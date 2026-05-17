-- 025_get_staff_cash_positions_rpc.sql
-- Aggregate cash position per staff for the admin "Posisi Kas Staff" dashboard.
-- Formula matches cashService.getSummary() on the client so both show the same number.

BEGIN;

DROP FUNCTION IF EXISTS public.get_staff_cash_positions(bigint, text);

CREATE OR REPLACE FUNCTION public.get_staff_cash_positions(
  p_branch_id bigint DEFAULT NULL,
  p_status    text   DEFAULT 'all'
)
RETURNS TABLE (
  staff_id          bigint,
  staff_name        text,
  branch_id         bigint,
  branch_name       text,
  session_id        bigint,
  session_status    text,
  opened_at         timestamptz,
  closed_at         timestamptz,
  opening_cash      numeric,
  cash_sales_in     numeric,
  manual_in         numeric,
  manual_out        numeric,
  refund_out        numeric,
  void_out          numeric,
  deposit_confirmed numeric,
  deposit_pending   numeric,
  expected_cash     numeric,
  last_activity_at  timestamptz,
  risk_level        text
)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  WITH
  -- Active staff members (role=staff, not soft-deleted)
  staff_list AS (
    SELECT
      u.id          AS user_id,
      u.name,
      u.branch_id   AS default_branch_id
    FROM public.users u
    WHERE u.role = 'staff'
      AND COALESCE(u.is_active, true) = true
  ),

  -- Latest OPEN session per staff (a staff should only have one, but guard with DISTINCT ON)
  open_sessions AS (
    SELECT DISTINCT ON (cs.user_id)
      cs.id           AS session_id,
      cs.user_id,
      cs.branch_id,
      cs.opening_cash,
      cs.opened_at
    FROM public.cashier_sessions cs
    WHERE cs.status = 'open'
    ORDER BY cs.user_id, cs.opened_at DESC
  ),

  -- Latest CLOSED session per staff (used for "Shift Ditutup Hari Ini" filter)
  last_closed AS (
    SELECT DISTINCT ON (cs.user_id)
      cs.id         AS session_id,
      cs.user_id,
      cs.branch_id,
      cs.closed_at
    FROM public.cashier_sessions cs
    WHERE cs.status = 'closed'
    ORDER BY cs.user_id, cs.closed_at DESC
  ),

  -- Cash log components per session (non-voided entries only)
  log_sums AS (
    SELECT
      cl.session_id,
      SUM(CASE WHEN cl.type = 'in'  AND cl.reference_type = 'manual'  AND NOT cl.is_void THEN cl.amount ELSE 0 END) AS manual_in,
      SUM(CASE WHEN cl.type = 'out' AND cl.reference_type = 'manual'  AND NOT cl.is_void THEN cl.amount ELSE 0 END) AS manual_out,
      SUM(CASE WHEN cl.type = 'out' AND cl.reference_type = 'refund'  AND NOT cl.is_void THEN cl.amount ELSE 0 END) AS refund_out,
      SUM(CASE WHEN cl.type = 'out' AND cl.reference_type = 'void'    AND NOT cl.is_void THEN cl.amount ELSE 0 END) AS void_out,
      SUM(CASE WHEN cl.type = 'out' AND cl.reference_type = 'deposit' AND NOT cl.is_void THEN cl.amount ELSE 0 END) AS deposit_confirmed,
      MAX(cl.created_at) AS last_log_at
    FROM public.cash_logs cl
    WHERE cl.session_id IS NOT NULL
    GROUP BY cl.session_id
  ),

  -- Completed cash sales per session
  sale_sums AS (
    SELECT
      t.session_id,
      SUM(t.total)      AS cash_sales_in,
      MAX(t.created_at) AS last_tx_at
    FROM public.transactions t
    WHERE t.status = 'completed'
      AND t.payment_method = 'cash'
      AND t.session_id IS NOT NULL
    GROUP BY t.session_id
  ),

  -- Total pending deposits per staff (all sessions)
  pending_sums AS (
    SELECT
      cd.staff_id,
      SUM(cd.amount) AS deposit_pending
    FROM public.cash_deposits cd
    WHERE cd.status = 'pending'
    GROUP BY cd.staff_id
  )

  SELECT
    sl.user_id                                                AS staff_id,
    sl.name                                                   AS staff_name,
    COALESCE(os.branch_id, sl.default_branch_id)            AS branch_id,
    COALESCE(b.name, '—')                                   AS branch_name,
    os.session_id,
    CASE
      WHEN os.session_id IS NOT NULL                         THEN 'open'
      WHEN lc.closed_at IS NOT NULL
           AND lc.closed_at >= CURRENT_DATE                  THEN 'closed_today'
      ELSE 'none'
    END                                                       AS session_status,
    os.opened_at,
    lc.closed_at,
    COALESCE(os.opening_cash, 0)                            AS opening_cash,
    COALESCE(ss.cash_sales_in, 0)                           AS cash_sales_in,
    COALESCE(ls.manual_in, 0)                               AS manual_in,
    COALESCE(ls.manual_out, 0)                              AS manual_out,
    COALESCE(ls.refund_out, 0)                              AS refund_out,
    COALESCE(ls.void_out, 0)                                AS void_out,
    COALESCE(ls.deposit_confirmed, 0)                       AS deposit_confirmed,
    COALESCE(ps.deposit_pending, 0)                         AS deposit_pending,
    (
      COALESCE(os.opening_cash, 0)
      + COALESCE(ss.cash_sales_in, 0)
      + COALESCE(ls.manual_in, 0)
      - COALESCE(ls.manual_out, 0)
      - COALESCE(ls.refund_out, 0)
      - COALESCE(ls.void_out, 0)
      - COALESCE(ls.deposit_confirmed, 0)
    )                                                         AS expected_cash,
    GREATEST(ls.last_log_at, ss.last_tx_at)                AS last_activity_at,
    CASE
      WHEN (
        COALESCE(os.opening_cash, 0)
        + COALESCE(ss.cash_sales_in, 0)
        + COALESCE(ls.manual_in, 0)
        - COALESCE(ls.manual_out, 0)
        - COALESCE(ls.refund_out, 0)
        - COALESCE(ls.void_out, 0)
        - COALESCE(ls.deposit_confirmed, 0)
      ) < 0           THEN 'danger'
      WHEN (
        COALESCE(os.opening_cash, 0)
        + COALESCE(ss.cash_sales_in, 0)
        + COALESCE(ls.manual_in, 0)
        - COALESCE(ls.manual_out, 0)
        - COALESCE(ls.refund_out, 0)
        - COALESCE(ls.void_out, 0)
        - COALESCE(ls.deposit_confirmed, 0)
      ) > 1000000     THEN 'high'
      WHEN (
        COALESCE(os.opening_cash, 0)
        + COALESCE(ss.cash_sales_in, 0)
        + COALESCE(ls.manual_in, 0)
        - COALESCE(ls.manual_out, 0)
        - COALESCE(ls.refund_out, 0)
        - COALESCE(ls.void_out, 0)
        - COALESCE(ls.deposit_confirmed, 0)
      ) > 500000      THEN 'warning'
      ELSE 'normal'
    END                                                       AS risk_level

  FROM staff_list sl
  LEFT JOIN open_sessions os ON os.user_id   = sl.user_id
  LEFT JOIN last_closed   lc ON lc.user_id   = sl.user_id
  LEFT JOIN public.branches b
         ON b.id = COALESCE(os.branch_id, sl.default_branch_id)
  LEFT JOIN log_sums      ls ON ls.session_id = os.session_id
  LEFT JOIN sale_sums     ss ON ss.session_id = os.session_id
  LEFT JOIN pending_sums  ps ON ps.staff_id   = sl.user_id

  WHERE
    (p_branch_id IS NULL
     OR COALESCE(os.branch_id, sl.default_branch_id) = p_branch_id)
    AND CASE p_status
          WHEN 'open'         THEN os.session_id IS NOT NULL
          WHEN 'none'         THEN os.session_id IS NULL
          WHEN 'closed_today' THEN os.session_id IS NULL AND lc.closed_at >= CURRENT_DATE
          ELSE TRUE
        END

  ORDER BY
    -- Active shifts first
    CASE WHEN os.session_id IS NOT NULL THEN 0 ELSE 1 END,
    -- Then by expected cash descending
    (
      COALESCE(os.opening_cash, 0)
      + COALESCE(ss.cash_sales_in, 0)
      + COALESCE(ls.manual_in, 0)
      - COALESCE(ls.manual_out, 0)
      - COALESCE(ls.refund_out, 0)
      - COALESCE(ls.void_out, 0)
      - COALESCE(ls.deposit_confirmed, 0)
    ) DESC,
    sl.name
$$;

GRANT EXECUTE ON FUNCTION public.get_staff_cash_positions(bigint, text)
  TO anon, authenticated;

NOTIFY pgrst, 'reload schema';

COMMIT;
