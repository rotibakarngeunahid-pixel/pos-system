# PRD: Perbaikan UI/UX Mobile Halaman Setoran Tunai

Tanggal: 2026-05-18  
Produk: Roti Bakar Ngeunah POS  
Area: Staff POS - Halaman Setoran Tunai  
Prioritas: Tinggi  
Status: Ready for AI Builder

## 1. Judul

Perbaikan UI/UX mobile-first untuk halaman setoran tunai staff pada POS Roti Bakar Ngeunah.

Halaman yang diperbaiki:

- `pos.html`, panel `#panel-deposits`.
- `js/depositUi.js`, state dan interaksi form setoran staff.
- `js/depositService.js`, validasi submit/upload setoran staff.
- `js/pos.js`, navigasi tab, blocker shift, dan class body untuk state halaman setoran.
- `css/styles.css`, layout, spacing, responsive, disabled state, floating tutorial button.
- `sql/migrations/030_enforce_closed_shift_before_cash_deposit.sql`, validasi backend yang wajib diverifikasi tetap aktif.

## 2. Background Masalah

Berdasarkan screenshot mobile dan pembacaan kode, halaman setoran tunai saat ini sudah memiliki alur bisnis yang benar secara garis besar: staff hanya boleh setor setelah ada `selectedClosedSession` dari RPC `get_deposit_eligible_sessions`, dan submit akhir diproteksi oleh `depositService.submitDeposit()` serta RPC `create_deposit`.

Masalah utama tersisa ada pada UI/UX mobile:

- Layout mobile terasa berat, tinggi, dan kurang proporsional.
- Status shift card memakai area visual terlalu besar untuk kondisi blocked.
- Informasi `Shift Aktif`, `Staff`, dan `Waktu` masih dipaksa 3 kolom di layar kecil sehingga mudah pecah.
- Form masih bisa diinteraksi sebagian saat belum ada shift tertutup. Saat ini `updateSubmitState()` hanya men-disable submit dan quick button, tetapi input amount, metode setoran, upload bukti, dan notes belum benar-benar disabled secara visual dan fungsional.
- Tombol nominal cepat terlalu tinggi pada mobile kecil.
- Card metode setoran terlalu tinggi, state selected terlalu merah/padat, dan spacing icon/copy belum stabil.
- Floating tutorial button `#ob-reopen-btn` fixed di kanan bawah dengan `z-index: 7400`, ukuran 50px, dan `bottom: env(...) + 72px`; pada halaman setoran ia dapat menutupi area form/submit.
- Safe area Android Chrome/iOS sudah sebagian ditangani lewat `--vh100` dan `env(safe-area-inset-bottom)`, tetapi halaman setoran belum punya bottom safe area yang memperhitungkan floating tutorial button.
- Pesan "Tutup shift terlebih dahulu sebelum setoran tunai" muncul di status card, tetapi belum cukup tegas, belum memberi next action yang jelas, dan tidak mengunci seluruh form.

Dampak operasional:

- Staff bisa bingung karena form tampak aktif meskipun setoran belum boleh dilakukan.
- Staff bisa mengisi nominal, memilih metode, atau mengupload bukti sebelum menutup shift.
- Area bawah berisiko tertutup floating tutorial button atau browser navigation bar.
- Tampilan kurang clean/profesional untuk penggunaan harian di HP kecil.
- Ada potensi error input dan double submit jika state loading/disabled tidak dijaga konsisten di semua handler.

## 3. Tujuan

Tujuan utama:

- Membuat halaman setoran tunai mobile-first, rapi, compact, dan profesional.
- Membuat staff langsung paham bahwa setoran tunai hanya bisa dilakukan setelah shift ditutup.
- Mengunci semua input secara visual dan fungsional saat belum ada shift tertutup eligible.
- Mencegah elemen saling menimpa, terutama floating tutorial button dan tombol submit.
- Menjaga desktop tetap stabil dan tidak rusak.

Tujuan detail:

1. Tidak ada overflow horizontal di viewport 320px sampai desktop.
2. Padding kiri-kanan konsisten dan tidak ada double padding antara panel dan child card.
3. Status shift card compact, mudah dibaca, dan adaptif.
4. Alert blocked punya title, body, dan CTA yang jelas.
5. Input jumlah setoran mudah dibaca, tidak terlalu tinggi, dan aman dari karakter invalid.
6. Quick amount button konsisten, touch-friendly, tetapi tidak berlebihan.
7. Metode setoran tampil compact, selected state jelas namun tidak terlalu mencolok.
8. Upload bukti wajib hanya untuk non-cash dan benar-benar disabled saat blocked.
9. Submit punya disabled/loading/success/error state yang konsisten dan tidak bisa double click.
10. Floating tutorial button tidak menutupi konten utama.
11. Validasi penting tetap ada di backend/RPC/database, bukan hanya frontend.

## 4. Scope

In scope:

- Layout mobile halaman staff setoran tunai di `#panel-deposits`.
- Status shift card `#deposit-cash-card`.
- Alert/blocked state `#deposit-no-cash` atau komponen pengganti yang lebih eksplisit.
- Form jumlah setoran `#deposit-amount` dan `.deposit-currency-field`.
- Quick amount buttons `.deposit-quick-btn`.
- Metode setoran `.deposit-method-card`.
- Upload bukti `#deposit-proof-zone` dan `#deposit-proof-file`.
- Catatan `#deposit-notes`.
- Submit button `#btn-submit-deposit`.
- Riwayat setoran staff `#deposit-history-body` sejauh berdampak pada scroll dan spacing mobile.
- Floating tutorial reopen button `#ob-reopen-btn` pada halaman setoran.
- Guardrail UI di `depositUi`: blocked, enabled, loading, selected, proof required.
- Guardrail service/backend yang berkaitan langsung dengan setoran.

Files yang perlu disentuh:

- `pos.html`
- `css/styles.css`
- `js/depositUi.js`
- `js/depositService.js`
- `js/pos.js`
- Opsional jika perlu: `js/onboarding.js`
- Verifikasi saja: `sql/migrations/030_enforce_closed_shift_before_cash_deposit.sql`

## 5. Non-Scope

Tidak termasuk:

- Mengubah flow bisnis setoran selain guardrail yang sudah diwajibkan.
- Membuat fitur absensi/presensi/clock-in.
- Membuat metode approval baru.
- Mengubah flow transaksi penjualan POS.
- Mengubah logic kas manual admin kecuali ada bug langsung yang menyebabkan setoran bisa bypass closed shift.
- Mengubah desain seluruh POS.
- Membuat rekonsiliasi bank otomatis.
- Menghapus atau memigrasi data historis setoran lama secara otomatis.

## 6. Screenshot Issue Analysis

Analisis visual dari screenshot mobile:

| Area | Issue yang terlihat | Dampak | Solusi wajib |
|---|---|---|---|
| Page container | Konten terlihat memiliki padding/margin yang tidak stabil dan terasa berat | Layout kurang clean, potensi horizontal overflow | Gunakan satu sumber padding horizontal pada `.deposit-page-inner` atau `.deposit-content-grid`; child card tidak boleh menambah margin horizontal lagi di mobile |
| Status card | Card atas terlalu tinggi, ada amount/dash besar, alert tinggi | Area first viewport habis oleh status, form terdorong turun | Compact card: padding 12-16px, amount max 26px, meta stack pada layar kecil, alert jadi inline banner compact |
| Meta shift/staff/waktu | 3 kolom tetap dipakai di HP kecil | Teks wrap tidak rapi | Di bawah 390px gunakan 1 kolom; 390-560px gunakan 2 kolom dengan waktu full-width atau stack |
| Alert blocked | Copy hanya satu kalimat besar | Staff belum tahu next action | Alert berisi title "Setoran belum bisa dilakukan", body, dan CTA "Tutup Shift Sekarang" jika ada shift open |
| Input amount | Field tinggi dan tampak aktif saat belum boleh setor | Staff bisa salah mengira form aktif | Tambahkan state disabled pada field, hint, dan `aria-disabled` |
| Quick amount | Tombol terlalu besar dan jarak kurang ideal | Menghabiskan ruang mobile | Tinggi 40-44px, gap 8px, font 13px, radius 8px |
| Method card | Terlalu tinggi, selected border merah tebal dan background kuat | Visual terlalu ramai | Tinggi 56-64px, border 1.5px, background selected red tint halus, icon 32px |
| Floating tutorial | Tombol cap di kanan bawah menutupi area konten | Mengganggu scroll/submit | Reposition/hide khusus halaman setoran; bottom safe area minimal 96-120px |
| Bottom area | Konten bawah dapat tertutup browser/nav/floating | Submit tidak nyaman dijangkau | Tambah bottom padding halaman setoran: `calc(128px + max(env(safe-area-inset-bottom, 0px), 16px))` |
| Disabled visual | Disabled quick button ada, tetapi komponen lain belum terkunci | State UI tidak konsisten | Buat satu fungsi `applyFormAvailability()` untuk semua field |

## 7. User Flow Sebelum Perbaikan

Flow saat ini berdasarkan kode:

1. Staff membuka POS dan masuk ke tab `Setoran`.
2. `POS.switchMainTab('deposits')` mengaktifkan `#panel-deposits`.
3. `depositUi.refreshWhenReady()` mengambil eligible closed session lewat `depositService.getEligibleSessions()`.
4. Jika belum ada shift tertutup dan shift masih open, modal `#modal-deposit-blocked` bisa muncul.
5. Status card menampilkan "Tutup shift terlebih dahulu sebelum setoran tunai".
6. Submit button dan quick amount disabled lewat `updateSubmitState()`.
7. Tetapi input jumlah, pilihan metode, upload bukti, dan catatan masih tampak aktif atau masih dapat diinteraksi.
8. Jika staff tetap mencoba submit, `onSubmit()` menolak karena `hasEligibleClosedShift()` false.

Masalah flow:

- UI mengandalkan submit guard, bukan form-level guard.
- Staff masih bisa melakukan aksi yang sebenarnya tidak relevan sebelum shift tertutup.
- Pesan blocked tersebar antara modal dan status card, belum menjadi inline state yang jelas.
- Floating tutorial button masih bisa muncul di atas area kerja.

## 8. User Flow Setelah Perbaikan

### A. Staff belum tutup shift, ada shift open

1. Staff membuka tab Setoran.
2. Sistem menampilkan compact status card dengan status "Shift masih aktif".
3. Sistem menampilkan inline alert utama:
   - Title: "Setoran belum bisa dilakukan"
   - Body: "Tutup shift terlebih dahulu agar kas akhir terkunci. Setelah itu, form setoran akan aktif."
   - CTA: "Tutup Shift Sekarang"
4. Semua field setoran disabled:
   - Amount input disabled.
   - Quick buttons disabled.
   - Method cards disabled dan tidak focusable.
   - Upload proof disabled.
   - Notes disabled.
   - Submit disabled.
5. Jika CTA diklik, sistem membuka modal tutup shift existing.
6. Setelah shift berhasil ditutup, sistem refresh eligible session dan form aktif.

### B. Staff belum punya shift tertutup dan tidak ada shift open

1. Staff membuka tab Setoran.
2. Sistem menampilkan status "Belum ada shift tertutup".
3. Alert utama menjelaskan bahwa staff perlu membuka shift, berjualan, lalu tutup shift.
4. CTA: "Buka Shift" jika tersedia dari existing flow.
5. Semua field tetap disabled.

### C. Staff sudah tutup shift dan ada cash depositable

1. Sistem menampilkan status "Kas Final Shift".
2. Sistem menampilkan `Shift #id (Tertutup)`, staff, waktu, dan nominal kas dapat disetor.
3. Form aktif.
4. Staff input nominal atau pilih quick amount.
5. Staff pilih metode setoran.
6. Jika metode cash/tunai: upload bukti opsional.
7. Jika metode bank/QRIS/e-wallet: upload bukti wajib.
8. Submit aktif hanya jika semua syarat terpenuhi.
9. Submit membuka confirm modal.
10. Setelah confirm, submit masuk loading dan tidak bisa diklik ulang.
11. Jika sukses, form reset dan success state muncul.

### D. Shift tertutup sudah punya deposit pending/confirmed

1. Form disabled.
2. Alert menjelaskan:
   - Pending: "Setoran shift ini sedang menunggu konfirmasi admin."
   - Confirmed: "Setoran shift ini sudah selesai."
3. Jika rejected, form boleh aktif ulang dan alasan rejection ditampilkan.

## 9. Detail Requirement UI

### 9.1 Layout page

Tambahkan atau rapikan struktur container:

```html
<div class="pos-alt-panel deposit-page" id="panel-deposits">
  <div class="deposit-page-inner">
    ...
  </div>
</div>
```

Jika tidak ingin mengubah markup besar, terapkan aturan yang sama pada child existing.

Spesifikasi:

- `.deposit-page`:
  - `overflow-x: hidden`
  - background `#F8F8F8` atau `var(--bg)`
  - mobile padding luar 0, biarkan `.deposit-page-inner` mengatur padding
- `.deposit-page-inner`:
  - width `100%`
  - max-width desktop `1180px`
  - margin `0 auto`
  - padding mobile `12px`
  - padding tablet `16px`
  - padding desktop `16px 24px 24px`
  - padding-bottom mobile `calc(128px + max(env(safe-area-inset-bottom, 0px), 16px))`
- Tidak boleh ada child dengan `width` lebih dari `100%`.
- Semua grid child wajib punya `min-width: 0`.

### 9.2 Header halaman

Selector: `.deposit-page-header`, `.deposit-page-title`, `.deposit-header-meta`.

Mobile <= 560px:

- Header height natural, padding `0 0 8px`.
- Gap `8px`.
- Title font 18px, weight 700.
- Meta font 12px, color `var(--text-muted)`, line-height 1.35.
- Refresh button tetap 40px min-height, boleh icon-only pada <= 360px.
- Back button icon-only pada <= 560px.

### 9.3 Status shift card

Selector: `#deposit-cash-card`, `.deposit-cash-card`.

Default mobile:

- margin `0 0 12px`
- padding `14px`
- border radius `8px`
- box-shadow maksimal `0 4px 14px rgba(220,38,38,0.14)`
- background closed-ready: `var(--danger)` atau linear red/orange halus
- background blocked/no-session: `#FFF7ED` dengan border `1px solid rgba(249,115,22,0.28)` dan text dark, bukan card orange solid besar
- Jangan pakai card warning solid penuh untuk blocked state di mobile.

Amount:

- Closed-ready: `#deposit-expected-cash` font 24-26px mobile, 30-34px desktop.
- Blocked/no-session: jangan tampilkan dash besar sebagai elemen dominan. Tampilkan `-` kecil atau sembunyikan amount dan fokus ke alert.
- Line-height 1.1.

Icon:

- Mobile: 28px.
- Desktop: 34px.
- Pada blocked state gunakan icon lock/alert di alert, bukan hanya banknote besar.

### 9.4 Meta grid shift/staff/waktu

Selector: `.deposit-card-meta-grid`.

Breakpoints:

- <= 389px: `grid-template-columns: 1fr`, gap 8px, label/value satu baris atau stacked compact.
- 390px-560px: `grid-template-columns: repeat(2, minmax(0, 1fr))`; item Waktu boleh `grid-column: 1 / -1`.
- >= 561px: `grid-template-columns: repeat(3, minmax(0, 1fr))`.

Typography:

- Label: 11px, weight 700, uppercase tidak wajib, color muted.
- Value: 12-13px, weight 800, `overflow-wrap: anywhere`, line-height 1.3.
- Jangan ada value yang memaksa horizontal scroll.

Catatan copy:

- Label "Shift Aktif" harus diganti dinamis menjadi:
  - Jika belum eligible: "Status Shift"
  - Jika eligible: "Shift Tertutup"
- Ini menghindari kontradiksi saat sistem sedang menunggu shift tertutup.

### 9.5 Alert blocked

Selector existing: `#deposit-no-cash`, `.deposit-no-cash`. Boleh diganti menjadi `.deposit-blocking-alert`.

Komponen wajib:

- Icon kecil 20px.
- Title 13-14px weight 800.
- Body 12-13px line-height 1.45.
- CTA button/link jika action tersedia.
- Background:
  - Warning: `#FFEDD5`
  - Border: `rgba(249,115,22,0.35)`
  - Text: `#7C2D12` atau `var(--text)`
- Border radius 8px.
- Padding mobile 10-12px.
- Margin top 12px.

Copy wajib:

- Jika shift open:
  - Title: "Setoran belum bisa dilakukan"
  - Body: "Tutup shift terlebih dahulu agar kas akhir terkunci. Setelah itu form setoran akan aktif."
  - CTA: "Tutup Shift Sekarang"
- Jika tidak ada shift:
  - Title: "Belum ada shift tertutup"
  - Body: "Buka shift, selesaikan transaksi, lalu tutup shift sebelum melakukan setoran tunai."
  - CTA: "Buka Shift"
- Jika pending:
  - Title: "Setoran sedang diproses"
  - Body: "Setoran shift ini sudah dikirim dan menunggu konfirmasi admin."
- Jika confirmed:
  - Title: "Setoran shift ini selesai"
  - Body: "Shift ini sudah memiliki setoran terkonfirmasi."
- Jika rejected:
  - Title: "Setoran sebelumnya ditolak"
  - Body: tampilkan alasan penolakan dan izinkan input ulang.

### 9.6 Form card

Selector: `.deposit-form-card`, `.deposit-form-card .card-body`.

Mobile:

- Card margin 0.
- Border radius 8px.
- Border `1px solid var(--border)`.
- Box shadow ringan atau none.
- Body padding 14px pada <= 360px, 16px pada 361-560px.
- Gap antar section 14-16px.
- Jangan gunakan gap 24px pada mobile.

Desktop:

- Body padding 20-24px.
- Layout 2 kolom tetap hanya untuk `.deposit-content-grid`, bukan isi form.

### 9.7 Input jumlah setoran

Selector: `.deposit-currency-field`, `#deposit-amount`.

Mobile:

- Height/min-height 48px.
- Prefix `Rp` box 36x36px.
- Input font 17px, weight 600.
- Padding input `10px 8px 10px 0`.
- Border radius 8px.
- Focus ring `0 0 0 3px rgba(220,38,38,0.10)`.
- Error border `var(--danger)`.
- Disabled background `#F3F4F6`, border `#E5E7EB`, text muted.

Behavior:

- Placeholder "0".
- Value ditampilkan sebagai ribuan id-ID tanpa `Rp` karena prefix sudah ada.
- Input harus tetap numeric-only.
- Jangan menerima tanda minus, `e`, desimal, atau simbol lain.

### 9.8 Quick amount buttons

Selector: `.deposit-quick-grid`, `.deposit-quick-btn`.

Mobile:

- Grid 3 kolom untuk >= 361px.
- Grid 2 kolom untuk <= 360px jika label "Setor Semua" tidak muat.
- Gap 8px.
- Height 42px pada <= 480px.
- Min-height maksimal 44px.
- Font 13px, weight 800.
- Border radius 8px.
- Border 1px solid `var(--border)`.
- Button "Setor Semua":
  - enabled: background `var(--danger)`, color white.
  - disabled: same disabled style as others, tidak memakai gray gelap solid.

Disabled:

- opacity 1, bukan 0.48 saja.
- background `#F3F4F6`.
- border `#E5E7EB`.
- color `#9CA3AF`.
- cursor default/not-allowed.
- pointer-events none.

### 9.9 Metode setoran cards

Selector: `.deposit-method-grid`, `.deposit-method-card`.

Mobile:

- Single column di <= 560px.
- Gap 8px.
- Card min-height 58px, max natural 68px.
- Padding `10px 12px`.
- Border radius 8px.
- Icon container 32x32px.
- Icon size 18px.
- Copy strong 14px, line-height 1.25.
- Copy small 12px, line-height 1.25, `white-space: normal` pada <= 360px agar rekening panjang tidak overflow.

Selected state:

- Border `1.5px solid var(--danger)`.
- Background `#FFF7F6` atau `rgba(220,38,38,0.05)`.
- Tambahkan check icon kecil di kanan jika memungkinkan.
- Jangan gunakan border 2px yang menyebabkan layout shift.
- Jangan gunakan background merah/pink terlalu tebal.

Disabled state:

- `.deposit-method-card.is-disabled`
- `aria-disabled="true"`
- `tabindex="-1"`
- pointer-events none.
- background `#F9FAFB`.
- icon/copy color muted.
- selected visual tidak boleh terlalu dominan saat disabled.

### 9.10 Upload zone

Selector: `#deposit-proof-zone`, `.deposit-upload-zone`.

Mobile:

- Min-height 88px default.
- Padding 12px.
- Border radius 8px.
- Di <= 560px jangan dipaksa 140px kecuali ada preview image.
- Empty state tetap row pada 390-560px; boleh column pada <= 360px.
- Icon 36px.
- Copy title 14px, body 12px.

Preview:

- Image preview max 72x56px mobile.
- Filename wrap dengan `overflow-wrap: anywhere`.
- Remove button 32x32px.

Disabled:

- Upload zone harus tidak bisa diklik/focus.
- `tabindex="-1"`.
- `aria-disabled="true"`.
- Text: "Upload bukti aktif setelah shift ditutup."

## 10. Detail Requirement UX

### 10.1 Prinsip UX

- Staff harus melihat satu pesan utama yang menjelaskan status, bukan menebak dari disabled button.
- Semua elemen yang tidak bisa dipakai harus tampak disabled dan benar-benar tidak menerima event.
- Error harus muncul sedekat mungkin dengan field terkait.
- Submit hanya aktif jika staff bisa menyelesaikan action tanpa error.
- State loading harus mengunci semua input sampai request selesai.
- Tidak boleh ada modal blocker yang berulang-ulang saat staff masih membaca halaman. Inline alert menjadi sumber informasi utama; modal blocker boleh muncul hanya saat pertama kali staff membuka tab Setoran dari menu.

### 10.2 Copy UX

Gunakan copy singkat:

- "Setoran belum bisa dilakukan"
- "Tutup shift terlebih dahulu agar kas akhir terkunci."
- "Form setoran aktif setelah shift tertutup."
- "Pilih metode setoran."
- "Upload bukti setoran untuk transfer bank/QRIS/e-wallet."
- "Bukti opsional untuk setoran tunai langsung."

Hindari:

- "Shift aktif belum terbaca" sebagai status user-facing utama.
- "Mode setoran tanpa shift aktif".
- Pesan teknis seperti `session_id null`.

### 10.3 Feedback sukses/gagal

Sukses:

- Tampilkan inline success state di atas form selama 7 detik.
- Toast tetap boleh tampil.
- Success copy:
  - Title: "Setoran berhasil dikirim"
  - Body: "Menunggu konfirmasi admin. Ref: XXXXXXXX"

Gagal:

- Toast error.
- Jika error validasi field, tampilkan juga inline error pada field.
- Jika error backend closed-shift, tampilkan alert blocked dan refresh eligibility.
- Jika upload proof berhasil tetapi RPC gagal, tampilkan pesan bahwa setoran belum tercatat dan staff harus coba lagi. Opsional: bersihkan file sementara jika path tersedia.

## 11. Detail Requirement Validasi

### 11.1 Frontend validation

Nominal:

- Wajib angka positif.
- Wajib kelipatan Rp 50.000.
- Tidak boleh melebihi `depositableCash`.
- Tidak boleh 0.
- Tidak boleh negatif.
- Tidak boleh desimal.
- Tidak boleh karakter selain digit.
- Maksimal angka aman: tidak melebihi `Number.MAX_SAFE_INTEGER` dan tetap dibatasi oleh `depositableCash`.

Metode:

- Wajib pilih satu metode aktif jika form enabled.
- Jika tidak ada metode aktif, submit disabled dan tampilkan "Belum ada metode setoran aktif. Hubungi admin."

Bukti:

- Wajib untuk non-cash.
- Opsional untuk cash/tunai.
- File type: JPG, JPEG, PNG, PDF.
- Max size 5 MB.
- File size tidak boleh 0.

Shift:

- `selectedClosedSession` wajib ada.
- `selectedClosedSession.session_status` wajib `closed`.
- `depositableCash` harus > 0.
- Jika `block_reason` ada, form disabled.

Submit:

- Jika `isSubmitting === true`, semua handler return.
- Submit button disabled sebelum confirm, saat confirm modal aktif, dan selama request.

### 11.2 Backend/database validation

Validasi final wajib tetap ada di RPC/database:

- `create_deposit` wajib menolak `p_session_id IS NULL`.
- Session wajib ditemukan.
- `cashier_sessions.status` wajib `closed`.
- `branch_id` dan `staff_id` deposit wajib sama dengan session.
- Nominal wajib > 0.
- Nominal wajib kelipatan Rp 50.000.
- Nominal tidak boleh melebihi depositable cash.
- Metode setoran wajib aktif dan tersedia untuk cabang.
- Bukti wajib untuk account type non-cash.
- Double submit untuk satu shift harus ditolak secara atomik.
- Direct insert/update ke `cash_deposits` wajib ditolak oleh trigger/policy jika melanggar closed-shift rule.

Migration `030_enforce_closed_shift_before_cash_deposit.sql` sudah mengarah ke guardrail ini. AI builder wajib memverifikasi migration sudah diterapkan di environment target.

Rekomendasi tambahan:

- Tambahkan partial unique index jika belum ada:

```sql
CREATE UNIQUE INDEX IF NOT EXISTS uniq_cash_deposits_active_per_session
ON public.cash_deposits(session_id)
WHERE status IN ('pending', 'confirmed');
```

Index ini bukan pengganti trigger/RPC, tetapi memperkuat pencegahan double submit.

## 12. Detail Requirement Responsive Mobile

Bagian ini adalah spesifikasi Mobile Layout utama untuk halaman setoran tunai. Semua ukuran di bawah harus diprioritaskan dari viewport kecil terlebih dahulu, lalu ditingkatkan untuk tablet/desktop.

Gunakan mobile-first.

Breakpoints:

| Breakpoint | Target | Layout |
|---|---|---|
| <= 360px | HP sangat kecil | Padding 10-12px, quick button 2 kolom jika perlu, meta 1 kolom |
| 361px-480px | HP umum kecil | Padding 12px, quick button 3 kolom, metode 1 kolom |
| 481px-560px | HP besar | Padding 14-16px, meta 2 kolom, metode 1 kolom |
| 561px-768px | Tablet kecil/mobile landscape | Padding 16px, meta 3 kolom, metode 1 atau 2 kolom sesuai ruang |
| 769px-900px | Tablet | Grid content 1 kolom, history di bawah |
| > 900px | Desktop | Grid form/history 2 kolom existing boleh dipertahankan |

Rules wajib:

- `html`, `body`, `.pos-page` tidak boleh menghasilkan horizontal scroll.
- `.deposit-page` harus `overflow-x: hidden`.
- Semua container grid harus `min-width: 0`.
- Gunakan `max-width: 100%` pada card/input/button.
- Hindari `min-width: 320px` pada child card di mobile.
- Bottom padding halaman setoran harus memperhitungkan:
  - browser navigation bar
  - safe area inset
  - floating tutorial button
  - submit button/confirm modal

CSS target mobile:

```css
@media (max-width: 768px) {
  .pos-alt-panel.deposit-page {
    padding: 0;
    overflow-x: hidden;
    overflow-y: auto;
  }

  .deposit-page-inner {
    width: 100%;
    max-width: 100%;
    padding: 12px;
    padding-bottom: calc(128px + max(env(safe-area-inset-bottom, 0px), 16px));
  }

  .deposit-cash-card,
  .deposit-content-grid {
    margin-left: 0;
    margin-right: 0;
  }
}
```

Jika tidak menambah `.deposit-page-inner`, implementasikan padding equivalent pada `.deposit-page-header`, `.deposit-cash-card`, dan `.deposit-content-grid` tanpa double padding.

## 13. Detail Requirement State Disabled/Enabled

Buat satu source of truth di `js/depositUi.js`:

```js
isFormBlocked() {
  const sess = this.selectedClosedSession;
  return !this.hasEligibleClosedShift()
    || Boolean(sess?.block_reason)
    || this.depositableCash <= 0;
}
```

Tambahkan fungsi:

```js
applyFormAvailability() {
  const blocked = this.isFormBlocked();
  const disabled = blocked || this.isSubmitting;
  // set disabled/aria-disabled/class/tabindex untuk semua field
}
```

Elemen yang wajib dikunci saat blocked:

| Elemen | Required state |
|---|---|
| `#deposit-amount` | `disabled = true`, parent `.is-disabled` |
| `.deposit-quick-btn` | `disabled = true` |
| `.deposit-method-card` | `.is-disabled`, `aria-disabled=true`, `tabindex=-1` |
| `input[name="deposit-method"]` | `disabled = true` |
| `#deposit-proof-file` | `disabled = true` |
| `#deposit-proof-zone` | `.is-disabled`, `aria-disabled=true`, `tabindex=-1` |
| `#deposit-notes` | `disabled = true` |
| `#btn-submit-deposit` | `disabled = true` |

Handler guards:

- `onAmountInput()` harus return jika form blocked atau submitting.
- `setQuickAmount()` harus return jika form blocked atau submitting.
- `selectAccount()` harus return jika form blocked atau submitting.
- Upload zone click/keydown/drop harus return jika form blocked atau submitting.
- `onFileChange()` harus return dan clear file jika form blocked.
- `onSubmit()` tetap melakukan semua validasi backend-facing seperti saat ini.

CSS state:

```css
.deposit-form-card.is-disabled {
  opacity: 1;
}

.deposit-currency-field.is-disabled,
.deposit-upload-zone.is-disabled,
.deposit-method-card.is-disabled {
  background: #F9FAFB;
  border-color: #E5E7EB;
  color: #9CA3AF;
  cursor: not-allowed;
  box-shadow: none;
}

.deposit-method-card.is-disabled,
.deposit-upload-zone.is-disabled {
  pointer-events: none;
}
```

## 14. Detail Requirement Metode Setoran

Data sumber:

- `depositService.getAccounts({ branchId })`.
- Table `deposit_accounts`.
- Account aktif: `is_active = true`.

Sorting existing di `depositUi.sortAccounts()` boleh dipertahankan:

1. BCA
2. BNI
3. BRI
4. cash/manager
5. QRIS
6. lainnya

Perbaikan required:

- Staff UI harus menggunakan helper cash detection yang sama dengan admin:

```js
depositService.isCashDepositMethod(account)
```

Jangan hanya memakai:

```js
account.type === 'cash'
```

Alasannya: data bisa memakai label/type seperti `tunai`, `serah_tunai`, atau label mengandung cash/tunai.

Display:

- Bank:
  - Label: `Via Bank BCA`
  - Detail: `BCA - 6115790556`
- Cash:
  - Label: `Serah Tunai`
  - Detail: `Serahkan langsung ke manager`
- QRIS/e-wallet:
  - Label sesuai account.
  - Detail ringkas, maksimal 1-2 baris.

Selected state:

- Satu metode saja yang boleh selected.
- `aria-checked` harus sinkron dengan radio checked.
- Selected card tidak boleh berubah ukuran.
- Saat disabled, selected state boleh tetap terlihat tipis, tetapi tidak boleh memberi kesan bisa diklik.

Empty/error state:

- Jika accounts gagal load: tampilkan inline error dan submit disabled.
- Jika tidak ada account aktif: tampilkan inline error dan submit disabled.

## 15. Detail Requirement Upload Bukti

Rules:

- Metode cash/tunai: bukti opsional.
- Metode bank, QRIS, e-wallet, non-cash lain: bukti wajib.
- Upload zone disabled jika form blocked.
- Upload zone disabled saat `isSubmitting`.
- File validation dilakukan sebelum preview.
- Preview harus dapat dihapus.
- Jika user mengganti metode dari non-cash ke cash:
  - file yang sudah dipilih boleh tetap ada.
  - hint berubah menjadi opsional.
- Jika user mengganti metode dari cash ke non-cash:
  - submit disabled sampai bukti ada.

Hint copy:

- Tidak ada metode: "Pilih metode setoran terlebih dahulu."
- Cash: "Bukti opsional untuk penyerahan tunai langsung."
- Bank: "Bukti wajib untuk transfer bank."
- QRIS/e-wallet: "Bukti wajib untuk QRIS/e-wallet."
- Disabled: "Upload bukti aktif setelah shift ditutup."

Accessibility:

- `#deposit-proof-zone` role button hanya jika enabled.
- Jika disabled, set `aria-disabled=true`.
- Keyboard Enter/Space hanya membuka file picker jika enabled.

## 16. Detail Requirement Floating Button

Floating yang terdeteksi:

- `#ob-reopen-btn` di `css/styles.css`, bagian onboarding tutorial.
- Position fixed, right `var(--s4)`, bottom `env + 72px`, z-index `7400`, ukuran 50px.

Masalah:

- Pada halaman setoran, button ini muncul di kanan bawah dan dapat menutupi form, riwayat, atau tombol submit.
- Z-index sangat tinggi untuk elemen sekunder.

Requirement:

1. Saat tab deposits aktif, body harus mendapat class:

```js
document.body.classList.toggle('deposit-tab-active', tab === 'deposits');
```

Tambahkan di:

- `POS.switchMainTab(tab, btnEl)`
- `POS.switchMobileDrawerTab(tab, btnEl)`

2. CSS khusus halaman setoran:

```css
@media (max-width: 768px) {
  body.deposit-tab-active #ob-reopen-btn {
    width: 44px;
    height: 44px;
    right: 12px;
    bottom: calc(112px + max(env(safe-area-inset-bottom, 0px), 16px));
    z-index: 1200;
  }
}
```

3. Jika masih overlap dengan submit/floating content, opsi yang lebih aman:

```css
body.deposit-tab-active #ob-reopen-btn.visible {
  display: none;
}
```

Prioritas rekomendasi:

- Untuk halaman setoran, prefer hide `#ob-reopen-btn` saat form belum selesai atau saat viewport <= 480px.
- Jika tetap harus tampil, letakkan di atas bottom safe area dan jangan menutupi submit.

4. Tambah bottom padding halaman setoran minimal 128px agar jika FAB tetap tampil, konten terakhir masih bisa discroll di atasnya.

## 17. Detail Requirement Submit Behavior

Submit button: `#btn-submit-deposit`.

Enabled hanya jika:

- Ada `selectedClosedSession`.
- `selectedClosedSession.session_status === 'closed'`.
- Tidak ada `block_reason`.
- `depositableCash > 0`.
- Amount valid.
- Account selected.
- Proof valid jika required.
- `isSubmitting === false`.

Submit flow:

1. User klik "Setor Sekarang".
2. `onSubmit()` validasi ulang semua syarat.
3. Confirm modal muncul.
4. Jika user cancel, tidak ada perubahan.
5. Jika user confirm:
   - set `isSubmitting = true`.
   - disable semua input.
   - button text "Mengirim..." atau "Mengupload bukti..." jika file ada.
   - tampilkan spinner.
6. Upload proof jika ada.
7. Call RPC `create_deposit`.
8. On success:
   - simpan last account.
   - clear form.
   - refresh eligible session/history.
   - show success state.
9. On error:
   - show toast.
   - jika error closed-shift/double-submit, refresh eligibility.
10. Finally:
   - set `isSubmitting = false`.
   - render state ulang.

Double click prevention:

- `onSubmit()` harus return paling awal jika `this.isSubmitting`.
- Confirm OK button juga harus disable setelah diklik.
- Submit button disabled sebelum async upload dimulai.
- Backend tetap menolak double active deposit per session.

Tidak bisa dibypass:

- UI disabled bukan satu-satunya proteksi.
- `depositService.submitDeposit()` tetap harus menolak sessionId kosong, amount invalid, proof missing, dan amount > cashBalance.
- RPC/database tetap validasi closed shift.

## 18. Edge Cases

Wajib ditangani:

1. Viewport 320px: tidak ada horizontal overflow.
2. Viewport 360px: quick button "Setor Semua" tidak pecah/keluar card.
3. Browser Android navigation bar menutupi area bawah.
4. iOS safe area bottom.
5. Floating tutorial button aktif di halaman setoran.
6. Tidak ada shift open dan tidak ada shift tertutup.
7. Ada shift open tetapi belum ditutup.
8. Baru saja tutup shift dan langsung masuk halaman setoran.
9. Shift tertutup punya cash 0.
10. Shift tertutup punya deposit pending.
11. Shift tertutup punya deposit confirmed.
12. Shift tertutup punya deposit rejected.
13. Account setoran gagal load.
14. Tidak ada account setoran aktif.
15. Account selected dari localStorage sudah nonaktif/hilang.
16. Staff memilih bank tetapi belum upload bukti.
17. Staff memilih cash tanpa bukti.
18. File > 5 MB.
19. File extension valid tetapi MIME kosong dari kamera HP.
20. File PDF preview.
21. Nama file sangat panjang.
22. Nominal lebih dari depositableCash.
23. Nominal bukan kelipatan Rp 50.000.
24. Nominal paste dengan `Rp`, titik, koma, minus, huruf.
25. Submit saat koneksi lambat.
26. Double click submit.
27. Refresh halaman saat submit pending.
28. RPC menolak karena session sudah punya deposit aktif.
29. Modal confirm dibuka lalu tab pindah.
30. Keyboard virtual membuka dan viewport mengecil.

## 19. Acceptance Criteria

AC-001: Pada viewport 320px, 360px, 390px, 412px, 480px, 768px, dan desktop, halaman setoran tidak memiliki horizontal overflow.

AC-002: Pada mobile, padding kiri-kanan halaman konsisten 12-16px dan tidak ada double padding yang membuat card terlalu sempit atau terlalu mepet.

AC-003: Status shift card mobile lebih compact: tinggi blocked state maksimal 190px kecuali teks sangat panjang.

AC-004: Informasi status shift, staff, dan waktu tidak overlap dan tidak keluar card.

AC-005: Saat belum ada shift tertutup eligible, semua input form setoran disabled secara visual dan fungsional.

AC-006: Saat belum ada shift tertutup eligible, click pada method card, quick amount, upload zone, dan amount input tidak mengubah state.

AC-007: Alert "Setoran belum bisa dilakukan" tampil jelas dengan CTA yang sesuai kondisi.

AC-008: Jika shift open, CTA alert membuka modal tutup shift existing.

AC-009: Jika tidak ada shift open, CTA alert membuka modal buka shift existing jika tersedia.

AC-010: Setelah shift ditutup, form aktif tanpa reload manual dan preselect shift tertutup terbaru.

AC-011: Quick amount buttons mobile memiliki ukuran konsisten dan tidak terlalu tinggi.

AC-012: Method cards mobile compact dan selected state tidak menyebabkan layout shift.

AC-013: Cash/tunai tidak wajib bukti; bank/QRIS/e-wallet wajib bukti.

AC-014: Submit disabled sampai semua syarat terpenuhi.

AC-015: Saat submit loading, semua input disabled dan tombol tidak bisa diklik ulang.

AC-016: Backend/RPC menolak submit tanpa closed shift walaupun dipanggil dari console/devtools.

AC-017: Backend/RPC menolak submit tanpa bukti untuk non-cash walaupun frontend dibypass.

AC-018: Backend/RPC menolak double submit untuk session yang sama.

AC-019: Floating tutorial button tidak menutupi form, upload, history, atau submit pada mobile.

AC-020: Desktop tetap memakai layout 2 kolom form/history dan tidak mengalami regresi visual besar.

## 20. Checklist Testing

### 20.1 Manual responsive test

Test viewport:

- 320x568
- 360x740
- 390x844
- 412x915
- 480x900
- 768x1024
- 1024x768
- 1366x768

Checklist:

- Tidak ada horizontal scroll.
- Card tidak terpotong.
- Header tidak overlap.
- Status card compact.
- Meta shift/staff/waktu terbaca.
- Alert blocked terbaca jelas.
- Quick buttons rapi.
- Method cards rapi.
- Upload zone rapi.
- Floating tutorial tidak menutup konten.
- Konten terakhir bisa discroll di atas browser nav/floating button.

### 20.2 State test

- Staff punya shift open, belum tutup shift.
- Staff tidak punya shift open dan tidak punya closed shift.
- Staff punya closed shift dengan kas > 0.
- Staff punya closed shift dengan kas 0.
- Staff punya deposit pending.
- Staff punya deposit confirmed.
- Staff punya deposit rejected.

Checklist:

- Disabled/enabled state benar.
- CTA benar.
- Copy benar.
- Submit state benar.

### 20.3 Input test

Paste values:

- `50000`
- `50.000`
- `Rp 50.000`
- `-50000`
- `50abc000`
- `1e6`
- `0`
- kosong
- nominal lebih dari cash
- nominal bukan kelipatan 50.000

Expected:

- Invalid tidak bisa submit.
- Error field muncul.
- Tidak ada negative amount.
- Value diformat rupiah.

### 20.4 Method/proof test

- Pilih cash tanpa file, submit boleh jika syarat lain valid.
- Pilih BCA/BNI tanpa file, submit disabled/error.
- Upload JPG valid.
- Upload PNG valid.
- Upload PDF valid.
- Upload file > 5MB ditolak.
- Upload file kosong ditolak.
- Hapus file preview.
- Ganti dari bank ke cash.
- Ganti dari cash ke bank.

### 20.5 Submit test

- Klik submit sekali.
- Double click submit cepat.
- Klik confirm dua kali.
- Koneksi lambat saat upload.
- RPC error.
- Upload success tetapi RPC error.
- Submit berhasil.
- Setelah berhasil, history refresh.
- Setelah berhasil, session eligible berubah menjadi blocked/pending.

### 20.6 Backend bypass test

Jalankan dari console/service atau API:

- `depositService.submitDeposit()` tanpa `sessionId`.
- `depositService.submitDeposit()` dengan session open.
- `depositService.submitDeposit()` non-cash tanpa file.
- RPC `create_deposit` langsung dengan session open.
- Insert langsung ke `cash_deposits` jika masih punya akses.
- Double RPC untuk session sama.

Expected:

- Semua bypass ditolak oleh service/RPC/DB.

## 21. Rekomendasi Implementasi Teknis

### 21.1 Urutan implementasi

1. Tambahkan class active tab di `js/pos.js`:
   - `document.body.classList.toggle('deposit-tab-active', tab === 'deposits')`.
   - Terapkan di `switchMainTab()` dan `switchMobileDrawerTab()`.

2. Tambahkan wrapper atau normalisasi padding:
   - Pilihan A: edit `pos.html` dan bungkus isi `#panel-deposits` dengan `.deposit-page-inner`.
   - Pilihan B: tanpa markup baru, ubah CSS supaya `.deposit-cash-card` dan `.deposit-content-grid` tidak menambah margin horizontal di mobile.

3. Tambahkan helper state di `js/depositUi.js`:
   - `isFormBlocked()`
   - `getBlockedReasonMeta()`
   - `applyFormAvailability()`
   - `renderBlockingAlert()`

4. Panggil `applyFormAvailability()` dari:
   - `refresh()`
   - `updateSummaryCard()`
   - `renderAccounts()`
   - `updateMethodDependentFields()`
   - `updateSubmitState()`
   - `renderSubmitting()`
   - `clearForm()`

5. Tambahkan guard di event handlers:
   - amount input
   - quick amount
   - select account
   - proof zone click/keydown/drop
   - file change
   - submit

6. Ganti cash detection staff:
   - dari `account.type === 'cash'`
   - menjadi `depositService.isCashDepositMethod(account)` dengan fallback jika service belum ada.

7. Update CSS mobile deposit:
   - compact status card
   - responsive meta grid
   - compact quick buttons
   - compact method cards
   - compact upload zone
   - disabled visual state
   - bottom safe area
   - floating tutorial override/hide

8. Verifikasi backend migration:
   - `get_deposit_eligible_sessions`
   - `create_deposit`
   - `admin_create_manual_deposit`
   - trigger `trg_cash_deposits_require_closed_shift`
   - revoke direct DML
   - accumulator nominal hasil `SUM(cd.amount)` harus bertipe `numeric`, bukan `integer`, agar tidak ada cast/truncation/overflow pada nominal setoran.

### 21.2 Suggested JS shape

Tambahkan di `depositUi`:

```js
isFormBlocked() {
  const sess = this.selectedClosedSession;
  return !this.hasEligibleClosedShift()
    || Boolean(sess?.block_reason)
    || this.depositableCash <= 0;
},

canInteractWithForm() {
  return !this.isSubmitting && !this.isFormBlocked();
},

applyFormAvailability() {
  const blocked = this.isFormBlocked();
  const disabled = blocked || this.isSubmitting;

  this.el.amountInput && (this.el.amountInput.disabled = disabled);
  this.el.fileInput && (this.el.fileInput.disabled = disabled);
  this.el.notesInput && (this.el.notesInput.disabled = disabled);

  this.el.amountInput?.closest('.deposit-currency-field')
    ?.classList.toggle('is-disabled', disabled);

  this.el.proofZone?.classList.toggle('is-disabled', disabled);
  this.el.proofZone?.setAttribute('aria-disabled', disabled ? 'true' : 'false');
  this.el.proofZone?.setAttribute('tabindex', disabled ? '-1' : '0');

  this.el.accountOptions?.querySelectorAll('[data-deposit-account-id]').forEach(card => {
    card.classList.toggle('is-disabled', disabled);
    card.setAttribute('aria-disabled', disabled ? 'true' : 'false');
    card.setAttribute('tabindex', disabled ? '-1' : '0');
    const input = card.querySelector('input[type="radio"]');
    if (input) input.disabled = disabled;
  });

  this.el.quickButtons.forEach(btn => { btn.disabled = disabled; });
}
```

Pastikan fungsi di atas tidak menghapus `submitBtn.disabled` dari `updateSubmitState()`. Submit tetap dihitung dengan validasi lengkap.

### 21.3 Suggested CSS target

```css
.deposit-page {
  overflow-x: hidden;
}

.deposit-page-inner {
  width: 100%;
  max-width: 1180px;
  margin: 0 auto;
}

@media (max-width: 768px) {
  .pos-alt-panel.deposit-page {
    padding: 0;
  }

  .deposit-page-inner {
    padding: 12px;
    padding-bottom: calc(128px + max(env(safe-area-inset-bottom, 0px), 16px));
  }

  .deposit-cash-card {
    margin: 0 0 12px;
    padding: 14px;
    border-radius: 8px;
  }

  .deposit-card-amount {
    font-size: 26px;
  }

  .deposit-content-grid {
    padding: 0;
    gap: 12px;
  }

  .deposit-form-card .card-body {
    padding: 16px;
    gap: 16px;
  }

  .deposit-currency-field {
    min-height: 48px;
    border-radius: 8px;
  }

  .deposit-quick-btn {
    min-height: 42px;
    border-radius: 8px;
    font-size: 13px;
  }

  .deposit-method-card {
    min-height: 58px;
    padding: 10px 12px;
    border-radius: 8px;
  }

  .deposit-upload-zone {
    min-height: 88px;
    padding: 12px;
    border-radius: 8px;
  }
}

@media (max-width: 389px) {
  .deposit-card-meta-grid {
    grid-template-columns: 1fr;
  }

  .deposit-quick-grid {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
}
```

### 21.4 Current code risks to fix directly

- `depositUi.updateSubmitState()` currently disables submit and quick buttons, but not all fields. Fix with `applyFormAvailability()`.
- `depositUi.selectAccount()` currently can change selected method even when form should be blocked. Add guard.
- `depositUi.bindUploadZone()` currently opens file picker without checking blocked state. Add guard.
- `depositUi.isProofRequired()` currently checks `account.type !== 'cash'`. Use `depositService.isCashDepositMethod(account)`.
- `.deposit-upload-zone` becomes 140px on mobile; reduce default mobile height.
- `#ob-reopen-btn` has high z-index and fixed position; hide/reposition on deposit tab.
- `.deposit-card-meta-grid` should not stay 3 columns on very small screens.
- Alert blocked should be structured, not one large sentence.

## 22. Risiko Bug dan Cara Mencegahnya

| Risiko | Penyebab | Pencegahan |
|---|---|---|
| Horizontal overflow mobile | Double padding, grid child min-width, rekening panjang | `overflow-x:hidden`, `min-width:0`, `overflow-wrap:anywhere`, single column <= 560px |
| Form tampak disabled tapi masih bisa diklik | Hanya CSS disabled tanpa guard JS | Set property `disabled`, `aria-disabled`, `tabindex=-1`, plus early return di handler |
| Submit bisa dilakukan sebelum shift tertutup | UI bypass/devtools | Service validation, RPC validation, trigger DB |
| Upload proof aktif saat blocked | File input tidak disabled | Disable `#deposit-proof-file` dan guard upload zone |
| Method selected tidak sinkron | Radio, hidden input, class selected tidak update bersama | `selectAccount()` wajib update hidden value, radio checked, class, `aria-checked` |
| Cash tetap wajib bukti karena type tidak persis `cash` | Detection terlalu sempit | Pakai `depositService.isCashDepositMethod(account)` |
| Double submit | Klik cepat atau confirm double click | `isSubmitting`, disable confirm OK, backend lock/unique index |
| Floating tutorial menutupi submit | Fixed z-index tinggi | `body.deposit-tab-active` override/hide dan bottom padding |
| Browser bottom nav menutupi konten | `env()` bernilai 0 di Android Chrome | Gunakan `max(env(...), 16px)` dan padding minimal 128px |
| Keyboard mobile membuat layout pecah | viewport height berubah | Pertahankan `--vh100` existing dan hindari sticky footer di form |
| Card status terlalu tinggi | Amount besar dan alert besar | Compact typography dan alert padding 10-12px |
| Selected border menyebabkan layout shift | Border lebih tebal saat selected | Pakai border thickness sama, ubah color/background saja |
| Text rekening panjang keluar card | `white-space: nowrap` di mobile | Gunakan wrap pada <= 360px dan `overflow-wrap:anywhere` |
| Submit tanpa bukti non-cash | Frontend saja yang cek proof | RPC `create_deposit` wajib cek account type dan proof URL |
| Data dobel karena API direct insert | RLS/grant permissive | Revoke DML, trigger, partial unique index |
| Desktop rusak oleh CSS mobile | Selector terlalu global | Semua perubahan compact mobile masuk media query, desktop override dipertahankan |

Definition of done:

- Semua acceptance criteria lulus.
- Checklist mobile utama lulus minimal di 320px, 360px, 390px, 412px, 768px, dan desktop.
- Tidak ada perubahan flow bisnis di luar guardrail setoran tunai.
- Validasi frontend, service, RPC, dan database tetap konsisten.
