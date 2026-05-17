'use strict';

const Onboarding = (() => {

  // ── State ─────────────────────────────────────────────────────
  let _user             = null;
  let _assignment       = null;
  let _steps            = [];
  let _currentIdx       = 0;
  let _saving           = false;
  let _dismissed        = false;
  let _highlightEl      = null;
  let _transitioning    = false;
  let _resizeTimer      = null;
  let _localMode        = false;
  let _autoAdvanceTimer = null;
  let _paused           = false;
  let _modalObserver    = null;
  let _clickShieldActive      = false;
  let _guidedActionCleanup    = null;

  // ── Storage keys ──────────────────────────────────────────────
  const DONE = uid => `ob_done_${uid}`;
  const PROG = uid => `ob_prog_${uid}`;
  const PEND = uid => `ob_pend_${uid}`;

  // ── Check if shift modal is currently open ────────────────────
  const shiftModalOpen = () => {
    const el = document.getElementById('modal-shift');
    return el && el.classList.contains('active');
  };

  // ── Per-step UI overrides (supplements DB / fallback data) ────
  // These add fields that the DB schema doesn't store yet.
  const STEP_UI = {
    // Shift modal steps — skip if shift is already open
    m0_welcome:        { modal_step: true, showWhen: 'shift_closed', interaction_mode: 'center_info' },
    m0_kas_awal:       { modal_step: true, showWhen: 'shift_closed', interaction_mode: 'guided_action' },
    m0_open_shift:     { modal_step: true, showWhen: 'shift_closed', interaction_mode: 'guided_action', auto_advance: 'modal-shift' },
    m1_welcome:        { modal_step: true, showWhen: 'shift_closed', interaction_mode: 'center_info' },
    m1_open_shift:     { modal_step: true, showWhen: 'shift_closed', interaction_mode: 'guided_action', auto_advance: 'modal-shift' },
    m1_shift_required: { showWhen: 'shift_open', interaction_mode: 'passive' },
    // Guided click — user must interact; click shield OFF so target is reachable
    m2_select_product: { interaction_mode: 'guided_click', target_override: '.pcard:not(.out-of-stock)' },
    m2_open_cart:      { interaction_mode: 'guided_click' },
    // Passive steps — block target click to prevent unintended modal collisions
    m4_stock_adjust:   { interaction_mode: 'passive', prevent_target_click: true },
    m4_stock_transfer: { interaction_mode: 'passive', prevent_target_click: true },
    m6_close_shift:    { interaction_mode: 'passive', prevent_target_click: true },
  };

  // ── Modals that must pause the tour ──────────────────────────
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

  // ── Hardcoded fallback steps ───────────────────────────────────
  // modal_step: true  → overlay transparent; pointer/tooltip float above modal
  // auto_advance: id  → hide Next; auto-advance when that modal closes
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
      body:  'Klik kartu produk yang disorot untuk memilih produk. ' +
             'Jika produk punya varian, pilih salah satunya di layar yang muncul.',
      is_required: true },

    { step_key:'m2_open_cart', module_key:'modul_3_penjualan', sequence:9,
      target_selector: '#fab-cart-btn',
      title: '🛍️ Buka Keranjang',
      body:  'Keranjang muncul setelah ada item. Tap tombol keranjang untuk melihat pesanan, mengubah qty, atau menghapus item.',
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
      title: '📤 Setoran',
      body:  'Setelah shift ditutup, catat setoran melalui tab Setoran. ' +
             'Pilih metode setoran, upload bukti, dan masukkan nominal yang disetor.',
      is_required: true },
  ];

  // ── Tab routing ────────────────────────────────────────────────
  const MODULE_TAB = {
    modul_1_shift:          'kasir',
    modul_1_shift_awal:     'kasir',
    modul_2_tampilan:       'kasir',
    modul_2_penjualan:      'kasir',
    modul_3_penjualan:      'kasir',
    modul_3_stok_otomatis:  'stock',
    modul_4_stok_otomatis:  'stock',
    modul_4_manajemen_stok: 'stock',
    modul_5_stok:           'stock',
    modul_5_riwayat:        'transactions',
    modul_6_riwayat:        'transactions',
    modul_6_kas:            'cash',
    modul_6_kas_shift:      'cash',
    modul_7_kas:            'cash',
  };
  const STEP_TAB = { m6_deposit: 'deposits' };

  // ── Step precondition engine ───────────────────────────────────
  // Returns true if the step's required state is currently met.
  const STEP_PRECONDITIONS = {
    m2_select_product: () => document.querySelectorAll('.pcard:not(.out-of-stock)').length > 0,
    m2_open_cart:      () => getCartCount() > 0 && isFabVisible(),
    m2_discount:       () => getCartCount() > 0,
    m2_payment:        () => getCartCount() > 0,
    m2_checkout:       () => getCartCount() > 0,
  };

  // ── Helpers ────────────────────────────────────────────────────
  const $ = id => document.getElementById(id);
  const sleep = ms => new Promise(r => setTimeout(r, ms));

  function getCartCount() {
    return (window.POS?.cart || []).reduce((s, i) => s + i.quantity, 0);
  }

  function isFabVisible() {
    const el = document.getElementById('fab-cart-btn');
    return !!(el && el.classList.contains('show') && el.offsetParent !== null);
  }

  function goToStepKey(stepKey) {
    const idx = _steps.findIndex(s => s.step_key === stepKey);
    if (idx >= 0 && idx !== _currentIdx) { _currentIdx = idx; renderStep(idx); }
  }

  function getRequiredTab(step) {
    if (step.modal_step) return null;
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

  // ── Merge step with STEP_UI overrides ─────────────────────────
  function getEffectiveStep(step) {
    return Object.assign({}, step, STEP_UI[step.step_key] || {});
  }

  // ── Visual Viewport Engine ─────────────────────────────────────
  function getCssSafeAreaBottom() {
    try {
      const el = document.createElement('div');
      el.style.cssText = 'position:fixed;bottom:0;height:env(safe-area-inset-bottom,0px);visibility:hidden;pointer-events:none';
      document.body.appendChild(el);
      const h = el.offsetHeight;
      document.body.removeChild(el);
      return h || 0;
    } catch { return 0; }
  }

  function getVisualViewportBox() {
    const vv = window.visualViewport;
    return {
      width:      vv ? vv.width      : window.innerWidth,
      height:     vv ? vv.height     : window.innerHeight,
      offsetLeft: vv ? vv.offsetLeft : 0,
      offsetTop:  vv ? vv.offsetTop  : 0,
      safeTop:    12,
      safeRight:  12,
      safeBottom: Math.max(20, getCssSafeAreaBottom() + 16),
      safeLeft:   12,
    };
  }

  // ── Target validation & resolution ────────────────────────────
  function isTargetValid(el) {
    if (!el) return false;
    try {
      const rect = el.getBoundingClientRect();
      if (rect.width < 24 || rect.height < 24) return false;
      const vv = getVisualViewportBox();
      if (rect.right < 0 || rect.left > vv.width || rect.bottom < 0 || rect.top > vv.height) return false;
      const visW = Math.min(rect.right, vv.width)  - Math.max(rect.left, 0);
      const visH = Math.min(rect.bottom, vv.height) - Math.max(rect.top, 0);
      return (visW * visH) / (rect.width * rect.height) >= 0.35;
    } catch { return false; }
  }

  function isTargetTooLarge(el) {
    try {
      const rect = el.getBoundingClientRect();
      const vv = getVisualViewportBox();
      return rect.height > vv.height * 0.45;
    } catch { return false; }
  }

  function resolveTarget(step) {
    const ui = STEP_UI[step.step_key] || {};
    // Try target_override first, then original selector
    for (const sel of [ui.target_override, step.target_selector].filter(Boolean)) {
      const el = safeQuerySelector(sel);
      if (!el) continue;
      // For overly large containers, prefer first meaningful child
      if (isTargetTooLarge(el)) {
        const child = el.querySelector('.pcard, .product-card, .list-card');
        if (child && isTargetValid(child)) return child;
      }
      if (isTargetValid(el)) return el;
    }
    return null;
  }

  // ── Modal conflict detector ────────────────────────────────────
  const GUIDED_SAFE_MODALS = new Set(['modal-variant-select', 'modal-topping-select']);

  function isBlockingModalOpen() {
    const currentStep = _steps[_currentIdx];
    const es = currentStep ? getEffectiveStep(currentStep) : {};
    const isGuided = es.interaction_mode === 'guided_click' || es.interaction_mode === 'guided_modal';
    return BLOCKING_MODALS.some(id => {
      if (isGuided && GUIDED_SAFE_MODALS.has(id)) return false;
      const el = document.getElementById(id);
      return el && el.classList.contains('active');
    });
  }

  function setupModalConflictDetector() {
    if (_modalObserver) return;
    _modalObserver = new MutationObserver(() => {
      const overlay = $('ob-overlay');
      if (!overlay || !overlay.classList.contains('visible')) return;
      const blocking = isBlockingModalOpen();
      if (blocking && !_paused) {
        _paused = true;
        const tt = $('ob-tooltip');
        if (tt) { tt.classList.remove('ob-tooltip-in'); tt.classList.add('ob-tooltip-out'); }
        clearPointer();
        clearHighlight();
      } else if (!blocking && _paused) {
        _paused = false;
        renderStep(_currentIdx);
      }
    });
    _modalObserver.observe(document.body, {
      subtree: true,
      attributes: true,
      attributeFilter: ['class'],
    });
  }

  // ── Click shield for passive steps ────────────────────────────
  function _clickShieldHandler(e) {
    if (!_highlightEl) return;
    if (e.target === _highlightEl || _highlightEl.contains(e.target)) {
      e.stopImmediatePropagation();
      e.preventDefault();
    }
  }

  function activateClickShield() {
    if (_clickShieldActive) return;
    _clickShieldActive = true;
    document.addEventListener('click',      _clickShieldHandler, { capture: true });
    document.addEventListener('touchstart', _clickShieldHandler, { capture: true, passive: false });
  }

  function deactivateClickShield() {
    if (!_clickShieldActive) return;
    _clickShieldActive = false;
    document.removeEventListener('click',      _clickShieldHandler, true);
    document.removeEventListener('touchstart', _clickShieldHandler, true);
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

  // ── Wait for blocking modals to close ─────────────────────────
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

  // ── Guided click action handler ────────────────────────────────
  function cancelGuidedAction() {
    if (_guidedActionCleanup) { _guidedActionCleanup(); _guidedActionCleanup = null; }
  }

  function setupGuidedClickAction(stepKey, idx) {
    cancelGuidedAction();

    if (stepKey === 'm2_select_product') {
      let done = false;

      const onCartChanged = async (e) => {
        if (done || _currentIdx !== idx) return;
        const count = (typeof e.detail?.count === 'number') ? e.detail.count : getCartCount();
        if (count > 0) {
          done = true;
          cleanup();
          await sleep(200);
          const cartIdx = _steps.findIndex(s => s.step_key === 'm2_open_cart');
          const saveKey = _steps[idx]?.step_key;
          if (saveKey) await saveStepProgress(saveKey);
          if (cartIdx > idx) {
            _currentIdx = cartIdx;
            await renderStep(_currentIdx);
          } else {
            if (_currentIdx < _steps.length - 1) { _currentIdx++; await renderStep(_currentIdx); }
          }
        }
      };

      const onModalOpened = (e) => {
        if (done || _currentIdx !== idx) return;
        if (e.detail?.id !== 'modal-variant-select') return;
        // Redirect spotlight to variant modal's first button
        setTimeout(() => {
          const varBtn = document.querySelector('#modal-variant-select .variant-select-btn');
          if (!varBtn || !isTargetValid(varBtn)) return;
          if (_highlightEl) _highlightEl.classList.remove('ob-target-active');
          _highlightEl = varBtn;
          varBtn.classList.add('ob-target-active');
          positionSpotlight(varBtn);
          showPointer(varBtn);
          const tt = $('ob-tooltip');
          if (tt) {
            const bodyEl = tt.querySelector('.ob-step-body');
            if (bodyEl) bodyEl.textContent = 'Pilih varian produk yang ingin dipesan.';
            positionTooltipNearTarget(varBtn, tt);
          }
        }, 200);
      };

      function cleanup() {
        window.removeEventListener('rbn:cart:changed', onCartChanged);
        window.removeEventListener('rbn:modal:opened', onModalOpened);
        _guidedActionCleanup = null;
      }

      _guidedActionCleanup = cleanup;
      window.addEventListener('rbn:cart:changed', onCartChanged);
      window.addEventListener('rbn:modal:opened', onModalOpened);

    } else if (stepKey === 'm2_open_cart') {
      let done = false;

      const onCartOpen = () => {
        if (done || _currentIdx !== idx) return;
        const viewCart = document.getElementById('view-cart');
        if (viewCart && !viewCart.hidden) {
          done = true;
          cleanup();
          // auto-advance when cart view opens
          (async () => {
            await sleep(400);
            if (_currentIdx === idx) await nextStep();
          })();
        }
      };

      // Poll for cart view opening (FAB click opens it outside onboarding control)
      const _pollTimer = setInterval(onCartOpen, 300);

      function cleanup() {
        clearInterval(_pollTimer);
        _guidedActionCleanup = null;
      }

      _guidedActionCleanup = cleanup;
    }
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
    cancelGuidedAction();
    clearHighlight();
    clearPointer();
    deactivateClickShield();
    $('ob-overlay')?.classList.remove('visible', 'ob-no-target');
  }

  // ── Render Step ────────────────────────────────────────────────
  async function renderStep(idx) {
    if (_transitioning) return;
    _transitioning = true;
    clearAutoAdvance();
    cancelGuidedAction();
    deactivateClickShield();

    const overlay = $('ob-overlay');
    const tooltip  = $('ob-tooltip');
    const step     = _steps[idx];
    if (!step || !tooltip || !overlay) { _transitioning = false; return; }

    const es = getEffectiveStep(step);

    // Skip step when its showWhen condition is not met
    if (es.showWhen === 'shift_closed' && !shiftModalOpen()) {
      _transitioning = false;
      _currentIdx++;
      if (_currentIdx < _steps.length) await renderStep(_currentIdx);
      return;
    }

    // Skip cart-dependent steps if precondition fails (cart empty / FAB hidden)
    const precondFn = STEP_PRECONDITIONS[step.step_key];
    const CART_STEPS = new Set(['m2_discount', 'm2_payment', 'm2_checkout']);
    if (precondFn && !precondFn() && CART_STEPS.has(step.step_key)) {
      _transitioning = false;
      _currentIdx++;
      if (_currentIdx < _steps.length) await renderStep(_currentIdx);
      return;
    }

    tooltip.classList.remove('ob-tooltip-in', 'ob-tooltip-bottom-sheet');
    tooltip.classList.add('ob-tooltip-out');
    clearHighlight();
    clearPointer();
    await sleep(160);

    // Tab switch (skip for modal steps)
    const requiredTab = getRequiredTab(es);
    if (requiredTab) {
      const switched = switchToTab(requiredTab);
      if (switched) await sleep(300);
    }

    fillTooltipContent(step, idx);

    const isModalStep     = !!es.modal_step;
    const autoAdvance     = es.auto_advance || null;
    const preventClick    = !!es.prevent_target_click;
    const interactionMode = es.interaction_mode || 'info';
    const isGuidedClick   = interactionMode === 'guided_click';

    // For m2_open_cart: if precondition still not met, show state-info tooltip
    if (step.step_key === 'm2_open_cart' && precondFn && !precondFn()) {
      overlay.classList.add('ob-no-target');
      const bodyEl = tooltip.querySelector('.ob-step-body');
      if (bodyEl) bodyEl.textContent = 'Keranjang akan muncul setelah produk ditambahkan. Kembali ke halaman kasir dan tap kartu produk terlebih dahulu.';
      positionTooltipCenter(tooltip);
      tooltip.classList.remove('ob-tooltip-out');
      tooltip.classList.add('ob-tooltip-in');
      _transitioning = false;
      // Wait for cart to fill, then re-render
      const _waitCartFill = (e) => {
        const count = (typeof e.detail?.count === 'number') ? e.detail.count : getCartCount();
        if (count > 0) {
          window.removeEventListener('rbn:cart:changed', _waitCartFill);
          sleep(200).then(() => { if (_currentIdx === idx) renderStep(idx); });
        }
      };
      window.addEventListener('rbn:cart:changed', _waitCartFill);
      return;
    }

    const target = resolveTarget(es);

    if (target && !isModalStep) {
      // ── Normal spotlight ──────────────────────────────────────
      overlay.classList.remove('ob-no-target');
      target.scrollIntoView({ behavior: 'smooth', block: 'center' });
      await sleep(360);
      _highlightEl = target;
      target.classList.add('ob-target-active');
      positionSpotlight(target);
      showPointer(target);
      positionTooltipNearTarget(target, tooltip);
      if (preventClick && !isGuidedClick) activateClickShield();

    } else if (target && isModalStep) {
      // ── Modal step: transparent overlay, pointer above modal ──
      overlay.classList.remove('ob-no-target');
      showPointer(target);
      positionTooltipNearTarget(target, tooltip);

    } else {
      // ── No valid target: scrim + center/bottom-sheet ──────────
      if (step.target_selector) {
        console.warn(`[Onboarding] selector not found or off-screen: "${step.target_selector}" (step: ${step.step_key})`);
      }
      overlay.classList.add('ob-no-target');
      positionTooltipCenter(tooltip);
    }

    tooltip.classList.remove('ob-tooltip-out');
    tooltip.classList.add('ob-tooltip-in');
    _transitioning = false;

    window.removeEventListener('resize', _onResize);
    if (window.visualViewport) window.visualViewport.removeEventListener('resize', _onVVResize);
    if (target) {
      window.addEventListener('resize', _onResize, { passive: true });
      if (window.visualViewport) window.visualViewport.addEventListener('resize', _onVVResize, { passive: true });
    }

    // Auto-advance when modal closes (e.g., after "Buka Shift" click)
    if (autoAdvance) {
      _autoAdvanceTimer = waitForModalClose(autoAdvance).then(async () => {
        await sleep(500);
        if (_currentIdx === idx) await nextStep();
      });
    }

    // Guided click: wait for the user action that proves the step is done
    if (isGuidedClick && !autoAdvance) {
      setupGuidedClickAction(step.step_key, idx);
    }
  }

  function _onResize() {
    clearTimeout(_resizeTimer);
    _resizeTimer = setTimeout(() => {
      const tt = $('ob-tooltip');
      if (!tt) return;
      if (_highlightEl) {
        positionSpotlight(_highlightEl);
        showPointer(_highlightEl);
        positionTooltipNearTarget(_highlightEl, tt);
      }
    }, 200);
  }

  function _onVVResize() {
    clearTimeout(_resizeTimer);
    _resizeTimer = setTimeout(() => {
      const tt = $('ob-tooltip');
      if (!tt) return;
      if (_highlightEl) {
        positionSpotlight(_highlightEl);
        showPointer(_highlightEl);
        positionTooltipNearTarget(_highlightEl, tt);
      } else {
        positionTooltipCenter(tt);
      }
    }, 150);
  }

  function clearAutoAdvance() {
    _autoAdvanceTimer = null;
  }

  // ── Spotlight ──────────────────────────────────────────────────
  function positionSpotlight(target) {
    const box = $('ob-highlight-box');
    if (!box) return;
    const rect = target.getBoundingClientRect();
    const vv   = getVisualViewportBox();
    const pad  = 10;
    // Clamp highlight to viewport so it never draws a line off-screen
    const top    = Math.max(0, rect.top    - pad);
    const left   = Math.max(0, rect.left   - pad);
    const width  = Math.min(rect.width  + pad * 2, vv.width  - left);
    const height = Math.min(rect.height + pad * 2, vv.height - top);
    box.style.top    = `${top}px`;
    box.style.left   = `${left}px`;
    box.style.width  = `${width}px`;
    box.style.height = `${height}px`;
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
    deactivateClickShield();
  }

  // ── Pointer ────────────────────────────────────────────────────
  function showPointer(target) {
    const ptr = $('ob-pointer');
    if (!ptr) return;
    const vv   = getVisualViewportBox();
    const rect = target.getBoundingClientRect();
    const ptrLeft = Math.min(rect.left + rect.width * 0.65, vv.width - 40);
    const ptrTop  = rect.top - 32;
    // Hide pointer if it would fall outside visible area
    if (ptrTop < vv.safeTop || ptrTop > vv.height - 60) {
      ptr.classList.remove('visible');
      return;
    }
    ptr.style.left = `${Math.max(vv.safeLeft, ptrLeft)}px`;
    ptr.style.top  = `${ptrTop}px`;
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
    const es = getEffectiveStep(step);
    const isAutoAdvance = !!(es.auto_advance || step.auto_advance);

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

    const interactionMode = es.interaction_mode || 'info';
    const isGuidedAction  = (interactionMode === 'guided_click' || interactionMode === 'guided_modal') && !isLast;

    if (btnBack) btnBack.disabled = idx === 0;
    if (btnNext) {
      const hideNext = isLast || isAutoAdvance || isGuidedAction;
      btnNext.style.display = hideNext ? 'none' : '';
      btnNext.disabled = _saving;
    }
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
    const MAP = {
      modul_1_shift:          'Modul 1 - Shift',
      modul_1_shift_awal:     'Modul 1 - Shift & Kas Awal',
      modul_2_tampilan:       'Modul 2 - Tampilan Awal',
      modul_2_penjualan:      'Modul 2 - Penjualan',
      modul_3_penjualan:      'Modul 3 - Penjualan',
      modul_3_stok_otomatis:  'Modul 3 - Stok Otomatis',
      modul_4_stok_otomatis:  'Modul 4 - Stok Otomatis',
      modul_4_manajemen_stok: 'Modul 4 - Manajemen Stok',
      modul_5_stok:           'Modul 5 - Manajemen Stok',
      modul_5_riwayat:        'Modul 5 - Riwayat',
      modul_6_riwayat:        'Modul 6 - Riwayat & Void',
      modul_6_kas:            'Modul 6 - Kas & Setoran',
      modul_6_kas_shift:      'Modul 6 - Kas & Shift',
      modul_7_kas:            'Modul 7 - Kas & Setoran',
    };
    // Fallback: convert raw key to readable title
    return MAP[key] || (key || '').replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
  }

  // ── Tooltip Positioning ────────────────────────────────────────
  function shouldUseBottomSheet(target, tooltip, viewport) {
    if (viewport.width > 480) return false;
    if (!target) return true;
    try {
      const rect = target.getBoundingClientRect();
      const th   = tooltip.offsetHeight || 240;
      const targetLow   = rect.top > viewport.height * 0.55;
      const noRoomBelow = rect.bottom + th + 18 > viewport.height - viewport.safeBottom;
      const noRoomAbove = rect.top   - th - 18  < viewport.safeTop;
      return targetLow || (noRoomBelow && noRoomAbove);
    } catch { return true; }
  }

  function positionTooltipBottomSheet(tooltip) {
    tooltip.classList.add('ob-tooltip-bottom-sheet');
    tooltip.style.position  = 'fixed';
    tooltip.style.left      = '12px';
    tooltip.style.right     = '12px';
    tooltip.style.bottom    = 'max(16px, env(safe-area-inset-bottom, 16px))';
    tooltip.style.top       = 'auto';
    tooltip.style.width     = 'auto';
  }

  function positionTooltipNearTarget(target, tooltip) {
    tooltip.classList.remove('ob-tooltip-bottom-sheet');
    const viewport = getVisualViewportBox();

    if (shouldUseBottomSheet(target, tooltip, viewport)) {
      positionTooltipBottomSheet(tooltip);
      return;
    }

    const rect = target.getBoundingClientRect();
    const tw   = Math.min(tooltip.offsetWidth || 340, 340, viewport.width - viewport.safeLeft - viewport.safeRight);
    const th   = tooltip.offsetHeight || 240;
    const gap  = 18;

    let top;
    if (rect.bottom + th + gap <= viewport.height - viewport.safeBottom) {
      top = rect.bottom + gap;
    } else if (rect.top - th - gap >= viewport.safeTop) {
      top = rect.top - th - gap;
    } else {
      top = Math.max(viewport.safeTop, viewport.height - viewport.safeBottom - th);
    }

    let left = rect.left + rect.width / 2 - tw / 2;
    left = Math.max(viewport.safeLeft, Math.min(left, viewport.width - tw - viewport.safeRight));
    top  = Math.max(viewport.safeTop,  Math.min(top,  viewport.height - viewport.safeBottom - th));

    tooltip.style.position  = 'fixed';
    tooltip.style.left      = `${left}px`;
    tooltip.style.top       = `${top}px`;
    tooltip.style.bottom    = 'auto';
    tooltip.style.right     = 'auto';
    tooltip.style.width     = `${tw}px`;
  }

  function positionTooltipCenter(tooltip) {
    const viewport = getVisualViewportBox();
    if (viewport.width <= 480) {
      positionTooltipBottomSheet(tooltip);
      return;
    }
    tooltip.classList.remove('ob-tooltip-bottom-sheet');
    // Calculate center without relying on CSS transform (avoids conflict with in/out classes)
    const tw   = tooltip.offsetWidth  || 340;
    const th   = tooltip.offsetHeight || 240;
    const left = Math.max(viewport.safeLeft, (viewport.width  - tw) / 2);
    const top  = Math.max(viewport.safeTop,  (viewport.height - th) / 2);
    tooltip.style.position  = 'fixed';
    tooltip.style.left      = `${left}px`;
    tooltip.style.top       = `${top}px`;
    tooltip.style.bottom    = 'auto';
    tooltip.style.right     = 'auto';
    tooltip.style.width     = '';
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
      const prev = _steps[_currentIdx - 1];
      const eprev = getEffectiveStep(prev);
      if (eprev.modal_step && !shiftModalOpen()) return;
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

  // ── Start Tour (entry panel — shift already open) ──────────────
  async function startTour() {
    hideEntryPanel();
    _assignment.status = 'in_progress';
    if (!_localMode && _assignment.id) {
      try {
        await db.rpc('start_my_onboarding', { p_assignment_id: _assignment.id, p_user_id: _user.id });
      } catch { /* non-fatal */ }
    }
    // Skip modal steps (shift is already open)
    _currentIdx = _steps.findIndex(s => {
      const es = getEffectiveStep(s);
      return s.status !== 'completed' && !es.modal_step;
    });
    if (_currentIdx < 0) _currentIdx = _steps.findIndex(s => !getEffectiveStep(s).modal_step);
    if (_currentIdx < 0) _currentIdx = 0;
    $('ob-overlay')?.classList.add('visible');
    await renderStep(_currentIdx);
  }

  // ── Auto-Start Tour (shift modal open — start from step 1) ────
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
  let _eventsBound = false;

  function bindEvents() {
    if (_eventsBound) return;
    _eventsBound = true;
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
    setupModalConflictDetector();
  }

  // ── Public API ─────────────────────────────────────────────────
  async function init(user) {
    if (!user || user.role !== 'staff') return;
    _user = user;
    bindEvents();

    try { if (localStorage.getItem(DONE(user.id)) === '1') return; } catch { /* ignore */ }

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

    await sleep(900);

    if (shiftModalOpen()) {
      await autoStartTour();
    } else {
      await waitForReady();
      await sleep(400);
      showEntryPanel();
    }
  }

  return { init };

})();

window.Onboarding = Onboarding;
