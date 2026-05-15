-- ═══════════════════════════════════════════════════════════════
-- Migration 018: Copy Branch Menu
-- Enables admin to copy active menu (branch_products + branch_variant_prices)
-- from a source branch to a target branch atomically.
-- ═══════════════════════════════════════════════════════════════

-- ─────────────────────────────────────────────────────────────────
-- 1. Ensure unique constraints exist (defensive — may already exist)
-- ─────────────────────────────────────────────────────────────────

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'branch_products_branch_id_product_id_key'
      AND conrelid = 'public.branch_products'::regclass
  ) THEN
    ALTER TABLE public.branch_products
      ADD CONSTRAINT branch_products_branch_id_product_id_key
      UNIQUE (branch_id, product_id);
  END IF;
EXCEPTION WHEN others THEN NULL;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'branch_variant_prices_branch_id_variant_id_key'
      AND conrelid = 'public.branch_variant_prices'::regclass
  ) THEN
    ALTER TABLE public.branch_variant_prices
      ADD CONSTRAINT branch_variant_prices_branch_id_variant_id_key
      UNIQUE (branch_id, variant_id);
  END IF;
EXCEPTION WHEN others THEN NULL;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'branch_variant_prices_price_non_negative'
      AND conrelid = 'public.branch_variant_prices'::regclass
  ) THEN
    ALTER TABLE public.branch_variant_prices
      ADD CONSTRAINT branch_variant_prices_price_non_negative
      CHECK (price >= 0);
  END IF;
EXCEPTION WHEN others THEN NULL;
END $$;

-- ─────────────────────────────────────────────────────────────────
-- 2. Audit table for copy operations
-- ─────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.branch_menu_copy_logs (
  id               BIGSERIAL PRIMARY KEY,
  source_branch_id BIGINT NOT NULL REFERENCES public.branches(id),
  target_branch_id BIGINT NOT NULL REFERENCES public.branches(id),
  mode             TEXT   NOT NULL CHECK (mode IN ('replace', 'merge')),
  copied_by        BIGINT REFERENCES public.users(id),
  result           JSONB  NOT NULL DEFAULT '{}'::jsonb,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_branch_menu_copy_logs_target
  ON public.branch_menu_copy_logs(target_branch_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_branch_menu_copy_logs_source
  ON public.branch_menu_copy_logs(source_branch_id, created_at DESC);

-- ─────────────────────────────────────────────────────────────────
-- 3. RPC: admin_preview_branch_menu_copy
-- Returns preview stats — read-only, no data changes.
-- ─────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.admin_preview_branch_menu_copy(
  p_source_branch_id BIGINT,
  p_target_branch_id BIGINT,
  p_mode             TEXT
)
RETURNS JSON
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_source_branch        RECORD;
  v_target_branch        RECORD;
  v_source_active        INT;
  v_source_variants      INT;
  v_source_overrides     INT;
  v_target_active        INT;
  v_target_overrides     INT;
  v_products_no_variants INT;
  v_warnings             JSON;
BEGIN
  -- Validate mode
  IF p_mode NOT IN ('replace', 'merge') THEN
    RAISE EXCEPTION 'Mode tidak valid: gunakan replace atau merge';
  END IF;

  -- Validate source and target not same
  IF p_source_branch_id = p_target_branch_id THEN
    RAISE EXCEPTION 'Cabang sumber dan tujuan tidak boleh sama';
  END IF;

  -- Validate source branch exists
  SELECT id, name INTO v_source_branch
  FROM public.branches WHERE id = p_source_branch_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Cabang sumber tidak ditemukan';
  END IF;

  -- Validate target branch exists
  SELECT id, name INTO v_target_branch
  FROM public.branches WHERE id = p_target_branch_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Cabang tujuan tidak ditemukan';
  END IF;

  -- Count source active products
  SELECT COUNT(*) INTO v_source_active
  FROM public.branch_products
  WHERE branch_id = p_source_branch_id AND is_active = TRUE;

  -- Count source variants (from active products)
  SELECT COUNT(*) INTO v_source_variants
  FROM public.product_variants pv
  WHERE pv.product_id IN (
    SELECT product_id FROM public.branch_products
    WHERE branch_id = p_source_branch_id AND is_active = TRUE
  );

  -- Count source overrides
  SELECT COUNT(*) INTO v_source_overrides
  FROM public.branch_variant_prices bvp
  WHERE bvp.branch_id = p_source_branch_id
    AND bvp.variant_id IN (
      SELECT pv.id FROM public.product_variants pv
      WHERE pv.product_id IN (
        SELECT product_id FROM public.branch_products
        WHERE branch_id = p_source_branch_id AND is_active = TRUE
      )
    );

  -- Count target active products
  SELECT COUNT(*) INTO v_target_active
  FROM public.branch_products
  WHERE branch_id = p_target_branch_id AND is_active = TRUE;

  -- Count target overrides
  SELECT COUNT(*) INTO v_target_overrides
  FROM public.branch_variant_prices
  WHERE branch_id = p_target_branch_id;

  -- Count active source products without any variants
  SELECT COUNT(*) INTO v_products_no_variants
  FROM public.branch_products bp
  WHERE bp.branch_id = p_source_branch_id
    AND bp.is_active = TRUE
    AND NOT EXISTS (
      SELECT 1 FROM public.product_variants pv
      WHERE pv.product_id = bp.product_id
    );

  -- Build warnings array
  IF v_products_no_variants > 0 THEN
    v_warnings := json_build_array(
      json_build_object(
        'type', 'no_variants',
        'message', v_products_no_variants || ' produk aktif di sumber tidak memiliki varian dan tidak akan tampil di POS'
      )
    );
  ELSE
    v_warnings := '[]'::json;
  END IF;

  RETURN json_build_object(
    'source_branch',            json_build_object('id', v_source_branch.id, 'name', v_source_branch.name),
    'target_branch',            json_build_object('id', v_target_branch.id, 'name', v_target_branch.name),
    'mode',                     p_mode,
    'source_active_products',   v_source_active,
    'source_variants',          v_source_variants,
    'source_overrides',         v_source_overrides,
    'target_active_products',   v_target_active,
    'target_overrides',         v_target_overrides,
    'products_without_variants',v_products_no_variants,
    'warnings',                 v_warnings
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.admin_preview_branch_menu_copy(BIGINT, BIGINT, TEXT)
  TO anon, authenticated;

-- ─────────────────────────────────────────────────────────────────
-- 4. RPC: admin_copy_branch_menu
-- Atomically copies active menu from source to target branch.
-- ─────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.admin_copy_branch_menu(
  p_source_branch_id BIGINT,
  p_target_branch_id BIGINT,
  p_mode             TEXT,
  p_admin_id         BIGINT
)
RETURNS JSON
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_admin_role         TEXT;
  v_source_active      INT;
  v_products_activated INT := 0;
  v_products_deactivated INT := 0;
  v_overrides_deleted  INT := 0;
  v_overrides_inserted INT := 0;
  v_products_no_variants INT := 0;
  v_result             JSON;
BEGIN
  -- Advisory lock on target branch to prevent concurrent copy
  PERFORM pg_advisory_xact_lock(9871001, p_target_branch_id::integer);

  -- Validate mode
  IF p_mode NOT IN ('replace', 'merge') THEN
    RAISE EXCEPTION 'Mode tidak valid: gunakan replace atau merge';
  END IF;

  -- Validate admin role
  SELECT role INTO v_admin_role FROM public.users WHERE id = p_admin_id;
  IF v_admin_role IS DISTINCT FROM 'admin' THEN
    RAISE EXCEPTION 'Akses ditolak: hanya admin yang dapat menjalankan copy menu';
  END IF;

  -- Validate source != target
  IF p_source_branch_id = p_target_branch_id THEN
    RAISE EXCEPTION 'Cabang sumber dan tujuan tidak boleh sama';
  END IF;

  -- Validate source branch exists
  IF NOT EXISTS (SELECT 1 FROM public.branches WHERE id = p_source_branch_id) THEN
    RAISE EXCEPTION 'Cabang sumber tidak ditemukan';
  END IF;

  -- Validate target branch exists
  IF NOT EXISTS (SELECT 1 FROM public.branches WHERE id = p_target_branch_id) THEN
    RAISE EXCEPTION 'Cabang tujuan tidak ditemukan';
  END IF;

  -- Validate source has active products
  SELECT COUNT(*) INTO v_source_active
  FROM public.branch_products
  WHERE branch_id = p_source_branch_id AND is_active = TRUE;

  IF v_source_active = 0 THEN
    RAISE EXCEPTION 'Cabang sumber belum memiliki menu aktif';
  END IF;

  -- Count source products without variants (for reporting)
  SELECT COUNT(*) INTO v_products_no_variants
  FROM public.branch_products bp
  WHERE bp.branch_id = p_source_branch_id
    AND bp.is_active = TRUE
    AND NOT EXISTS (
      SELECT 1 FROM public.product_variants pv
      WHERE pv.product_id = bp.product_id
    );

  -- ── REPLACE MODE ──────────────────────────────────────────────
  IF p_mode = 'replace' THEN

    -- Count current active target products (for result reporting)
    SELECT COUNT(*) INTO v_products_deactivated
    FROM public.branch_products
    WHERE branch_id = p_target_branch_id AND is_active = TRUE;

    -- Deactivate all target products
    UPDATE public.branch_products
    SET is_active = FALSE
    WHERE branch_id = p_target_branch_id;

    -- Delete all target overrides
    DELETE FROM public.branch_variant_prices
    WHERE branch_id = p_target_branch_id;
    GET DIAGNOSTICS v_overrides_deleted = ROW_COUNT;

    -- Upsert source active products into target
    INSERT INTO public.branch_products (branch_id, product_id, is_active)
    SELECT p_target_branch_id, bp.product_id, TRUE
    FROM public.branch_products bp
    WHERE bp.branch_id = p_source_branch_id AND bp.is_active = TRUE
    ON CONFLICT (branch_id, product_id)
      DO UPDATE SET is_active = TRUE;
    GET DIAGNOSTICS v_products_activated = ROW_COUNT;

    -- Insert source overrides into target (only for source-active variants)
    INSERT INTO public.branch_variant_prices (branch_id, variant_id, price)
    SELECT p_target_branch_id, bvp.variant_id, bvp.price
    FROM public.branch_variant_prices bvp
    JOIN public.product_variants pv ON pv.id = bvp.variant_id
    WHERE bvp.branch_id = p_source_branch_id
      AND pv.product_id IN (
        SELECT product_id FROM public.branch_products
        WHERE branch_id = p_source_branch_id AND is_active = TRUE
      )
    ON CONFLICT (branch_id, variant_id)
      DO UPDATE SET price = EXCLUDED.price;
    GET DIAGNOSTICS v_overrides_inserted = ROW_COUNT;

  -- ── MERGE MODE ────────────────────────────────────────────────
  ELSIF p_mode = 'merge' THEN

    -- Upsert source active products into target (activate them)
    INSERT INTO public.branch_products (branch_id, product_id, is_active)
    SELECT p_target_branch_id, bp.product_id, TRUE
    FROM public.branch_products bp
    WHERE bp.branch_id = p_source_branch_id AND bp.is_active = TRUE
    ON CONFLICT (branch_id, product_id)
      DO UPDATE SET is_active = TRUE;
    GET DIAGNOSTICS v_products_activated = ROW_COUNT;

    -- Delete target overrides only for variants belonging to source active products
    DELETE FROM public.branch_variant_prices
    WHERE branch_id = p_target_branch_id
      AND variant_id IN (
        SELECT pv.id
        FROM public.product_variants pv
        WHERE pv.product_id IN (
          SELECT product_id FROM public.branch_products
          WHERE branch_id = p_source_branch_id AND is_active = TRUE
        )
      );
    GET DIAGNOSTICS v_overrides_deleted = ROW_COUNT;

    -- Insert source overrides for source active products' variants
    INSERT INTO public.branch_variant_prices (branch_id, variant_id, price)
    SELECT p_target_branch_id, bvp.variant_id, bvp.price
    FROM public.branch_variant_prices bvp
    JOIN public.product_variants pv ON pv.id = bvp.variant_id
    WHERE bvp.branch_id = p_source_branch_id
      AND pv.product_id IN (
        SELECT product_id FROM public.branch_products
        WHERE branch_id = p_source_branch_id AND is_active = TRUE
      )
    ON CONFLICT (branch_id, variant_id)
      DO UPDATE SET price = EXCLUDED.price;
    GET DIAGNOSTICS v_overrides_inserted = ROW_COUNT;

  END IF;

  -- Build result JSON
  v_result := json_build_object(
    'ok',                      TRUE,
    'mode',                    p_mode,
    'source_branch_id',        p_source_branch_id,
    'target_branch_id',        p_target_branch_id,
    'products_activated',      v_products_activated,
    'products_deactivated',    v_products_deactivated,
    'target_overrides_deleted',v_overrides_deleted,
    'target_overrides_inserted',v_overrides_inserted,
    'products_without_variants',v_products_no_variants
  );

  -- Write audit log
  INSERT INTO public.branch_menu_copy_logs
    (source_branch_id, target_branch_id, mode, copied_by, result)
  VALUES
    (p_source_branch_id, p_target_branch_id, p_mode, p_admin_id, v_result::jsonb);

  RETURN v_result;
END;
$$;

GRANT EXECUTE ON FUNCTION public.admin_copy_branch_menu(BIGINT, BIGINT, TEXT, BIGINT)
  TO anon, authenticated;
