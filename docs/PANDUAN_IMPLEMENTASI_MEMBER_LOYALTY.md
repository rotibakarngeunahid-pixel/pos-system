# Panduan Implementasi Sistem Member & Loyalty Point
## Roti Bakar Ngeunah POS
**Untuk: Owner / Pengelola (Non-Programmer)**
**Estimasi waktu: 30–45 menit**

---

## Sebelum Mulai — Baca Ini Dulu

> **PENTING:** Lakukan semua langkah ini di luar jam operasional (malam atau pagi sebelum buka). Backup database wajib dilakukan sebelum langkah apapun.

Kamu butuh akses ke:
- **cPanel hosting** (login ke cpanel.namadomain.com atau panel hosting-mu)
- **File Manager** atau **FTP** (untuk upload file)
- **phpMyAdmin** (untuk jalankan SQL)
- **Akun Admin** di aplikasi POS

---

## LANGKAH 1 — Backup Database (WAJIB)

> Ini seperti "foto dulu sebelum renovasi". Kalau ada masalah, bisa balik ke kondisi semula.

1. Login ke **cPanel** hosting kamu
2. Klik **phpMyAdmin**
3. Di panel kiri, klik nama database kamu (biasanya nama seperti `user_rbn` atau sejenisnya)
4. Klik tab **Export** di bagian atas
5. Pilih format: **SQL**
6. Klik tombol **Export** / **Go**
7. File `.sql` akan terdownload ke komputer kamu
8. **Simpan file ini di tempat aman** — ini backup-mu

✅ **Tanda berhasil:** Ada file `.sql` terdownload ke komputer kamu

---

## LANGKAH 2 — Jalankan Migrasi Database

> Ini menambahkan "tabel-tabel baru" di database untuk menyimpan data member, point, reward, dll.

1. Masih di **phpMyAdmin**
2. Pastikan database kamu sudah dipilih di panel kiri
3. Klik tab **SQL** di bagian atas
4. Buka file `sql/migrations/064_member_loyalty_schema.sql` dari folder project kamu
5. Buka file itu dengan **Notepad** (klik kanan → Open with → Notepad)
6. **Pilih semua teks** (Ctrl+A) lalu **Copy** (Ctrl+C)
7. Kembali ke phpMyAdmin, **Paste** (Ctrl+V) ke kotak SQL yang terbuka
8. Klik tombol **Go** / **Execute**
9. Tunggu sampai muncul pesan hijau "SQL query executed successfully"

✅ **Tanda berhasil:** Muncul pesan hijau. Di panel kiri (daftar tabel), sekarang ada tabel-tabel baru:
- `members`
- `member_sessions`
- `member_point_ledger`
- `member_rewards`
- `member_reward_claims`
- `member_fraud_flags`
- `member_settings`

> ⚠️ **Kalau muncul pesan merah (error):** Jangan panik. Screenshot pesannya, hubungi tim teknis. Sistem POS lama tidak terpengaruh karena semua tambahan ini aman.

---

## LANGKAH 3 — Upload File Baru ke Hosting

> Ini mengirim "file-file program baru" ke server hosting.

### Cara upload via File Manager cPanel:

1. Buka **cPanel** → klik **File Manager**
2. Navigasi ke folder project POS kamu (biasanya `public_html` atau `public_html/pos` atau sesuai subdomain)
3. Upload file-file berikut (ada di folder project di komputermu):

#### 3a. File BARU (belum ada di server):

| File di Komputer | Upload ke Folder di Server |
|---|---|
| `member.html` | Folder utama POS (sama dengan `pos.html`) |
| `js/member.js` | Folder `js/` |
| `js/memberUi.js` | Folder `js/` |
| `js/adminMemberUi.js` | Folder `js/` |
| `sql/migrations/064_member_loyalty_schema.sql` | Folder `sql/migrations/` |

**Cara upload:**
- Di File Manager, masuk ke folder yang tepat
- Klik tombol **Upload** di toolbar atas
- Pilih file dari komputer kamu
- Tunggu sampai selesai (progress bar penuh)
- Klik **Go Back to...**

#### 3b. File LAMA yang diperbarui (ganti yang lama):

| File | Folder |
|---|---|
| `api/api.php` | Folder `api/` |
| `pos.html` | Folder utama |
| `admin.html` | Folder utama |
| `js/pos.js` | Folder `js/` |
| `js/admin.js` | Folder `js/` |
| `js/services/transactionService.js` | Folder `js/services/` |

**Cara mengganti file lama:**
- Navigasi ke folder yang tepat di File Manager
- Klik **Upload**
- Pilih file baru dari komputer
- Kalau ada konfirmasi "overwrite existing file?" → klik **Yes / Overwrite**

✅ **Tanda berhasil:** Semua file berhasil diupload tanpa error merah

---

## LANGKAH 4 — Aktifkan Modul Member (Opsional dulu)

> Modul member secara default **NONAKTIF** (aman — POS lama tidak berubah). Kamu bisa aktifkan nanti setelah yakin semua berjalan. Langkah ini untuk **testing** dulu.

1. Buka aplikasi **Admin POS** di browser
2. Login dengan akun admin/owner
3. Di menu kiri, cari dan klik **"Member Loyalty"**
4. Klik sub-tab **"Aturan Point"**
5. Cari baris **"Modul Loyalty"** — ada toggle/checkbox di sana
6. Centang/aktifkan togglenya
7. Klik **"Simpan Semua"**

✅ **Tanda berhasil:** Toggle berubah jadi hijau / AKTIF

---

## LANGKAH 5 — Test Dasar (Cek Semua Berjalan)

> Sebelum kasir pakai, pastikan semuanya bekerja dengan benar.

### Test 1: Daftar Member Baru

1. Buka browser, ketik alamat: `namadomain.com/member.html` (sesuaikan dengan domain POS kamu)
2. Kamu akan lihat halaman dengan logo RBN dan form login member
3. Klik **"Daftar sekarang"**
4. Isi form:
   - Nama: `Test Member`
   - Nomor HP: `081234567890` (nomor test)
   - Password: `test123`
   - Konfirmasi Password: `test123`
   - Centang "Saya setuju..."
5. Klik **"Daftar Sekarang"**

✅ **Tanda berhasil:** Masuk ke halaman dashboard member, ada QR code dan kode member seperti `RBN-2606-XXXXX`

---

### Test 2: Cek di Admin

1. Buka **Admin POS** → klik **"Member Loyalty"**
2. Klik sub-tab **"Kelola Member"**
3. Cari nama "Test Member" di tabel

✅ **Tanda berhasil:** Member "Test Member" muncul di daftar

---

### Test 3: Cek Panel Kasir

1. Buka aplikasi **POS (Kasir)** seperti biasa
2. Tambahkan produk ke keranjang
3. Klik tombol **Keranjang**
4. Di halaman checkout, kamu akan lihat bagian baru **"Tanpa Member"** dengan tombol **"Cari Member"**

✅ **Tanda berhasil:** Muncul panel member di halaman checkout

---

### Test 4: Transaksi dengan Member

1. Dari halaman checkout POS, klik **"Cari Member"**
2. Ketik nomor HP test tadi: `081234567890`
3. Klik **"Cari"** → akan muncul nama "Test Member"
4. Klik **"Pilih"**
5. Panel berubah: muncul nama "Test Member" dan kode membernya
6. Lanjutkan proses bayar seperti biasa
7. Setelah bayar, cek di member app — point seharusnya bertambah (setelah jeda beberapa jam)

✅ **Tanda berhasil:** Transaksi berhasil dan di halaman member ada histori transaksi baru

---

## LANGKAH 6 — Setting Aturan Point (Sesuaikan dengan Bisnis)

> Ini bagian paling penting untuk disesuaikan sebelum go-live.

1. Admin POS → **Member Loyalty** → **Aturan Point**
2. Atur sesuai kebutuhan bisnis:

| Pengaturan | Default | Penjelasan |
|---|---|---|
| **Rasio: Rp per 1 Point** | 10.000 | Artinya: setiap belanja Rp10.000 = 1 point |
| **Maksimum Point per Transaksi** | 1.000 | Batas maksimal point sekali transaksi |
| **Masa Berlaku Point (hari)** | 365 | Point hangus setelah 1 tahun, 0 = tidak hangus |
| **Jam Pending Point** | 24 | Point baru "aktif" setelah 24 jam (anti-refund fraud) |
| **Maks Point per Member per Hari** | 50 | Anti-kecurangan: max point yang bisa dikumpulkan per hari |

3. Klik **"Simpan Semua"** setelah selesai

---

## LANGKAH 7 — Buat Reward Pertama

> Reward adalah hadiah yang bisa ditukar member dengan point-nya.

1. Admin POS → **Member Loyalty** → **Kelola Reward**
2. Klik **"Buat Reward Baru"**
3. Isi form:
   - **Nama Reward**: `Roti Bakar Coklat Gratis`
   - **Tipe Reward**: Pilih `Produk Gratis`
   - **Cost (point)**: `50` (artinya butuh 50 point untuk klaim)
   - **Kuota Total**: kosongkan (tidak terbatas) atau isi angka tertentu
   - Centang **"Aktif"**
4. Klik **"Simpan Reward"**

✅ **Tanda berhasil:** Reward muncul di daftar dengan status "Aktif"

---

## LANGKAH 8 — Umumkan ke Pelanggan

Setelah semua test berjalan baik, kamu siap go-live!

### Yang perlu diberitahu ke kasir:
- Tanya pelanggan: *"Sudah jadi member RBN?"*
- Kalau sudah: klik "Cari Member" → masukkan nomor HP pelanggan
- Kalau belum: kasir bisa daftar-kan langsung (klik "Cari Member" → "Tambah Member Baru")
- Point otomatis masuk setelah transaksi selesai

### Yang perlu diberitahu ke pelanggan:
- Bisa daftar member di: `namadomain.com/member.html`
- Login pakai nomor HP dan password yang dibuat saat daftar
- Bisa lihat QR code, total point, dan daftar reward

---

## Kalau Ada Masalah

### Masalah umum & solusi:

| Masalah | Kemungkinan Penyebab | Solusi |
|---|---|---|
| Langkah 2 error "Table already exists" | Migrasi sudah pernah dijalankan | Ini normal, abaikan saja (berarti sudah pernah dibuat) |
| Panel member tidak muncul di kasir | Modul belum diaktifkan | Cek Langkah 4 — aktifkan toggle modul |
| Point tidak bertambah setelah transaksi | Modul nonaktif atau nominal transaksi di bawah minimum | Cek pengaturan di Aturan Point |
| Halaman member.html tidak bisa dibuka | File belum diupload atau salah folder | Ulangi Langkah 3 |
| Login admin tidak bisa akses tab Member | File `adminMemberUi.js` belum diupload | Upload ulang file tersebut |

### Cara rollback (balik ke kondisi sebelumnya):
Kalau ada masalah serius dan ingin kembali ke versi sebelum member loyalty:

1. Di **Admin POS → Member Loyalty → Aturan Point**: **matikan modul loyalty** (toggle jadi merah/NONAKTIF)
2. Panel member langsung hilang dari kasir
3. POS berjalan normal seperti sebelumnya
4. Data tetap aman, tidak ada yang terhapus

---

## Checklist Final Sebelum Go-Live

Centang semua sebelum umumkan ke pelanggan:

- [ ] Backup database sudah dilakukan dan disimpan
- [ ] SQL migrasi berhasil (tabel-tabel baru muncul di phpMyAdmin)
- [ ] Semua file berhasil diupload
- [ ] Halaman `member.html` bisa dibuka di browser
- [ ] Bisa daftar member baru dari `member.html`
- [ ] Panel "Cari Member" muncul di halaman checkout kasir
- [ ] Transaksi dengan member berhasil (cek histori di app member)
- [ ] Tab "Member Loyalty" muncul dan bisa diakses di admin
- [ ] Minimal 1 reward sudah dibuat
- [ ] Aturan point sudah disesuaikan (rasio point, masa berlaku)
- [ ] Modul loyalty sudah diaktifkan

---

## Kontak Bantuan

Kalau ada masalah teknis yang tidak bisa diselesaikan sendiri, siapkan informasi berikut sebelum menghubungi tim teknis:
- Screenshot error yang muncul
- Di langkah mana masalah terjadi
- Pesan error lengkap (kalau ada)

---

*Panduan ini dibuat untuk implementasi Fase 1 MVP sistem Member & Loyalty Point RBN POS.*
*Tanggal: 2026-06-04*
