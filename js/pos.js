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
  _openShiftLock: false,
  _pendingTxIds: null,
  bomData:     null,   // { recipeMap: {variantId→recipeId}, recipeItemsMap: {recipeId→[items]} }
  stockCache:  null,   // Map<ingredientId, stock> — refreshed after each transaction
  toppingMap:  {},     // productId → [{id, name, price}]
  _cartIdCounter: 0,   // increments to give each cart line a unique cartItemId
  _pendingVariantId: null,   // staged while topping modal is open
  _pendingProduct:   null,
  _openShiftDeposit: { sessions: [], accounts: [], session: null, depositableCash: 0, file: null },
  _openShiftBlocker: null,
  _branchCashPosition: { currentBalance: 0, pendingDeposit: 0, version: 0, hasBalanceRow: false, loaded: false, error: false,
    source: null, lastClosedBy: null, lastClosedAt: null, openSession: null },
  _ingredientLogId:     null,
  _ingredientLogName:   null,
  _ingredientLogOffset: 0,
  _ingredientLogLimit:  50,
  _logTrxLock:          false,

  // ── Cache dirty flags (set by cross-page events from Admin) ──
  _productsDirty:     false,
  _bomDirty:          false,
  _stockDirty:        false,
  _toppingsDirty:     false,
  _paymentsDirty:     false,
  _cashDirty:         false,

  // ── Mode Setoran: lock user ke tab deposits sampai shift dibuka ──
  _depositOnlyMode:   false,

  // ── Tab data cache (ms timestamps) — avoids redundant API calls on rapid tab switching ──
  _tabLastLoaded:     {},
  _tabCacheTtlMs:     30000, // 30 seconds

  _shouldReloadTab(tab) {
    const last = this._tabLastLoaded[tab] || 0;
    return Date.now() - last > this._tabCacheTtlMs;
  },
  _markTabLoaded(tab) {
    this._tabLastLoaded[tab] = Date.now();
  },
  _invalidateTabCache(tab) {
    delete this._tabLastLoaded[tab];
  },

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
        case 'refresh-deposits':
          if (window.depositUi) (depositUi.refreshWhenReady || depositUi.refresh).call(depositUi);
          break;
        case 'load-session-transactions': POS.loadSessionTransactions(); break;
        case 'switch-mobile-drawer-tab': POS.switchMobileDrawerTab(btn.dataset.tab, btn); break;
        case 'test-print': POS.testPrint(); break;
        case 'confirm-open-shift': POS.confirmOpenShift(); break;
        case 'confirm-close-shift': POS.confirmCloseShift(); break;
        case 'startup-open-shift':
          closeModal('modal-startup-choice');
          POS._setDepositOnlyMode(false);
          setTimeout(() => POS.openShiftModal(), 120);
          break;
        case 'startup-go-deposit':
          closeModal('modal-startup-choice');
          POS._setDepositOnlyMode(true);
          POS.switchMainTab('deposits', document.querySelector('.pos-tab-item[data-tab="deposits"]'));
          break;
        case 'shift-modal-back':
          closeModal('modal-shift');
          setTimeout(() => POS.showStartupChoice(), 150);
          break;
        case 'deposit-blocker-tutup-shift':
          closeModal('modal-deposit-blocked');
          setTimeout(() => POS.openCloseShiftModal(), 160);
          break;
        case 'deposit-blocker-buka-shift':
          closeModal('modal-deposit-blocked');
          setTimeout(() => POS.showStartupChoice(), 160);
          break;
        case 'post-shift-setor':
          closeModal('modal-post-close-shift');
          POS.switchMainTab('deposits', document.querySelector('.pos-tab-item[data-tab="deposits"]'));
          break;
        case 'post-shift-buka-shift':
          closeModal('modal-post-close-shift');
          setTimeout(() => POS.openShiftModal(), 150);
          break;
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
        case 'open-shift-modal': POS.openShiftModal(); break;
        case 'reload-branch-cash-position': POS.loadBranchCashPosition(); break;
        case 'void-cash-log': POS.voidCashLogFromPOS(Number(btn.dataset.id)); break;
        case 'switch-cash-subtab': POS.switchCashSubTab(btn.dataset.type); break;
        case 'submit-cash-entry': POS.submitCashEntry(); break;
        case 'open-close-shift': POS.closeMobileDrawer(); POS.openCloseShiftModal(); break;
        case 'print-receipt': window.print(); break;
        case 'open-stock-adjust-modal': POS.openStockAdjustModal(); break;
        case 'submit-stock-adjust': POS.submitStockAdjust(); break;
        case 'open-send-transfer-modal': POS.openSendTransferModal(); break;
        case 'submit-send-transfer': POS.submitSendTransfer(); break;
        case 'add-transfer-item': POS.addTransferItem(); break;
        case 'remove-transfer-item': POS.removeTransferItem(Number(btn.dataset.index)); break;
        case 'open-pending-transfers-modal': POS.openPendingTransfersModal(); break;
        case 'confirm-transfer': POS.confirmTransfer(Number(btn.dataset.id)); break;
        case 'reject-transfer': POS.rejectTransfer(Number(btn.dataset.id)); break;
        case 'cancel-transfer': POS.cancelTransfer(Number(btn.dataset.id)); break;
        case 'open-transfer-history-modal': POS.openTransferHistoryModal(); break;
        case 'view-ingredient-log': POS.viewIngredientLog(btn.dataset.ingredientId, btn.dataset.ingredientName); break;
        case 'refresh-ingredient-log': POS.loadIngredientLogData(false); break;
        case 'ingredient-log-load-more': POS.loadIngredientLogData(true); break;
        case 'view-log-trx': POS.viewLogTransaction(Number(btn.dataset.id), btn); break;
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
      else if (action === 'ingredient-log-filter-change') POS.loadIngredientLogData(false);
    });
    document.addEventListener('input', e => {
      const inputNode = e.target.closest('[data-action-input]');
      if (!inputNode) return;
      const action = inputNode.dataset.actionInput;
      if (action === 'apply-discount-preview') POS.applyDiscountPreview();
      else if (action === 'calc-change') POS.calcChange();
      else if (action === 'update-shift-diff') POS.updateShiftDiff(inputNode.value);
    });

    // Global guard: prevent non-numeric characters in all inputmode="numeric" fields
    document.addEventListener('keydown', e => {
      const el = e.target;
      if (el.tagName !== 'INPUT') return;
      if (el.getAttribute('inputmode') !== 'numeric' && el.type !== 'tel') return;
      const passKeys = ['Backspace','Delete','Tab','Escape','Enter',
                        'ArrowLeft','ArrowRight','ArrowUp','ArrowDown','Home','End'];
      if (passKeys.includes(e.key) || e.ctrlKey || e.metaKey) return;
      if (!/^\d$/.test(e.key)) e.preventDefault();
    }, true); // capture phase so it runs before other listeners

    // Handle Android back button / browser popstate
    window.addEventListener('popstate', () => {
      const viewCart = document.getElementById('view-cart');
      if (viewCart && !viewCart.hidden) {
        POS.switchView('kasir');
      }
    });

    window.addEventListener('rbn:modal:opened', e => {
      if (e.detail?.id === 'modal-shift') {
        POS.loadBranchCashPosition();
        // loadOpenShiftDeposit dihapus — setoran kini via Startup Choice → tab Setoran
      }
    });
    // shift-open-dep-account / shift-open-dep-proof listeners dihapus (section deposit di modal-shift sudah dinonaktifkan)

    this.user = auth.requireRole('staff');
    if (!this.user) return;
    this.user = await auth.validateCurrentUser(['staff']);
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
        await this.openShiftModal();
      }
    } else {
      await this.showBranchSelector();
    }

    this.setupSearch();
    this.hideLoader();
    if (window.depositUi && typeof depositUi.refreshWhenReady === 'function') {
      depositUi.refreshWhenReady();
    }

    // Onboarding tutorial for new staff — non-blocking, never affects POS flow
    if (window.Onboarding && this.user) {
      window.Onboarding.init(this.user).catch(err => {
        console.warn('[Onboarding] init failed', err);
      });
    }

    // Subscribe to cross-page data change events from Admin
    if (window.RBNDataEvents) {
      RBNDataEvents.subscribe('products:changed', () => { this._productsDirty = true; });
      RBNDataEvents.subscribe('recipes:changed',  () => { this._bomDirty      = true; });
      RBNDataEvents.subscribe('inventory:changed',() => { this._stockDirty    = true; });
      RBNDataEvents.subscribe('toppings:changed', () => { this._toppingsDirty = true; });
      RBNDataEvents.subscribe('settings:changed', () => { this._paymentsDirty = true; });
      RBNDataEvents.subscribe('cash:changed',     () => { this._cashDirty     = true; });
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
    if (data?.is_active === false) return null;
    return data;
  },

  async showBranchSelector() {
    const { data } = await db.from('branches').select('*').order('name');
    const branches = (data || []).filter(b => b.is_active !== false);
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
  async getOwnOpenShift() {
    const { data, error } = await db.from('cashier_sessions')
      .select('*')
      .eq('branch_id', this.branch.id)
      .eq('staff_id', this.user.id)
      .eq('status', 'open')
      .order('opened_at', { ascending: false })
      .limit(1);
    if (error) throw error;
    return (data || [])[0] || null;
  },

  getOpenShiftBlockerMessage(session = this._openShiftBlocker) {
    if (typeof transactionService !== 'undefined' && transactionService.formatOpenShiftBlocker) {
      return transactionService.formatOpenShiftBlocker(session, this.user?.name || null);
    }
    const staffName = session?.staff_name || 'Staff lain';
    return `Shift sebelumnya atas nama ${staffName} belum menutup kas. Silakan tutup kas terlebih dahulu.`;
  },

  getPendingDepositBlockerMessage() {
    return 'Masih ada setoran tunai yang menunggu persetujuan owner/admin. Selesaikan setoran terlebih dahulu sebelum membuka shift baru.';
  },

  setOpenShiftBlocker(session = null) {
    this._openShiftBlocker = session || null;
    const blocked = !!this._openShiftBlocker;
    const setDisplay = (id, show) => {
      const el = document.getElementById(id);
      if (el) el.style.display = show ? '' : 'none';
    };

    setDisplay('shift-open-blocker', blocked);
    setDisplay('shift-opening-warning', !blocked);
    // shift-open-deposit-wrap permanently hidden — setoran kini via tab Setoran

    const msgEl = document.getElementById('shift-open-blocker-msg');
    if (msgEl && blocked) {
      const openedAt = this._openShiftBlocker.opened_at ? ` Dibuka: ${fDate(this._openShiftBlocker.opened_at)}.` : '';
      msgEl.textContent = `${this.getOpenShiftBlockerMessage(this._openShiftBlocker)}${openedAt}`;
    }

    const btn = document.getElementById('btn-open-shift');
    if (btn) {
      btn.disabled = blocked;
      btn.textContent = blocked ? 'Kas Belum Ditutup' : 'Buka Shift & Mulai Berjualan';
    }
    if (window.lucide) requestAnimationFrame(() => lucide.createIcons());
  },

  async refreshOpenShiftBlocker() {
    if (!this.branch?.id || !this.user?.id || typeof transactionService === 'undefined') {
      this.setOpenShiftBlocker(null);
      return null;
    }
    const blocker = await transactionService.getOpenShiftForBranch({
      branchId: this.branch.id,
      excludeStaffId: this.user.id
    });
    this.setOpenShiftBlocker(blocker);
    return blocker;
  },

  async openShiftModal() {
    let blocker = null;
    try {
      blocker = await this.refreshOpenShiftBlocker();
    } catch (e) {
      console.error('openShiftModal: failed to check active cashier shift', e);
      this.setOpenShiftBlocker(null);
      showToast('Gagal memeriksa kas aktif. Coba refresh halaman.', 'error');
    }
    openModal('modal-shift');
    if (blocker) showToast(this.getOpenShiftBlockerMessage(blocker), 'warning');
  },

  // ── Startup Choice — Pilih Buka Shift atau Setoran ───────────
  async showStartupChoice() {
    const greetEl = document.getElementById('startup-staff-greeting');
    if (greetEl && this.user?.name) {
      greetEl.textContent = `${this.user.name} — Pilih aktivitas untuk memulai`;
    }

    // Cek apakah ada eligible session untuk setoran (async, non-blocking)
    const depositBtn = document.getElementById('btn-startup-deposit');
    if (depositBtn) depositBtn.style.display = 'none'; // sembunyikan dulu
    if (this.branch && this.user && typeof depositService !== 'undefined') {
      depositService.getEligibleSessions({ branchId: this.branch.id, staffId: this.user.id, limit: 1 })
        .then(sessions => {
          const hasEligible = (sessions || []).some(s => !s.block_reason && Number(s.depositable_cash || 0) > 0);
          if (depositBtn) depositBtn.style.display = hasEligible ? 'flex' : 'none';
          if (window.lucide) requestAnimationFrame(() => lucide.createIcons());
        })
        .catch(() => { /* tombol setoran tetap tersembunyi */ });
    }

    openModal('modal-startup-choice');
    if (window.lucide) requestAnimationFrame(() => lucide.createIcons());
  },

  // ── Toggle deposit-only mode (lock non-deposit tabs) ─────────
  _setDepositOnlyMode(active) {
    this._depositOnlyMode = !!active;
    document.body.classList.toggle('deposit-only-mode', this._depositOnlyMode);
    if (window.lucide) requestAnimationFrame(() => lucide.createIcons());
  },

  // ── Branch Cash Position (Posisi Kas Outlet) ─────────────────
  async loadBranchCashPosition() {
    if (!this.branch || !this.user) return;
    const b = this._branchCashPosition;
    b.loaded = false; b.error = false;
    this._renderShiftBalance('loading');
    try {
      const result = await transactionService.getBranchCashPosition({
        branchId: this.branch.id,
        staffId:  this.user.id
      });
      b.currentBalance = Number(result?.current_balance ?? 0);
      b.pendingDeposit = Number(result?.pending_deposit_amount ?? 0);
      b.version        = Number(result?.version ?? 0);
      b.hasBalanceRow  = !!result?.has_balance_row;
      b.source         = result?.source || null;
      b.openSession    = result?.open_session || null;
      b.lastClosedBy   = result?.last_closed_session?.staff_name || null;
      b.lastClosedAt   = result?.last_closed_session?.closed_at  || null;
      b.loaded         = true;
      this._renderShiftBalance('display');
    } catch (e) {
      console.error('loadBranchCashPosition', e);
      b.error = true;
      this._renderShiftBalance('error');
    }
  },

  _renderShiftBalance(state) {
    const g    = id => document.getElementById(id);
    const show = id => { const el = g(id); if (el) el.style.display = ''; };
    const hide = id => { const el = g(id); if (el) el.style.display = 'none'; };
    ['shift-balance-loading', 'shift-balance-display', 'shift-balance-error'].forEach(hide);
    if (state === 'loading') { show('shift-balance-loading'); return; }
    if (state === 'error')   { show('shift-balance-error');   return; }

    const b = this._branchCashPosition;

    // Jika ada shift aktif di outlet (dari staff lain), sinkron dgn blocker
    if (b.openSession && Number(b.openSession.staff_id) !== Number(this.user?.id)) {
      this.setOpenShiftBlocker(b.openSession);
      return;
    }

    show('shift-balance-display');

    const amountEl  = g('shift-balance-amount');
    const hintEl    = g('shift-balance-hint');
    const sourceEl  = g('shift-balance-source');
    const lastByEl  = g('shift-balance-last-closed-by');
    const pendWrap  = g('shift-balance-pending-warn');
    const pendText  = g('shift-balance-pending-text');
    const openingInput = g('shift-opening-cash');

    if (amountEl) amountEl.textContent = formatRupiah(b.currentBalance);
    if (openingInput) openingInput.value = String(b.currentBalance || 0);

    const sourceLabels = {
      'branch_balance':          'Posisi kas terakhir outlet',
      'latest_closed_session':   'Kas akhir terakhir (belum ada saldo tercatat)',
      'default_cash':            'Default outlet (belum ada riwayat kas)'
    };
    if (hintEl) hintEl.textContent = 'Kas awal ini diambil dari posisi kas terakhir outlet.';
    if (sourceEl) sourceEl.textContent = sourceLabels[b.source] || 'Posisi kas outlet';

    if (lastByEl) {
      if (b.lastClosedBy && b.lastClosedAt) {
        lastByEl.textContent = `Kas terakhir ditutup oleh ${b.lastClosedBy} pada ${fDate(b.lastClosedAt)}.`;
        lastByEl.style.display = '';
      } else {
        lastByEl.style.display = 'none';
      }
    }

    if (pendWrap && pendText) {
      if (b.pendingDeposit > 0) {
        pendText.textContent = `${this.getPendingDepositBlockerMessage()} Nominal pending: ${formatRupiah(b.pendingDeposit)}. Posisi kas belum berkurang sampai disetujui.`;
        pendWrap.style.display = '';
      } else {
        pendWrap.style.display = 'none';
      }
    }

    const openBtn = g('btn-open-shift');
    if (openBtn && !this._openShiftBlocker) {
      const pendingBlocked = Number(b.pendingDeposit || 0) > 0;
      openBtn.disabled = pendingBlocked;
      openBtn.textContent = pendingBlocked ? 'Setoran Menunggu Approval' : 'Buka Shift & Mulai Berjualan';
    }

    if (window.lucide) requestAnimationFrame(() => lucide.createIcons());
  },

  onVarianceToggle(checked) {
    const varGroup = document.getElementById('shift-variance-group');
    if (varGroup) varGroup.style.display = checked ? '' : 'none';
    if (!checked) {
      const physInput = document.getElementById('shift-physical-cash');
      const varDiff   = document.getElementById('shift-variance-diff');
      const varReason = document.getElementById('shift-variance-reason');
      if (physInput) physInput.value = '';
      if (varDiff)   varDiff.textContent = '';
      if (varReason) varReason.value = '';
    }
  },

  updateShiftVariance(val) {
    const physical  = parseFloat(val) || 0;
    const system    = this._branchCashPosition.currentBalance;
    const diff      = physical - system;
    const diffEl    = document.getElementById('shift-variance-diff');
    if (!diffEl) return;
    if (!val) { diffEl.textContent = ''; return; }
    const sign = diff >= 0 ? '+' : '−';
    diffEl.textContent = `Selisih: ${sign}${formatRupiah(Math.abs(diff))}`;
    diffEl.style.color = diff === 0 ? 'var(--text-muted)' : diff > 0 ? 'var(--success)' : 'var(--danger)';
  },

  async initShift() {
    const data = await this.getOwnOpenShift();

    if (data) {
      this.session = data;
      this._setDepositOnlyMode(false);
      this.setOpenShiftBlocker(null);
      this.updateShiftUI();
    } else {
      this.session = null;
      const blocker = await this.refreshOpenShiftBlocker();
      this.updateShiftUI();
      // Tampilkan pilihan Buka Shift / Setoran — bukan langsung modal-shift
      await this.showStartupChoice();
      if (blocker) showToast(this.getOpenShiftBlockerMessage(blocker), 'warning');
    }
  },

  updateShiftUI() {
    if (!this.session) {
      // Only open if no session — already handled by initShift/selectBranch
    }
  },

  async confirmOpenShift() {
    if (this._openShiftLock) return;
    if (this.session) {
      closeModal('modal-shift');
      showToast('Shift sudah terbuka. Silakan lanjut berjualan.', 'success');
      return;
    }

    this._openShiftLock = true;
    const btn = document.getElementById('btn-open-shift');
    if (btn) {
      btn.disabled = true;
      btn.textContent = 'Membuka...';
    }
    try {
      const existingOwnSession = await this.getOwnOpenShift();
      if (existingOwnSession) {
        this.session = existingOwnSession;
        closeModal('modal-shift');
        this.updateShiftUI();
        showToast('Shift sudah terbuka. Status kas disinkronkan.', 'success');
        return;
      }

      const blocker = await this.refreshOpenShiftBlocker();
      if (blocker) throw new Error(this.getOpenShiftBlockerMessage(blocker));

      if (!this._branchCashPosition.loaded) {
        await this.loadBranchCashPosition();
      }
      if (this._branchCashPosition.error) {
        throw new Error('Gagal memuat posisi kas outlet. Coba lagi sebelum membuka shift.');
      }
      if (Number(this._branchCashPosition.pendingDeposit || 0) > 0) {
        throw new Error(this.getPendingDepositBlockerMessage());
      }

      // Buka shift dari posisi kas outlet terkini.
      this.session = await transactionService.openShiftFromBalance({
        branchId:       this.branch.id,
        staffId:        this.user.id
      });

      closeModal('modal-shift');
      closeModal('modal-startup-choice');
      this._setDepositOnlyMode(false);
      this.updateShiftUI();
      const openingCash = this.session.opening_cash || 0;
      const openedMsg = this.session.already_open
        ? `Shift sudah terbuka. Kas awal: ${formatRupiah(openingCash)}.`
        : `Shift dibuka — Kas awal: ${formatRupiah(openingCash)}. Selamat berjualan!`;
      showToast(openedMsg, 'success');
    } catch (e) {
      showToast(e.message, 'error');
    } finally {
      this._openShiftLock = false;
      if (!btn) return;
      if (this.session) {
        btn.disabled = true;
        btn.textContent = 'Shift Sudah Terbuka';
        return;
      }
      const pendingBlocked = Number(this._branchCashPosition?.pendingDeposit || 0) > 0;
      btn.disabled = !!this._openShiftBlocker || pendingBlocked;
      btn.textContent = this._openShiftBlocker
        ? 'Kas Belum Ditutup'
        : pendingBlocked
          ? 'Setoran Menunggu Approval'
          : 'Buka Shift & Mulai Berjualan';
    }
  },

  async loadOpenShiftDeposit() {
    if (!this.branch || !this.user) return;
    const d = this._openShiftDeposit;
    d.sessions = []; d.accounts = []; d.session = null; d.depositableCash = 0; d.file = null;
    const fileInput = document.getElementById('shift-open-dep-proof');
    if (fileInput) fileInput.value = '';
    const amountInput = document.getElementById('shift-open-dep-amount');
    if (amountInput) amountInput.value = '';
    this.renderOpenShiftDeposit('loading');
    try {
      [d.sessions, d.accounts] = await Promise.all([
        depositService.getEligibleSessions({ branchId: this.branch.id, staffId: this.user.id, limit: 5 }),
        depositService.getAccounts({ branchId: this.branch.id })
      ]);
      const eligible = d.sessions.filter(s => !s.block_reason && s.depositable_cash > 0);
      if (eligible.length > 0) {
        d.session = eligible[0];
        d.depositableCash = Number(d.session.depositable_cash || 0);
        this.renderOpenShiftDeposit('form');
      } else if (d.sessions.length > 0) {
        d.session = d.sessions[0];
        this.renderOpenShiftDeposit('blocked');
      } else {
        this.renderOpenShiftDeposit('none');
      }
    } catch (e) {
      console.error('loadOpenShiftDeposit', e);
      this.renderOpenShiftDeposit('none');
    }
  },

  renderOpenShiftDeposit(state) {
    const g = id => document.getElementById(id);
    const show = id => { const el = g(id); if (el) el.style.display = ''; };
    const hide = id => { const el = g(id); if (el) el.style.display = 'none'; };
    ['shift-open-dep-loading', 'shift-open-dep-none', 'shift-open-dep-blocked', 'shift-open-dep-form'].forEach(hide);
    if (state === 'loading') { show('shift-open-dep-loading'); return; }
    if (state === 'none') { show('shift-open-dep-none'); return; }
    if (state === 'blocked') {
      show('shift-open-dep-blocked');
      const msg = g('shift-open-dep-blocked-msg');
      if (msg) msg.textContent = this._openShiftDeposit.session?.block_reason || 'Setoran shift sebelumnya sedang diproses.';
      return;
    }
    if (state !== 'form') return;
    show('shift-open-dep-form');
    const d = this._openShiftDeposit;
    const sess = d.session;
    const infoEl = g('shift-open-dep-session-info');
    if (infoEl && sess) {
      infoEl.innerHTML = `Shift ditutup: <strong>${fDate(sess.closed_at)}</strong> &nbsp;·&nbsp; Dapat disetor: <strong>${formatRupiah(d.depositableCash)}</strong>`;
    }
    const hintEl = g('shift-open-dep-hint');
    if (hintEl) hintEl.textContent = `Maks. dapat disetor: ${formatRupiah(d.depositableCash)}`;
    const sel = g('shift-open-dep-account');
    if (sel) {
      sel.innerHTML = '<option value="">— Pilih —</option>';
      d.accounts.forEach(acc => {
        const opt = document.createElement('option');
        opt.value = acc.id;
        opt.textContent = acc.label || acc.name || '—';
        sel.appendChild(opt);
      });
    }
    hide('shift-open-dep-proof-wrap');
    if (window.lucide) requestAnimationFrame(() => lucide.createIcons());
  },

  onOpenShiftDepositAccountChange() {
    const sel = document.getElementById('shift-open-dep-account');
    const proofWrap = document.getElementById('shift-open-dep-proof-wrap');
    const d = this._openShiftDeposit;
    if (!sel || !proofWrap) return;
    const acc = d.accounts.find(a => a.id === sel.value);
    const requireProof = acc && !depositService.isCashDepositMethod(acc);
    proofWrap.style.display = requireProof ? '' : 'none';
    if (!requireProof) {
      d.file = null;
      const fi = document.getElementById('shift-open-dep-proof');
      if (fi) fi.value = '';
    }
  },

  updateDepositBlocker() {
    const titleEl = document.getElementById('deposit-blocker-title');
    const descEl  = document.getElementById('deposit-blocker-desc');
    const btnEl   = document.getElementById('deposit-blocker-primary-btn');
    const lblEl   = document.getElementById('deposit-blocker-btn-label');
    const iconEl  = btnEl?.querySelector('[data-lucide]');

    if (this.session) {
      // Ada shift open — suruh tutup shift dulu
      if (titleEl) titleEl.textContent = 'Shift Belum Ditutup';
      if (descEl)  descEl.textContent  = 'Tutup shift terlebih dahulu sebelum melakukan setoran tunai.';
      if (lblEl)   lblEl.textContent   = 'Tutup Shift Sekarang';
      if (iconEl)  iconEl.setAttribute('data-lucide', 'x-circle');
      if (btnEl)   btnEl.dataset.action = 'deposit-blocker-tutup-shift';
    } else {
      // Tidak ada shift sama sekali — belum ada yang bisa ditutup
      if (titleEl) titleEl.textContent = 'Belum Ada Shift Tertutup';
      if (descEl)  descEl.textContent  = 'Buka shift terlebih dahulu, jalankan transaksi, lalu tutup shift sebelum melakukan setoran tunai.';
      if (lblEl)   lblEl.textContent   = 'Buka Shift';
      if (iconEl)  iconEl.setAttribute('data-lucide', 'play-circle');
      if (btnEl)   btnEl.dataset.action = 'deposit-blocker-buka-shift';
    }
    if (window.lucide) requestAnimationFrame(() => lucide.createIcons());
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
    const depositOut   = summary ? summary.depositOut   : 0;
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
          ${depositOut > 0 ? `<div class="shift-detail-row">
            <span><i data-lucide="landmark" class="icon-sm text-danger" style="margin-right:6px"></i>Setoran Terkonfirmasi (di luar shift)</span>
            <span class="text-danger">−${formatRupiah(depositOut)}</span>
          </div>` : ''}
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
      const result = await transactionService.closeShiftApplyBalance({
        sessionId:  this.session.id,
        closingCash: cash,
        staffId:    this.user.id
      });
      this.lastClosedSession = result;
      closeModal('modal-close-shift');
      this.session   = null;
      this.cart      = [];
      this.heldCarts = [];
      this.discount  = { type: 'none', value: 0 };
      this.renderCart();
      this.updateHeldBadge();
      this.updateShiftUI();
      const diff         = cash - (result.expected_cash || 0);
      const balanceAfter = result.balance_after ?? cash;
      const toastType    = diff >= 0 ? 'success' : 'warning';
      showToast(
        `Shift ditutup. Posisi kas outlet diperbarui menjadi ${formatRupiah(balanceAfter)}.` +
        (diff !== 0 ? ` Selisih: ${diff >= 0 ? '+' : '−'}${formatRupiah(Math.abs(diff))}` : ''),
        toastType
      );
      // Update cached balance state
      this._branchCashPosition.currentBalance = balanceAfter;
      this._branchCashPosition.hasBalanceRow  = true;

      // Invalidate tab caches after shift close so all tabs show fresh data
      this._invalidateTabCache('summary');
      this._invalidateTabCache('cash');
      this._invalidateTabCache('transactions');

      if (window.depositUi) {
        depositUi.refreshWhenReady({ preferSessionId: result.id });
      }
      setTimeout(() => openModal('modal-post-close-shift'), 400);
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
        id:    Number(v.id),
        name:  v.name,
        price: priceOverride[Number(v.id)] !== undefined ? priceOverride[Number(v.id)] : parseFloat(v.price)
      }));

      if (!resolvedVariants.length) return;

      const isSimple = p.has_variants === false || p.has_variants === 0 || p.has_variants === '0';
      this.allProducts.push({
        productId:   Number(p.id),
        productName: p.name,
        category:    p.category || 'Lainnya',
        imageUrl:    p.image_url || null,
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
    document.querySelectorAll('.cat-btn').forEach(b => {
      b.classList.remove('active');
      if (b.dataset.cat === cat) b.classList.add('active');
    });
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

      const [itemsRes, invRes, assignRes] = await Promise.all([
        db.from('recipe_items')
          .select('recipe_id, ingredient_id, quantity, ingredients(name, unit)')
          .in('recipe_id', recipeIds),
        db.from('branch_inventory')
          .select('ingredient_id, stock')
          .eq('branch_id', this.branch.id),
        db.from('branch_ingredient_assignments').select('ingredient_id, branch_id')
      ]);

      // Build map: ingredientId → Set<branchId>. Kosong = tersedia di semua cabang.
      const assignMap = new Map();
      for (const a of (assignRes.data || [])) {
        if (!assignMap.has(a.ingredient_id)) assignMap.set(a.ingredient_id, new Set());
        assignMap.get(a.ingredient_id).add(a.branch_id);
      }
      const myBranchId = this.branch.id;

      const recipeItemsMap = {};
      for (const ri of (itemsRes.data || [])) {
        // Skip bahan yang di-assign ke cabang lain (tidak termasuk cabang ini)
        const assigns = assignMap.get(ri.ingredient_id);
        if (assigns && !assigns.has(myBranchId)) continue;
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
    window.dispatchEvent(new CustomEvent('rbn:product:selected', { detail: { productId } }));
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
    window.dispatchEvent(new CustomEvent('rbn:variant:selected', { detail: { variantId, productId } }));
    this.checkAndShowToppings(variantId, product);
  },

  // ── Cart: Add ────────────────────────────────────────────────
  addToCart(variantId, product, toppings = []) {
    if (this.loading) return;
    if (!this.session) {
      showToast('Buka shift terlebih dahulu sebelum bertransaksi', 'warning');
      this.openShiftModal();
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
    window.dispatchEvent(new CustomEvent('rbn:cart:changed', { detail: { count, total } }));

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
    // Guard: tab yang butuh shift aktif tidak bisa diakses tanpa sesi
    const requiresShift = ['kasir', 'summary', 'transactions', 'cash', 'stock'];
    if (!this.session && requiresShift.includes(tab)) {
      showToast('Buka shift terlebih dahulu untuk mengakses halaman ini', 'warning');
      if (this._depositOnlyMode) {
        // Pastikan tetap di deposits tab
        this.switchMainTab('deposits', document.querySelector('.pos-tab-item[data-tab="deposits"]'));
      } else {
        setTimeout(() => this.showStartupChoice(), 150);
      }
      return;
    }

    this.currentMainTab = tab;
    document.body.classList.toggle('deposit-tab-active', tab === 'deposits');
    document.querySelectorAll('.pos-tab-item').forEach(b => b.classList.remove('active'));
    if (btnEl?.classList?.contains('pos-tab-item')) {
      btnEl.classList.add('active');
    } else {
      document.querySelector(`.pos-tab-item[data-tab="${tab}"]`)?.classList.add('active');
    }

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
      // Reload produk jika cache dirty (perubahan dari Admin tab lain)
      if (this._productsDirty) {
        this._productsDirty = false;
        this.loadProducts().catch(e => console.warn('[POS] reload products after dirty flag:', e));
      }
    }
    if (tab === 'summary') {
      if (this._shouldReloadTab('summary')) {
        this._markTabLoaded('summary');
        this.loadPaymentMethodFilter();
        this.loadSalesSummary();
      }
    }
    if (tab === 'stock') {
      if (this._stockDirty || this._shouldReloadTab('stock')) {
        this._stockDirty = false;
        this._markTabLoaded('stock');
        this.loadInventorySummary();
      }
    }
    if (tab === 'cash') {
      if (this._cashDirty || this._shouldReloadTab('cash')) {
        this._cashDirty = false;
        this._markTabLoaded('cash');
        this.updateCashSummary();
      }
    }
    if (tab === 'deposits') {
      if (window.depositUi) (depositUi.refreshWhenReady || depositUi.refresh).call(depositUi);
    }
    if (tab === 'transactions') {
      if (this._shouldReloadTab('transactions')) {
        this._markTabLoaded('transactions');
        this.loadSessionTransactions();
      }
    }
  },

  switchMobileDrawerTab(tab, btnEl) {
    // Guard: tab yang butuh shift aktif
    const requiresShift = ['kasir', 'summary', 'transactions', 'cash', 'stock'];
    if (!this.session && requiresShift.includes(tab)) {
      this.closeMobileDrawer();
      showToast('Buka shift terlebih dahulu untuk mengakses halaman ini', 'warning');
      if (!this._depositOnlyMode) setTimeout(() => this.showStartupChoice(), 200);
      return;
    }

    document.querySelectorAll('.drawer-btn').forEach(b => b.classList.remove('active'));
    if (btnEl) btnEl.classList.add('active');
    document.body.classList.toggle('deposit-tab-active', tab === 'deposits');

    if (tab === 'kasir') {
      document.getElementById('panel-kasir').style.display = '';
      ['panel-summary','panel-stock','panel-cash','panel-deposits','panel-transactions'].forEach(id => {
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
      if (tab === 'summary') {
        if (this._shouldReloadTab('summary')) {
          this._markTabLoaded('summary');
          this.loadPaymentMethodFilter();
          this.loadSalesSummary();
        }
      }
      if (tab === 'stock') {
        if (this._stockDirty || this._shouldReloadTab('stock')) {
          this._stockDirty = false;
          this._markTabLoaded('stock');
          this.loadInventorySummary();
        }
      }
      if (tab === 'cash') {
        if (this._cashDirty || this._shouldReloadTab('cash')) {
          this._cashDirty = false;
          this._markTabLoaded('cash');
          this.updateCashSummary();
        }
      }
      if (tab === 'deposits') {
        if (window.depositUi) (depositUi.refreshWhenReady || depositUi.refresh).call(depositUi);
      }
      if (tab === 'transactions') {
        if (this._shouldReloadTab('transactions')) {
          this._markTabLoaded('transactions');
          this.loadSessionTransactions();
        }
      }
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
        .select('ingredient_id, quantity, type, reference_type')
        .eq('branch_id', this.branch.id)
        .eq('type', 'out')
        .eq('reference_type', 'transaction')
        .gte('created_at', from)
        .lte('created_at', to),
      db.from('inventory_logs')
        .select('quantity, type, note, created_at, ingredients(name, unit), users(name)')
        .eq('branch_id', this.branch.id)
        .eq('reference_type', 'manual')
        .gte('created_at', from)
        .lte('created_at', to)
        .order('created_at', { ascending: false })
        .limit(30)
    ]);

    const stockData   = stockRes.data || [];
    const logs        = logsRes.data || [];
    const manualLogs  = manualLogsRes.data || [];

    const usageMap = {};
    logs.forEach(l => {
      const id = l.ingredient_id;
      if (!usageMap[id]) usageMap[id] = 0;
      usageMap[id] += parseFloat(l.quantity || 0);
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
          const ingName = escapeHtml(r.ingredients?.name || '—');
          return `
            <div class="trx-item"
              style="padding:16px;cursor:pointer;transition:background .15s;"
              data-action="view-ingredient-log"
              data-ingredient-id="${r.ingredient_id}"
              data-ingredient-name="${ingName}"
              onmouseenter="this.style.background='var(--surface-2)'"
              onmouseleave="this.style.background=''">
              <div class="trx-item-left" style="flex:1;">
                <div class="fw-700 text-md mb-1">
                  ${ingName}
                  <span style="font-size:10px;font-weight:500;color:var(--primary);margin-left:6px;vertical-align:middle;opacity:.8;">
                    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:middle;"><path d="M12 8v4l3 3"/><circle cx="12" cy="12" r="10"/></svg>
                    Log
                  </span>
                </div>
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
              const qty   = parseFloat(l.quantity || 0);
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
                    <div class="text-xs text-muted" style="margin-top:2px;">${escapeHtml(l.note || '—')} &bull; ${actor}</div>
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

  // ── Ingredient Inventory Log ──────────────────────────────────
  viewIngredientLog(ingredientIdStr, ingredientName) {
    const ingredientId = parseInt(ingredientIdStr);
    if (!ingredientId || !this.branch) return;

    this._ingredientLogId     = ingredientId;
    this._ingredientLogName   = ingredientName || '—';
    this._ingredientLogOffset = 0;
    this._logTrxLock          = false; // reset lock jika modal dibuka ulang

    const titleEl = document.getElementById('ingredient-log-title');
    if (titleEl) titleEl.textContent = this._ingredientLogName;

    // Reset semua filter
    const fromEl = document.getElementById('ing-log-date-from');
    const toEl   = document.getElementById('ing-log-date-to');
    const typeEl = document.getElementById('ing-log-type-filter');
    if (fromEl) fromEl.value = '';
    if (toEl)   toEl.value   = '';
    if (typeEl) typeEl.value = '';

    // Pre-set loading state SEBELUM openModal agar layout stabil saat animasi dimulai
    // (menghindari reflow yang bisa mengganggu CSS transition)
    const listEl  = document.getElementById('ingredient-log-list');
    const moreBtn = document.getElementById('btn-ingredient-log-loadmore');
    if (listEl) {
      listEl.innerHTML = `
        <div class="empty-state" style="padding:40px 0;">
          <div class="empty-icon" style="opacity:.4;">
            <svg xmlns="http://www.w3.org/2000/svg" width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 1 1-6.219-8.56"/></svg>
          </div>
          <div class="empty-title">Memuat riwayat...</div>
        </div>`;
    }
    if (moreBtn) moreBtn.style.display = 'none';

    openModal('modal-ingredient-log');

    // Mulai fetch setelah satu frame — animasi open berjalan duluan, baru data load
    requestAnimationFrame(() => this.loadIngredientLogData(false));
  },

  // Tutup modal log inventori dulu, baru buka detail transaksi
  // Mencegah dua modal menumpuk + double-click
  viewLogTransaction(trxId, triggerBtn) {
    if (!trxId || this._logTrxLock) return;
    this._logTrxLock = true;

    // Disable semua tombol transaksi di log agar tidak bisa diklik lagi
    document.querySelectorAll('[data-action="view-log-trx"]').forEach(btn => {
      btn.disabled = true;
      btn.style.opacity = '0.55';
      btn.style.pointerEvents = 'none';
    });

    // Tutup modal log inventori
    closeModal('modal-ingredient-log');

    // Tunggu animasi tutup selesai (~280ms), baru buka transaksi
    // --t-slow = 0.28s; pakai 310ms agar animasi benar-benar selesai dulu
    setTimeout(() => {
      this._logTrxLock = false;
      if (trxId) this.viewPosTransaction(trxId);
    }, 310);
  },

  async loadIngredientLogData(append = false) {
    if (!this._ingredientLogId || !this.branch || !this.user) return;

    const listEl  = document.getElementById('ingredient-log-list');
    const moreBtn = document.getElementById('btn-ingredient-log-loadmore');
    if (!listEl) return;

    if (!append) {
      this._ingredientLogOffset = 0;
      listEl.innerHTML = `
        <div class="empty-state" style="padding:40px 0;">
          <div class="empty-icon" style="opacity:.4;">
            <svg xmlns="http://www.w3.org/2000/svg" width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 1 1-6.219-8.56"/></svg>
          </div>
          <div class="empty-title">Memuat riwayat...</div>
        </div>`;
      if (moreBtn) moreBtn.style.display = 'none';
    }

    const fromEl   = document.getElementById('ing-log-date-from');
    const toEl     = document.getElementById('ing-log-date-to');
    const typeEl   = document.getElementById('ing-log-type-filter');
    const dateFrom = fromEl?.value ? (fromEl.value + 'T00:00:00+08:00') : null;
    const dateTo   = toEl?.value   ? (toEl.value   + 'T23:59:59+08:00') : null;
    const typeVal  = typeEl?.value || null;

    try {
      const { data, error } = await db.rpc('get_ingredient_inventory_logs', {
        p_ingredient_id: this._ingredientLogId,
        p_branch_id:     this.branch.id,
        p_user_id:       this.user.id,
        p_date_from:     dateFrom,
        p_date_to:       dateTo,
        p_type:          typeVal,
        p_limit:         this._ingredientLogLimit,
        p_offset:        this._ingredientLogOffset
      });

      if (error) throw new Error(error.message);

      const logs = Array.isArray(data) ? data : [];

      if (!append) {
        if (!logs.length) {
          listEl.innerHTML = `
            <div class="empty-state" style="padding:48px 0;">
              <div class="empty-icon"><i data-lucide="inbox" class="icon"></i></div>
              <div class="empty-title">Belum ada riwayat pergerakan</div>
              <div class="empty-desc" style="max-width:220px;">Bahan ini belum memiliki histori stok yang tercatat.</div>
            </div>`;
          if (window.lucide) lucide.createIcons();
          return;
        }
        listEl.innerHTML = '';
      }

      this._renderIngredientLogRows(listEl, logs);
      this._ingredientLogOffset += logs.length;

      if (moreBtn) {
        moreBtn.style.display = logs.length >= this._ingredientLogLimit ? 'inline-flex' : 'none';
      }

      if (window.lucide) window.requestAnimationFrame(() => lucide.createIcons());
    } catch (e) {
      if (!append) {
        listEl.innerHTML = `
          <div class="empty-state" style="padding:48px 0;">
            <div class="empty-icon"><i data-lucide="wifi-off" class="icon"></i></div>
            <div class="empty-title" style="color:var(--danger);">Riwayat bahan belum bisa dimuat</div>
            <div class="empty-desc">Silakan coba lagi.</div>
          </div>`;
        if (window.lucide) lucide.createIcons();
      }
      console.error('[RBN] loadIngredientLogData:', e.message);
    }
  },

  _renderIngredientLogRows(container, logs) {
    const typeLabel = {
      'in':           'Stok Masuk',
      'out':          'Stok Keluar',
      'transfer_in':  'Transfer Masuk',
      'transfer_out': 'Transfer Keluar',
      'opname':       'Opname',
    };
    const typeBadge = {
      'in':           'badge-green',
      'out':          'badge-red',
      'transfer_in':  'badge-green',
      'transfer_out': 'badge-orange',
      'opname':       'badge-orange',
    };
    const refLabel = {
      'transaction': 'Pemakaian Transaksi',
      'void':        'Void / Retur Transaksi',
      'purchase':    'Pembelian / Restock',
      'transfer':    'Transfer Antar Outlet',
      'manual':      'Penyesuaian Manual',
    };

    const rows = logs.map(log => {
      const qty    = parseFloat(log.quantity || 0);
      const isIn   = qty >= 0;
      const absQty = Math.abs(qty);
      const unit   = escapeHtml(log.ingredient_unit || '');
      const ts     = new Date(log.created_at);
      const tStr   = ts.toLocaleString('id-ID', {
        day:'2-digit', month:'short', year:'numeric',
        hour:'2-digit', minute:'2-digit'
      });
      const actor   = escapeHtml(log.user_name || 'Sistem');
      const before  = parseFloat(log.stock_before ?? 0);
      const after   = parseFloat(log.stock_after  ?? 0);
      const notes   = escapeHtml(log.note || '');
      const typeKey = log.type || 'out';
      const refType = log.reference_type || '';
      const refId   = log.reference_id;

      let refHtml = '';
      if ((refType === 'transaction' || refType === 'void') && refId) {
        const trxNum = parseInt(refId) || refId;
        const labelTrx = refType === 'void' ? 'Void Transaksi' : 'Transaksi Penjualan';
        refHtml = `
          <button class="btn btn-ghost btn-sm"
            style="padding:2px 8px;font-size:11px;height:auto;margin-top:4px;color:var(--primary);border:1px solid var(--border);border-radius:var(--r-sm);"
            data-action="view-log-trx" data-id="${trxNum}">
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:middle;margin-right:3px;"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>
            Lihat ${labelTrx} #${trxNum}
          </button>`;
      } else if (refLabel[refType]) {
        refHtml = `<span class="text-xs text-muted" style="margin-top:3px;display:inline-block;">${escapeHtml(refLabel[refType])}</span>`;
      }

      return `
        <div class="trx-item" style="padding:12px 16px;gap:10px;align-items:flex-start;border-bottom:1px solid var(--border);">
          <div style="width:32px;height:32px;border-radius:50%;flex-shrink:0;display:flex;align-items:center;justify-content:center;margin-top:2px;background:${isIn ? 'var(--success-bg)' : 'var(--danger-bg)'};">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none"
              stroke="${isIn ? 'var(--success)' : 'var(--danger)'}"
              stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
              ${isIn ? '<polyline points="18 15 12 9 6 15"/>' : '<polyline points="6 9 12 15 18 9"/>'}
            </svg>
          </div>
          <div style="flex:1;min-width:0;">
            <div class="flex items-center gap-2 flex-wrap">
              <span class="badge ${typeBadge[typeKey] || 'badge-orange'}" style="font-size:10px;">
                ${escapeHtml(typeLabel[typeKey] || typeKey)}
              </span>
              <span class="fw-700 text-sm ${isIn ? 'text-success' : 'text-danger'}">
                ${isIn ? '+' : '−'}${absQty.toLocaleString('id-ID')} ${unit}
              </span>
            </div>
            <div class="text-xs text-muted" style="margin-top:4px;">
              Stok: <strong>${before.toLocaleString('id-ID')}</strong>
              &rarr;
              <strong>${after.toLocaleString('id-ID')} ${unit}</strong>
            </div>
            ${notes ? `<div class="text-xs text-muted" style="margin-top:3px;font-style:italic;">${notes}</div>` : ''}
            <div style="margin-top:4px;">${refHtml}</div>
            <div class="text-xs text-muted" style="margin-top:4px;">Oleh: ${actor}</div>
          </div>
          <div style="flex-shrink:0;text-align:right;font-size:11px;color:var(--text-muted);white-space:nowrap;margin-top:2px;">${tStr}</div>
        </div>`;
    });

    container.insertAdjacentHTML('beforeend', rows.join(''));
  },

  // ── Stock Adjust (Koreksi manual: masuk, keluar, opname) ────────
  async openStockAdjustModal() {
    if (!this.branch) return;
    const invRes = await db.from('branch_inventory')
      .select('ingredient_id, ingredients(id, name, unit)')
      .eq('branch_id', this.branch.id);

    const sel = document.getElementById('stock-adj-ingredient');
    if (!sel) return;

    const ingredients = (invRes.data || [])
      .map(r => r.ingredients)
      .filter(Boolean)
      .sort((a, b) => a.name.localeCompare(b.name));

    if (invRes.error || !ingredients.length) {
      showToast('Belum ada bahan baku yang dipetakan ke outlet ini.', 'warning');
      return;
    }

    sel.innerHTML = ingredients
      .map(i => `<option value="${i.id}">${escapeHtml(i.name)} (${escapeHtml(i.unit)})</option>`)
      .join('');

    document.getElementById('stock-adj-qty').value   = '';
    document.getElementById('stock-adj-notes').value = '';
    document.getElementById('stock-adj-type').value  = 'in';
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

  // ── Cek pending transfer masuk & update badge ────────────────
  async _checkTransferNotifications() {
    if (!this.branch?.id) return;
    try {
      const pending = await inventoryService.getPendingTransfers(this.branch.id);
      this._updatePendingBadge(pending.length);
    } catch (e) {
      console.warn('[POS] Transfer pending check failed:', e.message);
    }
  },

  _updatePendingBadge(count) {
    const badge = document.getElementById('pending-transfer-badge');
    if (!badge) return;
    if (count > 0) {
      badge.textContent = count > 9 ? '9+' : count;
      badge.style.display = 'flex';
    } else {
      badge.style.display = 'none';
    }
  },

  // ══════════════════════════════════════════════════════════
  // TRANSFER V2: KIRIM STOK
  // ══════════════════════════════════════════════════════════
  async openSendTransferModal() {
    if (!this.branch) return;
    const [invRes, branchRes] = await Promise.all([
      db.from('branch_inventory').select('ingredient_id, stock, ingredients(id, name, unit)').eq('branch_id', this.branch.id),
      db.from('branches').select('id, name').eq('is_active', true).order('name')
    ]);

    const otherBranches = (branchRes.data || []).filter(b => b.id !== this.branch.id);
    if (!otherBranches.length) { showToast('Tidak ada outlet lain yang aktif', 'warning'); return; }

    const branchSel = document.getElementById('send-transfer-branch');
    if (branchSel) branchSel.innerHTML = otherBranches.map(b => `<option value="${b.id}">${escapeHtml(b.name)}</option>`).join('');

    const ingredients = (invRes.data || [])
      .map(r => ({ ...r.ingredients, stock: parseFloat(r.stock || 0) }))
      .filter(Boolean)
      .sort((a, b) => a.name.localeCompare(b.name));

    this._sendTransferIngredients = ingredients;
    document.getElementById('send-transfer-notes').value = '';

    const container = document.getElementById('send-transfer-items');
    container.innerHTML = '';
    this.addTransferItem();

    openModal('modal-send-transfer');
  },

  _renderTransferItemRow(index) {
    const ingredients = this._sendTransferIngredients || [];
    const opts = ingredients.map(i =>
      `<option value="${i.id}">${escapeHtml(i.name)} (${escapeHtml(i.unit)}) — Stok: ${i.stock.toLocaleString('id-ID')}</option>`
    ).join('');
    return `
      <div class="transfer-item-row" id="transfer-item-row-${index}"
        style="display:flex;gap:8px;align-items:center;background:var(--bg-alt);border-radius:var(--r-sm);padding:8px 10px;">
        <div style="flex:1;">
          <select class="form-control" id="transfer-ing-${index}" style="margin-bottom:4px;">${opts}</select>
          <input type="number" class="form-control" id="transfer-qty-${index}"
            placeholder="Jumlah" min="0.01" step="0.01" inputmode="decimal"
            style="height:34px;font-size:13px;" />
        </div>
        <button class="btn btn-ghost btn-sm" data-action="remove-transfer-item" data-index="${index}"
          title="Hapus baris" style="flex-shrink:0;color:var(--danger);">
          <i data-lucide="trash-2" class="icon-sm"></i>
        </button>
      </div>`;
  },

  addTransferItem() {
    const container = document.getElementById('send-transfer-items');
    if (!container) return;
    const index = container.children.length;
    container.insertAdjacentHTML('beforeend', this._renderTransferItemRow(index));
    if (window.lucide) lucide.createIcons();
  },

  removeTransferItem(index) {
    const row = document.getElementById(`transfer-item-row-${index}`);
    if (row) row.remove();
  },

  async submitSendTransfer() {
    const toBranchId = parseInt(document.getElementById('send-transfer-branch').value);
    const notes      = (document.getElementById('send-transfer-notes').value || '').trim();

    if (!toBranchId) { showToast('Pilih outlet tujuan', 'error'); return; }

    const container = document.getElementById('send-transfer-items');
    const rows = container ? container.querySelectorAll('.transfer-item-row') : [];
    const items = [];

    for (const row of rows) {
      const idx = row.id.replace('transfer-item-row-', '');
      const ingId = parseInt(document.getElementById(`transfer-ing-${idx}`)?.value);
      const qty   = parseFloat(document.getElementById(`transfer-qty-${idx}`)?.value);
      if (!ingId || !qty || qty <= 0) continue;
      if (items.some(it => it.ingredient_id === ingId)) {
        showToast('Bahan yang sama tidak boleh dipilih lebih dari satu kali', 'error');
        return;
      }
      items.push({ ingredient_id: ingId, qty });
    }

    if (!items.length) { showToast('Isi minimal satu bahan dengan jumlah yang valid', 'error'); return; }

    const btn = document.getElementById('btn-submit-send-transfer');
    if (btn) { btn.disabled = true; btn.textContent = 'Mengirim...'; }

    try {
      const { transferCode } = await inventoryService.createStockTransfer({
        fromBranchId: this.branch.id,
        toBranchId,
        items,
        notes: notes || null,
        userId: this.user.id
      });
      closeModal('modal-send-transfer');
      this.loadInventorySummary();
      this.refreshStockCache();
      showToast(`Transfer ${transferCode} berhasil dikirim. Menunggu konfirmasi outlet tujuan.`, 'success');
    } catch (e) {
      showToast('Gagal mengirim: ' + e.message, 'error');
    } finally {
      if (btn) { btn.disabled = false; btn.innerHTML = '<i data-lucide="send" class="icon-sm"></i> Kirim Stok'; if (window.lucide) lucide.createIcons(); }
    }
  },

  // ══════════════════════════════════════════════════════════
  // TRANSFER V2: TERIMA STOK (pending transfers)
  // ══════════════════════════════════════════════════════════
  async openPendingTransfersModal() {
    openModal('modal-pending-transfers');
    const list = document.getElementById('pending-transfers-list');
    list.innerHTML = '<div style="text-align:center;padding:20px;color:var(--text-muted);">Memuat...</div>';
    try {
      const pending = await inventoryService.getPendingTransfers(this.branch.id);
      this._updatePendingBadge(pending.length);
      if (!pending.length) {
        list.innerHTML = `
          <div style="text-align:center;padding:32px 16px;">
            <div style="font-size:2rem;margin-bottom:8px;">📭</div>
            <div style="font-weight:700;color:var(--text);">Tidak ada transfer masuk</div>
            <div style="font-size:12px;color:var(--text-muted);margin-top:4px;">Semua kiriman dari outlet lain sudah diterima.</div>
          </div>`;
        return;
      }
      list.innerHTML = pending.map(t => this._renderPendingTransferCard(t)).join('');
      if (window.lucide) lucide.createIcons();
    } catch (e) {
      list.innerHTML = `<div style="padding:12px;color:var(--danger);">Gagal memuat: ${escapeHtml(e.message)}</div>`;
    }
  },

  _renderPendingTransferCard(t) {
    const dateStr = new Date(t.created_at).toLocaleString('id-ID', { day:'2-digit', month:'short', year:'numeric', hour:'2-digit', minute:'2-digit' });
    const items = (t.items || []).map(it =>
      `<div style="display:flex;justify-content:space-between;font-size:13px;padding:3px 0;border-bottom:1px solid var(--border);">
        <span>${escapeHtml(it.ingredient_name)}</span>
        <span style="font-weight:700;color:var(--primary);">+${parseFloat(it.qty).toLocaleString('id-ID')} ${escapeHtml(it.unit)}</span>
      </div>`
    ).join('');
    const noteHtml = t.notes ? `<div style="font-size:11px;color:var(--text-muted);margin-top:6px;font-style:italic;">Catatan: ${escapeHtml(t.notes)}</div>` : '';
    return `
      <div style="border:1.5px solid var(--border);border-radius:var(--r-lg);padding:14px;background:#fff;">
        <div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:8px;">
          <div>
            <div style="font-size:11px;font-weight:700;color:var(--primary);letter-spacing:.5px;">${escapeHtml(t.transfer_code)}</div>
            <div style="font-size:13px;font-weight:700;margin-top:1px;">Dari: ${escapeHtml(t.from_branch_name)}</div>
            <div style="font-size:11px;color:var(--text-muted);">${dateStr} &middot; Dikirim oleh: ${escapeHtml(t.created_by_name)}</div>
          </div>
          <span style="flex-shrink:0;padding:2px 8px;border-radius:20px;font-size:11px;font-weight:700;background:#fff7ed;color:#c05621;">Menunggu</span>
        </div>
        <div style="background:var(--bg-alt);border-radius:var(--r-sm);padding:8px 10px;margin-bottom:8px;">${items}</div>
        ${noteHtml}
        <div style="display:flex;gap:8px;margin-top:10px;">
          <button class="btn btn-primary btn-sm" style="flex:1;" data-action="confirm-transfer" data-id="${t.id}">
            <i data-lucide="check" class="icon-sm"></i> Terima
          </button>
          <button class="btn btn-sm" style="flex:1;border:1.5px solid var(--danger);color:var(--danger);background:transparent;" data-action="reject-transfer" data-id="${t.id}">
            <i data-lucide="x" class="icon-sm"></i> Tolak
          </button>
        </div>
      </div>`;
  },

  async confirmTransfer(transferId) {
    const ok = await showConfirm({
      title:       'Terima Transfer?',
      message:     'Konfirmasi penerimaan barang? Stok outlet Anda akan bertambah sesuai jumlah yang dikirim.',
      confirmText: 'Ya, Terima',
    });
    if (!ok) return;
    try {
      const code = await inventoryService.confirmTransfer({ transferId, userId: this.user.id });
      showToast(`Transfer ${code} berhasil diterima. Stok sudah bertambah.`, 'success');
      this.openPendingTransfersModal();
      this.loadInventorySummary();
      this.refreshStockCache();
    } catch (e) {
      showToast('Gagal menerima transfer: ' + e.message, 'error');
    }
  },

  async rejectTransfer(transferId) {
    const reason = await showPrompt({
      title:       'Tolak Transfer',
      message:     'Alasan penolakan (opsional, kosongkan jika tidak ingin mengisi):',
      placeholder: 'Contoh: Barang tidak sesuai pesanan',
      confirmText: 'Tolak',
    });
    if (reason === null) return;
    try {
      const code = await inventoryService.rejectTransfer({ transferId, userId: this.user.id, reason });
      showToast(`Transfer ${code} ditolak. Stok pengirim dikembalikan.`, 'success');
      this.openPendingTransfersModal();
    } catch (e) {
      showToast('Gagal menolak transfer: ' + e.message, 'error');
    }
  },

  // ══════════════════════════════════════════════════════════
  // TRANSFER V2: RIWAYAT TRANSFER
  // ══════════════════════════════════════════════════════════
  async openTransferHistoryModal() {
    openModal('modal-transfer-history');
    const list = document.getElementById('transfer-history-list');
    list.innerHTML = '<div style="text-align:center;padding:20px;color:var(--text-muted);">Memuat...</div>';
    try {
      const history = await inventoryService.getTransferHistory(this.branch.id, 50, 0);
      if (!history.length) {
        list.innerHTML = '<div style="text-align:center;padding:32px;color:var(--text-muted);">Belum ada riwayat transfer.</div>';
        return;
      }
      list.innerHTML = history.map(t => this._renderTransferHistoryCard(t)).join('');
      if (window.lucide) lucide.createIcons();
    } catch (e) {
      list.innerHTML = `<div style="padding:12px;color:var(--danger);">Gagal memuat: ${escapeHtml(e.message)}</div>`;
    }
  },

  _renderTransferHistoryCard(t) {
    const statusConfig = {
      pending:   { label: 'Menunggu',   bg: '#fff7ed', color: '#c05621' },
      confirmed: { label: 'Selesai',    bg: '#f0fdf4', color: '#166534' },
      rejected:  { label: 'Ditolak',    bg: '#fef2f2', color: '#991b1b' },
      cancelled: { label: 'Dibatalkan', bg: '#f9fafb', color: '#6b7280' }
    };
    const sc = statusConfig[t.status] || { label: t.status, bg: '#f9fafb', color: '#6b7280' };
    const isSender   = t.from_branch_id === this.branch?.id;
    const dirLabel   = isSender
      ? `Ke: <strong>${escapeHtml(t.to_branch_name)}</strong>`
      : `Dari: <strong>${escapeHtml(t.from_branch_name)}</strong>`;
    const dateStr = new Date(t.created_at).toLocaleString('id-ID', { day:'2-digit', month:'short', year:'numeric', hour:'2-digit', minute:'2-digit' });
    const items = (t.items || []).map(it =>
      `<span style="font-size:11px;">${escapeHtml(it.ingredient_name)}: ${parseFloat(it.qty).toLocaleString('id-ID')} ${escapeHtml(it.unit)}</span>`
    ).join(' &middot; ');
    const rejNote = t.rejection_reason
      ? `<div style="font-size:11px;color:var(--danger);margin-top:4px;">Alasan: ${escapeHtml(t.rejection_reason)}</div>` : '';
    const cancelBtn = (t.status === 'pending' && isSender)
      ? `<button class="btn btn-sm" style="margin-top:8px;color:var(--danger);font-size:11px;border:1px solid var(--border);background:transparent;" data-action="cancel-transfer" data-id="${t.id}">Batalkan Transfer</button>`
      : '';
    return `
      <div style="border:1.5px solid var(--border);border-radius:var(--r-lg);padding:12px;background:#fff;">
        <div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:4px;">
          <div>
            <div style="font-size:11px;font-weight:700;color:var(--primary);">${escapeHtml(t.transfer_code)}</div>
            <div style="font-size:12px;margin-top:2px;">${dirLabel}</div>
            <div style="font-size:11px;color:var(--text-muted);">${dateStr}</div>
          </div>
          <span style="flex-shrink:0;padding:2px 8px;border-radius:20px;font-size:11px;font-weight:700;background:${sc.bg};color:${sc.color};">${sc.label}</span>
        </div>
        <div style="font-size:11px;color:var(--text-muted);margin-top:4px;">${items}</div>
        ${rejNote}
        ${cancelBtn}
      </div>`;
  },

  async cancelTransfer(transferId) {
    const ok = await showConfirm({
      title:       'Batalkan Transfer?',
      message:     'Batalkan transfer ini? Stok akan dikembalikan ke outlet Anda.',
      confirmText: 'Ya, Batalkan',
    });
    if (!ok) return;
    try {
      const code = await inventoryService.cancelTransfer({ transferId, userId: this.user.id });
      showToast(`Transfer ${code} dibatalkan. Stok sudah dikembalikan.`, 'success');
      this.openTransferHistoryModal();
      this.loadInventorySummary();
      this.refreshStockCache();
    } catch (e) {
      showToast('Gagal membatalkan: ' + e.message, 'error');
    }
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
    const refundOut    = summary?.refundOut    ?? 0;
    const voidOut      = summary?.voidOut      ?? 0;
    const depositOut   = summary?.depositOut   ?? 0;
    const totalCashOut = manualOut + refundOut + voidOut;
    const expectedCash = summary?.expectedCash ?? (openingCash + salesIn + manualIn - totalCashOut);

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
            <div class="cash-stat-value text-danger">−${formatRupiah(totalCashOut)}</div>
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
      if (window.showDbError) showDbError(e, { action: 'membatalkan log kas', entity: 'Log kas' });
      else showToast('Gagal membatalkan log kas', 'error');
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
      if (window.showDbError) showDbError(e, { action: 'mencatat kas', entity: 'Catatan kas' });
      else showToast('Gagal mencatat kas', 'error');
    }
  },

  // ── Payment Modal ────────────────────────────────────────────
  async openPaymentModal() {
    if (!this.cart.length) { showToast('Keranjang masih kosong', 'warning'); return; }
    if (!this.session) {
      showToast('Buka shift terlebih dahulu sebelum bertransaksi', 'warning');
      this.openShiftModal();
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
        const { data, error } = await db.from('payment_methods').select('code, label, fee_label, fee_percent, is_fee_enabled, is_active').eq('is_active', true).order('id');
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

    // Hard guard: pastikan sesi di DB masih open (menghindari state frontend stale).
    try {
      const latestOwnSession = await this.getOwnOpenShift();
      if (!latestOwnSession) {
        this.session = null;
        showToast('Shift kas sudah ditutup. Buka shift kembali sebelum checkout.', 'warning');
        await this.openShiftModal();
        return;
      }
      this.session = latestOwnSession;
    } catch (e) {
      console.error('confirmCheckout: gagal validasi shift', e);
      showToast('Gagal memvalidasi status shift. Coba lagi.', 'error');
      return;
    }

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
      // Invalidate tab caches so data refreshes on next visit
      this._invalidateTabCache('summary');
      this._invalidateTabCache('transactions');
      this._invalidateTabCache('cash');
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

window.POS = POS;

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
