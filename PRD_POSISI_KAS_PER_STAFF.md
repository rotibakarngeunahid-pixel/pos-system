# PRD Revisi Posisi Kas Per Staff

Tanggal: 2026-05-17  
Produk: Roti Bakar Ngeunah POS  
Area: Admin - Laporan Kas, Setoran Tunai, POS Staff  
Status: Draft PRD  
Prioritas: Tinggi

## 1. Ringkasan

Saat ini owner/admin dapat melihat laporan kas per cabang dan periode, tetapi belum ada tampilan yang menjawab pertanyaan operasional sederhana: "Sekarang uang kas yang masih dipegang masing-masing staff berapa?"

Revisi ini menambahkan fitur Posisi Kas Per Staff agar admin dapat memantau saldo kas berjalan setiap staff berdasarkan shift aktif, transaksi tunai, kas masuk/keluar, refund/void, dan setoran yang sudah dikonfirmasi. Fitur ini harus membantu owner mengambil keputusan harian seperti follow up setoran, cek staff yang masih memegang kas besar, dan audit kas saat pergantian shift.

## 2. Tujuan

1. Admin dapat melihat posisi kas terkini untuk setiap staff aktif.
2. Admin dapat melihat staff mana yang sedang membuka shift dan berapa estimasi kas yang masih dipegang.
3. Admin dapat melihat rincian komponen kas per staff: kas awal, penjualan tunai, kas masuk manual, kas keluar manual, refund, void, dan setoran terkonfirmasi.
4. Admin dapat melihat setoran pending per staff sebagai konteks kas yang sudah diajukan tetapi belum mengurangi posisi kas sistem.
5. Sistem menyediakan angka yang konsisten antara tab Kas di POS staff, proses tutup shift, dan laporan admin.
6. Admin dapat memfilter posisi kas berdasarkan cabang, status shift, dan nominal kas berisiko tinggi.

## 3. Kondisi Sistem Saat Ini

### 3.1 Struktur Aplikasi

- Aplikasi adalah web statis berbasis HTML, CSS, dan JavaScript.
- Data utama diakses melalui Supabase client global `db`.
- Halaman admin berada di `admin.html` dan dikendalikan oleh `js/admin.js`.
- Halaman POS staff berada di `pos.html` dan dikendalikan oleh `js/pos.js`.
- Service kas berada di `js/services/cashService.js`.
- Service setoran berada di `js/depositService.js` dan UI admin setoran berada di `js/adminDepositUi.js`.

### 3.2 Fitur Kas yang Sudah Ada

- Staff membuka shift melalui tabel `cashier_sessions` dengan `opening_cash`.
- POS staff menampilkan Ringkasan Kas untuk shift aktif lewat `cashService.getSummary({ branchId, sessionId })`.
- Transaksi tunai tercatat sebagai kas masuk melalui `cash_logs` dengan `reference_type = 'sale'`.
- Kas masuk/keluar manual tercatat di `cash_logs`.
- Refund, void, dan setoran terkonfirmasi tercatat sebagai kas keluar.
- Staff dapat membuat pengajuan setoran di `cash_deposits`.
- Admin dapat konfirmasi/tolak setoran melalui halaman Setoran Tunai.
- Saat setoran dikonfirmasi, RPC `confirm_deposit` membuat `cash_logs` keluar dengan `reference_type = 'deposit'`.
- Admin sudah memiliki Laporan Kas per cabang dan tanggal, tetapi agregasinya belum menjawab posisi kas per staff saat ini.

### 3.3 Masalah Saat Ini

Admin tidak dapat melihat secara langsung:

- Staff A sedang memegang kas berapa.
- Staff B sudah setor berapa dan masih tersisa berapa.
- Staff mana yang punya shift aktif dengan kas besar.
- Apakah kas yang dipegang staff sudah berkurang setelah setoran dikonfirmasi.
- Ringkasan posisi kas semua staff dalam satu layar.

Akibatnya owner harus menebak dari laporan cabang, riwayat transaksi, atau chat/manual konfirmasi ke staff.

## 4. Problem Statement

Owner/admin butuh visibilitas posisi kas per staff secara cepat dan dapat dipercaya. Sistem saat ini menghitung kas dengan benar di level shift staff, tetapi informasi itu tersebar di POS staff, laporan kas cabang, dan setoran. Belum ada agregasi admin yang menggabungkan data tersebut menjadi daftar posisi kas tiap staff.

Fitur yang dibutuhkan adalah dashboard operasional untuk menjawab:

- Siapa staffnya?
- Cabangnya apa?
- Shift aktif atau tidak?
- Kas sistem yang seharusnya dipegang sekarang berapa?
- Berapa setoran pending?
- Berapa setoran terkonfirmasi?
- Kapan aktivitas kas terakhir?

## 5. Definisi Posisi Kas

### 5.1 Posisi Kas Staff Aktif

Untuk staff yang memiliki shift aktif, posisi kas adalah estimasi kas yang masih berada di staff/laci berdasarkan sistem.

Formula:

```text
posisi_kas =
  kas_awal
  + penjualan_tunai_completed
  + kas_masuk_manual
  - kas_keluar_manual
  - refund_tunai
  - void_tunai
  - setoran_terkonfirmasi
```

Nilai ini harus sama dengan `expectedCash` yang ditampilkan di POS staff untuk shift yang sama.

### 5.2 Setoran Pending

Setoran pending adalah pengajuan setoran staff yang statusnya `pending`.

Setoran pending tidak boleh mengurangi posisi kas sampai dikonfirmasi admin, karena secara sistem uang belum dianggap diterima/diproses.

### 5.3 Setoran Terkonfirmasi

Setoran terkonfirmasi adalah setoran dengan status `confirmed`.

Setoran terkonfirmasi harus mengurangi posisi kas jika setoran tersebut terkait dengan `session_id` shift aktif atau shift terkait. Jika setoran manual admin dibuat tanpa `session_id`, nilai tersebut ditampilkan sebagai aktivitas setoran staff, tetapi tidak boleh diam-diam mengurangi shift aktif kecuali ada aturan eksplisit untuk mengaitkannya.

### 5.4 Staff Tanpa Shift Aktif

Staff tanpa shift aktif tetap boleh muncul, tetapi statusnya harus jelas:

- `Tidak Ada Shift Aktif`
- posisi kas aktif = `Rp 0`
- tampilkan shift terakhir dan kas tutup terakhir jika tersedia
- tampilkan setoran pending jika masih ada

## 6. Scope

### 6.1 In Scope

- Menu atau subtab admin untuk melihat posisi kas per staff.
- Ringkasan semua staff aktif dalam satu tabel/kartu.
- Filter berdasarkan cabang, status shift, dan nominal posisi kas.
- Detail per staff untuk melihat komponen hitungan.
- Indikator setoran pending dan setoran terkonfirmasi.
- RPC atau service query yang menghitung posisi kas secara konsisten.
- Integrasi refresh setelah setoran dikonfirmasi/ditolak/manual.
- Empty state dan error state yang jelas.
- QA test plan untuk alur transaksi, kas manual, refund/void, setoran, dan tutup shift.

### 6.2 Out of Scope

- Mengubah cara checkout POS.
- Mengubah aturan nominal setoran kelipatan Rp 50.000.
- Membuat rekonsiliasi fisik kas otomatis.
- Mengganti sistem shift.
- Membuat approval multi-level untuk setoran.
- Membangun realtime multi-device penuh sebagai syarat MVP.
- Mengubah data historis transaksi atau setoran lama.

## 7. User Persona

### Owner / Admin

Owner mengawasi kas operasional harian. Owner perlu tahu siapa staff yang masih memegang uang, siapa yang sudah setor, dan mana yang perlu difollow up.

### Staff / Kasir

Staff memakai POS untuk transaksi dan setoran. Staff tidak membutuhkan dashboard semua staff, tetapi angka yang dilihat admin harus konsisten dengan Ringkasan Kas miliknya.

## 8. UX Requirement

### 8.1 Entry Point

Tambahkan entry point di Admin pada area Kas.

Opsi yang direkomendasikan:

1. Tambahkan menu baru `Posisi Kas Staff` di sidebar Kas, atau
2. Tambahkan subtab baru di halaman `Laporan Kas`.

Rekomendasi MVP: menu baru `Posisi Kas Staff`, karena pertanyaannya adalah monitoring saat ini, bukan laporan historis periode.

### 8.2 Tampilan Utama

Tampilan utama harus berisi:

- Header: `Posisi Kas Staff`
- Tombol `Refresh`
- Filter cabang
- Filter status shift:
  - Semua
  - Shift Aktif
  - Tidak Ada Shift Aktif
  - Shift Ditutup Hari Ini
- Filter risiko:
  - Semua
  - Kas > Rp 500.000
  - Kas > Rp 1.000.000
  - Ada setoran pending
- Timestamp `Terakhir diperbarui`

### 8.3 Summary Cards

Tampilkan kartu ringkasan:

| Kartu | Definisi |
| --- | --- |
| Total Posisi Kas Aktif | Total posisi kas dari semua shift aktif. |
| Staff Shift Aktif | Jumlah staff dengan shift aktif. |
| Setoran Pending | Total nominal setoran pending. |
| Perlu Perhatian | Jumlah staff dengan posisi kas melewati threshold atau setoran pending. |

### 8.4 Tabel Posisi Kas

Kolom minimal:

| Kolom | Isi |
| --- | --- |
| Staff | Nama staff. |
| Cabang | Nama cabang staff/shift. |
| Status Shift | Aktif, Tidak Ada Shift Aktif, Ditutup Hari Ini. |
| Dibuka | Waktu buka shift aktif. |
| Posisi Kas | Estimasi kas yang masih dipegang. |
| Setoran Pending | Nominal setoran pending staff. |
| Setoran Terkonfirmasi | Nominal setoran terkonfirmasi pada shift aktif/hari ini. |
| Aktivitas Terakhir | Waktu transaksi/kas/setoran terakhir. |
| Aksi | Detail, Input Manual Setoran. |

### 8.5 State Visual

- Posisi kas `0`: netral.
- Posisi kas positif normal: hijau/normal.
- Posisi kas di atas threshold: warning.
- Posisi kas negatif: danger dan tampilkan label `Perlu Audit`.
- Ada setoran pending: badge `Pending`.
- Shift aktif: badge `Aktif`.
- Tidak ada shift aktif: badge abu-abu.

### 8.6 Detail Staff

Klik `Detail` membuka modal/panel berisi:

- Staff, cabang, status shift.
- Session ID jika ada.
- Kas awal.
- Penjualan tunai.
- Kas masuk manual.
- Kas keluar manual.
- Refund.
- Void.
- Setoran terkonfirmasi.
- Posisi kas akhir.
- Setoran pending.
- Riwayat kas terakhir, maksimal 20 baris.
- Riwayat setoran terakhir, maksimal 20 baris.

## 9. Functional Requirements

### FR-01 - Melihat Posisi Kas Semua Staff

Admin dapat membuka halaman `Posisi Kas Staff` dan melihat daftar posisi kas seluruh staff aktif.

Kriteria:

- Staff aktif dari tabel `users` dengan `role = 'staff'` dan `is_active != false` muncul.
- Staff yang punya shift aktif ditampilkan dengan angka posisi kas aktif.
- Staff yang tidak punya shift aktif tetap muncul jika filter `Semua` dipilih.
- Data default diurutkan dari posisi kas terbesar ke terkecil, lalu nama staff.

### FR-02 - Hitung Posisi Kas Berdasarkan Shift Aktif

Untuk setiap shift aktif, sistem harus menghitung posisi kas berdasarkan `cashier_sessions`, `transactions`, `cash_logs`, dan `cash_deposits`.

Kriteria:

- Sumber utama shift aktif adalah `cashier_sessions.status = 'open'`.
- Perhitungan memakai `session_id`, bukan hanya `branch_id`, agar tidak tercampur antar staff di cabang yang sama.
- Transaksi tunai yang dihitung hanya `transactions.status = 'completed'` dan `payment_method = 'cash'`.
- Cash log yang `is_void = true` tidak mempengaruhi posisi kas.
- Setoran pending tidak mengurangi posisi kas.
- Setoran rejected tidak mengurangi posisi kas.
- Setoran confirmed mengurangi posisi kas melalui cash log deposit.

### FR-03 - Konsistensi Dengan POS Staff

Nilai `Posisi Kas` pada admin harus sama dengan `Ekspektasi Kas` di POS staff untuk `session_id` yang sama.

Kriteria:

- Jika staff membuka tab Kas di POS dan admin membuka detail staff yang sama, angka expected cash sama.
- Jika ada transaksi tunai baru, setelah refresh angka admin bertambah.
- Jika ada kas keluar manual, setelah refresh angka admin berkurang.
- Jika setoran dikonfirmasi, setelah refresh angka admin berkurang.

### FR-04 - Filter Cabang

Admin dapat memfilter posisi kas berdasarkan cabang.

Kriteria:

- Filter cabang default `Semua Cabang`.
- Jika cabang dipilih, hanya staff/shift cabang tersebut yang muncul.
- Untuk staff tanpa shift aktif, gunakan `users.branch_id`.
- Untuk staff dengan shift aktif, gunakan `cashier_sessions.branch_id`.

### FR-05 - Filter Status Shift

Admin dapat memfilter berdasarkan status shift.

Kriteria:

- `Shift Aktif` hanya menampilkan staff dengan `cashier_sessions.status = 'open'`.
- `Tidak Ada Shift Aktif` menampilkan staff aktif tanpa shift open.
- `Shift Ditutup Hari Ini` menampilkan staff dengan sesi terakhir `closed` pada hari berjalan.
- `Semua` menampilkan seluruh staff aktif sesuai filter cabang.

### FR-06 - Setoran Pending Per Staff

Sistem menampilkan total setoran pending per staff.

Kriteria:

- Pending diambil dari `cash_deposits.status = 'pending'`.
- Jika staff punya shift aktif, prioritaskan pending dengan `session_id` shift aktif.
- Jika ada pending tanpa `session_id`, tetap tampilkan sebagai pending staff dengan badge `Manual/Non-shift`.
- Klik badge pending dapat membuka halaman Setoran Tunai dengan filter staff/cabang terkait jika filter staff tersedia, atau minimal filter cabang dan status pending.

### FR-07 - Detail Komponen Hitungan

Admin dapat melihat breakdown hitungan posisi kas per staff.

Kriteria:

- Detail menampilkan formula yang sama dengan definisi PRD.
- Detail membedakan transaksi tunai, kas manual, refund, void, dan setoran.
- Detail menampilkan log yang di-void sebagai riwayat, tetapi tidak masuk total.
- Detail menampilkan waktu aktivitas terakhir.

### FR-08 - Refresh Data

Halaman memiliki tombol `Refresh` dan otomatis refresh saat admin masuk halaman.

Kriteria:

- Klik `Refresh` memuat ulang data dari database.
- Setelah admin konfirmasi/tolak setoran, halaman posisi kas ikut ditandai dirty atau refresh jika sedang terbuka.
- Setelah input setoran manual berhasil, halaman posisi kas ikut refresh jika sedang terbuka.
- Tampilkan loading state pada summary dan tabel.

### FR-09 - Threshold Perhatian

Sistem memberi penanda untuk posisi kas yang perlu perhatian.

Kriteria:

- Threshold default MVP:
  - warning jika posisi kas > Rp 500.000
  - high warning jika posisi kas > Rp 1.000.000
  - danger jika posisi kas < Rp 0
- Threshold boleh hardcoded untuk MVP.
- Threshold dapat dipindahkan ke settings pada fase berikutnya.

### FR-10 - Aksi Input Manual Setoran Dari Baris Staff

Pada baris staff, admin dapat membuka modal Input Manual Setoran dengan staff dan cabang terisi otomatis.

Kriteria:

- Tombol hanya aktif untuk staff aktif.
- Jika staff tidak punya cabang, tombol disabled dengan tooltip/alasan.
- Modal memakai flow existing di `adminDepositUi.openManualDepositModal()`.
- Setelah simpan, data posisi kas dan tabel setoran refresh.

## 10. Data Requirement

### 10.1 Tabel yang Digunakan

| Tabel | Fungsi |
| --- | --- |
| `users` | Daftar staff dan cabang default staff. |
| `branches` | Nama cabang. |
| `cashier_sessions` | Shift aktif/terakhir, kas awal, kas tutup. |
| `transactions` | Penjualan tunai completed per session. |
| `cash_logs` | Kas masuk/keluar manual, refund, void, deposit. |
| `cash_deposits` | Setoran pending/confirmed/rejected per staff/session. |
| `cash_categories` | Label kategori kas. |

### 10.2 Output Data Posisi Kas

Service/RPC harus mengembalikan struktur minimal:

| Field | Tipe | Keterangan |
| --- | --- | --- |
| `staff_id` | bigint | ID staff. |
| `staff_name` | text | Nama staff. |
| `branch_id` | bigint | Cabang dari shift aktif atau default staff. |
| `branch_name` | text | Nama cabang. |
| `session_id` | bigint/null | Shift aktif jika ada. |
| `session_status` | text | `open`, `closed`, atau `none`. |
| `opened_at` | timestamptz/null | Waktu buka shift aktif. |
| `closed_at` | timestamptz/null | Waktu tutup shift terakhir jika ada. |
| `opening_cash` | numeric | Kas awal. |
| `cash_sales_in` | numeric | Penjualan tunai completed. |
| `manual_in` | numeric | Kas masuk manual. |
| `manual_out` | numeric | Kas keluar manual. |
| `refund_out` | numeric | Refund tunai. |
| `void_out` | numeric | Void tunai. |
| `deposit_confirmed` | numeric | Setoran confirmed terkait sesi/hari ini. |
| `deposit_pending` | numeric | Setoran pending. |
| `expected_cash` | numeric | Posisi kas aktif. |
| `last_activity_at` | timestamptz/null | Aktivitas kas/transaksi/setoran terakhir. |
| `risk_level` | text | `normal`, `warning`, `high`, `danger`. |

## 11. Technical Recommendation

### 11.1 Tambahkan RPC Database

Buat RPC baru, misalnya:

```sql
public.get_staff_cash_positions(
  p_branch_id bigint DEFAULT NULL,
  p_status text DEFAULT 'all'
)
```

Alasan RPC direkomendasikan:

- Perhitungan melibatkan beberapa tabel dan agregasi.
- Mengurangi query client yang berulang per staff.
- Menghindari race/stale calculation antar request.
- Menjaga formula posisi kas sebagai single source of truth.

### 11.2 Tambahkan Service Client

Tambahkan method pada `js/services/cashService.js`:

```js
async getStaffCashPositions({ branchId = null, status = 'all' } = {})
async getStaffCashPositionDetail({ staffId, sessionId = null })
```

Service ini dipakai oleh Admin UI. Jangan menghitung seluruh posisi kas staff dengan loop `cashService.getSummary()` per staff jika jumlah staff dapat bertambah, karena itu akan membuat banyak query.

### 11.3 Tambahkan UI Admin

Opsi file:

- Tambahkan section baru di `admin.html`: `section-staff-cash-position`.
- Tambahkan loader di `ADMIN.navigate()` untuk section baru.
- Tambahkan controller kecil di `js/admin.js`, atau buat file baru `js/adminStaffCashUi.js` bila ingin memisahkan dari `admin.js`.

Rekomendasi: buat `js/adminStaffCashUi.js` jika implementasi detail/modal cukup besar, supaya `admin.js` tidak makin berat.

### 11.4 Integrasi Dengan Setoran

Saat aksi berikut terjadi, posisi kas harus refresh atau ditandai dirty:

- `adminDepositUi.doConfirm()`
- `adminDepositUi.doReject()`
- `adminDepositUi.saveManualDeposit()`
- `POS.submitCashEntry()`
- `POS.voidCashLogFromPOS()`
- `POS.confirmCheckout()`
- `POS.confirmCloseShift()`

Untuk MVP, refresh manual di admin cukup, tetapi setelah aksi setoran admin berhasil sebaiknya panggil:

```js
if (window.adminStaffCashUi) adminStaffCashUi.markDirty();
```

Jika section posisi kas sedang aktif, jalankan reload.

## 12. Business Rules

1. Posisi kas staff dihitung dari session aktif staff, bukan hanya total cabang.
2. Satu staff tidak boleh punya lebih dari satu shift aktif pada cabang yang sama.
3. Jika data historis memiliki lebih dari satu shift aktif untuk staff yang sama, tampilkan warning `Duplikat Shift Aktif` dan hitung per session secara terpisah atau pilih sesi terbaru dengan flag audit.
4. Staff nonaktif tidak muncul secara default.
5. Staff nonaktif boleh muncul jika filter future `Termasuk Nonaktif` ditambahkan, tetapi bukan scope MVP.
6. Setoran pending tidak mengurangi posisi kas.
7. Setoran confirmed mengurangi posisi kas melalui `cash_logs.reference_type = 'deposit'`.
8. Cash log void tidak mempengaruhi total.
9. Transaksi void tidak dihitung sebagai penjualan tunai completed.
10. Nominal negatif pada posisi kas harus dianggap kondisi audit, bukan otomatis dibetulkan.

## 13. Acceptance Criteria

### AC-01 - Admin Melihat Semua Staff Aktif

Given admin membuka `Posisi Kas Staff`  
When data selesai dimuat  
Then semua staff aktif tampil sesuai filter cabang  
And staff dengan shift aktif memiliki nilai posisi kas  
And staff tanpa shift aktif memiliki status `Tidak Ada Shift Aktif`.

### AC-02 - Transaksi Tunai Menambah Posisi Kas

Given staff membuka shift dengan kas awal Rp 100.000  
When staff membuat transaksi tunai completed Rp 50.000  
Then posisi kas staff di admin menjadi Rp 150.000 setelah refresh.

### AC-03 - Kas Keluar Manual Mengurangi Posisi Kas

Given posisi kas staff Rp 150.000  
When staff mencatat kas keluar manual Rp 20.000  
Then posisi kas staff di admin menjadi Rp 130.000 setelah refresh.

### AC-04 - Setoran Pending Tidak Mengurangi Posisi Kas

Given posisi kas staff Rp 500.000  
When staff membuat setoran Rp 200.000 dengan status pending  
Then posisi kas tetap Rp 500.000  
And kolom Setoran Pending menampilkan Rp 200.000.

### AC-05 - Setoran Confirmed Mengurangi Posisi Kas

Given posisi kas staff Rp 500.000  
And ada setoran pending Rp 200.000  
When admin mengkonfirmasi setoran tersebut  
Then posisi kas menjadi Rp 300.000 setelah refresh  
And Setoran Pending menjadi Rp 0  
And Setoran Terkonfirmasi bertambah Rp 200.000.

### AC-06 - Angka Sama Dengan POS Staff

Given staff membuka tab Kas di POS  
And admin membuka detail posisi kas staff yang sama  
Then nilai `Ekspektasi Kas` POS sama dengan `Posisi Kas` admin untuk session yang sama.

### AC-07 - Staff Tutup Shift

Given staff menutup shift  
When admin refresh posisi kas  
Then staff tidak lagi muncul di filter `Shift Aktif`  
And pada filter `Semua`, staff tampil sebagai `Tidak Ada Shift Aktif` atau `Shift Ditutup Hari Ini`.

## 14. Edge Cases

1. Staff punya shift aktif tetapi belum ada transaksi: posisi kas = kas awal.
2. Staff punya setoran pending tanpa shift aktif: tampilkan pending, posisi kas aktif Rp 0.
3. Staff pindah cabang setelah shift dibuka: untuk shift aktif, cabang yang dipakai adalah cabang pada `cashier_sessions`.
4. Cash log deposit dibuat tanpa `session_id`: tampilkan di riwayat staff jika berasal dari `cash_deposits.staff_id`, tetapi jangan mengurangi shift aktif tanpa relasi session.
5. Ada cash log void: tampilkan di detail sebagai voided, tetapi total tidak berubah.
6. Ada transaksi void: jangan masuk penjualan tunai completed.
7. Ada koneksi lambat: tampilkan skeleton/loading dan jangan kosongkan angka lama tanpa indikator.
8. Ada error RPC: tampilkan error state dengan tombol retry.

## 15. Non-Functional Requirements

1. Load awal halaman posisi kas maksimal 3 detik untuk 50 staff pada koneksi normal.
2. Perhitungan posisi kas harus dilakukan dalam query/RPC agregat, bukan N+1 query per staff.
3. UI responsif untuk desktop dan tablet.
4. Tombol aksi harus disabled saat loading untuk mencegah double action.
5. Semua nominal memakai format Rupiah yang sama dengan fungsi existing `fRp`/`formatRupiah`.
6. Tidak ada perubahan data saat admin hanya membuka halaman posisi kas.
7. Data historis tidak boleh dimutasi oleh fitur dashboard.

## 16. Analytics dan Audit

MVP tidak wajib menambah event analytics, tetapi sistem harus bisa diaudit dari data existing:

- Sumber posisi kas dari `cashier_sessions`, `transactions`, `cash_logs`, dan `cash_deposits`.
- Detail staff harus cukup untuk menjelaskan angka akhir.
- Jika angka negatif atau duplikat shift aktif ditemukan, UI harus menampilkan tanda audit.

## 17. QA Test Plan

### 17.1 Test Data Minimal

Siapkan:

- 2 cabang aktif.
- 3 staff aktif.
- 1 staff tanpa shift aktif.
- 1 staff dengan shift aktif tanpa transaksi.
- 1 staff dengan shift aktif, transaksi tunai, kas manual, dan setoran.

### 17.2 Skenario Wajib

1. Buka halaman posisi kas dengan filter semua cabang.
2. Buka filter cabang tertentu.
3. Buat transaksi tunai di POS, refresh admin, cek posisi kas bertambah.
4. Buat transaksi non-tunai, refresh admin, cek posisi kas tidak bertambah.
5. Catat kas masuk manual, cek posisi kas bertambah.
6. Catat kas keluar manual, cek posisi kas berkurang.
7. Buat setoran pending, cek pending bertambah dan posisi kas tidak berubah.
8. Konfirmasi setoran, cek pending turun dan posisi kas berkurang.
9. Tolak setoran, cek pending turun dan posisi kas tidak berkurang.
10. Void cash log, cek total kembali sesuai aturan.
11. Tutup shift, cek staff hilang dari filter shift aktif.
12. Bandingkan angka admin dengan tab Kas POS untuk session yang sama.

## 18. Risiko

| Risiko | Dampak | Mitigasi |
| --- | --- | --- |
| Formula admin berbeda dengan POS | Owner melihat angka tidak konsisten | Jadikan RPC/service sebagai single source of truth dan samakan dengan `cashService.getSummary`. |
| Query lambat jika hitung per staff di client | Dashboard lambat | Gunakan RPC agregat. |
| Setoran manual tanpa session membingungkan | Posisi kas terlihat tidak berkurang | Tampilkan label `Manual/Non-shift` dan dokumentasikan bahwa tidak mengurangi shift aktif. |
| Data lama punya shift aktif duplikat | Angka ambigu | Tampilkan warning audit dan detail session. |
| Admin mengira pending sudah mengurangi kas | Salah follow up | Bedakan jelas `Posisi Kas` dan `Setoran Pending`. |

## 19. Rollout Plan

### Phase 1 - MVP

- Tambah RPC agregat posisi kas staff.
- Tambah service `cashService.getStaffCashPositions`.
- Tambah halaman admin `Posisi Kas Staff`.
- Tampilkan summary, filter cabang/status, tabel, dan detail dasar.
- Integrasi refresh setelah konfirmasi setoran admin.

### Phase 2 - Penyempurnaan

- Tambah threshold configurable.
- Tambah deep link dari badge pending ke Setoran Tunai dengan filter lebih spesifik.
- Tambah export CSV/PDF.
- Tambah auto refresh interval opsional, misalnya 60 detik.
- Tambah indikator realtime ringan via `RBNDataEvents`.

### Phase 3 - Rekonsiliasi Lanjutan

- Tambah fitur audit selisih staff per shift.
- Tambah catatan follow up admin.
- Tambah laporan historis posisi kas per staff per hari.

## 20. Open Questions

1. Apakah staff tanpa shift aktif tetapi punya setoran pending harus selalu tampil di bagian atas?
2. Apakah threshold warning Rp 500.000 dan Rp 1.000.000 sudah sesuai SOP outlet?
3. Apakah setoran manual admin tanpa session perlu opsi untuk dikaitkan ke shift aktif staff jika ada?
4. Apakah owner membutuhkan export posisi kas harian pada MVP?
5. Apakah investor boleh melihat posisi kas staff, atau fitur ini hanya untuk admin?

## 21. Definition of Done

Fitur dianggap selesai jika:

1. Admin dapat membuka halaman Posisi Kas Staff.
2. Semua staff aktif tampil sesuai filter.
3. Staff dengan shift aktif menampilkan posisi kas yang benar.
4. Angka admin konsisten dengan POS staff untuk session yang sama.
5. Setoran pending dan confirmed ditampilkan dengan perlakuan yang benar.
6. Detail staff menjelaskan komponen hitungan.
7. Refresh setelah konfirmasi setoran berjalan.
8. QA scenario wajib lulus.
9. Tidak ada regresi pada POS checkout, Ringkasan Kas POS, Tutup Shift, dan Setoran Tunai.

