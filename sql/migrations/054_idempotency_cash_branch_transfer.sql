-- Migration 054: Tambah UNIQUE INDEX client_request_id di cash_branch_transfers
-- Mencegah insert duplikat saat double-click / retry network
-- Aman dijalankan berulang kali (IF NOT EXISTS)

-- Pastikan tidak ada duplikat sebelum menambah UNIQUE constraint
-- Jika ada duplikat, query ini akan GAGAL — periksa data terlebih dahulu.
-- SELECT client_request_id, COUNT(*) FROM cash_branch_transfers
--   WHERE client_request_id IS NOT NULL
--   GROUP BY client_request_id HAVING COUNT(*) > 1;

ALTER TABLE cash_branch_transfers
    MODIFY COLUMN client_request_id VARCHAR(100) NULL;

-- Tambah UNIQUE INDEX (hanya untuk nilai NON-NULL agar backward compatible)
-- MySQL mengizinkan multiple NULL dalam UNIQUE INDEX — aman.
CREATE UNIQUE INDEX IF NOT EXISTS uq_cash_branch_transfer_client_req_id
    ON cash_branch_transfers (client_request_id);
