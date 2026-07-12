-- Migration 069: Bukti Foto Realtime + Auto-Approve untuk Transfer Stok & Transfer Kas Antar Outlet
-- Staff outlet pengirim kini wajib mengambil foto bukti langsung dari kamera (realtime,
-- bukan dari galeri) saat mengirim stok/kas ke outlet lain. Begitu foto terlampir,
-- transfer otomatis disetujui (auto-approve) tanpa perlu konfirmasi manual dari outlet
-- tujuan — stok/kas outlet tujuan langsung bertambah dalam transaksi yang sama.

ALTER TABLE stock_transfers
  ADD COLUMN evidence_photo_url VARCHAR(500) NULL AFTER notes,
  ADD COLUMN auto_approved      TINYINT(1)   NOT NULL DEFAULT 0 AFTER status;

ALTER TABLE cash_branch_transfers
  ADD COLUMN auto_approved TINYINT(1) NOT NULL DEFAULT 0 AFTER status;
