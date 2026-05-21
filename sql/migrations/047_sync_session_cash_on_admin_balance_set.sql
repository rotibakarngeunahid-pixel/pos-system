-- Migration 047: Sync last closed session's current_cash_amount when admin sets outlet balance.
-- Root cause: get_deposit_eligible_sessions reads final_cash_amount from cashier_sessions
--   (COALESCE current_cash_amount, closing_cash, expected_cash, ...).
-- When admin uses Set Kas to adjust branch_cash_positions.balance, the last closed
-- cashier_session still holds the old cash amount → depositable_cash shows wrong (tiny) value.
-- Fix: after updating branch_cash_positions, also update current_cash_amount of the
-- most recent closed session for that branch to match the new admin-set balance.

BEGIN;

CREATE OR REPLACE FUNCTION public.admin_set_branch_cash_balance(
  p_admin_id    bigint,
  p_branch_id   bigint,
  p_new_balance numeric,
  p_reason      text,
  p_version     bigint DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_admin        record;
  v_pos          public.branch_cash_positions%ROWTYPE;
  v_before       numeric(15,2);
  v_ledger_id    bigint;
  v_session_id   bigint;
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
    SET balance    = p_new_balance,
        version    = version + 1,
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

  -- Sync the most recent closed cashier_session so depositable_cash reflects the
  -- admin-corrected balance. Without this, get_deposit_eligible_sessions still reads
  -- the old current_cash_amount / closing_cash from the session row.
  SELECT id INTO v_session_id
  FROM public.cashier_sessions
  WHERE branch_id = p_branch_id
    AND status = 'closed'
  ORDER BY closed_at DESC NULLS LAST
  LIMIT 1;

  IF v_session_id IS NOT NULL THEN
    UPDATE public.cashier_sessions
    SET current_cash_amount = p_new_balance
    WHERE id = v_session_id;
  END IF;

  -- source_table / source_id dibiarkan NULL agar tidak bentrok dengan unique index
  -- idx_branch_cash_ledger_unique_source (yang hanya aktif saat keduanya NOT NULL).
  INSERT INTO public.branch_cash_ledger (
    branch_id, admin_id,
    movement_type, direction, amount,
    balance_before, balance_after,
    reason, metadata
  ) VALUES (
    p_branch_id, p_admin_id,
    'admin_adjustment', 'adjust', ABS(p_new_balance - v_before),
    v_before, p_new_balance,
    BTRIM(p_reason),
    jsonb_build_object('admin_id', p_admin_id, 'balance_id', v_pos.id)
  )
  RETURNING id INTO v_ledger_id;

  RETURN jsonb_build_object(
    'branch_id',      p_branch_id,
    'balance_before', v_before,
    'balance_after',  p_new_balance,
    'ledger_id',      v_ledger_id,
    'version',        v_pos.version
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.admin_set_branch_cash_balance(bigint, bigint, numeric, text, bigint)
  TO anon, authenticated;

COMMIT;
