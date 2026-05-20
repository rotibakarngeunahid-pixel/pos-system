-- Migration 042: Fix ambiguous shift_status in get_admin_branch_cash_positions
-- Jalankan setelah migration 041 jika halaman Kas Outlet menampilkan:
-- column reference "shift_status" is ambiguous

BEGIN;

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
  SELECT id, role INTO v_admin
  FROM public.users
  WHERE id = p_admin_id;

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

GRANT EXECUTE ON FUNCTION public.get_admin_branch_cash_positions(bigint, bigint, bigint, text, date, date)
  TO anon, authenticated;

NOTIFY pgrst, 'reload schema';

COMMIT;
