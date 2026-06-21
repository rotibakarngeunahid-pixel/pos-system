-- ════════════════════════════════════════════════════════════════════════════
-- 066_manual_transaction.sql
-- Penanda transaksi yang diinput MANUAL oleh admin (transaksi susulan / koreksi /
-- penjualan offline yang lupa dicatat). Menambah 3 kolom ke tabel `transactions`:
--   * source      : 'pos' (default, dari kasir) | 'manual' (diinput admin)
--   * created_by  : id admin/owner yang menginput transaksi manual (audit)
--   * entered_at  : waktu sebenarnya admin menginput (created_at = waktu bisnis/backdate)
--
-- Idempotent: aman dijalankan berulang. Baris lama otomatis terisi source='pos'
-- karena kolom ADD dengan NOT NULL DEFAULT 'pos'.
--
-- Jalankan manual di phpMyAdmin / MySQL cPanel — JANGAN dieksekusi otomatis.
-- ════════════════════════════════════════════════════════════════════════════

-- ── Tambah kolom (idempotent) ───────────────────────────────────────────────
DROP PROCEDURE IF EXISTS `__rbn_add_col_066`;
DELIMITER //
CREATE PROCEDURE `__rbn_add_col_066`(
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

CALL `__rbn_add_col_066`('transactions', 'source',     'VARCHAR(20) NOT NULL DEFAULT ''pos''');
CALL `__rbn_add_col_066`('transactions', 'created_by', 'BIGINT DEFAULT NULL');
CALL `__rbn_add_col_066`('transactions', 'entered_at', 'DATETIME DEFAULT NULL');

DROP PROCEDURE IF EXISTS `__rbn_add_col_066`;

-- ── Index & FK (idempotent) ─────────────────────────────────────────────────
DROP PROCEDURE IF EXISTS `__rbn_add_idx_066`;
DELIMITER //
CREATE PROCEDURE `__rbn_add_idx_066`()
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM INFORMATION_SCHEMA.STATISTICS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'transactions' AND INDEX_NAME = 'idx_tx_source'
  ) THEN
    ALTER TABLE `transactions` ADD INDEX `idx_tx_source` (`source`, `created_at`);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM INFORMATION_SCHEMA.TABLE_CONSTRAINTS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'transactions' AND CONSTRAINT_NAME = 'fk_tx_created_by'
  ) THEN
    ALTER TABLE `transactions` ADD CONSTRAINT `fk_tx_created_by` FOREIGN KEY (`created_by`) REFERENCES `users`(`id`);
  END IF;
END //
DELIMITER ;
CALL `__rbn_add_idx_066`();
DROP PROCEDURE IF EXISTS `__rbn_add_idx_066`;
