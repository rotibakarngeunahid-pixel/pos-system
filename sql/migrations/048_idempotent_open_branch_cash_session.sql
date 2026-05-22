-- Migration 048: Make opening a branch cash session idempotent.
-- Root cause observed in POS: duplicate/open-shift race can surface the raw
-- idx_cashier_sessions_one_open_per_branch unique violation to staff.
-- Fix:
-- - Keep one open shift per outlet.
-- - Return the existing open session when the same staff retries/double-taps.
-- - Raise a business message when another staff still owns the open shift.

BEGIN;

ALTER TABLE public.cashier_sessions
  ADD COLUMN IF NOT EXISTS opening_cash_source text DEFAULT 'branch_balance';

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

  SELECT cs.id, cs.branch_id, cs.staff_id, cs.status, cs.opened_at,
         cs.opening_cash, cs.opening_cash_source, u.name::text AS staff_name
    INTO v_active
  FROM public.cashier_sessions cs
  LEFT JOIN public.users u ON u.id = cs.staff_id
  WHERE cs.branch_id = p_branch_id
    AND cs.status = 'open'
  ORDER BY cs.opened_at DESC
  LIMIT 1;

  IF FOUND THEN
    IF v_active.staff_id IS NOT DISTINCT FROM p_staff_id THEN
      RETURN jsonb_build_object(
        'id', v_active.id,
        'branch_id', v_active.branch_id,
        'staff_id', v_active.staff_id,
        'status', v_active.status,
        'opening_cash', COALESCE(v_active.opening_cash, 0),
        'opening_cash_source', COALESCE(v_active.opening_cash_source, 'branch_balance'),
        'opened_at', v_active.opened_at,
        'already_open', true
      );
    END IF;

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
    SELECT cs.id, cs.branch_id, cs.staff_id, cs.status, cs.opened_at,
           cs.opening_cash, cs.opening_cash_source, u.name::text AS staff_name
      INTO v_active
    FROM public.cashier_sessions cs
    LEFT JOIN public.users u ON u.id = cs.staff_id
    WHERE cs.branch_id = p_branch_id
      AND cs.status = 'open'
    ORDER BY cs.opened_at DESC
    LIMIT 1;

    IF FOUND AND v_active.staff_id IS NOT DISTINCT FROM p_staff_id THEN
      RETURN jsonb_build_object(
        'id', v_active.id,
        'branch_id', v_active.branch_id,
        'staff_id', v_active.staff_id,
        'status', v_active.status,
        'opening_cash', COALESCE(v_active.opening_cash, 0),
        'opening_cash_source', COALESCE(v_active.opening_cash_source, 'branch_balance'),
        'opened_at', v_active.opened_at,
        'already_open', true
      );
    END IF;

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
    'ledger_id', v_ledger_id,
    'already_open', false
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.open_cash_session_from_branch_balance(bigint, bigint, numeric, text)
  TO anon, authenticated;

NOTIFY pgrst, 'reload schema';

COMMIT;
