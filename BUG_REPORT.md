# BUG REPORT SISTEM — RBN POS (Roti Bakar Ngeunah)

> Dibuat: 2026-05-29 | Auditor: Claude Code | Versi Kode: Branch `main`

---

## 1. Ringkasan Audit

Sistem RBN POS adalah aplikasi Point of Sale berbasis web yang telah bermigrasi dari Supabase/PostgreSQL ke cPanel/MySQL. Sistem terdiri dari:
- **Frontend:** HTML + Vanilla JS (pos.html, admin.html, investor.html, index.html)
- **Backend:** PHP REST API (`api/api.php`) yang menggantikan Supabase PostgREST
- **Database:** MySQL dengan schema yang diadaptasi dari PostgreSQL
- **Fitur utama:** Transaksi POS, manajemen kas outlet, setoran tunai, transfer kas antar outlet, laporan

**Bagian yang sudah baik:**
- Penggunaan prepared statements (PDO) di seluruh backend PHP — mencegah SQL injection
- Logika bisnis kritis (transaksi, buka/tutup kas) menggunakan database transaction (`BEGIN`/`COMMIT`)
- Idempotency check pada transaksi POS menggunakan `client_tx_id`
- Validasi input frontend cukup lengkap meskipun belum sempurna di backend
- Formatter tanggal (WITA/UTC+8) konsisten di level frontend
- Row-level locking (`FOR UPDATE`) digunakan untuk operasi saldo yang kritis

**Bagian yang berpotensi bermasalah:**
- API key dan credential sensitif terekspos di frontend dan repository Git
- Beberapa fungsi RPC tidak memiliki validasi role/akses yang cukup
- Status transaksi tidak konsisten antara frontend dan backend
- Beberapa fungsi kritis tidak menggunakan database transaction
- Tabel yang diquery tidak terdaftar di whitelist API
- File-file besar yang sulit di-maintain

---

## 2. Daftar Bug Prioritas Tinggi

### Bug 1 — API Key Hardcoded di File JavaScript Frontend

- **Kategori:** Keamanan
- **Lokasi File:** `js/supabaseClient.js` baris 7 dan `api/config.php` baris 14
- **Masalah:** API key `rbn2026xK9mPqL3vWnHjRtYcBfDsAeUo` ditulis langsung (hardcoded) di file JavaScript yang bisa dibaca oleh siapapun melalui browser developer tools (F12). API key yang sama juga ada di `config.php` yang ada di repository Git.
- **Dampak:** Siapapun yang mengunjungi website bisa mengambil API key ini dan langsung membuat request ke backend API — termasuk membuat deposit palsu, mengubah saldo, atau mengakses data transaksi semua outlet — tanpa perlu login sebagai user manapun.
- **Penyebab Kemungkinan:** Sisa pola lama dari Supabase (Supabase menggunakan anon key yang memang publik), namun pada sistem custom PHP ini API key berfungsi sebagai satu-satunya pengaman akses API.
- **Rekomendasi Perbaikan:** Alih-alih mengandalkan API key sebagai satu-satunya pengaman, implementasikan session-based authentication: setelah login berhasil, server memberikan token sesi yang hanya berlaku untuk user tersebut. Validasi token ini di setiap request API untuk memastikan hanya user yang sudah login yang bisa mengakses endpoint. Hapus API key statis dari kode frontend.
- **Prioritas:** Tinggi

---

### Bug 2 — Password Database Hardcoded di File Config

- **Kategori:** Keamanan
- **Lokasi File:** `api/config.php` baris 10
- **Masalah:** Password database MySQL (`@iCYdX9QPC3iYnM`) ditulis langsung di file PHP dan ada di dalam repository Git. Berdasarkan `git status`, file ini ter-track oleh Git.
- **Dampak:** Jika repository diakses oleh pihak tidak berwenang (misalnya di-push ke GitHub secara tidak sengaja, atau ada kebocoran), password database langsung terbaca dan database bisa diakses langsung.
- **Penyebab Kemungkinan:** Praktik umum saat development cepat, namun berbahaya di production.
- **Rekomendasi Perbaikan:** Gunakan file `.env` yang tidak di-track Git untuk menyimpan credential. Tambahkan `.env` ke `.gitignore`. Buat `config.php` membaca dari environment variables atau dari file `.env` yang terpisah.
- **Prioritas:** Tinggi

---

### Bug 3 — Inkonsistensi Status Transaksi 'void' vs 'voided'

- **Kategori:** Integrasi / Data
- **Lokasi File:** `api/api.php` baris 2048, `js/services/transactionService.js` baris 272, `js/services/reportService.js` baris 25, `sql/cpanel_mysql_schema.sql` baris 160
- **Masalah:** Ada ketidaksesuaian nilai status "void" di berbagai bagian sistem:
  - **Schema MySQL** mendefinisikan ENUM: `('completed', 'voided', 'refunded')` — nilai yang valid adalah **'voided'**
  - **Backend** `rpc_void_transaction` menyimpan status sebagai `'voided'` — sudah benar
  - **Frontend** `transactionService.voidTransaction()` mengembalikan `data?.status || 'void'` — default-nya adalah **'void'** (bukan 'voided')
  - **reportService.js** menggunakan filter `t.status === 'void' || t.status === 'voided'` — defensif tetapi menunjukkan ada ketidakpastian
- **Dampak:** Nilai yang dikembalikan ke UI setelah void bisa berupa 'void' (dari default JS) padahal database menyimpan 'voided'. Jika ada filter atau kondisi yang mengecek tepat satu nilai, bisa terjadi tampilan yang salah.
- **Penyebab Kemungkinan:** Migrasi dari Supabase menggunakan nilai 'void', sementara schema MySQL menggunakan 'voided'.
- **Rekomendasi Perbaikan:** Standarisasikan ke 'voided' di seluruh kode. Ubah default di `transactionService.js` dari `|| 'void'` menjadi `|| 'voided'`. Hapus pengecekan ganda di `reportService.js`.
- **Prioritas:** Tinggi

---

### Bug 4 — `void_transaction` Tidak Menggunakan Database Transaction (Atomicity)

- **Kategori:** Backend / Data
- **Lokasi File:** `api/api.php` fungsi `rpc_void_transaction` baris 2036–2055
- **Masalah:** Fungsi ini melakukan dua operasi terpisah: `UPDATE transactions SET status='voided'` dan kemudian `UPDATE cash_logs SET is_void=1`. Tidak ada `beginTransaction()` / `commit()` / `rollBack()`. Jika operasi pertama berhasil tapi kedua gagal (jaringan putus, timeout, dll), data akan tidak konsisten.
- **Dampak:** Transaksi ter-void di tabel `transactions`, tapi `cash_logs`-nya masih aktif. Akibatnya, saldo kas outlet masih terhitung pendapatan dari transaksi yang seharusnya sudah di-void, menyebabkan laporan kas tidak akurat.
- **Penyebab Kemungkinan:** Fungsi ini mungkin ditulis terburu-buru atau terlewat saat proses pembuatan.
- **Rekomendasi Perbaikan:** Bungkus seluruh operasi dalam `$pdo->beginTransaction()` ... `$pdo->commit()`, dengan `$pdo->rollBack()` di blok catch. Contoh sudah ada di fungsi-fungsi lain seperti `rpc_process_transaction` dan `rpc_confirm_deposit`.
- **Prioritas:** Tinggi

---

### Bug 5 — `rpc_admin_set_branch_cash_balance` Tanpa Validasi Role User

- **Kategori:** Keamanan / Backend
- **Lokasi File:** `api/api.php` fungsi `rpc_admin_set_branch_cash_balance` baris 1292–1324
- **Masalah:** Fungsi yang bisa mengubah saldo kas outlet ini **tidak** memverifikasi bahwa user yang meminta (`p_admin_id`) adalah admin atau owner. Bandingkan dengan fungsi lain seperti `rpc_admin_set_branch_cash_balance` yang memiliki pengecekan role:
  ```php
  // Fungsi lain (BENAR):
  $ar = $admin->fetch();
  if (!$ar || !in_array($ar['role'],['admin','owner'])) throw new Exception('Hanya admin/owner');
  
  // Fungsi ini (SALAH - tidak ada pengecekan role):
  function rpc_admin_set_branch_cash_balance(array $p): mixed {
      $pdo = getDB();
      $adminId = (int)($p['p_admin_id'] ?? 0);
      // ... langsung update saldo tanpa cek role
  ```
- **Dampak:** Siapapun yang tahu ID numerik user (bisa di-guess 1, 2, 3...) dan punya API key, bisa mengubah saldo kas outlet ke nilai berapapun.
- **Penyebab Kemungkinan:** Terlewat saat penulisan fungsi.
- **Rekomendasi Perbaikan:** Tambahkan validasi role seperti fungsi-fungsi lainnya sebelum melanjutkan operasi.
- **Prioritas:** Tinggi

---

### Bug 6 — Tabel `cash_session_adjustments` Tidak Terdaftar di Whitelist API

- **Kategori:** Backend / Fungsionalitas
- **Lokasi File:** `api/api.php` baris 67–80 (whitelist), `js/services/cashService.js` baris 377
- **Masalah:** Fungsi `getAdminCashSessionDetail()` di `cashService.js` mencoba mengakses tabel `cash_session_adjustments` melalui `db.from('cash_session_adjustments')`. Namun tabel ini **tidak ada di daftar `$allowedTables`** di `api.php`. Setiap request ke tabel ini akan selalu dikembalikan error 400 "Tabel tidak diizinkan".
- **Dampak:** Data adjustments tidak pernah tampil di detail sesi kas admin. Meskipun ada error handling yang "menelan" error ini (try/catch yang mengembalikan array kosong), fitur ini secara diam-diam tidak berfungsi.
- **Penyebab Kemungkinan:** Tabel baru ditambahkan di kode frontend tapi lupa ditambahkan ke whitelist backend, atau tabel ini memang belum dibuat di database.
- **Rekomendasi Perbaikan:** Jika fitur adjustments akan digunakan, tambahkan `'cash_session_adjustments'` ke `$allowedTables`. Jika belum siap, hapus kode yang mencoba mengaksesnya agar tidak membingungkan.
- **Prioritas:** Tinggi

---

### Bug 7 — Saldo Kas Outlet Bisa Hilang Diam-Diam saat Deposit Dikonfirmasi

- **Kategori:** Backend / Data
- **Lokasi File:** `api/api.php` baris 1680, 1604
- **Masalah:** Saat deposit dikonfirmasi, backend menggunakan `max(0, $before - $amount)` untuk mengurangi saldo:
  ```php
  $after = max(0, $before - (float)$deposit['amount']);
  ```
  Jika saldo outlet lebih kecil dari jumlah deposit yang dikonfirmasi, saldo diset ke 0 tanpa error, perbedaannya hilang begitu saja tanpa peringatan. Contoh: saldo Rp 100.000, deposit dikonfirmasi Rp 500.000 → saldo jadi Rp 0 (bukan -Rp 400.000), tapi ledger mencatat pengurangan Rp 500.000 yang tidak sesuai.
- **Dampak:** Ketidaksesuaian antara jumlah yang dilaporkan terdeposit dengan perubahan saldo yang sebenarnya. Bisa menyebabkan data keuangan tidak dapat direkonsiliasi.
- **Penyebab Kemungkinan:** Mencegah saldo negatif tanpa mempertimbangkan kasus edge ini.
- **Rekomendasi Perbaikan:** Throw exception dan batalkan konfirmasi deposit jika saldo tidak mencukupi, atau setidaknya catat discrepancy ke log/ledger dengan flag khusus.
- **Prioritas:** Tinggi

---

### Bug 8 — Transfer Antar Outlet Bisa Dibuat Duplikat (Tidak Ada Idempotency Check)

- **Kategori:** Backend / Data
- **Lokasi File:** `api/api.php` fungsi `rpc_create_cash_branch_transfer` baris 1724–1775
- **Masalah:** Meskipun ada kolom `client_request_id` di tabel `cash_branch_transfers`, tidak ada pengecekan apakah transfer dengan `client_request_id` yang sama sudah pernah dibuat sebelum INSERT baru. Bandingkan dengan `rpc_process_transaction` yang benar-benar melakukan SELECT terlebih dahulu. Ada juga tidak ada UNIQUE constraint pada kolom `client_request_id` di schema.
- **Dampak:** Jika user menekan tombol "Buat Transfer" dua kali (double-click, atau submit ulang karena koneksi lambat), dua transfer terpisah akan dibuat dengan jumlah yang sama, menyebabkan saldo outlet berkurang dua kali.
- **Penyebab Kemungkinan:** Fitur ini lebih baru dan idempotency belum diimplementasi.
- **Rekomendasi Perbaikan:** Tambahkan idempotency check: `SELECT id FROM cash_branch_transfers WHERE client_request_id = ? LIMIT 1` sebelum INSERT. Jika sudah ada, kembalikan data yang lama tanpa INSERT baru. Tambahkan juga UNIQUE INDEX pada kolom `client_request_id`.
- **Prioritas:** Tinggi

---

## 3. Daftar Bug Prioritas Sedang

### Bug 9 — `void_at` Tersimpan dengan Waktu UTC, Bukan WITA

- **Kategori:** Integrasi / Timezone
- **Lokasi File:** `js/services/cashService.js` baris 117
- **Masalah:** Saat cash log di-void, timestamp dikirim sebagai:
  ```javascript
  void_at: new Date().toISOString()
  ```
  `toISOString()` menghasilkan format UTC seperti `2026-05-29T03:00:00.000Z`. Fungsi `normalizeSqlValue` di backend mengambil 19 karakter pertama `2026-05-29T03:00:00` lalu mengganti 'T' dengan spasi → `2026-05-29 03:00:00`. Ini adalah waktu UTC, padahal database menyimpan semua waktu dalam WITA (UTC+8).
- **Dampak:** Kolom `void_at` di database akan tercatat 8 jam lebih awal dari waktu sebenarnya. Misalnya void dilakukan pukul 14:00 WITA, tersimpan sebagai 06:00. Laporan riwayat void akan menampilkan jam yang salah.
- **Rekomendasi Perbaikan:** Ganti dengan: `void_at: new Date(Date.now() + (8 * 60 + new Date().getTimezoneOffset()) * 60000).toISOString().slice(0, 19).replace('T', ' ')` atau gunakan fungsi helper seperti yang sudah ada di `fmt.getBusinessDate()`.
- **Prioritas:** Sedang

---

### Bug 10 — URL Upload File Hardcoded di `upload.php`

- **Kategori:** Backend / Maintenance
- **Lokasi File:** `api/upload.php` baris 117
- **Masalah:** URL publik file yang diupload dikonstruksi dari nilai hardcoded:
  ```php
  $siteUrl = 'https://pos.rotibakarngeunah.my.id';
  ```
  Nilai ini tidak diambil dari `config.php`.
- **Dampak:** Jika domain website berubah di masa mendatang, semua URL file yang sudah tersimpan di database akan rusak (broken link). Harus mencari dan mengganti secara manual.
- **Rekomendasi Perbaikan:** Pindahkan konstanta `SITE_URL` ke `config.php` dan gunakan di `upload.php`.
- **Prioritas:** Sedang

---

### Bug 11 — Validasi Kelipatan Rp 50.000 pada Deposit Hanya di Frontend

- **Kategori:** Validasi / Keamanan
- **Lokasi File:** `js/depositService.js` baris 255, `api/api.php` fungsi `rpc_create_deposit`
- **Masalah:** Validasi `if (amount % 50000 !== 0) throw new Error(...)` ada di frontend, tapi backend `rpc_create_deposit` tidak memvalidasi hal yang sama. Siapapun yang mengakses API langsung (menggunakan API key yang terekspos) bisa membuat deposit dengan nominal sembarang.
- **Dampak:** Aturan bisnis mengenai kelipatan nominal setoran bisa di-bypass, menghasilkan data deposit yang tidak konsisten.
- **Rekomendasi Perbaikan:** Tambahkan validasi yang sama di backend: `if (fmod($amount, 50000) !== 0.0) throw new Exception('Nominal harus kelipatan Rp 50.000');`
- **Prioritas:** Sedang

---

### Bug 12 — Tabel `app_sessions` Tidak Pernah Dibersihkan untuk Semua User

- **Kategori:** Performa / Database
- **Lokasi File:** `api/api.php` baris 916
- **Masalah:** Expired sessions hanya dihapus untuk user yang sedang login:
  ```php
  $pdo->prepare("DELETE FROM app_sessions WHERE user_id = ? AND expires_at <= NOW()")->execute([$user['id']]);
  ```
  Sessions dari user yang sudah tidak aktif dan tidak pernah login lagi tidak pernah dihapus. Dengan session TTL 8 jam dan banyak user yang login berulang kali, tabel ini akan terus bertambah.
- **Dampak:** Query validasi session (`rbn_validate_session`) akan semakin lambat seiring waktu karena tabel semakin besar.
- **Rekomendasi Perbaikan:** Tambahkan cleanup global di awal setiap request atau gunakan cron job: `DELETE FROM app_sessions WHERE expires_at <= NOW()`. Tambahkan INDEX `idx_expires_at` pada kolom `expires_at`.
- **Prioritas:** Sedang

---

### Bug 13 — Inkonsistensi Nama Kolom `account_id` vs `deposit_account_id`

- **Kategori:** Integrasi / Database
- **Lokasi File:** `sql/cpanel_mysql_schema.sql` baris 374, `api/api.php` baris 1530, `js/depositService.js` baris 301
- **Masalah:** Schema MySQL mendefinisikan kolom bernama `account_id` (CHAR(36)) di tabel `cash_deposits`. Namun kode PHP mencoba nama `deposit_account_id` terlebih dahulu:
  ```php
  $accountCol = dbColumnExists($pdo, 'cash_deposits', 'deposit_account_id') ? 'deposit_account_id' : 'account_id';
  ```
  Sementara di `getAllDeposits` di `depositService.js`, select query menggunakan `account_id`. Jika tabel pernah punya kolom `deposit_account_id` (dari versi Supabase lama), ini bisa menyebabkan data tersimpan di kolom yang berbeda dari yang dibaca.
- **Dampak:** Data `account_id` mungkin tidak tersimpan atau tidak terbaca dengan benar, menyebabkan metode setoran tidak muncul di laporan.
- **Rekomendasi Perbaikan:** Standarisasikan ke satu nama kolom (`account_id`) di seluruh kode. Hapus logika `dbColumnExists` kondisional dan gunakan nama yang konsisten.
- **Prioritas:** Sedang

---

### Bug 14 — Tidak Ada Validasi Akses Branch pada Void dan Refund Transaksi

- **Kategori:** Keamanan / Backend
- **Lokasi File:** `api/api.php` fungsi `rpc_void_transaction` baris 2036 dan `rpc_refund_transaction` baris 2057
- **Masalah:** Kedua fungsi ini hanya menerima `p_transaction_id` dan `p_user_id`, tanpa memverifikasi bahwa user yang meminta void/refund memiliki akses ke branch dari transaksi tersebut. Jika staff outlet A mengetahui ID transaksi dari outlet B, mereka bisa void transaksi outlet B.
- **Dampak:** Staff dari satu outlet bisa memanipulasi data transaksi outlet lain.
- **Rekomendasi Perbaikan:** Setelah mengambil data transaksi, validasikan bahwa `p_user_id` memiliki `branch_id` yang sama dengan transaksi, atau role admin/owner.
- **Prioritas:** Sedang

---

### Bug 15 — Password Plaintext Masih Didukung di Sistem Login

- **Kategori:** Keamanan
- **Lokasi File:** `api/api.php` baris 907–912
- **Masalah:**
  ```php
  } else {
      $valid = $stored === $pass; // plain text legacy
  }
  ```
  Sistem masih mendukung password yang disimpan sebagai teks biasa (tidak terenkripsi) dengan alasan "legacy".
- **Dampak:** Jika database bocor atau bisa diakses pihak tidak berwenang, password semua user legacy langsung terbaca tanpa perlu decryption.
- **Rekomendasi Perbaikan:** Paksa migrasi: saat user dengan password plaintext login berhasil, langsung hash password-nya dengan bcrypt dan update di database. Hapus dukungan plaintext setelah semua user migrasi.
- **Prioritas:** Sedang

---

### Bug 16 — Tidak Ada Rate Limiting / Pembatasan Percobaan Login

- **Kategori:** Keamanan
- **Lokasi File:** `api/api.php` fungsi `rpc_pos_login`
- **Masalah:** Tidak ada pembatasan jumlah percobaan login yang gagal berturut-turut. Tidak ada delay, tidak ada lockout, tidak ada CAPTCHA.
- **Dampak:** Serangan brute force pada akun staff atau admin bisa dilakukan tanpa hambatan — ribuan percobaan per detik jika menggunakan script otomatis.
- **Rekomendasi Perbaikan:** Catat jumlah percobaan login gagal per username atau IP di database. Setelah 5 kali gagal, tambahkan delay eksponensial atau kunci sementara akun selama beberapa menit.
- **Prioritas:** Sedang

---

### Bug 17 — CORS Header Selalu Dikirim Meskipun Origin Tidak Diizinkan

- **Kategori:** Keamanan
- **Lokasi File:** `api/api.php` baris 31–32
- **Masalah:**
  ```php
  } else {
      header('Access-Control-Allow-Origin: ' . ALLOWED_ORIGINS[0]);
  }
  ```
  Jika origin request tidak ada di daftar yang diizinkan, server tetap mengirim header CORS (ke domain pertama dari daftar). Seharusnya jika origin tidak diizinkan, tidak perlu mengirim CORS header sama sekali — browser akan memblokir request secara otomatis.
- **Dampak:** Bisa menyebabkan kebingungan saat debugging. Secara teknis tidak membuka celah baru tapi bukan praktik terbaik.
- **Rekomendasi Perbaikan:** Jika origin tidak diizinkan, cukup tidak mengirim header `Access-Control-Allow-Origin` — browser akan otomatis menolak request lintas domain.
- **Prioritas:** Sedang

---

## 4. Daftar Bug Prioritas Rendah

### Bug 18 — Komentar PostgreSQL yang Sudah Tidak Relevan

- **Kategori:** Code Quality
- **Lokasi File:** `js/services/cashService.js` baris 3–12
- **Masalah:** Ada blok komentar tentang cara mengecek foreign key constraint name di PostgreSQL (`pg_constraint`, `pg_attribute`, dll). Sistem sudah pindah ke MySQL, informasi ini tidak relevan dan menyesatkan.
- **Rekomendasi Perbaikan:** Hapus komentar SQL PostgreSQL tersebut.
- **Prioritas:** Rendah

---

### Bug 19 — Fungsi `formatRupiah` dan `escHtml` Ada Dua Versi (Duplikat)

- **Kategori:** Code Quality
- **Lokasi File:** `js/utils/formatter.js` baris 9 (dalam objek `fmt`) dan baris 121 (sebagai `window.fRp`)
- **Masalah:** Implementasi yang sama ditulis dua kali — satu di dalam objek `fmt` dan satu lagi sebagai global `window.fRp` / `window.formatRupiah`. Keduanya identik.
- **Dampak:** Jika perlu mengubah logika format, harus diubah di dua tempat.
- **Rekomendasi Perbaikan:** Buat `window.fRp` langsung memanggil `fmt.rupiah` alih-alih menduplikasi implementasi.
- **Prioritas:** Rendah

---

### Bug 20 — Pesan Error Login Membocorkan Detail Infrastruktur

- **Kategori:** Keamanan Ringan
- **Lokasi File:** `js/auth.js` baris 71
- **Masalah:**
  ```javascript
  throw new Error('Fungsi login belum ada. Jalankan fix_login.sql di Supabase SQL Editor.');
  ```
  Pesan error ini muncul ke pengguna dan menyebut nama teknologi internal ("Supabase SQL Editor") yang sudah tidak digunakan.
- **Dampak:** Penyerang bisa mengetahui detail infrastruktur lama sistem dari pesan error.
- **Rekomendasi Perbaikan:** Ubah pesan error menjadi generik seperti "Terjadi kesalahan server. Hubungi admin."
- **Prioritas:** Rendah

---

### Bug 21 — `UNIQUE KEY uq_source` di `branch_cash_ledger` Bisa Menyebabkan Kegagalan Diam-Diam

- **Kategori:** Database / Data
- **Lokasi File:** `sql/cpanel_mysql_schema.sql` baris 480
- **Masalah:** Tabel `branch_cash_ledger` memiliki:
  ```sql
  UNIQUE KEY `uq_source` (`source_table`(50), `source_id`(100), `movement_type`(50))
  ```
  Jika ada bug atau retry yang menyebabkan INSERT ledger dengan kombinasi kunci yang sama, INSERT akan gagal dengan error constraint. Beberapa fungsi yang memanggil `rpcInsertBranchCashLedger` tidak secara eksplisit menangani error ini.
- **Dampak:** Ledger tidak tercatat tapi transaksi utama mungkin sudah berhasil, menyebabkan data tidak lengkap di riwayat kas.
- **Rekomendasi Perbaikan:** Gunakan `INSERT IGNORE` atau `ON DUPLICATE KEY UPDATE` untuk ledger, karena pencatatan ganda lebih baik dari tidak tercatat sama sekali — atau pastikan semua caller menangani error INSERT ledger.
- **Prioritas:** Rendah

---

### Bug 22 — Potensi Masalah di `getMyDeposits` saat `daysBack = 0`

- **Kategori:** Frontend / Logic
- **Lokasi File:** `js/depositService.js` baris 278–293
- **Masalah:** Saat `daysBack = 0`, kalkulasi `startDate` dan `endDate` menghasilkan tanggal yang sama, sehingga query hanya mengambil deposit hari ini saja. Ini mungkin sudah disengaja, tapi jika default `daysBack = 0` berarti "semua data", ini akan menghasilkan data yang terlalu sedikit.
- **Dampak:** User tidak melihat riwayat deposit lama jika `daysBack` tidak diisi dengan benar.
- **Rekomendasi Perbaikan:** Pastikan pemanggil selalu mengisi `daysBack` dengan nilai yang sesuai (misalnya 30 atau 90), atau ubah default menjadi nilai yang masuk akal.
- **Prioritas:** Rendah

---

## 5. Masalah Struktur Code

### 5.1 File JS Terlalu Besar

File-file JavaScript utama sangat besar dan sulit di-maintain:
- `js/admin.js` — **209 KB** (~8.000+ baris)
- `js/pos.js` — **170 KB** (~6.500+ baris)
- `js/depositUi.js` — **68 KB**
- `js/adminDepositUi.js` — **44 KB**

File sebesar ini sulit di-debug, sulit dikolaborasi, dan memperlambat proses review perubahan. Satu bug bisa tersembunyi di ratusan baris kode yang tidak terkait.

**Rekomendasi:** Pecah masing-masing file besar menjadi modul yang lebih kecil berdasarkan fitur atau halaman. Pertimbangkan menggunakan ES modules atau bundler seperti Vite/Rollup.

---

### 5.2 Logika Bisnis Tercampur di UI Files

Banyak logika bisnis (validasi, kalkulasi, format) tersebar di file-file UI seperti `adminDepositUi.js`, `adminBranchCashUi.js`, dll — bukan di service layer. Ini membuat logika yang sama berpotensi diimplementasi berbeda di halaman yang berbeda.

**Rekomendasi:** Pindahkan semua logika bisnis ke service layer (`js/services/` atau `js/*.Service.js`) dan buat UI hanya bertugas render dan handle event.

---

### 5.3 Fungsi `dbColumnExists()` Dipanggil Berulang di Setiap Request

Di `api.php`, fungsi `filterRowToExistingColumns()` memanggil `dbColumnExists()` untuk setiap kolom di setiap INSERT/UPDATE. Meskipun ada static cache dalam satu request, ini menambah overhead query INFORMATION_SCHEMA per kolom yang belum pernah dicek.

**Rekomendasi:** Cache schema tabel di awal request menggunakan `DESCRIBE table` sekali saja, lalu filter berdasarkan cache tersebut — lebih efisien dari banyak query individual.

---

### 5.4 Duplikasi Kode Format dan Escaping

Fungsi `fmt.rupiah()` dan `window.fRp()` melakukan hal yang sama persis. Begitu juga `fmt.html()` dan `window.escHtml()`. Dua implementasi paralel meningkatkan risiko inkonsistensi saat ada perubahan.

---

## 6. Masalah Flow User

### 6.1 Pesan Error Teknis Muncul ke User

Beberapa error backend diteruskan langsung ke UI dengan pesan teknis seperti:
- "Jalankan migrasi 041 lalu coba lagi"
- "Fitur kas admin perlu patch migrasi 029"

User kasir tidak paham apa arti "migrasi 029" dan tidak bisa melakukan apapun dengan informasi tersebut. Pesan error harus ditulis dalam bahasa yang bisa dipahami dan memberikan instruksi yang actionable.

---

### 6.2 Alur Setoran Tunai: Tidak Ada Feedback Visual yang Cukup

Proses setoran melibatkan banyak langkah (tutup shift → upload bukti → submit setoran → tunggu konfirmasi admin). Tidak ada progress indicator yang jelas, sehingga user mungkin tidak tahu di tahap mana mereka berada.

---

### 6.3 Tidak Ada Konfirmasi Sebelum Aksi Destruktif

Beberapa aksi seperti "void transaksi" atau "tolak transfer" tidak ada konfirmasi popup "Apakah Anda yakin?". User bisa tidak sengaja melakukan aksi yang tidak dapat dibatalkan.

---

## 7. Masalah Validasi Data

### 7.1 Validasi Hanya di Frontend untuk Beberapa Aturan Bisnis

| Aturan Bisnis | Frontend | Backend |
|---|---|---|
| Setoran harus kelipatan Rp 50.000 | ✅ Ada | ❌ Tidak ada |
| Jumlah setoran > 0 | ✅ Ada | ✅ Ada |
| Transfer tidak ke outlet sendiri | ✅ Ada | ✅ Ada |
| Password tidak boleh kosong | ✅ Ada | ✅ Ada |
| Alasan void minimal berisi teks | ✅ Ada | ✅ Ada |

### 7.2 `safeNum()` Tidak Validasi Angka Negatif

Fungsi `safeNum(x, label)` hanya memeriksa apakah nilai adalah angka valid, tapi tidak memvalidasi apakah angka tersebut positif. Pemanggil harus melakukan pengecekan tambahan sendiri, yang kadang terlewat.

### 7.3 Tidak Ada Validasi Panjang Teks di Backend

Field seperti `reason` (alasan void), `notes`, dan `name` tidak ada validasi panjang maksimum di backend PHP, hanya di frontend (validator.js). Teks yang sangat panjang bisa menyebabkan masalah tampilan atau overflow di database.

---

## 8. Masalah Keamanan

### 8.1 Ringkasan Masalah Keamanan (Diurutkan dari Paling Kritis)

| # | Masalah | Tingkat Risiko |
|---|---|---|
| 1 | API key hardcoded di JavaScript frontend | 🔴 Kritis |
| 2 | Password database di repository Git | 🔴 Kritis |
| 3 | `rpc_admin_set_branch_cash_balance` tanpa validasi role | 🔴 Kritis |
| 4 | Password plaintext masih didukung | 🟠 Tinggi |
| 5 | Tidak ada rate limiting login | 🟠 Tinggi |
| 6 | Void/refund tidak memvalidasi akses branch | 🟠 Tinggi |
| 7 | Validasi bisnis hanya di frontend | 🟡 Sedang |
| 8 | Pesan error membocorkan detail teknis | 🟢 Rendah |

### 8.2 Catatan Tambahan

- Sistem menggunakan PDO prepared statements secara konsisten — **SQL injection sudah dicegah dengan baik**
- Autentikasi session (app_sessions) sudah menggunakan hash SHA-256 token — **cukup baik**
- Upload file sudah memvalidasi MIME type dari konten file (bukan hanya ekstensi) — **bagus**
- Row-level locking (`FOR UPDATE`) digunakan untuk operasi saldo kritis — **bagus**

---

## 9. Masalah Performa

### 9.1 Query Berat di `rpc_get_admin_branch_cash_positions`

Fungsi ini (`api/api.php` baris 1327) menjalankan query dengan banyak correlated subquery (subquery yang dieksekusi per baris):
- Subquery untuk mendapatkan open session per branch
- Subquery untuk mendapatkan last closed session per branch
- Subquery untuk menghitung estimated running cash per branch
- Subquery untuk menghitung pending deposit amount per branch

Jika ada 10+ outlet, ini bisa menjadi sangat lambat karena MySQL harus menjalankan 3–4 subquery untuk setiap baris di tabel `branches`.

**Rekomendasi:** Refactor menggunakan JOIN atau CTE, atau tambahkan INDEX yang tepat. Pertimbangkan caching hasil query ini untuk beberapa detik.

---

### 9.2 `filterRowToExistingColumns` Query INFORMATION_SCHEMA Berulang

Setiap INSERT atau UPDATE memanggil `filterRowToExistingColumns` yang memanggil `dbColumnExists` (query ke INFORMATION_SCHEMA) untuk setiap kolom. Meskipun ada static cache per request, dalam satu request yang menginsert banyak baris, ini bisa memperlambat performa.

---

### 9.3 `cashService.getSummary()` Melakukan 3–4 API Calls Berurutan

Fungsi ini memanggil:
1. Query `cash_logs`
2. `getCashTransactionSummary` → query `transactions`
3. Query `cashier_sessions`
4. Query `cash_deposits`

Semuanya berurutan (sequential), padahal beberapa bisa diparalelkan. Ini memperlambat loading halaman dashboard kas.

**Rekomendasi:** Gunakan `Promise.all()` untuk query yang tidak saling bergantung.

---

### 9.4 Data Setoran Tidak Ada Filter Tanggal Default

`getAllDeposits` di `depositService.js` tanpa filter `dateFrom`/`dateTo` akan mengambil semua data setoran (dibatasi `limit = 100`). Tapi jika admin melihat data tanpa filter, 100 data terbaru mungkin mencakup banyak bulan. Tidak ada paginasi yang jelas untuk data melebihi 100.

---

## 10. Rekomendasi Perbaikan Bertahap

### Tahap 1 — Perbaikan Kritis (Segera)

* **Bug 4:** Tambahkan `beginTransaction()` / `commit()` / `rollBack()` ke fungsi `rpc_void_transaction`
* **Bug 5:** Tambahkan validasi role di `rpc_admin_set_branch_cash_balance`
* **Bug 6:** Tambahkan `'cash_session_adjustments'` ke whitelist tabel, atau hapus kode yang merujuk tabel tersebut
* **Bug 8:** Tambahkan idempotency check (`SELECT` sebelum `INSERT`) di `rpc_create_cash_branch_transfer`
* **Bug 3:** Standarisasi nilai status 'voided' di seluruh kode (ubah default di `transactionService.js`)

### Tahap 2 — Perbaikan Keamanan

* **Bug 1 & 2:** Pindahkan API key dan password database ke environment variables / file `.env` yang tidak ada di Git. Rotasi credential yang sudah terekspos.
* **Bug 15:** Paksa migrasi password plaintext ke bcrypt saat user login berikutnya
* **Bug 16:** Implementasi rate limiting sederhana untuk endpoint login (misalnya 5 percobaan gagal → lockout 5 menit)
* **Bug 14:** Tambahkan validasi akses branch di `rpc_void_transaction` dan `rpc_refund_transaction`

### Tahap 3 — Perbaikan Validasi dan Data

* **Bug 9:** Perbaiki `void_at` agar menggunakan waktu WITA, bukan UTC
* **Bug 11:** Tambahkan validasi kelipatan Rp 50.000 di backend `rpc_create_deposit`
* **Bug 13:** Standarisasi nama kolom `account_id` vs `deposit_account_id`
* **Bug 7:** Tambahkan penanganan yang benar saat saldo outlet tidak mencukupi untuk konfirmasi deposit
* **Bug 12:** Tambahkan cleanup `app_sessions` expired secara global

### Tahap 4 — Perbaikan URL dan Konfigurasi

* **Bug 10:** Pindahkan `$siteUrl` di `upload.php` ke `config.php` sebagai konstanta `SITE_URL`
* **Bug 17:** Perbaiki CORS header agar tidak mengirim header ke origin yang tidak diizinkan
* **Bug 20:** Hapus pesan error yang menyebut detail teknis internal

### Tahap 5 — Optimasi dan Code Quality

* **Bug 18, 19:** Bersihkan komentar PostgreSQL yang tidak relevan dan hapus duplikasi fungsi format
* **Section 5.1:** Mulai pecah `admin.js` dan `pos.js` menjadi modul yang lebih kecil
* **Section 9.1:** Refactor query berat di `rpc_get_admin_branch_cash_positions` menggunakan JOIN
* **Section 9.3:** Paralelkan API calls di `cashService.getSummary()` menggunakan `Promise.all()`
* **Bug 21:** Ubah INSERT ledger menggunakan `INSERT IGNORE` atau penanganan duplikat yang lebih baik

---

## 11. Kesimpulan

Sistem RBN POS **sudah bisa digunakan untuk operasional harian** karena fitur-fitur inti (transaksi POS, manajemen kas, setoran) berjalan dengan cukup baik dan logika bisnis utama sudah diproteksi dengan database transaction yang benar.

Namun, sistem **perlu perbaikan keamanan sebelum dianggap aman dari risiko penyalahgunaan**, terutama:
1. **API key yang terekspos di frontend** membuat semua endpoint API bisa diakses tanpa otentikasi yang sesungguhnya
2. **Credential sensitif di repository Git** membuka risiko kebocoran data
3. **Satu fungsi RPC tanpa validasi role** memungkinkan manipulasi saldo kas

Untuk data integrity, **Bug 4 (void_transaction tidak atomic)** adalah yang paling berbahaya dan harus diperbaiki segera karena bisa menyebabkan ketidaksesuaian data kas yang sulit direkonsiliasi.

**Estimasi pekerjaan perbaikan:**
- Tahap 1 (Kritis): ~1–2 hari kerja
- Tahap 2 (Keamanan): ~2–3 hari kerja
- Tahap 3–4 (Data/Config): ~2–3 hari kerja
- Tahap 5 (Optimasi): ~3–5 hari kerja (opsional, bisa dilakukan bertahap)

Setelah Tahap 1 dan 2 selesai, sistem sudah jauh lebih aman dan stabil untuk digunakan di production dengan jumlah transaksi harian yang wajar.
