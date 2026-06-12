-- Migration 065: Bukti Stok Keluar Staff (MySQL / cPanel)
-- Stok keluar oleh staff kini dibatasi hanya 2 alasan:
--   'roti_berjamur' → wajib foto bukti realtime dari kamera (evidence_photo_url)
--   'roti_hilang'   → wajib kronologi kejadian tertulis (chronology)
-- Kolom baru di inventory_logs untuk menyimpan bukti tersebut.

ALTER TABLE inventory_logs
  ADD COLUMN reason             VARCHAR(30)  NULL AFTER reference_id,
  ADD COLUMN evidence_photo_url VARCHAR(500) NULL AFTER reason,
  ADD COLUMN chronology         TEXT         NULL AFTER evidence_photo_url;
