-- ══════════════════════════════════════════════════════════════════════════════
-- patch_post_migration_fixes.sql
-- Jalankan patch ini pada database cPanel yang SUDAH dibuat dari cpanel_mysql_schema.sql
-- Memperbaiki kolom yang hilang setelah migrasi dari Supabase
-- ══════════════════════════════════════════════════════════════════════════════

-- 1. Tambah reference_type ke inventory_logs (jika belum ada)
ALTER TABLE `inventory_logs`
  ADD COLUMN IF NOT EXISTS `reference_type` VARCHAR(50) DEFAULT NULL AFTER `created_by`,
  ADD INDEX IF NOT EXISTS `idx_ref_type` (`reference_type`, `created_at`);

-- 2. Tambah updated_at ke branch_inventory (jika belum ada)
ALTER TABLE `branch_inventory`
  ADD COLUMN IF NOT EXISTS `updated_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP;

-- 3. Tutup cashier_sessions yang masih 'open' dari sisa data Supabase
--    (sesi-sesi ini tidak bisa ditutup secara normal setelah migrasi)
--    Jalankan HANYA jika yakin tidak ada shift yang sedang aktif!
--
-- UPDATE `cashier_sessions`
-- SET status = 'closed',
--     closed_at = NOW(),
--     closing_cash = opening_cash
-- WHERE status = 'open'
--   AND opened_at < DATE_SUB(NOW(), INTERVAL 12 HOUR);
--
-- Catatan: Baris di atas sengaja di-comment. Uncomment dan jalankan manual
-- di phpMyAdmin jika ada shift lama yang menghalangi pembukaan shift baru.

-- 4. Tambah reference_id ke inventory_logs (jika belum ada)
ALTER TABLE `inventory_logs`
  ADD COLUMN IF NOT EXISTS `reference_id` VARCHAR(100) DEFAULT NULL AFTER `reference_type`;

-- 5. Tambah kolom yang hilang di tabel products (dari Supabase, tidak ada di schema awal)
ALTER TABLE `products`
  ADD COLUMN IF NOT EXISTS `category`      VARCHAR(255) DEFAULT NULL AFTER `name`,
  ADD COLUMN IF NOT EXISTS `has_variants`  TINYINT(1) NOT NULL DEFAULT 1 AFTER `image_url`,
  ADD COLUMN IF NOT EXISTS `default_price` DECIMAL(12,2) DEFAULT NULL AFTER `has_variants`;

-- 6. Hapus semua foto produk yang menggunakan URL Supabase (jalankan setelah upload foto baru)
--    URL Supabase biasanya mengandung 'supabase.co' atau 'pvxllnhtlybvz' (project ID)
UPDATE `products`
SET `image_url` = NULL
WHERE `image_url` IS NOT NULL
  AND (`image_url` LIKE '%supabase.co%' OR `image_url` LIKE '%pvxllnhtlybvz%');

-- Jika ingin hapus SEMUA foto (tidak hanya Supabase), gunakan ini:
-- UPDATE `products` SET `image_url` = NULL;

-- Verifikasi (cek struktur tabel secara langsung)
DESCRIBE `inventory_logs`;
DESCRIBE `branch_inventory`;
DESCRIBE `products`;
