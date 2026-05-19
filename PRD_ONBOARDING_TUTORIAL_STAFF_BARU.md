# PRD Fitur Onboarding Tutorial Staff Baru

Tanggal: 2026-05-16  
Produk: Roti Bakar Ngeunah POS  
Area: Admin - Staff, POS Staff, Training / Onboarding  
Status: Draft PRD

## 1. Ringkasan

Fitur Onboarding Tutorial Staff Baru adalah sistem pelatihan otomatis untuk akun staff yang baru dibuat. Setelah admin membuat akun dengan role `staff`, sistem otomatis membuat assignment pelatihan untuk akun tersebut. Saat staff baru login ke POS, aplikasi menampilkan guide tour / onboarding guide yang mengajarkan workflow utama aplikasi, seperti membuka shift, memilih produk, melakukan penjualan, memahami pengurangan stok otomatis, melihat stok, melakukan penyesuaian stok, menutup shift, dan setoran tunai.

Fitur ini wajib hanya berlaku untuk akun baru dengan role `staff`. Akun admin, investor, staff lama, akun yang diedit, dan staff yang sudah pernah menyelesaikan onboarding tidak boleh mendapat onboarding baru secara otomatis.

Target utama PRD ini adalah membuat spesifikasi implementasi yang idempotent, aman dari duplikasi data, tidak mengganggu transaksi POS, dan tetap berjalan stabil walaupun koneksi atau data onboarding bermasalah.

## 2. Tujuan

1. Setiap akun staff baru otomatis memiliki pelatihan penggunaan aplikasi.
2. Staff baru langsung memahami alur kerja POS sebelum atau saat mulai memakai aplikasi.
3. Pelatihan mencakup penjualan, pengurangan stok otomatis, manajemen stok dasar, shift kasir, riwayat transaksi, kas, dan setoran tunai.
4. Onboarding hanya dibuat sekali untuk akun baru role `staff`.
5. Onboarding tidak dibuat untuk admin, investor, staff lama, atau akun yang hanya diedit.
6. Progress pelatihan tersimpan sehingga staff dapat melanjutkan dari step terakhir.
7. Sistem tetap aman jika staff refresh halaman, logout, login ulang, pindah device, atau koneksi terputus.
8. Tutorial tidak boleh membuat transaksi, stok, kas, atau data bisnis palsu kecuali user benar-benar menjalankan aksi live yang valid.
9. Jika modul onboarding error, POS tetap bisa dipakai dan error ditampilkan secara terkendali.

## 3. Kondisi Sistem Saat Ini

### 3.1 Struktur Aplikasi

- Aplikasi adalah web statis berbasis HTML, CSS, dan JavaScript.
- Database dan RPC menggunakan Supabase.
- Admin UI berada di `admin.html` dan dikendalikan oleh `js/admin.js`.
- POS staff berada di `pos.html` dan dikendalikan oleh `js/pos.js`.
- Login dan session dikelola oleh `js/auth.js`.
- Role yang relevan:
  - `admin` diarahkan ke `admin.html`.
  - `staff` diarahkan ke `pos.html`.
  - `investor` diarahkan ke `investor.html`.

### 3.2 Pembuatan Staff Saat Ini

- Admin membuat akun dari menu Manajemen Staff.
- Function utama berada di `js/admin.js`:
  - `openStaffModal()`
  - `saveStaff()`
  - `loadStaff()`
  - `deleteStaff()`
- Data user disimpan di tabel `users`.
- Field yang sudah digunakan:
  - `id`
  - `name`
  - `password`
  - `role`
  - `branch_id`
  - `is_active`
  - `deleted_at`

### 3.3 Alur POS Staff Saat Ini

- `js/pos.js` melakukan `auth.requireRole('staff')`.
- Staff yang memiliki `branch_id` langsung memakai cabang tersebut.
- Staff tanpa `branch_id` diminta memilih cabang.
- Jika belum ada shift terbuka, POS membuka modal shift.
- Produk POS dimuat dari `branch_products` dan harga cabang dari `branch_variant_prices`.
- Pengurangan stok terjadi melalui resep / BOM saat transaksi berhasil.
- Staff dapat menggunakan fitur:
  - kasir / penjualan,
  - keranjang,
  - diskon,
  - pembayaran,
  - cetak struk,
  - riwayat transaksi,
  - void / refund sesuai fitur yang ada,
  - ringkasan stok,
  - penyesuaian stok,
  - transfer stok,
  - kas masuk / kas keluar,
  - buka dan tutup shift,
  - setoran tunai.

## 4. Problem Statement

Staff baru sering belum memahami alur aplikasi. Tanpa panduan, risiko operasional meningkat:

- staff bingung setelah login pertama,
- staff tidak tahu harus membuka shift,
- staff tidak tahu cara memilih produk, varian, topping, qty, diskon, dan pembayaran,
- staff tidak memahami bahwa stok bahan bisa berkurang otomatis setelah transaksi,
- staff tidak tahu cara cek stok atau mencatat stok keluar / opname,
- staff salah memakai fitur kas atau setoran,
- admin harus melatih manual berulang untuk setiap staff baru.

Dibutuhkan onboarding otomatis yang muncul hanya untuk staff baru, tersimpan progress-nya, dan tidak menimbulkan bug pada alur transaksi live.

## 5. Scope

### 5.1 In Scope

- Membuat assignment onboarding otomatis untuk user baru dengan role `staff`.
- Menampilkan onboarding guide di `pos.html` untuk staff baru.
- Menyimpan status assignment dan progress setiap step.
- Menampilkan resume onboarding jika staff belum selesai.
- Menyembunyikan onboarding setelah staff menyelesaikan seluruh step wajib.
- Menyediakan UI tour yang menunjuk elemen penting di POS.
- Menyediakan fallback checklist jika elemen target tidak ditemukan.
- Menambahkan status onboarding di daftar staff admin.
- Menyediakan validasi agar onboarding tidak dibuat ganda.
- Menyediakan migration database, trigger, dan constraint.
- Menyediakan QA plan untuk memastikan fitur anti duplikasi, anti error, dan tidak merusak transaksi.

### 5.2 Out of Scope

- Membuat onboarding otomatis untuk admin.
- Membuat onboarding otomatis untuk investor.
- Membuat onboarding otomatis untuk staff lama yang sudah ada sebelum fitur ini rilis.
- Membuat ulang onboarding otomatis ketika akun staff diedit.
- Membuat ulang onboarding otomatis setiap staff login.
- Membuat transaksi latihan yang tersimpan sebagai transaksi asli.
- Mengubah total alur login.
- Mengganti sistem role dan permission.
- Mengubah logic pengurangan stok existing.
- Membuat LMS kompleks seperti ujian, nilai, sertifikat, video upload, atau materi multi-bahasa.

## 6. User Persona

### Admin / Owner

Admin membuat akun staff baru dan ingin staff tersebut bisa belajar aplikasi tanpa harus selalu dilatih manual. Admin perlu melihat apakah staff sudah menyelesaikan onboarding.

### Staff Baru / Kasir Baru

Staff baru login ke POS dan butuh panduan langsung di aplikasi. Staff perlu tahu langkah kerja yang benar tanpa takut membuat data bisnis palsu saat belajar.

### Staff Lama

Staff lama tidak boleh terganggu oleh onboarding otomatis. Jika sudah terbiasa memakai POS, aplikasi harus tetap terbuka seperti biasa.

## 7. Prinsip Produk

1. Onboarding harus membantu staff bekerja, bukan menghalangi operasional.
2. Data bisnis live tidak boleh dibuat hanya karena user sedang ikut tutorial.
3. Semua progress penting harus tersimpan di database, bukan hanya `localStorage`.
4. `localStorage` hanya boleh dipakai sebagai cache ringan, bukan sumber kebenaran.
5. Sistem harus idempotent: proses yang sama dijalankan ulang tidak boleh membuat duplikasi.
6. Error onboarding tidak boleh menyebabkan POS blank, logout paksa, atau transaksi gagal.
7. Step tutorial harus tahan terhadap perubahan UI. Jika selector berubah, tampilkan checklist fallback.
8. Onboarding hanya otomatis untuk user baru role `staff` pada saat user dibuat.

## 8. Alur Utama

### 8.1 Admin Membuat Staff Baru

1. Admin membuka `admin.html`.
2. Admin masuk ke menu Staff.
3. Admin klik Tambah Staff.
4. Admin mengisi username, password, role `staff`, dan cabang penugasan jika ada.
5. Admin menyimpan user.
6. Sistem menyimpan user ke tabel `users`.
7. Database trigger otomatis membuat assignment onboarding untuk user baru tersebut.
8. Admin melihat status onboarding staff sebagai `Belum mulai`.

### 8.2 Staff Baru Login Pertama Kali

1. Staff login dari `index.html`.
2. Role `staff` diarahkan ke `pos.html`.
3. POS memvalidasi session.
4. POS memuat assignment onboarding staff.
5. Jika assignment `not_started` atau `in_progress`, tampilkan onboarding panel.
6. Staff dapat klik Mulai Tutorial.
7. Tutorial berjalan sesuai step yang relevan dengan kondisi akun dan cabang.

### 8.3 Staff Menyelesaikan Onboarding

1. Staff menyelesaikan semua step wajib.
2. Sistem menandai assignment sebagai `completed`.
3. Sistem mencatat `completed_at`.
4. Login berikutnya tidak menampilkan onboarding otomatis.
5. Admin melihat status onboarding staff sebagai `Selesai`.

### 8.4 Staff Refresh / Logout Saat Onboarding

1. Staff sedang berada di step tertentu.
2. Staff refresh halaman atau logout.
3. Saat login kembali, POS membaca progress dari database.
4. Tutorial lanjut dari step belum selesai berikutnya.

## 9. Materi Onboarding MVP

### 9.1 Modul 1 - Login, Cabang, dan Shift

Tujuan: staff memahami bahwa POS bekerja per cabang dan per shift.

Step:

1. Mengenali nama staff di header.
2. Mengenali cabang aktif.
3. Jika akun tidak punya `branch_id`, jelaskan pilihan cabang.
4. Membuka shift dengan kas awal.
5. Memahami bahwa transaksi penjualan membutuhkan shift aktif.

Acceptance:

- Staff tahu cabang aktif.
- Staff tahu cara membuka shift.
- Staff tahu bahwa kas awal harus diisi sesuai kondisi kas laci.

### 9.2 Modul 2 - Penjualan

Tujuan: staff memahami cara membuat transaksi penjualan.

Step:

1. Cari produk melalui search.
2. Pilih kategori.
3. Pilih produk.
4. Pilih varian jika produk memiliki varian.
5. Pilih topping jika produk memiliki topping.
6. Ubah qty di keranjang.
7. Hapus item dari keranjang.
8. Simpan / tahan keranjang jika tersedia.
9. Terapkan diskon jika dibutuhkan.
10. Pilih metode pembayaran.
11. Konfirmasi checkout.
12. Cetak atau tutup struk.

Acceptance:

- Staff tahu alur lengkap penjualan.
- Tutorial tidak otomatis memanggil checkout live.
- Jika staff ingin latihan, sistem harus menggunakan mode panduan tanpa menyimpan transaksi palsu.

### 9.3 Modul 3 - Pengurangan Stok Otomatis

Tujuan: staff memahami hubungan transaksi dan stok bahan.

Step:

1. Jelaskan bahwa produk dapat memiliki resep / BOM.
2. Saat transaksi berhasil, stok bahan terkait dikurangi otomatis.
3. Jika stok tidak cukup, sistem dapat menampilkan peringatan sesuai validasi existing.
4. Staff diarahkan melihat ringkasan stok setelah transaksi.

Acceptance:

- Staff tahu bahwa stok berkurang karena transaksi, bukan harus selalu dicatat manual.
- Tutorial tidak mengubah stok tanpa transaksi live yang valid.

### 9.4 Modul 4 - Cek dan Penyesuaian Stok

Tujuan: staff memahami stok masuk, stok keluar, opname, dan transfer.

Step:

1. Buka tab atau drawer stok.
2. Lihat daftar stok bahan.
3. Catat stok masuk untuk pembelian / penerimaan.
4. Catat stok keluar untuk waste / pemakaian manual.
5. Catat opname untuk koreksi hitung fisik.
6. Transfer stok antar cabang jika fitur tersedia untuk staff.
7. Pahami notifikasi transfer masuk.

Acceptance:

- Staff tahu perbedaan stok masuk, stok keluar, opname, dan transfer.
- Tutorial tidak melakukan submit stok otomatis.
- Submit stok tetap memakai validasi existing.

### 9.5 Modul 5 - Riwayat Transaksi, Void, dan Refund

Tujuan: staff memahami cara mengecek transaksi dan menangani koreksi.

Step:

1. Buka riwayat transaksi.
2. Lihat detail transaksi.
3. Pahami status transaksi.
4. Pahami void / refund jika tersedia.
5. Pahami bahwa alasan void / refund wajib jelas.

Acceptance:

- Staff tahu bahwa koreksi transaksi harus melalui fitur resmi.
- Tutorial tidak membuat void / refund otomatis.

### 9.6 Modul 6 - Kas, Tutup Shift, dan Setoran Tunai

Tujuan: staff memahami akhir shift.

Step:

1. Lihat ringkasan kas.
2. Catat kas masuk / kas keluar manual jika diperlukan.
3. Tutup shift.
4. Isi kas aktual.
5. Pahami selisih kas.
6. Lanjut ke setoran tunai jika proses bisnis membutuhkan.

Acceptance:

- Staff tahu cara menutup shift.
- Staff tahu bahwa setoran tunai dilakukan setelah shift sesuai alur yang tersedia.

## 10. Functional Requirements

### FR-001 - Auto Create Assignment untuk Staff Baru

Saat baris baru dibuat di tabel `users` dengan `role = 'staff'`, sistem harus otomatis membuat satu onboarding assignment aktif.

Rules:

- Berlaku hanya untuk event `INSERT`.
- Berlaku hanya jika `NEW.role = 'staff'`.
- Berlaku hanya jika `NEW.is_active` bukan `false`.
- Tidak berlaku untuk role `admin`.
- Tidak berlaku untuk role `investor`.
- Tidak berlaku untuk update user lama.
- Tidak boleh membuat assignment ganda.

### FR-002 - Idempotency

Jika proses auto-create assignment terpanggil lebih dari sekali untuk user yang sama dan template yang sama, database wajib menolak duplikasi dengan unique constraint dan `ON CONFLICT DO NOTHING`.

### FR-003 - Template Onboarding

Sistem harus memiliki template onboarding aktif untuk role `staff`.

Template minimal berisi:

- `template_key`: `staff_pos_basics`
- `audience_role`: `staff`
- `version`: angka integer
- `title`: nama onboarding
- `is_active`: boolean

### FR-004 - Step Onboarding

Step onboarding disimpan terstruktur agar bisa diubah tanpa edit banyak kode.

Setiap step minimal memiliki:

- `step_key`
- `template_id`
- `sequence`
- `module_key`
- `page`
- `target_selector`
- `title`
- `body`
- `is_required`
- `is_active`

### FR-005 - Load Onboarding di POS

Saat `POS.init()` selesai validasi user dan sebelum staff mulai memakai POS, sistem membaca assignment onboarding user.

Rules:

- Jika tidak ada assignment, jangan tampilkan onboarding.
- Jika status `completed`, jangan tampilkan onboarding.
- Jika status `not_started` atau `in_progress`, tampilkan onboarding panel.
- Jika query onboarding gagal, tampilkan toast ringan dan lanjutkan POS.

### FR-006 - Start, Next, Back, Skip Step

Staff dapat:

- mulai onboarding,
- lanjut ke step berikutnya,
- kembali ke step sebelumnya,
- menutup panel sementara,
- melanjutkan nanti.

Catatan:

- Skip seluruh onboarding tidak tersedia untuk staff pada MVP.
- Staff hanya boleh menutup sementara, bukan menandai selesai tanpa menyelesaikan step wajib.

### FR-007 - Completion

Assignment hanya boleh menjadi `completed` jika semua step required sudah selesai.

Saat completed:

- set `status = 'completed'`,
- set `completed_at = now()`,
- simpan event audit `completed`.

### FR-008 - Fallback Jika Target UI Tidak Ada

Jika `target_selector` tidak ditemukan:

- jangan throw error uncaught,
- tampilkan step dalam checklist panel,
- catat event `target_missing`,
- izinkan staff melanjutkan step.

### FR-009 - Admin Melihat Status Onboarding

Di daftar staff admin, tampilkan status onboarding:

- `Belum mulai`
- `Sedang belajar`
- `Selesai`
- `Tidak ada onboarding`

Status ini hanya informatif pada MVP.

### FR-010 - Tidak Membuat Data Bisnis Palsu

Tutorial tidak boleh otomatis membuat:

- transaksi,
- transaction_items,
- inventory_logs,
- branch_inventory changes,
- cash_logs,
- cashier_sessions,
- cash_deposits,
- refund,
- void.

Jika staff melakukan aksi live secara sadar, data tetap mengikuti alur existing dan validasi existing.

### FR-011 - Mobile Friendly

Onboarding wajib nyaman di mobile:

- overlay tidak menutup tombol penting secara permanen,
- panel bisa dipindah antara bawah dan tengah sesuai ruang layar,
- teks tidak overflow,
- tombol Next / Back selalu terlihat,
- target highlight tidak merusak scroll.

### FR-012 - Persist Progress

Setiap step selesai harus disimpan ke database.

Fallback:

- Jika koneksi gagal, simpan pending progress di `localStorage`.
- Saat koneksi pulih, sync pending progress.
- Progress pending tidak boleh menandai assignment completed sebelum database berhasil update.

## 11. Data Model Rekomendasi

Buat migration baru:

`sql/migrations/021_staff_onboarding.sql`

### 11.1 Tabel `onboarding_templates`

```sql
CREATE TABLE IF NOT EXISTS onboarding_templates (
  id            BIGSERIAL PRIMARY KEY,
  template_key  TEXT NOT NULL,
  audience_role TEXT NOT NULL,
  version       INTEGER NOT NULL DEFAULT 1,
  title         TEXT NOT NULL,
  description   TEXT,
  is_active     BOOLEAN NOT NULL DEFAULT TRUE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (template_key, version)
);
```

### 11.2 Tabel `onboarding_steps`

```sql
CREATE TABLE IF NOT EXISTS onboarding_steps (
  id              BIGSERIAL PRIMARY KEY,
  template_id     BIGINT NOT NULL REFERENCES onboarding_templates(id) ON DELETE CASCADE,
  step_key        TEXT NOT NULL,
  module_key      TEXT NOT NULL,
  sequence        INTEGER NOT NULL,
  page            TEXT NOT NULL DEFAULT 'pos.html',
  target_selector TEXT,
  title           TEXT NOT NULL,
  body            TEXT NOT NULL,
  is_required     BOOLEAN NOT NULL DEFAULT TRUE,
  is_active       BOOLEAN NOT NULL DEFAULT TRUE,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (template_id, step_key),
  UNIQUE (template_id, sequence)
);
```

### 11.3 Tabel `user_onboarding_assignments`

```sql
CREATE TABLE IF NOT EXISTS user_onboarding_assignments (
  id            BIGSERIAL PRIMARY KEY,
  user_id       BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  template_id   BIGINT NOT NULL REFERENCES onboarding_templates(id) ON DELETE RESTRICT,
  status        TEXT NOT NULL DEFAULT 'not_started',
  started_at    TIMESTAMPTZ,
  completed_at  TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT chk_onboarding_assignment_status
    CHECK (status IN ('not_started', 'in_progress', 'completed')),
  UNIQUE (user_id, template_id)
);
```

### 11.4 Tabel `user_onboarding_step_progress`

```sql
CREATE TABLE IF NOT EXISTS user_onboarding_step_progress (
  id             BIGSERIAL PRIMARY KEY,
  assignment_id  BIGINT NOT NULL REFERENCES user_onboarding_assignments(id) ON DELETE CASCADE,
  step_id        BIGINT NOT NULL REFERENCES onboarding_steps(id) ON DELETE CASCADE,
  status         TEXT NOT NULL DEFAULT 'pending',
  completed_at   TIMESTAMPTZ,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT chk_onboarding_step_status
    CHECK (status IN ('pending', 'completed')),
  UNIQUE (assignment_id, step_id)
);
```

### 11.5 Tabel `onboarding_events`

```sql
CREATE TABLE IF NOT EXISTS onboarding_events (
  id             BIGSERIAL PRIMARY KEY,
  assignment_id  BIGINT REFERENCES user_onboarding_assignments(id) ON DELETE CASCADE,
  user_id        BIGINT REFERENCES users(id) ON DELETE CASCADE,
  event_type     TEXT NOT NULL,
  step_key       TEXT,
  metadata       JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```

## 12. Trigger Auto Assignment

Auto assignment sebaiknya dilakukan di database, bukan hanya di frontend, agar tetap konsisten jika user dibuat dari script, SQL editor, atau fitur admin lain.

Pseudo SQL:

```sql
CREATE OR REPLACE FUNCTION create_staff_onboarding_assignment()
RETURNS TRIGGER AS $$
DECLARE
  v_template_id BIGINT;
  v_assignment_id BIGINT;
BEGIN
  IF NEW.role <> 'staff' THEN
    RETURN NEW;
  END IF;

  IF COALESCE(NEW.is_active, TRUE) = FALSE THEN
    RETURN NEW;
  END IF;

  SELECT id INTO v_template_id
  FROM onboarding_templates
  WHERE template_key = 'staff_pos_basics'
    AND audience_role = 'staff'
    AND is_active = TRUE
  ORDER BY version DESC
  LIMIT 1;

  IF v_template_id IS NULL THEN
    INSERT INTO onboarding_events(user_id, event_type, metadata)
    VALUES (NEW.id, 'template_missing', jsonb_build_object('role', NEW.role));
    RETURN NEW;
  END IF;

  INSERT INTO user_onboarding_assignments(user_id, template_id, status)
  VALUES (NEW.id, v_template_id, 'not_started')
  ON CONFLICT (user_id, template_id) DO NOTHING
  RETURNING id INTO v_assignment_id;

  IF v_assignment_id IS NOT NULL THEN
    INSERT INTO user_onboarding_step_progress(assignment_id, step_id, status)
    SELECT v_assignment_id, s.id, 'pending'
    FROM onboarding_steps s
    WHERE s.template_id = v_template_id
      AND s.is_active = TRUE
    ON CONFLICT DO NOTHING;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

DROP TRIGGER IF EXISTS trg_create_staff_onboarding_assignment ON users;

CREATE TRIGGER trg_create_staff_onboarding_assignment
AFTER INSERT ON users
FOR EACH ROW
EXECUTE FUNCTION create_staff_onboarding_assignment();
```

## 13. RPC Rekomendasi

Untuk mengurangi logic raw query di frontend, sediakan RPC:

### 13.1 `get_my_onboarding()`

Input:

- `p_user_id`

Output:

- assignment,
- template,
- steps,
- progress.

Rules:

- Hanya mengembalikan assignment milik user tersebut.
- Jika role bukan `staff`, return kosong.
- Jika completed, return status completed tanpa steps aktif atau sesuai kebutuhan UI.

### 13.2 `start_my_onboarding()`

Input:

- `p_assignment_id`
- `p_user_id`

Rules:

- Assignment harus milik user.
- Status `not_started` menjadi `in_progress`.
- Set `started_at` jika belum ada.
- Idempotent jika sudah `in_progress`.

### 13.3 `complete_onboarding_step()`

Input:

- `p_assignment_id`
- `p_step_key`
- `p_user_id`

Rules:

- Assignment harus milik user.
- Step harus bagian dari assignment template.
- Update step progress menjadi completed.
- Jika semua required steps completed, update assignment menjadi completed.
- Simpan event audit.
- Idempotent jika step sudah completed.

## 14. UI / UX Requirements

### 14.1 Onboarding Entry Panel

Saat staff baru masuk POS:

- tampilkan panel ringkas: "Pelatihan Staff Baru"
- tampilkan progress: `0 dari N langkah`
- tombol utama: `Mulai`
- tombol sekunder: `Lanjut nanti`

`Lanjut nanti` hanya menutup panel sementara untuk session tersebut. Login berikutnya tetap menampilkan reminder sampai onboarding selesai.

### 14.2 Tour Overlay

Tour overlay terdiri dari:

- highlight target element,
- judul step,
- deskripsi singkat,
- progress indicator,
- tombol Back,
- tombol Next,
- tombol Selesai pada step terakhir,
- tombol Tutup Sementara.

### 14.3 Checklist Fallback

Jika target element tidak ditemukan atau layout berubah:

- tampilkan mode checklist,
- jangan highlight element,
- tetap tampilkan materi step,
- user tetap bisa menyelesaikan step.

### 14.4 Admin Staff List

Pada kartu staff di `section-staff`, tambahkan badge kecil:

- `Training: Belum mulai`
- `Training: Sedang belajar`
- `Training: Selesai`
- `Training: Tidak ada`

Badge tidak boleh menggantikan role badge.

## 15. File yang Perlu Diubah

Rekomendasi perubahan:

| File | Perubahan |
| --- | --- |
| `sql/migrations/021_staff_onboarding.sql` | Tabel onboarding, seed template, seed steps, trigger auto assignment, RPC. |
| `pos.html` | Container onboarding overlay dan panel. |
| `admin.html` | Badge status onboarding di staff list jika perlu markup tambahan. |
| `js/pos.js` | Panggil modul onboarding setelah user dan cabang siap. |
| `js/admin.js` | Load status onboarding di daftar staff. |
| `js/onboarding.js` | Modul baru untuk load assignment, render panel, tour, persist progress, fallback. |
| `css/style.css` atau CSS terkait | Styling overlay, highlight, panel mobile. |

## 16. Anti Bug dan Anti Error Requirements

### 16.1 Database Safety

1. Wajib ada unique constraint `(user_id, template_id)`.
2. Wajib memakai `ON CONFLICT DO NOTHING` saat auto-create assignment.
3. Trigger hanya `AFTER INSERT`, bukan `AFTER UPDATE`.
4. Trigger wajib filter `role = 'staff'`.
5. Trigger wajib aman jika template belum ada.
6. RPC wajib validasi assignment milik user.
7. Completion wajib dihitung dari required steps di database.

### 16.2 Frontend Safety

1. Semua query onboarding dibungkus `try/catch`.
2. Error onboarding tidak boleh menghentikan `POS.init()`.
3. Selector yang tidak ditemukan tidak boleh menyebabkan crash.
4. Tombol Next harus disable sementara saat progress sedang disimpan.
5. Klik ganda tidak boleh membuat event progress duplikat.
6. Onboarding tidak boleh mengubah cart tanpa aksi eksplisit dari staff.
7. Onboarding tidak boleh submit checkout, stok, kas, void, refund, atau setoran otomatis.
8. Overlay wajib bisa ditutup sementara jika menghalangi transaksi.
9. Data text dari database wajib di-escape sebelum dirender.
10. State loading, error, empty, dan completed harus jelas.

### 16.3 Session dan Offline Safety

1. Jika session expired, gunakan flow logout existing.
2. Jika koneksi putus, simpan progress pending di localStorage.
3. Pending progress disync setelah koneksi kembali.
4. Pending progress tidak boleh menandai completed sebelum database sukses.
5. Jika user login di device lain, progress database menjadi sumber kebenaran.

### 16.4 Regression Safety

1. Staff lama tanpa assignment tidak boleh melihat onboarding.
2. Admin tidak boleh melihat onboarding POS.
3. Investor tidak boleh melihat onboarding POS.
4. Staff baru yang sudah completed tidak boleh melihat onboarding lagi.
5. Edit password / cabang staff tidak boleh membuat assignment baru.
6. Soft delete staff tidak boleh menghapus riwayat transaksi.
7. Reset data existing tidak boleh gagal karena tabel onboarding.

## 17. Acceptance Criteria

### AC-001 - Staff Baru Mendapat Onboarding

Given admin membuat user baru dengan role `staff`  
When insert berhasil di tabel `users`  
Then sistem membuat satu assignment onboarding dengan status `not_started`

### AC-002 - Admin Tidak Mendapat Onboarding

Given admin membuat user baru dengan role `admin`  
When insert berhasil  
Then tidak ada assignment onboarding yang dibuat

### AC-003 - Investor Tidak Mendapat Onboarding

Given admin membuat user baru dengan role `investor`  
When insert berhasil  
Then tidak ada assignment onboarding yang dibuat

### AC-004 - Edit Staff Tidak Membuat Onboarding Baru

Given user staff sudah ada  
When admin mengubah password, cabang, atau nama user  
Then sistem tidak membuat assignment onboarding baru

### AC-005 - Tidak Ada Duplikasi

Given trigger atau proses auto-create terpanggil dua kali  
When user dan template sama  
Then hanya ada satu assignment karena unique constraint

### AC-006 - Staff Baru Melihat Onboarding

Given staff baru memiliki assignment `not_started`  
When staff login ke `pos.html`  
Then panel onboarding tampil

### AC-007 - Progress Tersimpan

Given staff menyelesaikan step 1  
When staff refresh halaman  
Then step 1 tetap completed dan tutorial lanjut ke step berikutnya

### AC-008 - Completion Persisten

Given semua required steps selesai  
When staff login ulang  
Then onboarding tidak tampil otomatis lagi

### AC-009 - Error Onboarding Tidak Merusak POS

Given query onboarding gagal  
When staff membuka POS  
Then POS tetap bisa dipakai dan sistem menampilkan pesan error ringan

### AC-010 - Tutorial Tidak Membuat Transaksi Palsu

Given staff mengikuti tutorial penjualan  
When staff menekan Next di tutorial  
Then tidak ada row baru di `transactions`, `transaction_items`, `cash_logs`, atau `inventory_logs`

### AC-011 - Selector Hilang Tetap Aman

Given target selector step tidak ditemukan  
When tour mencoba render step  
Then sistem menampilkan checklist fallback dan tidak crash

### AC-012 - Staff Lama Tidak Terganggu

Given staff lama tidak punya assignment onboarding  
When staff login  
Then POS terbuka seperti biasa tanpa panel onboarding

## 18. QA Test Plan

### 18.1 Database Tests

1. Insert user role `staff`, pastikan assignment dibuat.
2. Insert user role `admin`, pastikan assignment tidak dibuat.
3. Insert user role `investor`, pastikan assignment tidak dibuat.
4. Insert staff dengan `is_active = false`, pastikan assignment tidak dibuat.
5. Update staff lama, pastikan assignment tidak dibuat.
6. Jalankan function assignment manual dua kali, pastikan tidak duplicate.
7. Hapus / nonaktifkan template aktif, insert staff, pastikan insert user tidak gagal.
8. Complete semua step, pastikan assignment menjadi completed.

### 18.2 POS E2E Tests

1. Login staff baru dengan cabang assigned.
2. Login staff baru tanpa cabang assigned.
3. Mulai onboarding, klik Next beberapa step.
4. Refresh halaman, pastikan progress lanjut.
5. Logout lalu login ulang, pastikan progress lanjut.
6. Selesaikan onboarding, login ulang, pastikan tidak tampil.
7. Pakai POS normal saat onboarding ditutup sementara.
8. Pastikan checkout live tetap mengurangi stok sesuai logic existing.

### 18.3 Negative Tests

1. Matikan koneksi saat klik Next.
2. Ubah selector target menjadi tidak valid.
3. Klik Next berkali-kali cepat.
4. Login dua tab dengan user yang sama.
5. Session expired saat onboarding terbuka.
6. Staff soft deleted saat session masih ada.

### 18.4 Regression Tests

1. Admin Staff list tetap bisa load.
2. Tambah staff tetap berhasil.
3. Edit staff tetap berhasil.
4. Hapus staff tetap soft delete.
5. POS penjualan tetap berhasil.
6. Buka dan tutup shift tetap berhasil.
7. Stok masuk / keluar / opname tetap berhasil.
8. Setoran tunai tetap berhasil.

## 19. Rollout Plan

1. Buat migration onboarding.
2. Seed template dan steps default.
3. Tambahkan RPC.
4. Tambahkan `js/onboarding.js`.
5. Integrasikan dengan `pos.html` dan `js/pos.js`.
6. Tambahkan status training di `js/admin.js`.
7. Test di database development.
8. Test dengan akun staff baru.
9. Test regresi staff lama.
10. Deploy.

## 20. Keputusan Produk

1. Default MVP tidak melakukan backfill untuk staff lama.
2. Onboarding otomatis hanya untuk `INSERT users` role `staff`.
3. Onboarding tidak boleh otomatis dibuat dari event login.
4. Onboarding tidak boleh otomatis dibuat dari update role.
5. Tutorial bersifat panduan live yang aman, bukan transaksi simulasi tersimpan.
6. Staff dapat menutup sementara, tetapi status selesai hanya jika semua required steps selesai.
7. Database adalah sumber kebenaran progress.

## 21. Risiko dan Mitigasi

| Risiko | Dampak | Mitigasi |
| --- | --- | --- |
| Assignment duplicate | Staff melihat onboarding berulang | Unique constraint dan `ON CONFLICT DO NOTHING`. |
| Trigger gagal karena template tidak ada | User gagal dibuat | Trigger tidak throw error, hanya audit `template_missing`. |
| Selector UI berubah | Tour crash | Checklist fallback. |
| Koneksi putus saat progress save | Progress hilang | Pending localStorage dan sync ulang. |
| Tutorial mengganggu transaksi | Operasional lambat | Tombol Tutup Sementara dan tidak blocking checkout. |
| Tutorial membuat data palsu | Laporan kacau | Next tutorial tidak memanggil submit live. |
| Staff lama terganggu | UX buruk | Tidak ada backfill, hanya user baru. |

## 22. Success Metrics

1. 100% staff baru role `staff` memiliki assignment onboarding.
2. 0 assignment otomatis untuk role `admin` dan `investor`.
3. 0 duplikasi assignment untuk user dan template yang sama.
4. Minimal 90% staff baru menyelesaikan onboarding.
5. Tidak ada kenaikan error checkout, stok, shift, atau setoran setelah fitur aktif.
6. Admin lebih jarang perlu melatih manual alur dasar POS.

## 23. Definition of Done

Fitur dianggap selesai jika:

1. Migration berhasil dijalankan tanpa error.
2. Staff baru otomatis mendapat assignment onboarding.
3. Staff lama tidak mendapat onboarding otomatis.
4. Onboarding muncul di POS hanya untuk staff baru yang belum selesai.
5. Progress tersimpan dan bisa dilanjutkan.
6. Completion menghentikan tampilan onboarding otomatis.
7. Admin dapat melihat status onboarding staff.
8. Semua acceptance criteria lulus.
9. Semua QA regression utama lulus.
10. Tidak ada transaksi, stok, kas, void, refund, atau setoran palsu dari tutorial.
