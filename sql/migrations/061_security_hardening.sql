-- Migration 061: Security hardening for POS API
-- Adds audit logging and generic API/RPC rate-limit storage.
-- Run after migration 060.

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

-- Strengthen idempotency if migration 059 has not been run yet.
SET @has_uq_client_tx := (
  SELECT COUNT(*)
  FROM INFORMATION_SCHEMA.STATISTICS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'transactions'
    AND INDEX_NAME = 'uq_transactions_client_tx_id'
);

SET @add_uq_client_tx_sql := IF(
  @has_uq_client_tx = 0,
  'CREATE UNIQUE INDEX uq_transactions_client_tx_id ON transactions (client_tx_id)',
  'SELECT 1'
);

PREPARE add_uq_client_tx_stmt FROM @add_uq_client_tx_sql;
EXECUTE add_uq_client_tx_stmt;
DEALLOCATE PREPARE add_uq_client_tx_stmt;

SELECT 'Migration 061 applied successfully' AS status;
