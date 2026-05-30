-- Migration 059: Proteksi transaksi double
-- 1. Tambah UNIQUE INDEX pada client_tx_id di tabel transactions
--    MySQL mengizinkan multiple NULL dalam UNIQUE INDEX sehingga backward-compatible.
-- 2. Tambah composite INDEX untuk deteksi duplikat berbasis konten (branch+staff+session+total+waktu).
-- Aman dijalankan berulang kali (IF NOT EXISTS).

-- UNIQUE INDEX: jika clientTxId yang sama dikirim dua kali, INSERT kedua akan gagal
-- dan backend idempotency check (SELECT sebelum INSERT) menangkap ini lebih awal.
CREATE UNIQUE INDEX IF NOT EXISTS uq_transactions_client_tx_id
    ON transactions (client_tx_id);

-- Composite INDEX: mempercepat query deteksi duplikat berbasis konten
-- (branch_id, staff_id, session_id, total, created_at, status)
CREATE INDEX IF NOT EXISTS idx_transactions_dup_check
    ON transactions (branch_id, staff_id, session_id, total, created_at, status);
