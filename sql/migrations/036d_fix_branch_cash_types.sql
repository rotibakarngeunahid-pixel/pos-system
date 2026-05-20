-- Patch 036d: drop & recreate get_admin_branch_cash_positions dengan explicit type cast
-- Fix: varchar vs text OID mismatch pada kolom b.name dan u.name
-- Jalankan ini di Supabase SQL Editor.

-- Drop semua overload fungsi ini
DO $$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT p.oid, pg_get_function_identity_arguments(p.oid) AS args
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.proname = 'get_admin_branch_cash_positions'
  LOOP
    EXECUTE 'DROP FUNCTION IF EXISTS public.get_admin_branch_cash_positions(' || r.args || ')';
  END LOOP;
END;
$$;

CREATE FUNCTION public.get_admin_branch_cash_positions(
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
  WITH open_sess AS (
    SELECT cs.id::bigint,
           cs.branch_id::bigint,
           cs.staff_id::bigint,
           cs.opened_at::timestamptz,
           cs.opening_cash::numeric,
           u.name::text AS staff_name
      FROM cashier_sessions cs
      LEFT JOIN users u ON u.id = cs.staff_id
     WHERE cs.status = 'open'
  ),
  last_closed AS (
    SELECT DISTINCT ON (cs.branch_id)
           cs.branch_id::bigint,
           cs.id::bigint AS session_id,
           cs.opening_cash::numeric,
           cs.closing_cash::numeric,
           cs.closed_at::timestamptz,
           (COALESCE(cs.closing_cash, 0) - COALESCE(cs.expected_cash, 0))::numeric AS variance,
           u.name::text AS staff_name
      FROM cashier_sessions cs
      LEFT JOIN users u ON u.id = cs.staff_id
     WHERE cs.status = 'closed' AND cs.closing_cash IS NOT NULL
     ORDER BY cs.branch_id, cs.closed_at DESC
  ),
  pending AS (
    SELECT cd.branch_id::bigint, SUM(cd.amount)::numeric AS total
      FROM cash_deposits cd
     WHERE cd.status = 'pending'
     GROUP BY cd.branch_id
  )
  SELECT
    b.id::bigint                                                          AS branch_id,
    b.name::text                                                          AS branch_name,
    COALESCE(bcp.balance, lc.closing_cash, 0)::numeric                   AS current_balance,
    NULL::numeric                                                          AS running_estimated_cash,
    bcp.id::bigint                                                         AS balance_id,
    COALESCE(bcp.version, 0)::bigint                                       AS version,
    lc.opening_cash::numeric                                               AS last_opening_cash,
    lc.closing_cash::numeric                                               AS last_closing_cash,
    lc.staff_name::text                                                    AS last_opened_by_name,
    lc.staff_name::text                                                    AS last_closed_by_name,
    COALESCE(bcp.updated_at, lc.closed_at)::timestamptz                   AS last_updated,
    CASE
      WHEN os.id         IS NOT NULL THEN 'open'
      WHEN lc.session_id IS NOT NULL THEN 'closed_today'
      ELSE 'none'
    END::text                                                              AS shift_status,
    os.id::bigint                                                          AS open_session_id,
    os.staff_name::text                                                    AS open_staff_name,
    os.opened_at::timestamptz                                              AS open_session_opened_at,
    COALESCE(pd.total, 0)::numeric                                         AS pending_deposit_amount,
    lc.variance::numeric                                                   AS last_variance_amount,
    (lc.variance IS NOT NULL AND lc.variance <> 0)::boolean               AS has_variance,
    0::numeric                                                             AS default_cash_position
  FROM branches b
  LEFT JOIN branch_cash_positions bcp ON bcp.branch_id = b.id
  LEFT JOIN open_sess              os  ON os.branch_id  = b.id
  LEFT JOIN last_closed            lc  ON lc.branch_id  = b.id
  LEFT JOIN pending                pd  ON pd.branch_id  = b.id
  WHERE b.is_active = true
    AND (p_branch_id IS NULL OR b.id = p_branch_id)
  ORDER BY b.name;
END;
$$;

GRANT EXECUTE ON FUNCTION public.get_admin_branch_cash_positions(bigint, bigint, bigint, text, date, date) TO anon, authenticated;

NOTIFY pgrst, 'reload schema';
