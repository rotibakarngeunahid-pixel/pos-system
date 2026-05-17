-- 027_manual_deposit_cash_proof_optional.sql
-- Bukti setoran manual admin hanya wajib untuk metode non-cash.
-- Penentuan cash memakai deposit_accounts.type lebih dulu, lalu fallback label.

BEGIN;

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
  v_is_cash_method boolean;
  v_proof_url text;
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
    NULL,
    p_staff_id,
    p_deposit_account_id,
    v_account_label,
    p_amount,
    NULL,
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

GRANT EXECUTE ON FUNCTION public.admin_create_manual_deposit(bigint, bigint, bigint, uuid, numeric, text, text, text, text, text, bigint, timestamptz)
  TO anon, authenticated;

NOTIFY pgrst, 'reload schema';

COMMIT;
