-- Migration 045: Hardening final flow kas outlet
-- Tujuan:
-- - Source of truth saldo kas hanya branch_cash_positions.balance.
-- - RPC legacy saldo kas per staff tidak bisa dipakai client.
-- - Buka shift diblokir jika ada shift aktif atau setoran pending di outlet.
-- - Setoran pending tidak mengurangi saldo outlet; confirmed baru mengurangi saldo outlet.
-- - Setoran confirmed tidak lagi masuk cash_logs dan tidak mengubah expected_cash shift lama.
-- - Admin tidak bisa set saldo outlet saat masih ada shift aktif.

BEGIN;

CREATE INDEX IF NOT EXISTS idx_cash_deposits_branch_pending
  ON public.cash_deposits(branch_id, created_at)
  WHERE status = 'pending';

-- Client lama tidak boleh memakai jalur saldo kas per staff.
DO $$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT p.oid::regprocedure AS fn
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND p.proname IN (
        'get_staff_cash_balance',
        'get_admin_staff_cash_balances',
        'admin_set_staff_cash_balance',
        'open_cash_session_from_balance',
        'close_cash_session_apply_balance',
        'get_staff_cash_ledger'
      )
  LOOP
    EXECUTE format('REVOKE EXECUTE ON FUNCTION %s FROM PUBLIC, anon, authenticated', r.fn);
  END LOOP;
END;
$$;

CREATE OR REPLACE FUNCTION public.open_cash_session_from_balance(
  p_branch_id bigint,
  p_staff_id bigint,
  p_physical_cash numeric DEFAULT NULL,
  p_variance_reason text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  RAISE EXCEPTION 'RPC kas per staff sudah dinonaktifkan. Gunakan open_cash_session_from_branch_balance.';
END;
$$;

CREATE OR REPLACE FUNCTION public.close_cash_session_apply_balance(
  p_session_id bigint,
  p_closing_cash numeric,
  p_staff_id bigint
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  RAISE EXCEPTION 'RPC kas per staff sudah dinonaktifkan. Gunakan close_cash_session_apply_branch_balance.';
END;
$$;

CREATE OR REPLACE FUNCTION public.admin_set_staff_cash_balance(
  p_admin_id bigint,
  p_branch_id bigint,
  p_staff_id bigint,
  p_new_balance numeric,
  p_reason text,
  p_version bigint DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  RAISE EXCEPTION 'Saldo kas per staff sudah dinonaktifkan. Gunakan admin_set_branch_cash_balance.';
END;
$$;

REVOKE EXECUTE ON FUNCTION public.open_cash_session_from_balance(bigint, bigint, numeric, text) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.close_cash_session_apply_balance(bigint, numeric, bigint) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.admin_set_staff_cash_balance(bigint, bigint, bigint, numeric, text, bigint) FROM PUBLIC, anon, authenticated;

-- Setoran adalah mutasi outlet setelah shift closed, bukan bagian expected cash shift.
CREATE OR REPLACE FUNCTION public.compute_cash_session_system_amount(
  p_session_id bigint
) RETURNS numeric
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  WITH
  sess AS (
    SELECT id, opening_cash
    FROM public.cashier_sessions
    WHERE id = p_session_id
  ),
  log_sums AS (
    SELECT
      SUM(CASE WHEN cl.type = 'in'  AND cl.reference_type = 'manual' AND NOT COALESCE(cl.is_void, false) THEN cl.amount ELSE 0 END) AS manual_in,
      SUM(CASE WHEN cl.type = 'out' AND cl.reference_type = 'manual' AND NOT COALESCE(cl.is_void, false) THEN cl.amount ELSE 0 END) AS manual_out,
      SUM(CASE WHEN cl.type = 'out' AND cl.reference_type = 'refund' AND NOT COALESCE(cl.is_void, false) THEN cl.amount ELSE 0 END) AS refund_out,
      SUM(CASE
        WHEN cl.type = 'out'
         AND cl.reference_type = 'void'
         AND NOT COALESCE(cl.is_void, false)
         AND NOT EXISTS (
           SELECT 1
           FROM public.transactions tx
           WHERE tx.session_id = cl.session_id
             AND tx.payment_method = 'cash'
             AND tx.id::text = cl.reference_id::text
         )
        THEN cl.amount ELSE 0
      END) AS void_out
    FROM public.cash_logs cl
    WHERE cl.session_id = p_session_id
  ),
  sale_sums AS (
    SELECT SUM(t.total) AS cash_sales_in
    FROM public.transactions t
    WHERE t.session_id = p_session_id
      AND t.status = 'completed'
      AND t.payment_method = 'cash'
  )
  SELECT
    COALESCE(s.opening_cash, 0)
    + COALESCE(ss.cash_sales_in, 0)
    + COALESCE(ls.manual_in, 0)
    - COALESCE(ls.manual_out, 0)
    - COALESCE(ls.refund_out, 0)
    - COALESCE(ls.void_out, 0)
  FROM sess s
  CROSS JOIN log_sums ls
  CROSS JOIN sale_sums ss;
$$;

CREATE OR REPLACE FUNCTION public.compute_cash_session_system_amount_outlet(
  p_session_id bigint
) RETURNS numeric
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT COALESCE(public.compute_cash_session_system_amount(p_session_id), 0);
$$;

-- Helper setoran: outlet/session based. p_staff_id hanya dipakai sebagai user/pencatat yang meminta data.
CREATE OR REPLACE FUNCTION public.get_deposit_eligible_sessions(
  p_branch_id bigint,
  p_staff_id bigint,
  p_limit integer DEFAULT 10
) RETURNS TABLE (
  session_id bigint,
  branch_id bigint,
  staff_id bigint,
  session_status text,
  opened_at timestamptz,
  closed_at timestamptz,
  closing_cash numeric,
  expected_cash numeric,
  current_cash_amount numeric,
  final_cash_amount numeric,
  deposit_pending numeric,
  deposit_confirmed numeric,
  depositable_cash numeric,
  has_active_deposit boolean,
  last_deposit_status text,
  block_reason text
)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_user record;
BEGIN
  SELECT id, role, branch_id
    INTO v_user
  FROM public.users
  WHERE id = p_staff_id
    AND COALESCE(is_active, true) = true;

  IF p_staff_id IS NOT NULL AND NOT FOUND THEN
    RAISE EXCEPTION 'User tidak ditemukan atau tidak aktif';
  END IF;

  IF p_staff_id IS NOT NULL
     AND v_user.role NOT IN ('admin', 'owner')
     AND v_user.branch_id IS DISTINCT FROM p_branch_id THEN
    RAISE EXCEPTION 'Tidak memiliki akses ke outlet ini';
  END IF;

  RETURN QUERY
  WITH session_deps AS (
    SELECT
      cd.session_id,
      COALESCE(SUM(cd.amount) FILTER (WHERE cd.status = 'pending'), 0)::numeric AS dep_pending,
      COALESCE(SUM(cd.amount) FILTER (WHERE cd.status = 'confirmed'), 0)::numeric AS dep_confirmed,
      (
        SELECT cd2.status
        FROM public.cash_deposits cd2
        WHERE cd2.session_id = cd.session_id
        ORDER BY cd2.created_at DESC
        LIMIT 1
      )::text AS last_status
    FROM public.cash_deposits cd
    WHERE cd.session_id IN (
      SELECT cs2.id
      FROM public.cashier_sessions cs2
      WHERE cs2.branch_id = p_branch_id
        AND cs2.status = 'closed'
    )
      AND cd.status IN ('pending', 'confirmed')
    GROUP BY cd.session_id
  ),
  sessions AS (
    SELECT
      cs.id AS session_id,
      cs.branch_id,
      cs.staff_id,
      cs.status::text AS session_status,
      cs.opened_at,
      cs.closed_at,
      cs.closing_cash,
      cs.expected_cash,
      cs.current_cash_amount,
      COALESCE(
        cs.current_cash_amount,
        cs.closing_cash,
        cs.expected_cash,
        public.compute_cash_session_system_amount(cs.id),
        0
      )::numeric AS final_cash_amount,
      COALESCE(sd.dep_pending, 0)::numeric AS dep_pending,
      COALESCE(sd.dep_confirmed, 0)::numeric AS dep_confirmed,
      sd.last_status
    FROM public.cashier_sessions cs
    LEFT JOIN session_deps sd ON sd.session_id = cs.id
    WHERE cs.branch_id = p_branch_id
      AND cs.status = 'closed'
      AND cs.closing_cash IS NOT NULL
    ORDER BY cs.closed_at DESC NULLS LAST, cs.id DESC
    LIMIT COALESCE(p_limit, 10)
  )
  SELECT
    s.session_id,
    s.branch_id,
    s.staff_id,
    s.session_status,
    s.opened_at,
    s.closed_at,
    s.closing_cash,
    s.expected_cash,
    s.current_cash_amount,
    s.final_cash_amount,
    s.dep_pending,
    s.dep_confirmed,
    GREATEST(s.final_cash_amount - (s.dep_pending + s.dep_confirmed), 0)::numeric AS depositable_cash,
    (s.dep_pending + s.dep_confirmed) > 0 AS has_active_deposit,
    s.last_status AS last_deposit_status,
    CASE
      WHEN s.dep_pending > 0 THEN 'Setoran sedang menunggu konfirmasi'
      WHEN s.dep_confirmed > 0 THEN 'Setoran shift ini sudah selesai'
      ELSE NULL
    END::text AS block_reason
  FROM sessions s;
END;
$$;

CREATE OR REPLACE FUNCTION public.create_deposit(
  p_branch_id bigint,
  p_session_id bigint,
  p_staff_id bigint,
  p_deposit_account_id uuid,
  p_amount numeric,
  p_cash_balance_at_deposit numeric DEFAULT NULL,
  p_proof_url text DEFAULT NULL,
  p_notes text DEFAULT NULL
) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_id uuid;
  v_session public.cashier_sessions%ROWTYPE;
  v_submitter record;
  v_account_type text;
  v_account_branch bigint;
  v_account_label text;
  v_final_cash numeric;
  v_active_deposits numeric;
  v_depositable numeric;
BEGIN
  IF p_session_id IS NULL THEN
    RAISE EXCEPTION 'Setoran tunai hanya bisa dibuat setelah shift ditutup';
  END IF;

  SELECT *
    INTO v_session
  FROM public.cashier_sessions
  WHERE id = p_session_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Shift tidak ditemukan';
  END IF;

  IF v_session.status <> 'closed' THEN
    RAISE EXCEPTION 'Tutup shift terlebih dahulu sebelum setoran tunai';
  END IF;

  IF v_session.branch_id <> p_branch_id THEN
    RAISE EXCEPTION 'Setoran tidak sesuai dengan outlet shift';
  END IF;

  SELECT id, role, branch_id
    INTO v_submitter
  FROM public.users
  WHERE id = p_staff_id
    AND COALESCE(is_active, true) = true;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Staff pencatat setoran tidak ditemukan atau tidak aktif';
  END IF;

  IF v_submitter.role NOT IN ('admin', 'owner')
     AND v_submitter.branch_id IS DISTINCT FROM p_branch_id THEN
    RAISE EXCEPTION 'Staff tidak memiliki akses ke outlet ini';
  END IF;

  IF p_amount IS NULL OR p_amount <= 0 THEN
    RAISE EXCEPTION 'Jumlah setoran harus lebih dari 0';
  END IF;

  IF p_amount % 50000 <> 0 THEN
    RAISE EXCEPTION 'Nominal harus kelipatan Rp 50.000';
  END IF;

  v_final_cash := COALESCE(
    v_session.current_cash_amount,
    v_session.closing_cash,
    v_session.expected_cash,
    public.compute_cash_session_system_amount(p_session_id),
    0
  );

  SELECT COALESCE(SUM(cd.amount), 0)
    INTO v_active_deposits
  FROM public.cash_deposits cd
  WHERE cd.session_id = p_session_id
    AND cd.status IN ('pending', 'confirmed');

  v_depositable := GREATEST(v_final_cash - v_active_deposits, 0);

  IF v_active_deposits > 0 THEN
    RAISE EXCEPTION 'Shift ini sudah memiliki setoran aktif. Tunggu konfirmasi atau buat ulang setelah penolakan.';
  END IF;

  IF p_amount > v_depositable THEN
    RAISE EXCEPTION 'Jumlah setoran melebihi kas yang dapat disetor (maks %)', v_depositable;
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
    RAISE EXCEPTION 'Metode setoran tidak tersedia untuk outlet ini';
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
    v_depositable,
    NULLIF(BTRIM(COALESCE(p_proof_url, '')), ''),
    NULLIF(BTRIM(COALESCE(p_notes, '')), ''),
    'pending'
  ) RETURNING id INTO v_id;

  RETURN v_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.admin_create_manual_deposit(
  p_admin_id bigint,
  p_branch_id bigint,
  p_staff_id bigint,
  p_session_id bigint,
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
  v_session public.cashier_sessions%ROWTYPE;
  v_submitter record;
  v_account_type text;
  v_account_branch bigint;
  v_account_label text;
  v_is_cash_method boolean;
  v_proof_url text;
  v_active_deposits numeric;
  v_final_cash numeric;
  v_depositable numeric;
BEGIN
  SELECT role
    INTO v_admin_role
  FROM public.users
  WHERE id::text = p_admin_id::text;

  IF v_admin_role IS NULL OR v_admin_role NOT IN ('admin', 'owner') THEN
    RAISE EXCEPTION 'Hanya admin/owner yang dapat input setoran manual';
  END IF;

  IF p_session_id IS NULL THEN
    RAISE EXCEPTION 'Setoran tunai hanya bisa dibuat setelah shift ditutup';
  END IF;

  SELECT *
    INTO v_session
  FROM public.cashier_sessions
  WHERE id = p_session_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Shift tidak ditemukan';
  END IF;

  IF v_session.status <> 'closed' THEN
    RAISE EXCEPTION 'Tutup shift terlebih dahulu sebelum setoran tunai';
  END IF;

  IF v_session.branch_id <> p_branch_id THEN
    RAISE EXCEPTION 'Setoran tidak sesuai dengan outlet shift';
  END IF;

  SELECT id, role, branch_id, COALESCE(is_active, true) AS is_active
    INTO v_submitter
  FROM public.users
  WHERE id = p_staff_id;

  IF NOT FOUND OR v_submitter.is_active IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'Staff pencatat setoran tidak valid atau tidak aktif';
  END IF;

  IF v_submitter.role NOT IN ('admin', 'owner')
     AND v_submitter.branch_id IS DISTINCT FROM p_branch_id THEN
    RAISE EXCEPTION 'Staff tidak memiliki akses ke outlet ini';
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

  v_final_cash := COALESCE(
    v_session.current_cash_amount,
    v_session.closing_cash,
    v_session.expected_cash,
    public.compute_cash_session_system_amount(p_session_id),
    0
  );

  SELECT COALESCE(SUM(cd.amount), 0)
    INTO v_active_deposits
  FROM public.cash_deposits cd
  WHERE cd.session_id = p_session_id
    AND cd.status IN ('pending', 'confirmed');

  v_depositable := GREATEST(v_final_cash - v_active_deposits, 0);

  IF v_active_deposits > 0 THEN
    RAISE EXCEPTION 'Shift ini sudah memiliki setoran aktif';
  END IF;

  IF p_amount > v_depositable THEN
    RAISE EXCEPTION 'Jumlah setoran melebihi kas yang dapat disetor (maks %)', v_depositable;
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
    RAISE EXCEPTION 'Metode setoran tidak tersedia untuk outlet ini';
  END IF;

  v_proof_url := NULLIF(BTRIM(COALESCE(p_proof_url, '')), '');
  v_is_cash_method := CASE
    WHEN NULLIF(BTRIM(COALESCE(v_account_type, '')), '') IS NOT NULL THEN
      LOWER(v_account_type) = 'cash'
    ELSE
      LOWER(COALESCE(v_account_label, '')) LIKE '%cash%'
      OR LOWER(COALESCE(v_account_label, '')) LIKE '%tunai%'
  END;

  IF v_is_cash_method IS DISTINCT FROM true AND v_proof_url IS NULL THEN
    RAISE EXCEPTION 'Upload bukti setoran terlebih dahulu.';
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
    p_session_id,
    p_staff_id,
    p_deposit_account_id,
    v_account_label,
    p_amount,
    v_depositable,
    v_proof_url,
    NULLIF(BTRIM(COALESCE(p_proof_file_name, '')), ''),
    NULLIF(BTRIM(COALESCE(p_proof_file_type, '')), ''),
    CASE WHEN COALESCE(p_proof_file_size, 0) > 0 THEN p_proof_file_size ELSE NULL END,
    CASE WHEN v_proof_url IS NOT NULL THEN COALESCE(p_proof_uploaded_at, now()) ELSE NULL END,
    NULLIF(BTRIM(COALESCE(p_notes, '')), ''),
    'pending'
  ) RETURNING id INTO v_id;

  IF v_status = 'confirmed' THEN
    PERFORM public.confirm_deposit(v_id, p_admin_id, 'confirmed', NULL);
  END IF;

  RETURN v_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.enforce_cash_deposit_closed_shift()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_session public.cashier_sessions%ROWTYPE;
  v_submitter record;
  v_active_count integer;
BEGIN
  IF NEW.session_id IS NULL THEN
    RAISE EXCEPTION 'Setoran tunai hanya bisa dibuat setelah shift ditutup';
  END IF;

  SELECT *
    INTO v_session
  FROM public.cashier_sessions
  WHERE id = NEW.session_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Shift tidak ditemukan';
  END IF;

  IF v_session.status <> 'closed' THEN
    RAISE EXCEPTION 'Tutup shift terlebih dahulu sebelum setoran tunai';
  END IF;

  IF v_session.branch_id <> NEW.branch_id THEN
    RAISE EXCEPTION 'Setoran tidak sesuai dengan outlet shift';
  END IF;

  SELECT id, role, branch_id, COALESCE(is_active, true) AS is_active
    INTO v_submitter
  FROM public.users
  WHERE id = NEW.staff_id;

  IF NOT FOUND OR v_submitter.is_active IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'Staff pencatat setoran tidak valid atau tidak aktif';
  END IF;

  IF v_submitter.role NOT IN ('admin', 'owner')
     AND v_submitter.branch_id IS DISTINCT FROM NEW.branch_id THEN
    RAISE EXCEPTION 'Staff tidak memiliki akses ke outlet ini';
  END IF;

  IF NEW.status IN ('pending', 'confirmed') THEN
    SELECT COUNT(*)
      INTO v_active_count
    FROM public.cash_deposits cd
    WHERE cd.session_id = NEW.session_id
      AND cd.status IN ('pending', 'confirmed')
      AND (NEW.id IS NULL OR cd.id <> NEW.id);

    IF v_active_count > 0 THEN
      RAISE EXCEPTION 'Shift ini sudah memiliki setoran aktif';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_cash_deposits_require_closed_shift ON public.cash_deposits;

CREATE TRIGGER trg_cash_deposits_require_closed_shift
BEFORE INSERT OR UPDATE OF session_id, branch_id, staff_id, amount, status
ON public.cash_deposits
FOR EACH ROW
EXECUTE FUNCTION public.enforce_cash_deposit_closed_shift();

CREATE OR REPLACE FUNCTION public.prevent_deposit_cash_logs()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF COALESCE(NEW.reference_type, '') = 'deposit' THEN
    RAISE EXCEPTION 'Setoran tunai dicatat di branch_cash_ledger, bukan cash_logs shift.';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_prevent_deposit_cash_logs ON public.cash_logs;

CREATE TRIGGER trg_prevent_deposit_cash_logs
BEFORE INSERT OR UPDATE OF reference_type
ON public.cash_logs
FOR EACH ROW
WHEN (NEW.reference_type = 'deposit')
EXECUTE FUNCTION public.prevent_deposit_cash_logs();

CREATE OR REPLACE FUNCTION public.open_cash_session_from_branch_balance(
  p_branch_id bigint,
  p_staff_id bigint,
  p_physical_cash numeric DEFAULT NULL,
  p_variance_reason text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_user record;
  v_branch record;
  v_active record;
  v_pending record;
  v_pos public.branch_cash_positions%ROWTYPE;
  v_opening_cash numeric(15,2);
  v_session public.cashier_sessions%ROWTYPE;
  v_ledger_id bigint;
  v_seed_source text;
BEGIN
  SELECT id, role, branch_id, name
    INTO v_user
  FROM public.users
  WHERE id = p_staff_id
    AND COALESCE(is_active, true) = true;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Staff tidak ditemukan atau tidak aktif';
  END IF;

  SELECT id, name, COALESCE(default_cash_position, 0) AS default_cash_position
    INTO v_branch
  FROM public.branches
  WHERE id = p_branch_id
    AND COALESCE(is_active, true) = true;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Outlet tidak ditemukan atau tidak aktif';
  END IF;

  IF v_user.role NOT IN ('admin', 'owner')
     AND v_user.branch_id IS DISTINCT FROM p_branch_id THEN
    RAISE EXCEPTION 'Staff tidak memiliki akses ke outlet ini';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtext('branch_cash_open:' || p_branch_id::text));

  SELECT cs.id, cs.staff_id, cs.opened_at, u.name::text AS staff_name
    INTO v_active
  FROM public.cashier_sessions cs
  LEFT JOIN public.users u ON u.id = cs.staff_id
  WHERE cs.branch_id = p_branch_id
    AND cs.status = 'open'
  ORDER BY cs.opened_at DESC
  LIMIT 1;

  IF FOUND THEN
    RAISE EXCEPTION 'Shift sebelumnya atas nama % belum menutup kas. Silakan tutup kas terlebih dahulu.',
      COALESCE(v_active.staff_name, 'staff sebelumnya');
  END IF;

  SELECT cd.id, cd.amount, cd.created_at
    INTO v_pending
  FROM public.cash_deposits cd
  WHERE cd.branch_id = p_branch_id
    AND cd.status = 'pending'
  ORDER BY cd.created_at ASC
  LIMIT 1;

  IF FOUND THEN
    RAISE EXCEPTION 'Masih ada setoran tunai yang menunggu persetujuan owner/admin. Selesaikan setoran terlebih dahulu sebelum membuka shift baru.';
  END IF;

  SELECT *
    INTO v_pos
  FROM public.branch_cash_positions
  WHERE branch_id = p_branch_id
  FOR UPDATE;

  IF v_pos.id IS NULL THEN
    SELECT closing_cash
      INTO v_opening_cash
    FROM public.cashier_sessions
    WHERE branch_id = p_branch_id
      AND status = 'closed'
      AND closing_cash IS NOT NULL
    ORDER BY closed_at DESC
    LIMIT 1;

    IF v_opening_cash IS NULL THEN
      v_opening_cash := COALESCE(v_branch.default_cash_position, 0);
      v_seed_source := 'default_cash';
    ELSE
      v_seed_source := 'latest_closed_session';
    END IF;

    INSERT INTO public.branch_cash_positions (branch_id, balance, version, updated_at, updated_by)
    VALUES (p_branch_id, COALESCE(v_opening_cash, 0), 1, now(), p_staff_id)
    ON CONFLICT (branch_id) DO UPDATE SET
      balance = EXCLUDED.balance,
      updated_at = now(),
      updated_by = EXCLUDED.updated_by
    RETURNING * INTO v_pos;

    INSERT INTO public.branch_cash_ledger (
      branch_id, staff_id, movement_type, direction, amount,
      balance_before, balance_after, reason, source_table, source_id, metadata
    ) VALUES (
      p_branch_id, p_staff_id, 'system_repair', 'none', COALESCE(v_opening_cash, 0),
      0, COALESCE(v_opening_cash, 0),
      'Inisialisasi posisi kas outlet saat buka shift',
      'branch_cash_positions', v_pos.id::text,
      jsonb_build_object('seed_source', v_seed_source)
    )
    ON CONFLICT DO NOTHING;
  ELSE
    v_opening_cash := COALESCE(v_pos.balance, 0);
  END IF;

  BEGIN
    INSERT INTO public.cashier_sessions (
      branch_id, staff_id, opening_cash, status, opened_at, opening_cash_source
    ) VALUES (
      p_branch_id, p_staff_id, COALESCE(v_opening_cash, 0), 'open', now(), 'branch_balance'
    )
    RETURNING * INTO v_session;
  EXCEPTION WHEN unique_violation THEN
    SELECT cs.id, cs.staff_id, cs.opened_at, u.name::text AS staff_name
      INTO v_active
    FROM public.cashier_sessions cs
    LEFT JOIN public.users u ON u.id = cs.staff_id
    WHERE cs.branch_id = p_branch_id
      AND cs.status = 'open'
    ORDER BY cs.opened_at DESC
    LIMIT 1;

    RAISE EXCEPTION 'Shift sebelumnya atas nama % belum menutup kas. Silakan tutup kas terlebih dahulu.',
      COALESCE(v_active.staff_name, 'staff sebelumnya');
  END;

  INSERT INTO public.branch_cash_ledger (
    branch_id, staff_id, cash_session_id,
    movement_type, direction, amount,
    balance_before, balance_after,
    reason, source_table, source_id, metadata
  ) VALUES (
    p_branch_id, p_staff_id, v_session.id,
    'session_open_confirm', 'none', 0,
    COALESCE(v_opening_cash, 0), COALESCE(v_opening_cash, 0),
    'Buka shift dari posisi kas outlet',
    'cashier_sessions', v_session.id::text,
    jsonb_build_object('opening_cash', COALESCE(v_opening_cash, 0))
  )
  ON CONFLICT DO NOTHING
  RETURNING id INTO v_ledger_id;

  RETURN jsonb_build_object(
    'id', v_session.id,
    'branch_id', v_session.branch_id,
    'staff_id', v_session.staff_id,
    'status', v_session.status,
    'opening_cash', COALESCE(v_session.opening_cash, v_opening_cash, 0),
    'opening_cash_source', 'branch_balance',
    'opened_at', v_session.opened_at,
    'ledger_id', v_ledger_id
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.admin_set_branch_cash_balance(
  p_admin_id bigint,
  p_branch_id bigint,
  p_new_balance numeric,
  p_reason text,
  p_version bigint DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_admin record;
  v_open record;
  v_pos public.branch_cash_positions%ROWTYPE;
  v_before numeric(15,2);
  v_ledger_id bigint;
BEGIN
  SELECT id, role
    INTO v_admin
  FROM public.users
  WHERE id = p_admin_id;

  IF NOT FOUND OR v_admin.role NOT IN ('admin', 'owner') THEN
    RAISE EXCEPTION 'Hanya admin/owner yang dapat mengatur posisi kas outlet';
  END IF;

  IF p_new_balance IS NULL OR p_new_balance < 0 THEN
    RAISE EXCEPTION 'Posisi kas outlet tidak boleh negatif';
  END IF;

  IF p_reason IS NULL OR length(BTRIM(p_reason)) < 3 THEN
    RAISE EXCEPTION 'Keterangan wajib diisi minimal 3 karakter';
  END IF;

  SELECT cs.id, u.name::text AS staff_name
    INTO v_open
  FROM public.cashier_sessions cs
  LEFT JOIN public.users u ON u.id = cs.staff_id
  WHERE cs.branch_id = p_branch_id
    AND cs.status = 'open'
  ORDER BY cs.opened_at DESC
  LIMIT 1;

  IF FOUND THEN
    RAISE EXCEPTION 'Saldo kas outlet tidak bisa diubah karena masih ada shift aktif. Tutup shift terlebih dahulu.';
  END IF;

  SELECT *
    INTO v_pos
  FROM public.branch_cash_positions
  WHERE branch_id = p_branch_id
  FOR UPDATE;

  IF v_pos.id IS NOT NULL THEN
    IF p_version IS NOT NULL AND v_pos.version <> p_version THEN
      RAISE EXCEPTION 'Data berubah. Muat ulang halaman sebelum menyimpan.';
    END IF;
    v_before := COALESCE(v_pos.balance, 0);
    UPDATE public.branch_cash_positions
    SET balance = p_new_balance,
        version = version + 1,
        updated_at = now(),
        updated_by = p_admin_id
    WHERE id = v_pos.id
    RETURNING * INTO v_pos;
  ELSE
    v_before := 0;
    INSERT INTO public.branch_cash_positions (branch_id, balance, version, updated_at, updated_by)
    VALUES (p_branch_id, p_new_balance, 1, now(), p_admin_id)
    RETURNING * INTO v_pos;
  END IF;

  INSERT INTO public.branch_cash_ledger (
    branch_id, admin_id,
    movement_type, direction, amount,
    balance_before, balance_after,
    reason, source_table, source_id, metadata
  ) VALUES (
    p_branch_id, p_admin_id,
    'admin_adjustment', 'adjust', ABS(p_new_balance - v_before),
    v_before, p_new_balance,
    BTRIM(p_reason), 'branch_cash_positions', v_pos.id::text,
    jsonb_build_object('admin_id', p_admin_id)
  )
  RETURNING id INTO v_ledger_id;

  RETURN jsonb_build_object(
    'branch_id', p_branch_id,
    'balance_before', v_before,
    'balance_after', p_new_balance,
    'ledger_id', v_ledger_id,
    'version', v_pos.version
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.confirm_deposit(
  p_deposit_id uuid,
  p_admin_id bigint,
  p_action text,
  p_reject_reason text DEFAULT NULL
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_dep public.cash_deposits%ROWTYPE;
  v_session public.cashier_sessions%ROWTYPE;
  v_role text;
  v_reviewed_by_type text;
  v_update_sql text;
  v_pos public.branch_cash_positions%ROWTYPE;
  v_before numeric(15,2);
  v_after numeric(15,2);
  v_ledger_id bigint;
BEGIN
  SELECT role
    INTO v_role
  FROM public.users
  WHERE id::text = p_admin_id::text;

  IF v_role IS NULL OR v_role NOT IN ('admin', 'owner') THEN
    RAISE EXCEPTION 'Hanya admin/owner yang dapat mengkonfirmasi atau menolak setoran';
  END IF;

  IF p_action NOT IN ('confirmed', 'rejected') THEN
    RAISE EXCEPTION 'p_action harus ''confirmed'' atau ''rejected''';
  END IF;

  SELECT *
    INTO v_dep
  FROM public.cash_deposits
  WHERE id = p_deposit_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Setoran tidak ditemukan';
  END IF;

  IF v_dep.status <> 'pending' THEN
    RAISE EXCEPTION 'Setoran sudah diproses (status: %)', v_dep.status;
  END IF;

  IF v_dep.session_id IS NULL THEN
    RAISE EXCEPTION 'Setoran ini tidak memiliki shift yang valid dan tidak bisa dikonfirmasi';
  END IF;

  SELECT *
    INTO v_session
  FROM public.cashier_sessions
  WHERE id = v_dep.session_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Shift setoran tidak ditemukan';
  END IF;

  IF v_session.status <> 'closed' THEN
    RAISE EXCEPTION 'Shift setoran belum tertutup dan tidak bisa dikonfirmasi';
  END IF;

  SELECT udt_name
    INTO v_reviewed_by_type
  FROM information_schema.columns
  WHERE table_schema = 'public'
    AND table_name = 'cash_deposits'
    AND column_name = 'reviewed_by';

  v_update_sql :=
    'UPDATE public.cash_deposits ' ||
    'SET status = $1, ' ||
    '    reviewed_at = now(), ' ||
    '    reject_reason = CASE ' ||
    '      WHEN $1 = ''rejected'' THEN NULLIF(BTRIM(COALESCE($2, '''')), '''') ' ||
    '      ELSE NULL ' ||
    '    END';

  IF v_reviewed_by_type IN ('int2', 'int4', 'int8', 'numeric') THEN
    v_update_sql := v_update_sql || ', reviewed_by = $3';
  ELSIF v_reviewed_by_type IN ('text', 'varchar', 'bpchar') THEN
    v_update_sql := v_update_sql || ', reviewed_by = $3::text';
  END IF;

  v_update_sql := v_update_sql || ' WHERE id = $4';

  IF p_action = 'rejected' THEN
    EXECUTE v_update_sql
      USING p_action, p_reject_reason, p_admin_id, p_deposit_id;

    SELECT *
      INTO v_pos
    FROM public.branch_cash_positions
    WHERE branch_id = v_dep.branch_id
    FOR UPDATE;

    v_before := COALESCE(v_pos.balance, v_dep.cash_balance_at_deposit, v_session.current_cash_amount, v_session.closing_cash, v_session.expected_cash, 0);

    INSERT INTO public.branch_cash_ledger (
      branch_id, staff_id, admin_id, cash_session_id, deposit_id,
      movement_type, direction, amount,
      balance_before, balance_after,
      reason, source_table, source_id, metadata
    ) VALUES (
      v_dep.branch_id, v_dep.staff_id, p_admin_id, v_dep.session_id, p_deposit_id,
      'deposit_rejected', 'none', v_dep.amount,
      v_before, v_before,
      COALESCE(NULLIF(BTRIM(COALESCE(p_reject_reason, '')), ''), 'Setoran ditolak'),
      'cash_deposits', p_deposit_id::text,
      jsonb_build_object('admin_id', p_admin_id)
    )
    ON CONFLICT DO NOTHING;

    RETURN;
  END IF;

  IF v_dep.branch_cash_applied_at IS NULL THEN
    SELECT *
      INTO v_pos
    FROM public.branch_cash_positions
    WHERE branch_id = v_dep.branch_id
    FOR UPDATE;

    IF v_pos.id IS NULL THEN
      v_before := COALESCE(
        v_dep.cash_balance_at_deposit,
        v_session.current_cash_amount,
        v_session.closing_cash,
        v_session.expected_cash,
        0
      );
      INSERT INTO public.branch_cash_positions (branch_id, balance, version, updated_at, updated_by)
      VALUES (v_dep.branch_id, v_before, 1, now(), p_admin_id)
      RETURNING * INTO v_pos;
    ELSE
      v_before := COALESCE(v_pos.balance, 0);
    END IF;

    v_after := v_before - v_dep.amount;
    IF v_after < 0 THEN
      RAISE EXCEPTION 'Nominal setoran (%) melebihi posisi kas outlet saat ini (%). Koreksi kas outlet terlebih dahulu.',
        v_dep.amount, v_before;
    END IF;

    UPDATE public.branch_cash_positions
    SET balance = v_after,
        version = version + 1,
        updated_at = now(),
        updated_by = p_admin_id
    WHERE id = v_pos.id;

    INSERT INTO public.branch_cash_ledger (
      branch_id, staff_id, admin_id, cash_session_id, deposit_id,
      movement_type, direction, amount,
      balance_before, balance_after,
      reason, source_table, source_id, metadata
    ) VALUES (
      v_dep.branch_id, v_dep.staff_id, p_admin_id, v_dep.session_id, p_deposit_id,
      'deposit_approved', 'out', v_dep.amount,
      v_before, v_after,
      'Setoran disetujui admin',
      'cash_deposits', p_deposit_id::text,
      jsonb_build_object('admin_id', p_admin_id)
    )
    ON CONFLICT DO NOTHING
    RETURNING id INTO v_ledger_id;

    IF v_ledger_id IS NULL THEN
      SELECT id
        INTO v_ledger_id
      FROM public.branch_cash_ledger
      WHERE source_table = 'cash_deposits'
        AND source_id = p_deposit_id::text
        AND movement_type = 'deposit_approved'
      ORDER BY id DESC
      LIMIT 1;
    END IF;

    EXECUTE v_update_sql
      USING p_action, p_reject_reason, p_admin_id, p_deposit_id;

    UPDATE public.cash_deposits
    SET branch_cash_applied_at = now(),
        branch_cash_balance_before = v_before,
        branch_cash_balance_after = v_after,
        branch_cash_ledger_id = v_ledger_id
    WHERE id = p_deposit_id;
  ELSE
    EXECUTE v_update_sql
      USING p_action, p_reject_reason, p_admin_id, p_deposit_id;
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION public.get_admin_cash_sessions(
  p_admin_id bigint,
  p_branch_id bigint DEFAULT NULL,
  p_staff_id bigint DEFAULT NULL,
  p_status text DEFAULT 'open',
  p_date_from date DEFAULT NULL,
  p_date_to date DEFAULT NULL
) RETURNS TABLE (
  session_id bigint,
  staff_id bigint,
  staff_name text,
  branch_id bigint,
  branch_name text,
  session_status text,
  opened_at timestamptz,
  closed_at timestamptz,
  opening_cash numeric,
  closing_cash numeric,
  cash_sales_in numeric,
  manual_in numeric,
  manual_out numeric,
  refund_out numeric,
  void_out numeric,
  deposit_confirmed numeric,
  deposit_pending numeric,
  system_cash_amount numeric,
  current_cash_amount numeric,
  closed_manually boolean,
  has_manual_adjustment boolean,
  manual_closed_at timestamptz,
  manual_close_reason text,
  updated_at timestamptz,
  adjustment_count bigint,
  last_activity_at timestamptz,
  risk_level text
)
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_admin_role text;
  v_status text;
BEGIN
  SELECT u.role
    INTO v_admin_role
  FROM public.users u
  WHERE u.id::text = p_admin_id::text;

  IF v_admin_role IS NULL OR v_admin_role NOT IN ('admin', 'owner') THEN
    RAISE EXCEPTION 'Hanya owner/admin yang dapat melihat daftar kas admin';
  END IF;

  v_status := COALESCE(NULLIF(BTRIM(COALESCE(p_status, '')), ''), 'open');

  RETURN QUERY
  WITH
  base_sessions AS (
    SELECT
      cs.id AS session_id,
      cs.staff_id,
      u.name::text AS staff_name,
      cs.branch_id,
      b.name::text AS branch_name,
      cs.status::text AS session_status,
      cs.opened_at,
      cs.closed_at,
      COALESCE(cs.opening_cash, 0) AS opening_cash,
      cs.closing_cash,
      COALESCE(cs.current_cash_amount, NULL) AS current_cash_amount,
      COALESCE(cs.closed_manually, false) AS closed_manually,
      COALESCE(cs.has_manual_adjustment, false) AS has_manual_adjustment,
      cs.manual_closed_at,
      cs.manual_close_reason,
      COALESCE(cs.updated_at, cs.closed_at, cs.opened_at) AS updated_at
    FROM public.cashier_sessions cs
    LEFT JOIN public.users u ON u.id = cs.staff_id
    LEFT JOIN public.branches b ON b.id = cs.branch_id
    WHERE (p_branch_id IS NULL OR cs.branch_id = p_branch_id)
      AND (p_staff_id IS NULL OR cs.staff_id = p_staff_id)
      AND (p_date_from IS NULL OR cs.opened_at >= p_date_from::timestamptz)
      AND (p_date_to IS NULL OR cs.opened_at < (p_date_to + 1)::timestamptz)
  ),
  log_sums AS (
    SELECT
      cl.session_id,
      SUM(CASE WHEN cl.type = 'in'  AND cl.reference_type = 'manual' AND NOT COALESCE(cl.is_void, false) THEN cl.amount ELSE 0 END) AS manual_in,
      SUM(CASE WHEN cl.type = 'out' AND cl.reference_type = 'manual' AND NOT COALESCE(cl.is_void, false) THEN cl.amount ELSE 0 END) AS manual_out,
      SUM(CASE WHEN cl.type = 'out' AND cl.reference_type = 'refund' AND NOT COALESCE(cl.is_void, false) THEN cl.amount ELSE 0 END) AS refund_out,
      SUM(CASE
        WHEN cl.type = 'out'
         AND cl.reference_type = 'void'
         AND NOT COALESCE(cl.is_void, false)
         AND NOT EXISTS (
           SELECT 1
           FROM public.transactions tx
           WHERE tx.session_id = cl.session_id
             AND tx.payment_method = 'cash'
             AND tx.id::text = cl.reference_id::text
         )
        THEN cl.amount ELSE 0
      END) AS void_out,
      MAX(cl.created_at) AS last_log_at
    FROM public.cash_logs cl
    WHERE cl.session_id IS NOT NULL
    GROUP BY cl.session_id
  ),
  sale_sums AS (
    SELECT
      t.session_id,
      SUM(t.total) AS cash_sales_in,
      MAX(t.created_at) AS last_tx_at
    FROM public.transactions t
    WHERE t.status = 'completed'
      AND t.payment_method = 'cash'
      AND t.session_id IS NOT NULL
    GROUP BY t.session_id
  ),
  deposit_sums AS (
    SELECT
      cd.session_id,
      SUM(cd.amount) FILTER (WHERE cd.status = 'confirmed') AS deposit_confirmed,
      SUM(cd.amount) FILTER (WHERE cd.status = 'pending') AS deposit_pending,
      MAX(cd.created_at) AS last_deposit_at
    FROM public.cash_deposits cd
    WHERE cd.session_id IS NOT NULL
    GROUP BY cd.session_id
  ),
  adjustment_sums AS (
    SELECT
      csa.cash_session_id AS session_id,
      COUNT(*) AS adjustment_count
    FROM public.cash_session_adjustments csa
    GROUP BY csa.cash_session_id
  ),
  enriched AS (
    SELECT
      bs.session_id,
      bs.staff_id,
      bs.staff_name,
      bs.branch_id,
      bs.branch_name,
      bs.session_status,
      bs.opened_at,
      bs.closed_at,
      bs.opening_cash,
      bs.closing_cash,
      COALESCE(ss.cash_sales_in, 0) AS cash_sales_in,
      COALESCE(ls.manual_in, 0) AS manual_in,
      COALESCE(ls.manual_out, 0) AS manual_out,
      COALESCE(ls.refund_out, 0) AS refund_out,
      COALESCE(ls.void_out, 0) AS void_out,
      COALESCE(ds.deposit_confirmed, 0) AS deposit_confirmed,
      COALESCE(ds.deposit_pending, 0) AS deposit_pending,
      (
        bs.opening_cash
        + COALESCE(ss.cash_sales_in, 0)
        + COALESCE(ls.manual_in, 0)
        - COALESCE(ls.manual_out, 0)
        - COALESCE(ls.refund_out, 0)
        - COALESCE(ls.void_out, 0)
      ) AS system_cash_amount,
      bs.current_cash_amount,
      bs.closed_manually,
      (bs.has_manual_adjustment OR COALESCE(adj.adjustment_count, 0) > 0) AS has_manual_adjustment,
      bs.manual_closed_at,
      bs.manual_close_reason,
      bs.updated_at,
      COALESCE(adj.adjustment_count, 0)::bigint AS adjustment_count,
      GREATEST(ls.last_log_at, ss.last_tx_at, ds.last_deposit_at, bs.closed_at, bs.opened_at) AS last_activity_at
    FROM base_sessions bs
    LEFT JOIN log_sums ls ON ls.session_id = bs.session_id
    LEFT JOIN sale_sums ss ON ss.session_id = bs.session_id
    LEFT JOIN deposit_sums ds ON ds.session_id = bs.session_id
    LEFT JOIN adjustment_sums adj ON adj.session_id = bs.session_id
  )
  SELECT
    e.session_id,
    e.staff_id,
    e.staff_name::text,
    e.branch_id,
    e.branch_name::text,
    e.session_status::text,
    e.opened_at,
    e.closed_at,
    e.opening_cash,
    e.closing_cash,
    e.cash_sales_in,
    e.manual_in,
    e.manual_out,
    e.refund_out,
    e.void_out,
    e.deposit_confirmed,
    e.deposit_pending,
    e.system_cash_amount,
    COALESCE(e.current_cash_amount, e.closing_cash, e.system_cash_amount) AS current_cash_amount,
    e.closed_manually,
    e.has_manual_adjustment,
    e.manual_closed_at,
    e.manual_close_reason::text,
    e.updated_at,
    e.adjustment_count,
    e.last_activity_at,
    CASE
      WHEN COALESCE(e.current_cash_amount, e.closing_cash, e.system_cash_amount) < 0 THEN 'danger'
      WHEN ABS(COALESCE(e.current_cash_amount, e.closing_cash, e.system_cash_amount) - e.system_cash_amount) > 100000 THEN 'warning'
      WHEN e.system_cash_amount > 1000000 THEN 'high'
      WHEN e.system_cash_amount > 500000 THEN 'warning'
      ELSE 'normal'
    END::text AS risk_level
  FROM enriched e
  WHERE CASE v_status
    WHEN 'open' THEN e.session_status = 'open'
    WHEN 'closed' THEN e.session_status = 'closed'
    WHEN 'manual_closed' THEN e.closed_manually IS TRUE
    WHEN 'adjusted' THEN e.has_manual_adjustment IS TRUE
    ELSE TRUE
  END
  ORDER BY
    CASE WHEN e.session_status = 'open' THEN 0 ELSE 1 END,
    e.opened_at DESC,
    e.session_id DESC;
END;
$$;

WITH recalculated AS (
  SELECT
    cs.id,
    public.compute_cash_session_system_amount(cs.id) AS expected_cash
  FROM public.cashier_sessions cs
  WHERE cs.status = 'closed'
),
updated_sessions AS (
  UPDATE public.cashier_sessions cs
  SET expected_cash = r.expected_cash
  FROM recalculated r
  WHERE cs.id = r.id
    AND cs.expected_cash IS DISTINCT FROM r.expected_cash
  RETURNING cs.id
)
UPDATE public.branch_cash_ledger l
SET expected_balance = r.expected_cash,
    variance_amount = COALESCE(cs.closing_cash, 0) - COALESCE(r.expected_cash, 0),
    metadata = COALESCE(l.metadata, '{}'::jsonb)
      || jsonb_build_object('expected_repair_migration', '045', 'expected_repaired_at', now())
FROM recalculated r
JOIN public.cashier_sessions cs ON cs.id = r.id
WHERE l.cash_session_id = cs.id
  AND l.movement_type IN ('session_close', 'force_close')
  AND (
    l.expected_balance IS DISTINCT FROM r.expected_cash
    OR l.variance_amount IS DISTINCT FROM COALESCE(cs.closing_cash, 0) - COALESCE(r.expected_cash, 0)
  );

GRANT EXECUTE ON FUNCTION public.compute_cash_session_system_amount(bigint) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.compute_cash_session_system_amount_outlet(bigint) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_deposit_eligible_sessions(bigint, bigint, integer) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.create_deposit(bigint, bigint, bigint, uuid, numeric, numeric, text, text) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.admin_create_manual_deposit(bigint, bigint, bigint, bigint, uuid, numeric, text, text, text, text, text, bigint, timestamptz) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.open_cash_session_from_branch_balance(bigint, bigint, numeric, text) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.admin_set_branch_cash_balance(bigint, bigint, numeric, text, bigint) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.confirm_deposit(uuid, bigint, text, text) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_admin_cash_sessions(bigint, bigint, bigint, text, date, date) TO anon, authenticated;

NOTIFY pgrst, 'reload schema';

COMMIT;
