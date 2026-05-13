'use strict';

const POS = {
  // ── State ────────────────────────────────────────────────────
  user:        null,
  branch:      null,
  session:     null,
  cart:        [],
  heldCarts:   [],
  allProducts: [],
  filtered:    [],
  currentMainTab: 'kasir',
  paymentMethod: 'cash',
  paymentMethodData: null,   // full method object from DB
  discount:    { type: 'none', value: 0 },
  loading:     false,
  _clickTs:    {},
  _checkoutLock: false,
  _pendingTxIds: null,
  bomData:     null,   // { recipeMap: {variantId→recipeId}, recipeItemsMap: {recipeId→[items]} }
  stockCache:  null,   // Map<ingredientId, stock> — refreshed after each transaction
  toppingMap:  {},     // productId → [{id, name, price}]
  _cartIdCounter: 0,   // increments to give each cart line a unique cartItemId
  _pendingVariantId: null,   // staged while topping modal is open
  _pendingProduct:   null,

  // ── Init ─────────────────────────────────────────────────────
  async init() {
    // Event Delegation
    document.addEventListener('click', e => {
      const btn = e.target.closest('[data-action]');
      if (!btn) return;
      const { action } = btn.dataset;
      switch (action) {
        case 'toggle-mobile-drawer': POS.toggleMobileDrawer(); break;
        case 'open-printer-settings': POS.closeMobileDrawer(); POS.openPrinterSettings(); break;
        case 'confirm-logout': POS.confirmLogout(); break;
        case 'switch-main-tab': POS.switchMainTab(btn.dataset.tab, btn); break;
        case 'open-cart-view':    POS.switchView('cart');  break;
        case 'close-cart-view':   POS.switchView('kasir'); break;
        case 'hold-cart': POS.holdCart(); break;
        case 'show-held-carts': POS.showHeldCarts(); break;
        case 'clear-cart': POS.clearCart(); break;
        case 'open-payment-modal': POS.openPaymentModal(); break;
        case 'load-sales-summary': POS.loadSalesSummary(); break;
        case 'load-inventory-summary': POS.loadInventorySummary(); break;
        case 'update-cash-summary': POS.updateCashSummary(); break;
        case 'load-session-transactions': POS.loadSessionTransactions(); break;
        case 'switch-mobile-drawer-tab': POS.switchMobileDrawerTab(btn.dataset.tab, btn); break;
        case 'test-print': POS.testPrint(); break;
        case 'confirm-open-shift': POS.confirmOpenShift(); break;
        case 'confirm-close-shift': POS.confirmCloseShift(); break;
        case 'close-payment-modal': POS.closePaymentModal(); break;
        case 'apply-discount': POS.applyDiscount(); break;
        case 'confirm-checkout': POS.confirmCheckout(); break;
        case 'void-pos-transaction': POS.voidPosTransaction(); break;
        case 'close-modal': closeModal(btn.dataset.modalId); break;
        case 'select-branch': POS.selectBranch(Number(btn.dataset.id), btn.dataset.name || '', btn.dataset.address || ''); break;
        case 'select-product': POS.selectProduct(Number(btn.dataset.id)); break;
        case 'select-variant': POS.selectVariant(Number(btn.dataset.id), Number(btn.dataset.product)); break;
        case 'qty-minus': POS.changeQty(Number(btn.dataset.id), -1); break;
        case 'qty-plus': POS.changeQty(Number(btn.dataset.id), 1); break;
        case 'remove-cart': POS.removeFromCart(Number(btn.dataset.id)); break;
        case 'resume-cart': POS.resumeCart(Number(btn.dataset.index)); break;
        case 'delete-held': POS.deleteHeld(Number(btn.dataset.index)); break;
        case 'view-trx': POS.viewPosTransaction(Number(btn.dataset.id)); e.stopPropagation(); break;
        case 'filter-category': POS.filterCategory(btn.dataset.cat || 'Semua'); break;
        case 'select-payment-method': POS.selectPaymentMethod(btn, btn.dataset.method); break;
        case 'set-quick-amount': POS.setQuickAmount(safeNum(btn.dataset.amount || 0, 'Quick Amount')); break;
        // FIX: 'start-new-transaction' was missing from switch-case — added here
        case 'start-new-transaction': POS.startNewTransaction(); break;
        case 'close-receipt': POS.closeReceipt(); break;
        case 'open-shift-modal': openModal('modal-shift'); break;
        case 'void-cash-log': POS.voidCashLogFromPOS(Number(btn.dataset.id)); break;
        case 'switch-cash-subtab': POS.switchCashSubTab(btn.dataset.type); break;
        case 'submit-cash-entry': POS.submitCashEntry(); break;
        case 'open-close-shift': POS.closeMobileDrawer(); POS.openCloseShiftModal(); break;
        case 'print-receipt': window.print(); break;
        case 'open-stock-adjust-modal': POS.openStockAdjustModal(); break;
        case 'submit-stock-adjust': POS.submitStockAdjust(); break;
        case 'edit-item-price': POS.editItemPrice(Number(btn.dataset.id)); break;
        // FIX: close-success-popup handler properly resets all locks
        case 'close-success-popup': POS.closeSuccessPopup(); break;
        case 'print-receipt-close': POS.printReceiptAndClose(); break;
        case 'confirm-topping-select': POS.confirmToppingSelect(); break;
        case 'skip-topping-select': POS.skipToppingSelect(); break;
      }
    });
    document.addEventListener('change', e => {
      const input = e.target.closest('[data-action="qty-set"]');
      if (input) POS.setQty(Number(input.dataset.id), input.value);
      const toppingCheck = e.target.closest('[data-action="topping-check-change"]');
      if (toppingCheck) POS._updateToppingExtra();
      const changeNode = e.target.closest('[data-action-change]');
      if (!changeNode) return;
      const action = changeNode.dataset.actionChange;
      if (action === 'load-sales-summary') POS.loadSalesSummary();
      else if (action === 'load-inventory-summary') POS.loadInventorySummary();
      else if (action === 'save-printer-settings') POS.savePrinterSettings();
      else if (action === 'toggle-discount-input') POS.toggleDiscountInput();
      else if (action === 'toggle-stock-adj-type') POS.toggleStockAdjType();
    });
    document.addEventListener('input', e => {
      const inputNode = e.target.closest('[data-action-input]');
      if (!inputNode) return;
      const action = inputNode.dataset.actionInput;
      if (action === 'apply-discount-preview') POS.applyDiscountPreview();
      else if (action === 'calc-change') POS.calcChange();
      else if (action === 'update-shift-diff') POS.updateShiftDiff(inputNode.value);
    });

    // Handle Android back button / browser popstate
    window.addEventListener('popstate', () => {
      const viewCart = document.getElementById('view-cart');
      if (viewCart && !viewCart.hidden) {
        POS.switchView('kasir');
      }
    });

    this.user = auth.requireRole('staff');
    if (!this.user) return;
    this.user = await auth.validateCurrentUser();
    if (!this.user) return;
    const headerStaffEl = document.getElementById('header-staff-name');
    if (headerStaffEl) headerStaffEl.textContent = this.user.name;
    const staffChip = document.getElementById('header-staff-chip');
    if (staffChip) staffChip.textContent = this.user.name;

    let branch = null;
    if (this.user.branch_id) {
      branch = await this.fetchBranch(this.user.branch_id);
    } else {
      const cached = auth.getActiveBranch();
      if (cached) branch = cached;
    }

    if (branch) {
      this.branch = branch;
      this.updateBranchUI();
      try {
        await this.initShift();
        await this.loadProducts();
      } catch (e) {
        showToast('Koneksi bermasalah. Coba refresh halaman.', 'error');
        this.session = null;
        openModal('modal-shift');
      }
    } else {
      await this.showBranchSelector();
    }

    this.setupSearch();
    this.hideLoader();
    if (window.depositUi && typeof depositUi.refreshWhenReady === 'function') {
      depositUi.refreshWhenReady();
    }

    // Poll transfer notifications every 30 seconds
    this._checkTransferNotifications();
    this._transferNotifInterval = setInterval(() => this._checkTransferNotifications(), 30_000);

    // BUG-04 FIX: Poll session validity every 5 minutes
    setInterval(() => {
      if (!auth.getSession()) {
        showToast('Sesi habis. Silakan login kembali.', 'warning');
        setTimeout(() => auth.logout(), 2000);
      }
    }, 5 * 60 * 1000);
  },

  // ── Branch ───────────────────────────────────────────────────
  async fetchBranch(id) {
    const { data } = await db.from('branches').select('*').eq('id', id).maybeSingle();
    return data;
  },

  async showBranchSelector() {
    const { data: branches } = await db.from('branches').select('*').order('name');
    const list = document.getElementById('branch-list');
      if (!branches?.length) {
        list.innerHTML = '<p class="text-muted text-sm">Belum ada cabang. Hubungi admin.</p>';
      openModal('modal-branch');
      this.hideLoader();
      return;
    }
      list.innerHTML = branches.map(b => `
        <button class="btn btn-outline btn-full btn-list-item"
          data-action="select-branch"
          data-id="${b.id}"
          data-name="${escapeHtml(b.name)}"
          data-address="${escapeHtml(b.address||'')}">
          <i data-lucide="store" class="icon-lg mr-2"></i>
          <span><strong>${escapeHtml(b.name)}</strong>
            ${b.address ? `<br><span class="text-xs text-muted">${escapeHtml(b.address)}</span>` : ''}
          </span>
        </button>`).join('');
      if (window.lucide) lucide.createIcons();
    openModal('modal-branch');
    this.hideLoader();
  },

  async selectBranch(id, name, address) {
    closeModal('modal-branch');
    showLoader();
    // Reset state from previous branch before reinitializing
    this.session  = null;
    this.cart     = [];
    this.discount = { type: 'none', value: 0 };
    this.heldCarts = [];
    this.renderCart();
    this.updateHeldBadge();
    this.branch = { id, name, address };
    auth.setActiveBranch(this.branch);
    this.updateBranchUI();
    await this.initShift();
    await this.loadProducts();
    if (window.depositUi && typeof depositUi.refreshWhenReady === 'function') {
      depositUi.refreshWhenReady();
    }
    this.hideLoader();
  },

  updateBranchUI() {
    const branchNameEl = document.getElementById('header-branch-name');
    if (branchNameEl) branchNameEl.textContent = this.branch.name;
  },

  // ── Shift / Session ──────────────────────────────────────────
  async initShift() {
    const { data } = await db.from('cashier_sessions')
      .select('*')
      .eq('branch_id', this.branch.id)
      .eq('staff_id', this.user.id)
      .eq('status', 'open')
      .order('opened_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (data) {
      this.session = data;
      this.updateShiftUI();
    } else {
      this.session = null;
      this.updateShiftUI();
      openModal('modal-shift');
    }
  },

  updateShiftUI() {
    if (!this.session) {
      // Only open if no session — already handled by initShift/selectBranch
    }
  },

  async confirmOpenShift() {
    const cash = parseFloat(document.getElementById('shift-opening-cash').value) || 0;
    const btn  = document.getElementById('btn-open-shift');
    btn.disabled = true;
    btn.textContent = 'Membuka...';
    try {
      this.session = await transactionService.openShift({
        branchId:    this.branch.id,
        staffId:     this.user.id,
        openingCash: cash
      });
      closeModal('modal-shift');
      this.updateShiftUI();
      showToast('Shift berhasil dibuka — Selamat berjualan!', 'success');
    } catch (e) {
      showToast(e.message, 'error');
    } finally {
      btn.disabled = false;
      btn.textContent = 'Buka Shift & Mulai Berjualan';
    }
  },

  async openCloseShiftModal() {
    if (!this.session) { showToast('Tidak ada shift aktif', 'warning'); return; }

    // Load cashService summary for accurate numbers
    let summary = null;
    if (typeof cashService !== 'undefined') {
      try { summary = await cashService.getSummary({ branchId: this.branch.id, sessionId: this.session.id }); } catch(e) {}
    }
    const openingCash  = summary ? summary.openingCash  : parseFloat(this.session.opening_cash || 0);
    const salesIn      = summary ? summary.salesIn      : 0;
    const totalSales   = summary ? summary.totalSales   : parseFloat(this.session.total_sales  || 0);
    const manualIn     = summary ? summary.manualIn     : 0;
    const manualOut    = summary ? summary.manualOut    : 0;
    const refundOut    = summary ? summary.refundOut    : 0;
    const expectedCash = summary ? summary.expectedCash : openingCash + salesIn;
    const totalTrx     = this.session.total_transactions || 0;

    // Store for live diff calculation
    this._closeShiftExpected = expectedCash;

    const el = document.getElementById('close-shift-summary');
    if (el) el.innerHTML = `
      <div class="shift-summary-modern">
        <div class="shift-stat-group">
          <div class="shift-stat-item">
            <div class="shift-stat-label">Kas Awal</div>
            <div class="shift-stat-val">${formatRupiah(openingCash)}</div>
          </div>
          <div class="shift-stat-item highlight">
            <div class="shift-stat-label">Total Transaksi</div>
            <div class="shift-stat-val">${totalTrx} trx</div>
          </div>
        </div>
        
        <div class="shift-detail-list">
          <div class="shift-detail-row">
            <span><i data-lucide="arrow-down-left" class="icon-sm text-success" style="margin-right:6px"></i>Penjualan Tunai</span>
            <span class="text-success fw-700">+${formatRupiah(salesIn)}</span>
          </div>
          <div class="shift-detail-row">
            <span><i data-lucide="plus-circle" class="icon-sm text-success" style="margin-right:6px"></i>Kas Masuk Manual</span>
            <span class="text-success fw-700">+${formatRupiah(manualIn)}</span>
          </div>
          <div class="shift-detail-row">
            <span><i data-lucide="minus-circle" class="icon-sm text-danger" style="margin-right:6px"></i>Kas Keluar Manual</span>
            <span class="text-danger">−${formatRupiah(manualOut)}</span>
          </div>
          <div class="shift-detail-row">
            <span><i data-lucide="refresh-ccw" class="icon-sm text-danger" style="margin-right:6px"></i>Refund</span>
            <span class="text-danger">−${formatRupiah(refundOut)}</span>
          </div>
        </div>

        <div class="shift-expected-box">
          <div class="shift-expected-label">Ekspektasi Kas Akhir (Sistem)</div>
          <div class="shift-expected-val">${formatRupiah(expectedCash)}</div>
        </div>

        <div class="shift-actual-input">
          <label class="form-label text-md fw-700" style="color:var(--text); margin-bottom:8px">Kas Aktual (Hitung Fisik Laci) *</label>
          <div class="input-prefix-wrap" style="box-shadow: 0 4px 12px rgba(0,0,0,0.05); border-radius: var(--r-lg);">
            <span class="input-prefix" style="font-weight:800; font-size:16px;">Rp</span>
            <input type="number" class="form-control input-hero" id="shift-closing-cash"
              placeholder="0" min="0" style="font-size:22px; font-weight:900; height:54px"
              data-action-input="update-shift-diff" />
          </div>
        </div>

        <div id="shift-selisih-box" class="shift-selisih-box" style="display:none">
          <div class="shift-selisih-icon" id="shift-selisih-icon"></div>
          <div class="shift-selisih-info">
            <span class="shift-selisih-label">Selisih Kas</span>
            <span class="shift-selisih-val" id="shift-selisih-val">—</span>
          </div>
        </div>
      </div>`;
    if (window.lucide) lucide.createIcons();

    document.getElementById('shift-closing-cash').value = '';
    openModal('modal-close-shift');
  },

  updateShiftDiff(val) {
    const actual   = parseFloat(val) || 0;
    const expected = this._closeShiftExpected || 0;
    const diff     = actual - expected;
    const box      = document.getElementById('shift-selisih-box');
    const valEl    = document.getElementById('shift-selisih-val');
    const iconEl   = document.getElementById('shift-selisih-icon');
    if (!box || !valEl) return;
    box.style.display = 'flex';
    box.className = 'shift-selisih-box ' + (diff === 0 ? 'selisih-ok' : diff > 0 ? 'selisih-lebih' : 'selisih-kurang');
    valEl.textContent = (diff >= 0 ? '+' : '−') + formatRupiah(Math.abs(diff));
    if (iconEl) {
       iconEl.innerHTML = diff === 0 ? '<i data-lucide="check-circle"></i>' : (diff > 0 ? '<i data-lucide="trending-up"></i>' : '<i data-lucide="alert-circle"></i>');
       if (window.lucide) lucide.createIcons();
    }
  },

  async confirmCloseShift() {
    const cash = parseFloat(document.getElementById('shift-closing-cash').value);
    if (isNaN(cash) || cash < 0) { showToast('Masukkan jumlah kas akhir', 'error'); return; }
    const btn = document.getElementById('btn-close-shift');
    btn.disabled = true;
    try {
      const result = await transactionService.closeShift({ sessionId: this.session.id, closingCash: cash });
      closeModal('modal-close-shift');
      this.session   = null;
      this.cart      = [];
      this.heldCarts = [];
      this.discount  = { type: 'none', value: 0 };
      this.renderCart();
      this.updateHeldBadge();
      this.updateShiftUI();
      const diff = cash - result.expected_cash;
      showToast(`Shift ditutup. Selisih kas: ${formatRupiah(Math.abs(diff))} ${diff >= 0 ? 'lebih' : 'kurang'}`, diff >= 0 ? 'success' : 'warning');
      // Reset input kas awal lalu minta buka shift baru
      const kasInput = document.getElementById('shift-opening-cash');
      if (kasInput) kasInput.value = '';
      setTimeout(() => openModal('modal-shift'), 400);
    } catch (e) {
      showToast(e.message, 'error');
    } finally {
      btn.disabled = false;
    }
  },

  // ── Products ─────────────────────────────────────────────────
  async loadProducts() {
    const grid = document.getElementById('products-grid');
    grid.innerHTML = '<div class="empty-state"><div class="empty-icon">⏳</div><div class="empty-title">Memuat produk...</div></div>';

    // Fetch branch products and branch-specific price overrides in parallel
    const [bpRes, priceRes] = await Promise.all([
      db.from('branch_products')
        .select(`is_active, products(id, name, image_url, category, has_variants, default_price, product_variants(id, name, price))`)
        .eq('branch_id', this.branch.id)
        .eq('is_active', true),
      db.from('branch_variant_prices')
        .select('variant_id, price')
        .eq('branch_id', this.branch.id)
        .then(r => r)
        .catch(() => ({ data: null, error: null })) // graceful if table doesn't exist
    ]);

    const { data, error } = bpRes;

    if (error || !data) {
      grid.innerHTML = '<div class="empty-state col-span-full"><div class="empty-icon"><svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" x2="12" y1="9" y2="13"/><line x1="12" x2="12.01" y1="17" y2="17"/></svg></div><div class="empty-title">Gagal memuat produk</div></div>';
      return;
    }

    // Build price-override map: variantId → overridePrice
    const priceOverride = {};
    if (priceRes.data && !priceRes.error) {
      priceRes.data.forEach(r => { priceOverride[r.variant_id] = parseFloat(r.price); });
    }

    this.allProducts = [];
    data.forEach(row => {
      const p = row.products;
      if (!p) return;

      const resolvedVariants = (p.product_variants || []).map(v => ({
        id:    v.id,
        name:  v.name,
        price: priceOverride[v.id] !== undefined ? priceOverride[v.id] : parseFloat(v.price)
      }));

      if (!resolvedVariants.length) return;

      const isSimple = p.has_variants === false;
      this.allProducts.push({
        productId:   p.id,
        productName: p.name,
        category:    p.category || 'Lainnya',
        imageUrl:    p.image_url,
        isSimple,
        variants:    resolvedVariants
      });
    });

    this.filtered = [...this.allProducts];
    this.buildCategoryBar();
    this.renderGrid();
    this.preloadBOM();    // non-blocking: caches BOM + stock for instant add-to-cart
    this.loadToppings();  // non-blocking: caches topping map per product
  },

  buildCategoryBar() {
    const cats = ['Semua', ...new Set(this.allProducts.map(p => p.category))];
    document.getElementById('category-bar').innerHTML = cats.map((c, i) =>
      `<button class="cat-btn ${i===0?'active':''}" data-action="filter-category" data-cat="${escapeHtml(c)}">${escapeHtml(c)}</button>`
    ).join('');
  },

  filterCategory(cat) {
    document.querySelectorAll('.cat-btn').forEach(b => b.classList.remove('active'));
    const activeBtn = document.querySelector(`.cat-btn[data-cat="${cat}"]`);
    if (activeBtn) activeBtn.classList.add('active');
    const q = (document.getElementById('product-search')?.value || '').toLowerCase().trim();
    this.filtered = this.allProducts.filter(p =>
      (cat === 'Semua' || p.category === cat) &&
      (!q || p.productName.toLowerCase().includes(q))
    );
    this.renderGrid();
  },

  setupSearch() {
    const input = document.getElementById('product-search');
    if (!input) return;
    let timer;
    input.addEventListener('input', e => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        const q   = e.target.value.toLowerCase().trim();
        const cat = document.querySelector('.cat-btn.active')?.dataset.cat || 'Semua';
        this.filtered = this.allProducts.filter(p =>
          (cat === 'Semua' || p.category === cat) &&
          (!q || p.productName.toLowerCase().includes(q))
        );
        this.renderGrid();
      }, 200);
    });
  },

  renderGrid() {
    const grid = document.getElementById('products-grid');
    if (!grid) return;
    if (!this.filtered.length) {
      grid.innerHTML = '<div class="empty-state col-span-full"><div class="empty-icon"><i data-lucide="search" class="icon"></i></div><div class="empty-title">Produk tidak ditemukan</div></div>';
      if (window.lucide) lucide.createIcons();
      return;
    }
    const minPrice = p => Math.min(...p.variants.map(v => v.price));
    grid.innerHTML = this.filtered.map(p => {
      const hasMultiple = !p.isSimple && p.variants.length > 1;
      const priceDisplay = hasMultiple
        ? 'Rp ' + minPrice(p).toLocaleString('id-ID') + '+'
        : formatRupiah(p.variants[0]?.price || 0);
      const metaText = p.isSimple
        ? ''
        : hasMultiple
          ? `${p.variants.length} varian`
          : escapeHtml(p.variants[0]?.name || '');
      const imgHtml = p.imageUrl
        ? `<img loading="lazy" src="${escapeHtml(p.imageUrl)}" alt="${escapeHtml(p.productName)}" onerror="this.style.display='none';this.nextElementSibling.style.display='flex'"><div class="pcard-placeholder" style="display:none"><i data-lucide="package" class="icon-lg"></i></div>`
        : `<div class="pcard-placeholder"><i data-lucide="package" class="icon-lg"></i></div>`;
      return `<div class="pcard" data-action="select-product" data-id="${p.productId}"><div class="pcard-img">${imgHtml}</div><div class="pcard-body"><div class="pcard-name">${escapeHtml(p.productName)}</div><div class="pcard-meta">${metaText}</div><div class="pcard-foot"><span class="pcard-price">${priceDisplay}</span><span class="pcard-btn">${hasMultiple ? '›' : '+'}</span></div></div></div>`;
    }).join('');
    if (window.lucide) lucide.createIcons();
  },

  // ── BOM / Stock Cache ─────────────────────────────────────────
  async preloadBOM() {
    if (!this.allProducts.length) return;
    const allVariantIds = this.allProducts.flatMap(p => p.variants.map(v => v.id));
    if (!allVariantIds.length) return;
    try {
      const { data: recipesData } = await db.from('recipes')
        .select('id, variant_id').in('variant_id', allVariantIds);

      const recipeMap = {};
      for (const r of (recipesData || [])) recipeMap[r.variant_id] = r.id;

      const recipeIds = Object.values(recipeMap);
      if (!recipeIds.length) {
        this.bomData = { recipeMap: {}, recipeItemsMap: {} };
        this.stockCache = new Map();
        return;
      }

      const [itemsRes, invRes] = await Promise.all([
        db.from('recipe_items')
          .select('recipe_id, ingredient_id, quantity, ingredients(name, unit)')
          .in('recipe_id', recipeIds),
        db.from('branch_inventory')
          .select('ingredient_id, stock')
          .eq('branch_id', this.branch.id)
      ]);

      const recipeItemsMap = {};
      for (const ri of (itemsRes.data || [])) {
        if (!recipeItemsMap[ri.recipe_id]) recipeItemsMap[ri.recipe_id] = [];
        recipeItemsMap[ri.recipe_id].push(ri);
      }

      const stockCache = new Map();
      for (const row of (invRes.data || [])) {
        stockCache.set(row.ingredient_id, parseFloat(row.stock));
      }

      this.bomData    = { recipeMap, recipeItemsMap };
      this.stockCache = stockCache;
    } catch (e) {
      // Non-fatal: fall back to allowing all adds; checkout will re-validate via DB
      this.bomData    = null;
      this.stockCache = null;
    }
  },

  async refreshStockCache() {
    if (!this.bomData || !this.branch) return;
    try {
      const { data } = await db.from('branch_inventory')
        .select('ingredient_id, stock').eq('branch_id', this.branch.id);
      const stockCache = new Map();
      for (const row of (data || [])) stockCache.set(row.ingredient_id, parseFloat(row.stock));
      this.stockCache = stockCache;
    } catch (e) { /* non-fatal */ }
  },

  async _applyBOMDeduction(cart, trxId, preStock) {
    if (!this.bomData || !this.branch) return;
    try {
      await this.refreshStockCache();
      const { recipeMap, recipeItemsMap } = this.bomData;
      for (const item of cart) {
        const recipeId = recipeMap[item.variantId];
        if (!recipeId) continue;
        for (const bi of (recipeItemsMap[recipeId] || [])) {
          const expected  = bi.quantity * item.quantity;
          const preLvl    = preStock.get(bi.ingredient_id) ?? 0;
          const postLvl   = this.stockCache.get(bi.ingredient_id) ?? 0;
          const remaining = expected - (preLvl - postLvl);
          if (remaining > 0.0001) {
            await inventoryService.adjustStock({
              branchId:      this.branch.id,
              ingredientId:  bi.ingredient_id,
              qty:           remaining,
              type:          'out',
              referenceType: 'transaction',
              referenceId:   trxId,
              notes:         `${item.productName} ×${item.quantity}`,
              createdBy:     this.user.id
            });
          }
        }
      }
      await this.refreshStockCache();
    } catch (e) {
      console.warn('BOM stock deduction correction failed:', e.message);
    }
  },

  async _applyBOMRestore(txItems, trxId, preStock) {
    if (!this.bomData || !this.branch || !txItems.length) return;
    try {
      await this.refreshStockCache();
      const { recipeMap, recipeItemsMap } = this.bomData;
      for (const item of txItems) {
        const recipeId = recipeMap[item.variant_id];
        if (!recipeId) continue;
        for (const bi of (recipeItemsMap[recipeId] || [])) {
          const expected  = bi.quantity * item.quantity;
          const preLvl    = preStock.get(bi.ingredient_id) ?? 0;
          const postLvl   = this.stockCache.get(bi.ingredient_id) ?? 0;
          const remaining = expected - (postLvl - preLvl);
          if (remaining > 0.0001) {
            await inventoryService.adjustStock({
              branchId:      this.branch.id,
              ingredientId:  bi.ingredient_id,
              qty:           remaining,
              type:          'in',
              referenceType: 'void',
              referenceId:   trxId,
              notes:         `Void transaksi #${trxId}`,
              createdBy:     this.user.id
            });
          }
        }
      }
      await this.refreshStockCache();
    } catch (e) {
      console.warn('BOM stock restore correction failed:', e.message);
    }
  },

  checkStockFromCache(cart) {
    if (!this.bomData || !this.stockCache) return { ok: true, insufficient: [] };
    const { recipeMap, recipeItemsMap } = this.bomData;
    const insufficient = [];
    for (const item of cart) {
      const recipeId = recipeMap[item.variantId];
      if (!recipeId) continue;
      for (const ri of (recipeItemsMap[recipeId] || [])) {
        const needed    = ri.quantity * item.quantity;
        const available = this.stockCache.get(ri.ingredient_id) ?? 0;
        if (available < needed) {
          insufficient.push({
            item:       item.productName,
            variant:    item.variantName,
            ingredient: ri.ingredients?.name || '?',
            unit:       ri.ingredients?.unit || '',
            needed,
            available
          });
        }
      }
    }
    return { ok: insufficient.length === 0, insufficient };
  },

  // ── Product / Variant Selection ───────────────────────────────
  selectProduct(productId) {
    const product = this.allProducts.find(p => p.productId === productId);
    if (!product) return;

    if (product.variants.length === 1) {
      this.checkAndShowToppings(product.variants[0].id, product);
    } else {
      this.openVariantSelect(product);
    }
  },

  openVariantSelect(product) {
    const vsNameEl = document.getElementById('vs-product-name');
    if (vsNameEl) vsNameEl.textContent = product.productName;
    const vsCatEl = document.getElementById('vs-product-category');
    if (vsCatEl) vsCatEl.textContent = product.category;

    const imgEl = document.getElementById('vs-product-img');
    imgEl.innerHTML = product.imageUrl
      ? `<img loading="lazy" src="${escapeHtml(product.imageUrl)}" alt="${escapeHtml(product.productName)}" class="img-cover" onerror="this.outerHTML='<div class=&quot;product-img-placeholder&quot;><i data-lucide=&quot;package&quot; class=&quot;icon-xl&quot;></i></div>'; if(window.lucide) lucide.createIcons();">`
      : `<i data-lucide="package" class="icon-xl"></i>`;
    if (window.lucide) lucide.createIcons();

    document.getElementById('variant-select-list').innerHTML = product.variants.map(v => `
      <button class="variant-select-btn" data-action="select-variant" data-id="${v.id}" data-product="${product.productId}">
        <span class="variant-select-name">${escapeHtml(v.name)}</span>
        <span class="variant-select-price">${formatRupiah(v.price)}</span>
      </button>`).join('');

    openModal('modal-variant-select');
  },

  selectVariant(variantId, productId) {
    closeModal('modal-variant-select');
    const product = this.allProducts.find(p => p.productId === productId);
    if (!product) return;
    this.checkAndShowToppings(variantId, product);
  },

  // ── Cart: Add ────────────────────────────────────────────────
  addToCart(variantId, product, toppings = []) {
    if (this.loading) return;
    if (!this.session) {
      showToast('Buka shift terlebih dahulu sebelum bertransaksi', 'warning');
      openModal('modal-shift');
      return;
    }

    const now = Date.now();
    const clickKey = variantId + ':' + (toppings.map(t=>t.id).sort().join(','));
    if (this._clickTs[clickKey] && now - this._clickTs[clickKey] < 400) return;
    this._clickTs[clickKey] = now;

    const variant = product?.variants?.find(v => v.id === variantId);
    if (!variant || !product) return;

    // Merge if same variant + same toppings already in cart
    const toppingKey = toppings.map(t => t.id).sort().join(',');
    const existing   = this.cart.find(c => c.variantId === variantId && c._toppingKey === toppingKey);
    const newQty     = (existing ? existing.quantity : 0) + 1;

    const cartItem = {
      cartItemId:  existing ? existing.cartItemId : ++this._cartIdCounter,
      variantId,
      productId:   product.productId,
      productName: product.productName,
      variantName: variant.name,
      price:       variant.price,
      customPrice: null,
      toppings:    toppings,
      _toppingKey: toppingKey,
      category:    product.category,
      imageUrl:    product.imageUrl,
      quantity:    newQty
    };

    const check = this.checkStockFromCache([cartItem]);
    if (!check.ok) {
      const detail = check.insufficient?.[0];
      if (detail) {
        showToast(`Stok ${detail.ingredient} tidak cukup (butuh ${detail.needed} ${detail.unit}, tersedia ${detail.available})`, 'error');
      } else {
        showToast('Stok bahan tidak cukup!', 'error');
      }
      return;
    }

    if (existing) {
      existing.quantity = newQty;
    } else {
      this.cart.push({ ...cartItem, quantity: 1 });
    }
    this.renderCart();
    const toppingLabel = toppings.length ? ` + ${toppings.map(t=>t.name).join(', ')}` : '';
    showToast(`${product.productName} (${variant.name})${toppingLabel} ditambahkan`, 'success');
  },

  // ── Cart: Qty controls ───────────────────────────────────────
  changeQty(cartItemId, delta) {
    if (this.loading) return;
    const idx  = this.cart.findIndex(c => c.cartItemId === cartItemId);
    if (idx < 0) return;
    const newQty = this.cart[idx].quantity + delta;
    if (newQty <= 0) { this.removeFromCart(cartItemId); return; }

    if (delta > 0) {
      const check = this.checkStockFromCache([{ ...this.cart[idx], quantity: newQty }]);
      if (!check.ok) {
        const detail = check.insufficient?.[0];
        if (detail) {
          showToast(`Stok ${detail.ingredient} tidak cukup (butuh ${detail.needed} ${detail.unit}, tersedia ${detail.available})`, 'error');
        } else {
          showToast('Stok bahan tidak cukup!', 'error');
        }
        return;
      }
    }
    this.cart[idx].quantity = newQty;
    this.renderCart();
  },

  setQty(cartItemId, val) {
    const qty = Number(val);
    if (!Number.isFinite(qty) || qty <= 0) { this.removeFromCart(cartItemId); return; }
    const idx = this.cart.findIndex(c => c.cartItemId === cartItemId);
    if (idx < 0) return;
    const check = this.checkStockFromCache([{ ...this.cart[idx], quantity: qty }]);
    if (!check.ok) {
      const detail = check.insufficient?.[0];
      if (detail) {
        showToast(`Stok ${detail.ingredient} tidak cukup (butuh ${detail.needed} ${detail.unit}, tersedia ${detail.available})`, 'error');
      } else {
        showToast('Stok tidak cukup untuk jumlah tersebut', 'error');
      }
      return;
    }
    this.cart[idx].quantity = qty;
    this.renderCart();
  },

  removeFromCart(cartItemId) {
    this.cart = this.cart.filter(c => c.cartItemId !== cartItemId);
    this.renderCart();
  },

  async clearCart() {
    if (!this.cart.length) return;
    const ok = await showConfirm({
      title:       'Hapus keranjang?',
      message:     'Semua item di keranjang akan dihapus.',
      confirmText: 'Ya, Hapus',
      danger:      true,
      icon:        '🗑️'
    });
    if (ok) { this.cart = []; this.renderCart(); }
  },

  // ── Hold / Resume Cart ───────────────────────────────────────
  holdCart() {
    if (!this.cart.length) { showToast('Keranjang kosong', 'warning'); return; }
    const t    = new Date().toLocaleTimeString('id-ID', { hour:'2-digit', minute:'2-digit' });
    const name = `Tahan ${t} (${this.cart.length} item)`;
    this.heldCarts.push({ label: name, cart: [...this.cart], ts: Date.now() });
    this.cart = [];
    this.renderCart();
    this.updateHeldBadge();
    showToast('Keranjang ditahan', 'success');
  },

  updateHeldBadge() {
    const el = document.getElementById('held-cart-badge');
    if (el) { el.textContent = this.heldCarts.length; el.style.display = this.heldCarts.length ? 'flex' : 'none'; }
  },

  showHeldCarts() {
    const list = document.getElementById('held-carts-list');
    if (!this.heldCarts.length) {
      list.innerHTML = '<p class="text-muted text-center p-6">Tidak ada keranjang ditahan</p>';
    } else {
      list.innerHTML = this.heldCarts.map((h, i) => `
        <div class="flex items-center justify-between p-3 border-b">
          <div>
            <div class="fw-600">${escapeHtml(h.label)}</div>
            <div class="text-xs text-muted">${h.cart.reduce((s,c)=>s+c.quantity,0)} pcs · ${formatRupiah(h.cart.reduce((s,c)=>s+((c.customPrice??c.price)+(c.toppings||[]).reduce((ts,t)=>ts+t.price,0))*c.quantity,0))}</div>
          </div>
          <div class="flex gap-2">
            <button class="btn btn-primary btn-sm" data-action="resume-cart" data-index="${i}">Ambil</button>
            <button class="btn btn-sm btn-danger-ghost" data-action="delete-held" data-index="${i}">Hapus</button>
          </div>
        </div>`).join('');
    }
    openModal('modal-held-carts');
  },

  async resumeCart(index) {
    if (!Array.isArray(this.heldCarts) || index == null || index < 0 || index >= this.heldCarts.length) { showToast('Keranjang tidak ditemukan', 'error'); return; }
    const doResume = () => {
      this.cart = [...this.heldCarts[index].cart];
      this.heldCarts.splice(index, 1);
      closeModal('modal-held-carts');
      this.renderCart();
      this.updateHeldBadge();
      showToast('Keranjang dipulihkan', 'success');
    };
    if (this.cart.length) {
      const ok = await showConfirm({
        title:       'Ganti Keranjang?',
        message:     'Keranjang saat ini akan digantikan oleh keranjang yang ditahan. Lanjutkan?',
        confirmText: 'Ya, Ganti',
        danger:      true,
        icon:        '🔄'
      });
      if (ok) doResume();
    } else {
      doResume();
    }
  },

  async deleteHeld(index) {
    if (!Array.isArray(this.heldCarts) || index == null || index < 0 || index >= this.heldCarts.length) { showToast('Keranjang tidak ditemukan', 'error'); return; }
    const ok = await showConfirm({
      title:       'Hapus Keranjang Ditahan?',
      message:     'Keranjang yang ditahan ini akan dihapus permanen.',
      confirmText: 'Ya, Hapus',
      danger:      true,
      icon:        '🗑️'
    });
    if (!ok) return;
    this.heldCarts.splice(index, 1);
    this.updateHeldBadge();
    this.showHeldCarts();
  },

  // ── Cart: Render ─────────────────────────────────────────────
  renderCart() {
    const itemsEl  = document.getElementById('cart-items');
    const emptyEl  = document.getElementById('cart-empty');
    const footerEl = document.getElementById('cart-footer');
    const countEl  = document.getElementById('cart-count');

    const subtotal = this.cartSubtotal();
    const disc     = this.calcDiscount(subtotal);
    const total    = Math.max(0, subtotal - disc);
    const count    = this.cart.reduce((s, i) => s + i.quantity, 0);

    if (countEl) countEl.textContent = count;
    const fabBadge   = document.getElementById('fab-cart-count');
    const fabCartBtn = document.getElementById('fab-cart-btn');
    const fabTotal   = document.getElementById('fab-cart-total');

    if (fabBadge) { fabBadge.textContent = count; fabBadge.style.display = count > 0 ? 'inline-block' : 'none'; }
    if (fabTotal) { fabTotal.textContent = formatRupiah(total); }
    if (fabCartBtn) {
      const pKasir   = document.getElementById('panel-kasir');
      const viewCart = document.getElementById('view-cart');
      const kasirVis  = pKasir ? window.getComputedStyle(pKasir).display !== 'none' : false;
      const cartShown = viewCart ? !viewCart.hidden : false;
      if (count > 0 && !cartShown && kasirVis) {
        fabCartBtn.classList.add('show');
      } else {
        fabCartBtn.classList.remove('show');
      }
    }

    if (!this.cart.length) {
      if (itemsEl)  itemsEl.innerHTML = '';
      if (emptyEl)  emptyEl.classList.remove('hidden');
      if (footerEl) footerEl.classList.add('hidden');
      if (itemsEl)  itemsEl.classList.add('hidden');
      return;
    }

    if (emptyEl)  emptyEl.classList.add('hidden');
    if (footerEl) footerEl.classList.remove('hidden');
    if (itemsEl)  itemsEl.classList.remove('hidden');

    itemsEl.innerHTML = this.cart.map(item => {
      const toppingTotal = (item.toppings || []).reduce((s, t) => s + t.price, 0);
      const basePrice    = item.customPrice ?? item.price;
      const effPrice     = basePrice + toppingTotal;
      const isCustom     = item.customPrice != null;
      const toppingHtml  = item.toppings?.length
        ? `<div style="font-size:10px;color:var(--text-muted);margin-top:2px">${item.toppings.map(t => escapeHtml(t.name) + (t.price > 0 ? ' (+' + formatRupiah(t.price) + ')' : '')).join(', ')}</div>`
        : '';
      return `
      <div class="cart-item">
        <div class="cart-item-info">
          <div class="cart-item-name">${escapeHtml(item.productName)}</div>
          <div class="cart-item-variant">${escapeHtml(item.variantName)}</div>
          ${toppingHtml}
          <div class="cart-item-price" style="display:flex;align-items:center;gap:4px;flex-wrap:wrap;margin-top:2px">
            <button class="cart-price-btn" data-action="edit-item-price" data-id="${item.cartItemId}" title="Ubah harga">
              ${formatRupiah(effPrice)}<i data-lucide="pencil" style="width:10px;height:10px;margin-left:3px;opacity:.6;"></i>
            </button>
            ${isCustom ? `<span style="font-size:9px;background:var(--warning-bg);color:var(--warning);padding:1px 5px;border-radius:4px;font-weight:700;">Custom</span>` : ''}
          </div>
        </div>
        <div class="cart-item-qty">
          <button class="qty-btn minus" data-action="qty-minus" data-id="${item.cartItemId}">−</button>
          <input class="qty-input" type="number" min="1" value="${item.quantity}" data-action="qty-set" data-id="${item.cartItemId}" />
          <button class="qty-btn" data-action="qty-plus" data-id="${item.cartItemId}">+</button>
        </div>
        <div class="cart-item-sub">${formatRupiah(effPrice * item.quantity)}</div>
        <button class="cart-item-delete" data-action="remove-cart" data-id="${item.cartItemId}" title="Hapus"><i data-lucide="trash-2" class="icon-sm"></i></button>
      </div>`;
    }).join('');
    if (window.lucide) lucide.createIcons();

    const countTextEl = document.getElementById('cart-items-count-text');
    if (countTextEl) countTextEl.textContent = `${count} item`;
    const cartSubtotalTextEl = document.getElementById('cart-subtotal-text');
    if (cartSubtotalTextEl) cartSubtotalTextEl.textContent = formatRupiah(subtotal);

    const discRow = document.getElementById('cart-discount-row');
    if (discRow) {
      discRow.classList.toggle('hidden', disc <= 0);
      const discEl = document.getElementById('cart-discount-text');
      if (discEl) discEl.textContent = '−' + formatRupiah(disc);
    }
    const cartTotalDisplayEl = document.getElementById('cart-total-display');
    if (cartTotalDisplayEl) cartTotalDisplayEl.textContent = formatRupiah(total);
  },

  cartSubtotal() {
    return this.cart.reduce((s, i) => {
      const base         = i.customPrice ?? i.price;
      const toppingTotal = (i.toppings || []).reduce((ts, t) => ts + t.price, 0);
      return s + (base + toppingTotal) * i.quantity;
    }, 0);
  },
  calcDiscount(subtotal) {
    if (this.discount.type === 'pct')   return Math.round(subtotal * this.discount.value / 100);
    if (this.discount.type === 'fixed') return Math.min(this.discount.value, subtotal);
    return 0;
  },

  // ── SPA View Swap ─────────────────────────────────────────────
  switchView(target) {
    const viewKasir = document.getElementById('view-kasir');
    const viewCart  = document.getElementById('view-cart');
    if (!viewKasir || !viewCart) return;

    if (target === 'cart') {
      this._savedScrollTop = document.getElementById('panel-products')?.scrollTop ?? 0;
      viewKasir.hidden = true;
      viewCart.hidden  = false;
      history.pushState({ posView: 'cart' }, '');
      this.renderCart();
    } else {
      viewCart.hidden  = true;
      viewKasir.hidden = false;
      const pp = document.getElementById('panel-products');
      if (pp && this._savedScrollTop) pp.scrollTop = this._savedScrollTop;
      this.renderCart();
    }
  },

  // ── Tab Switching ─────────────────────────────────────────────
  switchMainTab(tab, btnEl) {
    this.currentMainTab = tab;
    document.querySelectorAll('.pos-tab-item').forEach(b => b.classList.remove('active'));
    if (btnEl) btnEl.classList.add('active');

    const altPanels = ['panel-summary','panel-stock','panel-cash','panel-deposits','panel-transactions'];
    document.getElementById('panel-kasir').style.display = tab === 'kasir' ? '' : 'none';
    altPanels.forEach(id => {
      const el = document.getElementById(id);
      if (el) el.classList.toggle('active', id === 'panel-' + tab);
    });

    if (tab === 'kasir') {
      // reset to products view whenever switching back to kasir
      const viewCart  = document.getElementById('view-cart');
      const viewKasir = document.getElementById('view-kasir');
      if (viewCart)  viewCart.hidden  = true;
      if (viewKasir) viewKasir.hidden = false;
      this.renderCart();
    }
    if (tab === 'summary')      { this.loadPaymentMethodFilter(); this.loadSalesSummary(); }
    if (tab === 'stock')        this.loadInventorySummary();
    if (tab === 'cash')         this.updateCashSummary();
    if (tab === 'deposits')     { if (window.depositUi) (depositUi.refreshWhenReady || depositUi.refresh).call(depositUi); }
    if (tab === 'transactions') this.loadSessionTransactions();
  },

  switchMobileDrawerTab(tab, btnEl) {
    document.querySelectorAll('.drawer-btn').forEach(b => b.classList.remove('active'));
    if (btnEl) btnEl.classList.add('active');

    if (tab === 'kasir') {
      document.getElementById('panel-kasir').style.display = '';
      ['panel-summary','panel-stock','panel-cash','panel-transactions'].forEach(id => {
        const el = document.getElementById(id);
        if (el) el.classList.remove('active');
      });
      // always reset to products view when navigating back to kasir
      const viewCart  = document.getElementById('view-cart');
      const viewKasir = document.getElementById('view-kasir');
      if (viewCart)  viewCart.hidden  = true;
      if (viewKasir) viewKasir.hidden = false;
      this.renderCart();
    } else {
      document.getElementById('panel-kasir').style.display = 'none';
      ['panel-summary','panel-stock','panel-cash','panel-deposits','panel-transactions'].forEach(id => {
        const el = document.getElementById(id);
        if (el) el.classList.toggle('active', id === 'panel-' + tab);
      });
      if (tab === 'summary')      { this.loadPaymentMethodFilter(); this.loadSalesSummary(); }
      if (tab === 'stock')        this.loadInventorySummary();
      if (tab === 'cash')         this.updateCashSummary();
      if (tab === 'deposits')     { if (window.depositUi) (depositUi.refreshWhenReady || depositUi.refresh).call(depositUi); }
      if (tab === 'transactions') this.loadSessionTransactions();
    }

    this.closeMobileDrawer();
  },

  closeMobileDrawer() {
    const drawer = document.getElementById('pos-mobile-drawer');
    const overlay = document.getElementById('mobile-drawer-overlay');
    if (drawer) drawer.classList.remove('active');
    if (overlay) overlay.classList.remove('active');
  },

  async confirmLogout() {
    const ok = await showConfirm({
      title:       'Yakin ingin keluar?',
      message:     'Sesi kamu akan diakhiri dan kamu perlu login ulang.',
      confirmText: 'Ya, Keluar',
      cancelText:  'Batal',
      danger:      true,
      icon:        '🚪'
    });
    if (ok) auth.logout();
  },

  toggleMobileDrawer() {
    const drawer = document.getElementById('pos-mobile-drawer');
    const overlay = document.getElementById('mobile-drawer-overlay');
    if (!drawer || !overlay) return;
    const isActive = drawer.classList.contains('active');
    if (isActive) {
      drawer.classList.remove('active');
      overlay.classList.remove('active');
    } else {
      drawer.classList.add('active');
      overlay.classList.add('active');
    }
  },

  toggleMobileCart() {
    // Legacy method — now delegates to SPA view swap
    this.switchView('cart');
  },

  // ── Summary / Stock / Cash panels ────────────────────────────
  async loadPaymentMethodFilter() {
    const sel = document.getElementById('summary-filter-method');
    if (!sel) return;
    try {
      const { data } = await db.from('payment_methods')
        .select('code, label')
        .eq('is_active', true)
        .order('id');
      if (!data?.length) return;
      const current = sel.value;
      sel.innerHTML = '<option value="all">Semua Metode</option>' +
        data.map(m => `<option value="${m.code}">${m.label}</option>`).join('');
      if ([...sel.options].some(o => o.value === current)) sel.value = current;
    } catch(e) {
      console.warn("loadPaymentMethodFilter failed:", e.message);
    }
  },

  async loadSalesSummary() {
    if (!this.branch) return;
    const businessDate = fmt.getBusinessDate();
    const dateEl       = document.getElementById('summary-filter-date');
    const methodEl     = document.getElementById('summary-filter-method');
    if (dateEl && !dateEl.value) dateEl.value = businessDate;
    const filterDate   = dateEl?.value || businessDate;
    const filterMethod = methodEl?.value || 'all';
    const { from, to } = fmt.getBusinessDateRange(filterDate);

    const statsEl = document.getElementById('summary-stats');
    const trxEl   = document.getElementById('summary-trx-body');
    if (statsEl) statsEl.innerHTML = '<div class="text-center p-6 text-muted">Memuat...</div>';
    if (trxEl)   trxEl.innerHTML   = '<tr><td colspan="5" class="empty-td">Memuat...</td></tr>';

    let statsQ = db.from('transactions')
      .select('total, payment_method')
      .eq('branch_id', this.branch.id)
      .eq('status', 'completed')
      .gte('created_at', from)
      .lte('created_at', to);
    if (filterMethod !== 'all') statsQ = statsQ.eq('payment_method', filterMethod);

    let trxQ = db.from('transactions')
      .select('id, created_at, total, payment_method, users!staff_id(name)')
      .eq('branch_id', this.branch.id)
      .eq('status', 'completed')
      .gte('created_at', from)
      .lte('created_at', to)
      .order('created_at', { ascending: false })
      .limit(30);
    if (filterMethod !== 'all') trxQ = trxQ.eq('payment_method', filterMethod);

    const [statsRes, trxRes] = await Promise.all([statsQ, trxQ]);
    const data = statsRes.data || [];
    const totalRev = data.reduce((s, t) => s + parseFloat(t.total || 0), 0);

    const methodLabel = { cash: 'Tunai', qris: 'QRIS', transfer: 'Transfer' };
    const dateLabel = filterDate === businessDate ? 'Hari Ini' : filterDate;
    const summarySubLabel = filterDate === businessDate ? 'Semua shift hari ini' : 'Semua shift tanggal ini';

    if (statsEl) statsEl.innerHTML = `
      <div class="pos-stat-card pos-stat-card-hero">
        <div class="pos-stat-label" style="color:rgba(255,255,255,0.65)">${dateLabel}${filterMethod !== 'all' ? ' · ' + (methodLabel[filterMethod] || filterMethod) : ''}</div>
        <div class="pos-stat-value" style="color:#fff;font-size:28px">${formatRupiah(totalRev)}</div>
        <div style="color:rgba(255,255,255,0.5);font-size:11px;margin-top:4px;font-weight:500;letter-spacing:0.3px">
          ${summarySubLabel}
        </div>
      </div>
      <div class="pos-stat-card">
        <div class="pos-stat-label">Total Transaksi</div>
        <div class="pos-stat-value">${data.length} <span style="font-size:13px;color:var(--text-muted)">trx</span></div>
      </div>
      <div class="pos-stat-card">
        <div class="pos-stat-label">Rata-rata per Trx</div>
        <div class="pos-stat-value">${data.length ? formatRupiah(totalRev / data.length) : 'Rp 0'}</div>
      </div>`;

    const trxData = trxRes.data || [];
    if (trxEl) trxEl.innerHTML = trxData.length
      ? trxData.map(t => `
          <div class="trx-item" data-action="view-trx" data-id="${t.id}">
            <div class="trx-item-left">
              <div class="trx-item-row">
                <span class="text-sm fw-700">#${t.id}</span>
                <span class="badge badge-orange text-xs" style="padding: 2px 6px">${escapeHtml(fmt.titleCase(t.payment_method||'cash'))}</span>
              </div>
              <div class="text-xs text-muted">
                ${new Date(t.created_at).toLocaleTimeString('id-ID',{hour:'2-digit',minute:'2-digit'})} • Kasir: ${escapeHtml(t.users?.name||'—')}
              </div>
            </div>
            <div class="trx-item-right">
              <span class="fw-800" style="color:var(--text-main); font-size:15px">${formatRupiah(t.total)}</span>
              <span class="text-xs text-primary fw-600">Detail <i data-lucide="chevron-right" class="icon-sm" style="vertical-align:middle"></i></span>
            </div>
          </div>`).join('')
      : '<div class="p-8 text-center text-muted">Belum ada transaksi</div>';
    if (window.lucide) window.requestAnimationFrame(() => lucide.createIcons());
  },

  async loadInventorySummary() {
    if (!this.branch) return;
    const grid = document.getElementById('stock-grid');
    if (!grid) return;
    grid.innerHTML = '<div class="empty-state col-span-full"><div class="empty-icon"><svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 1 1-6.219-8.56"/></svg></div><div class="empty-title">Memuat stok...</div></div>';

    const dateEl       = document.getElementById('stock-filter-date');
    const businessDate = fmt.getBusinessDate();
    if (dateEl && !dateEl.value) dateEl.value = businessDate;
    const filterDate   = dateEl?.value || businessDate;
    const { from, to } = fmt.getBusinessDateRange(filterDate);

    const [stockRes, logsRes, manualLogsRes] = await Promise.all([
      db.from('branch_inventory').select('stock, ingredient_id, ingredients(name, unit)').eq('branch_id', this.branch.id),
      db.from('inventory_logs')
        .select('ingredient_id, qty, type, reference_type')
        .eq('branch_id', this.branch.id)
        .eq('type', 'out')
        .eq('reference_type', 'transaction')
        .gte('created_at', from)
        .lte('created_at', to),
      db.from('inventory_logs')
        .select('qty, type, notes, created_at, ingredients(name, unit), users(name)')
        .eq('branch_id', this.branch.id)
        .eq('reference_type', 'manual')
        .order('created_at', { ascending: false })
        .limit(15)
    ]);

    const stockData   = stockRes.data || [];
    const logs        = logsRes.data || [];
    const manualLogs  = manualLogsRes.data || [];

    const usageMap = {};
    logs.forEach(l => {
      const id = l.ingredient_id;
      if (!usageMap[id]) usageMap[id] = 0;
      usageMap[id] += parseFloat(l.qty || 0);
    });

    if (!stockData.length) {
      grid.innerHTML = '<div class="empty-state col-span-full"><div class="empty-icon"><i data-lucide="package" class="icon"></i></div><div class="empty-title">Belum ada data stok</div></div>';
      if (window.lucide) lucide.createIcons();
      return;
    }

    grid.innerHTML = `
      <div class="trx-list" style="grid-column:1/-1; background:var(--surface); border-radius:var(--r-lg); border:1px solid var(--border); overflow:hidden;">
        ${stockData.map((r, idx) => {
          const sisa    = parseFloat(r.stock || 0);
          const terpakai = usageMap[r.ingredient_id] || 0;
          const awal    = sisa + terpakai;
          const low     = sisa < 5;
          const unit    = escapeHtml(r.ingredients?.unit || '');
          return `
            <div class="trx-item" style="padding:16px;">
              <div class="trx-item-left" style="flex:1;">
                <div class="fw-700 text-md mb-1">${escapeHtml(r.ingredients?.name || '—')}</div>
                <div class="flex gap-3 text-xs text-muted">
                  <span>Stok Awal: <strong style="color:var(--text-main)">${awal.toLocaleString('id-ID')} ${unit}</strong></span>
                  <span>Terpakai: <strong class="text-danger">${terpakai > 0 ? '−'+terpakai.toLocaleString('id-ID') : '0'} ${unit}</strong></span>
                </div>
              </div>
              <div class="trx-item-right" style="text-align:right; min-width:80px;">
                <div class="text-xs text-muted mb-1">Sisa Saat Ini</div>
                <div class="fw-800 text-lg ${low ? 'text-danger' : 'text-success'}">
                  ${sisa.toLocaleString('id-ID')} <span class="text-xs fw-500 text-muted">${unit}</span>
                </div>
                ${low ? '<div class="mt-1"><span class="badge badge-danger" style="font-size:9px">Menipis</span></div>' : ''}
              </div>
            </div>
          `;
        }).join('')}
      </div>`;

    const logSection = document.getElementById('stock-log-section');
    if (logSection) {
      if (manualLogs.length) {
        logSection.innerHTML = `
          <div class="fw-700 text-sm mb-2" style="color:var(--text-sub);">Riwayat Penyesuaian Stok</div>
          <div class="trx-list" style="background:var(--surface);border-radius:var(--r-lg);border:1px solid var(--border);overflow:hidden;">
            ${manualLogs.map(l => {
              const ts    = new Date(l.created_at);
              const tStr  = ts.toLocaleString('id-ID', { day:'2-digit', month:'short', hour:'2-digit', minute:'2-digit' });
              const isIn  = l.type === 'in';
              const qty   = parseFloat(l.qty || 0);
              const unit  = escapeHtml(l.ingredients?.unit || '');
              const name  = escapeHtml(l.ingredients?.name || '—');
              const actor = escapeHtml(l.users?.name || 'Staff');
              return `
                <div class="trx-item" style="padding:12px 16px;gap:10px;">
                  <div style="width:28px;height:28px;border-radius:50%;flex-shrink:0;display:flex;align-items:center;justify-content:center;background:${isIn ? 'var(--success-bg)' : 'var(--danger-bg)'};">
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="${isIn ? 'var(--success)' : 'var(--danger)'}" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">${isIn ? '<polyline points="18 15 12 9 6 15"/>' : '<polyline points="6 9 12 15 18 9"/>'}</svg>
                  </div>
                  <div style="flex:1;min-width:0;">
                    <div class="fw-600 text-sm">${name}</div>
                    <div class="text-xs text-muted" style="margin-top:2px;">${escapeHtml(l.notes || '—')} &bull; ${actor}</div>
                  </div>
                  <div style="text-align:right;flex-shrink:0;">
                    <div class="fw-700 text-sm ${isIn ? 'text-success' : 'text-danger'}">${isIn ? '+' : '−'}${qty.toLocaleString('id-ID')} ${unit}</div>
                    <div class="text-xs text-muted">${tStr}</div>
                  </div>
                </div>`;
            }).join('')}
          </div>`;
      } else {
        logSection.innerHTML = '';
      }
    }

    if (window.lucide) lucide.createIcons();
  },

  // ── Stock Adjust (Staff & Admin) ──────────────────────────────
  async openStockAdjustModal() {
    if (!this.branch) return;
    const [ingRes, branchRes] = await Promise.all([
      db.from('ingredients').select('id, name, unit').order('name'),
      db.from('branches').select('id, name').order('name')
    ]);

    const sel = document.getElementById('stock-adj-ingredient');
    if (!sel) return;

    if (ingRes.error || !ingRes.data?.length) {
      showToast('Belum ada bahan baku terdaftar. Tambahkan di menu Admin → Bahan Baku.', 'warning');
      return;
    }

    sel.innerHTML = ingRes.data
      .map(i => `<option value="${i.id}">${escapeHtml(i.name)} (${escapeHtml(i.unit)})</option>`)
      .join('');

    const targetSel = document.getElementById('stock-adj-target-branch');
    if (targetSel) {
      targetSel.innerHTML = (branchRes.data || [])
        .filter(b => b.id !== this.branch.id)
        .map(b => `<option value="${b.id}">${escapeHtml(b.name)}</option>`)
        .join('');
    }

    document.getElementById('stock-adj-qty').value   = '';
    document.getElementById('stock-adj-notes').value = '';
    document.getElementById('stock-adj-type').value  = 'in';
    const transferDiv = document.getElementById('stock-adj-transfer-target');
    if (transferDiv) transferDiv.style.display = 'none';
    openModal('modal-stock-adjust');
  },

  async submitStockAdjust() {
    const ingredientId = parseInt(document.getElementById('stock-adj-ingredient').value);
    const qty          = safeNum(document.getElementById('stock-adj-qty').value, 'Jumlah');
    const type         = document.getElementById('stock-adj-type').value;
    const notes        = (document.getElementById('stock-adj-notes').value || '').trim();

    if (!ingredientId || !qty || qty <= 0) {
      showToast('Pilih bahan baku dan isi jumlah dengan benar', 'error');
      return;
    }

    const btn = document.getElementById('btn-submit-stock-adj');
    if (btn) { btn.disabled = true; btn.textContent = 'Menyimpan...'; }

    try {
      if (type === 'transfer') {
        const targetBranchId = parseInt(document.getElementById('stock-adj-target-branch').value);
        if (!targetBranchId) throw new Error('Pilih outlet tujuan');
        if (targetBranchId === this.branch.id) throw new Error('Outlet tujuan tidak boleh sama');

        await inventoryService.transferStock({
          fromBranchId: this.branch.id,
          toBranchId:   targetBranchId,
          ingredientId,
          qty,
          notes:        notes || `Transfer dari ${this.branch.name}`,
          userId:       this.user.id
        });

        await db.from('stock_transfer_notifications').insert({
          from_branch_id: this.branch.id,
          to_branch_id:   targetBranchId,
          ingredient_id:  ingredientId,
          qty,
          notes:          notes || null,
          created_by:     this.user.id,
          is_read:        false
        });

        closeModal('modal-stock-adjust');
        this.loadInventorySummary();
        this.refreshStockCache();
        showToast('Transfer stok berhasil', 'success');
        return;
      }

      await inventoryService.adjustStock({
        branchId:      this.branch.id,
        ingredientId,
        qty,
        type,
        referenceType: 'manual',
        notes:         notes || null,
        createdBy:     this.user.id
      });
      showToast('Stok berhasil diperbarui', 'success');
      closeModal('modal-stock-adjust');
      this.loadInventorySummary();
      this.refreshStockCache();
    } catch(e) {
      showToast('Gagal memperbarui stok: ' + e.message, 'error');
    } finally {
      if (btn) { btn.disabled = false; btn.innerHTML = '<i data-lucide="check" class="icon-sm"></i> Simpan'; if (window.lucide) lucide.createIcons(); }
    }
  },

  // ── Stock Adjust: Toggle Transfer Target ─────────────────────
  toggleStockAdjType() {
    const type        = document.getElementById('stock-adj-type').value;
    const transferDiv = document.getElementById('stock-adj-transfer-target');
    if (transferDiv) transferDiv.style.display = type === 'transfer' ? '' : 'none';
  },

  // ── Transfer Notifications Polling ───────────────────────────
  async _checkTransferNotifications() {
    if (!this.branch?.id) return;
    try {
      const { data: notifs } = await db.from('stock_transfer_notifications')
        .select('id, qty, notes, created_at, from_branch_id, ingredient_id, branches!from_branch_id(name), ingredients(name, unit)')
        .eq('to_branch_id', this.branch.id)
        .eq('is_read', false)
        .order('created_at', { ascending: true })
        .limit(5);

      if (!notifs?.length) return;
      this._showTransferNotif(notifs, 0);
    } catch (e) {
      console.warn('[POS] Transfer notif check failed:', e.message);
    }
  },

  async _showTransferNotif(notifs, index) {
    if (index >= notifs.length) return;
    const n = notifs[index];

    const fromName = n.branches?.name || 'Outlet lain';
    const ingName  = n.ingredients?.name || '?';
    const ingUnit  = n.ingredients?.unit || '';
    const qty      = parseFloat(n.qty);

    const body = document.getElementById('transfer-notif-body');
    body.innerHTML = `
      <p style="color:var(--text-muted);font-size:13px;margin:0 0 12px;">Transfer baru diterima:</p>
      <div class="transfer-notif-detail">
        <div class="transfer-notif-row">
          <span class="label">Dari Outlet</span>
          <span class="value fw-700">${escapeHtml(fromName)}</span>
        </div>
        <div class="transfer-notif-row">
          <span class="label">Bahan</span>
          <span class="value">${escapeHtml(ingName)}</span>
        </div>
        <div class="transfer-notif-row">
          <span class="label">Jumlah Masuk</span>
          <span class="value fw-700" style="color:var(--success);">+${qty.toLocaleString('id-ID')} ${escapeHtml(ingUnit)}</span>
        </div>
      </div>`;

    const modal     = document.getElementById('modal-transfer-notif');
    const btn       = document.getElementById('btn-close-transfer-notif');
    const countdown = document.getElementById('transfer-notif-countdown');

    modal.style.display = 'flex';
    btn.disabled = true;
    countdown.textContent = '3';

    let secs = 3;
    const timer = setInterval(() => {
      secs--;
      countdown.textContent = secs;
      if (secs <= 0) {
        clearInterval(timer);
        btn.disabled = false;
        btn.textContent = 'Mengerti';
      }
    }, 1000);

    const closeHandler = async () => {
      clearInterval(timer);
      modal.style.display = 'none';
      btn.removeEventListener('click', closeHandler);
      try {
        await db.from('stock_transfer_notifications').update({ is_read: true }).eq('id', n.id);
      } catch (e) {
        console.warn('[POS] mark notif read failed:', e.message);
      }
      this._showTransferNotif(notifs, index + 1);
      if (this.currentMainTab === 'stock') this.loadInventorySummary();
    };
    btn.addEventListener('click', closeHandler);
  },

  // ── Harga Custom per Item ────────────────────────────────────
  async editItemPrice(cartItemId) {
    const item = this.cart.find(i => i.cartItemId === cartItemId);
    if (!item) return;
    const minPrice  = item.price;
    const currPrice = item.customPrice ?? item.price;

    const val = await showPrompt({
      title:       'Harga Custom',
      message:     `${escapeHtml(item.productName)} — ${escapeHtml(item.variantName)}\nHarga minimal: ${formatRupiah(minPrice)}`,
      placeholder: String(currPrice),
      confirmText: 'Terapkan',
    });
    if (val === null) return;

    const raw = val.toString().replace(/\D/g, '');
    const newPrice = parseInt(raw, 10);
    if (!newPrice || isNaN(newPrice)) { showToast('Masukkan harga yang valid', 'error'); return; }
    if (newPrice < minPrice) {
      showToast(`Harga tidak boleh di bawah harga jual: ${formatRupiah(minPrice)}`, 'error');
      return;
    }
    item.customPrice = newPrice === minPrice ? null : newPrice;
    this.renderCart();
    this._updatePaymentTotals();
    showToast(item.customPrice ? `Harga diubah ke ${formatRupiah(newPrice)}` : 'Harga dikembalikan ke harga normal', 'success');
  },

  // ── Cash Tab ─────────────────────────────────────────────────
  _cashSubTab: 'in',

  async updateCashSummary() {
    const el = document.getElementById('cash-summary-content');
    if (!el) return;
    if (!this.session) {
      el.innerHTML = `<div class="empty-state">
        <div class="empty-icon"><i data-lucide="alert-triangle" class="icon"></i></div>
        <div class="empty-title">Belum ada shift aktif</div>
        <div class="empty-desc">Buka shift terlebih dahulu untuk mencatat kas</div>
        <div class="empty-cta"><button class="btn btn-primary" data-action="open-shift-modal">Buka Shift</button></div>
      </div>`;
      if (window.lucide) lucide.createIcons();
      return;
    }

    let summary = null;
    try { summary = await cashService.getSummary({ branchId: this.branch.id, sessionId: this.session.id }); } catch(e){}
    const openingCash  = summary?.openingCash  ?? parseFloat(this.session.opening_cash || 0);
    const salesIn      = summary?.salesIn      ?? 0;
    const totalSales   = summary?.totalSales   ?? parseFloat(this.session.total_sales || salesIn);
    const manualIn     = summary?.manualIn     ?? 0;
    const manualOut    = summary?.manualOut    ?? 0;
    const expectedCash = summary?.expectedCash ?? (openingCash + salesIn + manualIn - manualOut);

    if (!this._cashCategories?.length) {
      try { this._cashCategories = await cashService.getCategories(); } catch(e) { this._cashCategories = []; }
    }

    const tab = this._cashSubTab || 'in';
    const cats = (this._cashCategories || []).filter(c => c.type === tab);

    let logs = [];
    try { logs = await cashService.getLogs({ branchId: this.branch.id, sessionId: this.session.id, includeVoided: true, limit: 100 }); } catch(e){}
    const filteredLogs = logs.filter(l => l.type === tab && l.reference_type === 'manual');

    const logsHtml = filteredLogs.length
      ? filteredLogs.map(l => `
          <div class="cash-log-item ${l.is_void ? 'cash-log-voided' : ''}">
            <div class="cash-log-meta">
              <span class="cash-log-time">${new Date(l.created_at).toLocaleTimeString('id-ID',{hour:'2-digit',minute:'2-digit'})}</span>
              <span class="text-sm fw-600">${escapeHtml(l.cash_categories?.name || l.note || '—')}</span>
              ${l.note ? `<span class="text-xs text-muted">${escapeHtml(l.note)}</span>` : ''}
              ${l.creator?.name ? `<span class="text-xs text-muted">oleh ${escapeHtml(l.creator.name)}</span>` : ''}
            </div>
            <div class="cash-log-right">
              <span class="fw-700 ${l.type==='in'?'text-success':'text-danger'}">${l.type==='in'?'+':'−'}${formatRupiah(l.amount)}</span>
              ${l.is_void
                ? `<span class="badge badge-danger" style="font-size:10px"><i data-lucide="slash" class="icon-sm" style="margin-right:2px"></i> Dibatalkan ${l.voider?.name ? '('+escapeHtml(l.voider.name)+')' : ''}</span>`
                : `<button class="btn btn-outline btn-sm text-danger" style="padding:4px 10px; font-size:11px; font-weight:700" data-action="void-cash-log" data-id="${l.id}"><i data-lucide="x-circle" class="icon-sm" style="margin-right:4px"></i>Batalkan</button>`}
            </div>
          </div>`).join('')
      : `<div class="text-muted text-sm text-center p-4">Belum ada log ${tab==='in'?'kas masuk':'kas keluar'}</div>`;

    el.innerHTML = `
      <div class="flex flex-col gap-3">
        <div class="cash-stats-grid">
          <div class="cash-stat-card cash-stat-hero">
            <div class="cash-stat-label">Penjualan Tunai Shift</div>
            <div class="cash-stat-value">${formatRupiah(salesIn)}</div>
            <div style="color:rgba(255,255,255,0.5);font-size:11px;margin-top:4px;font-weight:500;letter-spacing:0.3px">
              Shift ini saja · Untuk rekonsiliasi laci
            </div>
          </div>
          <div class="cash-stat-card">
            <div class="cash-stat-label">Kas Awal</div>
            <div class="cash-stat-value">${formatRupiah(openingCash)}</div>
          </div>
          <div class="cash-stat-card">
            <div class="cash-stat-label" style="color:var(--success)">Kas Masuk</div>
            <div class="cash-stat-value text-success">+${formatRupiah(manualIn)}</div>
          </div>
          <div class="cash-stat-card">
            <div class="cash-stat-label" style="color:var(--danger)">Kas Keluar</div>
            <div class="cash-stat-value text-danger">−${formatRupiah(manualOut)}</div>
          </div>
          <div class="cash-stat-card cash-stat-expected">
            <div class="cash-stat-label">Ekspektasi Kas</div>
            <div class="cash-stat-value">${formatRupiah(expectedCash)}</div>
          </div>
        </div>

        <div class="cash-subtab-bar">
          <button class="cash-subtab-btn ${tab==='in'?'active-in':''}" data-action="switch-cash-subtab" data-type="in">
            <i data-lucide="trending-up" class="icon-sm"></i> Kas Masuk
          </button>
          <button class="cash-subtab-btn ${tab==='out'?'active-out':''}" data-action="switch-cash-subtab" data-type="out">
            <i data-lucide="trending-down" class="icon-sm"></i> Kas Keluar
          </button>
        </div>

        <div class="card">
          <div class="card-header">
            <span class="card-title">${tab==='in'?'Catat Kas Masuk':'Catat Kas Keluar'}</span>
          </div>
          <div class="p-4 flex flex-col gap-3">
            <div class="form-group">
              <label class="form-label">Kategori</label>
              <select class="form-control" id="pos-cash-category">
                <option value="">-- Pilih Kategori --</option>
                ${cats.map(c=>`<option value="${c.id}">${escapeHtml(c.name)}</option>`).join('')}
              </select>
            </div>
            <div class="form-group">
              <label class="form-label">Jumlah</label>
              <div class="input-prefix-wrap">
                <span class="input-prefix">Rp</span>
                <input type="number" class="form-control" id="pos-cash-amount" placeholder="0" min="0" />
              </div>
            </div>
            <div class="form-group">
              <label class="form-label">Keterangan (opsional)</label>
              <input type="text" class="form-control" id="pos-cash-note" placeholder="Keterangan..." />
            </div>
            <button class="btn ${tab==='in'?'btn-success':'btn-danger'} btn-full" data-action="submit-cash-entry">
              <i data-lucide="${tab==='in'?'plus-circle':'minus-circle'}" class="icon-sm"></i>
              ${tab==='in'?'Simpan Kas Masuk':'Simpan Kas Keluar'}
            </button>
          </div>
        </div>

        <div class="card">
          <div class="card-header">
            <span class="card-title">Log ${tab==='in'?'Kas Masuk':'Kas Keluar'}</span>
          </div>
          <div id="cash-log-list" class="cash-log-list">${logsHtml}</div>
        </div>

        <button class="btn btn-danger mt-2" data-action="open-close-shift">
          <i data-lucide="lock" class="icon-sm"></i> Tutup Shift
        </button>
      </div>`;
    if (window.lucide) lucide.createIcons();
  },

  switchCashSubTab(type) {
    this._cashSubTab = type;
    this._cashEntryType = type;
    this.updateCashSummary();
  },

  async voidCashLogFromPOS(logId) {
    const reason = await showPrompt({
      title:       'Alasan Void',
      message:     'Masukkan alasan untuk membatalkan log kas ini',
      placeholder: 'Contoh: Input salah',
      confirmText: 'Lanjutkan',
    });
    if (reason === null || !reason.trim()) return;
    const ok = await showConfirm({
      title:       'Void Log Kas?',
      message:     'Log kas ini akan dibatalkan dan tidak dapat dikembalikan.',
      confirmText: 'Ya, Void',
      danger:      true,
    });
    if (!ok) return;
    try {
      await cashService.voidLog({ logId, reason: reason.trim(), voidedBy: this.user.id });
      showToast('Log kas di-void', 'success');
      this.updateCashSummary();
    } catch(e) {
      showToast('Gagal: ' + e.message, 'error');
    }
  },

  async submitCashEntry() {
    if (!this.session) { showToast('Buka shift terlebih dahulu', 'warning'); return; }
    const type     = this._cashSubTab || 'in';
    const catEl    = document.getElementById('pos-cash-category');
    const amountEl = document.getElementById('pos-cash-amount');
    const noteEl   = document.getElementById('pos-cash-note');
    const amount   = parseFloat(amountEl?.value) || 0;
    const note     = noteEl?.value.trim() || null;
    const catId    = catEl?.value || null;
    if (amount <= 0) { showToast('Jumlah harus lebih dari 0', 'error'); return; }
    try {
      await cashService.logCash({
        branchId:      this.branch.id,
        sessionId:     this.session.id,
        type,
        categoryId:    catId || null,
        amount,
        note,
        createdBy:     this.user.id,
        referenceType: 'manual'
      });
      showToast(`Kas ${type === 'in' ? 'masuk' : 'keluar'} berhasil dicatat`, 'success');
      await this.updateCashSummary();
    } catch(e) {
      showToast('Gagal: ' + e.message, 'error');
    }
  },

  // ── Payment Modal ────────────────────────────────────────────
  async openPaymentModal() {
    if (!this.cart.length) { showToast('Keranjang masih kosong', 'warning'); return; }
    if (!this.session) {
      showToast('Buka shift terlebih dahulu sebelum bertransaksi', 'warning');
      openModal('modal-shift');
      return;
    }

    const subtotal = this.cartSubtotal();
    const disc     = this.calcDiscount(subtotal);
    const total    = Math.max(0, subtotal - disc);

    document.getElementById('payment-subtotal-display').textContent  = formatRupiah(subtotal);
    document.getElementById('payment-discount-display').textContent  = disc > 0 ? '−' + formatRupiah(disc) : '—';
    document.getElementById('payment-total-display').textContent     = formatRupiah(total);

    document.getElementById('payment-items-summary').innerHTML = this.cart.map(i => {
      const toppingTotal = (i.toppings || []).reduce((s, t) => s + t.price, 0);
      const ep = (i.customPrice ?? i.price) + toppingTotal;
      const toppingLabel = i.toppings?.length ? ` <span style="font-size:10px;color:var(--text-muted);">[${i.toppings.map(t=>escapeHtml(t.name)).join(', ')}]</span>` : '';
      const customLabel  = i.customPrice != null ? ' <span style="font-size:10px;color:var(--warning);font-weight:700;">[custom]</span>' : '';
      return `<div class="payment-summary-row">
        <span>${escapeHtml(i.productName)} (${escapeHtml(i.variantName)}) ×${i.quantity}${toppingLabel}${customLabel}</span>
        <span>${formatRupiah(ep * i.quantity)}</span>
       </div>`;
    }).join('');

    document.getElementById('discount-type').value  = this.discount.type;
    document.getElementById('discount-value').value = this.discount.value || '';
    this.toggleDiscountInput();

    const rounds = [total, roundUp(total, 5000), roundUp(total, 10000), roundUp(total, 50000)];
    document.getElementById('quick-amounts').innerHTML = [...new Set(rounds)].filter(v => v >= total).slice(0, 4)
      .map(v => `<button class="btn btn-outline btn-sm" data-action="set-quick-amount" data-amount="${v}">${formatRupiah(v)}</button>`).join('');

    document.getElementById('cash-received').value    = '';
    document.getElementById('change-display').style.display = 'none';

    try {
      const defaultMethods = [
        { code: 'cash', label: 'Tunai', icon: '' },
        { code: 'qris', label: 'QRIS', icon: '' },
        { code: 'transfer', label: 'Transfer', icon: '' }
      ];

      let methods = defaultMethods;
      try {
        const { data, error } = await db.from('payment_methods').select('code, label, fee_label, fee_percent, is_active').eq('is_active', true).order('id');
        if (!error && Array.isArray(data) && data.length) methods = data;
      } catch (dbErr) {
        const settings = JSON.parse(localStorage.getItem('pos_settings') || '{}');
        if (Array.isArray(settings.paymentMethods) && settings.paymentMethods.length) methods = settings.paymentMethods;
      }
      POS._paymentMethodsCache = methods;

      const pmWrap = document.querySelector('.payment-methods');
      if (pmWrap) {
        const iconMap = { cash: 'banknote', qris: 'qr-code', transfer: 'credit-card', gofood: 'shopping-bag', grabfood: 'shopping-bag', shopeefood: 'shopping-bag' };
        pmWrap.innerHTML = methods.map(m => {
          const iconName = iconMap[m.code.toLowerCase()] || 'wallet';
          return `
          <button class="payment-method-btn"
            data-action="select-payment-method"
            data-method="${escapeHtml(m.code)}"
            data-fee-pct="${parseFloat(m.fee_percent||0)}"
            data-fee-enabled="${m.is_fee_enabled ? 'true' : 'false'}"
            >
            <i data-lucide="${iconName}" class="icon-md pm-icon"></i>
            <span style="line-height:1.2">${escapeHtml(m.label)}${(m.is_fee_enabled && m.fee_percent) ? `<br><span style="font-size:10px;color:var(--text-muted);font-weight:500">(+${parseFloat(m.fee_percent)}%)</span>` : ''}</span>
          </button>`;
        }).join('');
        if (window.lucide) lucide.createIcons();
      }
      const defaultCode = methods.find(m => m.code === 'cash') ? 'cash' : (methods[0] && methods[0].code) || 'cash';
      this.selectPaymentMethod(document.querySelector(`.payment-method-btn[data-method="${defaultCode}"]`), defaultCode);
    } catch (e) {
      this.selectPaymentMethod(document.querySelector('.payment-method-btn[data-method="cash"]'), 'cash');
    }
    openModal('modal-payment');
  },

  toggleDiscountInput() {
    const type  = document.getElementById('discount-type').value;
    const wrap  = document.getElementById('discount-value-wrap');
    if (wrap) wrap.style.display = type === 'none' ? 'none' : 'block';
    const label = document.getElementById('discount-value-label');
    if (label) label.textContent = type === 'pct' ? 'Nilai Diskon (%)' : 'Nilai Diskon (Rp)';
  },

  applyDiscount() {
    const type     = document.getElementById('discount-type').value;
    const rawValue = parseFloat(document.getElementById('discount-value').value) || 0;
    const subtotal = this.cartSubtotal();

    if (rawValue < 0) { showToast('Diskon tidak boleh negatif', 'error'); return; }
    if (type === 'pct' && rawValue > 100) { showToast('Persentase diskon maksimal 100%', 'error'); return; }
    if (type === 'fixed' && rawValue > subtotal) {
      showToast('Diskon tidak boleh melebihi subtotal', 'error'); return;
    }

    const value = type === 'pct' ? rawValue : Math.min(rawValue, subtotal);
    this.discount = { type, value };
    this._updatePaymentTotals();
    this.renderCart();
    showToast('Diskon diterapkan: ' + formatRupiah(this.calcDiscount(subtotal)), 'success');
  },

  applyDiscountPreview() {
    const type     = document.getElementById('discount-type').value;
    const rawValue = parseFloat(document.getElementById('discount-value').value) || 0;
    const subtotal = this.cartSubtotal();
    if (type === 'none' || rawValue < 0) {
      this._updatePaymentTotals();
      return;
    }
    if (type === 'pct' && rawValue > 100) return;

    const previewDisc = type === 'pct'
      ? Math.round(subtotal * rawValue / 100)
      : Math.min(rawValue, subtotal);

    const discEl  = document.getElementById('payment-discount-display');
    const totalEl = document.getElementById('payment-total-display');
    const activeBtn = document.querySelector('.payment-method-btn.active');
    const feePct  = activeBtn ? parseFloat(activeBtn.dataset.feePct || 0) : 0;
    const feeOn   = activeBtn ? activeBtn.dataset.feeEnabled === 'true' : false;
    const fee     = (feeOn && feePct > 0) ? Math.round((subtotal - previewDisc) * feePct / 100) : 0;
    const total   = Math.max(0, subtotal - previewDisc) + fee;

    if (discEl)  discEl.textContent  = previewDisc > 0 ? '−' + formatRupiah(previewDisc) : '—';
    if (totalEl) totalEl.textContent = formatRupiah(total);
  },

  _updatePaymentTotals() {
    const subtotal  = this.cartSubtotal();
    const disc      = this.calcDiscount(subtotal);
    const activeBtn = document.querySelector('.payment-method-btn.active');
    const feePct    = activeBtn ? parseFloat(activeBtn.dataset.feePct || 0) : 0;
    const feeOn     = activeBtn ? activeBtn.dataset.feeEnabled === 'true' : false;
    const fee       = (feeOn && feePct > 0) ? Math.round((subtotal - disc) * feePct / 100) : 0;
    const total     = Math.max(0, subtotal - disc) + fee;
    const discEl    = document.getElementById('payment-discount-display');
    const totalEl   = document.getElementById('payment-total-display');
    if (discEl)  discEl.textContent  = disc > 0 ? '−' + formatRupiah(disc) : '—';
    if (totalEl) totalEl.textContent = formatRupiah(total);
  },

  selectPaymentMethod(btn, method) {
    this.paymentMethod = method;
    this.paymentMethodData = null;
    document.querySelectorAll('.payment-method-btn').forEach(b => b.classList.remove('active'));
    if (btn) btn.classList.add('active');

    const feeRow = document.getElementById('payment-fee-row');
    const feeEl  = document.getElementById('payment-fee-display');
    const feePct = btn ? parseFloat(btn.dataset.feePct || 0) : 0;
    const feeOn  = btn ? btn.dataset.feeEnabled === 'true' : false;
    const subtotal = this.cartSubtotal();
    const disc     = this.calcDiscount(subtotal);
    const base     = Math.max(0, subtotal - disc);
    const fee      = (feeOn && feePct > 0) ? Math.round(base * feePct / 100) : 0;
    if (feeRow) feeRow.style.display = fee > 0 ? 'flex' : 'none';
    if (feeEl)  feeEl.textContent    = fee > 0 ? '+' + formatRupiah(fee) : '—';
    const total = base + fee;
    const totalEl = document.getElementById('payment-total-display');
    if (totalEl) totalEl.textContent = formatRupiah(total);

    document.getElementById('cash-input-wrap').style.display = method === 'cash' ? 'flex' : 'none';
    document.getElementById('change-display').style.display  = 'none';
  },

  setQuickAmount(amount) {
    document.getElementById('cash-received').value = amount;
    this.calcChange();
  },

  calcChange() {
    const subtotal = this.cartSubtotal();
    const disc     = this.calcDiscount(subtotal);
    const activeBtn = document.querySelector('.payment-method-btn.active');
    const feePct    = activeBtn ? parseFloat(activeBtn.dataset.feePct || 0) : 0;
    const feeOn     = activeBtn ? activeBtn.dataset.feeEnabled === 'true' : false;
    const fee       = (feeOn && feePct > 0) ? Math.round(Math.max(0, subtotal - disc) * feePct / 100) : 0;
    const total     = Math.max(0, subtotal - disc) + fee;
    const received  = parseFloat(document.getElementById('cash-received').value) || 0;
    const changeEl  = document.getElementById('change-display');
    if (received >= total) {
      const changeValueEl = document.getElementById('change-value');
      if (changeValueEl) changeValueEl.textContent = formatRupiah(received - total);
      if (changeEl) changeEl.style.display = 'flex';
    } else {
      if (changeEl) changeEl.style.display = 'none';
    }
  },

  closePaymentModal() { closeModal('modal-payment'); this._updatePaymentTotals(); },

  // ── Checkout ─────────────────────────────────────────────────
  async confirmCheckout() {
    if (this._checkoutLock) return;
    if (this.loading || !this.cart.length) return;
    if (!this.session) { showToast('Buka shift terlebih dahulu sebelum checkout', 'warning'); return; }
    this._checkoutLock = true;

    let clientTxId;
    try {
      clientTxId = (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') ? crypto.randomUUID() : null;
    } catch (e) { clientTxId = null; }
    // FIX: Fallback harus menghasilkan UUID v4 valid (format: xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx)
    // agar tidak menyebabkan error "invalid input syntax for type uuid" di PostgreSQL
    if (!clientTxId) {
      clientTxId = 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
        const r = (Math.random() * 16) | 0;
        const v = c === 'x' ? r : (r & 0x3) | 0x8;
        return v.toString(16);
      });
    }

    const subtotal = this.cartSubtotal();
    const disc     = this.calcDiscount(subtotal);
    const activeBtn = document.querySelector('.payment-method-btn.active');
    const feePct    = activeBtn ? parseFloat(activeBtn.dataset.feePct || 0) : 0;
    const feeOn     = activeBtn ? activeBtn.dataset.feeEnabled === 'true' : false;
    const fee       = (feeOn && feePct > 0) ? Math.round(Math.max(0, subtotal - disc) * feePct / 100) : 0;
    const total     = Math.max(0, subtotal - disc) + fee;
    const method    = this.paymentMethod;
    let   received  = total;

    if (method === 'cash') {
      try {
        received = safeNum(document.getElementById('cash-received').value, 'Uang Diterima');
      } catch(e) {
        showToast('Masukkan jumlah uang yang diterima', 'error');
        this._checkoutLock = false;
        return;
      }
      if (received < total) {
        showToast('Uang tidak cukup!', 'error');
        this._checkoutLock = false;
        return;
      }
    }

    const btn = document.getElementById('btn-confirm-pay');

    // FIX: Set loading true only while DB operations run, reset it BEFORE showing success popup
    this.loading = true;
    try {
      const stockCheck = await inventoryService.checkBOMStock({ cart: this.cart, branchId: this.branch.id });
      if (!stockCheck.ok) {
        const items = stockCheck.insufficient || [];
        if (items.length) {
          const lines = items.map(d => `${d.ingredient}: butuh ${d.needed} ${d.unit}, tersedia ${d.available}`).join(' | ');
          showToast(`Stok kurang — ${lines}`, 'error');
        } else {
          showToast('Stok bahan tidak cukup!', 'error');
        }
        this._checkoutLock = false;
        this.loading = false;
        return;
      }
    } catch (e) {
      showToast('Gagal memeriksa stok', 'error');
      this._checkoutLock = false;
      this.loading = false;
      return;
    }

    this._pendingTxIds = this._pendingTxIds || new Set();

    if (this._pendingTxIds.has(clientTxId)) {
      showToast('Transaksi sedang diproses...', 'warning');
      this._checkoutLock = false;
      this.loading = false;
      if (btn) { btn.disabled = false; btn.textContent = 'Konfirmasi Bayar'; }
      return;
    }
    this._pendingTxIds.add(clientTxId);

    if (btn) { btn.disabled = true; btn.textContent = 'Memproses...'; }

    const preCheckoutStock = new Map(this.stockCache || []);

    try {
      const cartForTx = this.cart.map(i => {
        const toppingTotal = (i.toppings || []).reduce((s, t) => s + t.price, 0);
        const toppingNote  = i.toppings?.length ? ` [${i.toppings.map(t=>t.name).join(', ')}]` : '';
        return {
          ...i,
          price:    (i.customPrice ?? i.price) + toppingTotal,
          variantName: i.variantName + toppingNote
        };
      });
      const result = await transactionService.processTransaction({
        cart:           cartForTx,
        branchId:       this.branch.id,
        staffId:        this.user.id,
        sessionId:      this.session?.id || null,
        paymentMethod:  method,
        paymentAmount:  received,
        discountAmount: disc,
        taxAmount:      0,
        feeAmount:      fee,
        clientTxId:     clientTxId
      });

      closeModal('modal-payment');
      const savedCart = [...this.cart];
      this.cart = [];
      this.discount = { type: 'none', value: 0 };

      // FIX: Reset loading flag BEFORE showPostPaymentScreen so UI is interactive
      this.loading = false;

      this.renderCart();
      this.showPostPaymentScreen(result, savedCart, method);

      // Run BOM deduction async without blocking UI
      this._applyBOMDeduction(savedCart, result.trx.id, preCheckoutStock);
      if (this.currentMainTab === 'summary') this.loadSalesSummary();
      if (this.currentMainTab === 'stock') this.loadInventorySummary();

    } catch (err) {
      console.error(err);
      try {
        const recovered = await transactionService.getTransactionByClientTxId(clientTxId);
        if (recovered && recovered.trx) {
          closeModal('modal-payment');
          const savedCart = [...this.cart];
          this.cart = [];
          this.discount = { type: 'none', value: 0 };

          // FIX: Reset loading flag BEFORE showPostPaymentScreen on recovery path too
          this.loading = false;

          this.renderCart();
          this.showPostPaymentScreen(recovered, savedCart, method);
          this._applyBOMDeduction(savedCart, recovered.trx.id, preCheckoutStock);
          if (this.currentMainTab === 'summary') this.loadSalesSummary();
          showToast('Checkout berhasil (diproses sebelumnya)', 'success');
          return;
        }
      } catch (fetchErr) {
        console.error('Recovery fetch failed', fetchErr);
      }
      showToast('Checkout gagal: ' + (err.message || 'Coba lagi'), 'error');
    } finally {
      if (this._pendingTxIds) this._pendingTxIds.delete(clientTxId);
      this._checkoutLock = false;
      // FIX: Only reset loading here if it wasn't already reset in the success path above
      if (this.loading) this.loading = false;
      if (btn) { btn.disabled = false; btn.textContent = 'Konfirmasi Bayar'; }
    }
  },

  // ── Post-payment screen ─────────────────────────────────────
  showPostPaymentScreen(result, savedCart, method) {
    const { trx, subtotal, discountAmount: disc, total, change } = result;
    const received = trx.payment_amount != null ? trx.payment_amount : total;

    // Pre-render receipt silently so it is ready to print
    this.showReceipt(trx, subtotal, disc, total, received, change, method, savedCart, true);

    const staticLabels = { cash:'Tunai', qris:'QRIS', transfer:'Transfer' };
    const cachedMethod = (POS._paymentMethodsCache || []).find(m => m.code === method);
    const mLabel = cachedMethod?.label || staticLabels[method] || method;

    const metaEl = document.getElementById('success-popup-meta');
    if (metaEl) {
      metaEl.innerHTML =
        '<div class="spop-row"><span>Total Bayar</span><strong>' + formatRupiah(total) + '</strong></div>' +
        '<div class="spop-row"><span>Metode</span><strong>' + escapeHtml(mLabel) + '</strong></div>' +
        (method === 'cash' && change >= 0 ? '<div class="spop-row"><span>Kembalian</span><strong style="color:var(--success)">' + formatRupiah(change) + '</strong></div>' : '') +
        '<div class="spop-row" style="font-size:11px;color:var(--text-muted);"><span>No. Transaksi</span><span>#' + trx.id + '</span></div>';
    }

    openModal('modal-success-trx');
    if (window.lucide) requestAnimationFrame(() => lucide.createIcons());

    if (localStorage.getItem('printer_auto_print') === 'true') {
      requestAnimationFrame(() => window.print());
    }
  },

  // FIX: closeSuccessPopup now also ensures all locks are cleared
  closeSuccessPopup() {
    closeModal('modal-success-trx');
    this._checkoutLock = false;
    this.loading = false;
    this.switchView('kasir');
    showToast('Siap untuk transaksi berikutnya', 'success');
  },

  printReceiptAndClose() {
    window.print();
    closeModal('modal-success-trx');
    this._checkoutLock = false;
    this.loading = false;
    this.switchView('kasir');
    showToast('Siap untuk transaksi berikutnya', 'success');
  },

  // FIX: startNewTransaction properly closes modal and resets state
  startNewTransaction() {
    closeModal('modal-receipt');
    closeModal('modal-success-trx');
    // Ensure all locks are cleared so next transaction works
    this._checkoutLock = false;
    this.loading = false;
    showToast('Siap untuk transaksi berikutnya', 'success');
  },

  // ── Receipt builder ───────────────────────────────────────────
  showReceipt(trx, subtotal, disc, total, received, change, method, cart, skipModal = false) {
    const now    = new Date(trx.created_at || Date.now());
    const date   = now.toLocaleDateString('id-ID', { day:'2-digit', month:'long', year:'numeric' });
    const time   = now.toLocaleTimeString('id-ID', { hour:'2-digit', minute:'2-digit' });
    const staticLabels = { cash:'Tunai', qris:'QRIS', transfer:'Transfer' };
    const cachedMethod = (POS._paymentMethodsCache || []).find(m => m.code === method);
    const mLabel = cachedMethod?.label || staticLabels[method] || method;
    const settings   = JSON.parse(localStorage.getItem('pos_settings') || '{}');
    const shopName   = settings.shopName      || 'Roti Bakar Ngeunah';
    const headerText = settings.receiptHeader || '';
    const footerText = settings.receiptFooter || 'Terima kasih atas kunjungannya!';

    document.getElementById('receipt-content').innerHTML = `
      <div class="receipt-header">
        <div class="receipt-shop-name">${escapeHtml(shopName)}</div>
        <div class="receipt-address">${escapeHtml(this.branch.name)}</div>
        ${headerText ? headerText.split('\n').map(l=>`<div class="receipt-address">${escapeHtml(l)}</div>`).join('') : ''}
        <div class="receipt-address">${date}, ${time}</div>
        <div class="receipt-address">No. #${trx.id}</div>
        <div class="receipt-address">Kasir: <strong>${escapeHtml(this.user.name)}</strong></div>
      </div>
      <div class="receipt-divider"></div>
      ${cart.map(i=>{
        const toppingTotal = (i.toppings||[]).reduce((s,t)=>s+t.price,0);
        const ep = (i.customPrice ?? i.price) + toppingTotal;
        return `
        <div class="receipt-item-row"><span class="receipt-item-name">${escapeHtml(i.productName)} ${escapeHtml(i.variantName)}</span></div>
        ${(i.toppings||[]).length ? `<div class="receipt-item-row" style="padding-left:8px;font-size:10px;color:#777"><span>Topping: ${i.toppings.map(t=>escapeHtml(t.name)+(t.price>0?' (+'+formatRupiah(t.price)+')':'')).join(', ')}</span></div>` : ''}
        <div class="receipt-item-row" style="padding-left:8px;color:#555">
          <span>${i.quantity} x ${formatRupiah(ep)}</span>
          <span class="receipt-item-price">${formatRupiah(ep*i.quantity)}</span>
        </div>`;}).join('')}
      <div class="receipt-divider"></div>
      <div class="receipt-item-row" style="color:#555"><span>Subtotal</span><span>${formatRupiah(subtotal)}</span></div>
      ${disc>0?`<div class="receipt-item-row" style="color:#E53935"><span>Diskon</span><span>\u2212${formatRupiah(disc)}</span></div>`:''}
      <div class="receipt-total-row"><span>TOTAL</span><span>${formatRupiah(total)}</span></div>
      <div class="receipt-item-row" style="margin-top:4px;color:#555">
        <span>Pembayaran (${mLabel})</span><span>${formatRupiah(received)}</span>
      </div>
      ${method==='cash'?`<div class="receipt-item-row" style="color:#555"><span>Kembalian</span><span>${formatRupiah(change)}</span></div>`:''}
      <div class="receipt-divider"></div>
      <div class="receipt-footer">${footerText.split('\n').map(l=>`<div>${escapeHtml(l)}</div>`).join('')}</div>`;
    
    if (!skipModal) {
      openModal('modal-receipt');
    }
  },

  // ── Session Transactions Tab ────────────────────────────────
  async loadSessionTransactions() {
    const tbody = document.getElementById('pos-trx-body');
    if (!tbody) return;
    if (!this.session) {
      tbody.innerHTML = '<tr><td colspan="7" class="empty-td">Buka shift terlebih dahulu untuk melihat transaksi</td></tr>';
      return;
    }
    tbody.innerHTML = '<tr><td colspan="7" class="empty-td">Memuat...</td></tr>';
    try {
      const { data, error } = await db.from('transactions')
        .select('id, created_at, total, payment_method, status, users!staff_id(name)')
        .eq('branch_id', this.branch.id)
        .eq('session_id', this.session.id)
        .order('created_at', { ascending: false });
      if (error) throw error;
      if (!data?.length) {
        tbody.innerHTML = '<tr><td colspan="7" class="empty-td">Belum ada transaksi di shift ini</td></tr>';
        return;
      }
      const statusBadge = s => {
        if (s === 'void')      return 'badge-danger';
        if (s === 'refunded')  return 'badge-red';
        if (s === 'completed') return 'badge-green';
        return 'badge-orange';
      };
      tbody.innerHTML = data.map(t => `
        <div class="trx-item" data-action="view-trx" data-id="${t.id}">
          <div class="trx-item-left">
            <div class="trx-item-row">
              <span class="text-sm fw-700">#${t.id}</span>
              <span class="badge badge-orange text-xs" style="padding: 2px 6px">${escapeHtml(fmt.titleCase(t.payment_method||'cash'))}</span>
              <span class="badge ${statusBadge(t.status)} text-xs" style="padding: 2px 6px">${escapeHtml(fmt.titleCase(t.status||'completed'))}</span>
            </div>
            <div class="text-xs text-muted">
              ${new Date(t.created_at).toLocaleTimeString('id-ID',{hour:'2-digit',minute:'2-digit'})} • Kasir: ${escapeHtml(t.users?.name||'—')}
            </div>
          </div>
          <div class="trx-item-right">
            <span class="fw-800" style="color:var(--text-main); font-size:15px">${formatRupiah(t.total)}</span>
            <span class="text-xs text-primary fw-600">Detail <i data-lucide="chevron-right" class="icon-sm" style="vertical-align:middle"></i></span>
          </div>
        </div>`).join('');
      if (window.lucide) window.requestAnimationFrame(() => lucide.createIcons());
    } catch(e) {
      tbody.innerHTML = `<div class="p-8 text-center text-danger">Gagal: ${escapeHtml(e.message)}</div>`;
    }
  },

  _currentPosViewTrxId: null,

  async viewPosTransaction(id) {
    this._currentPosViewTrxId = id;
    const subtitleEl = document.getElementById('pos-trx-detail-subtitle');
    const bodyEl     = document.getElementById('pos-trx-detail-body');
    const voidBtn    = document.getElementById('btn-pos-void-trx');
    if (subtitleEl) subtitleEl.textContent = `#${id}`;
    if (bodyEl)     bodyEl.innerHTML = '<div class="text-center p-6 text-muted">Memuat...</div>';
    openModal('modal-pos-trx-detail');
    try {
      const [trxRes, itemsRes] = await Promise.all([
        db.from('transactions').select('*, users!staff_id(name)').eq('id', id).single(),
        db.from('transaction_items').select('*').eq('transaction_id', id)
      ]);
      const t     = trxRes.data;
      const items = itemsRes.data || [];
      if (!t) throw new Error('Transaksi tidak ditemukan');

      if (subtitleEl) subtitleEl.textContent = `#${t.id} — ${new Date(t.created_at).toLocaleString('id-ID',{day:'2-digit',month:'short',hour:'2-digit',minute:'2-digit'})}`;
      if (voidBtn) voidBtn.style.display = (t.status === 'completed') ? 'inline-flex' : 'none';

      const statusColor = t.status === 'void' ? 'text-danger' : t.status === 'refunded' ? 'text-warning' : 'text-success';
      bodyEl.innerHTML = `
        <div class="grid-2-col-s2 mb-4">
          <div><div class="form-label">Status</div><div class="fw-700 ${statusColor}">${escapeHtml(fmt.titleCase(t.status||'completed'))}</div></div>
          <div><div class="form-label">Metode</div><div><span class="badge badge-orange">${escapeHtml(fmt.titleCase(t.payment_method||'cash'))}</span></div></div>
          <div><div class="form-label">Subtotal</div><div>${formatRupiah(t.subtotal ?? t.total)}</div></div>
          <div><div class="form-label">Diskon</div><div class="text-danger">${t.discount_amount > 0 ? '−'+formatRupiah(t.discount_amount) : '—'}</div></div>
          <div><div class="form-label">Total</div><div class="fw-800 text-danger">${formatRupiah(t.total)}</div></div>
          ${t.payment_method==='cash' ? `<div><div class="form-label">Kembalian</div><div>${formatRupiah(t.change_amount)}</div></div>` : ''}
        </div>
        <div class="divider"></div>
        <div class="card-title mb-2">Item Pesanan</div>
        <div class="flex flex-col gap-2 mt-2">
          ${items.map(i => `
            <div class="flex justify-between items-center p-3" style="background:var(--surface-2);border-radius:var(--r-md);border:1px solid var(--border)">
              <div class="flex flex-col gap-1">
                <div class="fw-700 text-sm">${escapeHtml(i.product_name)} <span class="text-xs text-muted">(${escapeHtml(i.variant_name)})</span></div>
                <div class="text-xs text-muted">${i.quantity} x ${formatRupiah(i.price)}</div>
              </div>
              <div class="fw-800 text-sm text-right">
                ${formatRupiah(i.subtotal)}
              </div>
            </div>
          `).join('')}
        </div>`;
      if (window.lucide) lucide.createIcons();
    } catch(e) {
      if (bodyEl) bodyEl.innerHTML = `<div class="text-danger p-4">Gagal memuat: ${escapeHtml(e.message)}</div>`;
    }
  },

  async voidPosTransaction() {
    const id = this._currentPosViewTrxId;
    if (!id) return;
    const reason = await showPrompt({
      title:       'Alasan Void',
      message:     `Masukkan alasan pembatalan transaksi #${id}`,
      placeholder: 'Contoh: Pesanan dibatalkan pelanggan',
      confirmText: 'Lanjutkan',
    });
    if (reason === null || !reason.trim()) return;
    const ok = await showConfirm({
      title:       `Void Transaksi #${id}?`,
      message:     'Transaksi akan dibatalkan dan stok akan dikembalikan.',
      subText:     `Alasan: ${reason.trim()}`,
      confirmText: 'Ya, Void Transaksi',
      danger:      true,
    });
    if (!ok) return;
    try {
      let txItems = [];
      try {
        const { data } = await db.from('transaction_items')
          .select('variant_id, quantity')
          .eq('transaction_id', id);
        txItems = data || [];
      } catch (e) { /* non-fatal */ }

      const preVoidStock = new Map(this.stockCache || []);

      await transactionService.voidTransaction({ transactionId: id, reason: reason.trim(), userId: this.user.id });
      showToast('Transaksi berhasil di-void', 'success');
      closeModal('modal-pos-trx-detail');

      this._applyBOMRestore(txItems, id, preVoidStock);

      await this.initShift();
      this.loadSessionTransactions();
      if (this.currentMainTab === 'cash') this.updateCashSummary();
      if (this.currentMainTab === 'stock') this.loadInventorySummary();
    } catch(e) {
      showToast('Gagal void: ' + e.message, 'error');
    }
  },

  closeReceipt() { closeModal('modal-receipt'); },
  hideLoader()   { document.getElementById('page-loader').style.display = 'none'; },

  // ── Toppings ─────────────────────────────────────────────────
  async loadToppings() {
    if (!this.allProducts.length) return;
    const productIds = this.allProducts.map(p => p.productId);
    try {
      const { data } = await db.from('product_toppings')
        .select('product_id, toppings(id, name, price, is_active)')
        .in('product_id', productIds);
      this.toppingMap = {};
      (data || []).forEach(row => {
        if (!row.toppings?.is_active) return;
        const pid = row.product_id;
        if (!this.toppingMap[pid]) this.toppingMap[pid] = [];
        this.toppingMap[pid].push(row.toppings);
      });
    } catch (e) {
      console.warn('[RBN] loadToppings failed:', e.message);
      this.toppingMap = {};
    }
  },

  checkAndShowToppings(variantId, product) {
    const toppings = this.toppingMap[product.productId] || [];
    if (!toppings.length) {
      this.addToCart(variantId, product, []);
    } else {
      this.openToppingSelect(variantId, product, toppings);
    }
  },

  openToppingSelect(variantId, product, toppings) {
    this._pendingVariantId = variantId;
    this._pendingProduct   = product;

    const variant = product.variants.find(v => v.id === variantId);
    const subEl   = document.getElementById('topping-select-subtitle');
    if (subEl) subEl.textContent = `${product.productName} — ${variant?.name || ''} (${formatRupiah(variant?.price || 0)})`;

    const listEl = document.getElementById('topping-select-list');
    if (listEl) {
      listEl.innerHTML = toppings.map(t => `
        <label class="flex items-center gap-3 p-3 rounded cursor-pointer" style="border:1px solid var(--border);background:var(--bg);user-select:none">
          <input type="checkbox" data-action="topping-check-change" data-topping-id="${t.id}"
            style="width:18px;height:18px;accent-color:var(--primary);flex-shrink:0" />
          <div class="flex-1">
            <div class="fw-600 text-sm">${escapeHtml(t.name)}</div>
            <div class="text-xs text-muted">${t.price > 0 ? '+' + formatRupiah(t.price) : 'Gratis'}</div>
          </div>
        </label>`).join('');
    }

    this._pendingToppings = toppings;
    this._updateToppingExtra();
    openModal('modal-topping-select');
  },

  _updateToppingExtra() {
    const listEl   = document.getElementById('topping-select-list');
    const extraEl  = document.getElementById('topping-select-extra');
    if (!listEl || !extraEl) return;
    const checked  = [...listEl.querySelectorAll('input[type=checkbox]:checked')];
    const tids     = new Set(checked.map(cb => Number(cb.dataset.toppingId)));
    const total    = (this._pendingToppings || []).filter(t => tids.has(t.id)).reduce((s, t) => s + t.price, 0);
    extraEl.textContent = total > 0 ? '+' + formatRupiah(total) : '+Rp 0';
  },

  confirmToppingSelect() {
    const listEl = document.getElementById('topping-select-list');
    if (!listEl) return;
    const checked  = [...listEl.querySelectorAll('input[type=checkbox]:checked')];
    const tids     = new Set(checked.map(cb => Number(cb.dataset.toppingId)));
    const selected = (this._pendingToppings || []).filter(t => tids.has(t.id));
    closeModal('modal-topping-select');
    if (this._pendingVariantId && this._pendingProduct) {
      this.addToCart(this._pendingVariantId, this._pendingProduct, selected);
    }
    this._pendingVariantId = null;
    this._pendingProduct   = null;
    this._pendingToppings  = null;
  },

  skipToppingSelect() {
    closeModal('modal-topping-select');
    if (this._pendingVariantId && this._pendingProduct) {
      this.addToCart(this._pendingVariantId, this._pendingProduct, []);
    }
    this._pendingVariantId = null;
    this._pendingProduct   = null;
    this._pendingToppings  = null;
  },
};

// ── Global helpers ─────────────────────────────────────────────
function roundUp(val, to) { return Math.ceil(val / to) * to; }

function refreshPaymentMethodsFromSettings(settings) {
  if (!settings) return;
  const methods = Array.isArray(settings.paymentMethods) && settings.paymentMethods.length ? settings.paymentMethods : null;
  if (!methods) return;
  const pmWrap = document.querySelector('.payment-methods');
  if (!pmWrap) return;
  pmWrap.innerHTML = methods.map(m => {
    const feePct = Number.isFinite(parseFloat(m.fee_percent || 0)) ? parseFloat(m.fee_percent || 0) : 0;
    const feeEnabled = m.is_fee_enabled ? 'true' : 'false';
    const feeLabel = (m.fee_percent && !Number.isNaN(parseFloat(m.fee_percent))) ? ` <span style="font-size:12px;color:var(--text-muted)">(+${parseFloat(m.fee_percent)}%)</span>` : '';
    return `<button class="payment-method-btn" data-action="select-payment-method" data-method="${escapeHtml(m.code)}" data-fee-pct="${feePct}" data-fee-enabled="${feeEnabled}">${escapeHtml(m.label)}${feeLabel}</button>`;
  }).join('');
  const defaultCode = methods.find(m => m.code === 'cash') ? 'cash' : (methods[0] && methods[0].code) || 'cash';
  POS.selectPaymentMethod(document.querySelector(`.payment-method-btn[data-method="${defaultCode}"]`), defaultCode);
}

window.addEventListener('storage', (e) => {
  if (e.key !== 'pos_settings') return;
  try {
    const settings = JSON.parse(e.newValue || '{}');
    refreshPaymentMethodsFromSettings(settings);
  } catch (err) {
    console.warn('pos: failed to parse pos_settings from storage event', err);
  }
});

POS.openPrinterSettings = function() {
  const autoPrint = localStorage.getItem('printer_auto_print') === 'true';
  const cb = document.getElementById('cb-auto-print');
  if (cb) cb.checked = autoPrint;
  openModal('modal-printer');
};

POS.savePrinterSettings = function() {
  const cb = document.getElementById('cb-auto-print');
  if (cb) {
    localStorage.setItem('printer_auto_print', cb.checked);
    showToast('Pengaturan printer disimpan', 'success');
  }
};

POS.testPrint = function() {
  const settings   = JSON.parse(localStorage.getItem('pos_settings') || '{}');
  const shopName   = settings.shopName || 'Roti Bakar Ngeunah';
  const headerText = settings.receiptHeader || 'Jl. Contoh No. 1\nTelp: 0812-xxxx-xxxx';
  const footerText = settings.receiptFooter || 'Terima kasih atas kunjungannya!';

  const dummyTrx = {
    id: 99999,
    created_at: new Date().toISOString(),
    payment_amount: 50000,
  };
  const dummyCart = [
    { productName: 'Roti Bakar', variantName: 'Keju', price: 15000, quantity: 2 },
    { productName: 'Es Teh Manis', variantName: 'Besar', price: 8000, quantity: 1 },
    { productName: 'Roti Bakar', variantName: 'Coklat', price: 12000, quantity: 1 },
  ];
  const subtotal = dummyCart.reduce((s, i) => s + i.price * i.quantity, 0);
  const disc     = 0;
  const total    = subtotal;
  const change   = dummyTrx.payment_amount - total;

  const branch = POS.branch || { name: 'Cabang Contoh' };
  const user   = POS.user   || { name: 'Kasir Demo' };

  const _prevBranch = POS.branch;
  const _prevUser   = POS.user;
  POS.branch = branch;
  POS.user   = user;

  POS.showReceipt(dummyTrx, subtotal, disc, total, dummyTrx.payment_amount, change, 'cash', dummyCart);

  POS.branch = _prevBranch;
  POS.user   = _prevUser;

  setTimeout(() => window.print(), 400);
};

document.addEventListener('DOMContentLoaded', () => POS.init());

// Global overlay click handler: close modal when clicking the backdrop
document.addEventListener('click', function(e) {
  if (!e.target.classList || !e.target.classList.contains('modal-overlay')) return;
  const lockedModals = ['modal-shift', 'modal-branch'];
  if (lockedModals.includes(e.target.id)) return;
  // Do not close payment modal while checkout is locked/in-progress
  if (e.target.id === 'modal-payment' && typeof POS !== 'undefined' && POS._checkoutLock) return;
  // FIX: Do NOT close success modal via overlay click — use the buttons inside instead
  // (previously the overlay had data-action="close-success-popup" which conflicted with
  //  stopPropagation on the card, causing intermittent non-responsiveness)
  if (e.target.id === 'modal-success-trx') return;
  e.target.classList.remove('active');
});
