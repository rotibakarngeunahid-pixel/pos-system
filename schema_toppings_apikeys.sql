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
GRANT ALL              ON toppings                         TO anon, authenticated;
GRANT ALL              ON product_toppings                 TO anon, authenticated;
GRANT ALL              ON api_keys                         TO anon, authenticated;
GRANT USAGE, SELECT    ON SEQUENCE toppings_id_seq         TO anon, authenticated;
GRANT USAGE, SELECT    ON SEQUENCE product_toppings_id_seq TO anon, authenticated;
GRANT USAGE, SELECT    ON SEQUENCE api_keys_id_seq         TO anon, authenticated;
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

-- Aplikasi memakai custom session di localStorage dan Supabase anon key.
-- Karena role dicek di app/RPC, policy tambahan ini dibuat permisif.
CREATE POLICY "toppings_select"  ON toppings         FOR SELECT USING (true);
CREATE POLICY "toppings_insert"  ON toppings         FOR INSERT WITH CHECK (true);
CREATE POLICY "toppings_update"  ON toppings         FOR UPDATE USING (true) WITH CHECK (true);
CREATE POLICY "toppings_delete"  ON toppings         FOR DELETE USING (true);

-- product_toppings: dibaca POS, dikelola admin UI custom auth
CREATE POLICY "pt_select"  ON product_toppings FOR SELECT USING (true);
CREATE POLICY "pt_insert"  ON product_toppings FOR INSERT WITH CHECK (true);
CREATE POLICY "pt_update"  ON product_toppings FOR UPDATE USING (true) WITH CHECK (true);
CREATE POLICY "pt_delete"  ON product_toppings FOR DELETE USING (true);

-- api_keys: dikelola admin UI custom auth
CREATE POLICY "apikeys_select"  ON api_keys FOR SELECT USING (true);
CREATE POLICY "apikeys_insert"  ON api_keys FOR INSERT WITH CHECK (true);
CREATE POLICY "apikeys_update"  ON api_keys FOR UPDATE USING (true) WITH CHECK (true);
CREATE POLICY "apikeys_delete"  ON api_keys FOR DELETE USING (true);
