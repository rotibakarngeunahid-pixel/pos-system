-- ══════════════════════════════════════════════════════════════════════════════
-- Migration 057: Fix Riwayat Kas Outlet
-- Tanggal: 2026-05-29
-- Masalah yang diperbaiki:
--   1. admin_adjustment ke-2+ untuk branch yang sama diam-diam discarded oleh
--      INSERT IGNORE karena UNIQUE KEY (source_table, source_id, movement_type)
--      dan source_id = branch_id yang static.
--      FIX: kode PHP sekarang menggunakan uuid4() sebagai source_id sehingga
--           setiap koreksi admin menghasilkan row unik.
--   2. rpc_get_branch_cash_ledger hanya membaca branch_cash_ledger, tidak
--      membaca cash_logs. Penjualan tunai, kas masuk/keluar manual, void, dan
--      refund (yang disimpan di cash_logs) tidak pernah muncul di riwayat.
--      FIX: query diperluas dengan UNION ke cash_logs.
--   3. rpc_refund_transaction tidak mencatat apapun ke cash_logs/ledger.
--      FIX: ditambahkan INSERT ke cash_logs untuk refund tunai.
-- ══════════════════════════════════════════════════════════════════════════════

-- ── Pastikan kategori "Refund" ada di cash_categories ────────────────────────
-- Dibutuhkan agar rpc_refund_transaction bisa menyimpan cash_log refund
-- dengan category_id yang benar.
INSERT IGNORE INTO `cash_categories` (`name`, `type`)
VALUES ('Refund', 'out');

-- ── Catatan: tidak ada perubahan skema tabel yang diperlukan ─────────────────
-- UNIQUE KEY `uq_source` di branch_cash_ledger TETAP ada dan masih valid.
-- Bug lama bukan pada definisi unique key, melainkan pada nilai source_id
-- yang dikirim oleh PHP (static branch_id → sekarang uuid4()).
--
-- Untuk melihat riwayat koreksi admin lama yang TERSIMPAN (sebelum fix),
-- jalankan query berikut (informasional, tidak wajib):
--
-- SELECT * FROM branch_cash_ledger
-- WHERE movement_type = 'admin_adjustment'
-- ORDER BY created_at DESC;
--
-- Row yang ada di sana adalah koreksi PERTAMA per branch (yang berhasil masuk).
-- Koreksi ke-2 dan seterusnya (sebelum fix) memang tidak tersimpan.
-- Tidak perlu data recovery kecuali audit history mewajibkannya.

-- ── Selesai ───────────────────────────────────────────────────────────────────
SELECT 'Migration 057 applied successfully' AS status;
