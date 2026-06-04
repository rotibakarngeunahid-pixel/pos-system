# PRD — Sistem Member & Loyalty Point
**Roti Bakar Ngeunah (RBN) POS**

| Item | Nilai |
| --- | --- |
| Versi PRD | 1.0 |
| Tanggal | 2026-06-03 |
| Status | Draft — belum implementasi |
| Pemilik Produk | Owner RBN |
| Target Implementasi | Bertahap (3 fase, lihat §15) |
| Stack target | PHP 8 + MySQL 8 (cPanel), Vanilla JS (PWA), Lucide Icons |
| Backend entrypoint | `api/api.php` (RESTful + RPC pattern PostgREST-style) |
| Frontend kasir | `pos.html` + `js/pos.js` |
| Frontend admin | `admin.html` + `js/admin.js` |

> Catatan: PRD ini wajib dibaca **dari atas ke bawah** sebelum coding. Section 14 (Anti-Fraud) dan Section 6 (Database Schema) adalah jantung sistem — jangan dilewati.

---

## Daftar Isi
1. [Ringkasan Eksekutif (Non-Programmer)](#1-ringkasan-eksekutif-non-programmer)
2. [Latar Belakang & Tujuan Bisnis](#2-latar-belakang--tujuan-bisnis)
3. [Glossary](#3-glossary)
4. [Role & Hak Akses](#4-role--hak-akses)
5. [Fitur Utama](#5-fitur-utama)
6. [Struktur Database](#6-struktur-database)
7. [API & Endpoint](#7-api--endpoint)
8. [Halaman & UI/UX](#8-halaman--uiux)
9. [User Flow](#9-user-flow)
10. [Aturan Point & Reward](#10-aturan-point--reward)
11. [Integrasi dengan Sistem POS Existing](#11-integrasi-dengan-sistem-pos-existing)
12. [Edge Case](#12-edge-case)
13. [Acceptance Criteria](#13-acceptance-criteria)
14. [Anti-Fraud & Security Hardening](#14-anti-fraud--security-hardening)
15. [Rekomendasi Implementasi Bertahap](#15-rekomendasi-implementasi-bertahap)
16. [Risiko, Asumsi, & Open Questions](#16-risiko-asumsi--open-questions)

---

## 1. Ringkasan Eksekutif (Non-Programmer)

Saat ini kasir RBN sudah bisa melayani transaksi penjualan, mencatat shift kas, dan membuat laporan. Tapi belum ada **sistem member** — pelanggan setia tidak punya akun, tidak dapat point, dan tidak ada alasan kuat untuk kembali lagi.

Fitur **Member & Loyalty Point** ini menambah satu lapisan baru di atas sistem yang sudah berjalan:

- Pelanggan bisa daftar jadi member (pakai nomor HP), dapat **kode member unik + QR code**.
- Setiap kali belanja, member tunjukkan QR atau kasir cari nomor HP-nya → member dapat **point** otomatis berdasarkan nominal transaksi (misalnya: Rp10.000 = 1 point).
- Member bisa **menukar point dengan reward** (contoh: 50 point = roti bakar gratis). Reward diatur admin.
- Sistem mencatat **semua perubahan point** di "buku besar point" (ledger) supaya bisa dilacak dan tidak bisa dipalsukan.
- Sistem punya **alarm anti-curang**: kalau kasir coba pakai akun member sendiri, atau ada pola mencurigakan (banyak transaksi kecil ke 1 member dalam sehari), admin akan dapat peringatan.

**Penting:** Sistem POS lama tidak diubah. Fitur ini menempel sebagai modul terpisah yang berkomunikasi lewat ID transaksi. Kalau fitur member dimatikan, kasir tetap bisa transaksi normal seperti biasa.

**Cara kerja singkat:**
1. Pelanggan datang → kasir tanya "ada member?" → kasir scan QR atau ketik nomor HP.
2. Setelah transaksi selesai dan dibayar, sistem otomatis tambah point ke akun member.
3. Kalau point cukup, member klaim reward di app/web → dapat kode klaim → tunjukkan ke kasir → kasir scan → point berkurang, reward keluar.
4. Kalau transaksi dibatalkan/refund, point yang sudah masuk juga dibatalkan otomatis.

---

## 2. Latar Belakang & Tujuan Bisnis

### 2.1 Masalah saat ini
- Tidak ada cara mengidentifikasi pelanggan setia.
- Tidak ada insentif retensi → pelanggan mudah pindah ke kompetitor.
- Tidak ada data demografi/perilaku pelanggan untuk strategi marketing.
- Promo manual (potongan harga) cepat dilupakan, sulit diukur ROI-nya.

### 2.2 Goal bisnis
1. **Retensi**: tingkatkan frekuensi kunjungan pelanggan setia.
2. **Data**: kumpulkan basis data member untuk kampanye broadcast (WhatsApp/SMS) di masa depan.
3. **Word-of-mouth**: reward "gratis roti bakar" mendorong pelanggan share ke teman/keluarga.
4. **Anti-fraud**: pastikan program loyalty tidak bisa disalahgunakan staff sendiri.

### 2.3 Goal teknis
1. **Tidak merusak** sistem POS yang sudah berjalan stabil (transaksi, kas, deposit, inventory).
2. **Ledger-based** (mengikuti pola `branch_cash_ledger`) supaya saldo point bisa di-audit dan direkonsiliasi.
3. **Tetap PHP + MySQL** di cPanel — tidak butuh stack baru.
4. **Aman by default**: hash password, prepared statement, audit log, rate limit (mengikuti pola yang sudah ada di `api.php`).

### 2.4 Non-Goals (di luar scope versi 1)
- Notifikasi push real-time ke member (anggap kirim via WhatsApp manual dulu).
- Integrasi WhatsApp Business API untuk OTP otomatis (Fase 2).
- Multi-tier membership (Bronze/Silver/Gold) — bisa Fase 3.
- Gamification (badge, leaderboard) — di luar scope.
- Referral program — di luar scope.
- Affiliate/cashback ke rekening — di luar scope.

---

## 3. Glossary

| Istilah | Definisi |
| --- | --- |
| **Member** | Pelanggan yang sudah punya akun di sistem loyalty. Bukan staff. |
| **Point** | Satuan reward yang dikumpulkan member dari transaksi. 1 point = abstrak, bukan rupiah. |
| **Reward** | Hadiah yang bisa ditukar dengan point (contoh: Roti Bakar Coklat gratis). |
| **Redemption** | Proses tukar point ke reward. |
| **Redemption Code** | Kode unik sekali pakai yang dibuat saat member klaim reward. Wajib di-redeem di kasir. |
| **Ledger** | Buku besar — catatan kronologis semua perubahan point. Tidak bisa diedit/dihapus. |
| **Point Pending** | Point yang sudah dijatahkan dari transaksi, tapi belum aktif (menunggu shift ditutup atau periode anti-refund lewat). |
| **Point Active** | Point yang sudah bisa dipakai klaim reward. |
| **Point Expired** | Point yang melewati masa berlaku, sudah hangus otomatis. |
| **Fraud Flag** | Catatan dari sistem deteksi bahwa ada aktivitas mencurigakan. |
| **Self-Transaction** | Kondisi di mana `staff_id` (kasir) berkaitan dengan `member_id` (target point) — terindikasi fraud. |

---

## 4. Role & Hak Akses

Sistem POS sudah punya 4 role di tabel `users.role` ENUM: `admin`, `owner`, `staff`, `investor`.
Fitur ini menambah **1 entitas baru** (member, bukan role di `users`) — tabel `members` terpisah.

### 4.1 Admin / Owner
- ✅ Kelola data member (CRUD, aktifkan/nonaktifkan).
- ✅ Lihat semua histori transaksi & point member.
- ✅ Atur aturan perolehan point (rasio, minimum transaksi, masa berlaku).
- ✅ Atur reward (CRUD reward, syarat, kuota).
- ✅ Lihat laporan loyalty (total point beredar, klaim terbanyak, member teraktif).
- ✅ Lihat fraud dashboard dengan skor risiko.
- ✅ Lihat audit log perubahan point.
- ✅ Manual adjustment point (wajib alasan, tercatat di audit log).
- ✅ Kunci/batalkan point yang terindikasi fraud.
- ✅ Approve klaim reward yang butuh approval.
- ✅ Lihat dan trigger reset password member.

### 4.2 Staff / Kasir
- ✅ Cari member saat transaksi (HP / kode member / scan QR).
- ✅ Attach member ke transaksi sebelum disimpan.
- ✅ Lihat preview point yang akan diberikan.
- ✅ Scan & validasi redemption code member.
- ✅ Proses klaim reward sesuai kode yang valid.
- ❌ Tidak boleh edit saldo point manual.
- ❌ Tidak boleh tambah point tanpa transaksi.
- ❌ Tidak boleh hapus histori point.
- ❌ Tidak boleh ubah aturan reward.
- ❌ Tidak boleh memberi point ke akun member yang terkait dirinya (self-transaction protection — lihat §14).
- ❌ Tidak boleh attach member ke transaksi yang sudah `completed` lebih dari window time tertentu (lihat §14).

### 4.3 Member / Pelanggan
- ✅ Daftar (register).
- ✅ Login & logout.
- ✅ Lihat profil sendiri.
- ✅ Lihat total point (aktif + pending).
- ✅ Lihat histori transaksi sendiri.
- ✅ Lihat histori point in/out sendiri.
- ✅ Lihat daftar reward yang tersedia.
- ✅ Klaim reward kalau point cukup.
- ✅ Lihat status klaim (pending/redeemed/expired/cancelled).
- ✅ Update data dasar (nama, email) dengan validasi password.
- ✅ Ganti nomor HP (butuh OTP ke nomor baru — Fase 2; di Fase 1 cukup approve admin).
- ✅ Ganti password.
- ❌ Tidak bisa lihat data member lain.
- ❌ Tidak bisa akses endpoint admin/staff.
- ❌ Tidak bisa atur point sendiri.
- ❌ Tidak bisa hapus akun sendiri (harus minta admin) — supaya audit trail terjaga.

### 4.4 Investor
- ✅ (Opsional Fase 2) Lihat ringkasan loyalty di cabang yang ia akses, sebagai bagian dari laporan finansial.
- ❌ Tidak boleh lihat data personal member (PII).
- ❌ Tidak boleh CRUD apapun.

### 4.5 Matrix Akses Endpoint (Ringkasan)

| Endpoint Kategori | Admin/Owner | Staff | Member | Investor |
| --- | :---: | :---: | :---: | :---: |
| `rpc/member_register` | ✅ | ❌ | ✅ (self) | ❌ |
| `rpc/member_login` | ❌ | ❌ | ✅ | ❌ |
| `rpc/member_lookup` (by phone) | ✅ | ✅ | ❌ | ❌ |
| `rpc/member_attach_to_transaction` | ✅ | ✅ | ❌ | ❌ |
| `rpc/member_validate_qr_or_otp` | ✅ | ✅ | ❌ | ❌ |
| `GET /members` | ✅ | ❌ | ✅ (self only) | ❌ |
| `GET /member_point_ledger` | ✅ | ❌ | ✅ (self) | ❌ |
| `GET /member_rewards` (active list) | ✅ | ✅ | ✅ | ❌ |
| `POST /member_rewards` | ✅ | ❌ | ❌ | ❌ |
| `rpc/member_claim_reward` | ❌ | ❌ | ✅ | ❌ |
| `rpc/member_redeem_at_cashier` | ✅ | ✅ | ❌ | ❌ |
| `rpc/member_manual_adjust` | ✅ | ❌ | ❌ | ❌ |
| `GET /member_fraud_flags` | ✅ | ❌ | ❌ | ❌ |
| `GET /member_audit_logs` | ✅ | ❌ | ❌ | ❌ |

---

## 5. Fitur Utama

### 5.1 Modul A — Registrasi Member
- Field wajib: `name`, `phone`, `password`.
- Field opsional: `email`, `birth_date`, `gender`, `branch_id_signup` (cabang pertama daftar).
- `phone` wajib **unik** (UNIQUE INDEX di DB).
- `email` boleh kosong, tapi kalau diisi harus unik.
- Generate otomatis: `member_code` (format: `RBN-YYMM-XXXXX`, 5 digit random alphanumeric), `qr_payload` (signed token), `created_at`.
- Password di-hash dengan `password_hash($pw, PASSWORD_BCRYPT)` — sama seperti `users.password` di `api.php:1443-1444`.
- Verifikasi nomor HP:
  - **Fase 1**: tidak ada OTP (anggap nomor HP valid). Member baru flag `phone_verified=0`.
  - **Fase 2**: integrasi gateway WA/SMS untuk OTP 6 digit. `phone_verified=1` setelah OTP valid.
- Member baru **tidak mendapat point welcome** secara otomatis. Hanya admin yang boleh memberikan point welcome via manual adjustment.

### 5.2 Modul B — Login & Session Member
- Login pakai `phone` atau `email` + `password`.
- Mengikuti pola `app_sessions` yang sudah ada: buat token random 32-byte, simpan SHA256 hash di tabel baru `member_sessions` (terpisah dari `app_sessions` supaya tidak campur dengan staff).
- Session expire 30 hari (lebih lama dari staff karena pelanggan jarang login).
- Header: `X-Member-Session-Token` (terpisah dari `X-Session-Token` staff).
- Forgot password (Fase 1): admin reset manual; (Fase 2): OTP ke HP.
- Rate limit: 5 percobaan gagal / 5 menit per nomor HP (pakai tabel `login_attempts` existing dengan prefix `member:`).

### 5.3 Modul C — Dashboard Member
Halaman utama setelah login. Komponen:
1. Header: nama, kode member, QR code (besar, bisa diperbesar).
2. Saldo point:
   - **Point Aktif** (besar, highlight).
   - **Point Pending** (lebih kecil, info icon menjelaskan).
   - **Point Hangus bulan ini** (warning kalau ada yang segera expired).
3. Card "Reward Bisa Diklaim" — daftar reward yang point-nya sudah cukup.
4. Tombol "Lihat Semua Reward".
5. Histori transaksi terakhir (5 terbaru, link ke detail).
6. Histori point (5 terbaru).

### 5.4 Modul D — Integrasi Transaksi Kasir
- Di halaman POS (`pos.html`), tambah panel "Member" di sebelah cart.
- Default: "Tanpa Member" (transaksi anonim).
- Tombol "Cari Member":
  - Input HP/Kode Member, atau
  - Scan QR via kamera HP (pakai library `html5-qrcode` atau `jsQR`).
- Setelah ditemukan: tampilkan nama, kode, total point aktif, dan **preview point yang akan didapat** dari transaksi ini.
- Validasi kepemilikan (lihat §14 untuk detail):
  - QR member dianggap valid kalau di-scan langsung di kasir (bukan diketik manual).
  - Kalau input manual via HP, sistem **menampilkan 4 digit terakhir HP** untuk konfirmasi visual dengan pelanggan ("Pak/Bu, nomor 08xxx-xxxx-1234 benar?").
- Member di-attach ke transaksi via field baru `transactions.member_id` (nullable BIGINT, FK→members).
- Point dihitung di backend pada RPC `rpc_process_transaction` (modifikasi minimal — lihat §11).

### 5.5 Modul E — Aturan Point
Disimpan di tabel `member_settings` (key-value). Admin bisa atur via UI:
- `point_ratio_rupiah_per_point` (default 10000) — Rp10.000 = 1 point.
- `point_rounding_mode` ENUM('floor','round','ceil') (default 'floor').
- `min_transaction_for_point` (default 0).
- `max_point_per_transaction` (default 1000).
- `max_point_per_member_per_day` (default 50) — anti-fraud, lihat §14.
- `point_validity_days` (default 365, 0 = tidak expired).
- `point_pending_window_hours` (default 24) — point pending selama X jam atau sampai shift ditutup.
- `excluded_product_ids` (JSON array of product IDs yang tidak dapat point).
- `excluded_category_ids` (JSON array of category IDs).
- `point_on_reward_transaction` (default 0) — kalau transaksi mengandung reward, dapat point tidak?
- `enable_loyalty_module` (default 0 di awal, di-on saat siap go-live).

### 5.6 Modul F — Reward Management
Admin bisa CRUD reward dengan field:
- `name`, `description`, `image_url`.
- `cost_point` — minimal point untuk klaim.
- `reward_type` ENUM('free_product','discount_amount','discount_percent','other').
- `reward_product_id` (kalau type=`free_product` → produk yang diberikan).
- `reward_variant_id` (kalau ada variant spesifik).
- `discount_value` (kalau type=`discount_amount`/`discount_percent`).
- `quota_total` (NULL = unlimited).
- `quota_per_member` (NULL = unlimited).
- `valid_from`, `valid_until` (NULL = tidak ada batas).
- `branch_scope` ENUM('all','specific') + `branch_ids` JSON kalau specific.
- `is_active` BOOL.
- `requires_admin_approval` BOOL — kalau true, klaim member masuk status `pending_approval` dulu.
- `terms_and_conditions` TEXT.

### 5.7 Modul G — Klaim Reward
Alur:
1. Member klik "Klaim" di halaman reward.
2. Sistem cek: point cukup? reward aktif? kuota tersisa? sudah pernah klaim (kalau per-member terbatas)?
3. Sistem buat `member_reward_claims` row dengan status `pending` (kalau `requires_admin_approval`=0 → langsung `redeemable`).
4. Generate `redemption_code` random 8 char + `redemption_qr` (signed payload).
5. Point **dipotong langsung** dan ditahan di status `reserved` (lihat §10).
6. Member tunjukkan kode/QR di kasir.
7. Kasir buka modal "Redeem Reward", scan QR atau input kode.
8. Sistem validasi: kode valid? belum expired? belum dipakai? member sama dengan yang attach ke transaksi (kalau attach)?
9. Kasir konfirmasi → status `redeemed`, point definitif terpotong dari ledger, produk/diskon di-apply ke transaksi.
10. Kalau member batal klaim sebelum redeem: status `cancelled`, point dikembalikan via ledger entry `redemption_refund`.

Reward tidak bisa diklaim 2x dengan kode yang sama (UNIQUE INDEX di `redemption_code`).

---

## 6. Struktur Database

> Semua tabel baru pakai prefix `member_*` supaya tidak bertabrakan dengan tabel existing. Mengikuti konvensi MySQL 8 + InnoDB + utf8mb4_unicode_ci yang sudah dipakai di `cpanel_mysql_schema.sql`.

### 6.1 Tabel `members`
Master data pelanggan yang sudah jadi member.

```sql
CREATE TABLE IF NOT EXISTS `members` (
  `id`                  BIGINT AUTO_INCREMENT PRIMARY KEY,
  `member_code`         VARCHAR(20)  NOT NULL UNIQUE,
  `name`                VARCHAR(255) NOT NULL,
  `phone`               VARCHAR(20)  NOT NULL UNIQUE,
  `email`               VARCHAR(255) UNIQUE DEFAULT NULL,
  `password`            VARCHAR(255) NOT NULL,
  `birth_date`          DATE DEFAULT NULL,
  `gender`              ENUM('M','F','other') DEFAULT NULL,
  `phone_verified`      TINYINT(1) NOT NULL DEFAULT 0,
  `email_verified`      TINYINT(1) NOT NULL DEFAULT 0,
  `qr_secret`           VARCHAR(64) NOT NULL,
  `signup_branch_id`    BIGINT DEFAULT NULL,
  `staff_link_user_id`  BIGINT DEFAULT NULL,    -- diisi kalau member ini terdaftar atas nama staff/orang dalam (anti-fraud)
  `is_active`           TINYINT(1) NOT NULL DEFAULT 1,
  `lifetime_points_earned` BIGINT NOT NULL DEFAULT 0,
  `lifetime_points_redeemed` BIGINT NOT NULL DEFAULT 0,
  `last_transaction_at` DATETIME DEFAULT NULL,
  `created_at`          DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at`          DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  `deleted_at`          DATETIME DEFAULT NULL,
  FOREIGN KEY (`signup_branch_id`)   REFERENCES `branches`(`id`) ON DELETE SET NULL,
  FOREIGN KEY (`staff_link_user_id`) REFERENCES `users`(`id`)    ON DELETE SET NULL,
  INDEX `idx_member_phone`   (`phone`),
  INDEX `idx_member_active`  (`is_active`, `created_at`),
  INDEX `idx_member_created` (`created_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
```

**Catatan kolom kunci:**
- `member_code`: dibaca pelanggan, format `RBN-2606-A1B2C`. Pakai INSERT loop kalau collision (sangat jarang).
- `qr_secret`: 32 byte hex random. Dipakai untuk menandatangani QR payload supaya tidak bisa dipalsu.
- `staff_link_user_id`: kalau admin tahu member ini sebenarnya staff/keluarga staff → flag manual. Dipakai oleh logic anti-fraud (lihat §14.2).
- `lifetime_*`: cached counter untuk performance. Recompute periodik dari ledger.
- Saldo point **TIDAK** disimpan di tabel ini → harus selalu dihitung dari ledger (single source of truth).

### 6.2 Tabel `member_sessions`
Session login member (terpisah dari `app_sessions` untuk staff).

```sql
CREATE TABLE IF NOT EXISTS `member_sessions` (
  `token_hash`   VARCHAR(64) NOT NULL PRIMARY KEY,
  `member_id`    BIGINT NOT NULL,
  `created_at`   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `expires_at`   DATETIME NOT NULL,
  `last_seen_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `ip_address`   VARCHAR(45),
  `user_agent`   VARCHAR(255),
  FOREIGN KEY (`member_id`) REFERENCES `members`(`id`) ON DELETE CASCADE,
  INDEX `idx_member_expires` (`member_id`, `expires_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
```

### 6.3 Tabel `member_point_ledger` ⭐
**Tabel paling penting.** Buku besar semua perubahan point. Append-only — tidak boleh UPDATE/DELETE row, hanya INSERT ledger baru untuk koreksi.

```sql
CREATE TABLE IF NOT EXISTS `member_point_ledger` (
  `id`              BIGINT AUTO_INCREMENT PRIMARY KEY,
  `member_id`       BIGINT NOT NULL,
  `branch_id`       BIGINT,
  `transaction_id`  INT DEFAULT NULL,         -- FK ke transactions, NULL kalau adjustment manual
  `reward_claim_id` BIGINT DEFAULT NULL,      -- FK ke member_reward_claims kalau redeem
  `movement_type`   VARCHAR(50) NOT NULL,
    -- ENUM: 'earn_purchase', 'earn_pending', 'pending_to_active', 'redeem_reserve',
    --       'redeem_commit', 'redeem_refund', 'refund_reversal', 'manual_adjust_in',
    --       'manual_adjust_out', 'expire', 'fraud_lock', 'fraud_unlock'
  `direction`       ENUM('in','out','none') NOT NULL,
  `points`          INT NOT NULL,             -- selalu positif; tanda ditentukan oleh `direction`
  `balance_active_before`   BIGINT NOT NULL,
  `balance_active_after`    BIGINT NOT NULL,
  `balance_pending_before`  BIGINT NOT NULL,
  `balance_pending_after`   BIGINT NOT NULL,
  `expires_at`      DATETIME DEFAULT NULL,    -- diisi kalau point ada masa berlaku
  `reason`          TEXT,
  `source_table`    VARCHAR(50),
  `source_id`       VARCHAR(100),
  `created_by_user_id` BIGINT,                -- staff/admin yang trigger; NULL kalau system
  `created_at`      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `metadata`        JSON,
  FOREIGN KEY (`member_id`)      REFERENCES `members`(`id`),
  FOREIGN KEY (`branch_id`)      REFERENCES `branches`(`id`),
  FOREIGN KEY (`transaction_id`) REFERENCES `transactions`(`id`),
  FOREIGN KEY (`created_by_user_id`) REFERENCES `users`(`id`),
  UNIQUE KEY `uq_ledger_source` (`source_table`(50), `source_id`(100), `movement_type`(50)),
  INDEX `idx_ledger_member_date` (`member_id`, `created_at`),
  INDEX `idx_ledger_tx`          (`transaction_id`),
  INDEX `idx_ledger_movement`    (`movement_type`, `created_at`),
  INDEX `idx_ledger_expires`     (`expires_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
```

**Saldo dihitung:**
```sql
SELECT
  COALESCE(SUM(CASE WHEN direction='in'  AND movement_type IN ('earn_purchase','pending_to_active','manual_adjust_in','redeem_refund','refund_reversal','fraud_unlock')
                   THEN points ELSE 0 END), 0)
  - COALESCE(SUM(CASE WHEN direction='out' AND movement_type IN ('redeem_commit','manual_adjust_out','expire','fraud_lock')
                   THEN points ELSE 0 END), 0)
  AS balance_active
FROM member_point_ledger
WHERE member_id = ?
```

> Komputasi semua disimpan di RPC `rpc_member_get_balance()` agar konsisten.

### 6.4 Tabel `member_rewards`
Master katalog reward yang bisa ditukar.

```sql
CREATE TABLE IF NOT EXISTS `member_rewards` (
  `id`                       BIGINT AUTO_INCREMENT PRIMARY KEY,
  `name`                     VARCHAR(255) NOT NULL,
  `description`              TEXT,
  `image_url`                TEXT,
  `cost_point`               INT NOT NULL,
  `reward_type`              ENUM('free_product','discount_amount','discount_percent','other') NOT NULL,
  `reward_product_id`        INT DEFAULT NULL,
  `reward_variant_id`        INT DEFAULT NULL,
  `discount_value`           DECIMAL(12,2) DEFAULT NULL,
  `quota_total`              INT DEFAULT NULL,
  `quota_used`               INT NOT NULL DEFAULT 0,
  `quota_per_member`         INT DEFAULT NULL,
  `valid_from`               DATETIME DEFAULT NULL,
  `valid_until`              DATETIME DEFAULT NULL,
  `branch_scope`             ENUM('all','specific') NOT NULL DEFAULT 'all',
  `branch_ids`               JSON,
  `requires_admin_approval`  TINYINT(1) NOT NULL DEFAULT 0,
  `terms_and_conditions`     TEXT,
  `is_active`                TINYINT(1) NOT NULL DEFAULT 1,
  `created_by_user_id`       BIGINT,
  `created_at`               DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at`               DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  `deleted_at`               DATETIME DEFAULT NULL,
  FOREIGN KEY (`reward_product_id`) REFERENCES `products`(`id`) ON DELETE SET NULL,
  FOREIGN KEY (`reward_variant_id`) REFERENCES `product_variants`(`id`) ON DELETE SET NULL,
  FOREIGN KEY (`created_by_user_id`) REFERENCES `users`(`id`),
  INDEX `idx_reward_active`  (`is_active`, `valid_until`),
  INDEX `idx_reward_cost`    (`cost_point`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
```

### 6.5 Tabel `member_reward_claims`
Catatan setiap kali member klaim reward.

```sql
CREATE TABLE IF NOT EXISTS `member_reward_claims` (
  `id`                  BIGINT AUTO_INCREMENT PRIMARY KEY,
  `member_id`           BIGINT NOT NULL,
  `reward_id`           BIGINT NOT NULL,
  `redemption_code`     VARCHAR(20) NOT NULL UNIQUE,
  `redemption_qr_token` VARCHAR(128) NOT NULL,
  `cost_point`          INT NOT NULL,            -- snapshot saat klaim
  `status`              ENUM('pending_approval','redeemable','redeemed','cancelled','expired') NOT NULL DEFAULT 'redeemable',
  `transaction_id`      INT DEFAULT NULL,        -- diisi saat status=redeemed
  `redeemed_by_user_id` BIGINT DEFAULT NULL,     -- kasir yang redeem
  `redeemed_at_branch_id` BIGINT DEFAULT NULL,
  `claimed_at`          DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `expires_at`          DATETIME NOT NULL,       -- default claim + 30 hari
  `approved_at`         DATETIME DEFAULT NULL,
  `approved_by_user_id` BIGINT DEFAULT NULL,
  `redeemed_at`         DATETIME DEFAULT NULL,
  `cancelled_at`        DATETIME DEFAULT NULL,
  `cancel_reason`       TEXT,
  `notes`               TEXT,
  FOREIGN KEY (`member_id`)            REFERENCES `members`(`id`),
  FOREIGN KEY (`reward_id`)            REFERENCES `member_rewards`(`id`),
  FOREIGN KEY (`transaction_id`)       REFERENCES `transactions`(`id`),
  FOREIGN KEY (`redeemed_by_user_id`)  REFERENCES `users`(`id`),
  FOREIGN KEY (`redeemed_at_branch_id`) REFERENCES `branches`(`id`),
  FOREIGN KEY (`approved_by_user_id`)  REFERENCES `users`(`id`),
  INDEX `idx_claim_member`  (`member_id`, `status`),
  INDEX `idx_claim_status`  (`status`, `expires_at`),
  INDEX `idx_claim_reward`  (`reward_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
```

### 6.6 Tabel `member_fraud_flags`
Catatan flag fraud dari sistem deteksi atau manual admin.

```sql
CREATE TABLE IF NOT EXISTS `member_fraud_flags` (
  `id`              BIGINT AUTO_INCREMENT PRIMARY KEY,
  `member_id`       BIGINT,
  `staff_user_id`   BIGINT,
  `transaction_id`  INT DEFAULT NULL,
  `flag_type`       VARCHAR(80) NOT NULL,
    -- contoh: 'self_transaction', 'too_many_tx_per_day', 'small_tx_repetition',
    --         'cashier_member_pattern', 'rapid_redemption', 'late_attach_member'
  `severity`        ENUM('low','medium','high','critical') NOT NULL DEFAULT 'medium',
  `risk_score`      INT NOT NULL DEFAULT 50,    -- 0–100
  `detected_at`     DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `evidence`        JSON,                       -- detail metrik yang men-trigger
  `status`          ENUM('open','acknowledged','dismissed','action_taken') NOT NULL DEFAULT 'open',
  `reviewed_by_user_id` BIGINT DEFAULT NULL,
  `reviewed_at`     DATETIME DEFAULT NULL,
  `resolution_note` TEXT,
  FOREIGN KEY (`member_id`)         REFERENCES `members`(`id`),
  FOREIGN KEY (`staff_user_id`)     REFERENCES `users`(`id`),
  FOREIGN KEY (`transaction_id`)    REFERENCES `transactions`(`id`),
  FOREIGN KEY (`reviewed_by_user_id`) REFERENCES `users`(`id`),
  INDEX `idx_flag_status_severity` (`status`, `severity`, `detected_at`),
  INDEX `idx_flag_member`          (`member_id`),
  INDEX `idx_flag_staff`           (`staff_user_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
```

### 6.7 Tabel `member_settings`
Key-value setting global (mirip kalau ada `system_settings`).

```sql
CREATE TABLE IF NOT EXISTS `member_settings` (
  `setting_key`   VARCHAR(80) NOT NULL PRIMARY KEY,
  `setting_value` TEXT NOT NULL,
  `value_type`    ENUM('int','decimal','bool','string','json') NOT NULL DEFAULT 'string',
  `description`   TEXT,
  `updated_by_user_id` BIGINT,
  `updated_at`    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  FOREIGN KEY (`updated_by_user_id`) REFERENCES `users`(`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
```

Seed default:
```sql
INSERT IGNORE INTO `member_settings` (`setting_key`,`setting_value`,`value_type`,`description`) VALUES
  ('enable_loyalty_module','0','bool','Master switch fitur member'),
  ('point_ratio_rupiah_per_point','10000','int','Setiap N rupiah = 1 point'),
  ('point_rounding_mode','floor','string','floor|round|ceil'),
  ('min_transaction_for_point','0','int','Minimum total transaksi agar dapat point'),
  ('max_point_per_transaction','1000','int','Batas atas point per transaksi'),
  ('max_point_per_member_per_day','50','int','Anti-fraud: batas point per member per hari'),
  ('point_validity_days','365','int','Masa berlaku point dalam hari, 0=unlimited'),
  ('point_pending_window_hours','24','int','Jam pending sebelum aktif'),
  ('excluded_product_ids','[]','json','Array product_id yang tidak dapat point'),
  ('excluded_category_ids','[]','json','Array category_id yang tidak dapat point'),
  ('point_on_reward_transaction','0','bool','Apakah transaksi yang mengandung reward dapat point'),
  ('member_late_attach_window_minutes','5','int','Anti-fraud: window attach member setelah transaksi selesai'),
  ('require_qr_scan_for_member','0','bool','Wajib scan QR (bukan input HP manual)');
```

### 6.8 Tabel `member_audit_logs`
Catatan khusus audit aktivitas loyalty (selain `audit_logs` umum). Optional — bisa pakai `audit_logs` existing dengan `action` prefix `member_*`.

**Rekomendasi: pakai `audit_logs` yang sudah ada** (`api.php` punya helper `auditLog()` di line 257-279), dengan konvensi:
- `action`: `member_register`, `member_login`, `member_attach_tx`, `member_earn_point`, `member_claim_reward`, `member_redeem`, `member_manual_adjust`, `member_settings_update`, `member_reward_crud`, dst.
- `table_name`: tabel terkait.
- `old_data`/`new_data`: snapshot perubahan.

Ini menghindari fragmentasi audit dan memanfaatkan index existing.

### 6.9 Modifikasi Tabel Existing
Hanya **2 kolom tambahan** ke `transactions` (non-breaking, semua nullable, default NULL).

```sql
ALTER TABLE `transactions`
  ADD COLUMN `member_id`           BIGINT DEFAULT NULL AFTER `session_id`,
  ADD COLUMN `member_attached_at`  DATETIME DEFAULT NULL AFTER `member_id`,
  ADD COLUMN `points_awarded`      INT NOT NULL DEFAULT 0 AFTER `member_attached_at`,
  ADD COLUMN `reward_claim_id`     BIGINT DEFAULT NULL AFTER `points_awarded`,
  ADD CONSTRAINT `fk_tx_member`   FOREIGN KEY (`member_id`)       REFERENCES `members`(`id`),
  ADD CONSTRAINT `fk_tx_claim`    FOREIGN KEY (`reward_claim_id`) REFERENCES `member_reward_claims`(`id`),
  ADD INDEX `idx_tx_member` (`member_id`, `created_at`);
```

> **Migrasi disarankan via file SQL baru**: `sql/migrations/064_member_loyalty_schema.sql`. Sesuai feedback memory (`feedback_supabase_migration.md`) yang mengatakan jangan buat migration untuk *logic fix*, tapi ini adalah **fitur baru dengan schema baru** — wajib migration.

### 6.10 ER Diagram (Tekstual)

```
branches ──┬──< members (signup_branch_id)
           │       │
           │       ├──< member_sessions
           │       ├──< member_point_ledger >── transactions
           │       │                              │
           │       │                              └──< transaction_items
           │       └──< member_reward_claims ─── member_rewards
           │              │                              │
           │              └──> transactions              │
           │                                             │
           └────────< member_fraud_flags ──> users (staff_user_id)
                                          └─> members

users (existing) ──┬──< members.staff_link_user_id (anti-fraud link)
                   ├──< member_point_ledger.created_by_user_id
                   ├──< member_reward_claims.redeemed_by_user_id
                   ├──< member_rewards.created_by_user_id
                   └──< member_settings.updated_by_user_id
```

---

## 7. API & Endpoint

Mengikuti pola PostgREST-style di `api/api.php`. Tabel baru otomatis bisa di-CRUD via REST kalau ditambahkan ke whitelist (`api.php:81-98`). RPC custom ditambahkan di handler RPC (`api.php:1282+`).

### 7.1 Tabel di Whitelist (REST)
Tambahkan ke array tabel yang diizinkan di `api.php`:
- `members` (read: admin all, member self only)
- `member_rewards` (read: all authenticated; write: admin only)
- `member_reward_claims` (read: admin all, member self)
- `member_point_ledger` (read: admin all, member self; **write: tidak ada — hanya via RPC**)
- `member_fraud_flags` (admin only)
- `member_settings` (read: admin/staff; write: admin only)

> `member_sessions` dan `member_point_ledger` write **tidak boleh** via REST direct — wajib via RPC supaya logic balance & validasi tetap terjaga. Atur di `api.php` column-write blacklist.

### 7.2 RPC Endpoints

Format URL: `POST /api/api.php/rpc/<rpc_name>` dengan JSON body. Header `X-API-Key` wajib. Authentication via `X-Session-Token` (staff) atau `X-Member-Session-Token` (member).

#### A. Authentication Member

| RPC | Method | Role | Request | Response |
| --- | --- | --- | --- | --- |
| `member_register` | POST | Public (rate limited) | `{phone, name, password, email?, birth_date?, gender?, signup_branch_id?}` | `{member: {id, member_code, ...}, session_token}` |
| `member_login` | POST | Public (rate limited) | `{identifier, password}` (identifier = phone atau email) | `{member, session_token, expires_at}` |
| `member_logout` | POST | Member | (none) | `{ok: true}` |
| `member_request_otp` | POST | Public (Fase 2) | `{phone, purpose: 'register'\|'login'\|'reset_password'}` | `{ok, otp_id, expires_at}` |
| `member_verify_otp` | POST | Public (Fase 2) | `{otp_id, code}` | `{ok, token?}` |
| `member_forgot_password` | POST | Public | `{phone}` | `{ok}` (Fase 1: admin notified; Fase 2: kirim OTP) |
| `member_change_password` | POST | Member | `{old_password, new_password}` | `{ok}` |

Rate limit:
- `member_register`: 5 / jam per IP.
- `member_login`: 10 / 5 menit per phone + 30 / 5 menit per IP.
- `member_request_otp`: 3 / 10 menit per phone.

Validasi:
- `phone`: regex `^08[0-9]{8,12}$` (Indonesia mobile).
- `password`: min 8 char, must contain letter+number.
- `name`: 2–80 char, trim, strip HTML.
- `email`: format email valid.

Security check:
- Cek tabel `members.phone` duplicate sebelum INSERT.
- Hash password dengan `password_hash($pw, PASSWORD_BCRYPT)`.
- Generate `member_code` & `qr_secret`.
- Audit log entry `member_register`.

#### B. Profile & Balance (Member self)

| RPC | Method | Role | Request | Response |
| --- | --- | --- | --- | --- |
| `member_me` | GET/POST | Member | (none, dari session) | `{member, balance: {active, pending, reserved}, expiring_soon: [...]}` |
| `member_update_profile` | POST | Member | `{name?, email?, birth_date?, gender?, current_password}` | `{ok, member}` |
| `member_request_change_phone` | POST | Member (Fase 2) | `{new_phone, current_password}` | `{ok, otp_id}` |
| `member_get_balance` | GET | Member self / Admin | `{member_id?}` | `{active, pending, reserved, lifetime_earned, lifetime_redeemed}` |
| `member_get_point_history` | GET | Member self / Admin | `{member_id?, from?, to?, limit, offset}` | `[{ledger entries}]` |
| `member_get_transaction_history` | GET | Member self / Admin | `{member_id?, from?, to?, limit, offset}` | `[{tx with items}]` |

#### C. Cashier Workflow (Staff)

| RPC | Method | Role | Request | Response | Catatan |
| --- | --- | --- | --- | --- | --- |
| `member_lookup` | POST | Staff/Admin | `{query, branch_id}` (query=phone atau member_code) | `{member: {id, name, code, balance_active, phone_masked}}` | Mask HP: `0812***1234` |
| `member_validate_qr` | POST | Staff/Admin | `{qr_token, branch_id}` | `{ok, member}` | Cek signature & expiry QR |
| `member_attach_to_transaction` | POST | Staff/Admin | `{client_tx_id, member_id}` | `{ok, preview_points}` | Dipanggil **sebelum** `process_transaction`. Hanya simpan reservasi in-memory/cache. |
| `member_preview_points` | POST | Staff/Admin | `{member_id, subtotal, items: [...]}` | `{points_to_earn, reason_if_zero}` | Tidak menulis DB |
| `member_redeem_at_cashier` | POST | Staff/Admin | `{redemption_code, transaction_id?, branch_id}` | `{ok, claim, discount_applied}` | Validasi kode, set status `redeemed` |
| `member_unattach_from_transaction` | POST | Staff/Admin | `{transaction_id, reason}` | `{ok}` | Hanya dalam window `member_late_attach_window_minutes`. Audit log. |

#### D. Reward (Member)

| RPC | Method | Role | Request | Response |
| --- | --- | --- | --- | --- |
| `member_list_rewards` | GET | Member | `{branch_id?}` | `[{reward objects, can_claim, reason_if_not}]` |
| `member_claim_reward` | POST | Member | `{reward_id}` | `{ok, claim: {redemption_code, qr, expires_at}}` |
| `member_cancel_claim` | POST | Member | `{claim_id}` | `{ok, points_refunded}` |

#### E. Admin Management

| RPC | Method | Role | Request | Response |
| --- | --- | --- | --- | --- |
| `member_admin_search` | GET | Admin | `{query?, is_active?, sort, limit, offset}` | `[{members}]` |
| `member_admin_get_detail` | GET | Admin | `{member_id}` | `{member, balance, recent_tx, recent_ledger, flags}` |
| `member_admin_set_active` | POST | Admin | `{member_id, is_active, reason}` | `{ok}` |
| `member_admin_set_staff_link` | POST | Admin | `{member_id, staff_user_id, reason}` | `{ok}` |
| `member_admin_manual_adjust` | POST | Admin | `{member_id, direction: 'in'\|'out', points, reason}` | `{ok, ledger_entry}` |
| `member_admin_lock_points` | POST | Admin | `{member_id, points, reason, related_flag_id?}` | `{ok}` |
| `member_admin_unlock_points` | POST | Admin | `{member_id, points, reason}` | `{ok}` |
| `member_admin_reset_password` | POST | Admin | `{member_id}` | `{ok, temp_password}` |
| `member_admin_void_claim` | POST | Admin | `{claim_id, reason}` | `{ok}` |
| `member_admin_approve_claim` | POST | Admin | `{claim_id}` | `{ok}` |

Manual adjustment **wajib** isi `reason` (min 10 char). Audit log entry `member_manual_adjust`.

#### F. Reward CRUD (Admin)

REST endpoint pakai pattern existing — table `member_rewards`:
- `GET /api/api.php/member_rewards?is_active=eq.1&order=cost_point.asc`
- `POST /api/api.php/member_rewards` (admin only — divalidasi di `api.php` scope)
- `PATCH /api/api.php/member_rewards?id=eq.5`
- `DELETE` → soft delete via `deleted_at`

#### G. Settings (Admin)

- `GET /api/api.php/member_settings` (admin/staff read).
- `PATCH /api/api.php/member_settings?setting_key=eq.point_ratio_rupiah_per_point` (admin only).

#### H. Fraud & Audit (Admin)

| RPC | Method | Role | Request | Response |
| --- | --- | --- | --- | --- |
| `member_fraud_dashboard` | GET | Admin | `{from?, to?, severity?, status?}` | `{summary: {open, critical, ...}, flags: [...]}` |
| `member_fraud_resolve` | POST | Admin | `{flag_id, status: 'dismissed'\|'action_taken', resolution_note}` | `{ok}` |
| `member_fraud_run_scan` | POST | Admin | `{from, to}` | `{flags_created: N}` | Trigger manual scan. Otomatis run nightly via cron. |
| `member_audit_export` | GET | Admin | `{from, to, member_id?, format: 'csv'\|'json'}` | file/JSON |

### 7.3 Response Convention
Sesuai pola existing (`api.php`):
- Success: HTTP 200, body `{data, error: null}` atau langsung object/array.
- Error: HTTP 4xx/5xx, body `{error: {message, code}}`.

Error code yang dipakai:
- `MEMBER_NOT_FOUND`, `MEMBER_INACTIVE`, `PHONE_ALREADY_EXISTS`, `INVALID_OTP`,
- `INSUFFICIENT_POINTS`, `REWARD_OUT_OF_STOCK`, `REWARD_EXPIRED`, `CLAIM_EXPIRED`,
- `CLAIM_ALREADY_REDEEMED`, `RATE_LIMITED`, `SELF_TRANSACTION_BLOCKED`,
- `DAILY_POINT_LIMIT_EXCEEDED`, `INVALID_QR_SIGNATURE`,
- `LATE_ATTACH_WINDOW_EXPIRED`, `PERMISSION_DENIED`, `VALIDATION_FAILED`.

### 7.4 Idempotency
Mengikuti pola transaksi (`migration 059`):
- `member_attach_to_transaction` → idempotent berdasarkan `client_tx_id`.
- `member_claim_reward` → idempotent berdasarkan `Idempotency-Key` header (opsional).
- `member_redeem_at_cashier` → idempotent berdasarkan `redemption_code` (unique constraint sudah menjamin).

### 7.5 Security Checklist Per Endpoint
Setiap endpoint baru WAJIB lulus check:
- [ ] `X-API-Key` divalidasi.
- [ ] Authentication header divalidasi sesuai role.
- [ ] Rate limit applied via `rateLimitAction()` (`api.php:230`).
- [ ] Input divalidasi tipe + range.
- [ ] Query pakai prepared statement (PDO).
- [ ] Audit log untuk semua operasi write.
- [ ] Branch scope di-enforce via `requireBranchAccess()`.
- [ ] Tidak return PII member lain (mask phone, hide email).
- [ ] Error message generik untuk 500 (tidak leak stack trace ke client).

---

## 8. Halaman & UI/UX

### 8.1 Halaman Admin (`admin.html` — tambah tab baru "Member")

Struktur tab "Member" (sidebar level 2):

1. **Dashboard Loyalty**
   - Card: Total Member, Member Aktif Bulan Ini, Total Point Beredar, Total Point Terklaim Bulan Ini.
   - Chart: tren member baru per minggu (line chart).
   - Chart: distribusi point earn vs redeem (bar chart).
   - Top 10 Member by point.
   - Top 5 Reward terbanyak diklaim.

2. **Kelola Member**
   - Tabel: kode, nama, HP, point aktif, tx terakhir, status. Search + filter (aktif/nonaktif).
   - Action per row: detail, edit, nonaktifkan, manual adjust point, reset password.
   - Tombol "Tambah Member Manual" (untuk pelanggan walk-in yang diregister kasir).
   - Bulk: export CSV.

3. **Detail Member**
   - Sub-tab: Profil, Histori Point (ledger), Histori Transaksi, Klaim Reward, Fraud Flags.
   - Profil: full info + tombol "Flag sebagai Staff Link" (anti-fraud).
   - Histori Point: tabel ledger dengan filter movement_type.
   - Histori Transaksi: tabel transaksi member, link ke detail tx.

4. **Kelola Reward**
   - Tabel: nama, type, cost, kuota, valid until, status.
   - Form CRUD reward (modal/drawer).
   - Toggle aktif/nonaktif.
   - Preview reward seperti tampilan member.

5. **Aturan Point (Settings)**
   - Form edit semua `member_settings`. Tombol "Simpan" → audit log.
   - Warning kalau ubah `point_ratio_rupiah_per_point` (mempengaruhi semua transaksi mendatang).
   - Toggle besar "Aktifkan Modul Loyalty" (master switch).

6. **Klaim Reward (Approval Queue)**
   - Hanya tampil kalau ada reward dengan `requires_admin_approval=1`.
   - List klaim status `pending_approval`, tombol Approve/Reject.

7. **Fraud Monitoring**
   - Filter: severity, status, periode.
   - Tabel flag dengan kolom evidence preview.
   - Action: Acknowledge, Dismiss, Take Action (kunci point, nonaktifkan member, dst.).
   - Tombol "Scan Manual" untuk run detector ad-hoc.

8. **Audit Log**
   - Filter di `audit_logs` dengan `action LIKE 'member_%'`.
   - Tampilan diff old_data vs new_data.

### 8.2 Halaman Kasir (`pos.html` — modifikasi minimal)

Penambahan:

1. **Panel Member di samping cart**
   - Default state: "Tanpa Member" + tombol "Cari/Pilih Member".
   - Setelah pilih: tampilkan card kecil — nama, kode, point aktif, preview point dari transaksi ini.
   - Tombol "Lepas Member" (kalau salah pilih).

2. **Modal "Cari Member"**
   - 2 tab: "Scan QR" (kamera) + "Cari HP/Kode".
   - Saat HP ditemukan: konfirmasi 4 digit terakhir HP (visual).
   - Tombol "Daftarkan Member Baru" (mini-form: HP+nama+password default).

3. **Modal "Redeem Reward"**
   - Tombol di toolbar POS (icon gift).
   - Scan QR / input kode klaim.
   - Setelah valid: tampilkan reward, tombol "Apply ke Transaksi Saat Ini".

4. **Preview Point di Checkout Summary**
   - Di atas tombol "Bayar": "Member akan dapat: +N point" (kalau ada member attached).
   - Warning kuning kalau anti-fraud terdeteksi: "⚠️ Transaksi ini akan masuk review (kasir = member)".

5. **Indikator Status Modul Loyalty**
   - Kalau `enable_loyalty_module=0`, panel member disembunyikan/disabled — UI POS lama tetap utuh.

### 8.3 Halaman Member (file baru: `member.html` + `js/member.js`)

PWA standalone, satu file HTML.

1. **Landing / Login** (`#login`)
   - Logo RBN, form: nomor HP / email + password, tombol login.
   - Link: "Daftar di sini" + "Lupa Password".

2. **Register** (`#register`)
   - Form: nama, HP, email (opsional), password, konfirmasi password, tanggal lahir (opsional).
   - Checkbox "Saya setuju S&K".

3. **Dashboard** (`#dashboard`)
   - Card besar: nama + kode + QR code (tombol perbesar).
   - Stat: Point Aktif (besar) + Pending (kecil).
   - Banner: "🔥 Reward bisa diklaim: 3" (kalau ada).
   - Section: 3 reward terdekat (cost ≤ saldo + 50%).
   - Section: 5 transaksi terakhir.

4. **Profil** (`#profile`)
   - Form edit nama, email, gender, tanggal lahir.
   - Tombol "Ubah Password".
   - Tombol "Ubah Nomor HP" (Fase 2).

5. **Histori Transaksi** (`#history-tx`)
   - Infinite scroll. Filter periode.
   - Detail expand: list item, total, point earned/redeemed.

6. **Histori Point** (`#history-point`)
   - List ledger entry dengan icon (in/out), tanggal, reason.

7. **Daftar Reward** (`#rewards`)
   - Grid card reward. Filter: "Bisa Saya Klaim" / "Semua".
   - Card: gambar, nama, cost, kuota tersisa, tombol "Klaim" (disabled kalau tidak cukup).

8. **Detail Reward** (`#reward-detail`)
   - Full info, S&K, tombol "Klaim Sekarang" (modal konfirmasi).

9. **Status Klaim** (`#my-claims`)
   - List klaim aktif (status redeemable): tampilkan QR & kode besar + countdown expiry.
   - List klaim history (redeemed/cancelled/expired).

### 8.4 UI/UX Notes
- Pakai design system existing: CSS variables (`--primary`, `--text`, `--border`), Lucide icons.
- Mobile-first untuk member page (mayoritas akses dari HP).
- Loading state + empty state untuk semua list.
- Error toast pakai pola yang sudah ada di `ui.js`.
- A11y: kontras minimal AA, label form jelas.

---

## 9. User Flow

### 9.1 Member Daftar Akun
1. Buka `member.html` → klik "Daftar".
2. Isi form (nama, HP, password, opsional email & DOB) → submit.
3. Frontend POST ke `rpc/member_register`.
4. Backend: validasi → cek HP unik → hash password → insert `members` → buat `member_code` + `qr_secret` → audit log → return session_token.
5. Redirect ke dashboard, QR code langsung visible.

### 9.2 Member Login
1. Input HP/email + password → submit.
2. POST `rpc/member_login` → cek hash → buat session → return token.
3. Frontend simpan token di `localStorage.member_session`.
4. Redirect ke dashboard.

### 9.3 Member Belanja & Dapat Point
**Aktor:** Member di outlet, Kasir.

1. Pelanggan: "Saya member, bos."
2. Kasir klik panel "Cari Member" → pilih tab "Scan QR".
3. Member buka app → tab QR (atau buka dashboard, QR sudah visible).
4. Kasir scan QR.
5. Sistem `rpc/member_validate_qr` → cek signature → return member.
6. Panel member di POS update: nama, point aktif, preview point.
7. Kasir lanjut tambah produk, tekan "Bayar".
8. Frontend kirim `rpc_process_transaction` dengan field tambahan `member_id` & `client_tx_id`.
9. Backend (single transaction):
   - INSERT transactions (dengan `member_id`).
   - INSERT transaction_items.
   - Hitung point: `floor(subtotal_eligible / point_ratio_rupiah_per_point)`.
   - Cek limit harian member → kalau over, tetap simpan transaksi tapi `points_awarded=0` + audit warning.
   - Cek anti-fraud (lihat §14.2) → kalau `self_transaction` terdeteksi, point=0 + insert `member_fraud_flags`.
   - INSERT `member_point_ledger` dengan movement_type=`earn_pending` (kalau setting pending) atau `earn_purchase` (kalau langsung aktif).
   - Update `members.lifetime_points_earned` (counter).
10. Return ke kasir: success + total point baru member.
11. Cetak struk dengan info "+N point — Total point: M".

### 9.4 Pending Point → Active
**Trigger:** cron job tiap 1 jam, atau saat shift close.

1. Cron query `member_point_ledger WHERE movement_type='earn_pending' AND created_at + pending_window <= NOW() AND NOT EXISTS (rollback)`.
2. Untuk tiap row → INSERT ledger baru `pending_to_active`.
3. Saldo aktif bertambah, pending berkurang.

### 9.5 Member Klaim Reward
1. Member di app, buka tab Reward → klik reward yang diinginkan → klik "Klaim".
2. POST `rpc/member_claim_reward` → cek balance → cek kuota → INSERT `member_reward_claims` (status `redeemable` atau `pending_approval`) → INSERT ledger `redeem_reserve` (point langsung dipotong).
3. Frontend tampilkan QR + kode klaim besar dengan countdown 30 hari.

### 9.6 Kasir Memproses Reward
1. Pelanggan datang ke kasir, tunjukkan QR klaim.
2. Kasir tekan tombol "Redeem Reward" di POS.
3. Modal terbuka → kasir scan QR atau input kode.
4. POST `rpc/member_redeem_at_cashier` dengan `redemption_code` + `transaction_id` (kalau ada cart aktif).
5. Backend: cek code → cek expiry → cek status (`redeemable`).
6. Update `claim.status='redeemed'`, set `redeemed_by_user_id`, `redeemed_at`, `transaction_id`.
7. INSERT ledger `redeem_commit` (commit penurunan saldo).
8. Kalau type=`free_product`: tambahkan item produk ke cart dengan price=0.
9. Kalau type=`discount`: kurangi total transaksi.
10. Audit log.

### 9.7 Transaksi Dibatalkan / Refund
1. Admin klik refund di `pos.html` Laporan.
2. POST `rpc_void_transaction` atau `rpc_refund_transaction`.
3. Backend (di RPC tersebut, modifikasi):
   - Update `transactions.status='voided'|'refunded'`.
   - Kalau ada `points_awarded > 0`: INSERT ledger `refund_reversal` (direction=out, points=points_awarded).
   - Kalau ada `reward_claim_id`: update claim status=`cancelled`, INSERT ledger `redemption_refund` (direction=in).
   - Kalau refund partial: hitung proporsi point yang dibalikkan (round down).
4. Audit log.

### 9.8 Admin Membuat Reward
1. Admin → tab Member → Kelola Reward → "Buat Reward Baru".
2. Form modal → submit.
3. POST `/api/api.php/member_rewards` → validate → INSERT → audit log.
4. List refresh.

### 9.9 Admin Mengubah Aturan Point
1. Admin → tab Member → Aturan Point.
2. Edit value → "Simpan".
3. PATCH `/api/api.php/member_settings?setting_key=eq.X`.
4. Backend: validate range → UPDATE → audit log (with old_value+new_value).
5. Toast sukses.

### 9.10 Admin Mengecek Fraud
1. Admin → tab Member → Fraud Monitoring.
2. List flag terbuka (status=open) urut severity.
3. Klik detail → lihat evidence (transaksi terkait, member, staff).
4. Tindakan: Dismiss / Lock Points / Nonaktifkan Member.

### 9.11 Admin Membatalkan Point Mencurigakan
1. Dari detail member atau dari flag.
2. Klik "Lock Points" → input jumlah & alasan.
3. POST `rpc/member_admin_lock_points` → INSERT ledger `fraud_lock` (direction=out).
4. Audit log.

---

## 10. Aturan Point & Reward

### 10.1 Rumus Hitung Point
```
eligible_subtotal = subtotal
                  - sum(item.subtotal for item in cart if product_id in excluded_product_ids)
                  - sum(item.subtotal for item in cart if category_id in excluded_category_ids)
                  - (reward_discount kalau point_on_reward_transaction=0)

if eligible_subtotal < min_transaction_for_point:
    points = 0
else:
    raw = eligible_subtotal / point_ratio_rupiah_per_point
    points = apply_rounding(raw, point_rounding_mode)
    points = min(points, max_point_per_transaction)
    points = min(points, remaining_daily_quota(member))
    if self_transaction_detected: points = 0
```

### 10.2 Lifecycle State Point
```
[earn_pending] --(after pending_window)--> [earn_active] --(redeem)--> [redeemed]
       |                                          |
       +---(refund within window)---> [reversed]  +---(expire after validity)---> [expired]
                                                  +---(fraud_lock)---> [locked]
```

State **tidak disimpan eksplisit per row** — selalu dihitung dari ledger. Tabel `members.balance_*` di-cache untuk performance saja (recompute periodik).

### 10.3 Aturan Reward
- Reward `free_product` → saat redeem, tambahkan item ke cart dengan `price=0`, `notes='Reward: <reward.name>'`. Item ini tetap mengurangi inventory (via recipe).
- Reward `discount_amount` → `transactions.discount_amount += value` saat redeem. Tidak lebih besar dari subtotal.
- Reward `discount_percent` → `discount = subtotal * value/100`, max cap configurable.
- Reward dengan `requires_admin_approval=1`: status klaim awal = `pending_approval`. Member lihat status "Menunggu Persetujuan". Admin approve → status=`redeemable`. Kalau reject → status=`cancelled`, point dikembalikan.

### 10.4 Validitas & Expiry Point
- Setiap entry `earn_purchase` / `earn_active` punya `expires_at = created_at + point_validity_days`.
- Cron harian scan ledger entry yang `expires_at < NOW()` dan belum dipakai → INSERT `expire` ledger.
- Saldo aktif dihitung dengan filter `expires_at IS NULL OR expires_at > NOW()`.
- Member dapat warning di dashboard kalau ada point akan expired dalam 30 hari.

### 10.5 Order Pemakaian Point (FIFO)
Saat redeem, point lama dipakai dulu (FIFO) supaya member tidak rugi karena expiry. Implementasi: di RPC `member_claim_reward`, alokasi `redeem_reserve` ditelusuri ke earn entries lama ke baru.

> Untuk Fase 1 boleh disederhanakan: tidak track per-batch, hanya saldo total. FIFO bisa Fase 3.

---

## 11. Integrasi dengan Sistem POS Existing

### 11.1 Prinsip Dasar
1. **Tidak boleh menghapus / mengubah** kolom existing di tabel apapun.
2. Hanya **menambah kolom nullable** dengan default sehingga code lama tetap jalan.
3. RPC existing (`rpc_process_transaction`, `rpc_void_transaction`) dimodifikasi dengan **branch opt-in** — kalau `enable_loyalty_module=0` atau `member_id=null`, behavior 100% sama seperti sekarang.
4. UI loyalty di POS pakai feature flag — kalau modul off, panel member tidak render.

### 11.2 Modifikasi di `rpc_process_transaction`
Tambahkan parameter opsional:
- `p_member_id BIGINT DEFAULT NULL`
- `p_redemption_code VARCHAR(20) DEFAULT NULL` (kalau pakai reward sekaligus)

Setelah INSERT transaction sukses, di **stored procedure / PHP RPC** tambah blok:
```
IF p_member_id IS NOT NULL AND enable_loyalty_module=1 THEN
  // 1. Validasi anti-fraud
  // 2. Hitung points
  // 3. INSERT member_point_ledger
  // 4. UPDATE transactions SET member_id=p_member_id, points_awarded=N
  // 5. (kalau ada redemption_code) panggil sub-routine redeem
END IF
```

Atomic dalam satu transaction DB. Kalau insert ledger gagal, ROLLBACK transaksi penjualan.

> Catatan engineering: kalau `rpc_process_transaction` saat ini adalah **stored procedure MySQL**, modifikasi dilakukan di sana. Kalau implementasi **PHP function** di `api.php`, modifikasi di PHP function. Cek `api.php` line search "rpc_process_transaction" sebelum coding.

### 11.3 Modifikasi di Refund/Void RPC
- `rpc_void_transaction` → sebelum mark voided, cek `points_awarded > 0`, kalau ya → INSERT `refund_reversal` ledger.
- Sama untuk refund partial.

### 11.4 Tidak Mengganggu Cash Ledger
- Point bukan cash → tidak ada entry ke `branch_cash_ledger`.
- Reward `discount_amount` → kurangi `transactions.total` dan `transactions.discount_amount` (kolom existing) → cash ledger menerima total yang sudah dikurangi → konsisten.
- Reward `free_product` → item tambahan dengan price=0 → tidak menambah total → cash ledger tidak terpengaruh.

### 11.5 Inventory Tetap Konsisten
Reward `free_product` saat di-redeem → item masuk `transaction_items` dengan `price=0`. Karena inventory deduction ditrigger oleh `transaction_items` (via recipe), stok ingredient tetap berkurang seperti transaksi normal. **Bukan bug — ini fitur:** bahan baku roti bakar gratis tetap harus dikurangi dari stok.

### 11.6 Multi-Outlet
- Member adalah entitas global (lintas cabang).
- Point bisa earn & redeem di cabang manapun (default Fase 1).
- Setting `branch_scope` di reward bisa membatasi reward khusus cabang.

### 11.7 Investor Privacy
- Endpoint investor existing tidak boleh diberi akses ke tabel `members` atau `member_point_ledger`.
- Tambahkan ke deny list di `api.php` scope investor.

### 11.8 Backup & Restore
- Migration SQL ditaruh di `sql/migrations/064_member_loyalty_schema.sql`.
- Sebelum run di production: backup DB dulu (sudah jadi SOP).
- Migration idempotent (`CREATE TABLE IF NOT EXISTS`, `ALTER TABLE ADD COLUMN IF NOT EXISTS` — note: MySQL 8 tidak support `IF NOT EXISTS` di ADD COLUMN, jadi cek dulu via `INFORMATION_SCHEMA`).

### 11.9 Rollback Plan
Kalau ada masalah parah pasca-deploy:
1. Set `member_settings.enable_loyalty_module='0'`.
2. UI member tidak terlihat lagi di POS.
3. Transaksi baru tidak menulis ke ledger.
4. Data historis tetap utuh.
5. (Worst case) DROP TABLE member_* — data hilang tapi POS tetap jalan karena kolom `transactions.member_id` nullable.

---

## 12. Edge Case

| No | Edge Case | Penanganan |
| --- | --- | --- |
| 1 | Transaksi dibatalkan setelah point masuk | RPC void/refund INSERT `refund_reversal` ledger. Kalau `earn_pending` belum aktif → tetap reverse. Kalau sudah dipakai redeem partial → kurangi saldo aktif sebanyak yang reversible; sisanya beri flag `over_redeem_after_refund` ke admin. |
| 2 | Transaksi refund sebagian | Hitung proporsi: `point_refund = floor(refund_amount / point_ratio)`. Tidak lebih dari `points_awarded`. |
| 3 | Member lupa password | Fase 1: admin reset manual. Fase 2: OTP ke HP. |
| 4 | Nomor HP sudah terdaftar | Saat register: error `PHONE_ALREADY_EXISTS`. Member arahkan ke login atau forgot password. |
| 5 | Member ganti nomor HP | Fase 1: admin update manual via `member_admin_search`. Fase 2: self-service via OTP ke nomor baru + verifikasi password. |
| 6 | Kasir salah pilih member | Tombol "Lepas Member" sebelum transaksi disimpan (no DB write). Setelah disimpan, dalam window `member_late_attach_window_minutes` (default 5 menit), kasir bisa `member_unattach_from_transaction` dengan alasan. Setelah window → harus admin. Semua tindakan audit log. |
| 7 | Member klaim reward tapi stok produk habis | Saat redeem di kasir, sistem cek inventory. Kalau habis: error `OUT_OF_STOCK`, klaim tetap aktif (member bisa redeem nanti). |
| 8 | Reward sudah nonaktif setelah klaim | Klaim yang sudah `redeemable` tetap valid sampai expiry. Reward `is_active=0` hanya hide dari listing baru. |
| 9 | Point kurang | Error `INSUFFICIENT_POINTS`, tampilkan kekurangan. |
| 10 | Point expired | Cron harian INSERT `expire` ledger. Member dapat notifikasi (Fase 2). |
| 11 | Member dinonaktifkan (`is_active=0`) | Tidak bisa login. Point freeze (tidak earn/redeem). Histori tetap visible ke admin. |
| 12 | Koneksi internet putus saat transaksi | Frontend sudah punya `client_tx_id` dari migration 059 → retry idempotent. Point hanya masuk kalau transaksi tercatat. |
| 13 | Transaksi double submit | Existing protection via `client_tx_id` UNIQUE constraint. Point juga tidak dobel. |
| 14 | Kasir mencoba tambah point manual | Tidak ada endpoint untuk staff. RPC `member_admin_manual_adjust` hanya admin/owner. |
| 15 | Staff mencoba pakai akun member sendiri | Anti-fraud `self_transaction` mendeteksi via `members.staff_link_user_id` atau heuristik HP/email cocok user. Lihat §14.2. |
| 16 | Transaksi non-member ingin diubah jadi member setelah selesai | Dalam window `member_late_attach_window_minutes` (default 5 menit) → boleh, masuk audit log + flag medium severity. Setelah window → tolak, harus via admin yang akan flag high severity. |
| 17 | Member klik klaim 2x cepat (race condition) | RPC `member_claim_reward` pakai SELECT FOR UPDATE pada members + cek balance → atomic. Frontend disable button + spinner. |
| 18 | Reward kuota habis saat 2 member klaim simultan | RPC pakai SELECT FOR UPDATE pada `member_rewards` → first wins, second dapat error `REWARD_OUT_OF_STOCK`. |
| 19 | QR code member di-screenshot & disebar | QR berisi `signed_token = HMAC(member_id + timestamp, qr_secret)`. Token rotate setiap 60 detik di app. Kalau perlu lebih ketat: tambahkan nonce server-side (Fase 3). Untuk Fase 1, anggap risiko rendah karena harus tetap divalidasi di kasir. |
| 20 | Member email/HP berubah → konflik unique | Saat update profile cek dulu apakah email/HP baru sudah terpakai member lain → error `PHONE_ALREADY_EXISTS`. |
| 21 | Migrasi tabel pertama kali di prod tapi sudah ada transaksi historis | Kolom `member_id` di transactions nullable → transaksi lama tidak terpengaruh. |
| 22 | Admin set `enable_loyalty_module=0` saat ada klaim aktif | Klaim tetap valid (UI member readonly mode). Kasir tidak bisa redeem (UI hilang) — manual via admin. Atau lebih aman: tampilkan banner "Mode maintenance, hubungi admin" di member app. |
| 23 | Member sign-up dari device yang sudah login member lain | Logout dulu (frontend). Atau backend tolak register kalau ada session aktif (Fase 2). |

---

## 13. Acceptance Criteria

Daftar ini dipakai QA untuk testing. Setiap item harus terverifikasi sebelum go-live.

### A. Functional
1. ✅ Member bisa register dengan nomor HP unik. Duplicate HP ditolak dengan error jelas.
2. ✅ Member bisa login dengan HP+password, mendapat session token valid 30 hari.
3. ✅ Member tidak bisa login pakai password salah, max 5 attempts / 5 menit.
4. ✅ Member bisa lihat point sendiri, sesuai dengan jumlah di ledger.
5. ✅ Member TIDAK bisa lihat data member lain (test: ganti `member_id` di URL/request → 403).
6. ✅ Member bisa lihat histori transaksi sendiri, terurut newest first.
7. ✅ Kasir bisa cari member via HP atau scan QR.
8. ✅ Kasir bisa attach member ke transaksi sebelum disimpan.
9. ✅ Setelah transaksi `completed`, point otomatis masuk ke ledger.
10. ✅ Point = `floor(eligible_subtotal / ratio)`, batas atas `max_point_per_transaction`.
11. ✅ Excluded products tidak menambah eligible subtotal.
12. ✅ Kalau transaksi `voided`, point dibatalkan via ledger `refund_reversal`.
13. ✅ Kalau refund partial, point proporsional dibatalkan.
14. ✅ Member bisa klaim reward kalau point cukup.
15. ✅ Klaim membuat `redemption_code` unik 8 karakter.
16. ✅ Kode klaim hanya bisa dipakai 1x (UNIQUE constraint + status check).
17. ✅ Kasir scan kode klaim → reward diterapkan ke cart.
18. ✅ Setelah redeem, ledger mencatat `redeem_commit`, saldo turun.
19. ✅ Admin bisa CRUD reward.
20. ✅ Admin bisa edit aturan point, perubahan tercatat di audit log.
21. ✅ Admin bisa lihat semua member.
22. ✅ Admin bisa manual adjust point dengan alasan wajib.
23. ✅ Manual adjustment tanpa alasan → ditolak (validation error).
24. ✅ Endpoint admin tidak bisa diakses oleh staff atau member (403).

### B. Anti-Fraud (kritis)
25. ✅ Kasir tidak bisa attach member yang `staff_link_user_id` = dirinya sendiri ke transaksi. Sistem set `points_awarded=0` + INSERT fraud flag.
26. ✅ Member nomor HP-nya sama dengan `users.name` atau pernah login dari device yang sama dengan kasir → flagged sebagai `self_transaction_suspect`.
27. ✅ Member menerima > `max_point_per_member_per_day` point dalam 1 hari → point di atas limit tidak diberikan, flag dibuat.
28. ✅ Kasir sama memasukkan transaksi ke member sama > N kali / hari → flag `cashier_member_pattern`.
29. ✅ Member menerima > X transaksi dari kasir sama dalam 1 jam → flag `rapid_assignment`.
30. ✅ Banyak transaksi non-member diubah jadi member dalam 1 shift → flag `late_attach_spike`.
31. ✅ Klaim reward > 3 dalam 24 jam dari 1 member → flag `rapid_redemption`.

### C. Security
32. ✅ Password member di-hash bcrypt; tidak ada password plaintext di DB.
33. ✅ Session token tidak disimpan plaintext di DB (hanya hash).
34. ✅ `X-API-Key` wajib untuk semua endpoint loyalty.
35. ✅ Rate limit aktif untuk register, login, OTP request.
36. ✅ Semua query pakai prepared statement (PDO).
37. ✅ Input validation untuk semua field (phone format, password length, dst.).
38. ✅ Email/phone enumeration mitigated (generic error untuk login fail).
39. ✅ Audit log entry untuk setiap operasi write (register, manual adjust, reward CRUD, settings change, member status change, claim, redeem).

### D. Integrasi POS
40. ✅ Kalau `enable_loyalty_module=0`, panel member di POS tidak tampil; transaksi jalan normal.
41. ✅ Transaksi tanpa member (`member_id=null`) tetap berhasil seperti sebelumnya.
42. ✅ `client_tx_id` idempotency tetap berfungsi.
43. ✅ Cash ledger tidak terpengaruh oleh point/reward.
44. ✅ Inventory tetap berkurang sesuai recipe meski item adalah reward gratis.
45. ✅ Investor user tidak bisa lihat data member.

### E. Performance
46. ✅ Lookup member by phone < 200ms (index pada `phone`).
47. ✅ Get balance member < 100ms untuk member dengan ≤ 1000 ledger entries.
48. ✅ Dashboard admin loyalty < 2s untuk DB 10k member, 100k ledger entries.

### F. UX
49. ✅ Member app responsive di HP (320px width).
50. ✅ POS panel member tidak menambah tinggi viewport >50px (tidak mengganggu cart).
51. ✅ Error toast jelas dan bahasa Indonesia.

---

## 14. Anti-Fraud & Security Hardening

> **Section paling kritis.** Skenario fraud utama yang user khawatirkan: **kasir membuat akun member sendiri lalu memasukkan transaksi pelanggan non-member ke akun member miliknya → akumulasi point tidak sah → klaim roti gratis.**

### 14.1 Strategi Multi-Layer
Tidak ada satu mekanisme yang 100% efektif. Kombinasi 8 lapisan:

| Layer | Mekanisme | Fase |
| --- | --- | --- |
| L1. Identifikasi | QR code wajib di-scan langsung | 1 |
| L2. Identifikasi | Konfirmasi 4 digit HP / OTP | 1 / 2 |
| L3. Identifikasi | Staff link flag manual oleh admin | 1 |
| L4. Logic | Self-transaction block + zero point | 1 |
| L5. Logic | Daily / per-tx caps | 1 |
| L6. Logic | Pending point window | 1 |
| L7. Detection | Rule-based heuristic + scoring | 1 |
| L8. Detection | Pattern detection (cron + ML-lite) | 2 |

### 14.2 Definisi Self-Transaction Detection
Saat `rpc_process_transaction` di-attach `member_id`, sistem cek **semua** kondisi berikut. Kalau **salah satu** true → block point + insert flag.

```
function isSelfTransaction(memberId, staffId, branchId, db):
  member = db.fetchMember(memberId)

  # A. Direct link (paling kuat)
  if member.staff_link_user_id == staffId: return ('direct_link', 'critical')

  # B. Phone match (kasir pernah catatkan HP dirinya sendiri)
  staff = db.fetchUser(staffId)
  if staff.phone_personal == member.phone: return ('phone_match', 'high')

  # C. Pola: kasir sama, member sama, > N times this week
  count = db.countTxByCashierAndMember(staffId, memberId, last_7_days)
  if count > 20: return ('cashier_member_repeat', 'high')

  # D. Pola: member ini hanya transact via kasir ini
  pct = db.percentTxByCashier(memberId, staffId, last_30_days)
  if pct > 0.85 and total_tx > 10: return ('exclusive_cashier', 'medium')

  return null
```

Implementasi practical:
- **Field baru opsional di `users`**: `personal_phone VARCHAR(20)` untuk staff. Diisi saat admin onboard kasir. Index unique kalau ada.
- **Konsekuensi `direct_link`/`phone_match`**: `points_awarded=0`, transaksi tetap berhasil, flag severity=critical, admin dapat notif.
- **Konsekuensi `cashier_member_repeat`**: point dibagi 50% atau requested approval.
- **Konsekuensi `exclusive_cashier`**: tidak block, hanya flag.

### 14.3 Daily / Per-TX Caps
Setting yang menjadi rem otomatis (sudah di §5.5):
- `max_point_per_transaction` — batas atas per transaksi.
- `max_point_per_member_per_day` — total point earn per member per hari (00:00-23:59 zona WIB).
- `max_attached_tx_per_cashier_per_day` (baru): batas berapa kali kasir bisa attach member ke transaksi per hari. Default 50.

Implementasi di RPC `process_transaction`:
```
SELECT COALESCE(SUM(points), 0)
FROM member_point_ledger
WHERE member_id = :mid AND direction='in'
  AND movement_type IN ('earn_purchase','earn_pending','manual_adjust_in')
  AND DATE(created_at) = CURDATE()
INTO @today_points;

points_to_grant = LEAST(computed_points, GREATEST(0, max_daily - @today_points));
if points_to_grant < computed_points:
  insert_flag('daily_cap_reached', severity=low);
```

### 14.4 Late Attach Protection (Kasus 16 di edge case)
- Window default 5 menit.
- Setelah transaksi `completed`, kasir bisa edit `member_id` lewat `rpc/member_attach_to_transaction_after` selama:
  - `NOW() - tx.created_at <= late_attach_window`.
  - `tx.member_id IS NULL` (tidak boleh swap member).
  - Member belum diattach ke tx lain dalam shift ini > X kali.
- Wajib `reason TEXT` minimal 5 karakter.
- Insert flag `late_attach` severity=medium otomatis.
- Setelah window → harus admin via `rpc/member_admin_late_attach`.

### 14.5 Pending Point Window
- Setting `point_pending_window_hours` (default 24).
- Point dari transaksi masuk sebagai `earn_pending`.
- Naik jadi `earn_active` setelah window lewat & tidak ada refund.
- Konsekuensi: member yang fraud susah cash out cepat (cooldown).
- UI member: tampilkan saldo aktif besar, pending kecil dengan tooltip "Point pending menunggu 24 jam atau shift kasir ditutup".

### 14.6 Fraud Detection Rules (Rule Engine)

Cron tiap 1 jam (atau on-demand via admin) jalankan rule berikut. Tiap rule yang trigger → INSERT `member_fraud_flags`.

| Rule ID | Deskripsi | Severity | Window | Threshold |
| --- | --- | --- | --- | --- |
| R001 | 1 member > N transaksi hari ini | high | hari ini | > 15 |
| R002 | 1 member > Rp X total hari ini | medium | hari ini | > Rp 2.000.000 |
| R003 | 1 kasir → 1 member > N transaksi minggu ini | high | 7 hari | > 30 |
| R004 | 1 member, > N transaksi kecil < Rp Y berturut | medium | 24 jam | > 10 tx < Rp 20.000 |
| R005 | Pola attach late > N kali / shift | medium | 1 shift | > 3 |
| R006 | Klaim reward > N dalam 24 jam | medium | 24 jam | > 3 |
| R007 | Member baru langsung dapat banyak point | medium | sejak register | > 100 point in 24 jam |
| R008 | Velocity: time between transactions terlalu cepat | low | 1 jam | < 30 detik avg |
| R009 | Direct phone match (staff & member) | critical | always | exact match |
| R010 | Manual adjustment tanpa flag terkait, > Rp X | high | per adjust | points > 100 |

Threshold disimpan di table baru `member_fraud_rules` (key, threshold, window, enabled) supaya admin bisa adjust tanpa code change. Atau minimal di `member_settings`.

### 14.7 Risk Scoring
Setiap flag punya `risk_score 0–100`:
- critical = 90-100
- high = 70-89
- medium = 40-69
- low = 10-39

Member dengan akumulasi flag berhubungan auto-elevated:
- > 2 flags any severity dalam 7 hari → notify admin.
- > 1 critical → freeze member otomatis (status `is_active=0` + reason flag).

### 14.8 Audit Trail Lengkap
Selain `audit_logs`, **wajib tercatat**:
- Setiap `member_point_ledger` entry sudah otomatis audit (tabel itu sendiri).
- `member_reward_claims` event lifecycle: claim, approve, redeem, cancel.
- Setiap edit `members` (terutama `phone`, `is_active`, `staff_link_user_id`).
- Setiap edit `member_settings` & `member_rewards`.
- Login member sukses & gagal.
- Self-transaction block events.

Audit log immutable: TIDAK ADA endpoint untuk DELETE/UPDATE `audit_logs`. Hanya INSERT.

### 14.9 Redemption Security
- `redemption_code`: 8 char [A-Z2-9] (tanpa O, 0, I, 1 supaya tidak ambigu). Generate via `random_bytes(6)` → base32.
- `redemption_qr_token`: format `MBR-CLAIM-{claim_id}.{HMAC(claim_id+expires_at, qr_secret)}`.
- UNIQUE constraint pada `redemption_code` di DB.
- Status check sebelum redeem: hanya `redeemable` yang boleh, bukan `pending_approval`/`redeemed`/`cancelled`/`expired`.
- Expiry: default 30 hari sejak claim, configurable di reward.
- Reward `requires_admin_approval=1` + reward khusus mahal → approval queue.

### 14.10 Database & API Security
Sudah ada dasar yang baik di sistem existing — perluas ke modul ini:
- **Password**: `password_hash(PASSWORD_BCRYPT)`. Verifikasi `password_verify`.
- **Prepared statements** (PDO, `ATTR_EMULATE_PREPARES=false` di `config.php:77-81`).
- **Input validation backend**: regex phone, length password, range numeric, whitelist enum.
- **Input validation frontend**: untuk UX, bukan satu-satunya garis pertahanan.
- **CORS**: hanya origin yang ada di whitelist `config.php:38-51`. Tambah domain member app kalau pakai subdomain berbeda.
- **CSRF**: token-based auth via header, bukan cookie — relatif aman dari CSRF default.
- **XSS**: escape output. Frontend hindari `innerHTML`, gunakan `textContent`.
- **Rate limiting**: pakai `api_rate_limits` table existing.
- **Error generik untuk 500**: tidak leak stack trace (sudah di `api.php:30`).
- **Logging**: error log ke file server, tidak ke client.
- **Session expiry**: 30 hari, sliding window optional.
- **No PII in URLs**: tidak ada `?phone=08xxx` di URL — selalu di body POST.

### 14.11 Member Self-Service Hardening
- Update profile butuh `current_password` (re-auth).
- Ganti password butuh password lama.
- Ganti HP (Fase 2) butuh OTP ke nomor baru DAN password lama.
- Soft delete only (member tidak bisa hard delete diri sendiri).

### 14.12 Data Integrity & Reconciliation
- Tabel `members.lifetime_*` di-cache. Cron mingguan `verify_balance_consistency` recompute dari ledger → kalau beda > 0 → audit log + alert admin.
- `members.balance_*` (kalau tetap di-cache) sama.
- Reward `quota_used` recomputable dari count claim `status='redeemed'`.

### 14.13 Penalty & Action Matrix

| Flag Severity | Otomatis | Manual Action Admin |
| --- | --- | --- |
| Low | Log only | Review optional |
| Medium | Email/notif admin | Review wajib, action optional |
| High | Block point + notify | Investigasi, possibly lock points |
| Critical | Block point + freeze member + escalate | Mandatory investigation, possible firing kasir |

---

## 15. Rekomendasi Implementasi Bertahap

### Fase 1 — MVP (target: 4-6 minggu)
Goal: launch loyalty internal di 1 outlet pilot.

1. ✅ Schema & migration `064_member_loyalty_schema.sql`.
2. ✅ RPC: register, login, lookup, attach, process_transaction modification, claim_reward, redeem_at_cashier, manual_adjust.
3. ✅ Admin UI: dashboard, kelola member, kelola reward, settings, fraud monitoring (basic).
4. ✅ Kasir UI: panel member di POS, modal cari member (HP + QR), modal redeem.
5. ✅ Member app: register, login, dashboard, reward list, claim, profile.
6. ✅ Anti-fraud: L1 (QR scan), L4 (self-tx block), L5 (caps), L6 (pending window), L7 rules R001/R003/R009.
7. ✅ Audit logs untuk semua write.
8. ✅ Setting `enable_loyalty_module` default 0, toggle ON setelah testing.

**Out of Fase 1**: OTP, late attach window (boleh simple cek 5 menit), FIFO point usage, fraud rules R002/R004/R005/R006/R007/R008/R010, Investor view.

### Fase 2 — Production Hardening (target: +3-4 minggu)
1. ✅ OTP integration (gateway WA/SMS, contoh: WaSenderApi, Vonage).
2. ✅ Forgot password self-service via OTP.
3. ✅ Change phone self-service.
4. ✅ Sisa fraud rules + risk scoring.
5. ✅ Cron jobs: pending → active, expire, fraud scan, balance reconciliation.
6. ✅ Push notification (PWA) untuk member.
7. ✅ Email member untuk reward claim & expiry warning.
8. ✅ Investor view (read-only summary).

### Fase 3 — Advanced (target: opsional)
1. ✅ Multi-tier membership (Bronze/Silver/Gold) dengan multiplier point.
2. ✅ Referral program.
3. ✅ FIFO point usage / per-batch tracking.
4. ✅ Birthday bonus (cron daily).
5. ✅ ML-lite fraud scoring (anomaly detection).
6. ✅ WA Business API broadcast.
7. ✅ QR rotating dengan nonce server-side.
8. ✅ Loyalty wallet di kartu fisik (NFC/RFID).

### Urutan Kerja Disarankan (Fase 1)
1. Diskusi & approve PRD (ini).
2. Tulis migration SQL → review → run di staging.
3. Implementasi RPC backend (PHP/PDO) + test via Postman.
4. Modifikasi `rpc_process_transaction` + regression test full POS flow.
5. Admin UI (mulai dari Settings & Reward CRUD).
6. POS panel member.
7. Member app (PWA).
8. Anti-fraud rules.
9. UAT di outlet pilot 2 minggu.
10. Bug fixes + go-live.

---

## 16. Risiko, Asumsi, & Open Questions

### 16.1 Risiko Teknis
| Risiko | Mitigasi |
| --- | --- |
| Modifikasi `rpc_process_transaction` mengganggu transaksi existing | Backward compatible: parameter baru opsional, default off via setting. Full regression test wajib. |
| QR scanner library tidak konsisten di Android lama | Test di Android 8+, fallback ke input manual HP. |
| Performance ledger besar | Index pada `member_id+created_at`, pagination semua list, cache `members.lifetime_*`. |
| OTP gateway downtime (Fase 2) | Fallback ke admin reset; queue OTP request. |
| Race condition di klaim/redeem | SELECT FOR UPDATE di RPC, UNIQUE constraint di DB. |

### 16.2 Risiko Bisnis
| Risiko | Mitigasi |
| --- | --- |
| Fraud staff tetap terjadi di lapangan | CCTV + SOP + spot check + anti-fraud rules. Technical control bukan satu-satunya. |
| Point inflation (terlalu mudah dapat) | Setting konservatif di awal: ratio 10000:1, max harian 50. Monitor 1 bulan, adjust. |
| Liability point (kewajiban perusahaan) | Set expiry 365 hari + pelajari implikasi akuntansi. |
| Member tidak adopt | Promosi awal: bonus point 50 untuk daftar 30 hari pertama (manual adjust admin). |

### 16.3 Asumsi
- DB MySQL 8 di cPanel mendukung `JSON`, `CHAR(36)`, `ENUM` (sudah dipakai).
- Volume transaksi saat ini < 1000/hari/outlet → schema cukup tanpa sharding.
- Internet di outlet stabil (kalau tidak, butuh offline mode — bukan scope ini).
- Owner punya akses cPanel untuk run migration.
- Kasir dilengkapi HP/tablet dengan kamera untuk QR scan.

### 16.4 Open Questions (perlu jawaban sebelum implementasi)
1. **Ratio default**: Rp10.000 / 1 point cocok? Atau Rp5.000? Owner decide.
2. **Reward awal**: berapa SKU reward yang siap launch? (rekomendasi: 3-5 reward simple).
3. **Pricing reward**: 50 point untuk roti bakar sederhana? Hitung ulang dari margin.
4. **OTP provider Fase 2**: WA Business API? Pakai Twilio? Atau gateway lokal seperti Fonnte?
5. **Apakah investor boleh lihat aggregate member**: ya/tidak?
6. **Apakah point bisa transfer antar member**: rekomendasi: tidak, untuk Fase 1 simpler.
7. **Apakah perlu refund point** kalau reward fisik tidak terkirim/rusak: ya, via admin manual adjust.
8. **Reward limit per member per periode**: ada? (misal: max 1 reward besar / bulan). Setting baru.
9. **Apakah ada minimum balance untuk daftar**: tidak.
10. **Branding member app**: subdomain (member.rotibakarngeunah.com) atau path (/member)? → impact CORS config.

### 16.5 Dependencies External
- QR code library: `qrcode-generator` (untuk generate di member app), `html5-qrcode` (untuk scan di kasir).
- (Fase 2) SMS/WA gateway provider — pilih sebelum Fase 2 mulai.

### 16.6 Estimasi Effort (Fase 1, kasar)
| Komponen | Effort (hari) |
| --- | --- |
| Migration + DB design review | 1 |
| Backend RPC + integration `process_transaction` | 5 |
| Member app PWA | 6 |
| POS modification | 3 |
| Admin UI (Member, Reward, Settings, Fraud basic) | 6 |
| Anti-fraud rules basic | 2 |
| Testing & bugfix | 5 |
| UAT + go-live | 3 |
| **Total** | **~31 hari kerja** (≈ 6 minggu untuk 1 dev) |

---

## Lampiran A — Mapping ke Sistem Existing (Quick Reference)

| Konsep PRD | Tabel Existing yang Dirujuk | File yang Akan Disentuh |
| --- | --- | --- |
| Transaksi member | `transactions` (+kolom baru) | `api/api.php` RPC process_transaction |
| Auth member | `app_sessions` (pattern) | `api/api.php` + tabel baru `member_sessions` |
| Audit point | `audit_logs` | `api/api.php` helper `auditLog()` |
| Rate limit | `api_rate_limits` | `api/api.php` `rateLimitAction()` |
| Cash impact reward | `transactions.discount_amount`, `branch_cash_ledger` | tidak modifikasi langsung — flow data via transaction |
| Inventory reward | `transaction_items` + recipe | tidak modifikasi |
| Branch scope | `branches` + `requireBranchAccess()` | `api/api.php` |
| Login pattern | `rpc_pos_login` (`api.php:1405-1493`) | dijadikan template untuk `member_login` |
| Idempotency | `transactions.client_tx_id` (migration 059) | reuse pattern untuk `member_attach` |

## Lampiran B — File Baru yang Akan Dibuat

| File | Deskripsi |
| --- | --- |
| `sql/migrations/064_member_loyalty_schema.sql` | Schema migration + seed default settings |
| `member.html` | Member-facing PWA |
| `js/member.js` | Member app logic |
| `js/services/memberService.js` | Reusable member API client (mirip `transactionService.js`) |
| `js/memberUi.js` | UI components untuk member panel di POS |
| `js/adminMemberUi.js` | Admin tab member UI |
| `css/member.css` (optional) | Tambahan style member app |

## Lampiran C — File Existing yang Dimodifikasi

| File | Modifikasi |
| --- | --- |
| `api/api.php` | Tambah whitelist tabel baru, RPC baru, modifikasi `rpc_process_transaction` & void/refund RPC |
| `pos.html` | Tambah panel member + modal scan/redeem (conditional render via feature flag) |
| `js/pos.js` | Tambah handler untuk attach member, redeem, preview point |
| `js/services/transactionService.js` | Tambah field `memberId`, `redemptionCode` ke `processTransaction()` |
| `admin.html` | Tambah tab "Member" di navigation |
| `js/admin.js` | Tambah load handler untuk tab member |
| `js/apiClient.js` | Tambah support header `X-Member-Session-Token` (kalau dipakai dari member app context) |
| `manifest.json` | Tambah PWA config untuk member route (kalau pakai sama domain) |

---

**End of PRD.** Tinggal review owner, jawab open questions di §16.4, lalu lanjut ke implementasi Fase 1.
