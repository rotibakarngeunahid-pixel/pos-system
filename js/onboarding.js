'use strict';

const Onboarding = (() => {

  // ── State ─────────────────────────────────────────────────────
  let _user          = null;
  let _assignment    = null;
  let _steps         = [];
  let _currentIdx    = 0;
  let _saving        = false;
  let _dismissed     = false;
  let _highlightEl   = null;
  let _transitioning = false;
  let _resizeTimer   = null;
  let _localMode     = false;
  let _autoAdvanceTimer = null; // clearable timer for auto-advance on modal close

  // ── Storage keys ──────────────────────────────────────────────
  const DONE = uid => `ob_done_${uid}`;
  const PROG = uid => `ob_prog_${uid}`;
  const PEND = uid => `ob_pend_${uid}`;

  // ── Check if shift modal is currently open ────────────────────
  const shiftModalOpen = () => {
    const el = document.getElementById('modal-shift');
    return el && el.classList.contains('active');
  };

  // ── Hardcoded steps ───────────────────────────────────────────
  // modal_step: true   → no scrim / no spotlight; pointer floats above modal
  //                       (modal-shift is at z-index 1000; pointer/tooltip are 9250/9300)
  // auto_advance: id   → hide Next button; auto-advance when that modal closes
  const FALLBACK_STEPS = [

    // ── Modul 1: Buka Shift & Kas Awal ────────────────────────
    { step_key:'m0_welcome', module_key:'modul_1_shift_awal', sequence:1,
      target_selector: null, modal_step: true,
      title: '👋 Selamat Datang di POS!',
      body:  'Halo! Tutorial ini akan memandu Anda dari awal hingga siap berjualan. ' +
             'Langkah pertama: kita akan membuka shift dan mengisi kas awal bersama-sama. Klik Lanjut untuk mulai.',
      is_required: true },

    { step_key:'m0_kas_awal', module_key:'modul_1_shift_awal', sequence:2,
      target_selector: '#shift-opening-cash', modal_step: true,
      title: '💰 Apa itu Kas Awal?',
      body:  'Kas Awal adalah uang tunai yang ada di laci kasir saat Anda mulai bertugas. ' +
             'Caranya: hitung semua uang fisik di laci kasir, lalu ketik jumlahnya di sini. ' +
             'Jika laci kosong atau Anda tidak yakin, isi dengan 0.',
      is_required: true },

    { step_key:'m0_open_shift', module_key:'modul_1_shift_awal', sequence:3,
      target_selector: '#btn-open-shift', modal_step: true, auto_advance: 'modal-shift',
      title: '🕐 Buka Shift Sekarang',
      body:  'Setelah mengisi kas awal, klik tombol ini untuk membuka shift. ' +
             'Tanpa shift aktif Anda tidak bisa memproses pembayaran. ' +
             'Tutorial akan otomatis lanjut setelah shift terbuka.',
      is_required: true },

    // ── Modul 2: Tampilan Awal ─────────────────────────────────
    { step_key:'m1_staff_name', module_key:'modul_2_tampilan', sequence:4,
      target_selector: '#header-staff-name',
      title: '👤 Nama Anda di Header',
      body:  'Nama Anda ditampilkan di sini sebagai tanda sudah login. ' +
             'Pastikan nama yang tampil sudah benar sebelum mulai bertugas.',
      is_required: true },

    { step_key:'m1_branch_name', module_key:'modul_2_tampilan', sequence:5,
      target_selector: '#header-branch-name',
      title: '🏪 Cabang Aktif',
      body:  'Ini adalah cabang tempat Anda bertugas hari ini. ' +
             'Semua transaksi, stok, dan kas akan dicatat di cabang ini.',
      is_required: true },

    // ── Modul 3: Penjualan ─────────────────────────────────────
    { step_key:'m2_product_search', module_key:'modul_3_penjualan', sequence:6,
      target_selector: '#product-search',
      title: '🔍 Cari Produk',
      body:  'Ketik nama produk di kotak pencarian ini untuk menemukan produk dengan cepat. ' +
             'Berguna saat pelanggan langsung menyebut nama produk.',
      is_required: true },

    { step_key:'m2_category_bar', module_key:'modul_3_penjualan', sequence:7,
      target_selector: '#category-bar',
      title: '📂 Filter Kategori',
      body:  'Klik salah satu kategori untuk menyaring produk berdasarkan jenisnya. ' +
             'Pilih "Semua" untuk melihat semua produk kembali.',
      is_required: true },

    { step_key:'m2_select_product', module_key:'modul_3_penjualan', sequence:8,
      target_selector: '#products-grid',
      title: '🛒 Pilih Produk',
      body:  'Klik kartu produk untuk menambahkannya ke keranjang. ' +
             'Jika produk punya varian (ukuran/rasa), sistem akan meminta Anda memilih varian terlebih dahulu.',
      is_required: true },

    { step_key:'m2_open_cart', module_key:'modul_3_penjualan', sequence:9,
      target_selector: '#fab-cart-btn',
      title: '🛍️ Buka Keranjang',
      body:  'Tombol ini menampilkan keranjang belanja. ' +
             'Angka di atasnya menunjukkan jumlah item. ' +
             'Klik untuk melihat detail pesanan, mengubah qty, atau menghapus item.',
      is_required: true },

    { step_key:'m2_discount', module_key:'modul_3_penjualan', sequence:10,
      target_selector: '#fab-cart-btn',
      title: '🏷️ Terapkan Diskon',
      body:  'Di halaman pembayaran (buka keranjang terlebih dahulu), Anda bisa memberikan diskon persentase atau nominal. ' +
             'Pilih jenis diskon, masukkan nilai, lalu klik Terapkan.',
      is_required: true },

    { step_key:'m2_payment', module_key:'modul_3_penjualan', sequence:11,
      target_selector: '#fab-cart-btn',
      title: '💳 Pilih Metode Pembayaran',
      body:  'Pilih metode pembayaran: Tunai, QRIS, atau Transfer Bank. ' +
             'Untuk tunai, masukkan uang yang diterima agar sistem menghitung kembalian otomatis.',
      is_required: true },

    { step_key:'m2_checkout', module_key:'modul_3_penjualan', sequence:12,
      target_selector: '#fab-cart-btn',
      title: '✅ Konfirmasi Pembayaran',
      body:  'Setelah semua dipilih, klik "Bayar" untuk menyelesaikan transaksi. ' +
             'Sistem akan menyimpan transaksi, mengurangi stok bahan sesuai resep, dan mencatat ke kas.',
      is_required: true },

    // ── Modul 4: Stok Otomatis ─────────────────────────────────
    { step_key:'m3_auto_stock', module_key:'modul_4_stok_otomatis', sequence:13,
      target_selector: '#pos-maintab-stock',
      title: '📦 Stok Berkurang Otomatis',
      body:  'Setiap transaksi berhasil, stok bahan baku yang digunakan dalam resep produk akan langsung berkurang otomatis. ' +
             'Klik tab Stok untuk melihatnya.',
      is_required: true },

    { step_key:'m3_stock_view', module_key:'modul_4_stok_otomatis', sequence:14,
      target_selector: '#pos-maintab-stock',
      title: '👁️ Cek Ringkasan Stok',
      body:  'Biasakan mengecek stok di awal dan akhir shift. ' +
             'Jika stok suatu bahan hampir habis, segera laporkan ke admin agar dapat segera diisi ulang.',
      is_required: true },

    // ── Modul 5: Manajemen Stok ────────────────────────────────
    { step_key:'m4_stock_tab', module_key:'modul_5_stok', sequence:15,
      target_selector: '#pos-maintab-stock',
      title: '📋 Tab Stok Bahan',
      body:  'Di tab ini Anda bisa melihat daftar lengkap semua bahan baku beserta sisa stok terkini.',
      is_required: true },

    { step_key:'m4_stock_adjust', module_key:'modul_5_stok', sequence:16,
      target_selector: 'button[data-action="open-stock-adjust-modal"]',
      title: '✏️ Ubah Stok Manual',
      body:  'Gunakan tombol "Ubah Stok" untuk mencatat: ' +
             'Stok Masuk (pembelian bahan), Stok Keluar (waste atau penggunaan manual), atau Opname (koreksi hasil hitung fisik).',
      is_required: true },

    { step_key:'m4_stock_transfer', module_key:'modul_5_stok', sequence:17,
      target_selector: 'button[data-action="open-stock-adjust-modal"]',
      title: '🔄 Transfer Stok Antar Cabang',
      body:  'Jika cabang Anda memiliki kelebihan stok, Anda bisa mentransfer ke cabang lain melalui Ubah Stok → Transfer Keluar.',
      is_required: false },

    // ── Modul 6: Riwayat & Void ────────────────────────────────
    { step_key:'m5_transactions', module_key:'modul_6_riwayat', sequence:18,
      target_selector: '#pos-maintab-transactions',
      title: '📜 Riwayat Transaksi',
      body:  'Tab Transaksi menampilkan semua transaksi dalam shift aktif. ' +
             'Klik salah satu transaksi untuk melihat detail: item, total, metode bayar, dan waktu.',
      is_required: true },

    { step_key:'m5_void', module_key:'modul_6_riwayat', sequence:19,
      target_selector: '#pos-maintab-transactions',
      title: '↩️ Void Transaksi',
      body:  'Jika ada kesalahan transaksi, gunakan fitur Void dari detail transaksi. ' +
             'Void wajib disertai alasan yang jelas. Hubungi admin jika ragu.',
      is_required: true },

    // ── Modul 7: Kas, Shift & Setoran ──────────────────────────
    { step_key:'m6_cash_tab', module_key:'modul_7_kas', sequence:20,
      target_selector: '#pos-maintab-cash',
      title: '💰 Ringkasan Kas',
      body:  'Tab Kas menampilkan saldo kas tunai saat ini, riwayat kas masuk dan keluar, ' +
             'serta total penjualan tunai. Periksa sebelum menutup shift.',
      is_required: true },

    { step_key:'m6_close_shift', module_key:'modul_7_kas', sequence:21,
      target_selector: 'button[data-action="open-close-shift"]',
      title: '🔒 Tutup Shift di Akhir Tugas',
      body:  'Di akhir giliran, klik "Tutup Shift". Hitung uang tunai di laci kasir dan masukkan jumlah aktualnya. ' +
             'Sistem akan menampilkan apakah ada selisih dengan kas awal + pemasukan.',
      is_required: true },

    { step_key:'m6_deposit', module_key:'modul_7_kas', sequence:22,
      target_selector: '#pos-maintab-deposits',
      title: '📤 Setoran Tunai',
      body:  'Setelah shift ditutup, setor tunai ke rekening bisnis melalui tab Setoran. ' +
             'Upload bukti transfer dan masukkan nominal yang disetor.',
      is_required: true },
  ];

  // ── Tab routing ────────────────────────────────────────────────
  const MODULE_TAB = {
    modul_1_shift_awal:   'kasir',
    modul_2_tampilan:     'kasir',
    modul_3_penjualan:    'kasir',
    modul_4_stok_otomatis:'stock',
    modul_5_stok:         'stock',
    modul_6_riwayat:      'transactions',
    modul_7_kas:          'cash',
  };
  const STEP_TAB = { m6_deposit: 'deposits' };

  // ── Helpers ────────────────────────────────────────────────────
  const $ = id => document.getElementById(id);
  const sleep = ms => new Promise(r => setTimeout(r, ms));

  function getRequiredTab(step) {
    if (step.modal_step) return null; // don't switch tabs during modal steps
    return STEP_TAB[step.step_key] || MODULE_TAB[step.module_key] || 'kasir';
  }

  function switchToTab(tabName) {
    if (!tabName) return false;
    const btn = document.querySelector(`.pos-tab-item[data-tab="${tabName}"]`);
    if (btn && !btn.classList.contains('active')) { btn.click(); return true; }
    return false;
  }

  function safeQuerySelector(sel) {
    try { return document.querySelector(sel) || null; }
    catch { return null; }
  }

  // ── Wait for a modal to close ──────────────────────────────────
  function waitForModalClose(modalId) {
    return new Promise(resolve => {
      const deadline = Date.now() + 120_000;
      const timer = setInterval(() => {
        const el = document.getElementById(modalId);
        if (!el || !el.classList.contains('active') || Date.now() >= deadline) {
          clearInterval(timer);
          resolve();
        }
      }, 300);
    });
  }

  // ── Wait for blocking modals to close (fallback path) ─────────
  async function waitForReady() {
    const BLOCKING = ['modal-shift', 'modal-branch'];
    const deadline = Date.now() + 90_000;
    const anyOpen  = () => BLOCKING.some(id => {
      const el = document.getElementById(id);
      return el && el.classList.contains('active');
    });
    if (!anyOpen()) return;
    await new Promise(resolve => {
      const timer = setInterval(() => {
        if (!anyOpen() || Date.now() >= deadline) { clearInterval(timer); resolve(); }
      }, 250);
    });
    await sleep(600);
  }

  // ── Entry Panel ────────────────────────────────────────────────
  function showEntryPanel() {
    const panel = $('ob-entry-panel');
    if (!panel) return;
    $('ob-reopen-btn')?.classList.remove('visible');
    _dismissed = false;

    const done  = _steps.filter(s => s.status === 'completed').length;
    const total = _steps.length;
    const isNew = !_assignment.status || _assignment.status === 'not_started';

    panel.querySelector('.ob-entry-progress').textContent =
      `${done} dari ${total} langkah selesai`;
    panel.querySelector('.ob-entry-title').textContent =
      isNew ? 'Pelatihan Staff Baru 🎓' : 'Lanjutkan Pelatihan 📚';
    panel.querySelector('.ob-entry-desc').textContent =
      isNew
        ? 'Shift Anda sudah terbuka. Ikuti panduan ini agar siap menggunakan POS.'
        : 'Anda masih punya langkah pelatihan yang belum selesai. Lanjutkan sekarang?';
    panel.querySelector('[data-ob-action="start"]').textContent =
      isNew ? 'Mulai Pelatihan' : 'Lanjutkan';
    panel.classList.add('visible');
  }

  function hideEntryPanel() {
    $('ob-entry-panel')?.classList.remove('visible');
  }

  // ── Tour Overlay ───────────────────────────────────────────────
  function hideTour() {
    clearAutoAdvance();
    clearHighlight();
    clearPointer();
    $('ob-overlay')?.classList.remove('visible', 'ob-no-target');
  }

  // ── Render Step ────────────────────────────────────────────────
  async function renderStep(idx) {
    if (_transitioning) return;
    _transitioning = true;
    clearAutoAdvance();

    const overlay = $('ob-overlay');
    const tooltip  = $('ob-tooltip');
    const step     = _steps[idx];
    if (!step || !tooltip || !overlay) { _transitioning = false; return; }

    tooltip.classList.remove('ob-tooltip-in');
    tooltip.classList.add('ob-tooltip-out');
    clearHighlight();
    clearPointer();
    await sleep(160);

    // Tab switch (skip for modal steps — we stay on whatever tab is active)
    const requiredTab = getRequiredTab(step);
    if (requiredTab) {
      const switched = switchToTab(requiredTab);
      if (switched) await sleep(300);
    }

    fillTooltipContent(step, idx);

    let target = step.target_selector ? safeQuerySelector(step.target_selector) : null;

    if (target && !step.modal_step) {
      // ── Normal spotlight: dark overlay with cutout ─────────
      overlay.classList.remove('ob-no-target');
      target.scrollIntoView({ behavior: 'smooth', block: 'center' });
      await sleep(360);
      _highlightEl = target;
      target.classList.add('ob-target-active');
      positionSpotlight(target);
      showPointer(target);
      positionTooltipNearTarget(target, tooltip);

    } else if (target && step.modal_step) {
      // ── Modal step: no scrim, just pointer + tooltip above modal ──
      // ob-overlay is transparent (pointer-events: none) so user can
      // still interact with the shift modal inputs and buttons.
      overlay.classList.remove('ob-no-target');
      showPointer(target);
      positionTooltipNearTarget(target, tooltip);

    } else {
      // ── No target: scrim + centered tooltip ────────────────
      overlay.classList.add('ob-no-target');
      positionTooltipCenter(tooltip);
    }

    tooltip.classList.remove('ob-tooltip-out');
    tooltip.classList.add('ob-tooltip-in');
    _transitioning = false;

    window.removeEventListener('resize', _onResize);
    if (target) window.addEventListener('resize', _onResize, { passive: true });

    // Auto-advance when a modal closes (e.g., after user clicks "Buka Shift")
    if (step.auto_advance) {
      _autoAdvanceTimer = waitForModalClose(step.auto_advance).then(async () => {
        await sleep(500);
        if (_currentIdx === idx) await nextStep();
      });
    }
  }

  function _onResize() {
    clearTimeout(_resizeTimer);
    _resizeTimer = setTimeout(() => {
      if (!_highlightEl) return;
      positionSpotlight(_highlightEl);
      showPointer(_highlightEl);
      const tt = $('ob-tooltip');
      if (tt) positionTooltipNearTarget(_highlightEl, tt);
    }, 200);
  }

  function clearAutoAdvance() {
    // _autoAdvanceTimer is a Promise, can't cancel — just guard with _currentIdx check
    _autoAdvanceTimer = null;
  }

  // ── Spotlight ──────────────────────────────────────────────────
  // #ob-highlight-box is inside #ob-overlay (position:fixed; inset:0).
  // viewport-relative coords from getBoundingClientRect() are correct
  // directly — no scrollX/scrollY needed.
  function positionSpotlight(target) {
    const box = $('ob-highlight-box');
    if (!box) return;
    const rect = target.getBoundingClientRect();
    const pad  = 10;
    box.style.top          = `${rect.top    - pad}px`;
    box.style.left         = `${rect.left   - pad}px`;
    box.style.width        = `${rect.width  + pad * 2}px`;
    box.style.height       = `${rect.height + pad * 2}px`;
    const r = parseInt(getComputedStyle(target).borderRadius) || 4;
    box.style.borderRadius = `${Math.max(8, r + 4)}px`;
    box.style.display      = 'block';
  }

  function clearHighlight() {
    const box = $('ob-highlight-box');
    if (box) box.style.display = 'none';
    if (_highlightEl) {
      _highlightEl.classList.remove('ob-target-active');
      _highlightEl = null;
    }
  }

  // ── Pointer ────────────────────────────────────────────────────
  // Pointer is z-index 9250 — floats above modals (z-index 1000) too.
  function showPointer(target) {
    const ptr = $('ob-pointer');
    if (!ptr) return;
    const rect = target.getBoundingClientRect();
    ptr.style.left = `${rect.left + rect.width * 0.65}px`;
    ptr.style.top  = `${rect.top  - 32}px`;
    ptr.classList.add('visible');
  }

  function clearPointer() {
    $('ob-pointer')?.classList.remove('visible');
  }

  // ── Tooltip Content ────────────────────────────────────────────
  function fillTooltipContent(step, idx) {
    const tooltip = $('ob-tooltip');
    if (!tooltip) return;
    const total  = _steps.length;
    const isLast = idx === total - 1;
    const isAutoAdvance = !!step.auto_advance;

    tooltip.querySelector('.ob-step-module').textContent   = moduleLabel(step.module_key);
    tooltip.querySelector('.ob-step-title').textContent    = step.title;
    tooltip.querySelector('.ob-step-body').textContent     = step.body;
    tooltip.querySelector('.ob-progress-text').textContent = `Langkah ${idx + 1} dari ${total}`;

    const fill = tooltip.querySelector('.ob-progress-bar-fill');
    if (fill) fill.style.width = `${Math.round(((idx + 1) / total) * 100)}%`;

    renderDots(idx, total);

    const btnBack = tooltip.querySelector('[data-ob-action="back"]');
    const btnNext = tooltip.querySelector('[data-ob-action="next"]');
    const btnDone = tooltip.querySelector('[data-ob-action="done"]');

    if (btnBack) btnBack.disabled = idx === 0;
    // Hide Next/Done while waiting for auto-advance (e.g., user must click shift button)
    if (btnNext) { btnNext.style.display = (isLast || isAutoAdvance) ? 'none' : ''; btnNext.disabled = _saving; }
    if (btnDone) { btnDone.style.display = (isLast && !isAutoAdvance) ? '' : 'none'; btnDone.disabled = _saving; }
  }

  function renderDots(activeIdx, total) {
    const wrap = $('ob-dots');
    if (!wrap) return;
    const max   = Math.min(total, 12);
    const start = Math.max(0, activeIdx - Math.floor(max / 2));
    const count = Math.min(max, total - start);
    wrap.innerHTML = Array.from({ length: count }, (_, i) => {
      const ri  = start + i;
      const cls = ri === activeIdx
                  ? 'ob-dot ob-dot-active'
                  : _steps[ri]?.status === 'completed' ? 'ob-dot ob-dot-done' : 'ob-dot';
      return `<span class="${cls}"></span>`;
    }).join('');
  }

  function moduleLabel(key) {
    return ({
      modul_1_shift_awal:    'Modul 1 — Shift & Kas Awal',
      modul_2_tampilan:      'Modul 2 — Tampilan Awal',
      modul_3_penjualan:     'Modul 3 — Penjualan',
      modul_4_stok_otomatis: 'Modul 4 — Stok Otomatis',
      modul_5_stok:          'Modul 5 — Manajemen Stok',
      modul_6_riwayat:       'Modul 6 — Riwayat & Void',
      modul_7_kas:           'Modul 7 — Kas & Setoran',
    })[key] || key;
  }

  // ── Tooltip Positioning ────────────────────────────────────────
  function positionTooltipNearTarget(target, tooltip) {
    const rect = target.getBoundingClientRect();
    const tw   = Math.min(tooltip.offsetWidth  || 340, 340);
    const th   = tooltip.offsetHeight || 240;
    const vw   = window.innerWidth;
    const vh   = window.innerHeight;
    const gap  = 18;

    let top;
    if (rect.bottom + th + gap < vh)   top = rect.bottom + gap;
    else if (rect.top - th - gap > 0)  top = rect.top - th - gap;
    else                               top = vh - th - 12;

    let left = rect.left + rect.width / 2 - tw / 2;
    left = Math.max(12, Math.min(left, vw - tw - 12));

    tooltip.style.position  = 'absolute';
    tooltip.style.top       = `${top}px`;
    tooltip.style.left      = `${left}px`;
    tooltip.style.bottom    = 'auto';
    tooltip.style.right     = 'auto';
    tooltip.style.transform = '';
  }

  function positionTooltipCenter(tooltip) {
    tooltip.style.position  = 'fixed';
    tooltip.style.top       = '50%';
    tooltip.style.left      = '50%';
    tooltip.style.bottom    = 'auto';
    tooltip.style.right     = 'auto';
    tooltip.style.transform = 'translate(-50%, -50%)';
  }

  // ── Navigation ─────────────────────────────────────────────────
  async function nextStep() {
    if (_saving || _transitioning) return;
    const step = _steps[_currentIdx];
    if (step) await saveStepProgress(step.step_key);
    if (_currentIdx < _steps.length - 1) {
      _currentIdx++;
      await renderStep(_currentIdx);
    }
  }

  async function prevStep() {
    if (_transitioning) return;
    if (_currentIdx > 0) {
      // Don't go back to modal steps if the shift modal is now closed
      const prev = _steps[_currentIdx - 1];
      if (prev?.modal_step && !shiftModalOpen()) return;
      _currentIdx--;
      await renderStep(_currentIdx);
    }
  }

  async function finishOnboarding() {
    if (_saving || _transitioning) return;
    const step = _steps[_currentIdx];
    if (step) await saveStepProgress(step.step_key);
    for (const s of _steps.filter(s => s.is_required && s.status !== 'completed')) {
      await saveStepProgress(s.step_key);
    }
    hideTour();
    showCompletionBanner();
    if (_localMode && _user) {
      try { localStorage.setItem(DONE(_user.id), '1'); } catch { /* ignore */ }
    }
  }

  function dismissTemporarily() {
    _dismissed = true;
    hideEntryPanel();
    hideTour();
    $('ob-reopen-btn')?.classList.add('visible');
  }

  // ── Progress Persistence ───────────────────────────────────────
  function setNavDisabled(disabled) {
    const tooltip = $('ob-tooltip');
    if (!tooltip) return;
    ['next', 'done'].forEach(a => {
      const b = tooltip.querySelector(`[data-ob-action="${a}"]`);
      if (b) b.disabled = disabled;
    });
  }

  async function saveStepProgress(stepKey) {
    if (_saving) return;
    _saving = true;
    setNavDisabled(true);

    const step = _steps.find(s => s.step_key === stepKey);
    if (step) step.status = 'completed';

    if (_localMode) {
      try {
        const uid  = _user.id;
        const done = JSON.parse(localStorage.getItem(PROG(uid)) || '[]');
        if (!done.includes(stepKey)) {
          done.push(stepKey);
          localStorage.setItem(PROG(uid), JSON.stringify(done));
        }
        const allDone = _steps.filter(s => s.is_required).every(s => s.status === 'completed');
        if (allDone) localStorage.setItem(DONE(uid), '1');
      } catch { /* ignore */ }
    } else {
      try {
        const { data, error } = await db.rpc('complete_onboarding_step', {
          p_assignment_id: _assignment.id,
          p_step_key:      stepKey,
          p_user_id:       _user.id,
        });
        if (error) throw error;
        if (data?.assignment_completed) _assignment.status = 'completed';
        await syncPendingSteps();
      } catch {
        queuePendingStep(stepKey);
      }
    }

    _saving = false;
    setNavDisabled(false);
  }

  function queuePendingStep(stepKey) {
    if (!_user) return;
    try {
      const arr = JSON.parse(localStorage.getItem(PEND(_user.id)) || '[]');
      if (!arr.includes(stepKey)) { arr.push(stepKey); localStorage.setItem(PEND(_user.id), JSON.stringify(arr)); }
    } catch { /* ignore */ }
  }

  async function syncPendingSteps() {
    if (!_user || !_assignment?.id) return;
    try {
      const arr = JSON.parse(localStorage.getItem(PEND(_user.id)) || '[]');
      if (!arr.length) return;
      for (const key of [...arr]) {
        const { error } = await db.rpc('complete_onboarding_step', {
          p_assignment_id: _assignment.id,
          p_step_key:      key,
          p_user_id:       _user.id,
        });
        if (!error) {
          const cur = JSON.parse(localStorage.getItem(PEND(_user.id)) || '[]');
          localStorage.setItem(PEND(_user.id), JSON.stringify(cur.filter(k => k !== key)));
        }
      }
    } catch { /* ignore */ }
  }

  // ── Completion Banner ──────────────────────────────────────────
  function showCompletionBanner() {
    $('ob-reopen-btn')?.classList.remove('visible');
    const banner = $('ob-complete-banner');
    if (!banner) return;
    banner.classList.add('visible');
    setTimeout(() => banner.classList.remove('visible'), 5500);
  }

  // ── Build steps from local progress ───────────────────────────
  function buildLocalSteps(uid) {
    let done = [];
    try { done = JSON.parse(localStorage.getItem(PROG(uid)) || '[]'); } catch { /* ignore */ }
    return FALLBACK_STEPS.map(s => ({ ...s, status: done.includes(s.step_key) ? 'completed' : 'pending' }));
  }

  // ── Start Tour (entry panel button — shift already open) ───────
  async function startTour() {
    hideEntryPanel();
    _assignment.status = 'in_progress';
    if (!_localMode && _assignment.id) {
      try {
        await db.rpc('start_my_onboarding', { p_assignment_id: _assignment.id, p_user_id: _user.id });
      } catch { /* non-fatal */ }
    }
    // Shift is already open — skip the modal steps, start from first non-modal incomplete step
    _currentIdx = _steps.findIndex(s => s.status !== 'completed' && !s.modal_step);
    if (_currentIdx < 0) _currentIdx = _steps.findIndex(s => !s.modal_step) || 0;
    if (_currentIdx < 0) _currentIdx = 0;
    $('ob-overlay')?.classList.add('visible');
    await renderStep(_currentIdx);
  }

  // ── Auto-Start Tour (shift modal open — run modal steps first) ─
  async function autoStartTour() {
    _assignment.status = 'in_progress';
    if (!_localMode && _assignment.id) {
      try {
        await db.rpc('start_my_onboarding', { p_assignment_id: _assignment.id, p_user_id: _user.id });
      } catch { /* non-fatal */ }
    }
    _currentIdx = _steps.findIndex(s => s.status !== 'completed');
    if (_currentIdx < 0) _currentIdx = 0;
    $('ob-overlay')?.classList.add('visible');
    await renderStep(_currentIdx);
  }

  // ── Event Binding ──────────────────────────────────────────────
  function bindEvents() {
    document.addEventListener('click', async e => {
      const btn = e.target.closest('[data-ob-action]');
      if (!btn) return;
      switch (btn.dataset.obAction) {
        case 'start':   await startTour(); break;
        case 'next':    await nextStep(); break;
        case 'back':    await prevStep(); break;
        case 'done':    await finishOnboarding(); break;
        case 'dismiss': dismissTemporarily(); break;
        case 'reopen':  showEntryPanel(); break;
      }
    });
  }

  // ── Public API ─────────────────────────────────────────────────
  async function init(user) {
    if (!user || user.role !== 'staff') return;
    _user = user;
    bindEvents();

    // Skip if already completed in a previous session
    try { if (localStorage.getItem(DONE(user.id)) === '1') return; } catch { /* ignore */ }

    // Try DB — fall back to localStorage-only mode if unavailable
    let dbOk = false;
    try {
      const { data: d, error } = await db.rpc('get_my_onboarding', { p_user_id: user.id });
      if (error) throw error;
      if (d?.assignment) {
        if (d.assignment.status === 'completed') {
          try { localStorage.setItem(DONE(user.id), '1'); } catch { /* ignore */ }
          return;
        }
        _assignment = d.assignment;
        _steps      = Array.isArray(d.steps) ? d.steps : [];
        if (_steps.length) { await syncPendingSteps(); dbOk = true; }
      }
    } catch { /* fall through to local mode */ }

    if (!dbOk) {
      _localMode  = true;
      _assignment = { id: null, status: 'not_started' };
      _steps      = buildLocalSteps(user.id);
      if (_steps.every(s => s.status === 'completed')) {
        try { localStorage.setItem(DONE(user.id), '1'); } catch { /* ignore */ }
        return;
      }
    }

    // Wait briefly for page to fully render before checking modal state
    await sleep(900);

    if (shiftModalOpen()) {
      // ── Shift modal is open: auto-start tour from step 1 (kas awal) ──
      // No entry panel needed; the modal steps guide through shift opening.
      // ob-overlay is transparent (pointer-events: none) so the user can
      // still type in the kas awal input and click the shift button.
      await autoStartTour();
    } else {
      // ── Shift already open: show entry panel, skip modal steps ────────
      await waitForReady();
      await sleep(400);
      showEntryPanel();
    }
  }

  return { init };

})();
