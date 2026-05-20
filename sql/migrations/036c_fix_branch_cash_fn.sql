-- Patch: drop & recreate get_admin_branch_cash_positions
-- Error sebelumnya: "structure of query does not match function result type"
-- Penyebab: fungsi lama (migration 035) punya return type berbeda, CREATE OR REPLACE tidak bisa ubah return type.
-- Fix: DROP dulu, lalu CREATE baru.
-- Jalankan ini di Supabase SQL Editor.

DROP FUNCTION IF EXISTS public.get_admin_branch_cash_positions(bigint, bigint, bigint, text, date, date);

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
    SELECT cs.id, cs.branch_id, cs.staff_id, cs.opened_at, cs.opening_cash,
           u.name AS staff_name
      FROM cashier_sessions cs
      LEFT JOIN users u ON u.id = cs.staff_id
     WHERE cs.status = 'open'
  ),
  last_closed AS (
    SELECT DISTINCT ON (cs.branch_id)
           cs.branch_id,
           cs.id         AS session_id,
           cs.opening_cash,
           cs.closing_cash,
           cs.closed_at,
           COALESCE(cs.closing_cash, 0) - COALESCE(cs.expected_cash, 0) AS variance,
           u.name        AS staff_name
      FROM cashier_sessions cs
      LEFT JOIN users u ON u.id = cs.staff_id
     WHERE cs.status = 'closed' AND cs.closing_cash IS NOT NULL
     ORDER BY cs.branch_id, cs.closed_at DESC
  ),
  pending AS (
    SELECT cd.branch_id, SUM(cd.amount) AS total
      FROM cash_deposits cd
     WHERE cd.status = 'pending'
     GROUP BY cd.branch_id
  )
  SELECT
    b.id                                                  AS branch_id,
    b.name                                                AS branch_name,
    COALESCE(bcp.balance, lc.closing_cash, 0)             AS current_balance,
    NULL::numeric                                          AS running_estimated_cash,
    bcp.id                                                 AS balance_id,
    COALESCE(bcp.version, 0)                               AS version,
    lc.opening_cash                                        AS last_opening_cash,
    lc.closing_cash                                        AS last_closing_cash,
    lc.staff_name                                          AS last_opened_by_name,
    lc.staff_name                                          AS last_closed_by_name,
    COALESCE(bcp.updated_at, lc.closed_at)                AS last_updated,
    CASE
      WHEN os.id          IS NOT NULL THEN 'open'
      WHEN lc.session_id  IS NOT NULL THEN 'closed_today'
      ELSE 'none'
    END                                                    AS shift_status,
    os.id                                                  AS open_session_id,
    os.staff_name                                          AS open_staff_name,
    os.opened_at                                           AS open_session_opened_at,
    COALESCE(pd.total, 0)                                  AS pending_deposit_amount,
    lc.variance                                            AS last_variance_amount,
    (lc.variance IS NOT NULL AND lc.variance <> 0)         AS has_variance,
    0::numeric                                             AS default_cash_position
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
