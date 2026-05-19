# PRD: Fitur Tutup Kas Manual dan Edit Posisi Kas di UI Admin

Tanggal: 2026-05-17  
Produk: Roti Bakar Ngeunah POS  
Area: Admin - Kas, Shift, Audit Log  
Status: Draft PRD  
Prioritas: Tinggi

## 1. Background / Masalah

Saat ini sistem kas sudah memiliki flow utama untuk staff/kasir, yaitu buka kas, transaksi berjalan, tutup kas, dan setoran. Flow tersebut sudah cukup untuk operasional normal ketika semua proses dilakukan tepat waktu dan nominal yang diinput benar.

Dalam operasional harian, ada kondisi yang tidak selalu ideal:

- Staff lupa menutup kas setelah shift selesai.
- Nominal tutup kas salah input.
- Ada selisih kas yang perlu dikoreksi.
- Owner/admin perlu mencatat posisi kas aktual saat ini.
- Owner/admin perlu menutup kas secara manual dari dashboard admin.

Karena admin belum memiliki kontrol yang cukup fleksibel di UI admin, koreksi sering harus dilakukan langsung melalui database atau cara manual di luar sistem. Dampaknya:

- Risiko salah update data lebih tinggi.
- Histori perubahan kas tidak terdokumentasi dengan baik.
- Owner/admin sulit melacak siapa yang mengubah kas, kapan, dan alasannya.
- Rekonsiliasi kas dan setoran menjadi kurang rapi.
- Data operasional menjadi kurang dapat diaudit.

Fitur ini dibutuhkan agar owner/admin bisa melakukan tindakan koreksi secara resmi dari UI admin tanpa menghapus transaksi lama dan tanpa merusak histori penjualan.

Asumsi:

- Sistem sudah memiliki konsep cash session atau cashier session.
- Sistem sudah memiliki data outlet/cabang, staff, role user, dan transaksi kas.
- Sistem sudah memiliki atau dapat ditambahkan mekanisme audit log untuk perubahan kas.
- Revisi ini menambah kontrol admin tanpa mengganti flow kasir/staff yang sudah berjalan.

## 2. Tujuan

Tujuan utama fitur ini adalah memberi owner/admin kemampuan mengelola kas secara manual dari UI admin dengan tetap aman, transparan, dan dapat diaudit.

Tujuan detail:

1. Admin dapat melihat daftar kas aktif atau kas yang masih terbuka.
2. Admin dapat membuka detail kas berdasarkan outlet, staff, dan shift.
3. Admin dapat menutup kas manual dari UI admin jika kas masih terbuka.
4. Admin dapat menginput posisi kas aktual saat ini.
5. Admin dapat melakukan koreksi nominal kas jika terjadi kesalahan input atau selisih.
6. Setiap perubahan manual wajib memiliki alasan.
7. Setiap perubahan manual wajib menyimpan admin pelaku, waktu perubahan, nominal sebelum, nominal sesudah, dan alasan.
8. Riwayat perubahan kas dapat dilihat dari UI admin.
9. Koreksi kas dicatat sebagai adjustment, bukan overwrite diam-diam.
10. Data transaksi penjualan historis tidak berubah akibat koreksi kas manual.

## 3. Scope

### In Scope

- Menambahkan halaman atau section admin untuk daftar kas aktif/terbuka.
- Menambahkan detail kas per outlet, staff, dan shift.
- Menampilkan status kas, nominal sistem, posisi kas aktual terbaru, setoran terkait, dan riwayat perubahan.
- Menambahkan tombol "Tutup Kas Manual" pada kas yang masih terbuka.
- Menambahkan form input posisi kas aktual.
- Menambahkan form edit/koreksi nominal kas.
- Mewajibkan alasan perubahan untuk tutup kas manual dan koreksi kas.
- Menyimpan audit log untuk setiap aksi manual admin.
- Menyimpan nominal sebelum dan sesudah perubahan.
- Menyimpan admin yang melakukan aksi dan waktu aksi.
- Memberi label jelas untuk kas yang ditutup atau disesuaikan manual oleh admin.
- Menjaga data transaksi lama dan histori penjualan tetap tidak berubah.
- Menangani data lama yang belum memiliki audit log.
- Menambahkan permission dan validasi role owner/admin di frontend dan backend.

### Out of Scope

- Membuat ulang sistem kas dari nol.
- Mengubah flow buka kas dan tutup kas staff/kasir yang sudah ada.
- Menghapus transaksi penjualan lama.
- Mengubah nominal transaksi historis.
- Membuat sistem rekonsiliasi bank otomatis.
- Membuat approval bertingkat untuk adjustment kas.
- Membuat fitur reversal adjustment jika belum didukung oleh sistem.
- Mengubah flow setoran kasir kecuali diperlukan untuk menjaga konsistensi posisi kas.
- Melakukan migrasi data historis yang mengubah makna transaksi lama.

## 4. User Role

### Owner/Admin

Owner/admin adalah pengguna utama fitur ini.

Hak dan kebutuhan:

- Melihat daftar kas aktif dan detail kas.
- Menutup kas manual dari UI admin.
- Menginput posisi kas aktual.
- Mengedit atau mengoreksi nominal kas.
- Mengisi alasan perubahan.
- Melihat riwayat perubahan kas dan audit log.
- Membedakan kas normal dengan kas yang sudah mendapat penyesuaian manual.

### Staff/Kasir

Staff/kasir tetap menggunakan flow existing untuk buka kas, tutup kas, transaksi, dan setoran.

Batasan:

- Staff tidak boleh menutup kas manual dari UI admin.
- Staff tidak boleh mengedit posisi kas dari UI admin.
- Staff boleh tetap melihat atau menggunakan fitur kas sesuai permission existing, jika sudah tersedia.
- Aksi admin tidak boleh merusak flow kasir/staff yang sudah berjalan.

## 5. User Flow

### 5.1 Admin Melihat Daftar Kas Aktif

1. Admin membuka halaman admin.
2. Admin masuk ke menu atau tab kas.
3. Sistem menampilkan daftar kas aktif/terbuka.
4. Admin dapat memfilter berdasarkan outlet, staff, tanggal, dan status.
5. Admin melihat ringkasan nominal kas sistem, status shift, dan indikator penyesuaian manual.

### 5.2 Admin Membuka Detail Kas

1. Admin memilih salah satu kas dari daftar.
2. Sistem membuka detail kas.
3. Sistem menampilkan informasi outlet, staff, waktu buka, status, kas awal, kas masuk, kas keluar, setoran, posisi kas sistem, posisi kas aktual terbaru, dan riwayat audit.
4. Jika kas masih terbuka, sistem menampilkan tombol "Tutup Kas Manual".
5. Sistem menampilkan tombol "Edit Posisi Kas" sesuai permission admin.

### 5.3 Admin Menutup Kas Manual

1. Admin membuka detail kas yang masih terbuka.
2. Admin klik tombol "Tutup Kas Manual".
3. Sistem membuka modal/form tutup kas manual.
4. Admin menginput posisi kas aktual atau nominal penutupan.
5. Admin mengisi alasan penutupan manual.
6. Sistem menampilkan confirmation modal berisi ringkasan perubahan.
7. Admin mengonfirmasi.
8. Sistem menutup kas, memberi label "Ditutup Manual Admin", dan menyimpan audit log.

### 5.4 Admin Menginput Posisi Kas Aktual

1. Admin membuka detail kas.
2. Admin klik tombol "Edit Posisi Kas" atau "Input Posisi Kas Aktual".
3. Sistem menampilkan nominal kas sistem saat ini sebagai pembanding.
4. Admin mengisi nominal kas aktual.
5. Admin mengisi alasan perubahan.
6. Sistem menghitung selisih adjustment dari nominal sebelumnya.
7. Admin mengonfirmasi perubahan.
8. Sistem menyimpan posisi kas aktual terbaru dan audit log.

### 5.5 Admin Mengedit/Koreksi Posisi Kas

1. Admin membuka detail kas yang perlu dikoreksi.
2. Admin klik tombol "Edit Posisi Kas".
3. Sistem menampilkan nominal saat ini, nominal sebelumnya, dan riwayat adjustment.
4. Admin menginput nominal baru.
5. Admin mengisi alasan koreksi.
6. Sistem membuat record adjustment baru.
7. Sistem tidak mengubah transaksi penjualan historis.
8. Detail kas menampilkan badge "Ada Penyesuaian Manual".

### 5.6 Admin Melihat Riwayat Perubahan Kas

1. Admin membuka detail kas.
2. Sistem menampilkan section riwayat perubahan.
3. Admin dapat melihat action type, nominal sebelum, nominal sesudah, selisih, alasan, admin pelaku, dan waktu perubahan.
4. Data lama yang belum memiliki audit log tetap bisa dibuka dengan empty state yang jelas.

## 6. Functional Requirements

- FR-001: Sistem harus menyediakan halaman atau section daftar kas aktif/terbuka di UI admin.
- FR-002: Sistem harus menampilkan filter daftar kas berdasarkan outlet, staff, tanggal, dan status kas.
- FR-003: Sistem harus menampilkan detail kas per outlet, staff, dan shift.
- FR-004: Detail kas harus menampilkan informasi minimal: outlet, staff, waktu buka, waktu tutup, status, kas awal, kas masuk, kas keluar, setoran, nominal sistem, posisi kas aktual terbaru, dan status manual adjustment.
- FR-005: Sistem harus menampilkan tombol "Tutup Kas Manual" hanya jika kas masih terbuka dan user memiliki role owner/admin.
- FR-006: Sistem harus menyembunyikan atau menonaktifkan tombol "Tutup Kas Manual" jika kas sudah ditutup.
- FR-007: Sistem harus menyediakan form tutup kas manual dari UI admin.
- FR-008: Form tutup kas manual harus memiliki input nominal posisi kas aktual atau nominal penutupan.
- FR-009: Form tutup kas manual harus memiliki field alasan perubahan yang wajib diisi.
- FR-010: Sistem harus menyimpan aksi tutup kas manual sebagai audit log.
- FR-011: Sistem harus memberi label jelas pada kas yang ditutup manual, misalnya "Ditutup Manual Admin".
- FR-012: Sistem harus menyediakan form input posisi kas aktual.
- FR-013: Sistem harus menampilkan nominal kas sistem sebagai pembanding saat admin menginput posisi kas aktual.
- FR-014: Sistem harus menyediakan form edit/koreksi nominal kas.
- FR-015: Sistem harus menyimpan koreksi nominal kas sebagai adjustment baru, bukan overwrite tanpa histori.
- FR-016: Sistem harus menghitung adjustment_amount berdasarkan new_cash_amount dikurangi previous_cash_amount.
- FR-017: Sistem harus mewajibkan alasan untuk semua aksi manual admin yang mengubah status atau nominal kas.
- FR-018: Sistem harus menyimpan admin yang melakukan perubahan.
- FR-019: Sistem harus menyimpan waktu perubahan.
- FR-020: Sistem harus menyimpan nominal sebelum perubahan.
- FR-021: Sistem harus menyimpan nominal sesudah perubahan.
- FR-022: Sistem harus menyimpan alasan perubahan.
- FR-023: Sistem harus menampilkan riwayat perubahan kas pada detail kas.
- FR-024: Riwayat perubahan kas harus menampilkan label action type, misalnya "Penyesuaian Manual Admin" atau "Tutup Kas Manual Admin".
- FR-025: Sistem harus memvalidasi role owner/admin di frontend.
- FR-026: Sistem harus memvalidasi role owner/admin di backend atau database policy/RPC.
- FR-027: Sistem harus menolak aksi manual dari staff/kasir.
- FR-028: Sistem harus menjaga backward compatibility untuk data kas lama yang belum memiliki field manual adjustment atau audit log.
- FR-029: Sistem harus tetap bisa membuka detail kas lama tanpa error.
- FR-030: Sistem tidak boleh menghapus transaksi lama saat adjustment dibuat.
- FR-031: Sistem tidak boleh mengubah data penjualan historis saat adjustment dibuat.
- FR-032: Sistem harus membedakan kas normal dan kas yang pernah disesuaikan manual.
- FR-033: Sistem harus menyediakan empty state jika kas belum memiliki audit log.
- FR-034: Sistem harus menyediakan loading state saat mengambil data daftar/detail kas.
- FR-035: Sistem harus menyediakan error state jika data gagal dimuat atau aksi gagal disimpan.
- FR-036: Sistem harus menggunakan database transaction atau RPC atomik jika aksi mengubah lebih dari satu tabel.
- FR-037: Sistem harus melakukan validasi konflik edit bersamaan menggunakan updated_at, version, atau mekanisme optimistic locking lain.

## 7. Business Rules

- BR-001: Hanya owner/admin yang boleh menutup kas manual dari UI admin.
- BR-002: Hanya owner/admin yang boleh mengedit atau mengoreksi posisi kas dari UI admin.
- BR-003: Staff/kasir tidak boleh mengedit kas dari UI admin.
- BR-004: Tutup kas manual hanya bisa dilakukan pada kas yang masih terbuka.
- BR-005: Jika kas sudah ditutup, admin tidak boleh menutup ulang kas tersebut.
- BR-006: Edit kas tidak boleh menghapus transaksi penjualan.
- BR-007: Edit kas tidak boleh mengubah histori transaksi lama.
- BR-008: Koreksi kas harus disimpan sebagai adjustment.
- BR-009: Koreksi kas tidak boleh dilakukan sebagai overwrite diam-diam tanpa audit log.
- BR-010: Alasan perubahan wajib diisi untuk tutup kas manual dan edit posisi kas.
- BR-011: Alasan perubahan tidak boleh hanya spasi kosong.
- BR-012: Setiap perubahan harus menyimpan admin yang melakukan, waktu, nominal sebelum, nominal sesudah, dan alasan.
- BR-013: Posisi kas aktual harus menjadi nilai kas terbaru setelah adjustment berhasil disimpan.
- BR-014: Sistem harus tetap bisa membedakan kas normal dan kas yang ditutup manual.
- BR-015: Sistem harus tetap bisa membedakan kas normal dan kas yang diedit manual.
- BR-016: Nominal kas aktual tidak boleh bernilai negatif, kecuali bisnis secara eksplisit mengizinkan saldo kas negatif.
- BR-017: Jika nominal yang diinput jauh berbeda dari nominal sistem, sistem harus menampilkan peringatan sebelum admin menyimpan.
- BR-018: Jika sudah ada setoran terkait, sistem tetap boleh mencatat adjustment, tetapi harus menampilkan konteks setoran agar admin memahami dampaknya.
- BR-019: Aksi manual admin harus tercatat dengan action type yang jelas.
- BR-020: Data lama tanpa audit log tidak boleh dianggap rusak.

## 8. Edge Cases

- Staff lupa tutup kas: admin dapat menutup kas manual dengan alasan wajib dan label "Ditutup Manual Admin".
- Kas sudah ditutup: tombol tutup kas manual tidak ditampilkan atau disabled, dan backend tetap menolak request tutup ulang.
- Kas tidak ditemukan: sistem menampilkan error state dan tidak menyimpan perubahan.
- Nominal kas negatif: sistem menolak input, kecuali ada aturan bisnis eksplisit yang memperbolehkan.
- Admin input nominal yang tidak masuk akal: sistem menampilkan warning, misalnya jika selisih melebihi threshold tertentu dari nominal sistem.
- Ada setoran yang sudah dibuat: sistem menampilkan daftar/setoran terkait di detail kas sebelum admin melakukan adjustment.
- Ada transaksi baru masuk saat admin sedang edit: sistem harus mendeteksi perubahan updated_at/version dan meminta admin reload data sebelum menyimpan.
- Dua admin mengedit kas yang sama bersamaan: request kedua harus divalidasi ulang agar tidak menimpa adjustment pertama tanpa sadar.
- Data kas lama belum punya audit log: detail kas tetap terbuka dan menampilkan empty state riwayat perubahan.
- Tutup kas manual tanpa alasan: frontend dan backend menolak request.
- Koneksi gagal saat submit: sistem menampilkan error dan tidak mengubah UI menjadi sukses sebelum server mengonfirmasi.
- Admin kehilangan permission saat form sudah terbuka: backend tetap menolak aksi saat submit.
- Nominal input sama dengan nominal sebelumnya: sistem boleh menyimpan catatan posisi aktual jika action type adalah pencatatan audit, atau menolak jika tidak ada perubahan sesuai keputusan implementasi.

## 9. UI/UX Requirements

- UI-001: Admin harus memiliki halaman atau section daftar kas aktif.
- UI-002: Daftar kas aktif harus menampilkan filter outlet, staff, tanggal, dan status.
- UI-003: Daftar kas harus menampilkan informasi ringkas: outlet, staff, waktu buka, status, posisi kas sistem, posisi kas aktual, dan indikator manual adjustment.
- UI-004: Detail kas harus menampilkan ringkasan kas dan riwayat perubahan dalam satu halaman/detail view.
- UI-005: Detail kas harus memiliki tombol "Tutup Kas Manual" jika kas masih terbuka dan user adalah owner/admin.
- UI-006: Detail kas harus memiliki tombol "Edit Posisi Kas" untuk owner/admin.
- UI-007: Form input posisi kas aktual harus menampilkan nominal kas sistem sebagai pembanding.
- UI-008: Form edit posisi kas harus memiliki field nominal baru dan alasan perubahan.
- UI-009: Field alasan wajib diberi indikator required dan pesan validasi jika kosong.
- UI-010: Sebelum menyimpan, sistem harus menampilkan confirmation modal berisi ringkasan perubahan.
- UI-011: Confirmation modal harus menampilkan nominal sebelum, nominal sesudah, selisih, action type, dan alasan.
- UI-012: Kas yang ditutup manual harus menampilkan badge "Ditutup Manual Admin".
- UI-013: Kas yang memiliki adjustment manual harus menampilkan badge "Ada Penyesuaian Manual".
- UI-014: Riwayat perubahan kas harus mudah dibaca dan diurutkan dari yang terbaru.
- UI-015: Riwayat perubahan harus menampilkan admin pelaku dan waktu perubahan.
- UI-016: Sistem harus memiliki empty state untuk daftar kosong dan audit log kosong.
- UI-017: Sistem harus memiliki loading state saat mengambil data.
- UI-018: Sistem harus memiliki error state saat data gagal dimuat atau aksi gagal disimpan.
- UI-019: UI harus mengikuti pattern visual, komponen, dan bahasa yang sudah ada di aplikasi admin.
- UI-020: Aksi yang berisiko harus menggunakan konfirmasi eksplisit sebelum submit.

## 10. Data Requirements

### 10.1 Data Adjustment / Audit Log

Disarankan membuat tabel atau record audit log khusus untuk perubahan kas manual. Nama tabel dapat mengikuti pattern existing, misalnya `cash_session_adjustments`, `cash_adjustment_logs`, atau nama lain yang konsisten dengan schema.

Field yang disarankan:

- id
- cash_session_id
- outlet_id
- staff_id
- action_type
- previous_cash_amount
- new_cash_amount
- adjustment_amount
- reason
- created_by
- created_by_name
- created_at
- metadata

Keterangan:

- `action_type` dapat berisi nilai seperti `manual_close`, `manual_cash_adjustment`, atau `manual_actual_cash_input`.
- `previous_cash_amount` menyimpan nominal sebelum aksi.
- `new_cash_amount` menyimpan nominal setelah aksi.
- `adjustment_amount` adalah selisih nominal baru dan nominal sebelumnya.
- `reason` wajib diisi.
- `created_by` menyimpan user id admin/owner.
- `created_by_name` menyimpan snapshot nama admin agar audit tetap mudah dibaca.
- `metadata` opsional untuk menyimpan konteks tambahan seperti setoran terkait, device, atau sumber aksi.

### 10.2 Data Cash Session

Jika diperlukan, cash session dapat ditambah field nullable agar aman untuk data lama:

- closed_manually
- manual_closed_by
- manual_closed_at
- manual_close_reason
- current_cash_amount
- has_manual_adjustment
- updated_at

Keterangan:

- `closed_manually` menandai kas yang ditutup manual admin.
- `manual_closed_by` menyimpan user id admin/owner yang menutup kas.
- `manual_closed_at` menyimpan waktu tutup manual.
- `manual_close_reason` menyimpan alasan tutup manual.
- `current_cash_amount` menyimpan posisi kas terbaru setelah adjustment.
- `has_manual_adjustment` menandai bahwa kas pernah disesuaikan manual.
- `updated_at` digunakan untuk audit dan validasi konflik edit bersamaan.

Catatan data:

- Jangan overwrite data penting tanpa audit.
- Jika nominal terbaru perlu diupdate di cash session, histori nominal sebelumnya tetap wajib tersimpan di audit log.
- Data transaksi penjualan tetap menjadi sumber histori transaksi dan tidak boleh dimutasi oleh fitur ini.
- Data lama harus tetap valid meskipun field baru bernilai null.

## 11. Permission & Access Control

- Melihat daftar kas: owner/admin boleh melihat; staff hanya boleh melihat jika permission existing memang mengizinkan.
- Melihat detail kas: owner/admin boleh melihat semua sesuai akses outlet; staff hanya boleh melihat data sendiri jika flow existing mendukung.
- Menutup kas manual: hanya owner/admin.
- Edit posisi kas: hanya owner/admin.
- Input posisi kas aktual: hanya owner/admin.
- Melihat audit log: owner/admin.
- Menghapus adjustment: out of scope untuk versi awal, kecuali sistem existing sudah mendukung. Jika didukung, hanya owner/admin tertentu yang boleh melakukan dan harus tetap mencatat audit log baru.
- Membatalkan adjustment: out of scope untuk versi awal. Jika dibutuhkan nanti, pembatalan harus dibuat sebagai adjustment balik, bukan menghapus record lama.

Kontrol akses wajib diterapkan di:

- Frontend: untuk menyembunyikan/menonaktifkan tombol.
- Backend/RPC/policy database: untuk menolak request tidak sah.

## 12. Acceptance Criteria

- [ ] Admin bisa melihat daftar kas aktif.
- [ ] Admin bisa membuka detail kas.
- [ ] Admin bisa menutup kas manual dari UI admin.
- [ ] Admin wajib mengisi alasan saat tutup kas manual.
- [ ] Admin bisa input posisi kas aktual.
- [ ] Admin wajib mengisi alasan saat edit posisi kas.
- [ ] Sistem menyimpan audit log setiap perubahan.
- [ ] Audit log menyimpan nominal sebelum dan sesudah.
- [ ] Audit log menyimpan admin yang melakukan perubahan.
- [ ] Audit log menyimpan waktu perubahan.
- [ ] Audit log menyimpan alasan perubahan.
- [ ] Kas yang ditutup manual memiliki label jelas.
- [ ] Kas yang memiliki adjustment manual memiliki label jelas.
- [ ] Koreksi kas tidak menghapus transaksi lama.
- [ ] Data penjualan historis tidak berubah.
- [ ] Staff tidak bisa melakukan aksi admin.
- [ ] Kas yang sudah ditutup tidak bisa ditutup ulang.
- [ ] Data lama tetap bisa dibuka tanpa error.
- [ ] Sistem menolak submit jika alasan kosong.
- [ ] Sistem menolak nominal negatif jika tidak diperbolehkan bisnis.
- [ ] Sistem menangani konflik dua admin yang mengedit kas yang sama.

## 13. Testing Scenario

- Test Case: Admin tutup kas manual
  - Step:
    1. Login sebagai owner/admin.
    2. Buka daftar kas aktif.
    3. Pilih kas yang masih terbuka.
    4. Klik "Tutup Kas Manual".
    5. Isi nominal posisi kas aktual dan alasan.
    6. Konfirmasi penyimpanan.
  - Expected Result:
    - Kas berubah menjadi tertutup.
    - Kas memiliki label "Ditutup Manual Admin".
    - Audit log tersimpan dengan action type tutup kas manual.
    - Audit log menyimpan nominal sebelum, nominal sesudah, admin, waktu, dan alasan.

- Test Case: Admin edit posisi kas
  - Step:
    1. Login sebagai owner/admin.
    2. Buka detail kas.
    3. Klik "Edit Posisi Kas".
    4. Isi nominal baru dan alasan koreksi.
    5. Konfirmasi penyimpanan.
  - Expected Result:
    - Posisi kas aktual berubah ke nominal baru.
    - Sistem membuat adjustment baru.
    - Kas memiliki badge "Ada Penyesuaian Manual".
    - Transaksi penjualan lama tidak berubah.

- Test Case: Alasan kosong
  - Step:
    1. Login sebagai owner/admin.
    2. Buka form tutup kas manual atau edit posisi kas.
    3. Isi nominal, tetapi kosongkan alasan.
    4. Submit form.
  - Expected Result:
    - Sistem menolak submit.
    - Pesan validasi alasan wajib ditampilkan.
    - Tidak ada perubahan data dan tidak ada audit log baru.

- Test Case: Staff mencoba akses
  - Step:
    1. Login sebagai staff/kasir.
    2. Coba buka halaman admin atau endpoint aksi manual.
    3. Coba melakukan tutup kas manual atau edit posisi kas.
  - Expected Result:
    - Tombol aksi admin tidak tersedia di UI.
    - Backend/RPC/policy menolak request jika dipanggil langsung.
    - Tidak ada perubahan data.

- Test Case: Kas sudah ditutup
  - Step:
    1. Login sebagai owner/admin.
    2. Buka detail kas yang sudah tertutup.
    3. Periksa tombol "Tutup Kas Manual".
    4. Jika memungkinkan, coba submit request tutup manual secara langsung.
  - Expected Result:
    - Tombol tutup manual tidak tersedia atau disabled.
    - Backend menolak request tutup ulang.
    - Status kas tidak berubah.

- Test Case: Nominal negatif
  - Step:
    1. Login sebagai owner/admin.
    2. Buka form edit posisi kas.
    3. Input nominal negatif.
    4. Submit form.
  - Expected Result:
    - Sistem menolak input.
    - Pesan validasi nominal tidak valid ditampilkan.
    - Tidak ada adjustment baru.

- Test Case: Dua admin edit bersamaan
  - Step:
    1. Admin A dan Admin B membuka detail kas yang sama.
    2. Admin A menyimpan adjustment.
    3. Admin B menyimpan adjustment dari data lama tanpa reload.
  - Expected Result:
    - Sistem mendeteksi konflik updated_at/version.
    - Request Admin B ditolak atau diminta reload.
    - Adjustment Admin A tetap tersimpan.
    - Tidak ada overwrite diam-diam.

- Test Case: Riwayat audit log
  - Step:
    1. Login sebagai owner/admin.
    2. Buka detail kas yang pernah ditutup atau diedit manual.
    3. Lihat section riwayat perubahan kas.
  - Expected Result:
    - Riwayat audit log tampil.
    - Data diurutkan dari terbaru.
    - Setiap item menampilkan action type, nominal sebelum, nominal sesudah, selisih, alasan, admin, dan waktu.

- Test Case: Data lama tanpa audit log
  - Step:
    1. Login sebagai owner/admin.
    2. Buka detail kas lama yang belum memiliki audit log.
    3. Lihat section riwayat perubahan.
  - Expected Result:
    - Detail kas tetap terbuka tanpa error.
    - Riwayat perubahan menampilkan empty state.
    - Sistem tidak membuat audit log palsu.

- Test Case: Ada setoran terkait
  - Step:
    1. Login sebagai owner/admin.
    2. Buka detail kas yang sudah memiliki setoran terkait.
    3. Klik "Edit Posisi Kas".
    4. Simpan adjustment dengan alasan.
  - Expected Result:
    - Sistem menampilkan konteks setoran di detail kas.
    - Adjustment tetap bisa disimpan jika valid.
    - Setoran lama tidak berubah.
    - Audit log menyimpan perubahan kas.

## 14. Implementation Notes

- Gunakan modul/session kas existing.
- Jangan membuat ulang sistem kas dari nol.
- Jangan menghapus atau mengubah transaksi historis.
- Jangan mengubah data penjualan historis.
- Simpan koreksi sebagai adjustment/audit log.
- Jika nominal terbaru disimpan di cash session, tetap simpan histori nominal sebelumnya di audit log.
- Gunakan transaction database atau RPC atomik jika update menyentuh cash session dan audit log sekaligus.
- Gunakan optimistic locking atau validasi `updated_at` untuk mencegah konflik edit bersamaan.
- Validasi role di frontend dan backend.
- Gunakan pattern UI existing di admin.
- Tambahkan migration secara aman dan nullable untuk data lama.
- Pastikan flow kasir/staff existing tidak rusak.
- Pastikan fitur setoran existing tetap berjalan.
- Pastikan query laporan kas tetap bisa membedakan transaksi asli dan adjustment manual.
- Gunakan label action type yang eksplisit agar laporan dan audit mudah dibaca.
- Hindari update langsung dari client ke banyak tabel jika dapat dibuat melalui RPC/backend function yang terkontrol.
- Jika menggunakan Supabase RLS/policy, pastikan policy hanya mengizinkan owner/admin untuk insert adjustment dan update status tutup manual.

Referensi implementasi repo yang perlu dicek saat eksekusi:

- `admin.html` untuk struktur UI admin.
- `js/admin.js` untuk orchestration halaman admin.
- `js/adminStaffCashUi.js` untuk UI posisi kas staff jika relevan.
- `js/services/cashService.js` untuk logic kas existing.
- `js/depositService.js` dan `js/adminDepositUi.js` untuk konteks setoran.
- `sql/migrations/` untuk penambahan schema/RPC/policy.

## 15. Risiko / Asumsi

### Risiko

- Adjustment manual dapat membuat laporan kas membingungkan jika tidak diberi label jelas.
- Jika validasi role hanya dilakukan di frontend, staff dapat mencoba memanggil endpoint secara langsung.
- Jika adjustment overwrite nominal tanpa audit, histori kas menjadi tidak dapat dipercaya.
- Jika tidak ada locking, dua admin dapat menyimpan perubahan berurutan berdasarkan data lama.
- Jika field baru tidak nullable, data lama dapat gagal dibuka.
- Jika query laporan tidak membedakan transaksi asli dan adjustment, hasil rekonsiliasi bisa salah ditafsirkan.
- Jika admin tidak mengisi alasan yang jelas, audit log tetap kurang berguna secara operasional.

### Asumsi

- Role owner/admin sudah tersedia di sistem auth existing.
- Cash session memiliki id unik yang dapat menjadi relasi audit log.
- Outlet/cabang dan staff sudah tersimpan di data cash session atau dapat diambil melalui relasi.
- Sistem memiliki pola migration database yang bisa ditambah tanpa memutus data lama.
- UI admin existing dapat ditambah menu, tab, atau detail view tanpa redesign besar.
- Posisi kas aktual terbaru dapat disimpan di cash session atau dihitung dari audit log sesuai keputusan teknis saat implementasi.
- Fitur ini tidak menggantikan tutup kas normal oleh staff, tetapi menjadi kontrol admin untuk kondisi operasional khusus.
