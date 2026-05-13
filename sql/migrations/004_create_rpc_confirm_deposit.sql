-- 004_create_rpc_confirm_deposit.sql
-- RPC: confirm_deposit — confirm or reject a deposit; if confirmed insert cash_logs out entry

BEGIN;

CREATE OR REPLACE FUNCTION public.confirm_deposit(
  p_deposit_id uuid,
  p_admin_id uuid,
  p_action text,
  p_reject_reason text DEFAULT NULL
) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE v_dep public.cash_deposits%ROWTYPE;
        v_cat_id uuid;
BEGIN
  IF p_action NOT IN ('confirmed','rejected') THEN
    RAISE EXCEPTION 'p_action must be ''confirmed'' or ''rejected''';
  END IF;

  SELECT * INTO v_dep FROM public.cash_deposits WHERE id = p_deposit_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Deposit tidak ditemukan'; END IF;
  IF v_dep.status <> 'pending' THEN RAISE EXCEPTION 'Deposit sudah diproses'; END IF;

  UPDATE public.cash_deposits SET
    status       = p_action,
    reviewed_by  = p_admin_id,
    reviewed_at  = now(),
    reject_reason = p_reject_reason
  WHERE id = p_deposit_id;

  IF p_action = 'confirmed' THEN
    SELECT id INTO v_cat_id FROM public.cash_categories
      WHERE name = 'Setoran Tunai' AND type = 'out' LIMIT 1;

    INSERT INTO public.cash_logs (
      branch_id, session_id, type, category_id, amount, note,
      created_by, reference_type, reference_id, is_void
    ) VALUES (
      v_dep.branch_id, v_dep.session_id, 'out', v_cat_id,
      v_dep.amount,
      'Setoran #' || v_dep.id::text,
      p_admin_id, 'deposit', v_dep.id, false
    );
  END IF;
END;
$$;

COMMIT;
