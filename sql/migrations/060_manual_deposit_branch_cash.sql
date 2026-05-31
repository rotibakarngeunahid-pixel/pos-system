-- Migration 060: Manual deposit admin follows branch cash balance
-- Date: 2026-05-31
--
-- Manual deposits created by admin/owner are now based on the outlet cash
-- position, not on a selected staff member. Staff-submitted deposits still keep
-- staff_id, but admin manual deposit rows may store staff_id as NULL.

ALTER TABLE `cash_deposits`
  MODIFY COLUMN `staff_id` BIGINT NULL;

SET @has_cash_balance_at_deposit := (
  SELECT COUNT(*)
  FROM INFORMATION_SCHEMA.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'cash_deposits'
    AND COLUMN_NAME = 'cash_balance_at_deposit'
);

SET @add_cash_balance_at_deposit_sql := IF(
  @has_cash_balance_at_deposit = 0,
  'ALTER TABLE `cash_deposits` ADD COLUMN `cash_balance_at_deposit` DECIMAL(15,2) NULL AFTER `amount`',
  'SELECT 1'
);

PREPARE add_cash_balance_at_deposit_stmt FROM @add_cash_balance_at_deposit_sql;
EXECUTE add_cash_balance_at_deposit_stmt;
DEALLOCATE PREPARE add_cash_balance_at_deposit_stmt;

SELECT 'Migration 060 applied successfully' AS status;
