# PRD Revisi Flow Kas Staff: Saldo Aktif Otomatis Per Staff

Tanggal: 2026-05-20  
Produk: Roti Bakar Ngeunah POS  
Area: Staff POS, Admin Kas Aktif, Buka/Tutup Kas, Setoran, Approval, Laporan Kas  
Status: Draft siap untuk AI builder  
Prioritas: Kritis

## 1. Background Masalah

Saat ini sistem sudah punya flow `cashier_sessions`, `cash_logs`, `cash_deposits`, approval setoran, dan UI admin "Kas Aktif & Posisi Staff". Namun kas awal staff masih diinput manual di modal buka shift (`pos.html` -> `shift-opening-cash`, `js/pos.js` -> `confirmOpenShift()`), lalu dikirim ke `transactionService.openShift()` sebagai `opening_cash`.

Temuan kode existing:

| Area | Kondisi saat ini |
|---|---|
| Buka kas staff | `js/pos.js::confirmOpenShift()` membaca input `shift-opening-cash`; belum mengambil saldo aktif staff terakhir. |
| Insert session | `js/services/transactionService.js::openShift()` insert `cashier_sessions.opening_cash = openingCash || 0`. |
| Tutup kas | `closeShift()` update `status='closed'`, `closing_cash`, `expected_cash`, `current_cash_amount=closingCash`. |
| Ringkasan kas | `cashService.getSummary()` menghitung `opening_cash + penjualan_tunai + manual_in - manual_out - refund - void - deposit_confirmed`. |
| Setoran | `cash_deposits.status` = `pending/confirmed/rejected`; `confirm_deposit()` baru membuat `cash_logs` keluar saat `confirmed`. Pending tidak mengurangi kas. |
| Admin kas aktif | `adminStaffCashUi` dan RPC `get_admin_cash_sessions` bekerja per sesi, bukan saldo aktif permanen per staff. |
| Posisi staff tanpa sesi | RPC `get_staff_cash_positions` menampilkan posisi dari sesi open; jika tidak ada sesi open, saldo aktif staff tidak menjadi sumber kas awal berikutnya. |

Risiko jika saldo staff tidak dilacak otomatis:

- Kas awal bisa salah input, ter-reset ke `0`, atau tidak sama dengan saldo akhir sebelumnya.
- Staff/admin harus ingat saldo manual di luar sistem.
- Setoran pending bisa dianggap sudah mengurangi saldo padahal belum approved.
- Koreksi admin sulit dibedakan dari transaksi, setoran, dan tutup kas.
- Audit posisi kas per staff tidak utuh karena `current_cash_amount` melekat ke sesi, bukan saldo aktif staff.

Kebutuhan utama: admin dapat mengatur/mengoreksi posisi kas aktif staff secara manual, sistem menyimpan saldo aktif tersebut, dan saldo aktif otomatis dipakai sebagai kas awal saat staff buka kas berikutnya.

## 2. Tujuan Fitur

1. Admin/owner dapat melihat dan mengatur posisi kas aktif per staff.
2. Staff tidak input kas awal manual; staff hanya konfirmasi kas awal sistem.
3. Sistem otomatis memakai saldo aktif terakhir staff sebagai `opening_cash` sesi berikutnya.
4. Saldo akhir tutup kas menjadi saldo aktif staff berikutnya.
5. Penjualan tunai menambah saldo kas staff lewat hasil tutup kas.
6. Setoran pending tidak mengurangi saldo aktif.
7. Setoran approved mengurangi saldo aktif secara idempotent.
8. Semua perubahan saldo kas tercatat di ledger/audit trail.
9. Tidak ada double count antara `cash_logs`, `cash_deposits`, transaksi tunai, dan ledger saldo staff.

## 3. Scope Fitur

### In Scope

- UI admin untuk daftar saldo aktif staff, koreksi saldo, dan riwayat ledger.
- UI staff untuk konfirmasi kas awal otomatis saat buka kas.
- Flow buka kas otomatis dari saldo aktif staff.
- Flow tutup kas yang mengunci saldo akhir sebagai saldo aktif staff.
- Flow setoran staff/admin dan approval admin yang hanya mengurangi saldo saat approved.
- Audit trail/ledger saldo staff.
- Validasi idempotency agar session close, deposit approval, dan adjustment tidak double apply.
- Integrasi dengan laporan kas dan penjualan tunai agar angka penjualan tidak berubah.
- Edge case operasional: belum punya saldo, lupa tutup kas, pending deposit, multi shift, koreksi saat sesi aktif, lewat tengah malam.

### Out of Scope

- Membuat ulang modul transaksi POS.
- Mengubah nominal setoran kelipatan Rp 50.000.
- Approval bertingkat baru.
- Rekonsiliasi bank otomatis.
- Menghapus histori `cash_logs`, `transactions`, atau `cash_deposits` lama.
- Fitur absensi/attendance.

## 4. User Role

| Role | Hak |
|---|---|
| Admin/Owner | Melihat semua saldo staff, set posisi kas, koreksi saldo dengan alasan wajib, approve/reject setoran, melihat audit trail. |
| Staff | Melihat saldo kas miliknya, konfirmasi kas awal saat buka kas, lapor selisih fisik dengan alasan, tutup kas, membuat setoran untuk shift tertutup. |

## 5. Definisi dan Prinsip Data

| Istilah | Definisi teknis |
|---|---|
| Saldo aktif staff | Saldo kas terakhir yang menjadi sumber `opening_cash` sesi berikutnya. Disimpan di `staff_cash_balances.current_balance`. |
| Saldo awal buka kas | Nilai `staff_cash_balances.current_balance` saat staff membuka sesi. Disalin ke `cashier_sessions.opening_cash`. |
| Saldo akhir tutup kas | Nominal kas akhir aktual yang dikonfirmasi staff/admin saat tutup kas. Menjadi saldo aktif baru staff. |
| Ledger kas staff | Tabel append-only untuk semua perubahan saldo aktif staff. |
| Setoran pending | Row `cash_deposits.status='pending'`. Tidak mengubah saldo aktif. |
| Setoran approved | Row `cash_deposits.status='confirmed'`. Mengurangi saldo aktif satu kali. |
| Penjualan tunai | `transactions.status='completed' AND payment_method='cash'`. Masuk perhitungan sesi dan mempengaruhi saldo aktif saat sesi ditutup. |

Prinsip penting:

- `cash_logs` tetap dipakai untuk laporan kas sesi/cabang.
- `staff_cash_ledger` menjadi audit perubahan `staff_cash_balances`.
- Jangan menghitung saldo staff dengan menjumlah `cash_logs` dan ledger sekaligus.
- Untuk MVP, penjualan tunai tidak perlu membuat ledger per transaksi; cukup masuk ke saldo staff saat `session_close` satu kali.

## 6. Flow Utama

### 6.1 Admin Set Posisi Kas Staff

1. Admin buka menu `Kas Aktif & Posisi Staff`.
2. Sistem menampilkan saldo aktif per staff dari `staff_cash_balances`.
3. Admin pilih staff, klik `Set/Koreksi Posisi Kas`.
4. Admin input nominal baru dan alasan wajib.
5. Backend mengunci row saldo staff, insert ledger `admin_set_balance` atau `admin_adjustment`, update `staff_cash_balances.current_balance`.
6. UI menampilkan saldo baru dan riwayat perubahan.

### 6.2 Staff Buka Kas dan Konfirmasi Kas Awal

1. Staff buka POS.
2. Sistem mengambil saldo aktif staff:
   - Jika ada row balance: pakai `current_balance`.
   - Jika belum ada row: default `0` dan buat row saat buka/adjust pertama.
3. Modal buka kas menampilkan `Kas awal sistem: Rp X`.
4. Staff klik `Konfirmasi & Buka Kas`.
5. Jika kas fisik sesuai, backend membuat `cashier_sessions` dengan `opening_cash = X`.
6. Jika tidak sesuai, staff isi `kas_fisik`, `selisih`, dan alasan wajib. Session tetap memakai `opening_cash` sistem; selisih disimpan sebagai audit `opening_variance` untuk review admin.

### 6.3 Sistem Menghitung Kas Berjalan

Rumus tampilan sesi berjalan:

```text
kas_berjalan_sesi =
  opening_cash
  + penjualan_tunai_completed
  + kas_masuk_manual
  - kas_keluar_manual
  - refund_tunai
  - void_tunai
  - setoran_approved_yang_relevan
  + external_staff_balance_adjustment_setelah_sesi_dibuka
```

Catatan: `setoran_pending` hanya ditampilkan sebagai informasi, tidak mengurangi angka.

### 6.4 Staff Tutup Kas

1. Staff klik tutup shift.
2. Sistem menampilkan kas sistem dan komponen: kas awal, penjualan tunai, kas masuk/keluar manual, refund, void, setoran approved.
3. Staff input kas fisik akhir.
4. Backend menutup `cashier_sessions`, mengisi `closing_cash`, `expected_cash`, `current_cash_amount`.
5. Backend update `staff_cash_balances.current_balance = closing_cash`.
6. Backend insert ledger `session_close` dengan `balance_before`, `balance_after`, `amount = balance_after - balance_before`.
7. `session_close` harus idempotent: sesi yang sama tidak boleh mengubah saldo dua kali.

Contoh:

```text
Saldo aktif Narti = Rp10.000
Buka kas: opening_cash = Rp10.000
Penjualan tunai: Rp50.000
Tutup kas normal: closing_cash = Rp60.000
Saldo aktif baru Narti = Rp60.000
Besok buka kas: opening_cash otomatis Rp60.000
```

### 6.5 Setoran dan Approval Admin

1. Staff/admin membuat setoran untuk shift tertutup sesuai rule existing migration 030/031.
2. Status awal `pending`.
3. Saat pending:
   - `staff_cash_balances.current_balance` tidak berubah.
   - UI saldo menampilkan `pending_deposit_amount`.
4. Saat admin approve:
   - `cash_deposits.status` menjadi `confirmed`.
   - Sistem insert `cash_logs` out `reference_type='deposit'` seperti existing.
   - Sistem update `staff_cash_balances.current_balance -= amount`.
   - Sistem insert ledger `deposit_approved`.
5. Saat admin reject:
   - `status='rejected'`.
   - Saldo aktif tidak berubah.
   - Alasan reject disimpan.

Contoh:

```text
Saldo aktif Narti = Rp60.000
Narti submit setoran Rp50.000 -> pending
Saldo aktif tetap Rp60.000
Admin approve setoran Rp50.000
Saldo aktif baru = Rp10.000
Buka kas berikutnya otomatis Rp10.000
```

## 7. Acceptance Criteria

- AC-001: Kas awal buka kas otomatis sama dengan saldo aktif terakhir staff.
- AC-002: Staff tidak bisa mengetik bebas kas awal sebagai sumber saldo; staff hanya konfirmasi atau lapor selisih.
- AC-003: Staff yang belum punya saldo aktif mendapat kas awal default `Rp0`.
- AC-004: Admin bisa set/koreksi saldo aktif staff dengan alasan wajib.
- AC-005: Setiap koreksi admin membuat ledger dengan nominal sebelum, sesudah, selisih, admin, alasan, timestamp.
- AC-006: Penjualan tunai menambah saldo aktif saat sesi ditutup.
- AC-007: Tutup kas normal membawa saldo akhir menjadi saldo aktif staff.
- AC-008: Setoran pending tidak mengurangi saldo aktif.
- AC-009: Setoran approved mengurangi saldo aktif tepat satu kali.
- AC-010: Setoran rejected tidak mengubah saldo aktif dan dapat dibuat ulang sesuai rule existing.
- AC-011: Tidak ada saldo aktif yang otomatis reset ke `0` kecuali admin melakukan adjustment valid ke `0`.
- AC-012: Tidak ada double count dari penjualan tunai, close session, atau approval deposit.
- AC-013: Jika RPC approval deposit dipanggil ulang untuk deposit yang sudah confirmed, saldo tidak berubah lagi.
- AC-014: Jika close session dipanggil ulang untuk session closed, saldo tidak berubah lagi.
- AC-015: Admin dan staff melihat status pending/approved/rejected setoran dengan jelas.
- AC-016: Laporan penjualan tunai tetap mengambil total dari `transactions`, bukan dari ledger saldo staff.
- AC-017: Semua aksi penting tercatat: open confirm, opening variance, close session, admin adjustment, deposit approval/rejection.

## 8. Data Model / Database Adjustment

### 8.1 Tabel Baru: `staff_cash_balances`

Satu row per kombinasi `branch_id + staff_id`.

```sql
CREATE TABLE public.staff_cash_balances (
  id bigserial PRIMARY KEY,
  branch_id bigint NOT NULL REFERENCES public.branches(id),
  staff_id bigint NOT NULL REFERENCES public.users(id),
  current_balance numeric(15,2) NOT NULL DEFAULT 0 CHECK (current_balance >= 0),
  last_cash_session_id bigint REFERENCES public.cashier_sessions(id),
  last_ledger_id bigint,
  pending_deposit_amount numeric(15,2) NOT NULL DEFAULT 0,
  version bigint NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by bigint REFERENCES public.users(id),
  UNIQUE (branch_id, staff_id)
);
```

Catatan:

- `pending_deposit_amount` boleh disimpan untuk performa, tetapi sumber valid tetap `cash_deposits WHERE status='pending'`.
- Jika memilih derived-only, hapus field ini dan hitung via view/RPC.

### 8.2 Tabel Baru: `staff_cash_ledger`

Append-only ledger perubahan saldo aktif staff.

```sql
CREATE TABLE public.staff_cash_ledger (
  id bigserial PRIMARY KEY,
  branch_id bigint NOT NULL REFERENCES public.branches(id),
  staff_id bigint NOT NULL REFERENCES public.users(id),
  cash_session_id bigint REFERENCES public.cashier_sessions(id),
  deposit_id uuid REFERENCES public.cash_deposits(id),
  movement_type text NOT NULL CHECK (movement_type IN (
    'admin_set_balance',
    'admin_adjustment',
    'session_open_confirm',
    'opening_variance',
    'session_close',
    'deposit_approved',
    'deposit_rejected',
    'system_repair'
  )),
  direction text NOT NULL CHECK (direction IN ('in','out','adjust','none')),
  amount numeric(15,2) NOT NULL DEFAULT 0,
  balance_before numeric(15,2) NOT NULL,
  balance_after numeric(15,2) NOT NULL,
  reason text,
  source_table text,
  source_id text,
  created_by bigint REFERENCES public.users(id),
  approved_by bigint REFERENCES public.users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb
);

CREATE UNIQUE INDEX idx_staff_cash_ledger_unique_source
ON public.staff_cash_ledger(source_table, source_id, movement_type)
WHERE source_table IS NOT NULL AND source_id IS NOT NULL;
```

### 8.3 Adjustment `cashier_sessions`

Tambahkan field audit buka/tutup berbasis saldo aktif:

```sql
ALTER TABLE public.cashier_sessions
  ADD COLUMN IF NOT EXISTS opening_cash_source text DEFAULT 'manual',
  ADD COLUMN IF NOT EXISTS opening_balance_id bigint REFERENCES public.staff_cash_balances(id),
  ADD COLUMN IF NOT EXISTS opening_confirmed_at timestamptz,
  ADD COLUMN IF NOT EXISTS opening_confirmed_by bigint REFERENCES public.users(id),
  ADD COLUMN IF NOT EXISTS opening_physical_cash numeric(15,2),
  ADD COLUMN IF NOT EXISTS opening_variance_amount numeric(15,2),
  ADD COLUMN IF NOT EXISTS opening_variance_reason text,
  ADD COLUMN IF NOT EXISTS balance_applied_at timestamptz,
  ADD COLUMN IF NOT EXISTS balance_ledger_id bigint REFERENCES public.staff_cash_ledger(id);
```

### 8.4 Adjustment `cash_deposits`

Field existing:

- `status` saat ini berfungsi sebagai `approval_status`.
- `reviewed_by` = `approved_by/rejected_by`.
- `reviewed_at` = waktu approval/rejection.
- `reject_reason` sudah ada.

Tambahkan idempotency saldo:

```sql
ALTER TABLE public.cash_deposits
  ADD COLUMN IF NOT EXISTS balance_applied_at timestamptz,
  ADD COLUMN IF NOT EXISTS balance_ledger_id bigint REFERENCES public.staff_cash_ledger(id);
```

## 9. Backend / RPC Requirement

Gunakan RPC `SECURITY DEFINER` untuk mutasi saldo. Jangan update `staff_cash_balances` langsung dari frontend.

### 9.1 RPC Baru/Diubah

| RPC | Fungsi |
|---|---|
| `get_staff_cash_balance(p_branch_id, p_staff_id)` | Ambil saldo aktif, pending deposit, sesi open, dan riwayat ringkas. |
| `get_admin_staff_cash_balances(p_admin_id, filters...)` | Daftar saldo staff untuk UI admin. |
| `admin_set_staff_cash_balance(...)` | Set/koreksi saldo staff dengan alasan wajib dan ledger. |
| `open_cash_session_from_balance(...)` | Buka `cashier_sessions` dengan `opening_cash` dari saldo aktif staff. |
| `close_cash_session_apply_balance(...)` | Tutup sesi dan update saldo aktif staff secara atomik. |
| `confirm_deposit(...)` | Extend RPC existing agar approval deposit juga apply saldo aktif idempotent. |

### 9.2 Validasi RPC

- Role admin/owner wajib untuk semua RPC admin.
- Staff hanya boleh buka/tutup session miliknya sendiri.
- Lock row balance dengan `FOR UPDATE` sebelum update saldo.
- Jika balance row belum ada, buat dengan `current_balance=0`.
- Gunakan unique source ledger untuk idempotency.
- Reject nominal negatif.
- Reject adjustment tanpa alasan.
- Reject `close_cash_session_apply_balance` jika session bukan milik staff atau sudah applied.
- Reject `confirm_deposit` jika deposit bukan pending.
- Untuk approval deposit, jika `balance_applied_at` sudah ada, jangan apply lagi.

## 10. Business Logic

### 10.1 Rumus Utama

```text
saldo_kas_berjalan =
  saldo_awal
  + penjualan_tunai
  + kas_masuk_manual
  - kas_keluar_manual
  - refund
  - void
  - setoran_approved
  + adjustment_admin
```

### 10.2 Buka Kas

```text
saldo_awal_buka_kas = staff_cash_balances.current_balance
cashier_sessions.opening_cash = saldo_awal_buka_kas
```

### 10.3 Tutup Kas

```text
expected_cash =
  opening_cash
  + total_penjualan_tunai_sesi
  + manual_in
  - manual_out
  - refund
  - void
  - setoran_approved_relevan

saldo_aktif_baru = closing_cash_actual
ledger.amount = saldo_aktif_baru - saldo_aktif_sebelum_close
```

Normal case:

```text
saldo_awal Rp10.000 + penjualan_tunai Rp50.000 = closing_cash Rp60.000
staff_cash_balances.current_balance = Rp60.000
```

### 10.4 Setoran

```text
Jika status = pending:
  saldo_aktif tidak berubah

Jika status berubah pending -> confirmed:
  saldo_aktif_baru = saldo_aktif_lama - amount
  insert ledger deposit_approved

Jika status berubah pending -> rejected:
  saldo_aktif tidak berubah
  simpan reject_reason
```

### 10.5 Admin Adjustment

```text
balance_before = staff_cash_balances.current_balance
balance_after = nominal_admin
amount = balance_after - balance_before
movement_type = admin_set_balance/admin_adjustment
reason wajib
```

## 11. UI/UX Requirement

### 11.1 UI Staff - Buka Kas

Ubah modal buka shift di `pos.html` dan logic `js/pos.js`:

- Ganti input `Kas Awal (Rp)` menjadi display read-only `Kas awal sistem`.
- Tampilkan nominal otomatis besar dan jelas.
- Tombol utama: `Konfirmasi & Buka Kas`.
- Checkbox/aksi sekunder: `Kas fisik tidak sesuai`.
- Jika tidak sesuai:
  - Input `Kas fisik yang dihitung`.
  - Auto tampilkan selisih.
  - Alasan wajib.
  - Copy harus jelas: "Kas awal sistem tetap dipakai. Selisih akan dilaporkan ke admin."
- Tampilkan pending deposit jika ada: "Ada setoran menunggu approval RpX. Saldo kas belum dikurangi sampai admin approve."

### 11.2 UI Staff - Tutup Kas

- Tetap tampilkan breakdown existing dari `cashService.getSummary()`.
- Tambahkan konteks saldo aktif:
  - `Saldo aktif sebelum tutup`
  - `Kas akhir yang akan menjadi saldo aktif berikutnya`
  - `Selisih kas akhir vs sistem`
- Setelah sukses tutup, tampilkan pesan: "Saldo aktif Anda sekarang RpX. Nilai ini akan menjadi kas awal berikutnya."

### 11.3 UI Admin - Saldo Kas Staff

Extend menu `Kas Aktif & Posisi Staff`:

- Tampilkan daftar staff, cabang, status sesi, saldo aktif, kas berjalan sesi, pending deposit, last movement.
- Tombol `Set/Koreksi Saldo` tersedia untuk admin/owner.
- Modal koreksi:
  - Staff/cabang read-only.
  - Saldo saat ini.
  - Nominal baru.
  - Selisih.
  - Alasan wajib.
  - Konfirmasi sebelum simpan.
- Detail staff:
  - Saldo aktif.
  - Session terakhir.
  - Setoran pending/approved/rejected.
  - Ledger saldo.
  - Cash logs sesi terkait.

### 11.4 UI Admin - Approval Setoran

- Tampilkan efek approval sebelum admin klik:
  - Pending: "Belum mengurangi saldo staff."
  - Approve: "Saldo staff akan berkurang RpX."
  - Reject: "Saldo staff tidak berubah."
- Setelah approve, refresh:
  - Tabel setoran.
  - Kas Aktif & Posisi Staff.
  - Detail ledger staff.

### 11.5 Laporan Penjualan Tunai dan Laporan Kas

- Laporan penjualan tunai tetap menggunakan `transactions`.
- Laporan kas sesi tetap menggunakan `cashier_sessions`, `transactions`, `cash_logs`, dan `cash_deposits`.
- Data saldo aktif staff ditampilkan sebagai laporan terpisah atau kolom tambahan, bukan pengganti total penjualan.
- Jika laporan kas menampilkan `Kas Awal`, ambil dari `cashier_sessions.opening_cash`, bukan dari input manual lama yang kosong.

## 12. Security dan Permission

- Hanya admin/owner yang bisa set/koreksi saldo staff.
- Staff hanya bisa melihat saldo miliknya dan membuka/tutup kas miliknya.
- Staff tidak boleh mengubah `staff_cash_balances.current_balance` langsung.
- Frontend role check wajib, tetapi validasi final wajib di RPC.
- RLS/grant harus mencegah direct DML ke `staff_cash_balances` dan `staff_cash_ledger` oleh `anon/authenticated`.
- Semua aksi penting wajib punya `created_by`, timestamp, dan metadata.
- Adjustment admin wajib punya alasan non-empty.
- Opening variance staff wajib punya alasan jika selisih tidak nol.

## 13. Edge Case

| Edge case | Expected behavior |
|---|---|
| Staff belum pernah punya saldo | Sistem default `Rp0`, buat row balance saat open/adjust pertama. |
| Staff lupa tutup kas | Admin dapat tutup manual via flow existing, lalu RPC close manual harus apply saldo aktif sekali. |
| Ada 2 shift dalam 1 outlet secara berurutan | Masing-masing staff memakai saldo aktifnya sendiri; saldo staff A tidak mempengaruhi staff B. |
| Ada 2 kasir paralel dalam 1 outlet | Saat ini migration 032 membatasi satu session open per `branch_id`. Jika bisnis butuh paralel, tambah `cash_drawer_id/shift_slot` dan ubah unique index menjadi per drawer. |
| Ada setoran pending saat staff buka kas | Kas awal tetap saldo aktif terakhir, pending ditampilkan sebagai peringatan, tidak mengurangi saldo. |
| Deposit approved saat staff sudah membuka sesi baru | Saldo aktif berkurang via ledger; UI sesi berjalan harus menampilkan external movement agar expected cash tidak terlihat selisih palsu. |
| Admin koreksi saldo saat tidak ada sesi aktif | Langsung update `staff_cash_balances` dan ledger. Kas awal berikutnya memakai saldo baru. |
| Admin koreksi saldo saat sesi aktif | MVP: tampilkan warning. Adjustment masuk sebagai external movement dan harus terlihat di close summary. Alternatif aman: wajib tutup sesi dulu sebelum koreksi saldo aktif. |
| Penjualan tunai sudah tercatat tapi staff belum tutup kas | Saldo aktif persistent belum berubah; UI kas berjalan menampilkan proyeksi dari session summary. |
| Setoran ditolak admin | Saldo aktif tidak berubah; staff dapat submit ulang sesuai rule shift tertutup existing. |
| Staff berbeda dalam outlet sama | Key saldo adalah `branch_id + staff_id`; tidak boleh bercampur. |
| Pergantian tanggal setelah tengah malam | Session tetap dihitung berdasarkan `opened_at/closed_at`, bukan tanggal kalender saja. Kas awal berikutnya tetap dari saldo aktif terakhir. |
| RPC dipanggil ulang karena retry jaringan | Idempotency unique source mencegah saldo ter-apply dua kali. |
| Saldo akan negatif karena approval deposit | Reject approval atau require admin override dengan reason. Default: tidak boleh negatif. |

## 14. Validasi Anti Double Count

Wajib:

- `session_close` hanya membuat satu ledger per `cashier_sessions.id`.
- `deposit_approved` hanya membuat satu ledger per `cash_deposits.id`.
- Jika `confirm_deposit` sudah menginsert `cash_logs` deposit, jangan hitung `cash_logs` deposit lagi sebagai ledger saldo kecuali melalui `deposit_approved`.
- Jangan membuat ledger per penjualan tunai jika saldo sudah diupdate saat session close.
- Jika nantinya ingin real-time ledger per sale, maka `session_close` tidak boleh menambahkan total penjualan lagi; hanya rekonsiliasi selisih.
- `cash_deposits.status='pending'` tidak boleh masuk ledger pengurang saldo.

## 15. Implementation Map

### Frontend

| File | Perubahan |
|---|---|
| `pos.html` | Ubah modal buka shift dari input kas awal manual menjadi konfirmasi saldo otomatis + form selisih. |
| `js/pos.js` | Load saldo aktif sebelum buka modal; `confirmOpenShift()` panggil RPC open from balance; close shift panggil RPC apply balance. |
| `js/services/transactionService.js` | Replace direct insert/update `cashier_sessions` dengan RPC atomic. |
| `js/services/cashService.js` | Tambah method saldo staff/admin ledger; update summary jika ada external movement. |
| `js/depositService.js` | `confirmDeposit()` tetap dipakai, tetapi backend harus apply saldo. Tambahkan helper refresh saldo jika perlu. |
| `js/adminStaffCashUi.js` | Tampilkan saldo aktif staff, modal koreksi saldo, ledger staff. |
| `js/adminDepositUi.js` | Tampilkan dampak approval terhadap saldo staff dan refresh saldo setelah approve/reject. |
| `admin.html` | Tambah kolom/section saldo aktif dan modal koreksi saldo jika belum cukup. |

### Database

Rekomendasi migration baru:

```text
sql/migrations/034_staff_cash_balance_ledger.sql
```

Isi minimal:

- Create `staff_cash_balances`.
- Create `staff_cash_ledger`.
- Add columns to `cashier_sessions` and `cash_deposits`.
- Create/replace RPC saldo.
- Extend `confirm_deposit`.
- Revoke direct DML, grant execute RPC.
- Add indexes/idempotency constraints.

## 16. Testing Checklist

### Admin Set Saldo Awal Staff

- [ ] Admin set saldo Narti Rp10.000 dengan alasan.
- [ ] `staff_cash_balances.current_balance = 10000`.
- [ ] Ledger `admin_set_balance` tercatat dengan before/after.
- [ ] Tanpa alasan ditolak.
- [ ] Role staff tidak bisa set saldo via UI/RPC.

### Staff Buka Kas

- [ ] Modal buka kas menampilkan Rp10.000 otomatis.
- [ ] Staff konfirmasi, session dibuat `opening_cash=10000`.
- [ ] Input kas awal manual tidak tersedia sebagai sumber saldo.
- [ ] Jika kas fisik beda, alasan wajib dan variance tercatat.
- [ ] Staff tanpa saldo mendapat Rp0.

### Staff Tutup Kas

- [ ] Penjualan tunai Rp50.000 di sesi dengan opening Rp10.000.
- [ ] Close cash actual Rp60.000.
- [ ] Session closed dengan `closing_cash=60000`, `current_cash_amount=60000`.
- [ ] `staff_cash_balances.current_balance=60000`.
- [ ] Ledger `session_close` hanya satu kali.
- [ ] Retry close tidak menambah/mengubah saldo lagi.

### Penjualan Tunai

- [ ] Transaksi cash completed masuk ke summary sesi.
- [ ] Transaksi QRIS/transfer tidak menambah kas tunai.
- [ ] Void/refund mengurangi expected cash sesuai rule existing.
- [ ] Laporan penjualan tunai tetap sama dengan total `transactions`.

### Setoran Pending

- [ ] Staff submit setoran Rp50.000 dari saldo Rp60.000.
- [ ] `cash_deposits.status='pending'`.
- [ ] Saldo aktif tetap Rp60.000.
- [ ] UI admin/staff menampilkan pending Rp50.000.
- [ ] Kas awal berikutnya tetap Rp60.000 jika belum approved.

### Setoran Approved

- [ ] Admin approve setoran Rp50.000.
- [ ] `cash_deposits.status='confirmed'`, `reviewed_by`, `reviewed_at` terisi.
- [ ] `cash_logs` deposit out tercatat untuk laporan sesi.
- [ ] `staff_cash_balances.current_balance` turun dari Rp60.000 ke Rp10.000.
- [ ] Ledger `deposit_approved` tercatat.
- [ ] Approve ulang tidak mengurangi saldo lagi.
- [ ] Kas awal buka kas berikutnya Rp10.000.

### Setoran Rejected

- [ ] Admin reject setoran pending dengan alasan.
- [ ] Saldo aktif tidak berubah.
- [ ] Ledger optional `deposit_rejected` direction `none` tercatat atau audit deposit cukup.
- [ ] Staff bisa submit ulang untuk shift yang sama jika rule existing mengizinkan.

### Admin Adjustment

- [ ] Admin koreksi saldo Rp60.000 ke Rp10.000 dengan alasan.
- [ ] Saldo berubah ke Rp10.000.
- [ ] Ledger before/after/selisih/alasan tercatat.
- [ ] Koreksi ke nominal negatif ditolak.
- [ ] Concurrent edit dengan version lama ditolak atau minta refresh.

### Kas Awal Hari Berikutnya

- [ ] Setelah close Rp60.000, buka kas berikutnya otomatis Rp60.000.
- [ ] Setelah deposit approved Rp50.000, buka kas berikutnya otomatis Rp10.000.
- [ ] Saldo tidak reset ke 0 saat tanggal berganti.

### Tidak Double Count

- [ ] Session close tidak apply dua kali.
- [ ] Deposit approved tidak apply dua kali.
- [ ] Penjualan tunai tidak dihitung dua kali dari `transactions` dan `cash_logs`.
- [ ] Pending deposit tidak masuk ledger pengurang.
- [ ] Manual cash out existing tidak otomatis jadi adjustment saldo staff di luar session close.

### Multi Shift / Multi Staff

- [ ] Staff A dan Staff B punya saldo terpisah di cabang yang sama.
- [ ] Shift berurutan dalam satu outlet memakai saldo masing-masing staff.
- [ ] Jika parallel cashier dibutuhkan, test gagal dengan constraint existing sampai `cash_drawer_id` dibuat.

### Error Handling

- [ ] Gagal load saldo menampilkan pesan dan tombol refresh.
- [ ] RPC permission error tampil dengan pesan role.
- [ ] Conflict version/concurrent update tampil "Muat ulang saldo".
- [ ] Network retry tidak membuat ledger ganda.
- [ ] Data lama tanpa row saldo bisa dimigrasi/default ke 0 tanpa crash UI.

## 17. Migration Data Lama

Strategi awal:

1. Buat `staff_cash_balances` untuk semua staff aktif dengan `current_balance=0`.
2. Untuk staff yang punya closed session terakhir dan belum ada deposit pending/confirmed setelahnya, opsional seed dari `COALESCE(current_cash_amount, closing_cash, expected_cash, 0)`.
3. Jika histori lama tidak cukup konsisten, jangan auto seed nominal besar. Tampilkan saldo 0 dan minta admin set manual dengan alasan.
4. Catat semua seed non-zero sebagai ledger `system_repair` dengan metadata `migration`.

Rekomendasi aman: setelah deploy, admin melakukan set saldo awal per staff dari UI berdasarkan kas fisik aktual.

## 18. Definition of Done

- Staff buka kas tanpa input kas awal manual.
- Saldo aktif terakhir otomatis menjadi `opening_cash`.
- Tutup kas mengupdate saldo aktif staff.
- Setoran pending tidak mengubah saldo.
- Setoran approved mengurangi saldo.
- Admin bisa set/koreksi saldo dengan audit wajib.
- Ledger saldo staff lengkap dan idempotent.
- Laporan penjualan tunai tetap akurat.
- Semua edge case utama di checklist lulus.
