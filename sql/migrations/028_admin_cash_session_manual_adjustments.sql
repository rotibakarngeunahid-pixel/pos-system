-- 028_admin_cash_session_manual_adjustments.sql
-- Admin manual cash closing and actual cash adjustment audit trail.

BEGIN;

ALTER TABLE public.cashier_sessions
  ADD COLUMN IF NOT EXISTS closed_manually boolean DEFAULT false,
  ADD COLUMN IF NOT EXISTS manual_closed_by bigint REFERENCES public.users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS manual_closed_at timestamptz,
  ADD COLUMN IF NOT EXISTS manual_close_reason text,
  ADD COLUMN IF NOT EXISTS current_cash_amount numeric(15,2),
  ADD COLUMN IF NOT EXISTS has_manual_adjustment boolean DEFAULT false,
  ADD COLUMN IF NOT EXISTS updated_at timestamptz DEFAULT now();

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'cashier_sessions_current_cash_amount_nonnegative'
      AND conrelid = 'public.cashier_sessions'::regclass
  ) THEN
    ALTER TABLE public.cashier_sessions
      ADD CONSTRAINT cashier_sessions_current_cash_amount_nonnegative
      CHECK (current_cash_amount IS NULL OR current_cash_amount >= 0);
  END IF;
END$$;

UPDATE public.cashier_sessions
SET updated_at = COALESCE(updated_at, closed_at, opened_at, now())
WHERE updated_at IS NULL;

CREATE OR REPLACE FUNCTION public.set_cashier_sessions_updated_at()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_cashier_sessions_updated_at ON public.cashier_sessions;
CREATE TRIGGER trg_cashier_sessions_updated_at
BEFORE UPDATE ON public.cashier_sessions
FOR EACH ROW
EXECUTE FUNCTION public.set_cashier_sessions_updated_at();

CREATE TABLE IF NOT EXISTS public.cash_session_adjustments (
  id bigserial PRIMARY KEY,
  cash_session_id bigint NOT NULL REFERENCES public.cashier_sessions(id) ON DELETE CASCADE,
  branch_id bigint REFERENCES public.branches(id) ON DELETE SET NULL,
  staff_id bigint REFERENCES public.users(id) ON DELETE SET NULL,
  action_type text NOT NULL CHECK (
    action_type IN ('manual_close', 'manual_cash_adjustment', 'manual_actual_cash_input')
  ),
  previous_cash_amount numeric(15,2),
  new_cash_amount numeric(15,2) NOT NULL CHECK (new_cash_amount >= 0),
  adjustment_amount numeric(15,2) NOT NULL,
  reason text NOT NULL CHECK (BTRIM(reason) <> ''),
  created_by bigint REFERENCES public.users(id) ON DELETE SET NULL,
  created_by_name text,
  created_at timestamptz NOT NULL DEFAULT now(),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS idx_cash_session_adjustments_session
  ON public.cash_session_adjustments(cash_session_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_cash_session_adjustments_branch
  ON public.cash_session_adjustments(branch_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_cash_session_adjustments_staff
  ON public.cash_session_adjustments(staff_id, created_at DESC);

ALTER TABLE public.cash_session_adjustments ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_policy
    WHERE polname = 'cash_session_adjustments_read'
      AND polrelid = 'public.cash_session_adjustments'::regclass
  ) THEN
    DROP POLICY cash_session_adjustments_read ON public.cash_session_adjustments;
  END IF;
END$$;

CREATE POLICY cash_session_adjustments_read
  ON public.cash_session_adjustments
  FOR SELECT
  USING (true);

GRANT USAGE ON SCHEMA public TO anon, authenticated;
GRANT SELECT ON public.cash_session_adjustments TO anon, authenticated;

CREATE OR REPLACE FUNCTION public.compute_cash_session_system_amount(
  p_session_id bigint
) RETURNS numeric
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  WITH
  sess AS (
    SELECT id, opening_cash
    FROM public.cashier_sessions
    WHERE id = p_session_id
  ),
  log_sums AS (
    SELECT
      SUM(CASE WHEN cl.type = 'in'  AND cl.reference_type = 'manual'  AND NOT COALESCE(cl.is_void, false) THEN cl.amount ELSE 0 END) AS manual_in,
      SUM(CASE WHEN cl.type = 'out' AND cl.reference_type = 'manual'  AND NOT COALESCE(cl.is_void, false) THEN cl.amount ELSE 0 END) AS manual_out,
      SUM(CASE WHEN cl.type = 'out' AND cl.reference_type = 'refund'  AND NOT COALESCE(cl.is_void, false) THEN cl.amount ELSE 0 END) AS refund_out,
      SUM(CASE WHEN cl.type = 'out' AND cl.reference_type = 'void'    AND NOT COALESCE(cl.is_void, false) THEN cl.amount ELSE 0 END) AS void_out,
      SUM(CASE WHEN cl.type = 'out' AND cl.reference_type = 'deposit' AND NOT COALESCE(cl.is_void, false) THEN cl.amount ELSE 0 END) AS deposit_out
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
    + COALESCE(ss.cash_sales_in, 0)
    + COALESCE(ls.manual_in, 0)
    - COALESCE(ls.manual_out, 0)
    - COALESCE(ls.refund_out, 0)
    - COALESCE(ls.void_out, 0)
    - COALESCE(ls.deposit_out, 0)
  FROM sess s
  CROSS JOIN log_sums ls
  CROSS JOIN sale_sums ss;
$$;

GRANT EXECUTE ON FUNCTION public.compute_cash_session_system_amount(bigint)
  TO anon, authenticated;

CREATE OR REPLACE FUNCTION public.get_admin_cash_sessions(
  p_admin_id bigint,
  p_branch_id bigint DEFAULT NULL,
  p_staff_id bigint DEFAULT NULL,
  p_status text DEFAULT 'open',
  p_date_from date DEFAULT NULL,
  p_date_to date DEFAULT NULL
) RETURNS TABLE (
  session_id bigint,
  staff_id bigint,
  staff_name text,
  branch_id bigint,
  branch_name text,
  session_status text,
  opened_at timestamptz,
  closed_at timestamptz,
  opening_cash numeric,
  closing_cash numeric,
  cash_sales_in numeric,
  manual_in numeric,
  manual_out numeric,
  refund_out numeric,
  void_out numeric,
  deposit_confirmed numeric,
  deposit_pending numeric,
  system_cash_amount numeric,
  current_cash_amount numeric,
  closed_manually boolean,
  has_manual_adjustment boolean,
  manual_closed_at timestamptz,
  manual_close_reason text,
  updated_at timestamptz,
  adjustment_count bigint,
  last_activity_at timestamptz,
  risk_level text
)
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_admin_role text;
  v_status text;
BEGIN
  SELECT role
    INTO v_admin_role
  FROM public.users
  WHERE id::text = p_admin_id::text;

  IF v_admin_role IS NULL OR v_admin_role NOT IN ('admin', 'owner') THEN
    RAISE EXCEPTION 'Hanya owner/admin yang dapat melihat daftar kas admin';
  END IF;

  v_status := COALESCE(NULLIF(BTRIM(COALESCE(p_status, '')), ''), 'open');

  RETURN QUERY
  WITH
  base_sessions AS (
    SELECT
      cs.id AS session_id,
      cs.staff_id,
      u.name::text AS staff_name,
      cs.branch_id,
      b.name::text AS branch_name,
      cs.status::text AS session_status,
      cs.opened_at,
      cs.closed_at,
      COALESCE(cs.opening_cash, 0) AS opening_cash,
      cs.closing_cash,
      COALESCE(cs.current_cash_amount, NULL) AS current_cash_amount,
      COALESCE(cs.closed_manually, false) AS closed_manually,
      COALESCE(cs.has_manual_adjustment, false) AS has_manual_adjustment,
      cs.manual_closed_at,
      cs.manual_close_reason,
      COALESCE(cs.updated_at, cs.closed_at, cs.opened_at) AS updated_at
    FROM public.cashier_sessions cs
    LEFT JOIN public.users u ON u.id = cs.staff_id
    LEFT JOIN public.branches b ON b.id = cs.branch_id
    WHERE (p_branch_id IS NULL OR cs.branch_id = p_branch_id)
      AND (p_staff_id IS NULL OR cs.staff_id = p_staff_id)
      AND (p_date_from IS NULL OR cs.opened_at >= p_date_from::timestamptz)
      AND (p_date_to IS NULL OR cs.opened_at < (p_date_to + 1)::timestamptz)
  ),
  log_sums AS (
    SELECT
      cl.session_id,
      SUM(CASE WHEN cl.type = 'in'  AND cl.reference_type = 'manual'  AND NOT COALESCE(cl.is_void, false) THEN cl.amount ELSE 0 END) AS manual_in,
      SUM(CASE WHEN cl.type = 'out' AND cl.reference_type = 'manual'  AND NOT COALESCE(cl.is_void, false) THEN cl.amount ELSE 0 END) AS manual_out,
      SUM(CASE WHEN cl.type = 'out' AND cl.reference_type = 'refund'  AND NOT COALESCE(cl.is_void, false) THEN cl.amount ELSE 0 END) AS refund_out,
      SUM(CASE WHEN cl.type = 'out' AND cl.reference_type = 'void'    AND NOT COALESCE(cl.is_void, false) THEN cl.amount ELSE 0 END) AS void_out,
      SUM(CASE WHEN cl.type = 'out' AND cl.reference_type = 'deposit' AND NOT COALESCE(cl.is_void, false) THEN cl.amount ELSE 0 END) AS deposit_confirmed,
      MAX(cl.created_at) AS last_log_at
    FROM public.cash_logs cl
    WHERE cl.session_id IS NOT NULL
    GROUP BY cl.session_id
  ),
  sale_sums AS (
    SELECT
      t.session_id,
      SUM(t.total) AS cash_sales_in,
      MAX(t.created_at) AS last_tx_at
    FROM public.transactions t
    WHERE t.status = 'completed'
      AND t.payment_method = 'cash'
      AND t.session_id IS NOT NULL
    GROUP BY t.session_id
  ),
  pending_sums AS (
    SELECT
      cd.session_id,
      SUM(cd.amount) AS deposit_pending
    FROM public.cash_deposits cd
    WHERE cd.status = 'pending'
      AND cd.session_id IS NOT NULL
    GROUP BY cd.session_id
  ),
  adjustment_sums AS (
    SELECT
      csa.cash_session_id AS session_id,
      COUNT(*) AS adjustment_count
    FROM public.cash_session_adjustments csa
    GROUP BY csa.cash_session_id
  ),
  enriched AS (
    SELECT
      bs.session_id,
      bs.staff_id,
      bs.staff_name,
      bs.branch_id,
      bs.branch_name,
      bs.session_status,
      bs.opened_at,
      bs.closed_at,
      bs.opening_cash,
      bs.closing_cash,
      COALESCE(ss.cash_sales_in, 0) AS cash_sales_in,
      COALESCE(ls.manual_in, 0) AS manual_in,
      COALESCE(ls.manual_out, 0) AS manual_out,
      COALESCE(ls.refund_out, 0) AS refund_out,
      COALESCE(ls.void_out, 0) AS void_out,
      COALESCE(ls.deposit_confirmed, 0) AS deposit_confirmed,
      COALESCE(ps.deposit_pending, 0) AS deposit_pending,
      (
        bs.opening_cash
        + COALESCE(ss.cash_sales_in, 0)
        + COALESCE(ls.manual_in, 0)
        - COALESCE(ls.manual_out, 0)
        - COALESCE(ls.refund_out, 0)
        - COALESCE(ls.void_out, 0)
        - COALESCE(ls.deposit_confirmed, 0)
      ) AS system_cash_amount,
      bs.current_cash_amount,
      bs.closed_manually,
      (bs.has_manual_adjustment OR COALESCE(adj.adjustment_count, 0) > 0) AS has_manual_adjustment,
      bs.manual_closed_at,
      bs.manual_close_reason,
      bs.updated_at,
      COALESCE(adj.adjustment_count, 0)::bigint AS adjustment_count,
      GREATEST(ls.last_log_at, ss.last_tx_at, bs.closed_at, bs.opened_at) AS last_activity_at
    FROM base_sessions bs
    LEFT JOIN log_sums ls ON ls.session_id = bs.session_id
    LEFT JOIN sale_sums ss ON ss.session_id = bs.session_id
    LEFT JOIN pending_sums ps ON ps.session_id = bs.session_id
    LEFT JOIN adjustment_sums adj ON adj.session_id = bs.session_id
  )
  SELECT
    e.session_id,
    e.staff_id,
    e.staff_name::text,
    e.branch_id,
    e.branch_name::text,
    e.session_status::text,
    e.opened_at,
    e.closed_at,
    e.opening_cash,
    e.closing_cash,
    e.cash_sales_in,
    e.manual_in,
    e.manual_out,
    e.refund_out,
    e.void_out,
    e.deposit_confirmed,
    e.deposit_pending,
    e.system_cash_amount,
    COALESCE(e.current_cash_amount, e.closing_cash, e.system_cash_amount) AS current_cash_amount,
    e.closed_manually,
    e.has_manual_adjustment,
    e.manual_closed_at,
    e.manual_close_reason::text,
    e.updated_at,
    e.adjustment_count,
    e.last_activity_at,
    CASE
      WHEN COALESCE(e.current_cash_amount, e.closing_cash, e.system_cash_amount) < 0 THEN 'danger'
      WHEN ABS(COALESCE(e.current_cash_amount, e.closing_cash, e.system_cash_amount) - e.system_cash_amount) > 100000 THEN 'warning'
      WHEN e.system_cash_amount > 1000000 THEN 'high'
      WHEN e.system_cash_amount > 500000 THEN 'warning'
      ELSE 'normal'
    END::text AS risk_level
  FROM enriched e
  WHERE CASE v_status
    WHEN 'open' THEN e.session_status = 'open'
    WHEN 'closed' THEN e.session_status = 'closed'
    WHEN 'manual_closed' THEN e.closed_manually IS TRUE
    WHEN 'adjusted' THEN e.has_manual_adjustment IS TRUE
    ELSE TRUE
  END
  ORDER BY
    CASE WHEN e.session_status = 'open' THEN 0 ELSE 1 END,
    e.opened_at DESC,
    e.session_id DESC;
END;
$$;

GRANT EXECUTE ON FUNCTION public.get_admin_cash_sessions(bigint, bigint, bigint, text, date, date)
  TO anon, authenticated;

CREATE OR REPLACE FUNCTION public.admin_manual_close_cash_session(
  p_admin_id bigint,
  p_session_id bigint,
  p_actual_cash_amount numeric,
  p_reason text,
  p_expected_updated_at timestamptz DEFAULT NULL
) RETURNS bigint
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_sess public.cashier_sessions%ROWTYPE;
  v_admin_role text;
  v_admin_name text;
  v_reason text;
  v_system_cash numeric;
  v_previous_cash numeric;
  v_adjustment_id bigint;
  v_now timestamptz := now();
BEGIN
  SELECT role, name
    INTO v_admin_role, v_admin_name
  FROM public.users
  WHERE id::text = p_admin_id::text;

  IF v_admin_role IS NULL OR v_admin_role NOT IN ('admin', 'owner') THEN
    RAISE EXCEPTION 'Hanya owner/admin yang dapat menutup kas manual';
  END IF;

  v_reason := NULLIF(BTRIM(COALESCE(p_reason, '')), '');
  IF v_reason IS NULL THEN
    RAISE EXCEPTION 'Alasan wajib diisi';
  END IF;

  IF p_actual_cash_amount IS NULL OR p_actual_cash_amount < 0 THEN
    RAISE EXCEPTION 'Nominal kas aktual tidak boleh negatif';
  END IF;

  SELECT *
    INTO v_sess
  FROM public.cashier_sessions
  WHERE id = p_session_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Kas tidak ditemukan';
  END IF;

  IF v_sess.status <> 'open' THEN
    RAISE EXCEPTION 'Kas sudah tertutup dan tidak dapat ditutup ulang';
  END IF;

  IF p_expected_updated_at IS NOT NULL
     AND COALESCE(v_sess.updated_at, v_sess.opened_at) IS DISTINCT FROM p_expected_updated_at THEN
    RAISE EXCEPTION 'Konflik data kas. Muat ulang detail kas lalu coba lagi.'
      USING ERRCODE = '40001';
  END IF;

  v_system_cash := COALESCE(public.compute_cash_session_system_amount(p_session_id), 0);
  v_previous_cash := COALESCE(v_sess.current_cash_amount, v_sess.closing_cash, v_system_cash, 0);

  UPDATE public.cashier_sessions
  SET
    status = 'closed',
    closing_cash = p_actual_cash_amount,
    expected_cash = v_system_cash,
    closed_at = v_now,
    closed_manually = true,
    manual_closed_by = p_admin_id,
    manual_closed_at = v_now,
    manual_close_reason = v_reason,
    current_cash_amount = p_actual_cash_amount,
    has_manual_adjustment = COALESCE(has_manual_adjustment, false)
      OR p_actual_cash_amount IS DISTINCT FROM v_previous_cash
  WHERE id = p_session_id;

  INSERT INTO public.cash_session_adjustments (
    cash_session_id,
    branch_id,
    staff_id,
    action_type,
    previous_cash_amount,
    new_cash_amount,
    adjustment_amount,
    reason,
    created_by,
    created_by_name,
    metadata
  ) VALUES (
    p_session_id,
    v_sess.branch_id,
    v_sess.staff_id,
    'manual_close',
    v_previous_cash,
    p_actual_cash_amount,
    p_actual_cash_amount - v_previous_cash,
    v_reason,
    p_admin_id,
    v_admin_name,
    jsonb_build_object(
      'system_cash_amount', v_system_cash,
      'previous_status', v_sess.status,
      'expected_updated_at', p_expected_updated_at
    )
  )
  RETURNING id INTO v_adjustment_id;

  RETURN v_adjustment_id;
END;
$$;

GRANT EXECUTE ON FUNCTION public.admin_manual_close_cash_session(bigint, bigint, numeric, text, timestamptz)
  TO anon, authenticated;

CREATE OR REPLACE FUNCTION public.admin_adjust_cash_session_actual(
  p_admin_id bigint,
  p_session_id bigint,
  p_new_cash_amount numeric,
  p_reason text,
  p_expected_updated_at timestamptz DEFAULT NULL
) RETURNS bigint
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_sess public.cashier_sessions%ROWTYPE;
  v_admin_role text;
  v_admin_name text;
  v_reason text;
  v_system_cash numeric;
  v_previous_cash numeric;
  v_action_type text;
  v_adjustment_id bigint;
BEGIN
  SELECT role, name
    INTO v_admin_role, v_admin_name
  FROM public.users
  WHERE id::text = p_admin_id::text;

  IF v_admin_role IS NULL OR v_admin_role NOT IN ('admin', 'owner') THEN
    RAISE EXCEPTION 'Hanya owner/admin yang dapat edit posisi kas';
  END IF;

  v_reason := NULLIF(BTRIM(COALESCE(p_reason, '')), '');
  IF v_reason IS NULL THEN
    RAISE EXCEPTION 'Alasan wajib diisi';
  END IF;

  IF p_new_cash_amount IS NULL OR p_new_cash_amount < 0 THEN
    RAISE EXCEPTION 'Nominal kas aktual tidak boleh negatif';
  END IF;

  SELECT *
    INTO v_sess
  FROM public.cashier_sessions
  WHERE id = p_session_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Kas tidak ditemukan';
  END IF;

  IF p_expected_updated_at IS NOT NULL
     AND COALESCE(v_sess.updated_at, v_sess.opened_at) IS DISTINCT FROM p_expected_updated_at THEN
    RAISE EXCEPTION 'Konflik data kas. Muat ulang detail kas lalu coba lagi.'
      USING ERRCODE = '40001';
  END IF;

  v_system_cash := COALESCE(public.compute_cash_session_system_amount(p_session_id), 0);
  v_previous_cash := COALESCE(v_sess.current_cash_amount, v_sess.closing_cash, v_system_cash, 0);
  v_action_type := CASE
    WHEN v_sess.current_cash_amount IS NULL THEN 'manual_actual_cash_input'
    ELSE 'manual_cash_adjustment'
  END;

  UPDATE public.cashier_sessions
  SET
    current_cash_amount = p_new_cash_amount,
    has_manual_adjustment = true
  WHERE id = p_session_id;

  INSERT INTO public.cash_session_adjustments (
    cash_session_id,
    branch_id,
    staff_id,
    action_type,
    previous_cash_amount,
    new_cash_amount,
    adjustment_amount,
    reason,
    created_by,
    created_by_name,
    metadata
  ) VALUES (
    p_session_id,
    v_sess.branch_id,
    v_sess.staff_id,
    v_action_type,
    v_previous_cash,
    p_new_cash_amount,
    p_new_cash_amount - v_previous_cash,
    v_reason,
    p_admin_id,
    v_admin_name,
    jsonb_build_object(
      'system_cash_amount', v_system_cash,
      'session_status', v_sess.status,
      'expected_updated_at', p_expected_updated_at
    )
  )
  RETURNING id INTO v_adjustment_id;

  RETURN v_adjustment_id;
END;
$$;

GRANT EXECUTE ON FUNCTION public.admin_adjust_cash_session_actual(bigint, bigint, numeric, text, timestamptz)
  TO anon, authenticated;

NOTIFY pgrst, 'reload schema';

COMMIT;
