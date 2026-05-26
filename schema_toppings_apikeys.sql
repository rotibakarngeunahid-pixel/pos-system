-- ══════════════════════════════════════════════════════════════
-- RBN POS — Schema Tambahan: Toppings + API Keys
-- Jalankan di Supabase Dashboard → SQL Editor → Run
-- ══════════════════════════════════════════════════════════════

-- ── Toppings ─────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS toppings (
  id         SERIAL PRIMARY KEY,
  name       TEXT             NOT NULL,
  price      NUMERIC(12,2)    NOT NULL DEFAULT 0,
  is_active  BOOLEAN          NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ      NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS product_toppings (
  id         SERIAL  PRIMARY KEY,
  product_id INTEGER NOT NULL REFERENCES products(id)  ON DELETE CASCADE,
  topping_id INTEGER NOT NULL REFERENCES toppings(id)  ON DELETE CASCADE,
  UNIQUE(product_id, topping_id)
);

-- ── API Keys ─────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS api_keys (
  id         SERIAL PRIMARY KEY,
  name       TEXT         NOT NULL,
  key_value  TEXT         NOT NULL UNIQUE,
  is_active  BOOLEAN      NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

-- ── RPC: ambil data transaksi pakai API key ───────────────────
CREATE OR REPLACE FUNCTION get_transactions_api(
  p_api_key TEXT,
  p_from    TIMESTAMPTZ DEFAULT NULL,
  p_to      TIMESTAMPTZ DEFAULT NULL
)
RETURNS TABLE (
  id              INTEGER,
  created_at      TIMESTAMPTZ,
  branch_name     TEXT,
  staff_name      TEXT,
  payment_method  TEXT,
  subtotal        NUMERIC,
  discount_amount NUMERIC,
  total           NUMERIC,
  status          TEXT,
  items           JSONB
)
SECURITY DEFINER LANGUAGE plpgsql AS $$
BEGIN
  -- Validasi API key
  IF NOT EXISTS (
    SELECT 1 FROM api_keys WHERE key_value = p_api_key AND is_active = TRUE
  ) THEN
    RAISE EXCEPTION 'Invalid or inactive API key';
  END IF;

  RETURN QUERY
  SELECT
    t.id,
    t.created_at,
    b.name::TEXT                              AS branch_name,
    u.name::TEXT                              AS staff_name,
    t.payment_method,
    COALESCE(t.subtotal, t.total)::NUMERIC    AS subtotal,
    COALESCE(t.discount_amount, 0)::NUMERIC   AS discount_amount,
    t.total::NUMERIC,
    t.status,
    COALESCE(
      (SELECT jsonb_agg(jsonb_build_object(
         'product_name', ti.product_name,
         'variant_name',  ti.variant_name,
         'quantity',      ti.quantity,
         'price',         ti.price,
         'subtotal',      ti.subtotal
       ))
       FROM transaction_items ti WHERE ti.transaction_id = t.id),
      '[]'::jsonb
    ) AS items
  FROM transactions t
  LEFT JOIN branches b ON b.id = t.branch_id
  LEFT JOIN users    u ON u.id = t.staff_id
  WHERE t.status = 'completed'
    AND (p_from IS NULL OR t.created_at >= p_from)
    AND (p_to   IS NULL OR t.created_at <= p_to)
  ORDER BY t.created_at DESC;
END;
$$;

-- ── Permissions (GRANT) ──────────────────────────────────────
GRANT SELECT           ON toppings                         TO anon, authenticated;
GRANT SELECT           ON product_toppings                 TO anon, authenticated;
REVOKE INSERT, UPDATE, DELETE ON toppings                  FROM PUBLIC, anon, authenticated;
REVOKE INSERT, UPDATE, DELETE ON product_toppings          FROM PUBLIC, anon, authenticated;
REVOKE ALL             ON api_keys                         FROM PUBLIC, anon, authenticated;
REVOKE ALL             ON SEQUENCE toppings_id_seq         FROM PUBLIC, anon, authenticated;
REVOKE ALL             ON SEQUENCE product_toppings_id_seq FROM PUBLIC, anon, authenticated;
REVOKE ALL             ON SEQUENCE api_keys_id_seq         FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION get_transactions_api             TO anon, authenticated;

-- ── Row Level Security ────────────────────────────────────────
-- Supabase mengaktifkan RLS secara otomatis. Tanpa policy, semua
-- akses diblokir meski GRANT sudah diberikan.

ALTER TABLE toppings         ENABLE ROW LEVEL SECURITY;
ALTER TABLE product_toppings ENABLE ROW LEVEL SECURITY;
ALTER TABLE api_keys         ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "toppings_select" ON toppings;
DROP POLICY IF EXISTS "toppings_insert" ON toppings;
DROP POLICY IF EXISTS "toppings_update" ON toppings;
DROP POLICY IF EXISTS "toppings_delete" ON toppings;
DROP POLICY IF EXISTS "pt_select" ON product_toppings;
DROP POLICY IF EXISTS "pt_insert" ON product_toppings;
DROP POLICY IF EXISTS "pt_update" ON product_toppings;
DROP POLICY IF EXISTS "pt_delete" ON product_toppings;
DROP POLICY IF EXISTS "apikeys_select" ON api_keys;
DROP POLICY IF EXISTS "apikeys_insert" ON api_keys;
DROP POLICY IF EXISTS "apikeys_update" ON api_keys;
DROP POLICY IF EXISTS "apikeys_delete" ON api_keys;

-- POS boleh membaca topping, tetapi mutasi topping/API key harus lewat
-- RPC admin yang ditambahkan di sql/migrations/054_harden_custom_sessions_and_api_keys.sql.
CREATE POLICY "toppings_select"  ON toppings         FOR SELECT USING (true);

-- product_toppings: dibaca POS, mutasi lewat RPC admin.
CREATE POLICY "pt_select"  ON product_toppings FOR SELECT USING (true);

-- api_keys tidak punya public policy. Integrasi tetap memanggil
-- SECURITY DEFINER RPC get_transactions_api; admin kelola key lewat migration 054.

NOTIFY pgrst, 'reload schema';
