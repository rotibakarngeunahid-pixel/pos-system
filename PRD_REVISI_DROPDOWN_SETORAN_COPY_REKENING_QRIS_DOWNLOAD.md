# PRD: Revisi Dropdown Metode Setoran, Copy Rekening, dan Download QRIS

Tanggal: 2026-05-18  
Produk: Roti Bakar Ngeunah POS  
Area: Staff POS - Halaman Setoran Tunai  
Prioritas: Tinggi  
Status: Ready for AI Builder

## 1. Ringkasan

Revisi ini mengubah pengalaman staff saat memilih metode setoran di halaman setoran tunai POS.

Target utama:

- Metode setoran staff berbentuk dropdown.
- Nomor rekening baru muncul setelah staff memilih metode bank.
- Nomor rekening dapat disalin dengan satu tombol.
- Jika metode setoran adalah QRIS, sistem menampilkan gambar QRIS yang sudah diupload admin.
- QRIS dapat diunduh oleh staff agar bisa dipakai saat membayar melalui mobile banking.
- Bukti setoran tetap harus diupload setelah staff melakukan transfer/QRIS.

Ekspektasi UX mirip flow pembayaran melalui payment gateway seperti Midtrans atau Xendit: user memilih metode dulu, lalu sistem menampilkan instruksi pembayaran yang relevan untuk metode tersebut. Revisi ini bukan integrasi API payment gateway.

## 2. Background Masalah

Berdasarkan pembacaan kode existing, fitur setoran tunai sudah memiliki basis data dan flow utama yang mendukung metode setoran dinamis.

Kondisi saat ini:

- `deposit_accounts` sudah memiliki data metode setoran dengan `type` `bank`, `qris`, atau `cash`.
- Untuk rekening bank, tabel sudah punya `bank_name`, `account_number`, dan `account_holder`.
- Untuk QRIS, tabel sudah punya `qris_image_url`.
- Admin sudah dapat mengupload QRIS melalui modal metode setoran di `admin.html` dan `js/adminDepositUi.js`.
- Storage bucket `deposit-qris` sudah dibuat sebagai public bucket lewat migrasi `sql/migrations/006_create_storage_buckets_deposit_proofs_and_qris.sql`.
- Staff UI di `pos.html` masih memakai `input hidden` `#deposit-account-select` dan pilihan metode berbentuk kartu/radio grid lewat `#deposit-account-options`.
- `js/depositUi.js` sudah mengambil daftar akun melalui `depositService.getAccounts()` dan sudah mengenali tipe metode, tetapi belum punya selected detail panel untuk salin rekening atau unduh QRIS.

Masalah operasional:

- Nomor rekening terlihat sebagai teks detail pada kartu metode, tetapi belum dirancang sebagai informasi yang mudah disalin.
- Pada mobile, staff perlu copy nomor rekening secara manual dari teks kecil sehingga rawan salah salin.
- Semua metode terlihat sekaligus, padahal flow yang diinginkan adalah pilih metode dulu, lalu detail pembayaran muncul.
- QRIS yang sudah diupload admin belum ditampilkan kepada staff di halaman setoran.
- Staff belum punya tombol unduh QRIS langsung dari halaman setoran.
- Tanpa tampilan QRIS dan tombol unduh, staff harus mencari QRIS di luar sistem atau meminta ulang ke admin.

Dampak:

- Proses setoran bank dan QRIS lebih lambat.
- Risiko salah nomor rekening lebih besar.
- Staff bisa bingung membedakan QRIS tujuan pembayaran dengan bukti setoran yang harus diupload.
- Data metode setoran yang sudah disiapkan admin belum termanfaatkan penuh di UI staff.

## 3. Tujuan

Tujuan utama:

- Membuat flow setoran staff lebih jelas: pilih metode, lihat instruksi, lakukan pembayaran, upload bukti.
- Membuat nomor rekening mudah disalin tanpa staff perlu blok teks manual.
- Membuat QRIS yang sudah diupload admin tampil langsung pada flow setoran staff.
- Memberikan opsi unduh QRIS agar staff bisa melanjutkan pembayaran di mobile banking.
- Menjaga validasi setoran existing tetap berjalan: shift harus tertutup, nominal valid, metode aktif, dan bukti wajib untuk non-cash.

Tujuan detail:

1. Dropdown metode setoran menggantikan radio/card grid sebagai input utama.
2. Detail metode hanya muncul setelah staff memilih metode.
3. Untuk metode bank, detail menampilkan bank, nomor rekening, pemilik rekening, dan tombol salin nomor rekening.
4. Untuk metode QRIS, detail menampilkan gambar QRIS, tombol unduh QRIS, dan tombol buka QRIS jika download tidak didukung browser.
5. Untuk metode cash/tunai, detail menampilkan instruksi serah tunai langsung dan bukti setoran tetap opsional.
6. Tombol submit tetap disabled sampai nominal valid, metode dipilih, dan bukti tersedia jika wajib.
7. UI tetap mobile-first dan tidak menambah konflik layout pada PRD perbaikan UI/UX setoran tunai mobile.
8. Tidak ada perubahan behavior approval admin dan pengurangan kas selain yang sudah ada.

## 4. Scope

### In Scope

- Revisi UI staff pada `pos.html`, panel `#panel-deposits`.
- Revisi state dan interaksi pilihan metode di `js/depositUi.js`.
- Penambahan detail panel metode setoran terpilih.
- Penambahan tombol copy nomor rekening.
- Penambahan preview QRIS dan tombol unduh QRIS.
- Penyesuaian CSS di `css/styles.css`.
- Validasi agar QRIS aktif tanpa gambar ditangani dengan jelas.
- Validasi agar rekening bank aktif tanpa nomor rekening ditangani dengan jelas.
- Revisi copy UI agar staff paham bahwa QRIS yang ditampilkan adalah tujuan pembayaran, bukan bukti setoran.
- Verifikasi admin upload QRIS existing tetap kompatibel.

### Out of Scope

- Integrasi API Midtrans, Xendit, QRIS provider, bank, atau e-wallet.
- Generate virtual account otomatis.
- Generate QRIS dinamis per nominal.
- Rekonsiliasi bank otomatis.
- Auto-detect pembayaran QRIS.
- Mengubah flow konfirmasi/reject setoran admin.
- Mengubah rule wajib tutup shift sebelum setoran.
- Mengubah database utama jika kolom existing sudah cukup.
- Migrasi data historis setoran.

## 5. Definisi Data

| Istilah | Definisi teknis |
|---|---|
| Metode setoran | Row pada `public.deposit_accounts`. |
| Metode bank | `deposit_accounts.type = 'bank'`. |
| Metode QRIS | `deposit_accounts.type = 'qris'`. |
| Metode cash/tunai | `deposit_accounts.type = 'cash'` atau dikenali oleh `depositService.isCashDepositMethod()`. |
| Nomor rekening | `deposit_accounts.account_number`. |
| Pemilik rekening | `deposit_accounts.account_holder`. |
| Gambar QRIS | `deposit_accounts.qris_image_url`. |
| Bukti setoran | File yang diupload staff ke bucket `deposit-proofs` dan disimpan pada `cash_deposits.proof_url`. |

## 6. Kondisi Kode Existing

### Staff POS

File: `pos.html`

- Panel setoran staff ada di `#panel-deposits`.
- Saat ini metode setoran memakai:
  - `#deposit-account-select` sebagai hidden input.
  - `#deposit-account-options` sebagai radio/card grid.
  - `#deposit-account-empty` untuk empty/error state.
- Upload bukti setoran memakai:
  - `#deposit-proof-file`.
  - `#deposit-proof-zone`.
  - `#deposit-proof-preview`.
  - `#deposit-proof-hint`.

File: `js/depositUi.js`

- `depositUi.accounts` menyimpan daftar metode setoran.
- `depositService.getAccounts({ branchId })` sudah mengembalikan `select('*')`.
- `renderAccounts()` saat ini membuat kartu metode.
- `selectAccount(id)` menyimpan pilihan pada hidden input dan mengubah selected state kartu.
- `getSelectedAccount()` mengambil akun dari `this.accounts` berdasarkan `#deposit-account-select.value`.
- `updateMethodDependentFields()` mengubah hint bukti setoran berdasarkan metode.
- `isProofRequired()` membuat bukti wajib untuk non-cash.
- `onSubmit()` mengirim `account.id` ke `depositService.submitDeposit()`.

File: `css/styles.css`

- CSS metode setoran existing memakai `.deposit-method-grid`, `.deposit-method-card`, `.deposit-method-icon`, dan `.deposit-method-copy`.
- Perlu ditambah CSS baru untuk dropdown dan selected detail panel.

### Admin Metode Setoran

File: `admin.html`

- Modal metode setoran ada di `#modal-deposit-account`.
- Admin dapat memilih tipe `bank`, `qris`, atau `cash`.
- Untuk bank, admin mengisi `bank_name`, `account_number`, dan `account_holder`.
- Untuk QRIS, admin mengisi URL atau upload gambar QRIS.

File: `js/adminDepositUi.js`

- `saveAccount()` menyimpan `qrisImageUrl`.
- `uploadQrisImage()` upload ke bucket `deposit-qris` dan mengambil public URL.
- `renderQrisPreview()` menampilkan preview pada modal admin.

### Database dan Storage

File: `sql/migrations/001_create_deposit_accounts_and_policies.sql`

- Tabel `deposit_accounts` sudah memiliki:
  - `type`
  - `label`
  - `bank_name`
  - `account_number`
  - `account_holder`
  - `qris_image_url`
  - `is_active`

File: `sql/migrations/006_create_storage_buckets_deposit_proofs_and_qris.sql`

- Bucket `deposit-qris` sudah dibuat public.
- Bucket `deposit-proofs` private dan dipakai untuk bukti setoran.

Kesimpulan teknis: revisi utama dapat dilakukan di frontend. Tidak perlu migration baru kecuali ingin menambah constraint/metadata tambahan.

## 7. User Flow Baru

### Staff Setor Melalui Transfer Bank

1. Staff membuka tab Setoran.
2. Sistem memastikan ada shift tertutup yang eligible.
3. Staff mengisi jumlah setoran.
4. Staff membuka dropdown Metode Setoran.
5. Staff memilih metode bank, misalnya BCA.
6. Sistem menampilkan panel detail:
   - Nama bank.
   - Nomor rekening.
   - Pemilik rekening.
   - Tombol Salin Nomor.
7. Staff menekan tombol Salin Nomor.
8. Sistem menyalin nomor rekening ke clipboard dan menampilkan feedback berhasil.
9. Staff melakukan transfer di mobile banking.
10. Staff kembali ke POS dan upload bukti setoran.
11. Staff submit setoran.

### Staff Setor Melalui QRIS

1. Staff membuka tab Setoran.
2. Sistem memastikan ada shift tertutup yang eligible.
3. Staff mengisi jumlah setoran.
4. Staff memilih metode QRIS pada dropdown.
5. Sistem menampilkan panel detail:
   - Label metode QRIS.
   - Preview gambar QRIS dari `qris_image_url`.
   - Tombol Unduh QRIS.
   - Tombol Buka QRIS.
6. Staff mengunduh atau membuka QRIS.
7. Staff melakukan pembayaran QRIS melalui mobile banking.
8. Staff kembali ke POS dan upload bukti pembayaran.
9. Staff submit setoran.

### Staff Setor Tunai Langsung

1. Staff memilih metode cash/tunai.
2. Sistem menampilkan instruksi serahkan tunai langsung ke manager/admin.
3. Bukti setoran bersifat opsional sesuai rule existing.
4. Staff submit setelah nominal valid.

## 8. Functional Requirements

### Dropdown Metode Setoran

- FR-001: Sistem harus mengganti input utama metode setoran staff dari radio/card grid menjadi dropdown.
- FR-002: Dropdown harus memakai data aktif dari `deposit_accounts` yang sudah difilter oleh `depositService.getAccounts({ branchId })`.
- FR-003: Dropdown harus memiliki placeholder seperti `Pilih metode setoran`.
- FR-004: Dropdown harus disabled saat form blocked, misalnya belum ada shift tertutup, sedang submit, atau tidak ada kas yang dapat disetor.
- FR-005: Dropdown harus disabled/loading saat data metode sedang dimuat.
- FR-006: Dropdown hanya boleh memilih satu metode setoran.
- FR-007: Pilihan metode terakhir boleh tetap disimpan via localStorage seperti behavior existing, selama metode tersebut masih aktif.
- FR-008: Jika metode terakhir sudah tidak aktif/tidak tersedia, dropdown kembali ke placeholder.
- FR-009: Opsi dropdown sebaiknya menampilkan label ringkas metode, bukan instruksi panjang.
- FR-010: Detail nomor rekening atau QRIS tidak perlu tampil sebelum metode dipilih.

### Detail Bank dan Copy Rekening

- FR-011: Jika metode terpilih `type = 'bank'`, sistem harus menampilkan detail rekening setelah dropdown.
- FR-012: Detail rekening minimal berisi `bank_name`, `account_number`, dan `account_holder`.
- FR-013: Nomor rekening harus tampil sebagai teks besar/jelas dan dapat diseleksi manual.
- FR-014: Sistem harus menyediakan tombol Salin Nomor di dekat nomor rekening.
- FR-015: Tombol Salin Nomor harus menyalin hanya angka/teks nomor rekening, bukan label bank atau pemilik.
- FR-016: Setelah berhasil copy, sistem harus menampilkan feedback singkat seperti `Nomor rekening disalin`.
- FR-017: Jika Clipboard API gagal/tidak tersedia, sistem harus menyediakan fallback copy menggunakan temporary input/textarea.
- FR-018: Jika fallback juga gagal, sistem harus menampilkan pesan agar staff menyalin manual.
- FR-019: Jika metode bank tidak memiliki `account_number`, sistem harus menampilkan state konfigurasi belum lengkap dan submit tidak boleh dilakukan untuk metode tersebut.
- FR-020: Jika `bank_name` atau `account_holder` kosong, UI tetap tidak crash dan menampilkan fallback `-`.

### Detail QRIS dan Download QRIS

- FR-021: Jika metode terpilih `type = 'qris'`, sistem harus menampilkan panel QRIS setelah dropdown.
- FR-022: Panel QRIS harus mengambil gambar dari `deposit_accounts.qris_image_url`.
- FR-023: Gambar QRIS harus tampil cukup besar untuk diverifikasi staff, minimal mudah terlihat di mobile 320px.
- FR-024: Gambar QRIS harus memiliki alt text yang jelas, misalnya `QRIS setoran Roti Bakar Ngeunah`.
- FR-025: Sistem harus menyediakan tombol Unduh QRIS.
- FR-026: Tombol Unduh QRIS harus memakai link ke `qris_image_url` dengan atribut `download` jika memungkinkan.
- FR-027: Sistem harus menyediakan tombol Buka QRIS sebagai fallback untuk browser/mobile yang tidak menjalankan download pada URL publik lintas origin.
- FR-028: Tombol Buka QRIS harus membuka tab baru dengan `target="_blank"` dan `rel="noopener"`.
- FR-029: Jika `qris_image_url` kosong, rusak, atau tidak valid, sistem harus menampilkan state konfigurasi belum lengkap.
- FR-030: Metode QRIS tanpa gambar tidak boleh bisa disubmit sampai admin melengkapi QRIS, atau metode tersebut harus dinonaktifkan dari daftar staff.
- FR-031: QRIS yang ditampilkan adalah tujuan pembayaran, bukan bukti setoran.
- FR-032: Bukti pembayaran QRIS tetap wajib diupload sebelum submit.

### Detail Cash/Tunai

- FR-033: Jika metode terpilih cash/tunai, sistem harus menampilkan panel instruksi singkat untuk serah tunai langsung.
- FR-034: Untuk cash/tunai, bukti setoran tetap opsional sesuai rule existing `depositService.isCashDepositMethod()`.
- FR-035: Tombol copy rekening dan unduh QRIS tidak boleh tampil pada metode cash/tunai.

### Validasi Submit

- FR-036: Submit harus disabled jika belum ada metode dipilih.
- FR-037: Submit harus disabled jika metode bank dipilih tetapi nomor rekening kosong.
- FR-038: Submit harus disabled jika metode QRIS dipilih tetapi gambar QRIS kosong/tidak valid.
- FR-039: Submit harus disabled jika bukti wajib tetapi belum ada file bukti.
- FR-040: Submit tetap harus memakai validasi nominal existing: jumlah lebih dari 0, kelipatan Rp 50.000, dan tidak melebihi kas yang dapat disetor.
- FR-041: `depositService.submitDeposit()` tetap menerima `accountId` yang sama dan tidak perlu mengubah kontrak RPC.
- FR-042: Backend RPC existing tetap menjadi source of truth untuk validasi metode aktif, nominal, cabang, dan shift tertutup.

### Admin Metode Setoran

- FR-043: Admin tetap dapat mengupload QRIS melalui flow existing.
- FR-044: Saat admin membuat/mengedit metode `qris`, sistem sebaiknya mewajibkan URL/upload gambar QRIS jika metode ingin diaktifkan.
- FR-045: Saat admin membuat/mengedit metode `bank`, sistem tetap wajib meminta nama bank, nomor rekening, dan pemilik rekening.
- FR-046: Daftar metode admin tetap menampilkan nomor rekening untuk kebutuhan administrasi.
- FR-047: Perubahan staff UI tidak boleh merusak form setoran manual admin yang memakai dropdown metode setoran sendiri.

## 9. Non-Functional Requirements

- NFR-001: UI harus mobile-first dan nyaman pada viewport 320px.
- NFR-002: Tidak boleh ada horizontal overflow.
- NFR-003: Dropdown, detail panel, QRIS preview, dan tombol harus tetap rapi pada layar kecil.
- NFR-004: Tombol Salin Nomor dan Unduh QRIS harus touch-friendly dengan tinggi minimal 40px.
- NFR-005: Tidak boleh ada teks penting yang terpotong tanpa fallback.
- NFR-006: Semua URL QRIS harus di-escape saat dirender ke HTML.
- NFR-007: Jangan mengeksekusi URL selain `http:` atau `https:` untuk QRIS image/link.
- NFR-008: Jika gambar QRIS gagal dimuat, tampilkan error state yang jelas.
- NFR-009: Perubahan harus kompatibel dengan browser mobile modern.
- NFR-010: Copy feedback tidak boleh mengubah layout secara besar atau membuat tombol bergeser.

## 10. UI Requirements

### Struktur UI Baru pada Form Staff

Di dalam form setoran, urutan field menjadi:

1. Jumlah Setoran.
2. Metode Setoran dropdown.
3. Detail metode terpilih.
4. Bukti Setoran.
5. Catatan.
6. Tombol Setor Sekarang.

### Dropdown

Komponen yang disarankan:

```html
<select class="form-control deposit-method-select" id="deposit-account-select">
  <option value="">Pilih metode setoran</option>
</select>
```

Catatan:

- `#deposit-account-select` boleh tetap dipakai agar perubahan di `getSelectedAccount()` minimal.
- Hidden input existing diganti menjadi `select`.
- `#deposit-account-options` dapat dihapus atau dipakai ulang sebagai container detail/loading jika ingin menjaga perubahan HTML lebih kecil.

### Detail Bank

Contoh struktur:

```html
<div id="deposit-method-detail" class="deposit-method-detail">
  <div class="deposit-bank-detail">
    <div class="deposit-method-detail-row">
      <span>Bank</span>
      <strong>BCA</strong>
    </div>
    <div class="deposit-account-number-row">
      <div>
        <span>Nomor Rekening</span>
        <strong class="deposit-account-number">1234567890</strong>
      </div>
      <button type="button" class="btn btn-outline btn-sm" data-action="copy-deposit-account-number">
        Salin Nomor
      </button>
    </div>
    <div class="deposit-method-detail-row">
      <span>Atas Nama</span>
      <strong>Roti Bakar Ngeunah</strong>
    </div>
  </div>
</div>
```

### Detail QRIS

Contoh struktur:

```html
<div class="deposit-qris-detail">
  <div class="deposit-qris-preview">
    <img src="..." alt="QRIS setoran Roti Bakar Ngeunah" />
  </div>
  <div class="deposit-qris-actions">
    <a class="btn btn-primary btn-sm" href="..." download>Unduh QRIS</a>
    <a class="btn btn-outline btn-sm" href="..." target="_blank" rel="noopener">Buka QRIS</a>
  </div>
</div>
```

### Copywriting

Gunakan copy singkat dan operasional:

- Placeholder dropdown: `Pilih metode setoran`.
- Bank detail title: `Transfer ke rekening ini`.
- Copy button: `Salin Nomor`.
- Copy success: `Nomor rekening disalin`.
- QRIS detail title: `Gunakan QRIS ini`.
- QRIS download button: `Unduh QRIS`.
- QRIS open button: `Buka QRIS`.
- QRIS proof hint: `Setelah pembayaran QRIS selesai, upload bukti pembayaran.`
- Bank proof hint: `Setelah transfer selesai, upload bukti transfer.`
- Cash proof hint: `Bukti opsional untuk penyerahan tunai langsung.`
- QRIS missing image: `QRIS belum dikonfigurasi. Hubungi admin.`
- Bank missing number: `Nomor rekening belum dikonfigurasi. Hubungi admin.`

## 11. Implementation Notes

### `pos.html`

Perubahan yang disarankan:

- Ubah `#deposit-account-select` dari hidden input menjadi `select.form-control.deposit-method-select`.
- Tambahkan container detail, misalnya `#deposit-method-detail`, setelah dropdown.
- Jika `#deposit-account-options` tidak lagi dipakai untuk card grid, bisa dihapus atau dibiarkan kosong untuk backward compatibility selama tidak merusak layout.

### `js/depositUi.js`

Perubahan yang disarankan:

- `bindElements()`:
  - Bind `change` pada `this.el.accountSelect`.
  - Tambahkan `this.el.accountDetail = document.getElementById('deposit-method-detail')`.
  - Tambahkan handler click untuk tombol copy rekening jika memakai event delegation.

- `renderAccountLoading()`:
  - Isi dropdown dengan option loading.
  - Disable dropdown saat loading.
  - Kosongkan detail panel.

- `renderAccounts()`:
  - Sort dan dedupe tetap memakai fungsi existing.
  - Render `<option>` ke `#deposit-account-select`.
  - Placeholder selalu ada.
  - Pilih last account jika masih valid.
  - Panggil `renderSelectedAccountDetail()`.

- `selectAccount(id, { persist = true } = {})`:
  - Update value dropdown.
  - Simpan localStorage jika valid.
  - Panggil `renderSelectedAccountDetail()`.
  - Panggil `updateMethodDependentFields()` dan `updateSubmitState()`.

- Tambahkan helper:
  - `renderSelectedAccountDetail()`
  - `renderBankAccountDetail(account)`
  - `renderQrisAccountDetail(account)`
  - `renderCashAccountDetail(account)`
  - `copySelectedAccountNumber()`
  - `copyTextToClipboard(text)`
  - `isSelectedMethodReady(account)`
  - `isSafeHttpUrl(url)`

- `updateSubmitState()`:
  - Tambahkan validasi `methodReady`.
  - Disable submit jika metode belum lengkap.

- `updateMethodDependentFields()`:
  - Untuk bank: hint bukti menjadi bukti transfer.
  - Untuk QRIS: hint bukti menjadi bukti pembayaran QRIS.
  - Untuk cash: hint bukti opsional.

- `clearForm()`:
  - Jika tidak keep account, kosongkan dropdown dan detail panel.

- `showDepositConfirm()`:
  - Tetap tampilkan label metode.
  - Opsional: untuk bank tampilkan bank/account holder, tetapi jangan wajib.

### `js/depositService.js`

Kemungkinan tidak perlu perubahan kontrak utama.

Opsional:

- Tambahkan helper validasi URL QRIS jika ingin dipakai bersama:
  - `isValidPublicQrisUrl(url)`.
- Pertahankan `getAccounts()` karena sudah `select('*')`.
- Pertahankan `submitDeposit()` karena tetap memakai `accountId`.

### `js/adminDepositUi.js`

Perubahan opsional tetapi disarankan:

- Saat `type === 'qris'` dan `isActive === true`, validasi `qrisImageUrl` wajib ada.
- Pesan error: `Upload atau isi URL gambar QRIS terlebih dahulu.`
- Saat `type === 'bank'` dan `isActive === true`, tetap wajib `bankName`, `accountNumber`, dan `accountHolder`.
- Preview QRIS admin tetap seperti existing.

### `css/styles.css`

Tambahkan style baru:

- `.deposit-method-select`
- `.deposit-method-detail`
- `.deposit-method-detail-title`
- `.deposit-method-detail-row`
- `.deposit-account-number-row`
- `.deposit-account-number`
- `.deposit-copy-feedback`
- `.deposit-qris-detail`
- `.deposit-qris-preview`
- `.deposit-qris-preview img`
- `.deposit-qris-actions`
- `.deposit-method-config-error`

Pertahankan atau hapus style card lama sesuai keputusan implementasi. Jika card lama tidak dipakai di staff UI tetapi masih dipakai tempat lain, jangan hapus tanpa verifikasi.

## 12. Business Rules

- BR-001: Staff harus memilih metode setoran sebelum submit.
- BR-002: Detail rekening/QRIS hanya tampil setelah metode dipilih.
- BR-003: Nomor rekening harus bisa disalin untuk metode bank.
- BR-004: QRIS harus bisa dilihat dan diunduh untuk metode QRIS.
- BR-005: QRIS yang ditampilkan bukan bukti setoran.
- BR-006: Bukti setoran wajib untuk metode bank dan QRIS.
- BR-007: Bukti setoran opsional untuk metode cash/tunai.
- BR-008: Metode bank aktif wajib memiliki nomor rekening.
- BR-009: Metode QRIS aktif wajib memiliki gambar QRIS.
- BR-010: Shift tertutup tetap wajib sebelum setoran, sesuai PRD dan migrasi existing.

## 13. Edge Cases

| Kondisi | Expected Behavior |
|---|---|
| Tidak ada metode aktif | Dropdown disabled, tampilkan `Belum ada metode setoran aktif. Hubungi admin.` |
| Gagal memuat metode | Dropdown disabled, tampilkan error existing dari `accountLoadError`. |
| Last selected method sudah nonaktif | Dropdown kembali ke placeholder. |
| Bank tanpa nomor rekening | Tampilkan error konfigurasi, submit disabled. |
| QRIS tanpa gambar | Tampilkan error konfigurasi, submit disabled. |
| Gambar QRIS gagal load | Tampilkan fallback error, tombol buka tetap boleh tampil jika URL valid. |
| Browser tidak support `download` | Tombol Buka QRIS tetap tersedia. |
| Clipboard API gagal | Gunakan fallback textarea copy. |
| Fallback copy gagal | Tampilkan toast agar staff menyalin manual. |
| Staff mengganti metode setelah upload bukti | Bukti tetap boleh dipertahankan, tetapi hint wajib diperbarui sesuai metode baru. |
| Staff memilih cash setelah upload bukti | Bukti menjadi opsional, file yang sudah dipilih boleh tetap ada. |
| Staff memilih QRIS setelah sebelumnya memilih bank | Detail bank hilang, detail QRIS muncul, validation state diperbarui. |

## 14. Acceptance Criteria

- AC-001: Pada halaman setoran staff, metode setoran tampil sebagai dropdown, bukan daftar kartu/radio sebagai input utama.
- AC-002: Saat belum memilih metode, detail rekening/QRIS tidak tampil.
- AC-003: Saat memilih metode bank, nomor rekening tampil jelas.
- AC-004: Tombol Salin Nomor berhasil menyalin nomor rekening ke clipboard.
- AC-005: Setelah copy sukses, staff melihat feedback berhasil.
- AC-006: Saat memilih metode QRIS dengan `qris_image_url`, gambar QRIS tampil.
- AC-007: Tombol Unduh QRIS tersedia pada metode QRIS.
- AC-008: Tombol Buka QRIS tersedia sebagai fallback.
- AC-009: Metode QRIS tanpa gambar tidak dapat disubmit.
- AC-010: Metode bank tanpa nomor rekening tidak dapat disubmit.
- AC-011: Bukti setoran tetap wajib untuk bank dan QRIS.
- AC-012: Bukti setoran tetap opsional untuk cash/tunai.
- AC-013: Submit tetap menolak nominal invalid.
- AC-014: Submit tetap menolak setoran jika belum ada shift tertutup eligible.
- AC-015: Riwayat setoran tetap menampilkan metode yang dipakai.
- AC-016: Admin upload QRIS existing tetap berfungsi.
- AC-017: Tidak ada horizontal overflow pada viewport 320px.
- AC-018: Tidak ada error JavaScript saat load halaman setoran, pilih metode, copy rekening, unduh QRIS, upload bukti, dan submit.

## 15. Test Plan

### Manual Test - Bank

1. Admin buat metode bank aktif dengan bank, nomor rekening, dan pemilik rekening lengkap.
2. Staff tutup shift agar setoran eligible.
3. Staff buka tab Setoran.
4. Staff pilih metode bank pada dropdown.
5. Pastikan detail rekening muncul.
6. Klik Salin Nomor.
7. Paste ke field lain atau browser note untuk memastikan nomor sesuai.
8. Upload bukti transfer.
9. Submit setoran.
10. Pastikan setoran masuk riwayat pending dan admin dashboard.

### Manual Test - QRIS

1. Admin buat metode QRIS aktif dan upload gambar QRIS.
2. Staff buka tab Setoran.
3. Staff pilih metode QRIS.
4. Pastikan QRIS tampil.
5. Klik Unduh QRIS.
6. Klik Buka QRIS.
7. Upload bukti pembayaran QRIS.
8. Submit setoran.
9. Pastikan setoran masuk riwayat pending dan admin dashboard.

### Manual Test - Cash

1. Admin buat metode cash aktif.
2. Staff pilih metode cash.
3. Pastikan detail instruksi tunai tampil.
4. Pastikan bukti setoran opsional.
5. Submit tanpa bukti.
6. Pastikan submit berjalan sesuai rule existing.

### Negative Test

1. Bank aktif tanpa nomor rekening: submit harus disabled/ditolak.
2. QRIS aktif tanpa gambar: submit harus disabled/ditolak.
3. Tidak pilih metode: submit disabled.
4. Tidak upload bukti untuk bank/QRIS: submit disabled.
5. Belum tutup shift: dropdown dan form tetap disabled sesuai behavior existing.
6. Gagal copy clipboard: fallback berjalan atau toast error tampil.

## 16. Data dan Migration

Tidak wajib membuat migration baru karena data yang dibutuhkan sudah tersedia:

- `deposit_accounts.account_number`
- `deposit_accounts.account_holder`
- `deposit_accounts.bank_name`
- `deposit_accounts.qris_image_url`

Migration opsional jika ingin memperketat data:

- Tambahkan constraint atau trigger agar active QRIS wajib punya `qris_image_url`.
- Tambahkan constraint atau trigger agar active bank wajib punya `account_number`.

Namun karena ada data historis dan kebutuhan fleksibilitas admin, validasi frontend/admin bisa cukup untuk tahap ini.

## 17. Rollout

Urutan implementasi yang disarankan:

1. Ubah HTML staff menjadi dropdown plus detail container.
2. Update `depositUi.renderAccounts()` dan `selectAccount()` agar memakai dropdown.
3. Tambahkan render detail bank/QRIS/cash.
4. Tambahkan copy rekening dan download/open QRIS.
5. Tambahkan validasi method readiness di `updateSubmitState()` dan `onSubmit()`.
6. Tambahkan CSS responsive.
7. Tambahkan validasi admin untuk QRIS aktif wajib punya gambar.
8. Manual test bank, QRIS, cash, dan blocked shift.

## 18. Risiko dan Mitigasi

| Risiko | Mitigasi |
|---|---|
| Label metode existing berisi nomor rekening sehingga nomor tetap terlihat di dropdown | Gunakan option label dari `bank_name`/`account_holder` jika tersedia, atau rapikan data admin. |
| Atribut `download` tidak bekerja pada mobile/cross-origin | Sediakan tombol Buka QRIS. |
| Clipboard API tidak tersedia | Tambahkan fallback textarea copy. |
| QRIS URL tidak valid | Validasi URL `http/https` sebelum render link dan gambar. |
| Submit QRIS tanpa bukti | Pertahankan `isProofRequired()` untuk non-cash. |
| UI detail membuat form terlalu panjang di mobile | Gunakan panel compact, QRIS max-width, dan spacing mobile yang hemat. |

## 19. Success Metrics

- Staff dapat menyalin rekening tanpa mengetik manual.
- Staff dapat mengunduh/membuka QRIS dari halaman setoran.
- Jumlah pertanyaan internal tentang nomor rekening/QRIS berkurang.
- Tidak ada peningkatan setoran gagal karena salah metode atau bukti tidak lengkap.
- Tidak ada regresi pada flow setoran bank, QRIS, cash, dan admin approval.

