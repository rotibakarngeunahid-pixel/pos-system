-- ════════════════════════════════════════════════════════════════════════════
-- Migration 064: Member & Loyalty Point — Schema (Fase 1 MVP)
-- ────────────────────────────────────────────────────────────────────────────
-- Membuat seluruh tabel member_* + kolom tambahan di `transactions` & `users`.
-- AMAN dijalankan berulang kali:
--   * CREATE TABLE IF NOT EXISTS
--   * Penambahan kolom dibungkus stored procedure idempotent (cek INFORMATION_SCHEMA)
--   * Seed setting pakai INSERT IGNORE
-- Referensi: docs/PRD_Member_Loyalty_Point.md §6
-- Konvensi: MySQL 8 + InnoDB + utf8mb4_unicode_ci
-- Tipe PK existing: transactions.id INT, users/branches.id BIGINT, products/variants.id INT
-- ════════════════════════════════════════════════════════════════════════════

-- ── 6.1 members ──────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS `members` (
  `id`                       BIGINT AUTO_INCREMENT PRIMARY KEY,
  `member_code`              VARCHAR(20)  NOT NULL UNIQUE,
  `name`                     VARCHAR(255) NOT NULL,
  `phone`                    VARCHAR(20)  NOT NULL UNIQUE,
  `email`                    VARCHAR(255) UNIQUE DEFAULT NULL,
  `password`                 VARCHAR(255) NOT NULL,
  `birth_date`               DATE DEFAULT NULL,
  `gender`                   ENUM('M','F','other') DEFAULT NULL,
  `phone_verified`           TINYINT(1) NOT NULL DEFAULT 0,
  `email_verified`           TINYINT(1) NOT NULL DEFAULT 0,
  `qr_secret`                VARCHAR(64) NOT NULL,
  `signup_branch_id`         BIGINT DEFAULT NULL,
  `staff_link_user_id`       BIGINT DEFAULT NULL,
  `is_active`                TINYINT(1) NOT NULL DEFAULT 1,
  `lifetime_points_earned`   BIGINT NOT NULL DEFAULT 0,
  `lifetime_points_redeemed` BIGINT NOT NULL DEFAULT 0,
  `last_transaction_at`      DATETIME DEFAULT NULL,
  `created_at`               DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at`               DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  `deleted_at`               DATETIME DEFAULT NULL,
  FOREIGN KEY (`signup_branch_id`)   REFERENCES `branches`(`id`) ON DELETE SET NULL,
  FOREIGN KEY (`staff_link_user_id`) REFERENCES `users`(`id`)    ON DELETE SET NULL,
  INDEX `idx_member_phone`   (`phone`),
  INDEX `idx_member_active`  (`is_active`, `created_at`),
  INDEX `idx_member_created` (`created_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ── 6.2 member_sessions ──────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS `member_sessions` (
  `token_hash`   VARCHAR(64) NOT NULL PRIMARY KEY,
  `member_id`    BIGINT NOT NULL,
  `created_at`   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `expires_at`   DATETIME NOT NULL,
  `last_seen_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `ip_address`   VARCHAR(45),
  `user_agent`   VARCHAR(255),
  FOREIGN KEY (`member_id`) REFERENCES `members`(`id`) ON DELETE CASCADE,
  INDEX `idx_member_session_expires` (`member_id`, `expires_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ── 6.4 member_rewards (dibuat sebelum claims karena FK) ──────────────────────
CREATE TABLE IF NOT EXISTS `member_rewards` (
  `id`                       BIGINT AUTO_INCREMENT PRIMARY KEY,
  `name`                     VARCHAR(255) NOT NULL,
  `description`              TEXT,
  `image_url`                TEXT,
  `cost_point`               INT NOT NULL,
  `reward_type`              ENUM('free_product','discount_amount','discount_percent','other') NOT NULL,
  `reward_product_id`        INT DEFAULT NULL,
  `reward_variant_id`        INT DEFAULT NULL,
  `discount_value`           DECIMAL(12,2) DEFAULT NULL,
  `quota_total`              INT DEFAULT NULL,
  `quota_used`               INT NOT NULL DEFAULT 0,
  `quota_per_member`         INT DEFAULT NULL,
  `valid_from`               DATETIME DEFAULT NULL,
  `valid_until`              DATETIME DEFAULT NULL,
  `branch_scope`             ENUM('all','specific') NOT NULL DEFAULT 'all',
  `branch_ids`               JSON,
  `requires_admin_approval`  TINYINT(1) NOT NULL DEFAULT 0,
  `terms_and_conditions`     TEXT,
  `is_active`                TINYINT(1) NOT NULL DEFAULT 1,
  `created_by_user_id`       BIGINT,
  `created_at`               DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at`               DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  `deleted_at`               DATETIME DEFAULT NULL,
  FOREIGN KEY (`reward_product_id`)  REFERENCES `products`(`id`)         ON DELETE SET NULL,
  FOREIGN KEY (`reward_variant_id`)  REFERENCES `product_variants`(`id`) ON DELETE SET NULL,
  FOREIGN KEY (`created_by_user_id`) REFERENCES `users`(`id`),
  INDEX `idx_reward_active` (`is_active`, `valid_until`),
  INDEX `idx_reward_cost`   (`cost_point`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ── 6.5 member_reward_claims ─────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS `member_reward_claims` (
  `id`                    BIGINT AUTO_INCREMENT PRIMARY KEY,
  `member_id`             BIGINT NOT NULL,
  `reward_id`             BIGINT NOT NULL,
  `redemption_code`       VARCHAR(20) NOT NULL UNIQUE,
  `redemption_qr_token`   VARCHAR(128) NOT NULL,
  `cost_point`            INT NOT NULL,
  `status`                ENUM('pending_approval','redeemable','redeemed','cancelled','expired') NOT NULL DEFAULT 'redeemable',
  `transaction_id`        INT DEFAULT NULL,
  `redeemed_by_user_id`   BIGINT DEFAULT NULL,
  `redeemed_at_branch_id` BIGINT DEFAULT NULL,
  `claimed_at`            DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `expires_at`            DATETIME NOT NULL,
  `approved_at`           DATETIME DEFAULT NULL,
  `approved_by_user_id`   BIGINT DEFAULT NULL,
  `redeemed_at`           DATETIME DEFAULT NULL,
  `cancelled_at`          DATETIME DEFAULT NULL,
  `cancel_reason`         TEXT,
  `notes`                 TEXT,
  FOREIGN KEY (`member_id`)             REFERENCES `members`(`id`),
  FOREIGN KEY (`reward_id`)             REFERENCES `member_rewards`(`id`),
  FOREIGN KEY (`transaction_id`)        REFERENCES `transactions`(`id`),
  FOREIGN KEY (`redeemed_by_user_id`)   REFERENCES `users`(`id`),
  FOREIGN KEY (`redeemed_at_branch_id`) REFERENCES `branches`(`id`),
  FOREIGN KEY (`approved_by_user_id`)   REFERENCES `users`(`id`),
  INDEX `idx_claim_member` (`member_id`, `status`),
  INDEX `idx_claim_status` (`status`, `expires_at`),
  INDEX `idx_claim_reward` (`reward_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ── 6.3 member_point_ledger ⭐ (append-only) ─────────────────────────────────
CREATE TABLE IF NOT EXISTS `member_point_ledger` (
  `id`                     BIGINT AUTO_INCREMENT PRIMARY KEY,
  `member_id`              BIGINT NOT NULL,
  `branch_id`              BIGINT,
  `transaction_id`         INT DEFAULT NULL,
  `reward_claim_id`        BIGINT DEFAULT NULL,
  `movement_type`          VARCHAR(50) NOT NULL,
  `direction`              ENUM('in','out','none') NOT NULL,
  `points`                 INT NOT NULL,
  `balance_active_before`  BIGINT NOT NULL,
  `balance_active_after`   BIGINT NOT NULL,
  `balance_pending_before` BIGINT NOT NULL,
  `balance_pending_after`  BIGINT NOT NULL,
  `expires_at`             DATETIME DEFAULT NULL,
  `reason`                 TEXT,
  `source_table`           VARCHAR(50),
  `source_id`              VARCHAR(100),
  `created_by_user_id`     BIGINT,
  `created_at`             DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `metadata`               JSON,
  FOREIGN KEY (`member_id`)          REFERENCES `members`(`id`),
  FOREIGN KEY (`branch_id`)          REFERENCES `branches`(`id`),
  FOREIGN KEY (`transaction_id`)     REFERENCES `transactions`(`id`),
  FOREIGN KEY (`reward_claim_id`)    REFERENCES `member_reward_claims`(`id`),
  FOREIGN KEY (`created_by_user_id`) REFERENCES `users`(`id`),
  UNIQUE KEY `uq_ledger_source` (`source_table`, `source_id`, `movement_type`),
  INDEX `idx_ledger_member_date` (`member_id`, `created_at`),
  INDEX `idx_ledger_tx`          (`transaction_id`),
  INDEX `idx_ledger_movement`    (`movement_type`, `created_at`),
  INDEX `idx_ledger_expires`     (`expires_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ── 6.6 member_fraud_flags ───────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS `member_fraud_flags` (
  `id`                  BIGINT AUTO_INCREMENT PRIMARY KEY,
  `member_id`           BIGINT,
  `staff_user_id`       BIGINT,
  `transaction_id`      INT DEFAULT NULL,
  `flag_type`           VARCHAR(80) NOT NULL,
  `severity`            ENUM('low','medium','high','critical') NOT NULL DEFAULT 'medium',
  `risk_score`          INT NOT NULL DEFAULT 50,
  `detected_at`         DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `evidence`            JSON,
  `status`              ENUM('open','acknowledged','dismissed','action_taken') NOT NULL DEFAULT 'open',
  `reviewed_by_user_id` BIGINT DEFAULT NULL,
  `reviewed_at`         DATETIME DEFAULT NULL,
  `resolution_note`     TEXT,
  FOREIGN KEY (`member_id`)           REFERENCES `members`(`id`),
  FOREIGN KEY (`staff_user_id`)       REFERENCES `users`(`id`),
  FOREIGN KEY (`transaction_id`)      REFERENCES `transactions`(`id`),
  FOREIGN KEY (`reviewed_by_user_id`) REFERENCES `users`(`id`),
  INDEX `idx_flag_status_severity` (`status`, `severity`, `detected_at`),
  INDEX `idx_flag_member`          (`member_id`),
  INDEX `idx_flag_staff`           (`staff_user_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ── 6.7 member_settings ──────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS `member_settings` (
  `setting_key`        VARCHAR(80) NOT NULL PRIMARY KEY,
  `setting_value`      TEXT NOT NULL,
  `value_type`         ENUM('int','decimal','bool','string','json') NOT NULL DEFAULT 'string',
  `description`        TEXT,
  `updated_by_user_id` BIGINT,
  `updated_at`         DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  FOREIGN KEY (`updated_by_user_id`) REFERENCES `users`(`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ── Seed default settings (§6.7) ─────────────────────────────────────────────
INSERT IGNORE INTO `member_settings` (`setting_key`,`setting_value`,`value_type`,`description`) VALUES
  ('enable_loyalty_module','0','bool','Master switch fitur member'),
  ('point_ratio_rupiah_per_point','10000','int','Setiap N rupiah = 1 point'),
  ('point_rounding_mode','floor','string','floor|round|ceil'),
  ('min_transaction_for_point','0','int','Minimum total transaksi agar dapat point'),
  ('max_point_per_transaction','1000','int','Batas atas point per transaksi'),
  ('max_point_per_member_per_day','50','int','Anti-fraud: batas point per member per hari'),
  ('point_validity_days','365','int','Masa berlaku point dalam hari, 0=unlimited'),
  ('point_pending_window_hours','24','int','Jam pending sebelum aktif'),
  ('excluded_product_ids','[]','json','Array product_id yang tidak dapat point'),
  ('excluded_category_ids','[]','json','Array category_id yang tidak dapat point'),
  ('point_on_reward_transaction','0','bool','Apakah transaksi yang mengandung reward dapat point'),
  ('member_late_attach_window_minutes','5','int','Anti-fraud: window attach member setelah transaksi selesai'),
  ('max_attached_tx_per_cashier_per_day','50','int','Anti-fraud: batas attach member per kasir per hari'),
  ('claim_validity_days','30','int','Masa berlaku kode klaim reward dalam hari'),
  ('require_qr_scan_for_member','0','bool','Wajib scan QR (bukan input HP manual)');

-- ── 6.9 Modifikasi tabel existing (idempotent via prosedur) ──────────────────
DROP PROCEDURE IF EXISTS `__rbn_add_col_064`;
DELIMITER //
CREATE PROCEDURE `__rbn_add_col_064`(
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

CALL `__rbn_add_col_064`('transactions','member_id','BIGINT DEFAULT NULL');
CALL `__rbn_add_col_064`('transactions','member_attached_at','DATETIME DEFAULT NULL');
CALL `__rbn_add_col_064`('transactions','points_awarded','INT NOT NULL DEFAULT 0');
CALL `__rbn_add_col_064`('transactions','reward_claim_id','BIGINT DEFAULT NULL');

-- Field anti-fraud staff (§14.2): nomor HP personal kasir
CALL `__rbn_add_col_064`('users','personal_phone','VARCHAR(20) DEFAULT NULL');

DROP PROCEDURE IF EXISTS `__rbn_add_col_064`;

-- ── Index & FK untuk kolom transactions baru (idempotent) ────────────────────
DROP PROCEDURE IF EXISTS `__rbn_add_idx_064`;
DELIMITER //
CREATE PROCEDURE `__rbn_add_idx_064`()
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM INFORMATION_SCHEMA.STATISTICS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'transactions' AND INDEX_NAME = 'idx_tx_member'
  ) THEN
    ALTER TABLE `transactions` ADD INDEX `idx_tx_member` (`member_id`, `created_at`);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM INFORMATION_SCHEMA.TABLE_CONSTRAINTS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'transactions' AND CONSTRAINT_NAME = 'fk_tx_member'
  ) THEN
    ALTER TABLE `transactions` ADD CONSTRAINT `fk_tx_member` FOREIGN KEY (`member_id`) REFERENCES `members`(`id`);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM INFORMATION_SCHEMA.TABLE_CONSTRAINTS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'transactions' AND CONSTRAINT_NAME = 'fk_tx_claim'
  ) THEN
    ALTER TABLE `transactions` ADD CONSTRAINT `fk_tx_claim` FOREIGN KEY (`reward_claim_id`) REFERENCES `member_reward_claims`(`id`);
  END IF;
END //
DELIMITER ;
CALL `__rbn_add_idx_064`();
DROP PROCEDURE IF EXISTS `__rbn_add_idx_064`;

-- ════════════════════════════════════════════════════════════════════════════
-- End migration 064
-- ════════════════════════════════════════════════════════════════════════════
