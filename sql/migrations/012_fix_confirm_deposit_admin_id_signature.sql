-- 012_fix_confirm_deposit_admin_id_signature.sql
-- Remove stale confirm_deposit overloads that treat p_admin_id as uuid.

BEGIN;

DROP FUNCTION IF EXISTS public.confirm_deposit(uuid, uuid, text, text);
DROP FUNCTION IF EXISTS public.confirm_deposit(uuid, bigint, text, text);

CREATE OR REPLACE FUNCTION public.confirm_deposit(
  p_deposit_id uuid,
  p_admin_id bigint,
  p_action text,
  p_reject_reason text DEFAULT NULL
) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_dep public.cash_deposits%ROWTYPE;
  v_cat_id uuid;
  v_role text;
BEGIN
  SELECT role INTO v_role
  FROM public.users
  WHERE id = p_admin_id;

  IF v_role IS NULL OR v_role <> 'admin' THEN
    RAISE EXCEPTION 'Hanya admin yang dapat mengkonfirmasi atau menolak setoran';
  END IF;

  IF p_action NOT IN ('confirmed','rejected') THEN
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

  UPDATE public.cash_deposits
  SET status = p_action,
      reviewed_by = p_admin_id,
      reviewed_at = now(),
      reject_reason = CASE
        WHEN p_action = 'rejected' THEN NULLIF(BTRIM(COALESCE(p_reject_reason, '')), '')
        ELSE NULL
      END
  WHERE id = p_deposit_id;

  IF p_action = 'confirmed' THEN
    SELECT id
      INTO v_cat_id
    FROM public.cash_categories
    WHERE name = 'Setoran Tunai'
      AND type = 'out'
    LIMIT 1;

    INSERT INTO public.cash_logs (
      branch_id, session_id, type, category_id, amount, note,
      created_by, reference_type, reference_id, is_void
    ) VALUES (
      v_dep.branch_id, v_dep.session_id, 'out', v_cat_id, v_dep.amount,
      'Setoran #' || left(v_dep.id::text, 8),
      p_admin_id, 'deposit', v_dep.id, false
    );
  END IF;
END;
$$;

GRANT EXECUTE ON FUNCTION public.confirm_deposit(uuid, bigint, text, text)
  TO anon, authenticated;

NOTIFY pgrst, 'reload schema';

COMMIT;
