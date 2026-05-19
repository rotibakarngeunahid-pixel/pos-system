# PRD Fix UI Collision Onboarding / Guided Tour Mobile

Tanggal: 2026-05-16
Produk: POS Roti Bakar Ngeunah
Area: POS Staff, Onboarding Guided Tour, Mobile UI
Prioritas: P0
Status: Ready for implementation

## 1. Ringkasan

Onboarding guided tour saat ini sudah muncul, tetapi pada mobile UI banyak elemen saling bertabrakan. Dari screenshot terlihat tooltip onboarding melebar keluar layar, tombol terpotong, pointer tidak selalu menunjuk target dengan benar, highlight membuat garis besar yang mengganggu, dan tour dapat bertabrakan dengan modal POS seperti "Pilih Varian".

PRD ini mendefinisikan perbaikan layout, positioning, z-index, interaction mode, dan step metadata agar onboarding nyaman dipakai di Android Chrome/mobile web tanpa error dan tanpa menabrak modal aplikasi.

## 2. Masalah dari Screenshot

### 2.1 Tooltip Keluar Layar

Pada screenshot pertama, card onboarding berada terlalu ke kanan dan bagian tombol "Lanjut" terpotong. Ini membuat user tidak dapat membaca/mengklik kontrol dengan aman.

Indikasi penyebab:

- `#ob-tooltip` memakai positioning berdasarkan `window.innerWidth` dan `window.innerHeight`.
- Mobile browser punya address bar dan navigation bar yang membuat viewport visual berbeda dari layout viewport.
- CSS mobile hanya mengubah width, tetapi positioning JS tetap bisa menaruh tooltip di luar area visual.

### 2.2 Tooltip Menimpa Konten dan Tidak Punya Safe Area

Tooltip bisa berada terlalu bawah dan mendekati navigation bar Android. Area bawah harus dihitung dengan `visualViewport`, `env(safe-area-inset-bottom)`, dan fallback fixed pixel untuk Android Chrome.

### 2.3 Module Label Tampil Mentah

Screenshot menampilkan `MODUL_1_SHIFT` dan `MODUL_2_PENJUALAN`, bukan label user-friendly seperti "Modul 1 - Shift" atau "Modul 2 - Penjualan".

Indikasi penyebab:

- Step dari database memakai `module_key` seperti `modul_1_shift`.
- `moduleLabel()` di `js/onboarding.js` hanya memetakan key fallback seperti `modul_1_shift_awal`, `modul_3_penjualan`, dan tidak memetakan key database lama.

### 2.4 Step Shift Muncul Saat Shift Sudah Terbuka

Screenshot menampilkan "Buka Shift Sebelum Berjualan" di halaman produk. Step ini seharusnya hanya muncul saat modal shift sedang terbuka atau saat staff memang belum membuka shift.

Indikasi penyebab:

- Step database `m1_open_shift` menunjuk `#btn-open-shift`, tetapi tombol itu hanya ada di `#modal-shift`.
- Jika shift sudah terbuka, step shift harus diskip atau diganti dengan edukasi "Shift sudah aktif".

### 2.5 Tour Bertabrakan dengan Modal Varian

Screenshot ketiga menunjukkan modal "Pilih Varian" terbuka, sementara tooltip onboarding tetap muncul di atasnya. Ini membuat user melihat dua lapisan instruksi yang saling berebut fokus.

Indikasi penyebab:

- Target yang di-highlight tetap bisa diklik ketika tour aktif.
- Onboarding tidak punya modal conflict detector.
- Tidak ada aturan apakah step adalah passive highlight atau guided click.

### 2.6 Pointer dan Highlight Tidak Stabil

Pointer bisa muncul di posisi yang tidak membantu, highlight bisa berupa garis panjang, dan target yang diangkat dengan `z-index` dapat membuat elemen latar terlihat aktif padahal onboarding sedang menutupi layar.

Indikasi penyebab:

- `.ob-target-active` menaikkan target ke `z-index: 9150`.
- `#ob-highlight-box` memakai box-shadow besar.
- Target container seperti grid atau toolbar bisa menghasilkan highlight terlalu besar.

## 3. Tujuan

1. Tooltip onboarding tidak pernah keluar dari viewport mobile.
2. Tombol onboarding selalu terlihat dan bisa diklik.
3. Onboarding tidak bertabrakan dengan modal POS seperti varian, topping, pembayaran, stok, receipt, confirm, dan shift.
4. Step shift hanya muncul di kondisi yang relevan.
5. Label modul tampil rapi dan tidak memakai raw `module_key`.
6. Pointer dan highlight selalu berada di posisi masuk akal.
7. Tour tetap bisa selesai walaupun target selector tidak ditemukan.
8. Tidak ada uncaught JavaScript error selama onboarding.

## 4. Non-Goals

- Tidak mengubah flow transaksi POS.
- Tidak membuat data dummy.
- Tidak menghapus fitur onboarding existing.
- Tidak mengubah desain utama POS di luar kebutuhan collision fix.
- Tidak memaksa staff melakukan checkout live saat tour.

## 5. Scope File

| File | Kebutuhan |
| --- | --- |
| `js/onboarding.js` | Positioning engine mobile, modal conflict detector, interaction mode, module label map, step skip logic |
| `css/styles.css` | Mobile-safe tooltip, bottom sheet mode, safe-area, z-index rules, reduced motion |
| `pos.html` | Cache busting script/CSS setelah perubahan |
| `sql/migrations/021_staff_onboarding.sql` | Audit step seed existing |
| `sql/migrations/022_fix_onboarding_steps.sql` | Audit selector fix existing |
| `sql/migrations/023_fix_onboarding_ui_metadata.sql` | Migration baru jika metadata step perlu disimpan di DB |

## 6. Prinsip UX Wajib

### 6.1 Satu Foreground Fokus

Pada satu waktu hanya boleh ada satu layer utama:

- Onboarding tooltip, atau
- Modal POS, atau
- Completion banner.

Jika modal POS aktif, onboarding harus:

- pause dan hide tooltip, atau
- masuk ke mode modal-aware yang memang menargetkan elemen di dalam modal aktif.

Tidak boleh ada tooltip onboarding menimpa modal POS tanpa desain khusus.

### 6.2 Mobile First

Semua placement onboarding harus didesain untuk viewport minimal:

- 360 x 740 CSS px
- 390 x 844 CSS px
- 412 x 915 CSS px

Tooltip tidak boleh mengandalkan desktop placement. Pada mobile, default placement adalah compact bottom sheet kecuali ada ruang aman di atas/bawah target.

### 6.3 No Forced Live Transaction

Tour boleh memberi instruksi klik, tetapi tidak boleh mendorong user membuat transaksi, stok, kas, void, refund, atau setoran palsu. Step yang membuka modal transaksi harus punya mode khusus atau tetap passive.

## 7. Functional Requirements

### FR-001 - Mobile Viewport Engine

Implementasikan helper viewport yang memakai `window.visualViewport` jika tersedia.

Contoh kontrak:

```js
function getVisualViewportBox() {
  const vv = window.visualViewport;
  return {
    width: vv?.width || window.innerWidth,
    height: vv?.height || window.innerHeight,
    offsetLeft: vv?.offsetLeft || 0,
    offsetTop: vv?.offsetTop || 0,
    safeTop: 12,
    safeRight: 12,
    safeBottom: Math.max(20, getCssSafeAreaBottom()),
    safeLeft: 12,
  };
}
```

Acceptance:

- Tooltip tidak keluar dari viewport pada Android Chrome.
- Saat address bar Chrome berubah tinggi, posisi tooltip tetap benar setelah resize/scroll visual viewport.

### FR-002 - Tooltip Clamp

Semua posisi tooltip wajib melewati clamp:

```js
left = clamp(left, safeLeft, viewport.width - tooltipWidth - safeRight);
top = clamp(top, safeTop, viewport.height - tooltipHeight - safeBottom);
```

Acceptance:

- `#ob-tooltip.getBoundingClientRect().left >= 8`
- `#ob-tooltip.getBoundingClientRect().right <= visualViewport.width - 8`
- `#ob-tooltip.getBoundingClientRect().bottom <= visualViewport.height - 16`

### FR-003 - Bottom Sheet Mode untuk Mobile

Pada viewport `max-width <= 480px`, tooltip harus bisa masuk mode bottom sheet:

Kondisi bottom sheet:

- Target berada di bawah 55% viewport.
- Ruang di atas/bawah target tidak cukup untuk tooltip.
- Ada modal POS aktif.
- Tooltip height melebihi 48% viewport.

Behavior:

- Tooltip fixed di bawah.
- Lebar `calc(100vw - 24px)`.
- `max-height: min(52dvh, 420px)`.
- Body scroll internal.
- Footer sticky di bawah card.
- Bottom menghormati Android nav bar fallback minimal 16px.

Acceptance:

- Tombol `Kembali` dan `Lanjut` tidak terpotong.
- Body text panjang bisa discroll di dalam tooltip.
- Tooltip tidak tertutup browser bottom navigation.

### FR-004 - Header dan Footer Tooltip Anti Overflow

CSS wajib:

```css
#ob-tooltip {
  box-sizing: border-box;
  max-width: calc(100vw - 24px);
}

.ob-tooltip-footer {
  display: grid;
  grid-template-columns: minmax(104px, auto) 1fr;
}

.btn-ob-back,
.btn-ob-next,
.btn-ob-done {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
}
```

Acceptance:

- Tombol tidak melebar keluar card.
- Tidak ada horizontal scroll di halaman saat tour aktif.

### FR-005 - Module Label Map Lengkap

`moduleLabel()` wajib memetakan semua key yang ada di DB dan fallback.

Minimal:

| Key | Label |
| --- | --- |
| `modul_1_shift` | `Modul 1 - Shift` |
| `modul_1_shift_awal` | `Modul 1 - Shift & Kas Awal` |
| `modul_2_tampilan` | `Modul 2 - Tampilan Awal` |
| `modul_2_penjualan` | `Modul 2 - Penjualan` |
| `modul_3_penjualan` | `Modul 3 - Penjualan` |
| `modul_3_stok_otomatis` | `Modul 3 - Stok Otomatis` |
| `modul_4_stok_otomatis` | `Modul 4 - Stok Otomatis` |
| `modul_4_manajemen_stok` | `Modul 4 - Manajemen Stok` |
| `modul_5_stok` | `Modul 5 - Manajemen Stok` |
| `modul_5_riwayat` | `Modul 5 - Riwayat` |
| `modul_6_riwayat` | `Modul 6 - Riwayat & Void` |
| `modul_6_kas` | `Modul 6 - Kas & Setoran` |
| `modul_7_kas` | `Modul 7 - Kas & Setoran` |

Acceptance:

- Tidak ada teks raw seperti `MODUL_1_SHIFT`.
- Label modul maksimal satu baris di mobile; jika terlalu panjang, truncate dengan ellipsis.

### FR-006 - Step Presentation Overrides

Frontend wajib memiliki presentation override per `step_key`, karena database lama hanya menyimpan selector dan konten.

Contoh:

```js
const STEP_UI = {
  m1_open_shift: {
    showWhen: 'shift_closed',
    modalStep: true,
    modalId: 'modal-shift',
    interactionMode: 'guided_action',
    autoAdvanceOnModalClose: 'modal-shift',
  },
  m2_select_product: {
    interactionMode: 'passive',
    preventTargetClick: true,
    placement: 'bottom_sheet',
    targetSelector: '.pcard, #products-grid',
  },
};
```

Acceptance:

- Step shift tidak tampil saat shift sudah terbuka.
- Step produk tidak membuka modal varian kecuali step memang dirancang untuk modal-aware mode.

### FR-007 - Interaction Mode

Setiap step wajib memiliki interaction mode:

| Mode | Behavior |
| --- | --- |
| `passive` | User hanya membaca, target tidak bisa diklik, tombol Next melanjutkan |
| `guided_action` | User harus melakukan aksi tertentu, Next disembunyikan, tour lanjut setelah aksi valid |
| `modal_aware` | Tooltip diposisikan terhadap modal aktif dan tidak menabrak isi modal |
| `center_info` | Tidak ada target, tooltip tampil center/bottom sheet |

Default semua step adalah `passive`.

Acceptance:

- Klik product card saat step passive tidak membuka modal varian.
- Step buka shift tetap bisa klik `#btn-open-shift`.
- Jika modal varian terbuka manual, onboarding pause atau masuk modal-aware.

### FR-008 - Modal Conflict Detector

Tambahkan detector untuk modal aktif:

```js
const BLOCKING_MODALS = [
  'modal-variant-select',
  'modal-topping-select',
  'modal-payment',
  'modal-stock-adjust',
  'modal-close-shift',
  'modal-receipt',
  'modal-pos-trx-detail',
  'modal-confirm',
  'modal-success-trx',
  'modal-transfer-notif',
];
```

Behavior:

- Jika blocking modal aktif dan step bukan `modal_aware`, onboarding pause visual.
- Saat modal tertutup, onboarding resume dan recalculates target.
- Khusus `modal-shift`, onboarding boleh aktif karena memang step awal shift.

Acceptance:

- Tidak ada kondisi tooltip onboarding berada di atas modal varian seperti screenshot ketiga.
- Menutup modal POS mengembalikan tour ke posisi valid.

### FR-009 - Target Click Shield

Untuk step `passive`, target yang di-highlight tidak boleh menerima klik langsung.

Implementasi opsi:

- Overlay shield transparan di atas target.
- Atau jangan naikkan target ke z-index interaktif.
- Atau set class target `pointer-events: none` sementara dan restore setelah step.

Acceptance:

- Saat step "Pilih Produk" passive, tap pada product card tidak membuka modal varian.
- Setelah onboarding ditutup, product card bisa diklik normal lagi.

### FR-010 - Target Visibility Guard

Sebelum highlight, validasi:

- Target ada.
- Target punya ukuran minimal `24 x 24`.
- Target tidak tertutup modal aktif.
- Target berada minimal 40% terlihat di viewport.
- Target bukan elemen hidden atau disabled.

Jika gagal:

- Pakai `center_info` atau bottom sheet.
- Jangan gambar highlight garis panjang.
- Log warning terkendali.

Acceptance:

- Tidak ada highlight berupa garis panjang tanpa card/target jelas.
- Target di dalam modal tertutup tidak di-highlight.

### FR-011 - Better Target untuk Container Besar

Step yang menargetkan container besar harus memakai target lebih spesifik.

Contoh:

| Step | Current | Required |
| --- | --- | --- |
| `m2_select_product` | `#products-grid` | `.pcard:first-of-type` jika ada, fallback `#products-grid` |
| `m2_category_bar` | `#category-bar` | active category chip atau first visible category chip |
| `m3_stock_view` | `#pos-maintab-stock` | tab button tetap boleh |

Acceptance:

- Highlight product step mengelilingi satu product card, bukan seluruh grid.
- Pointer berada dekat card, bukan di garis horizontal atas.

### FR-012 - Z-Index Contract

Tetapkan z-index contract:

| Layer | Z-index |
| --- | --- |
| App base | 0-999 |
| App modal overlay | 1000-1999 |
| Mobile drawer | 1900 |
| Critical app notif | 9500 |
| Onboarding passive overlay | 7000 |
| Onboarding highlight | 7100 |
| Onboarding pointer | 7200 |
| Onboarding tooltip | 7300 |
| Onboarding completion banner | 7600 |

Catatan:

- Onboarding tidak boleh selalu berada di atas semua modal.
- Jika modal POS aktif, onboarding pause atau modal-aware.
- Hindari menaikkan target app ke `z-index` lebih tinggi dari tooltip kecuali target action memang harus diklik.

Acceptance:

- Tidak ada modal POS yang tertutup setengah oleh tooltip onboarding.
- Tidak ada target background yang terlihat clickable di atas scrim kecuali guided action.

### FR-013 - Reduced Motion

Tambahkan CSS:

```css
@media (prefers-reduced-motion: reduce) {
  #ob-highlight-box,
  #ob-pointer,
  #ob-tooltip,
  #ob-entry-panel,
  #ob-complete-banner {
    animation: none !important;
    transition: none !important;
  }
}
```

Acceptance:

- Tour tetap bisa dipakai tanpa animasi.

### FR-014 - Cache Busting

Setelah fix, naikkan versi:

```html
<link rel="stylesheet" href="css/styles.css?v=20260516-onboarding-ui-collision-1" />
<script src="js/onboarding.js?v=20260516-onboarding-ui-collision-1"></script>
<script src="js/pos.js?v=20260516-onboarding-ui-collision-1"></script>
```

Acceptance:

- Browser mobile tidak memakai CSS/JS lama.

## 8. Design Requirements

### 8.1 Mobile Tooltip Layout

Ukuran:

- Width: `min(360px, visualViewport.width - 24px)`
- Bottom sheet width: `visualViewport.width - 24px`
- Border radius: 16px top/bottom untuk floating, 18px untuk bottom sheet.
- Max height: `min(52dvh, 420px)`.
- Body line height: 1.55 sampai 1.65.
- Header height compact: 44px max.

Footer:

- Back button min width 104px.
- Next button mengambil sisa lebar.
- Gap 10px.
- Footer sticky jika body scroll.

### 8.2 Pointer

Pointer hanya tampil jika:

- Target valid.
- Target visible.
- Tooltip tidak menutupi target sepenuhnya.
- Step bukan center/bottom sheet tanpa target.

Jika target berada dekat top browser chrome atau bawah nav:

- Sembunyikan pointer.
- Gunakan highlight saja.

### 8.3 Highlight

Highlight:

- Tidak boleh lebih lebar dari viewport minus 24px.
- Tidak boleh lebih tinggi dari 45% viewport.
- Untuk target container besar, highlight target child.
- Jika target rect invalid, jangan render highlight.

## 9. Data / Migration Requirements

### DB-001 - Optional Presentation Metadata

Jika metadata disimpan di database, buat migration:

`sql/migrations/023_fix_onboarding_ui_metadata.sql`

Tambahkan kolom:

```sql
ALTER TABLE onboarding_steps
  ADD COLUMN IF NOT EXISTS ui_config JSONB NOT NULL DEFAULT '{}'::jsonb;
```

Isi minimal:

```json
{
  "interaction_mode": "passive",
  "placement": "auto",
  "show_when": "always",
  "prevent_target_click": true
}
```

Untuk `m1_open_shift`:

```json
{
  "interaction_mode": "guided_action",
  "placement": "modal",
  "show_when": "shift_closed",
  "modal_id": "modal-shift",
  "auto_advance_on_modal_close": "modal-shift"
}
```

Acceptance:

- Migration idempotent.
- Existing data tidak rusak.
- Jika kolom belum ada, frontend tetap punya fallback override map.

### DB-002 - Normalize Module Key atau Frontend Alias

Pilih salah satu:

1. Update DB module key agar konsisten dengan frontend, atau
2. Tambah alias map di frontend.

Rekomendasi MVP: gunakan alias map di frontend agar aman dan tidak mengubah progress existing.

## 10. Acceptance Criteria

### AC-001 - Tooltip Tidak Terpotong di Mobile

Given user membuka POS di Android Chrome viewport 360x740
When onboarding step apa pun tampil
Then seluruh tooltip berada di viewport
And tombol `Kembali` dan `Lanjut` terlihat penuh
And tidak ada horizontal scroll.

### AC-002 - Module Label Rapi

Given step dari DB memakai `module_key = 'modul_1_shift'`
When tooltip render
Then header menampilkan `Modul 1 - Shift`
And tidak menampilkan `MODUL_1_SHIFT`.

### AC-003 - Shift Step Tidak Salah Kondisi

Given shift sudah aktif
When onboarding dimulai
Then step membuka shift tidak tampil sebagai action utama
And tour mulai dari step non-shift yang relevan.

### AC-004 - Modal Varian Tidak Tabrakan

Given onboarding sedang di step pilih produk
When user tap product card
Then jika step passive, modal varian tidak terbuka
Or jika step guided action, tooltip pindah ke mode modal-aware dan tidak menimpa modal
And tidak ada dua panel yang saling menutupi.

### AC-005 - Modal POS Pause Tour

Given modal POS aktif
When onboarding bukan step modal-aware
Then onboarding tooltip dan highlight pause/hide
And resume setelah modal tertutup.

### AC-006 - Highlight Valid

Given target selector menunjuk container besar atau target offscreen
When step render
Then sistem memilih child target yang valid atau fallback center_info
And tidak ada highlight garis panjang.

### AC-007 - No Console Error

Selama test onboarding:

- Tidak ada `ReferenceError`.
- Tidak ada `TypeError` uncaught.
- Tidak ada `Cannot read properties of null`.
- Tidak ada error `querySelector`.
- Warning selector missing diperbolehkan jika fallback jalan.

## 11. Test Plan

### 11.1 Device / Viewport

Test minimal:

- Android Chrome real device.
- Chrome DevTools 360x740.
- Chrome DevTools 390x844.
- Chrome DevTools 412x915.
- Desktop 1366x768 untuk regression.

### 11.2 Scenario Test

1. Login staff baru tanpa shift aktif.
2. Pastikan modal shift dan onboarding tidak tabrakan.
3. Isi kas awal.
4. Buka shift.
5. Lanjutkan step sampai header staff.
6. Pastikan module label rapi.
7. Lanjutkan sampai product search.
8. Lanjutkan sampai category bar.
9. Lanjutkan sampai pilih produk.
10. Tap product card.
11. Pastikan tidak ada modal varian yang menimpa tooltip dalam passive mode.
12. Lanjutkan sampai step cart/payment.
13. Pastikan tooltip tidak keluar layar.
14. Buka modal payment manual lalu cek onboarding pause.
15. Tutup modal payment lalu cek onboarding resume.
16. Selesaikan onboarding.
17. Login ulang dan pastikan onboarding tidak muncul lagi.

### 11.3 Visual Assertions

Di setiap step:

```js
const r = document.getElementById('ob-tooltip').getBoundingClientRect();
console.assert(r.left >= 8);
console.assert(r.right <= window.innerWidth - 8);
console.assert(r.top >= 8);
console.assert(r.bottom <= window.innerHeight - 8);
```

Untuk visualViewport:

```js
const vv = window.visualViewport;
const r = document.getElementById('ob-tooltip').getBoundingClientRect();
console.assert(r.right <= vv.width - 8);
console.assert(r.bottom <= vv.height - 16);
```

### 11.4 Regression POS

Setelah onboarding ditutup:

1. Klik product card.
2. Pilih varian.
3. Tambahkan ke cart.
4. Buka cart.
5. Checkout transaksi valid.
6. Pastikan modal dan tombol POS normal.

Expected:

- Pointer-events yang dimodifikasi onboarding sudah direstore.
- Tidak ada class `.ob-target-active` tertinggal.
- Tidak ada overlay onboarding invisible yang memblokir POS.

## 12. Implementation Plan

1. Tambah alias `moduleLabel()` lengkap.
2. Tambah `STEP_UI` override per step.
3. Tambah `getVisualViewportBox()` dan `clampTooltip()`.
4. Refactor `positionTooltipNearTarget()` agar mobile-aware.
5. Tambah bottom sheet placement.
6. Tambah modal conflict detector.
7. Tambah passive target click shield.
8. Tambah target visibility guard.
9. Update CSS tooltip mobile, footer grid, safe-area, reduced motion.
10. Naikkan cache-busting di `pos.html`.
11. Jalankan manual mobile test dan console test.

## 13. Definition of Done

Perbaikan dianggap selesai jika:

1. Semua screenshot issue dalam dokumen ini tidak bisa direproduksi.
2. Tooltip tidak pernah keluar viewport di mobile.
3. Tidak ada module key mentah.
4. Step shift hanya tampil saat relevan.
5. Product variant modal tidak bertabrakan dengan onboarding.
6. Highlight dan pointer valid di semua step.
7. POS normal setelah onboarding ditutup.
8. Tidak ada uncaught JS error.
9. Browser mobile mengambil versi CSS/JS terbaru.

## 14. Release Checklist

- [ ] `js/onboarding.js` punya viewport engine.
- [ ] `js/onboarding.js` punya module alias map lengkap.
- [ ] `js/onboarding.js` punya step UI override.
- [ ] `js/onboarding.js` punya modal conflict detector.
- [ ] `css/styles.css` punya mobile bottom sheet dan footer anti-overflow.
- [ ] `css/styles.css` punya reduced motion.
- [ ] `pos.html` version query dinaikkan.
- [ ] Test Android Chrome real device lulus.
- [ ] Test 360x740 lulus.
- [ ] Test modal varian lulus.
- [ ] Test console error lulus.
- [ ] Test transaksi normal setelah onboarding lulus.

## 15. Catatan Anti-Gagal

Prioritas implementasi harus dimulai dari collision yang terlihat di screenshot:

1. Clamp tooltip ke visual viewport.
2. Bottom sheet mode untuk mobile.
3. Jangan biarkan passive step membuka modal POS.
4. Pause onboarding saat modal POS aktif.
5. Map semua module key DB agar header rapi.

Jangan hanya menaikkan z-index. Z-index lebih tinggi akan membuat masalah screenshot ketiga semakin buruk karena tooltip tetap menimpa modal varian. Solusi yang benar adalah satu foreground fokus, modal-aware mode, dan passive click shield.
