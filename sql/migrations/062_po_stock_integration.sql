-- Migration 062: Integrasi Purchase Order ke Stok POS
-- Membuat tabel sync, mapping bahan, mapping outlet, dan tabel ignored.
-- Juga menambah kolom audit ke inventory_logs.

-- ─────────────────────────────────────────────────────────────
-- 1. Kolom tambahan di inventory_logs untuk audit PO sync
-- ─────────────────────────────────────────────────────────────
ALTER TABLE inventory_logs
  ADD COLUMN IF NOT EXISTS action_type    VARCHAR(60)  NULL AFTER reference_id,
  ADD COLUMN IF NOT EXISTS source_system  VARCHAR(30)  NULL AFTER action_type,
  ADD COLUMN IF NOT EXISTS source_po_id   VARCHAR(80)  NULL AFTER source_system,
  ADD COLUMN IF NOT EXISTS source_po_item_id VARCHAR(80) NULL AFTER source_po_id,
  ADD COLUMN IF NOT EXISTS actor_role     VARCHAR(20)  NULL AFTER source_po_item_id,
  ADD COLUMN IF NOT EXISTS sync_status    VARCHAR(40)  NULL AFTER actor_role;

-- ─────────────────────────────────────────────────────────────
-- 2. po_outlet_branch_mappings
--    Memetakan outlet di Supabase PO ke branch di MySQL POS
-- ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS po_outlet_branch_mappings (
  id              INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  po_outlet_id    VARCHAR(80)   NOT NULL COMMENT 'UUID outlet dari Supabase',
  po_outlet_name  VARCHAR(120)  NOT NULL,
  pos_branch_id   INT UNSIGNED  NOT NULL,
  pos_branch_name VARCHAR(120)  NOT NULL,
  is_active       TINYINT(1)    NOT NULL DEFAULT 1,
  created_by      INT UNSIGNED  NULL,
  created_at      DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at      DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_outlet_mapping (po_outlet_id),
  KEY idx_branch (pos_branch_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ─────────────────────────────────────────────────────────────
-- 3. po_material_pos_mappings
--    Memetakan material PO ke ingredient POS
-- ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS po_material_pos_mappings (
  id                   INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  po_material_id       VARCHAR(80)   NOT NULL COMMENT 'UUID material dari Supabase',
  po_material_name     VARCHAR(120)  NOT NULL,
  pos_ingredient_id    INT UNSIGNED  NOT NULL,
  pos_ingredient_name  VARCHAR(120)  NOT NULL,
  pos_branch_id        INT UNSIGNED  NULL COMMENT 'NULL = mapping global; isi = khusus cabang',
  conversion_factor    DECIMAL(14,6) NOT NULL DEFAULT 1.000000 COMMENT 'qty_pos = qty_po * conversion_factor',
  conversion_note      VARCHAR(255)  NULL,
  match_type           VARCHAR(20)   NOT NULL DEFAULT 'manual' COMMENT 'manual | exact_name',
  is_active            TINYINT(1)    NOT NULL DEFAULT 1,
  created_by           INT UNSIGNED  NULL,
  updated_by           INT UNSIGNED  NULL,
  created_at           DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at           DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  -- Tidak boleh ada dua mapping aktif untuk material+cabang yang sama
  UNIQUE KEY uq_material_branch (po_material_id, pos_branch_id),
  KEY idx_ingredient (pos_ingredient_id),
  KEY idx_active (is_active)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ─────────────────────────────────────────────────────────────
-- 4. po_ignored_materials
--    Bahan PO yang tidak perlu masuk stok POS
-- ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS po_ignored_materials (
  id               INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  po_material_id   VARCHAR(80)   NOT NULL,
  po_material_name VARCHAR(120)  NOT NULL,
  pos_branch_id    INT UNSIGNED  NULL COMMENT 'NULL = global; isi = khusus cabang',
  reason           VARCHAR(255)  NULL,
  is_active        TINYINT(1)    NOT NULL DEFAULT 1,
  created_by       INT UNSIGNED  NULL,
  created_at       DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_ignored_material (po_material_id, pos_branch_id),
  KEY idx_active (is_active)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ─────────────────────────────────────────────────────────────
-- 5. po_stock_sync_runs
--    Satu record per proses sinkronisasi PO
-- ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS po_stock_sync_runs (
  id                INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  po_id             VARCHAR(80)  NOT NULL COMMENT 'UUID PO dari Supabase',
  trigger_type      VARCHAR(40)  NOT NULL COMMENT 'po_received | po_revised | po_cancelled | manual_retry',
  status            VARCHAR(30)  NOT NULL DEFAULT 'pending' COMMENT 'pending | success | partial_success | failed',
  started_at        DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  finished_at       DATETIME     NULL,
  triggered_by      INT UNSIGNED NULL,
  triggered_by_role VARCHAR(20)  NULL,
  summary           TEXT         NULL,
  KEY idx_po_id (po_id),
  KEY idx_status (status),
  KEY idx_started (started_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ─────────────────────────────────────────────────────────────
-- 6. po_stock_sync_items
--    Status sinkronisasi per PO item, per cabang, per ingredient POS
-- ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS po_stock_sync_items (
  id                   INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  sync_run_id          INT UNSIGNED  NOT NULL,
  po_id                VARCHAR(80)   NOT NULL,
  po_item_id           VARCHAR(80)   NOT NULL,
  po_material_id       VARCHAR(80)   NULL,
  po_material_name     VARCHAR(120)  NULL,
  po_status            VARCHAR(30)   NULL COMMENT 'Status PO saat sync',
  po_item_source       VARCHAR(20)   NULL COMMENT 'ordered | adjustment',
  po_qty_received      DECIMAL(14,4) NULL,
  pos_branch_id        INT UNSIGNED  NULL,
  pos_ingredient_id    INT UNSIGNED  NULL,
  pos_ingredient_name  VARCHAR(120)  NULL,
  target_sync_qty      DECIMAL(14,4) NULL COMMENT 'Qty POS setelah konversi unit yang SEHARUSNYA masuk',
  previous_synced_qty  DECIMAL(14,4) NOT NULL DEFAULT 0 COMMENT 'Qty yang sudah pernah masuk sebelumnya',
  delta_qty            DECIMAL(14,4) NULL COMMENT 'target - previous; yang benar-benar diubah ke stok',
  inventory_log_id     INT UNSIGNED  NULL COMMENT 'FK ke inventory_logs.id',
  sync_status          VARCHAR(40)   NOT NULL DEFAULT 'belum_disinkronkan'
                       COMMENT 'belum_disinkronkan|sudah_disinkronkan|butuh_mapping_admin|butuh_alokasi_cabang|diabaikan_dari_stok_pos|direvisi|dibatalkan|gagal_sinkron|rollback_butuh_review_admin',
  error_message        TEXT          NULL,
  idempotency_key      VARCHAR(200)  NULL,
  created_at           DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at           DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  -- Mencegah stok double masuk untuk item+cabang yang sama
  UNIQUE KEY uq_po_item_branch (po_id, po_item_id, pos_branch_id),
  KEY idx_sync_run (sync_run_id),
  KEY idx_po (po_id),
  KEY idx_sync_status (sync_status),
  KEY idx_ingredient_branch (pos_ingredient_id, pos_branch_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ─────────────────────────────────────────────────────────────
-- 7. po_stock_sync_errors
--    Log error teknis dan bisnis per sync
-- ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS po_stock_sync_errors (
  id               INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  sync_run_id      INT UNSIGNED  NOT NULL,
  po_id            VARCHAR(80)   NULL,
  po_item_id       VARCHAR(80)   NULL,
  error_code       VARCHAR(60)   NULL,
  error_message    TEXT          NULL,
  payload_snapshot JSON          NULL,
  created_at       DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_sync_run (sync_run_id),
  KEY idx_po (po_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ─────────────────────────────────────────────────────────────
-- Verifikasi
-- ─────────────────────────────────────────────────────────────
SELECT 'Migration 062 selesai' AS result;
