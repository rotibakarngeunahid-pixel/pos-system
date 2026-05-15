-- ═══════════════════════════════════════════════════════════════
-- Migration 021: Staff Onboarding Tutorial
-- Auto-assigns guided POS training to every new staff user.
-- Includes tables, trigger, RPCs, and seed data.
-- ═══════════════════════════════════════════════════════════════

BEGIN;

-- ─────────────────────────────────────────────────────────────
-- 1. onboarding_templates
-- ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS onboarding_templates (
  id            BIGSERIAL PRIMARY KEY,
  template_key  TEXT NOT NULL,
  audience_role TEXT NOT NULL,
  version       INTEGER NOT NULL DEFAULT 1,
  title         TEXT NOT NULL,
  description   TEXT,
  is_active     BOOLEAN NOT NULL DEFAULT TRUE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (template_key, version)
);

GRANT ALL ON onboarding_templates TO anon, authenticated;
GRANT ALL ON SEQUENCE onboarding_templates_id_seq TO anon, authenticated;

CREATE INDEX IF NOT EXISTS idx_ob_templates_active
  ON onboarding_templates(is_active, audience_role);

-- ─────────────────────────────────────────────────────────────
-- 2. onboarding_steps
-- ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS onboarding_steps (
  id              BIGSERIAL PRIMARY KEY,
  template_id     BIGINT NOT NULL REFERENCES onboarding_templates(id) ON DELETE CASCADE,
  step_key        TEXT NOT NULL,
  module_key      TEXT NOT NULL,
  sequence        INTEGER NOT NULL,
  page            TEXT NOT NULL DEFAULT 'pos.html',
  target_selector TEXT,
  title           TEXT NOT NULL,
  body            TEXT NOT NULL,
  is_required     BOOLEAN NOT NULL DEFAULT TRUE,
  is_active       BOOLEAN NOT NULL DEFAULT TRUE,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (template_id, step_key),
  UNIQUE (template_id, sequence)
);

GRANT ALL ON onboarding_steps TO anon, authenticated;
GRANT ALL ON SEQUENCE onboarding_steps_id_seq TO anon, authenticated;

CREATE INDEX IF NOT EXISTS idx_ob_steps_template
  ON onboarding_steps(template_id, sequence);

-- ─────────────────────────────────────────────────────────────
-- 3. user_onboarding_assignments
-- ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS user_onboarding_assignments (
  id            BIGSERIAL PRIMARY KEY,
  user_id       BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  template_id   BIGINT NOT NULL REFERENCES onboarding_templates(id) ON DELETE RESTRICT,
  status        TEXT NOT NULL DEFAULT 'not_started',
  started_at    TIMESTAMPTZ,
  completed_at  TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT chk_ob_assignment_status
    CHECK (status IN ('not_started', 'in_progress', 'completed')),
  UNIQUE (user_id, template_id)
);

GRANT ALL ON user_onboarding_assignments TO anon, authenticated;
GRANT ALL ON SEQUENCE user_onboarding_assignments_id_seq TO anon, authenticated;

CREATE INDEX IF NOT EXISTS idx_ob_assignments_user
  ON user_onboarding_assignments(user_id, status);

-- ─────────────────────────────────────────────────────────────
-- 4. user_onboarding_step_progress
-- ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS user_onboarding_step_progress (
  id             BIGSERIAL PRIMARY KEY,
  assignment_id  BIGINT NOT NULL REFERENCES user_onboarding_assignments(id) ON DELETE CASCADE,
  step_id        BIGINT NOT NULL REFERENCES onboarding_steps(id) ON DELETE CASCADE,
  status         TEXT NOT NULL DEFAULT 'pending',
  completed_at   TIMESTAMPTZ,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT chk_ob_step_status
    CHECK (status IN ('pending', 'completed')),
  UNIQUE (assignment_id, step_id)
);

GRANT ALL ON user_onboarding_step_progress TO anon, authenticated;
GRANT ALL ON SEQUENCE user_onboarding_step_progress_id_seq TO anon, authenticated;

CREATE INDEX IF NOT EXISTS idx_ob_step_progress_assignment
  ON user_onboarding_step_progress(assignment_id);

-- ─────────────────────────────────────────────────────────────
-- 5. onboarding_events  (audit log)
-- ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS onboarding_events (
  id             BIGSERIAL PRIMARY KEY,
  assignment_id  BIGINT REFERENCES user_onboarding_assignments(id) ON DELETE CASCADE,
  user_id        BIGINT REFERENCES users(id) ON DELETE CASCADE,
  event_type     TEXT NOT NULL,
  step_key       TEXT,
  metadata       JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

GRANT ALL ON onboarding_events TO anon, authenticated;
GRANT ALL ON SEQUENCE onboarding_events_id_seq TO anon, authenticated;

CREATE INDEX IF NOT EXISTS idx_ob_events_assignment
  ON onboarding_events(assignment_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_ob_events_user
  ON onboarding_events(user_id, created_at DESC);

-- ─────────────────────────────────────────────────────────────
-- 6. Trigger: auto-create assignment on new staff INSERT
-- ─────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION create_staff_onboarding_assignment()
RETURNS TRIGGER AS $$
DECLARE
  v_template_id   BIGINT;
  v_assignment_id BIGINT;
BEGIN
  -- Only for role=staff on INSERT; skip admin, investor, inactive
  IF NEW.role <> 'staff' THEN
    RETURN NEW;
  END IF;

  IF COALESCE(NEW.is_active, TRUE) = FALSE THEN
    RETURN NEW;
  END IF;

  -- Find most recent active template for staff
  SELECT id INTO v_template_id
  FROM onboarding_templates
  WHERE template_key  = 'staff_pos_basics'
    AND audience_role = 'staff'
    AND is_active     = TRUE
  ORDER BY version DESC
  LIMIT 1;

  -- If no template exists, log audit and continue (do NOT fail the INSERT)
  IF v_template_id IS NULL THEN
    INSERT INTO onboarding_events (user_id, event_type, metadata)
    VALUES (NEW.id, 'template_missing',
            jsonb_build_object('role', NEW.role, 'note', 'No active staff_pos_basics template found'));
    RETURN NEW;
  END IF;

  -- Create assignment; idempotent via ON CONFLICT DO NOTHING
  INSERT INTO user_onboarding_assignments (user_id, template_id, status)
  VALUES (NEW.id, v_template_id, 'not_started')
  ON CONFLICT (user_id, template_id) DO NOTHING
  RETURNING id INTO v_assignment_id;

  -- Pre-create step progress rows so the frontend can track them
  IF v_assignment_id IS NOT NULL THEN
    INSERT INTO user_onboarding_step_progress (assignment_id, step_id, status)
    SELECT v_assignment_id, s.id, 'pending'
    FROM onboarding_steps s
    WHERE s.template_id = v_template_id
      AND s.is_active   = TRUE
    ON CONFLICT DO NOTHING;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

DROP TRIGGER IF EXISTS trg_create_staff_onboarding_assignment ON users;
CREATE TRIGGER trg_create_staff_onboarding_assignment
  AFTER INSERT ON users
  FOR EACH ROW
  EXECUTE FUNCTION create_staff_onboarding_assignment();

-- ─────────────────────────────────────────────────────────────
-- 7. RPC: get_my_onboarding
-- Returns assignment + template + steps + progress for one user.
-- Returns empty if role is not staff or no active assignment.
-- ─────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION get_my_onboarding(p_user_id BIGINT)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_role       TEXT;
  v_assignment RECORD;
  v_result     JSONB;
BEGIN
  SELECT role INTO v_role FROM users WHERE id = p_user_id LIMIT 1;
  IF v_role IS NULL OR v_role <> 'staff' THEN
    RETURN '{}'::jsonb;
  END IF;

  SELECT a.id, a.status, a.started_at, a.completed_at,
         t.id AS template_id, t.title AS template_title, t.template_key
  INTO v_assignment
  FROM user_onboarding_assignments a
  JOIN onboarding_templates t ON t.id = a.template_id
  WHERE a.user_id = p_user_id
    AND t.is_active = TRUE
  ORDER BY a.created_at DESC
  LIMIT 1;

  IF NOT FOUND THEN
    RETURN '{}'::jsonb;
  END IF;

  SELECT jsonb_build_object(
    'assignment', jsonb_build_object(
      'id',           v_assignment.id,
      'status',       v_assignment.status,
      'started_at',   v_assignment.started_at,
      'completed_at', v_assignment.completed_at
    ),
    'template', jsonb_build_object(
      'id',           v_assignment.template_id,
      'title',        v_assignment.template_title,
      'template_key', v_assignment.template_key
    ),
    'steps', (
      SELECT jsonb_agg(
        jsonb_build_object(
          'id',              s.id,
          'step_key',        s.step_key,
          'module_key',      s.module_key,
          'sequence',        s.sequence,
          'title',           s.title,
          'body',            s.body,
          'target_selector', s.target_selector,
          'is_required',     s.is_required,
          'status',          COALESCE(sp.status, 'pending')
        )
        ORDER BY s.sequence
      )
      FROM onboarding_steps s
      LEFT JOIN user_onboarding_step_progress sp
        ON sp.step_id = s.id AND sp.assignment_id = v_assignment.id
      WHERE s.template_id = v_assignment.template_id
        AND s.is_active   = TRUE
    )
  ) INTO v_result;

  RETURN v_result;
END;
$$;

GRANT EXECUTE ON FUNCTION get_my_onboarding(BIGINT) TO anon, authenticated;

-- ─────────────────────────────────────────────────────────────
-- 8. RPC: start_my_onboarding
-- Transitions assignment from not_started → in_progress.
-- Idempotent if already in_progress.
-- ─────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION start_my_onboarding(
  p_assignment_id BIGINT,
  p_user_id       BIGINT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_current_status TEXT;
BEGIN
  SELECT status INTO v_current_status
  FROM user_onboarding_assignments
  WHERE id = p_assignment_id AND user_id = p_user_id;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', FALSE, 'error', 'Assignment not found or not owned by user');
  END IF;

  IF v_current_status = 'completed' THEN
    RETURN jsonb_build_object('ok', TRUE, 'status', 'completed');
  END IF;

  UPDATE user_onboarding_assignments
  SET status     = 'in_progress',
      started_at = COALESCE(started_at, NOW()),
      updated_at = NOW()
  WHERE id      = p_assignment_id
    AND user_id = p_user_id
    AND status IN ('not_started', 'in_progress');

  INSERT INTO onboarding_events (assignment_id, user_id, event_type)
  VALUES (p_assignment_id, p_user_id, 'started')
  ON CONFLICT DO NOTHING;

  RETURN jsonb_build_object('ok', TRUE, 'status', 'in_progress');
END;
$$;

GRANT EXECUTE ON FUNCTION start_my_onboarding(BIGINT, BIGINT) TO anon, authenticated;

-- ─────────────────────────────────────────────────────────────
-- 9. RPC: complete_onboarding_step
-- Marks one step as completed. If all required steps done,
-- marks the assignment as completed too.
-- Fully idempotent.
-- ─────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION complete_onboarding_step(
  p_assignment_id BIGINT,
  p_step_key      TEXT,
  p_user_id       BIGINT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_assignment_owner BIGINT;
  v_step_id          BIGINT;
  v_template_id      BIGINT;
  v_required_total   INTEGER;
  v_required_done    INTEGER;
  v_is_completed     BOOLEAN := FALSE;
BEGIN
  -- Validate assignment ownership
  SELECT user_id, template_id
  INTO v_assignment_owner, v_template_id
  FROM user_onboarding_assignments
  WHERE id = p_assignment_id;

  IF NOT FOUND OR v_assignment_owner <> p_user_id THEN
    RETURN jsonb_build_object('ok', FALSE, 'error', 'Assignment not found or access denied');
  END IF;

  -- Find step by key within this template
  SELECT id INTO v_step_id
  FROM onboarding_steps
  WHERE template_id = v_template_id
    AND step_key    = p_step_key
    AND is_active   = TRUE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', FALSE, 'error', 'Step not found: ' || p_step_key);
  END IF;

  -- Upsert step progress (idempotent)
  INSERT INTO user_onboarding_step_progress (assignment_id, step_id, status, completed_at, updated_at)
  VALUES (p_assignment_id, v_step_id, 'completed', NOW(), NOW())
  ON CONFLICT (assignment_id, step_id)
  DO UPDATE SET
    status       = 'completed',
    completed_at = COALESCE(user_onboarding_step_progress.completed_at, NOW()),
    updated_at   = NOW();

  -- Log event
  INSERT INTO onboarding_events (assignment_id, user_id, event_type, step_key)
  VALUES (p_assignment_id, p_user_id, 'step_completed', p_step_key);

  -- Check if all required steps are now done
  SELECT COUNT(*) INTO v_required_total
  FROM onboarding_steps
  WHERE template_id = v_template_id
    AND is_required = TRUE
    AND is_active   = TRUE;

  SELECT COUNT(*) INTO v_required_done
  FROM user_onboarding_step_progress sp
  JOIN onboarding_steps s ON s.id = sp.step_id
  WHERE sp.assignment_id = p_assignment_id
    AND sp.status        = 'completed'
    AND s.is_required    = TRUE
    AND s.is_active      = TRUE;

  IF v_required_done >= v_required_total AND v_required_total > 0 THEN
    UPDATE user_onboarding_assignments
    SET status       = 'completed',
        completed_at = COALESCE(completed_at, NOW()),
        updated_at   = NOW()
    WHERE id = p_assignment_id
      AND status <> 'completed';

    IF FOUND THEN
      INSERT INTO onboarding_events (assignment_id, user_id, event_type)
      VALUES (p_assignment_id, p_user_id, 'completed');
    END IF;

    v_is_completed := TRUE;
  END IF;

  RETURN jsonb_build_object(
    'ok',           TRUE,
    'step_key',     p_step_key,
    'assignment_completed', v_is_completed
  );
END;
$$;

GRANT EXECUTE ON FUNCTION complete_onboarding_step(BIGINT, TEXT, BIGINT) TO anon, authenticated;

-- ─────────────────────────────────────────────────────────────
-- 10. RPC: get_staff_onboarding_statuses
-- Returns onboarding status for a list of user IDs.
-- Used by admin staff list to display training badges.
-- ─────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION get_staff_onboarding_statuses(p_user_ids BIGINT[])
RETURNS TABLE (user_id BIGINT, ob_status TEXT)
LANGUAGE sql
SECURITY DEFINER
AS $$
  SELECT DISTINCT ON (a.user_id)
    a.user_id,
    a.status AS ob_status
  FROM user_onboarding_assignments a
  JOIN onboarding_templates t ON t.id = a.template_id
  WHERE a.user_id = ANY(p_user_ids)
    AND t.is_active = TRUE
  ORDER BY a.user_id, a.created_at DESC;
$$;

GRANT EXECUTE ON FUNCTION get_staff_onboarding_statuses(BIGINT[]) TO anon, authenticated;

-- ─────────────────────────────────────────────────────────────
-- 11. Seed: template staff_pos_basics v1
-- ─────────────────────────────────────────────────────────────
INSERT INTO onboarding_templates (template_key, audience_role, version, title, description, is_active)
VALUES (
  'staff_pos_basics',
  'staff',
  1,
  'Pelatihan Staff Baru — POS Roti Bakar Ngeunah',
  'Panduan lengkap penggunaan aplikasi kasir: shift, penjualan, stok, kas, dan setoran tunai.',
  TRUE
)
ON CONFLICT (template_key, version) DO NOTHING;

-- ─────────────────────────────────────────────────────────────
-- 12. Seed: steps for staff_pos_basics v1
-- ─────────────────────────────────────────────────────────────
DO $$
DECLARE v_tid BIGINT;
BEGIN
  SELECT id INTO v_tid FROM onboarding_templates
  WHERE template_key = 'staff_pos_basics' AND version = 1;

  IF v_tid IS NULL THEN RETURN; END IF;

  INSERT INTO onboarding_steps
    (template_id, step_key, module_key, sequence, page, target_selector, title, body, is_required, is_active)
  VALUES
    -- ── Modul 1: Login, Cabang & Shift ──────────────────────────
    (v_tid, 'm1_welcome',       'modul_1_shift',  1,  'pos.html', NULL,
     '👋 Selamat Datang di POS!',
     'Ini adalah aplikasi kasir Roti Bakar Ngeunah. Tutorial ini akan memandu Anda mengenal semua fitur utama. Klik Lanjut untuk mulai.',
     TRUE, TRUE),

    (v_tid, 'm1_staff_name',    'modul_1_shift',  2,  'pos.html', '#header-staff-name',
     '👤 Nama Anda di Header',
     'Nama Anda ditampilkan di sini sebagai tanda Anda sudah login. Pastikan nama yang tampil sudah benar sebelum mulai bertugas.',
     TRUE, TRUE),

    (v_tid, 'm1_branch_name',   'modul_1_shift',  3,  'pos.html', '#header-branch-name',
     '🏪 Cabang Aktif',
     'Ini adalah cabang tempat Anda bertugas hari ini. Semua transaksi, stok, dan kas akan dicatat di cabang ini.',
     TRUE, TRUE),

    (v_tid, 'm1_open_shift',    'modul_1_shift',  4,  'pos.html', '#btn-open-shift',
     '🕐 Buka Shift Sebelum Berjualan',
     'Setiap hari kerja dimulai dengan membuka shift. Isi jumlah kas awal di laci kasir (boleh 0 jika kosong), lalu klik "Buka Shift & Mulai Berjualan".',
     TRUE, TRUE),

    (v_tid, 'm1_shift_required','modul_1_shift',  5,  'pos.html', '.pos-tab-item[data-tab="kasir"]',
     '⚡ Shift Wajib Ada untuk Transaksi',
     'Tanpa shift aktif, Anda tidak bisa memproses pembayaran. Jika shift belum terbuka, sistem akan meminta Anda membuka shift terlebih dahulu.',
     TRUE, TRUE),

    -- ── Modul 2: Penjualan ───────────────────────────────────────
    (v_tid, 'm2_product_search','modul_2_penjualan', 6, 'pos.html', '#product-search',
     '🔍 Cari Produk',
     'Ketik nama produk di kotak pencarian ini untuk menemukan produk dengan cepat. Berguna saat pelanggan menyebut nama produk langsung.',
     TRUE, TRUE),

    (v_tid, 'm2_category_bar',  'modul_2_penjualan', 7, 'pos.html', '#category-bar',
     '📂 Filter Kategori',
     'Klik salah satu kategori untuk menyaring produk berdasarkan jenisnya. Pilih "Semua" untuk melihat semua produk kembali.',
     TRUE, TRUE),

    (v_tid, 'm2_select_product','modul_2_penjualan', 8, 'pos.html', '#products-grid',
     '🛒 Pilih Produk',
     'Klik kartu produk untuk menambahkannya ke keranjang. Jika produk memiliki varian (ukuran, rasa), sistem akan meminta Anda memilih varian terlebih dahulu.',
     TRUE, TRUE),

    (v_tid, 'm2_open_cart',     'modul_2_penjualan', 9, 'pos.html', '#fab-cart-btn',
     '🛍️ Buka Keranjang',
     'Tombol ini menampilkan keranjang belanja Anda. Angka di atasnya menunjukkan jumlah item. Klik untuk melihat detail pesanan dan mengubah qty.',
     TRUE, TRUE),

    (v_tid, 'm2_discount',      'modul_2_penjualan', 10, 'pos.html', '#discount-type',
     '🏷️ Terapkan Diskon',
     'Di halaman pembayaran, Anda bisa memberikan diskon persentase atau nominal. Pilih jenis diskon, masukkan nilai, lalu klik Terapkan.',
     TRUE, TRUE),

    (v_tid, 'm2_payment',       'modul_2_penjualan', 11, 'pos.html', '.payment-methods',
     '💳 Pilih Metode Pembayaran',
     'Pilih metode pembayaran: Tunai, QRIS, atau Transfer Bank. Untuk tunai, masukkan uang yang diterima agar sistem menghitung kembalian otomatis.',
     TRUE, TRUE),

    (v_tid, 'm2_checkout',      'modul_2_penjualan', 12, 'pos.html', '#btn-confirm-pay',
     '✅ Konfirmasi Pembayaran',
     'Klik tombol ini untuk menyelesaikan transaksi. Sistem akan menyimpan transaksi, mengurangi stok bahan sesuai resep, dan mencatat ke kas.',
     TRUE, TRUE),

    -- ── Modul 3: Stok Otomatis ───────────────────────────────────
    (v_tid, 'm3_auto_stock',    'modul_3_stok_otomatis', 13, 'pos.html', '#pos-maintab-stock',
     '📦 Stok Berkurang Otomatis',
     'Setelah transaksi berhasil, stok bahan baku yang digunakan dalam resep produk akan langsung berkurang secara otomatis. Anda tidak perlu mencatat manual setiap penjualan.',
     TRUE, TRUE),

    (v_tid, 'm3_stock_view',    'modul_3_stok_otomatis', 14, 'pos.html', '#pos-maintab-stock',
     '👁️ Cek Ringkasan Stok',
     'Klik tab Stok untuk melihat sisa stok semua bahan baku. Biasakan mengecek stok di awal dan akhir shift untuk memastikan ketersediaan bahan.',
     TRUE, TRUE),

    -- ── Modul 4: Manajemen Stok ──────────────────────────────────
    (v_tid, 'm4_stock_tab',     'modul_4_manajemen_stok', 15, 'pos.html', '#pos-maintab-stock',
     '📋 Tab Stok Bahan',
     'Di tab ini Anda bisa melihat daftar lengkap semua bahan baku beserta sisa stok terkini.',
     TRUE, TRUE),

    (v_tid, 'm4_stock_adjust',  'modul_4_manajemen_stok', 16, 'pos.html', 'button[data-action="open-stock-adjust-modal"]',
     '✏️ Ubah Stok Manual',
     'Gunakan tombol "Ubah Stok" untuk mencatat: Stok Masuk (pembelian bahan), Stok Keluar (waste atau penggunaan manual), atau Opname (koreksi hasil hitung fisik).',
     TRUE, TRUE),

    (v_tid, 'm4_stock_transfer','modul_4_manajemen_stok', 17, 'pos.html', '#stock-adj-type',
     '🔄 Transfer Stok Antar Cabang',
     'Jika cabang Anda memiliki kelebihan stok, Anda bisa mentransfer ke cabang lain melalui menu Ubah Stok → Transfer Keluar. Cabang penerima akan mendapat notifikasi.',
     FALSE, TRUE),

    -- ── Modul 5: Riwayat & Void ──────────────────────────────────
    (v_tid, 'm5_transactions',  'modul_5_riwayat', 18, 'pos.html', '#pos-maintab-transactions',
     '📜 Riwayat Transaksi',
     'Tab Transaksi menampilkan semua transaksi dalam shift aktif. Klik salah satu transaksi untuk melihat detail lengkapnya termasuk item, total, dan metode bayar.',
     TRUE, TRUE),

    (v_tid, 'm5_void',          'modul_5_riwayat', 19, 'pos.html', '#pos-maintab-transactions',
     '↩️ Void Transaksi',
     'Jika ada kesalahan transaksi, gunakan fitur Void dari detail transaksi. Void wajib disertai alasan yang jelas. Hubungi admin jika ragu.',
     TRUE, TRUE),

    -- ── Modul 6: Kas, Tutup Shift & Setoran ─────────────────────
    (v_tid, 'm6_cash_tab',      'modul_6_kas_shift', 20, 'pos.html', '#pos-maintab-cash',
     '💰 Ringkasan Kas',
     'Tab Kas menampilkan saldo kas tunai saat ini, riwayat kas masuk dan keluar, serta total penjualan tunai. Periksa sebelum menutup shift.',
     TRUE, TRUE),

    (v_tid, 'm6_close_shift',   'modul_6_kas_shift', 21, 'pos.html', 'button[data-action="open-close-shift"]',
     '🔒 Tutup Shift di Akhir Tugas',
     'Di akhir giliran, klik tombol "Tutup Shift". Hitung uang tunai di laci kasir dan masukkan jumlah aktualnya. Sistem akan menampilkan apakah ada selisih.',
     TRUE, TRUE),

    (v_tid, 'm6_deposit',       'modul_6_kas_shift', 22, 'pos.html', '#pos-maintab-deposits',
     '📤 Setoran Tunai',
     'Setelah shift ditutup, Anda bisa menyetor tunai ke rekening bisnis melalui tab Setoran. Upload bukti transfer dan masukkan nominal yang disetor.',
     TRUE, TRUE)

  ON CONFLICT (template_id, step_key) DO NOTHING;
END;
$$;

COMMIT;
