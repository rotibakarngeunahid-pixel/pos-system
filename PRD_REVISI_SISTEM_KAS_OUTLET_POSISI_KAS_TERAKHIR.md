# PRD Revisi Sistem Kas Outlet: Posisi Kas Terakhir Per Cabang

Tanggal: 2026-05-20  
Produk: Roti Bakar Ngeunah POS  
Area: POS Staff, Buka/Tutup Kas, Setoran Tunai, Approval Admin, Dashboard Admin, Laporan Kas  
Status: Draft teknis siap eksekusi AI builder  
Prioritas: Kritis  

## 1. Ringkasan

Revisi ini mengubah sumber kebenaran kas dari "saldo staff" menjadi "posisi kas outlet/cabang terakhir". Di codebase saat ini istilah teknis outlet adalah `branches`, sehingga PRD ini memakai istilah:

| Bahasa bisnis | Nama teknis existing |
|---|---|
| Outlet / Cabang | `branches` |
| Outlet ID | `branch_id` |
| Shift / kas aktif | `cashier_sessions` |
| Setoran tunai | `cash_deposits` |
| Log kas sesi | `cash_logs` |

Masalah utama: outlet bisa punya lebih dari satu staff. Kas awal staff berikutnya harus mengambil kas akhir terakhir di outlet yang sama, bukan kas akhir staff yang sama.

Contoh wajib:

```text
19 Mei: Evi tutup kas outlet Pamogan dengan kas akhir Rp22.000.
20 Mei: Jayak buka kas di outlet Pamogan.
Kas awal Jayak harus Rp22.000 karena itu posisi kas terakhir outlet Pamogan.
```

Prinsip final:

```text
Kas awal staff = posisi kas outlet saat ini
Kas akhir staff = posisi kas outlet terbaru setelah tutup kas
Setoran approved/confirmed = mengurangi posisi kas outlet
Koreksi admin = menetapkan posisi kas outlet baru
Default kas outlet = hanya dipakai jika outlet belum punya posisi/riwayat
```

## 2. Problem Statement

Flow sebelumnya/yang sedang dirancang masih berisiko berbasis `staff_id`, misalnya melalui `staff_cash_balances`. Desain itu salah untuk outlet dengan 2 staff atau lebih karena uang fisik berada di outlet/laci, bukan melekat permanen ke staff.

Dampak jika tetap berbasis staff:

| Risiko | Dampak |
|---|---|
| Staff berbeda buka kas | Kas awal bisa `0`, default, atau saldo staff itu sendiri, bukan kas outlet terakhir. |
| Dua shift sehari | Shift 2 bisa mulai dengan angka salah jika staff berbeda. |
| Setoran approved | Pengurangan saldo bisa diterapkan ke staff, padahal posisi kas outlet yang harus berubah. |
| Admin monitoring | Admin melihat "staff memegang kas" padahal yang dibutuhkan adalah "outlet punya kas berapa sekarang". |
| Audit | Riwayat kas tidak menjawab perpindahan antar staff di outlet yang sama. |

## 3. Tujuan

1. Kas awal otomatis mengambil posisi kas terakhir outlet berdasarkan `branch_id`.
2. Sistem tidak mencari kas awal berdasarkan `staff_id`.
3. Satu outlet memiliki satu posisi kas settled/current yang menjadi sumber `opening_cash`.
4. Staff berbeda di outlet yang sama tetap mendapat kas awal yang benar.
5. Outlet baru memakai `branches.default_cash_position` jika belum ada posisi kas.
6. Setoran pending tidak mengubah posisi kas outlet.
7. Setoran `confirmed`/approved mengurangi posisi kas outlet satu kali.
8. Admin dapat melihat posisi kas terkini semua outlet.
9. Admin dapat koreksi posisi kas outlet dengan alasan wajib.
10. Semua perubahan posisi kas tercatat append-only di audit ledger.
11. Tidak ada lebih dari satu shift kas `open` per outlet, kecuali di masa depan sistem mendukung multi-register.
12. Tidak merusak login, dashboard, POS, laporan kas, setoran, approval, dan flow lama.

## 4. Non-Goals

- Tidak membuat ulang modul transaksi POS.
- Tidak menghapus histori `cashier_sessions`, `cash_logs`, `cash_deposits`, atau transaksi lama.
- Tidak mengubah aturan nominal setoran existing kecuali diperlukan oleh flow kas.
- Tidak menambah multi-register/cash drawer parallel.
- Tidak membuat rekonsiliasi bank otomatis.
- Tidak mengganti istilah database `branch_id` menjadi `outlet_id` di seluruh codebase.

## 5. Current System Context

File/konsep existing yang harus dibaca sebelum implementasi:

| Area | File/tabel |
|---|---|
| POS staff | `pos.html`, `js/pos.js` |
| Service shift | `js/services/transactionService.js` |
| Ringkasan kas | `js/services/cashService.js` |
| Setoran staff/admin | `js/depositService.js`, `js/depositUi.js`, `js/adminDepositUi.js` |
| Admin kas staff existing | `js/adminStaffCashUi.js`, `admin.html`, `js/admin.js` |
| Shift kas | `public.cashier_sessions` |
| Setoran | `public.cash_deposits` |
| Log kas sesi | `public.cash_logs` |
| Cabang/outlet | `public.branches` |
| Guard 1 shift aktif/cabang | `sql/migrations/032_enforce_single_open_cashier_per_branch.sql` |
| Desain saldo staff yang harus direvisi | `sql/migrations/034_staff_cash_balance_ledger.sql` |

Catatan status:

- Migration `032` sudah benar arahnya karena membuat unique index satu `cashier_sessions.status='open'` per `branch_id`.
- Migration `034` menambah `staff_cash_balances` dan `staff_cash_ledger`. Untuk revisi ini, tabel tersebut tidak boleh menjadi source of truth kas awal. Source of truth harus per `branch_id`.
- Status deposit existing adalah `pending`, `confirmed`, `rejected`. Di UI boleh disebut approved, tetapi DB sebaiknya tetap memakai `confirmed` agar tidak breaking change.
- Status session existing adalah `open`, `closed`. UI boleh menampilkan `Aktif`, tetapi DB tidak perlu diubah menjadi `active`.

## 6. Definisi

| Istilah | Definisi |
|---|---|
| Posisi kas outlet | Kas settled terakhir milik outlet. Sumber `opening_cash` shift berikutnya. |
| Kas awal otomatis | `opening_cash` yang diambil dari posisi kas outlet saat staff buka kas. |
| Kas akhir aktual | Nominal fisik yang diinput staff saat tutup kas. Menjadi posisi kas outlet baru. |
| Estimasi kas sistem | `opening_cash + penjualan tunai + kas masuk - kas keluar - refund - void - setoran confirmed terkait`. |
| Shift aktif | Row `cashier_sessions.status='open'` pada satu `branch_id`. |
| Setoran pending | `cash_deposits.status='pending'`; belum mengubah posisi kas outlet. |
| Setoran approved | DB existing: `cash_deposits.status='confirmed'`; mengurangi posisi kas outlet. |
| Koreksi admin | Penetapan manual posisi kas outlet dengan alasan wajib. |
| Ledger outlet | Audit append-only semua perubahan posisi kas outlet. |

## 7. Prinsip Data

1. `branch_cash_balances.current_balance` adalah source of truth posisi kas outlet settled.
2. `cashier_sessions.opening_cash` adalah snapshot posisi outlet saat shift dibuka.
3. `cashier_sessions.closing_cash` adalah kas akhir aktual dan menjadi posisi outlet setelah shift ditutup.
4. Selama ada shift aktif, `current_balance` tetap posisi settled sebelum shift dibuka; UI boleh menampilkan estimasi berjalan.
5. Pending deposit tidak mengubah `current_balance`.
6. Deposit `confirmed` mengurangi `current_balance` secara idempotent.
7. Koreksi admin tidak menghapus histori, hanya membuat ledger adjustment baru.
8. Semua write penting harus berada dalam transaction/RPC backend, bukan rangkaian update bebas di client.
9. Jangan menghitung posisi outlet dengan menjumlah saldo staff. Untuk satu outlet satu laci, itu akan salah.
10. Semua nilai kas harus `numeric(15,2)` dan tidak negatif, kecuali ada keputusan eksplisit untuk mode audit negatif. MVP: blokir negatif.

## 8. Scope Fitur

In scope:

- Revisi flow buka kas staff.
- Revisi flow tutup kas staff.
- Revisi logic posisi kas outlet per `branch_id`.
- Revisi logic kas awal otomatis.
- Outlet dengan 1, 2, atau lebih staff.
- Dua shift atau lebih dalam satu hari.
- Staff berbeda membuka kas berikutnya.
- Shift sebelumnya belum tutup kas.
- Setoran tunai dan approval admin mempengaruhi posisi outlet.
- Koreksi manual posisi kas outlet oleh admin.
- Halaman admin `Kas Outlet` / `Posisi Kas Cabang`.
- Detail riwayat kas per outlet.
- Audit log semua perubahan posisi kas.
- Anti double active shift dan anti double submit.
- Edge case dan regression testing.

Out of scope MVP:

- Multi-register dalam satu outlet.
- Split cash drawer per kasir.
- Rekonsiliasi bank/QRIS otomatis.
- Approval multi-level.
- Import histori kas manual massal selain seed posisi awal.

## 9. Data Model Target

### 9.1 Alter `branches`

Tambahkan default kas outlet. Jangan simpan current balance di `branches` jika sudah ada tabel balance khusus.

```sql
ALTER TABLE public.branches
  ADD COLUMN IF NOT EXISTS default_cash_position numeric(15,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS default_cash_updated_at timestamptz,
  ADD COLUMN IF NOT EXISTS default_cash_updated_by bigint REFERENCES public.users(id);
```

Rules:

- `default_cash_position` hanya dipakai untuk outlet yang belum punya row di `branch_cash_balances` dan belum punya histori kas valid.
- Perubahan default setelah outlet punya posisi kas tidak otomatis mengubah posisi kas current; admin harus pakai koreksi kas.

### 9.2 Tabel Baru `branch_cash_balances`

Satu row per outlet/cabang.

```sql
CREATE TABLE IF NOT EXISTS public.branch_cash_balances (
  id bigserial PRIMARY KEY,
  branch_id bigint NOT NULL REFERENCES public.branches(id),
  current_balance numeric(15,2) NOT NULL DEFAULT 0 CHECK (current_balance >= 0),
  current_status text NOT NULL DEFAULT 'idle'
    CHECK (current_status IN ('idle','active','needs_review')),
  last_open_session_id bigint REFERENCES public.cashier_sessions(id),
  last_closed_session_id bigint REFERENCES public.cashier_sessions(id),
  last_opened_by bigint REFERENCES public.users(id),
  last_closed_by bigint REFERENCES public.users(id),
  last_ledger_id bigint,
  last_movement_type text,
  version bigint NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by bigint REFERENCES public.users(id),
  UNIQUE (branch_id)
);
```

Notes:

- `current_status='active'` berarti ada shift open di outlet.
- Source valid untuk status tetap `cashier_sessions WHERE status='open'`; field status di balance hanya cache/summary.
- `version` dipakai optimistic concurrency untuk admin correction.

### 9.3 Tabel Baru `branch_cash_ledger`

Append-only audit posisi kas outlet.

```sql
CREATE TABLE IF NOT EXISTS public.branch_cash_ledger (
  id bigserial PRIMARY KEY,
  branch_id bigint NOT NULL REFERENCES public.branches(id),
  staff_id bigint REFERENCES public.users(id),
  admin_id bigint REFERENCES public.users(id),
  cash_session_id bigint REFERENCES public.cashier_sessions(id),
  deposit_id uuid REFERENCES public.cash_deposits(id),
  movement_type text NOT NULL CHECK (movement_type IN (
    'default_seed',
    'session_open_confirm',
    'opening_variance',
    'session_close',
    'deposit_approved',
    'deposit_rejected',
    'admin_adjustment',
    'force_close',
    'system_repair'
  )),
  direction text NOT NULL CHECK (direction IN ('in','out','adjust','none')),
  amount numeric(15,2) NOT NULL DEFAULT 0,
  balance_before numeric(15,2) NOT NULL,
  balance_after numeric(15,2) NOT NULL,
  expected_balance numeric(15,2),
  variance_amount numeric(15,2),
  reason text,
  source_table text,
  source_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_branch_cash_ledger_unique_source
  ON public.branch_cash_ledger(source_table, source_id, movement_type)
  WHERE source_table IS NOT NULL AND source_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_branch_cash_ledger_branch_created
  ON public.branch_cash_ledger(branch_id, created_at DESC);
```

Rules:

- Tidak ada UPDATE/DELETE dari app role untuk ledger.
- Semua perubahan posisi kas harus menghasilkan ledger.
- `source_table + source_id + movement_type` mencegah double apply.

### 9.4 Alter `cashier_sessions`

Tambahkan kolom audit tanpa mengubah flow lama.

```sql
ALTER TABLE public.cashier_sessions
  ADD COLUMN IF NOT EXISTS opening_cash_source text DEFAULT 'manual',
  ADD COLUMN IF NOT EXISTS opening_branch_balance_id bigint REFERENCES public.branch_cash_balances(id),
  ADD COLUMN IF NOT EXISTS opening_confirmed_at timestamptz,
  ADD COLUMN IF NOT EXISTS opening_confirmed_by bigint REFERENCES public.users(id),
  ADD COLUMN IF NOT EXISTS opening_physical_cash numeric(15,2),
  ADD COLUMN IF NOT EXISTS opening_variance_amount numeric(15,2),
  ADD COLUMN IF NOT EXISTS opening_variance_reason text,
  ADD COLUMN IF NOT EXISTS closing_note text,
  ADD COLUMN IF NOT EXISTS balance_applied_at timestamptz,
  ADD COLUMN IF NOT EXISTS balance_ledger_id bigint REFERENCES public.branch_cash_ledger(id);
```

Mapping:

- `opening_cash_source='branch_balance'` untuk flow baru.
- `opening_cash` tetap dipakai agar laporan lama tidak rusak.
- `closing_cash` tetap nominal kas fisik akhir.
- `expected_cash` tetap estimasi sistem saat close.
- `current_cash_amount` boleh tetap diisi untuk kompatibilitas UI lama.

### 9.5 Alter `cash_deposits`

Gunakan kolom idempotency existing bila sudah ada dari migration `034`; jika belum, tambahkan.

```sql
ALTER TABLE public.cash_deposits
  ADD COLUMN IF NOT EXISTS balance_applied_at timestamptz,
  ADD COLUMN IF NOT EXISTS branch_balance_ledger_id bigint REFERENCES public.branch_cash_ledger(id);
```

Jika kolom existing bernama `balance_ledger_id`, boleh dipakai ulang, tetapi referensinya harus diarahkan ke ledger outlet atau diberi kolom baru agar tidak ambigu.

### 9.6 Deprecated / Compatibility

Jika `staff_cash_balances` dan `staff_cash_ledger` sudah terlanjur dibuat:

- Jangan pakai sebagai sumber kas awal.
- Jangan sum `staff_cash_balances.current_balance` untuk menghasilkan posisi outlet.
- Boleh dipertahankan sementara untuk read-only legacy/admin audit.
- Tambahkan PRD/issue terpisah untuk deprecate UI `Posisi Kas Staff` menjadi `Kas Outlet`.

Jika migration `034` belum deployed:

- Jangan lanjutkan desain saldo per staff.
- Buat migration baru berbasis outlet, misalnya `035_branch_cash_balance_ledger.sql`, atau revisi `034` sebelum masuk production.

## 10. RPC / Backend Contract

Semua operasi mutasi kas harus melalui RPC `SECURITY DEFINER` dengan `SET search_path = public, pg_temp`.

### 10.1 `get_branch_cash_position`

Tujuan: data buka kas staff dan detail outlet.

Signature:

```sql
get_branch_cash_position(p_branch_id bigint, p_user_id bigint DEFAULT NULL) RETURNS jsonb
```

Return minimal:

```json
{
  "branch_id": 1,
  "branch_name": "Pamogan",
  "balance_id": 10,
  "current_balance": 22000,
  "source": "branch_balance|default_cash|latest_closed_session",
  "version": 3,
  "has_balance_row": true,
  "current_status": "idle",
  "open_session": null,
  "last_closed_session": {
    "id": 99,
    "staff_id": 5,
    "staff_name": "Evi",
    "closed_at": "2026-05-19T23:00:00+08:00",
    "opening_cash": 10000,
    "closing_cash": 22000,
    "expected_cash": 22000,
    "variance": 0
  },
  "pending_deposit_amount": 0,
  "running_estimated_cash": null,
  "updated_at": "2026-05-19T23:00:00+08:00"
}
```

Rules:

- Staff hanya boleh membaca branch miliknya.
- Admin/owner boleh membaca semua branch.
- Jika ada shift open, return `open_session` dengan staff aktif dan opened_at.

### 10.2 `get_admin_branch_cash_positions`

Tujuan: halaman admin daftar semua outlet.

Signature:

```sql
get_admin_branch_cash_positions(
  p_admin_id bigint,
  p_branch_id bigint DEFAULT NULL,
  p_staff_id bigint DEFAULT NULL,
  p_status text DEFAULT 'all',
  p_date_from date DEFAULT NULL,
  p_date_to date DEFAULT NULL
) RETURNS TABLE (...)
```

Kolom minimal:

| Kolom | Isi |
|---|---|
| `branch_id` | ID outlet |
| `branch_name` | Nama outlet |
| `current_balance` | Posisi kas settled |
| `running_estimated_cash` | Estimasi jika ada shift open |
| `balance_id` | ID row balance |
| `version` | Untuk koreksi optimistic lock |
| `last_opening_cash` | Kas awal session terakhir |
| `last_closing_cash` | Kas akhir session terakhir |
| `last_opened_by_name` | Staff terakhir buka |
| `last_closed_by_name` | Staff terakhir tutup |
| `last_updated` | Timestamp posisi outlet |
| `shift_status` | `none/open/closed_today/needs_review` |
| `open_session_id` | Shift aktif jika ada |
| `open_staff_name` | Staff aktif jika ada |
| `open_session_opened_at` | Jam buka shift aktif |
| `pending_deposit_amount` | Total setoran pending outlet |
| `last_variance_amount` | Selisih terakhir |
| `has_variance` | boolean |

### 10.3 `open_cash_session_from_branch_balance`

Tujuan: buka kas atomik dari posisi outlet.

Signature:

```sql
open_cash_session_from_branch_balance(
  p_branch_id bigint,
  p_staff_id bigint,
  p_physical_cash numeric DEFAULT NULL,
  p_variance_reason text DEFAULT NULL
) RETURNS jsonb
```

Transaction rules:

1. Validasi staff aktif dan `users.branch_id = p_branch_id`.
2. Ambil advisory lock per branch: `pg_advisory_xact_lock(hashtext('branch_cash:' || p_branch_id))`.
3. Cek tidak ada `cashier_sessions.status='open'` untuk branch.
4. Lock/create row `branch_cash_balances FOR UPDATE`.
5. Jika row belum ada, seed dari:
   - `branches.default_cash_position`, jika tidak ada session closed valid.
   - latest valid closed session, jika strategi backfill belum jalan dan ada histori.
6. `opening_cash = branch_cash_balances.current_balance`.
7. Jika `p_physical_cash` diberikan dan beda dari `opening_cash`, `p_variance_reason` wajib.
8. Insert `cashier_sessions` status `open` dengan `opening_cash_source='branch_balance'`.
9. Insert ledger `session_open_confirm` direction `none`.
10. Jika ada variance, insert ledger `opening_variance` direction `in/out`, tetapi jangan ubah balance saat open. Balance berubah saat close atau admin correction.
11. Update `branch_cash_balances.current_status='active'`, `last_open_session_id`, `last_opened_by`, `updated_at`.
12. Return data session dan opening cash.

Friendly error:

```text
Shift sebelumnya di outlet ini belum ditutup. Silakan minta staff sebelumnya menutup kas terlebih dahulu atau hubungi admin.
```

Jika duplicate karena race condition, tangkap `unique_violation` dari index `idx_cashier_sessions_one_open_per_branch` dan return error yang sama.

### 10.4 `close_cash_session_apply_branch_balance`

Tujuan: tutup shift dan update posisi outlet atomik.

Signature:

```sql
close_cash_session_apply_branch_balance(
  p_session_id bigint,
  p_closing_cash numeric,
  p_staff_id bigint,
  p_closing_note text DEFAULT NULL
) RETURNS jsonb
```

Transaction rules:

1. Validasi `p_closing_cash >= 0`.
2. Lock `cashier_sessions` by `p_session_id FOR UPDATE`.
3. Jika status sudah `closed`, return idempotent `already_closed=true`; jangan update balance lagi.
4. Validasi session milik `p_staff_id`.
5. Hitung `expected_cash` menggunakan logic existing `compute_cash_session_system_amount()` atau formula konsisten `cashService.getSummary()`.
6. `variance = p_closing_cash - expected_cash`.
7. Jika variance != 0, `p_closing_note` wajib.
8. Lock `branch_cash_balances FOR UPDATE`.
9. Update session: `status='closed'`, `closing_cash`, `expected_cash`, `current_cash_amount=p_closing_cash`, `closed_at=now()`, `balance_applied_at=now()`, `closing_note`.
10. Update balance: `current_balance=p_closing_cash`, `current_status='idle'`, `last_closed_session_id`, `last_closed_by`, `version+1`.
11. Insert ledger `session_close` dengan before/after, expected, variance.
12. Set `cashier_sessions.balance_ledger_id`.
13. Return before/after, expected, variance, ledger id.

### 10.5 `confirm_deposit`

Tujuan: approve/reject setoran dan apply ke posisi outlet satu kali.

Pertahankan signature existing:

```sql
confirm_deposit(p_deposit_id uuid, p_admin_id bigint, p_action text, p_reject_reason text DEFAULT NULL)
```

Rules:

- `p_action='confirmed'` berarti approved.
- `p_action='rejected'` berarti rejected.
- Hanya admin/owner.
- Deposit harus `pending`.
- Deposit harus punya `branch_id`.
- Deposit harus terkait session `closed` sesuai rule existing migration `030`.
- Saat rejected:
  - Update status rejected + reason.
  - Insert ledger `deposit_rejected` direction `none` optional tapi direkomendasikan.
  - Jangan ubah `branch_cash_balances.current_balance`.
- Saat confirmed:
  - Update status confirmed.
  - Insert `cash_logs` out `reference_type='deposit'` seperti existing.
  - Jika `balance_applied_at IS NULL`, lock `branch_cash_balances FOR UPDATE`.
  - Validasi `current_balance - amount >= 0`; jika negatif, blokir dengan pesan admin harus koreksi dulu atau pilih override terpisah.
  - Update `current_balance -= amount`, `version+1`, `updated_by=p_admin_id`.
  - Insert ledger `deposit_approved`.
  - Set `cash_deposits.balance_applied_at` dan ledger id.
  - Idempotent: deposit yang sama tidak boleh mengurangi dua kali.

### 10.6 `admin_set_branch_cash_balance`

Tujuan: admin koreksi posisi kas outlet.

Signature:

```sql
admin_set_branch_cash_balance(
  p_admin_id bigint,
  p_branch_id bigint,
  p_new_balance numeric,
  p_reason text,
  p_version bigint DEFAULT NULL
) RETURNS jsonb
```

Rules:

- Hanya admin/owner.
- `p_new_balance >= 0`.
- `p_reason` wajib dan minimal 5 karakter setelah trim.
- Lock balance row `FOR UPDATE`.
- Jika `p_version` tidak cocok, reject: "Data posisi kas berubah. Muat ulang sebelum menyimpan."
- Insert ledger `admin_adjustment`.
- Update `current_balance=p_new_balance`, `version+1`, `updated_by`.
- Jika ada shift open, koreksi tetap boleh hanya untuk emergency dan harus:
  - Tampilkan warning di UI.
  - Ledger metadata menyimpan `open_session_id`.
  - Admin paham kas awal shift aktif tidak berubah; running estimate bisa berubah di tampilan admin.

### 10.7 `get_branch_cash_ledger`

Tujuan: detail riwayat outlet.

Signature:

```sql
get_branch_cash_ledger(
  p_admin_id bigint,
  p_branch_id bigint,
  p_date_from timestamptz DEFAULT NULL,
  p_date_to timestamptz DEFAULT NULL,
  p_movement_type text DEFAULT NULL,
  p_limit integer DEFAULT 100
) RETURNS TABLE (...)
```

Kolom:

`id`, `movement_type`, `direction`, `amount`, `balance_before`, `balance_after`, `expected_balance`, `variance_amount`, `reason`, `staff_name`, `admin_name`, `cash_session_id`, `deposit_id`, `source_table`, `source_id`, `created_at`, `metadata`.

### 10.8 `admin_force_close_branch_cash_session`

Tujuan: emergency jika staff lupa tutup kas.

Signature:

```sql
admin_force_close_branch_cash_session(
  p_admin_id bigint,
  p_session_id bigint,
  p_closing_cash numeric,
  p_reason text
) RETURNS jsonb
```

Rules:

- Hanya admin/owner.
- Alasan wajib.
- Reuse logic close session.
- Session status boleh tetap `closed` dengan metadata `forced=true`, atau jika DB mendukung status baru gunakan `forced_closed`. Untuk menghindari breaking change, rekomendasi MVP: `status='closed'` + ledger `force_close` + metadata.
- Staff berikutnya bisa buka kas dari posisi hasil forced close.

## 11. Flow Buka Kas Staff

Step:

1. Staff login.
2. Client membaca `currentUser.branch_id`.
3. Client memanggil `get_branch_cash_position(branch_id, staff_id)`.
4. Jika ada `open_session`, tampilkan blocker:
   - nama staff aktif
   - outlet
   - jam buka
   - instruksi tutup kas/hubungi admin
   - tombol buka kas disabled
5. Jika tidak ada open session:
   - tampilkan kas awal otomatis dari `current_balance`.
   - tampilkan sumber: posisi kas terakhir outlet atau default outlet.
   - tampilkan staff terakhir yang menutup kas jika ada.
6. Staff konfirmasi kas awal.
7. Jika kas fisik berbeda, staff isi kas fisik dan alasan selisih.
8. Client memanggil `open_cash_session_from_branch_balance`.
9. Backend membuat session `open`, mengunci outlet sebagai active, membuat ledger.
10. POS masuk mode transaksi.

Kas awal tidak boleh berasal dari:

- `staff_id` staff yang sedang login.
- `staff_cash_balances`.
- Input manual bebas tanpa audit.
- Default outlet jika sudah ada posisi outlet valid.

## 12. Flow Tutup Kas Staff

Step:

1. Staff klik tutup kas.
2. Sistem menampilkan:
   - kas awal
   - total penjualan tunai
   - kas masuk manual
   - kas keluar manual
   - refund/void tunai
   - setoran confirmed terkait session
   - setoran pending sebagai informasi
   - estimasi kas akhir sistem
3. Staff input kas fisik akhir.
4. Sistem hitung `variance = actual_closing_cash - expected_closing_cash`.
5. Jika variance != 0, catatan wajib.
6. Submit memanggil `close_cash_session_apply_branch_balance`.
7. Backend menutup session, update posisi outlet menjadi kas fisik akhir, insert ledger.
8. UI menampilkan sukses: "Posisi kas outlet diperbarui menjadi RpX."
9. Staff berikutnya di outlet yang sama mendapat kas awal RpX.

## 13. Flow Staff Berbeda

Scenario:

```text
Evi tutup kas Pamogan Rp22.000.
branch_cash_balances(Pamogan).current_balance = 22000.
Jayak buka kas Pamogan.
opening_cash Jayak = 22000.
```

Rules:

- Query opening cash wajib `WHERE branch_id = p_branch_id`.
- `staff_id` hanya dipakai untuk audit, permission, dan ownership session.
- Staff terakhir yang menutup kas tampil sebagai informasi audit, bukan filter sumber saldo.

## 14. Flow Dua Shift Dalam Satu Hari

Rules:

1. Shift 2 boleh buka hanya jika shift 1 sudah `closed`.
2. Kas awal shift 2 = kas akhir aktual shift 1, setelah dikurangi deposit approved yang terjadi sebelum shift 2 dibuka.
3. Jika shift 1 masih `open`, shift 2 diblokir.
4. Blokir harus terjadi di UI dan backend.
5. Backend guard wajib: unique index `cashier_sessions(branch_id) WHERE status='open'`.
6. Admin bisa forced close hanya untuk emergency dan wajib audit.

## 15. Flow Shift Belum Tutup

Jika ada session open pada branch:

UI staff menampilkan:

```text
Shift sebelumnya di outlet ini belum ditutup.
Staff aktif: Jayak
Dibuka: 20 Mei 2026 08:00
Outlet: Pamogan
Silakan minta staff sebelumnya menutup kas terlebih dahulu atau hubungi admin.
```

Backend:

- Reject RPC open.
- Tidak membuat `cashier_sessions` baru.
- Tidak mengubah `branch_cash_balances`.
- Tidak membuat ledger open baru.

Admin dashboard:

- Status outlet `Sedang Aktif`.
- Tampilkan staff aktif dan durasi shift.
- Tampilkan action `Detail` dan `Forced Close` untuk admin/owner.

## 16. Flow Setoran Tunai

Keputusan MVP: setoran hanya boleh dibuat untuk shift yang sudah ditutup. Ini sesuai migration existing `030_enforce_closed_shift_before_cash_deposit.sql` dan menghindari double count saat shift masih berjalan.

Flow:

1. Staff/admin membuat setoran dari closed session.
2. Status awal `pending`.
3. Posisi kas outlet tidak berubah.
4. Admin approve:
   - status DB menjadi `confirmed`
   - `cash_logs` out dibuat untuk laporan kas sesi
   - `branch_cash_balances.current_balance -= amount`
   - ledger `deposit_approved` dibuat
5. Admin reject:
   - status DB menjadi `rejected`
   - posisi kas outlet tidak berubah
   - reason disimpan
   - ledger `deposit_rejected` direkomendasikan

Example:

```text
Posisi Pamogan Rp22.000.
Setoran Rp10.000 dibuat pending.
Posisi tetap Rp22.000.
Admin approve.
Posisi Pamogan menjadi Rp12.000.
Shift berikutnya opening_cash Rp12.000.
```

Validasi:

- Pending tidak mengurangi posisi.
- Rejected tidak mengurangi posisi.
- Confirmed mengurangi tepat satu kali.
- Jika amount > current balance, reject approval dengan pesan jelas.
- Double click approve tidak boleh double apply.

## 17. Flow Koreksi Admin

Flow:

1. Admin buka `Kas Outlet`.
2. Pilih outlet.
3. Klik `Koreksi Kas`.
4. Sistem tampilkan current position, version, last update, shift status.
5. Admin input `new_cash_position`.
6. Admin wajib isi alasan.
7. Backend lock balance, cek version, update current balance, insert ledger.
8. Staff berikutnya mendapat kas awal dari nilai koreksi.

Field audit:

| Field | Isi |
|---|---|
| `branch_id` | Outlet |
| `balance_before` | Posisi sebelum koreksi |
| `balance_after` | Posisi baru |
| `amount` | `ABS(after-before)` |
| `direction` | `adjust` |
| `reason` | Alasan admin |
| `admin_id` | Admin pelaku |
| `created_at` | Timestamp |
| `source_table/source_id` | `branch_cash_balances/<id>` |

## 18. Rumus Posisi Kas

### 18.1 Posisi Settled

```text
posisi_kas_outlet_saat_ini = branch_cash_balances.current_balance
```

Cara nilai ini berubah:

```text
Outlet baru:
  current_balance = branches.default_cash_position

Tutup kas:
  current_balance = actual_closing_cash

Setoran confirmed:
  current_balance = current_balance - deposit.amount

Koreksi admin:
  current_balance = admin_new_balance
```

### 18.2 Saat Shift Aktif

```text
settled_position = posisi sebelum shift aktif dibuka

running_estimated_cash =
  opening_cash
  + cash_sales_completed
  + manual_cash_in
  - manual_cash_out
  - refund_cash
  - void_cash
  - confirmed_deposit_for_session
```

UI admin harus menampilkan keduanya jika ada shift aktif:

- `Posisi kas settled`: posisi sebelum close.
- `Estimasi kas berjalan`: estimasi berdasarkan transaksi shift aktif.

### 18.3 Pending Deposit

```text
pending_deposit_amount =
  SUM(cash_deposits.amount)
  WHERE branch_id = outlet
    AND status = 'pending'
```

Pending deposit hanya label/informasi. Jangan kurangi current balance.

## 19. UI/UX Staff

### 19.1 Halaman Buka Kas

Tampilkan:

- Nama outlet.
- Kas awal otomatis.
- Label: "Kas awal ini diambil dari posisi kas terakhir outlet."
- Sumber kas:
  - "Dari kas akhir terakhir"
  - "Dari default outlet" jika outlet baru
  - "Dari koreksi admin" jika latest movement admin adjustment
- Info last close: "Kas terakhir ditutup oleh Evi pada 19 Mei 2026 23:00."
- Input opsional kas fisik saat pembukaan.
- Input alasan selisih jika kas fisik != kas sistem.
- Tombol `Konfirmasi Buka Kas`.

Jika ada shift aktif:

- Jangan tampilkan tombol buka kas.
- Tampilkan blocker berisi staff aktif, jam buka, outlet, instruksi.

### 19.2 Halaman Tutup Kas

Tampilkan:

- Kas awal.
- Penjualan tunai.
- Kas masuk manual.
- Kas keluar manual.
- Refund/void.
- Setoran confirmed.
- Setoran pending.
- Estimasi kas akhir sistem.
- Input kas fisik akhir.
- Selisih otomatis.
- Catatan wajib jika selisih tidak 0.

Setelah sukses:

- Tampilkan posisi kas outlet terbaru.
- Refresh session state.
- Jangan izinkan submit ulang mengubah angka lagi.

## 20. UI/UX Admin

Nama menu: `Kas Outlet` atau `Posisi Kas Cabang`.

### 20.1 Summary Cards

| Card | Definisi |
|---|---|
| Total Kas Outlet | SUM current balance semua outlet aktif. |
| Outlet Shift Aktif | Count outlet dengan session open. |
| Setoran Pending | Count dan nominal deposit pending. |
| Selisih Kas | Count outlet dengan variance terakhir != 0. |

### 20.2 Tabel Outlet

Kolom:

1. Nama outlet.
2. Posisi kas saat ini.
3. Estimasi kas berjalan jika shift aktif.
4. Kas awal terakhir.
5. Kas akhir terakhir.
6. Staff terakhir buka.
7. Staff terakhir tutup.
8. Update terakhir.
9. Status shift: belum buka, aktif, sudah tutup, perlu review.
10. Setoran pending: ada/tidak + nominal.
11. Selisih kas terakhir.
12. Action: detail.
13. Action: koreksi kas.
14. Action: riwayat kas.
15. Action: forced close jika shift aktif dan role admin/owner.

### 20.3 Detail Outlet

Tab/panel:

- Ringkasan posisi kas.
- Shift aktif jika ada.
- Riwayat buka/tutup kas.
- Riwayat setoran.
- Riwayat koreksi admin.
- Audit ledger.
- Bukti setoran.
- Catatan selisih buka/tutup.

### 20.4 Filter

- Outlet.
- Tanggal.
- Staff.
- Status kas/shift.
- Ada selisih.
- Ada setoran pending.
- Range tanggal.
- Metode setoran.
- Movement type ledger.

## 21. Permission dan Security

### 21.1 Staff

- Hanya bisa membaca posisi branch miliknya.
- Hanya bisa buka kas untuk branch miliknya.
- Hanya bisa tutup session miliknya.
- Tidak bisa koreksi balance.
- Tidak bisa direct insert/update/delete `branch_cash_balances` atau `branch_cash_ledger`.

### 21.2 Admin/Owner

- Bisa membaca semua branch.
- Bisa koreksi posisi kas dengan alasan.
- Bisa approve/reject setoran.
- Bisa forced close.
- Semua action admin masuk ledger.

### 21.3 Grants

Rekomendasi:

```sql
REVOKE INSERT, UPDATE, DELETE ON public.branch_cash_balances FROM anon, authenticated;
REVOKE INSERT, UPDATE, DELETE ON public.branch_cash_ledger FROM anon, authenticated;
GRANT SELECT ON public.branch_cash_balances TO anon, authenticated;
GRANT SELECT ON public.branch_cash_ledger TO anon, authenticated;
GRANT EXECUTE ON FUNCTION ... TO anon, authenticated;
```

Jika RLS aktif, policy harus konsisten dengan role app. Karena banyak RPC `SECURITY DEFINER`, validasi role di dalam function tetap wajib.

## 22. Race Condition dan Idempotency

Risiko dan guard:

| Risiko | Guard |
|---|---|
| Dua staff klik buka kas bersamaan | unique index `cashier_sessions(branch_id) WHERE status='open'` + advisory lock branch. |
| Double click buka kas | tombol disabled client + backend unique index. |
| Double click tutup kas | lock session `FOR UPDATE`, return `already_closed=true` jika sudah closed. |
| Double approve deposit | lock deposit `FOR UPDATE`, cek status pending, cek `balance_applied_at IS NULL`, unique ledger source. |
| Admin koreksi dari data stale | `version` optimistic lock. |
| Error tengah transaksi | RPC transaction rollback otomatis. |
| Ledger duplicate | unique index source. |

## 23. Migration / Backfill Strategy

### 23.1 Jika Belum Production

Rekomendasi paling aman:

1. Jangan deploy migration saldo per staff sebagai source of truth.
2. Buat migration branch-based.
3. Update UI staff/admin ke RPC branch-based.
4. Hapus fallback yang membuka shift dengan `opening_cash=0` ketika RPC tidak ada, atau tampilkan error eksplisit.

### 23.2 Jika `034_staff_cash_balance_ledger.sql` Sudah Deployed

Jangan otomatis menjumlah saldo staff.

Backfill `branch_cash_balances` dengan urutan:

1. Ambil latest valid closed session per branch:
   - `cashier_sessions.status='closed'`
   - `closing_cash IS NOT NULL`
   - order by `closed_at DESC`
2. Seed `current_balance = closing_cash` dari session tersebut.
3. Tandai ledger `system_repair` atau `default_seed`.
4. Jika tidak ada closed session, pakai `branches.default_cash_position`.
5. Buat report review untuk branch yang punya:
   - lebih dari satu `staff_cash_balances.current_balance > 0`
   - session open saat migrasi
   - deposit confirmed setelah latest close yang belum punya balance apply
6. Admin wajib verifikasi fisik untuk branch flagged.

Catatan:

- Jika deposit approved setelah latest close sudah mengurangi saldo staff lama, jangan otomatis apply lagi ke branch tanpa audit. Gunakan `cash_deposits.balance_applied_at` dan ledger source untuk idempotency.
- Migration sebaiknya menulis metadata backfill agar audit jelas.

## 24. Edge Cases

| Case | Expected behavior |
|---|---|
| Outlet baru tanpa riwayat | Opening cash = `branches.default_cash_position`; create balance row. |
| Outlet 1 staff | Flow tetap normal. |
| Outlet 2 staff | Staff kedua mendapat kas akhir outlet, bukan saldo staff sendiri. |
| Outlet >2 staff | Sama, source tetap branch. |
| Dua shift sehari | Shift berikutnya boleh buka setelah previous closed. |
| Shift 2 buka sebelum shift 1 tutup | Reject, tampilkan staff aktif. |
| Staff lupa tutup kas | Admin dashboard menampilkan active; admin bisa forced close. |
| Kas akhir beda estimasi | Closing note wajib, ledger variance. |
| Kas fisik awal beda sistem | Opening variance reason wajib, ledger variance. |
| Setoran pending | Posisi tidak berubah, badge pending. |
| Setoran confirmed | Posisi berkurang satu kali. |
| Setoran rejected | Posisi tidak berubah. |
| Approve deposit > current balance | Reject atau butuh koreksi admin dulu. MVP: reject. |
| Admin koreksi saat idle | Balance berubah, ledger adjustment. |
| Admin koreksi saat active | Allowed emergency dengan warning dan audit metadata. |
| Staff buka setelah koreksi | Opening cash = nilai koreksi. |
| Staff buka setelah deposit confirmed | Opening cash = nilai setelah deposit. |
| Internet putus saat open | Backend idempotency; client refresh cek session open. |
| Internet putus saat close | Client refresh session; if closed, jangan submit ulang. |
| Double click tombol | Client disable + backend idempotency. |
| Dua staff open bersamaan | Hanya satu berhasil. |
| Transaksi berubah setelah close | Jangan diam-diam ubah balance; mark needs_review/admin repair. |
| Shift lewat tengah malam | Gunakan timestamp `opened_at/closed_at`, bukan hanya tanggal calendar. |
| Admin lihat saat shift active | Tampilkan settled position + running estimate. |
| Admin lihat belum ada history | Tampilkan default cash dan label "Belum ada riwayat". |

## 25. Acceptance Criteria

| ID | Criteria |
|---|---|
| AC-001 | Kas awal staff selalu mengambil posisi kas terakhir outlet (`branch_id`). |
| AC-002 | Staff berbeda tetap mendapat kas awal yang benar. |
| AC-003 | Sistem tidak memakai `staff_id` sebagai filter source kas awal. |
| AC-004 | Outlet baru memakai default kas outlet. |
| AC-005 | Setelah tutup kas, posisi outlet = kas akhir aktual. |
| AC-006 | Shift baru tidak bisa dibuka jika outlet masih punya shift open. |
| AC-007 | Setoran pending tidak mengubah posisi outlet. |
| AC-008 | Setoran confirmed mengurangi posisi outlet satu kali. |
| AC-009 | Setoran rejected tidak mengubah posisi outlet. |
| AC-010 | Admin bisa melihat posisi kas semua outlet. |
| AC-011 | Admin bisa melihat detail riwayat/audit per outlet. |
| AC-012 | Admin bisa koreksi posisi kas dengan alasan wajib. |
| AC-013 | Koreksi admin masuk ledger dan tidak menghapus histori. |
| AC-014 | Double click buka/tutup/approve tidak membuat double update. |
| AC-015 | Semua mutasi kas atomic dan rollback jika error. |
| AC-016 | Tidak ada current balance negatif tanpa explicit admin flow. |
| AC-017 | UI staff menampilkan blocker jelas saat shift outlet masih active. |
| AC-018 | Dashboard admin menampilkan staff aktif, last opened/closed, pending deposit, variance. |
| AC-019 | Laporan kas lama tetap berjalan. |
| AC-020 | Build/static app tidak error dan semua regression utama lulus. |

## 26. Testing Scenario

### 26.1 Functional

1. Outlet baru default Rp10.000; staff pertama buka; opening cash Rp10.000.
2. Staff tutup kas Rp22.000; branch balance menjadi Rp22.000.
3. Staff berbeda buka berikutnya; opening cash Rp22.000.
4. Staff kedua tutup kas Rp122.000 setelah penjualan tunai Rp100.000.
5. Shift 2 mencoba buka saat shift 1 open; reject dan tidak ada session baru.
6. Double click buka kas; hanya satu session open.
7. Double click tutup kas; balance update sekali.
8. Staff input opening physical berbeda; reason wajib.
9. Staff input closing berbeda expected; note wajib.
10. Setoran pending Rp10.000; branch balance tidak berubah.
11. Approve setoran; branch balance berkurang Rp10.000.
12. Double approve setoran; balance tidak berkurang kedua kali.
13. Reject setoran; branch balance tidak berubah.
14. Admin koreksi Rp20.000 dengan alasan; branch balance Rp20.000.
15. Staff buka setelah koreksi; opening cash Rp20.000.
16. Admin forced close shift aktif; branch balance mengikuti closing cash forced.
17. Admin filter outlet berdasarkan pending deposit.
18. Admin lihat ledger movement type `session_close`, `deposit_approved`, `admin_adjustment`.

### 26.2 Race/Failure

1. Dua staff submit open bersamaan untuk branch sama.
2. Close session dengan koneksi terputus setelah server sukses; reload harus melihat closed.
3. Approve deposit dengan koneksi terputus setelah server sukses; reload harus melihat confirmed dan balance applied.
4. Admin koreksi dengan version stale; backend reject.
5. Migration backfill branch dengan session open; branch flagged review.

### 26.3 Regression

1. Login admin/staff.
2. POS checkout tunai/non-tunai.
3. Cash summary staff.
4. Laporan kas admin.
5. Setoran manual/admin.
6. Approve/reject setoran.
7. Admin dashboard existing.
8. Investor/report pages jika membaca `branches`, `cash_logs`, atau `cashier_sessions`.

## 27. Implementation Plan for AI Builder

### Phase 1 - Discovery

1. Baca `js/pos.js`, `js/services/transactionService.js`, `js/services/cashService.js`.
2. Baca `js/depositService.js`, `js/adminDepositUi.js`, `js/adminStaffCashUi.js`.
3. Baca migrations `030`, `032`, `034`.
4. Catat semua caller RPC lama:
   - `openShiftFromBalance`
   - `closeShiftApplyBalance`
   - `confirm_deposit`
   - `get_admin_staff_cash_balances`
   - `get_staff_cash_ledger`

### Phase 2 - Database

1. Buat migration baru branch-based.
2. Tambah `branches.default_cash_position`.
3. Buat `branch_cash_balances`.
4. Buat `branch_cash_ledger`.
5. Alter `cashier_sessions` dan `cash_deposits` untuk idempotency branch balance.
6. Buat RPC branch-based.
7. Update/replace `confirm_deposit` agar apply branch balance.
8. Revoke direct DML balance/ledger.
9. `NOTIFY pgrst, 'reload schema';`

### Phase 3 - Staff UI

1. Update `transactionService.openShiftFromBalance` menjadi branch-based RPC.
2. Rename method internal bila perlu, tetapi jaga wrapper lama agar caller tidak rusak.
3. Update modal buka kas di `pos.js`:
   - load branch cash position
   - show last closed by
   - show blocker open session
   - no manual arbitrary opening cash
4. Update close shift agar memanggil branch-based close RPC.
5. Setelah close/open, refresh cash summary dan local session state.

### Phase 4 - Admin UI

1. Buat atau refactor menu `Kas Outlet`.
2. Jangan lagi menjadikan `Posisi Kas Staff` sebagai sumber utama.
3. Tampilkan summary cards, table outlet, detail outlet, ledger.
4. Tambahkan modal koreksi kas outlet.
5. Tambahkan action forced close jika diperlukan.
6. Refresh setelah approve/reject deposit dan koreksi.

### Phase 5 - Compatibility

1. Pertahankan function wrapper lama sementara jika UI lama masih memanggilnya.
2. Hindari rename kolom existing yang dipakai laporan.
3. Jika `staff_cash_balances` ada, jangan hapus dalam migration pertama.
4. Tandai UI/fitur lama sebagai deprecated setelah halaman Kas Outlet siap.

### Phase 6 - Verification

1. Jalankan lint/static checks yang tersedia.
2. Jalankan build jika project punya build step. Jika app statis tanpa `package.json`, lakukan smoke test browser.
3. Test manual scenario pada section 26.
4. Verifikasi SQL migration idempotent.
5. Verifikasi Supabase schema reload.

## 28. Do Not Break

AI builder tidak boleh:

- Mengubah source kas awal menjadi per staff.
- Menghapus histori lama.
- Menghapus guard satu open session per branch.
- Membuat update balance dari client langsung.
- Mengurangi posisi kas saat deposit masih pending.
- Mengubah status DB deposit dari `confirmed` ke `approved` tanpa migrasi menyeluruh.
- Mengubah status DB session dari `open/closed` ke `active/closed` tanpa migrasi menyeluruh.
- Membuat fallback buka shift dengan `opening_cash=0` saat RPC gagal. Tampilkan error agar tidak salah kas.
- Menjumlah `staff_cash_balances` menjadi posisi outlet.
- Membuat current balance negatif diam-diam.

## 29. Definition of Done

1. Ada source of truth per outlet di database.
2. Buka kas memakai posisi outlet terakhir.
3. Tutup kas memperbarui posisi outlet.
4. Deposit confirmed mengurangi posisi outlet.
5. Admin correction bekerja dan audited.
6. Admin dashboard Kas Outlet tersedia.
7. Detail ledger outlet tersedia.
8. Guard race condition dan idempotency tersedia.
9. Semua acceptance criteria lulus.
10. Regression utama admin/staff/setoran/laporan lulus.
11. Implementer memberikan ringkasan file yang diubah, migration yang dibuat, dan cara test.

