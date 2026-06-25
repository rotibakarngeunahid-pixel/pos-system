-- ════════════════════════════════════════════════════════════════════════════
-- 067_cash_check_status.sql
-- Tambah kolom verifikasi fisik kas saat tutup shift ke tabel cashier_sessions.
--
-- Dengan fitur ini, staff TIDAK LAGI bisa input nominal kas akhir secara manual.
-- Backend menghitung expected_cash dari data sistem; staff hanya memilih apakah
-- uang fisik di laci sesuai atau tidak dengan angka sistem.
--
-- Kolom baru:
--   * cash_check_status : 'match' | 'mismatch' | NULL (sesi lama sebelum fitur ini)
--   * cash_check_note   : Catatan staff jika kas fisik tidak sesuai (mismatch)
--   * cash_checked_at   : Waktu pengecekan fisik kas oleh staff saat tutup shift
--
-- Idempotent: aman dijalankan berulang.
-- Jalankan manual di phpMyAdmin / MySQL cPanel — JANGAN dieksekusi otomatis.
-- ════════════════════════════════════════════════════════════════════════════

DROP PROCEDURE IF EXISTS `__rbn_add_col_067`;
DELIMITER //
CREATE PROCEDURE `__rbn_add_col_067`(
  IN p_table VARCHAR(64), IN p_col VARCHAR(64), IN p_def TEXT
)
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = p_table AND COLUMN_NAME = p_col
  ) THEN
    SET @ddl = CONCAT('ALTER TABLE `', p_table, '` ADD COLUMN `', p_col, '` ', p_def);
    PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;
  END IF;
END //
DELIMITER ;

CALL `__rbn_add_col_067`('cashier_sessions', 'cash_check_status',
  'VARCHAR(20) DEFAULT NULL COMMENT ''match=kas sesuai, mismatch=kas tidak sesuai, NULL=sesi lama sebelum migrasi ini''');

CALL `__rbn_add_col_067`('cashier_sessions', 'cash_check_note',
  'TEXT DEFAULT NULL COMMENT ''Catatan/alasan staff jika kas fisik tidak sesuai saldo sistem''');

CALL `__rbn_add_col_067`('cashier_sessions', 'cash_checked_at',
  'DATETIME DEFAULT NULL COMMENT ''Waktu staff melakukan pengecekan fisik kas saat tutup shift''');

DROP PROCEDURE IF EXISTS `__rbn_add_col_067`;
