-- 037_fix_confirm_deposit_branch_cash_positions.sql
-- Fix approve setoran agar posisi kas outlet (branch_cash_positions) ikut berkurang.
--
-- Penyebab bug:
--   confirm_deposit versi terakhir hanya update status setoran/cash_logs dan saldo staff.
--   Halaman Kas Outlet membaca branch_cash_positions, sehingga approve setoran Rp 200.000
--   masih menampilkan saldo lama Rp 222.000.
--
-- Patch:
--   1. Tambah kolom idempotency khusus apply saldo outlet di cash_deposits.
--   2. Recreate confirm_deposit supaya action confirmed mengurangi branch_cash_positions.
--   3. Backfill aman untuk setoran confirmed lama yang belum pernah apply ke branch cash,
--      hanya jika saldo outlet saat ini masih sama dengan snapshot cash_balance_at_deposit.

BEGIN;

ALTER TABLE public.cash_deposits
  ADD COLUMN IF NOT EXISTS balance_applied_at timestamptz,
  ADD COLUMN IF NOT EXISTS balance_ledger_id bigint,
  ADD COLUMN IF NOT EXISTS branch_cash_applied_at timestamptz,
  ADD COLUMN IF NOT EXISTS branch_cash_balance_before numeric(15,2),
  ADD COLUMN IF NOT EXISTS branch_cash_balance_after numeric(15,2);

CREATE INDEX IF NOT EXISTS idx_cash_deposits_branch_cash_apply
  ON public.cash_deposits(branch_id, branch_cash_applied_at)
  WHERE status = 'confirmed';

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

  v_staff_balance     public.staff_cash_balances%ROWTYPE;
  v_staff_before      numeric;
  v_staff_after       numeric;
  v_staff_ledger_id   bigint;

  v_branch_pos        public.branch_cash_positions%ROWTYPE;
  v_branch_before     numeric;
  v_branch_after      numeric;
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
    AND table_name   = 'cash_deposits'
    AND column_name  = 'reviewed_by';

  SELECT udt_name INTO v_created_by_type
  FROM information_schema.columns
  WHERE table_schema = 'public'
    AND table_name   = 'cash_logs'
    AND column_name  = 'created_by';

  SELECT udt_name INTO v_reference_id_type
  FROM information_schema.columns
  WHERE table_schema = 'public'
    AND table_name   = 'cash_logs'
    AND column_name  = 'reference_id';

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

  IF p_action <> 'confirmed' THEN
    RETURN;
  END IF;

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

  -- Saldo aktif staff tetap dipertahankan dari migration 034.
  IF v_dep.balance_applied_at IS NULL THEN
    SELECT *
      INTO v_staff_balance
    FROM public.staff_cash_balances
    WHERE branch_id = v_dep.branch_id
      AND staff_id  = v_dep.staff_id
    FOR UPDATE;

    IF v_staff_balance.id IS NOT NULL THEN
      v_staff_before := COALESCE(v_staff_balance.current_balance, 0);
      v_staff_after  := GREATEST(v_staff_before - v_dep.amount, 0);

      UPDATE public.staff_cash_balances
      SET current_balance = v_staff_after,
          version         = version + 1,
          updated_by      = p_admin_id,
          updated_at      = now()
      WHERE id = v_staff_balance.id;

      BEGIN
        INSERT INTO public.staff_cash_ledger (
          branch_id, staff_id, deposit_id,
          movement_type, direction, amount,
          balance_before, balance_after,
          reason, source_table, source_id,
          created_by, approved_by, created_at, metadata
        ) VALUES (
          v_dep.branch_id, v_dep.staff_id, p_deposit_id,
          'deposit_approved', 'out', v_dep.amount,
          v_staff_before, v_staff_after,
          'Setoran diapprove - saldo aktif dikurangi',
          'cash_deposits', p_deposit_id::text,
          v_dep.staff_id, p_admin_id, now(),
          jsonb_build_object('deposit_id', p_deposit_id, 'admin_id', p_admin_id)
        ) RETURNING id INTO v_staff_ledger_id;
      EXCEPTION WHEN unique_violation THEN
        NULL;
      END;

      IF v_staff_ledger_id IS NOT NULL THEN
        UPDATE public.cash_deposits
        SET balance_applied_at = now(),
            balance_ledger_id  = v_staff_ledger_id
        WHERE id = p_deposit_id;

        UPDATE public.staff_cash_balances
        SET last_ledger_id = v_staff_ledger_id
        WHERE id = v_staff_balance.id;
      ELSE
        UPDATE public.cash_deposits
        SET balance_applied_at = now()
        WHERE id = p_deposit_id
          AND balance_applied_at IS NULL;
      END IF;
    END IF;
  END IF;

  -- Apply saldo kas outlet yang dipakai halaman Kas Outlet.
  IF v_dep.branch_cash_applied_at IS NULL THEN
    SELECT *
      INTO v_branch_pos
    FROM public.branch_cash_positions
    WHERE branch_id = v_dep.branch_id
    FOR UPDATE;

    IF v_branch_pos.id IS NOT NULL THEN
      v_branch_before := COALESCE(v_branch_pos.balance, 0);
    ELSE
      v_branch_before := COALESCE(
        v_dep.cash_balance_at_deposit,
        v_session.current_cash_amount,
        v_session.closing_cash,
        v_session.expected_cash,
        0
      );
    END IF;

    v_branch_after := v_branch_before - v_dep.amount;
    IF v_branch_after < 0 THEN
      RAISE EXCEPTION 'Nominal setoran (%) melebihi posisi kas outlet saat ini (%). Koreksi kas outlet terlebih dahulu.',
        v_dep.amount, v_branch_before;
    END IF;

    IF v_branch_pos.id IS NOT NULL THEN
      UPDATE public.branch_cash_positions
      SET balance    = v_branch_after,
          version    = version + 1,
          updated_at = now(),
          updated_by = p_admin_id
      WHERE id = v_branch_pos.id;
    ELSE
      INSERT INTO public.branch_cash_positions (
        branch_id, balance, version, updated_at, updated_by
      ) VALUES (
        v_dep.branch_id, v_branch_after, 1, now(), p_admin_id
      );
    END IF;

    UPDATE public.cash_deposits
    SET branch_cash_applied_at     = now(),
        branch_cash_balance_before = v_branch_before,
        branch_cash_balance_after  = v_branch_after
    WHERE id = p_deposit_id;
  END IF;
END;
$$;

GRANT EXECUTE ON FUNCTION public.confirm_deposit(uuid, bigint, text, text)
  TO anon, authenticated;

-- Tampilkan deposit_approved juga di riwayat kas outlet.
CREATE OR REPLACE FUNCTION public.get_branch_cash_ledger(
  p_admin_id      bigint,
  p_branch_id     bigint,
  p_date_from     timestamptz DEFAULT NULL,
  p_date_to       timestamptz DEFAULT NULL,
  p_movement_type text        DEFAULT NULL,
  p_limit         integer     DEFAULT 50
)
RETURNS TABLE (
  id               bigint,
  movement_type    text,
  direction        text,
  amount           numeric,
  balance_before   numeric,
  balance_after    numeric,
  expected_balance numeric,
  variance_amount  numeric,
  reason           text,
  staff_name       text,
  admin_name       text,
  cash_session_id  bigint,
  deposit_id       uuid,
  source_table     text,
  source_id        text,
  created_at       timestamptz,
  metadata         jsonb
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_admin record;
BEGIN
  SELECT id, role INTO v_admin FROM users WHERE id = p_admin_id;
  IF NOT FOUND OR v_admin.role NOT IN ('admin','owner') THEN
    RAISE EXCEPTION 'Hanya admin/owner yang dapat mengakses riwayat ini';
  END IF;

  RETURN QUERY
  SELECT *
  FROM (
    SELECT
      cs.id::bigint                                                              AS id,
      CASE cs.status
        WHEN 'closed' THEN 'session_close'
        ELSE 'session_open_confirm'
      END::text                                                                  AS movement_type,
      CASE cs.status
        WHEN 'closed' THEN 'adjust'::text
        ELSE 'none'::text
      END                                                                        AS direction,
      COALESCE(cs.closing_cash, cs.opening_cash, 0)::numeric                     AS amount,
      COALESCE(cs.opening_cash, 0)::numeric                                      AS balance_before,
      COALESCE(cs.closing_cash, cs.opening_cash, 0)::numeric                     AS balance_after,
      cs.expected_cash::numeric                                                  AS expected_balance,
      (COALESCE(cs.closing_cash, 0) - COALESCE(cs.expected_cash, 0))::numeric    AS variance_amount,
      CASE cs.status WHEN 'closed' THEN 'Shift ditutup' ELSE 'Shift dibuka' END::text AS reason,
      staff.name::text                                                           AS staff_name,
      NULL::text                                                                 AS admin_name,
      cs.id::bigint                                                              AS cash_session_id,
      NULL::uuid                                                                 AS deposit_id,
      'cashier_sessions'::text                                                   AS source_table,
      cs.id::text                                                                AS source_id,
      COALESCE(cs.closed_at, cs.opened_at)::timestamptz                          AS created_at,
      '{}'::jsonb                                                                AS metadata
    FROM cashier_sessions cs
    LEFT JOIN users staff ON staff.id = cs.staff_id
    WHERE cs.branch_id = p_branch_id

    UNION ALL

    SELECT
      NULL::bigint                                                               AS id,
      'deposit_approved'::text                                                   AS movement_type,
      'out'::text                                                                AS direction,
      cd.amount::numeric                                                         AS amount,
      cd.branch_cash_balance_before::numeric                                     AS balance_before,
      cd.branch_cash_balance_after::numeric                                      AS balance_after,
      NULL::numeric                                                              AS expected_balance,
      NULL::numeric                                                              AS variance_amount,
      'Setoran disetujui admin'::text                                            AS reason,
      staff.name::text                                                           AS staff_name,
      admin.name::text                                                           AS admin_name,
      cd.session_id::bigint                                                      AS cash_session_id,
      cd.id::uuid                                                                AS deposit_id,
      'cash_deposits'::text                                                      AS source_table,
      cd.id::text                                                                AS source_id,
      cd.branch_cash_applied_at::timestamptz                                     AS created_at,
      jsonb_build_object('deposit_id', cd.id, 'reviewed_by', cd.reviewed_by)     AS metadata
    FROM cash_deposits cd
    LEFT JOIN users staff ON staff.id = cd.staff_id
    LEFT JOIN users admin ON admin.id::text = cd.reviewed_by::text
    WHERE cd.branch_id = p_branch_id
      AND cd.status = 'confirmed'
      AND cd.branch_cash_applied_at IS NOT NULL
  ) ledger_rows
  WHERE (p_date_from IS NULL OR ledger_rows.created_at >= p_date_from)
    AND (p_date_to   IS NULL OR ledger_rows.created_at <= p_date_to)
    AND (p_movement_type IS NULL OR ledger_rows.movement_type = p_movement_type)
  ORDER BY ledger_rows.created_at DESC
  LIMIT COALESCE(p_limit, 50);
END;
$$;

GRANT EXECUTE ON FUNCTION public.get_branch_cash_ledger(bigint, bigint, timestamptz, timestamptz, text, integer)
  TO anon, authenticated;

-- Backfill aman untuk kasus lama:
-- Hanya apply jika saldo outlet saat ini masih sama persis dengan snapshot saldo
-- pada saat setoran dibuat. Ini menghindari double-subtract saat saldo outlet
-- sudah pernah dikoreksi manual atau sudah berubah oleh shift berikutnya.
DO $$
DECLARE
  r record;
  v_pos public.branch_cash_positions%ROWTYPE;
  v_after numeric(15,2);
BEGIN
  FOR r IN
    SELECT
      cd.id,
      cd.branch_id,
      cd.amount,
      cd.cash_balance_at_deposit,
      cd.reviewed_by,
      cd.reviewed_at
    FROM public.cash_deposits cd
    JOIN public.branch_cash_positions bcp ON bcp.branch_id = cd.branch_id
    WHERE cd.status = 'confirmed'
      AND cd.branch_cash_applied_at IS NULL
      AND cd.cash_balance_at_deposit IS NOT NULL
      AND bcp.balance = cd.cash_balance_at_deposit
      AND bcp.balance >= cd.amount
    ORDER BY COALESCE(cd.reviewed_at, cd.created_at), cd.created_at
  LOOP
    SELECT *
      INTO v_pos
    FROM public.branch_cash_positions
    WHERE branch_id = r.branch_id
    FOR UPDATE;

    IF v_pos.id IS NOT NULL
       AND v_pos.balance = r.cash_balance_at_deposit
       AND v_pos.balance >= r.amount THEN
      v_after := v_pos.balance - r.amount;

      UPDATE public.branch_cash_positions
      SET balance    = v_after,
          version    = version + 1,
          updated_at = now(),
          updated_by = CASE
            WHEN r.reviewed_by IS NOT NULL AND r.reviewed_by::text ~ '^[0-9]+$'
              THEN r.reviewed_by::text::bigint
            ELSE NULL
          END
      WHERE id = v_pos.id;

      UPDATE public.cash_deposits
      SET branch_cash_applied_at     = COALESCE(r.reviewed_at, now()),
          branch_cash_balance_before = v_pos.balance,
          branch_cash_balance_after  = v_after
      WHERE id = r.id;
    END IF;
  END LOOP;
END;
$$;

NOTIFY pgrst, 'reload schema';

COMMIT;
