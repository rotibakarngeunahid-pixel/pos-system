-- Migration 023: Sync investor payment-method reporting with POS settings
-- Ensures investor sales KPIs, completed rows, and void rows all honor
-- p_payment_method when the investor UI filters by a dynamic payment method.

CREATE OR REPLACE FUNCTION investor_get_sales_report(
  p_user_id        BIGINT,
  p_branch_id      BIGINT,
  p_date_from      DATE,
  p_date_to        DATE,
  p_payment_method TEXT DEFAULT NULL
)
RETURNS JSON
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_has_access BOOLEAN;
  v_result     JSON;
BEGIN
  SELECT investor_can_access_feature(p_user_id, p_branch_id, 'sales') INTO v_has_access;
  IF NOT v_has_access THEN
    RAISE EXCEPTION 'Akses ditolak: investor tidak memiliki izin fitur ini';
  END IF;

  SELECT json_build_object(
    'transactions', COALESCE((
      SELECT json_agg(t ORDER BY t.created_at DESC)
      FROM (
        SELECT
          tx.id,
          tx.created_at,
          tx.total,
          tx.subtotal,
          tx.discount_amount,
          tx.payment_method,
          tx.status,
          b.name AS branch_name,
          u.name AS staff_name
        FROM transactions tx
        LEFT JOIN branches b ON b.id = tx.branch_id
        LEFT JOIN users    u ON u.id = tx.staff_id
        WHERE tx.branch_id = p_branch_id
          AND tx.created_at >= (p_date_from || 'T00:00:00')::TIMESTAMPTZ
          AND tx.created_at <= (p_date_to   || 'T23:59:59')::TIMESTAMPTZ
          AND (p_payment_method IS NULL OR p_payment_method = '' OR tx.payment_method = p_payment_method)
          AND tx.status = 'completed'
      ) t
    ), '[]'::json),
    'voidedTransactions', COALESCE((
      SELECT json_agg(t ORDER BY t.created_at DESC)
      FROM (
        SELECT
          tx.id,
          tx.created_at,
          tx.total,
          tx.payment_method,
          tx.status
        FROM transactions tx
        WHERE tx.branch_id = p_branch_id
          AND tx.created_at >= (p_date_from || 'T00:00:00')::TIMESTAMPTZ
          AND tx.created_at <= (p_date_to   || 'T23:59:59')::TIMESTAMPTZ
          AND (p_payment_method IS NULL OR p_payment_method = '' OR tx.payment_method = p_payment_method)
          AND tx.status IN ('void', 'voided')
      ) t
    ), '[]'::json),
    'totalRevenue', COALESCE((
      SELECT SUM(tx.total)
      FROM transactions tx
      WHERE tx.branch_id = p_branch_id
        AND tx.created_at >= (p_date_from || 'T00:00:00')::TIMESTAMPTZ
        AND tx.created_at <= (p_date_to   || 'T23:59:59')::TIMESTAMPTZ
        AND (p_payment_method IS NULL OR p_payment_method = '' OR tx.payment_method = p_payment_method)
        AND tx.status = 'completed'
    ), 0),
    'totalDiscount', COALESCE((
      SELECT SUM(tx.discount_amount)
      FROM transactions tx
      WHERE tx.branch_id = p_branch_id
        AND tx.created_at >= (p_date_from || 'T00:00:00')::TIMESTAMPTZ
        AND tx.created_at <= (p_date_to   || 'T23:59:59')::TIMESTAMPTZ
        AND (p_payment_method IS NULL OR p_payment_method = '' OR tx.payment_method = p_payment_method)
        AND tx.status = 'completed'
    ), 0),
    'count', COALESCE((
      SELECT COUNT(*)
      FROM transactions tx
      WHERE tx.branch_id = p_branch_id
        AND tx.created_at >= (p_date_from || 'T00:00:00')::TIMESTAMPTZ
        AND tx.created_at <= (p_date_to   || 'T23:59:59')::TIMESTAMPTZ
        AND (p_payment_method IS NULL OR p_payment_method = '' OR tx.payment_method = p_payment_method)
        AND tx.status = 'completed'
    ), 0),
    'voidCount', COALESCE((
      SELECT COUNT(*)
      FROM transactions tx
      WHERE tx.branch_id = p_branch_id
        AND tx.created_at >= (p_date_from || 'T00:00:00')::TIMESTAMPTZ
        AND tx.created_at <= (p_date_to   || 'T23:59:59')::TIMESTAMPTZ
        AND (p_payment_method IS NULL OR p_payment_method = '' OR tx.payment_method = p_payment_method)
        AND tx.status IN ('void', 'voided')
    ), 0),
    'voidAmount', COALESCE((
      SELECT SUM(tx.total)
      FROM transactions tx
      WHERE tx.branch_id = p_branch_id
        AND tx.created_at >= (p_date_from || 'T00:00:00')::TIMESTAMPTZ
        AND tx.created_at <= (p_date_to   || 'T23:59:59')::TIMESTAMPTZ
        AND (p_payment_method IS NULL OR p_payment_method = '' OR tx.payment_method = p_payment_method)
        AND tx.status IN ('void', 'voided')
    ), 0)
  ) INTO v_result;

  RETURN v_result;
END;
$$;

GRANT EXECUTE ON FUNCTION investor_get_sales_report(BIGINT, BIGINT, DATE, DATE, TEXT) TO anon, authenticated;
