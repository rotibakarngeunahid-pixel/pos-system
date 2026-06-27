# PRD: Revisi Rekomendasi Order Inventori ke Purchase Order

**Versi:** 1.0  
**Tanggal:** 2026-06-28  
**Status:** Draft untuk implementasi  
**Sistem terdampak:** `inventori-new` dan `purchase_order`

## 1. Ringkasan

Staff cabang sudah dapat memilih bahan yang harus diorder di sistem Inventori. Data tersebut disimpan sebagai `recommend_order` di `daily_reports` dan sebagai baris `pending` di tabel `order_recommendations`.

Masalah yang terlihat di Purchase Order adalah panel `Rekomendasi Staff` dapat menampilkan "Tidak ada rekomendasi untuk cabang ini" walaupun staff sudah menandai bahan sebagai harus diorder. Berdasarkan pembacaan kode, masalah utama bukan pada input staff, tetapi pada cara Purchase Order mengambil, memfilter, memetakan, dan menindaklanjuti rekomendasi dari Inventori.

PRD ini merevisi integrasi agar rekomendasi staff menjadi task queue yang andal: muncul di PO selama masih `pending`, cocok ke cabang dan bahan yang benar, dapat langsung ditambahkan ke order cabang asal, lalu ditandai selesai setelah benar-benar diproses.

## 2. Temuan Dari Codebase Saat Ini

### 2.1 Inventori sudah menyimpan rekomendasi

Di `inventori-new`, submit laporan membaca `it.recommend_order`, memasukkan item rekomendasi ke array `recommended`, lalu menulis ke:

- `daily_reports.recommend_order`
- `order_recommendations`

Tabel `order_recommendations` memiliki field utama:

- `report_date`
- `branch_id`, `branch_name`
- `staff_id`, `staff_name`
- `material_id`, `material_name`
- `input_type`, `stock_end`, `photo_url`
- `status`, default `pending`
- `processed_at`, `processed_note`

Endpoint Inventori yang tersedia:

- `GET /api/dashboard/recommendations?date=YYYY-MM-DD`
- `POST /api/dashboard/recommendations/process`

### 2.2 Purchase Order mengambil data terlalu sempit

Panel PO saat ini memanggil:

```text
GET /api/inventori/rekomendasi?status=pending&tanggal={getLocalOperationalYesterday()}
```

Lalu frontend memfilter ulang supaya `item.tanggal` harus diawali tanggal yang sama. Dampaknya:

- Rekomendasi staff hari ini tidak muncul jika PO hanya mengambil kemarin.
- Rekomendasi kemarin tidak muncul jika reporting date Inventori bergeser karena cutoff.
- Rekomendasi lama yang masih `pending` tidak muncul walaupun belum diproses.
- Saat admin mengganti `orderDate`, panel tidak otomatis reload karena fetch hanya berjalan saat komponen mount.

### 2.3 Filter cabang berbasis exact match nama raw

Di mode `per-outlet`, panel hanya menampilkan item jika:

```text
item.nama_cabang.toLowerCase() === (currentOutlet.inventori_cabang_name || currentOutlet.name).toLowerCase()
```

Dampaknya:

- Perbedaan spasi, kapital, alias, atau nama seperti `Bunderan Dalung` vs `Dalung 1` membuat rekomendasi tidak tampil untuk cabang aktif.
- Jika rekomendasi ada di tab "Semua" tetapi tidak match cabang aktif, empty state tidak cukup menjelaskan akar masalah.

### 2.4 Mapping bahan masih berbasis exact match nama

Backend PO mencocokkan `material_name` Inventori ke `materials.name` PO dengan lowercase + trim. Ini rapuh untuk kasus:

- `Susu` di Inventori vs `Susu Kental Manis` di PO.
- `Keju` vs `Keju Parut`.
- Penulisan bahan yang berubah di salah satu sistem.

Item tanpa mapping masih dapat muncul, tetapi tidak bisa ditambahkan ke order.

### 2.5 Tombol tambah order belum memakai cabang asal rekomendasi

Handler `handleAddRekToOrder(materialId, rekomendasiId)` menambahkan bahan ke:

- outlet yang sedang dipilih di mode `per-outlet`, atau
- outlet aktif pertama di mode lain.

Ini berbahaya ketika admin membuka tab "Semua": rekomendasi dari cabang lain dapat masuk ke cabang yang sedang dipilih, bukan cabang asal rekomendasi.

### 2.6 Status `processed` belum benar-benar terhubung dengan proses order

Saat item ditambahkan, PO hanya menandai `rekAddedIds` di state lokal browser. Item yang sudah ditambahkan tidak otomatis diproses di Inventori.

Selain itu tombol "Tandai sudah diproses" saat ini justru memproses item yang belum ditambahkan dan mengecualikan item yang sudah ditambahkan. Dampaknya:

- Item yang benar-benar ditambahkan ke order dapat tetap `pending` dan muncul lagi besok.
- Item yang diabaikan dapat hilang dari pending tanpa jejak keputusan yang jelas.

## 3. Root Cause Yang Harus Direvisi

1. **Tanggal sumber rekomendasi tidak boleh hardcoded H-1.** Rekomendasi staff adalah queue `pending`, bukan hanya data tanggal kemarin.
2. **Cabang harus dipetakan dengan ID atau mapping resmi, bukan exact match nama tampilan.**
3. **Bahan harus dipetakan dengan ID atau mapping resmi, bukan exact match nama bahan.**
4. **Tambah ke order harus memakai cabang asal rekomendasi.**
5. **Status rekomendasi harus berubah ke `processed` hanya setelah item berhasil disimpan ke order, atau setelah admin eksplisit mengabaikan dengan alasan.**
6. **UI empty state harus menjelaskan apakah tidak ada data, data ada tapi berbeda cabang, data ada tapi tidak termapping, atau integrasi error.**

## 4. Tujuan Produk

- Admin PO langsung melihat bahan yang ditandai staff sebagai harus diorder.
- Rekomendasi tidak hilang hanya karena beda tanggal operasional atau mapping nama.
- Admin dapat menambahkan rekomendasi ke order cabang asal dengan satu aksi.
- Sistem mencatat rekomendasi mana yang sudah diproses dan mana yang diabaikan.
- Bila data tidak muncul, UI memberi alasan yang bisa ditindaklanjuti.

## 5. Non-Goals

- Tidak mengubah aturan staff wajib memilih minimal satu item rekomendasi saat submit Inventori.
- Tidak mengganti keseluruhan flow order PO.
- Tidak mengubah sistem kalkulasi otomatis Roti Tawar, kecuali sinkronisasi tanggal referensi jika diperlukan untuk konsistensi UI.

## 6. Requirement Fungsional

### RF-01: Ambil rekomendasi sebagai pending queue

PO harus mengambil rekomendasi dengan default:

```text
status=pending
date_from={operationalToday - 7 hari}
date_to={operationalToday}
```

Panel tetap boleh menyediakan filter cepat:

- Hari ini
- Kemarin
- 7 hari pending
- Semua pending

Default yang direkomendasikan: `7 hari pending`, supaya rekomendasi yang belum diproses tidak hilang.

### RF-02: Endpoint Inventori mendukung filter yang eksplisit

Tambahkan kemampuan pada `GET /api/dashboard/recommendations`:

```text
status=pending|processed|all
date=YYYY-MM-DD
date_from=YYYY-MM-DD
date_to=YYYY-MM-DD
branch_id=<inventory_branch_id>
material_id=<inventory_material_id>
```

Jika `date_from/date_to` dikirim, endpoint memakai range. Jika hanya `date` dikirim, endpoint tetap kompatibel seperti sekarang.

Response harus menyertakan `meta`:

```json
{
  "success": true,
  "data": {
    "meta": {
      "status": "pending",
      "date_from": "2026-06-21",
      "date_to": "2026-06-28",
      "total": 3
    },
    "recommendations": []
  }
}
```

### RF-03: Mapping cabang harus tahan beda nama

PO harus menyimpan mapping cabang Inventori secara eksplisit.

Opsi minimum:

- Tambahkan `outlets.inventori_branch_id`.
- Tetap pertahankan `outlets.inventori_cabang_name` sebagai label/fallback.

Opsi cepat jika belum migrasi:

- Normalisasi nama dengan `trim`, lowercase, collapse whitespace, hilangkan tanda baca umum.
- Tampilkan warning jika `inventori_cabang_name` tidak match cabang Inventori mana pun.

Requirement utama:

- Filter per-outlet harus memakai `branch_id` Inventori jika tersedia.
- Nama hanya boleh menjadi fallback, bukan sumber kebenaran utama.

### RF-04: Mapping bahan harus eksplisit

PO harus punya mapping bahan Inventori ke material PO.

Opsi schema yang direkomendasikan:

```sql
CREATE TABLE IF NOT EXISTS inventory_material_mappings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  inventory_material_id text NOT NULL,
  inventory_material_name text,
  po_material_id uuid NOT NULL REFERENCES materials(id),
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (inventory_material_id)
);
```

Opsi minimum:

- Tambahkan `materials.inventory_material_id text`.

Requirement utama:

- Backend `/api/inventori/rekomendasi` mengisi `po_material_id` dari mapping ID.
- Exact match nama hanya fallback dan harus diberi flag `mapping_source: "name_fallback"`.
- UI menampilkan badge "Perlu mapping bahan" jika tidak ada mapping.

### RF-05: Tambah ke order memakai cabang asal

Item rekomendasi harus membawa:

```json
{
  "rekomendasi_id": "...",
  "cabang_id": "inventory branch id",
  "po_outlet_id": "purchase order outlet id",
  "bahan_id": "inventory material id",
  "po_material_id": "purchase order material id"
}
```

Klik `Tambah` harus menyimpan qty ke `order_request_items` untuk `po_outlet_id` dari rekomendasi, bukan outlet yang sedang disorot di UI.

Jika `po_outlet_id` tidak tersedia:

- tombol `Tambah` disabled
- pesan: `Cabang Inventori belum dipetakan ke Outlet PO`

Jika `po_material_id` tidak tersedia:

- tombol `Tambah` disabled
- pesan: `Bahan Inventori belum dipetakan ke Material PO`

### RF-06: Process status setelah order tersimpan

Setelah `handleCellChange` atau endpoint save request berhasil menyimpan qty order:

1. PO memanggil `POST /api/inventori/rekomendasi/process`.
2. Body menyertakan:

```json
{
  "rekomendasi_ids": ["..."],
  "note": "Ditambahkan ke order PO <session_id>, outlet <outlet_name>, qty 1"
}
```

Jika save order gagal, rekomendasi tidak boleh diproses.

### RF-07: Abaikan rekomendasi harus eksplisit

Tombol abaikan harus terpisah dari tombol tambah.

Saat admin mengabaikan:

- tampilkan confirm dialog
- wajib pilih alasan:
  - stok masih cukup
  - sudah dibeli manual
  - salah input staff
  - bahan tidak tersedia
  - lainnya
- kirim alasan ke `processed_note`

### RF-08: Empty state harus diagnostik

Panel harus membedakan:

- Tidak ada rekomendasi pending dalam filter tanggal.
- Ada rekomendasi pending, tetapi tidak untuk cabang ini.
- Ada rekomendasi cabang ini, tetapi cabang belum termapping ke outlet PO.
- Ada rekomendasi cabang ini, tetapi bahan belum termapping ke material PO.
- Endpoint Inventori error/timeout.

Contoh untuk kasus screenshot:

```text
Tidak ada rekomendasi untuk Bunderan Dalung.
Ada 3 rekomendasi pending di cabang lain atau mapping cabang tidak cocok.
Lihat Semua atau periksa mapping Nama/ID Inventori di Master Data > Outlet.
```

### RF-09: Panel reload saat tanggal/order berubah

`RekomendasiPanel` harus menerima prop `orderDate` atau `referenceDate`. Fetch ulang saat:

- `orderDate` berubah
- filter tanggal berubah
- admin klik refresh

## 7. Requirement Teknis

### Inventori

Perubahan file utama:

- `inventori-new/src/server/controllers/dashboard.ts`
- `inventori-new/src/app/api/[...path]/route.ts`
- `inventori-new/database/schema.postgres.sql` jika perlu index tambahan

Tambahan index yang direkomendasikan:

```sql
CREATE INDEX IF NOT EXISTS idx_or_status_date
  ON order_recommendations (status, report_date);

CREATE INDEX IF NOT EXISTS idx_or_status_branch_date
  ON order_recommendations (status, branch_id, report_date);
```

Perubahan endpoint:

- `recommendations()` menerima `status`, `date_from`, `date_to`, `branch_id`, `material_id`.
- Query harus tetap kompatibel dengan parameter lama `date`.
- `recommendationsProcess()` tetap idempoten dan hanya memproses status `pending`.

### Purchase Order Backend

Perubahan file utama:

- `purchase_order/server/routes/inventoriRekomendasi.js`
- `purchase_order/server/routes/outlets.js`
- `purchase_order/supabase/schema.sql` atau migration baru

Endpoint PO:

```text
GET /api/inventori/rekomendasi?status=pending&date_from=...&date_to=...
POST /api/inventori/rekomendasi/process
```

Backend PO harus:

- forward filter ke Inventori
- map `branch_id` Inventori ke `outlets.id`
- map `material_id` Inventori ke `materials.id`
- tetap menyertakan item yang belum termapping, dengan metadata error per item
- tidak menyembunyikan data hanya karena mapping belum lengkap

### Purchase Order Frontend

Perubahan file utama:

- `purchase_order/client/src/components/order/RekomendasiPanel.jsx`
- `purchase_order/client/src/pages/OrderEntry.jsx`
- `purchase_order/client/src/pages/MasterData.jsx` jika UI mapping ditambahkan di Master Data

Frontend harus:

- menampilkan pending queue 7 hari secara default
- memfilter cabang memakai `po_outlet_id`
- menambahkan order ke `po_outlet_id` asal rekomendasi
- memanggil process hanya setelah save order berhasil
- menyediakan action abaikan dengan alasan
- memberi warning mapping cabang/bahan yang jelas

## 8. Acceptance Criteria

### AC-01: Data staff masuk Inventori

- Staff submit Inventori dengan Mentega, Susu, Keju dicentang harus diorder.
- Tabel `order_recommendations` berisi 3 baris `pending`.
- `daily_reports.recommend_order` untuk item tersebut bernilai 1.

### AC-02: PO mengambil pending queue

- Rekomendasi `pending` dalam 7 hari terakhir muncul di endpoint PO walaupun tanggalnya bukan H-1.
- Rekomendasi `processed` tidak muncul saat filter `status=pending`.
- Filter `date=YYYY-MM-DD` tetap bekerja untuk kebutuhan debug.

### AC-03: Per-outlet Bunderan Dalung

- Jika cabang Inventori untuk Bunderan Dalung sudah dipetakan, panel per-outlet Bunderan Dalung menampilkan rekomendasi cabang tersebut.
- Jika mapping cabang belum cocok, panel menampilkan pesan diagnostik dan link/arah ke Master Data Outlet.

### AC-04: Mapping bahan

- Item dengan mapping bahan valid menampilkan tombol `Tambah`.
- Item tanpa mapping bahan tetap terlihat, tetapi tombol disabled dengan pesan `Perlu mapping bahan`.
- Perbedaan nama seperti `Susu` vs `Susu Kental Manis` tidak menyebabkan item hilang.

### AC-05: Tambah ke order benar cabang

- Klik `Tambah` pada rekomendasi cabang Soputan saat UI sedang memilih Bunderan Dalung tetap memasukkan qty ke outlet Soputan.
- Qty default adalah 1 jika sebelumnya kosong.
- Jika qty sebelumnya sudah lebih dari 1, sistem tidak menurunkan qty.

### AC-06: Process setelah save

- Setelah save order berhasil, rekomendasi berubah menjadi `processed`.
- `processed_note` berisi konteks session PO, outlet, material, dan qty.
- Jika save order gagal, rekomendasi tetap `pending`.

### AC-07: Abaikan dengan alasan

- Admin tidak bisa memproses rekomendasi tanpa memilih tambah atau abaikan.
- Abaikan menyimpan alasan ke `processed_note`.
- Rekomendasi yang diabaikan tidak muncul lagi di pending queue.

### AC-08: Empty/error state jelas

- Saat tidak ada pending sama sekali: `Tidak ada rekomendasi pending`.
- Saat pending ada tetapi bukan untuk cabang aktif: tampilkan jumlah pending di cabang lain dan tombol `Lihat Semua`.
- Saat integrasi error: order tetap bisa digunakan dan panel menyediakan tombol `Coba Lagi`.

## 9. Test Plan

### Unit/Backend

- Test filter Inventori:
  - `status=pending`
  - `status=all`
  - `date`
  - `date_from/date_to`
  - `branch_id`
- Test mapping PO:
  - branch ID match
  - material ID match
  - no branch mapping
  - no material mapping
- Test process idempotent:
  - pending menjadi processed
  - processed tidak berubah dan tidak error fatal

### Frontend

- Render panel loading, error, empty, ada data.
- Per-outlet filter memakai `po_outlet_id`.
- `Lihat Semua` tidak mengubah target outlet saat klik tambah.
- Tombol tambah disabled untuk mapping tidak lengkap.
- Process dipanggil setelah save berhasil.

### Manual E2E

1. Login Inventori sebagai staff Bunderan Dalung.
2. Submit laporan dengan Mentega, Susu, dan Keju dicentang harus diorder.
3. Cek `order_recommendations` berstatus `pending`.
4. Login Purchase Order.
5. Buka Input Order.
6. Pilih outlet Bunderan Dalung.
7. Panel menampilkan 3 rekomendasi.
8. Klik `Tambah` pada Susu.
9. Matrix order Bunderan Dalung terisi Susu qty 1.
10. Rekomendasi Susu menjadi `processed`.
11. Refresh halaman, Susu tidak muncul lagi di pending, Mentega dan Keju tetap muncul.

## 10. Urutan Implementasi

### Sprint 1: Perbaikan API Inventori

1. Tambah filter `status`, `date_from`, `date_to`, `branch_id`, `material_id`.
2. Tambah meta response.
3. Tambah index rekomendasi.
4. Test endpoint langsung.

### Sprint 2: Mapping PO

1. Tambah mapping cabang Inventori ke Outlet PO.
2. Tambah mapping bahan Inventori ke Material PO.
3. Update endpoint `/api/inventori/rekomendasi` agar output membawa `po_outlet_id` dan `po_material_id`.
4. Tambah warning mapping di response.

### Sprint 3: Revisi Panel PO

1. Ubah default fetch menjadi pending queue 7 hari.
2. Reload saat tanggal/filter berubah.
3. Filter per-outlet memakai `po_outlet_id`.
4. Tombol tambah memakai cabang asal rekomendasi.
5. Process setelah save berhasil.
6. Tambah flow abaikan dengan alasan.
7. Perbaiki empty state diagnostik.

### Sprint 4: QA dan Deploy

1. Jalankan test backend dan frontend.
2. Test E2E untuk cabang Bunderan Dalung.
3. Cek data production/staging:
   - outlet Bunderan Dalung sudah punya mapping cabang Inventori
   - Mentega, Susu, Keju sudah punya mapping bahan
4. Deploy Inventori.
5. Deploy Purchase Order.
6. Monitor rekomendasi pending selama 1 hari operasional.

## 11. Checklist Data Setup

### Outlet PO

Setiap outlet aktif harus memiliki:

- `inventori_branch_id` atau mapping cabang resmi
- `inventori_cabang_name` sebagai label fallback

Khusus kasus screenshot:

- Pastikan outlet `Bunderan Dalung` di PO menunjuk cabang Inventori yang sama dengan tempat staff submit laporan.

### Material PO

Setiap bahan yang bisa direkomendasikan staff harus punya mapping:

- Mentega
- Susu
- Keju
- Coklat
- bahan aktif lain sesuai mapping cabang

## 12. Risiko dan Mitigasi

| Risiko | Dampak | Mitigasi |
| --- | --- | --- |
| Pending queue menampilkan rekomendasi lama | Admin bingung | Tampilkan tanggal dan badge stale jika lebih dari 2 hari |
| Mapping belum lengkap | Item tidak bisa ditambah | Item tetap tampil dengan CTA setup mapping |
| Process gagal setelah order tersimpan | Item muncul lagi | Retry process, dan tampilkan badge "sudah masuk order lokal" sampai sukses |
| Nama cabang berubah | Rekomendasi hilang di per-outlet | Pakai ID mapping, nama hanya label |
| Admin salah abaikan | Rekomendasi hilang | Simpan processed_note dan sediakan laporan processed untuk audit |

## 13. Instruksi Push Setelah Implementasi

Setelah revisi kode selesai dan acceptance criteria lulus, developer harus:

```bash
git status
git add docs/PRD_Revisi_Rekomendasi_Order_Inventori_ke_Purchase_Order.md inventori-new purchase_order
git commit -m "fix: sync inventory recommendations to purchase order"
git push
```

Catatan: jangan masukkan file `.env`, build artifact, atau perubahan unrelated ke commit.
