# PRD: Revisi Setoran Manual dengan Metode Setoran Dinamis dan Bukti Setoran

## 1. Background / Masalah

Saat ini fitur setoran manual pada sistem masih terlihat dan berperilaku seolah-olah setoran hanya dapat dilakukan menggunakan metode cash/tunai. Pada form admin, metode setoran diarahkan ke "Metode Cash" dan kondisi ini membuat admin tidak fleksibel saat mencatat setoran manual.

Dalam operasional Roti Bakar Ngeunah, setoran manual tidak selalu dilakukan secara tunai. Setoran bisa dilakukan melalui transfer bank, QRIS, e-wallet, atau metode setoran lain yang sudah tersedia di sistem. Jika sistem tetap mengunci metode setoran ke cash, data operasional menjadi kurang akurat karena admin harus mencatat transaksi non-cash sebagai cash atau menggunakan catatan manual di luar sistem.

Selain itu, sistem belum mewajibkan bukti setoran pada proses setoran manual. Akibatnya, data setoran manual kurang kuat untuk kebutuhan audit, rekonsiliasi, dan verifikasi oleh owner/admin. Tanpa bukti setoran, owner/admin sulit memastikan apakah setoran benar-benar dilakukan, melalui metode apa, dan apakah nominalnya sesuai dengan data yang dicatat.

Dampak operasional:

- Admin tidak bisa mencatat setoran manual sesuai metode setoran sebenarnya.
- Setoran transfer bank, QRIS, atau e-wallet berisiko tercatat sebagai cash.
- Riwayat setoran kurang informatif untuk audit.
- Owner/admin harus mencari bukti setoran di luar sistem, misalnya chat atau galeri pribadi.
- Proses verifikasi lebih lambat dan lebih rawan salah tafsir.

Asumsi:

- Sistem sudah memiliki data metode pembayaran atau metode setoran existing.
- Sistem sudah memiliki mekanisme upload file atau storage yang dapat digunakan kembali.
- Revisi ini berlaku untuk setoran manual yang dibuat oleh admin/owner, bukan untuk seluruh flow transaksi pembayaran.

## 2. Tujuan

Tujuan utama revisi fitur ini adalah membuat proses setoran manual lebih fleksibel, akurat, dan dapat diaudit.

Tujuan detail:

1. Admin tidak lagi dipaksa menggunakan metode cash saat membuat setoran manual.
2. Admin dapat memilih metode setoran dari dropdown yang mengambil data metode setoran aktif di sistem.
3. Admin wajib memilih salah satu metode setoran sebelum submit.
4. Admin wajib mengupload bukti setoran sebelum submit.
5. Bukti setoran tersimpan pada record setoran dan dapat digunakan untuk verifikasi serta audit.
6. Riwayat/detail setoran manual menampilkan metode setoran dan bukti setoran.
7. Data setoran lama tetap dapat dibuka tanpa error meskipun belum memiliki bukti setoran.
8. Perubahan ini tidak mengganggu flow setoran otomatis, setoran kasir, dan flow kas existing.

## 3. Scope

### In Scope

- Mengubah field metode pada form setoran manual menjadi dropdown metode setoran.
- Mengambil daftar metode setoran dari data metode pembayaran/setoran existing.
- Menampilkan hanya metode setoran yang aktif.
- Menghapus hardcode atau pemaksaan default cash pada setoran manual.
- Menambahkan validasi wajib pilih metode setoran pada frontend dan backend.
- Menambahkan field upload bukti setoran pada form setoran manual.
- Menambahkan validasi wajib upload bukti setoran pada frontend dan backend.
- Menyimpan data metode setoran pada record setoran.
- Menyimpan snapshot nama metode setoran pada record setoran.
- Menyimpan metadata bukti setoran pada record setoran.
- Menampilkan metode setoran pada riwayat/detail setoran manual.
- Menampilkan atau menyediakan akses buka/preview bukti setoran pada riwayat/detail setoran manual.
- Menangani data setoran lama yang belum memiliki metode dinamis atau bukti setoran.
- Menjaga agar flow setoran otomatis dan setoran kasir existing tetap berjalan seperti sebelumnya.

### Out of Scope

- Membuat ulang modul setoran dari nol.
- Membuat modul baru untuk manajemen metode pembayaran/setoran jika modul existing sudah ada.
- Mengubah flow transaksi POS atau metode pembayaran pelanggan.
- Mengubah flow konfirmasi setoran otomatis kecuali ada dependensi teknis minimal.
- Melakukan migrasi otomatis untuk mengisi bukti setoran pada data historis.
- Mengubah data historis menjadi metode tertentu secara otomatis.
- Membuat sistem approval bertingkat baru.
- Membuat rekonsiliasi bank otomatis.
- Integrasi API bank, QRIS provider, atau e-wallet provider.

## 4. User Role

### Owner/Admin

Owner/admin adalah role utama dalam revisi fitur ini.

Hak dan kebutuhan:

- Membuat setoran manual.
- Memilih cabang/outlet dan staff sesuai flow existing.
- Memilih metode setoran dari dropdown.
- Mengupload bukti setoran.
- Submit setoran manual.
- Melihat riwayat setoran manual.
- Melihat metode setoran pada riwayat/detail.
- Membuka atau melihat preview bukti setoran.
- Menggunakan bukti setoran sebagai data verifikasi dan audit.

### Staff

Staff relevan jika data setoran manual tetap dikaitkan ke staff atau kas staff.

Hak dan kebutuhan:

- Staff dapat muncul sebagai pihak yang terkait dengan setoran manual.
- Staff tidak wajib memiliki akses membuat setoran manual kecuali flow existing memang mengizinkan.
- Staff tidak otomatis mendapat akses melihat seluruh bukti setoran, kecuali permission existing memperbolehkan.

Asumsi:

- Jika saat ini hanya admin/owner yang dapat membuat setoran manual, maka revisi ini tidak menambahkan akses baru untuk staff.
- Jika staff memiliki flow setoran sendiri, flow tersebut hanya terdampak jika menggunakan komponen/form setoran manual yang sama.

## 5. User Flow

### Admin Membuat Setoran Manual

1. Admin membuka halaman/menu setoran.
2. Admin memilih aksi untuk membuat setoran manual.
3. Sistem menampilkan form setoran manual.
4. Form menampilkan field cabang/outlet, staff, metode setoran, jumlah setoran, bukti setoran, catatan, dan field lain sesuai flow existing.

### Admin Memilih Metode Setoran

1. Sistem mengambil daftar metode setoran aktif dari data metode pembayaran/setoran existing.
2. Sistem menampilkan daftar tersebut dalam dropdown "Metode Setoran".
3. Admin memilih salah satu metode setoran.
4. Sistem menyimpan pilihan metode pada state form.
5. Sistem tidak memilih cash secara otomatis kecuali admin memilihnya sendiri.

### Admin Upload Bukti Setoran

1. Admin memilih file bukti setoran melalui field upload.
2. Sistem memvalidasi format dan ukuran file sesuai aturan upload existing.
3. Sistem mengupload file ke storage/file upload mechanism existing.
4. Sistem menampilkan status upload.
5. Setelah upload berhasil, sistem menyimpan URL/path dan metadata file pada state form.
6. Jika file berupa gambar, sistem menampilkan preview atau minimal tombol untuk membuka file.

### Admin Submit Setoran

1. Admin mengisi jumlah setoran dan field wajib lain sesuai flow existing.
2. Admin memastikan metode setoran sudah dipilih.
3. Admin memastikan bukti setoran sudah berhasil diupload.
4. Admin menekan tombol submit.
5. Sistem melakukan validasi frontend.
6. Sistem melakukan validasi backend.
7. Jika validasi berhasil, sistem menyimpan data setoran manual beserta metode dan bukti setoran.
8. Sistem menampilkan notifikasi berhasil dan memperbarui riwayat setoran.

### Owner/Admin Melihat Riwayat dan Bukti Setoran

1. Owner/admin membuka riwayat atau detail setoran.
2. Sistem menampilkan data setoran manual.
3. Sistem menampilkan metode setoran yang digunakan.
4. Sistem menampilkan bukti setoran dalam bentuk preview gambar atau tombol/link "Lihat Bukti".
5. Owner/admin dapat membuka bukti setoran untuk verifikasi.
6. Jika data setoran lama belum memiliki bukti, sistem menampilkan status seperti "Bukti belum tersedia" tanpa error.

## 6. Functional Requirements

- FR-001: Sistem harus menyediakan field "Metode Setoran" pada form setoran manual dalam bentuk dropdown.
- FR-002: Dropdown metode setoran harus mengambil data dari tabel/collection metode pembayaran atau metode setoran existing.
- FR-003: Dropdown metode setoran hanya boleh menampilkan metode yang berstatus aktif.
- FR-004: Sistem tidak boleh memaksa default metode setoran menjadi cash.
- FR-005: Placeholder dropdown harus menjelaskan bahwa admin perlu memilih metode setoran, misalnya "Pilih metode setoran".
- FR-006: Admin wajib memilih salah satu metode setoran sebelum setoran manual dapat disubmit.
- FR-007: Sistem harus menolak submit setoran manual jika metode setoran belum dipilih.
- FR-008: Sistem harus memvalidasi ulang di backend bahwa metode setoran yang dikirim valid dan aktif.
- FR-009: Sistem harus menyediakan field upload "Bukti Setoran" pada form setoran manual.
- FR-010: Admin wajib mengupload bukti setoran sebelum setoran manual dapat disubmit.
- FR-011: Sistem harus menolak submit setoran manual jika bukti setoran belum berhasil diupload.
- FR-012: Bukti setoran dapat berupa gambar atau file sesuai kemampuan upload existing sistem.
- FR-013: Sistem harus menggunakan mekanisme storage/file upload existing untuk menyimpan bukti setoran.
- FR-014: Sistem harus menyimpan URL/path file bukti setoran pada record setoran.
- FR-015: Sistem harus menyimpan metadata file bukti setoran, minimal nama file, tipe file, dan waktu upload jika memungkinkan.
- FR-016: Sistem harus menyimpan `deposit_method_id` pada record setoran manual.
- FR-017: Sistem harus menyimpan snapshot nama metode setoran pada record setoran manual agar riwayat tetap terbaca meskipun nama metode berubah.
- FR-018: Riwayat setoran manual harus menampilkan metode setoran.
- FR-019: Detail setoran manual harus menampilkan metode setoran.
- FR-020: Riwayat atau detail setoran manual harus menampilkan bukti setoran atau menyediakan akses untuk membuka bukti tersebut.
- FR-021: Jika bukti setoran berupa gambar, sistem harus menyediakan preview gambar atau tombol untuk membuka gambar di tab/modal/preview sesuai pattern UI existing.
- FR-022: Jika bukti setoran bukan gambar, sistem harus menyediakan tombol/link untuk membuka atau mengunduh file sesuai kemampuan existing.
- FR-023: Data setoran lama yang belum memiliki `deposit_method_id`, snapshot metode, atau bukti setoran harus tetap dapat dibuka tanpa error.
- FR-024: Untuk data setoran lama tanpa bukti, sistem harus menampilkan fallback seperti "Bukti belum tersedia".
- FR-025: Untuk data setoran lama tanpa snapshot metode, sistem harus menampilkan fallback metode dari data lama jika ada, atau label seperti "Metode lama/tidak tersedia".
- FR-026: Perubahan ini tidak boleh mengubah flow setoran otomatis existing.
- FR-027: Perubahan ini tidak boleh mengubah flow setoran kasir existing kecuali komponen yang sama memang digunakan dan tetap kompatibel.
- FR-028: Sistem harus menjaga status setoran existing sesuai aturan saat ini, misalnya pending, dikonfirmasi, atau ditolak.
- FR-029: Sistem harus menampilkan loading state saat daftar metode setoran sedang dimuat.
- FR-030: Sistem harus menampilkan loading/progress state saat bukti setoran sedang diupload.
- FR-031: Sistem harus menampilkan error message yang jelas saat metode belum dipilih.
- FR-032: Sistem harus menampilkan error message yang jelas saat bukti belum diupload.
- FR-033: Sistem harus menampilkan error message yang jelas saat upload bukti gagal.
- FR-034: Sistem harus mencegah submit ganda saat proses submit atau upload masih berjalan.
- FR-035: Sistem harus mencatat `created_by` sesuai user admin/owner yang membuat setoran manual.

## 7. Business Rules

- BR-001: Setoran manual tidak boleh dipaksa menggunakan metode cash.
- BR-002: Cash tetap boleh dipilih jika cash adalah metode aktif yang tersedia di sistem.
- BR-003: Metode setoran harus dipilih dari daftar metode yang tersedia di sistem.
- BR-004: Metode setoran nonaktif tidak boleh ditampilkan sebagai opsi pada pembuatan setoran manual baru.
- BR-005: Metode setoran nonaktif tidak boleh dipilih atau dikirim saat submit setoran manual baru.
- BR-006: Bukti setoran wajib untuk setiap setoran manual baru.
- BR-007: Setoran manual tidak bisa disubmit tanpa metode setoran.
- BR-008: Setoran manual tidak bisa disubmit tanpa bukti setoran.
- BR-009: Bukti setoran harus tersimpan sebelum atau bersamaan dengan penyimpanan record setoran manual.
- BR-010: Data setoran lama tanpa bukti harus tetap bisa dibuka tanpa error.
- BR-011: Data setoran lama tanpa metode dinamis harus tetap bisa dibuka tanpa error.
- BR-012: Perubahan ini tidak boleh mengubah data historis secara otomatis.
- BR-013: Snapshot nama metode setoran harus digunakan untuk menampilkan riwayat jika nama metode berubah di kemudian hari.
- BR-014: Jika metode setoran dinonaktifkan setelah setoran dibuat, riwayat setoran lama tetap harus menampilkan metode tersebut berdasarkan snapshot.
- BR-015: Admin/owner hanya boleh melihat bukti setoran sesuai permission data cabang/outlet yang berlaku di sistem.
- BR-016: Validasi frontend tidak menggantikan validasi backend.

## 8. Edge Cases

### Tidak Ada Metode Setoran Aktif

- Kondisi: Sistem tidak menemukan metode setoran aktif.
- Ekspektasi: Dropdown disabled dan menampilkan empty state.
- Pesan yang disarankan: "Tidak ada metode setoran aktif. Aktifkan atau tambahkan metode setoran terlebih dahulu."
- Submit harus ditolak.

### Admin Belum Memilih Metode Setoran

- Kondisi: Admin mengisi nominal dan bukti, tetapi tidak memilih metode setoran.
- Ekspektasi: Submit ditolak.
- Pesan yang disarankan: "Pilih metode setoran terlebih dahulu."

### Admin Belum Upload Bukti

- Kondisi: Admin memilih metode dan mengisi nominal, tetapi belum upload bukti.
- Ekspektasi: Submit ditolak.
- Pesan yang disarankan: "Upload bukti setoran terlebih dahulu."

### Upload Bukti Gagal

- Kondisi: Upload gagal karena jaringan, storage error, permission, atau timeout.
- Ekspektasi: Sistem menampilkan error dan tidak menganggap bukti sudah tersedia.
- Submit harus tetap ditolak sampai upload berhasil.

### File Bukti Terlalu Besar

- Kondisi: File melebihi batas ukuran upload existing.
- Ekspektasi: Sistem menolak file sebelum submit.
- Pesan yang disarankan: "Ukuran file terlalu besar. Gunakan file dengan ukuran sesuai batas yang diizinkan."

### Format File Tidak Didukung

- Kondisi: Admin memilih file dengan format yang tidak didukung.
- Ekspektasi: Sistem menolak file.
- Pesan yang disarankan: "Format file tidak didukung."

### Metode Setoran Dinonaktifkan Setelah Form Dibuka

- Kondisi: Admin membuka form saat metode masih aktif, lalu metode dinonaktifkan sebelum submit.
- Ekspektasi: Validasi backend menolak submit.
- Pesan yang disarankan: "Metode setoran sudah tidak aktif. Pilih metode lain."

### Metode Setoran Dinonaktifkan Setelah Setoran Dibuat

- Kondisi: Setoran sudah berhasil dibuat, lalu metode dinonaktifkan.
- Ekspektasi: Riwayat/detail tetap menampilkan metode berdasarkan snapshot nama metode.
- Data historis tidak berubah.

### Data Setoran Lama Tidak Memiliki Bukti Setoran

- Kondisi: Record lama tidak memiliki field bukti setoran.
- Ekspektasi: Riwayat/detail tetap bisa dibuka.
- Sistem menampilkan fallback "Bukti belum tersedia".

### Data Setoran Lama Tidak Memiliki Metode Setoran Dinamis

- Kondisi: Record lama hanya memiliki data cash lama atau tidak memiliki `deposit_method_id`.
- Ekspektasi: Riwayat/detail tetap bisa dibuka.
- Sistem menampilkan metode dari field lama jika tersedia, atau fallback "Metode lama/tidak tersedia".

### Bukti Berupa Gambar Rusak atau Tidak Bisa Diakses

- Kondisi: URL file ada, tetapi file tidak bisa dimuat.
- Ekspektasi: Sistem menampilkan fallback error dan tetap menampilkan data setoran lain.
- Pesan yang disarankan: "Bukti setoran tidak dapat dimuat."

## 9. UI/UX Requirements

- UI-001: Judul form sebaiknya diubah dari "Input Manual Setoran Tunai" menjadi "Input Manual Setoran" agar tidak mengunci persepsi ke cash.
- UI-002: Label field "Metode Cash" harus diubah menjadi "Metode Setoran".
- UI-003: Field metode setoran harus berupa dropdown/select.
- UI-004: Dropdown menggunakan placeholder "Pilih metode setoran".
- UI-005: Dropdown hanya menampilkan metode setoran aktif.
- UI-006: Dropdown harus memiliki loading state saat data metode sedang dimuat.
- UI-007: Dropdown harus memiliki empty state jika tidak ada metode setoran aktif.
- UI-008: Field upload bukti setoran harus jelas terlihat pada form setoran manual.
- UI-009: Label field upload harus menjelaskan bahwa bukti setoran wajib, misalnya "Bukti Setoran *".
- UI-010: Sistem harus menampilkan nama file setelah file dipilih atau berhasil diupload.
- UI-011: Sistem harus menampilkan loading/progress state selama upload bukti.
- UI-012: Jika file bukti berupa gambar, sistem harus menampilkan preview thumbnail atau tombol "Lihat Bukti".
- UI-013: Jika file bukti bukan gambar, sistem harus menampilkan nama file dan tombol "Buka File" atau "Lihat Bukti".
- UI-014: Submit button harus disabled atau menolak aksi saat upload masih berlangsung.
- UI-015: Error metode wajib dipilih harus muncul dekat field metode setoran atau dalam form alert yang jelas.
- UI-016: Error bukti wajib diupload harus muncul dekat field upload bukti atau dalam form alert yang jelas.
- UI-017: Riwayat setoran manual harus menampilkan kolom/label metode setoran.
- UI-018: Detail setoran manual harus menampilkan metode setoran.
- UI-019: Riwayat atau detail setoran manual harus menyediakan akses ke bukti setoran.
- UI-020: Untuk data lama tanpa bukti, tampilkan teks fallback "Bukti belum tersedia", bukan tombol rusak.
- UI-021: Untuk metode yang sudah nonaktif setelah setoran dibuat, tampilkan nama metode dari snapshot tanpa memaksa status aktif.
- UI-022: UI harus mengikuti pattern, komponen, spacing, dan gaya visual existing.

## 10. Data Requirements

Gunakan tabel/collection metode pembayaran atau metode setoran existing jika sudah tersedia. Jangan membuat tabel metode baru yang duplikat jika data metode sudah ada.

Asumsi:

- Jika sistem memiliki tabel `payment_methods`, gunakan tabel tersebut selama dapat membedakan metode aktif dan relevan untuk setoran.
- Jika sistem memiliki tabel khusus seperti `deposit_methods`, gunakan tabel tersebut.
- Jika sistem memiliki field tipe metode seperti `type`, `category`, atau `usage`, filter metode yang valid untuk setoran jika field tersebut tersedia.

### Data Metode Setoran

Field yang dibutuhkan dari data metode existing:

- `id`
- `name`
- `is_active`
- `type` atau `category` jika ada
- `sort_order` jika ada
- `created_at`
- `updated_at`

Aturan pengambilan data:

- Ambil hanya metode dengan status aktif.
- Jika ada kategori/usage khusus setoran, ambil hanya metode yang dapat digunakan untuk setoran.
- Jika tidak ada kategori khusus, gunakan metode pembayaran aktif existing sebagai sumber dropdown.
- Urutan dropdown mengikuti `sort_order` jika ada, atau nama metode jika tidak ada.

### Data Record Setoran

Contoh field yang disarankan pada record setoran:

- `id`
- `outlet_id` / `branch_id`
- `staff_id`
- `amount`
- `deposit_method_id`
- `deposit_method_name_snapshot`
- `proof_file_url`
- `proof_file_name`
- `proof_file_type`
- `proof_file_size`
- `proof_uploaded_at`
- `notes`
- `status`
- `created_by`
- `created_at`
- `updated_at`

Catatan implementasi data:

- `deposit_method_id` boleh nullable untuk menjaga backward compatibility data lama.
- `deposit_method_name_snapshot` boleh nullable untuk data lama, tetapi wajib diisi untuk setoran manual baru.
- `proof_file_url` boleh nullable untuk data lama, tetapi wajib diisi untuk setoran manual baru.
- Validasi wajib bukti dan metode diterapkan pada pembuatan setoran manual baru, bukan dengan memaksa migrasi data lama.
- Simpan snapshot nama metode setoran saat submit, bukan hanya join ke tabel metode, agar riwayat tetap jelas jika nama metode berubah.
- Jangan mengubah data historis secara otomatis untuk mengisi metode atau bukti.

### Data File Bukti

Metadata file yang disarankan:

- URL/path file.
- Nama file asli atau nama file hasil upload.
- MIME type.
- Ukuran file jika tersedia.
- Waktu upload.
- User yang mengupload jika mekanisme existing mendukung.

Storage:

- Gunakan bucket/folder/path existing untuk file bukti transaksi/setoran jika sudah ada.
- Jika perlu path baru, gunakan struktur yang mudah diaudit, misalnya `deposit-proofs/{branch_id}/{deposit_id_or_temp_id}/{filename}`.
- Pastikan akses file mengikuti permission existing.

## 11. Permission & Access Control

### Membuat Setoran Manual

- Hanya owner/admin atau role existing yang sudah diizinkan membuat setoran manual.
- Revisi ini tidak menambahkan role baru secara otomatis.

### Memilih Metode Setoran

- Role yang boleh membuat setoran manual boleh memilih metode setoran.
- Opsi metode tetap dibatasi hanya metode aktif yang tersedia di sistem.

### Upload Bukti Setoran

- Role yang boleh membuat setoran manual boleh upload bukti setoran.
- Upload harus mengikuti permission storage/file upload existing.

### Melihat Bukti Setoran

- Owner/admin boleh melihat bukti setoran sesuai cakupan akses cabang/outlet existing.
- Staff hanya boleh melihat bukti jika permission existing memperbolehkan.
- Akses file bukti tidak boleh terbuka untuk user yang tidak memiliki hak melihat record setoran terkait.

### Mengubah atau Menghapus Setoran

- Jika sistem existing mendukung edit setoran:
  - Hanya role yang sudah diizinkan boleh mengubah setoran.
  - Perubahan metode atau bukti harus tercatat sesuai pattern audit existing jika tersedia.
  - Setoran yang sudah dikonfirmasi sebaiknya tidak dapat diubah kecuali sistem existing memang mengizinkan.
- Jika sistem existing mendukung hapus setoran:
  - Hanya role yang sudah diizinkan boleh menghapus setoran.
  - File bukti terkait harus mengikuti kebijakan cleanup existing.
- Jika sistem belum mendukung edit/hapus setoran, revisi ini tidak perlu menambahkan kemampuan tersebut.

## 12. Acceptance Criteria

- [ ] Admin bisa memilih metode setoran selain cash.
- [ ] Dropdown metode setoran menampilkan metode aktif yang tersedia.
- [ ] Sistem tidak memaksa metode cash sebagai default.
- [ ] Sistem menolak submit jika metode setoran belum dipilih.
- [ ] Sistem menolak submit jika bukti setoran belum diupload.
- [ ] Bukti setoran tersimpan pada data setoran.
- [ ] Riwayat/detail setoran menampilkan metode setoran.
- [ ] Riwayat/detail setoran menampilkan atau menyediakan akses ke bukti setoran.
- [ ] Data setoran lama tetap bisa dibuka walaupun belum punya bukti.
- [ ] Flow setoran lain yang bukan setoran manual tidak rusak.
- [ ] Field "Metode Cash" berubah menjadi "Metode Setoran".
- [ ] Judul form tidak lagi menyebut setoran manual sebagai setoran tunai saja.
- [ ] Cash tetap bisa dipilih jika cash aktif di daftar metode.
- [ ] Metode nonaktif tidak muncul di dropdown pembuatan setoran manual.
- [ ] Backend menolak metode yang sudah nonaktif saat submit.
- [ ] Upload bukti menampilkan loading state.
- [ ] Upload bukti gagal menampilkan error yang jelas.
- [ ] Data file bukti menyimpan URL/path dan metadata minimal.
- [ ] Snapshot nama metode setoran tersimpan pada record setoran baru.
- [ ] Riwayat tetap menampilkan nama metode lama meskipun metode sudah berganti nama atau nonaktif.

## 13. Testing Scenario

- Test Case: Setoran manual dengan transfer bank
  - Step:
    1. Pastikan metode "Transfer Bank" aktif di data metode setoran.
    2. Buka form setoran manual.
    3. Pilih cabang/outlet dan staff.
    4. Pilih metode "Transfer Bank".
    5. Isi jumlah setoran.
    6. Upload bukti transfer.
    7. Submit setoran.
    8. Buka riwayat/detail setoran.
  - Expected Result:
    1. Setoran berhasil dibuat.
    2. Record setoran menyimpan `deposit_method_id`.
    3. Record setoran menyimpan snapshot nama "Transfer Bank".
    4. Bukti setoran tersimpan.
    5. Riwayat/detail menampilkan metode "Transfer Bank" dan akses bukti setoran.

- Test Case: Setoran manual dengan cash
  - Step:
    1. Pastikan metode "Cash" aktif di data metode setoran.
    2. Buka form setoran manual.
    3. Pilih metode "Cash".
    4. Isi jumlah setoran.
    5. Upload bukti setoran tunai, misalnya foto nota atau bukti penerimaan.
    6. Submit setoran.
  - Expected Result:
    1. Setoran cash tetap bisa dibuat.
    2. Cash dipilih oleh admin, bukan dipaksa otomatis oleh sistem.
    3. Bukti setoran tetap wajib dan tersimpan.

- Test Case: Submit tanpa memilih metode
  - Step:
    1. Buka form setoran manual.
    2. Isi cabang/outlet, staff, dan jumlah setoran.
    3. Upload bukti setoran.
    4. Jangan pilih metode setoran.
    5. Klik submit.
  - Expected Result:
    1. Submit ditolak.
    2. Sistem menampilkan error "Pilih metode setoran terlebih dahulu."
    3. Tidak ada record setoran baru yang dibuat.

- Test Case: Submit tanpa upload bukti
  - Step:
    1. Buka form setoran manual.
    2. Pilih cabang/outlet dan staff.
    3. Pilih metode setoran.
    4. Isi jumlah setoran.
    5. Jangan upload bukti.
    6. Klik submit.
  - Expected Result:
    1. Submit ditolak.
    2. Sistem menampilkan error "Upload bukti setoran terlebih dahulu."
    3. Tidak ada record setoran baru yang dibuat.

- Test Case: Upload bukti gagal
  - Step:
    1. Buka form setoran manual.
    2. Pilih metode setoran.
    3. Pilih file bukti.
    4. Simulasikan kegagalan upload, misalnya jaringan mati atau storage error.
    5. Klik submit.
  - Expected Result:
    1. Sistem menampilkan error upload.
    2. File tidak dianggap berhasil diupload.
    3. Submit ditolak sampai upload berhasil.

- Test Case: File bukti terlalu besar
  - Step:
    1. Buka form setoran manual.
    2. Pilih file dengan ukuran di atas batas upload existing.
  - Expected Result:
    1. Sistem menolak file.
    2. Sistem menampilkan error ukuran file.
    3. Admin harus memilih file lain yang valid.

- Test Case: Format file tidak didukung
  - Step:
    1. Buka form setoran manual.
    2. Pilih file dengan format yang tidak didukung.
  - Expected Result:
    1. Sistem menolak file.
    2. Sistem menampilkan error format file.
    3. File tidak disimpan sebagai bukti setoran.

- Test Case: Metode setoran nonaktif tidak muncul
  - Step:
    1. Nonaktifkan salah satu metode setoran.
    2. Buka form setoran manual.
    3. Buka dropdown metode setoran.
  - Expected Result:
    1. Metode yang nonaktif tidak muncul di dropdown.
    2. Admin tidak bisa memilih metode tersebut untuk setoran baru.

- Test Case: Metode setoran dinonaktifkan setelah form dibuka
  - Step:
    1. Buka form setoran manual.
    2. Pilih metode setoran yang masih aktif.
    3. Dari sesi lain, nonaktifkan metode tersebut.
    4. Isi jumlah dan upload bukti.
    5. Submit setoran.
  - Expected Result:
    1. Backend menolak submit.
    2. Sistem menampilkan error bahwa metode sudah tidak aktif.
    3. Admin diminta memilih metode lain.

- Test Case: Membuka data setoran lama tanpa bukti
  - Step:
    1. Buka riwayat setoran lama yang dibuat sebelum revisi.
    2. Buka detail setoran tersebut.
  - Expected Result:
    1. Detail setoran terbuka tanpa error.
    2. Sistem menampilkan fallback "Bukti belum tersedia".
    3. Data lain seperti nominal, cabang, staff, status, dan tanggal tetap tampil.

- Test Case: Membuka data setoran lama tanpa metode dinamis
  - Step:
    1. Buka riwayat setoran lama yang belum memiliki `deposit_method_id`.
    2. Buka detail setoran tersebut.
  - Expected Result:
    1. Detail setoran terbuka tanpa error.
    2. Sistem menampilkan metode dari field lama jika tersedia.
    3. Jika tidak tersedia, sistem menampilkan fallback "Metode lama/tidak tersedia".

- Test Case: Flow setoran otomatis tidak berubah
  - Step:
    1. Jalankan flow setoran otomatis atau setoran kasir existing.
    2. Submit setoran sesuai flow lama.
    3. Konfirmasi atau proses setoran sesuai aturan existing.
  - Expected Result:
    1. Flow tetap berjalan seperti sebelumnya.
    2. Tidak ada validasi baru yang salah diterapkan ke flow selain setoran manual.
    3. Tidak ada error akibat field bukti wajib pada flow yang bukan setoran manual.

## 14. Implementation Notes

- Gunakan data metode setoran existing jika sudah ada.
- Jangan membuat data metode baru yang duplikat jika tabel metode pembayaran/setoran existing sudah dapat digunakan.
- Jangan hardcode metode cash.
- Jangan memfilter dropdown hanya untuk tipe cash.
- Jangan membuat ulang modul setoran dari nol.
- Revisi form setoran manual existing agar field metode menjadi dropdown metode setoran aktif.
- Tambahkan validasi frontend untuk metode setoran wajib dipilih.
- Tambahkan validasi backend untuk metode setoran wajib dipilih.
- Tambahkan validasi backend bahwa metode setoran masih aktif saat submit.
- Tambahkan validasi frontend untuk bukti setoran wajib diupload.
- Tambahkan validasi backend untuk bukti setoran wajib tersedia pada setoran manual baru.
- Simpan snapshot nama metode setoran agar riwayat tetap terbaca meskipun nama metode berubah.
- Simpan bukti setoran di storage/file upload mechanism existing.
- Simpan metadata file bukti sesuai kemampuan existing.
- Pastikan data lama tetap backward compatible dengan membuat field baru nullable untuk data historis.
- Validasi wajib metode dan bukti harus berlaku untuk setoran manual baru, bukan untuk membuka/membaca data lama.
- Gunakan pattern, component, API, dan database schema existing.
- Gunakan naming yang konsisten dengan kode existing, misalnya `branch_id` atau `outlet_id` sesuai schema aktual.
- Jika ada service khusus setoran, letakkan logic submit dan mapping data di service tersebut, bukan langsung tersebar di UI.
- Jika ada komponen upload existing, gunakan komponen tersebut agar behavior ukuran file, tipe file, dan storage tetap konsisten.
- Pastikan tombol submit disabled saat upload atau submit sedang berjalan untuk mencegah duplikasi.
- Pastikan error dari backend ditampilkan secara jelas di UI.
- Pastikan query riwayat/detail mengambil field metode dan bukti baru.
- Jika riwayat menggunakan join ke tabel metode, tetap gunakan snapshot sebagai fallback utama untuk data historis.
- Jika file bukti bersifat privat, gunakan signed URL atau mekanisme akses existing.
- Tambahkan migration database secara minimal untuk field baru yang dibutuhkan.
- Tambahkan test manual/regression untuk flow setoran otomatis dan setoran kasir.

## 15. Risiko / Asumsi

### Asumsi

- Sistem sudah memiliki data metode pembayaran atau metode setoran yang bisa digunakan sebagai sumber dropdown.
- Sistem sudah memiliki status aktif/nonaktif pada metode pembayaran/setoran.
- Sistem sudah memiliki mekanisme upload file atau storage.
- Owner/admin adalah role utama yang membuat setoran manual.
- Data setoran manual saat ini sudah tersimpan di tabel/collection yang dapat ditambahkan field baru.
- Flow setoran otomatis dan setoran kasir dapat dibedakan dari setoran manual melalui field, status, tipe, endpoint, atau konteks UI.
- Batas ukuran dan format file mengikuti aturan upload existing sistem.

### Risiko

- Jika data metode pembayaran existing tidak membedakan metode untuk pembayaran pelanggan dan metode untuk setoran, dropdown bisa menampilkan opsi yang kurang relevan untuk setoran.
- Jika storage/file upload existing belum memiliki permission yang jelas, bukti setoran bisa tidak bisa diakses oleh owner/admin atau justru terlalu terbuka.
- Jika validasi bukti setoran diterapkan terlalu global, flow setoran otomatis atau setoran kasir dapat ikut terganggu.
- Jika field baru dibuat non-null tanpa migrasi yang tepat, data setoran lama dapat gagal dibuka.
- Jika hanya frontend yang divalidasi, request langsung ke backend masih bisa membuat setoran tanpa metode atau bukti.
- Jika snapshot nama metode tidak disimpan, riwayat setoran bisa berubah makna saat nama metode diubah atau metode dihapus/nonaktif.
- Jika upload file dilakukan sebelum record setoran dibuat, perlu strategi cleanup untuk file yang sudah terupload tetapi submit gagal.
- Jika file bukti besar dan koneksi lambat, admin bisa menekan submit berulang atau meninggalkan form saat upload belum selesai.
- Jika preview gambar tidak menangani URL rusak atau permission error, detail setoran bisa terlihat rusak meskipun data setoran valid.

### Mitigasi

- Terapkan validasi di frontend dan backend.
- Buat field baru nullable untuk menjaga data lama.
- Gunakan snapshot nama metode pada record setoran.
- Gunakan storage dan permission pattern existing.
- Batasi perubahan hanya pada flow setoran manual.
- Tambahkan regression test untuk setoran otomatis dan setoran kasir.
- Tampilkan loading state dan disable submit saat upload/submit berjalan.
- Tampilkan fallback yang jelas untuk data lama atau file bukti yang tidak tersedia.
