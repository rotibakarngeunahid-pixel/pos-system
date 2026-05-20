-- ══════════════════════════════════════════════════════════════
-- Migration 040: Stock Transfer v2 — Alur Konfirmasi Antar Outlet
-- Jalankan di Supabase Dashboard → SQL Editor → Run
-- ══════════════════════════════════════════════════════════════
--
-- Menggantikan alur transfer langsung (transfer_stock_atomic) dengan
-- alur berbasis konfirmasi:
--   1. Outlet pengirim buat transfer → stok pengirim berkurang
--   2. Status = 'pending' sampai outlet penerima konfirmasi
--   3. Outlet penerima klik Terima → stok penerima bertambah, status = 'confirmed'
--   4. Outlet penerima bisa Tolak → stok dikembalikan ke pengirim, status = 'rejected'
--   5. Pengirim bisa Batalkan sebelum diterima → stok kembali, status = 'cancelled'
--
-- Data transfer lama (dari transfer_stock_atomic) TIDAK tersentuh.
-- Fungsi transfer_stock_atomic tetap ada untuk kompatibilitas.
-- ══════════════════════════════════════════════════════════════

-- ── Tabel utama transfer antar outlet ─────────────────────────
CREATE TABLE IF NOT EXISTS stock_transfers (
  id               BIGSERIAL PRIMARY KEY,
  transfer_code    TEXT UNIQUE NOT NULL,
  from_branch_id   BIGINT NOT NULL REFERENCES branches(id),
  to_branch_id     BIGINT NOT NULL REFERENCES branches(id),
  status           TEXT NOT NULL DEFAULT 'pending'
                     CHECK (status IN ('pending','confirmed','rejected','cancelled')),
  notes            TEXT,
  created_by       BIGINT NOT NULL REFERENCES users(id),
  confirmed_by     BIGINT REFERENCES users(id),
  confirmed_at     TIMESTAMPTZ,
  rejected_by      BIGINT REFERENCES users(id),
  rejected_at      TIMESTAMPTZ,
  rejection_reason TEXT,
  cancelled_by     BIGINT REFERENCES users(id),
  cancelled_at     TIMESTAMPTZ,
  created_at       TIMESTAMPTZ DEFAULT NOW()
);

-- ── Item-item dalam satu transfer (support multi-bahan) ────────
CREATE TABLE IF NOT EXISTS stock_transfer_items (
  id            BIGSERIAL PRIMARY KEY,
  transfer_id   BIGINT NOT NULL REFERENCES stock_transfers(id) ON DELETE CASCADE,
  ingredient_id BIGINT NOT NULL REFERENCES ingredients(id),
  qty           NUMERIC NOT NULL CHECK (qty > 0)
);

-- ── Index untuk performa query ─────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_stock_transfers_from  ON stock_transfers(from_branch_id);
CREATE INDEX IF NOT EXISTS idx_stock_transfers_to    ON stock_transfers(to_branch_id);
CREATE INDEX IF NOT EXISTS idx_stock_transfers_status ON stock_transfers(status);
CREATE INDEX IF NOT EXISTS idx_sti_transfer_id       ON stock_transfer_items(transfer_id);

-- ── Grant akses tabel ──────────────────────────────────────────
GRANT SELECT, INSERT, UPDATE ON stock_transfers      TO authenticated;
GRANT SELECT, INSERT         ON stock_transfer_items TO authenticated;
GRANT USAGE, SELECT ON SEQUENCE stock_transfers_id_seq      TO authenticated;
GRANT USAGE, SELECT ON SEQUENCE stock_transfer_items_id_seq TO authenticated;

-- ══════════════════════════════════════════════════════════════
-- FUNGSI PEMBANTU: generate_transfer_code
-- Format: TRF-YYYYMMDD-NNN (contoh: TRF-20260520-001)
-- ══════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION generate_transfer_code()
RETURNS TEXT
LANGUAGE plpgsql AS $$
DECLARE
  v_date TEXT;
  v_seq  INTEGER;
BEGIN
  v_date := TO_CHAR(NOW() AT TIME ZONE 'Asia/Jakarta', 'YYYYMMDD');
  SELECT COUNT(*) + 1 INTO v_seq
  FROM stock_transfers
  WHERE TO_CHAR(created_at AT TIME ZONE 'Asia/Jakarta', 'YYYYMMDD') = v_date;
  RETURN 'TRF-' || v_date || '-' || LPAD(v_seq::TEXT, 3, '0');
END;
$$;

-- ══════════════════════════════════════════════════════════════
-- RPC: create_stock_transfer
-- Dipanggil oleh outlet pengirim.
-- Validasi stok → kurangi stok pengirim → buat record + items → status pending
-- ══════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION create_stock_transfer(
  p_from_branch_id BIGINT,
  p_to_branch_id   BIGINT,
  p_items          JSONB,   -- [{ingredient_id, qty}, ...]
  p_notes          TEXT,
  p_user_id        BIGINT
)
RETURNS JSONB
SECURITY DEFINER
SET search_path = public
LANGUAGE plpgsql AS $$
DECLARE
  v_transfer_id    BIGINT;
  v_transfer_code  TEXT;
  v_item           JSONB;
  v_ingredient_id  BIGINT;
  v_qty            NUMERIC;
  v_current_stock  NUMERIC;
  v_ingredient_name TEXT;
  v_to_branch_name  TEXT;
BEGIN
  -- ── Validasi dasar ──────────────────────────────────────────
  IF p_from_branch_id = p_to_branch_id THEN
    RETURN jsonb_build_object('success', false, 'error', 'Outlet asal dan tujuan tidak boleh sama.');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM branches WHERE id = p_from_branch_id AND is_active = true) THEN
    RETURN jsonb_build_object('success', false, 'error', 'Outlet asal tidak ditemukan atau tidak aktif.');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM branches WHERE id = p_to_branch_id AND is_active = true) THEN
    RETURN jsonb_build_object('success', false, 'error', 'Outlet tujuan tidak ditemukan atau tidak aktif.');
  END IF;
  IF p_items IS NULL OR jsonb_array_length(p_items) = 0 THEN
    RETURN jsonb_build_object('success', false, 'error', 'Tidak ada bahan yang dipilih untuk dikirim.');
  END IF;

  SELECT name INTO v_to_branch_name FROM branches WHERE id = p_to_branch_id;

  -- ── Validasi stok semua item SEBELUM mutasi apapun ─────────
  FOR v_item IN SELECT * FROM jsonb_array_elements(p_items) LOOP
    v_ingredient_id := (v_item->>'ingredient_id')::BIGINT;
    v_qty           := (v_item->>'qty')::NUMERIC;

    IF v_qty IS NULL OR v_qty <= 0 THEN
      SELECT name INTO v_ingredient_name FROM ingredients WHERE id = v_ingredient_id;
      RETURN jsonb_build_object('success', false, 'error',
        'Jumlah tidak valid untuk bahan: ' || COALESCE(v_ingredient_name, '?'));
    END IF;

    SELECT COALESCE(bi.stock, 0) INTO v_current_stock
    FROM branch_inventory bi
    WHERE bi.branch_id = p_from_branch_id AND bi.ingredient_id = v_ingredient_id
    FOR UPDATE;

    IF NOT FOUND OR v_current_stock < v_qty THEN
      SELECT name INTO v_ingredient_name FROM ingredients WHERE id = v_ingredient_id;
      RETURN jsonb_build_object('success', false, 'error',
        'Stok ' || COALESCE(v_ingredient_name, '?') || ' tidak cukup. '
        || 'Tersedia: ' || COALESCE(v_current_stock, 0)::TEXT);
    END IF;
  END LOOP;

  -- ── Buat record transfer ────────────────────────────────────
  v_transfer_code := generate_transfer_code();
  INSERT INTO stock_transfers (transfer_code, from_branch_id, to_branch_id, status, notes, created_by)
  VALUES (v_transfer_code, p_from_branch_id, p_to_branch_id, 'pending', p_notes, p_user_id)
  RETURNING id INTO v_transfer_id;

  -- ── Proses tiap item: kurangi stok + catat log ──────────────
  FOR v_item IN SELECT * FROM jsonb_array_elements(p_items) LOOP
    v_ingredient_id := (v_item->>'ingredient_id')::BIGINT;
    v_qty           := (v_item->>'qty')::NUMERIC;

    INSERT INTO stock_transfer_items (transfer_id, ingredient_id, qty)
    VALUES (v_transfer_id, v_ingredient_id, v_qty);

    SELECT COALESCE(bi.stock, 0) INTO v_current_stock
    FROM branch_inventory bi
    WHERE bi.branch_id = p_from_branch_id AND bi.ingredient_id = v_ingredient_id;

    UPDATE branch_inventory
    SET stock = stock - v_qty
    WHERE branch_id = p_from_branch_id AND ingredient_id = v_ingredient_id;

    INSERT INTO inventory_logs
      (branch_id, ingredient_id, qty, type, stock_before, stock_after,
       reference_type, reference_id, notes, created_by)
    VALUES (
      p_from_branch_id, v_ingredient_id, -v_qty, 'transfer_out',
      v_current_stock, v_current_stock - v_qty,
      'transfer', v_transfer_id,
      'Dikirim ke ' || v_to_branch_name || ' [' || v_transfer_code || '] — menunggu konfirmasi',
      p_user_id
    );
  END LOOP;

  RETURN jsonb_build_object(
    'success',       true,
    'transfer_id',   v_transfer_id,
    'transfer_code', v_transfer_code
  );

EXCEPTION WHEN OTHERS THEN
  RETURN jsonb_build_object('success', false, 'error', 'Terjadi kesalahan server: ' || SQLERRM);
END;
$$;

-- ══════════════════════════════════════════════════════════════
-- RPC: confirm_stock_transfer
-- Outlet penerima menerima barang → stok penerima bertambah, status = confirmed
-- Anti-duplikasi: locked FOR UPDATE sebelum cek status
-- ══════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION confirm_stock_transfer(
  p_transfer_id BIGINT,
  p_user_id     BIGINT
)
RETURNS JSONB
SECURITY DEFINER
SET search_path = public
LANGUAGE plpgsql AS $$
DECLARE
  v_transfer      RECORD;
  v_item          RECORD;
  v_current_stock NUMERIC;
  v_from_name     TEXT;
BEGIN
  SELECT * INTO v_transfer FROM stock_transfers WHERE id = p_transfer_id FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'Transfer tidak ditemukan.');
  END IF;
  IF v_transfer.status = 'confirmed' THEN
    RETURN jsonb_build_object('success', false, 'error', 'Transfer ini sudah diterima sebelumnya.');
  END IF;
  IF v_transfer.status != 'pending' THEN
    RETURN jsonb_build_object('success', false, 'error',
      'Transfer tidak bisa diproses, status saat ini: ' || v_transfer.status || '.');
  END IF;

  SELECT name INTO v_from_name FROM branches WHERE id = v_transfer.from_branch_id;

  -- ── Tambah stok ke outlet penerima ──────────────────────────
  FOR v_item IN
    SELECT sti.ingredient_id, sti.qty
    FROM stock_transfer_items sti
    WHERE sti.transfer_id = p_transfer_id
  LOOP
    INSERT INTO branch_inventory (branch_id, ingredient_id, stock)
    VALUES (v_transfer.to_branch_id, v_item.ingredient_id, 0)
    ON CONFLICT (branch_id, ingredient_id) DO NOTHING;

    SELECT COALESCE(stock, 0) INTO v_current_stock
    FROM branch_inventory
    WHERE branch_id = v_transfer.to_branch_id AND ingredient_id = v_item.ingredient_id;

    UPDATE branch_inventory
    SET stock = stock + v_item.qty
    WHERE branch_id = v_transfer.to_branch_id AND ingredient_id = v_item.ingredient_id;

    INSERT INTO inventory_logs
      (branch_id, ingredient_id, qty, type, stock_before, stock_after,
       reference_type, reference_id, notes, created_by)
    VALUES (
      v_transfer.to_branch_id, v_item.ingredient_id, v_item.qty, 'transfer_in',
      v_current_stock, v_current_stock + v_item.qty,
      'transfer', p_transfer_id,
      'Diterima dari ' || v_from_name || ' [' || v_transfer.transfer_code || ']',
      p_user_id
    );
  END LOOP;

  UPDATE stock_transfers
  SET status = 'confirmed', confirmed_by = p_user_id, confirmed_at = NOW()
  WHERE id = p_transfer_id;

  RETURN jsonb_build_object('success', true, 'transfer_code', v_transfer.transfer_code);

EXCEPTION WHEN OTHERS THEN
  RETURN jsonb_build_object('success', false, 'error', 'Terjadi kesalahan server: ' || SQLERRM);
END;
$$;

-- ══════════════════════════════════════════════════════════════
-- RPC: reject_stock_transfer
-- Outlet penerima menolak → stok dikembalikan ke pengirim, status = rejected
-- ══════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION reject_stock_transfer(
  p_transfer_id BIGINT,
  p_user_id     BIGINT,
  p_reason      TEXT
)
RETURNS JSONB
SECURITY DEFINER
SET search_path = public
LANGUAGE plpgsql AS $$
DECLARE
  v_transfer      RECORD;
  v_item          RECORD;
  v_current_stock NUMERIC;
  v_to_name       TEXT;
BEGIN
  SELECT * INTO v_transfer FROM stock_transfers WHERE id = p_transfer_id FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'Transfer tidak ditemukan.');
  END IF;
  IF v_transfer.status != 'pending' THEN
    RETURN jsonb_build_object('success', false, 'error',
      'Hanya transfer dengan status "Menunggu" yang dapat ditolak.');
  END IF;

  SELECT name INTO v_to_name FROM branches WHERE id = v_transfer.to_branch_id;

  -- ── Kembalikan stok ke outlet pengirim ──────────────────────
  FOR v_item IN
    SELECT sti.ingredient_id, sti.qty
    FROM stock_transfer_items sti
    WHERE sti.transfer_id = p_transfer_id
  LOOP
    SELECT COALESCE(stock, 0) INTO v_current_stock
    FROM branch_inventory
    WHERE branch_id = v_transfer.from_branch_id AND ingredient_id = v_item.ingredient_id;

    UPDATE branch_inventory
    SET stock = stock + v_item.qty
    WHERE branch_id = v_transfer.from_branch_id AND ingredient_id = v_item.ingredient_id;

    INSERT INTO inventory_logs
      (branch_id, ingredient_id, qty, type, stock_before, stock_after,
       reference_type, reference_id, notes, created_by)
    VALUES (
      v_transfer.from_branch_id, v_item.ingredient_id, v_item.qty, 'transfer_in',
      v_current_stock, v_current_stock + v_item.qty,
      'transfer', p_transfer_id,
      'Stok kembali — ditolak oleh ' || v_to_name || ' [' || v_transfer.transfer_code || ']'
        || CASE WHEN p_reason IS NOT NULL AND TRIM(p_reason) != ''
               THEN '. Alasan: ' || p_reason ELSE '' END,
      p_user_id
    );
  END LOOP;

  UPDATE stock_transfers
  SET status = 'rejected', rejected_by = p_user_id, rejected_at = NOW(),
      rejection_reason = p_reason
  WHERE id = p_transfer_id;

  RETURN jsonb_build_object('success', true, 'transfer_code', v_transfer.transfer_code);

EXCEPTION WHEN OTHERS THEN
  RETURN jsonb_build_object('success', false, 'error', 'Terjadi kesalahan server: ' || SQLERRM);
END;
$$;

-- ══════════════════════════════════════════════════════════════
-- RPC: cancel_stock_transfer
-- Outlet pengirim membatalkan sebelum diterima → stok kembali, status = cancelled
-- ══════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION cancel_stock_transfer(
  p_transfer_id BIGINT,
  p_user_id     BIGINT
)
RETURNS JSONB
SECURITY DEFINER
SET search_path = public
LANGUAGE plpgsql AS $$
DECLARE
  v_transfer      RECORD;
  v_item          RECORD;
  v_current_stock NUMERIC;
BEGIN
  SELECT * INTO v_transfer FROM stock_transfers WHERE id = p_transfer_id FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'Transfer tidak ditemukan.');
  END IF;
  IF v_transfer.status != 'pending' THEN
    RETURN jsonb_build_object('success', false, 'error',
      'Hanya transfer dengan status "Menunggu" yang dapat dibatalkan.');
  END IF;

  -- ── Kembalikan stok ke outlet pengirim ──────────────────────
  FOR v_item IN
    SELECT sti.ingredient_id, sti.qty
    FROM stock_transfer_items sti
    WHERE sti.transfer_id = p_transfer_id
  LOOP
    SELECT COALESCE(stock, 0) INTO v_current_stock
    FROM branch_inventory
    WHERE branch_id = v_transfer.from_branch_id AND ingredient_id = v_item.ingredient_id;

    UPDATE branch_inventory
    SET stock = stock + v_item.qty
    WHERE branch_id = v_transfer.from_branch_id AND ingredient_id = v_item.ingredient_id;

    INSERT INTO inventory_logs
      (branch_id, ingredient_id, qty, type, stock_before, stock_after,
       reference_type, reference_id, notes, created_by)
    VALUES (
      v_transfer.from_branch_id, v_item.ingredient_id, v_item.qty, 'transfer_in',
      v_current_stock, v_current_stock + v_item.qty,
      'transfer', p_transfer_id,
      'Stok kembali — transfer dibatalkan [' || v_transfer.transfer_code || ']',
      p_user_id
    );
  END LOOP;

  UPDATE stock_transfers
  SET status = 'cancelled', cancelled_by = p_user_id, cancelled_at = NOW()
  WHERE id = p_transfer_id;

  RETURN jsonb_build_object('success', true, 'transfer_code', v_transfer.transfer_code);

EXCEPTION WHEN OTHERS THEN
  RETURN jsonb_build_object('success', false, 'error', 'Terjadi kesalahan server: ' || SQLERRM);
END;
$$;

-- ══════════════════════════════════════════════════════════════
-- RPC: get_pending_transfers
-- Transfer masuk yang menunggu konfirmasi untuk satu outlet (penerima)
-- ══════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION get_pending_transfers(p_branch_id BIGINT)
RETURNS JSONB
SECURITY DEFINER
SET search_path = public
LANGUAGE plpgsql AS $$
BEGIN
  RETURN COALESCE(
    (SELECT jsonb_agg(t ORDER BY t.created_at DESC)
     FROM (
       SELECT
         st.id,
         st.transfer_code,
         st.status,
         st.notes,
         st.created_at,
         fb.name AS from_branch_name,
         tb.name AS to_branch_name,
         u.name  AS created_by_name,
         (SELECT jsonb_agg(jsonb_build_object(
            'ingredient_id',   sti.ingredient_id,
            'ingredient_name', i.name,
            'unit',            i.unit,
            'qty',             sti.qty
          ))
          FROM stock_transfer_items sti
          JOIN ingredients i ON i.id = sti.ingredient_id
          WHERE sti.transfer_id = st.id
         ) AS items
       FROM stock_transfers st
       JOIN branches fb ON fb.id = st.from_branch_id
       JOIN branches tb ON tb.id = st.to_branch_id
       JOIN users    u  ON u.id  = st.created_by
       WHERE st.to_branch_id = p_branch_id
         AND st.status = 'pending'
     ) t),
    '[]'::jsonb
  );
END;
$$;

-- ══════════════════════════════════════════════════════════════
-- RPC: get_transfer_history
-- Semua transfer yang melibatkan satu outlet (kirim atau terima)
-- ══════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION get_transfer_history(
  p_branch_id BIGINT,
  p_limit     INTEGER DEFAULT 50,
  p_offset    INTEGER DEFAULT 0
)
RETURNS JSONB
SECURITY DEFINER
SET search_path = public
LANGUAGE plpgsql AS $$
BEGIN
  RETURN COALESCE(
    (SELECT jsonb_agg(t ORDER BY t.created_at DESC)
     FROM (
       SELECT
         st.id,
         st.transfer_code,
         st.status,
         st.notes,
         st.rejection_reason,
         st.created_at,
         st.confirmed_at,
         st.rejected_at,
         st.cancelled_at,
         fb.name   AS from_branch_name,
         tb.name   AS to_branch_name,
         uc.name   AS created_by_name,
         ucf.name  AS confirmed_by_name,
         urj.name  AS rejected_by_name,
         (SELECT jsonb_agg(jsonb_build_object(
            'ingredient_id',   sti.ingredient_id,
            'ingredient_name', i.name,
            'unit',            i.unit,
            'qty',             sti.qty
          ))
          FROM stock_transfer_items sti
          JOIN ingredients i ON i.id = sti.ingredient_id
          WHERE sti.transfer_id = st.id
         ) AS items
       FROM stock_transfers st
       JOIN branches fb  ON fb.id  = st.from_branch_id
       JOIN branches tb  ON tb.id  = st.to_branch_id
       JOIN users    uc  ON uc.id  = st.created_by
       LEFT JOIN users ucf ON ucf.id = st.confirmed_by
       LEFT JOIN users urj ON urj.id = st.rejected_by
       WHERE st.from_branch_id = p_branch_id OR st.to_branch_id = p_branch_id
       ORDER BY st.created_at DESC
       LIMIT p_limit OFFSET p_offset
     ) t),
    '[]'::jsonb
  );
END;
$$;

-- ══════════════════════════════════════════════════════════════
-- RPC: get_all_transfers_admin
-- Admin: lihat semua transfer dari semua outlet
-- ══════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION get_all_transfers_admin(
  p_limit  INTEGER DEFAULT 100,
  p_offset INTEGER DEFAULT 0,
  p_status TEXT    DEFAULT NULL
)
RETURNS JSONB
SECURITY DEFINER
SET search_path = public
LANGUAGE plpgsql AS $$
BEGIN
  RETURN COALESCE(
    (SELECT jsonb_agg(t ORDER BY t.created_at DESC)
     FROM (
       SELECT
         st.id,
         st.transfer_code,
         st.status,
         st.notes,
         st.rejection_reason,
         st.created_at,
         st.confirmed_at,
         st.rejected_at,
         st.cancelled_at,
         fb.name   AS from_branch_name,
         tb.name   AS to_branch_name,
         uc.name   AS created_by_name,
         ucf.name  AS confirmed_by_name,
         urj.name  AS rejected_by_name,
         (SELECT jsonb_agg(jsonb_build_object(
            'ingredient_id',   sti.ingredient_id,
            'ingredient_name', i.name,
            'unit',            i.unit,
            'qty',             sti.qty
          ))
          FROM stock_transfer_items sti
          JOIN ingredients i ON i.id = sti.ingredient_id
          WHERE sti.transfer_id = st.id
         ) AS items
       FROM stock_transfers st
       JOIN branches fb  ON fb.id  = st.from_branch_id
       JOIN branches tb  ON tb.id  = st.to_branch_id
       JOIN users    uc  ON uc.id  = st.created_by
       LEFT JOIN users ucf ON ucf.id = st.confirmed_by
       LEFT JOIN users urj ON urj.id = st.rejected_by
       WHERE (p_status IS NULL OR st.status = p_status)
       ORDER BY st.created_at DESC
       LIMIT p_limit OFFSET p_offset
     ) t),
    '[]'::jsonb
  );
END;
$$;

-- ── Grant execute ──────────────────────────────────────────────
GRANT EXECUTE ON FUNCTION generate_transfer_code()                             TO authenticated;
GRANT EXECUTE ON FUNCTION create_stock_transfer(BIGINT,BIGINT,JSONB,TEXT,BIGINT) TO authenticated;
GRANT EXECUTE ON FUNCTION confirm_stock_transfer(BIGINT,BIGINT)                TO authenticated;
GRANT EXECUTE ON FUNCTION reject_stock_transfer(BIGINT,BIGINT,TEXT)            TO authenticated;
GRANT EXECUTE ON FUNCTION cancel_stock_transfer(BIGINT,BIGINT)                 TO authenticated;
GRANT EXECUTE ON FUNCTION get_pending_transfers(BIGINT)                        TO authenticated;
GRANT EXECUTE ON FUNCTION get_transfer_history(BIGINT,INTEGER,INTEGER)         TO authenticated;
GRANT EXECUTE ON FUNCTION get_all_transfers_admin(INTEGER,INTEGER,TEXT)        TO authenticated;
