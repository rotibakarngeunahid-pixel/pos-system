# PRD Fix User Onboarding / Guided Tour First Login

Tanggal: 2026-05-16
Produk: POS Roti Bakar Ngeunah
Area: POS Staff, Admin Staff Management, Database Onboarding
Prioritas: P0
Status: Ready for implementation

## 1. Ringkasan

Fitur onboarding / guided tour wajib muncul otomatis saat staff baru pertama kali membuka POS. Tour harus memandu staff langkah demi langkah dari kondisi paling awal, terutama saat staff belum punya shift aktif dan perlu mengisi kas awal. Setelah kas awal diisi dan shift dibuka, tour lanjut ke fitur utama POS: tampilan cabang, pencarian produk, kategori, keranjang, pembayaran, stok, riwayat transaksi, kas, tutup shift, dan setoran tunai.

Saat ini codebase sudah memiliki implementasi onboarding, namun ada indikasi kuat tour tidak pernah dipanggil dari POS karena modul onboarding tidak diekspos ke `window`. Dokumen ini menjadi PRD implementasi perbaikan agar fitur muncul konsisten untuk akun staff baru, tidak mengganggu transaksi, dan tidak membuat error runtime.

## 2. Masalah Saat Ini

User membuat akun staff baru, login ke POS, tetapi onboarding tidak muncul. Ekspektasi bisnis: staff baru harus langsung dipandu dari langkah membuka shift dan memasukkan kas awal.

Temuan dari codebase:

- `pos.html` sudah memiliki markup onboarding: `#ob-entry-panel`, `#ob-overlay`, `#ob-highlight-box`, `#ob-pointer`, `#ob-tooltip`, `#ob-complete-banner`, dan `#ob-reopen-btn`.
- `pos.html` sudah memuat `js/onboarding.js`.
- `js/pos.js` mencoba menjalankan onboarding dengan kondisi `if (window.Onboarding && this.user)`.
- `js/onboarding.js` mendefinisikan `const Onboarding = (() => { ... })();` tetapi tidak menetapkan `window.Onboarding = Onboarding`.
- Karena top-level `const` tidak otomatis menjadi properti `window`, pengecekan `window.Onboarding` dapat bernilai `undefined`, sehingga `Onboarding.init(this.user)` tidak pernah dipanggil.
- Database migration `021_staff_onboarding.sql` sudah menyiapkan tabel, trigger, RPC, dan seed step onboarding, tetapi frontend tetap tidak akan tampil jika modul tidak pernah diinisialisasi.

## 3. Tujuan

1. Onboarding muncul otomatis untuk akun baru role `staff` saat pertama kali membuka `pos.html`.
2. Jika shift belum aktif, tour langsung mulai dari modal shift dan memandu input kas awal.
3. Jika shift sudah aktif, staff melihat panel "Pelatihan Staff Baru" dan dapat mulai tour.
4. Progress onboarding tersimpan dan dapat dilanjutkan setelah refresh, logout, atau koneksi sempat bermasalah.
5. Setelah selesai, onboarding tidak muncul lagi untuk user yang sama.
6. Admin dapat melihat status onboarding staff.
7. Tidak ada error JavaScript di console saat login, membuka shift, menjalankan tour, refresh, atau menyelesaikan tour.
8. POS tetap bisa digunakan walaupun onboarding RPC gagal.

## 4. Non-Goals

- Tidak membuat transaksi dummy.
- Tidak membuat stok dummy.
- Tidak membuat kas masuk/keluar palsu.
- Tidak otomatis melakukan checkout, void, refund, tutup shift, atau setoran tunai.
- Tidak menampilkan onboarding otomatis untuk admin atau investor.
- Tidak memaksa staff lama mengikuti onboarding jika sudah tidak memiliki assignment dan sudah aktif operasional sebelum fitur dirilis.

## 5. Persona

### Staff Baru

Staff baru butuh arahan visual saat pertama kali memakai aplikasi. Staff harus tahu urutan kerja tanpa perlu membaca manual terpisah.

### Admin / Owner

Admin perlu memastikan akun staff baru langsung mendapat pelatihan dan bisa melihat status apakah onboarding sudah selesai.

## 6. User Journey Utama

### 6.1 Staff Baru Login Tanpa Shift Aktif

1. Admin membuat user baru dengan role `staff` dan memilih cabang.
2. Staff login ke aplikasi.
3. Staff diarahkan ke `pos.html`.
4. POS memvalidasi user dan cabang.
5. POS menjalankan `initShift()`.
6. Karena belum ada shift aktif, POS membuka `#modal-shift`.
7. Onboarding otomatis aktif tanpa perlu klik tombol mulai.
8. Tooltip pertama menjelaskan bahwa staff akan membuka shift.
9. Tooltip berikutnya menunjuk `#shift-opening-cash`.
10. Staff mengisi kas awal.
11. Tooltip menunjuk `#btn-open-shift`.
12. Staff klik "Buka Shift & Mulai Berjualan".
13. Setelah modal shift tertutup, tour otomatis lanjut ke langkah POS berikutnya.

### 6.2 Staff Baru Login Dengan Shift Sudah Aktif

1. Staff login ke POS.
2. POS menemukan shift aktif.
3. Onboarding menampilkan bottom sheet `#ob-entry-panel`.
4. Staff klik "Mulai Pelatihan".
5. Tour dimulai dari langkah non-modal pertama, karena shift sudah terbuka.

### 6.3 Staff Refresh Saat Tour Berjalan

1. Staff sedang mengikuti tour.
2. Browser refresh atau logout.
3. Saat login berikutnya, progress dibaca dari database atau fallback localStorage.
4. Tour lanjut dari langkah belum selesai berikutnya.

### 6.4 Staff Menyelesaikan Tour

1. Staff menyelesaikan semua langkah required.
2. Assignment berubah menjadi `completed`.
3. Local marker `ob_done_{user_id}` diset.
4. Login berikutnya tidak menampilkan tour otomatis.

## 7. Kebutuhan Fungsional

### FR-001 - Modul Onboarding Harus Bisa Dipanggil POS

`js/onboarding.js` wajib mengekspos API ke global browser:

```js
window.Onboarding = Onboarding;
```

Atau lebih baik:

```js
window.Onboarding = (() => {
  // implementation
  return { init };
})();
```

Acceptance:

- Di console browser setelah `pos.html` selesai load, ekspresi ini harus `true`:

```js
typeof window.Onboarding?.init === 'function'
```

### FR-002 - POS Harus Menginisialisasi Onboarding Setelah User, Cabang, Shift, dan Produk Siap

`js/pos.js` harus memanggil onboarding setelah:

- `auth.requireRole('staff')` sukses.
- `auth.validateCurrentUser()` sukses.
- Cabang ditemukan atau dipilih.
- `initShift()` selesai membuka atau mendeteksi modal shift.
- `loadProducts()` minimal sudah dipanggil.
- Loader utama POS sudah ditutup.

Implementation note:

```js
if (window.Onboarding && this.user) {
  window.Onboarding.init(this.user).catch(err => {
    console.warn('[Onboarding] init failed', err);
  });
}
```

Acceptance:

- Error onboarding tidak boleh menghentikan `POS.init()`.
- Error tidak boleh disembunyikan total saat development; minimal ada `console.warn`.
- Tidak ada `ReferenceError: Onboarding is not defined`.

### FR-003 - Onboarding Otomatis untuk Staff Baru

Saat user baru role `staff` dibuat, database wajib membuat satu assignment onboarding dengan status `not_started`.

Sumber kebenaran:

- `onboarding_templates`
- `onboarding_steps`
- `user_onboarding_assignments`
- `user_onboarding_step_progress`
- `onboarding_events`

Assignment dibuat oleh trigger `trg_create_staff_onboarding_assignment`.

Acceptance SQL:

```sql
SELECT tgname
FROM pg_trigger
WHERE tgname = 'trg_create_staff_onboarding_assignment'
  AND NOT tgisinternal;
```

Harus mengembalikan satu row.

### FR-004 - Fallback Jika Assignment Belum Ada

Jika `get_my_onboarding(p_user_id)` tidak mengembalikan assignment karena migration belum lengkap atau data lama tidak tersinkron, UI tetap harus bisa tampil dalam mode local fallback.

Ketentuan:

- Fallback hanya untuk role `staff`.
- Fallback menyimpan progress ke localStorage.
- Fallback tidak boleh membuat transaksi, stok, kas, shift, atau setoran.
- Jika koneksi database pulih dan assignment tersedia, pending progress disinkronkan.

Acceptance:

- Jika RPC gagal, POS tetap terbuka.
- Staff tetap melihat tour lokal.
- Console hanya berisi warning terkendali, bukan uncaught exception.

### FR-005 - Tour Dimulai dari Kas Awal Jika Shift Modal Terbuka

Jika `#modal-shift` memiliki class `active`, onboarding harus menjalankan langkah modal:

1. Welcome.
2. Penjelasan kas awal dengan target `#shift-opening-cash`.
3. Instruksi klik buka shift dengan target `#btn-open-shift`.

Ketentuan UX:

- Overlay modal step tidak boleh memblokir input kas awal.
- Staff harus tetap bisa mengetik dan klik tombol buka shift.
- Tombol "Lanjut" disembunyikan pada step yang butuh aksi klik buka shift.
- Setelah modal tertutup, tour auto-advance.

Acceptance:

- Dalam 2 detik setelah modal shift tampil, tooltip onboarding terlihat.
- Pointer animasi mengarah ke input kas awal.
- Staff bisa mengetik angka di input kas awal.
- Staff bisa klik `#btn-open-shift`.
- Setelah shift terbuka, tour lanjut otomatis tanpa refresh.

### FR-006 - Entry Panel Saat Shift Sudah Terbuka

Jika shift sudah aktif, onboarding menampilkan `#ob-entry-panel`.

Panel wajib berisi:

- Judul: "Pelatihan Staff Baru".
- Deskripsi pendek.
- Progress: "X dari Y langkah selesai".
- Tombol utama: "Mulai Pelatihan" atau "Lanjutkan".
- Tombol sekunder: "Nanti".

Acceptance:

- Panel muncul maksimal 2 detik setelah POS siap.
- Klik "Nanti" menutup panel sementara dan menampilkan `#ob-reopen-btn`.
- Klik reopen menampilkan panel lagi.

### FR-007 - Animasi Guided Tour

Tour wajib memiliki animasi visual berikut:

- Entry panel slide-in dari bawah.
- Overlay fade-in.
- Spotlight / highlight pada target.
- Pointer bounce mengarah ke target.
- Tooltip fade/slide antar step.
- Progress bar bergerak mengikuti step.
- Completion banner slide/fade saat selesai.

Accessibility:

- Gunakan `prefers-reduced-motion` untuk mengurangi animasi bagi device/user yang meminta motion dikurangi.
- Tooltip harus tetap terbaca di mobile.
- Tidak boleh ada teks keluar dari container.

Acceptance:

- Animasi tidak menyebabkan layout shift besar.
- Tooltip tidak menutupi target utama secara fatal.
- Pada viewport mobile 360x740, tombol tooltip tetap terlihat dan bisa diklik.

### FR-008 - Target Selector Harus Tahan Perubahan UI

Setiap step memiliki target selector. Jika selector tidak ditemukan:

- Tour tidak boleh crash.
- Tooltip tampil di tengah layar.
- Step tetap bisa dilanjutkan.
- Console memberi warning ringan dengan `step_key` dan selector.

Acceptance:

- Menghapus salah satu target selector secara sementara tidak menghasilkan uncaught exception.
- Tour tetap bisa selesai.

### FR-009 - Progress Persisten

Setiap klik Next atau Done harus:

- Menandai step sebagai completed di memory.
- Memanggil RPC `complete_onboarding_step`.
- Jika RPC gagal, simpan pending step di localStorage.
- Saat init berikutnya, sinkronkan pending step.

Acceptance:

- Refresh setelah menyelesaikan 3 step tidak mengulang dari step pertama.
- Jika koneksi sempat gagal, pending step tidak hilang.

### FR-010 - Admin Melihat Status Onboarding

Daftar staff di admin harus menampilkan status:

- `Belum mulai`
- `Sedang berjalan`
- `Selesai`
- `Tidak ada onboarding`

Acceptance:

- Setelah staff baru dibuat, badge status muncul sebagai `Belum mulai`.
- Setelah staff klik mulai, badge berubah menjadi `Sedang berjalan`.
- Setelah selesai, badge berubah menjadi `Selesai`.

## 8. Materi Tour MVP

Urutan step MVP:

| No | Step Key | Target | Tujuan |
| --- | --- | --- | --- |
| 1 | `m0_welcome` | none | Sambutan dan konteks tour |
| 2 | `m0_kas_awal` | `#shift-opening-cash` | Jelaskan kas awal |
| 3 | `m0_open_shift` | `#btn-open-shift` | Staff membuka shift |
| 4 | `m1_staff_name` | `#header-staff-name` | Validasi nama login |
| 5 | `m1_branch_name` | `#header-branch-name` | Validasi cabang aktif |
| 6 | `m2_product_search` | `#product-search` | Cari produk |
| 7 | `m2_category_bar` | `#category-bar` | Filter kategori |
| 8 | `m2_select_product` | `#products-grid` | Pilih produk |
| 9 | `m2_open_cart` | `#fab-cart-btn` | Buka keranjang |
| 10 | `m2_discount` | `#fab-cart-btn` | Jelaskan diskon di payment view |
| 11 | `m2_payment` | `#fab-cart-btn` | Jelaskan metode bayar |
| 12 | `m2_checkout` | `#fab-cart-btn` | Jelaskan checkout tanpa submit otomatis |
| 13 | `m3_auto_stock` | `#pos-maintab-stock` | Stok otomatis berkurang dari transaksi valid |
| 14 | `m3_stock_view` | `#pos-maintab-stock` | Cek stok |
| 15 | `m4_stock_tab` | `#pos-maintab-stock` | Manajemen stok |
| 16 | `m4_stock_adjust` | `button[data-action="open-stock-adjust-modal"]` | Ubah stok manual |
| 17 | `m4_stock_transfer` | `button[data-action="open-stock-adjust-modal"]` | Transfer stok |
| 18 | `m5_transactions` | `#pos-maintab-transactions` | Riwayat transaksi |
| 19 | `m5_void` | `#pos-maintab-transactions` | Void transaksi |
| 20 | `m6_cash_tab` | `#pos-maintab-cash` | Ringkasan kas |
| 21 | `m6_close_shift` | `button[data-action="open-close-shift"]` | Tutup shift |
| 22 | `m6_deposit` | `#pos-maintab-deposits` | Setoran tunai |

## 9. Kebutuhan Teknis

### 9.1 File yang Wajib Dicek / Diubah

| File | Perubahan |
| --- | --- |
| `js/onboarding.js` | Export modul ke `window.Onboarding`, guard event binding agar tidak double, warning saat selector hilang |
| `js/pos.js` | Panggil `window.Onboarding.init(this.user)` dengan catch non-fatal dan console warning |
| `pos.html` | Pastikan markup onboarding ada, script onboarding dimuat sekali, cache-busting version dinaikkan |
| `css/styles.css` | Pastikan overlay, pointer, tooltip, reduced motion, dan mobile layout aman |
| `sql/migrations/021_staff_onboarding.sql` | Pastikan trigger, RPC, seed template, dan seed steps sudah diterapkan |
| `sql/migrations/022_fix_onboarding_steps.sql` | Pastikan selector step yang ada di modal tertutup sudah diganti ke target yang aman |
| `js/admin.js` | Pastikan status onboarding staff ditampilkan dan tidak fatal jika RPC gagal |

### 9.2 Fix P0 Wajib

Tambahkan export global di akhir `js/onboarding.js`:

```js
window.Onboarding = Onboarding;
```

Atau refactor declaration menjadi:

```js
window.Onboarding = (() => {
  // existing code
  return { init };
})();
```

Kriteria lulus:

```js
Boolean(window.Onboarding) === true
typeof window.Onboarding.init === 'function'
```

### 9.3 Guard Event Binding

Tambahkan guard agar event listener tidak double jika `Onboarding.init()` terpanggil lebih dari sekali:

```js
let _eventsBound = false;

function bindEvents() {
  if (_eventsBound) return;
  _eventsBound = true;
  document.addEventListener('click', async e => {
    // existing handler
  });
}
```

### 9.4 Logging Terkendali

Jangan gunakan empty catch untuk init utama. Minimal:

```js
Onboarding.init(this.user).catch(err => {
  console.warn('[Onboarding] init failed', err);
});
```

Error internal save progress boleh non-fatal, tetapi tidak boleh membuat POS blank.

### 9.5 Cache Busting

Setiap perubahan file frontend wajib menaikkan query version di `pos.html`, contoh:

```html
<script src="js/onboarding.js?v=20260516-onboarding-fix-1"></script>
<script src="js/pos.js?v=20260516-onboarding-fix-1"></script>
<link rel="stylesheet" href="css/styles.css?v=20260516-onboarding-fix-1" />
```

Acceptance:

- Hard refresh mengambil file terbaru.
- Browser tidak menjalankan versi lama yang belum export `window.Onboarding`.

## 10. Database Requirements

### DB-001 - Template Aktif Harus Ada

```sql
SELECT id, template_key, audience_role, version, is_active
FROM onboarding_templates
WHERE template_key = 'staff_pos_basics'
  AND audience_role = 'staff'
  AND is_active = TRUE
ORDER BY version DESC;
```

Harus ada minimal satu row.

### DB-002 - Trigger Staff Baru Harus Aktif

```sql
SELECT tgname
FROM pg_trigger
WHERE tgname = 'trg_create_staff_onboarding_assignment'
  AND NOT tgisinternal;
```

Harus ada satu row.

### DB-003 - Assignment Staff Baru Harus Terbuat

Setelah membuat staff baru:

```sql
SELECT a.id, a.user_id, a.status, a.created_at
FROM user_onboarding_assignments a
WHERE a.user_id = :new_staff_user_id;
```

Harus ada satu row dengan `status = 'not_started'`.

### DB-004 - Step Progress Harus Ada

```sql
SELECT COUNT(*) AS total_steps
FROM user_onboarding_step_progress sp
JOIN user_onboarding_assignments a ON a.id = sp.assignment_id
WHERE a.user_id = :new_staff_user_id;
```

Harus lebih dari 0.

## 11. Acceptance Criteria

### AC-001 - Staff Baru Melihat Tour dari Modal Shift

Given admin membuat user role `staff`
And user belum punya shift aktif
When user login ke `pos.html`
Then `#modal-shift` tampil
And onboarding overlay tampil maksimal 2 detik
And tooltip menunjuk `#shift-opening-cash`
And tidak ada uncaught error di console

### AC-002 - Staff Bisa Mengisi Kas Awal Saat Tour Aktif

Given onboarding sedang menunjuk input kas awal
When staff mengetik `0` atau nominal lain
Then input menerima nilai
And overlay tidak memblokir interaksi

### AC-003 - Tour Lanjut Setelah Buka Shift

Given staff berada di step `m0_open_shift`
When staff klik `#btn-open-shift`
Then shift terbuka
And `#modal-shift` tertutup
And tour otomatis lanjut ke step berikutnya

### AC-004 - Staff Baru Dengan Shift Aktif Melihat Entry Panel

Given staff sudah punya shift aktif
When staff login ulang
Then `#ob-entry-panel` tampil
And klik "Mulai Pelatihan" membuka tour

### AC-005 - Selesai Berarti Tidak Tampil Lagi

Given staff menyelesaikan semua required step
When staff logout lalu login ulang
Then onboarding tidak tampil otomatis
And admin melihat status `Selesai`

### AC-006 - Admin dan Investor Tidak Melihat POS Onboarding

Given user role `admin` atau `investor`
When membuka aplikasi sesuai rolenya
Then onboarding POS tidak tampil
And tidak ada assignment onboarding baru otomatis untuk role tersebut

### AC-007 - RPC Gagal Tidak Merusak POS

Given RPC onboarding gagal
When staff login
Then POS tetap bisa dipakai
And onboarding masuk local fallback atau tidak memblokir operasional
And tidak ada halaman blank

### AC-008 - Selector Hilang Tidak Crash

Given salah satu selector target tidak ditemukan
When tour mencapai step tersebut
Then tooltip tampil fallback di tengah
And staff tetap bisa klik Next
And tidak ada uncaught exception

## 12. Test Plan

### 12.1 Manual Browser Test

1. Apply migration `021_staff_onboarding.sql` dan `022_fix_onboarding_steps.sql` di database target.
2. Hard refresh `pos.html`.
3. Buka console browser.
4. Jalankan:

```js
typeof window.Onboarding?.init === 'function'
```

Expected: `true`.

5. Login sebagai admin.
6. Buat user baru role `staff` dengan cabang aktif.
7. Cek database assignment user baru.
8. Logout.
9. Login sebagai staff baru di browser profile bersih atau incognito.
10. Pastikan modal shift tampil.
11. Pastikan onboarding muncul di modal shift.
12. Isi kas awal `0`.
13. Klik buka shift.
14. Pastikan tour lanjut.
15. Klik Next beberapa langkah.
16. Refresh browser.
17. Pastikan progress tidak kembali ke awal.
18. Selesaikan tour.
19. Logout dan login ulang.
20. Pastikan onboarding tidak muncul lagi.

### 12.2 Regression Test POS

1. Login staff lama.
2. Buka shift.
3. Tambah produk ke cart.
4. Proses transaksi valid.
5. Cek transaksi tersimpan.
6. Cek stok berkurang sesuai fitur existing.
7. Cek kas tercatat.
8. Tutup shift.
9. Buat setoran tunai.

Expected:

- Semua flow POS tetap berjalan.
- Tidak ada data dummy dari onboarding.
- Tidak ada modal onboarding yang memblokir checkout.

### 12.3 Console Error Test

Selama semua skenario di atas, console tidak boleh memiliki:

- `ReferenceError`
- `TypeError` uncaught
- `Onboarding is not defined`
- `Cannot read properties of null`
- `Failed to execute 'querySelector'` uncaught

Warning yang diperbolehkan:

- Warning selector missing dengan fallback.
- Warning RPC onboarding gagal, selama POS tetap berjalan.

## 13. Definition of Done

Fitur dianggap selesai hanya jika semua kondisi ini terpenuhi:

1. `window.Onboarding.init` tersedia setelah `pos.html` load.
2. Staff baru melihat guided tour dari modal kas awal pada login pertama.
3. Staff baru bisa mengetik kas awal dan membuka shift saat tour aktif.
4. Tour lanjut otomatis setelah shift dibuka.
5. Progress tersimpan.
6. Completion mencegah tour tampil ulang.
7. Admin melihat status onboarding.
8. Tidak ada uncaught JavaScript error di console.
9. Tidak ada transaksi/stok/kas/setoran palsu akibat tombol Next tour.
10. POS tetap bisa dipakai normal jika onboarding gagal.

## 14. Release Checklist

Sebelum rilis:

- [ ] Migration onboarding sudah diterapkan di Supabase target.
- [ ] Trigger `trg_create_staff_onboarding_assignment` aktif.
- [ ] Template `staff_pos_basics` aktif.
- [ ] `window.Onboarding` tersedia.
- [ ] Version query script/CSS dinaikkan.
- [ ] Test staff baru tanpa shift lulus.
- [ ] Test staff baru dengan shift aktif lulus.
- [ ] Test refresh progress lulus.
- [ ] Test complete lalu login ulang lulus.
- [ ] Test admin/investor tidak melihat onboarding lulus.
- [ ] Test transaksi POS normal lulus.
- [ ] Console error test lulus.

## 15. Rollback Plan

Jika terjadi masalah setelah rilis:

1. Nonaktifkan frontend onboarding dengan feature flag lokal, misalnya `window.RBN_ENABLE_ONBOARDING = false`.
2. Jangan hapus tabel onboarding.
3. Jangan hapus assignment existing.
4. Pastikan POS tetap berjalan tanpa memanggil `Onboarding.init`.
5. Setelah fix, aktifkan kembali feature flag.

Rollback tidak boleh menghapus progress staff yang sudah selesai.

## 16. Catatan Implementasi Anti-Gagal

Penyebab no-show yang paling perlu diperbaiki lebih dulu adalah export global:

```js
window.Onboarding = Onboarding;
```

Tanpa ini, `js/pos.js` dapat terus melewati init karena `window.Onboarding` undefined. Setelah fix ini, lakukan test login staff baru dari browser bersih. Jika tour masih tidak muncul, urutan debug wajib:

1. Cek `typeof window.Onboarding?.init`.
2. Cek role session adalah `staff`.
3. Cek `#modal-shift` memiliki class `active` saat belum ada shift.
4. Cek `get_my_onboarding` mengembalikan assignment.
5. Cek localStorage tidak memiliki `ob_done_{user_id} = 1`.
6. Cek elemen `#ob-overlay` dan `#ob-entry-panel` ada di DOM.
7. Cek CSS tidak menyembunyikan overlay/panel karena z-index atau display.

PRD ini harus dipakai sebagai checklist implementasi. Fitur belum boleh dianggap selesai hanya karena kode sudah ditulis; fitur selesai ketika acceptance criteria dan test plan di atas lulus di browser.
