-- Migration 033: RPC get_ingredient_inventory_logs
-- Mengembalikan riwayat log inventori per-bahan per-cabang,
-- dengan validasi akses server-side:
--   • staff  → hanya boleh lihat cabang sendiri (branch_id harus cocok)
--   • admin  → boleh lihat semua cabang
-- Dipanggil dari tab "Stok Bahan Baku" di POS staff saat bahan diklik.

DROP FUNCTION IF EXISTS get_ingredient_inventory_logs(BIGINT, BIGINT, BIGINT, TIMESTAMPTZ, TIMESTAMPTZ, TEXT, INT, INT);

CREATE OR REPLACE FUNCTION get_ingredient_inventory_logs(
  p_ingredient_id  BIGINT,
  p_branch_id      BIGINT,
  p_user_id        BIGINT,
  p_date_from      TIMESTAMPTZ DEFAULT NULL,
  p_date_to        TIMESTAMPTZ DEFAULT NULL,
  p_type           TEXT        DEFAULT NULL,
  p_limit          INT         DEFAULT 50,
  p_offset         INT         DEFAULT 0
)
RETURNS JSON
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_user_role   TEXT;
  v_user_branch BIGINT;
BEGIN
  -- Validasi: pastikan user ada dan aktif (soft-delete aware)
  SELECT role, branch_id
  INTO   v_user_role, v_user_branch
  FROM   users
  WHERE  id = p_user_id
    AND  deleted_at IS NULL;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Pengguna tidak ditemukan atau sudah dihapus';
  END IF;

  -- Staff hanya boleh lihat data cabangnya sendiri
  IF v_user_role = 'staff' AND v_user_branch IS DISTINCT FROM p_branch_id THEN
    RAISE EXCEPTION 'Akses ditolak: Anda tidak memiliki izin untuk melihat data cabang ini';
  END IF;

  -- Kembalikan log dengan join ke branches, ingredients, users
  RETURN COALESCE(
    (
      SELECT json_agg(r)
      FROM (
        SELECT
          il.id,
          il.created_at,
          il.type,
          il.qty,
          il.stock_before,
          il.stock_after,
          il.reference_type,
          il.reference_id,
          il.notes,
          b.name   AS branch_name,
          ing.name AS ingredient_name,
          ing.unit AS ingredient_unit,
          u.name   AS user_name
        FROM  inventory_logs  il
        JOIN  branches        b   ON b.id   = il.branch_id
        JOIN  ingredients     ing ON ing.id = il.ingredient_id
        LEFT JOIN users       u   ON u.id   = il.created_by
        WHERE il.ingredient_id = p_ingredient_id
          AND il.branch_id     = p_branch_id
          AND (p_date_from IS NULL OR il.created_at >= p_date_from)
          AND (p_date_to   IS NULL OR il.created_at <= p_date_to)
          AND (p_type      IS NULL OR il.type = p_type)
        ORDER BY il.created_at DESC
        LIMIT  LEAST(COALESCE(p_limit, 50), 200)
        OFFSET GREATEST(COALESCE(p_offset, 0), 0)
      ) r
    ),
    '[]'::JSON
  );
END;
$$;

GRANT EXECUTE ON FUNCTION get_ingredient_inventory_logs(BIGINT, BIGINT, BIGINT, TIMESTAMPTZ, TIMESTAMPTZ, TEXT, INT, INT)
  TO authenticated;
