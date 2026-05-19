# PRD Fitur Copy Menu Cabang

Tanggal: 2026-05-16  
Produk: Roti Bakar Ngeunah POS  
Area: Admin - Cabang, Produk, Harga Per-Cabang, POS Menu
Status: Draft PRD

## 1. Ringkasan

Fitur Copy Menu Cabang memungkinkan admin menyalin menu dari satu cabang sumber ke cabang tujuan. Contoh utama: Cabang A sudah memiliki daftar menu dan harga yang benar, lalu admin membuat Cabang B dengan harga yang sama. Admin tidak perlu mengatur ulang produk satu per satu, cukup memilih Cabang A sebagai sumber dan Cabang B sebagai tujuan.

Sistem saat ini menyimpan produk dan varian sebagai master global. Menu yang terlihat di POS cabang ditentukan oleh mapping `branch_products`, sedangkan harga khusus cabang disimpan di `branch_variant_prices`. Karena itu, fitur ini tidak boleh menggandakan data produk. Fitur harus menyalin mapping produk aktif dan override harga cabang saja.

Target utama PRD ini adalah membuat spesifikasi yang jelas, aman, idempotent, dan minim risiko data setengah tersimpan.

## 2. Tujuan

1. Admin dapat menyalin menu aktif dari satu cabang ke cabang lain dalam satu proses.
2. Cabang tujuan langsung menampilkan menu yang sama di POS setelah proses berhasil.
3. Harga efektif cabang tujuan sama dengan cabang sumber pada saat copy.
4. Proses copy tidak membuat duplikat produk, duplikat varian, atau duplikat mapping.
5. Proses copy berjalan atomik di database agar tidak ada kondisi setengah berhasil.
6. Admin mendapat preview dampak sebelum copy dieksekusi.
7. Fitur aman untuk cabang baru dan tetap terkendali untuk cabang yang sudah memiliki menu.

## 3. Kondisi Sistem Saat Ini

### 3.1 Struktur Aplikasi

- Aplikasi adalah web statis berbasis HTML, CSS, dan JavaScript.
- Database dan RPC menggunakan Supabase.
- Admin UI berada di `admin.html` dan dikendalikan oleh `js/admin.js`.
- POS kasir berada di `pos.html` dan dikendalikan oleh `js/pos.js`.
- Auth saat ini memakai session lokal melalui `js/auth.js`, dengan guard `auth.requireRole('admin')` untuk halaman admin.

### 3.2 Model Data Menu Saat Ini

Data yang relevan:

| Tabel | Fungsi |
| --- | --- |
| `branches` | Master cabang/outlet. |
| `products` | Master produk global. Berisi nama, kategori, gambar, tipe produk, dan default price untuk produk sederhana. |
| `product_variants` | Master varian global. Harga default varian disimpan di `price`. |
| `branch_products` | Mapping produk yang tersedia di cabang. POS hanya mengambil produk aktif dari tabel ini. |
| `branch_variant_prices` | Override harga varian per cabang. Jika kosong, POS memakai harga default dari `product_variants.price`. |
| `recipes` dan `recipe_items` | BOM/resep per varian, bersifat global. |
| `toppings` dan `product_toppings` | Topping dan mapping produk-topping, bersifat global per produk. |

### 3.3 Alur yang Sudah Ada

- `js/admin.js` fungsi `saveProduct()` menyimpan produk/varian dan melakukan sinkronisasi `branch_products` berdasarkan checkbox cabang.
- `js/admin.js` fungsi `loadBranchPricing()` membaca semua varian dan menghitung jumlah override per cabang.
- `js/admin.js` fungsi `saveBranchProductPrice()` menyimpan atau menghapus override di `branch_variant_prices`.
- `js/pos.js` fungsi `loadProducts()` membaca:
  - `branch_products` dengan `is_active = true`,
  - `branch_variant_prices` untuk cabang aktif,
  - lalu menghitung harga final per varian.
- Bulk import menu di `js/admin.js` dapat membuat/update produk dan varian serta mengisi `branch_variant_prices`, tetapi visibility POS tetap bergantung pada `branch_products`.

### 3.4 Implikasi Penting

- Produk, varian, kategori, gambar, resep, dan topping tidak perlu dicopy karena sudah global.
- Yang harus dicopy untuk membuat cabang tujuan memiliki menu sama adalah:
  - `branch_products` aktif dari cabang sumber,
  - `branch_variant_prices` dari cabang sumber.
- Copy harga tidak boleh hanya menyalin `branch_variant_prices`, karena tanpa `branch_products` produk tidak muncul di POS.
- Copy menu tidak boleh membuat baris baru di `products` atau `product_variants`.

## 4. Problem Statement

Saat membuat cabang baru, admin harus mengaktifkan produk untuk cabang tersebut dan mengatur harga cabang satu per satu. Ini lambat, rawan salah input, dan berisiko membuat POS cabang baru kosong atau harga tidak sama dengan cabang referensi.

Fitur yang dibutuhkan adalah proses copy menu yang:

- cepat untuk setup cabang baru,
- jelas dampaknya sebelum dieksekusi,
- tidak merusak menu cabang sumber,
- tidak mengubah master produk global,
- tidak mengubah data transaksi historis,
- tidak menyisakan override harga lama di cabang tujuan saat mode replace.

## 5. Scope

### 5.1 In Scope

- UI admin untuk membuka modal Copy Menu Cabang.
- Preview menu yang akan dicopy.
- Copy mapping produk aktif dari cabang sumber ke cabang tujuan.
- Copy override harga cabang dari cabang sumber ke cabang tujuan.
- Mode copy:
  - Replace target menu.
  - Merge into target menu.
- Validasi cabang sumber dan tujuan.
- RPC database atomik untuk eksekusi copy.
- Audit log sederhana untuk copy menu yang berhasil.
- Refresh UI admin setelah copy berhasil.
- QA test plan untuk POS, branch pricing, dan regresi produk.

### 5.2 Out of Scope

- Menyalin stok bahan baku.
- Menyalin transaksi, shift kasir, laporan, cash log, setoran, atau refund.
- Menyalin staff/user cabang.
- Menyalin inventori atau purchase order.
- Menyalin data investor.
- Membuat cabang baru otomatis dari fitur copy.
- Sinkronisasi otomatis permanen antara cabang sumber dan tujuan setelah copy.
- Duplikasi master produk atau varian.
- Mengubah sistem harga global di `product_variants.price`.

## 6. User Persona

### Admin / Owner

Admin mengelola cabang, produk, dan harga. Admin butuh cara cepat untuk membuat cabang baru dengan menu yang sama seperti cabang existing, tanpa input manual berulang.

### Staff / Kasir

Staff menggunakan POS cabang. Setelah admin copy menu, staff harus langsung melihat menu yang benar saat membuka POS cabang tujuan.

## 7. Definisi Data yang Dicopy

### 7.1 Yang Dicopy

1. Produk aktif cabang sumber:
   - sumber: `branch_products`
   - filter: `source.branch_id = p_source_branch_id` dan `is_active = true`
   - hasil: produk yang sama menjadi aktif di cabang tujuan

2. Override harga cabang sumber:
   - sumber: `branch_variant_prices`
   - filter: `source.branch_id = p_source_branch_id`
   - hasil: override yang sama tersedia di cabang tujuan

### 7.2 Yang Tidak Dicopy

| Data | Alasan |
| --- | --- |
| `products` | Master produk global, tidak boleh diduplikasi. |
| `product_variants` | Master varian global, tidak boleh diduplikasi. |
| `product_categories` | Kategori melekat ke produk global. |
| `recipes` dan `recipe_items` | Resep melekat ke varian global. |
| `toppings` dan `product_toppings` | Topping melekat ke produk global. |
| `branch_inventory` | Stok cabang harus dikelola sendiri. |
| `inventory_logs` | Log stok historis tidak boleh disalin. |
| `transactions` dan `transaction_items` | Data transaksi historis tidak boleh disalin. |
| `cashier_sessions` dan `cash_logs` | Data kas cabang tidak boleh disalin. |
| `users` | Staff/admin/investor tidak termasuk menu. |

## 8. Aturan Bisnis

1. Cabang sumber dan cabang tujuan wajib dipilih.
2. Cabang sumber dan cabang tujuan tidak boleh sama.
3. Copy memakai `branch_id` dan `product_id`, bukan nama cabang atau nama produk.
4. Cabang sumber harus memiliki minimal satu produk aktif.
5. Produk yang dicopy adalah produk aktif di cabang sumber saja.
6. Harga efektif target harus sama dengan sumber setelah copy selesai.
7. Jika sumber memakai harga default untuk sebuah varian, target juga harus memakai harga default untuk varian tersebut.
8. Jika sumber memiliki override harga untuk sebuah varian, target harus memiliki override harga yang sama.
9. Override lama di target untuk produk yang dicopy harus dihapus lebih dulu, lalu diisi ulang sesuai sumber.
10. Proses copy bersifat one-time snapshot, bukan link permanen.
11. Perubahan menu atau harga sumber setelah copy tidak otomatis mengubah target.
12. Transaksi lama target tidak berubah karena harga transaksi tersimpan di `transaction_items`.
13. Cabang sumber tidak boleh berubah sama sekali akibat proses copy.
14. Cabang tujuan harus berubah hanya setelah seluruh operasi berhasil.

## 9. Mode Copy

### 9.1 Replace Target Menu

Mode default dan direkomendasikan untuk cabang baru.

Perilaku:

- Semua produk aktif lama di cabang tujuan dinonaktifkan.
- Semua override harga lama cabang tujuan dihapus.
- Produk aktif dari cabang sumber diaktifkan di cabang tujuan.
- Override harga sumber disalin ke cabang tujuan.
- Produk yang tidak aktif di cabang sumber tidak aktif di cabang tujuan.

Kapan digunakan:

- Cabang tujuan baru dibuat.
- Admin ingin cabang tujuan benar-benar sama dengan cabang sumber.
- Admin ingin membersihkan konfigurasi lama target.

### 9.2 Merge Into Target Menu

Mode tambahan untuk cabang yang sudah punya menu.

Perilaku:

- Produk aktif lama di cabang tujuan tetap aktif.
- Produk aktif dari cabang sumber ditambahkan/diaktifkan di cabang tujuan.
- Untuk produk yang dicopy dari sumber, override harga target diganti agar sama dengan sumber.
- Produk target yang tidak ada di sumber tidak disentuh.
- Override harga target untuk produk target-only tidak disentuh.

Kapan digunakan:

- Cabang tujuan sudah memiliki menu lokal.
- Admin hanya ingin menambahkan menu dari cabang lain.

## 10. UX Requirement

### 10.1 Entry Point

Tambahkan akses fitur di Admin:

1. `Admin -> Cabang`
   - Pada setiap card/list cabang, tambahkan tombol `Copy Menu`.
   - Tombol ini menjadikan cabang tersebut sebagai target.

2. Setelah `Tambah Cabang` berhasil
   - Tampilkan toast sukses seperti sekarang.
   - Tambahkan opsi lanjutan yang mudah ditemukan: tombol atau prompt `Copy menu dari cabang lain`.
   - Cabang baru otomatis menjadi target di modal copy.

3. Opsional di `Admin -> Harga Per-Cabang`
   - Jika cabang tujuan sudah dipilih, sediakan tombol `Copy Dari Cabang Lain`.

### 10.2 Modal Copy Menu

Modal minimal berisi:

- Judul: `Copy Menu Cabang`
- Field `Cabang Sumber`
  - Select list cabang.
  - Tidak boleh sama dengan target.
- Field `Cabang Tujuan`
  - Readonly jika dibuka dari tombol di card cabang.
  - Select jika dibuka dari toolbar umum.
- Mode Copy
  - Radio: `Replace target menu`
  - Radio: `Merge into target menu`
- Ringkasan harga
  - Teks: `Harga target akan mengikuti struktur harga sumber: override dicopy, harga default tetap memakai default global.`
- Tombol `Preview`
- Area preview
- Tombol `Salin Menu`
- Tombol `Batal`

### 10.3 Preview

Sebelum copy, admin wajib melihat preview:

| Data Preview | Keterangan |
| --- | --- |
| Cabang sumber | Nama cabang sumber. |
| Cabang tujuan | Nama cabang tujuan. |
| Produk aktif sumber | Jumlah produk yang akan dicopy. |
| Varian aktif sumber | Jumlah varian dari produk aktif sumber. |
| Override harga sumber | Jumlah override yang akan disalin. |
| Produk aktif target saat ini | Untuk memperjelas dampak replace/merge. |
| Override harga target saat ini | Untuk memperjelas dampak replace. |
| Produk tanpa varian | Warning jika ada produk aktif sumber tanpa varian. |
| Mode copy | Replace atau merge. |

Jika mode `replace` dan target sudah memiliki produk aktif, tampilkan konfirmasi:

`Menu aktif cabang tujuan akan diganti. Transaksi lama tidak berubah. Lanjutkan?`

### 10.4 Success State

Setelah copy berhasil:

- Tutup modal atau tampilkan done state.
- Tampilkan toast: `Menu berhasil dicopy ke [Nama Cabang]`.
- Tampilkan ringkasan hasil:
  - produk diaktifkan,
  - produk dinonaktifkan,
  - override harga disalin,
  - override harga dihapus,
  - produk/varian dilewati.
- Refresh:
  - master data admin,
  - list cabang jika sedang di halaman cabang,
  - branch pricing jika sedang di halaman harga cabang.

### 10.5 Error State

Modal tetap terbuka jika gagal.

Pesan error harus jelas:

- `Cabang sumber wajib dipilih.`
- `Cabang tujuan wajib dipilih.`
- `Cabang sumber dan tujuan tidak boleh sama.`
- `Cabang sumber belum memiliki menu aktif.`
- `Tabel branch_products belum siap. Jalankan migrasi database.`
- `Tabel branch_variant_prices belum siap. Jalankan migrasi database.`
- `Copy menu gagal. Tidak ada perubahan yang disimpan.`

## 11. Database dan RPC Requirement

### 11.1 Migrasi Baru

Buat migration baru:

`sql/migrations/018_copy_branch_menu.sql`

Migration harus berisi:

1. Validasi/penambahan constraint penting jika belum ada:
   - `branch_products`: unique `(branch_id, product_id)`
   - `branch_variant_prices`: unique `(branch_id, variant_id)`
   - `branch_variant_prices.price >= 0`
2. Audit table opsional tetapi direkomendasikan:
   - `branch_menu_copy_logs`
3. RPC preview:
   - `admin_preview_branch_menu_copy(...)`
4. RPC eksekusi:
   - `admin_copy_branch_menu(...)`
5. Grant execute sesuai pola proyek saat ini.

Catatan: full base schema tidak tersedia lengkap di repository ini, jadi migration harus dibuat defensif terhadap constraint yang mungkin sudah ada di Supabase.

### 11.2 Audit Table

Rekomendasi:

```sql
CREATE TABLE IF NOT EXISTS public.branch_menu_copy_logs (
  id BIGSERIAL PRIMARY KEY,
  source_branch_id BIGINT NOT NULL REFERENCES public.branches(id),
  target_branch_id BIGINT NOT NULL REFERENCES public.branches(id),
  mode TEXT NOT NULL CHECK (mode IN ('replace', 'merge')),
  copied_by BIGINT REFERENCES public.users(id),
  result JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```

Audit log digunakan untuk melacak kapan menu cabang dicopy dan hasilnya. Log ini tidak perlu tampil di MVP, tetapi datanya membantu debugging.

### 11.3 RPC Preview

Nama:

`admin_preview_branch_menu_copy`

Parameter:

| Parameter | Type | Wajib | Keterangan |
| --- | --- | --- | --- |
| `p_source_branch_id` | BIGINT | Ya | Cabang sumber. |
| `p_target_branch_id` | BIGINT | Ya | Cabang tujuan. |
| `p_mode` | TEXT | Ya | `replace` atau `merge`. |

Return JSON:

```json
{
  "source_branch": { "id": 1, "name": "Cabang A" },
  "target_branch": { "id": 2, "name": "Cabang B" },
  "mode": "replace",
  "source_active_products": 42,
  "source_variants": 84,
  "source_overrides": 10,
  "target_active_products": 0,
  "target_overrides": 0,
  "products_without_variants": 0,
  "warnings": []
}
```

Preview tidak boleh mengubah data.

### 11.4 RPC Copy

Nama:

`admin_copy_branch_menu`

Parameter:

| Parameter | Type | Wajib | Keterangan |
| --- | --- | --- | --- |
| `p_source_branch_id` | BIGINT | Ya | Cabang sumber. |
| `p_target_branch_id` | BIGINT | Ya | Cabang tujuan. |
| `p_mode` | TEXT | Ya | `replace` atau `merge`. |
| `p_admin_id` | BIGINT | Ya | User admin yang menjalankan copy, mengikuti pola auth saat ini. |

Return JSON:

```json
{
  "ok": true,
  "mode": "replace",
  "source_branch_id": 1,
  "target_branch_id": 2,
  "products_activated": 42,
  "products_deactivated": 0,
  "target_overrides_deleted": 0,
  "target_overrides_inserted": 10,
  "products_without_variants": 0
}
```

### 11.5 Validasi RPC

RPC copy wajib:

1. Memastikan `p_mode` hanya `replace` atau `merge`.
2. Memastikan `p_source_branch_id` dan `p_target_branch_id` valid.
3. Menolak jika source dan target sama.
4. Memastikan `p_admin_id` adalah user dengan role `admin`.
5. Mengunci target branch selama transaksi copy untuk mencegah double submit/concurrent copy.
6. Menolak jika source tidak memiliki produk aktif.
7. Menolak jika constraint unik yang dibutuhkan tidak tersedia dan upsert tidak bisa aman.
8. Tidak mengubah cabang sumber.
9. Menulis audit log setelah copy berhasil.

### 11.6 Atomicity

Eksekusi copy wajib berada dalam satu fungsi SQL `SECURITY DEFINER`. Semua perubahan harus berhasil bersama-sama atau rollback seluruhnya.

Alasan:

- Frontend saat ini banyak melakukan operasi table-by-table.
- Untuk copy menu, operasi multi-table dari frontend rawan kondisi setengah berhasil jika network putus.
- Fungsi PostgreSQL berjalan dalam satu transaksi, sehingga lebih aman.

### 11.7 Idempotency

Menjalankan copy yang sama dua kali harus menghasilkan data akhir yang sama.

Requirement:

- Tidak boleh ada duplikat `branch_products`.
- Tidak boleh ada duplikat `branch_variant_prices`.
- `upsert` wajib memakai `on conflict (branch_id, product_id)` dan `on conflict (branch_id, variant_id)`.
- Replace kedua kali harus tetap sukses.
- Merge kedua kali harus tetap sukses tanpa menambah duplikat.

## 12. Algoritma Copy

### 12.1 Data Source

Ambil produk aktif sumber:

```sql
SELECT product_id
FROM branch_products
WHERE branch_id = p_source_branch_id
  AND is_active = TRUE;
```

Ambil varian dari produk aktif sumber:

```sql
SELECT pv.id AS variant_id
FROM product_variants pv
JOIN source_products sp ON sp.product_id = pv.product_id;
```

Ambil override harga sumber:

```sql
SELECT bvp.variant_id, bvp.price
FROM branch_variant_prices bvp
JOIN source_variants sv ON sv.variant_id = bvp.variant_id
WHERE bvp.branch_id = p_source_branch_id;
```

### 12.2 Replace Target Menu

Urutan wajib:

1. Lock target branch.
2. Validate input.
3. Ambil source active products dan variants.
4. Hitung produk target yang akan dinonaktifkan.
5. Set semua `branch_products` target menjadi `is_active = false`.
6. Hapus semua `branch_variant_prices` target.
7. Upsert source active products ke target dengan `is_active = true`.
8. Insert source overrides ke target.
9. Tulis audit log.
10. Return result JSON.

### 12.3 Merge Into Target Menu

Urutan wajib:

1. Lock target branch.
2. Validate input.
3. Ambil source active products dan variants.
4. Upsert source active products ke target dengan `is_active = true`.
5. Hapus override target hanya untuk source variants.
6. Insert source overrides ke target.
7. Tulis audit log.
8. Return result JSON.

## 13. Frontend Implementation Notes

### 13.1 File yang Perlu Diubah

| File | Perubahan |
| --- | --- |
| `admin.html` | Tambah tombol copy menu di section cabang, tambah modal copy menu, tambah area preview. |
| `js/admin.js` | Tambah handler action, state modal, preview RPC, confirm RPC, refresh data. |
| `css/styles.css` | Tambah style minimal untuk preview/warning jika class existing tidak cukup. |
| `sql/migrations/018_copy_branch_menu.sql` | Tambah RPC dan audit table. |

### 13.2 Action dan Handler

Tambahkan action:

- `open-copy-menu-modal`
- `preview-copy-menu`
- `confirm-copy-menu`

State di `ADMIN`:

```js
_copyMenuPreview: null,
_copyMenuSubmitting: false
```

### 13.3 Fungsi Baru di `js/admin.js`

Rekomendasi fungsi:

- `openCopyMenuModal(targetBranchId = null)`
- `resetCopyMenuModal()`
- `loadCopyMenuPreview()`
- `renderCopyMenuPreview(preview)`
- `confirmCopyMenu()`
- `refreshAfterCopyMenu(targetBranchId)`

### 13.4 Integrasi UI Existing

Gunakan helper yang sudah ada:

- `showToast()`
- `showConfirm()`
- `openModal()`
- `closeModal()`
- `escHtml()`
- `fRp()`
- `setSelect()`

Gunakan class existing:

- `.modal`
- `.modal-lg`
- `.form-control`
- `.btn`
- `.table-wrap`
- `.badge`
- `.empty-state`

### 13.5 Disable Double Submit

Saat preview atau confirm berjalan:

- disable tombol terkait,
- tampilkan text loading,
- jangan panggil RPC kedua kali jika `_copyMenuSubmitting = true`.

## 14. Security dan Data Integrity

### 14.1 Admin Guard

Frontend tetap memakai `auth.requireRole('admin')`, tetapi RPC juga wajib memvalidasi `p_admin_id` terhadap tabel `users` dengan role `admin`.

Catatan penting:

- Sistem auth saat ini berbasis local session, bukan Supabase Auth penuh.
- Validasi `p_admin_id` mengikuti pola proyek saat ini, tetapi belum menjadi bukti kriptografis.
- Untuk hardening jangka panjang, mutasi admin sebaiknya memakai session server-side atau Supabase Auth JWT.

### 14.2 Database Constraint

Fitur ini bergantung pada constraint unik:

- `branch_products(branch_id, product_id)`
- `branch_variant_prices(branch_id, variant_id)`

Tanpa constraint ini, upsert tidak aman dan data duplikat bisa muncul.

### 14.3 Locking

RPC copy harus memakai transaction-level advisory lock berdasarkan target branch agar dua proses copy ke cabang yang sama tidak berjalan bersamaan.

Contoh pendekatan:

```sql
PERFORM pg_advisory_xact_lock(9871001, p_target_branch_id::integer);
```

Jika tipe ID dapat melebihi integer, gunakan strategi lock key yang aman untuk bigint.

### 14.4 Rollback

Jika operasi gagal di tengah:

- tidak ada perubahan yang tersimpan,
- audit log tidak dibuat,
- frontend menampilkan error,
- admin bisa mencoba ulang.

## 15. Edge Cases

| Kondisi | Expected Behavior |
| --- | --- |
| Source kosong | Copy ditolak dengan pesan source belum memiliki menu aktif. |
| Source dan target sama | Copy ditolak. |
| Target belum punya menu | Replace sukses, tidak ada deactivation berarti. |
| Target sudah punya menu dan mode replace | Tampilkan konfirmasi, lalu ganti menu target jika admin lanjut. |
| Target sudah punya menu dan mode merge | Menu target lama tetap ada, produk sumber ditambahkan/diupdate. |
| Source punya override, target punya override berbeda | Target mengikuti source setelah copy. |
| Source tidak punya override, target punya override lama untuk variant yang dicopy | Override target dihapus agar kembali ke default. |
| Source product aktif tetapi tidak punya variant | Muncul warning preview; produk boleh diaktifkan, tetapi POS tidak menampilkan sampai variant dibuat. |
| Product/variant global dihapus saat preview dan sebelum confirm | RPC confirm tetap validasi ulang dan gagal/skip aman. |
| Admin double click confirm | Button disabled dan database lock mencegah race. |
| Network putus saat confirm | Database tetap atomic; admin dapat refresh dan cek audit/result. |
| `branch_variant_prices` belum ada | Fitur menampilkan error migrasi belum siap. |
| Bulk import membuat produk tanpa branch mapping | Copy hanya menyalin produk yang aktif di source; produk import yang belum aktif tidak ikut. |

## 16. Acceptance Criteria

### 16.1 Admin UI

- Admin dapat membuka modal copy menu dari halaman cabang.
- Modal menampilkan pilihan cabang sumber dan target.
- Source dan target tidak bisa sama.
- Admin dapat memilih mode replace atau merge.
- Admin dapat melihat preview sebelum copy.
- Admin mendapat warning jika target sudah memiliki menu dan mode replace dipilih.
- Tombol confirm disabled saat proses berjalan.
- Setelah sukses, UI menampilkan ringkasan hasil dan refresh data terkait.

### 16.2 Data Result

- Produk aktif target sama dengan source pada mode replace.
- Produk aktif target berisi gabungan target lama dan source pada mode merge.
- Override harga target sama dengan source untuk variant yang dicopy.
- Variant yang memakai default di source juga memakai default di target.
- Tidak ada duplikat baris di `branch_products`.
- Tidak ada duplikat baris di `branch_variant_prices`.
- Source branch tidak berubah.
- Transaksi historis target tidak berubah.

### 16.3 POS

- Setelah copy berhasil, POS cabang target menampilkan produk yang sesuai.
- Harga di POS cabang target sama dengan cabang sumber pada saat copy.
- Produk yang tidak aktif di source tidak muncul di target pada mode replace.
- Topping dan resep tetap berjalan karena memakai data global produk/variant.

### 16.4 Error Handling

- Source kosong ditolak tanpa mengubah target.
- Source sama dengan target ditolak tanpa mengubah data.
- Kegagalan RPC tidak meninggalkan data setengah tersimpan.
- Pesan error dapat dipahami admin.

## 17. QA Test Plan

### 17.1 Setup Data

Buat minimal:

- Cabang A sebagai source.
- Cabang B sebagai target baru kosong.
- Cabang C sebagai target yang sudah punya menu.
- Produk 1 dengan dua varian dan harga default.
- Produk 2 dengan satu varian dan override harga di Cabang A.
- Produk 3 aktif di Cabang C saja.

### 17.2 Test Replace ke Cabang Baru

Langkah:

1. Buka Admin -> Cabang.
2. Klik Copy Menu pada Cabang B.
3. Pilih source Cabang A.
4. Pilih mode replace.
5. Preview.
6. Confirm.

Expected:

- Cabang B punya produk aktif sama dengan Cabang A.
- Override Cabang B sama dengan Cabang A.
- POS Cabang B menampilkan menu sama dengan Cabang A.
- Tidak ada duplikat mapping.

### 17.3 Test Replace ke Cabang yang Sudah Punya Menu

Langkah:

1. Cabang C punya Produk 3 aktif.
2. Copy dari Cabang A ke Cabang C mode replace.

Expected:

- Produk 3 tidak aktif lagi di Cabang C jika tidak ada di Cabang A.
- Override lama Cabang C terhapus.
- Menu Cabang C sama dengan Cabang A.
- Transaksi historis Cabang C tetap ada.

### 17.4 Test Merge

Langkah:

1. Cabang C punya Produk 3 aktif.
2. Copy dari Cabang A ke Cabang C mode merge.

Expected:

- Produk 3 tetap aktif.
- Produk Cabang A ikut aktif di Cabang C.
- Harga produk yang berasal dari Cabang A mengikuti Cabang A.
- Override produk target-only tidak berubah.

### 17.5 Test Harga Default vs Override

Case:

- Variant X di source tidak punya override.
- Variant Y di source punya override.
- Target sebelumnya punya override untuk X dan Y.

Expected setelah copy:

- Override X di target terhapus.
- Override Y di target sama dengan source.
- Harga POS target sama dengan source.

### 17.6 Test Idempotency

Langkah:

1. Jalankan copy yang sama dua kali.
2. Cek row count `branch_products`.
3. Cek row count `branch_variant_prices`.

Expected:

- Tidak bertambah duplikat.
- Hasil akhir tetap sama.
- RPC tetap sukses.

### 17.7 Test Error

Test wajib:

- Source kosong.
- Source sama dengan target.
- Source branch tidak ada.
- Target branch tidak ada.
- User bukan admin.
- Simulasi double submit.

Expected:

- Error jelas.
- Tidak ada perubahan data.

### 17.8 Regression

Pastikan fitur berikut tetap berjalan:

- Tambah/edit produk.
- Checkbox ketersediaan cabang di modal produk.
- Atur harga per-cabang.
- Bulk import menu.
- POS load menu.
- Checkout transaksi.
- Resep/BOM stock check.
- Topping produk.
- Laporan transaksi.

## 18. Prioritas Implementasi

### Phase 1 - Database Safety

- Buat migration `018_copy_branch_menu.sql`.
- Tambah/validasi unique constraint.
- Buat RPC preview.
- Buat RPC copy atomik.
- Tambah audit log.

### Phase 2 - Admin UI

- Tambah tombol copy menu di list cabang.
- Tambah modal copy menu.
- Tambah preview state.
- Tambah confirm flow dan loading state.

### Phase 3 - POS Verification

- Verifikasi POS cabang target membaca menu hasil copy.
- Verifikasi harga default dan override.
- Verifikasi branch pricing menampilkan count override yang benar.

### Phase 4 - Hardening

- Test idempotency.
- Test double submit.
- Test failure/rollback.
- Test target dengan data existing.
- Review error message dan audit log.

## 19. Risiko dan Mitigasi

| Risiko | Dampak | Mitigasi |
| --- | --- | --- |
| Copy dilakukan dari frontend multi-step | Data bisa setengah tersimpan saat network gagal | Wajib RPC database atomik. |
| Tidak ada unique constraint | Duplikat mapping/harga | Tambah/validasi unique constraint sebelum fitur aktif. |
| Target punya override lama | Harga target tidak sama dengan source | Hapus override target untuk scope copy sebelum insert ulang. |
| Source kosong | Target bisa terhapus jika replace tanpa validasi | Tolak copy jika source tidak punya produk aktif. |
| Admin salah pilih target | Menu cabang salah berubah | Preview jelas dan konfirmasi replace. |
| Double submit | Race condition | Disable button dan advisory lock. |
| Produk aktif tanpa variant | Produk tidak muncul di POS | Tampilkan warning preview. |
| Auth hanya local session | RPC role validation tidak sepenuhnya kuat | Validasi role di RPC mengikuti pola saat ini, rencanakan hardening auth. |
| Bulk import tidak mengaktifkan branch_products | Produk import mungkin tidak ikut copy | Copy hanya berdasarkan menu aktif source; tampilkan jumlah source active product. |

## 20. Definition of Done

Fitur dianggap selesai jika:

- Admin dapat copy menu dari cabang sumber ke cabang tujuan.
- Mode replace dan merge bekerja sesuai spesifikasi.
- Proses copy berjalan lewat RPC atomik.
- Hasil copy tidak membuat duplikat data.
- Harga efektif POS target sama dengan source setelah copy.
- Source branch tidak berubah.
- Transaksi, stok, kas, staff, resep, dan topping tidak rusak.
- Error state dan loading state tersedia.
- Audit log copy berhasil tersimpan.
- QA test plan utama lulus.

