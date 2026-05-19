-- 034_staff_cash_balance_ledger.sql
-- Implementasi saldo kas aktif per staff dengan ledger/audit trail.
-- Tabel baru: staff_cash_balances, staff_cash_ledger
-- Alter: cashier_sessions, cash_deposits (idempotency fields)
-- RPC baru: get_staff_cash_balance, get_admin_staff_cash_balances,
--           admin_set_staff_cash_balance, open_cash_session_from_balance,
--           close_cash_session_apply_balance, get_staff_cash_ledger
-- Extend: confirm_deposit (apply balance idempotent)
-- Security: revoke direct DML ke balance + ledger tables

BEGIN;

-- ─────────────────────────────────────────────────────────────────
-- 1. Tabel: staff_cash_balances
--    Satu row per kombinasi branch_id + staff_id.
-- ─────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.staff_cash_balances (
  id                   bigserial PRIMARY KEY,
  branch_id            bigint NOT NULL REFERENCES public.branches(id),
  staff_id             bigint NOT NULL REFERENCES public.users(id),
  current_balance      numeric(15,2) NOT NULL DEFAULT 0 CHECK (current_balance >= 0),
  last_cash_session_id bigint REFERENCES public.cashier_sessions(id),
  last_ledger_id       bigint,
  pending_deposit_amount numeric(15,2) NOT NULL DEFAULT 0,
  version              bigint NOT NULL DEFAULT 1,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  updated_by           bigint REFERENCES public.users(id),
  UNIQUE (branch_id, staff_id)
);

-- ─────────────────────────────────────────────────────────────────
-- 2. Tabel: staff_cash_ledger
--    Append-only ledger semua perubahan saldo aktif staff.
-- ─────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.staff_cash_ledger (
  id              bigserial PRIMARY KEY,
  branch_id       bigint NOT NULL REFERENCES public.branches(id),
  staff_id        bigint NOT NULL REFERENCES public.users(id),
  cash_session_id bigint REFERENCES public.cashier_sessions(id),
  deposit_id      uuid   REFERENCES public.cash_deposits(id),
  movement_type   text NOT NULL CHECK (movement_type IN (
    'admin_set_balance',
    'admin_adjustment',
    'session_open_confirm',
    'opening_variance',
    'session_close',
    'deposit_approved',
    'deposit_rejected',
    'system_repair'
  )),
  direction       text NOT NULL CHECK (direction IN ('in','out','adjust','none')),
  amount          numeric(15,2) NOT NULL DEFAULT 0,
  balance_before  numeric(15,2) NOT NULL,
  balance_after   numeric(15,2) NOT NULL,
  reason          text,
  source_table    text,
  source_id       text,
  created_by      bigint REFERENCES public.users(id),
  approved_by     bigint REFERENCES public.users(id),
  created_at      timestamptz NOT NULL DEFAULT now(),
  metadata        jsonb NOT NULL DEFAULT '{}'::jsonb
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_staff_cash_ledger_unique_source
  ON public.staff_cash_ledger(source_table, source_id, movement_type)
  WHERE source_table IS NOT NULL AND source_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_staff_cash_balances_lookup
  ON public.staff_cash_balances(branch_id, staff_id);

CREATE INDEX IF NOT EXISTS idx_staff_cash_ledger_staff
  ON public.staff_cash_ledger(staff_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_staff_cash_ledger_branch_staff
  ON public.staff_cash_ledger(branch_id, staff_id);

-- ─────────────────────────────────────────────────────────────────
-- 3. Alter cashier_sessions — tambah kolom audit saldo aktif
-- ─────────────────────────────────────────────────────────────────
ALTER TABLE public.cashier_sessions
  ADD COLUMN IF NOT EXISTS opening_cash_source    text DEFAULT 'manual',
  ADD COLUMN IF NOT EXISTS opening_balance_id     bigint,
  ADD COLUMN IF NOT EXISTS opening_confirmed_at   timestamptz,
  ADD COLUMN IF NOT EXISTS opening_confirmed_by   bigint,
  ADD COLUMN IF NOT EXISTS opening_physical_cash  numeric(15,2),
  ADD COLUMN IF NOT EXISTS opening_variance_amount numeric(15,2),
  ADD COLUMN IF NOT EXISTS opening_variance_reason text,
  ADD COLUMN IF NOT EXISTS balance_applied_at     timestamptz,
  ADD COLUMN IF NOT EXISTS balance_ledger_id      bigint;

-- ─────────────────────────────────────────────────────────────────
-- 4. Alter cash_deposits — tambah kolom idempotency balance apply
-- ─────────────────────────────────────────────────────────────────
ALTER TABLE public.cash_deposits
  ADD COLUMN IF NOT EXISTS balance_applied_at timestamptz,
  ADD COLUMN IF NOT EXISTS balance_ledger_id  bigint;

-- ─────────────────────────────────────────────────────────────────
-- 5. RPC: get_staff_cash_balance
--    Ambil saldo aktif staff beserta info pending deposit & sesi terbuka.
-- ─────────────────────────────────────────────────────────────────
DROP FUNCTION IF EXISTS public.get_staff_cash_balance(bigint, bigint);

CREATE OR REPLACE FUNCTION public.get_staff_cash_balance(
  p_branch_id bigint,
  p_staff_id  bigint
)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_balance  public.staff_cash_balances%ROWTYPE;
  v_pending  numeric;
  v_session  jsonb;
BEGIN
  SELECT * INTO v_balance
  FROM public.staff_cash_balances
  WHERE branch_id = p_branch_id AND staff_id = p_staff_id;

  SELECT COALESCE(SUM(cd.amount), 0) INTO v_pending
  FROM public.cash_deposits cd
  WHERE cd.staff_id   = p_staff_id
    AND cd.branch_id  = p_branch_id
    AND cd.status     = 'pending';

  SELECT jsonb_build_object(
    'id',           cs.id,
    'status',       cs.status,
    'opening_cash', cs.opening_cash,
    'opened_at',    cs.opened_at
  ) INTO v_session
  FROM public.cashier_sessions cs
  WHERE cs.branch_id = p_branch_id
    AND cs.staff_id  = p_staff_id
    AND cs.status    = 'open'
  LIMIT 1;

  RETURN jsonb_build_object(
    'balance_id',      v_balance.id,
    'current_balance', COALESCE(v_balance.current_balance, 0),
    'pending_deposit', v_pending,
    'version',         COALESCE(v_balance.version, 0),
    'has_balance_row', v_balance.id IS NOT NULL,
    'open_session',    v_session,
    'last_updated',    v_balance.updated_at
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.get_staff_cash_balance(bigint, bigint)
  TO anon, authenticated;


-- ─────────────────────────────────────────────────────────────────
-- 6. RPC: get_admin_staff_cash_balances
--    Daftar saldo aktif semua staff (untuk UI admin).
-- ─────────────────────────────────────────────────────────────────
DROP FUNCTION IF EXISTS public.get_admin_staff_cash_balances(bigint, bigint, bigint);

CREATE OR REPLACE FUNCTION public.get_admin_staff_cash_balances(
  p_admin_id  bigint,
  p_branch_id bigint DEFAULT NULL,
  p_staff_id  bigint DEFAULT NULL
)
RETURNS TABLE (
  staff_id                bigint,
  staff_name              text,
  branch_id               bigint,
  branch_name             text,
  current_balance         numeric,
  pending_deposit         numeric,
  balance_id              bigint,
  version                 bigint,
  last_updated            timestamptz,
  open_session_id         bigint,
  open_session_status     text,
  open_session_opened_at  timestamptz
)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_role text;
BEGIN
  SELECT role INTO v_role FROM public.users WHERE id = p_admin_id;
  IF v_role IS NULL OR v_role NOT IN ('admin', 'owner') THEN
    RAISE EXCEPTION 'Hanya admin yang dapat melihat posisi saldo kas staff';
  END IF;

  RETURN QUERY
  SELECT
    u.id                   AS staff_id,
    u.name                 AS staff_name,
    u.branch_id            AS branch_id,
    b.name                 AS branch_name,
    COALESCE(scb.current_balance, 0)::numeric AS current_balance,
    COALESCE(
      (SELECT SUM(cd.amount)
       FROM public.cash_deposits cd
       WHERE cd.staff_id = u.id AND cd.branch_id = u.branch_id AND cd.status = 'pending'),
      0
    )::numeric             AS pending_deposit,
    scb.id                 AS balance_id,
    COALESCE(scb.version, 0)::bigint AS version,
    scb.updated_at         AS last_updated,
    cs.id                  AS open_session_id,
    cs.status              AS open_session_status,
    cs.opened_at           AS open_session_opened_at
  FROM public.users u
  JOIN public.branches b ON b.id = u.branch_id
  LEFT JOIN public.staff_cash_balances scb
    ON scb.branch_id = u.branch_id AND scb.staff_id = u.id
  LEFT JOIN public.cashier_sessions cs
    ON cs.branch_id = u.branch_id AND cs.staff_id = u.id AND cs.status = 'open'
  WHERE u.role = 'staff'
    AND COALESCE(u.is_active, true) = true
    AND (p_branch_id IS NULL OR u.branch_id = p_branch_id)
    AND (p_staff_id IS NULL OR u.id = p_staff_id)
  ORDER BY b.name, u.name;
END;
$$;

GRANT EXECUTE ON FUNCTION public.get_admin_staff_cash_balances(bigint, bigint, bigint)
  TO anon, authenticated;


-- ─────────────────────────────────────────────────────────────────
-- 7. RPC: admin_set_staff_cash_balance
--    Set/koreksi saldo aktif staff dengan alasan wajib + ledger.
-- ─────────────────────────────────────────────────────────────────
DROP FUNCTION IF EXISTS public.admin_set_staff_cash_balance(bigint, bigint, bigint, numeric, text, bigint);

CREATE OR REPLACE FUNCTION public.admin_set_staff_cash_balance(
  p_admin_id    bigint,
  p_branch_id   bigint,
  p_staff_id    bigint,
  p_new_balance numeric,
  p_reason      text,
  p_version     bigint DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_role          text;
  v_balance       public.staff_cash_balances%ROWTYPE;
  v_balance_before numeric;
  v_ledger_id     bigint;
  v_movement_type text;
BEGIN
  SELECT role INTO v_role FROM public.users WHERE id = p_admin_id;
  IF v_role IS NULL OR v_role NOT IN ('admin', 'owner') THEN
    RAISE EXCEPTION 'Hanya admin yang dapat mengatur saldo kas staff';
  END IF;

  IF p_new_balance IS NULL OR p_new_balance < 0 THEN
    RAISE EXCEPTION 'Nominal saldo tidak boleh negatif';
  END IF;

  IF NULLIF(BTRIM(COALESCE(p_reason, '')), '') IS NULL THEN
    RAISE EXCEPTION 'Alasan koreksi saldo wajib diisi';
  END IF;

  SELECT * INTO v_balance
  FROM public.staff_cash_balances
  WHERE branch_id = p_branch_id AND staff_id = p_staff_id
  FOR UPDATE;

  IF p_version IS NOT NULL AND v_balance.id IS NOT NULL AND v_balance.version <> p_version THEN
    RAISE EXCEPTION 'Data saldo berubah sejak terakhir dimuat. Muat ulang sebelum menyimpan.';
  END IF;

  v_balance_before := COALESCE(v_balance.current_balance, 0);
  v_movement_type  := CASE WHEN v_balance.id IS NULL THEN 'admin_set_balance' ELSE 'admin_adjustment' END;

  IF v_balance.id IS NULL THEN
    INSERT INTO public.staff_cash_balances (
      branch_id, staff_id, current_balance, version, updated_by, updated_at
    ) VALUES (
      p_branch_id, p_staff_id, p_new_balance, 1, p_admin_id, now()
    ) RETURNING * INTO v_balance;
  ELSE
    UPDATE public.staff_cash_balances
    SET current_balance = p_new_balance,
        version         = version + 1,
        updated_by      = p_admin_id,
        updated_at      = now()
    WHERE id = v_balance.id
    RETURNING * INTO v_balance;
  END IF;

  INSERT INTO public.staff_cash_ledger (
    branch_id, staff_id, movement_type, direction, amount,
    balance_before, balance_after, reason, source_table, source_id,
    created_by, created_at, metadata
  ) VALUES (
    p_branch_id, p_staff_id, v_movement_type, 'adjust',
    ABS(p_new_balance - v_balance_before),
    v_balance_before, p_new_balance,
    BTRIM(p_reason),
    'staff_cash_balances', v_balance.id::text,
    p_admin_id, now(),
    jsonb_build_object('admin_id', p_admin_id, 'movement_type', v_movement_type)
  ) RETURNING id INTO v_ledger_id;

  UPDATE public.staff_cash_balances
  SET last_ledger_id = v_ledger_id
  WHERE id = v_balance.id;

  RETURN jsonb_build_object(
    'balance_id',     v_balance.id,
    'balance_before', v_balance_before,
    'balance_after',  p_new_balance,
    'ledger_id',      v_ledger_id,
    'version',        v_balance.version
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.admin_set_staff_cash_balance(bigint, bigint, bigint, numeric, text, bigint)
  TO anon, authenticated;


-- ─────────────────────────────────────────────────────────────────
-- 8. RPC: open_cash_session_from_balance
--    Buka cashier_sessions dengan opening_cash = saldo aktif staff.
-- ─────────────────────────────────────────────────────────────────
DROP FUNCTION IF EXISTS public.open_cash_session_from_balance(bigint, bigint, numeric, text);

CREATE OR REPLACE FUNCTION public.open_cash_session_from_balance(
  p_branch_id       bigint,
  p_staff_id        bigint,
  p_physical_cash   numeric DEFAULT NULL,
  p_variance_reason text    DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_balance      public.staff_cash_balances%ROWTYPE;
  v_opening_cash numeric;
  v_session      public.cashier_sessions%ROWTYPE;
  v_variance     numeric;
  v_ledger_id    bigint;
  v_has_open     boolean;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.branches WHERE id = p_branch_id) THEN
    RAISE EXCEPTION 'Cabang tidak ditemukan';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM public.users WHERE id = p_staff_id) THEN
    RAISE EXCEPTION 'Staff tidak ditemukan';
  END IF;

  SELECT EXISTS(
    SELECT 1 FROM public.cashier_sessions
    WHERE branch_id = p_branch_id AND status = 'open'
  ) INTO v_has_open;

  IF v_has_open THEN
    RAISE EXCEPTION 'Masih ada kas yang belum ditutup di cabang ini';
  END IF;

  SELECT * INTO v_balance
  FROM public.staff_cash_balances
  WHERE branch_id = p_branch_id AND staff_id = p_staff_id
  FOR UPDATE;

  IF v_balance.id IS NULL THEN
    INSERT INTO public.staff_cash_balances (
      branch_id, staff_id, current_balance, version, updated_at
    ) VALUES (
      p_branch_id, p_staff_id, 0, 1, now()
    ) RETURNING * INTO v_balance;
  END IF;

  v_opening_cash := COALESCE(v_balance.current_balance, 0);
  v_variance     := CASE
    WHEN p_physical_cash IS NOT NULL THEN p_physical_cash - v_opening_cash
    ELSE 0
  END;

  IF v_variance <> 0 AND NULLIF(BTRIM(COALESCE(p_variance_reason, '')), '') IS NULL THEN
    RAISE EXCEPTION 'Alasan selisih kas wajib diisi jika kas fisik berbeda dari saldo sistem';
  END IF;

  INSERT INTO public.cashier_sessions (
    branch_id,
    staff_id,
    opening_cash,
    status,
    opening_cash_source,
    opening_balance_id,
    opening_confirmed_at,
    opening_confirmed_by,
    opening_physical_cash,
    opening_variance_amount,
    opening_variance_reason
  ) VALUES (
    p_branch_id,
    p_staff_id,
    v_opening_cash,
    'open',
    'balance',
    v_balance.id,
    now(),
    p_staff_id,
    p_physical_cash,
    v_variance,
    NULLIF(BTRIM(COALESCE(p_variance_reason, '')), '')
  ) RETURNING * INTO v_session;

  INSERT INTO public.staff_cash_ledger (
    branch_id, staff_id, cash_session_id,
    movement_type, direction, amount,
    balance_before, balance_after,
    reason, source_table, source_id,
    created_by, created_at, metadata
  ) VALUES (
    p_branch_id, p_staff_id, v_session.id,
    'session_open_confirm', 'none', 0,
    v_opening_cash, v_opening_cash,
    'Buka kas dari saldo aktif',
    'cashier_sessions', v_session.id::text,
    p_staff_id, now(),
    jsonb_build_object(
      'opening_cash',  v_opening_cash,
      'physical_cash', p_physical_cash,
      'variance',      v_variance
    )
  ) RETURNING id INTO v_ledger_id;

  IF v_variance <> 0 THEN
    INSERT INTO public.staff_cash_ledger (
      branch_id, staff_id, cash_session_id,
      movement_type, direction, amount,
      balance_before, balance_after,
      reason, source_table, source_id,
      created_by, created_at, metadata
    ) VALUES (
      p_branch_id, p_staff_id, v_session.id,
      'opening_variance',
      CASE WHEN v_variance > 0 THEN 'in' ELSE 'out' END,
      ABS(v_variance),
      v_opening_cash, v_opening_cash,
      BTRIM(p_variance_reason),
      'cashier_sessions', v_session.id::text || '_variance',
      p_staff_id, now(),
      jsonb_build_object('variance', v_variance, 'physical_cash', p_physical_cash)
    );
  END IF;

  UPDATE public.staff_cash_balances
  SET last_cash_session_id = v_session.id,
      last_ledger_id       = v_ledger_id,
      updated_at           = now()
  WHERE id = v_balance.id;

  RETURN jsonb_build_object(
    'id',                  v_session.id,
    'branch_id',           v_session.branch_id,
    'staff_id',            v_session.staff_id,
    'status',              v_session.status,
    'opening_cash',        v_opening_cash,
    'opening_cash_source', 'balance',
    'physical_cash',       p_physical_cash,
    'variance',            v_variance,
    'balance_id',          v_balance.id,
    'opened_at',           v_session.opened_at,
    'total_sales',         0,
    'total_transactions',  0
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.open_cash_session_from_balance(bigint, bigint, numeric, text)
  TO anon, authenticated;


-- ─────────────────────────────────────────────────────────────────
-- 9. RPC: close_cash_session_apply_balance
--    Tutup sesi dan update saldo aktif staff secara atomik + idempotent.
-- ─────────────────────────────────────────────────────────────────
DROP FUNCTION IF EXISTS public.close_cash_session_apply_balance(bigint, numeric, bigint);

CREATE OR REPLACE FUNCTION public.close_cash_session_apply_balance(
  p_session_id   bigint,
  p_closing_cash numeric,
  p_staff_id     bigint
)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_session        public.cashier_sessions%ROWTYPE;
  v_balance        public.staff_cash_balances%ROWTYPE;
  v_balance_before numeric;
  v_expected_cash  numeric;
  v_ledger_id      bigint;
BEGIN
  IF p_closing_cash IS NULL OR p_closing_cash < 0 THEN
    RAISE EXCEPTION 'Nominal kas akhir tidak boleh negatif';
  END IF;

  SELECT * INTO v_session
  FROM public.cashier_sessions
  WHERE id = p_session_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Sesi tidak ditemukan';
  END IF;

  IF v_session.status = 'closed' THEN
    RETURN jsonb_build_object(
      'id',             v_session.id,
      'status',         'closed',
      'closing_cash',   v_session.closing_cash,
      'expected_cash',  v_session.expected_cash,
      'already_closed', true
    );
  END IF;

  IF v_session.staff_id <> p_staff_id THEN
    RAISE EXCEPTION 'Session ini bukan milik staff yang bersangkutan';
  END IF;

  BEGIN
    v_expected_cash := public.compute_cash_session_system_amount(p_session_id);
  EXCEPTION WHEN OTHERS THEN
    v_expected_cash := COALESCE(v_session.opening_cash, 0);
  END;

  UPDATE public.cashier_sessions
  SET status              = 'closed',
      closing_cash        = p_closing_cash,
      expected_cash       = v_expected_cash,
      current_cash_amount = p_closing_cash,
      closed_at           = now(),
      balance_applied_at  = now()
  WHERE id = p_session_id
  RETURNING * INTO v_session;

  SELECT * INTO v_balance
  FROM public.staff_cash_balances
  WHERE branch_id = v_session.branch_id AND staff_id = p_staff_id
  FOR UPDATE;

  IF v_balance.id IS NULL THEN
    INSERT INTO public.staff_cash_balances (
      branch_id, staff_id, current_balance,
      last_cash_session_id, version, updated_at
    ) VALUES (
      v_session.branch_id, p_staff_id, p_closing_cash,
      p_session_id, 1, now()
    ) RETURNING * INTO v_balance;
    v_balance_before := 0;
  ELSE
    v_balance_before := COALESCE(v_balance.current_balance, 0);
    UPDATE public.staff_cash_balances
    SET current_balance      = p_closing_cash,
        last_cash_session_id = p_session_id,
        version              = version + 1,
        updated_at           = now()
    WHERE id = v_balance.id
    RETURNING * INTO v_balance;
  END IF;

  BEGIN
    INSERT INTO public.staff_cash_ledger (
      branch_id, staff_id, cash_session_id,
      movement_type, direction, amount,
      balance_before, balance_after,
      reason, source_table, source_id,
      created_by, created_at, metadata
    ) VALUES (
      v_session.branch_id, p_staff_id, p_session_id,
      'session_close',
      CASE WHEN p_closing_cash >= v_balance_before THEN 'in' ELSE 'out' END,
      ABS(p_closing_cash - v_balance_before),
      v_balance_before, p_closing_cash,
      'Tutup kas — saldo aktif diperbarui',
      'cashier_sessions', p_session_id::text,
      p_staff_id, now(),
      jsonb_build_object(
        'closing_cash',   p_closing_cash,
        'expected_cash',  v_expected_cash,
        'balance_before', v_balance_before
      )
    ) RETURNING id INTO v_ledger_id;
  EXCEPTION WHEN unique_violation THEN
    NULL;
  END;

  IF v_ledger_id IS NOT NULL THEN
    UPDATE public.staff_cash_balances
    SET last_ledger_id = v_ledger_id
    WHERE id = v_balance.id;

    UPDATE public.cashier_sessions
    SET balance_ledger_id = v_ledger_id
    WHERE id = p_session_id;
  END IF;

  RETURN jsonb_build_object(
    'id',             v_session.id,
    'status',         'closed',
    'closing_cash',   p_closing_cash,
    'expected_cash',  v_expected_cash,
    'balance_before', v_balance_before,
    'balance_after',  p_closing_cash,
    'ledger_id',      v_ledger_id,
    'already_closed', false
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.close_cash_session_apply_balance(bigint, numeric, bigint)
  TO anon, authenticated;


-- ─────────────────────────────────────────────────────────────────
-- 10. RPC: get_staff_cash_ledger
--     Riwayat perubahan saldo aktif staff.
-- ─────────────────────────────────────────────────────────────────
DROP FUNCTION IF EXISTS public.get_staff_cash_ledger(bigint, bigint, integer);

CREATE OR REPLACE FUNCTION public.get_staff_cash_ledger(
  p_branch_id bigint,
  p_staff_id  bigint,
  p_limit     integer DEFAULT 30
)
RETURNS TABLE (
  id               bigint,
  movement_type    text,
  direction        text,
  amount           numeric,
  balance_before   numeric,
  balance_after    numeric,
  reason           text,
  created_by_name  text,
  approved_by_name text,
  created_at       timestamptz,
  metadata         jsonb,
  cash_session_id  bigint,
  deposit_id       uuid
)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  RETURN QUERY
  SELECT
    scl.id,
    scl.movement_type,
    scl.direction,
    scl.amount,
    scl.balance_before,
    scl.balance_after,
    scl.reason,
    cu.name  AS created_by_name,
    au.name  AS approved_by_name,
    scl.created_at,
    scl.metadata,
    scl.cash_session_id,
    scl.deposit_id
  FROM public.staff_cash_ledger scl
  LEFT JOIN public.users cu ON cu.id = scl.created_by
  LEFT JOIN public.users au ON au.id = scl.approved_by
  WHERE scl.branch_id = p_branch_id
    AND scl.staff_id  = p_staff_id
  ORDER BY scl.created_at DESC
  LIMIT COALESCE(p_limit, 30);
END;
$$;

GRANT EXECUTE ON FUNCTION public.get_staff_cash_ledger(bigint, bigint, integer)
  TO anon, authenticated;


-- ─────────────────────────────────────────────────────────────────
-- 11. Extend confirm_deposit: apply saldo aktif idempotent
-- ─────────────────────────────────────────────────────────────────
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
  v_balance           public.staff_cash_balances%ROWTYPE;
  v_balance_before    numeric;
  v_new_balance       numeric;
  v_ledger_id         bigint;
BEGIN
  SELECT role INTO v_role FROM public.users WHERE id::text = p_admin_id::text;
  IF v_role IS NULL OR v_role NOT IN ('admin', 'owner') THEN
    RAISE EXCEPTION 'Hanya admin yang dapat mengkonfirmasi atau menolak setoran';
  END IF;

  IF p_action NOT IN ('confirmed', 'rejected') THEN
    RAISE EXCEPTION 'p_action harus ''confirmed'' atau ''rejected''';
  END IF;

  SELECT * INTO v_dep FROM public.cash_deposits WHERE id = p_deposit_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Setoran tidak ditemukan';
  END IF;
  IF v_dep.status <> 'pending' THEN
    RAISE EXCEPTION 'Setoran sudah diproses (status: %)', v_dep.status;
  END IF;

  IF v_dep.session_id IS NULL THEN
    RAISE EXCEPTION 'Setoran ini tidak memiliki shift yang valid dan tidak bisa dikonfirmasi';
  END IF;

  SELECT * INTO v_session
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

  IF p_action = 'confirmed' THEN
    SELECT id INTO v_cat_id
    FROM public.cash_categories
    WHERE name = 'Setoran Tunai' AND type = 'out'
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

    -- Apply saldo aktif (idempotent via balance_applied_at)
    IF v_dep.balance_applied_at IS NULL THEN
      SELECT * INTO v_balance
      FROM public.staff_cash_balances
      WHERE branch_id = v_dep.branch_id AND staff_id = v_dep.staff_id
      FOR UPDATE;

      IF v_balance.id IS NOT NULL THEN
        v_balance_before := COALESCE(v_balance.current_balance, 0);
        v_new_balance    := GREATEST(v_balance_before - v_dep.amount, 0);

        UPDATE public.staff_cash_balances
        SET current_balance = v_new_balance,
            version         = version + 1,
            updated_by      = p_admin_id,
            updated_at      = now()
        WHERE id = v_balance.id;

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
            v_balance_before, v_new_balance,
            'Setoran diapprove — saldo aktif dikurangi',
            'cash_deposits', p_deposit_id::text,
            v_dep.staff_id, p_admin_id, now(),
            jsonb_build_object('deposit_id', p_deposit_id, 'admin_id', p_admin_id)
          ) RETURNING id INTO v_ledger_id;
        EXCEPTION WHEN unique_violation THEN
          NULL;
        END;

        IF v_ledger_id IS NOT NULL THEN
          UPDATE public.cash_deposits
          SET balance_applied_at = now(),
              balance_ledger_id  = v_ledger_id
          WHERE id = p_deposit_id;

          UPDATE public.staff_cash_balances
          SET last_ledger_id = v_ledger_id
          WHERE id = v_balance.id;
        ELSE
          UPDATE public.cash_deposits
          SET balance_applied_at = now()
          WHERE id = p_deposit_id AND balance_applied_at IS NULL;
        END IF;
      END IF;
    END IF;
  END IF;
END;
$$;

GRANT EXECUTE ON FUNCTION public.confirm_deposit(uuid, bigint, text, text)
  TO anon, authenticated;


-- ─────────────────────────────────────────────────────────────────
-- 12. Security: revoke direct DML ke tabel baru
-- ─────────────────────────────────────────────────────────────────
REVOKE INSERT, UPDATE, DELETE ON public.staff_cash_balances FROM anon, authenticated;
REVOKE INSERT, UPDATE, DELETE ON public.staff_cash_ledger    FROM anon, authenticated;
GRANT SELECT ON public.staff_cash_balances TO anon, authenticated;
GRANT SELECT ON public.staff_cash_ledger    TO anon, authenticated;


NOTIFY pgrst, 'reload schema';

COMMIT;
