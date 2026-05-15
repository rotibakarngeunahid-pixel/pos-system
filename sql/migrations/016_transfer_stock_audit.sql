-- Migration 016: Create transfer_stock_atomic RPC
-- Ensures every stock transfer creates two inventory_logs entries (transfer_out + transfer_in)
-- with created_by, reference_type='transfer', and auto-generated notes.

DROP FUNCTION IF EXISTS transfer_stock_atomic(BIGINT, BIGINT, BIGINT, NUMERIC, TEXT, BIGINT);

CREATE OR REPLACE FUNCTION transfer_stock_atomic(
  p_from_branch    BIGINT,
  p_to_branch      BIGINT,
  p_ingredient_id  BIGINT,
  p_qty            NUMERIC,
  p_notes          TEXT    DEFAULT NULL,
  p_user_id        BIGINT  DEFAULT NULL
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_from_stock_before  NUMERIC;
  v_from_stock_after   NUMERIC;
  v_to_stock_before    NUMERIC;
  v_to_stock_after     NUMERIC;
  v_from_branch_name   TEXT;
  v_to_branch_name     TEXT;
BEGIN
  -- Validate required params
  IF p_from_branch IS NULL OR p_to_branch IS NULL THEN
    RAISE EXCEPTION 'Cabang asal dan tujuan wajib diisi';
  END IF;

  IF p_from_branch = p_to_branch THEN
    RAISE EXCEPTION 'Cabang asal dan tujuan tidak boleh sama';
  END IF;

  IF p_qty IS NULL OR p_qty <= 0 THEN
    RAISE EXCEPTION 'Jumlah transfer harus lebih dari 0';
  END IF;

  -- Resolve branch names
  SELECT name INTO v_from_branch_name FROM branches WHERE id = p_from_branch;
  SELECT name INTO v_to_branch_name   FROM branches WHERE id = p_to_branch;

  IF v_from_branch_name IS NULL OR v_to_branch_name IS NULL THEN
    RAISE EXCEPTION 'Cabang tidak ditemukan';
  END IF;

  -- Lock & fetch source stock
  SELECT stock INTO v_from_stock_before
  FROM branch_inventory
  WHERE branch_id = p_from_branch AND ingredient_id = p_ingredient_id
  FOR UPDATE;

  IF v_from_stock_before IS NULL THEN
    RAISE EXCEPTION 'Stok cabang asal belum tersedia';
  END IF;

  IF v_from_stock_before < p_qty THEN
    RAISE EXCEPTION 'Stok cabang asal tidak cukup (tersedia: %, dibutuhkan: %)',
      v_from_stock_before, p_qty;
  END IF;

  -- Ensure destination row exists, then lock & fetch
  INSERT INTO branch_inventory (branch_id, ingredient_id, stock)
  VALUES (p_to_branch, p_ingredient_id, 0)
  ON CONFLICT (branch_id, ingredient_id) DO NOTHING;

  SELECT stock INTO v_to_stock_before
  FROM branch_inventory
  WHERE branch_id = p_to_branch AND ingredient_id = p_ingredient_id
  FOR UPDATE;

  -- Calculate new stock levels
  v_from_stock_after := v_from_stock_before - p_qty;
  v_to_stock_after   := v_to_stock_before   + p_qty;

  -- Update stock
  UPDATE branch_inventory
  SET stock = v_from_stock_after
  WHERE branch_id = p_from_branch AND ingredient_id = p_ingredient_id;

  UPDATE branch_inventory
  SET stock = v_to_stock_after
  WHERE branch_id = p_to_branch AND ingredient_id = p_ingredient_id;

  -- Log transfer_out for source branch
  INSERT INTO inventory_logs (
    branch_id, ingredient_id, qty, type,
    stock_before, stock_after,
    reference_type, notes, created_by
  ) VALUES (
    p_from_branch, p_ingredient_id, -p_qty, 'transfer_out',
    v_from_stock_before, v_from_stock_after,
    'transfer',
    CONCAT('Transfer keluar ke ', v_to_branch_name,
           COALESCE('. ' || NULLIF(TRIM(p_notes), ''), '')),
    p_user_id
  );

  -- Log transfer_in for destination branch
  INSERT INTO inventory_logs (
    branch_id, ingredient_id, qty, type,
    stock_before, stock_after,
    reference_type, notes, created_by
  ) VALUES (
    p_to_branch, p_ingredient_id, p_qty, 'transfer_in',
    v_to_stock_before, v_to_stock_after,
    'transfer',
    CONCAT('Transfer masuk dari ', v_from_branch_name,
           COALESCE('. ' || NULLIF(TRIM(p_notes), ''), '')),
    p_user_id
  );
END;
$$;

-- Grant execute to authenticated users (staff and admin via RLS context)
GRANT EXECUTE ON FUNCTION transfer_stock_atomic(BIGINT, BIGINT, BIGINT, NUMERIC, TEXT, BIGINT)
  TO authenticated;
