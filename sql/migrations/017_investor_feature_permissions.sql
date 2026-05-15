-- ═══════════════════════════════════════════════════════════════
-- Migration 017: Investor Feature Permissions
-- Adds granular module-level access control for investor accounts.
-- Admin can now control which data modules each investor can view.
-- ═══════════════════════════════════════════════════════════════

-- 1. Create investor_feature_access table
CREATE TABLE IF NOT EXISTS investor_feature_access (
  user_id     BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  feature_key TEXT NOT NULL,
  allowed     BOOLEAN NOT NULL DEFAULT FALSE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by  BIGINT REFERENCES users(id),
  updated_by  BIGINT REFERENCES users(id),
  PRIMARY KEY (user_id, feature_key),
  CONSTRAINT investor_feature_access_key_check CHECK (
    feature_key IN ('sales', 'products', 'inventory_stock', 'inventory_usage')
  )
);

CREATE INDEX IF NOT EXISTS idx_investor_feature_access_user
  ON investor_feature_access(user_id);

-- 2. Backfill existing investors: grant all MVP permissions so existing access is not broken
INSERT INTO investor_feature_access (user_id, feature_key, allowed)
SELECT u.id, f.feature_key, TRUE
FROM users u
CROSS JOIN (
  VALUES
    ('sales'),
    ('products'),
    ('inventory_stock'),
    ('inventory_usage')
) AS f(feature_key)
WHERE u.role = 'investor'
ON CONFLICT (user_id, feature_key) DO NOTHING;

-- ─────────────────────────────────────────────────────────────────
-- RPC: investor_get_access_config
-- Returns allowed branches and active feature keys for an investor.
-- ─────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION investor_get_access_config(p_user_id BIGINT)
RETURNS JSON
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_branches JSON;
  v_features JSON;
BEGIN
  SELECT json_agg(
    json_build_object('branch_id', b.id, 'branch_name', b.name, 'address', b.address)
    ORDER BY b.name
  )
  INTO v_branches
  FROM investor_branch_access iba
  JOIN branches b ON b.id = iba.branch_id
  JOIN users u ON u.id = iba.user_id
  WHERE iba.user_id = p_user_id AND u.role = 'investor';

  SELECT json_agg(feature_key ORDER BY feature_key)
  INTO v_features
  FROM investor_feature_access
  WHERE user_id = p_user_id AND allowed = TRUE;

  RETURN json_build_object(
    'branches', COALESCE(v_branches, '[]'::json),
    'features', COALESCE(v_features, '[]'::json)
  );
END;
$$;

GRANT EXECUTE ON FUNCTION investor_get_access_config(BIGINT) TO anon, authenticated;

-- ─────────────────────────────────────────────────────────────────
-- RPC: investor_can_access_feature
-- Returns TRUE only if investor has branch access AND feature access.
-- Used internally by data RPCs to enforce server-side permission.
-- ─────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION investor_can_access_feature(
  p_user_id     BIGINT,
  p_branch_id   BIGINT,
  p_feature_key TEXT
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  RETURN
    EXISTS (
      SELECT 1
      FROM investor_branch_access iba
      JOIN users u ON u.id = iba.user_id
      WHERE iba.user_id   = p_user_id
        AND iba.branch_id = p_branch_id
        AND u.role        = 'investor'
    )
    AND
    EXISTS (
      SELECT 1
      FROM investor_feature_access ifa
      WHERE ifa.user_id     = p_user_id
        AND ifa.feature_key = p_feature_key
        AND ifa.allowed     = TRUE
    );
END;
$$;

GRANT EXECUTE ON FUNCTION investor_can_access_feature(BIGINT, BIGINT, TEXT) TO anon, authenticated;

-- ─────────────────────────────────────────────────────────────────
-- RPC: admin_save_investor_access
-- Saves branch access and feature access in one atomic transaction.
-- Validates that caller is admin and target is investor.
-- ─────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION admin_save_investor_access(
  p_admin_id   BIGINT,
  p_user_id    BIGINT,
  p_branch_ids BIGINT[],
  p_features   TEXT[]
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_admin_role    TEXT;
  v_investor_role TEXT;
BEGIN
  SELECT role INTO v_admin_role FROM users WHERE id = p_admin_id;
  IF v_admin_role IS DISTINCT FROM 'admin' THEN
    RAISE EXCEPTION 'Akses ditolak: hanya admin yang dapat mengatur akses investor';
  END IF;

  SELECT role INTO v_investor_role FROM users WHERE id = p_user_id;
  IF v_investor_role IS DISTINCT FROM 'investor' THEN
    RAISE EXCEPTION 'Target bukan akun investor';
  END IF;

  -- Update branch access
  DELETE FROM investor_branch_access WHERE user_id = p_user_id;
  IF array_length(p_branch_ids, 1) > 0 THEN
    INSERT INTO investor_branch_access (user_id, branch_id, created_by)
    SELECT p_user_id, unnest(p_branch_ids), p_admin_id;
  END IF;

  -- Upsert all 4 feature flags
  INSERT INTO investor_feature_access (user_id, feature_key, allowed, updated_at, updated_by)
  SELECT
    p_user_id,
    f.fk,
    (p_features IS NOT NULL AND f.fk = ANY(p_features)),
    NOW(),
    p_admin_id
  FROM (VALUES ('sales'), ('products'), ('inventory_stock'), ('inventory_usage')) AS f(fk)
  ON CONFLICT (user_id, feature_key) DO UPDATE
    SET allowed    = EXCLUDED.allowed,
        updated_at = NOW(),
        updated_by = p_admin_id;
END;
$$;

GRANT EXECUTE ON FUNCTION admin_save_investor_access(BIGINT, BIGINT, BIGINT[], TEXT[]) TO anon, authenticated;

-- ─────────────────────────────────────────────────────────────────
-- Update RPC: investor_get_sales_report
-- Now validates 'sales' feature permission in addition to branch.
-- ─────────────────────────────────────────────────────────────────
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
    'totalRevenue', COALESCE((
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
-- Update RPC: investor_get_product_performance
-- Now validates 'products' feature permission.
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
  SELECT investor_can_access_feature(p_user_id, p_branch_id, 'products') INTO v_has_access;
  IF NOT v_has_access THEN
    RAISE EXCEPTION 'Akses ditolak: investor tidak memiliki izin fitur ini';
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
-- Update RPC: investor_get_inventory_summary
-- Now validates 'inventory_stock' feature permission.
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
  SELECT investor_can_access_feature(p_user_id, p_branch_id, 'inventory_stock') INTO v_has_access;
  IF NOT v_has_access THEN
    RAISE EXCEPTION 'Akses ditolak: investor tidak memiliki izin fitur ini';
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
-- Update RPC: investor_get_inventory_usage
-- Now validates 'inventory_usage' feature permission.
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
  SELECT investor_can_access_feature(p_user_id, p_branch_id, 'inventory_usage') INTO v_has_access;
  IF NOT v_has_access THEN
    RAISE EXCEPTION 'Akses ditolak: investor tidak memiliki izin fitur ini';
  END IF;

  RETURN COALESCE((
    SELECT json_agg(r ORDER BY r.total_used DESC)
    FROM (
      SELECT
        i.name           AS ingredient_name,
        i.unit,
        SUM(ABS(il.qty)) AS total_used
      FROM inventory_logs il
      JOIN ingredients i ON i.id = il.ingredient_id
      WHERE il.branch_id      = p_branch_id
        AND il.type           = 'out'
        AND il.reference_type = 'transaction'
        AND il.created_at >= (p_date_from || 'T00:00:00')::TIMESTAMPTZ
        AND il.created_at <= (p_date_to   || 'T23:59:59')::TIMESTAMPTZ
      GROUP BY i.name, i.unit
    ) r
  ), '[]'::json);
END;
$$;

GRANT EXECUTE ON FUNCTION investor_get_inventory_usage(BIGINT, BIGINT, DATE, DATE) TO anon, authenticated;
