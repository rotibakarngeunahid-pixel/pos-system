# PRD Fix Onboarding Action, Target, Pointer, and State Mismatch

Tanggal: 2026-05-16
Produk: POS Roti Bakar Ngeunah
Area: POS Staff, Onboarding Guided Tour, Mobile UX
Prioritas: P0
Status: Ready for implementation

## 1. Ringkasan

Onboarding saat ini masih memberi instruksi yang tidak sesuai dengan kondisi UI. Contoh dari screenshot:

- Pointer menunjuk ke area kategori `Lainnya`, tetapi highlight ada di kartu produk.
- Tooltip menyuruh user "Klik kartu produk untuk menambahkannya ke keranjang", tetapi kartu tidak bisa diklik karena step bersifat passive / click dicegah.
- Setelah user klik `Lanjut`, tour masuk ke instruksi keranjang, padahal produk belum masuk ke cart dan tombol keranjang tidak muncul.

PRD ini mendefinisikan perbaikan agar setiap step onboarding memenuhi aturan: pointer harus menunjuk target yang sama dengan highlight, instruksi harus sesuai dengan mode interaksi, dan step berikutnya hanya boleh tampil jika state aplikasi memenuhi prasyarat.

## 2. Masalah yang Harus Diperbaiki

### 2.1 Pointer Tidak Menunjuk Target Highlight

Pada screenshot, kartu `Roti Bakar Coklat` di-highlight, tetapi pointer berada di atas chip kategori `Lainnya`. Ini membuat user bingung harus klik apa.

Penyebab yang harus dicegah:

- Pointer memakai rect lama atau target berbeda dari highlight.
- Target berubah setelah scroll / layout shift, tetapi pointer tidak dihitung ulang.
- Selector awal `#products-grid` diganti ke child `.pcard`, tetapi pointer masih memakai posisi selector/container lain.

### 2.2 Instruksi Menyuruh Klik, Tetapi Klik Tidak Bisa

Step "Pilih Produk" menyuruh klik kartu produk, tetapi onboarding mencegah target click. Ini tidak boleh terjadi.

Rule wajib:

- Jika teks menyuruh "klik", target harus benar-benar bisa diklik.
- Jika target tidak boleh diklik, teks harus bersifat informatif dan tombol utama harus "Lanjut", bukan menyuruh user melakukan aksi.

### 2.3 Tour Lanjut ke Keranjang Tanpa Item

Step berikutnya menjelaskan keranjang, tetapi cart kosong. Di POS saat ini `#fab-cart-btn` hanya tampil jika `cart count > 0`. Jika produk belum ditambahkan, step keranjang tidak punya target valid.

Rule wajib:

- Step `m2_open_cart` hanya boleh tampil jika cart count lebih dari 0 dan `#fab-cart-btn` terlihat.
- Jika cart masih kosong, tour harus tetap di flow tambah produk atau mengubah copy menjadi penjelasan bahwa keranjang akan muncul setelah produk dipilih.

## 3. Tujuan

1. Pointer, highlight, dan tooltip selalu memakai target yang sama.
2. Tidak ada instruksi klik pada step yang memblokir klik.
3. Step yang membutuhkan state tertentu tidak boleh muncul sebelum state itu terpenuhi.
4. Flow pilih produk harus jelas: passive info atau guided action, tidak campur.
5. Flow keranjang hanya muncul setelah cart benar-benar berisi item.
6. Variant/topping modal tidak bertabrakan dengan onboarding.
7. Tidak ada uncaught JavaScript error selama tour.

## 4. Non-Goals

- Tidak membuat transaksi dummy.
- Tidak otomatis checkout.
- Tidak otomatis menambahkan produk tanpa aksi user.
- Tidak mengubah bisnis proses POS.
- Tidak menyembunyikan bug dengan hanya menaikkan z-index.

## 5. Bukti dari Codebase

Temuan implementasi saat ini:

- Product card memakai `.pcard` dengan `data-action="select-product"` dan kliknya diproses oleh `POS.selectProduct(...)`.
- Jika produk punya lebih dari satu varian, `POS.selectProduct(...)` membuka `#modal-variant-select`.
- Cart FAB `#fab-cart-btn` hanya diberi class `.show` jika cart count lebih dari 0, cart view belum terbuka, dan panel kasir terlihat.
- Onboarding step `m2_select_product` masih memiliki teks "Klik kartu produk..." tetapi ada konfigurasi yang mencegah target click.
- Step `m2_open_cart` menargetkan `#fab-cart-btn`, tetapi target itu tidak akan terlihat jika produk belum benar-benar masuk cart.

## 6. Prinsip Produk

### 6.1 No False Instruction

Onboarding tidak boleh memberi instruksi yang tidak bisa dilakukan user.

Contoh yang dilarang:

- "Klik kartu produk" tetapi kartu tidak bisa diklik.
- "Buka keranjang" tetapi tombol keranjang tidak ada.
- Pointer menunjuk kategori, tetapi teks membahas kartu produk.

### 6.2 State-Gated Tour

Setiap step wajib punya prasyarat state. Step hanya boleh tampil jika prasyaratnya benar.

Contoh:

- Step pilih produk butuh minimal satu `.pcard` visible.
- Step buka keranjang butuh `POS.cart.length > 0` atau badge cart count > 0.
- Step payment butuh cart view terbuka atau cart berisi item.

### 6.3 Action Mode Harus Eksplisit

Setiap step harus jelas apakah:

- hanya menjelaskan UI, atau
- meminta user melakukan aksi nyata.

Tidak boleh ada step passive yang memakai copy guided action.

## 7. Functional Requirements

### FR-001 - Single Target Resolver

Onboarding wajib memakai satu resolver target untuk highlight, pointer, tooltip placement, click shield, dan action listener.

Kontrak:

```js
function resolveStepTarget(step) {
  return {
    element,
    selector,
    rect,
    isVisible,
    reason,
  };
}
```

Semua fungsi ini harus menerima hasil resolver yang sama:

- `positionSpotlight(resolvedTarget)`
- `showPointer(resolvedTarget)`
- `positionTooltip(resolvedTarget)`
- `installClickShield(resolvedTarget)`
- `waitForGuidedAction(resolvedTarget)`

Acceptance:

- Pointer tidak boleh menunjuk elemen berbeda dari highlight.
- Jika kartu produk yang di-highlight, pointer harus berada dalam atau dekat bounding box kartu produk.

### FR-002 - Pointer Alignment Validation

Setelah pointer diposisikan, sistem wajib validasi bahwa pointer dekat target.

Aturan:

- Anchor pointer harus berada di dalam rect target atau maksimal 16px dari rect target.
- Jika target terlalu dekat edge layar, pointer boleh disembunyikan.
- Pointer tidak boleh muncul di atas elemen lain yang tidak terkait.

Acceptance:

```js
const target = document.querySelector('.ob-target-active');
const pointer = document.getElementById('ob-pointer');
// pointer anchor must be visually near target rect, not category chip.
```

Manual expected:

- Pada step "Pilih Produk", pointer menunjuk kartu produk yang sama dengan highlight, bukan chip kategori.

### FR-003 - Interaction Mode Contract

Setiap step wajib punya `interaction_mode`.

| Mode | Copy yang boleh | Behavior |
| --- | --- | --- |
| `info` | "Ini adalah..." / "Gunakan..." | Target tidak perlu diklik, tombol `Lanjut` aktif |
| `guided_click` | "Klik..." | Target wajib bisa diklik, tombol `Lanjut` disembunyikan atau disabled sampai aksi selesai |
| `guided_modal` | "Pilih..." di modal | Tour mengikuti modal aktif dan menunggu pilihan valid |
| `state_info` | "Keranjang akan muncul..." | Dipakai jika state belum terpenuhi |

Acceptance:

- Step dengan kata "Klik" harus `guided_click` atau `guided_modal`.
- Step `info` tidak boleh memakai copy yang menyuruh klik.

### FR-004 - Perbaiki Step `m2_select_product`

Pilih salah satu desain MVP. Rekomendasi: `guided_click`.

#### Opsi A - Guided Click (Recommended)

Step `m2_select_product`:

- Target: first visible `.pcard:not(.out-of-stock)`.
- Mode: `guided_click`.
- Copy: "Klik kartu produk yang disorot untuk memilih produk."
- Tombol `Lanjut` disembunyikan atau disabled.
- Klik pada kartu produk harus diteruskan ke POS.
- Jika produk punya varian, tour masuk ke step `m2_select_variant`.
- Jika produk hanya punya satu varian dan tidak perlu topping, setelah `addToCart` berhasil tour lanjut ke `m2_open_cart`.

Acceptance:

- User bisa tap kartu produk yang di-highlight.
- Modal varian terbuka jika produk punya varian.
- Tour tidak lanjut ke keranjang sebelum item masuk cart.

#### Opsi B - Info Only

Step `m2_select_product`:

- Target: first visible `.pcard`.
- Mode: `info`.
- Copy: "Ini adalah kartu produk. Saat berjualan, tap kartu seperti ini untuk memilih produk."
- Klik target dicegah.
- Step berikutnya tidak boleh `m2_open_cart`; harus masuk ke step info "Keranjang muncul setelah produk ditambahkan" atau skip cart flow.

Acceptance:

- Tidak ada copy "Klik kartu produk".
- Step berikutnya tidak mengklaim keranjang ada.

### FR-005 - Tambah Step Variant Modal Jika Guided Click

Jika Opsi A dipilih, tambahkan step:

| Step Key | Target | Mode | Tujuan |
| --- | --- | --- | --- |
| `m2_select_variant` | `#modal-variant-select .variant-select-btn:first-of-type` | `guided_modal` | Staff memilih varian |
| `m2_select_topping` | `#modal-topping-select [data-action="confirm-topping-select"]` atau skip | `guided_modal` | Staff memahami topping jika muncul |

Behavior:

- Saat modal varian terbuka, tooltip harus pindah ke modal.
- Tidak boleh ada tooltip lama di atas product grid.
- Tombol `Lanjut` disabled sampai variant dipilih.
- Setelah variant/topping selesai dan `cart count > 0`, lanjut ke step cart.

Acceptance:

- Modal varian dan onboarding tidak tumpang tindih.
- Setelah pilih varian, item masuk cart.
- Cart FAB muncul.

### FR-006 - Cart Step Harus State-Gated

Step `m2_open_cart` hanya render jika:

```js
const cartCount = POS?.cart?.reduce((sum, item) => sum + item.quantity, 0) || 0;
const fab = document.getElementById('fab-cart-btn');
const fabVisible = fab && fab.classList.contains('show') && fab.offsetParent !== null;
return cartCount > 0 && fabVisible;
```

Jika syarat gagal:

- Jangan render step keranjang.
- Jika flow guided click belum selesai, kembali ke step pilih produk.
- Jika flow info-only, tampilkan copy "Keranjang akan muncul setelah produk ditambahkan saat transaksi."

Acceptance:

- Tidak ada instruksi "Buka Keranjang" saat `#fab-cart-btn` tidak visible.
- Tidak ada pointer ke lokasi kosong.

### FR-007 - Step Precondition Engine

Tambahkan engine:

```js
const STEP_PRECONDITIONS = {
  m2_select_product: () => document.querySelectorAll('.pcard:not(.out-of-stock)').length > 0,
  m2_open_cart: () => getCartCount() > 0 && isVisible(document.getElementById('fab-cart-btn')),
  m2_discount: () => getCartCount() > 0,
  m2_payment: () => getCartCount() > 0,
  m2_checkout: () => getCartCount() > 0,
};
```

Jika precondition gagal:

- Skip step jika optional/info.
- Atau block dengan instruction yang benar jika step required.

Acceptance:

- Tour tidak pernah menampilkan target yang tidak ada atau tidak visible.
- Step payment/checkout tidak muncul saat cart kosong.

### FR-008 - POS Event Hooks untuk Onboarding

POS perlu mengirim event agar onboarding tidak polling terus.

Tambahkan event:

```js
window.dispatchEvent(new CustomEvent('rbn:product:selected', { detail: { productId } }));
window.dispatchEvent(new CustomEvent('rbn:variant:selected', { detail: { variantId, productId } }));
window.dispatchEvent(new CustomEvent('rbn:cart:changed', { detail: { count, total } }));
window.dispatchEvent(new CustomEvent('rbn:modal:opened', { detail: { id: modalId } }));
window.dispatchEvent(new CustomEvent('rbn:modal:closed', { detail: { id: modalId } }));
```

Acceptance:

- Onboarding bisa menunggu event `rbn:cart:changed` count > 0 sebelum lanjut.
- Tidak ada race condition antara click product, modal variant, dan cart FAB.

### FR-009 - Next Button Rules

Rules:

- Step `info`: `Lanjut` aktif.
- Step `guided_click`: `Lanjut` hidden atau disabled dengan label "Klik area yang disorot".
- Step `guided_modal`: `Lanjut` hidden atau disabled dengan label "Pilih varian dulu".
- Step dengan precondition gagal: jangan tampilkan `Lanjut` ke step yang tidak valid.

Acceptance:

- User tidak bisa klik `Lanjut` dari product step lalu melihat keranjang kosong.

### FR-010 - Copy Review Semua Step Penjualan

Copy harus disesuaikan dengan mode.

Jika `m2_select_product` guided:

```text
Klik kartu produk yang disorot. Jika produk punya varian, pilih salah satu varian pada langkah berikutnya.
```

Jika info-only:

```text
Ini adalah kartu produk. Saat transaksi berlangsung, tap kartu seperti ini untuk memilih produk dan memasukkannya ke keranjang.
```

Step `m2_open_cart`:

```text
Keranjang muncul setelah ada item. Tap tombol keranjang untuk melihat pesanan, mengubah qty, atau menghapus item.
```

Acceptance:

- Copy tidak menjanjikan sesuatu yang belum ada di layar.
- Copy tidak menyuruh klik jika click target diblokir.

## 8. UX Flow Rekomendasi

Gunakan guided flow berikut:

1. `m2_product_search` - info.
2. `m2_category_bar` - info, bukan wajib klik.
3. `m2_select_product` - guided_click ke first visible product card.
4. Jika variant modal muncul: `m2_select_variant` - guided_modal.
5. Jika topping modal muncul: `m2_select_topping` - guided_modal atau allow skip.
6. Tunggu `cart count > 0`.
7. `m2_open_cart` - guided_click ke `#fab-cart-btn`.
8. Setelah cart view terbuka, baru jelaskan discount/payment/checkout dengan target yang ada di cart/payment view.

## 9. Acceptance Criteria

### AC-001 - Pointer Sesuai Highlight

Given step "Pilih Produk" tampil
When kartu produk `Roti Bakar Coklat` di-highlight
Then pointer harus menunjuk kartu tersebut
And pointer tidak boleh menunjuk chip kategori `Lainnya`.

### AC-002 - Instruksi Klik Bisa Dilakukan

Given tooltip berkata "Klik kartu produk"
When user tap kartu yang di-highlight
Then POS menerima klik tersebut
And modal varian terbuka atau item masuk cart.

### AC-003 - Lanjut Tidak Membawa ke Keranjang Kosong

Given cart count masih 0
When user berada di step pilih produk
Then tombol `Lanjut` tidak boleh membawa user ke step `m2_open_cart`
And step keranjang tidak tampil sebelum cart berisi item.

### AC-004 - Keranjang Hanya Jika Visible

Given cart count > 0
And `#fab-cart-btn` visible
When step `m2_open_cart` tampil
Then pointer dan highlight menunjuk `#fab-cart-btn`
And tap tombol membuka cart view.

### AC-005 - Variant Modal Tidak Bentrok

Given produk punya 2 varian
When user tap kartu produk saat guided step
Then modal varian terbuka
And onboarding berpindah ke modal-aware step
And tooltip tidak menutupi pilihan varian secara tidak bisa digunakan.

### AC-006 - No False Copy

Given step bersifat info/passive
When tooltip tampil
Then teks tidak memakai instruksi "klik", "tap", atau "pilih sekarang".

### AC-007 - No Runtime Error

Selama flow penjualan onboarding:

- Tidak ada `TypeError` uncaught.
- Tidak ada `Cannot read properties of null`.
- Tidak ada pointer tertinggal di target lama.
- Tidak ada `.ob-target-active` tertinggal setelah step berubah.

## 10. Test Plan

### 10.1 Manual Mobile Test

1. Login staff baru atau reset onboarding progress.
2. Buka shift.
3. Jalankan tour sampai step "Pilih Produk".
4. Pastikan highlight dan pointer berada di kartu produk yang sama.
5. Tap kartu produk yang disorot.
6. Jika modal varian muncul, pilih varian.
7. Jika topping muncul, pilih atau skip sesuai flow.
8. Pastikan cart count menjadi lebih dari 0.
9. Pastikan cart FAB muncul.
10. Pastikan step keranjang baru tampil setelah cart FAB muncul.
11. Tap cart FAB.
12. Pastikan cart view terbuka dan instruksi berikutnya sesuai elemen yang terlihat.

### 10.2 Empty Cart Guard Test

1. Reset cart ke kosong.
2. Paksa tour ke step `m2_open_cart`.
3. Expected: step tidak render sebagai target keranjang.
4. Expected: tour kembali ke pilih produk atau menampilkan info bahwa keranjang muncul setelah produk ditambahkan.

### 10.3 Pointer Regression Test

Di setiap step dengan target:

```js
const active = document.querySelector('.ob-target-active');
const pointer = document.getElementById('ob-pointer');
const ar = active?.getBoundingClientRect();
const pr = pointer?.getBoundingClientRect();
console.assert(active && ar.width > 0 && ar.height > 0);
console.assert(!pointer.classList.contains('visible') || (
  pr.left <= ar.right + 24 &&
  pr.right >= ar.left - 24 &&
  pr.top <= ar.bottom + 24 &&
  pr.bottom >= ar.top - 48
));
```

### 10.4 Copy Contract Test

Audit semua step:

- Jika body mengandung `Klik`, `Tap`, `Pilih`, atau `Tekan`, mode harus `guided_click` atau `guided_modal`.
- Jika mode `info`, copy tidak boleh berisi instruksi aksi langsung.

## 11. Implementation Plan

1. Buat `resolveStepTarget()` sebagai single source untuk pointer/highlight/tooltip.
2. Tambah `interaction_mode` dan `precondition` per step.
3. Ubah `m2_select_product` menjadi guided_click atau ubah copy menjadi info-only.
4. Tambah event hooks POS untuk product selected, variant selected, cart changed, modal opened/closed.
5. Tambah step modal-aware untuk variant/topping jika memakai guided_click.
6. Gate `m2_open_cart`, `m2_discount`, `m2_payment`, dan `m2_checkout` berdasarkan cart count.
7. Update copy step penjualan.
8. Pastikan pointer dihitung ulang setelah scroll, resize, modal open/close, dan image load.
9. Naikkan cache busting di `pos.html`.
10. Jalankan manual test mobile.

## 12. Definition of Done

Fitur dianggap selesai jika:

1. Pointer selalu sesuai target highlight.
2. Tidak ada instruksi klik yang tidak bisa diklik.
3. Step keranjang tidak muncul saat cart kosong.
4. Product guided flow berhasil sampai cart FAB muncul.
5. Variant modal terintegrasi dengan onboarding tanpa tabrakan.
6. Semua copy sesuai mode interaksi.
7. Tidak ada uncaught JS error.
8. POS normal setelah onboarding ditutup.

## 13. Release Checklist

- [ ] `m2_select_product` mode dan copy sudah konsisten.
- [ ] `m2_open_cart` punya precondition cart count > 0.
- [ ] Pointer dan highlight memakai target resolver yang sama.
- [ ] Guided click product benar-benar men-trigger POS.
- [ ] Variant modal masuk modal-aware mode.
- [ ] Cart FAB baru dijelaskan saat visible.
- [ ] Copy semua step penjualan sudah diaudit.
- [ ] Test mobile 360x740 lulus.
- [ ] Test Android real device lulus.
- [ ] Console error test lulus.
- [ ] Cache busting dinaikkan.

## 14. Catatan Anti-Gagal

Jangan hanya mengganti posisi pointer secara manual. Masalah dasarnya adalah mismatch antara instruction, target, dan state. Solusi wajib mengikat tiga hal ini:

1. Apa yang dikatakan tooltip.
2. Elemen mana yang di-highlight dan ditunjuk pointer.
3. State POS apa yang harus benar sebelum step berikutnya muncul.

Jika salah satu tidak sinkron, onboarding akan tetap membingungkan walaupun tampilannya terlihat rapi.
