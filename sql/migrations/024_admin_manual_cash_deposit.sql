-- 024_admin_manual_cash_deposit.sql
-- Allow admins to record a manual cash deposit for an active staff member
-- assigned to a selected branch. The deposit is stored in cash_deposits so it
-- appears in that staff member's deposit history.

BEGIN;

ALTER TABLE public.cash_deposits
  ALTER COLUMN cash_balance_at_deposit DROP NOT NULL,
  ALTER COLUMN proof_url DROP NOT NULL;

DROP FUNCTION IF EXISTS public.admin_create_manual_deposit(uuid, bigint, bigint, uuid, numeric, text, text);
DROP FUNCTION IF EXISTS public.admin_create_manual_deposit(bigint, bigint, bigint, uuid, numeric, text, text);

CREATE OR REPLACE FUNCTION public.admin_create_manual_deposit(
  p_admin_id bigint,
  p_branch_id bigint,
  p_staff_id bigint,
  p_deposit_account_id uuid,
  p_amount numeric,
  p_notes text DEFAULT NULL,
  p_status text DEFAULT 'confirmed'
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

  SELECT type, branch_id
    INTO v_account_type, v_account_branch_id
  FROM public.deposit_accounts
  WHERE id = p_deposit_account_id
    AND is_active = true;

  IF v_account_type IS NULL THEN
    RAISE EXCEPTION 'Metode setoran tidak valid atau tidak aktif';
  END IF;

  IF v_account_type <> 'cash' THEN
    RAISE EXCEPTION 'Input manual setoran tunai hanya memakai metode Cash';
  END IF;

  IF v_account_branch_id IS NOT NULL AND v_account_branch_id <> p_branch_id THEN
    RAISE EXCEPTION 'Metode setoran tidak tersedia untuk cabang ini';
  END IF;

  INSERT INTO public.cash_deposits (
    branch_id,
    session_id,
    staff_id,
    deposit_account_id,
    amount,
    cash_balance_at_deposit,
    proof_url,
    notes,
    status
  ) VALUES (
    p_branch_id,
    NULL,
    p_staff_id,
    p_deposit_account_id,
    p_amount,
    NULL,
    NULL,
    NULLIF(BTRIM(COALESCE(p_notes, '')), ''),
    'pending'
  ) RETURNING id INTO v_id;

  IF v_status = 'confirmed' THEN
    PERFORM public.confirm_deposit(v_id, p_admin_id, 'confirmed', NULL);
  END IF;

  RETURN v_id;
END;
$$;

GRANT EXECUTE ON FUNCTION public.admin_create_manual_deposit(bigint, bigint, bigint, uuid, numeric, text, text)
  TO anon, authenticated;

NOTIFY pgrst, 'reload schema';

COMMIT;
