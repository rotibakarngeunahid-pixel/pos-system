-- Migration 041: Hardening flow kas outlet
-- Tujuan:
-- 1. Kas awal shift selalu dari branch_cash_positions.balance.
-- 2. Hanya satu shift open per outlet; staff lain diblokir dengan pesan jelas.
-- 3. Tutup shift memperbarui saldo kas outlet.
-- 4. Setoran pending tidak mengurangi saldo outlet; setoran confirmed mengurangi saldo outlet.
-- 5. Staff cash balance lama tidak lagi menjadi sumber mutasi kas.

BEGIN;

-- Default kas outlet hanya dipakai saat outlet belum punya posisi kas dan belum punya riwayat close.
ALTER TABLE public.branches
  ADD COLUMN IF NOT EXISTS default_cash_position numeric(15,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS default_cash_updated_at timestamptz,
  ADD COLUMN IF NOT EXISTS default_cash_updated_by bigint REFERENCES public.users(id);

-- Tabel posisi kas outlet: satu row per outlet.
CREATE TABLE IF NOT EXISTS public.branch_cash_positions (
  id         bigserial PRIMARY KEY,
  branch_id  bigint NOT NULL UNIQUE REFERENCES public.branches(id),
  balance    numeric(15,2) NOT NULL DEFAULT 0 CHECK (balance >= 0),
  version    bigint NOT NULL DEFAULT 1,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by bigint REFERENCES public.users(id)
);

-- Ledger outlet ringan. Jika migration 035 pernah membuat tabel ini, struktur ini kompatibel
-- dengan kolom yang dipakai UI Kas Outlet.
CREATE TABLE IF NOT EXISTS public.branch_cash_ledger (
  id               bigserial PRIMARY KEY,
  branch_id        bigint NOT NULL REFERENCES public.branches(id),
  staff_id         bigint REFERENCES public.users(id),
  admin_id         bigint REFERENCES public.users(id),
  cash_session_id  bigint REFERENCES public.cashier_sessions(id),
  deposit_id       uuid REFERENCES public.cash_deposits(id),
  movement_type    text NOT NULL,
  direction        text NOT NULL DEFAULT 'none',
  amount           numeric(15,2) NOT NULL DEFAULT 0,
  balance_before   numeric(15,2) NOT NULL DEFAULT 0,
  balance_after    numeric(15,2) NOT NULL DEFAULT 0,
  expected_balance numeric(15,2),
  variance_amount  numeric(15,2),
  reason           text,
  source_table     text,
  source_id        text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  metadata         jsonb NOT NULL DEFAULT '{}'::jsonb
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_branch_cash_ledger_unique_source
  ON public.branch_cash_ledger(source_table, source_id, movement_type)
  WHERE source_table IS NOT NULL AND source_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_branch_cash_ledger_branch_created
  ON public.branch_cash_ledger(branch_id, created_at DESC);

ALTER TABLE public.cashier_sessions
  ADD COLUMN IF NOT EXISTS opening_cash_source text DEFAULT 'branch_balance',
  ADD COLUMN IF NOT EXISTS closing_note text,
  ADD COLUMN IF NOT EXISTS balance_applied_at timestamptz,
  ADD COLUMN IF NOT EXISTS branch_balance_ledger_id bigint;

ALTER TABLE public.cash_deposits
  ADD COLUMN IF NOT EXISTS branch_cash_applied_at timestamptz,
  ADD COLUMN IF NOT EXISTS branch_cash_balance_before numeric(15,2),
  ADD COLUMN IF NOT EXISTS branch_cash_balance_after numeric(15,2),
  ADD COLUMN IF NOT EXISTS branch_cash_ledger_id bigint;

-- Defense in depth: satu shift open per outlet.
CREATE UNIQUE INDEX IF NOT EXISTS idx_cashier_sessions_one_open_per_branch
  ON public.cashier_sessions(branch_id)
  WHERE status = 'open';

-- Helper internal: estimasi kas sistem untuk satu session.
-- Formula disamakan dengan cashService.getSummary().
CREATE OR REPLACE FUNCTION public.compute_cash_session_system_amount_outlet(
  p_session_id bigint
) RETURNS numeric
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_amount numeric;
BEGIN
  WITH sess AS (
    SELECT id, opening_cash
    FROM public.cashier_sessions
    WHERE id = p_session_id
  ),
  log_sums AS (
    SELECT
      SUM(CASE WHEN cl.type = 'in' AND cl.reference_type = 'manual' AND NOT COALESCE(cl.is_void, false) THEN cl.amount ELSE 0 END) AS manual_in,
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
      SUM(CASE WHEN cl.type = 'out' AND cl.reference_type = 'deposit' AND NOT COALESCE(cl.is_void, false) THEN cl.amount ELSE 0 END) AS deposit_out,
      SUM(CASE WHEN cl.type = 'in' AND cl.reference_type = 'sale' AND NOT COALESCE(cl.is_void, false) THEN cl.amount ELSE 0 END) AS sales_from_logs
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
    + COALESCE(ss.cash_sales_in, ls.sales_from_logs, 0)
    + COALESCE(ls.manual_in, 0)
    - COALESCE(ls.manual_out, 0)
    - COALESCE(ls.refund_out, 0)
    - COALESCE(ls.void_out, 0)
    - COALESCE(ls.deposit_out, 0)
  INTO v_amount
  FROM sess s
  CROSS JOIN log_sums ls
  CROSS JOIN sale_sums ss;

  RETURN COALESCE(v_amount, 0);
END;
$$;

CREATE OR REPLACE FUNCTION public.get_branch_cash_position(
  p_branch_id bigint,
  p_user_id bigint DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_branch record;
  v_user record;
  v_pos record;
  v_open_sess record;
  v_last_closed record;
  v_pending_dep numeric(15,2);
  v_source text;
  v_cur_balance numeric(15,2);
BEGIN
  SELECT id, name, COALESCE(default_cash_position, 0) AS default_cash_position
    INTO v_branch
  FROM public.branches
  WHERE id = p_branch_id
    AND COALESCE(is_active, true) = true;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Outlet tidak ditemukan atau tidak aktif';
  END IF;

  IF p_user_id IS NOT NULL THEN
    SELECT id, role, branch_id
      INTO v_user
    FROM public.users
    WHERE id = p_user_id;

    IF FOUND
       AND v_user.role NOT IN ('admin', 'owner')
       AND v_user.branch_id IS DISTINCT FROM p_branch_id THEN
      RAISE EXCEPTION 'Tidak memiliki akses ke outlet ini';
    END IF;
  END IF;

  SELECT *
    INTO v_pos
  FROM public.branch_cash_positions
  WHERE branch_id = p_branch_id;

  SELECT cs.id, cs.staff_id, cs.opened_at, cs.opening_cash, u.name::text AS staff_name
    INTO v_open_sess
  FROM public.cashier_sessions cs
  LEFT JOIN public.users u ON u.id = cs.staff_id
  WHERE cs.branch_id = p_branch_id
    AND cs.status = 'open'
  ORDER BY cs.opened_at DESC
  LIMIT 1;

  SELECT cs.id, cs.staff_id, cs.closed_at, cs.closing_cash, cs.opening_cash,
         cs.expected_cash, u.name::text AS staff_name
    INTO v_last_closed
  FROM public.cashier_sessions cs
  LEFT JOIN public.users u ON u.id = cs.staff_id
  WHERE cs.branch_id = p_branch_id
    AND cs.status = 'closed'
    AND cs.closing_cash IS NOT NULL
  ORDER BY cs.closed_at DESC
  LIMIT 1;

  IF v_pos.id IS NOT NULL THEN
    v_cur_balance := COALESCE(v_pos.balance, 0);
    v_source := 'branch_balance';
  ELSIF v_last_closed.id IS NOT NULL THEN
    v_cur_balance := COALESCE(v_last_closed.closing_cash, 0);
    v_source := 'latest_closed_session';
  ELSE
    v_cur_balance := COALESCE(v_branch.default_cash_position, 0);
    v_source := 'default_cash';
  END IF;

  SELECT COALESCE(SUM(amount), 0)
    INTO v_pending_dep
  FROM public.cash_deposits
  WHERE branch_id = p_branch_id
    AND status = 'pending';

  RETURN jsonb_build_object(
    'branch_id', p_branch_id,
    'branch_name', v_branch.name,
    'balance_id', v_pos.id,
    'current_balance', v_cur_balance,
    'source', v_source,
    'version', COALESCE(v_pos.version, 0),
    'has_balance_row', v_pos.id IS NOT NULL,
    'current_status', CASE WHEN v_open_sess.id IS NOT NULL THEN 'active' ELSE 'idle' END,
    'open_session', CASE WHEN v_open_sess.id IS NOT NULL THEN jsonb_build_object(
      'id', v_open_sess.id,
      'staff_id', v_open_sess.staff_id,
      'staff_name', v_open_sess.staff_name,
      'opened_at', v_open_sess.opened_at,
      'opening_cash', v_open_sess.opening_cash
    ) ELSE NULL END,
    'last_closed_session', CASE WHEN v_last_closed.id IS NOT NULL THEN jsonb_build_object(
      'id', v_last_closed.id,
      'staff_id', v_last_closed.staff_id,
      'staff_name', v_last_closed.staff_name,
      'closed_at', v_last_closed.closed_at,
      'opening_cash', v_last_closed.opening_cash,
      'closing_cash', v_last_closed.closing_cash,
      'expected_cash', v_last_closed.expected_cash,
      'variance', COALESCE(v_last_closed.closing_cash, 0) - COALESCE(v_last_closed.expected_cash, 0)
    ) ELSE NULL END,
    'pending_deposit_amount', v_pending_dep,
    'updated_at', COALESCE(v_pos.updated_at, v_last_closed.closed_at, now())
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.get_admin_branch_cash_positions(
  p_admin_id bigint,
  p_branch_id bigint DEFAULT NULL,
  p_staff_id bigint DEFAULT NULL,
  p_status text DEFAULT 'all',
  p_date_from date DEFAULT NULL,
  p_date_to date DEFAULT NULL
)
RETURNS TABLE (
  branch_id bigint,
  branch_name text,
  current_balance numeric,
  running_estimated_cash numeric,
  balance_id bigint,
  version bigint,
  last_opening_cash numeric,
  last_closing_cash numeric,
  last_opened_by_name text,
  last_closed_by_name text,
  last_updated timestamptz,
  shift_status text,
  open_session_id bigint,
  open_staff_name text,
  open_session_opened_at timestamptz,
  pending_deposit_amount numeric,
  last_variance_amount numeric,
  has_variance boolean,
  default_cash_position numeric
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_admin record;
BEGIN
  SELECT u.id, u.role INTO v_admin
  FROM public.users u
  WHERE u.id = p_admin_id;

  IF NOT FOUND OR v_admin.role NOT IN ('admin', 'owner') THEN
    RAISE EXCEPTION 'Hanya admin/owner yang dapat mengakses data ini';
  END IF;

  RETURN QUERY
  WITH open_sess AS (
    SELECT cs.id, cs.branch_id, cs.staff_id, cs.opened_at, cs.opening_cash,
           u.name::text AS staff_name
    FROM public.cashier_sessions cs
    LEFT JOIN public.users u ON u.id = cs.staff_id
    WHERE cs.status = 'open'
      AND (p_staff_id IS NULL OR cs.staff_id = p_staff_id)
  ),
  last_closed AS (
    SELECT DISTINCT ON (cs.branch_id)
           cs.branch_id,
           cs.id AS session_id,
           cs.staff_id,
           cs.opening_cash,
           cs.closing_cash,
           cs.closed_at,
           COALESCE(cs.closing_cash, 0) - COALESCE(cs.expected_cash, 0) AS variance,
           u.name::text AS staff_name
    FROM public.cashier_sessions cs
    LEFT JOIN public.users u ON u.id = cs.staff_id
    WHERE cs.status = 'closed'
      AND cs.closing_cash IS NOT NULL
      AND (p_staff_id IS NULL OR cs.staff_id = p_staff_id)
      AND (p_date_from IS NULL OR cs.closed_at::date >= p_date_from)
      AND (p_date_to IS NULL OR cs.closed_at::date <= p_date_to)
    ORDER BY cs.branch_id, cs.closed_at DESC
  ),
  pending AS (
    SELECT cd.branch_id, SUM(cd.amount) AS total
    FROM public.cash_deposits cd
    WHERE cd.status = 'pending'
    GROUP BY cd.branch_id
  ),
  rows AS (
    SELECT
      b.id::bigint AS branch_id,
      b.name::text AS branch_name,
      COALESCE(bcp.balance, lc.closing_cash, b.default_cash_position, 0)::numeric AS current_balance,
      NULL::numeric AS running_estimated_cash,
      bcp.id::bigint AS balance_id,
      COALESCE(bcp.version, 0)::bigint AS version,
      COALESCE(os.opening_cash, lc.opening_cash)::numeric AS last_opening_cash,
      lc.closing_cash::numeric AS last_closing_cash,
      COALESCE(os.staff_name, lc.staff_name)::text AS last_opened_by_name,
      lc.staff_name::text AS last_closed_by_name,
      COALESCE(bcp.updated_at, os.opened_at, lc.closed_at)::timestamptz AS last_updated,
      CASE
        WHEN os.id IS NOT NULL THEN 'open'
        WHEN lc.session_id IS NOT NULL
          AND (lc.closed_at AT TIME ZONE 'Asia/Jakarta')::date = (now() AT TIME ZONE 'Asia/Jakarta')::date
          THEN 'closed_today'
        ELSE 'none'
      END::text AS shift_status,
      os.id::bigint AS open_session_id,
      os.staff_name::text AS open_staff_name,
      os.opened_at::timestamptz AS open_session_opened_at,
      COALESCE(pd.total, 0)::numeric AS pending_deposit_amount,
      lc.variance::numeric AS last_variance_amount,
      (lc.variance IS NOT NULL AND lc.variance <> 0)::boolean AS has_variance,
      COALESCE(b.default_cash_position, 0)::numeric AS default_cash_position
    FROM public.branches b
    LEFT JOIN public.branch_cash_positions bcp ON bcp.branch_id = b.id
    LEFT JOIN open_sess os ON os.branch_id = b.id
    LEFT JOIN last_closed lc ON lc.branch_id = b.id
    LEFT JOIN pending pd ON pd.branch_id = b.id
    WHERE COALESCE(b.is_active, true) = true
      AND (p_branch_id IS NULL OR b.id = p_branch_id)
  )
  SELECT r.*
  FROM rows r
  WHERE COALESCE(p_status, 'all') = 'all'
     OR r.shift_status = p_status
     OR (p_status = 'adjusted' AND r.has_variance)
     OR (p_status = 'manual_closed' AND false)
  ORDER BY r.branch_name;
END;
$$;

CREATE OR REPLACE FUNCTION public.open_cash_session_from_branch_balance(
  p_branch_id bigint,
  p_staff_id bigint,
  p_physical_cash numeric DEFAULT NULL,
  p_variance_reason text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_user record;
  v_branch record;
  v_active record;
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

CREATE OR REPLACE FUNCTION public.close_cash_session_apply_branch_balance(
  p_session_id bigint,
  p_closing_cash numeric,
  p_staff_id bigint,
  p_closing_note text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_session public.cashier_sessions%ROWTYPE;
  v_pos public.branch_cash_positions%ROWTYPE;
  v_expected numeric(15,2);
  v_variance numeric(15,2);
  v_before numeric(15,2);
  v_ledger_id bigint;
BEGIN
  IF p_closing_cash IS NULL OR p_closing_cash < 0 THEN
    RAISE EXCEPTION 'Kas akhir tidak boleh negatif';
  END IF;

  SELECT *
    INTO v_session
  FROM public.cashier_sessions
  WHERE id = p_session_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Sesi tidak ditemukan';
  END IF;

  IF v_session.status = 'closed' THEN
    RETURN jsonb_build_object(
      'already_closed', true,
      'id', v_session.id,
      'status', 'closed',
      'closing_cash', v_session.closing_cash,
      'expected_cash', v_session.expected_cash,
      'variance', COALESCE(v_session.closing_cash, 0) - COALESCE(v_session.expected_cash, 0),
      'balance_after', COALESCE(v_session.closing_cash, 0)
    );
  END IF;

  IF v_session.staff_id <> p_staff_id THEN
    RAISE EXCEPTION 'Sesi ini bukan milik staff yang bersangkutan';
  END IF;

  v_expected := public.compute_cash_session_system_amount_outlet(p_session_id);
  v_variance := p_closing_cash - COALESCE(v_expected, 0);

  SELECT *
    INTO v_pos
  FROM public.branch_cash_positions
  WHERE branch_id = v_session.branch_id
  FOR UPDATE;

  IF v_pos.id IS NULL THEN
    v_before := COALESCE(v_session.opening_cash, 0);
    INSERT INTO public.branch_cash_positions (branch_id, balance, version, updated_at, updated_by)
    VALUES (v_session.branch_id, v_before, 1, now(), p_staff_id)
    RETURNING * INTO v_pos;
  ELSE
    v_before := COALESCE(v_pos.balance, 0);
  END IF;

  UPDATE public.cashier_sessions
  SET status = 'closed',
      closing_cash = p_closing_cash,
      expected_cash = v_expected,
      current_cash_amount = p_closing_cash,
      closed_at = now(),
      closing_note = NULLIF(BTRIM(COALESCE(p_closing_note, '')), ''),
      balance_applied_at = COALESCE(balance_applied_at, now())
  WHERE id = p_session_id
  RETURNING * INTO v_session;

  UPDATE public.branch_cash_positions
  SET balance = p_closing_cash,
      version = version + 1,
      updated_at = now(),
      updated_by = p_staff_id
  WHERE id = v_pos.id;

  INSERT INTO public.branch_cash_ledger (
    branch_id, staff_id, cash_session_id,
    movement_type, direction, amount,
    balance_before, balance_after, expected_balance, variance_amount,
    reason, source_table, source_id, metadata
  ) VALUES (
    v_session.branch_id, p_staff_id, p_session_id,
    'session_close',
    CASE WHEN p_closing_cash >= v_before THEN 'in' ELSE 'out' END,
    ABS(p_closing_cash - v_before),
    v_before, p_closing_cash, v_expected, v_variance,
    COALESCE(NULLIF(BTRIM(COALESCE(p_closing_note, '')), ''), 'Shift ditutup'),
    'cashier_sessions', p_session_id::text,
    jsonb_build_object('closing_cash', p_closing_cash, 'expected_cash', v_expected)
  )
  ON CONFLICT DO NOTHING
  RETURNING id INTO v_ledger_id;

  IF v_ledger_id IS NOT NULL THEN
    UPDATE public.cashier_sessions
    SET branch_balance_ledger_id = v_ledger_id
    WHERE id = p_session_id;
  END IF;

  RETURN jsonb_build_object(
    'id', p_session_id,
    'status', 'closed',
    'closing_cash', p_closing_cash,
    'expected_cash', v_expected,
    'variance', v_variance,
    'balance_before', v_before,
    'balance_after', p_closing_cash,
    'ledger_id', v_ledger_id,
    'already_closed', false
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.admin_set_branch_cash_balance(
  p_admin_id bigint,
  p_branch_id bigint,
  p_new_balance numeric,
  p_reason text,
  p_version bigint DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_admin record;
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

DROP FUNCTION IF EXISTS public.confirm_deposit(uuid, uuid, text, text);
DROP FUNCTION IF EXISTS public.confirm_deposit(uuid, bigint, text, text);

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
  v_cat_id public.cash_categories.id%TYPE;
  v_role text;
  v_reviewed_by_type text;
  v_created_by_type text;
  v_reference_id_type text;
  v_update_sql text;
  v_log_cols text;
  v_log_vals text;
  v_log_note text;
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

  IF p_action = 'rejected' THEN
    INSERT INTO public.branch_cash_ledger (
      branch_id, staff_id, admin_id, cash_session_id, deposit_id,
      movement_type, direction, amount,
      balance_before, balance_after,
      reason, source_table, source_id, metadata
    ) VALUES (
      v_dep.branch_id, v_dep.staff_id, p_admin_id, v_dep.session_id, p_deposit_id,
      'deposit_rejected', 'none', v_dep.amount,
      COALESCE(v_dep.cash_balance_at_deposit, 0), COALESCE(v_dep.cash_balance_at_deposit, 0),
      COALESCE(NULLIF(BTRIM(COALESCE(p_reject_reason, '')), ''), 'Setoran ditolak'),
      'cash_deposits', p_deposit_id::text,
      jsonb_build_object('admin_id', p_admin_id)
    )
    ON CONFLICT DO NOTHING;
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

    UPDATE public.cash_deposits
    SET branch_cash_applied_at = now(),
        branch_cash_balance_before = v_before,
        branch_cash_balance_after = v_after,
        branch_cash_ledger_id = v_ledger_id
    WHERE id = p_deposit_id;
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION public.get_branch_cash_ledger(
  p_admin_id bigint,
  p_branch_id bigint,
  p_date_from timestamptz DEFAULT NULL,
  p_date_to timestamptz DEFAULT NULL,
  p_movement_type text DEFAULT NULL,
  p_limit integer DEFAULT 50
)
RETURNS TABLE (
  id bigint,
  movement_type text,
  direction text,
  amount numeric,
  balance_before numeric,
  balance_after numeric,
  expected_balance numeric,
  variance_amount numeric,
  reason text,
  staff_name text,
  admin_name text,
  cash_session_id bigint,
  deposit_id uuid,
  source_table text,
  source_id text,
  created_at timestamptz,
  metadata jsonb
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_admin record;
BEGIN
  SELECT u.id, u.role INTO v_admin
  FROM public.users u
  WHERE u.id = p_admin_id;

  IF NOT FOUND OR v_admin.role NOT IN ('admin', 'owner') THEN
    RAISE EXCEPTION 'Hanya admin/owner yang dapat mengakses riwayat ini';
  END IF;

  RETURN QUERY
  WITH ledger_rows AS (
    SELECT
      l.id::bigint,
      l.movement_type::text,
      l.direction::text,
      l.amount::numeric,
      l.balance_before::numeric,
      l.balance_after::numeric,
      l.expected_balance::numeric,
      l.variance_amount::numeric,
      l.reason::text,
      staff.name::text AS staff_name,
      admin.name::text AS admin_name,
      l.cash_session_id::bigint,
      l.deposit_id::uuid,
      l.source_table::text,
      l.source_id::text,
      l.created_at::timestamptz,
      l.metadata::jsonb
    FROM public.branch_cash_ledger l
    LEFT JOIN public.users staff ON staff.id = l.staff_id
    LEFT JOIN public.users admin ON admin.id = l.admin_id
    WHERE l.branch_id = p_branch_id

    UNION ALL

    SELECT
      cs.id::bigint AS id,
      CASE cs.status WHEN 'closed' THEN 'session_close' ELSE 'session_open_confirm' END::text AS movement_type,
      CASE cs.status WHEN 'closed' THEN 'adjust' ELSE 'none' END::text AS direction,
      COALESCE(cs.closing_cash, cs.opening_cash, 0)::numeric AS amount,
      COALESCE(cs.opening_cash, 0)::numeric AS balance_before,
      COALESCE(cs.closing_cash, cs.opening_cash, 0)::numeric AS balance_after,
      cs.expected_cash::numeric AS expected_balance,
      (COALESCE(cs.closing_cash, 0) - COALESCE(cs.expected_cash, 0))::numeric AS variance_amount,
      CASE cs.status WHEN 'closed' THEN 'Shift ditutup' ELSE 'Shift dibuka' END::text AS reason,
      staff.name::text AS staff_name,
      NULL::text AS admin_name,
      cs.id::bigint AS cash_session_id,
      NULL::uuid AS deposit_id,
      'cashier_sessions'::text AS source_table,
      cs.id::text AS source_id,
      COALESCE(cs.closed_at, cs.opened_at)::timestamptz AS created_at,
      jsonb_build_object('legacy_virtual', true) AS metadata
    FROM public.cashier_sessions cs
    LEFT JOIN public.users staff ON staff.id = cs.staff_id
    WHERE cs.branch_id = p_branch_id
      AND NOT EXISTS (
        SELECT 1
        FROM public.branch_cash_ledger existing
        WHERE existing.source_table = 'cashier_sessions'
          AND existing.source_id = cs.id::text
      )

    UNION ALL

    SELECT
      NULL::bigint AS id,
      'deposit_approved'::text AS movement_type,
      'out'::text AS direction,
      cd.amount::numeric AS amount,
      cd.branch_cash_balance_before::numeric AS balance_before,
      cd.branch_cash_balance_after::numeric AS balance_after,
      NULL::numeric AS expected_balance,
      NULL::numeric AS variance_amount,
      'Setoran disetujui admin'::text AS reason,
      staff.name::text AS staff_name,
      admin.name::text AS admin_name,
      cd.session_id::bigint AS cash_session_id,
      cd.id::uuid AS deposit_id,
      'cash_deposits'::text AS source_table,
      cd.id::text AS source_id,
      cd.branch_cash_applied_at::timestamptz AS created_at,
      jsonb_build_object('legacy_virtual', true, 'reviewed_by', cd.reviewed_by) AS metadata
    FROM public.cash_deposits cd
    LEFT JOIN public.users staff ON staff.id = cd.staff_id
    LEFT JOIN public.users admin ON admin.id::text = cd.reviewed_by::text
    WHERE cd.branch_id = p_branch_id
      AND cd.status = 'confirmed'
      AND cd.branch_cash_applied_at IS NOT NULL
      AND NOT EXISTS (
        SELECT 1
        FROM public.branch_cash_ledger existing
        WHERE existing.source_table = 'cash_deposits'
          AND existing.source_id = cd.id::text
      )
  )
  SELECT
    lr.id,
    lr.movement_type,
    lr.direction,
    lr.amount,
    lr.balance_before,
    lr.balance_after,
    lr.expected_balance,
    lr.variance_amount,
    lr.reason,
    lr.staff_name,
    lr.admin_name,
    lr.cash_session_id,
    lr.deposit_id,
    lr.source_table,
    lr.source_id,
    lr.created_at,
    lr.metadata
  FROM ledger_rows lr
  WHERE (p_date_from IS NULL OR lr.created_at >= p_date_from)
    AND (p_date_to IS NULL OR lr.created_at <= p_date_to)
    AND (p_movement_type IS NULL OR lr.movement_type = p_movement_type)
  ORDER BY lr.created_at DESC
  LIMIT COALESCE(p_limit, 50);
END;
$$;

CREATE OR REPLACE FUNCTION public.admin_force_close_branch_cash_session(
  p_admin_id bigint,
  p_session_id bigint,
  p_closing_cash numeric,
  p_reason text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_admin record;
  v_staff_id bigint;
  v_result jsonb;
  v_ledger_id bigint;
BEGIN
  SELECT id, role INTO v_admin
  FROM public.users
  WHERE id = p_admin_id;

  IF NOT FOUND OR v_admin.role NOT IN ('admin', 'owner') THEN
    RAISE EXCEPTION 'Hanya admin/owner yang dapat melakukan forced close';
  END IF;

  IF p_reason IS NULL OR length(BTRIM(p_reason)) < 3 THEN
    RAISE EXCEPTION 'Alasan forced close wajib diisi minimal 3 karakter';
  END IF;

  SELECT staff_id
    INTO v_staff_id
  FROM public.cashier_sessions
  WHERE id = p_session_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Sesi tidak ditemukan';
  END IF;

  SELECT public.close_cash_session_apply_branch_balance(
    p_session_id, p_closing_cash, v_staff_id, p_reason
  ) INTO v_result;

  v_ledger_id := NULLIF(v_result->>'ledger_id', '')::bigint;
  IF v_ledger_id IS NOT NULL THEN
    UPDATE public.branch_cash_ledger
    SET movement_type = 'force_close',
        admin_id = p_admin_id,
        reason = p_reason,
        metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object('forced', true, 'admin_id', p_admin_id)
    WHERE id = v_ledger_id;
  END IF;

  RETURN v_result || jsonb_build_object('forced_by_admin', p_admin_id);
END;
$$;

-- Trigger pengaman untuk direct insert/update cashier_sessions: opening_cash tetap dari outlet.
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
    FROM public.branch_cash_positions
    WHERE branch_id = NEW.branch_id;

    IF v_opening_cash IS NULL THEN
      SELECT closing_cash
        INTO v_opening_cash
      FROM public.cashier_sessions
      WHERE branch_id = NEW.branch_id
        AND status = 'closed'
        AND closing_cash IS NOT NULL
      ORDER BY closed_at DESC
      LIMIT 1;
    END IF;

    IF v_opening_cash IS NULL THEN
      SELECT COALESCE(default_cash_position, 0)
        INTO v_opening_cash
      FROM public.branches
      WHERE id = NEW.branch_id;
    END IF;

    NEW.opening_cash := COALESCE(v_opening_cash, 0);
    NEW.opening_cash_source := 'branch_balance';
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

REVOKE INSERT, UPDATE, DELETE ON public.branch_cash_positions FROM anon, authenticated;
REVOKE INSERT, UPDATE, DELETE ON public.branch_cash_ledger FROM anon, authenticated;
GRANT SELECT ON public.branch_cash_positions TO anon, authenticated;
GRANT SELECT ON public.branch_cash_ledger TO anon, authenticated;

GRANT EXECUTE ON FUNCTION public.compute_cash_session_system_amount_outlet(bigint) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_branch_cash_position(bigint, bigint) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_admin_branch_cash_positions(bigint, bigint, bigint, text, date, date) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.open_cash_session_from_branch_balance(bigint, bigint, numeric, text) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.close_cash_session_apply_branch_balance(bigint, numeric, bigint, text) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.confirm_deposit(uuid, bigint, text, text) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.admin_set_branch_cash_balance(bigint, bigint, numeric, text, bigint) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_branch_cash_ledger(bigint, bigint, timestamptz, timestamptz, text, integer) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.admin_force_close_branch_cash_session(bigint, bigint, numeric, text) TO anon, authenticated;

NOTIFY pgrst, 'reload schema';

COMMIT;
