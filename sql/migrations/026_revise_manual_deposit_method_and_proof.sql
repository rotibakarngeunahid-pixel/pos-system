-- 026_revise_manual_deposit_method_and_proof.sql
-- Revisi setoran manual admin:
-- - metode setoran tidak lagi dibatasi ke cash
-- - bukti setoran wajib untuk setoran manual baru
-- - simpan snapshot nama metode dan metadata file bukti secara nullable

BEGIN;

ALTER TABLE public.cash_deposits
  ADD COLUMN IF NOT EXISTS deposit_account_name_snapshot text,
  ADD COLUMN IF NOT EXISTS proof_file_name text,
  ADD COLUMN IF NOT EXISTS proof_file_type text,
  ADD COLUMN IF NOT EXISTS proof_file_size bigint,
  ADD COLUMN IF NOT EXISTS proof_uploaded_at timestamptz;

ALTER TABLE public.cash_deposits
  ALTER COLUMN cash_balance_at_deposit DROP NOT NULL,
  ALTER COLUMN proof_url DROP NOT NULL;

DROP FUNCTION IF EXISTS public.create_deposit(bigint, bigint, bigint, uuid, numeric, numeric, text, text);

CREATE OR REPLACE FUNCTION public.create_deposit(
  p_branch_id bigint,
  p_session_id bigint,
  p_staff_id bigint,
  p_deposit_account_id uuid,
  p_amount numeric,
  p_cash_balance_at_deposit numeric,
  p_proof_url text DEFAULT NULL,
  p_notes text DEFAULT NULL
) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_id uuid;
  v_account_type text;
  v_account_branch bigint;
  v_account_label text;
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

  SELECT type, branch_id, label
    INTO v_account_type, v_account_branch, v_account_label
  FROM public.deposit_accounts
  WHERE id = p_deposit_account_id
    AND is_active = true;

  IF v_account_type IS NULL THEN
    RAISE EXCEPTION 'Metode setoran tidak valid atau tidak aktif';
  END IF;

  IF v_account_branch IS NOT NULL AND v_account_branch <> p_branch_id THEN
    RAISE EXCEPTION 'Metode setoran tidak tersedia untuk cabang ini';
  END IF;

  IF v_account_type <> 'cash'
     AND NULLIF(BTRIM(COALESCE(p_proof_url, '')), '') IS NULL THEN
    RAISE EXCEPTION 'Bukti setoran wajib dilampirkan untuk metode ini';
  END IF;

  INSERT INTO public.cash_deposits (
    branch_id,
    session_id,
    staff_id,
    deposit_account_id,
    deposit_account_name_snapshot,
    amount,
    cash_balance_at_deposit,
    proof_url,
    notes,
    status
  ) VALUES (
    p_branch_id,
    p_session_id,
    p_staff_id,
    p_deposit_account_id,
    v_account_label,
    p_amount,
    p_cash_balance_at_deposit,
    NULLIF(BTRIM(COALESCE(p_proof_url, '')), ''),
    NULLIF(BTRIM(COALESCE(p_notes, '')), ''),
    'pending'
  ) RETURNING id INTO v_id;

  RETURN v_id;
END;
$$;

GRANT EXECUTE ON FUNCTION public.create_deposit(bigint, bigint, bigint, uuid, numeric, numeric, text, text)
  TO anon, authenticated;

DROP FUNCTION IF EXISTS public.admin_create_manual_deposit(uuid, bigint, bigint, uuid, numeric, text, text);
DROP FUNCTION IF EXISTS public.admin_create_manual_deposit(bigint, bigint, bigint, uuid, numeric, text, text);
DROP FUNCTION IF EXISTS public.admin_create_manual_deposit(bigint, bigint, bigint, uuid, numeric, text, text, text, text, bigint, timestamptz);
DROP FUNCTION IF EXISTS public.admin_create_manual_deposit(bigint, bigint, bigint, uuid, numeric, text, text, text, text, text, bigint, timestamptz);

CREATE OR REPLACE FUNCTION public.admin_create_manual_deposit(
  p_admin_id bigint,
  p_branch_id bigint,
  p_staff_id bigint,
  p_deposit_account_id uuid,
  p_amount numeric,
  p_notes text DEFAULT NULL,
  p_status text DEFAULT 'confirmed',
  p_proof_url text DEFAULT NULL,
  p_proof_file_name text DEFAULT NULL,
  p_proof_file_type text DEFAULT NULL,
  p_proof_file_size bigint DEFAULT NULL,
  p_proof_uploaded_at timestamptz DEFAULT NULL
) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_id uuid;
  v_status text;
  v_admin_role text;
  v_branch_active boolean;
  v_staff_role text;
  v_staff_branch_id bigint;
  v_staff_active boolean;
  v_account_type text;
  v_account_branch_id bigint;
  v_account_label text;
BEGIN
  SELECT role
    INTO v_admin_role
  FROM public.users
  WHERE id::text = p_admin_id::text;

  IF v_admin_role IS NULL OR v_admin_role <> 'admin' THEN
    RAISE EXCEPTION 'Hanya admin yang dapat input setoran manual';
  END IF;

  IF p_amount IS NULL OR p_amount <= 0 THEN
    RAISE EXCEPTION 'Jumlah setoran harus lebih dari 0';
  END IF;

  IF p_amount % 50000 <> 0 THEN
    RAISE EXCEPTION 'Nominal harus kelipatan Rp 50.000';
  END IF;

  v_status := COALESCE(NULLIF(BTRIM(COALESCE(p_status, '')), ''), 'confirmed');
  IF v_status NOT IN ('pending', 'confirmed') THEN
    RAISE EXCEPTION 'Status setoran manual tidak valid';
  END IF;

  SELECT COALESCE(is_active, true)
    INTO v_branch_active
  FROM public.branches
  WHERE id = p_branch_id;

  IF v_branch_active IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'Cabang tidak valid atau tidak aktif';
  END IF;

  SELECT role, branch_id, COALESCE(is_active, true)
    INTO v_staff_role, v_staff_branch_id, v_staff_active
  FROM public.users
  WHERE id = p_staff_id;

  IF v_staff_role IS NULL OR v_staff_role <> 'staff' OR v_staff_active IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'Staff tidak valid atau tidak aktif';
  END IF;

  IF v_staff_branch_id IS DISTINCT FROM p_branch_id THEN
    RAISE EXCEPTION 'Staff tidak ditugaskan di cabang ini';
  END IF;

  SELECT type, branch_id, label
    INTO v_account_type, v_account_branch_id, v_account_label
  FROM public.deposit_accounts
  WHERE id = p_deposit_account_id
    AND is_active = true;

  IF v_account_type IS NULL THEN
    RAISE EXCEPTION 'Metode setoran tidak valid atau tidak aktif';
  END IF;

  IF v_account_branch_id IS NOT NULL AND v_account_branch_id <> p_branch_id THEN
    RAISE EXCEPTION 'Metode setoran tidak tersedia untuk cabang ini';
  END IF;

  IF NULLIF(BTRIM(COALESCE(p_proof_url, '')), '') IS NULL THEN
    RAISE EXCEPTION 'Upload bukti setoran terlebih dahulu';
  END IF;

  INSERT INTO public.cash_deposits (
    branch_id,
    session_id,
    staff_id,
    deposit_account_id,
    deposit_account_name_snapshot,
    amount,
    cash_balance_at_deposit,
    proof_url,
    proof_file_name,
    proof_file_type,
    proof_file_size,
    proof_uploaded_at,
    notes,
    status
  ) VALUES (
    p_branch_id,
    NULL,
    p_staff_id,
    p_deposit_account_id,
    v_account_label,
    p_amount,
    NULL,
    NULLIF(BTRIM(COALESCE(p_proof_url, '')), ''),
    NULLIF(BTRIM(COALESCE(p_proof_file_name, '')), ''),
    NULLIF(BTRIM(COALESCE(p_proof_file_type, '')), ''),
    CASE WHEN COALESCE(p_proof_file_size, 0) > 0 THEN p_proof_file_size ELSE NULL END,
    COALESCE(p_proof_uploaded_at, now()),
    NULLIF(BTRIM(COALESCE(p_notes, '')), ''),
    'pending'
  ) RETURNING id INTO v_id;

  IF v_status = 'confirmed' THEN
    PERFORM public.confirm_deposit(v_id, p_admin_id, 'confirmed', NULL);
  END IF;

  RETURN v_id;
END;
$$;

GRANT EXECUTE ON FUNCTION public.admin_create_manual_deposit(bigint, bigint, bigint, uuid, numeric, text, text, text, text, text, bigint, timestamptz)
  TO anon, authenticated;

NOTIFY pgrst, 'reload schema';

COMMIT;
