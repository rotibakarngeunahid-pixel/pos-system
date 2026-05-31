-- ══════════════════════════════════════════════════════════════════════════════
-- RBN POS — MySQL Schema untuk cPanel Hosting
-- Jalankan di phpMyAdmin atau MySQL console setelah membuat database
-- ══════════════════════════════════════════════════════════════════════════════

SET NAMES utf8mb4;
SET FOREIGN_KEY_CHECKS = 0;

-- ── branches ──────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS `branches` (
  `id`                       BIGINT AUTO_INCREMENT PRIMARY KEY,
  `name`                     VARCHAR(255) NOT NULL,
  `address`                  TEXT,
  `phone`                    VARCHAR(50),
  `is_active`                TINYINT(1) NOT NULL DEFAULT 1,
  `default_cash_position`    DECIMAL(15,2) NOT NULL DEFAULT 0,
  `default_cash_updated_at`  DATETIME,
  `default_cash_updated_by`  BIGINT,
  `created_at`               DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `deleted_at`               DATETIME DEFAULT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ── users ─────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS `users` (
  `id`                  BIGINT AUTO_INCREMENT PRIMARY KEY,
  `name`                VARCHAR(255) NOT NULL,
  `role`                ENUM('admin','owner','staff','investor') NOT NULL DEFAULT 'staff',
  `branch_id`           BIGINT DEFAULT NULL,
  `password`            VARCHAR(255),
  `is_active`           TINYINT(1) DEFAULT 1,
  `onboarding_status`   JSON,
  `created_at`          DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `deleted_at`          DATETIME DEFAULT NULL,
  FOREIGN KEY (`branch_id`) REFERENCES `branches`(`id`) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ── app_sessions ──────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS `app_sessions` (
  `token_hash`   VARCHAR(64) NOT NULL PRIMARY KEY,
  `user_id`      BIGINT NOT NULL,
  `created_at`   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `expires_at`   DATETIME NOT NULL,
  `last_seen_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE CASCADE,
  INDEX `idx_user_expires` (`user_id`, `expires_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `audit_logs` (
  `id`          BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  `user_id`     BIGINT NULL,
  `user_name`   VARCHAR(255) NULL,
  `user_role`   VARCHAR(50) NULL,
  `branch_id`   BIGINT NULL,
  `action`      VARCHAR(100) NOT NULL,
  `table_name`  VARCHAR(100) NULL,
  `old_data`    JSON NULL,
  `new_data`    JSON NULL,
  `ip_address`  VARCHAR(45) NULL,
  `user_agent`  VARCHAR(255) NULL,
  `created_at`  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX `idx_audit_user_time` (`user_id`, `created_at`),
  INDEX `idx_audit_branch_time` (`branch_id`, `created_at`),
  INDEX `idx_audit_action_time` (`action`, `created_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `api_rate_limits` (
  `id`           BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  `action_key`   VARCHAR(80) NOT NULL,
  `identity_key` VARCHAR(128) NOT NULL,
  `ip_address`   VARCHAR(45) NULL,
  `created_at`   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX `idx_rate_action_identity_time` (`action_key`, `identity_key`, `created_at`),
  INDEX `idx_rate_created_at` (`created_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ── product_categories ────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS `product_categories` (
  `id`         INT AUTO_INCREMENT PRIMARY KEY,
  `name`       VARCHAR(255) NOT NULL,
  `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ── products ──────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS `products` (
  `id`            INT AUTO_INCREMENT PRIMARY KEY,
  `name`          VARCHAR(255) NOT NULL,
  `category`      VARCHAR(255) DEFAULT NULL,
  `price`         DECIMAL(12,2) NOT NULL DEFAULT 0,
  `default_price` DECIMAL(12,2) DEFAULT NULL,
  `has_variants`  TINYINT(1) NOT NULL DEFAULT 1,
  `category_id`   INT DEFAULT NULL,
  `image_url`     TEXT,
  `is_active`     TINYINT(1) NOT NULL DEFAULT 1,
  `created_at`    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (`category_id`) REFERENCES `product_categories`(`id`) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ── product_variants ──────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS `product_variants` (
  `id`         INT AUTO_INCREMENT PRIMARY KEY,
  `product_id` INT NOT NULL,
  `name`       VARCHAR(255) NOT NULL,
  `price`      DECIMAL(12,2) NOT NULL DEFAULT 0,
  `is_active`  TINYINT(1) NOT NULL DEFAULT 1,
  `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (`product_id`) REFERENCES `products`(`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ── branch_products ───────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS `branch_products` (
  `id`         INT AUTO_INCREMENT PRIMARY KEY,
  `branch_id`  BIGINT NOT NULL,
  `product_id` INT NOT NULL,
  `is_active`  TINYINT(1) NOT NULL DEFAULT 1,
  UNIQUE KEY `uq_branch_product` (`branch_id`, `product_id`),
  FOREIGN KEY (`branch_id`)  REFERENCES `branches`(`id`)  ON DELETE CASCADE,
  FOREIGN KEY (`product_id`) REFERENCES `products`(`id`)  ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ── branch_variant_prices ─────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS `branch_variant_prices` (
  `id`         INT AUTO_INCREMENT PRIMARY KEY,
  `branch_id`  BIGINT NOT NULL,
  `variant_id` INT NOT NULL,
  `price`      DECIMAL(12,2) NOT NULL,
  UNIQUE KEY `uq_branch_variant` (`branch_id`, `variant_id`),
  FOREIGN KEY (`branch_id`)  REFERENCES `branches`(`id`)         ON DELETE CASCADE,
  FOREIGN KEY (`variant_id`) REFERENCES `product_variants`(`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ── payment_methods ───────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS `payment_methods` (
  `id`          INT AUTO_INCREMENT PRIMARY KEY,
  `code`        VARCHAR(50) NOT NULL UNIQUE,
  `label`       VARCHAR(100) NOT NULL,
  `icon`        VARCHAR(50),
  `fee_label`   VARCHAR(100),
  `fee_percent` DECIMAL(5,2) NOT NULL DEFAULT 0,
  `is_fee_enabled` TINYINT(1) NOT NULL DEFAULT 0,
  `is_active`   TINYINT(1) NOT NULL DEFAULT 1,
  `created_at`  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ── cashier_sessions ──────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS `cashier_sessions` (
  `id`                       BIGINT AUTO_INCREMENT PRIMARY KEY,
  `branch_id`                BIGINT NOT NULL,
  `staff_id`                 BIGINT NOT NULL,
  `status`                   ENUM('open','closed') NOT NULL DEFAULT 'open',
  `opening_cash`             DECIMAL(15,2) NOT NULL DEFAULT 0,
  `closing_cash`             DECIMAL(15,2),
  `expected_cash`            DECIMAL(15,2),
  `current_cash_amount`      DECIMAL(15,2),
  `opened_at`                DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `closed_at`                DATETIME,
  `opening_cash_source`      VARCHAR(50) DEFAULT 'manual',
  `opening_balance_id`       BIGINT,
  `opening_confirmed_at`     DATETIME,
  `opening_confirmed_by`     BIGINT,
  `opening_physical_cash`    DECIMAL(15,2),
  `opening_variance_amount`  DECIMAL(15,2),
  `opening_variance_reason`  TEXT,
  `balance_applied_at`       DATETIME,
  `balance_ledger_id`        BIGINT,
  `created_at`               DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (`branch_id`) REFERENCES `branches`(`id`),
  FOREIGN KEY (`staff_id`)  REFERENCES `users`(`id`),
  INDEX `idx_branch_status` (`branch_id`, `status`),
  INDEX `idx_staff_status`  (`staff_id`, `status`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ── transactions ──────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS `transactions` (
  `id`              INT AUTO_INCREMENT PRIMARY KEY,
  `branch_id`       BIGINT NOT NULL,
  `staff_id`        BIGINT,
  `session_id`      BIGINT,
  `payment_method`  VARCHAR(50),
  `payment_amount`  DECIMAL(15,2),
  `subtotal`        DECIMAL(15,2) NOT NULL DEFAULT 0,
  `discount_amount` DECIMAL(15,2) NOT NULL DEFAULT 0,
  `tax_amount`      DECIMAL(15,2) NOT NULL DEFAULT 0,
  `fee_amount`      DECIMAL(15,2) NOT NULL DEFAULT 0,
  `total`           DECIMAL(15,2) NOT NULL,
  `change_amount`   DECIMAL(15,2),
  `notes`           TEXT,
  `status`          ENUM('completed','voided','refunded') NOT NULL DEFAULT 'completed',
  `client_tx_id`    VARCHAR(100),
  `created_at`      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (`branch_id`)  REFERENCES `branches`(`id`),
  FOREIGN KEY (`staff_id`)   REFERENCES `users`(`id`),
  FOREIGN KEY (`session_id`) REFERENCES `cashier_sessions`(`id`),
  INDEX `idx_branch_date`  (`branch_id`, `created_at`),
  INDEX `idx_status_date`  (`status`, `created_at`),
  INDEX `idx_client_tx_id` (`client_tx_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ── transaction_items ─────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS `transaction_items` (
  `id`             INT AUTO_INCREMENT PRIMARY KEY,
  `transaction_id` INT NOT NULL,
  `product_id`     INT,
  `variant_id`     INT,
  `product_name`   VARCHAR(255),
  `variant_name`   VARCHAR(255),
  `quantity`       INT NOT NULL DEFAULT 1,
  `price`          DECIMAL(12,2) NOT NULL,
  `subtotal`       DECIMAL(12,2) NOT NULL,
  `notes`          TEXT,
  FOREIGN KEY (`transaction_id`) REFERENCES `transactions`(`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ── refund_transactions ───────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS `refund_transactions` (
  `id`             INT AUTO_INCREMENT PRIMARY KEY,
  `transaction_id` INT NOT NULL,
  `reason`         TEXT,
  `amount`         DECIMAL(15,2),
  `refunded_by`    BIGINT,
  `created_at`     DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (`transaction_id`) REFERENCES `transactions`(`id`),
  FOREIGN KEY (`refunded_by`)    REFERENCES `users`(`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ── cash_categories ───────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS `cash_categories` (
  `id`         INT AUTO_INCREMENT PRIMARY KEY,
  `name`       VARCHAR(255) NOT NULL,
  `type`       ENUM('in','out') NOT NULL,
  `is_active`  TINYINT(1) NOT NULL DEFAULT 1,
  `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ── cash_logs ─────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS `cash_logs` (
  `id`             INT AUTO_INCREMENT PRIMARY KEY,
  `branch_id`      BIGINT NOT NULL,
  `session_id`     BIGINT,
  `type`           ENUM('in','out') NOT NULL,
  `category_id`    INT,
  `amount`         DECIMAL(15,2) NOT NULL,
  `note`           TEXT,
  `created_by`     BIGINT,
  `reference_type` VARCHAR(50),
  `reference_id`   VARCHAR(100),
  `is_void`        TINYINT(1) NOT NULL DEFAULT 0,
  `void_reason`    TEXT,
  `void_by`        BIGINT,
  `void_at`        DATETIME,
  `created_at`     DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (`branch_id`)   REFERENCES `branches`(`id`),
  FOREIGN KEY (`session_id`)  REFERENCES `cashier_sessions`(`id`),
  FOREIGN KEY (`category_id`) REFERENCES `cash_categories`(`id`) ON DELETE SET NULL,
  INDEX `idx_branch_session` (`branch_id`, `session_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ── ingredients ───────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS `ingredients` (
  `id`         INT AUTO_INCREMENT PRIMARY KEY,
  `name`       VARCHAR(255) NOT NULL,
  `unit`       VARCHAR(50),
  `min_stock`  DECIMAL(10,3) NOT NULL DEFAULT 0,
  `is_active`  TINYINT(1) NOT NULL DEFAULT 1,
  `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ── suppliers ─────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS `suppliers` (
  `id`         INT AUTO_INCREMENT PRIMARY KEY,
  `name`       VARCHAR(255) NOT NULL,
  `phone`      VARCHAR(50),
  `address`    TEXT,
  `is_active`  TINYINT(1) NOT NULL DEFAULT 1,
  `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ── recipes ───────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS `recipes` (
  `id`         INT AUTO_INCREMENT PRIMARY KEY,
  `variant_id` INT NOT NULL,
  `name`       VARCHAR(255),
  `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (`variant_id`) REFERENCES `product_variants`(`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ── recipe_items ──────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS `recipe_items` (
  `id`            INT AUTO_INCREMENT PRIMARY KEY,
  `recipe_id`     INT NOT NULL,
  `ingredient_id` INT NOT NULL,
  `quantity`      DECIMAL(10,3) NOT NULL DEFAULT 1,
  FOREIGN KEY (`recipe_id`)     REFERENCES `recipes`(`id`)     ON DELETE CASCADE,
  FOREIGN KEY (`ingredient_id`) REFERENCES `ingredients`(`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ── branch_inventory ──────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS `branch_inventory` (
  `id`            INT AUTO_INCREMENT PRIMARY KEY,
  `branch_id`     BIGINT NOT NULL,
  `ingredient_id` INT NOT NULL,
  `stock`         DECIMAL(10,3) NOT NULL DEFAULT 0,
  `updated_at`    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY `uq_branch_ingredient` (`branch_id`, `ingredient_id`),
  FOREIGN KEY (`branch_id`)     REFERENCES `branches`(`id`)    ON DELETE CASCADE,
  FOREIGN KEY (`ingredient_id`) REFERENCES `ingredients`(`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ── inventory_logs ────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS `inventory_logs` (
  `id`             INT AUTO_INCREMENT PRIMARY KEY,
  `branch_id`      BIGINT NOT NULL,
  `ingredient_id`  INT,
  `type`           VARCHAR(50),
  `quantity`       DECIMAL(10,3),
  `stock_before`   DECIMAL(10,3),
  `stock_after`    DECIMAL(10,3),
  `note`           TEXT,
  `created_by`     BIGINT,
  `reference_type` VARCHAR(50),
  `reference_id`   VARCHAR(100),
  `created_at`     DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (`branch_id`)     REFERENCES `branches`(`id`),
  FOREIGN KEY (`ingredient_id`) REFERENCES `ingredients`(`id`) ON DELETE SET NULL,
  INDEX `idx_branch_date`     (`branch_id`, `created_at`),
  INDEX `idx_ingredient_date` (`ingredient_id`, `created_at`),
  INDEX `idx_ref_type`        (`reference_type`, `created_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ── stock_transfers ───────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS `stock_transfers` (
  `id`             INT AUTO_INCREMENT PRIMARY KEY,
  `transfer_code`  VARCHAR(50) UNIQUE,
  `from_branch_id` BIGINT NOT NULL,
  `to_branch_id`   BIGINT NOT NULL,
  `status`         ENUM('pending','confirmed','rejected','cancelled') NOT NULL DEFAULT 'pending',
  `notes`          TEXT,
  `reject_reason`  TEXT,
  `cancel_reason`  TEXT,
  `requested_by`   BIGINT,
  `confirmed_by`   BIGINT,
  `rejected_by`    BIGINT,
  `cancelled_by`   BIGINT,
  `created_at`     DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at`     DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  FOREIGN KEY (`from_branch_id`) REFERENCES `branches`(`id`),
  FOREIGN KEY (`to_branch_id`)   REFERENCES `branches`(`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ── stock_transfer_items ──────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS `stock_transfer_items` (
  `id`            INT AUTO_INCREMENT PRIMARY KEY,
  `transfer_id`   INT NOT NULL,
  `ingredient_id` INT NOT NULL,
  `quantity`      DECIMAL(10,3) NOT NULL,
  FOREIGN KEY (`transfer_id`)   REFERENCES `stock_transfers`(`id`) ON DELETE CASCADE,
  FOREIGN KEY (`ingredient_id`) REFERENCES `ingredients`(`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ── investor_branch_access ────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS `investor_branch_access` (
  `id`        INT AUTO_INCREMENT PRIMARY KEY,
  `user_id`   BIGINT NOT NULL,
  `branch_id` BIGINT NOT NULL,
  UNIQUE KEY `uq_investor_branch` (`user_id`, `branch_id`),
  FOREIGN KEY (`user_id`)   REFERENCES `users`(`id`)    ON DELETE CASCADE,
  FOREIGN KEY (`branch_id`) REFERENCES `branches`(`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ── investor_feature_access ───────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS `investor_feature_access` (
  `id`          INT AUTO_INCREMENT PRIMARY KEY,
  `user_id`     BIGINT NOT NULL,
  `feature_key` VARCHAR(100) NOT NULL,
  `allowed`     TINYINT(1) NOT NULL DEFAULT 1,
  UNIQUE KEY `uq_investor_feature` (`user_id`, `feature_key`),
  FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ── deposit_accounts ──────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS `deposit_accounts` (
  `id`             CHAR(36) NOT NULL PRIMARY KEY,
  `branch_id`      BIGINT,
  `type`           ENUM('bank','qris','cash') NOT NULL,
  `label`          VARCHAR(255) NOT NULL,
  `bank_name`      VARCHAR(100),
  `account_number` VARCHAR(100),
  `account_holder` VARCHAR(255),
  `qris_image_url` TEXT,
  `is_active`      TINYINT(1) NOT NULL DEFAULT 1,
  `created_at`     DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (`branch_id`) REFERENCES `branches`(`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ── cash_deposits ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS `cash_deposits` (
  `id`                CHAR(36) NOT NULL PRIMARY KEY,
  `branch_id`         BIGINT NOT NULL,
  `staff_id`          BIGINT,
  `session_id`        BIGINT,
  `account_id`        CHAR(36),
  `amount`            DECIMAL(15,2) NOT NULL,
  `cash_balance_at_deposit` DECIMAL(15,2),
  `method`            VARCHAR(50),
  `proof_url`         TEXT,
  `proof_file_name`   VARCHAR(255),
  `proof_file_type`   VARCHAR(50),
  `proof_file_size`   BIGINT,
  `proof_uploaded_at` DATETIME,
  `notes`             TEXT,
  `status`            ENUM('pending','confirmed','rejected') NOT NULL DEFAULT 'pending',
  `reviewed_by`       BIGINT,
  `reviewed_at`       DATETIME,
  `reject_reason`     TEXT,
  `balance_applied_at` DATETIME,
  `balance_ledger_id`  BIGINT,
  `created_at`        DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (`branch_id`)  REFERENCES `branches`(`id`),
  FOREIGN KEY (`staff_id`)   REFERENCES `users`(`id`),
  FOREIGN KEY (`session_id`) REFERENCES `cashier_sessions`(`id`),
  INDEX `idx_branch_status` (`branch_id`, `status`),
  INDEX `idx_staff_status`  (`staff_id`, `status`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ── staff_cash_balances ───────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS `staff_cash_balances` (
  `id`                     BIGINT AUTO_INCREMENT PRIMARY KEY,
  `branch_id`              BIGINT NOT NULL,
  `staff_id`               BIGINT NOT NULL,
  `current_balance`        DECIMAL(15,2) NOT NULL DEFAULT 0,
  `last_cash_session_id`   BIGINT,
  `last_ledger_id`         BIGINT,
  `pending_deposit_amount` DECIMAL(15,2) NOT NULL DEFAULT 0,
  `version`                BIGINT NOT NULL DEFAULT 1,
  `created_at`             DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at`             DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  `updated_by`             BIGINT,
  UNIQUE KEY `uq_branch_staff` (`branch_id`, `staff_id`),
  FOREIGN KEY (`branch_id`) REFERENCES `branches`(`id`),
  FOREIGN KEY (`staff_id`)  REFERENCES `users`(`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ── staff_cash_ledger ─────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS `staff_cash_ledger` (
  `id`             BIGINT AUTO_INCREMENT PRIMARY KEY,
  `branch_id`      BIGINT NOT NULL,
  `staff_id`       BIGINT NOT NULL,
  `cash_session_id` BIGINT,
  `deposit_id`     CHAR(36),
  `movement_type`  VARCHAR(50) NOT NULL,
  `direction`      ENUM('in','out','adjust','none') NOT NULL,
  `amount`         DECIMAL(15,2) NOT NULL DEFAULT 0,
  `balance_before` DECIMAL(15,2) NOT NULL,
  `balance_after`  DECIMAL(15,2) NOT NULL,
  `reason`         TEXT,
  `source_table`   VARCHAR(100),
  `source_id`      VARCHAR(100),
  `created_by`     BIGINT,
  `approved_by`    BIGINT,
  `created_at`     DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `metadata`       JSON,
  UNIQUE KEY `uq_source` (`source_table`(50), `source_id`(100), `movement_type`(50)),
  FOREIGN KEY (`branch_id`) REFERENCES `branches`(`id`),
  FOREIGN KEY (`staff_id`)  REFERENCES `users`(`id`),
  INDEX `idx_staff_date` (`staff_id`, `created_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ── branch_cash_balances ──────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS `branch_cash_balances` (
  `id`                      BIGINT AUTO_INCREMENT PRIMARY KEY,
  `branch_id`               BIGINT NOT NULL,
  `current_balance`         DECIMAL(15,2) NOT NULL DEFAULT 0,
  `current_status`          ENUM('idle','active','needs_review') NOT NULL DEFAULT 'idle',
  `last_open_session_id`    BIGINT,
  `last_closed_session_id`  BIGINT,
  `last_opened_by`          BIGINT,
  `last_closed_by`          BIGINT,
  `last_ledger_id`          BIGINT,
  `last_movement_type`      VARCHAR(50),
  `version`                 BIGINT NOT NULL DEFAULT 1,
  `created_at`              DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at`              DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  `updated_by`              BIGINT,
  UNIQUE KEY `uq_branch` (`branch_id`),
  FOREIGN KEY (`branch_id`) REFERENCES `branches`(`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ── branch_cash_ledger ────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS `branch_cash_ledger` (
  `id`               BIGINT AUTO_INCREMENT PRIMARY KEY,
  `branch_id`        BIGINT NOT NULL,
  `staff_id`         BIGINT,
  `admin_id`         BIGINT,
  `cash_session_id`  BIGINT,
  `deposit_id`       CHAR(36),
  `transfer_id`      CHAR(36),
  `movement_type`    VARCHAR(50) NOT NULL,
  `direction`        ENUM('in','out','adjust','none') NOT NULL,
  `amount`           DECIMAL(15,2) NOT NULL DEFAULT 0,
  `balance_before`   DECIMAL(15,2) NOT NULL,
  `balance_after`    DECIMAL(15,2) NOT NULL,
  `expected_balance` DECIMAL(15,2),
  `variance_amount`  DECIMAL(15,2),
  `reason`           TEXT,
  `source_table`     VARCHAR(100),
  `source_id`        VARCHAR(100),
  `created_at`       DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `metadata`         JSON,
  UNIQUE KEY `uq_source` (`source_table`(50), `source_id`(100), `movement_type`(50)),
  FOREIGN KEY (`branch_id`) REFERENCES `branches`(`id`),
  INDEX `idx_branch_date` (`branch_id`, `created_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ── cash_branch_transfers ─────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS `cash_branch_transfers` (
  `id`                           CHAR(36) NOT NULL PRIMARY KEY,
  `transfer_code`                VARCHAR(50) NOT NULL UNIQUE,
  `from_branch_id`               BIGINT NOT NULL,
  `to_branch_id`                 BIGINT NOT NULL,
  `session_id`                   BIGINT NOT NULL,
  `staff_id`                     BIGINT NOT NULL,
  `requested_by`                 BIGINT NOT NULL,
  `requested_at`                 DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `amount`                       DECIMAL(15,2) NOT NULL,
  `cash_balance_at_request`      DECIMAL(15,2),
  `status`                       ENUM('pending','confirmed','rejected','cancelled') NOT NULL DEFAULT 'pending',
  `notes`                        TEXT,
  `reject_reason`                TEXT,
  `cancel_reason`                TEXT,
  `proof_url`                    TEXT,
  `proof_file_name`              VARCHAR(255),
  `proof_file_type`              VARCHAR(50),
  `proof_file_size`              BIGINT,
  `proof_uploaded_at`            DATETIME,
  `confirmed_by`                 BIGINT,
  `confirmed_at`                 DATETIME,
  `rejected_by`                  BIGINT,
  `rejected_at`                  DATETIME,
  `cancelled_by`                 BIGINT,
  `cancelled_at`                 DATETIME,
  `source_balance_before`        DECIMAL(15,2),
  `source_balance_after`         DECIMAL(15,2),
  `target_balance_before`        DECIMAL(15,2),
  `target_balance_after`         DECIMAL(15,2),
  `source_branch_cash_ledger_id` BIGINT,
  `target_branch_cash_ledger_id` BIGINT,
  `client_request_id`            VARCHAR(100),
  `created_at`                   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at`                   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  `metadata`                     JSON,
  FOREIGN KEY (`from_branch_id`) REFERENCES `branches`(`id`),
  FOREIGN KEY (`to_branch_id`)   REFERENCES `branches`(`id`),
  FOREIGN KEY (`session_id`)     REFERENCES `cashier_sessions`(`id`),
  FOREIGN KEY (`staff_id`)       REFERENCES `users`(`id`),
  INDEX `idx_from_date` (`from_branch_id`, `created_at`),
  INDEX `idx_to_status` (`to_branch_id`, `status`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ── toppings ──────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS `toppings` (
  `id`         INT AUTO_INCREMENT PRIMARY KEY,
  `name`       VARCHAR(255) NOT NULL,
  `price`      DECIMAL(12,2) NOT NULL DEFAULT 0,
  `is_active`  TINYINT(1) NOT NULL DEFAULT 1,
  `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ── product_toppings ──────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS `product_toppings` (
  `id`         INT AUTO_INCREMENT PRIMARY KEY,
  `product_id` INT NOT NULL,
  `topping_id` INT NOT NULL,
  UNIQUE KEY `uq_product_topping` (`product_id`, `topping_id`),
  FOREIGN KEY (`product_id`) REFERENCES `products`(`id`)  ON DELETE CASCADE,
  FOREIGN KEY (`topping_id`) REFERENCES `toppings`(`id`)  ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ── api_keys ──────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS `api_keys` (
  `id`         INT AUTO_INCREMENT PRIMARY KEY,
  `name`       VARCHAR(255) NOT NULL,
  `key_value`  VARCHAR(255) NOT NULL UNIQUE,
  `is_active`  TINYINT(1) NOT NULL DEFAULT 1,
  `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ── onboarding_assignments ────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS `onboarding_assignments` (
  `id`          INT AUTO_INCREMENT PRIMARY KEY,
  `user_id`     BIGINT NOT NULL,
  `assigned_by` BIGINT,
  `status`      VARCHAR(50) DEFAULT 'not_started',
  `started_at`  DATETIME,
  `completed_at` DATETIME,
  `created_at`  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ── onboarding_step_completions ───────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS `onboarding_step_completions` (
  `id`             INT AUTO_INCREMENT PRIMARY KEY,
  `assignment_id`  INT NOT NULL,
  `step_key`       VARCHAR(100) NOT NULL,
  `completed_at`   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY `uq_assignment_step` (`assignment_id`, `step_key`),
  FOREIGN KEY (`assignment_id`) REFERENCES `onboarding_assignments`(`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

SET FOREIGN_KEY_CHECKS = 1;

-- ── Seed Data: Cash Categories ────────────────────────────────────────────────
INSERT IGNORE INTO `cash_categories` (`name`, `type`) VALUES
  ('Penjualan Tunai',    'in'),
  ('Setoran Tunai',      'out'),
  ('Kas Masuk Lainnya',  'in'),
  ('Kas Keluar Lainnya', 'out'),
  ('Pengeluaran Operasional', 'out');

-- ── Seed Data: Payment Methods ────────────────────────────────────────────────
INSERT IGNORE INTO `payment_methods` (`code`, `label`, `icon`, `fee_percent`) VALUES
  ('cash',   'Tunai',   'banknote',      0),
  ('qris',   'QRIS',    'qr-code',       0),
  ('bca',    'BCA',     'credit-card',   0),
  ('mandiri','Mandiri', 'credit-card',   0),
  ('bni',    'BNI',     'credit-card',   0),
  ('bri',    'BRI',     'credit-card',   0),
  ('gopay',  'GoPay',   'smartphone',    0),
  ('ovo',    'OVO',     'smartphone',    0),
  ('dana',   'DANA',    'smartphone',    0),
  ('shopeepay','ShopeePay','smartphone', 0);
