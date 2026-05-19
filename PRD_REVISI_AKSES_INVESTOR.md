# PRD Revisi Fitur Akses Investor

Tanggal: 2026-05-16  
Produk: Roti Bakar Ngeunah POS  
Area: Admin - Investor Access, Investor Dashboard

## 1. Ringkasan

Sistem saat ini sudah memiliki role `investor`, halaman `investor.html`, service `js/investorService.js`, controller `js/investor.js`, serta tabel `investor_branch_access` melalui migrasi `sql/migrations/015_investor_role.sql`. Namun akses investor saat ini baru mengatur cabang yang dapat dilihat. Jika investor memiliki akses ke sebuah cabang, halaman investor otomatis memuat semua modul: overview, penjualan, performa produk, stok, dan pemakaian bahan.

Revisi ini menambahkan kontrol granular agar admin dapat menentukan data apa saja yang boleh dilihat setiap investor, misalnya penjualan, produk, stok, pemakaian bahan, dan modul lain yang akan ditambahkan nanti. Revisi juga memperbaiki UI investor agar rapi di mobile dengan navigasi slide kanan/kiri, layout yang tidak overflow, serta UX yang lebih profesional.

## 2. Tujuan

1. Admin dapat mengatur akses investor per akun, minimal berdasarkan cabang dan modul data.
2. Investor hanya melihat tab, data, KPI, dan request API/RPC yang sesuai izin dari admin.
3. Halaman investor mobile menjadi rapi, mudah dipakai satu tangan, dan mendukung swipe kanan/kiri antar modul.
4. UI/UX investor memiliki state yang jelas: loading, empty, error, no access, dan refresh.
5. Kontrol akses tidak hanya disembunyikan di frontend, tetapi juga divalidasi di layer database/RPC.

## 3. Kondisi Sistem Saat Ini

### 3.1 Implementasi yang Sudah Ada

- `users.role` sudah mendukung `admin`, `staff`, dan `investor`.
- `auth.getDefaultPageByRole('investor')` mengarahkan investor ke `investor.html`.
- Admin memiliki menu `Investor Access` di `admin.html`.
- Admin dapat memilih cabang investor melalui `investor_branch_access`.
- Investor mengambil data melalui RPC:
  - `investor_get_allowed_branches`
  - `investor_get_sales_report`
  - `investor_get_product_performance`
  - `investor_get_inventory_summary`
  - `investor_get_inventory_usage`

### 3.2 Masalah Saat Ini

- Akses investor hanya berbasis cabang, belum berbasis fitur/modul.
- Investor yang boleh melihat cabang otomatis bisa melihat semua data cabang tersebut.
- `js/investor.js` memanggil semua data sekaligus walaupun user mungkin nantinya tidak boleh melihat semuanya.
- UI investor mobile masih desktop-first:
  - filter memenuhi layar,
  - tabel berpotensi sempit/terpotong,
  - tab hanya scroll horizontal biasa,
  - belum ada swipe antar panel,
  - belum ada layout card mobile untuk data penting.
- Beberapa teks di file terlihat mojibake, terutama karakter dash dan simbol yang tampil rusak. Ini perlu dibersihkan agar tampilan profesional.

## 4. Scope

### 4.1 In Scope

- Menambahkan permission fitur untuk investor.
- Memperbarui admin UI untuk mengatur cabang dan modul yang boleh dilihat investor.
- Memperbarui RPC agar setiap data investor memvalidasi izin fitur.
- Memperbarui halaman investor agar hanya menampilkan modul yang diizinkan.
- Membuat investor mobile UI dengan swipe kanan/kiri antar modul.
- Memperbaiki UX investor: loading state, empty state, error state, no permission state, validasi filter, dan refresh state.

### 4.2 Out of Scope

- Mengubah role selain investor.
- Membuat sistem multi-tenant baru.
- Mengubah workflow kasir/POS.
- Membuat analytics kompleks seperti chart laba rugi, prediksi stok, atau dashboard investor eksternal.
- Mengubah sistem login secara total, kecuali hardening yang dibutuhkan untuk validasi akses investor.

## 5. User Persona

### Admin

Pemilik/operator yang mengatur investor mana saja yang boleh melihat data cabang dan modul tertentu. Admin butuh kontrol cepat, jelas, dan minim risiko salah konfigurasi.

### Investor

User yang hanya membaca data bisnis. Investor tidak boleh mengubah transaksi, stok, produk, cabang, kas, atau konfigurasi apa pun. Investor sering mengakses dari mobile, sehingga UI harus mudah dibaca dan tidak terasa seperti tabel desktop dipaksakan ke layar kecil.

## 6. Permission Model

### 6.1 Modul Akses MVP

Permission awal mengikuti modul yang sudah ada di halaman investor:

| Feature Key | Nama di UI Admin | Dampak di Investor |
| --- | --- | --- |
| `sales` | Penjualan | KPI penjualan, jumlah transaksi, total diskon, transaksi void, tabel/list transaksi |
| `products` | Performa Produk | Produk/varian terlaris, qty terjual, revenue per produk |
| `inventory_stock` | Stok Bahan | Stok saat ini, satuan, pemakaian hari ini, update terakhir |
| `inventory_usage` | Pemakaian Bahan | Total bahan terpakai dalam periode |

Catatan: `overview` tidak perlu menjadi permission terpisah. Overview harus merender kartu ringkasan berdasarkan modul yang diizinkan. Jika investor hanya boleh melihat stok, overview hanya menampilkan ringkasan stok.

### 6.2 Aturan Umum

- Investor harus punya minimal satu cabang agar bisa melihat data.
- Investor harus punya minimal satu modul aktif agar dashboard menampilkan data.
- Jika cabang aktif tetapi modul tidak aktif, tampilkan state "Belum ada izin fitur".
- Jika modul aktif tetapi cabang tidak aktif, tampilkan state "Belum ada akses cabang".
- Frontend tidak boleh memanggil RPC untuk modul yang tidak diizinkan.
- RPC tetap wajib menolak request jika permission tidak valid, meskipun request dibuat manual dari console/browser.

## 7. Perubahan Database dan RPC

### 7.1 Migrasi Baru

Buat migrasi baru:

`sql/migrations/017_investor_feature_permissions.sql`

Rekomendasi data model:

```sql
CREATE TABLE IF NOT EXISTS investor_feature_access (
  user_id     BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  feature_key TEXT NOT NULL,
  allowed     BOOLEAN NOT NULL DEFAULT FALSE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by  BIGINT REFERENCES users(id),
  updated_by  BIGINT REFERENCES users(id),
  PRIMARY KEY (user_id, feature_key),
  CONSTRAINT investor_feature_access_key_check CHECK (
    feature_key IN ('sales', 'products', 'inventory_stock', 'inventory_usage')
  )
);
```

Alasan memakai tabel terpisah:

- Tidak mengubah makna `investor_branch_access` yang saat ini khusus cabang.
- Mudah menambah modul baru tanpa menambah banyak kolom boolean.
- Admin dapat mengatur modul per investor secara global, sementara cabang tetap diatur lewat tabel yang sudah ada.

### 7.2 RPC Baru

Tambahkan RPC:

- `investor_get_access_config(p_user_id BIGINT)`  
  Mengembalikan cabang yang boleh diakses dan daftar fitur aktif.

- `investor_can_access_feature(p_user_id BIGINT, p_branch_id BIGINT, p_feature_key TEXT)`  
  Mengembalikan `TRUE` hanya jika:
  - user ber-role `investor`,
  - user punya akses ke `p_branch_id`,
  - `feature_key` aktif untuk user tersebut.

- `admin_save_investor_access(...)` atau RPC sejenis  
  Menyimpan branch access dan feature access dalam satu operasi agar tidak ada kondisi setengah tersimpan.

### 7.3 Update RPC Lama

RPC investor yang sudah ada wajib menambahkan validasi feature:

- `investor_get_sales_report` wajib cek `sales`.
- `investor_get_product_performance` wajib cek `products`.
- `investor_get_inventory_summary` wajib cek `inventory_stock`.
- `investor_get_inventory_usage` wajib cek `inventory_usage`.

Jika izin tidak valid, RPC harus mengembalikan error yang aman:

```text
Akses ditolak: investor tidak memiliki izin fitur ini
```

### 7.4 Security Requirement

- Hindari akses langsung dari frontend ke tabel permission untuk operasi sensitif.
- Mutasi akses investor sebaiknya lewat RPC admin yang memvalidasi role admin.
- Permission tidak boleh hanya berupa hide/show di frontend.
- Review ulang grant pada `investor_branch_access` karena saat ini migrasi memberikan `GRANT ALL` ke `anon, authenticated`. Target ideal adalah operasi tulis hanya melalui RPC admin.

## 8. Admin UI Requirement

### 8.1 Menu Investor Access

Lokasi saat ini: `admin.html` section `section-investor-access`.

List investor harus menampilkan:

- nama investor,
- cabang yang dapat diakses dalam bentuk chip/badge,
- modul yang aktif dalam bentuk chip/badge,
- status konfigurasi:
  - "Lengkap" jika punya cabang dan modul,
  - "Belum ada cabang",
  - "Belum ada modul",
  - "Tidak aktif" jika nanti ada status user.

Action minimal:

- `Atur Akses`
- `Edit User`
- `Hapus`

### 8.2 Modal Atur Akses Investor

Modal saat ini hanya mengatur cabang. Revisi modal menjadi:

1. Header
   - Judul: `Atur Akses Investor`
   - Subjudul/nama investor

2. Bagian Cabang
   - Checkbox cabang.
   - Tombol `Pilih Semua`.
   - Tombol `Kosongkan`.
   - Search cabang jika jumlah cabang banyak.

3. Bagian Modul yang Boleh Dilihat
   - Toggle/checkbox:
     - Penjualan
     - Performa Produk
     - Stok Bahan
     - Pemakaian Bahan
   - Gunakan label yang jelas dan ringkas.
   - Setiap toggle memiliki deskripsi singkat di bawah label.

4. Preview Akses
   - Contoh teks: `Investor ini akan melihat: 2 cabang, Penjualan, Stok Bahan`.

5. Footer
   - `Batal`
   - `Simpan Akses`

### 8.3 Validasi Admin

- Jika tidak memilih cabang, tampilkan warning sebelum simpan.
- Jika tidak memilih modul, tampilkan warning sebelum simpan.
- Saat menyimpan:
  - disable tombol simpan,
  - tampilkan loading,
  - cegah double submit.
- Setelah sukses:
  - tutup modal,
  - refresh list investor access,
  - tampilkan toast sukses.
- Jika gagal:
  - modal tetap terbuka,
  - tampilkan pesan error yang bisa dipahami admin.

### 8.4 Integrasi Modal Staff

Saat membuat user role `investor` dari modal staff:

- Admin tetap dapat memilih cabang awal.
- Tambahkan pilihan modul awal atau arahkan setelah simpan ke modal `Atur Akses`.
- Default permission untuk investor baru:
  - cabang: kosong,
  - modul: kosong,
  - admin harus eksplisit memberi akses.

Alasan: data investor sensitif, sehingga default harus tidak memberi akses otomatis.

## 9. Investor UI Requirement

### 9.1 Desktop

- Header tetap ringkas.
- Filter cabang/periode/metode bayar berada di bar atas atau panel filter yang mudah discan.
- Tab hanya menampilkan modul yang diizinkan.
- Overview menampilkan kartu berdasarkan data yang boleh dilihat.
- Tabel tetap boleh dipakai di desktop, tetapi harus memiliki horizontal scroll aman jika kolom melebar.

### 9.2 Mobile Swipe Navigation

Halaman investor mobile wajib menggunakan pola slide kanan/kiri antar modul.

Requirement:

- Area modul memakai horizontal swipe dengan `scroll-snap` atau carousel ringan.
- Setiap modul menjadi satu slide full-width:
  - Overview
  - Penjualan
  - Produk
  - Stok
  - Pemakaian Bahan
- Tab/segmented control di atas tetap ada sebagai shortcut, tetapi sinkron dengan posisi slide.
- Swipe kiri pindah ke modul berikutnya.
- Swipe kanan pindah ke modul sebelumnya.
- Posisi aktif terlihat jelas.
- Tidak ada konten yang terpotong karena `.overflow:hidden` pada table wrapper.
- Gunakan safe area padding untuk perangkat mobile.

### 9.3 Mobile Layout Detail

Header mobile:

- Logo kecil.
- Nama brand dipendekkan menjadi `Investor`.
- Nama user boleh dipindah ke menu/account area.
- Tombol logout menjadi icon button dengan tooltip/title.

Filter mobile:

- Cabang dan periode harus mudah diakses.
- Rekomendasi pola:
  - bar ringkas berisi cabang aktif + periode,
  - tombol filter membuka bottom sheet atau collapsible panel.
- Tombol `Tampilkan` full width di mobile.
- Date input tidak boleh membuat layout melebar.

Overview mobile:

- KPI cards 2 kolom untuk layar >= 360px.
- 1 kolom untuk layar sangat kecil.
- Nilai rupiah harus wrap/resize dengan rapi, tidak keluar kartu.

Penjualan mobile:

- Hindari tabel 5 kolom sebagai tampilan utama.
- Gunakan card list:
  - total transaksi,
  - tanggal/jam,
  - metode bayar,
  - status,
  - kasir jika diizinkan tetap ditampilkan kecil.
- Jika tetap menyediakan table, table harus berada dalam horizontal scroll yang jelas.

Produk mobile:

- Gunakan ranking list.
- Tampilkan produk, varian, qty, revenue.

Stok mobile:

- Gunakan list/card bahan.
- Tampilkan nama bahan, stok saat ini, satuan, pemakaian hari ini, update terakhir.
- Tambahkan visual status sederhana seperti normal/rendah jika threshold tersedia.

Pemakaian bahan mobile:

- Gunakan list compact.
- Tampilkan bahan, total terpakai, satuan.

### 9.4 UX State

Investor page wajib punya state berikut:

- Loading awal: skeleton atau spinner yang tidak menggeser layout besar.
- Refresh loading: tombol refresh disabled dan menampilkan loading.
- Empty data: pesan spesifik per modul.
- No branch access: pesan `Akun investor belum memiliki akses cabang. Hubungi admin.`
- No feature access: pesan `Akun investor belum memiliki izin fitur. Hubungi admin.`
- Partial access: jika hanya satu modul aktif, hanya modul itu yang muncul.
- Error RPC: tampilkan banner error dan tombol coba lagi.

## 10. Frontend Implementation Notes

### 10.1 File yang Perlu Diubah

- `admin.html`
  - Revisi modal investor access.
  - Tambahkan UI toggle permission.

- `js/admin.js`
  - Load feature access investor.
  - Render chip modul di list investor.
  - Save branch + feature access.
  - Validasi form akses.

- `investor.html`
  - Revisi struktur panel menjadi swipeable.
  - Rapikan header/filter/tabs mobile.
  - Hilangkan/kurangi inline style yang sulit dirawat.

- `js/investorService.js`
  - Tambahkan `getAccessConfig`.
  - Jangan expose helper yang bypass permission.

- `js/investor.js`
  - Simpan state `permissions`.
  - Render hanya modul yang diizinkan.
  - Lazy load data per modul atau batch hanya untuk modul yang diizinkan.
  - Sinkronkan tab aktif dengan swipe slide.

- `css/styles.css`
  - Pindahkan style investor dari inline CSS ke stylesheet utama atau file khusus investor.
  - Tambahkan responsive rules investor.
  - Tambahkan class reusable untuk swipe panels, investor cards, permission chips, dan empty states.

### 10.2 Perubahan Loading Data Investor

Saat ini `loadDashboard()` memanggil semua RPC sekaligus:

```js
Promise.all([
  getSalesReport(),
  getProductPerformance(),
  getInventorySummary(),
  getInventoryUsage()
])
```

Target revisi:

- Ambil `accessConfig` setelah user tervalidasi.
- Tentukan modul aktif.
- Panggil hanya RPC untuk modul aktif.
- Jika modul tidak aktif, jangan render tab dan jangan panggil RPC.
- Jika semua modul tidak aktif, tampilkan no feature access.

## 11. Acceptance Criteria

### 11.1 Admin Permission

- Admin dapat membuka menu `Investor Access`.
- Admin dapat melihat daftar investor beserta cabang dan modul aktif.
- Admin dapat membuka modal `Atur Akses`.
- Admin dapat memilih cabang investor.
- Admin dapat memilih modul: Penjualan, Performa Produk, Stok Bahan, Pemakaian Bahan.
- Admin dapat menyimpan akses dan melihat perubahan langsung di list.
- Investor baru tidak otomatis mendapat akses modul jika admin belum memilih.

### 11.2 Enforcement

- Investor tanpa akses cabang tidak dapat melihat data.
- Investor tanpa akses modul tidak dapat melihat data.
- Investor yang hanya diberi akses `sales` tidak melihat tab stok/produk/pemakaian bahan.
- Investor yang hanya diberi akses `inventory_stock` tidak melihat data penjualan.
- RPC menolak request manual jika investor tidak punya permission fitur.

### 11.3 Mobile UI

- Di layar mobile 360px, halaman investor tidak memiliki horizontal overflow global.
- Modul investor dapat digeser kanan/kiri.
- Tab aktif berubah saat user swipe.
- Tombol dan input memiliki touch target yang nyaman.
- Tabel/list tidak terpotong.
- Filter tidak menutupi konten utama.
- Empty/loading/error state tampil rapi.

### 11.4 Regression

- Admin tetap bisa membuat/edit user staff dan admin.
- Role investor tetap redirect ke `investor.html`.
- Investor dengan permission lengkap tetap bisa melihat semua data seperti sistem lama.
- Existing investor yang sudah punya cabang tetap bisa diberi default permission melalui migration/backfill.

## 12. Backfill dan Compatibility

Untuk investor existing, migration harus menyediakan strategi backfill.

Rekomendasi:

- Semua user role `investor` yang sudah punya cabang diberi semua permission MVP secara default agar tidak memutus akses yang sudah ada.
- Investor baru setelah migrasi default permission kosong.

Contoh backfill:

```sql
INSERT INTO investor_feature_access (user_id, feature_key, allowed)
SELECT u.id, f.feature_key, TRUE
FROM users u
CROSS JOIN (
  VALUES
    ('sales'),
    ('products'),
    ('inventory_stock'),
    ('inventory_usage')
) AS f(feature_key)
WHERE u.role = 'investor'
ON CONFLICT (user_id, feature_key)
DO NOTHING;
```

## 13. QA Test Plan

### 13.1 Admin

- Buat investor baru tanpa cabang dan tanpa modul.
- Tambahkan satu cabang dan satu modul.
- Tambahkan beberapa cabang dan beberapa modul.
- Hapus semua modul lalu simpan.
- Hapus semua cabang lalu simpan.
- Edit investor existing dan pastikan value lama termuat benar.

### 13.2 Investor

- Login sebagai investor tanpa akses cabang.
- Login sebagai investor tanpa akses modul.
- Login sebagai investor hanya sales.
- Login sebagai investor hanya stok.
- Login sebagai investor akses lengkap.
- Uji filter tanggal dan cabang.
- Uji refresh.
- Uji error RPC.

### 13.3 Responsive

Uji minimal viewport:

- 360 x 800 mobile
- 390 x 844 mobile
- 768 x 1024 tablet
- 1366 x 768 desktop

Checklist:

- Tidak ada teks keluar container.
- Tidak ada button saling tumpuk.
- Swipe kanan/kiri responsif.
- Tab aktif sinkron dengan slide.
- Tabel/list tetap bisa dibaca.

## 14. Prioritas Implementasi

### Phase 1 - Access Control

- Tambah migration permission.
- Tambah RPC access config dan permission validator.
- Update RPC investor existing.
- Update admin save/load permission.

### Phase 2 - Investor Rendering

- Update `investorService`.
- Update `investor.js` agar permission-aware.
- Sembunyikan modul yang tidak diizinkan.
- Tambah no access states.

### Phase 3 - Mobile UI/UX

- Rebuild investor layout mobile dengan swipe panels.
- Ubah tabel mobile menjadi card/list.
- Rapikan filter mobile.
- Bersihkan mojibake text.

### Phase 4 - QA dan Hardening

- Test permission matrix.
- Test manual RPC denial.
- Test mobile viewport.
- Review direct grants dan akses tulis permission.

## 15. Risiko

| Risiko | Dampak | Mitigasi |
| --- | --- | --- |
| Permission hanya diterapkan di frontend | Investor bisa bypass lewat console/API | Validasi wajib di RPC |
| Backfill salah | Investor existing kehilangan akses | Backfill semua permission untuk investor existing |
| UI mobile swipe konflik dengan scroll tabel | UX terasa sulit | Gunakan card list mobile dan horizontal scroll hanya untuk tabel detail |
| Save akses setengah berhasil | Data cabang/modul tidak konsisten | Simpan via RPC transaction |
| Terlalu banyak data dimuat di awal | Mobile lambat | Lazy load per modul atau batch sesuai permission |

## 16. Definisi Done

Fitur dianggap selesai jika:

- Admin bisa mengatur cabang dan modul investor dari UI.
- Investor hanya melihat data sesuai permission.
- RPC menolak akses yang tidak diizinkan.
- Investor page mobile rapi, bisa swipe kanan/kiri, dan tidak overflow.
- Semua state utama tersedia: loading, empty, error, no branch, no feature.
- QA permission dan responsive viewport lulus.
