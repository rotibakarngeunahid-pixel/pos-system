-- 031_fix_confirm_deposit_category_id_type_after_closed_shift.sql
-- Hotfix untuk database yang sudah menjalankan 030.
-- 030 sempat mendeklarasikan v_cat_id sebagai uuid, sedangkan
-- cash_categories.id pada skema produksi bertipe bigint. Nilai kategori
-- seperti 12 akhirnya gagal dengan:
-- invalid input syntax for type uuid: "12".

BEGIN;

DROP FUNCTION IF EXISTS public.confirm_deposit(uuid, uuid, text, text);
DROP FUNCTION IF EXISTS public.confirm_deposit(uuid, bigint, text, text);

CREATE OR REPLACE FUNCTION public.confirm_deposit(
  p_deposit_id    uuid,
  p_admin_id      bigint,
  p_action        text,
  p_reject_reason text DEFAULT NULL
) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_dep               public.cash_deposits%ROWTYPE;
  v_session           public.cashier_sessions%ROWTYPE;
  v_cat_id            public.cash_categories.id%TYPE;
  v_role              text;
  v_reviewed_by_type  text;
  v_created_by_type   text;
  v_reference_id_type text;
  v_update_sql        text;
  v_log_cols          text;
  v_log_vals          text;
  v_log_note          text;
BEGIN
  SELECT role INTO v_role
  FROM public.users
  WHERE id::text = p_admin_id::text;

  IF v_role IS NULL OR v_role NOT IN ('admin', 'owner') THEN
    RAISE EXCEPTION 'Hanya admin yang dapat mengkonfirmasi atau menolak setoran';
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

  SELECT udt_name INTO v_reviewed_by_type
  FROM information_schema.columns
  WHERE table_schema = 'public'
    AND table_name = 'cash_deposits'
    AND column_name = 'reviewed_by';

  SELECT udt_name INTO v_created_by_type
  FROM information_schema.columns
  WHERE table_schema = 'public'
    AND table_name = 'cash_logs'
    AND column_name = 'created_by';

  SELECT udt_name INTO v_reference_id_type
  FROM information_schema.columns
  WHERE table_schema = 'public'
    AND table_name = 'cash_logs'
    AND column_name = 'reference_id';

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

  EXECUTE v_update_sql
    USING p_action, p_reject_reason, p_admin_id, p_deposit_id;

  IF p_action = 'confirmed' THEN
    SELECT id
      INTO v_cat_id
    FROM public.cash_categories
    WHERE name = 'Setoran Tunai'
      AND type = 'out'
    LIMIT 1;

    v_log_note := 'Setoran #' || left(v_dep.id::text, 8);
    v_log_cols := 'branch_id, session_id, type, category_id, amount, note, reference_type, is_void';
    v_log_vals := '$1, $2, ''out'', $3, $4, $5, ''deposit'', false';

    IF v_created_by_type IN ('int2', 'int4', 'int8', 'numeric') THEN
      v_log_cols := v_log_cols || ', created_by';
      v_log_vals := v_log_vals || ', $6';
    ELSIF v_created_by_type IN ('text', 'varchar', 'bpchar') THEN
      v_log_cols := v_log_cols || ', created_by';
      v_log_vals := v_log_vals || ', $6::text';
    ELSE
      v_log_note := v_log_note || ' - admin #' || p_admin_id::text;
    END IF;

    IF v_reference_id_type = 'uuid' THEN
      v_log_cols := v_log_cols || ', reference_id';
      v_log_vals := v_log_vals || ', $7';
    ELSIF v_reference_id_type IN ('text', 'varchar', 'bpchar') THEN
      v_log_cols := v_log_cols || ', reference_id';
      v_log_vals := v_log_vals || ', $8';
    END IF;

    EXECUTE 'INSERT INTO public.cash_logs (' || v_log_cols || ') VALUES (' || v_log_vals || ')'
      USING v_dep.branch_id, v_dep.session_id, v_cat_id, v_dep.amount,
            v_log_note, p_admin_id, v_dep.id, v_dep.id::text;
  END IF;
END;
$$;

GRANT EXECUTE ON FUNCTION public.confirm_deposit(uuid, bigint, text, text)
  TO anon, authenticated;

NOTIFY pgrst, 'reload schema';

COMMIT;
