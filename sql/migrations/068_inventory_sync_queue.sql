-- Migration 068: Sinkronisasi Event POS → Inventori (transfer & stok keluar)
--   + Dukungan transfer Inventori → POS yang idempoten.
--
-- Bagian dari PRD "Sinkronisasi Transfer Stok dan Stok Keluar POS - Inventori".
-- Aman dijalankan berulang (IF NOT EXISTS).
--
-- Catatan eksekusi: MySQL/MariaDB versi lama TIDAK mendukung
-- "ADD COLUMN IF NOT EXISTS". Jika server menolak, jalankan bagian ALTER
-- secara manual / hapus klausa IF NOT EXISTS-nya. cPanel MariaDB 10.3+ OK.

-- ─────────────────────────────────────────────────────────────
-- 1. Queue outbound POS → Inventori
--    POS commit dulu (stok/transfer), lalu kirim event ke Inventori.
--    Bila Inventori down, baris tetap 'pending'/'failed' untuk diretry.
-- ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS inventory_sync_queue (
  id            BIGINT AUTO_INCREMENT PRIMARY KEY,
  event_type    VARCHAR(50)  NOT NULL COMMENT 'stock_transfer | stock_transfer_status | stock_out',
  source_table  VARCHAR(50)  NOT NULL COMMENT 'tabel sumber (stock_transfers | inventory_logs)',
  source_id     VARCHAR(100) NOT NULL COMMENT 'id baris sumber (+suffix status bila perlu)',
  endpoint      VARCHAR(120) NOT NULL COMMENT 'path Inventori, mis. /integration/pos/stock-transfer',
  payload       JSON         NOT NULL,
  status        ENUM('pending','processing','applied','failed','skipped') NOT NULL DEFAULT 'pending',
  attempts      INT          NOT NULL DEFAULT 0,
  last_error    TEXT         NULL,
  next_retry_at DATETIME     NULL,
  created_at    DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at    DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_inventory_sync_source (event_type, source_table, source_id),
  KEY idx_status_retry (status, next_retry_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ─────────────────────────────────────────────────────────────
-- 2. stock_transfers: lacak transfer yang BERASAL dari Inventori
--    agar RPC sync_inventory_stock_transfer idempoten (tidak dobel).
-- ─────────────────────────────────────────────────────────────
ALTER TABLE stock_transfers
  ADD COLUMN IF NOT EXISTS source_system   VARCHAR(30)  NULL AFTER cancelled_by,
  ADD COLUMN IF NOT EXISTS source_event_id VARCHAR(100) NULL AFTER source_system;

-- Unique key idempotency (source_system, source_event_id). Diberi nama agar
-- bisa di-drop bila perlu. Jika kolom NULL keduanya (transfer biasa POS), MySQL
-- mengizinkan banyak baris NULL pada UNIQUE — jadi tidak mengganggu transfer POS biasa.
ALTER TABLE stock_transfers
  ADD UNIQUE KEY IF NOT EXISTS uq_stock_transfer_source (source_system, source_event_id);
