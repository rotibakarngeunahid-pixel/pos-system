-- Migration 056: Fix admin cash branch transfer date filter timezone expression
--
-- Migration 055 created get_admin_cash_branch_transfers with an expression where
-- AT TIME ZONE could be applied to an interval:
--   interval '1 second' AT TIME ZONE 'Asia/Makassar'
-- PostgreSQL then raises:
--   function pg_catalog.timezone(unknown, interval) does not exist

BEGIN;

CREATE OR REPLACE FUNCTION public.get_admin_cash_branch_transfers(
  p_admin_id       bigint,
  p_from_branch_id bigint  DEFAULT NULL,
  p_to_branch_id   bigint  DEFAULT NULL,
  p_status         text    DEFAULT NULL,
  p_date_from      date    DEFAULT NULL,
  p_date_to        date    DEFAULT NULL,
  p_limit          integer DEFAULT 200,
  p_offset         integer DEFAULT 0
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_admin  record;
  v_result jsonb;
BEGIN
  SELECT id, role
    INTO v_admin
  FROM public.users
  WHERE id = p_admin_id
    AND COALESCE(is_active, true) = true;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Admin tidak ditemukan atau tidak aktif';
  END IF;
  IF v_admin.role NOT IN ('admin', 'owner') THEN
    RAISE EXCEPTION 'Hanya admin atau owner yang dapat melihat semua transfer';
  END IF;

  SELECT jsonb_build_object(
    'transfers', COALESCE(jsonb_agg(row ORDER BY row->>'requested_at' DESC), '[]'::jsonb),
    'summary', jsonb_build_object(
      'total_pending_count', COUNT(*) FILTER (WHERE (row->>'status')::text = 'pending'),
      'total_pending_amount', COALESCE(SUM((row->>'amount')::numeric) FILTER (WHERE (row->>'status')::text = 'pending'), 0),
      'total_confirmed_amount', COALESCE(SUM((row->>'amount')::numeric) FILTER (WHERE (row->>'status')::text = 'confirmed'), 0),
      'total_rejected_count', COUNT(*) FILTER (WHERE (row->>'status')::text = 'rejected'),
      'total_rejected_amount', COALESCE(SUM((row->>'amount')::numeric) FILTER (WHERE (row->>'status')::text = 'rejected'), 0)
    )
  )
    INTO v_result
  FROM (
    SELECT jsonb_build_object(
      'transfer_id',         cbt.id,
      'transfer_code',       cbt.transfer_code,
      'from_branch_id',      cbt.from_branch_id,
      'from_branch_name',    fb.name,
      'to_branch_id',        cbt.to_branch_id,
      'to_branch_name',      tb.name,
      'session_id',          cbt.session_id,
      'staff_id',            cbt.staff_id,
      'staff_name',          su.name,
      'amount',              cbt.amount,
      'status',              cbt.status,
      'notes',               cbt.notes,
      'reject_reason',       cbt.reject_reason,
      'cancel_reason',       cbt.cancel_reason,
      'proof_url',           cbt.proof_url,
      'proof_file_name',     cbt.proof_file_name,
      'requested_at',        cbt.requested_at,
      'confirmed_at',        cbt.confirmed_at,
      'confirmed_by_name',   cu.name,
      'rejected_at',         cbt.rejected_at,
      'rejected_by_name',    ru.name,
      'cancelled_at',        cbt.cancelled_at,
      'cancelled_by_name',   cxu.name,
      'source_balance_before', cbt.source_balance_before,
      'source_balance_after',  cbt.source_balance_after,
      'target_balance_before', cbt.target_balance_before,
      'target_balance_after',  cbt.target_balance_after
    ) AS row
    FROM public.cash_branch_transfers cbt
    JOIN public.branches fb ON fb.id = cbt.from_branch_id
    JOIN public.branches tb ON tb.id = cbt.to_branch_id
    LEFT JOIN public.users su  ON su.id  = cbt.staff_id
    LEFT JOIN public.users cu  ON cu.id  = cbt.confirmed_by
    LEFT JOIN public.users ru  ON ru.id  = cbt.rejected_by
    LEFT JOIN public.users cxu ON cxu.id = cbt.cancelled_by
    WHERE (p_from_branch_id IS NULL OR cbt.from_branch_id = p_from_branch_id)
      AND (p_to_branch_id   IS NULL OR cbt.to_branch_id   = p_to_branch_id)
      AND (p_status         IS NULL OR cbt.status         = p_status)
      AND (p_date_from      IS NULL OR cbt.requested_at >= (p_date_from::timestamp AT TIME ZONE 'Asia/Makassar'))
      AND (p_date_to        IS NULL OR cbt.requested_at <  ((p_date_to + 1)::timestamp AT TIME ZONE 'Asia/Makassar'))
    ORDER BY cbt.requested_at DESC
    LIMIT COALESCE(p_limit, 200)
    OFFSET COALESCE(p_offset, 0)
  ) sub;

  RETURN COALESCE(v_result, jsonb_build_object('transfers','[]'::jsonb,'summary','{}'::jsonb));
END;
$$;

GRANT EXECUTE ON FUNCTION public.get_admin_cash_branch_transfers(bigint,bigint,bigint,text,date,date,integer,integer)
  TO anon, authenticated;

NOTIFY pgrst, 'reload schema';

COMMIT;
