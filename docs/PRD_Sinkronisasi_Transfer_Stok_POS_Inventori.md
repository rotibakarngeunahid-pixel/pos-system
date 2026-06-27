# PRD: Sinkronisasi Transfer Stok dan Stok Keluar POS - Inventori

| Item | Nilai |
| --- | --- |
| Versi | 1.0 |
| Tanggal | 2026-06-28 |
| Status | Draft siap implementasi |
| Produk | RBN POS + Sistem Inventori |
| Area terdampak | `point_of_sales`, `inventori-new` |
| Stack terkait | POS: PHP 8 + MySQL + Vanilla JS. Inventori: Next.js 14/TypeScript + PostgreSQL/Supabase, dengan backend PHP legacy/opsional |

## 1. Ringkasan

Sistem POS dan Sistem Inventori saat ini sama-sama mencatat stok, tetapi belum semua mutasi stok tersinkron otomatis dua arah.

Kondisi yang sudah ada:

- POS mencatat stok per cabang di `branch_inventory` dan riwayatnya di `inventory_logs`.
- POS punya transfer v2: `stock_transfers` + `stock_transfer_items`, status `pending`, `confirmed`, `rejected`, `cancelled`.
- POS punya stok keluar staff via `adjust_stock_atomic` dengan `type = out`, alasan wajib `roti_berjamur` atau `roti_hilang`.
- Inventori mencatat laporan harian di `daily_reports`.
- Inventori mencatat transfer dari form staff di `transfer_log`, dan nilai transfer per bahan di `daily_reports.stock_transfer`.
- Inventori sudah punya mapping POS: `pos_cabang_mapping` dan `pos_bahan_mapping`.
- Jalur Inventori ke POS untuk stok akhir sudah ada di `inventori-new/src/server/posSync.ts`, memanggil POS RPC `sync_inventory_stock_count`.

Masalah yang perlu diselesaikan:

- Jika staff membuat transfer stok di POS, Inventori belum otomatis membuat catatan `transfer_log` atau mengisi bagian transfer stok.
- Jika staff mengisi transfer stok di Inventori, POS belum otomatis membuat `stock_transfers` dengan outlet asal/tujuan sesuai input staff.
- Jika staff mencatat stok keluar di POS, Inventori belum otomatis mencatat `stock_waste`/stok keluar pada laporan harian.
- Tanpa idempotency dan sumber event yang jelas, fitur sinkronisasi berisiko menggandakan pengurangan stok.

## 2. Tujuan

1. Transfer stok yang dibuat di POS otomatis tercatat di Inventori dengan cabang asal, cabang tujuan, bahan, qty, status, staff, dan catatan yang sesuai.
2. Transfer stok yang dibuat di Inventori otomatis dibuat di POS sebagai `stock_transfers` dengan cabang POS yang benar.
3. Perubahan status transfer di POS, seperti diterima, ditolak, atau dibatalkan, tercermin di Inventori.
4. Stok keluar staff yang dibuat di POS otomatis tercatat di Inventori sebagai stok keluar/waste pada tanggal laporan yang benar.
5. Semua sync idempoten: request ulang tidak boleh membuat transfer/log dobel atau mengurangi stok dua kali.
6. Admin bisa memantau sync berhasil, pending, gagal, dan retry.

## 3. Non-Goal

- Tidak mengganti model stok POS yang sudah berjalan.
- Tidak membuat POS mengambil stok dari Inventori secara penuh.
- Tidak menghapus flow laporan harian Inventori.
- Tidak memaksa cabang/bahan tanpa mapping untuk gagal transaksi di POS; transaksi POS tetap harus bisa berjalan.
- Tidak membuat realtime websocket. Sinkronisasi cukup berbasis API call synchronous untuk critical path dan retry queue untuk fallback.

## 4. Analisis Sistem Existing

### 4.1 POS

File utama:

- `point_of_sales/api/api.php`
- `point_of_sales/js/services/inventoryService.js`
- `point_of_sales/js/pos.js`
- `point_of_sales/js/admin.js`
- `point_of_sales/sql/cpanel_mysql_schema.sql`

Tabel relevan:

- `branches`: master cabang POS.
- `ingredients`: master bahan POS.
- `branch_inventory`: stok bahan per cabang POS.
- `inventory_logs`: ledger mutasi stok POS.
- `stock_transfers`: header transfer stok antar cabang POS.
- `stock_transfer_items`: item bahan per transfer POS.

RPC POS yang sudah ada:

- `adjust_stock_atomic`: mutasi stok atomic, dipakai untuk stok keluar/stok masuk/opname.
- `create_stock_transfer`: membuat transfer pending dan langsung mengurangi stok cabang asal.
- `confirm_stock_transfer`: menambah stok cabang tujuan dan mengubah status jadi `confirmed`.
- `reject_stock_transfer`: mengembalikan stok cabang asal dan status `rejected`.
- `cancel_stock_transfer`: mengembalikan stok cabang asal dan status `cancelled`.
- `sync_inventory_stock_count`: menerima stok akhir dari Inventori sebagai opname absolut.
- `inventory_list_branches`, `inventory_list_ingredients`, `inventory_get_branch_stock`: dipakai Inventori untuk mapping/validasi.

Catatan penting:

- POS system RPC sudah punya jalur `systemRpcNames()` untuk request dengan API key tanpa session user.
- RPC transfer POS saat ini adalah user/session RPC, belum ada versi system RPC khusus sync dari Inventori.
- `create_stock_transfer` POS mengurangi stok asal saat dibuat, dan hanya menambah stok tujuan saat confirm.

### 4.2 Inventori

File utama:

- `inventori-new/src/server/controllers/reports.ts`
- `inventori-new/src/server/posSync.ts`
- `inventori-new/src/server/controllers/posMapping.ts`
- `inventori-new/src/app/api/[...path]/route.ts`
- `inventori-new/database/schema.postgres.sql`
- `inventori-new/backend/api/controllers/ReportController.php` bila backend PHP masih dipakai production.

Tabel relevan:

- `branches`: master cabang Inventori.
- `materials`: master bahan Inventori.
- `daily_reports`: laporan stok harian. Kolom penting: `stock_in`, `stock_end`, `stock_waste`, `stock_transfer`.
- `transfer_log`: catatan transfer keluar antar cabang dari input Inventori.
- `pos_cabang_mapping`: mapping cabang Inventori ke cabang POS.
- `pos_bahan_mapping`: mapping bahan Inventori ke bahan POS, termasuk `conversion_factor`.
- `pos_validasi_log`: log validasi/override POS.
- `audit_log`: audit admin/system.

Perilaku existing:

- Staff Inventori mengisi `stock_transfer`; bila qty > 0, UI wajib meminta cabang tujuan.
- Submit Inventori menyimpan `daily_reports` dan insert `transfer_log`.
- Versi `src/server/controllers/reports.ts` sudah memanggil `syncStockToPos()` untuk mengirim `stock_end` ke POS sebagai opname absolut.
- Versi PHP `backend/api/controllers/ReportController.php` belum terlihat memanggil sync stok akhir ke POS. Jika production memakai backend PHP, parity wajib dibuat.

## 5. Masalah dan Gap

1. Belum ada event ID lintas sistem.
   POS transfer punya `stock_transfers.id` dan `transfer_code`, tetapi Inventori `transfer_log` belum menyimpan `pos_transfer_id` atau `source_system`.

2. `daily_reports` bersifat satu laporan per hari per cabang.
   Jika stok keluar POS terjadi setelah laporan Inventori dikirim, tidak aman langsung update row laporan tanpa aturan. Perlu ledger sync terpisah atau amend event yang jelas.

3. Transfer berbeda model.
   POS punya status transfer pending/confirmed/rejected/cancelled, sedangkan Inventori `transfer_log` saat ini hanya log sederhana tanpa status.

4. Risiko double deduction.
   Inventori submit mengirim `stock_end` sebagai opname ke POS, sementara transfer POS mengurangi stok asal. Jika sync didesain sebagai delta tanpa source guard, stok bisa berubah dobel.

5. Mapping belum diwajibkan untuk semua bahan/cabang.
   Sync harus bisa skip item tidak ter-mapping, mencatat error yang bisa dipantau admin.

6. Dua backend Inventori.
   Next API (`src/server`) dan PHP backend (`backend/api`) berisi logika submit yang mirip. Implementasi harus jelas target production-nya.

## 6. Rekomendasi Desain

Gunakan pola event sync dengan source tracking dan idempotency. Jangan langsung mengubah row historis tanpa mencatat event asal.

Tambahkan tabel sync di Inventori:

```sql
CREATE TABLE inventory_external_stock_events (
  id varchar(36) PRIMARY KEY,
  source_system varchar(30) NOT NULL,       -- pos | inventory
  source_event_type varchar(50) NOT NULL,   -- stock_transfer | stock_transfer_status | stock_out
  source_event_id varchar(100) NOT NULL,
  source_event_code varchar(100),
  event_date date NOT NULL,
  branch_id varchar(36),
  branch_name varchar(100),
  material_id varchar(36),
  material_name varchar(100),
  quantity numeric(15,4),
  direction varchar(20),                    -- out | in | transfer_out | transfer_in
  status varchar(30) DEFAULT 'applied',      -- pending | applied | failed | skipped
  payload jsonb,
  error_message text,
  created_at timestamp(0) DEFAULT now(),
  updated_at timestamp(0) DEFAULT now(),
  CONSTRAINT uq_inventory_external_event UNIQUE (source_system, source_event_type, source_event_id, material_id, direction)
);
```

Tambahkan kolom pada `transfer_log` Inventori:

```sql
ALTER TABLE transfer_log
  ADD COLUMN IF NOT EXISTS source_system varchar(30) DEFAULT 'inventory',
  ADD COLUMN IF NOT EXISTS source_event_id varchar(100),
  ADD COLUMN IF NOT EXISTS pos_transfer_id varchar(100),
  ADD COLUMN IF NOT EXISTS pos_transfer_code varchar(100),
  ADD COLUMN IF NOT EXISTS status varchar(30) DEFAULT 'pending',
  ADD COLUMN IF NOT EXISTS confirmed_at timestamp(0),
  ADD COLUMN IF NOT EXISTS rejected_at timestamp(0),
  ADD COLUMN IF NOT EXISTS cancelled_at timestamp(0),
  ADD COLUMN IF NOT EXISTS sync_status varchar(30) DEFAULT 'pending',
  ADD COLUMN IF NOT EXISTS sync_error text;
```

Tambahkan kolom opsional pada `daily_reports` bila business memutuskan stok keluar POS harus tampil di laporan harian utama:

```sql
ALTER TABLE daily_reports
  ADD COLUMN IF NOT EXISTS external_stock_waste numeric(15,4) DEFAULT 0,
  ADD COLUMN IF NOT EXISTS external_stock_out_detail jsonb;
```

Rekomendasi utama: untuk v1, stok keluar POS masuk ke `inventory_external_stock_events` dan ditampilkan sebagai "Stok Keluar POS" di riwayat/detail. `daily_reports.stock_waste` tidak perlu dioverwrite jika laporan sudah submitted, kecuali ada requirement accounting yang mengharuskan angka total gabung.

## 7. Requirement Fungsional

### 7.1 Transfer dari POS ke Inventori

Ketika staff POS menjalankan `create_stock_transfer`:

1. POS tetap membuat `stock_transfers` dan `stock_transfer_items`.
2. Setelah commit POS berhasil, POS memanggil endpoint Inventori:
   `POST /api/integration/pos/stock-transfer`
3. Payload berisi:
   - `pos_transfer_id`
   - `transfer_code`
   - `from_pos_branch_id`
   - `to_pos_branch_id`
   - `status`
   - `created_at`
   - `requested_by_pos_user_id`
   - `requested_by_name`
   - `notes`
   - `items`: `pos_ingredient_id`, `ingredient_name`, `quantity`, `unit`
4. Inventori mencari mapping cabang dan bahan.
5. Untuk setiap item mapped, Inventori insert/update `transfer_log`.
6. Inventori mengisi `status = pending`, `source_system = pos`, `pos_transfer_id`, `pos_transfer_code`.
7. Bila mapping tidak ditemukan, event disimpan sebagai `failed` atau `skipped` di `inventory_external_stock_events` dan terlihat di dashboard admin.

### 7.2 Status Transfer dari POS ke Inventori

Ketika transfer POS di-confirm, reject, atau cancel:

1. POS memanggil endpoint:
   `POST /api/integration/pos/stock-transfer-status`
2. Inventori update semua `transfer_log` dengan `pos_transfer_id` terkait.
3. Mapping status:
   - POS `pending` -> Inventori `pending`
   - POS `confirmed` -> Inventori `confirmed`
   - POS `rejected` -> Inventori `rejected`
   - POS `cancelled` -> Inventori `cancelled`
4. Inventori tidak membuat baris transfer baru untuk status event bila header transfer belum ada. Jika header belum ada, simpan sebagai failed dependency dan retry.

### 7.3 Transfer dari Inventori ke POS

Ketika staff Inventori submit laporan dengan `stock_transfer > 0`:

1. Inventori tetap menyimpan `daily_reports` dan `transfer_log`.
2. Setelah `transfer_log` dibuat, Inventori memanggil POS system RPC baru:
   `sync_inventory_stock_transfer`
3. POS membuat `stock_transfers` pending dan `stock_transfer_items`.
4. POS mengurangi stok cabang asal seperti flow `create_stock_transfer`.
5. POS mengembalikan `transfer_id` dan `transfer_code`.
6. Inventori menyimpan `pos_transfer_id`, `pos_transfer_code`, `sync_status = applied`.
7. Bila POS gagal, submit Inventori harus:
   - Untuk mode strict: rollback seluruh submit agar tidak ada selisih sistem.
   - Untuk mode queue: simpan submit, tandai `sync_status = failed`, tampilkan warning admin, dan retry.

Keputusan v1 yang direkomendasikan: strict untuk transfer, karena transfer langsung mengubah stok fisik antar outlet. Jika POS gagal, laporan Inventori tidak disimpan dan staff diminta coba lagi.

### 7.4 Stok Keluar dari POS ke Inventori

Ketika staff POS menjalankan stok keluar:

1. POS tetap memproses `adjust_stock_atomic` dengan `type = out`.
2. Setelah commit POS berhasil, POS memanggil endpoint Inventori:
   `POST /api/integration/pos/stock-out`
3. Payload berisi:
   - `pos_inventory_log_id`
   - `pos_branch_id`
   - `pos_ingredient_id`
   - `quantity`
   - `stock_before`
   - `stock_after`
   - `reason`
   - `evidence_photo_url`
   - `chronology`
   - `created_by_pos_user_id`
   - `created_by_name`
   - `created_at`
4. Inventori menyimpan event di `inventory_external_stock_events`.
5. Inventori menampilkan event ini di riwayat stok/detail laporan sebagai "Stok Keluar POS".
6. Jika laporan harian tanggal tersebut belum ada, event tetap disimpan sebagai pending association. Saat laporan dibuat, UI/admin bisa melihat total stok keluar POS pada tanggal yang sama.
7. Jika laporan harian sudah ada, jangan overwrite `stock_waste` existing. Tampilkan sebagai komponen tambahan agar audit tetap jelas.

Mapping alasan:

| POS reason | Inventori reason |
| --- | --- |
| `roti_berjamur` | `berjamur` |
| `roti_hilang` | `hilang` |

### 7.5 Dashboard Admin

Admin Inventori membutuhkan menu monitoring "Sinkronisasi POS":

- Tab mapping cabang/bahan tetap ada.
- Tambah tab "Event Sync".
- Filter: tanggal, cabang, tipe event, status, sumber.
- Aksi: retry event failed, mark skipped dengan alasan, lihat payload.
- Badge error bila ada event failed 24 jam terakhir.

Admin POS membutuhkan minimal log error sync ke Inventori:

- Jika Inventori tidak bisa dihubungi setelah POS commit, transaksi POS tetap sukses.
- Error sync dicatat di tabel queue POS agar bisa retry.

## 8. Requirement Teknis

### 8.1 Endpoint Inventori baru

Jika memakai Next API:

- Tambahkan route di `inventori-new/src/app/api/[...path]/route.ts` dengan auth `apikey`.
- Tambahkan controller baru, misalnya `inventori-new/src/server/controllers/posEvents.ts`.
- Gunakan `requireApiKey` scope baru: `pos:write` atau `integration:write`.

Endpoint:

```text
POST /api/integration/pos/stock-transfer
POST /api/integration/pos/stock-transfer-status
POST /api/integration/pos/stock-out
GET  /api/admin/pos-sync/events
POST /api/admin/pos-sync/events/:id/retry
```

Jika memakai PHP backend production:

- Tambahkan route yang sama di `inventori-new/backend/api/index.php`.
- Tambahkan method pada `Router::scopeFor()` agar endpoint write memakai scope `integration:write`.
- Implementasi controller harus parity dengan versi Next API.

### 8.2 POS RPC baru

Tambahkan system RPC di `point_of_sales/api/api.php`:

```text
sync_inventory_stock_transfer
sync_inventory_stock_transfer_status
```

Keduanya masuk ke `systemRpcNames()` agar bisa dipanggil Inventori memakai API key tanpa session user.

RPC `sync_inventory_stock_transfer` harus menerima payload mapped dari Inventori:

```json
{
  "p_source_event_id": "uuid-transfer-log-or-session",
  "p_from_branch_id": 1,
  "p_to_branch_id": 2,
  "p_items": [{ "ingredient_id": 10, "qty": 3 }],
  "p_notes": "Transfer dari Inventori",
  "p_staff_name": "Nama Staff"
}
```

RPC wajib idempoten berdasarkan `p_source_event_id`. Perlu kolom tambahan pada `stock_transfers`:

```sql
ALTER TABLE stock_transfers
  ADD COLUMN source_system VARCHAR(30) NULL,
  ADD COLUMN source_event_id VARCHAR(100) NULL,
  ADD UNIQUE KEY uq_stock_transfer_source (source_system, source_event_id);
```

### 8.3 POS Outbound Client

Tambahkan konfigurasi POS:

- `INVENTORY_API_URL`
- `INVENTORY_API_KEY`

Jangan taruh secret baru di `js/apiClient.js`, karena file JS terbuka di browser. Pemanggilan POS -> Inventori harus terjadi server-side di `api/api.php` setelah transaksi database commit.

Tambahkan tabel queue POS:

```sql
CREATE TABLE IF NOT EXISTS inventory_sync_queue (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  event_type VARCHAR(50) NOT NULL,
  source_table VARCHAR(50) NOT NULL,
  source_id VARCHAR(100) NOT NULL,
  payload JSON NOT NULL,
  status ENUM('pending','processing','applied','failed','skipped') NOT NULL DEFAULT 'pending',
  attempts INT NOT NULL DEFAULT 0,
  last_error TEXT,
  next_retry_at DATETIME NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_inventory_sync_source (event_type, source_table, source_id)
);
```

Critical path POS:

- POS commit stok/transfer dulu.
- Insert queue event dalam transaksi yang sama.
- Coba kirim sync setelah commit.
- Jika gagal, queue tetap `pending/failed`; POS tidak boleh rollback karena stok operasional sudah berhasil.

### 8.4 Mapping dan Konversi Satuan

Mapping wajib:

- Inventori branch -> POS branch: `pos_cabang_mapping`.
- Inventori material -> POS ingredient: `pos_bahan_mapping`.
- Gunakan `conversion_factor` dua arah:
  - Inventori ke POS: `qty_pos = qty_inventory * conversion_factor`.
  - POS ke Inventori: `qty_inventory = qty_pos / conversion_factor`.

Jika conversion factor kosong atau tidak valid, pakai `1` dan catat warning di event.

### 8.5 Reporting Date

Inventori harus memakai fungsi reporting date existing (`reportingDate`) saat menerima event POS.

Aturan:

- `event_date` mengikuti tanggal operasional Inventori berdasarkan timestamp POS, bukan sekadar tanggal kalender server.
- Untuk event POS lama yang diretry, gunakan `created_at` POS sebagai basis tanggal, bukan waktu retry.

## 9. Alur Data

### 9.1 POS transfer -> Inventori

```text
Staff POS kirim transfer
  -> POS create_stock_transfer commit
  -> POS insert inventory_sync_queue(stock_transfer)
  -> POS POST Inventori /integration/pos/stock-transfer
  -> Inventori map cabang dan bahan
  -> Inventori upsert transfer_log + external event
  -> Admin Inventori melihat transfer pending
```

### 9.2 Inventori transfer -> POS

```text
Staff Inventori submit stock_transfer
  -> Inventori insert daily_reports + transfer_log dalam transaksi
  -> Inventori call POS sync_inventory_stock_transfer
  -> POS create stock_transfers pending idempotent
  -> POS return transfer_id + transfer_code
  -> Inventori update transfer_log sync status
```

### 9.3 POS stok keluar -> Inventori

```text
Staff POS input stok keluar
  -> POS adjust_stock_atomic commit
  -> POS insert inventory_sync_queue(stock_out)
  -> POS POST Inventori /integration/pos/stock-out
  -> Inventori map cabang dan bahan
  -> Inventori insert inventory_external_stock_events
  -> UI Inventori tampilkan Stok Keluar POS
```

## 10. UI/UX

### POS Staff

- Tidak perlu perubahan besar.
- Setelah stok keluar/transfer berhasil, bila sync ke Inventori gagal, tampilkan toast non-blocking: "Stok berhasil dicatat. Sinkronisasi Inventori akan dicoba ulang."
- Jangan minta staff input ulang di dua sistem.

### Inventori Staff

- Form transfer tetap seperti sekarang.
- Saat submit dan sync POS gagal pada mode strict, tampilkan error jelas: "Transfer belum tersimpan karena POS tidak bisa disinkronkan. Coba lagi."
- Jika cabang/bahan belum mapping, tampilkan nama bahan/cabang yang bermasalah.

### Inventori Admin

- Di Riwayat Stok, tampilkan:
  - Transfer manual Inventori.
  - Transfer dari POS.
  - Stok keluar POS.
  - Status sync.
- Di detail event, tampilkan source ID, payload, error, dan tombol retry.

## 11. Security

1. Semua endpoint POS -> Inventori wajib pakai `X-API-Key`.
2. API key harus punya scope write, misalnya `integration:write` atau `pos:write`.
3. Secret Inventori tidak boleh dimasukkan ke frontend POS JS.
4. Payload harus divalidasi server-side:
   - branch/material mapped dan aktif.
   - qty > 0.
   - source_event_id wajib.
   - timestamp valid.
5. Endpoint write harus rate limited per API key dan IP.
6. Audit log harus menyimpan action:
   - `pos_stock_transfer_imported`
   - `pos_stock_transfer_status_imported`
   - `pos_stock_out_imported`
   - `inventory_stock_transfer_synced_to_pos`
7. Retry admin harus tercatat di `audit_log`.

## 12. Acceptance Criteria

### Transfer POS ke Inventori

- Given staff POS membuat transfer dari Outlet A ke Outlet B, when POS berhasil commit, then Inventori memiliki `transfer_log` dengan cabang asal A dan tujuan B sesuai mapping.
- Given request sync transfer yang sama dikirim dua kali, then Inventori hanya memiliki satu set row transfer untuk event tersebut.
- Given bahan belum dimapping, then transfer POS tetap sukses dan Inventori mencatat event `failed` dengan alasan mapping.

### Transfer Inventori ke POS

- Given staff Inventori mengisi `stock_transfer > 0` ke cabang tujuan, when submit berhasil, then POS memiliki `stock_transfers` pending dengan cabang asal/tujuan sesuai input staff.
- Given POS tidak bisa dihubungi, then pada mode strict submit Inventori rollback dan staff melihat error.
- Given request Inventori ke POS diulang dengan source event sama, then POS mengembalikan transfer existing dan tidak mengurangi stok dua kali.

### Status Transfer

- Given transfer POS dikonfirmasi penerima, when sync status dikirim, then `transfer_log.status` di Inventori menjadi `confirmed`.
- Given transfer POS ditolak/dibatalkan, then `transfer_log.status` di Inventori menjadi `rejected` atau `cancelled`.

### Stok Keluar POS ke Inventori

- Given staff POS mencatat roti berjamur dengan foto, when POS commit, then Inventori punya event stok keluar dengan reason `berjamur` dan URL foto.
- Given staff POS mencatat roti hilang dengan kronologi, when POS commit, then Inventori punya event stok keluar dengan reason `hilang` dan kronologi.
- Given laporan Inventori tanggal tersebut sudah submit, then event stok keluar POS tetap tampil sebagai event tambahan dan tidak overwrite `daily_reports.stock_waste`.

### Monitoring

- Admin bisa melihat event sync failed dan retry.
- Admin bisa filter event berdasarkan tanggal, cabang, tipe event, dan status.
- Semua sync failure menyimpan error detail yang cukup untuk perbaikan mapping/config.

## 13. Test Plan

Unit/integration test minimal:

- Mapping branch/material dua arah dengan `conversion_factor`.
- Idempotency unique key untuk event POS -> Inventori.
- Idempotency unique key untuk Inventori -> POS.
- Transfer status update tanpa membuat duplicate transfer.
- Stock out POS masuk ke event Inventori dan tidak mengubah `daily_reports` existing.
- Retry failed event setelah mapping diperbaiki.

Manual QA:

1. Buat mapping 2 cabang dan 2 bahan.
2. POS: kirim transfer 1 bahan dari cabang A ke B.
3. Cek Inventori: transfer muncul dengan status pending.
4. POS: cabang B confirm.
5. Cek Inventori: status menjadi confirmed.
6. Inventori: input transfer dari cabang B ke A.
7. Cek POS: transfer pending muncul di cabang A.
8. POS: input stok keluar roti berjamur dengan foto.
9. Cek Inventori: event stok keluar POS muncul.
10. Ulangi request sync sama via API client/postman.
11. Pastikan tidak ada row duplicate dan stok tidak berubah dua kali.

## 14. Rollout Plan

Fase 1 - Fondasi data:

- Tambah migration tabel/kolom sync.
- Tambah endpoint Inventori write dengan API key.
- Tambah event monitor admin read-only.

Fase 2 - POS -> Inventori:

- Tambah queue POS.
- Kirim event transfer create/status.
- Kirim event stok keluar.
- Aktifkan retry.

Fase 3 - Inventori -> POS:

- Tambah POS system RPC `sync_inventory_stock_transfer`.
- Hubungkan submit Inventori transfer ke POS.
- Terapkan strict rollback untuk transfer.

Fase 4 - Hardening:

- Dashboard error, alert admin, bulk retry.
- Reconciliation report harian POS vs Inventori.
- Dokumentasi operational runbook.

## 15. Risiko dan Mitigasi

| Risiko | Dampak | Mitigasi |
| --- | --- | --- |
| Double deduction | Stok POS/Inventori salah | Unique source event, idempotent RPC, jangan retry tanpa source ID |
| Mapping salah | Transfer masuk cabang/bahan salah | UI mapping wajib tampil nama POS + Inventori, audit mapping, validation preview |
| POS sukses tapi Inventori down | Data terlambat sinkron | Queue POS + retry + dashboard failed |
| Inventori submit sukses tapi POS gagal | Transfer tidak muncul di POS | Mode strict rollback untuk transfer Inventori -> POS |
| Dua backend Inventori berbeda perilaku | Bug production sulit dilacak | Tetapkan backend production; jika dua-duanya aktif, implement parity dan test keduanya |
| Laporan harian sudah submitted | Angka stok keluar bisa rancu | Simpan stock out POS sebagai external event, bukan overwrite laporan |

## 16. Open Questions

1. Backend Inventori production yang aktif saat ini Next API (`/api` Vercel) atau PHP backend cPanel? Jawaban ini menentukan file implementasi utama.
2. Apakah stok keluar POS harus masuk ke angka `daily_reports.stock_waste`, atau cukup tampil sebagai event tambahan "Stok Keluar POS"?
3. Untuk transfer Inventori -> POS, apakah submit harus rollback jika POS gagal? Rekomendasi PRD: ya, strict.
4. Apakah admin membutuhkan rekonsiliasi total harian yang menggabungkan `stock_waste + external_stock_out`, atau cukup list detail event?
5. Apakah semua bahan yang bisa ditransfer wajib sudah ada mapping POS, atau boleh skip sebagian item?

## 17. File Implementasi yang Disarankan

POS:

- `point_of_sales/api/api.php`
- `point_of_sales/sql/migrations/068_inventory_sync_queue.sql`
- `point_of_sales/js/services/inventoryService.js` hanya bila perlu membaca status sync dari API, bukan untuk menyimpan secret.

Inventori Next API:

- `inventori-new/database/migrations/002_pos_inventory_event_sync.sql`
- `inventori-new/src/server/controllers/posEvents.ts`
- `inventori-new/src/server/posTransferSync.ts`
- `inventori-new/src/app/api/[...path]/route.ts`
- `inventori-new/src/server/auth.ts` bila menambah scope helper.
- `inventori-new/src/app/admin/(dashboard)/pos-mapping/page.tsx` atau halaman admin sync baru.

Inventori PHP backend bila dipakai:

- `inventori-new/backend/api/index.php`
- `inventori-new/backend/api/controllers/PosEventController.php`
- `inventori-new/backend/api/lib/Router.php`
- `inventori-new/backend/api/controllers/ReportController.php`

