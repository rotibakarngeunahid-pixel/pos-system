# PANDUAN MIGRASI DATABASE — Supabase ke cPanel MySQL

**Roti Bakar Ngeunah POS**  
Dibuat: 28 Mei 2026

---

## Gambaran Singkat

Yang berubah hanya 3 hal:
1. Database pindah dari Supabase ke MySQL di cPanel Anda
2. File PHP API diupload ke hosting (pengganti PostgREST Supabase)
3. Kode JavaScript di-update (sudah selesai, tidak perlu diubah lagi)

**Semua data lama (transaksi, produk, pengguna, dll) ikut dipindahkan** menggunakan script migrasi otomatis.

Frontend tetap di Vercel — tidak perlu diubah sama sekali.

---

## LANGKAH 1 — Buat Database di cPanel

1. Login ke cPanel hosting Anda
2. Klik **MySQL Databases**
3. Di bagian *Create New Database*, ketik nama database (contoh: `rotibaka_pos`) → klik **Create Database**
4. Di bagian *Create New User*, buat username dan password yang kuat → klik **Create User**
5. Di bagian *Add User To Database*, pilih user dan database tadi → klik **Add** → centang **All Privileges** → **Make Changes**

Catat ketiga nilai ini, dibutuhkan di Langkah 3:
- Nama database: `nama_cpanel_nama_database` (cPanel biasanya prefix dengan username cPanel)
- Username database
- Password database

---

## LANGKAH 2 — Import Schema (Buat Tabel)

1. Di cPanel, klik **phpMyAdmin**
2. Klik nama database Anda di panel kiri
3. Klik tab **Import** di bagian atas
4. Klik **Choose File** → pilih file: `sql/cpanel_mysql_schema.sql`
5. Pastikan *Format* sudah terpilih **SQL**
6. Klik **Go** / **Import**

Tunggu sampai muncul pesan hijau: *"Import has been successfully finished"*

Jika muncul error "table already exists" — abaikan, itu normal jika dijalankan ulang.

---

## LANGKAH 3 — Konfigurasi File PHP

Buka file: `hosting/api/config.php`

Ganti bagian ini dengan data asli database Anda:

```php
define('DB_HOST', 'localhost');
define('DB_NAME', 'nama_database_anda');   // ← ganti
define('DB_USER', 'user_database_anda');   // ← ganti
define('DB_PASS', 'password_database');    // ← ganti
```

Juga buat **API Key** rahasia (kombinasi huruf dan angka acak panjang, minimal 32 karakter):

```php
define('API_SECRET_KEY', 'ganti_dengan_kunci_rahasia_acak_panjang'); // ← ganti
```

Contoh API Key yang bagus: `rbn2026xK9mPqL3vWnHjRtYcBfDsAeUo`

**PENTING:** Nilai `API_SECRET_KEY` di `config.php` harus **sama persis** dengan `API_KEY` di `js/supabaseClient.js`

Jadi juga buka `js/supabaseClient.js` dan ganti:
```javascript
const API_KEY = 'ganti_dengan_kunci_rahasia_acak_panjang'; // ← ganti sama persis
```

---

## LANGKAH 4 — Upload File PHP ke Hosting

Di cPanel File Manager (atau via FTP):

1. Masuk ke folder `public_html` (atau folder utama website Anda)
2. Buat folder baru bernama `api`
3. Upload **kedua** file ini ke dalam folder `api/`:
   - `hosting/api/config.php`
   - `hosting/api/api.php`

Hasil struktur di hosting:
```
public_html/
├── api/
│   ├── config.php
│   └── api.php
├── index.html      (frontend dari Vercel — tidak perlu diupload)
└── ...
```

> **Catatan:** Jika domain API berbeda dari frontend (misalnya `rotibakarngeunah.my.id/api/`), pastikan sudah sesuai dengan nilai `API_BASE` di `js/supabaseClient.js`.

---

## LANGKAH 5 — Ambil service_role Key dari Supabase

Script migrasi otomatis butuh akses penuh ke database Supabase. Untuk itu diperlukan **service_role key** (bukan anon key).

1. Login ke [Supabase Dashboard](https://supabase.com)
2. Pilih project Anda
3. Klik **Settings** (ikon gear di kiri bawah)
4. Klik **API**
5. Di bagian **Project API keys**, salin nilai **service_role** (klik "Reveal" lalu copy)

> ⚠️ **Jangan bagikan service_role key ke siapapun.** Key ini punya akses penuh ke semua data.

---

## LANGKAH 6 — Konfigurasi & Upload Script Migrasi

1. Buka file: `hosting/api/migrate_from_supabase.php`
2. Isi bagian konfigurasi di atas file:

```php
$SUPABASE_URL  = 'https://XXXXXXXXXXXX.supabase.co'; // ← URL project Supabase Anda
$SUPABASE_KEY  = 'eyJXXXXXXXXXXX...';                // ← service_role key tadi
$MYSQL_HOST    = 'localhost';
$MYSQL_DB      = 'nama_database';                    // ← sama seperti config.php
$MYSQL_USER    = 'user_database';
$MYSQL_PASS    = 'password_database';
$MIGRATION_KEY = 'kunci_migrasi_rahasia_2026';       // ← ganti dengan string acak
```

3. Simpan filenya
4. Upload file ini ke hosting, ke folder `public_html/api/` (sama dengan `api.php`)

---

## LANGKAH 7 — Jalankan Migrasi Data

1. Buka browser, akses URL berikut (ganti `kunci_migrasi_rahasia_2026` dengan nilai yang Anda set):

```
https://rotibakarngeunah.my.id/api/migrate_from_supabase.php?key=kunci_migrasi_rahasia_2026
```

2. Tunggu sampai selesai — halaman akan menampilkan progress per tabel:
   - ✅ Hijau = berhasil
   - ⚠️ Kuning = tabel kosong atau dilewati
   - ❌ Merah = error

3. Proses ini mungkin memakan waktu 1–5 menit tergantung jumlah data

4. **Setelah selesai, HAPUS file `migrate_from_supabase.php` dari hosting!** File ini berbahaya jika dibiarkan.

Script ini secara otomatis menangani:
- Semua tabel (branches, users, produk, transaksi, stok, dll) — ~35 tabel
- Urutan insert yang benar (foreign key tidak akan error)
- Konversi tipe data PostgreSQL → MySQL
- Data duplikat dilewati otomatis (aman jika dijalankan ulang)

---

## LANGKAH 8 — Update Frontend di Vercel

Frontend sudah diupdate di source code lokal Anda. Yang perlu dilakukan:

1. Pastikan perubahan sudah di-commit ke Git
2. Push ke GitHub (Vercel akan otomatis redeploy)
3. Atau jika pakai Vercel CLI: `vercel --prod`

File yang berubah di frontend:
- `js/supabaseClient.js` — sekarang mengarah ke PHP API Anda
- `index.html`, `pos.html`, `admin.html`, `investor.html` — Supabase CDN sudah dihapus

---

## LANGKAH 9 — Tes Koneksi

1. Buka website Anda: `https://rotibakarngeunah.my.id`
2. Halaman login akan otomatis tes koneksi ke database
3. Jika muncul tanda ✅ hijau → koneksi berhasil
4. Jika muncul ❌ merah → lihat pesan errornya:

| Pesan Error | Penyebab | Solusi |
|---|---|---|
| API Key ditolak | API_KEY tidak cocok | Samakan nilai di `config.php` dan `supabaseClient.js` |
| Tabel belum dibuat | Schema belum diimport | Ulangi Langkah 2 |
| Tidak bisa terhubung | File PHP belum diupload | Ulangi Langkah 4 |
| 500 Internal Server Error | Error di PHP | Buka `api.php`, cek di baris paling atas ada `error_reporting(E_ALL)` sementara |

---

## LANGKAH 10 — Coba Login

1. Buat user admin pertama langsung via phpMyAdmin:

```sql
INSERT INTO users (name, email, password_hash, role, branch_id, is_active)
VALUES (
  'Admin',
  'admin@rotibakarngeunah.my.id',
  '$2y$10$92IXUNpkjO0rOQ5byMi.Ye4oKoEa3Ro9llC/.og/at2.usfutJ6om',  -- password: "password"
  'admin',
  NULL,
  1
);
```

2. Login dengan email `admin@rotibakarngeunah.my.id` dan password `password`
3. Segera ganti password dari menu admin setelah berhasil login

---

## Ringkasan File yang Diubah

| File | Status | Keterangan |
|---|---|---|
| `sql/cpanel_mysql_schema.sql` | ✅ Baru dibuat | Schema MySQL lengkap, import ke phpMyAdmin |
| `hosting/api/config.php` | ✅ Baru dibuat | **Edit dulu** isi database dan API key, lalu upload |
| `hosting/api/api.php` | ✅ Baru dibuat | Upload ke hosting tanpa diubah |
| `hosting/api/migrate_from_supabase.php` | ✅ Baru dibuat | **Edit konfigurasi**, upload, jalankan SEKALI, lalu **HAPUS** |
| `js/supabaseClient.js` | ✅ Sudah diubah | Ganti nilai API_KEY saja |
| `index.html` | ✅ Sudah diubah | CDN Supabase dihapus |
| `pos.html` | ✅ Sudah diubah | CDN Supabase dihapus |
| `admin.html` | ✅ Sudah diubah | CDN Supabase dihapus |
| `investor.html` | ✅ Sudah diubah | CDN Supabase dihapus |

---

## Troubleshooting Umum

**Q: Muncul "CORS error" di browser**  
A: Buka `config.php`, pastikan `ALLOWED_ORIGINS` berisi domain frontend Anda (`https://rotibakarngeunah.my.id`).

**Q: Login gagal padahal password benar**  
A: Password di Supabase disimpan dalam format bcrypt. PHP bisa verifikasi bcrypt secara langsung — tidak perlu diubah. Tapi jika password lama disimpan plain text, API juga mendukungnya.

**Q: Data transaksi lama hilang**  
A: Data lama di Supabase tidak otomatis pindah — perlu diexport manual (Langkah 5-6). Data baru akan tersimpan di MySQL.

**Q: Upload file bukti setoran tidak bisa**  
A: File `hosting/bukti-setoran/upload.php` sudah ada sebelumnya dan tidak diubah. Pastikan folder `bukti-setoran` sudah ada di hosting dan permission-nya 755.
