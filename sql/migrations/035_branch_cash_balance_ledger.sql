-- Migration 035: Branch Cash Balance & Ledger (Posisi Kas Outlet)
-- Replaces staff-based cash source-of-truth with branch/outlet-level cash position.
-- staff_cash_balances (migration 034) dipertahankan read-only untuk audit legacy.
--
-- New tables  : branch_cash_balances, branch_cash_ledger
-- Altered     : branches, cashier_sessions, cash_deposits
-- New RPCs    : get_branch_cash_position, get_admin_branch_cash_positions,
--               open_cash_session_from_branch_balance,
--               close_cash_session_apply_branch_balance,
--               admin_set_branch_cash_balance, get_branch_cash_ledger,
--               admin_force_close_branch_cash_session
-- Replaced RPC: confirm_deposit (now applies to branch_cash_balances)

BEGIN;

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. ALTER branches — tambah default_cash_position
-- ─────────────────────────────────────────────────────────────────────────────
ALTER TABLE public.branches
  ADD COLUMN IF NOT EXISTS default_cash_position  numeric(15,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS default_cash_updated_at timestamptz,
  ADD COLUMN IF NOT EXISTS default_cash_updated_by bigint REFERENCES public.users(id);

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. CREATE branch_cash_balances — satu row per outlet, source of truth kas
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.branch_cash_balances (
  id                     bigserial PRIMARY KEY,
  branch_id              bigint NOT NULL REFERENCES public.branches(id),
  current_balance        numeric(15,2) NOT NULL DEFAULT 0 CHECK (current_balance >= 0),
  current_status         text NOT NULL DEFAULT 'idle'
                           CHECK (current_status IN ('idle','active','needs_review')),
  last_open_session_id   bigint REFERENCES public.cashier_sessions(id),
  last_closed_session_id bigint REFERENCES public.cashier_sessions(id),
  last_opened_by         bigint REFERENCES public.users(id),
  last_closed_by         bigint REFERENCES public.users(id),
  last_ledger_id         bigint,
  last_movement_type     text,
  version                bigint NOT NULL DEFAULT 1,
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now(),
  updated_by             bigint REFERENCES public.users(id),
  UNIQUE (branch_id)
);

-- ─────────────────────────────────────────────────────────────────────────────
-- 3. CREATE branch_cash_ledger — append-only audit pos kas outlet
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.branch_cash_ledger (
  id               bigserial PRIMARY KEY,
  branch_id        bigint NOT NULL REFERENCES public.branches(id),
  staff_id         bigint REFERENCES public.users(id),
  admin_id         bigint REFERENCES public.users(id),
  cash_session_id  bigint REFERENCES public.cashier_sessions(id),
  deposit_id       uuid   REFERENCES public.cash_deposits(id),
  movement_type    text NOT NULL CHECK (movement_type IN (
    'default_seed','session_open_confirm','opening_variance','session_close',
    'deposit_approved','deposit_rejected','admin_adjustment','force_close','system_repair'
  )),
  direction        text NOT NULL CHECK (direction IN ('in','out','adjust','none')),
  amount           numeric(15,2) NOT NULL DEFAULT 0,
  balance_before   numeric(15,2) NOT NULL,
  balance_after    numeric(15,2) NOT NULL,
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

-- ─────────────────────────────────────────────────────────────────────────────
-- 4. ALTER cashier_sessions — kolom branch balance (idempotent)
-- ─────────────────────────────────────────────────────────────────────────────
ALTER TABLE public.cashier_sessions
  ADD COLUMN IF NOT EXISTS opening_cash_source       text DEFAULT 'manual',
  ADD COLUMN IF NOT EXISTS opening_branch_balance_id bigint REFERENCES public.branch_cash_balances(id),
  ADD COLUMN IF NOT EXISTS opening_confirmed_at      timestamptz,
  ADD COLUMN IF NOT EXISTS opening_confirmed_by      bigint REFERENCES public.users(id),
  ADD COLUMN IF NOT EXISTS opening_physical_cash     numeric(15,2),
  ADD COLUMN IF NOT EXISTS opening_variance_amount   numeric(15,2),
  ADD COLUMN IF NOT EXISTS opening_variance_reason   text,
  ADD COLUMN IF NOT EXISTS closing_note              text,
  ADD COLUMN IF NOT EXISTS balance_applied_at        timestamptz,
  ADD COLUMN IF NOT EXISTS branch_balance_ledger_id  bigint REFERENCES public.branch_cash_ledger(id);

-- ─────────────────────────────────────────────────────────────────────────────
-- 5. ALTER cash_deposits — kolom idempotency branch balance
-- ─────────────────────────────────────────────────────────────────────────────
ALTER TABLE public.cash_deposits
  ADD COLUMN IF NOT EXISTS balance_applied_at       timestamptz,
  ADD COLUMN IF NOT EXISTS branch_balance_ledger_id bigint REFERENCES public.branch_cash_ledger(id);

-- ─────────────────────────────────────────────────────────────────────────────
-- 6. FUNCTION: get_branch_cash_position
--    Dipakai staff saat membuka kas: satu call untuk semua data yang dibutuhkan.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.get_branch_cash_position(
  p_branch_id bigint,
  p_user_id   bigint DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_branch       record;
  v_user         record;
  v_balance      record;
  v_open_sess    record;
  v_last_closed  record;
  v_source       text;
  v_cur_balance  numeric(15,2);
  v_pending_dep  numeric(15,2);
BEGIN
  SELECT id, name, default_cash_position INTO v_branch
    FROM branches WHERE id = p_branch_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Cabang tidak ditemukan';
  END IF;

  -- Permission: staff hanya bisa baca branch miliknya
  IF p_user_id IS NOT NULL THEN
    SELECT id, role, branch_id INTO v_user
      FROM users WHERE id = p_user_id;
    IF FOUND AND v_user.role NOT IN ('admin','owner') AND
       v_user.branch_id IS DISTINCT FROM p_branch_id THEN
      RAISE EXCEPTION 'Tidak memiliki akses ke outlet ini';
    END IF;
  END IF;

  SELECT * INTO v_balance
    FROM branch_cash_balances WHERE branch_id = p_branch_id;

  SELECT cs.id, cs.staff_id, cs.opened_at, cs.opening_cash,
         u.name AS staff_name
    INTO v_open_sess
    FROM cashier_sessions cs
    JOIN users u ON u.id = cs.staff_id
   WHERE cs.branch_id = p_branch_id AND cs.status = 'open'
   LIMIT 1;

  SELECT cs.id, cs.staff_id, cs.opened_at, cs.closed_at,
         cs.opening_cash, cs.closing_cash, cs.expected_cash,
         u.name AS staff_name
    INTO v_last_closed
    FROM cashier_sessions cs
    JOIN users u ON u.id = cs.staff_id
   WHERE cs.branch_id = p_branch_id
     AND cs.status = 'closed'
     AND cs.closing_cash IS NOT NULL
   ORDER BY cs.closed_at DESC
   LIMIT 1;

  IF v_balance.id IS NOT NULL THEN
    v_cur_balance := v_balance.current_balance;
    v_source      := 'branch_balance';
  ELSIF v_last_closed.id IS NOT NULL THEN
    v_cur_balance := v_last_closed.closing_cash;
    v_source      := 'latest_closed_session';
  ELSE
    v_cur_balance := COALESCE(v_branch.default_cash_position, 0);
    v_source      := 'default_cash';
  END IF;

  SELECT COALESCE(SUM(amount), 0) INTO v_pending_dep
    FROM cash_deposits
   WHERE branch_id = p_branch_id AND status = 'pending';

  RETURN jsonb_build_object(
    'branch_id',    p_branch_id,
    'branch_name',  v_branch.name,
    'balance_id',   v_balance.id,
    'current_balance', v_cur_balance,
    'source',       v_source,
    'version',      COALESCE(v_balance.version, 0),
    'has_balance_row', v_balance.id IS NOT NULL,
    'current_status',
      COALESCE(v_balance.current_status,
        CASE WHEN v_open_sess.id IS NOT NULL THEN 'active' ELSE 'idle' END),
    'open_session', CASE
      WHEN v_open_sess.id IS NOT NULL THEN jsonb_build_object(
        'id',          v_open_sess.id,
        'staff_id',    v_open_sess.staff_id,
        'staff_name',  v_open_sess.staff_name,
        'opened_at',   v_open_sess.opened_at,
        'opening_cash', v_open_sess.opening_cash
      )
      ELSE NULL
    END,
    'last_closed_session', CASE
      WHEN v_last_closed.id IS NOT NULL THEN jsonb_build_object(
        'id',           v_last_closed.id,
        'staff_id',     v_last_closed.staff_id,
        'staff_name',   v_last_closed.staff_name,
        'closed_at',    v_last_closed.closed_at,
        'opening_cash', v_last_closed.opening_cash,
        'closing_cash', v_last_closed.closing_cash,
        'expected_cash', v_last_closed.expected_cash,
        'variance',
          COALESCE(v_last_closed.closing_cash, 0) -
          COALESCE(v_last_closed.expected_cash, 0)
      )
      ELSE NULL
    END,
    'pending_deposit_amount', v_pending_dep,
    'running_estimated_cash', NULL,
    'updated_at', COALESCE(v_balance.updated_at, now())
  );
END;
$$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 7. FUNCTION: get_admin_branch_cash_positions
--    Dashboard admin: daftar semua outlet dengan posisi kas.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.get_admin_branch_cash_positions(
  p_admin_id   bigint,
  p_branch_id  bigint  DEFAULT NULL,
  p_staff_id   bigint  DEFAULT NULL,
  p_status     text    DEFAULT 'all',
  p_date_from  date    DEFAULT NULL,
  p_date_to    date    DEFAULT NULL
)
RETURNS TABLE (
  branch_id              bigint,
  branch_name            text,
  current_balance        numeric,
  running_estimated_cash numeric,
  balance_id             bigint,
  version                bigint,
  last_opening_cash      numeric,
  last_closing_cash      numeric,
  last_opened_by_name    text,
  last_closed_by_name    text,
  last_updated           timestamptz,
  shift_status           text,
  open_session_id        bigint,
  open_staff_name        text,
  open_session_opened_at timestamptz,
  pending_deposit_amount numeric,
  last_variance_amount   numeric,
  has_variance           boolean,
  default_cash_position  numeric
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
    RAISE EXCEPTION 'Hanya admin/owner yang dapat mengakses data ini';
  END IF;

  RETURN QUERY
  WITH open_sessions AS (
    SELECT cs.id, cs.branch_id, cs.staff_id, cs.opened_at, cs.opening_cash,
           u.name AS staff_name
      FROM cashier_sessions cs
      JOIN users u ON u.id = cs.staff_id
     WHERE cs.status = 'open'
  ),
  last_closed AS (
    SELECT DISTINCT ON (cs.branch_id)
           cs.branch_id, cs.id AS session_id,
           cs.opening_cash, cs.closing_cash, cs.expected_cash,
           cs.closed_at, cs.staff_id,
           cs.closing_cash - cs.expected_cash AS variance,
           uo.name AS opened_by_name,
           uc.name AS closed_by_name
      FROM cashier_sessions cs
      LEFT JOIN users uo ON uo.id = cs.staff_id
      LEFT JOIN users uc ON uc.id = cs.staff_id
     WHERE cs.status = 'closed' AND cs.closing_cash IS NOT NULL
       AND (p_date_from IS NULL OR cs.closed_at::date >= p_date_from)
       AND (p_date_to   IS NULL OR cs.closed_at::date <= p_date_to)
     ORDER BY cs.branch_id, cs.closed_at DESC
  ),
  pending_deps AS (
    SELECT cd.branch_id, SUM(cd.amount) AS total_pending
      FROM cash_deposits cd
     WHERE cd.status = 'pending'
     GROUP BY cd.branch_id
  )
  SELECT
    b.id                                              AS branch_id,
    b.name                                            AS branch_name,
    COALESCE(bcb.current_balance,
      lc.closing_cash,
      b.default_cash_position, 0)                    AS current_balance,
    NULL::numeric                                     AS running_estimated_cash,
    bcb.id                                            AS balance_id,
    COALESCE(bcb.version, 0)                          AS version,
    lc.opening_cash                                   AS last_opening_cash,
    lc.closing_cash                                   AS last_closing_cash,
    lc.opened_by_name                                 AS last_opened_by_name,
    lc.closed_by_name                                 AS last_closed_by_name,
    COALESCE(bcb.updated_at, lc.closed_at)           AS last_updated,
    CASE
      WHEN os.id IS NOT NULL THEN 'open'
      WHEN lc.session_id IS NOT NULL THEN 'closed_today'
      ELSE 'none'
    END                                               AS shift_status,
    os.id                                             AS open_session_id,
    os.staff_name                                     AS open_staff_name,
    os.opened_at                                      AS open_session_opened_at,
    COALESCE(pd.total_pending, 0)                     AS pending_deposit_amount,
    lc.variance                                       AS last_variance_amount,
    (lc.variance IS NOT NULL AND lc.variance <> 0)   AS has_variance,
    b.default_cash_position                           AS default_cash_position
  FROM branches b
  LEFT JOIN branch_cash_balances bcb ON bcb.branch_id = b.id
  LEFT JOIN open_sessions         os ON os.branch_id  = b.id
  LEFT JOIN last_closed           lc ON lc.branch_id  = b.id
  LEFT JOIN pending_deps          pd ON pd.branch_id  = b.id
  WHERE b.is_active = true
    AND (p_branch_id IS NULL OR b.id = p_branch_id)
  ORDER BY b.name;
END;
$$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 8. FUNCTION: open_cash_session_from_branch_balance
--    Atomik: baca posisi outlet → buka session → tulis ledger.
-- ─────────────────────────────────────────────────────────────────────────────
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
  v_branch      record;
  v_user        record;
  v_balance     record;
  v_session     record;
  v_active      record;
  v_opening_cash numeric(15,2);
  v_ledger_id   bigint;
  v_variance    numeric(15,2);
  v_seed_balance numeric(15,2);
BEGIN
  -- Validate staff
  SELECT id, role, branch_id, name INTO v_user FROM users WHERE id = p_staff_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Staff tidak ditemukan'; END IF;
  IF v_user.role NOT IN ('admin','owner') AND
     v_user.branch_id IS DISTINCT FROM p_branch_id THEN
    RAISE EXCEPTION 'Staff tidak memiliki akses ke outlet ini';
  END IF;

  -- Advisory lock per-branch untuk cegah race condition
  PERFORM pg_advisory_xact_lock(hashtext('branch_cash:' || p_branch_id::text));

  -- Guard: tidak boleh ada session open di outlet yang sama
  SELECT cs.id, u.name AS staff_name, cs.opened_at
    INTO v_active
    FROM cashier_sessions cs
    JOIN users u ON u.id = cs.staff_id
   WHERE cs.branch_id = p_branch_id AND cs.status = 'open'
   LIMIT 1;
  IF FOUND THEN
    RAISE EXCEPTION 'Shift sebelumnya di outlet ini belum ditutup. Staff aktif: %. Dibuka: %. Silakan minta staff sebelumnya menutup kas terlebih dahulu atau hubungi admin.',
      v_active.staff_name, v_active.opened_at;
  END IF;

  SELECT id, name, default_cash_position INTO v_branch
    FROM branches WHERE id = p_branch_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Cabang tidak ditemukan'; END IF;

  -- Lock/get balance row
  SELECT * INTO v_balance
    FROM branch_cash_balances WHERE branch_id = p_branch_id FOR UPDATE;

  IF NOT FOUND THEN
    -- Seed dari session terakhir atau default outlet
    SELECT closing_cash INTO v_seed_balance
      FROM cashier_sessions
     WHERE branch_id = p_branch_id
       AND status = 'closed'
       AND closing_cash IS NOT NULL
     ORDER BY closed_at DESC
     LIMIT 1;

    v_seed_balance := COALESCE(v_seed_balance, v_branch.default_cash_position, 0);

    INSERT INTO branch_cash_balances (
      branch_id, current_balance, current_status, version,
      created_at, updated_at, updated_by
    )
    VALUES (
      p_branch_id, v_seed_balance, 'idle', 1,
      now(), now(), p_staff_id
    )
    RETURNING * INTO v_balance;

    -- Ledger seed
    INSERT INTO branch_cash_ledger (
      branch_id, staff_id, movement_type, direction, amount,
      balance_before, balance_after, reason, source_table, source_id,
      created_at, metadata
    ) VALUES (
      p_branch_id, p_staff_id, 'default_seed', 'none', 0,
      0, v_seed_balance,
      'Inisialisasi posisi kas outlet',
      'branch_cash_balances', v_balance.id::text,
      now(), '{}'::jsonb
    );
  END IF;

  v_opening_cash := v_balance.current_balance;

  -- Validasi variance reason jika kas fisik berbeda
  IF p_physical_cash IS NOT NULL
     AND p_physical_cash <> v_opening_cash
     AND (p_variance_reason IS NULL OR trim(p_variance_reason) = '') THEN
    RAISE EXCEPTION 'Alasan selisih kas wajib diisi jika kas fisik berbeda dari posisi kas outlet';
  END IF;

  -- Buka session
  INSERT INTO cashier_sessions (
    branch_id, staff_id, opening_cash, status,
    opening_cash_source, opening_branch_balance_id,
    opening_confirmed_at, opening_confirmed_by,
    opening_physical_cash, opening_variance_amount, opening_variance_reason,
    opened_at
  ) VALUES (
    p_branch_id, p_staff_id, v_opening_cash, 'open',
    'branch_balance', v_balance.id,
    now(), p_staff_id,
    p_physical_cash,
    CASE WHEN p_physical_cash IS NOT NULL THEN p_physical_cash - v_opening_cash ELSE NULL END,
    CASE WHEN p_physical_cash IS NOT NULL AND p_physical_cash <> v_opening_cash
         THEN p_variance_reason ELSE NULL END,
    now()
  )
  RETURNING * INTO v_session;

  -- Ledger: session_open_confirm (arah none — balance belum berubah)
  INSERT INTO branch_cash_ledger (
    branch_id, staff_id, cash_session_id,
    movement_type, direction, amount,
    balance_before, balance_after,
    reason, source_table, source_id,
    created_at, metadata
  ) VALUES (
    p_branch_id, p_staff_id, v_session.id,
    'session_open_confirm', 'none', 0,
    v_opening_cash, v_opening_cash,
    'Shift dibuka dari posisi kas outlet',
    'cashier_sessions', v_session.id::text,
    now(), '{}'::jsonb
  )
  RETURNING id INTO v_ledger_id;

  -- Ledger opening_variance jika ada selisih (informasional, tidak ubah balance)
  IF p_physical_cash IS NOT NULL AND p_physical_cash <> v_opening_cash THEN
    v_variance := p_physical_cash - v_opening_cash;
    INSERT INTO branch_cash_ledger (
      branch_id, staff_id, cash_session_id,
      movement_type, direction, amount,
      balance_before, balance_after, variance_amount,
      reason, source_table, source_id,
      created_at, metadata
    ) VALUES (
      p_branch_id, p_staff_id, v_session.id,
      'opening_variance',
      CASE WHEN v_variance > 0 THEN 'in' ELSE 'out' END,
      ABS(v_variance),
      v_opening_cash, v_opening_cash,
      v_variance,
      p_variance_reason,
      'cashier_sessions', v_session.id::text || '_var',
      now(),
      jsonb_build_object(
        'physical_cash', p_physical_cash,
        'system_cash',   v_opening_cash,
        'variance',      v_variance
      )
    );
  END IF;

  -- Update balance status → active
  UPDATE branch_cash_balances SET
    current_status       = 'active',
    last_open_session_id = v_session.id,
    last_opened_by       = p_staff_id,
    last_ledger_id       = v_ledger_id,
    last_movement_type   = 'session_open_confirm',
    updated_at           = now(),
    updated_by           = p_staff_id
  WHERE id = v_balance.id;

  -- Set ledger id di session
  UPDATE cashier_sessions
    SET branch_balance_ledger_id = v_ledger_id
  WHERE id = v_session.id;

  RETURN jsonb_build_object(
    'id',                  v_session.id,
    'branch_id',           p_branch_id,
    'staff_id',            p_staff_id,
    'status',              'open',
    'opening_cash',        v_opening_cash,
    'opening_cash_source', 'branch_balance',
    'opened_at',           v_session.opened_at,
    'ledger_id',           v_ledger_id,
    'variance',
      CASE WHEN p_physical_cash IS NOT NULL
           THEN p_physical_cash - v_opening_cash ELSE NULL END
  );
END;
$$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 9. FUNCTION: close_cash_session_apply_branch_balance
--    Atomik: tutup session → update posisi outlet → tulis ledger.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.close_cash_session_apply_branch_balance(
  p_session_id   bigint,
  p_closing_cash numeric,
  p_staff_id     bigint,
  p_closing_note text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_session      record;
  v_balance      record;
  v_expected     numeric(15,2);
  v_variance     numeric(15,2);
  v_bal_before   numeric(15,2);
  v_ledger_id    bigint;
BEGIN
  IF p_closing_cash < 0 THEN
    RAISE EXCEPTION 'Kas akhir tidak boleh negatif';
  END IF;

  -- Lock session
  SELECT * INTO v_session
    FROM cashier_sessions WHERE id = p_session_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Sesi tidak ditemukan'; END IF;

  -- Idempotent: jika sudah closed, return hasil sebelumnya
  IF v_session.status = 'closed' THEN
    RETURN jsonb_build_object(
      'already_closed', true,
      'id',             v_session.id,
      'closing_cash',   v_session.closing_cash,
      'expected_cash',  v_session.expected_cash,
      'balance_after',  v_session.closing_cash
    );
  END IF;

  IF v_session.staff_id <> p_staff_id THEN
    RAISE EXCEPTION 'Sesi ini bukan milik staff yang bersangkutan';
  END IF;

  -- Hitung expected_cash dari cash_logs (konsisten dengan cashService.getSummary)
  SELECT COALESCE(v_session.opening_cash, 0)
       + COALESCE(SUM(
           CASE WHEN cl.type = 'in'  AND NOT COALESCE(cl.is_void, false)
                THEN cl.amount ELSE 0 END
         ), 0)
       - COALESCE(SUM(
           CASE WHEN cl.type = 'out' AND NOT COALESCE(cl.is_void, false)
                THEN cl.amount ELSE 0 END
         ), 0)
  INTO v_expected
  FROM cash_logs cl
  WHERE cl.session_id = p_session_id;

  v_variance := p_closing_cash - v_expected;

  IF v_variance <> 0 AND (p_closing_note IS NULL OR trim(p_closing_note) = '') THEN
    RAISE EXCEPTION 'Catatan wajib diisi jika ada selisih kas (ekspektasi: %, aktual: %)',
      v_expected, p_closing_cash;
  END IF;

  -- Lock balance row
  SELECT * INTO v_balance
    FROM branch_cash_balances WHERE branch_id = v_session.branch_id FOR UPDATE;

  IF NOT FOUND THEN
    INSERT INTO branch_cash_balances (
      branch_id, current_balance, current_status, version,
      created_at, updated_at, updated_by
    ) VALUES (
      v_session.branch_id, p_closing_cash, 'idle', 1,
      now(), now(), p_staff_id
    )
    RETURNING * INTO v_balance;
    v_bal_before := 0;
  ELSE
    v_bal_before := v_balance.current_balance;
  END IF;

  -- Update session
  UPDATE cashier_sessions SET
    status               = 'closed',
    closing_cash         = p_closing_cash,
    expected_cash        = v_expected,
    current_cash_amount  = p_closing_cash,
    closed_at            = now(),
    balance_applied_at   = now(),
    closing_note         = p_closing_note
  WHERE id = p_session_id;

  -- Update balance: posisi outlet = kas akhir aktual staff
  UPDATE branch_cash_balances SET
    current_balance        = p_closing_cash,
    current_status         = 'idle',
    last_closed_session_id = p_session_id,
    last_closed_by         = p_staff_id,
    version                = version + 1,
    updated_at             = now(),
    updated_by             = p_staff_id
  WHERE id = v_balance.id;

  -- Ledger: session_close
  INSERT INTO branch_cash_ledger (
    branch_id, staff_id, cash_session_id,
    movement_type, direction, amount,
    balance_before, balance_after,
    expected_balance, variance_amount,
    reason, source_table, source_id,
    created_at, metadata
  ) VALUES (
    v_session.branch_id, p_staff_id, p_session_id,
    'session_close',
    CASE WHEN p_closing_cash > v_bal_before THEN 'in'
         WHEN p_closing_cash < v_bal_before THEN 'out'
         ELSE 'none' END,
    ABS(p_closing_cash - v_bal_before),
    v_bal_before, p_closing_cash,
    v_expected, v_variance,
    COALESCE(p_closing_note, 'Shift ditutup'),
    'cashier_sessions', p_session_id::text,
    now(),
    jsonb_build_object(
      'expected_cash', v_expected,
      'variance',      v_variance,
      'opening_cash',  v_session.opening_cash
    )
  )
  RETURNING id INTO v_ledger_id;

  -- Set ledger id di session
  UPDATE cashier_sessions
    SET branch_balance_ledger_id = v_ledger_id
  WHERE id = p_session_id;

  -- Update last_ledger_id di balance
  UPDATE branch_cash_balances SET
    last_ledger_id     = v_ledger_id,
    last_movement_type = 'session_close'
  WHERE id = v_balance.id;

  RETURN jsonb_build_object(
    'id',             p_session_id,
    'status',         'closed',
    'closing_cash',   p_closing_cash,
    'expected_cash',  v_expected,
    'variance',       v_variance,
    'balance_before', v_bal_before,
    'balance_after',  p_closing_cash,
    'ledger_id',      v_ledger_id,
    'already_closed', false
  );
END;
$$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 10. FUNCTION: confirm_deposit (DROP+CREATE — apply ke branch balance)
--     Signature param dipertahankan dari migration 030 agar caller tidak rusak.
--     DROP diperlukan karena return type berubah menjadi jsonb.
-- ─────────────────────────────────────────────────────────────────────────────
DROP FUNCTION IF EXISTS public.confirm_deposit(uuid, bigint, text, text);

CREATE OR REPLACE FUNCTION public.confirm_deposit(
  p_deposit_id   uuid,
  p_admin_id     bigint,
  p_action       text,
  p_reject_reason text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_deposit      record;
  v_session      record;
  v_admin        record;
  v_balance      record;
  v_bal_before   numeric(15,2);
  v_new_balance  numeric(15,2);
  v_ledger_id    bigint;
  v_log_cat_id   bigint;
BEGIN
  -- Validasi admin
  SELECT id, role INTO v_admin FROM users WHERE id = p_admin_id;
  IF NOT FOUND OR v_admin.role NOT IN ('admin','owner') THEN
    RAISE EXCEPTION 'Hanya admin/owner yang dapat melakukan approval setoran';
  END IF;

  -- Validasi action
  IF p_action NOT IN ('confirmed','rejected') THEN
    RAISE EXCEPTION 'Action tidak valid. Gunakan confirmed atau rejected';
  END IF;

  -- Lock deposit
  SELECT * INTO v_deposit
    FROM cash_deposits WHERE id = p_deposit_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Setoran tidak ditemukan'; END IF;
  IF v_deposit.status <> 'pending' THEN
    RAISE EXCEPTION 'Setoran sudah diproses (status: %)', v_deposit.status;
  END IF;

  -- Validasi session tertutup (sesuai migration 030)
  SELECT * INTO v_session
    FROM cashier_sessions WHERE id = v_deposit.session_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Sesi kas tidak ditemukan'; END IF;
  IF v_session.status <> 'closed' THEN
    RAISE EXCEPTION 'Setoran hanya dapat dikonfirmasi setelah shift ditutup';
  END IF;

  IF p_action = 'rejected' THEN
    UPDATE cash_deposits SET
      status         = 'rejected',
      reject_reason  = p_reject_reason,
      confirmed_by   = p_admin_id,
      confirmed_at   = now()
    WHERE id = p_deposit_id;

    -- Ledger informatif untuk rejected (opsional)
    IF v_deposit.branch_id IS NOT NULL THEN
      SELECT * INTO v_balance FROM branch_cash_balances
        WHERE branch_id = v_deposit.branch_id;
      IF FOUND THEN
        INSERT INTO branch_cash_ledger (
          branch_id, admin_id, deposit_id,
          movement_type, direction, amount,
          balance_before, balance_after,
          reason, source_table, source_id,
          created_at, metadata
        ) VALUES (
          v_deposit.branch_id, p_admin_id, p_deposit_id,
          'deposit_rejected', 'none', v_deposit.amount,
          v_balance.current_balance, v_balance.current_balance,
          COALESCE(p_reject_reason, 'Setoran ditolak'),
          'cash_deposits', p_deposit_id::text,
          now(), '{}'::jsonb
        );
      END IF;
    END IF;

    RETURN jsonb_build_object(
      'status', 'rejected',
      'deposit_id', p_deposit_id
    );
  END IF;

  -- ── ACTION: confirmed ──────────────────────────────────────────────────────
  -- Idempotent: jangan apply dua kali
  IF v_deposit.balance_applied_at IS NOT NULL THEN
    RETURN jsonb_build_object(
      'status',      'confirmed',
      'deposit_id',  p_deposit_id,
      'already_applied', true
    );
  END IF;

  -- Butuh branch_id untuk apply ke posisi outlet
  IF v_deposit.branch_id IS NULL THEN
    RAISE EXCEPTION 'Setoran tidak memiliki branch_id — tidak dapat diproses';
  END IF;

  -- Lock balance
  SELECT * INTO v_balance
    FROM branch_cash_balances WHERE branch_id = v_deposit.branch_id FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Posisi kas outlet belum diinisialisasi. Pastikan outlet pernah membuka kas terlebih dahulu.';
  END IF;

  v_bal_before  := v_balance.current_balance;
  v_new_balance := v_bal_before - v_deposit.amount;

  IF v_new_balance < 0 THEN
    RAISE EXCEPTION 'Nominal setoran (%) melebihi posisi kas outlet saat ini (%). Admin perlu melakukan koreksi kas terlebih dahulu.',
      v_deposit.amount, v_bal_before;
  END IF;

  -- Update deposit status
  UPDATE cash_deposits SET
    status              = 'confirmed',
    confirmed_by        = p_admin_id,
    confirmed_at        = now(),
    balance_applied_at  = now()
  WHERE id = p_deposit_id;

  -- Insert cash_logs out (untuk laporan kas sesi — sesuai flow existing)
  SELECT id INTO v_log_cat_id FROM cash_categories
   WHERE type = 'out' AND is_system = true AND name ILIKE '%setor%'
   LIMIT 1;

  INSERT INTO cash_logs (
    session_id, branch_id, staff_id,
    amount, type, category_id,
    reference_type, reference_id, note,
    created_at
  ) VALUES (
    v_session.id, v_deposit.branch_id, v_deposit.staff_id,
    v_deposit.amount, 'out', v_log_cat_id,
    'deposit', p_deposit_id::text, 'Setoran terkonfirmasi',
    now()
  );

  -- Update branch balance
  UPDATE branch_cash_balances SET
    current_balance    = v_new_balance,
    version            = version + 1,
    updated_at         = now(),
    updated_by         = p_admin_id
  WHERE id = v_balance.id;

  -- Ledger: deposit_approved
  INSERT INTO branch_cash_ledger (
    branch_id, admin_id, deposit_id, cash_session_id,
    movement_type, direction, amount,
    balance_before, balance_after,
    reason, source_table, source_id,
    created_at, metadata
  ) VALUES (
    v_deposit.branch_id, p_admin_id, p_deposit_id, v_session.id,
    'deposit_approved', 'out', v_deposit.amount,
    v_bal_before, v_new_balance,
    'Setoran disetujui admin',
    'cash_deposits', p_deposit_id::text,
    now(), '{}'::jsonb
  )
  RETURNING id INTO v_ledger_id;

  -- Set ledger id di deposit
  UPDATE cash_deposits SET branch_balance_ledger_id = v_ledger_id
    WHERE id = p_deposit_id;

  -- Update last_ledger_id di balance
  UPDATE branch_cash_balances SET
    last_ledger_id     = v_ledger_id,
    last_movement_type = 'deposit_approved'
  WHERE id = v_balance.id;

  RETURN jsonb_build_object(
    'status',         'confirmed',
    'deposit_id',     p_deposit_id,
    'amount',         v_deposit.amount,
    'balance_before', v_bal_before,
    'balance_after',  v_new_balance,
    'ledger_id',      v_ledger_id,
    'already_applied', false
  );
END;
$$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 11. FUNCTION: admin_set_branch_cash_balance
--     Koreksi manual posisi kas outlet oleh admin.
-- ─────────────────────────────────────────────────────────────────────────────
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
  v_admin      record;
  v_balance    record;
  v_open_sess  record;
  v_bal_before numeric(15,2);
  v_ledger_id  bigint;
BEGIN
  SELECT id, role INTO v_admin FROM users WHERE id = p_admin_id;
  IF NOT FOUND OR v_admin.role NOT IN ('admin','owner') THEN
    RAISE EXCEPTION 'Hanya admin/owner yang dapat melakukan koreksi kas';
  END IF;

  IF p_new_balance < 0 THEN
    RAISE EXCEPTION 'Posisi kas tidak boleh negatif';
  END IF;

  IF p_reason IS NULL OR length(trim(p_reason)) < 5 THEN
    RAISE EXCEPTION 'Alasan koreksi wajib diisi minimal 5 karakter';
  END IF;

  SELECT * INTO v_balance
    FROM branch_cash_balances WHERE branch_id = p_branch_id FOR UPDATE;

  IF NOT FOUND THEN
    INSERT INTO branch_cash_balances (
      branch_id, current_balance, current_status, version,
      created_at, updated_at, updated_by
    ) VALUES (
      p_branch_id, p_new_balance, 'idle', 1,
      now(), now(), p_admin_id
    )
    RETURNING * INTO v_balance;
    v_bal_before := 0;
  ELSE
    IF p_version IS NOT NULL AND v_balance.version <> p_version THEN
      RAISE EXCEPTION 'Data posisi kas berubah. Muat ulang sebelum menyimpan.';
    END IF;
    v_bal_before := v_balance.current_balance;
  END IF;

  -- Cek apakah ada shift aktif (hanya warning, tidak blokir)
  SELECT id INTO v_open_sess
    FROM cashier_sessions WHERE branch_id = p_branch_id AND status = 'open'
   LIMIT 1;

  UPDATE branch_cash_balances SET
    current_balance    = p_new_balance,
    version            = version + 1,
    updated_at         = now(),
    updated_by         = p_admin_id
  WHERE id = v_balance.id;

  INSERT INTO branch_cash_ledger (
    branch_id, admin_id,
    movement_type, direction, amount,
    balance_before, balance_after,
    reason, source_table, source_id,
    created_at,
    metadata
  ) VALUES (
    p_branch_id, p_admin_id,
    'admin_adjustment', 'adjust', ABS(p_new_balance - v_bal_before),
    v_bal_before, p_new_balance,
    p_reason,
    'branch_cash_balances', v_balance.id::text,
    now(),
    jsonb_build_object(
      'open_session_id',
        CASE WHEN v_open_sess.id IS NOT NULL THEN v_open_sess.id ELSE NULL END,
      'has_active_shift', v_open_sess.id IS NOT NULL
    )
  )
  RETURNING id INTO v_ledger_id;

  UPDATE branch_cash_balances SET
    last_ledger_id     = v_ledger_id,
    last_movement_type = 'admin_adjustment'
  WHERE id = v_balance.id;

  RETURN jsonb_build_object(
    'branch_id',      p_branch_id,
    'balance_before', v_bal_before,
    'balance_after',  p_new_balance,
    'ledger_id',      v_ledger_id,
    'has_active_shift', v_open_sess.id IS NOT NULL
  );
END;
$$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 12. FUNCTION: get_branch_cash_ledger
--     Riwayat audit posisi kas per outlet.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.get_branch_cash_ledger(
  p_admin_id     bigint,
  p_branch_id    bigint,
  p_date_from    timestamptz DEFAULT NULL,
  p_date_to      timestamptz DEFAULT NULL,
  p_movement_type text       DEFAULT NULL,
  p_limit        integer     DEFAULT 100
)
RETURNS TABLE (
  id              bigint,
  movement_type   text,
  direction       text,
  amount          numeric,
  balance_before  numeric,
  balance_after   numeric,
  expected_balance numeric,
  variance_amount  numeric,
  reason          text,
  staff_name      text,
  admin_name      text,
  cash_session_id bigint,
  deposit_id      uuid,
  source_table    text,
  source_id       text,
  created_at      timestamptz,
  metadata        jsonb
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
    RAISE EXCEPTION 'Hanya admin/owner yang dapat mengakses ledger ini';
  END IF;

  RETURN QUERY
  SELECT
    l.id,
    l.movement_type,
    l.direction,
    l.amount,
    l.balance_before,
    l.balance_after,
    l.expected_balance,
    l.variance_amount,
    l.reason,
    us.name   AS staff_name,
    ua.name   AS admin_name,
    l.cash_session_id,
    l.deposit_id,
    l.source_table,
    l.source_id,
    l.created_at,
    l.metadata
  FROM branch_cash_ledger l
  LEFT JOIN users us ON us.id = l.staff_id
  LEFT JOIN users ua ON ua.id = l.admin_id
  WHERE l.branch_id = p_branch_id
    AND (p_date_from    IS NULL OR l.created_at >= p_date_from)
    AND (p_date_to      IS NULL OR l.created_at <= p_date_to)
    AND (p_movement_type IS NULL OR l.movement_type = p_movement_type)
  ORDER BY l.created_at DESC
  LIMIT p_limit;
END;
$$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 13. FUNCTION: admin_force_close_branch_cash_session
--     Emergency close jika staff lupa tutup kas.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.admin_force_close_branch_cash_session(
  p_admin_id     bigint,
  p_session_id   bigint,
  p_closing_cash numeric,
  p_reason       text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_admin   record;
  v_result  jsonb;
BEGIN
  SELECT id, role INTO v_admin FROM users WHERE id = p_admin_id;
  IF NOT FOUND OR v_admin.role NOT IN ('admin','owner') THEN
    RAISE EXCEPTION 'Hanya admin/owner yang dapat melakukan forced close';
  END IF;

  IF p_reason IS NULL OR length(trim(p_reason)) < 5 THEN
    RAISE EXCEPTION 'Alasan forced close wajib diisi minimal 5 karakter';
  END IF;

  -- Reuse close logic (staff_id = admin sebagai proxy)
  SELECT public.close_cash_session_apply_branch_balance(
    p_session_id,
    p_closing_cash,
    (SELECT staff_id FROM cashier_sessions WHERE id = p_session_id),
    p_reason
  ) INTO v_result;

  -- Override movement_type di ledger menjadi force_close
  UPDATE branch_cash_ledger SET
    movement_type = 'force_close',
    admin_id      = p_admin_id,
    metadata      = metadata || jsonb_build_object(
      'forced', true,
      'admin_id', p_admin_id,
      'reason', p_reason
    )
  WHERE id = (v_result->>'ledger_id')::bigint;

  RETURN v_result || jsonb_build_object('forced_by_admin', p_admin_id);
END;
$$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 14. BACKFILL branch_cash_balances dari closed sessions existing
-- ─────────────────────────────────────────────────────────────────────────────
DO $$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT DISTINCT ON (cs.branch_id)
      cs.branch_id,
      cs.closing_cash,
      cs.closed_at,
      cs.id AS session_id
    FROM cashier_sessions cs
    WHERE cs.status = 'closed' AND cs.closing_cash IS NOT NULL
    ORDER BY cs.branch_id, cs.closed_at DESC
  LOOP
    -- Hanya insert jika belum ada row untuk branch ini
    IF NOT EXISTS (
      SELECT 1 FROM branch_cash_balances WHERE branch_id = r.branch_id
    ) THEN
      INSERT INTO branch_cash_balances (
        branch_id, current_balance, current_status,
        last_closed_session_id, version, created_at, updated_at
      ) VALUES (
        r.branch_id, r.closing_cash, 'idle',
        r.session_id, 1, now(), now()
      );

      INSERT INTO branch_cash_ledger (
        branch_id, cash_session_id,
        movement_type, direction, amount,
        balance_before, balance_after,
        reason, source_table, source_id,
        created_at, metadata
      ) VALUES (
        r.branch_id, r.session_id,
        'system_repair', 'none', r.closing_cash,
        0, r.closing_cash,
        'Backfill posisi kas dari riwayat session yang ada',
        'cashier_sessions', r.session_id::text,
        now(),
        jsonb_build_object('backfill', true, 'source_closed_at', r.closed_at)
      );
    END IF;
  END LOOP;

  -- Untuk branch yang tidak punya closed session, seed dari default
  FOR r IN
    SELECT b.id AS branch_id, b.default_cash_position
    FROM branches b
    WHERE b.is_active = true
      AND NOT EXISTS (SELECT 1 FROM branch_cash_balances WHERE branch_id = b.id)
  LOOP
    INSERT INTO branch_cash_balances (
      branch_id, current_balance, current_status,
      version, created_at, updated_at
    ) VALUES (
      r.branch_id, COALESCE(r.default_cash_position, 0), 'idle',
      1, now(), now()
    );

    INSERT INTO branch_cash_ledger (
      branch_id,
      movement_type, direction, amount,
      balance_before, balance_after,
      reason, source_table, source_id,
      created_at, metadata
    ) VALUES (
      r.branch_id,
      'default_seed', 'none', COALESCE(r.default_cash_position, 0),
      0, COALESCE(r.default_cash_position, 0),
      'Inisialisasi posisi kas dari default outlet',
      'branches', r.branch_id::text,
      now(), jsonb_build_object('backfill', true)
    );
  END LOOP;
END;
$$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 15. REVOKE direct DML — semua mutasi via RPC SECURITY DEFINER
-- ─────────────────────────────────────────────────────────────────────────────
REVOKE INSERT, UPDATE, DELETE
  ON public.branch_cash_balances FROM anon, authenticated;
REVOKE INSERT, UPDATE, DELETE
  ON public.branch_cash_ledger   FROM anon, authenticated;

GRANT SELECT ON public.branch_cash_balances TO anon, authenticated;
GRANT SELECT ON public.branch_cash_ledger   TO anon, authenticated;

GRANT EXECUTE ON FUNCTION public.get_branch_cash_position                   TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_admin_branch_cash_positions             TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.open_cash_session_from_branch_balance       TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.close_cash_session_apply_branch_balance     TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.confirm_deposit                             TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.admin_set_branch_cash_balance               TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_branch_cash_ledger                      TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.admin_force_close_branch_cash_session        TO anon, authenticated;

-- ─────────────────────────────────────────────────────────────────────────────
-- 16. Reload PostgREST schema cache
-- ─────────────────────────────────────────────────────────────────────────────
NOTIFY pgrst, 'reload schema';

COMMIT;
