# PRD: Wajib Tutup Shift Sebelum Setoran Tunai

Tanggal: 2026-05-18  
Produk: Roti Bakar Ngeunah POS  
Area: Staff POS, Admin Setoran, Cash Closing, Supabase RPC  
Prioritas: Kritis  
Status: Ready for AI Builder

## 1. Koreksi Wajib

Sistem ini tidak memiliki fitur absen masuk. Jangan membuat flow, validasi, tabel, RPC, UI, copy, atau logic apa pun yang bergantung pada absensi, attendance, clock-in, presensi, masuk kerja, atau check-in.

Validasi setoran tunai hanya boleh bergantung pada:

- `cashier_sessions` sebagai data shift/buka toko/tutup toko.
- `cashier_sessions.status`.
- Data cash closing: `closing_cash`, `expected_cash`, `current_cash_amount`, `closed_at`, `closed_manually`.
- `cash_deposits` dan `cash_logs` untuk deposit/pengurang kas.

Rule utama:

```ts
shift.status === "closed"
```

Dalam database saat ini, `shift` = row pada `public.cashier_sessions`, sehingga rule teknisnya:

```sql
cashier_sessions.status = 'closed'
```

## 2. Ringkasan Masalah

Saat ini staff/admin masih berpotensi membuat setoran tunai sebelum shift ditutup atau tanpa relasi shift yang valid.

Temuan kode saat ini:

| Area | Kondisi saat ini |
|---|---|
| `js/pos.js` | `initShift()` hanya mencari `cashier_sessions.status = 'open'`. Setelah `confirmCloseShift()`, `POS.session = null`, lalu user diarahkan ke tab setoran. |
| `js/depositUi.js` | Jika tidak ada `POS.session`, UI masuk ke "Mode setoran tanpa shift aktif"; submit tetap boleh dengan `sessionId: null`. Jika ada `POS.session`, itu justru shift `open`, dan UI juga bisa submit. |
| `js/depositService.js` | `submitDeposit()` memanggil RPC `create_deposit` dengan `p_session_id = sessionId || null`. Tidak ada validasi closed shift di client. |
| `sql/migrations/002...` | `cash_deposits.session_id` nullable. |
| `sql/migrations/011/026...` | RPC `create_deposit` validasi nominal, metode, cabang, bukti, tetapi belum validasi `cashier_sessions.status = 'closed'`. |
| `sql/migrations/011/014...` | RPC `confirm_deposit` mengunci row deposit dan validasi role admin, tetapi belum menolak deposit dengan `session_id IS NULL` atau session masih `open`. |
| `sql/migrations/024/026/027...` | RPC `admin_create_manual_deposit` menyimpan `session_id = NULL`, lalu bisa langsung `confirm_deposit`. Ini bypass utama dari UI admin. |
| RLS/grant | `cash_deposits` punya policy permissive dan grant DML ke `anon, authenticated`; direct insert/update via REST masih harus dilindungi DB trigger/RPC. |

Dampak:

- Setoran dapat dibuat saat kas shift belum final.
- Setoran dapat dibuat tanpa shift.
- Setoran dapat dibuat untuk shift `open` via UI/API.
- Admin manual deposit bisa bypass closed-shift rule.
- Deposit lama yang invalid masih bisa dikonfirmasi jika belum ditutup oleh validasi baru.
- Potensi double submit karena tidak ada guard atomik berbasis session.

## 3. Tujuan

Staff hanya boleh membuat setoran tunai setelah shift ditutup.

Flow final:

1. Staff buka shift/buka toko.
2. Staff menjalankan transaksi operasional.
3. Staff tutup shift/tutup toko.
4. Setelah row `cashier_sessions.status = 'closed'`, staff baru bisa membuat setoran tunai untuk shift tersebut.

Target teknis:

- Tidak ada setoran baru dengan `cash_deposits.session_id IS NULL`.
- Tidak ada setoran baru yang menunjuk `cashier_sessions.status != 'closed'`.
- `branch_id` dan `staff_id` deposit harus sama dengan session yang ditutup.
- UI staff tidak lagi memakai mode "setoran tanpa shift aktif".
- UI admin tidak bisa membuat setoran manual tanpa memilih shift tertutup.
- RPC dan DB trigger menolak bypass direct API.
- Double submit untuk shift yang sama dicegah secara atomik.

## 4. Scope

### In Scope

- Staff POS setoran tunai di `pos.html`, `js/depositUi.js`, `js/depositService.js`, `js/pos.js`.
- Tutup shift staff di `js/pos.js` dan `js/services/transactionService.js`.
- Admin setoran manual di `admin.html`, `js/adminDepositUi.js`, `js/adminStaffCashUi.js`, `js/depositService.js`.
- RPC Supabase: `create_deposit`, `confirm_deposit`, `admin_create_manual_deposit`.
- Migration baru, disarankan `sql/migrations/030_enforce_closed_shift_before_cash_deposit.sql`.
- DB validation trigger untuk `cash_deposits`.
- Helper RPC untuk mengambil shift tertutup yang eligible untuk setoran.
- Test manual/SQL untuk UI/API bypass.

### Out of Scope

- Membuat fitur absensi.
- Membuat flow absen masuk.
- Membuat tabel attendance/presensi.
- Mengubah flow transaksi POS selain yang dibutuhkan untuk relasi shift deposit.
- Mengubah histori transaksi penjualan.
- Rekonsiliasi bank otomatis.
- Approval bertingkat baru.
- Menghapus data deposit historis secara otomatis.

## 5. Definisi Data

| Istilah | Definisi teknis |
|---|---|
| Shift aktif | `cashier_sessions.status = 'open'`. Tidak boleh dipakai untuk setoran. |
| Shift tertutup | `cashier_sessions.status = 'closed'`. Satu-satunya status yang boleh dipakai untuk setoran. |
| Setoran tunai staff | Row `cash_deposits` yang dibuat lewat RPC `create_deposit`. |
| Setoran manual admin | Row `cash_deposits` yang dibuat lewat RPC `admin_create_manual_deposit`. Harus tetap terkait shift tertutup. |
| Kas final shift | `COALESCE(current_cash_amount, closing_cash, expected_cash, compute_cash_session_system_amount(session_id))`. |
| Deposit aktif | `cash_deposits.status IN ('pending','confirmed')`. Row `rejected` tidak menghitung double submit dan boleh diganti. |

## 6. Business Rules

- BR-001: Setoran tunai hanya boleh dibuat jika `cashier_sessions.status = 'closed'`.
- BR-002: `p_session_id` wajib untuk semua pembuatan setoran baru.
- BR-003: `cash_deposits.session_id` untuk row baru tidak boleh `NULL`.
- BR-004: `cash_deposits.branch_id` harus sama dengan `cashier_sessions.branch_id`.
- BR-005: `cash_deposits.staff_id` harus sama dengan `cashier_sessions.staff_id`.
- BR-006: Setoran tidak boleh dibuat untuk shift `open`.
- BR-007: Setoran tidak boleh dibuat untuk shift yang tidak ditemukan.
- BR-008: Setoran tidak boleh dibuat untuk shift milik staff/cabang lain.
- BR-009: Setoran tidak boleh dibuat jika shift tertutup sudah memiliki deposit aktif (`pending` atau `confirmed`).
- BR-010: Jika deposit sebelumnya `rejected`, staff/admin boleh membuat deposit pengganti untuk shift yang sama.
- BR-011: Nominal tetap wajib `> 0` dan kelipatan Rp 50.000 sesuai rule existing.
- BR-012: Nominal setoran tidak boleh melebihi kas final/depositable cash shift tertutup.
- BR-013: Bukti setoran tetap wajib untuk metode non-cash dan opsional untuk metode cash sesuai rule existing.
- BR-014: `confirm_deposit` wajib menolak deposit yang tidak punya `session_id` atau session-nya bukan `closed`.
- BR-015: Direct insert/update ke `cash_deposits` harus ditolak jika melanggar rule closed shift.
- BR-016: Validasi frontend hanya UX; validasi final wajib di RPC/DB.
- BR-017: Tidak ada rule yang membaca tabel absensi karena tabel/fitur absen tidak ada.

## 7. Functional Requirements

### 7.1 Staff POS

- FR-001: Tab Setoran tidak boleh menampilkan form submit jika tidak ada shift tertutup yang eligible.
- FR-002: Jika staff masih punya shift `open` dan tidak ada shift tertutup eligible, tampilkan blocking state: "Tutup shift terlebih dahulu sebelum setoran tunai."
- FR-003: Setelah staff berhasil tutup shift, sistem harus memuat shift tertutup terbaru dan mengaitkan setoran ke `session_id` shift tersebut.
- FR-004: UI harus menampilkan metadata shift tertutup: `session_id`, `opened_at`, `closed_at`, staff, cabang, dan kas final.
- FR-005: Copy "Mode setoran tanpa shift aktif" harus dihapus/diganti. Tidak boleh ada mode setoran tanpa shift.
- FR-006: `depositUi` tidak boleh memakai `POS.session` sebagai sumber session deposit karena `POS.session` berarti shift `open`.
- FR-007: `depositUi` harus memakai state baru, contoh `selectedClosedSession`.
- FR-008: Tombol submit disabled jika `selectedClosedSession` kosong atau `selectedClosedSession.status !== 'closed'`.
- FR-009: `depositService.submitDeposit()` wajib menerima `sessionId` non-null dan menolak sebelum RPC jika kosong.
- FR-010: Payload RPC `create_deposit` harus mengirim `p_session_id = selectedClosedSession.id`.
- FR-011: `cashBalance` yang dikirim harus berasal dari kas final/depositable cash shift tertutup, bukan saldo shift aktif.
- FR-012: Quick button "Setor Semua" memakai `depositable_cash` dari shift tertutup.
- FR-013: Jika shift tertutup sudah punya deposit `pending`, tampilkan status "Setoran sedang menunggu konfirmasi" dan disable submit.
- FR-014: Jika shift tertutup sudah punya deposit `confirmed`, tampilkan status "Setoran shift ini sudah selesai" dan disable submit.
- FR-015: Jika deposit `rejected`, tampilkan alasan penolakan dan izinkan submit ulang untuk shift yang sama.

### 7.2 Tutup Shift

- FR-016: `transactionService.closeShift()` harus mengembalikan data session setelah update, minimal: `id`, `status`, `branch_id`, `staff_id`, `opening_cash`, `closing_cash`, `expected_cash`, `closed_at`, `current_cash_amount`.
- FR-017: Setelah close shift, `POS.confirmCloseShift()` boleh mengosongkan `POS.session`, tetapi harus memicu refresh eligibility setoran.
- FR-018: Jika kolom `current_cash_amount` tersedia, close shift staff sebaiknya mengisi `current_cash_amount = closingCash` agar kas final eksplisit.
- FR-019: `modal-post-close-shift` tombol "Setor Tunai Sekarang" harus membuka tab setoran yang sudah preselect shift tertutup terakhir.
- FR-020: Tombol "Tidak, Buka Shift Baru" tidak boleh menghapus eligibility deposit shift tertutup sebelumnya. Jika staff membuka shift baru, setoran untuk shift lama tetap harus menunjuk shift lama yang `closed`.

### 7.3 Admin Manual Deposit

- FR-021: `admin_create_manual_deposit` harus menerima parameter `p_session_id bigint`.
- FR-022: Admin manual deposit tidak boleh menyimpan `session_id = NULL` untuk setoran baru.
- FR-023: Modal "Input Manual Setoran" harus memiliki field/hidden state shift tertutup.
- FR-024: Jika modal dibuka dari `adminStaffCashUi`, tombol "Setor" hanya aktif untuk row `session_status = 'closed'`.
- FR-025: Untuk row `session_status = 'open'`, tombol "Setor" disembunyikan atau disabled dengan pesan "Tutup kas terlebih dahulu".
- FR-026: Jika modal dibuka dari menu Setoran Manual biasa, admin harus memilih cabang, staff, lalu shift tertutup yang eligible.
- FR-027: Submit admin manual deposit disabled sampai shift tertutup dipilih.
- FR-028: `depositService.createManualDeposit()` wajib mengirim `sessionId` ke RPC.
- FR-029: Admin manual deposit tetap boleh langsung `confirmed` sesuai flow existing, tetapi hanya setelah validasi shift closed lulus.

### 7.4 Backend/RPC/DB

- FR-030: `create_deposit` wajib melakukan `SELECT ... FROM cashier_sessions WHERE id = p_session_id FOR UPDATE`.
- FR-031: `create_deposit` wajib menolak `p_session_id IS NULL`.
- FR-032: `create_deposit` wajib menolak jika session tidak ditemukan.
- FR-033: `create_deposit` wajib menolak jika `session.status <> 'closed'`.
- FR-034: `create_deposit` wajib menolak branch/staff mismatch.
- FR-035: `create_deposit` wajib menghitung deposit aktif untuk session yang sama dan menolak double submit.
- FR-036: `create_deposit` wajib menghitung `depositable_cash` dan menolak amount yang melebihi nominal tersebut.
- FR-037: `confirm_deposit` wajib revalidate session closed sebelum update status atau insert `cash_logs`.
- FR-038: `admin_create_manual_deposit` wajib memakai validasi yang sama seperti `create_deposit`.
- FR-039: Tambahkan DB trigger `BEFORE INSERT OR UPDATE` pada `cash_deposits` untuk menolak direct API bypass.
- FR-040: Pertimbangkan revoke direct `INSERT/UPDATE/DELETE` pada `cash_deposits` dari `anon, authenticated`, lalu mutasi hanya lewat RPC `SECURITY DEFINER`.

## 8. Desain Teknis

### 8.1 Migration Baru

Buat migration:

```txt
sql/migrations/030_enforce_closed_shift_before_cash_deposit.sql
```

Isi minimal:

- Helper function `public.get_cash_session_depositable_cash(p_session_id bigint) returns numeric`.
- Helper validation function `public.validate_cash_deposit_closed_session(...)`.
- Trigger function untuk `cash_deposits`.
- Replace RPC `create_deposit`.
- Replace RPC `confirm_deposit`.
- Replace RPC `admin_create_manual_deposit` dengan signature baru.
- Optional RPC `get_deposit_eligible_sessions`.
- `NOTIFY pgrst, 'reload schema';`

### 8.2 Deposit Eligible Session RPC

Disarankan membuat RPC:

```sql
public.get_deposit_eligible_sessions(
  p_branch_id bigint,
  p_staff_id bigint,
  p_limit integer DEFAULT 10
)
```

Return columns:

| Kolom | Tipe | Keterangan |
|---|---:|---|
| `session_id` | bigint | `cashier_sessions.id` |
| `branch_id` | bigint | cabang session |
| `staff_id` | bigint | staff session |
| `session_status` | text | harus `closed` |
| `opened_at` | timestamptz | waktu buka |
| `closed_at` | timestamptz | waktu tutup |
| `closing_cash` | numeric | kas aktual saat tutup |
| `expected_cash` | numeric | kas sistem saat tutup |
| `current_cash_amount` | numeric | posisi kas aktual terbaru jika ada |
| `final_cash_amount` | numeric | `COALESCE(current_cash_amount, closing_cash, expected_cash, system_cash)` |
| `deposit_pending` | numeric | total pending session |
| `deposit_confirmed` | numeric | total confirmed session |
| `depositable_cash` | numeric | final cash dikurangi pending/confirmed |
| `has_active_deposit` | boolean | true jika pending/confirmed ada |
| `last_deposit_status` | text | pending/confirmed/rejected/null |
| `block_reason` | text | alasan jika tidak boleh submit |

Filter:

- Hanya `cashier_sessions.status = 'closed'`.
- Branch/staff sesuai parameter.
- Urut `closed_at DESC`.
- Sertakan rejected session agar bisa resubmit.

### 8.3 Rumus Depositable Cash

Gunakan formula:

```sql
final_cash_amount =
  COALESCE(cs.current_cash_amount, cs.closing_cash, cs.expected_cash, public.compute_cash_session_system_amount(cs.id), 0)

active_deposit_amount =
  SUM(cd.amount) WHERE cd.session_id = cs.id AND cd.status IN ('pending', 'confirmed')

depositable_cash =
  GREATEST(final_cash_amount - COALESCE(active_deposit_amount, 0), 0)
```

Catatan:

- `compute_cash_session_system_amount()` sudah dibuat di migration `028`.
- Jika function `compute_cash_session_system_amount` belum ada, fallback ke `expected_cash`/`closing_cash`; jangan membuat dependensi absensi.
- Jika rule bisnis menghendaki satu setoran final per shift, `active_deposit_amount > 0` langsung blok submit.

### 8.4 RPC `create_deposit`

Validasi tambahan wajib sebelum insert:

```sql
IF p_session_id IS NULL THEN
  RAISE EXCEPTION 'Setoran tunai hanya bisa dibuat setelah shift ditutup';
END IF;

SELECT * INTO v_session
FROM public.cashier_sessions
WHERE id = p_session_id
FOR UPDATE;

IF NOT FOUND THEN
  RAISE EXCEPTION 'Shift tidak ditemukan';
END IF;

IF v_session.status <> 'closed' THEN
  RAISE EXCEPTION 'Tutup shift terlebih dahulu sebelum setoran tunai';
END IF;

IF v_session.branch_id <> p_branch_id OR v_session.staff_id <> p_staff_id THEN
  RAISE EXCEPTION 'Setoran tidak sesuai dengan shift staff/cabang';
END IF;
```

Lanjutkan validasi existing:

- `p_amount > 0`.
- `p_amount % 50000 = 0`.
- metode setoran aktif dan cabang cocok.
- bukti wajib untuk non-cash.
- amount tidak melebihi `depositable_cash`.
- tidak ada deposit aktif untuk `p_session_id`.

Insert harus mengisi:

- `session_id = p_session_id`.
- `cash_balance_at_deposit = depositable_cash` atau `final_cash_amount` sebelum deposit.
- `deposit_account_name_snapshot`.

### 8.5 RPC `confirm_deposit`

Sebelum update `cash_deposits.status`, lakukan:

- Lock row deposit: existing `FOR UPDATE` tetap dipakai.
- Reject jika `v_dep.session_id IS NULL`.
- Lock session: `SELECT * FROM cashier_sessions WHERE id = v_dep.session_id FOR UPDATE`.
- Reject jika session tidak ditemukan.
- Reject jika `session.status <> 'closed'`.
- Reject jika branch/staff mismatch.
- Reject jika deposit amount melebihi remaining valid.

Saat confirmed, insert `cash_logs` tetap:

- `type = 'out'`.
- `reference_type = 'deposit'`.
- `reference_id = v_dep.id`.
- `session_id = v_dep.session_id`.

Jangan insert `cash_logs` dengan `session_id = NULL` untuk setoran baru.

### 8.6 Trigger Defense-in-Depth

Karena saat ini RLS/grant permissive, tambahkan trigger:

```sql
CREATE TRIGGER trg_cash_deposits_require_closed_shift
BEFORE INSERT OR UPDATE OF session_id, branch_id, staff_id, amount, status
ON public.cash_deposits
FOR EACH ROW
EXECUTE FUNCTION public.enforce_cash_deposit_closed_shift();
```

Trigger wajib:

- Untuk `INSERT`, selalu validasi closed shift.
- Untuk `UPDATE status` via `confirm_deposit`, tetap validasi closed shift agar deposit legacy yang invalid tidak bisa dikonfirmasi.
- Untuk update metadata non-status pada data historis, jangan memaksa backfill otomatis kecuali kolom yang divalidasi berubah.
- Menolak row baru dengan `NEW.session_id IS NULL`.
- Lock `cashier_sessions` row.
- Menolak `status != 'closed'`.
- Menolak branch/staff mismatch.
- Menolak double active deposit untuk session yang sama.

Double submit check harus mengecualikan row sendiri saat update:

```sql
AND cd.id <> NEW.id
```

### 8.7 Revoke Direct DML

Jika tidak merusak flow existing, ubah grant:

```sql
REVOKE INSERT, UPDATE, DELETE ON public.cash_deposits FROM anon, authenticated;
GRANT SELECT ON public.cash_deposits TO anon, authenticated;
```

Mutasi tetap lewat RPC `SECURITY DEFINER`. Jika revoke belum aman, trigger tetap wajib sebagai minimal guard.

## 9. Perubahan Frontend

### 9.1 `js/depositUi.js`

Refactor state:

```js
selectedClosedSession: null
eligibleSessions: []
depositableCash: 0
```

Ganti logic:

- `hasSession()` jangan dipakai untuk deposit eligibility.
- Tambah `hasEligibleClosedShift()`.
- `refresh()` panggil `depositService.getEligibleSessions({ branchId, staffId })`.
- Pilih latest eligible session otomatis.
- Set `expectedCash/depositableCash` dari RPC, bukan dari `cashService.getSummary()` untuk shift aktif.
- Hapus semua copy/logic:
  - "Tanpa shift aktif"
  - "Mode Setoran Manual"
  - "Mode setoran tanpa shift"
  - `sessionId: pos.session?.id || null`
  - `cashBalance: this.hasSession() ? this.expectedCash : null`

Submit payload baru:

```js
await depositService.submitDeposit({
  branchId: pos.branch.id,
  sessionId: this.selectedClosedSession.id,
  staffId: pos.user.id,
  accountId: account.id,
  amount,
  cashBalance: this.depositableCash,
  file: this.selectedFile,
  notes: this.composeNotes(),
  requireProof: proofRequired
});
```

### 9.2 `js/depositService.js`

Tambahkan:

```js
async getEligibleSessions({ branchId, staffId, limit = 10 })
```

Update `submitDeposit()`:

- Validasi `sessionId` wajib.
- Error message: "Tutup shift terlebih dahulu sebelum setoran tunai".
- Jangan kirim `p_session_id: null`.

Update `createManualDeposit()`:

- Tambah parameter `sessionId`.
- Validasi wajib.
- Kirim `p_session_id`.

### 9.3 `js/pos.js`

Update setelah close shift:

- `transactionService.closeShift()` return closed session aktual.
- `POS.confirmCloseShift()` setelah sukses:
  - simpan optional `this.lastClosedSession = result`.
  - panggil `depositUi.refreshWhenReady()` atau method khusus `depositUi.refresh({ preferSessionId: result.id })`.
  - buka modal post-close seperti sekarang.

Jangan membuka form setoran jika refresh eligibility gagal.

### 9.4 `js/services/transactionService.js`

Update `closeShift()`:

- Setelah update, refetch atau `update(...).select().single()` agar return row `status = 'closed'`.
- Jika kolom migration 028 tersedia, set `current_cash_amount = closingCash`.
- Tetap hitung `expected_cash` via `cashService.getSummary()`.

### 9.5 `js/adminStaffCashUi.js`

Update table action:

- Tombol "Setor" hanya render jika `r.session_status === 'closed'`.
- Untuk `open`, render disabled atau tidak render.
- `_openManualDeposit(row)` harus mengirim `session_id`, `branch_id`, `staff_id`.

### 9.6 `js/adminDepositUi.js`

Update manual modal:

- Tambahkan state `manualSessionId`.
- Jika dari `adminStaffCashUi`, prefill shift tertutup.
- Jika dari menu biasa, setelah pilih branch/staff load dropdown "Shift Tertutup".
- Submit disabled jika shift tertutup kosong.
- `saveManualDeposit()` mengirim `sessionId` ke `depositService.createManualDeposit()`.

## 10. Edge Cases

| Case | Expected |
|---|---|
| Staff belum pernah buka shift | Form setoran hidden/disabled. Pesan: "Belum ada shift tertutup untuk disetor." |
| Staff masih shift `open` | Submit ditolak. Pesan: "Tutup shift terlebih dahulu sebelum setoran tunai." |
| Staff sudah close shift | Form aktif untuk session closed tersebut. |
| Staff refresh browser setelah close shift | UI tetap menemukan shift closed dari DB, tidak bergantung memori `POS.lastClosedSession`. |
| Staff buka shift baru sebelum setor shift lama | Setoran tetap boleh untuk shift lama yang `closed`, tetapi UI harus jelas menampilkan `session_id` shift yang disetor. |
| Shift closed sudah punya pending deposit | Submit disabled; tampilkan pending. |
| Shift closed sudah punya confirmed deposit | Submit disabled; tampilkan selesai. |
| Deposit rejected | Submit ulang boleh untuk session closed yang sama. |
| Direct RPC `create_deposit` dengan session open | Ditolak oleh RPC/trigger. |
| Direct RPC `create_deposit` dengan session null | Ditolak oleh RPC/trigger. |
| Direct insert REST ke `cash_deposits` | Ditolak oleh trigger atau grant. |
| Admin manual deposit untuk session open | Ditolak frontend dan RPC. |
| Admin confirm deposit lama dengan session null/open | Ditolak oleh `confirm_deposit`. |
| Data historis session null | Tetap bisa dibaca di list, tetapi tidak boleh dikonfirmasi jika pending. |

## 11. Data Historis dan Migrasi Aman

Jangan auto-delete data historis.

Sebelum menambahkan guard final, jalankan audit query:

```sql
SELECT cd.id, cd.created_at, cd.status, cd.session_id, cd.branch_id, cd.staff_id, cs.status AS session_status
FROM public.cash_deposits cd
LEFT JOIN public.cashier_sessions cs ON cs.id = cd.session_id
WHERE cd.status IN ('pending','confirmed')
  AND (cd.session_id IS NULL OR cs.id IS NULL OR cs.status <> 'closed');
```

Duplicate audit:

```sql
SELECT session_id, COUNT(*) AS active_count, SUM(amount) AS active_amount
FROM public.cash_deposits
WHERE session_id IS NOT NULL
  AND status IN ('pending','confirmed')
GROUP BY session_id
HAVING COUNT(*) > 1;
```

Handling:

- Pending invalid: reject manual lewat SQL/admin decision dengan alasan migrasi, atau minta admin proses ulang setelah shift closed.
- Confirmed invalid: jangan ubah otomatis. Tandai sebagai legacy risk dalam catatan migrasi jika perlu.
- Trigger baru berlaku untuk write baru dan update status berikutnya.

## 12. Acceptance Criteria

- AC-001: Staff tidak bisa submit setoran saat `cashier_sessions.status = 'open'`.
- AC-002: Staff tidak bisa submit setoran dengan `session_id = NULL`.
- AC-003: Staff bisa submit setoran setelah shift ditutup dan payload berisi `session_id` closed.
- AC-004: Row `cash_deposits` baru selalu punya `session_id` closed.
- AC-005: RPC `create_deposit` menolak open/null/mismatch session walaupun dipanggil langsung.
- AC-006: RPC `confirm_deposit` menolak deposit pending lama jika session null/open.
- AC-007: Admin manual deposit tidak bisa dibuat tanpa shift tertutup.
- AC-008: Admin UI tidak menawarkan tombol Setor pada sesi kas `open`.
- AC-009: Double submit untuk session closed yang sama ditolak secara atomik.
- AC-010: Data historis tetap bisa tampil di riwayat tanpa crash.
- AC-011: Tidak ada file baru/logic baru terkait absensi.
- AC-012: Pencarian kode untuk `absen`, `absensi`, `attendance`, `clock-in`, `check-in` tidak menemukan penambahan feature flow.

## 13. Test Plan

### SQL/RPC

1. Buat/open shift, panggil `create_deposit` dengan `p_session_id` shift open. Expected: error.
2. Panggil `create_deposit` dengan `p_session_id = NULL`. Expected: error.
3. Close shift, panggil `create_deposit` dengan session closed valid. Expected: row pending dibuat.
4. Ulangi create untuk session yang sama saat pending masih ada. Expected: error double submit.
5. Confirm deposit valid. Expected: status `confirmed`, `cash_logs.reference_type = 'deposit'`, `cash_logs.session_id` sama.
6. Confirm deposit legacy `session_id NULL/open`. Expected: error.
7. `admin_create_manual_deposit` dengan session open/null. Expected: error.
8. Direct REST/SQL insert ke `cash_deposits` dengan session open/null. Expected: trigger/grant menolak.

### Staff UI

1. Login staff, belum buka shift, buka tab Setoran. Expected: form disabled, pesan belum ada shift tertutup.
2. Buka shift, buka tab Setoran. Expected: form disabled, pesan tutup shift dulu.
3. Tutup shift. Klik "Setor Tunai Sekarang". Expected: tab setoran menampilkan shift closed dan kas final.
4. Submit nominal valid. Expected: berhasil, history pending, form disabled untuk shift itu.
5. Refresh browser setelah close shift sebelum setor. Expected: shift closed tetap muncul sebagai eligible.

### Admin UI

1. Buka Posisi Kas Staff dengan filter open. Expected: tombol Setor tidak aktif untuk open.
2. Buka row closed. Expected: tombol Setor aktif.
3. Simpan manual deposit dari row closed. Expected: `cash_deposits.session_id = row.session_id`.
4. Buka menu Setoran Manual langsung. Expected: wajib pilih cabang, staff, shift tertutup.

## 14. File yang Perlu Diubah

| File | Perubahan |
|---|---|
| `sql/migrations/030_enforce_closed_shift_before_cash_deposit.sql` | Migration baru: helper RPC, trigger, replace `create_deposit`, `confirm_deposit`, `admin_create_manual_deposit`. |
| `js/depositService.js` | Wajibkan `sessionId`, tambah fetch eligible closed sessions, update manual deposit payload. |
| `js/depositUi.js` | Hapus mode tanpa shift, pakai `selectedClosedSession`, disable submit sampai shift closed valid. |
| `js/pos.js` | Setelah close shift refresh eligibility setoran dan preselect closed session. |
| `js/services/transactionService.js` | Return closed session aktual dan set `current_cash_amount` jika tersedia. |
| `js/adminStaffCashUi.js` | Disable/hide Setor untuk session open; pass `session_id` ke manual deposit modal. |
| `js/adminDepositUi.js` | Tambah pilihan/hidden shift tertutup; kirim `sessionId`. |
| `pos.html` | Copy/label setoran jika perlu; hapus teks mode tanpa shift. |
| `admin.html` | Tambah field shift tertutup pada modal manual deposit jika modal umum tetap dipakai. |

## 15. Non-Regression

- Transaksi POS tetap wajib punya shift open seperti sekarang.
- Kas masuk/keluar manual POS tetap hanya untuk shift open.
- Tutup shift tetap menghitung `expected_cash` dari `cashService.getSummary()`.
- Konfirmasi deposit tetap membuat `cash_logs` keluar dengan `reference_type = 'deposit'`.
- Riwayat setoran lama tetap tampil.
- Upload bukti setoran dan metode setoran existing tetap mengikuti rule migration 026/027.
- Tidak ada dependency absensi.

## 16. Instruksi Implementasi untuk AI Builder

Kerjakan berurutan:

1. Implement migration 030 dan pastikan RPC lama di-drop dengan signature yang benar.
2. Tambahkan helper RPC eligibility agar frontend tidak menghitung sendiri dengan query N+1.
3. Update `depositService` sebagai contract layer.
4. Update `depositUi` agar tidak lagi memakai `POS.session` untuk deposit.
5. Update `transactionService.closeShift()` dan `POS.confirmCloseShift()` untuk return/preselect closed session.
6. Update admin manual deposit agar selalu memilih/menyimpan `session_id` closed.
7. Jalankan test SQL/RPC bypass lebih dulu, baru test UI.
8. Cari teks/kode absensi dan pastikan tidak ada flow absensi baru.

Jangan menganggap validasi UI cukup. Syarat selesai adalah direct API/RPC/direct insert juga tidak bisa membuat setoran sebelum shift closed.
