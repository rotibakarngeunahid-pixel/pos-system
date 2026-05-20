-- 038_lock_opening_cash_from_branch_position.sql
-- Kunci kas awal shift staff agar selalu otomatis dari posisi kas outlet terkini.
--
-- Staff tidak boleh menentukan/mengubah kas awal saat buka shift.
-- Admin tetap bisa mengubah sumber kas awal lewat menu Admin > Kas Outlet > Set Kas,
-- karena shift berikutnya akan membaca nilai branch_cash_positions.balance.

BEGIN;

CREATE OR REPLACE FUNCTION public.open_cash_session_from_branch_balance(
  p_branch_id       bigint,
  p_staff_id        bigint,
  p_physical_cash   numeric DEFAULT NULL,
  p_variance_reason text    DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_user         record;
  v_active       record;
  v_opening_cash numeric(15,2);
  v_session      record;
BEGIN
  SELECT id, role, branch_id
    INTO v_user
  FROM users
  WHERE id = p_staff_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Staff tidak ditemukan';
  END IF;

  IF v_user.role NOT IN ('admin','owner')
     AND v_user.branch_id IS DISTINCT FROM p_branch_id THEN
    RAISE EXCEPTION 'Staff tidak memiliki akses ke outlet ini';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtext('branch_cash_open:' || p_branch_id::text));

  SELECT cs.id, u.name AS staff_name, cs.opened_at
    INTO v_active
  FROM cashier_sessions cs
  LEFT JOIN users u ON u.id = cs.staff_id
  WHERE cs.branch_id = p_branch_id
    AND cs.status = 'open'
  ORDER BY cs.opened_at DESC
  LIMIT 1;

  IF FOUND THEN
    RAISE EXCEPTION 'Shift sebelumnya di outlet ini belum ditutup. Staff aktif: %. Silakan tutup kas terlebih dahulu atau hubungi admin.',
      v_active.staff_name;
  END IF;

  SELECT balance
    INTO v_opening_cash
  FROM branch_cash_positions
  WHERE branch_id = p_branch_id
  FOR UPDATE;

  IF NOT FOUND THEN
    SELECT closing_cash
      INTO v_opening_cash
    FROM cashier_sessions
    WHERE branch_id = p_branch_id
      AND status = 'closed'
      AND closing_cash IS NOT NULL
    ORDER BY closed_at DESC
    LIMIT 1;

    v_opening_cash := COALESCE(v_opening_cash, 0);

    INSERT INTO branch_cash_positions (branch_id, balance, version, updated_at, updated_by)
    VALUES (p_branch_id, v_opening_cash, 1, now(), p_staff_id)
    ON CONFLICT (branch_id) DO UPDATE SET
      balance    = EXCLUDED.balance,
      updated_at = now(),
      updated_by = EXCLUDED.updated_by;
  END IF;

  -- p_physical_cash dan p_variance_reason sengaja diabaikan.
  -- Koreksi kas awal hanya boleh melalui admin_set_branch_cash_balance.
  INSERT INTO cashier_sessions (
    branch_id, staff_id, opening_cash, status, opened_at
  ) VALUES (
    p_branch_id, p_staff_id, COALESCE(v_opening_cash, 0), 'open', now()
  )
  RETURNING * INTO v_session;

  RETURN jsonb_build_object(
    'id',                  v_session.id,
    'branch_id',           p_branch_id,
    'staff_id',            p_staff_id,
    'status',              'open',
    'opening_cash',        COALESCE(v_session.opening_cash, v_opening_cash, 0),
    'opening_cash_source', 'branch_balance',
    'opened_at',           v_session.opened_at
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.open_cash_session_from_branch_balance(bigint, bigint, numeric, text)
  TO anon, authenticated;

CREATE OR REPLACE FUNCTION public.enforce_opening_cash_from_branch_position()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_opening_cash numeric(15,2);
BEGIN
  IF TG_OP = 'INSERT' AND COALESCE(NEW.status, 'open') = 'open' THEN
    SELECT balance
      INTO v_opening_cash
    FROM branch_cash_positions
    WHERE branch_id = NEW.branch_id;

    IF v_opening_cash IS NULL THEN
      SELECT closing_cash
        INTO v_opening_cash
      FROM cashier_sessions
      WHERE branch_id = NEW.branch_id
        AND status = 'closed'
        AND closing_cash IS NOT NULL
      ORDER BY closed_at DESC
      LIMIT 1;
    END IF;

    NEW.opening_cash := COALESCE(v_opening_cash, 0);
    RETURN NEW;
  END IF;

  IF TG_OP = 'UPDATE'
     AND NEW.opening_cash IS DISTINCT FROM OLD.opening_cash THEN
    RAISE EXCEPTION 'Kas awal dikunci dari posisi kas outlet. Admin harus memakai menu Kas Outlet > Set Kas untuk koreksi.';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_enforce_opening_cash_from_branch_position
  ON public.cashier_sessions;

CREATE TRIGGER trg_enforce_opening_cash_from_branch_position
BEFORE INSERT OR UPDATE OF opening_cash ON public.cashier_sessions
FOR EACH ROW
EXECUTE FUNCTION public.enforce_opening_cash_from_branch_position();

NOTIFY pgrst, 'reload schema';

COMMIT;
