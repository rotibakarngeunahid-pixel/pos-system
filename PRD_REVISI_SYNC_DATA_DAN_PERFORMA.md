# PRD Revisi Sinkronisasi Data Setelah CRUD dan Performa Ringan

Tanggal: 2026-05-16  
Produk: Roti Bakar Ngeunah POS  
Area: Admin, POS, Setoran, Investor Dashboard  
Prioritas: Tinggi

## 1. Ringkasan

Saat ini beberapa aksi seperti tambah data, ubah data, hapus data, konfirmasi data, dan transaksi berhasil menampilkan pesan sukses, tetapi data baru belum langsung terlihat di tampilan. User harus melakukan refresh browser agar perubahan muncul.

Revisi ini menetapkan standar baru untuk seluruh proses mutasi data: sistem baru boleh menyatakan aksi berhasil setelah database berhasil diperbarui dan tampilan aktif sudah tersinkron. Selain itu, revisi ini juga merapikan beberapa pola refresh yang boros query agar performa terasa lebih ringan tanpa mengubah arsitektur besar aplikasi.

## 2. Tujuan

1. Data hasil create, update, delete, confirm, void, refund, atau toggle langsung muncul di tampilan terkait tanpa refresh browser.
2. Toast sukses tidak muncul terlalu cepat sebelum UI selesai sinkron.
3. Loader, tombol, list, tabel, select, filter, dan cache lokal diperbarui secara konsisten setelah mutasi data.
4. Query refresh dibuat lebih hemat dengan memuat ulang resource yang terdampak saja, bukan selalu memanggil ulang semua master data.
5. Risiko stale cache pada Admin, POS, Setoran, dan Investor dikurangi dengan invalidasi cache yang jelas.

## 3. Kondisi Sistem Saat Ini

### 3.1 Arsitektur Singkat

- Aplikasi memakai HTML dan JavaScript statis.
- Data utama diakses melalui Supabase client global `db`.
- Halaman utama:
  - `admin.html` dengan controller `js/admin.js`
  - `pos.html` dengan controller `js/pos.js`
  - `investor.html` dengan controller `js/investor.js`
- Service terpisah sudah tersedia untuk transaksi, stok, kas, laporan, dan setoran:
  - `js/services/transactionService.js`
  - `js/services/inventoryService.js`
  - `js/services/cashService.js`
  - `js/depositService.js`

### 3.2 Temuan dari Pembacaan Kode

- `js/admin.js` memakai cache master seperti `branches`, `products`, `ingredients`, `productCategories`, dan `_allProducts`.
- `ADMIN.loadMasterData()` memuat banyak tabel sekaligus lalu hanya mengisi select master. Fungsi ini tidak otomatis merender ulang section aktif.
- Banyak handler CRUD di `js/admin.js` memanggil `showToast(..., 'success')` sebelum refresh UI selesai.
- Banyak refresh setelah mutasi tidak memakai `await`, misalnya pola `this.loadProducts()`, `this.loadVariants()`, `this.loadStaff()`, `this.loadToppings()`, dan sejenisnya.
- Beberapa flow melakukan reload berlebih. Contoh: setelah simpan kategori produk, handler memanggil `loadMasterData()`, lalu `loadProductCategories()` juga memanggil `loadMasterData()` lagi.
- `admin.html` memiliki menu `cash-deposits`, tetapi `ADMIN.navigate()` belum memasukkan section tersebut ke title map dan switch loader utama. `adminDepositUi` memuat data setoran saat `DOMContentLoaded`, bukan saat section benar-benar dibuka.
- `js/pos.js` menyimpan cache seperti `allProducts`, `filtered`, `bomData`, `stockCache`, `toppingMap`, dan `_paymentMethodsCache`. Cache ini perlu invalidasi ketika data menu, harga, resep, topping, stok, atau metode pembayaran berubah.
- `js/depositUi.js` sudah memanggil `await this.refresh()` setelah submit setoran, tetapi success state/toast muncul sebelum refresh selesai.
- `js/adminDepositUi.js` memiliki pola lebih baik pada beberapa aksi karena sudah `await this.loadDeposits()` atau `await this.loadAccounts()` setelah konfirmasi/simpan. Pola ini dapat dijadikan referensi.

## 4. Masalah yang Harus Diselesaikan

### 4.1 Masalah Utama

User menerima pesan berhasil, tetapi data belum muncul di list, tabel, kartu, filter, atau ringkasan sampai browser direfresh manual.

### 4.2 Penyebab Teknis yang Diduga

1. Refresh UI dipanggil tanpa `await`, sehingga toast sukses muncul sebelum DOM selesai diperbarui.
2. Beberapa fungsi hanya memperbarui cache master, tetapi tidak merender ulang view aktif.
3. Beberapa cache lokal tidak dihapus atau tidak dibangun ulang setelah data berubah.
4. Tidak ada kontrak tunggal untuk "setelah mutasi data, refresh apa saja yang wajib dilakukan".
5. Beberapa section dimuat di waktu yang kurang tepat, sehingga data bisa sudah stale ketika user membuka section tersebut.

### 4.3 Dampak ke User

- User mengira data gagal tersimpan karena tidak langsung terlihat.
- User melakukan refresh browser berulang.
- Risiko input data duplikat meningkat karena user mencoba menyimpan ulang.
- Admin/kasir kehilangan kepercayaan terhadap status sukses sistem.

## 5. Scope

### 5.1 In Scope

- Standarisasi lifecycle semua mutasi data penting di Admin, POS, Setoran, dan Investor.
- Refresh view aktif setelah create/update/delete/confirm/void/refund/toggle.
- Invalidation cache lokal yang terdampak.
- Optimasi query ringan pada refresh setelah mutasi.
- Perbaikan lazy loading section yang saat ini dimuat terlalu awal.
- UX state untuk tombol submit, loading row, empty state, warning jika refresh gagal, dan retry manual.

### 5.2 Out of Scope

- Rewrite aplikasi ke framework SPA seperti React/Vue.
- Mengubah skema database besar-besaran.
- Membuat offline mode penuh.
- Membuat realtime multi-device penuh sebagai fitur wajib MVP.
- Mengubah desain UI besar-besaran di luar state refresh dan loading.

## 6. Prinsip Solusi

1. Source of truth tetap database.
2. Setelah mutasi sukses, UI aktif wajib sinkron sebelum toast final sukses ditampilkan.
3. Jika mutasi sukses tetapi refresh UI gagal, tampilkan warning yang jujur: data tersimpan, tampilan gagal diperbarui.
4. Refresh harus spesifik ke resource terdampak.
5. Cache boleh dipakai untuk performa, tetapi harus punya aturan invalidasi.
6. Semua loader yang dipakai setelah mutasi harus mengembalikan Promise dan wajib bisa di-`await`.

## 7. Functional Requirements

### FR-01 - Standar Lifecycle Mutasi

Setiap aksi mutasi harus mengikuti urutan berikut:

1. User klik simpan/hapus/konfirmasi.
2. Tombol aksi masuk state loading dan disabled.
3. Sistem menjalankan mutasi ke Supabase/RPC.
4. Jika mutasi gagal, tampilkan toast error dan jangan ubah UI sebagai sukses.
5. Jika mutasi berhasil, jalankan refresh resource dan view yang terdampak.
6. Jika refresh berhasil, tutup modal bila relevan dan tampilkan toast sukses.
7. Jika refresh gagal, tampilkan warning: "Data tersimpan, tetapi tampilan gagal diperbarui. Klik Refresh untuk memuat ulang."
8. Tombol kembali normal.

### FR-02 - Helper Refresh Setelah Mutasi

Buat pola helper terpusat untuk masing-masing halaman, minimal:

- `ADMIN.refreshAfterMutation(options)`
- `POS.refreshAfterMutation(options)`
- `depositUi.refreshAfterMutation(options)` atau pakai `depositUi.refresh()` dengan kontrak yang sama
- `adminDepositUi.refreshAfterMutation(options)` atau wrapper setara

Helper harus mendukung:

- daftar resource yang harus di-refresh, misalnya `branches`, `products`, `ingredients`, `categories`, `settings`, `cashCategories`, `toppings`, `depositAccounts`
- daftar view yang harus di-render ulang, misalnya `currentSection`, `products`, `inventory`, `dashboard`, `cashDeposits`
- `Promise.all` untuk refresh yang independen
- pencegahan duplicate in-flight refresh dengan key per resource
- mekanisme ignore stale response jika user mengganti filter/section saat refresh berlangsung

### FR-03 - Refresh Section Aktif di Admin

`ADMIN.navigate()` harus menjadi pusat lazy loading section admin. Semua section di `admin.html` harus terdaftar, termasuk `cash-deposits`.

Mapping minimal:

| Section | Loader Wajib |
| --- | --- |
| `dashboard` | `loadDashboard()` |
| `branches` | `loadBranches()` |
| `products` | `loadProducts()` |
| `product-categories` | `loadProductCategories()` |
| `branch-pricing` | `loadBranchPricing()` |
| `recipes` | `loadRecipeVariants()` dan `loadRecipeItems()` jika filter sudah terpilih |
| `inventory` | `loadInventory()` |
| `transactions` | `loadTransactions()` |
| `staff` | `loadStaff()` |
| `investor-access` | `loadInvestorAccess()` |
| `cash-report` | `loadCashReport()` |
| `cash-deposits` | `adminDepositUi.loadDeposits()` dan `adminDepositUi.loadAccounts()` bila perlu |
| `cash-categories` | `loadCashCategories()` |
| `toppings` | `loadToppingSection()` |
| `api-keys` | `loadApiKeysSection()` |

### FR-04 - Refresh Setelah CRUD Admin

Semua handler berikut wajib memastikan list/view langsung berubah tanpa refresh browser:

- Cabang: tambah, edit, hapus.
- Produk: tambah, edit, hapus, bulk import.
- Harga per cabang: simpan override, hapus override.
- Kategori produk: tambah, edit, hapus.
- Varian produk: tambah, edit, hapus, edit di modal produk.
- Resep/BOM: buat resep, tambah bahan, edit bahan, hapus bahan.
- Bahan baku: tambah, edit, hapus.
- Inventori admin: stok masuk, stok keluar, opname, transfer.
- Transaksi admin: void dan refund.
- Staff dan investor: tambah, edit, hapus, simpan akses investor.
- Pengaturan metode pembayaran.
- Kategori kas.
- Setoran tunai admin: konfirmasi, tolak, simpan metode setoran, toggle rekening.
- Topping dan mapping topping.
- API key: generate, delete, toggle.

Setelah setiap handler selesai, UI yang terdampak harus langsung menampilkan data baru.

### FR-05 - Refresh dan Cache di POS

POS harus menginvalidasi cache berdasarkan jenis perubahan:

| Perubahan | Cache/View POS Terdampak |
| --- | --- |
| Produk, varian, harga cabang, produk aktif cabang | `allProducts`, `filtered`, grid kasir, category bar |
| Resep/BOM | `bomData`, validasi stok sebelum checkout |
| Stok | `stockCache`, ringkasan stok, warning stok |
| Topping atau mapping topping | `toppingMap`, modal topping |
| Metode pembayaran | `_paymentMethodsCache`, tombol metode bayar, filter ringkasan |
| Transaksi baru/void/refund | ringkasan penjualan, riwayat transaksi, ringkasan kas |
| Setoran/kas | ringkasan kas, estimasi setoran |

POS tidak wajib realtime penuh untuk MVP, tetapi setelah aksi lokal di POS selesai, tab aktif dan cache terkait harus langsung sinkron.

### FR-06 - Cross Page Sync Ringan

Untuk perubahan yang dilakukan di Admin dan berdampak ke POS pada browser yang sama, gunakan salah satu mekanisme ringan:

- `BroadcastChannel` jika tersedia.
- Fallback ke `localStorage` event dengan key seperti `rbn:data-version`.

Event minimal:

| Event | Trigger |
| --- | --- |
| `products:changed` | produk, varian, branch product, harga cabang |
| `recipes:changed` | resep atau bahan resep |
| `inventory:changed` | stok, transfer, opname |
| `cash:changed` | kas manual, void kas, setoran |
| `settings:changed` | metode pembayaran, receipt settings |
| `toppings:changed` | topping atau mapping |

Saat POS menerima event, POS cukup menandai cache dirty. Refresh penuh dilakukan saat tab terkait aktif atau saat user membuka modal terkait.

### FR-07 - Ordering Toast dan Refresh

Toast sukses final harus muncul setelah refresh selesai.

Contoh perilaku yang diharapkan:

- Saat simpan produk: tombol menampilkan "Menyimpan...", modal ditutup setelah data berhasil tersimpan, grid produk sudah berisi produk baru, baru tampil toast "Produk berhasil disimpan".
- Saat hapus topping: row topping hilang dari tabel, baru tampil toast "Topping dihapus".
- Saat submit setoran: riwayat setoran sudah berisi row baru, baru tampil success state.

### FR-08 - Error Recovery

Jika DB mutation sukses tetapi refresh UI gagal:

- Jangan tampilkan toast error seolah data gagal tersimpan.
- Tampilkan warning khusus.
- Sediakan tombol/manual refresh di section terkait.
- Log detail error ke console untuk debugging.

### FR-09 - Preserve Filter dan Posisi User

Setelah refresh view:

- Search produk admin tetap dipertahankan.
- Filter kategori produk tetap dipertahankan jika opsi masih ada.
- Filter cabang/tanggal/status tetap dipertahankan.
- Tab aktif tetap sama.
- Scroll tidak dipaksa ke atas kecuali item yang diedit tidak lagi ada karena terhapus.

### FR-10 - Hindari Duplicate Submit

Semua form mutasi harus:

- disable tombol submit selama proses berjalan
- memakai lock lokal per aksi jika perlu
- mengabaikan double click
- mengembalikan tombol ke state normal pada `finally`

## 8. Performance Requirements

### PR-01 - Hindari Full Master Reload Berulang

Jangan memanggil `loadMasterData()` untuk setiap perubahan kecil jika hanya satu resource yang berubah.

Contoh target:

- Simpan kategori produk cukup refresh `productCategories` dan view kategori, bukan reload branches, products, ingredients, suppliers.
- Simpan bahan cukup refresh `ingredients` dan view terkait, bukan selalu semua master.
- Simpan topping cukup refresh topping dan mapping terkait.

### PR-02 - Batch Query yang Saat Ini Berulang

Perbaiki flow yang melakukan loop query satu per satu jika bisa dibatch.

Contoh kandidat:

- Sync `branch_products` saat simpan produk saat ini melakukan update global lalu loop select/update/insert per cabang.
- Refresh select/filter setelah master change harus menggunakan data yang sudah diambil, bukan query ulang ganda.

### PR-03 - Lazy Load Section Berat

Data section yang tidak sedang dibuka tidak perlu dimuat saat initial admin page load.

Kandidat:

- Setoran tunai admin dapat diload saat section `cash-deposits` dibuka, bukan selalu saat `DOMContentLoaded`.
- List akun setoran dapat diload saat tab/section setoran dibuka atau saat modal butuh data.

### PR-04 - Deduplicate In-Flight Request

Jika refresh resource yang sama sedang berjalan:

- request baru dengan key sama boleh menunggu Promise yang sama, atau
- request baru boleh menggantikan request lama dan response lama diabaikan.

Ini mencegah UI tertimpa response lama saat user cepat mengganti filter atau menyimpan data berturut-turut.

### PR-05 - Select Kolom Secukupnya

Query refresh harus memilih kolom yang dibutuhkan tampilan saja.

Contoh:

- daftar cabang hanya perlu `id`, `name`, `address`, `created_at`
- select cabang hanya perlu `id`, `name`
- daftar kategori hanya perlu `id`, `name`

## 9. Non-Functional Requirements

1. Tidak boleh ada regression pada autentikasi dan role.
2. Tidak boleh menghapus data user existing.
3. Tetap kompatibel dengan Supabase client v2 yang sudah dipakai.
4. Tidak wajib menambah dependency besar.
5. Perubahan harus tetap cocok dengan pola JavaScript global yang sudah ada.
6. Semua perubahan harus aman jika tabel opsional belum ada, mengikuti pola graceful fallback yang sudah ada.

## 10. Acceptance Criteria

1. Setelah admin menambah produk, produk baru muncul di grid produk tanpa refresh browser.
2. Setelah admin mengubah produk, nama/harga/kategori yang tampil berubah tanpa refresh browser.
3. Setelah admin menghapus produk, produk hilang dari grid tanpa refresh browser.
4. Setelah admin menambah cabang, cabang muncul di daftar dan select terkait tanpa refresh browser.
5. Setelah admin menambah kategori produk, kategori muncul di daftar dan pilihan kategori produk tanpa refresh browser.
6. Setelah admin menambah/edit/hapus bahan resep, tabel resep langsung berubah.
7. Setelah admin menambah stok/opname/transfer, kartu stok dan log terkait langsung berubah.
8. Setelah kasir checkout, ringkasan penjualan, stok, dan riwayat transaksi yang sedang aktif langsung berubah.
9. Setelah kasir input kas masuk/keluar, ringkasan kas langsung berubah.
10. Setelah staff submit setoran, riwayat setoran staff menampilkan setoran baru tanpa refresh browser.
11. Setelah admin konfirmasi/tolak setoran, status setoran berubah di tabel tanpa refresh browser.
12. Toast sukses tidak muncul sebelum refresh view selesai.
13. Jika refresh setelah mutasi gagal, user mendapat warning yang menjelaskan data sudah tersimpan.
14. Tidak ada double submit ketika tombol simpan diklik cepat berkali-kali.
15. Query setelah simpan kategori produk tidak lagi memuat ulang seluruh master data dua kali.
16. Section `cash-deposits` bisa diakses melalui navigasi admin dan memuat data terbaru saat dibuka.

## 11. Rekomendasi Implementasi

### 11.1 Tahap 1 - Audit dan Kontrak Loader

- Pastikan semua `loadX()` mengembalikan Promise.
- Ubah semua pemanggilan refresh setelah mutasi menjadi `await`.
- Tambahkan return value yang jelas untuk loader utama.
- Tambahkan loading state minimal pada list/tabel ketika refresh berjalan.

### 11.2 Tahap 2 - Helper Admin

Tambahkan helper di `js/admin.js`:

```js
async refreshAfterMutation({ resources = [], views = [], successMessage = '' }) {
  // 1. refresh resources yang terdampak
  // 2. render ulang views aktif
  // 3. tampilkan toast sukses setelah semuanya selesai
}
```

Resource loader minimal:

- `refreshBranches()`
- `refreshProducts()`
- `refreshIngredients()`
- `refreshProductCategories()`
- `refreshPaymentMethods()`

Helper ini menggantikan pola tersebar seperti:

```js
showToast('Produk berhasil disimpan', 'success');
await this.loadMasterData();
this.loadProducts();
```

menjadi pola:

```js
await this.refreshAfterMutation({
  resources: ['products'],
  views: ['products'],
  successMessage: 'Produk berhasil disimpan'
});
```

### 11.3 Tahap 3 - Perbaiki Admin Navigation

- Tambahkan title dan loader untuk `cash-deposits`.
- Pindahkan initial heavy load `adminDepositUi.loadDeposits()` agar lazy saat section dibuka.
- Pastikan section aktif selalu bisa direfresh dari satu fungsi `refreshCurrentSection()`.

### 11.4 Tahap 4 - Helper POS dan Cache Dirty

Tambahkan flag dirty:

- `POS._productsDirty`
- `POS._bomDirty`
- `POS._stockDirty`
- `POS._toppingsDirty`
- `POS._paymentMethodsDirty`
- `POS._cashDirty`

Saat user membuka tab atau melakukan aksi yang butuh data tersebut, POS refresh jika dirty.

### 11.5 Tahap 5 - Cross Page Event

Tambahkan helper kecil:

```js
window.RBNDataEvents.publish('products:changed', { source: 'admin' });
window.RBNDataEvents.subscribe('products:changed', handler);
```

Gunakan `BroadcastChannel` dengan fallback `localStorage`.

### 11.6 Tahap 6 - Optimasi Query

- Pecah `loadMasterData()` menjadi loader per resource.
- Hilangkan reload ganda.
- Batch operasi branch product.
- Batasi `.select('*')` pada loader yang tidak membutuhkan semua kolom.

## 12. Test Plan

### 12.1 Manual Test Admin

1. Tambah, edit, hapus cabang.
2. Tambah produk simple.
3. Tambah produk varian.
4. Edit produk dan varian dari modal produk.
5. Bulk import menu.
6. Tambah, edit, hapus kategori produk.
7. Tambah, edit, hapus bahan baku.
8. Tambah stok, stok keluar, opname, transfer.
9. Tambah, edit, hapus staff.
10. Simpan akses investor.
11. Tambah, edit, hapus kategori kas.
12. Simpan metode pembayaran.
13. Tambah, edit, toggle, hapus topping.
14. Generate, toggle, hapus API key.

### 12.2 Manual Test POS

1. Checkout transaksi tunai.
2. Checkout transaksi QRIS/transfer.
3. Void transaksi.
4. Tambah kas masuk/keluar.
5. Void log kas.
6. Stok masuk/keluar dari POS.
7. Submit setoran.
8. Buka tab ringkasan, stok, kas, setoran, dan transaksi setelah aksi selesai.

### 12.3 Manual Test Cross Page

1. Buka Admin dan POS pada browser yang sama.
2. Di Admin, ubah harga produk cabang.
3. Di POS, buka kembali tab kasir atau tekan refresh menu.
4. Pastikan harga baru muncul tanpa reload browser penuh.
5. Di Admin, nonaktifkan metode pembayaran.
6. Di POS, buka modal pembayaran dan pastikan metode tersebut tidak tampil.

### 12.4 Test Kondisi Lambat

Gunakan throttling network atau koneksi lambat:

- Toast sukses tidak boleh muncul sebelum list berubah.
- Tombol tidak bisa diklik dua kali.
- Jika refresh gagal setelah mutasi sukses, warning muncul.

## 13. Risiko dan Mitigasi

| Risiko | Dampak | Mitigasi |
| --- | --- | --- |
| Refresh terlalu sering | Aplikasi lambat | Refresh resource spesifik dan dedupe in-flight request |
| Cache POS stale | Harga/stok/menu tidak sesuai | Dirty flag dan cross page event ringan |
| Response lama menimpa response baru | Data terlihat mundur | Request token per loader |
| Mutasi sukses tapi refresh gagal | User bingung | Warning khusus dan tombol refresh |
| Perubahan terlalu luas | Regression | Implementasi bertahap per area dan test manual matrix |

## 14. Metrics

1. 0 kasus wajib refresh browser setelah CRUD pada test matrix.
2. 0 duplicate row akibat double click pada form mutasi.
3. Refresh view aktif selesai dalam target:
   - normal: kurang dari 1 detik setelah DB mutation selesai
   - koneksi lambat: tampil loading/warning yang jelas
4. Query setelah mutasi kategori/setting sederhana tidak memanggil full master reload.
5. Initial admin load tidak memuat data setoran berat sampai section dibuka.

## 15. Open Questions

1. Apakah sinkronisasi lintas device harus realtime penuh, atau cukup browser yang sama untuk fase awal?
2. Apakah ada prioritas area paling sering bermasalah: produk, stok, transaksi, setoran, atau staff?
3. Apakah mode offline perlu dipertimbangkan di masa depan untuk kasir?
4. Apakah semua perubahan harga/menu di Admin harus langsung memaksa POS reload menu, atau cukup saat POS membuka ulang tab kasir/modal pembayaran?

## 16. Definisi Selesai

Revisi dianggap selesai jika seluruh acceptance criteria lulus, tidak ada aksi CRUD utama yang membutuhkan refresh browser manual, dan performa refresh setelah mutasi tidak lebih berat dari kondisi saat ini.
