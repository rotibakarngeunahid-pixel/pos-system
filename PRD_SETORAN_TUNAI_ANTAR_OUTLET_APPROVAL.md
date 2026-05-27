# PRD: Setoran Tunai Antar Outlet dengan Approval Outlet Penerima

Tanggal: 2026-05-27
Produk: Roti Bakar Ngeunah POS
Area: POS Staff, Tutup Kas, Setoran Tunai, Kas Outlet, Approval Outlet, Dashboard Admin
Status: Draft teknis siap eksekusi AI builder
Prioritas: Kritis

## 1. Ringkasan

Fitur ini menambahkan alur setoran tunai dari satu outlet ke outlet lain. Contoh operasional:

```text
Outlet Permai tutup kas.
Sebagian atau seluruh setoran tunai Permai diserahkan ke outlet Dalung.
Staff Dalung harus approve/terima setoran tersebut.
Setelah Dalung approve:
  kas outlet Permai berkurang
  kas outlet Dalung bertambah
```

Di codebase saat ini istilah teknis outlet adalah `branch`, sehingga PRD ini memakai mapping:

| Bahasa bisnis | Nama teknis existing |
|---|---|
| Outlet / Cabang | `branches` |
| Outlet ID | `branch_id` |
| Posisi kas outlet | `branch_cash_positions.balance` |
| Riwayat kas outlet | `branch_cash_ledger` |
| Shift / sesi kas | `cashier_sessions` |
| Setoran existing ke rekening/QRIS/cash | `cash_deposits` |
| Metode setoran | `deposit_accounts` |

Keputusan desain utama:

1. Jangan memaksakan fitur ini ke `cash_deposits` existing karena approval-nya berbeda.
2. Buat modul baru `cash_branch_transfers` untuk setoran tunai antar outlet.
3. Status pending belum mengubah saldo outlet.
4. Saldo source dan destination berubah bersamaan hanya saat outlet tujuan approve.
5. Admin/owner dapat melihat semua proses dari semua outlet.
6. Semua mutasi saldo wajib lewat RPC backend atomic, bukan update langsung dari client.

## 2. Latar Belakang

Saat ini fitur setoran tunai sudah ada untuk setoran ke metode setoran seperti bank, QRIS, atau serah tunai. Flow existing:

1. Staff membuat setoran dari shift yang sudah ditutup.
2. Status awal `pending`.
3. Admin melakukan konfirmasi.
4. Setelah `confirmed`, saldo kas outlet asal berkurang.

Kebutuhan baru berbeda: setoran tidak selalu ke rekening atau admin pusat, tetapi bisa diserahkan ke outlet lain. Contoh: Permai menyerahkan uang fisik ke Dalung. Karena uang diterima fisik oleh outlet tujuan, approval harus dilakukan oleh staff outlet tujuan, bukan hanya admin.

Masalah jika memakai flow existing apa adanya:

| Masalah | Dampak |
|---|---|
| `cash_deposits` hanya punya satu `branch_id` | Tidak ada outlet tujuan. |
| Approval hanya admin/owner | Staff Dalung tidak bisa memverifikasi penerimaan fisik. |
| Ledger hanya mengurangi outlet asal | Tidak ada mutasi kas masuk ke outlet tujuan. |
| Admin tidak punya monitoring khusus antar outlet | Sulit audit proses Permai ke Dalung. |
| Jika update source dan target dilakukan dari client | Risiko salah saldo, double approve, dan data setengah jalan. |

## 3. Tujuan

1. Staff outlet asal dapat membuat setoran tunai ke outlet lain setelah shift ditutup.
2. Outlet tujuan dapat melihat daftar setoran masuk yang menunggu approval.
3. Staff outlet tujuan wajib approve sebelum transaksi dianggap berhasil.
4. Saat approval berhasil, saldo outlet asal berkurang dan saldo outlet tujuan bertambah secara atomic.
5. Jika ditolak, saldo kedua outlet tidak berubah.
6. Admin/owner dapat melihat seluruh proses lintas outlet: pending, confirmed, rejected, cancelled.
7. Semua proses tersimpan di audit trail dan `branch_cash_ledger`.
8. Sistem mencegah double submit, double approve, dan saldo negatif.
9. Flow setoran existing ke bank/QRIS/cash tetap berjalan tanpa rusak.

## 4. Non-Goals

- Tidak mengganti total modul `cash_deposits` existing.
- Tidak mengubah status DB setoran existing dari `confirmed` menjadi `approved`.
- Tidak membuat multi-level approval.
- Tidak membuat rekonsiliasi bank.
- Tidak membuat fitur pinjaman antar outlet.
- Tidak menghapus riwayat kas lama.
- Tidak mengubah source of truth kas outlet dari `branch_cash_positions.balance`.
- Tidak mengubah upload endpoint `hosting/bukti-setoran/upload.php`, kecuali ada bug keamanan yang terpisah.

## 5. Current System Context

File dan tabel yang sudah ada dan wajib dipertahankan:

| Area | File / Tabel |
|---|---|
| Upload bukti setoran | `hosting/bukti-setoran/upload.php` |
| Service setoran | `js/depositService.js` |
| UI setoran staff | `js/depositUi.js` |
| UI setoran admin | `js/adminDepositUi.js` |
| Service kas | `js/services/cashService.js` |
| Service shift/transaksi | `js/services/transactionService.js` |
| UI kas outlet admin | `js/adminBranchCashUi.js` |
| Halaman admin | `admin.html` |
| Posisi kas outlet | `branch_cash_positions` |
| Ledger kas outlet | `branch_cash_ledger` |
| Shift kas | `cashier_sessions` |
| Setoran existing | `cash_deposits` |
| Metode setoran | `deposit_accounts` |

Catatan teknis dari kode existing:

- `upload.php` menerima multipart field `file`, validasi secret `X-Upload-Secret`, ukuran maksimal 5 MB, MIME `image/jpeg`, `image/png`, `application/pdf`, lalu menyimpan file per `branch_id`.
- `depositService.uploadDepositProof()` sudah memakai endpoint tersebut dan bisa digunakan ulang untuk bukti setoran antar outlet.
- `cash_deposits.status` existing adalah `pending`, `confirmed`, `rejected`.
- `confirm_deposit` existing mengurangi `branch_cash_positions.balance` outlet asal setelah admin konfirmasi.
- `branch_cash_ledger` sudah punya `source_table` dan `source_id`, cocok untuk audit transfer kas antar outlet.
- `adminBranchCashUi` sudah menampilkan posisi kas outlet dan ledger. UI ini perlu ditambah label movement baru.

## 6. Definisi

| Istilah | Definisi |
|---|---|
| Outlet asal | Outlet yang mengirim/menyetorkan kas, contoh Permai. |
| Outlet tujuan | Outlet yang menerima kas, contoh Dalung. |
| Transfer kas antar outlet | Setoran tunai dari outlet asal ke outlet tujuan. |
| Pending | Request sudah dibuat, belum diterima/ditolak outlet tujuan. |
| Confirmed | Outlet tujuan sudah approve dan saldo kedua outlet sudah berubah. |
| Rejected | Outlet tujuan menolak, saldo tidak berubah. |
| Cancelled | Outlet asal membatalkan sebelum outlet tujuan approve. |
| Kas eligible | Nominal kas dari shift tertutup yang masih dapat disetor/ditransfer. |

## 7. Business Rules

1. Outlet asal dan outlet tujuan tidak boleh sama.
2. Transfer hanya boleh dibuat dari shift yang sudah `closed`.
3. Shift harus milik outlet asal.
4. Amount harus lebih dari 0.
5. Amount tidak boleh melebihi kas eligible shift.
6. Amount mengikuti aturan existing setoran tunai: kelipatan Rp 50.000.
7. Satu shift tertutup hanya boleh punya satu proses setoran aktif:
   - `cash_deposits` pending/confirmed, atau
   - `cash_branch_transfers` pending/confirmed.
8. Transfer pending tidak mengubah `branch_cash_positions.balance`.
9. Transfer confirmed mengubah saldo dua outlet dalam satu transaksi database:
   - outlet asal: `balance = balance - amount`
   - outlet tujuan: `balance = balance + amount`
10. Transfer rejected/cancelled tidak mengubah saldo.
11. Outlet tujuan yang boleh approve adalah staff aktif dengan `users.branch_id = to_branch_id`, atau admin/owner melalui override dengan alasan wajib.
12. Staff outlet asal tidak boleh approve transfer yang ia buat sendiri, kecuali user tersebut admin/owner dan memakai flow override.
13. Admin/owner dapat melihat semua transfer dari semua outlet.
14. Semua approve/reject/cancel wajib tercatat aktor dan waktunya.
15. Double click approve tidak boleh menggandakan saldo.
16. Jika saldo outlet asal saat approval kurang dari amount, approval ditolak dengan pesan jelas dan admin diminta koreksi kas outlet lebih dulu.

## 8. Data Model Target

### 8.1 Tabel Baru `cash_branch_transfers`

Gunakan nama teknis `branch` agar konsisten dengan schema existing.

```sql
CREATE TABLE IF NOT EXISTS public.cash_branch_transfers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  transfer_code text UNIQUE NOT NULL,

  from_branch_id bigint NOT NULL REFERENCES public.branches(id),
  to_branch_id bigint NOT NULL REFERENCES public.branches(id),
  session_id bigint NOT NULL REFERENCES public.cashier_sessions(id),

  staff_id bigint NOT NULL REFERENCES public.users(id),
  requested_by bigint NOT NULL REFERENCES public.users(id),
  requested_at timestamptz NOT NULL DEFAULT now(),

  amount numeric(15,2) NOT NULL CHECK (amount > 0),
  cash_balance_at_request numeric(15,2),

  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','confirmed','rejected','cancelled')),

  notes text,
  reject_reason text,
  cancel_reason text,

  proof_url text,
  proof_file_name text,
  proof_file_type text,
  proof_file_size bigint,
  proof_uploaded_at timestamptz,

  confirmed_by bigint REFERENCES public.users(id),
  confirmed_at timestamptz,
  rejected_by bigint REFERENCES public.users(id),
  rejected_at timestamptz,
  cancelled_by bigint REFERENCES public.users(id),
  cancelled_at timestamptz,

  source_balance_before numeric(15,2),
  source_balance_after numeric(15,2),
  target_balance_before numeric(15,2),
  target_balance_after numeric(15,2),
  source_branch_cash_ledger_id bigint REFERENCES public.branch_cash_ledger(id),
  target_branch_cash_ledger_id bigint REFERENCES public.branch_cash_ledger(id),

  client_request_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,

  CONSTRAINT cash_branch_transfers_different_branch
    CHECK (from_branch_id <> to_branch_id)
);
```

Index:

```sql
CREATE INDEX IF NOT EXISTS idx_cash_branch_transfers_from_created
  ON public.cash_branch_transfers(from_branch_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_cash_branch_transfers_to_status_created
  ON public.cash_branch_transfers(to_branch_id, status, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_cash_branch_transfers_session_status
  ON public.cash_branch_transfers(session_id, status);

CREATE UNIQUE INDEX IF NOT EXISTS idx_cash_branch_transfers_client_request
  ON public.cash_branch_transfers(client_request_id)
  WHERE client_request_id IS NOT NULL;
```

### 8.2 Update `branch_cash_ledger` Movement Type

Tambahkan movement type baru ke constraint `branch_cash_ledger_movement_type_check`:

```text
cash_branch_transfer_out
cash_branch_transfer_in
cash_branch_transfer_rejected
cash_branch_transfer_cancelled
```

Mapping:

| Movement type | Branch | Direction | Kapan dibuat |
|---|---|---|---|
| `cash_branch_transfer_out` | Outlet asal | `out` | Saat transfer confirmed |
| `cash_branch_transfer_in` | Outlet tujuan | `in` | Saat transfer confirmed |
| `cash_branch_transfer_rejected` | Outlet asal dan/atau tujuan | `none` | Saat transfer rejected |
| `cash_branch_transfer_cancelled` | Outlet asal | `none` | Saat transfer cancelled |

Gunakan:

```text
source_table = 'cash_branch_transfers'
source_id = transfer_id::text
```

Untuk mencegah ledger double, tambahkan unique source yang sudah ada:

```text
idx_branch_cash_ledger_unique_source(source_table, source_id, movement_type)
```

### 8.3 Cash Logs

Saat transfer confirmed, sistem perlu membuat `cash_logs` agar laporan kas masuk/keluar tetap terbaca:

1. Outlet asal:
   - `type = 'out'`
   - `reference_type = 'cash_branch_transfer'`
   - `note = 'Setoran antar outlet ke {Outlet Tujuan} [{transfer_code}]'`

2. Outlet tujuan:
   - `type = 'in'`
   - `reference_type = 'cash_branch_transfer'`
   - `session_id = null` jika tidak ada shift aktif yang relevan
   - `note = 'Setoran antar outlet dari {Outlet Asal} [{transfer_code}]'`

Jika tipe `cash_logs.reference_id` bukan UUID, simpan ID transfer sebagai text jika schema memungkinkan. Jika tidak memungkinkan, cukup simpan detail di `note` dan `branch_cash_ledger.metadata`.

## 9. RPC / Backend Contract

Semua RPC wajib:

- `SECURITY DEFINER`
- `SET search_path = public, pg_temp`
- validasi role di dalam function
- lock row yang dimutasi
- idempotent untuk double submit / double approve

### 9.1 `create_cash_branch_transfer`

Tujuan: outlet asal membuat request setoran ke outlet lain.

Signature:

```sql
create_cash_branch_transfer(
  p_from_branch_id bigint,
  p_to_branch_id bigint,
  p_session_id bigint,
  p_staff_id bigint,
  p_amount numeric,
  p_notes text DEFAULT NULL,
  p_proof_url text DEFAULT NULL,
  p_proof_file_name text DEFAULT NULL,
  p_proof_file_type text DEFAULT NULL,
  p_proof_file_size bigint DEFAULT NULL,
  p_proof_uploaded_at timestamptz DEFAULT NULL,
  p_client_request_id text DEFAULT NULL
) RETURNS jsonb
```

Rules:

1. Validasi outlet asal dan tujuan aktif.
2. Validasi `p_from_branch_id <> p_to_branch_id`.
3. Validasi staff aktif.
4. Staff biasa hanya boleh membuat dari outlet miliknya.
5. Admin/owner boleh membuat atas nama outlet mana pun.
6. Lock `cashier_sessions` by `p_session_id FOR UPDATE`.
7. Session harus `closed`.
8. Session `branch_id` harus sama dengan `p_from_branch_id`.
9. Hitung kas eligible:
   - final cash shift
   - dikurangi `cash_deposits` pending/confirmed
   - dikurangi `cash_branch_transfers` pending/confirmed
10. Jika ada setoran/transfer aktif untuk session yang sama, reject.
11. Validasi amount tidak melebihi kas eligible.
12. Insert row `cash_branch_transfers` status `pending`.
13. Tidak mengubah `branch_cash_positions.balance`.
14. Return transfer detail.

Return contoh:

```json
{
  "success": true,
  "transfer_id": "uuid",
  "transfer_code": "KAS-20260527-001",
  "status": "pending",
  "message": "Setoran antar outlet dikirim dan menunggu approval outlet tujuan."
}
```

### 9.2 `get_pending_incoming_cash_branch_transfers`

Tujuan: staff outlet tujuan melihat setoran masuk yang perlu diapprove.

Signature:

```sql
get_pending_incoming_cash_branch_transfers(
  p_branch_id bigint,
  p_user_id bigint
) RETURNS jsonb
```

Rules:

- Staff biasa hanya boleh membaca transfer masuk untuk outlet miliknya.
- Admin/owner boleh membaca semua jika `p_branch_id` null atau dipilih.
- Return harus menyertakan outlet asal, staff pengirim, amount, waktu, catatan, bukti, dan transfer code.

### 9.3 `confirm_cash_branch_transfer`

Tujuan: outlet tujuan approve setoran.

Signature:

```sql
confirm_cash_branch_transfer(
  p_transfer_id uuid,
  p_user_id bigint
) RETURNS jsonb
```

Transaction rules:

1. Lock transfer `FOR UPDATE`.
2. Jika tidak ditemukan, error `Transfer kas tidak ditemukan`.
3. Jika status sudah `confirmed`, return idempotent `already_confirmed = true` tanpa mutasi ulang.
4. Jika status bukan `pending`, reject.
5. Validasi user aktif.
6. User staff biasa harus berada di `to_branch_id`.
7. User admin/owner boleh approve override, tetapi metadata harus mencatat `override = true`.
8. Lock posisi kas source dan target secara deterministic untuk menghindari deadlock:
   - lock branch dengan ID lebih kecil dulu
   - lalu branch dengan ID lebih besar
9. Jika row `branch_cash_positions` belum ada, seed dari default outlet atau 0 sesuai pola migration 041.
10. Validasi `source_balance >= amount`.
11. Update source balance: `source_balance - amount`.
12. Update target balance: `target_balance + amount`.
13. Insert ledger source `cash_branch_transfer_out`.
14. Insert ledger target `cash_branch_transfer_in`.
15. Insert `cash_logs` source out dan target in.
16. Update transfer menjadi `confirmed`, isi actor, timestamp, balance before/after, ledger IDs.
17. Return balance before/after kedua outlet.

Error saldo kurang:

```text
Saldo kas outlet asal tidak cukup untuk transfer ini. Koreksi kas outlet asal terlebih dahulu.
```

### 9.4 `reject_cash_branch_transfer`

Tujuan: outlet tujuan menolak setoran.

Signature:

```sql
reject_cash_branch_transfer(
  p_transfer_id uuid,
  p_user_id bigint,
  p_reason text
) RETURNS jsonb
```

Rules:

1. Transfer harus `pending`.
2. User staff biasa harus berada di outlet tujuan.
3. Admin/owner boleh reject dengan metadata override.
4. Reason wajib minimal 3 karakter.
5. Update status `rejected`.
6. Tidak mengubah saldo outlet.
7. Insert ledger `cash_branch_transfer_rejected` direction `none`.

### 9.5 `cancel_cash_branch_transfer`

Tujuan: outlet asal membatalkan transfer sebelum diterima.

Signature:

```sql
cancel_cash_branch_transfer(
  p_transfer_id uuid,
  p_user_id bigint,
  p_reason text DEFAULT NULL
) RETURNS jsonb
```

Rules:

1. Hanya bisa untuk status `pending`.
2. Staff biasa hanya bisa cancel transfer dari outlet miliknya.
3. Admin/owner boleh cancel semua dengan reason wajib.
4. Tidak mengubah saldo outlet.
5. Insert ledger `cash_branch_transfer_cancelled` direction `none`.

### 9.6 `get_cash_branch_transfer_history`

Tujuan: staff melihat riwayat transfer kas yang melibatkan outletnya.

Signature:

```sql
get_cash_branch_transfer_history(
  p_branch_id bigint,
  p_user_id bigint,
  p_status text DEFAULT NULL,
  p_limit integer DEFAULT 50,
  p_offset integer DEFAULT 0
) RETURNS jsonb
```

### 9.7 `get_admin_cash_branch_transfers`

Tujuan: admin/owner melihat semua proses.

Signature:

```sql
get_admin_cash_branch_transfers(
  p_admin_id bigint,
  p_from_branch_id bigint DEFAULT NULL,
  p_to_branch_id bigint DEFAULT NULL,
  p_status text DEFAULT NULL,
  p_date_from date DEFAULT NULL,
  p_date_to date DEFAULT NULL,
  p_limit integer DEFAULT 200,
  p_offset integer DEFAULT 0
) RETURNS jsonb
```

Return minimal:

| Field | Isi |
|---|---|
| `transfer_id` | UUID transfer |
| `transfer_code` | Kode transfer |
| `from_branch_id/name` | Outlet asal |
| `to_branch_id/name` | Outlet tujuan |
| `session_id` | Shift asal |
| `staff_name` | Staff pembuat |
| `amount` | Nominal |
| `status` | pending/confirmed/rejected/cancelled |
| `requested_at` | Waktu dibuat |
| `confirmed_by_name` | Staff penerima jika confirmed |
| `confirmed_at` | Waktu confirmed |
| `rejected_by_name` | Staff penolak jika rejected |
| `reject_reason` | Alasan penolakan |
| `cancel_reason` | Alasan pembatalan |
| `proof_url` | Bukti jika ada |
| `source_balance_before/after` | Audit saldo asal |
| `target_balance_before/after` | Audit saldo tujuan |

## 10. Flow Staff Outlet Asal

Contoh: Permai menyetor ke Dalung.

1. Staff Permai menutup shift.
2. Staff membuka menu Setoran.
3. Sistem menampilkan pilihan:
   - Setor ke Rekening/QRIS/Metode Setoran
   - Setor ke Outlet Lain
4. Staff memilih `Setor ke Outlet Lain`.
5. Sistem menampilkan shift tertutup eligible.
6. Staff memilih outlet tujuan: Dalung.
7. Sistem menolak jika outlet tujuan sama dengan outlet asal.
8. Staff mengisi nominal.
9. Sistem validasi nominal tidak melebihi kas eligible dan kelipatan Rp 50.000.
10. Staff dapat upload bukti/foto serah tunai. MVP: opsional untuk transfer tunai antar outlet, tetapi jika dipilih wajib lolos validasi file.
11. Staff submit.
12. Status menjadi `pending`.
13. UI menampilkan pesan:

```text
Setoran ke Dalung berhasil dikirim dan menunggu approval staff Dalung.
```

Selama pending:

- Saldo Permai belum berkurang.
- Saldo Dalung belum bertambah.
- Shift asal tidak bisa membuat setoran/transfer baru.
- Dashboard menampilkan pending outbound dari Permai dan pending inbound ke Dalung.

## 11. Flow Staff Outlet Tujuan

Contoh: Staff Dalung menerima setoran dari Permai.

1. Staff Dalung membuka menu Setoran Masuk / Approval Setoran Outlet.
2. Sistem menampilkan pending transfer dengan `to_branch_id = Dalung`.
3. Staff melihat detail:
   - kode transfer
   - outlet asal
   - staff pengirim
   - nominal
   - waktu request
   - catatan
   - bukti jika ada
4. Staff cocokkan uang fisik.
5. Jika sesuai, klik `Terima`.
6. Backend menjalankan `confirm_cash_branch_transfer`.
7. Jika sukses:
   - saldo Permai berkurang
   - saldo Dalung bertambah
   - status transfer menjadi `confirmed`
   - ledger kedua outlet tercatat
8. UI menampilkan:

```text
Setoran diterima. Kas Dalung bertambah RpX dan kas Permai berkurang RpX.
```

Jika tidak sesuai:

1. Staff klik `Tolak`.
2. Staff wajib mengisi alasan.
3. Status menjadi `rejected`.
4. Saldo kedua outlet tidak berubah.
5. Outlet asal dapat membuat transfer/setoran baru untuk shift tersebut jika aturan bisnis mengizinkan setelah rejected.

## 12. Flow Admin / Owner

Admin/owner harus bisa melihat semua proses tanpa harus pindah outlet.

Menu yang disarankan:

- Tambah tab baru di `Setoran Manual`: `Antar Outlet`, atau
- Tambah section baru: `Setoran Antar Outlet`.

Kolom admin:

1. Kode transfer.
2. Waktu request.
3. Dari Outlet.
4. Ke Outlet.
5. Staff pengirim.
6. Nominal.
7. Status.
8. Waktu approval/reject/cancel.
9. Staff penerima/penolak.
10. Alasan reject/cancel.
11. Bukti.
12. Ledger source/target.
13. Aksi detail.

Filter admin:

- Dari outlet.
- Ke outlet.
- Status.
- Tanggal request.
- Tanggal confirmed.
- Staff pengirim.
- Staff penerima.

Summary card admin:

| Card | Definisi |
|---|---|
| Pending Antar Outlet | Count dan nominal transfer pending |
| Total Confirmed | Nominal transfer confirmed pada filter |
| Total Rejected | Count dan nominal rejected |
| Outlet Terlibat | Count outlet asal/tujuan pada filter |

Admin action:

- Admin/owner dapat membuka detail semua transfer.
- Admin/owner dapat cancel pending dengan alasan wajib.
- Owner/admin dapat approve/reject override hanya jika bisnis mengizinkan. Jika dibuat, UI wajib memberi label `Override Admin` dan metadata audit wajib tersimpan.

## 13. UI/UX Requirements

### 13.1 Staff - Setoran

Tambahkan mode/segmented control:

```text
[Ke Rekening/QRIS] [Ke Outlet Lain]
```

Mode `Ke Outlet Lain` menampilkan:

- Shift tertutup eligible.
- Kas dapat disetor.
- Dropdown outlet tujuan.
- Input nominal.
- Bukti setoran opsional.
- Catatan.
- Tombol `Kirim ke Outlet`.

Validasi UI:

- Outlet tujuan wajib dipilih.
- Outlet tujuan tidak boleh sama dengan outlet asal.
- Amount wajib > 0.
- Amount wajib kelipatan Rp 50.000.
- Amount tidak boleh melebihi kas eligible.
- Tombol disabled saat submit.
- Setelah submit sukses, form reset dan riwayat refresh.

### 13.2 Staff - Approval Outlet Tujuan

Tambahkan panel:

```text
Setoran Masuk
```

Isi card/table:

- Dari outlet.
- Nominal.
- Staff pengirim.
- Waktu request.
- Catatan.
- Bukti.
- Tombol `Terima`.
- Tombol `Tolak`.

State kosong:

```text
Belum ada setoran masuk yang menunggu approval.
```

### 13.3 Admin

Admin page perlu menampilkan:

- Monitoring semua transfer kas antar outlet.
- Filter status.
- Filter outlet asal/tujuan.
- Detail transfer.
- Link bukti.
- Status actor.
- Badge:
  - `Menunggu`
  - `Diterima`
  - `Ditolak`
  - `Dibatalkan`

### 13.4 Kas Outlet

`js/adminBranchCashUi.js` perlu menampilkan:

- Pending outbound antar outlet.
- Pending inbound antar outlet.
- Ledger movement label:
  - `Transfer Kas Keluar`
  - `Transfer Kas Masuk`
  - `Transfer Kas Ditolak`
  - `Transfer Kas Dibatalkan`

## 14. Permission

### Staff Outlet Asal

Boleh:

- Membuat transfer dari outlet miliknya.
- Melihat transfer yang melibatkan outlet miliknya.
- Cancel transfer pending dari outlet miliknya.

Tidak boleh:

- Membuat transfer dari outlet lain.
- Approve transfer yang masuk ke outlet lain.
- Mengubah saldo langsung.

### Staff Outlet Tujuan

Boleh:

- Melihat transfer pending yang masuk ke outlet miliknya.
- Approve transfer pending yang masuk ke outlet miliknya.
- Reject transfer pending yang masuk ke outlet miliknya.

Tidak boleh:

- Approve transfer untuk outlet lain.
- Mengubah amount transfer.
- Mengubah saldo langsung.

### Admin / Owner

Boleh:

- Melihat semua transfer.
- Filter semua transfer.
- Melihat semua bukti.
- Cancel pending dengan alasan wajib.
- Override approve/reject jika fitur override diaktifkan.

Semua aksi admin/owner wajib masuk metadata audit.

## 15. Edge Cases

| Case | Expected behavior |
|---|---|
| Permai transfer ke Permai | Ditolak, outlet asal dan tujuan tidak boleh sama. |
| Permai transfer ke Dalung tapi shift belum closed | Ditolak, tutup kas dulu. |
| Amount lebih besar dari kas eligible | Ditolak dengan pesan nominal maksimal. |
| Shift sudah punya `cash_deposits` pending | Transfer antar outlet ditolak. |
| Shift sudah punya transfer antar outlet pending | Setoran/transfer baru ditolak. |
| Dalung double click approve | Saldo hanya berubah satu kali. |
| Dalung approve saat transfer sudah rejected | Ditolak. |
| Permai cancel saat Dalung sudah confirmed | Ditolak. |
| Saldo Permai berubah dan kurang saat Dalung approve | Approval ditolak, admin perlu koreksi kas. |
| Posisi kas Dalung belum ada | Backend membuat row posisi kas lalu menambah amount. |
| Bukti file terlalu besar | Ditolak maksimal 5 MB sesuai upload existing. |
| Bukti MIME tidak valid | Ditolak, hanya JPG/PNG/PDF. |
| Upload bukti gagal | Transfer tidak disubmit sampai upload selesai atau staff submit tanpa bukti jika opsional. |
| Admin buka data lama | Tidak error, karena tabel baru tidak mengubah data lama. |
| Internet putus setelah approve sukses | Reload menampilkan status confirmed, saldo tidak double. |
| Dua approval bersamaan | Lock transfer `FOR UPDATE`, hanya satu yang berhasil. |

## 16. Race Condition dan Idempotency

| Risiko | Guard |
|---|---|
| Double submit create | `client_request_id` unique + tombol disabled |
| Double approve | lock transfer `FOR UPDATE` + status check + unique ledger source |
| Deadlock update dua outlet | lock branch_cash_positions berdasarkan urutan `branch_id` kecil ke besar |
| Saldo negatif source | validasi `source_balance >= amount` di RPC approve |
| Ledger duplicate | unique `(source_table, source_id, movement_type)` |
| Cash log duplicate | cek reference sebelum insert atau simpan idempotency metadata |
| Transfer dan deposit dibuat bersamaan untuk session sama | lock session dan validasi semua active settlement |
| Error tengah approval | transaction rollback otomatis |

## 17. Reporting dan Audit

Admin harus bisa menjawab pertanyaan ini dari UI:

1. Permai mengirim berapa ke Dalung?
2. Siapa staff Permai yang membuat?
3. Kapan request dibuat?
4. Siapa staff Dalung yang approve?
5. Kapan approved?
6. Berapa saldo Permai sebelum dan sesudah?
7. Berapa saldo Dalung sebelum dan sesudah?
8. Apakah ada bukti?
9. Jika ditolak, siapa yang menolak dan alasannya apa?

`branch_cash_ledger.metadata` wajib menyimpan minimal:

```json
{
  "transfer_id": "uuid",
  "transfer_code": "KAS-20260527-001",
  "from_branch_id": 2,
  "to_branch_id": 1,
  "from_branch_name": "Permai",
  "to_branch_name": "Dalung",
  "requested_by": 10,
  "confirmed_by": 12
}
```

## 18. Acceptance Criteria

| ID | Criteria |
|---|---|
| AC-001 | Staff Permai dapat membuat setoran tunai ke Dalung dari shift yang sudah closed. |
| AC-002 | Staff tidak bisa membuat setoran antar outlet dari shift yang masih open. |
| AC-003 | Outlet asal dan tujuan tidak bisa sama. |
| AC-004 | Amount tidak bisa melebihi kas eligible shift. |
| AC-005 | Transfer baru berstatus `pending` dan tidak mengubah saldo outlet. |
| AC-006 | Staff Dalung dapat melihat transfer pending yang masuk ke Dalung. |
| AC-007 | Staff selain outlet tujuan tidak bisa approve transfer tersebut. |
| AC-008 | Saat staff Dalung approve, kas Permai berkurang dan kas Dalung bertambah dalam satu transaksi. |
| AC-009 | Saat staff Dalung reject, saldo Permai dan Dalung tidak berubah. |
| AC-010 | Double approve tidak menggandakan saldo. |
| AC-011 | Jika saldo outlet asal kurang saat approval, approval gagal tanpa perubahan saldo. |
| AC-012 | Ledger Permai mencatat `cash_branch_transfer_out`. |
| AC-013 | Ledger Dalung mencatat `cash_branch_transfer_in`. |
| AC-014 | Admin/owner dapat melihat semua transfer antar outlet dari semua outlet. |
| AC-015 | Admin dapat filter berdasarkan outlet asal, outlet tujuan, status, dan tanggal. |
| AC-016 | Bukti setoran jika ada dapat dibuka dari staff/admin history. |
| AC-017 | Upload bukti mengikuti validasi existing JPG/PNG/PDF maksimal 5 MB. |
| AC-018 | Flow setoran existing ke bank/QRIS/cash tidak rusak. |
| AC-019 | Posisi kas outlet di `Kas Outlet` refresh setelah transfer confirmed. |
| AC-020 | Tidak ada update saldo kas dari client langsung. |

## 19. Testing Scenario

### 19.1 Happy Path Permai ke Dalung

1. Permai tutup kas dengan posisi Rp1.000.000.
2. Staff Permai buka mode `Setor ke Outlet Lain`.
3. Pilih tujuan Dalung.
4. Input Rp500.000.
5. Submit.
6. Status pending.
7. Pastikan saldo Permai dan Dalung belum berubah.
8. Staff Dalung buka `Setoran Masuk`.
9. Staff Dalung approve.
10. Expected:
    - Permai berkurang Rp500.000.
    - Dalung bertambah Rp500.000.
    - Status confirmed.
    - Ledger dua outlet tercatat.

### 19.2 Reject

1. Buat transfer Permai ke Dalung Rp300.000.
2. Staff Dalung reject dengan alasan "Nominal fisik tidak sesuai".
3. Expected:
   - Status rejected.
   - Saldo Permai tidak berubah.
   - Saldo Dalung tidak berubah.
   - Alasan tampil di admin.

### 19.3 Double Approve

1. Buat transfer pending.
2. Klik approve dua kali cepat atau dari dua tab.
3. Expected:
   - Hanya satu approval sukses.
   - Saldo source/target berubah satu kali.
   - Ledger tidak duplicate.

### 19.4 Staff Salah Outlet

1. Transfer Permai ke Dalung pending.
2. Staff Pamogan mencoba approve.
3. Expected:
   - Ditolak dengan pesan akses.
   - Saldo tidak berubah.

### 19.5 Admin Monitoring

1. Buat transfer pending, confirmed, rejected, cancelled.
2. Login admin.
3. Buka monitoring setoran antar outlet.
4. Expected:
   - Semua status terlihat.
   - Filter bekerja.
   - Actor dan timestamp tampil.
   - Bukti bisa dibuka.

### 19.6 Regression Setoran Existing

1. Staff membuat setoran bank/QRIS existing.
2. Admin confirm `cash_deposits`.
3. Expected:
   - Flow lama tetap sukses.
   - Kas outlet asal berkurang seperti sebelumnya.
   - Tidak ada error akibat tabel baru.

## 20. Implementation Plan for AI Builder

### Phase 1 - Database

1. Buat migration baru `sql/migrations/053_cash_branch_transfers.sql`.
2. Create table `cash_branch_transfers`.
3. Tambah index dan constraint.
4. Update check constraint `branch_cash_ledger_movement_type_check`.
5. Buat helper generate `transfer_code`.
6. Buat RPC create, confirm, reject, cancel, list staff, list admin.
7. Update `get_deposit_eligible_sessions` agar menghitung `cash_branch_transfers`.
8. Grant execute ke role yang sesuai.
9. `NOTIFY pgrst, 'reload schema';`

### Phase 2 - Service Layer

Tambah service baru atau perluas `js/depositService.js`:

- `createCashBranchTransfer`
- `getPendingIncomingCashBranchTransfers`
- `confirmCashBranchTransfer`
- `rejectCashBranchTransfer`
- `cancelCashBranchTransfer`
- `getCashBranchTransferHistory`
- `getAdminCashBranchTransfers`

Gunakan `depositService.uploadDepositProof()` untuk bukti agar tidak membuat upload mechanism baru.

### Phase 3 - Staff UI

1. Update `js/depositUi.js`.
2. Tambahkan mode `Ke Outlet Lain`.
3. Load daftar outlet aktif selain outlet login.
4. Render pending incoming approval untuk outlet login.
5. Tambahkan action approve/reject.
6. Publish `RBNDataEvents.publish('cash:changed')` setelah confirmed/rejected/cancelled.

### Phase 4 - Admin UI

1. Update `admin.html` untuk section/tab monitoring antar outlet.
2. Buat `js/adminCashBranchTransferUi.js` atau extend `adminDepositUi.js`.
3. Tambahkan filter dan table.
4. Tambahkan detail modal.
5. Tambahkan summary cards.
6. Refresh `adminBranchCashUi` setelah approval.

### Phase 5 - Kas Outlet Ledger

1. Update `js/adminBranchCashUi.js` label movement baru.
2. Tambahkan pending inbound/outbound di card outlet jika RPC admin position diperluas.
3. Pastikan saldo current tetap dari `branch_cash_positions.balance`.

### Phase 6 - Verification

1. Test SQL migration idempotent.
2. Test create pending.
3. Test confirm atomic.
4. Test reject/cancel.
5. Test double approve.
6. Test permission staff beda outlet.
7. Test admin monitoring.
8. Test regression setoran existing.

## 21. Do Not Break

Implementer tidak boleh:

- Menghapus atau merusak `cash_deposits` existing.
- Mengubah status existing `cash_deposits.confirmed`.
- Membuat saldo outlet berubah saat transfer masih pending.
- Mengupdate `branch_cash_positions` langsung dari frontend.
- Mengizinkan outlet asal dan tujuan sama.
- Mengizinkan approve oleh staff bukan outlet tujuan.
- Mengurangi saldo source tanpa menambah saldo target pada transaksi yang sama.
- Membuat ledger hanya di satu sisi saat confirmed.
- Mengizinkan saldo source menjadi negatif.
- Membuat fitur ini memakai source of truth selain `branch_cash_positions.balance`.
- Mengabaikan validasi file upload existing.
- Menghilangkan admin visibility semua proses.

## 22. Definition of Done

1. Staff outlet asal bisa membuat setoran tunai ke outlet lain.
2. Staff outlet tujuan bisa approve/reject.
3. Saldo source dan target berubah atomic saat approve.
4. Admin dapat melihat semua proses dan detail audit.
5. Ledger source dan target tercatat.
6. Double submit/approve aman.
7. Permission antar outlet benar.
8. Setoran existing tetap berjalan.
9. Testing scenario di section 19 lulus.
10. Implementer memberikan daftar file berubah, migration yang dijalankan, dan hasil test.
