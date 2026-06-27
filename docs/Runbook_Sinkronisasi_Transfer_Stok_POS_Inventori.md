# Runbook & Panduan Aktivasi: Sinkronisasi Transfer Stok & Stok Keluar POS ↔ Inventori

| Item | Nilai |
| --- | --- |
| Versi | 1.0 |
| Tanggal | 2026-06-28 |
| Status | Implementasi SELESAI — menunggu aktivasi owner |
| Terkait | `docs/PRD_Sinkronisasi_Transfer_Stok_POS_Inventori.md` |

Dokumen ini untuk OWNER/operator (bukan developer). Ikuti urutan langkah dari atas
ke bawah. Semua fitur **default MATI** — tidak ada yang berubah sampai Anda
mengaktifkannya. Transaksi POS tetap berjalan normal walau sinkronisasi belum aktif.

---

## 0. Apa yang sudah dibangun

- **POS → Inventori (otomatis):**
  - Transfer stok yang dibuat staff di POS → muncul di Inventori (Riwayat Stok / Monitor Sync).
  - Perubahan status transfer di POS (diterima/ditolak/dibatalkan) → ikut ter-update di Inventori.
  - Stok keluar staff di POS (roti berjamur / roti hilang) → tercatat di Inventori sebagai "Stok Keluar POS".
- **Inventori → POS (otomatis, mode strict):**
  - Saat staff Inventori submit laporan berisi transfer antar cabang → transfer dibuat juga di POS (status pending).
- **Monitor admin Inventori:** menu **"Monitor Sync POS"** — lihat semua event, status, payload, dan tombol **Retry**.
- **Antrian + retry di POS:** bila Inventori sedang down, event POS tersimpan di antrian dan dicoba ulang.

---

## 1. Jalankan migration database (WAJIB, sekali saja)

### 1a. Database Inventori (Supabase / PostgreSQL)

1. Buka **Supabase → SQL Editor** untuk project Inventori.
2. Salin seluruh isi file:
   `inventori-new/database/migrations/002_pos_inventory_event_sync.sql`
3. Tempel ke SQL Editor, klik **Run**. (Aman dijalankan berulang.)
4. Pastikan tidak ada error merah. Migration ini membuat tabel
   `inventory_external_stock_events` dan menambah kolom pada `transfer_log`.

### 1b. Database POS (cPanel / MySQL)

1. Buka **cPanel → phpMyAdmin** → pilih database POS.
2. Tab **SQL**, salin seluruh isi file:
   `point_of_sales/sql/migrations/068_inventory_sync_queue.sql`
3. Klik **Go**. Membuat tabel `inventory_sync_queue` dan menambah 2 kolom pada `stock_transfers`.
4. Jika server menolak `ADD COLUMN IF NOT EXISTS` (MySQL versi lama), hapus klausa
   `IF NOT EXISTS` lalu jalankan ulang baris yang gagal.

---

## 2. Buat API Key Inventori (untuk dipakai POS)

POS perlu "kunci" untuk mengirim data ke Inventori.

1. Buat string acak panjang (minimal 40 karakter). Contoh cara: di terminal ketik
   `openssl rand -base64 48` — atau buat manual asal acak & panjang. **Simpan baik-baik.**
   Sebut string ini `SECRET_POS`.
2. Buka **Supabase → SQL Editor** (database Inventori), jalankan (ganti `SECRET_POS`):

   ```sql
   INSERT INTO api_keys (id, key_hash, key_prefix, name, scopes, status, created_by)
   VALUES (
     gen_random_uuid()::text,
     encode(sha256('SECRET_POS'::bytea), 'hex'),
     left('SECRET_POS', 8),
     'POS Integration (event sync)',
     'integration:read,integration:write',
     'active', 'SYSTEM'
   );
   ```

3. Selesai. `SECRET_POS` inilah yang akan dipasang di `.env` POS sebagai `INVENTORY_API_KEY`.

> Catatan: yang disimpan di database hanyalah **hash** dari kunci, bukan kunci aslinya.
> Jadi simpan `SECRET_POS` Anda sendiri; tidak bisa dilihat lagi dari database.

---

## 3. Isi konfigurasi POS (.env)

1. Di server POS (cPanel), buka file `.env` di root project POS (folder yang sama dengan `api/`).
2. Tambahkan 2 baris berikut (ganti dengan nilai asli):

   ```
   INVENTORY_API_URL=https://inventory.rotibakarngeunah.my.id/api
   INVENTORY_API_KEY=SECRET_POS_yang_tadi_dibuat
   ```

   - `INVENTORY_API_URL` = alamat API Inventori (Vercel) + `/api`, **tanpa garis miring di akhir**.
   - Mengosongkan kedua nilai = mematikan sinkronisasi POS→Inventori (transaksi POS tetap jalan).
3. Simpan file.

---

## 4. Isi konfigurasi Inventori (Sinkronisasi POS)

Agar Inventori bisa mendorong transfer ke POS, Inventori perlu tahu alamat & kunci POS.
Ini **sudah ada** dari fitur sebelumnya — pastikan terisi:

1. Login **Admin Inventori → menu "Sinkronisasi POS"**.
2. Pastikan **POS API URL** dan **POS API Key** sudah terisi (sama seperti yang dipakai
   fitur opname/PO sebelumnya). Bila kosong, isi via **Pengaturan Sistem**:
   - `pos_api_url` = `https://api.rotibakarngeunah.my.id/api/api.php` (alamat api.php POS)
   - `pos_api_key` = API_SECRET_KEY milik POS.

---

## 5. Mapping cabang & bahan (WAJIB sebelum aktivasi)

Sinkronisasi hanya bekerja untuk cabang & bahan yang sudah **dipasangkan** (mapping)
antara POS dan Inventori. Item yang belum dipasangkan akan ditandai **failed/skipped**
(tidak menggagalkan transaksi) dan bisa diperbaiki + retry nanti.

1. **Admin Inventori → "Sinkronisasi POS"**.
2. Tab **Cabang**: pasangkan tiap cabang Inventori ke cabang POS yang sesuai.
3. Tab **Bahan**: pasangkan tiap bahan Inventori ke bahan POS.
   - Isi **faktor konversi** bila satuannya beda. Contoh: Inventori "lusin" → POS "pcs" = **12**.
   - Rumus: `qty_POS = qty_Inventori × faktor`. Arah balik (POS→Inventori) dibagi.
4. Minimal pasangkan dulu cabang & bahan yang sering ditransfer.

---

## 6. Aktivasi bertahap (rekomendasi)

Aktifkan satu arah dulu, pantau, baru lanjut.

### Tahap A — POS → Inventori (paling aman, hanya mencatat)

1. Pastikan langkah 1–5 selesai.
2. POS→Inventori **otomatis aktif** begitu `INVENTORY_API_URL` & `INVENTORY_API_KEY`
   terisi (langkah 3). Tidak ada saklar lain.
3. Uji: minta staff POS membuat 1 transfer kecil / 1 stok keluar.
4. Cek **Admin Inventori → "Monitor Sync POS"** — event harus muncul `applied`.

### Tahap B — Inventori → POS (mode strict)

> ⚠️ **PENTING (baca §8 soal stok dobel):** Jangan mengaktifkan **opname**
> (`pos_stock_sync_enabled`) DAN **dorong transfer** (`pos_transfer_sync_enabled`)
> bersamaan untuk bahan yang sama. Keduanya strategi alternatif. Pilih SATU.

1. **Admin Inventori → Pengaturan Sistem** → nyalakan
   **"Dorong Transfer Inventori → Kasir/POS"** (`pos_transfer_sync_enabled`).
2. Uji: staff Inventori submit laporan berisi 1 transfer antar cabang.
3. Cek **POS** — harus muncul transfer `pending` di cabang asal.
4. Bila POS tidak bisa dihubungi saat submit: laporan Inventori **tidak tersimpan**
   (mode strict) dan staff diminta coba lagi. Ini disengaja agar stok tak selisih.

---

## 7. Retry & pemantauan harian

### Di Inventori (utama)
- **Monitor Sync POS**: filter `status = failed`. Klik ikon **Retry** setelah mapping diperbaiki.
- Badge merah muncul bila ada event gagal dalam 24 jam terakhir.

### Di POS (antrian outbound)
- Bila Inventori sempat down, event POS tersimpan di tabel `inventory_sync_queue`
  (status `pending`/`failed`).
- **Siapkan cron cPanel** agar antrian otomatis dikirim ulang. Tambah Cron Job:
  - Jadwal: setiap 2 menit (`*/2 * * * *`).
  - Perintah:
    ```
    curl -s -X POST "https://api.rotibakarngeunah.my.id/api/api.php/rpc/process_inventory_sync_queue" \
      -H "X-API-Key: API_SECRET_KEY_POS" -H "Content-Type: application/json" -d '{"p_limit":50}' >/dev/null
    ```
  - Ganti `API_SECRET_KEY_POS` dengan API key POS Anda.
- Untuk melihat isi antrian (debug): panggil RPC `get_inventory_sync_queue` (butuh sesi admin POS).

---

## 8. Risiko stok dobel (WAJIB dipahami) — opname vs dorong transfer

Sistem punya 2 cara menyamakan stok Inventori dengan POS:

1. **Opname** (`pos_stock_sync_enabled`): saat staff Inventori submit, **sisa stok**
   tiap bahan dikirim sebagai nilai absolut (menimpa stok POS). Transfer otomatis ikut
   terhitung karena tiap cabang melaporkan hitungan fisiknya sendiri.
2. **Dorong transfer** (`pos_transfer_sync_enabled`): transfer dibuat sebagai mutasi
   eksplisit di POS (mengurangi stok cabang asal, menambah cabang tujuan saat confirm).

**Mengaktifkan keduanya sekaligus untuk bahan yang sama bisa membuat stok berkurang dua kali.**
Pilih satu strategi:

- **Outlet yang staff-nya rutin submit laporan Inventori harian** → cukup pakai **Opname**
  (matikan dorong transfer). Lebih simpel, stok selalu mengikuti hitungan fisik.
- **Ingin transfer terlihat sebagai dokumen transfer resmi di POS (pending → confirm)** →
  pakai **Dorong transfer** (matikan opname untuk bahan yang sama).

Arah **POS → Inventori** (Tahap A) hanya **mencatat** event di Inventori, tidak mengubah
stok Inventori, jadi aman dikombinasikan dengan strategi apa pun.

---

## 9. Cara kerja idempotency (kenapa aman dikirim ulang)

- Setiap event punya ID sumber unik. Mengirim ulang event yang sama **tidak** membuat
  baris dobel maupun mengurangi stok dua kali.
  - POS→Inventori: kunci `(sumber, jenis, source_event_id)` pada `inventory_external_stock_events`.
  - Inventori→POS: kunci `(source_system='inventory', source_event_id)` pada `stock_transfers`.
- Jadi cron retry / klik retry berkali-kali aman.

---

## 10. Checklist aktivasi (centang semua)

- [ ] Migration Inventori 002 dijalankan (Supabase).
- [ ] Migration POS 068 dijalankan (phpMyAdmin).
- [ ] API key Inventori (`integration:write`) dibuat; `SECRET_POS` disimpan.
- [ ] `.env` POS diisi `INVENTORY_API_URL` + `INVENTORY_API_KEY`.
- [ ] Inventori: `pos_api_url` + `pos_api_key` terisi.
- [ ] Mapping cabang & bahan POS↔Inventori diisi.
- [ ] Tahap A diuji (transfer & stok keluar POS muncul di Monitor Sync, status `applied`).
- [ ] (Opsional) Tahap B diaktifkan & diuji; pastikan TIDAK bentrok dengan opname (§8).
- [ ] Cron `process_inventory_sync_queue` dipasang di cPanel (retry otomatis).

---

## 11. Troubleshooting cepat

| Gejala | Kemungkinan sebab | Solusi |
| --- | --- | --- |
| Event Inventori `failed`, error `*_not_mapped` | Cabang/bahan belum dipasangkan | Lengkapi mapping (§5), lalu klik Retry |
| Tidak ada event masuk ke Inventori sama sekali | `INVENTORY_API_URL`/`KEY` POS salah/kosong | Cek `.env` POS (§3); cek key benar (§2) |
| Inventori `401 API key tidak valid` | Hash key tidak cocok | Pastikan `SECRET_POS` di `.env` POS = yang di-hash saat insert api_keys |
| Submit Inventori gagal "POS tidak bisa disinkronkan" | Mode strict transfer + POS down | Coba lagi setelah POS online; atau matikan `pos_transfer_sync_enabled` sementara |
| Stok POS berkurang dobel | Opname & dorong transfer aktif bersamaan | Matikan salah satu (§8) |
| Antrian POS menumpuk `failed` | Inventori sempat down / cron belum jalan | Pastikan cron `process_inventory_sync_queue` aktif (§7) |
