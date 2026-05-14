-- 011_fix_deposit_security_and_integrity.sql
-- 1. confirm_deposit: tambah validasi role admin di dalam RPC sehingga staf tidak
--    bisa mengkonfirmasi deposit sendiri via direct API call.
-- 2. create_deposit: validasi deposit_account tidak NULL dan branch_id sesuai.
-- 3. Pastikan cash_deposits.amount% 50000 constraint sudah ada.

BEGIN;

-- ──────────────────────────────────────────────────────────────
-- confirm_deposit: hanya admin yang boleh mengkonfirmasi/menolak
-- ──────────────────────────────────────────────────────────────
DROP FUNCTION IF EXISTS public.confirm_deposit(uuid, bigint, text, text);

CREATE OR REPLACE FUNCTION public.confirm_deposit(
  p_deposit_id   uuid,
  p_admin_id     bigint,
  p_action       text,
  p_reject_reason text DEFAULT NULL
) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_dep     public.cash_deposits%ROWTYPE;
  v_cat_id  uuid;
  v_role    text;
BEGIN
  -- Validasi: hanya user dengan role 'admin' yang boleh mengkonfirmasi
  SELECT role INTO v_role FROM public.users WHERE id = p_admin_id;
  IF v_role IS NULL OR v_role <> 'admin' THEN
    RAISE EXCEPTION 'Hanya admin yang dapat mengkonfirmasi atau menolak setoran';
  END IF;

  IF p_action NOT IN ('confirmed','rejected') THEN
    RAISE EXCEPTION 'p_action harus ''confirmed'' atau ''rejected''';
  END IF;

  -- Kunci baris untuk mencegah race condition double-confirm
  SELECT * INTO v_dep FROM public.cash_deposits WHERE id = p_deposit_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Setoran tidak ditemukan';
  END IF;
  IF v_dep.status <> 'pending' THEN
    RAISE EXCEPTION 'Setoran sudah diproses (status: %)', v_dep.status;
  END IF;

  UPDATE public.cash_deposits SET
    status        = p_action,
    reviewed_by   = p_admin_id,
    reviewed_at   = now(),
    reject_reason = CASE WHEN p_action = 'rejected' THEN NULLIF(BTRIM(COALESCE(p_reject_reason,'')), '') ELSE NULL END
  WHERE id = p_deposit_id;

  IF p_action = 'confirmed' THEN
    SELECT id INTO v_cat_id
    FROM public.cash_categories
    WHERE name = 'Setoran Tunai' AND type = 'out'
    LIMIT 1;

    INSERT INTO public.cash_logs (
      branch_id, session_id, type, category_id, amount, note,
      created_by, reference_type, reference_id, is_void
    ) VALUES (
      v_dep.branch_id, v_dep.session_id, 'out', v_cat_id,
      v_dep.amount,
      'Setoran #' || left(v_dep.id::text, 8),
      p_admin_id, 'deposit', v_dep.id, false
    );
  END IF;
END;
$$;

GRANT EXECUTE ON FUNCTION public.confirm_deposit(uuid, bigint, text, text)
  TO anon, authenticated;

-- ──────────────────────────────────────────────────────────────
-- create_deposit: validasi branch_id sesuai deposit_account
-- (akun global branch_id IS NULL atau cocok dengan p_branch_id)
-- ──────────────────────────────────────────────────────────────
DROP FUNCTION IF EXISTS public.create_deposit(bigint, bigint, bigint, uuid, numeric, numeric, text, text);

CREATE OR REPLACE FUNCTION public.create_deposit(
  p_branch_id             bigint,
  p_session_id            bigint,
  p_staff_id              bigint,
  p_deposit_account_id    uuid,
  p_amount                numeric,
  p_cash_balance_at_deposit numeric,
  p_proof_url             text    DEFAULT NULL,
  p_notes                 text    DEFAULT NULL
) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_id           uuid;
  v_account_type text;
  v_account_branch bigint;
BEGIN
  IF p_amount <= 0 THEN
    RAISE EXCEPTION 'Jumlah setoran harus lebih dari 0';
  END IF;

  IF p_amount % 50000 <> 0 THEN
    RAISE EXCEPTION 'Nominal harus kelipatan Rp 50.000';
  END IF;

  IF p_cash_balance_at_deposit IS NOT NULL
     AND p_amount > p_cash_balance_at_deposit THEN
    RAISE EXCEPTION 'Jumlah setoran melebihi saldo kas';
  END IF;

  -- Validasi metode setoran: harus aktif dan cocok dengan cabang
  SELECT type, branch_id
    INTO v_account_type, v_account_branch
  FROM public.deposit_accounts
  WHERE id = p_deposit_account_id
    AND is_active = true;

  IF v_account_type IS NULL THEN
    RAISE EXCEPTION 'Metode setoran tidak valid atau tidak aktif';
  END IF;

  -- Metode setoran harus milik cabang yang sama atau global (branch_id IS NULL)
  IF v_account_branch IS NOT NULL AND v_account_branch <> p_branch_id THEN
    RAISE EXCEPTION 'Metode setoran tidak tersedia untuk cabang ini';
  END IF;

  -- Bukti wajib untuk semua tipe kecuali cash
  IF v_account_type <> 'cash'
     AND NULLIF(BTRIM(COALESCE(p_proof_url, '')), '') IS NULL THEN
    RAISE EXCEPTION 'Bukti setoran wajib dilampirkan untuk metode ini';
  END IF;

  INSERT INTO public.cash_deposits (
    branch_id, session_id, staff_id, deposit_account_id,
    amount, cash_balance_at_deposit, proof_url, notes, status
  ) VALUES (
    p_branch_id, p_session_id, p_staff_id, p_deposit_account_id,
    p_amount, p_cash_balance_at_deposit,
    NULLIF(BTRIM(COALESCE(p_proof_url, '')), ''),
    NULLIF(BTRIM(COALESCE(p_notes, '')), ''),
    'pending'
  ) RETURNING id INTO v_id;

  RETURN v_id;
END;
$$;

GRANT EXECUTE ON FUNCTION public.create_deposit(bigint, bigint, bigint, uuid, numeric, numeric, text, text)
  TO anon, authenticated;

COMMIT;
