-- ═══════════════════════════════════════════════════════════════
-- Migration 015: Investor Role & Branch Access
-- Adds role 'investor', investor_branch_access mapping table,
-- and RPC functions for secure investor data access.
-- ═══════════════════════════════════════════════════════════════

-- 1. Update role constraint to allow 'investor'
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_role_check;
ALTER TABLE users ADD CONSTRAINT users_role_check
  CHECK (role IN ('admin', 'staff', 'investor'));

-- 2. Create investor_branch_access table
CREATE TABLE IF NOT EXISTS investor_branch_access (
  id         BIGSERIAL PRIMARY KEY,
  user_id    BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  branch_id  BIGINT NOT NULL REFERENCES branches(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  created_by BIGINT REFERENCES users(id),
  UNIQUE(user_id, branch_id)
);

CREATE INDEX IF NOT EXISTS idx_investor_branch_access_user
  ON investor_branch_access(user_id);

CREATE INDEX IF NOT EXISTS idx_investor_branch_access_branch
  ON investor_branch_access(branch_id);

-- Grant access
GRANT ALL ON investor_branch_access TO anon, authenticated;
GRANT ALL ON SEQUENCE investor_branch_access_id_seq TO anon, authenticated;

-- 3. Optional view: investor_allowed_branches
CREATE OR REPLACE VIEW investor_allowed_branches AS
SELECT
  iba.user_id,
  b.id   AS branch_id,
  b.name AS branch_name,
  b.address
FROM investor_branch_access iba
JOIN branches b ON b.id = iba.branch_id;

GRANT SELECT ON investor_allowed_branches TO anon, authenticated;

-- ─────────────────────────────────────────────────────────────────
-- RPC: investor_get_allowed_branches
-- Returns list of branches the investor is allowed to view.
-- ─────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION investor_get_allowed_branches(p_user_id BIGINT)
RETURNS TABLE (
  branch_id   BIGINT,
  branch_name TEXT,
  address     TEXT
)
LANGUAGE sql
SECURITY DEFINER
AS $$
  SELECT b.id, b.name, b.address
  FROM investor_branch_access iba
  JOIN branches b ON b.id = iba.branch_id
  JOIN users u ON u.id = iba.user_id
  WHERE iba.user_id = p_user_id
    AND u.role = 'investor'
  ORDER BY b.name;
$$;

GRANT EXECUTE ON FUNCTION investor_get_allowed_branches(BIGINT) TO anon, authenticated;

-- ─────────────────────────────────────────────────────────────────
-- RPC: investor_can_access_branch
-- Returns TRUE if the investor has access to the given branch.
-- Used internally by other RPCs to validate access.
-- ─────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION investor_can_access_branch(
  p_user_id  BIGINT,
  p_branch_id BIGINT
)
RETURNS BOOLEAN
LANGUAGE sql
SECURITY DEFINER
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM investor_branch_access iba
    JOIN users u ON u.id = iba.user_id
    WHERE iba.user_id = p_user_id
      AND iba.branch_id = p_branch_id
      AND u.role = 'investor'
  );
$$;

GRANT EXECUTE ON FUNCTION investor_can_access_branch(BIGINT, BIGINT) TO anon, authenticated;

-- ─────────────────────────────────────────────────────────────────
-- RPC: investor_get_sales_report
-- Returns sales summary and transaction list for a branch+period.
-- Validates investor access before returning data.
-- ─────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION investor_get_sales_report(
  p_user_id       BIGINT,
  p_branch_id     BIGINT,
  p_date_from     DATE,
  p_date_to       DATE,
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
  -- Validate access
  SELECT investor_can_access_branch(p_user_id, p_branch_id) INTO v_has_access;
  IF NOT v_has_access THEN
    RAISE EXCEPTION 'Akses ditolak: cabang tidak dalam izin investor';
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
          b.name  AS branch_name,
          u.name  AS staff_name
        FROM transactions tx
        LEFT JOIN branches b ON b.id = tx.branch_id
        LEFT JOIN users    u ON u.id = tx.staff_id
        WHERE tx.branch_id = p_branch_id
          AND tx.created_at >= (p_date_from || 'T00:00:00')::TIMESTAMPTZ
          AND tx.created_at <= (p_date_to   || 'T23:59:59')::TIMESTAMPTZ
          AND (p_payment_method IS NULL OR tx.payment_method = p_payment_method)
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
          AND tx.status IN ('void', 'voided')
      ) t
    ), '[]'::json),
    'totalRevenue',  COALESCE((
      SELECT SUM(tx.total)
      FROM transactions tx
      WHERE tx.branch_id = p_branch_id
        AND tx.created_at >= (p_date_from || 'T00:00:00')::TIMESTAMPTZ
        AND tx.created_at <= (p_date_to   || 'T23:59:59')::TIMESTAMPTZ
        AND tx.status = 'completed'
    ), 0),
    'totalDiscount', COALESCE((
      SELECT SUM(tx.discount_amount)
      FROM transactions tx
      WHERE tx.branch_id = p_branch_id
        AND tx.created_at >= (p_date_from || 'T00:00:00')::TIMESTAMPTZ
        AND tx.created_at <= (p_date_to   || 'T23:59:59')::TIMESTAMPTZ
        AND tx.status = 'completed'
    ), 0),
    'count', COALESCE((
      SELECT COUNT(*)
      FROM transactions tx
      WHERE tx.branch_id = p_branch_id
        AND tx.created_at >= (p_date_from || 'T00:00:00')::TIMESTAMPTZ
        AND tx.created_at <= (p_date_to   || 'T23:59:59')::TIMESTAMPTZ
        AND tx.status = 'completed'
    ), 0),
    'voidCount', COALESCE((
      SELECT COUNT(*)
      FROM transactions tx
      WHERE tx.branch_id = p_branch_id
        AND tx.created_at >= (p_date_from || 'T00:00:00')::TIMESTAMPTZ
        AND tx.created_at <= (p_date_to   || 'T23:59:59')::TIMESTAMPTZ
        AND tx.status IN ('void', 'voided')
    ), 0),
    'voidAmount', COALESCE((
      SELECT SUM(tx.total)
      FROM transactions tx
      WHERE tx.branch_id = p_branch_id
        AND tx.created_at >= (p_date_from || 'T00:00:00')::TIMESTAMPTZ
        AND tx.created_at <= (p_date_to   || 'T23:59:59')::TIMESTAMPTZ
        AND tx.status IN ('void', 'voided')
    ), 0)
  ) INTO v_result;

  RETURN v_result;
END;
$$;

GRANT EXECUTE ON FUNCTION investor_get_sales_report(BIGINT, BIGINT, DATE, DATE, TEXT) TO anon, authenticated;

-- ─────────────────────────────────────────────────────────────────
-- RPC: investor_get_product_performance
-- Returns product sales performance for a branch+period.
-- ─────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION investor_get_product_performance(
  p_user_id   BIGINT,
  p_branch_id BIGINT,
  p_date_from DATE,
  p_date_to   DATE
)
RETURNS JSON
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_has_access BOOLEAN;
BEGIN
  SELECT investor_can_access_branch(p_user_id, p_branch_id) INTO v_has_access;
  IF NOT v_has_access THEN
    RAISE EXCEPTION 'Akses ditolak: cabang tidak dalam izin investor';
  END IF;

  RETURN COALESCE((
    SELECT json_agg(r ORDER BY r.qty DESC)
    FROM (
      SELECT
        ti.product_name AS product,
        ti.variant_name AS variant,
        SUM(ti.quantity)::INT AS qty,
        SUM(ti.subtotal) AS revenue
      FROM transaction_items ti
      JOIN transactions tx ON tx.id = ti.transaction_id
      WHERE tx.branch_id = p_branch_id
        AND tx.status = 'completed'
        AND tx.created_at >= (p_date_from || 'T00:00:00')::TIMESTAMPTZ
        AND tx.created_at <= (p_date_to   || 'T23:59:59')::TIMESTAMPTZ
      GROUP BY ti.product_name, ti.variant_name
    ) r
  ), '[]'::json);
END;
$$;

GRANT EXECUTE ON FUNCTION investor_get_product_performance(BIGINT, BIGINT, DATE, DATE) TO anon, authenticated;

-- ─────────────────────────────────────────────────────────────────
-- RPC: investor_get_inventory_summary
-- Returns current stock levels for a branch on a given date.
-- ─────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION investor_get_inventory_summary(
  p_user_id   BIGINT,
  p_branch_id BIGINT,
  p_date      DATE DEFAULT CURRENT_DATE
)
RETURNS JSON
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_has_access BOOLEAN;
BEGIN
  SELECT investor_can_access_branch(p_user_id, p_branch_id) INTO v_has_access;
  IF NOT v_has_access THEN
    RAISE EXCEPTION 'Akses ditolak: cabang tidak dalam izin investor';
  END IF;

  RETURN COALESCE((
    SELECT json_agg(r ORDER BY r.ingredient_name)
    FROM (
      SELECT
        bi.ingredient_id,
        i.name  AS ingredient_name,
        bi.stock,
        i.unit,
        COALESCE((
          SELECT SUM(ABS(il.qty))
          FROM inventory_logs il
          WHERE il.branch_id     = p_branch_id
            AND il.ingredient_id = bi.ingredient_id
            AND il.type          = 'out'
            AND il.created_at::DATE = p_date
        ), 0) AS used_today,
        (SELECT il2.created_at
         FROM inventory_logs il2
         WHERE il2.branch_id     = p_branch_id
           AND il2.ingredient_id = bi.ingredient_id
         ORDER BY il2.created_at DESC LIMIT 1
        ) AS last_updated
      FROM branch_inventory bi
      JOIN ingredients i ON i.id = bi.ingredient_id
      WHERE bi.branch_id = p_branch_id
    ) r
  ), '[]'::json);
END;
$$;

GRANT EXECUTE ON FUNCTION investor_get_inventory_summary(BIGINT, BIGINT, DATE) TO anon, authenticated;

-- ─────────────────────────────────────────────────────────────────
-- RPC: investor_get_inventory_usage
-- Returns ingredient usage totals for a branch+period.
-- ─────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION investor_get_inventory_usage(
  p_user_id   BIGINT,
  p_branch_id BIGINT,
  p_date_from DATE,
  p_date_to   DATE
)
RETURNS JSON
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_has_access BOOLEAN;
BEGIN
  SELECT investor_can_access_branch(p_user_id, p_branch_id) INTO v_has_access;
  IF NOT v_has_access THEN
    RAISE EXCEPTION 'Akses ditolak: cabang tidak dalam izin investor';
  END IF;

  RETURN COALESCE((
    SELECT json_agg(r ORDER BY r.total_used DESC)
    FROM (
      SELECT
        i.name            AS ingredient_name,
        i.unit,
        SUM(ABS(il.qty))  AS total_used
      FROM inventory_logs il
      JOIN ingredients i ON i.id = il.ingredient_id
      WHERE il.branch_id     = p_branch_id
        AND il.type          = 'out'
        AND il.reference_type = 'transaction'
        AND il.created_at >= (p_date_from || 'T00:00:00')::TIMESTAMPTZ
        AND il.created_at <= (p_date_to   || 'T23:59:59')::TIMESTAMPTZ
      GROUP BY i.name, i.unit
    ) r
  ), '[]'::json);
END;
$$;

GRANT EXECUTE ON FUNCTION investor_get_inventory_usage(BIGINT, BIGINT, DATE, DATE) TO anon, authenticated;
