-- Migration 063: Index tambahan untuk endpoint get_buduk_calculator_integration
-- Idempotent: cek INFORMATION_SCHEMA sebelum tambah index

SET @dbname = DATABASE();

-- Index transactions: branch_id + status + payment_method + created_at
SET @idx1 = (
    SELECT COUNT(*) FROM INFORMATION_SCHEMA.STATISTICS
    WHERE TABLE_SCHEMA = @dbname
      AND TABLE_NAME   = 'transactions'
      AND INDEX_NAME   = 'idx_transactions_branch_status_method_date'
);
SET @sql1 = IF(
    @idx1 = 0,
    'ALTER TABLE transactions ADD INDEX idx_transactions_branch_status_method_date (branch_id, status, payment_method, created_at)',
    'SELECT ''index idx_transactions_branch_status_method_date already exists'''
);
PREPARE stmt1 FROM @sql1;
EXECUTE stmt1;
DEALLOCATE PREPARE stmt1;

-- Index cash_logs: branch_id + reference_type + type + is_void + created_at
SET @idx2 = (
    SELECT COUNT(*) FROM INFORMATION_SCHEMA.STATISTICS
    WHERE TABLE_SCHEMA = @dbname
      AND TABLE_NAME   = 'cash_logs'
      AND INDEX_NAME   = 'idx_cash_logs_branch_ref_type_void_date'
);
SET @sql2 = IF(
    @idx2 = 0,
    'ALTER TABLE cash_logs ADD INDEX idx_cash_logs_branch_ref_type_void_date (branch_id, reference_type, type, is_void, created_at)',
    'SELECT ''index idx_cash_logs_branch_ref_type_void_date already exists'''
);
PREPARE stmt2 FROM @sql2;
EXECUTE stmt2;
DEALLOCATE PREPARE stmt2;
