-- Migration 043: Fix ambiguous id in get_branch_cash_ledger
-- Jalankan setelah migration 041/042 jika modal Riwayat Kas Outlet menampilkan:
-- column reference "id" is ambiguous

BEGIN;

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
      l.id::bigint AS id,
      l.movement_type::text AS movement_type,
      l.direction::text AS direction,
      l.amount::numeric AS amount,
      l.balance_before::numeric AS balance_before,
      l.balance_after::numeric AS balance_after,
      l.expected_balance::numeric AS expected_balance,
      l.variance_amount::numeric AS variance_amount,
      l.reason::text AS reason,
      staff.name::text AS staff_name,
      admin.name::text AS admin_name,
      l.cash_session_id::bigint AS cash_session_id,
      l.deposit_id::uuid AS deposit_id,
      l.source_table::text AS source_table,
      l.source_id::text AS source_id,
      l.created_at::timestamptz AS created_at,
      l.metadata::jsonb AS metadata
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

GRANT EXECUTE ON FUNCTION public.get_branch_cash_ledger(bigint, bigint, timestamptz, timestamptz, text, integer)
  TO anon, authenticated;

NOTIFY pgrst, 'reload schema';

COMMIT;
