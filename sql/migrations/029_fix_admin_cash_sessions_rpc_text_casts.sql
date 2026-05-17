-- 029_fix_admin_cash_sessions_rpc_text_casts.sql
-- Fix get_admin_cash_sessions runtime return-type mismatch after migration 028.
-- Some existing columns such as users.name are varchar(255), while the RPC
-- declares text return columns. PostgreSQL requires exact return types for
-- RETURNS TABLE, so cast text-shaped values explicitly.

BEGIN;

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

NOTIFY pgrst, 'reload schema';

COMMIT;
