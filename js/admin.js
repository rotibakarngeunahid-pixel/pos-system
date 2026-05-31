'use strict';

const ADMIN = {
  user:        null,
  branches:    [],
  products:    [],
  ingredients: [],
  suppliers:   [],
  productCategories: [],
  purchaseItems: [],   // temp items for PO being built
  currentSection: 'dashboard',
  currentReportTab: 'sales',
  _bulkImportData: null,  // parsed rows waiting for confirmation
  _allProducts:    [],    // cache for client-side product search/filter
  _copyMenuPreview:    null,
  _copyMenuSubmitting: false,
  _reportData:         null,

  // ── Init ─────────────────────────────────────────────────────
  async init() {
    this.user = auth.requireAnyRole(['admin', 'owner']);
    if (!this.user) return;
    this.user = await auth.validateCurrentUser(['admin', 'owner']);
    if (!this.user) return;

    document.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-admin-action]');
      if (!btn) return;
      const action = btn.dataset.adminAction;
      switch (action) {
        case 'navigate': this.navigate(btn.dataset.section, btn); break;
        case 'confirm-logout': this.confirmLogout(); break;
        case 'toggle-sidebar-collapse': this.toggleSidebarCollapse(); break;
        case 'close-sidebar': this.closeSidebar(); break;
        case 'toggle-sidebar': this.toggleSidebar(); break;
        case 'open-pos-window': window.open('pos.html', '_blank'); break;
        case 'close-modal': this.closeModal(btn.dataset.modalId); break;
        case 'close-generic-modal': closeModal(btn.dataset.modalId); break;
        case 'open-branch-modal': this.openBranchModal(btn.dataset.id ? Number(btn.dataset.id) : null); break;
        case 'delete-branch': this.deleteBranch(Number(btn.dataset.id), btn.dataset.name || ''); break;
        case 'open-product-modal': this.openProductModal(btn.dataset.id ? Number(btn.dataset.id) : null); break;
        case 'delete-product': this.deleteProduct(Number(btn.dataset.id), btn.dataset.name || ''); break;
        case 'open-product-category-modal': this.openProductCategoryModal(btn.dataset.id ? Number(btn.dataset.id) : null, btn.dataset.name || ''); break;
        case 'delete-product-category': this.deleteProductCategory(Number(btn.dataset.id), btn.dataset.name || ''); break;
        case 'open-recipe-item-modal': this.openRecipeItemModal(btn.dataset.id ? Number(btn.dataset.id) : null); break;
        case 'delete-recipe-item': this.deleteRecipeItem(Number(btn.dataset.id)); break;
        case 'create-recipe': this.createRecipe(btn.dataset.variantId, btn.dataset.variantName || 'Resep'); break;
        case 'open-staff-modal': this.openStaffModal(btn.dataset.id ? Number(btn.dataset.id) : null); break;
        case 'delete-staff': this.deleteStaff(Number(btn.dataset.id), btn.dataset.name || ''); break;
        case 'open-investor-modal': this.openInvestorModal(btn.dataset.id ? Number(btn.dataset.id) : null); break;
        case 'delete-investor': this.deleteStaff(Number(btn.dataset.id), btn.dataset.name || ''); break;
        case 'edit-investor-access': this.openInvestorAccessModal(Number(btn.dataset.id)); break;
        case 'open-ingredient-modal': this.openIngredientModal(); break;
        case 'open-edit-ingredient-modal': this.openEditIngredientModal(Number(btn.dataset.id)); break;
        case 'delete-ingredient': this.deleteIngredient(Number(btn.dataset.id), btn.dataset.name || ''); break;
        case 'open-ingredient-products': this.openIngredientProductsModal(Number(btn.dataset.id)); break;
        case 'view-transaction': this.viewTransaction(Number(btn.dataset.id)); break;
        case 'void-cash-log': this.voidCashLog(Number(btn.dataset.id)); break;
        case 'open-variant-modal': this.openVariantModal(Number(btn.dataset.id)); break;
        case 'delete-variant': this.deleteVariant(Number(btn.dataset.id), btn.dataset.name || ''); break;
        case 'edit-product-variant': this.editProductVariant(Number(btn.dataset.id), btn.dataset.name || '', safeNum(btn.dataset.price || 0, 'Variant Price')); break;
        case 'delete-product-variant': this.deleteProductVariant(Number(btn.dataset.id), btn.dataset.name || ''); break;
        case 'remove-pending-variant': this.removePendingVariant(Number(btn.dataset.index)); break;
        case 'edit-payment-method': this.editPaymentMethod(Number(btn.dataset.index)); break;
        case 'delete-payment-method': this.deletePaymentMethod(Number(btn.dataset.index)); break;
        case 'open-cash-category-modal': this.openCashCategoryModal(btn.dataset.id ? Number(btn.dataset.id) : null, btn.dataset.name || '', btn.dataset.type || 'in'); break;
        case 'delete-cash-category': this.deleteCashCategory(Number(btn.dataset.id), btn.dataset.name || ''); break;
        case 'open-inventory-modal': this.openInventoryModal(btn.dataset.type); break;
        case 'set-trx-quick-filter': this.setTrxQuickFilter(btn.dataset.filter, btn); break;
        case 'run-report': this.runReport(this.currentReportTab || 'sales'); break;
        case 'switch-report-tab': this.switchReportTab(btn.dataset.tab, btn); break;
        case 'export-report': this.exportReportCsv(); break;
        case 'save-receipt-settings': this.saveReceiptSettings(); break;
        case 'render-receipt-preview': this.renderReceiptPreview(); break;
        case 'add-payment-method': this.addPaymentMethod(); break;
        case 'open-reset-modal': this.openResetModal(); break;
        case 'load-cash-report': this.loadCashReport(); break;
        case 'switch-cash-tab': this.switchCashTab(btn.dataset.tab, btn); break;
        case 'save-branch': this.saveBranch(); break;
        case 'trigger-product-image-file': document.getElementById('product-image-file')?.click(); break;
        case 'save-product': this.saveProduct(); break;
        case 'add-pending-variant': this.addPendingVariant(); break;
        case 'add-product-variant': this.addProductVariant(); break;
        case 'save-variant': this.saveVariant(); break;
        case 'save-ingredient': this.saveIngredient(); break;
        case 'save-recipe-item': this.saveRecipeItem(); break;
        case 'save-inventory-adjust': this.saveInventoryAdjust(); break;
        case 'save-staff': this.saveStaff(); break;
        case 'save-investor-access': this.saveInvestorAccess(); break;
        case 'confirm-refund': this.confirmRefund(); break;
        case 'confirm-void': this.confirmVoid(); break;
        case 'save-cash-category': this.saveCashCategory(); break;
        case 'save-product-category': this.saveProductCategory(); break;
        case 'confirm-reset': this.confirmReset(); break;
        case 'open-branch-product-price-modal': this.openBranchProductPriceModal(Number(btn.dataset.productId), btn.dataset.productName||''); break;
        case 'save-branch-product-price': this.saveBranchProductPrice(); break;
        case 'download-menu-template': this.downloadMenuTemplate(); break;
        case 'trigger-bulk-import-file': document.getElementById('bulk-import-file')?.click(); break;
        case 'confirm-bulk-import': this.confirmBulkImport(); break;
        case 'open-topping-modal': this.openToppingModal(btn.dataset.id ? Number(btn.dataset.id) : null); break;
        case 'save-topping': this.saveTopping(); break;
        case 'delete-topping': this.deleteTopping(Number(btn.dataset.id), btn.dataset.name || ''); break;
        case 'toggle-topping-active': this.toggleToppingActive(Number(btn.dataset.id), btn.dataset.active === 'true'); break;
        case 'open-api-key-modal': this.openApiKeyModal(); break;
        case 'confirm-generate-api-key': this.confirmGenerateApiKey(); break;
        case 'delete-api-key': this.deleteApiKey(Number(btn.dataset.id), btn.dataset.name || ''); break;
        case 'toggle-api-key': this.toggleApiKey(Number(btn.dataset.id), btn.dataset.active === 'true'); break;
        case 'copy-api-key': this.copyApiKey(btn.dataset.key || ''); break;
        case 'open-copy-menu-modal': this.openCopyMenuModal(btn.dataset.targetId ? Number(btn.dataset.targetId) : null); break;
        case 'close-copy-menu-modal': this.resetCopyMenuModal(); closeModal('modal-copy-branch-menu'); break;
        case 'preview-copy-menu': this.loadCopyMenuPreview(); break;
        case 'confirm-copy-menu': this.confirmCopyMenu(); break;
        case 'refresh-transfer-monitoring': this.loadTransferMonitoring(); break;
        case 'admin-confirm-transfer': this.adminConfirmTransfer(Number(btn.dataset.id)); break;
        case 'admin-reject-transfer': this.adminRejectTransfer(Number(btn.dataset.id)); break;
      }
    });
    document.addEventListener('change', (e) => {
      const node = e.target.closest('[data-admin-change]');
      if (!node) return;
      const action = node.dataset.adminChange;
      switch (action) {
        case 'load-dashboard': this.loadDashboard(); break;
        case 'load-recipe-variants': this.loadRecipeVariants(); break;
        case 'load-recipe-items': this.loadRecipeItems(); break;
        case 'load-inventory': this.loadInventory(); break;
        case 'load-transactions': this.loadTransactions(); break;
        case 'load-inventory-logs': this.loadInventoryLogs(); break;
        case 'load-branch-pricing': this.loadBranchPricing(); break;
        case 'toggle-add-fee':
          document.getElementById('pm-add-fee-container').style.display = node.checked ? 'flex' : 'none';
          break;
        case 'preview-image': this.previewImage(node); break;
        case 'toggle-inventory-modal-type': this.toggleInventoryModalType(); break;
        case 'import-menu-file': this.handleImportMenuFile(node); break;
        case 'load-topping-mapping': this.loadToppingMapping(node.value); break;
        case 'toggle-report-void': this.runReport(this.currentReportTab || 'sales'); break;
        case 'load-transfer-monitoring': this.loadTransferMonitoring(); break;
      }
    });
    document.addEventListener('input', (e) => {
      const node = e.target.closest('[data-admin-input]');
      if (node) {
        const action = node.dataset.adminInput;
        if (action === 'preview-image-url') this.previewImageUrl(node.value);
        else if (action === 'update-pending-variant') this.updatePendingVariant(Number(node.dataset.index), node.dataset.field, node.value);
      }
      // Product search (debounced)
      if (e.target.id === 'product-search-input') {
        clearTimeout(this._productSearchTimer);
        this._productSearchTimer = setTimeout(() => ADMIN._renderProductGrid(), 200);
      }
    });

    // Product category filter change
    document.addEventListener('change', (e) => {
      if (e.target.id === 'product-category-filter') ADMIN._renderProductGrid();
      if (e.target.name === 'product-type') {
        const isSimple = e.target.value === 'simple';
        const simpleSec  = document.getElementById('product-simple-price-section');
        const variantSec = document.getElementById('product-variant-section');
        if (simpleSec)  simpleSec.style.display  = isSimple ? '' : 'none';
        if (variantSec) variantSec.style.display  = isSimple ? 'none' : '';
      }
    }, true);

    document.getElementById('sidebar-user-name').textContent = this.user.name;
    const avatarEl = document.getElementById('sidebar-user-avatar');
    if (avatarEl) avatarEl.textContent = this.user.name.charAt(0).toUpperCase();

    // BUG-16 FIX: Update topbar date at midnight instead of only once at init
    function updateTopbarDate() {
      const el = document.getElementById('topbar-date');
      if (el) el.textContent = new Date().toLocaleDateString('id-ID', {
        weekday: 'long', day: '2-digit', month: 'long', year: 'numeric'
      });
      const now = new Date();
      const midnight = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
      setTimeout(updateTopbarDate, midnight - now);
    }
    updateTopbarDate();

    // Restore sidebar collapse state
    if (localStorage.getItem('sidebar-collapsed') === 'true') {
      document.getElementById('admin-sidebar')?.classList.add('collapsed');
      const btn = document.getElementById('sidebar-collapse-btn');
      if (btn) btn.textContent = '›';
    }

    // Set today's date for transactions (WITA business date)
    const dateInput = document.getElementById('trx-date-filter');
    if (dateInput) dateInput.value = fmt.getBusinessDate();

    await this.loadMasterData();
    // Load settings (includes payment methods)
    await this.loadSettings();
    await this.loadDashboard();
    this.hideLoader();

    // Init Lucide icons (after DOM is ready)
    if (window.lucide) lucide.createIcons();
    this._bulkModalInit();
  },

  // ── Sidebar Collapse ──────────────────────────────────────────
  toggleSidebarCollapse() {
    const sidebar = document.getElementById('admin-sidebar');
    const btn     = document.getElementById('sidebar-collapse-btn');
    sidebar.classList.toggle('collapsed');
    const isCollapsed = sidebar.classList.contains('collapsed');
    localStorage.setItem('sidebar-collapsed', isCollapsed);
    if (btn) btn.textContent = isCollapsed ? '‹' : '›';
  },

  // ── Master data ───────────────────────────────────────────────
  async loadMasterData() {
    // product_categories is loaded separately with a graceful fallback in case
    // the table doesn't exist yet (run cpanel_mysql_schema.sql in phpMyAdmin to create it).
    const [branchRes, productRes, ingRes, supRes] = await Promise.all([
      db.from('branches').select('*').order('name'),
      db.from('products').select('*').order('name'),
      db.from('ingredients').select('*').order('name'),
      db.from('suppliers').select('*').order('name')
    ]);
    this.branches    = this._activeBranches(branchRes.data);
    this.products    = productRes.data || [];
    this.ingredients = ingRes.data     || [];
    this.suppliers   = supRes.data     || [];

    // Graceful load: product_categories may not exist if schema_v4.sql hasn't been run
    try {
      const catRes = await db.from('product_categories').select('*').order('name');
      if (catRes.error) {
        // Table missing — warn but don't crash
        console.warn('[RBN] product_categories table not found. Run schema_v4.sql to create it.', catRes.error.message);
        this.productCategories = this.productCategories || [];
      } else {
        this.productCategories = catRes.data || [];
      }
    } catch (e) {
      console.warn('[RBN] Failed to load product_categories:', e.message);
      this.productCategories = this.productCategories || [];
    }

    this.populateBranchSelects();
    this.populateProductSelects();
    this.populateProductCategorySelects();
  },

  // ── Targeted cache refreshers (lighter than loadMasterData) ──
  async _refreshBranchesCache() {
    const { data } = await db.from('branches').select('*').order('name');
    this.branches = this._activeBranches(data);
    this.populateBranchSelects();
  },

  async _refreshProductsCache() {
    const { data } = await db.from('products').select('*').order('name');
    this.products = data || [];
    this.populateProductSelects();
  },

  async _refreshIngredientsCache() {
    const { data } = await db.from('ingredients').select('*').order('name');
    this.ingredients = data || [];
  },

  async _refreshCategoriesCache() {
    try {
      const { data, error } = await db.from('product_categories').select('id, name').order('name');
      if (!error) {
        this.productCategories = data || [];
        this.populateProductCategorySelects();
      }
    } catch (e) {
      console.warn('[RBN] _refreshCategoriesCache failed:', e.message);
    }
  },

  // ── Central post-mutation refresh helper ──────────────────────
  // resources: array of cache keys to refresh in parallel
  // views: array of view keys to re-render after cache refresh
  // successMessage: shown after both caches and views are refreshed
  async refreshAfterMutation({ resources = [], views = [], successMessage = '' } = {}) {
    const cacheLoaders = {
      branches:       () => this._refreshBranchesCache(),
      products:       () => this._refreshProductsCache(),
      ingredients:    () => this._refreshIngredientsCache(),
      categories:     () => this._refreshCategoriesCache(),
      paymentMethods: () => this.loadSettings(),
    };
    const viewLoaders = {
      branches:         () => this.loadBranches(),
      products:         () => this.loadProducts(),
      ingredients:      () => this.loadIngredients(),
      inventory:        () => this.loadInventory(),
      'product-categories': () => this.loadProductCategories(),
      transactions:     () => this.loadTransactions(),
      staff:            () => this.loadStaff(),
      'investor-access':() => this.loadInvestorAccess(),
      'cash-categories':() => this.loadCashCategories(),
      toppings:         () => this.loadToppingSection(),
      'api-keys':       () => this.loadApiKeysSection(),
      recipes:          () => this.loadRecipeItems(),
      'branch-pricing': () => this.loadBranchPricing(),
      variants:         () => this.loadVariants(),
    };
    try {
      await Promise.all(resources.map(r => cacheLoaders[r]?.() ?? Promise.resolve()));
      for (const v of views) {
        if (viewLoaders[v]) await viewLoaders[v]();
      }
      if (successMessage) showToast(successMessage, 'success');
    } catch (e) {
      console.error('[RBN] refreshAfterMutation failed:', e);
      if (successMessage) {
        showToast(`Data tersimpan, tampilan gagal diperbarui — ${e.message}`, 'warning');
      } else {
        showToast('Tampilan gagal diperbarui. Klik Refresh jika data tidak muncul.', 'warning');
      }
    }
  },

  populateBranchSelects() {
    const opts    = this.branches.map(b => `<option value="${b.id}">${escHtml(b.name)}</option>`).join('');
    const allOpts = `<option value="">Semua Cabang</option>${opts}`;
    setSelect('dash-branch-filter',    allOpts);
    setSelect('trx-branch-filter',     allOpts);
    setSelect('report-branch-filter',  allOpts);
    setSelect('inv-branch-filter',     `<option value="">Pilih Cabang</option>${opts}`);
    setSelect('assign-branch-filter',  `<option value="">Pilih Cabang</option>${opts}`);
    setSelect('inv-adj-branch-id',     opts);
    setSelect('inv-transfer-from',     opts);
    setSelect('inv-transfer-to',       opts);
    setSelect('staff-branch-id',       `<option value="">— Tidak Ditentukan —</option>${opts}`);
    setSelect('po-branch-id',          opts);
    setSelect('inv-log-branch-filter', `<option value="">Semua Cabang</option>${opts}`);
    setSelect('branch-pricing-filter', `<option value="">— Pilih Cabang —</option>${opts}`);
    // Finance integration portal branch filter
    if (window.adminFinanceIntegrationUi) {
      adminFinanceIntegrationUi.populateBranchSelect(this.branches);
    }
  },

  populateProductSelects() {
    const opts = this.products.map(p => `<option value="${p.id}">${escHtml(p.name)}</option>`).join('');
    setSelect('variant-product-filter',    `<option value="">Pilih Produk</option>${opts}`);
    setSelect('variant-product-id',        opts);
    setSelect('recipe-product-filter',     `<option value="">Pilih Produk</option>${opts}`);
    setSelect('topping-mapping-product',   `<option value="">— Pilih Produk —</option>${opts}`);
  },

  populateProductCategorySelects() {
    const opts = this.productCategories.map(c => `<option value="${escHtml(c.name)}">${escHtml(c.name)}</option>`).join('');
    setSelect('product-category', `<option value="">-- Pilih Kategori --</option>${opts}`);
  },

  // ── Navigation ────────────────────────────────────────────────
  navigate(section, btn) {
    this.closeSidebar();
    document.querySelectorAll('.nav-item').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    document.querySelectorAll('.admin-section').forEach(s => s.classList.remove('active'));
    document.getElementById(`section-${section}`).classList.add('active');

    // Sync bottom nav active state
    document.querySelectorAll('.admin-bottom-tab[data-section]').forEach(t => t.classList.remove('active'));
    const abnTab = document.querySelector(`.admin-bottom-tab[data-section="${section}"]`);
    if (abnTab) abnTab.classList.add('active');

    const titles = {
      dashboard:   'Dashboard',         branches:     'Manajemen Cabang',
      products:    'Manajemen Produk',  recipes:      'Resep / BOM',
      'product-categories': 'Kategori Produk',
      'branch-pricing': 'Harga Per-Cabang',
      inventory:   'Inventori',         transactions: 'Riwayat Transaksi',
      staff:       'Manajemen Staff',
      reports:     'Laporan',           'inv-logs':   'Log Inventori',
      ingredients: 'Bahan Baku',        settings:     'Pengaturan',
      'cash-report': 'Laporan Kas',     'cash-categories': 'Kategori Kas',
      'cash-deposits': 'Setoran Manual', 'toppings':    'Manajemen Topping',
      'branch-cash': 'Kas Outlet',      'cash-branch-transfers': 'Setoran Antar Outlet',
      'api-keys': 'API Keys',           'investor-access': 'Investor Access',
      'finance-integration': 'Portal Integrasi Data',
      'transfer-monitoring': 'Monitoring Transfer Stok'
    };
    document.getElementById('topbar-title').textContent = titles[section] || section;
    this.currentSection = section;

    switch (section) {
      case 'branches':        this.loadBranches();        break;
      case 'products':        this.loadProducts();        break;
      case 'product-categories': this.loadProductCategories(); break;
      case 'branch-pricing':  this.loadBranchPricing();   break;
      case 'transactions':    this.loadTransactions();    break;
      case 'staff':           this.loadStaff();           break;
      case 'reports':         this.loadReports();         break;
      case 'inv-logs':        this.loadInventoryLogs();   break;
      case 'ingredients':     this.loadIngredients();     break;
      case 'settings':        this.loadSettings();        break;
      case 'cash-report':     this.loadCashReport();      break;
      case 'cash-categories': this.loadCashCategories();  break;
      case 'cash-deposits':
        if (window.adminDepositUi) {
          adminDepositUi.loadDeposits();
          adminDepositUi.loadAccounts();
        }
        break;
      case 'toppings':              this.loadToppingSection();    break;
      case 'api-keys':              this.loadApiKeysSection();    break;
      case 'investor-access':       this.loadInvestorAccess();    break;
      case 'branch-cash':           this.loadBranchCash();        break;
      case 'cash-branch-transfers':
        if (window.adminCashBranchTransferUi) adminCashBranchTransferUi.load();
        break;
      case 'finance-integration':   this.loadFinanceIntegration(); break;
      case 'transfer-monitoring':   this.loadTransferMonitoring(); break;
    }
  },

  toggleSidebar() {
    document.getElementById('admin-sidebar').classList.toggle('open');
    document.getElementById('sidebar-overlay').classList.toggle('show');
  },
  closeSidebar() {
    document.getElementById('admin-sidebar').classList.remove('open');
    document.getElementById('sidebar-overlay').classList.remove('show');
  },

  // ── Dashboard ─────────────────────────────────────────────────
  async loadDashboard() {
    const branchId   = document.getElementById('dash-branch-filter').value;
    // BUG-H3 FIX: Use business date range (cutoff jam 03:00) agar konsisten dengan POS summary
    const today      = fmt.getBusinessDate();
    const { from: todayFrom, to: todayTo } = fmt.getBusinessDateRange(today);
    const monthStart = today.slice(0, 7) + '-01';
    const { from: monthFrom } = fmt.getBusinessDateRange(monthStart);

    let qToday  = db.from('transactions').select('total, branch_id').eq('status','completed').gte('created_at', todayFrom).lte('created_at', todayTo);
    let qMonth  = db.from('transactions').select('total').eq('status','completed').gte('created_at', monthFrom);
    let qRecent = db.from('transactions')
      .select('id, created_at, total, payment_method, branch_id, status, branches(name), users!staff_id(name)')
      .order('created_at', { ascending: false }).limit(10);

    if (branchId) {
      qToday  = qToday.eq('branch_id', branchId);
      qMonth  = qMonth.eq('branch_id', branchId);
      qRecent = qRecent.eq('branch_id', branchId);
    }

    const [todayRes, monthRes, recentRes, prodCount, lowStockRes] = await Promise.all([
      qToday, qMonth, qRecent,
      db.from('products').select('id', { count:'exact', head:true }),
      db.from('branch_inventory').select('stock, ingredients(name), branches(name)').lt('stock', 5).limit(5)
    ]);

    const todayData  = todayRes.data  || [];
    const monthData  = monthRes.data  || [];
    const recentData = recentRes.data || [];

    document.getElementById('stat-sales').textContent        = fRp(todayData.reduce((s,t)=>s+parseFloat(t.total),0));
    document.getElementById('stat-transactions').textContent  = todayData.length;
    document.getElementById('stat-monthly').textContent       = fRp(monthData.reduce((s,t)=>s+parseFloat(t.total),0));
    document.getElementById('stat-products').textContent      = prodCount.count || 0;

    const tbody = document.getElementById('recent-trx-body');
    tbody.innerHTML = recentData.length ? recentData.map((t, i) => `
      <tr>
        <td>${i+1}</td>
        <td class="nowrap">${fDate(t.created_at)}</td>
        <td>${escHtml(t.branches?.name||'—')}</td>
        <td>${escHtml(t.users?.name||'—')}</td>
        <td><span class="badge badge-orange">${t.payment_method||'cash'}</span></td>
        <td><span class="badge ${t.status==='completed'?'badge-green':t.status==='refunded'?'badge-red':'badge-orange'}">${t.status||'completed'}</span></td>
        <td class="fw-700">${fRp(t.total)}</td>
      </tr>`).join('')
    : `<tr><td colspan="7" class="text-center text-muted p-6">Belum ada transaksi hari ini</td></tr>`;

    // Low stock alerts
    const alertEl = document.getElementById('low-stock-alerts');
    if (alertEl) {
      const low = lowStockRes.data || [];
      alertEl.innerHTML = low.length
        ? low.map(r => `<div class="alert-row"><span class="text-danger fw-700">!</span> <strong>${escHtml(r.ingredients?.name)}</strong> — stok ${parseFloat(r.stock)} (${escHtml(r.branches?.name||'?')})</div>`).join('')
        : '<div class="text-muted text-sm">Semua stok aman</div>';
    }

    // BUG-12 FIX: Wire up dashboard refresh button (added to admin.html)
    const refreshBtn = document.getElementById('dashboard-refresh-btn');
    if (refreshBtn && !refreshBtn._bound) {
      refreshBtn.addEventListener('click', () => ADMIN.loadDashboard());
      refreshBtn._bound = true;
    }
  },

  // ── Branches ─────────────────────────────────────────────────
  async loadBranches() {
    const { data, error } = await db.from('branches').select('*').order('created_at', { ascending:false });
    if (error) { showDbError(error, { action: 'memuat cabang', entity: 'Data cabang' }); return; }
    const container = document.getElementById('branches-list');
    const activeBranches = this._activeBranches(data);
    container.innerHTML = activeBranches.length
      ? `<div class="admin-list">${activeBranches.map(b => `
          <div class="admin-list-card">
            <div class="list-card-icon"><i data-lucide="store" class="icon"></i></div>
            <div class="list-card-info">
              <div class="list-card-title">${escHtml(b.name)}</div>
              <div class="list-card-sub">${escHtml(b.address||'Tidak ada alamat')}</div>
            </div>
            <div class="list-card-meta">${fDate(b.created_at)}</div>
            <div class="list-card-actions">
              <button class="btn btn-outline btn-sm" data-admin-action="open-copy-menu-modal" data-target-id="${b.id}">Copy Menu</button>
              <button class="btn btn-outline btn-sm" data-admin-action="open-branch-modal" data-id="${b.id}">Edit</button>
              <button class="btn btn-danger-soft btn-sm" data-admin-action="delete-branch" data-id="${b.id}" data-name="${escHtml(b.name)}">Hapus</button>
            </div>
          </div>`).join('')}</div>`
      : `<div class="empty-state">
          <div class="empty-icon"><i data-lucide="store" class="icon"></i></div>
          <div class="empty-title">Belum ada cabang</div>
          <div class="empty-desc">Tambahkan cabang pertama untuk mulai menggunakan sistem</div>
          <div class="empty-cta"><button class="btn btn-primary" data-admin-action="open-branch-modal">+ Tambah Cabang</button></div>
        </div>`;
  },

  openBranchModal(id = null) {
    document.getElementById('branch-id').value       = id || '';
    document.getElementById('branch-name').value     = '';
    document.getElementById('branch-address').value  = '';
    document.getElementById('branch-modal-title').textContent = id ? 'Edit Cabang' : 'Tambah Cabang';
    if (id) {
      const b = this.branches.find(x => x.id === id) || {};
      document.getElementById('branch-name').value    = b.name    || '';
      document.getElementById('branch-address').value = b.address || '';
    }
    openModal('modal-branch');
  },

  async saveBranch() {
    const id      = document.getElementById('branch-id').value;
    const name    = document.getElementById('branch-name').value.trim();
    const address = document.getElementById('branch-address').value.trim();
    if (!name) { showToast('Nama cabang wajib diisi', 'error'); return; }

    let newBranchId = null;
    if (id) {
      const { error } = await db.from('branches').update({ name, address }).eq('id', id);
      if (error) { showDbError(error, { action: 'menyimpan cabang', entity: 'Cabang' }); return; }
    } else {
      const { data, error } = await db.from('branches').insert({ name, address }).select('id').single();
      if (error) { showDbError(error, { action: 'menyimpan cabang', entity: 'Cabang' }); return; }
      newBranchId = data?.id || null;
    }

    this.closeModal('modal-branch');
    await this._refreshBranchesCache();
    await this.loadBranches();
    showToast('Cabang berhasil disimpan', 'success');
    window.RBNDataEvents?.publish('settings:changed', { source: 'admin' });

    // Offer copy menu for newly created branch
    if (newBranchId && this.branches.some(b => b.id !== newBranchId)) {
      const ok = await showConfirm({
        title:       'Copy menu dari cabang lain?',
        message:     `Cabang "${name}" baru saja dibuat. Ingin menyalin menu dari cabang lain sekarang?`,
        confirmText: 'Ya, Copy Menu',
        danger:      false,
      });
      if (ok) this.openCopyMenuModal(newBranchId);
    }
  },

  async deleteBranch(id, name) {
    const ok = await showConfirm({
      title:       `Hapus Cabang "${name}"?`,
      message:     'Cabang akan dinonaktifkan dan disembunyikan dari daftar aktif. Riwayat transaksi, log, dan laporan tetap tersimpan.',
      confirmText: 'Ya, Hapus',
      danger:      true,
    });
    if (!ok) return;
    const { error } = await db.from('branches')
      .update({
        is_active: false,
        deleted_at: new Date().toISOString()
      })
      .eq('id', id);
    if (error) { showDbError(error, { action: 'menghapus cabang', entity: 'Cabang' }); return; }

    await Promise.allSettled([
      db.from('branch_products').update({ is_active: false }).eq('branch_id', id),
      db.from('users').update({ branch_id: null }).eq('branch_id', id),
      db.from('investor_branch_access').delete().eq('branch_id', id),
      db.from('deposit_accounts').update({ is_active: false }).eq('branch_id', id)
    ]);

    await this._refreshBranchesCache();
    await this.loadBranches();
    showToast('Cabang dihapus dari daftar aktif', 'success');
  },

  // ── Copy Menu ────────────────────────────────────────────────────
  openCopyMenuModal(targetBranchId = null) {
    this.resetCopyMenuModal();
    const sourceEl  = document.getElementById('copy-menu-source-branch');
    const targetEl  = document.getElementById('copy-menu-target-branch');

    // Populate branch selects
    const opts = this.branches.map(b =>
      `<option value="${b.id}">${escHtml(b.name)}</option>`
    ).join('');
    sourceEl.innerHTML = '<option value="">— Pilih Cabang Sumber —</option>' + opts;

    if (targetBranchId) {
      // Opened from a specific branch card — target is locked
      targetEl.innerHTML = '';
      const b = this.branches.find(x => x.id === targetBranchId);
      targetEl.innerHTML = `<option value="${targetBranchId}">${escHtml(b ? b.name : targetBranchId)}</option>`;
      targetEl.disabled = true;
      // Remove the locked target from source options
      const lockedOpt = sourceEl.querySelector(`option[value="${targetBranchId}"]`);
      if (lockedOpt) lockedOpt.remove();
    } else {
      targetEl.innerHTML = '<option value="">— Pilih Cabang Tujuan —</option>' + opts;
      targetEl.disabled = false;
    }

    openModal('modal-copy-branch-menu');
    if (window.lucide) lucide.createIcons();
  },

  resetCopyMenuModal() {
    this._copyMenuPreview    = null;
    this._copyMenuSubmitting = false;
    const previewArea = document.getElementById('copy-menu-preview-area');
    if (previewArea) previewArea.innerHTML = '';
    const confirmBtn = document.getElementById('copy-menu-confirm-btn');
    if (confirmBtn) { confirmBtn.disabled = true; confirmBtn.textContent = 'Salin Menu'; }
    const previewBtn = document.getElementById('copy-menu-preview-btn');
    if (previewBtn) { previewBtn.disabled = false; previewBtn.innerHTML = '<i data-lucide="eye" class="icon-sm"></i> Preview'; }
    const targetEl = document.getElementById('copy-menu-target-branch');
    if (targetEl) targetEl.disabled = false;
    document.getElementById('copy-menu-mode-replace').checked = true;
  },

  async loadCopyMenuPreview() {
    const sourceId = Number(document.getElementById('copy-menu-source-branch').value);
    const targetId = Number(document.getElementById('copy-menu-target-branch').value);
    const mode     = document.querySelector('input[name="copy-menu-mode"]:checked')?.value || 'replace';
    const area     = document.getElementById('copy-menu-preview-area');
    const btn      = document.getElementById('copy-menu-preview-btn');
    const confirmBtn = document.getElementById('copy-menu-confirm-btn');

    if (!sourceId) { showToast('Cabang sumber wajib dipilih.', 'error'); return; }
    if (!targetId) { showToast('Cabang tujuan wajib dipilih.', 'error'); return; }
    if (sourceId === targetId) { showToast('Cabang sumber dan tujuan tidak boleh sama.', 'error'); return; }

    btn.disabled = true;
    btn.textContent = 'Memuat preview...';
    area.innerHTML  = '';
    confirmBtn.disabled = true;
    this._copyMenuPreview = null;

    try {
      const { data, error } = await db.rpc('admin_preview_branch_menu_copy', {
        p_source_branch_id: sourceId,
        p_target_branch_id: targetId,
        p_mode: mode,
      });
      if (error) throw error;
      this._copyMenuPreview = data;
      this.renderCopyMenuPreview(data, mode);
      confirmBtn.disabled = false;
      confirmBtn.innerHTML = '<i data-lucide="copy" class="icon-sm"></i> Salin Menu';
      if (window.lucide) lucide.createIcons();
    } catch (e) {
      area.innerHTML = `<div class="text-sm text-danger" style="padding:10px;border:1px solid var(--danger-soft);border-radius:var(--r-md)">${escHtml(e.message || 'Gagal memuat preview')}</div>`;
    } finally {
      btn.disabled = false;
      btn.innerHTML = '<i data-lucide="eye" class="icon-sm"></i> Preview';
      if (window.lucide) lucide.createIcons();
    }
  },

  renderCopyMenuPreview(p, mode) {
    const area = document.getElementById('copy-menu-preview-area');
    const warnHtml = (p.warnings && p.warnings.length)
      ? p.warnings.map(w => `<div class="text-sm text-warning" style="margin-top:8px;padding:8px 12px;background:var(--warning-soft,#fffbeb);border-radius:var(--r-sm);border:1px solid var(--warning,#f59e0b)">⚠ ${escHtml(w.message)}</div>`).join('')
      : '';

    const replaceWarning = (mode === 'replace' && p.target_active_products > 0)
      ? `<div class="text-sm" style="margin-top:8px;padding:10px 14px;background:#fff3cd;border-radius:var(--r-md);border:1px solid #f0c040;color:#856404">
           <strong>Perhatian:</strong> Menu aktif cabang tujuan (${p.target_active_products} produk) akan diganti. Transaksi lama tidak berubah. Lanjutkan?
         </div>`
      : '';

    area.innerHTML = `
      <div style="border:1px solid var(--border);border-radius:var(--r-md);overflow:hidden;margin-top:4px;">
        <table class="w-full text-sm">
          <tbody>
            <tr><td class="p-2 text-muted" style="width:50%;border-bottom:1px solid var(--border)">Cabang Sumber</td><td class="p-2" style="border-bottom:1px solid var(--border)"><strong>${escHtml(p.source_branch.name)}</strong></td></tr>
            <tr><td class="p-2 text-muted" style="border-bottom:1px solid var(--border)">Cabang Tujuan</td><td class="p-2" style="border-bottom:1px solid var(--border)"><strong>${escHtml(p.target_branch.name)}</strong></td></tr>
            <tr><td class="p-2 text-muted" style="border-bottom:1px solid var(--border)">Mode</td><td class="p-2" style="border-bottom:1px solid var(--border)"><span class="badge">${escHtml(mode)}</span></td></tr>
            <tr><td class="p-2 text-muted" style="border-bottom:1px solid var(--border)">Produk aktif sumber</td><td class="p-2" style="border-bottom:1px solid var(--border)">${p.source_active_products} produk</td></tr>
            <tr><td class="p-2 text-muted" style="border-bottom:1px solid var(--border)">Varian sumber</td><td class="p-2" style="border-bottom:1px solid var(--border)">${p.source_variants} varian</td></tr>
            <tr><td class="p-2 text-muted" style="border-bottom:1px solid var(--border)">Override harga sumber</td><td class="p-2" style="border-bottom:1px solid var(--border)">${p.source_overrides} override</td></tr>
            <tr><td class="p-2 text-muted" style="border-bottom:1px solid var(--border)">Produk aktif tujuan saat ini</td><td class="p-2" style="border-bottom:1px solid var(--border)">${p.target_active_products} produk</td></tr>
            <tr><td class="p-2 text-muted">Override harga tujuan saat ini</td><td class="p-2">${p.target_overrides} override</td></tr>
          </tbody>
        </table>
      </div>
      ${warnHtml}
      ${replaceWarning}
    `;
  },

  async confirmCopyMenu() {
    if (this._copyMenuSubmitting) return;
    const sourceId = Number(document.getElementById('copy-menu-source-branch').value);
    const targetId = Number(document.getElementById('copy-menu-target-branch').value);
    const mode     = document.querySelector('input[name="copy-menu-mode"]:checked')?.value || 'replace';

    if (!sourceId) { showToast('Cabang sumber wajib dipilih.', 'error'); return; }
    if (!targetId) { showToast('Cabang tujuan wajib dipilih.', 'error'); return; }
    if (sourceId === targetId) { showToast('Cabang sumber dan tujuan tidak boleh sama.', 'error'); return; }

    if (!this._copyMenuPreview) {
      showToast('Tekan Preview terlebih dahulu sebelum menyalin.', 'warning');
      return;
    }

    if (mode === 'replace' && this._copyMenuPreview.target_active_products > 0) {
      const targetName = this._copyMenuPreview.target_branch.name;
      const ok = await showConfirm({
        title:       `Ganti menu "${escHtml(targetName)}"?`,
        message:     `Menu aktif cabang tujuan (${this._copyMenuPreview.target_active_products} produk) akan diganti. Transaksi lama tidak berubah. Lanjutkan?`,
        confirmText: 'Ya, Ganti Menu',
        danger:      true,
      });
      if (!ok) return;
    }

    this._copyMenuSubmitting = true;
    const confirmBtn = document.getElementById('copy-menu-confirm-btn');
    const previewBtn = document.getElementById('copy-menu-preview-btn');
    if (confirmBtn) { confirmBtn.disabled = true; confirmBtn.textContent = 'Menyalin...'; }
    if (previewBtn) previewBtn.disabled = true;

    try {
      const { data, error } = await db.rpc('admin_copy_branch_menu', {
        p_source_branch_id: sourceId,
        p_target_branch_id: targetId,
        p_mode:    mode,
        p_admin_id: this.user.id,
      });
      if (error) throw error;

      const targetName = this._copyMenuPreview?.target_branch?.name || targetId;
      showToast(`Menu berhasil dicopy ke ${targetName}`, 'success');

      // Show summary
      const area = document.getElementById('copy-menu-preview-area');
      if (area && data) {
        area.innerHTML = `
          <div style="border:1px solid var(--success-soft,#d1fae5);border-radius:var(--r-md);overflow:hidden;background:var(--success-soft,#d1fae5);padding:12px 16px;">
            <div class="text-sm" style="font-weight:600;margin-bottom:8px;color:var(--success,#059669)">✓ Copy berhasil</div>
            <div class="text-sm text-muted">Produk diaktifkan: <strong>${data.products_activated}</strong></div>
            <div class="text-sm text-muted">Produk dinonaktifkan: <strong>${data.products_deactivated}</strong></div>
            <div class="text-sm text-muted">Override harga dihapus: <strong>${data.target_overrides_deleted}</strong></div>
            <div class="text-sm text-muted">Override harga disalin: <strong>${data.target_overrides_inserted}</strong></div>
            ${data.products_without_variants ? `<div class="text-sm text-warning">Produk tanpa varian: ${data.products_without_variants}</div>` : ''}
          </div>`;
      }

      this._copyMenuSubmitting = false;
      if (confirmBtn) { confirmBtn.disabled = true; confirmBtn.innerHTML = '<i data-lucide="check" class="icon-sm"></i> Selesai'; }
      await this.refreshAfterCopyMenu(targetId);
    } catch (e) {
      showToast('Copy menu gagal: ' + (e.message || 'Error tidak diketahui'), 'error');
      this._copyMenuSubmitting = false;
      if (confirmBtn) { confirmBtn.disabled = false; confirmBtn.innerHTML = '<i data-lucide="copy" class="icon-sm"></i> Salin Menu'; }
      if (previewBtn) previewBtn.disabled = false;
    }
  },

  async refreshAfterCopyMenu(targetBranchId) {
    await this.loadMasterData();
    if (this.currentSection === 'branches') this.loadBranches();
    if (this.currentSection === 'branch-pricing') {
      this.loadBranchPricing();
      // Sync the branch-pricing-filter select to targetBranchId if possible
      const filter = document.getElementById('branch-pricing-filter');
      if (filter && targetBranchId) {
        filter.value = String(targetBranchId);
        this.loadBranchPricing();
      }
    }
    if (window.lucide) lucide.createIcons();
  },

  // ── Branch Pricing ──────────────────────────────────────────────
  // ── Branch Pricing ──────────────────────────────────────────────
  async loadBranchPricing() {
    const branchId = document.getElementById('branch-pricing-filter')?.value;
    const tbody    = document.getElementById('branch-pricing-body');
    const hintEl   = document.getElementById('branch-pricing-hint');
    if (!tbody) return;

    const copyBtn = document.getElementById('branch-pricing-copy-btn');
    if (copyBtn) {
      copyBtn.style.display = branchId ? '' : 'none';
      if (branchId) copyBtn.dataset.targetId = branchId;
    }

    if (!branchId) {
      tbody.innerHTML = '<tr><td colspan="4" class="empty-td">Pilih cabang untuk melihat daftar harga</td></tr>';
      if (hintEl) hintEl.textContent = 'Pilih cabang untuk melihat dan mengatur harga';
      return;
    }

    tbody.innerHTML = '<tr><td colspan="4" class="empty-td">Memuat...</td></tr>';
    const branch = this.branches.find(b => b.id === parseInt(branchId));
    if (hintEl) hintEl.textContent = branch ? `Cabang: ${branch.name}` : '';

    try {
      // Fetch all variants with their product names
      const { data: variants, error: vErr } = await db
        .from('product_variants')
        .select('id, name, price, product_id, products(id, name)')
        .order('id');
      if (vErr) throw vErr;

      // Fetch existing overrides for this branch
      const { data: overrides, error: oErr } = await db
        .from('branch_variant_prices')
        .select('variant_id, price')
        .eq('branch_id', branchId);
      // If table doesn't exist yet, gracefully degrade
      if (oErr && /does not exist|relation.*not found/i.test(oErr.message)) {
        tbody.innerHTML = '<tr><td colspan="4" class="empty-td text-danger">Tabel branch_variant_prices belum ada. Jalankan schema_v6.sql terlebih dahulu.</td></tr>';
        return;
      }
      if (oErr) throw oErr;

      const overrideMap = {};
      (overrides || []).forEach(o => { overrideMap[o.variant_id] = parseFloat(o.price); });

      if (!variants?.length) {
        tbody.innerHTML = '<tr><td colspan="4" class="empty-td">Belum ada varian produk</td></tr>';
        return;
      }

      // Group variants by product
      const productsMap = {};
      variants.forEach(v => {
        const pId = v.product_id;
        if (!productsMap[pId]) {
          productsMap[pId] = { id: pId, name: v.products?.name || 'Unknown', variants: [], overrideCount: 0 };
        }
        productsMap[pId].variants.push(v);
        if (overrideMap[v.id] !== undefined) productsMap[pId].overrideCount++;
      });

      const productRows = Object.values(productsMap).map(p => {
        return `
          <tr>
            <td class="fw-700">📦 ${escHtml(p.name)}</td>
            <td style="text-align:center">${p.variants.length}</td>
            <td style="text-align:center">
              ${p.overrideCount > 0 
                ? `<span class="badge badge-orange">${p.overrideCount} Override</span>` 
                : `<span class="text-muted text-sm">Semua Default</span>`}
            </td>
            <td style="text-align:center">
              <button class="btn btn-outline btn-sm"
                data-admin-action="open-branch-product-price-modal"
                data-product-id="${p.id}"
                data-product-name="${escHtml(p.name)}">Atur Harga</button>
            </td>
          </tr>
        `;
      }).join('');

      tbody.innerHTML = productRows;
    } catch (e) {
      tbody.innerHTML = `<tr><td colspan="4" class="empty-td text-danger">Gagal memuat: ${escHtml(e.message)}</td></tr>`;
      showToast('Gagal memuat data harga cabang: ' + e.message, 'error');
    }
  },

  async openBranchProductPriceModal(productId, productName) {
    const branchId = document.getElementById('branch-pricing-filter')?.value;
    if (!branchId) { showToast('Pilih cabang terlebih dahulu', 'warning'); return; }

    document.getElementById('bprice-branch-id').value   = branchId;
    document.getElementById('bprice-product-id').value  = productId;
    
    const branch = this.branches.find(b => b.id === parseInt(branchId));
    document.getElementById('bprice-product-name-label').textContent = `${productName} di cabang ${branch?.name || ''}`;

    const tbody = document.getElementById('bprice-variants-body');
    tbody.innerHTML = '<tr><td colspan="3" class="text-center p-4">Memuat varian...</td></tr>';
    
    openModal('modal-branch-product-price');

    try {
      const { data: variants, error: vErr } = await db
        .from('product_variants')
        .select('id, name, price')
        .eq('product_id', productId)
        .order('id');
      if (vErr) throw vErr;

      const { data: overrides, error: oErr } = await db
        .from('branch_variant_prices')
        .select('variant_id, price')
        .eq('branch_id', branchId);
      if (oErr && !/does not exist|relation.*not found/i.test(oErr.message)) throw oErr;

      const overrideMap = {};
      (overrides || []).forEach(o => { overrideMap[o.variant_id] = parseFloat(o.price); });

      if (!variants?.length) {
        tbody.innerHTML = '<tr><td colspan="3" class="text-center p-4">Produk ini tidak memiliki varian.</td></tr>';
        return;
      }

      tbody.innerHTML = variants.map(v => {
        const defaultPrice = parseFloat(v.price || 0);
        const override = overrideMap[v.id];
        const val = override !== undefined ? override : '';
        return `
          <tr>
            <td class="fw-600">${escHtml(v.name)}</td>
            <td style="text-align:right" class="text-muted">${fRp(defaultPrice)}</td>
            <td>
              <input type="number" class="form-control bprice-input w-full" 
                data-variant-id="${v.id}" 
                placeholder="Kosongkan = default" 
                min="0" 
                value="${val}" />
            </td>
          </tr>
        `;
      }).join('');
    } catch (e) {
      tbody.innerHTML = `<tr><td colspan="3" class="text-center text-danger p-4">Gagal memuat: ${escHtml(e.message)}</td></tr>`;
    }
  },

  async saveBranchProductPrice() {
    const branchId  = parseInt(document.getElementById('bprice-branch-id').value);
    const productId = parseInt(document.getElementById('bprice-product-id').value);
    if (!branchId || !productId) return;

    const btn = document.querySelector('#modal-branch-product-price .btn-primary');
    if (btn) { btn.disabled = true; btn.textContent = 'Menyimpan...'; }

    try {
      const inputs = document.querySelectorAll('#bprice-variants-body .bprice-input');
      const upserts = [];
      const deletes = [];

      inputs.forEach(input => {
        const vId = parseInt(input.dataset.variantId);
        const valStr = input.value.trim();
        if (valStr === '') {
          deletes.push(vId);
        } else {
          const price = parseFloat(valStr);
          if (!isNaN(price) && price >= 0) {
            upserts.push({ branch_id: branchId, variant_id: vId, price, updated_at: new Date().toISOString() });
          }
        }
      });

      // Execute deletes for cleared inputs
      if (deletes.length > 0) {
        const { error: dErr } = await db.from('branch_variant_prices')
          .delete()
          .eq('branch_id', branchId)
          .in('variant_id', deletes);
        if (dErr) throw dErr;
      }

      // Execute upserts for filled inputs
      if (upserts.length > 0) {
        const { error: uErr } = await db.from('branch_variant_prices')
          .upsert(upserts, { onConflict: 'branch_id,variant_id' });
        if (uErr) throw uErr;
      }

      closeModal('modal-branch-product-price');
      await this.loadBranchPricing();
      showToast('Harga cabang berhasil disimpan', 'success');
    } catch (e) {
      showToast('Gagal menyimpan: ' + e.message, 'error');
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = 'Simpan Semua'; }
    }
  },

  // ── Products ─────────────────────────────────────────────────
  async loadProducts() {
    const { data } = await db.from('products')
      .select('*, product_variants(id, name, price)')
      .order('created_at', { ascending: false });

    this._allProducts = data || [];

    // Populate category filter
    const cats = [...new Set((data || []).map(p => p.category).filter(Boolean))].sort();
    const catSel = document.getElementById('product-category-filter');
    if (catSel) {
      catSel.innerHTML = '<option value="">Semua Kategori</option>'
        + cats.map(c => `<option value="${escHtml(c)}">${escHtml(c)}</option>`).join('');
    }

    this._renderProductGrid();
    if (window.lucide) lucide.createIcons();
  },

  _renderProductGrid() {
    const container = document.getElementById('products-grid-container');
    if (!container) return;

    const query   = (document.getElementById('product-search-input')?.value || '').toLowerCase().trim();
    const catFilt = document.getElementById('product-category-filter')?.value || '';

    const filtered = this._allProducts.filter(p => {
      const matchName = !query || p.name.toLowerCase().includes(query);
      const matchCat  = !catFilt || p.category === catFilt;
      return matchName && matchCat;
    });

    if (!filtered.length) {
      container.innerHTML = `<div class="empty-state">
        <div class="empty-icon"><i data-lucide="search-x" class="icon"></i></div>
        <div class="empty-title">${query ? `Produk "${escHtml(query)}" tidak ditemukan` : 'Belum ada produk'}</div>
        ${!query ? '<div class="empty-desc">Tambahkan produk pertama untuk mulai berjualan</div>' : ''}
      </div>`;
      if (window.lucide) lucide.createIcons();
      return;
    }

    container.innerHTML = `<div class="product-admin-grid">${filtered.map(p => {
      const variantCount = p.product_variants?.length || 0;
      const isSimple = p.has_variants === false;
      const priceLine = isSimple
        ? `<div class="text-xs text-muted mt-1">Harga: ${fRp ? fRp(p.default_price || 0) : (p.default_price || 0).toLocaleString('id-ID', {style:'currency',currency:'IDR',maximumFractionDigits:0})}</div>`
        : `<div class="text-xs text-muted mt-1">${variantCount} varian</div>`;
      return `<div class="product-admin-card">
        <div class="product-admin-img">
          ${p.image_url ? `<img loading="lazy" src="${escHtml(p.image_url)}" alt="${escHtml(p.name)}" class="img-cover" onerror="this.outerHTML='<div class=&quot;product-img-placeholder&quot;><i data-lucide=&quot;package&quot; class=&quot;icon-xl&quot;></i></div>'; if(window.lucide) lucide.createIcons();" />` : '<i data-lucide="package" class="icon-xl"></i>'}
        </div>
        <div class="product-admin-body">
          <div class="product-admin-name">${escHtml(p.name)}</div>
          ${p.category ? `<span class="badge badge-orange mt-1">${escHtml(p.category)}</span>` : ''}
          ${priceLine}
        </div>
        <div class="product-admin-footer">
          <button class="btn btn-outline btn-sm" data-admin-action="open-product-modal" data-id="${p.id}">Edit</button>
          <button class="btn btn-danger-soft btn-sm" data-admin-action="delete-product" data-id="${p.id}" data-name="${escHtml(p.name)}">Hapus</button>
        </div>
      </div>`;
    }).join('')}</div>`;

    if (window.lucide) lucide.createIcons();
  },


  previewImage(input) {
    if (!input.files?.[0]) return;
    const file = input.files[0];
    if (file.size > 1024*1024) { showToast('Ukuran gambar maks 1 MB', 'error'); input.value=''; return; }
    const reader = new FileReader();
    reader.onload = e => {
      const img = document.getElementById('img-preview');
      img.src = e.target.result;
      img.classList.remove('hidden');
      img.style.display = 'block';
      document.getElementById('upload-placeholder').style.display  = 'none';
      document.getElementById('product-image-url').value   = e.target.result;
    };
    reader.readAsDataURL(file);
  },

  previewImageUrl(url) {
    if (!url) return;
    const img = document.getElementById('img-preview');
    img.src = url;
    img.classList.remove('hidden');
    img.style.display = 'block';
    document.getElementById('upload-placeholder').style.display  = 'none';
  },

  async saveProduct() {
    const id        = document.getElementById('product-id').value;
    const name      = document.getElementById('product-name').value.trim();
    const category  = document.getElementById('product-category').value.trim();
    const fileInput = document.getElementById('product-image-file');
    let   imageUrl  = document.getElementById('product-image-url').value.trim();
    if (!name) { showToast('Nama produk wajib diisi', 'error'); return; }

    const isSimple     = document.querySelector('input[name="product-type"]:checked')?.value === 'simple';
    const defaultPrice = isSimple ? (parseFloat(document.getElementById('product-default-price').value) || 0) : null;

    if (isSimple && defaultPrice < 0) { showToast('Harga tidak boleh negatif', 'error'); return; }

    // For new variant products: validate pending variants (at least 1 required)
    if (!id && !isSimple) {
      const valid = this._pendingVariants.filter(v => v.name?.trim() && v.price !== '' && !isNaN(parseFloat(v.price)) && parseFloat(v.price) >= 0);
      if (!valid.length) { showToast('Tambahkan minimal 1 varian dengan nama dan harga', 'error'); return; }
    }

    if (fileInput.files?.[0]) {
      const file = fileInput.files[0];
      try {
        const fd = new FormData();
        fd.append('file', file);
        fd.append('folder', 'products');
        const UPLOAD_URL = API_BASE.replace('/api.php', '/upload.php');
        const upRes  = await fetch(UPLOAD_URL, { method: 'POST', headers: { 'X-API-Key': API_KEY }, body: fd });
        const upJson = await upRes.json();
        if (upJson.success && upJson.url) {
          imageUrl = upJson.url;
          document.getElementById('product-image-url').value = imageUrl;
        } else {
          showToast('Upload gambar gagal: ' + (upJson.error || 'Unknown error'), 'error');
        }
      } catch (upErr) {
        showToast('Upload gambar gagal: ' + upErr.message, 'error');
      }
    }

    const payload = { name, category, image_url: imageUrl || null, has_variants: !isSimple, default_price: isSimple ? defaultPrice : null };
    let savedId = parseInt(id) || null;

    if (id) {
      const { error } = await db.from('products').update(payload).eq('id', id);
      if (error) { showDbError(error, { action: 'menyimpan produk', entity: 'Produk' }); return; }
    } else {
      // Insert product
      const { data: inserted, error } = await db.from('products').insert(payload).select().single();
      if (error) { showDbError(error, { action: 'menyimpan produk', entity: 'Produk' }); return; }
      savedId = inserted.id;
      document.getElementById('product-id').value = savedId;
      document.getElementById('product-modal-title').textContent = 'Edit Produk';

      if (isSimple) {
        // Insert single hidden variant so RPC process_transaction stays compatible
        const { error: vErr } = await db.from('product_variants').insert({
          product_id: savedId, name, price: defaultPrice, is_default: true
        });
        if (vErr) showToast('Produk tersimpan, tetapi varian belum tersimpan. Periksa varian produk lalu simpan ulang.', 'warning');
      } else {
        // Bulk insert pending variants
        const variantRows = this._pendingVariants
          .filter(v => v.name?.trim() && !isNaN(parseFloat(v.price)) && parseFloat(v.price) >= 0)
          .map(v => ({ product_id: savedId, name: v.name.trim(), price: parseFloat(v.price) }));
        if (variantRows.length) {
          const { error: vErr } = await db.from('product_variants').insert(variantRows);
          if (vErr) { showToast('Produk tersimpan, tetapi sebagian varian belum tersimpan. Periksa varian produk lalu simpan ulang.', 'warning'); }
        }
        this._pendingVariants = [];
      }
    }

    // Sync branch_products
    const checkedBranches = Array.from(document.querySelectorAll('.product-branch-cb:checked')).map(cb => parseInt(cb.value));
    await db.from('branch_products').update({ is_active: false }).eq('product_id', savedId);
    
    for (const bId of checkedBranches) {
      const { data: existing } = await db.from('branch_products').select('id').eq('branch_id', bId).eq('product_id', savedId).maybeSingle();
      if (existing) {
        await db.from('branch_products').update({ is_active: true }).eq('id', existing.id);
      } else {
        await db.from('branch_products').insert({ branch_id: bId, product_id: savedId, is_active: true });
      }
    }

    this.closeModal('modal-product');
    await this._refreshProductsCache();
    await this.loadProducts();
    showToast('Produk berhasil disimpan', 'success');
    window.RBNDataEvents?.publish('products:changed', { source: 'admin' });
    if (savedId) await this.loadProductModalVariants(savedId);
  },

  async deleteProduct(id, name) {
    const ok = await showConfirm({
      title:       `Hapus Produk "${name}"?`,
      message:     'Produk ini akan dihapus permanen.',
      confirmText: 'Ya, Hapus',
      danger:      true,
    });
    if (!ok) return;
    const { error } = await db.from('products').delete().eq('id', id);
    if (error) { showDbError(error, { action: 'menghapus produk', entity: 'Produk' }); return; }
    await this._refreshProductsCache();
    await this.loadProducts();
    showToast('Produk dihapus', 'success');
    window.RBNDataEvents?.publish('products:changed', { source: 'admin' });
  },

  // ── Product Categories ───────────────────────────────────────
  async loadProductCategories() {
    const list = document.getElementById('product-categories-list');
    if (!list) return;
    await this._refreshCategoriesCache();
    const data = this.productCategories || [];
    list.innerHTML = data.length ? `<div class="admin-list">${data.map(c => `
      <div class="admin-list-card">
        <div class="list-card-icon blue"><i data-lucide="tags" class="icon"></i></div>
        <div class="list-card-info">
          <div class="list-card-title">${escHtml(c.name)}</div>
        </div>
        <div class="list-card-actions">
          <button class="btn btn-outline btn-sm" data-admin-action="open-product-category-modal" data-id="${c.id}" data-name="${escHtml(c.name)}">Edit</button>
          <button class="btn btn-danger-soft btn-sm" data-admin-action="delete-product-category" data-id="${c.id}" data-name="${escHtml(c.name)}">Hapus</button>
        </div>
      </div>`).join('')}</div>`
    : `<div class="empty-state"><div class="empty-icon"><i data-lucide="tags" class="icon"></i></div><div class="empty-title">Belum ada kategori</div><div class="empty-cta"><button class="btn btn-primary" data-admin-action="open-product-category-modal">+ Tambah Kategori</button></div></div>`;
    if (window.lucide) lucide.createIcons();
  },

  openProductCategoryModal(id = null, name = '') {
    document.getElementById('product-category-id').value = id || '';
    document.getElementById('product-category-name').value = name || '';
    document.getElementById('product-category-modal-title').textContent = id ? 'Edit Kategori Produk' : 'Tambah Kategori Produk';
    openModal('modal-product-category');
  },

  async saveProductCategory() {
    const id = document.getElementById('product-category-id').value;
    const name = document.getElementById('product-category-name').value.trim();
    if (!name) { showToast('Nama kategori wajib diisi', 'error'); return; }

    const payload = { name };
    try {
      const { error } = id
        ? await db.from('product_categories').update(payload).eq('id', id)
        : await db.from('product_categories').insert(payload);
      if (error) {
        // Detect missing table — give actionable guidance
        const msg = error.message || '';
        if (msg.includes('product_categories') && (msg.includes('schema cache') || msg.includes('does not exist') || msg.includes('relation'))) {
          showToast('Tabel product_categories belum ada. Import cpanel_mysql_schema.sql via phpMyAdmin terlebih dahulu.', 'error');
        } else {
          showDbError(error, { action: 'menyimpan kategori produk', entity: 'Kategori produk' });
        }
        return;
      }
    } catch (e) {
      showDbError(e, { action: 'menyimpan kategori produk', entity: 'Kategori produk' });
      return;
    }
    closeModal('modal-product-category');
    await this._refreshCategoriesCache();
    await this.loadProductCategories();
    showToast('Kategori produk disimpan', 'success');
  },

  async deleteProductCategory(id, name) {
    const ok = await showConfirm({
      title:       `Hapus Kategori "${name}"?`,
      message:     'Kategori ini akan dihapus permanen. Produk dengan kategori ini tidak akan terhapus, namun tidak akan memiliki kategori.',
      confirmText: 'Ya, Hapus',
      danger:      true,
    });
    if (!ok) return;
    try {
      const { error } = await db.from('product_categories').delete().eq('id', id);
      if (error) { showDbError(error, { action: 'menghapus kategori produk', entity: 'Kategori produk' }); return; }
    } catch (e) {
      showDbError(e, { action: 'menghapus kategori produk', entity: 'Kategori produk' });
      return;
    }
    await this._refreshCategoriesCache();
    await this.loadProductCategories();
    showToast('Kategori dihapus', 'success');
  },

  // ── Variants ─────────────────────────────────────────────────
  async loadVariants() {
    const productId = document.getElementById('variant-product-filter').value;
    const tbody     = document.getElementById('variants-body');

    let q = db.from('product_variants').select('*, products(name)').order('name');
    if (productId) q = q.eq('product_id', productId);

    const { data, error } = await q;
    if (error) { showToast('Gagal memuat varian: ' + error.message, 'error'); return; }
    tbody.innerHTML = data?.length ? data.map((v, i) => `
      <tr>
        <td>${i+1}</td>
        <td>${escHtml(v.products?.name||'—')}</td>
        <td class="fw-600">${escHtml(v.name)}</td>
        <td class="fw-700 text-orange">${fRp(v.price)}</td>
        <td>
          <button class="btn btn-outline btn-sm" data-admin-action="open-variant-modal" data-id="${v.id}">Edit</button>
          <button class="btn btn-sm btn-danger" data-admin-action="delete-variant" data-id="${v.id}" data-name="${escHtml(v.name)}">Hapus</button>
        </td>
      </tr>`).join('')
    : `<tr><td colspan="5" class="empty-td">Belum ada varian</td></tr>`;
  },

  async openVariantModal(id = null) {
    document.getElementById('variant-id').value    = id || '';
    document.getElementById('variant-name').value  = '';
    document.getElementById('variant-price').value = '';
    document.getElementById('variant-modal-title').textContent = id ? 'Edit Varian' : 'Tambah Varian';
    setSelect('variant-product-id', this.products.map(p => `<option value="${p.id}">${escHtml(p.name)}</option>`).join(''));
    if (id) {
      const { data: v } = await db.from('product_variants').select('*').eq('id', id).maybeSingle();
      if (v) {
        document.getElementById('variant-name').value      = v.name;
        document.getElementById('variant-price').value     = v.price;
        document.getElementById('variant-product-id').value = v.product_id;
      }
    } else {
      const sel = document.getElementById('variant-product-filter').value;
      if (sel) document.getElementById('variant-product-id').value = sel;
    }
    openModal('modal-variant');
  },

  async saveVariant() {
    const id        = document.getElementById('variant-id').value;
    const productId = document.getElementById('variant-product-id').value;
    const name      = document.getElementById('variant-name').value.trim();
    const price     = parseFloat(document.getElementById('variant-price').value);
    if (!productId || !name || isNaN(price) || price < 0) { showToast('Lengkapi semua field', 'error'); return; }
    const payload = { product_id: productId, name, price };
    const { error } = id
      ? await db.from('product_variants').update(payload).eq('id', id)
      : await db.from('product_variants').insert(payload);
    if (error) { showDbError(error, { action: 'menyimpan varian', entity: 'Varian' }); return; }
    this.closeModal('modal-variant');
    await this.loadVariants();
    showToast('Varian berhasil disimpan', 'success');
  },

  async deleteVariant(id, name) {
    const ok = await showConfirm({
      title:       `Hapus Varian "${name}"?`,
      message:     'Varian ini akan dihapus permanen.',
      confirmText: 'Ya, Hapus',
      danger:      true,
    });
    if (!ok) return;
    const { error } = await db.from('product_variants').delete().eq('id', id);
    if (error) { showDbError(error, { action: 'menghapus varian', entity: 'Varian' }); return; }
    await this.loadVariants();
    showToast('Varian dihapus', 'success');
  },


  // ── Recipes ───────────────────────────────────────────────────
  async loadRecipeVariants() {
    const productId = document.getElementById('recipe-product-filter').value;
    if (!productId) { setSelect('recipe-variant-filter', '<option value="">Pilih Varian</option>'); return; }
    const { data } = await db.from('product_variants').select('id, name').eq('product_id', productId).order('name');
    setSelect('recipe-variant-filter', `<option value="">Pilih Varian</option>${(data||[]).map(v=>`<option value="${v.id}">${escHtml(v.name)}</option>`).join('')}`);
  },

  async loadRecipeItems() {
    const variantId = document.getElementById('recipe-variant-filter').value;
    const tbody     = document.getElementById('recipe-items-body');
    const titleEl   = document.getElementById('recipe-card-title');
    if (!variantId) { tbody.innerHTML = `<tr><td colspan="5" class="empty-td">Pilih varian di atas</td></tr>`; return; }

    const vName = document.getElementById('recipe-variant-filter').selectedOptions[0]?.text || 'Varian';
    let { data: recipe } = await db.from('recipes').select('id, name').eq('variant_id', variantId).maybeSingle();
    if (!recipe) {
      // Jangan auto-create — tampilkan empty state dengan tombol buat resep
      titleEl.textContent = `Resep: ${vName}`;
      tbody.innerHTML = `<tr><td colspan="5" class="empty-td">
        Belum ada resep untuk varian ini.
        <br><br>
        <button class="btn btn-primary btn-sm" data-admin-action="create-recipe" data-variant-id="${variantId}" data-variant-name="${escHtml(vName)}">+ Buat Resep</button>
      </td></tr>`;
      return;
    }
    titleEl.textContent = `Resep: ${vName}`;

    const { data: items } = await db.from('recipe_items').select('id, quantity, ingredients(id, name, unit)').eq('recipe_id', recipe.id).order('id');
    tbody.innerHTML = items?.length ? items.map((item, i) => `
      <tr>
        <td>${i+1}</td>
        <td class="fw-600">${escHtml(item.ingredients?.name||'—')}</td>
        <td>${escHtml(item.ingredients?.unit||'—')}</td>
        <td>${item.quantity}</td>
        <td>
          <button class="btn btn-outline btn-sm" data-admin-action="open-recipe-item-modal" data-id="${item.id}">Edit</button>
          <button class="btn btn-sm btn-danger" data-admin-action="delete-recipe-item" data-id="${item.id}">Hapus</button>
        </td>
      </tr>`).join('')
    : `<tr><td colspan="5" class="empty-td">Belum ada bahan. Tambahkan bahan resep.</td></tr>`;
  },

  async createRecipe(variantId, variantName) {
    const { data: nr, error } = await db.from('recipes').insert({ variant_id: variantId, name: variantName }).select().single();
    if (error) { showDbError(error, { action: 'membuat resep', entity: 'Resep' }); return; }
    await this.loadRecipeItems();
    showToast('Resep berhasil dibuat', 'success');
  },

  async openRecipeItemModal(id = null) {
    const variantId = document.getElementById('recipe-variant-filter').value;
    if (!variantId && !id) { showToast('Pilih varian terlebih dahulu', 'warning'); return; }
    document.getElementById('recipe-item-id').value  = id || '';
    document.getElementById('recipe-item-qty').value = '';
    document.getElementById('recipe-item-modal-title').textContent = id ? 'Edit Bahan' : 'Tambah Bahan';
    setSelect('recipe-ingredient-id', this.ingredients.map(i=>`<option value="${i.id}">${escHtml(i.name)} (${escHtml(i.unit)})</option>`).join(''));
    if (id) {
      const { data } = await db.from('recipe_items').select('*').eq('id', id).maybeSingle();
      if (data) { document.getElementById('recipe-ingredient-id').value = data.ingredient_id; document.getElementById('recipe-item-qty').value = data.quantity; }
    }
    openModal('modal-recipe-item');
  },

  async saveRecipeItem() {
    const id           = document.getElementById('recipe-item-id').value;
    const variantId    = document.getElementById('recipe-variant-filter').value;
    const ingredientId = document.getElementById('recipe-ingredient-id').value;
    const qty          = parseFloat(document.getElementById('recipe-item-qty').value);
    if (!ingredientId || isNaN(qty) || qty <= 0) { showToast('Lengkapi semua field', 'error'); return; }

    if (id) {
      const { error } = await db.from('recipe_items').update({ ingredient_id: ingredientId, quantity: qty }).eq('id', id);
      if (error) { showDbError(error, { action: 'menyimpan bahan resep', entity: 'Bahan resep' }); return; }
    } else {
      let { data: recipe } = await db.from('recipes').select('id').eq('variant_id', variantId).maybeSingle();
      if (!recipe) {
        const { data: nr } = await db.from('recipes').insert({ variant_id: variantId }).select().single();
        recipe = nr;
      }
      const { error } = await db.from('recipe_items').insert({ recipe_id: recipe.id, ingredient_id: ingredientId, quantity: qty });
      if (error) { showDbError(error, { action: 'menyimpan bahan resep', entity: 'Bahan resep' }); return; }
    }
    this.closeModal('modal-recipe-item');
    await this.loadRecipeItems();
    showToast('Bahan resep disimpan', 'success');
    window.RBNDataEvents?.publish('recipes:changed', { source: 'admin' });
  },

  async deleteRecipeItem(id) {
    const ok = await showConfirm({
      title:       'Hapus Bahan Ini?',
      message:     'Bahan resep ini akan dihapus.',
      confirmText: 'Ya, Hapus',
      danger:      true,
    });
    if (!ok) return;
    // BUG-C4 FIX: cek error dari delete
    const { error } = await db.from('recipe_items').delete().eq('id', id);
    if (error) { showDbError(error, { action: 'menghapus bahan resep', entity: 'Bahan resep' }); return; }
    await this.loadRecipeItems();
    showToast('Bahan dihapus', 'success');
  },

  // ── Ingredients ───────────────────────────────────────────────
  openIngredientModal() {
    document.getElementById('ing-id').value        = '';
    document.getElementById('ing-name').value      = '';
    document.getElementById('ing-unit').value      = '';
    document.getElementById('ing-cost-price').value = '';
    document.getElementById('ing-modal-title').textContent = 'Tambah Bahan';
    this._renderIngBranchCheckboxes([]);
    openModal('modal-ingredient');
  },

  async openEditIngredientModal(id) {
    const ing = this.ingredients.find(i => i.id === id);
    if (!ing) return;
    document.getElementById('ing-id').value         = ing.id;
    document.getElementById('ing-name').value       = ing.name;
    document.getElementById('ing-unit').value       = ing.unit;
    document.getElementById('ing-cost-price').value = ing.cost_price || '';
    document.getElementById('ing-modal-title').textContent = 'Edit Bahan';

    try {
      const { data: assignments } = await db
        .from('branch_ingredient_assignments')
        .select('branch_id')
        .eq('ingredient_id', id);
      const assignedIds = (assignments || []).map(a => a.branch_id);
      this._renderIngBranchCheckboxes(assignedIds);
    } catch { this._renderIngBranchCheckboxes([]); }

    openModal('modal-ingredient');
  },

  _renderIngBranchCheckboxes(assignedIds) {
    const container = document.getElementById('ing-branch-checkboxes');
    if (!container) return;
    container.innerHTML = this.branches.map(b => `
      <label class="flex items-center gap-2 cursor-pointer p-2 hover:bg-alt rounded transition-colors">
        <input type="checkbox" class="ing-branch-cb" value="${b.id}" ${assignedIds.includes(b.id) ? 'checked' : ''} />
        <span>${escHtml(b.name)}</span>
      </label>`).join('');
  },

  // BUG-11 FIX: Only show products that actually use this ingredient via recipe_items
  async openIngredientProductsModal(id) {
    const ing = this.ingredients.find(i => i.id === id) || {};
    const body = document.getElementById('ingredient-products-body');
    if (!body) {
      console.warn('Ingredient products modal body not found');
      return;
    }
    body.innerHTML = '<div class="p-4 text-muted text-center">Memuat...</div>';
    openModal('modal-ingredient-products');

    try {
      const { data: recipeItems } = await db
        .from('recipe_items')
        .select('recipes(product_variants(products(id, name)))')
        .eq('ingredient_id', id);

      const productSet = new Map();
      (recipeItems || []).forEach(ri => {
        const p = ri.recipes?.product_variants?.products;
        if (p) productSet.set(p.id, p.name);
      });

      body.innerHTML = productSet.size
        ? [...productSet.entries()].map(([pid, pname]) => `
            <div class="admin-list-card flex items-center justify-between p-3 border-b">
              <div class="fw-700">${escHtml(pname)}</div>
              <button class="btn btn-outline btn-sm" data-admin-action="open-product-modal" data-id="${pid}">Edit</button>
            </div>`).join('')
        : `<div class="p-4 text-muted">Bahan ini belum digunakan di resep manapun</div>`;
    } catch (e) {
      body.innerHTML = `<div class="p-4 text-danger">Gagal memuat: ${escHtml(e.message)}</div>`;
    }

    document.getElementById('ingredient-products-modal-title').textContent =
      `Produk yang menggunakan: ${escHtml(ing.name || '')}`;
  },

  async saveIngredient() {
    const id        = document.getElementById('ing-id').value;
    const name      = document.getElementById('ing-name').value.trim();
    const unit      = document.getElementById('ing-unit').value.trim();
    const costPrice = parseFloat(document.getElementById('ing-cost-price').value) || 0;
    if (!name || !unit) { showToast('Nama dan satuan wajib diisi', 'error'); return; }

    const payload = { name, unit, cost_price: costPrice };
    let savedId = id ? parseInt(id) : null;

    if (id) {
      const { error } = await db.from('ingredients').update(payload).eq('id', id);
      if (error) { showDbError(error, { action: 'menyimpan bahan', entity: 'Bahan baku' }); return; }
    } else {
      const { data, error } = await db.from('ingredients').insert(payload).select('id').single();
      if (error) { showDbError(error, { action: 'menyimpan bahan', entity: 'Bahan baku' }); return; }
      savedId = data.id;
    }

    // Simpan mapping cabang (non-fatal jika tabel belum ada)
    try {
      const checkedIds = [...document.querySelectorAll('.ing-branch-cb:checked')].map(cb => parseInt(cb.value));
      await db.from('branch_ingredient_assignments').delete().eq('ingredient_id', savedId);
      if (checkedIds.length > 0) {
        await db.from('branch_ingredient_assignments').insert(
          checkedIds.map(bid => ({ branch_id: bid, ingredient_id: savedId }))
        );
      }
    } catch { /* tabel belum ada, mapping dilewati */ }

    this.closeModal('modal-ingredient');
    await this._refreshIngredientsCache();
    if (this.currentSection === 'ingredients') await this.loadIngredients();
    else await this.loadInventory();
    showToast('Bahan berhasil disimpan', 'success');
  },

  // ── Inventory ─────────────────────────────────────────────────
  async loadInventory() {
    const branchId = document.getElementById('inv-branch-filter').value;
    const grid     = document.getElementById('inv-grid');
    if (!branchId) { grid.innerHTML = '<div class="empty-state"><div class="empty-icon"><i data-lucide="package" class="icon"></i></div><div class="empty-title">Pilih cabang untuk melihat stok</div></div>'; lucide.createIcons(); return; }

    const { data: inv } = await db.from('branch_inventory')
      .select('stock, updated_at, ingredients(id, name, unit)')
      .eq('branch_id', branchId);

    const invMap = {};
    (inv||[]).forEach(i => { if (i.ingredients) invMap[i.ingredients.id] = i; });

    // Load branch assignments (non-fatal jika tabel belum ada)
    const assignMap = {};
    try {
      const { data: assignRows } = await db.from('branch_ingredient_assignments').select('ingredient_id, branch_id');
      for (const a of (assignRows || [])) {
        if (!assignMap[a.ingredient_id]) assignMap[a.ingredient_id] = new Set();
        assignMap[a.ingredient_id].add(a.branch_id);
      }
    } catch { /* tabel belum ada, tampilkan semua */ }
    const bidNum = parseInt(branchId);

    const ingredientsInBranch = this.ingredients.filter(ing => {
      // Jika ada mapping khusus tapi cabang ini tidak termasuk → skip
      const assigned = assignMap[ing.id];
      if (assigned && !assigned.has(bidNum)) return false;
      return invMap[ing.id] !== undefined;
    });
    grid.innerHTML = ingredientsInBranch.length
      ? ingredientsInBranch.map(ing => {
          const record  = invMap[ing.id];
          const stock   = record ? parseFloat(record.stock) : 0;
          const level   = stock < 5 ? 'low' : 'good';
          const updated = record ? fDate(record.updated_at) : 'Belum ada';
          return `<div class="inv-card">
            <div class="inv-name">${escHtml(ing.name)}</div>
            <div class="inv-unit">${escHtml(ing.unit)}</div>
            <div class="inv-stock ${level}">${stock.toLocaleString('id-ID')} ${escHtml(ing.unit)}</div>
            <div class="text-xs text-muted">Update: ${updated}</div>
            <div class="flex gap-1 mt-2 flex-wrap">
              <button class="btn btn-outline btn-sm" data-admin-action="open-edit-ingredient-modal" data-id="${ing.id}">Edit</button>
            </div>
          </div>`;
        }).join('')
      : '<div class="empty-state"><div class="empty-icon"><i data-lucide="package" class="icon"></i></div><div class="empty-title">Belum ada bahan di cabang ini</div></div>';
  },

  openInventoryModal(type = 'stock_in') {
    document.getElementById('inv-adj-qty').value   = '';
    document.getElementById('inv-adj-notes').value = '';
    document.getElementById('inv-adj-type').value  = type;
    setSelect('inv-adj-branch-id', this.branches.map(b=>`<option value="${b.id}">${escHtml(b.name)}</option>`).join(''));
    setSelect('inv-adj-ingredient-id', this.ingredients.map(i=>`<option value="${i.id}">${escHtml(i.name)} (${escHtml(i.unit)})</option>`).join(''));
    const currentBranch = document.getElementById('inv-branch-filter').value;
    if (currentBranch) document.getElementById('inv-adj-branch-id').value = currentBranch;
    this.toggleInventoryModalType();
    openModal('modal-inventory');
  },

  toggleInventoryModalType() {
    const type    = document.getElementById('inv-adj-type').value;
    const labels  = { stock_in:'Jumlah Masuk', stock_out:'Jumlah Keluar', opname:'Stok Aktual (Fisik)' };
    const qtyLabel = document.getElementById('inv-adj-qty-label');
    if (qtyLabel) qtyLabel.textContent = labels[type] || 'Jumlah';
  },

  async saveInventoryAdjust() {
    const branchId     = document.getElementById('inv-adj-branch-id').value;
    const ingredientId = document.getElementById('inv-adj-ingredient-id').value;
    const type         = document.getElementById('inv-adj-type').value;
    const qty          = parseFloat(document.getElementById('inv-adj-qty').value);
    const notes        = document.getElementById('inv-adj-notes').value.trim();
    if (!branchId || !ingredientId || isNaN(qty) || qty < 0) { showToast('Lengkapi semua field', 'error'); return; }

    try {
      const invType = { stock_in:'in', stock_out:'out', opname:'opname' }[type] || 'in';
      await inventoryService.adjustStock({
        branchId: parseInt(branchId), ingredientId: parseInt(ingredientId),
        qty, type: invType, referenceType: 'manual', notes, createdBy: this.user.id
      });
      this.closeModal('modal-inventory');
      await this.loadInventory();
      showToast('Stok berhasil diperbarui', 'success');
      window.RBNDataEvents?.publish('inventory:changed', { source: 'admin' });
    } catch (e) {
      showDbError(e, { action: 'memperbarui stok', entity: 'Stok' });
    }
  },

  // ── Transactions ─────────────────────────────────────────────
  setTrxQuickFilter(type, el) {
    document.querySelectorAll('.quick-filter-btn').forEach(b => b.classList.remove('active'));
    if (el) el.classList.add('active');
    const dateInput = document.getElementById('trx-date-filter');
    const todayWita = fmt.getBusinessDate(); // WITA calendar date
    if (type === 'today') {
      if (dateInput) dateInput.value = todayWita;
    } else if (type === 'yesterday') {
      const d = new Date(todayWita + 'T12:00:00+08:00');
      d.setUTCDate(d.getUTCDate() - 1);
      if (dateInput) dateInput.value = d.toISOString().slice(0, 10);
    } else if (type === 'week') {
      const d = new Date(todayWita + 'T12:00:00+08:00');
      d.setUTCDate(d.getUTCDate() - 6);
      if (dateInput) dateInput.value = d.toISOString().slice(0, 10);
    } else if (type === 'month') {
      if (dateInput) dateInput.value = todayWita.slice(0, 7) + '-01';
    }
    this.loadTransactions();
  },

  async loadTransactions() {
    const branchId = document.getElementById('trx-branch-filter').value;
    const date     = document.getElementById('trx-date-filter').value;
    const tbody    = document.getElementById('trx-body');

    let q = db.from('transactions')
      .select('id, created_at, total, payment_method, status, branches(name), users!staff_id(name)')
      .order('created_at', { ascending:false }).limit(200);
    if (branchId) q = q.eq('branch_id', branchId);
    if (date) {
      // BUG-H4 FIX: gunakan fmt.getBusinessDateRange agar timezone WIB (UTC+8) ditangani
      const { from, to } = fmt.getBusinessDateRange(date);
      q = q.gte('created_at', from).lte('created_at', to);
    }

    const { data, error } = await q;
    if (error) { tbody.innerHTML = `<tr><td colspan="8" class="empty-td text-danger">Gagal memuat: ${escHtml(error.message)}</td></tr>`; return; }
    const badgeClass = s => {
      if (s === 'void' || s === 'voided') return 'badge-danger';
      if (s === 'refunded') return 'badge-red';
      if (s === 'completed') return 'badge-green';
      return 'badge-orange';
    };
    tbody.innerHTML = data?.length ? data.map((t, i) => `
      <tr>
        <td class="text-muted text-xs">#${t.id}</td>
        <td class="nowrap text-sm">${fDate(t.created_at)}</td>
        <td>${escHtml(t.branches?.name||'—')}</td>
        <td>${escHtml(t.users?.name||'—')}</td>
        <td><span class="badge badge-orange">${t.payment_method||'cash'}</span></td>
        <td><span class="badge ${badgeClass(t.status)}">${t.status||'completed'}</span></td>
        <td class="fw-700">${fRp(t.total)}</td>
        <td><button class="btn btn-outline btn-sm" data-admin-action="view-transaction" data-id="${t.id}">Detail</button></td>
      </tr>`).join('')
    : `<tr><td colspan="8" class="empty-td">Tidak ada transaksi</td></tr>`;
  },

  async viewTransaction(id) {
    const body = document.getElementById('trx-detail-body');
    try {
    const { data: t, error: tErr } = await db.from('transactions').select('*, branches(name), users!staff_id(name)').eq('id', id).single();
    if (tErr || !t) { body.innerHTML = `<div class="text-danger p-4">Transaksi tidak ditemukan.</div>`; openModal('modal-trx-detail'); return; }
    const { data: items } = await db.from('transaction_items').select('*').eq('transaction_id', id);
    const { data: refunds } = await db.from('refund_transactions').select('*').eq('transaction_id', id).order('created_at', { ascending:false });
    body.innerHTML = `
      <div class="grid-2-col-s2 mb-4">
        <div><div class="form-label">ID Transaksi</div><div class="fw-700">#${t.id}</div></div>
        <div><div class="form-label">Status</div><div><span class="badge ${t.status==='void'||t.status==='voided'?'badge-danger':t.status==='refunded'?'badge-red':'badge-green'}">${t.status||'completed'}</span></div></div>
        <div><div class="form-label">Tanggal</div><div>${fDate(t.created_at)}</div></div>
        <div><div class="form-label">Cabang</div><div>${escHtml(t.branches?.name||'—')}</div></div>
        <div><div class="form-label">Kasir</div><div>${escHtml(t.users?.name||'—')}</div></div>
        <div><div class="form-label">Metode</div><div><span class="badge badge-orange">${t.payment_method||'cash'}</span></div></div>
        <div><div class="form-label">Subtotal</div><div>${fRp(t.subtotal||t.total)}</div></div>
        <div><div class="form-label">Diskon</div><div class="text-danger">${t.discount_amount > 0 ? '−'+fRp(t.discount_amount) : '—'}</div></div>
        <div><div class="form-label">Total</div><div class="fw-800 text-danger">${fRp(t.total)}</div></div>
        ${t.payment_method==='cash' ? `
        <div><div class="form-label">Diterima</div><div>${fRp(t.payment_amount)}</div></div>
        <div><div class="form-label">Kembalian</div><div>${fRp(t.change_amount)}</div></div>` : ''}
      </div>
      <div class="divider"></div>
      <div class="card-title mb-2">Item Pesanan</div>
      <table class="w-full text-sm">
        <thead><tr><th>Produk</th><th>Varian</th><th>Qty</th><th>Harga</th><th>Subtotal</th></tr></thead>
        <tbody>${(items||[]).map(i=>`
          <tr>
            <td>${escHtml(i.product_name)}</td><td>${escHtml(i.variant_name)}</td>
            <td>${i.quantity}</td><td>${fRp(i.price)}</td>
            <td class="fw-700">${fRp(i.subtotal)}</td>
          </tr>`).join('')}
        </tbody>
      </table>
      ${refunds?.length ? `
      <div class="divider mt-3"></div>
      <div class="card-title mb-2">Riwayat Refund</div>
      ${refunds.map(r=>`<div class="text-sm py-1 border-b">
        <strong>${fRp(r.refund_amount)}</strong> (${r.type}) — ${escHtml(r.reason||'—')} — ${fDate(r.created_at)}
      </div>`).join('')}` : ''}`;

    const refundBtn = document.getElementById('btn-refund-trx');
    if (refundBtn) {
      refundBtn.classList.toggle('hidden', (t.status === 'refunded' || t.status === 'void' || t.status === 'voided'));
      const clonedRefundBtn = refundBtn.cloneNode(true);
      refundBtn.parentNode.replaceChild(clonedRefundBtn, refundBtn);
      clonedRefundBtn.addEventListener('click', () => this.openRefundModal(id, parseFloat(t.total)));
    }
    const voidBtn = document.getElementById('btn-void-trx');
    if (voidBtn) {
      voidBtn.classList.toggle('hidden', (t.status === 'refunded' || t.status === 'void' || t.status === 'voided'));
      const clonedVoidBtn = voidBtn.cloneNode(true);
      voidBtn.parentNode.replaceChild(clonedVoidBtn, voidBtn);
      clonedVoidBtn.addEventListener('click', () => this.openVoidModal(id));
    }
    openModal('modal-trx-detail');
    } catch(e) {
      body.innerHTML = `<div class="text-danger p-4">Gagal memuat transaksi: ${escHtml(e.message)}</div>`;
      openModal('modal-trx-detail');
    }
  },

  openRefundModal(transactionId, maxAmount) {
    document.getElementById('refund-trx-id').value   = transactionId;
    // BUG-H7 FIX: simpan maxAmount di data-amount agar confirmRefund() bisa validasi
    const maxEl = document.getElementById('refund-max');
    if (maxEl) { maxEl.textContent = fRp(maxAmount); maxEl.dataset.amount = maxAmount; }
    document.getElementById('refund-amount').value    = maxAmount;
    document.getElementById('refund-type').value      = 'full';
    document.getElementById('refund-reason').value    = '';
    openModal('modal-refund');
  },

  // ── Void Transaction (NEW) ──────────────────────────────────
  openVoidModal(transactionId) {
    document.getElementById('void-trx-id').value  = transactionId;
    document.getElementById('void-reason').value  = '';
    openModal('modal-void-trx');
  },

  async confirmVoid() {
    const transactionId = parseInt(document.getElementById('void-trx-id').value);
    const reason        = document.getElementById('void-reason').value.trim();
    if (!reason) { showToast('Alasan void wajib diisi', 'error'); return; }
    const btn = document.getElementById('btn-confirm-void');
    btn.disabled = true;
    try {
      await transactionService.voidTransaction({ transactionId, reason, userId: this.user.id });
      this.closeModal('modal-void-trx');
      this.closeModal('modal-trx-detail');
      await this.loadTransactions();
      showToast('Transaksi berhasil di-void', 'success');
    } catch (e) {
      showToast('Gagal void: ' + e.message, 'error');
    } finally {
      btn.disabled = false;
    }
  },

  async confirmRefund() {
    const transactionId  = parseInt(document.getElementById('refund-trx-id').value);
    const refundAmount   = parseFloat(document.getElementById('refund-amount').value);
    const type           = document.getElementById('refund-type').value;
    const reason         = document.getElementById('refund-reason').value.trim();
    // BUG-H7 FIX: validasi refundAmount tidak boleh melebihi total transaksi
    const maxAmount = parseFloat(document.getElementById('refund-max')?.dataset.amount || Infinity);
    if (!refundAmount || refundAmount <= 0) { showToast('Jumlah refund tidak valid', 'error'); return; }
    if (isFinite(maxAmount) && refundAmount > maxAmount) {
      showToast(`Refund tidak boleh melebihi total transaksi (${fRp(maxAmount)})`, 'error'); return;
    }

    const btn = document.getElementById('btn-confirm-refund');
    btn.disabled = true;
    try {
      await transactionService.processRefund({ transactionId, refundAmount, reason, type, userId: this.user.id });
      this.closeModal('modal-refund');
      this.closeModal('modal-trx-detail');
      await this.loadTransactions();
      showToast('Refund berhasil diproses', 'success');
    } catch (e) {
      showDbError(e, { action: 'memproses refund', entity: 'Refund' });
    } finally {
      btn.disabled = false;
    }
  },


  // ── Reports ───────────────────────────────────────────────────
  async loadReports() {
    const today = fmt.getBusinessDate();
    const monthStart = today.slice(0, 7) + '-01';
    if (!document.getElementById('report-date-from').value) {
      document.getElementById('report-date-from').value = monthStart;
      document.getElementById('report-date-to').value   = today;
    }

    // BUG-L3 FIX: pastikan paymentMethods tersedia, fallback ke default jika belum
    if (!this.paymentMethods?.length) {
      try { await this.loadSettings(); } catch(e) {}
    }
    const methods = this.paymentMethods || [{ code:'cash', label:'Tunai' }, { code:'qris', label:'QRIS' }, { code:'transfer', label:'Transfer' }];
    const pmOpts = methods.map(m => `<option value="${m.code}">${escHtml(m.label)}</option>`).join('');
    setSelect('report-payment-filter', `<option value="">Semua Metode</option>${pmOpts}`);
    
    // Populate Staff
    try {
      let { data: users, error: usersErr } = await db.from('users').select('id, name, is_active').order('name');
      const usersErrMsg = (usersErr?.message || '').toLowerCase();
      if (usersErr && (usersErr.code === '42703' || usersErrMsg.includes('is_active'))) {
        ({ data: users, error: usersErr } = await db.from('users').select('id, name').order('name'));
      }
      if (usersErr) throw usersErr;
      if (users) {
        const staffOpts = this._activeUsers(users).map(u => `<option value="${u.id}">${escHtml(u.name)}</option>`).join('');
        setSelect('report-staff-filter', `<option value="">Semua Kasir</option>${staffOpts}`);
      }
    } catch(e) { console.error('Failed to load staff for reports', e); }

    this.switchReportTab('sales', document.querySelector('#section-reports .inner-tab.active') || document.querySelector('#section-reports .inner-tab'));
  },

  switchReportTab(tab, el) {
    this.currentReportTab = tab;
    document.querySelectorAll('#section-reports .inner-tab').forEach(t => t.classList.remove('active'));
    if (el) el.classList.add('active');
    document.getElementById('report-tab-sales').style.display     = tab === 'sales'     ? 'block' : 'none';
    document.getElementById('report-tab-products').style.display  = tab === 'products'  ? 'block' : 'none';
    document.getElementById('report-tab-inv-usage').style.display = tab === 'inv-usage' ? 'block' : 'none';
    document.getElementById('report-tab-ing-avg').style.display   = tab === 'ing-avg'   ? 'block' : 'none';
    this.runReport(tab);
  },

  async runReport(tab) {
    const dateFrom = document.getElementById('report-date-from').value;
    const dateTo   = document.getElementById('report-date-to').value;
    const branchId = document.getElementById('report-branch-filter').value;
    const paymentMethod = document.getElementById('report-payment-filter')?.value || null;
    const staffId = document.getElementById('report-staff-filter')?.value || null;

    if (!dateFrom || !dateTo) { showToast('Pilih rentang tanggal', 'warning'); return; }

    const exportBtn = document.getElementById('btn-export-report');
    if (exportBtn) exportBtn.disabled = true;

    try {
      if (tab === 'sales') {
        const el = document.getElementById('report-sales-body');
        el.innerHTML = '<tr><td colspan="8" class="empty-td">Memuat...</td></tr>';
        const data = await reportService.getSalesReport({ branchId, dateFrom, dateTo, paymentMethod, staffId });
        this._reportData = { tab, data, dateFrom, dateTo };

        // Summary cards — only completed transactions
        document.getElementById('report-stat-revenue').textContent     = fRp(data.totalRevenue);
        document.getElementById('report-stat-discount').textContent    = fRp(data.totalDiscount);
        document.getElementById('report-stat-count').textContent       = data.count;

        // Void info banner
        const voidInfoEl = document.getElementById('report-void-info');
        if (data.voidCount > 0) {
          voidInfoEl.style.display = 'block';
          voidInfoEl.textContent   = `⚠️  ${data.voidCount} transaksi void (${fRp(data.voidAmount)}) dikecualikan dari total penjualan`;
        } else {
          voidInfoEl.style.display = 'none';
        }

        // Table — show completed always; append voided rows when toggle is on
        const showVoid = document.getElementById('report-show-void')?.checked;
        const displayTx = showVoid
          ? [...data.transactions, ...data.voidedTransactions]
          : data.transactions;

        const isVoided = t => t.status === 'void' || t.status === 'voided';

        el.innerHTML = displayTx.length
          ? displayTx.map((t, i) => {
              const voided = isVoided(t);
              const statusBadge = voided
                ? '<span class="badge badge-danger">VOID</span>'
                : '<span class="badge badge-green">Selesai</span>';
              return `<tr style="${voided ? 'opacity:0.55' : ''}">
                <td>${i + 1}</td>
                <td>${fDate(t.created_at)}</td>
                <td>${escHtml(t.branches?.name || '—')}</td>
                <td>${escHtml(t.users?.name || '—')}</td>
                <td>${t.payment_method || 'cash'}</td>
                <td>${t.discount_amount > 0 ? fRp(t.discount_amount) : '—'}</td>
                <td>${statusBadge}</td>
                <td class="fw-700${voided ? ' text-muted' : ''}">${fRp(t.total)}</td>
              </tr>`;
            }).join('')
          : '<tr><td colspan="8" class="empty-td">Tidak ada data</td></tr>';

      } else if (tab === 'products') {
        const el = document.getElementById('report-products-body');
        el.innerHTML = '<tr><td colspan="6" class="empty-td">Memuat...</td></tr>';
        const data = await reportService.getProductPerformance({ branchId, dateFrom, dateTo, paymentMethod, staffId });
        this._reportData = { tab, data, dateFrom, dateTo };

        if (!data.length) {
          document.getElementById('report-prod-stat-unique').textContent = '0';
          document.getElementById('report-prod-stat-qty').textContent    = '0 pcs';
          document.getElementById('report-prod-stat-rev').textContent    = fRp(0);
          document.getElementById('report-top-products-cards').innerHTML = '';
          el.innerHTML = '<tr><td colspan="6" class="empty-td">Tidak ada data produk terjual</td></tr>';
        } else {
          const totalQty = data.reduce((s, p) => s + p.qty, 0);
          const totalRev = data.reduce((s, p) => s + p.revenue, 0);

          // Aggregate by product name for top-cards — exclude unrecorded rows
          const prodMap = {};
          for (const p of data) {
            if (p._unrecorded) continue;
            if (!prodMap[p.product]) prodMap[p.product] = { name: p.product, qty: 0, revenue: 0 };
            prodMap[p.product].qty     += p.qty;
            prodMap[p.product].revenue += p.revenue;
          }
          const topProds = Object.values(prodMap).sort((a, b) => b.qty - a.qty);

          document.getElementById('report-prod-stat-unique').textContent = topProds.length;
          document.getElementById('report-prod-stat-qty').textContent    = totalQty.toLocaleString('id-ID') + ' pcs';
          document.getElementById('report-prod-stat-rev').textContent    = fRp(totalRev);

          const rankColors = ['#F59E0B','#9CA3AF','#CD7C3A'];
          document.getElementById('report-top-products-cards').innerHTML = `
            <div class="top-products-section">
              <div class="top-products-label">TOP PRODUK</div>
              <div class="top-products-grid">
                ${topProds.slice(0, 5).map((p, i) => `
                  <div class="top-product-card ${i < 3 ? 'top-product-podium' : ''}" style="${i < 3 ? `border-left-color:${rankColors[i]}` : ''}">
                    <div class="top-product-rank" style="${i < 3 ? `color:${rankColors[i]}` : ''}">${i + 1}</div>
                    <div class="top-product-info">
                      <div class="top-product-name">${escHtml(p.name)}</div>
                      <div class="top-product-meta">
                        <span>${p.qty.toLocaleString('id-ID')} pcs</span>
                        <span>${fRp(p.revenue)}</span>
                      </div>
                    </div>
                  </div>`).join('')}
              </div>
            </div>`;

          // Rank counter only for recorded products
          let rankIdx = 0;
          el.innerHTML = data.map((p) => {
            const pct = totalQty ? ((p.qty / totalQty) * 100).toFixed(1) : '0.0';
            if (p._unrecorded) {
              return `<tr style="opacity:0.5;font-style:italic">
                <td><span style="color:var(--text-muted)">—</span></td>
                <td style="color:var(--text-muted)">${escHtml(p.product)}</td>
                <td style="color:var(--text-muted)">—</td>
                <td>${p.qty.toLocaleString('id-ID')} pcs</td>
                <td>${fRp(p.revenue)}</td>
                <td style="color:var(--text-muted)">${pct}%</td>
              </tr>`;
            }
            const i = rankIdx++;
            const badge = i < 3
              ? `<span class="prod-rank-badge" style="background:${rankColors[i]}20;color:${rankColors[i]};border-color:${rankColors[i]}40">#${i + 1}</span>`
              : `<span style="color:var(--text-muted)">${i + 1}</span>`;
            return `<tr>
              <td>${badge}</td>
              <td class="fw-700">${escHtml(p.product)}</td>
              <td>${escHtml(p.variant || '—')}</td>
              <td>${p.qty.toLocaleString('id-ID')} pcs</td>
              <td>${fRp(p.revenue)}</td>
              <td style="color:var(--text-muted)">${pct}%</td>
            </tr>`;
          }).join('');
        }

      } else if (tab === 'inv-usage') {
        const el = document.getElementById('report-inv-usage-body');
        el.innerHTML = '<tr><td colspan="3" class="empty-td">Memuat...</td></tr>';
        const data = await reportService.getInventoryUsage({ branchId, dateFrom, dateTo });
        this._reportData = { tab, data, dateFrom, dateTo };
        el.innerHTML = data.length
          ? data.map((r, i) => `
              <tr>
                <td>${i+1}</td>
                <td>${escHtml(r.name)}</td>
                <td>${r.totalUsed.toLocaleString('id-ID')} ${escHtml(r.unit)}</td>
              </tr>`).join('')
          : '<tr><td colspan="3" class="empty-td">Tidak ada data pemakaian</td></tr>';

      } else if (tab === 'ing-avg') {
        const el = document.getElementById('report-ing-avg-body');
        el.innerHTML = '<tr><td colspan="7" class="empty-td">Memuat...</td></tr>';
        const data = await reportService.getIngredientAvgUsage({ branchId, dateFrom, dateTo });
        this._reportData = { tab, data, dateFrom, dateTo };
        document.getElementById('report-avg-stat-items').textContent = data.length;
        const top = data[0];
        document.getElementById('report-avg-stat-top').textContent = top
          ? `${top.ingredient_name}: ${Math.round(parseFloat(top.avg_per_day)).toLocaleString('id-ID')} ${top.unit}/hari`
          : '—';
        el.innerHTML = data.length
          ? data.map((r, i) => `
              <tr>
                <td>${i+1}</td>
                <td>${escHtml(r.branch_name)}</td>
                <td>${escHtml(r.ingredient_name)}</td>
                <td>${escHtml(r.unit)}</td>
                <td><strong>${Math.round(parseFloat(r.avg_per_day)).toLocaleString('id-ID')}</strong></td>
                <td>${parseFloat(r.total_used).toLocaleString('id-ID', {minimumFractionDigits:0, maximumFractionDigits:2})}</td>
                <td>${r.active_days} hari</td>
              </tr>`).join('')
          : '<tr><td colspan="7" class="empty-td">Tidak ada data pemakaian bahan</td></tr>';
      }

      if (exportBtn) exportBtn.disabled = false;
    } catch (e) {
      showToast('Gagal memuat laporan: ' + e.message, 'error');
    }
  },

  exportReportCsv() {
    if (!this._reportData) return;
    const { tab, data, dateFrom, dateTo } = this._reportData;

    const csvCell = v => {
      const s = String(v ?? '');
      return s.includes(',') || s.includes('"') || s.includes('\n')
        ? '"' + s.replace(/"/g, '""') + '"'
        : s;
    };
    const csvRow  = cols => cols.map(csvCell).join(',');

    let rows = [], filename = '';

    if (tab === 'sales') {
      const showVoid = document.getElementById('report-show-void')?.checked;
      const isVoided = t => t.status === 'void' || t.status === 'voided';
      const txList = showVoid
        ? [...data.transactions, ...data.voidedTransactions]
        : data.transactions;
      rows.push(csvRow(['No','Waktu','Cabang','Kasir','Metode Bayar','Diskon','Status','Total']));
      txList.forEach((t, i) => rows.push(csvRow([
        i + 1,
        fDate(t.created_at),
        t.branches?.name || '',
        t.users?.name || '',
        t.payment_method || 'cash',
        t.discount_amount || 0,
        isVoided(t) ? 'VOID' : 'Selesai',
        t.total || 0,
      ])));
      filename = `laporan-penjualan_${dateFrom}_${dateTo}.csv`;

    } else if (tab === 'products') {
      const totalQty = data.reduce((s, p) => s + p.qty, 0);
      rows.push(csvRow(['No','Produk','Varian','Qty Terjual','Revenue','% Total']));
      data.forEach((p, i) => rows.push(csvRow([
        i + 1,
        p.product,
        p.variant || '',
        p.qty,
        p.revenue,
        totalQty ? ((p.qty / totalQty) * 100).toFixed(1) : '0.0',
      ])));
      filename = `laporan-produk_${dateFrom}_${dateTo}.csv`;

    } else if (tab === 'inv-usage') {
      rows.push(csvRow(['No','Bahan','Total Pemakaian','Satuan']));
      data.forEach((r, i) => rows.push(csvRow([i + 1, r.name, r.totalUsed, r.unit || ''])));
      filename = `laporan-bahan_${dateFrom}_${dateTo}.csv`;

    } else if (tab === 'ing-avg') {
      rows.push(csvRow(['No','Cabang','Bahan','Satuan','Rata-rata/Hari','Total Periode','Hari Aktif']));
      data.forEach((r, i) => rows.push(csvRow([
        i + 1,
        r.branch_name,
        r.ingredient_name,
        r.unit || '',
        r.avg_per_day,
        r.total_used,
        r.active_days,
      ])));
      filename = `laporan-rata-bahan_${dateFrom}_${dateTo}.csv`;
    }

    const bom  = '﻿'; // UTF-8 BOM agar Excel terbaca dengan benar
    const blob = new Blob([bom + rows.join('\r\n')], { type: 'text/csv;charset=utf-8;' });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href = url; a.download = filename; a.click();
    URL.revokeObjectURL(url);
  },

  // ── Inventory Logs ────────────────────────────────────────────
  async loadInventoryLogs() {
    const branchId = document.getElementById('inv-log-branch-filter').value;
    const type     = document.getElementById('inv-log-type-filter')?.value || '';
    const tbody    = document.getElementById('inv-log-body');
    tbody.innerHTML = '<tr><td colspan="8" class="empty-td">Memuat...</td></tr>';

    let q = db.from('inventory_logs')
      .select('*, ingredients(name, unit), branches(name), users!created_by(name)')
      .order('created_at', { ascending:false }).limit(300);
    if (branchId) q = q.eq('branch_id', branchId);
    if (type)     q = q.eq('type', type);

    const { data } = await q;
    const typeLabel = { in:'Masuk', out:'Keluar', opname:'Opname', transfer_in:'Transfer Masuk', transfer_out:'Transfer Keluar' };
    const typeBadge = { in:'badge-green', out:'badge-red', opname:'badge-orange', transfer_in:'badge-green', transfer_out:'badge-orange' };

    tbody.innerHTML = data?.length ? data.map(log => {
      const qty = parseFloat(log.quantity ?? 0);
      const qtyStr = qty > 0 ? '+' + qty : String(qty);
      const noteStr = log.note || log.reference_type || '—';
      return `<tr>
        <td class="nowrap text-xs">${fDate(log.created_at)}</td>
        <td>${escHtml(log.branches?.name||'—')}</td>
        <td class="fw-600">${escHtml(log.ingredients?.name||'—')}</td>
        <td><span class="badge ${typeBadge[log.type]||'badge-orange'}">${typeLabel[log.type]||log.type}</span></td>
        <td class="fw-700">${qtyStr} ${escHtml(log.ingredients?.unit||'')}</td>
        <td>${parseFloat(log.stock_before??0)} → ${parseFloat(log.stock_after??0)}</td>
        <td>${escHtml(log.users?.name||'Sistem')}</td>
        <td class="text-xs text-muted">${escHtml(noteStr)}</td>
      </tr>`;}).join('')
    : `<tr><td colspan="8" class="empty-td">Belum ada log inventori</td></tr>`;
  },

  // ── Staff ─────────────────────────────────────────────────────
  async loadStaff() {
    const { data, error } = await db.from('users').select('*').order('name');
    if (error) { showToast('Gagal memuat staff: ' + error.message, 'error'); return; }
    const container = document.getElementById('staff-list');
    if (!container) return;
    const activeUsers = this._activeUsers(data);

    // Load onboarding status for all staff users (non-fatal)
    const staffIds = activeUsers.filter(u => u.role === 'staff').map(u => u.id);
    const obStatusMap = {};
    if (staffIds.length) {
      try {
        const { data: obRows } = await db.rpc('get_staff_onboarding_statuses', {
          p_user_ids: staffIds,
        });
        (obRows || []).forEach(r => { obStatusMap[r.user_id] = r.ob_status; });
      } catch { /* non-fatal: badges just won't show */ }
    }

    container.innerHTML = activeUsers.length
      ? `<div class="admin-list">${activeUsers.map(u => {
          const branch = this.branches.find(b => b.id === u.branch_id);
          const roleIconSvg = u.role === 'admin'
            ? '<i data-lucide="shield" class="icon"></i>'
            : u.role === 'investor'
              ? '<i data-lucide="bar-chart-3" class="icon"></i>'
              : '<i data-lucide="user" class="icon"></i>';
          const roleBadgeClass = u.role === 'admin' ? 'badge-red' : u.role === 'investor' ? 'badge-blue' : 'badge-orange';

          let trainingBadge = '';
          if (u.role === 'staff') {
            const obStatus = obStatusMap[u.id];
            if (obStatus === 'not_started') {
              trainingBadge = '<span class="badge badge-training badge-training-not_started">Training: Belum mulai</span>';
            } else if (obStatus === 'in_progress') {
              trainingBadge = '<span class="badge badge-training badge-training-in_progress">Training: Sedang belajar</span>';
            } else if (obStatus === 'completed') {
              trainingBadge = '<span class="badge badge-training badge-training-completed">Training: Selesai ✓</span>';
            } else {
              trainingBadge = '<span class="badge badge-training badge-training-none">Training: Tidak ada</span>';
            }
          }

          return `<div class="admin-list-card">
            <div class="list-card-icon">${roleIconSvg}</div>
            <div class="list-card-info">
              <div class="list-card-title">${escHtml(u.name)}</div>
              <div class="list-card-sub">${escHtml(branch?.name||'Tidak ada cabang')}</div>
              ${trainingBadge ? `<div style="margin-top:4px;">${trainingBadge}</div>` : ''}
            </div>
            <div class="list-card-meta"><span class="badge ${roleBadgeClass}">${u.role}</span></div>
            <div class="list-card-actions">
              <button class="btn btn-outline btn-sm" data-admin-action="open-staff-modal" data-id="${u.id}">Edit</button>
              ${u.id !== this.user.id ? `<button class="btn btn-danger-soft btn-sm" data-admin-action="delete-staff" data-id="${u.id}" data-name="${escHtml(u.name)}">Hapus</button>` : ''}
            </div>
          </div>`;
        }).join('')}</div>`
      : `<div class="empty-state">
          <div class="empty-icon"><i data-lucide="users" class="icon"></i></div>
          <div class="empty-title">Belum ada staff</div>
          <div class="empty-desc">Tambahkan staff untuk mengelola operasional</div>
          <div class="empty-cta"><button class="btn btn-primary" data-admin-action="open-staff-modal">+ Tambah Staff</button></div>
        </div>`;
  },

  async openStaffModal(id = null) {
    document.getElementById('staff-id').value       = id || '';
    document.getElementById('staff-name').value     = '';
    document.getElementById('staff-username').value = '';
    document.getElementById('staff-password').value = '';
    document.getElementById('staff-role').value     = 'staff';
    document.getElementById('staff-modal-title').textContent = id ? 'Edit User' : 'Tambah User';
    setSelect('staff-branch-id', `<option value="">— Tidak Ditentukan —</option>${this.branches.map(b=>`<option value="${b.id}">${escHtml(b.name)}</option>`).join('')}`);

    let checkedBranches = [];
    if (id) {
      const [{ data: u }, { data: iba }] = await Promise.all([
        db.from('users').select('*').eq('id', id).maybeSingle(),
        db.from('investor_branch_access').select('branch_id').eq('user_id', id)
      ]);
      if (u) {
        document.getElementById('staff-name').value      = u.name;
        document.getElementById('staff-username').value  = u.name;
        document.getElementById('staff-password').value  = '';
        document.getElementById('staff-role').value      = u.role;
        document.getElementById('staff-branch-id').value = u.branch_id || '';
        checkedBranches = (iba || []).map(r => r.branch_id);
      }
    }

    this._renderInvestorBranchCheckboxes('investor-branch-checkboxes', checkedBranches);
    this.onStaffRoleChange();
    openModal('modal-staff');
  },

  onStaffRoleChange() {
    const role = document.getElementById('staff-role')?.value;
    const branchGroup    = document.getElementById('staff-branch-group');
    const investorGroup  = document.getElementById('investor-branches-group');
    if (!branchGroup || !investorGroup) return;
    if (role === 'investor') {
      branchGroup.classList.add('hidden');
      investorGroup.classList.remove('hidden');
    } else {
      branchGroup.classList.remove('hidden');
      investorGroup.classList.add('hidden');
    }
  },

  _renderInvestorBranchCheckboxes(containerId, checkedIds = []) {
    const container = document.getElementById(containerId);
    if (!container) return;
    container.innerHTML = this.branches.map(b => `
      <label style="display:flex;align-items:center;gap:8px;cursor:pointer;padding:4px 0;">
        <input type="checkbox" value="${b.id}" ${checkedIds.includes(b.id) ? 'checked' : ''}
          style="width:16px;height:16px;flex-shrink:0;" />
        <span>${escHtml(b.name)}</span>
      </label>
    `).join('');
  },

  _getCheckedBranchIds(containerId) {
    const container = document.getElementById(containerId);
    if (!container) return [];
    return [...container.querySelectorAll('input[type=checkbox]:checked')]
      .map(cb => Number(cb.value));
  },

  _activeUsers(rows = []) {
    return (rows || []).filter(u => u.is_active !== false);
  },

  _activeBranches(rows = []) {
    return (rows || []).filter(b => b.is_active !== false);
  },

  _makeArchivedPassword() {
    const bytes = new Uint8Array(16);
    if (window.crypto?.getRandomValues) {
      window.crypto.getRandomValues(bytes);
      return 'archived_' + Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
    }
    return 'archived_' + Date.now() + '_' + Math.random().toString(36).slice(2);
  },

  async saveStaff() {
    const id       = document.getElementById('staff-id').value;
    const name     = document.getElementById('staff-username').value.trim();
    const password = document.getElementById('staff-password').value || '';
    const role     = document.getElementById('staff-role').value;
    const branchId = role !== 'investor' ? (document.getElementById('staff-branch-id').value || null) : null;

    if (!name) { showToast('Username wajib diisi', 'error'); return; }

    let savedUserId = id ? Number(id) : null;
    const payload = { name, role, branch_id: branchId };
    try {
      if (!id) {
        if (!password.trim()) { showToast('Password wajib diisi', 'error'); return; }
        payload.password = password.trim();
        const { data: inserted, error } = await db.from('users').insert(payload).select('id').single();
        if (error) throw error;
        savedUserId = inserted.id;
      } else {
        if (password.trim()) payload.password = password.trim();
        const { error } = await db.from('users').update(payload).eq('id', id);
        if (error) throw error;
      }
    } catch (e) {
      if (e && e.code === '23505') {
        showToast('Username sudah digunakan, pilih username lain', 'error');
      } else {
        showDbError(e, { action: 'menyimpan user', entity: 'User' });
      }
      return;
    }

    if (role === 'investor' && savedUserId) {
      const selectedBranches = this._getCheckedBranchIds('investor-branch-checkboxes');
      await db.from('investor_branch_access').delete().eq('user_id', savedUserId);
      if (selectedBranches.length) {
        const rows = selectedBranches.map(bid => ({ user_id: savedUserId, branch_id: bid, created_by: this.user.id }));
        const { error: iaErr } = await db.from('investor_branch_access').insert(rows);
        if (iaErr) { showToast('User disimpan tapi akses cabang gagal: ' + iaErr.message, 'warn'); }
      }
    }

    this.closeModal('modal-staff');
    await this.loadStaff();
    showToast('User berhasil disimpan', 'success');
  },

  async deleteStaff(id, name) {
    if (id === this.user.id) {
      showToast('Akun yang sedang login tidak bisa dihapus', 'warning');
      return;
    }

    const ok = await showConfirm({
      title:       `Hapus User "${name}"?`,
      message:     'Akun user ini akan dinonaktifkan dan disembunyikan dari daftar staff. Riwayat transaksi tetap tersimpan.',
      confirmText: 'Ya, Hapus',
      danger:      true,
    });
    if (!ok) return;

    const { error } = await db.from('users')
      .update({
        is_active: false,
        deleted_at: new Date().toISOString(),
        branch_id: null,
        password: this._makeArchivedPassword()
      })
      .eq('id', id);

    if (error) {
      const msg = (error.message || '').toLowerCase();
      if (error.code === '42703' || msg.includes('is_active') || msg.includes('deleted_at')) {
        showToast('Database belum memakai pembaruan terbaru untuk hapus user. Hubungi developer untuk menjalankan pembaruan database.', 'error');
      } else {
        showDbError(error, { action: 'menghapus user', entity: 'User' });
      }
      return;
    }

    await db.from('investor_branch_access').delete().eq('user_id', id);
    await db.from('investor_feature_access').delete().eq('user_id', id);

    await this.loadStaff();
    if (this.currentSection === 'investor-access') await this.loadInvestorAccess();
    showToast('User dihapus dari daftar aktif', 'success');
  },

  // ── Investor Access ───────────────────────────────────────────
  _FEATURE_LABELS: {
    sales:           'Penjualan',
    products:        'Performa Produk',
    inventory_stock: 'Stok Bahan',
    inventory_usage: 'Pemakaian Bahan',
  },

  async loadInvestorAccess() {
    const { data: investors, error } = await db.from('users').select('*').eq('role', 'investor').order('name');
    if (error) { showToast('Gagal memuat investor: ' + error.message, 'error'); return; }
    const container = document.getElementById('investor-access-list');
    if (!container) return;
    const activeInvestors = this._activeUsers(investors);

    if (!activeInvestors.length) {
      container.innerHTML = `<div class="empty-state">
        <div class="empty-icon"><i data-lucide="bar-chart-3" class="icon"></i></div>
        <div class="empty-title">Belum ada investor</div>
        <div class="empty-desc">Tambahkan akun investor melalui menu Staff lalu atur akses cabangnya di sini</div>
      </div>`;
      if (window.lucide) lucide.createIcons();
      return;
    }

    const [{ data: allAccess }, { data: allFeatures }] = await Promise.all([
      db.from('investor_branch_access').select('user_id, branch_id'),
      db.from('investor_feature_access').select('user_id, feature_key, allowed').eq('allowed', true),
    ]);

    const branchMap = {};
    for (const a of (allAccess || [])) {
      if (!branchMap[a.user_id]) branchMap[a.user_id] = [];
      const b = this.branches.find(br => br.id === a.branch_id);
      if (b) branchMap[a.user_id].push(b.name);
    }
    const featureMap = {};
    for (const f of (allFeatures || [])) {
      if (!featureMap[f.user_id]) featureMap[f.user_id] = [];
      featureMap[f.user_id].push(f.feature_key);
    }

    const labels = this._FEATURE_LABELS;
    container.innerHTML = `<div class="admin-list">${activeInvestors.map(u => {
      const branchList  = branchMap[u.id]  || [];
      const featureList = featureMap[u.id] || [];
      const hasBranch  = branchList.length  > 0;
      const hasFeature = featureList.length > 0;
      const status = !hasBranch ? 'Belum ada cabang' : !hasFeature ? 'Belum ada modul' : 'Lengkap';
      const statusCls = (hasBranch && hasFeature) ? 'badge-green' : 'badge-warning';

      const branchChips = branchList.map(n => `<span class="badge badge-blue" style="font-size:11px;">${escHtml(n)}</span>`).join(' ');
      const featureChips = featureList.map(k => `<span class="badge badge-orange" style="font-size:11px;">${escHtml(labels[k] || k)}</span>`).join(' ');

      return `<div class="admin-list-card" style="flex-wrap:wrap;gap:10px;">
        <div class="list-card-icon"><i data-lucide="bar-chart-3" class="icon"></i></div>
        <div class="list-card-info" style="min-width:0;">
          <div class="list-card-title">${escHtml(u.name)}</div>
          <div style="display:flex;flex-wrap:wrap;gap:4px;margin-top:4px;">
            ${branchChips || '<span style="font-size:11px;color:var(--text-muted);">Belum ada cabang</span>'}
          </div>
          <div style="display:flex;flex-wrap:wrap;gap:4px;margin-top:4px;">
            ${featureChips || '<span style="font-size:11px;color:var(--text-muted);">Belum ada modul</span>'}
          </div>
        </div>
        <div class="list-card-meta">
          <span class="badge ${statusCls}" style="font-size:11px;">${status}</span>
        </div>
        <div class="list-card-actions">
          <button class="btn btn-outline btn-sm" data-admin-action="edit-investor-access" data-id="${u.id}">Atur Akses</button>
          <button class="btn btn-outline btn-sm" data-admin-action="open-staff-modal" data-id="${u.id}">Edit User</button>
          ${u.id !== this.user.id ? `<button class="btn btn-danger-soft btn-sm" data-admin-action="delete-investor" data-id="${u.id}" data-name="${escHtml(u.name)}">Hapus</button>` : ''}
        </div>
      </div>`;
    }).join('')}</div>`;
    if (window.lucide) lucide.createIcons();
  },

  async openInvestorModal(id = null) {
    await this.openStaffModal(id);
    document.getElementById('staff-role').value = 'investor';
    this.onStaffRoleChange();
    if (id) {
      const { data: iba } = await db.from('investor_branch_access').select('branch_id').eq('user_id', id);
      this._renderInvestorBranchCheckboxes('investor-branch-checkboxes', (iba || []).map(r => r.branch_id));
    }
  },

  async openInvestorAccessModal(userId) {
    const { data: u } = await db.from('users').select('id,name').eq('id', userId).maybeSingle();
    if (!u) { showToast('Investor tidak ditemukan', 'error'); return; }

    const [{ data: iba }, { data: ifa }] = await Promise.all([
      db.from('investor_branch_access').select('branch_id').eq('user_id', userId),
      db.from('investor_feature_access').select('feature_key, allowed').eq('user_id', userId),
    ]);

    const checkedBranches = (iba || []).map(r => r.branch_id);
    const activeFeatures  = (ifa || []).filter(r => r.allowed).map(r => r.feature_key);

    document.getElementById('investor-access-user-id').value      = userId;
    document.getElementById('investor-modal-subtitle').textContent = u.name;
    this._renderInvestorBranchCheckboxes('investor-access-checkboxes', checkedBranches);
    this._renderFeatureToggles(activeFeatures);
    this._updateAccessPreview();
    this._bindInvestorAccessModalEvents();
    openModal('modal-investor-access');
  },

  _renderFeatureToggles(activeFeatures = []) {
    document.querySelectorAll('.inv-feature-cb').forEach(cb => {
      cb.checked = activeFeatures.includes(cb.value);
    });
  },

  _bindInvestorAccessModalEvents() {
    const modal = document.getElementById('modal-investor-access');

    const branchAll  = document.getElementById('ia-branch-all');
    const branchNone = document.getElementById('ia-branch-none');
    const search     = document.getElementById('ia-branch-search');

    // Clone to remove old listeners
    [branchAll, branchNone, search].forEach(el => {
      if (!el) return;
      const clone = el.cloneNode(true);
      el.parentNode.replaceChild(clone, el);
    });

    document.getElementById('ia-branch-all')?.addEventListener('click', () => {
      document.querySelectorAll('#investor-access-checkboxes input[type=checkbox]').forEach(cb => { cb.checked = true; });
      this._updateAccessPreview();
    });
    document.getElementById('ia-branch-none')?.addEventListener('click', () => {
      document.querySelectorAll('#investor-access-checkboxes input[type=checkbox]').forEach(cb => { cb.checked = false; });
      this._updateAccessPreview();
    });
    document.getElementById('ia-branch-search')?.addEventListener('input', e => {
      const q = e.target.value.toLowerCase();
      document.querySelectorAll('#investor-access-checkboxes label').forEach(lbl => {
        lbl.style.display = lbl.textContent.toLowerCase().includes(q) ? '' : 'none';
      });
    });

    document.querySelectorAll('.inv-feature-cb').forEach(cb => {
      const clone = cb.cloneNode(true);
      cb.parentNode.replaceChild(clone, cb);
    });
    document.querySelectorAll('.inv-feature-cb').forEach(cb => {
      cb.addEventListener('change', () => this._updateAccessPreview());
    });
    document.querySelectorAll('#investor-access-checkboxes input[type=checkbox]').forEach(cb => {
      cb.addEventListener('change', () => this._updateAccessPreview());
    });
  },

  _updateAccessPreview() {
    const branchCount = document.querySelectorAll('#investor-access-checkboxes input[type=checkbox]:checked').length;
    const features    = [...document.querySelectorAll('.inv-feature-cb:checked')].map(cb => this._FEATURE_LABELS[cb.value] || cb.value);
    const el = document.getElementById('ia-access-preview');
    if (!el) return;
    if (!branchCount && !features.length) {
      el.textContent = 'Investor ini tidak akan dapat melihat data apapun.';
      return;
    }
    const parts = [];
    if (branchCount) parts.push(`${branchCount} cabang`);
    if (features.length) parts.push(...features);
    el.textContent = `Investor ini akan melihat: ${parts.join(', ')}.`;
  },

  async saveInvestorAccess() {
    const userId = Number(document.getElementById('investor-access-user-id').value);
    if (!userId) return;

    const selectedBranches = this._getCheckedBranchIds('investor-access-checkboxes');
    const selectedFeatures = [...document.querySelectorAll('.inv-feature-cb:checked')].map(cb => cb.value);

    if (!selectedBranches.length) {
      const ok = await showConfirm({
        title:       'Tidak ada cabang dipilih',
        message:     'Investor tidak akan dapat melihat data tanpa akses cabang. Lanjutkan?',
        confirmText: 'Tetap Simpan',
        danger:      false,
      });
      if (!ok) return;
    }
    if (!selectedFeatures.length) {
      const ok = await showConfirm({
        title:       'Tidak ada modul dipilih',
        message:     'Investor tidak akan dapat melihat data apapun tanpa modul aktif. Lanjutkan?',
        confirmText: 'Tetap Simpan',
        danger:      false,
      });
      if (!ok) return;
    }

    const saveBtn = document.getElementById('ia-save-btn');
    if (saveBtn) { saveBtn.disabled = true; saveBtn.textContent = 'Menyimpan...'; }

    try {
      const { error } = await db.rpc('admin_save_investor_access', {
        p_admin_id:   this.user.id,
        p_user_id:    userId,
        p_branch_ids: selectedBranches,
        p_features:   selectedFeatures,
      });
      if (error) throw error;
      this.closeModal('modal-investor-access');
      await this.loadInvestorAccess();
      showToast('Akses investor berhasil disimpan', 'success');
    } catch (e) {
      showDbError(e, { action: 'menyimpan akses investor', entity: 'Akses investor' });
    } finally {
      if (saveBtn) { saveBtn.disabled = false; saveBtn.textContent = 'Simpan Akses'; }
    }
  },

  // ── Bahan Baku / Ingredients ────────────────────────────────
  async loadIngredients() {
    const container = document.getElementById('ingredients-list');
    if (!container) return;
    await this._refreshIngredientsCache();
    const data = this.ingredients;

    // Load branch assignments untuk ditampilkan sebagai badge (non-fatal jika tabel belum ada)
    let assignMap = {};
    try {
      const { data: assignRows } = await db.from('branch_ingredient_assignments').select('ingredient_id, branch_id');
      for (const a of (assignRows || [])) {
        if (!assignMap[a.ingredient_id]) assignMap[a.ingredient_id] = [];
        assignMap[a.ingredient_id].push(a.branch_id);
      }
    } catch { /* tabel belum ada, badge tidak ditampilkan */ }
    const branchNameMap = {};
    for (const b of this.branches) branchNameMap[b.id] = b.name;

    container.innerHTML = data.length
      ? `<div class="admin-list">${data.map(ing => {
          const bids      = assignMap[ing.id] || [];
          const branchBadges = bids.length
            ? bids.map(bid => `<span class="badge badge-blue">${escHtml(branchNameMap[bid] || bid)}</span>`).join(' ')
            : `<span class="badge badge-orange">Semua Cabang</span>`;
          return `
          <div class="admin-list-card">
            <div class="list-card-icon green"><i data-lucide="leaf" class="icon"></i></div>
            <div class="list-card-info">
              <div class="list-card-title">${escHtml(ing.name)}</div>
              <div class="list-card-sub">Satuan: ${escHtml(ing.unit)}${ing.cost_price > 0 ? ' · Harga beli: ' + fRp(ing.cost_price) + '/' + escHtml(ing.unit) : ''}</div>
              <div class="flex gap-1 flex-wrap mt-1">${branchBadges}</div>
            </div>
            <div class="list-card-actions">
              <button class="btn btn-outline btn-sm" data-admin-action="open-ingredient-products" data-id="${ing.id}">Lihat Produk</button>
              <button class="btn btn-outline btn-sm" data-admin-action="open-edit-ingredient-modal" data-id="${ing.id}">Edit</button>
              <button class="btn btn-danger-soft btn-sm" data-admin-action="delete-ingredient" data-id="${ing.id}" data-name="${escHtml(ing.name)}">Hapus</button>
            </div>
          </div>`;
        }).join('')}</div>`
      : `<div class="empty-state">
          <div class="empty-icon"><i data-lucide="leaf" class="icon"></i></div>
          <div class="empty-title">Belum ada bahan baku</div>
          <div class="empty-desc">Tambahkan bahan baku untuk mengelola stok dan resep</div>
          <div class="empty-cta"><button class="btn btn-primary" data-admin-action="open-ingredient-modal">+ Tambah Bahan</button></div>
        </div>`;
  },

  async deleteIngredient(id, name) {
    const ok = await showConfirm({
      title:       `Hapus Bahan "${name}"?`,
      message:     'Ini akan menghapus data stok terkait.',
      confirmText: 'Ya, Hapus',
      danger:      true,
    });
    if (!ok) return;
    const { error } = await db.from('ingredients').delete().eq('id', id);
    if (error) { showDbError(error, { action: 'menghapus bahan', entity: 'Bahan baku' }); return; }
    await this._refreshIngredientsCache();
    if (this.currentSection === 'ingredients') await this.loadIngredients();
    if (this.currentSection === 'inventory')   await this.loadInventory();
    showToast('Bahan dihapus', 'success');
  },

  // ── Product variant management (inside product modal) ────────
  // _pendingVariants: temp storage for new variants before product is saved
  _pendingVariants: [],

  // BUG-10 FIX: openProductModal(null) fully resets all fields including hidden id and _pendingVariants
  async openProductModal(id = null) {
    this._pendingVariants = [];
    // Full reset regardless of new/edit to prevent stale data leaking between sessions
    document.getElementById('product-id').value         = id || '';
    document.getElementById('product-name').value       = '';
    document.getElementById('product-image-url').value  = '';
    document.getElementById('product-image-file').value = '';
    document.getElementById('product-category').value   = '';
    
    const imgPreview = document.getElementById('img-preview');
    imgPreview.classList.add('hidden');
    imgPreview.style.display = 'none';
    imgPreview.src = '';
    document.getElementById('upload-placeholder').style.display = 'block';
    document.getElementById('product-modal-title').textContent  = id ? 'Edit Produk' : 'Tambah Produk';
    this.renderPendingVariantRows();

    // Always show variant builder
    document.getElementById('add-variant-form').style.display = 'block';
    document.getElementById('product-variant-hint').textContent = '';

    // Render branch checkboxes
    const branchContainer = document.getElementById('product-branch-checkboxes');
    let branchProducts = [];
    if (id) {
      const { data } = await db.from('branch_products').select('branch_id').eq('product_id', id).eq('is_active', true);
      if (data) branchProducts = data.map(d => d.branch_id);
    }
    branchContainer.innerHTML = this.branches.map(b => `
      <label class="flex items-center gap-2 cursor-pointer p-2 hover:bg-alt rounded transition-colors">
        <input type="checkbox" class="product-branch-cb" value="${b.id}" ${(!id || branchProducts.includes(b.id)) ? 'checked' : ''} />
        <span>${escHtml(b.name)}</span>
      </label>
    `).join('') || '<div class="text-sm text-muted">Belum ada cabang</div>';

    // Reset product type toggle to default (variant)
    const radioVariant = document.getElementById('product-type-variant');
    const radioSimple  = document.getElementById('product-type-simple');
    const simpleSec    = document.getElementById('product-simple-price-section');
    const variantSec   = document.getElementById('product-variant-section');
    if (radioVariant) radioVariant.checked = true;
    if (radioSimple)  radioSimple.checked  = false;
    if (simpleSec)    simpleSec.style.display  = 'none';
    if (variantSec)   variantSec.style.display  = '';
    const defPriceEl = document.getElementById('product-default-price');
    if (defPriceEl) defPriceEl.value = '';

    if (id) {
      const p = (this._allProducts || this.products).find(x => Number(x.id) === id) || {};
      document.getElementById('product-name').value     = p.name     || '';
      document.getElementById('product-category').value = p.category || '';
      if (p.image_url) {
        document.getElementById('product-image-url').value  = p.image_url;
        const img = document.getElementById('img-preview');
        img.src = p.image_url;
        img.classList.remove('hidden');
        img.style.display = 'block';
        document.getElementById('upload-placeholder').style.display = 'none';
      }

      // Set simple/variant toggle based on product data
      const isSimple = p.has_variants === false;
      if (radioSimple)  radioSimple.checked  = isSimple;
      if (radioVariant) radioVariant.checked = !isSimple;
      if (simpleSec)    simpleSec.style.display  = isSimple ? '' : 'none';
      if (variantSec)   variantSec.style.display  = isSimple ? 'none' : '';
      if (isSimple && defPriceEl) defPriceEl.value = p.default_price || 0;

      await this.loadProductModalVariants(id);
    } else {
      // New product: start with one empty pending variant row
      this._pendingVariants = [{ name: '', price: '' }];
      this.renderPendingVariantRows();
    }
    openModal('modal-product');
  },

  async loadProductModalVariants(productId) {
    const container = document.getElementById('product-variants-list');
    const { data, error } = await db.from('product_variants').select('*').eq('product_id', productId).order('name');
    if (error) { container.innerHTML = '<div class="empty-td">Gagal memuat varian</div>'; return; }
    container.innerHTML = data?.length
      ? data.map(v => `
          <div class="panel-surface flex items-center gap-2 p-2 mb-1">
            <div class="flex-1">
              <div class="fw-600 text-sm">${escHtml(v.name)}</div>
              <div class="text-xs text-orange fw-700">${fRp(v.price)}</div>
            </div>
            <button class="btn btn-outline btn-sm" data-admin-action="edit-product-variant" data-id="${v.id}" data-name="${escHtml(v.name)}" data-price="${v.price}">Edit</button>
            <button class="btn btn-danger-soft btn-sm" data-admin-action="delete-product-variant" data-id="${v.id}" data-name="${escHtml(v.name)}">×</button>
          </div>`).join('')
      : '<div class="p-2 text-sm text-muted text-center">Belum ada varian — tambahkan di bawah</div>';
  },

  async addProductVariant() {
    const productId = document.getElementById('product-id').value;
    if (!productId) { showToast('Simpan produk dahulu', 'warning'); return; }
    const name  = document.getElementById('new-variant-name').value.trim();
    const price = parseFloat(document.getElementById('new-variant-price').value);
    if (!name || isNaN(price) || price < 0) { showToast('Isi nama dan harga varian', 'error'); return; }

    const { error } = await db.from('product_variants').insert({ product_id: parseInt(productId), name, price });
    if (error) { showDbError(error, { action: 'menambah varian', entity: 'Varian produk' }); return; }
    document.getElementById('new-variant-name').value  = '';
    document.getElementById('new-variant-price').value = '';
    await this.loadProductModalVariants(parseInt(productId));
    await this._refreshProductsCache();
    showToast('Varian ditambahkan', 'success');
  },

  async editProductVariant(variantId, currentName, currentPrice) {
    const newName = await showPrompt({ title: 'Edit Nama Varian', placeholder: 'Nama varian', defaultValue: currentName });
    if (newName === null) return;
    const newPriceStr = await showPrompt({ title: 'Edit Harga Varian', placeholder: 'Harga', defaultValue: String(currentPrice), inputType: 'number' });
    if (newPriceStr === null) return;
    const newPrice = parseFloat(newPriceStr);
    if (isNaN(newPrice) || newPrice < 0) { showToast('Harga tidak valid', 'error'); return; }
    const { error } = await db.from('product_variants').update({ name: newName.trim(), price: newPrice }).eq('id', variantId);
    if (error) { showDbError(error, { action: 'mengubah varian', entity: 'Varian produk' }); return; }
    const productId = document.getElementById('product-id').value;
    if (productId) await this.loadProductModalVariants(parseInt(productId));
    await this._refreshProductsCache();
    showToast('Varian diperbarui', 'success');
  },

  async deleteProductVariant(variantId, name) {
    const ok = await showConfirm({
      title:       `Hapus Varian "${name}"?`,
      message:     'Varian ini akan dihapus permanen dari daftar produk.',
      confirmText: 'Ya, Hapus',
      danger:      true,
    });
    if (!ok) return;
    const { error } = await db.from('product_variants').delete().eq('id', variantId);
    if (error) { showDbError(error, { action: 'menghapus varian', entity: 'Varian produk' }); return; }
    showToast('Varian dihapus', 'success');
    const productId = document.getElementById('product-id').value;
    if (productId) await this.loadProductModalVariants(parseInt(productId));
    await this.loadMasterData();
  },

  // ── Pending variants (inline create before product saved) ─────
  addPendingVariant() {
    this._pendingVariants.push({ name: '', price: '' });
    this.renderPendingVariantRows();
  },

  removePendingVariant(idx) {
    this._pendingVariants.splice(idx, 1);
    this.renderPendingVariantRows();
  },

  updatePendingVariant(idx, field, value) {
    if (this._pendingVariants[idx]) this._pendingVariants[idx][field] = value;
  },

  renderPendingVariantRows() {
    const container = document.getElementById('product-variants-list');
    if (!container) return;
    if (!this._pendingVariants.length) {
      container.innerHTML = '<div class="p-2 text-sm text-muted text-center">Belum ada varian — klik "+ Tambah Varian"</div>';
      return;
    }
    container.innerHTML = this._pendingVariants.map((v, i) => `
      <div class="pending-variant-row">
        <input type="text" class="form-control" placeholder="Nama varian (contoh: Original)" value="${escHtml(v.name)}"
          data-admin-input="update-pending-variant" data-index="${i}" data-field="name" />
        <div class="input-prefix-wrap" style="flex:0 0 140px">
          <span class="input-prefix">Rp</span>
          <input type="number" class="form-control" placeholder="0" value="${v.price}"
            data-admin-input="update-pending-variant" data-index="${i}" data-field="price" min="0" />
        </div>
        <button class="btn btn-danger-soft btn-sm" data-admin-action="remove-pending-variant" data-index="${i}" title="Hapus baris">×</button>
      </div>`).join('');
  },

  // ── Settings (receipt) ────────────────────────────────────────
  async loadSettings() {
    const sLocal = JSON.parse(localStorage.getItem('pos_settings') || '{}');
    const el = id => document.getElementById(id);
    if (el('setting-shop-name'))       el('setting-shop-name').value       = sLocal.shopName       || 'Roti Bakar Ngeunah';
    if (el('setting-receipt-header'))  el('setting-receipt-header').value  = sLocal.receiptHeader  || '';
    if (el('setting-receipt-footer'))  el('setting-receipt-footer').value  = sLocal.receiptFooter  || 'Terima kasih atas kunjungannya!';

    const defaultMethods = [
      { code: 'cash', label: 'Tunai', icon: '', is_active: true },
      { code: 'qris', label: 'QRIS', icon: '', is_active: true },
      { code: 'transfer', label: 'Transfer', icon: '', is_active: true }
    ];

    // Load payment methods from API; fall back to localStorage or defaults
    try {
      let { data, error } = await db.from('payment_methods').select('id, code, label, icon, fee_label, fee_percent, is_fee_enabled, is_active').order('id');
      const loadErrMsg = String(error?.message || '').toLowerCase();
      if (error && loadErrMsg.includes('is_fee_enabled')) {
        ({ data, error } = await db.from('payment_methods').select('id, code, label, icon, fee_label, fee_percent, is_active').order('id'));
      }
      if (error) throw error;
      if (Array.isArray(data) && data.length) {
        this.paymentMethods = data.map(m => ({
          id: m.id,
          code: m.code,
          label: m.label,
          icon: m.icon,
          fee_label: m.fee_label,
          fee_percent: parseFloat(m.fee_percent || 0),
          is_fee_enabled: m.is_fee_enabled === true || m.is_fee_enabled === 1 || m.is_fee_enabled === '1',
          is_active: m.is_active
        }));
      } else {
        // No rows in DB — use localStorage if present, otherwise seed with defaults
        this.paymentMethods = Array.isArray(sLocal.paymentMethods) && sLocal.paymentMethods.length ? sLocal.paymentMethods : defaultMethods;
        try {
          const payload = this.paymentMethods.map(m => ({ code: m.code, label: m.label, icon: m.icon, fee_label: m.fee_label || null, fee_percent: m.fee_percent || 0, is_fee_enabled: !!(m.is_fee_enabled || Number(m.fee_percent || 0) > 0), is_active: m.is_active ?? true }));
          await db.from('payment_methods').insert(payload);
        } catch (seedErr) {
          // ignore seed errors
          console.warn('Seed payment_methods failed', seedErr);
        }
      }
    } catch (e) {
      // If DB not available, fallback
      this.paymentMethods = Array.isArray(sLocal.paymentMethods) && sLocal.paymentMethods.length ? sLocal.paymentMethods : defaultMethods;
    }

    this.renderPaymentMethodsSettings();
    this.renderReceiptPreview();
  },

  async saveSettings() {
    const s = {
      shopName:      document.getElementById('setting-shop-name')?.value.trim()      || 'Roti Bakar Ngeunah',
      receiptHeader: document.getElementById('setting-receipt-header')?.value.trim() || '',
      receiptFooter: document.getElementById('setting-receipt-footer')?.value.trim() || '',
      paymentMethods: this.paymentMethods || []
    };
    // Keep a local copy for quick UI access (fallback)
    localStorage.setItem('pos_settings', JSON.stringify(s));

    // Persist payment methods to database: remove deleted, upsert existing
    try {
      const methods = this.paymentMethods || [];
      // Fetch existing codes
      const { data: existingData, error: selErr } = await db.from('payment_methods').select('code');
      if (selErr) throw selErr;
      const existingCodes = (existingData || []).map(r => r.code);
      const newCodes = methods.map(m => m.code);
      const toDelete = existingCodes.filter(c => !newCodes.includes(c));
      if (toDelete.length) {
        const { error: delErr } = await db.from('payment_methods').delete().in('code', toDelete);
        if (delErr) throw delErr;
      }

      const payloadFull = methods.map(m => ({ code: m.code, label: m.label, icon: m.icon, fee_label: m.fee_label || null, fee_percent: m.fee_percent || 0, is_fee_enabled: !!(m.is_fee_enabled || Number(m.fee_percent || 0) > 0), is_active: m.is_active ?? true }));
      try {
        const { error: upErr } = await db.from('payment_methods').upsert(payloadFull, { onConflict: 'code' });
        if (upErr) throw upErr;
        showToast('Pengaturan disimpan', 'success');
        return true;
      } catch (upErr) {
        // If the error mentions missing fee columns in the remote schema, retry without those fields
        const errMsg = upErr && (upErr.message || upErr.error) ? (upErr.message || upErr.error) : String(upErr || '');
        console.warn('Upsert failed, attempting fallback without fee fields:', errMsg);
        if (/fee_label|fee_percent|is_fee_enabled/.test(errMsg)) {
          const payloadFallback = methods.map(m => ({ code: m.code, label: m.label, icon: m.icon, is_active: m.is_active ?? true }));
          const { error: upErr2 } = await db.from('payment_methods').upsert(payloadFallback, { onConflict: 'code' });
          if (!upErr2) {
            showToast('Pengaturan disimpan (tanpa kolom fee) — DB schema belum diperbarui', 'warning');
            return true;
          }
          // if fallback also failed, fall through to outer catch
        }
        throw upErr;
      }
    } catch (e) {
      console.error('saveSettings error', e);
      showDbError(e, { action: 'menyimpan metode pembayaran', entity: 'Metode pembayaran' });
      return false;
    }
  },

  renderPaymentMethodsSettings() {
    const list = document.getElementById('payment-methods-list');
    if (!list) return;
    const methods = this.paymentMethods || [];
    if (!methods.length) { list.innerHTML = '<div class="text-muted">Belum ada metode pembayaran</div>'; return; }
    list.innerHTML = methods.map((m, i) => `
      <div class="flex items-center gap-2 p-2 border-b">
        <div class="flex-1">
          <div class="fw-700">${escHtml(m.label)}</div>
          <div class="text-xs text-muted">${escHtml(m.code)}
            ${m.fee_percent ? ' · +' + parseFloat(m.fee_percent).toString() + '%' : ''}
            ${m.fee_label   ? ' · ' + escHtml(m.fee_label) : ''}
          </div>
        </div>
        <div class="flex gap-2">
          <button class="btn btn-outline btn-sm" data-admin-action="edit-payment-method" data-index="${i}">Edit</button>
          <button class="btn btn-danger-soft btn-sm" data-admin-action="delete-payment-method" data-index="${i}">Hapus</button>
        </div>
      </div>`).join('');
  },

  saveReceiptSettings() {
    const sLocal = JSON.parse(localStorage.getItem('pos_settings') || '{}');
    sLocal.shopName = document.getElementById('setting-shop-name')?.value.trim() || 'Roti Bakar Ngeunah';
    sLocal.receiptHeader = document.getElementById('setting-receipt-header')?.value.trim() || '';
    sLocal.receiptFooter = document.getElementById('setting-receipt-footer')?.value.trim() || 'Terima kasih atas kunjungannya!';
    localStorage.setItem('pos_settings', JSON.stringify(sLocal));
    showToast('Pengaturan struk disimpan', 'success');
    this.renderReceiptPreview();
  },

  renderReceiptPreview() {
    const preview = document.getElementById('receipt-preview');
    if (!preview) return;
    const settings = JSON.parse(localStorage.getItem('pos_settings') || '{}');
    const shopName = settings.shopName || document.getElementById('setting-shop-name')?.value || 'Roti Bakar Ngeunah';
    const headerText = settings.receiptHeader || document.getElementById('setting-receipt-header')?.value || '';
    const footerText = settings.receiptFooter || document.getElementById('setting-receipt-footer')?.value || '';
    const date = new Date().toLocaleDateString('id-ID');
    // Sample items
    const items = [ { name: 'Roti Bakar Special', variant: 'Original', qty: 2, price: 12000 }, { name: 'Es Teh', variant: '-', qty: 1, price: 5000 } ];
    const subtotal = items.reduce((s,i)=>s + i.qty * i.price, 0);
    const total = subtotal;
    preview.innerHTML = `
      <div class="fw-800 text-lg mb-1">${escHtml(shopName)}</div>
      ${headerText ? headerText.split('\n').map(l => `<div class="text-xs text-muted">${escHtml(l)}</div>`).join('') : ''}
      <div class="text-xs text-muted mt-2 mb-2">${date}</div>
      <div class="dashed-border">
        ${items.map(it => `
          <div class="flex justify-between text-sm"><div>${escHtml(it.name)} ${escHtml(it.variant)}</div><div>${fRp(it.qty * it.price)}</div></div>
          <div class="text-xs text-muted">${it.qty} x ${fRp(it.price)}</div>
        `).join('')}
      </div>
      <div class="flex justify-between fw-700">Subtotal <span>${fRp(subtotal)}</span></div>
      <div class="flex justify-between fw-800 text-lg mt-1">TOTAL <span>${fRp(total)}</span></div>
      <div class="dashed-border-top text-xs text-muted">${footerText.split('\n').map(l => escHtml(l)).join('<br>')}</div>`;
  },

  async addPaymentMethod() {
    const labelEl = document.getElementById('pm-label');
    const toggleEl = document.getElementById('pm-add-fee-toggle');
    const feeLabelEl = document.getElementById('pm-fee-label');
    const feePercentEl = document.getElementById('pm-fee-percent');
    if (!labelEl) return;
    const label = (labelEl.value || '').trim();
    const is_fee_enabled = toggleEl ? toggleEl.checked : false;
    const fee_label = is_fee_enabled ? (feeLabelEl?.value || '').trim() : null;
    const fee_percent = is_fee_enabled ? (parseFloat(feePercentEl?.value) || 0) : 0;
    if (!label) { showToast('Label metode harus diisi', 'error'); return; }

    // Slugify label to create a code, ensure uniqueness (memory + DB)
    const slugify = s => String(s || '').toLowerCase().normalize('NFKD').replace(/[^a-z0-9\-\s_]/g, '').trim().replace(/[\s_]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 90) || '';
    let base = slugify(label) || ('pm_' + Date.now());
    let code = base;
    let suffix = 1;

    this.paymentMethods = this.paymentMethods || [];
    // avoid duplicates in-memory
    while (this.paymentMethods.find(m => m.code === code)) {
      code = base + '_' + suffix; suffix++;
    }

    // try ensure uniqueness in DB as well (best-effort). If DB check fails, we fall back to memory-only uniqueness.
    try {
      let exists = true;
      while (exists) {
        const { data, error } = await db.from('payment_methods').select('code').eq('code', code).maybeSingle();
        if (error) { console.warn('payment method uniqueness check failed', error); break; }
        if (!data) { exists = false; break; }
        code = base + '_' + suffix; suffix++;
      }
    } catch (err) {
      console.warn('Could not verify code uniqueness in DB', err);
    }

    this.paymentMethods.push({ code, label, fee_label: fee_label || null, fee_percent: fee_percent, is_fee_enabled });
    labelEl.value = ''; 
    if (feeLabelEl) feeLabelEl.value = ''; 
    if (feePercentEl) feePercentEl.value = '';
    if (toggleEl) { toggleEl.checked = false; document.getElementById('pm-add-fee-container').style.display = 'none'; }
    this.renderPaymentMethodsSettings();
    const saved = await this.saveSettings();
    if (saved) showToast('Metode pembayaran ditambahkan', 'success');
    else showToast('Metode ditambahkan (tersimpan lokal), gagal sinkron ke DB', 'warning');
  },

  // ── Danger Zone: Reset Data ──────────────────────────────────
  openResetModal() {
    const input = document.getElementById('reset-confirm-input');
    if (input) input.value = '';
    openModal('modal-reset-data');
  },

  async confirmReset() {
    const input = document.getElementById('reset-confirm-input')?.value;
    if (input !== 'RESET') { showToast('Ketik RESET dengan benar', 'error'); return; }

    const btn = document.getElementById('btn-confirm-reset');
    btn.disabled = true;
    btn.textContent = 'Menghapus...';
    showLoader();

    // ────────────────────────────────────────────────────────────
    // URUTAN: child → parent (FK dependency)
    // Semua tabel direset.
    // users: SEMUA dihapus KECUALI akun admin yang sedang login
    //        (agar tidak terkunci setelah reload).
    // ────────────────────────────────────────────────────────────
    const tables = [
      // ── 1. Purchase (child paling dalam) ──────────────────
      'purchase_items',        // FK → purchase_orders, ingredients
      // ── 2. Transaksi & Kas ────────────────────────────────
      'refund_transactions',   // FK → transactions
      'transaction_items',     // FK → transactions
      'cash_logs',             // FK → cashier_sessions, cash_categories, branches, users
      'transactions',          // FK → cashier_sessions, branches, users
      'cashier_sessions',      // FK → branches, users
      // ── 3. Inventori ──────────────────────────────────────
      'inventory_logs',        // FK → branch_inventory, ingredients, branches, users
      'branch_inventory',      // FK → branches, ingredients
      // ── 4. Resep / BOM ────────────────────────────────────
      'recipe_items',          // FK → recipes, ingredients
      'recipes',               // FK → product_variants
      // ── 5. Produk ─────────────────────────────────────────
      'branch_variant_prices', // FK → branches, product_variants
      'branch_products',       // FK → branches, products
      'product_variants',      // FK → products
      'products',              // FK → product_categories
      'product_categories',    // independent
      // ── 6. Purchase Orders (setelah child-nya) ────────────
      'purchase_orders',       // FK → branches, suppliers, users
      // ── 7. Master data independen ─────────────────────────
      'ingredients',           // independent — dihapus setelah semua FK child
      'cash_categories',       // independent
      'payment_methods',       // independent
      'suppliers',             // independent — dihapus setelah purchase_orders
      // ── 8. Users/Staff (kecuali admin yg sedang login) ───
      // Ditangani secara terpisah di bawah (pakai .neq filter)
      // ── 9. Branches/Outlet (paling terakhir) ─────────────
      'branches',              // dihapus setelah SEMUA FK child bersih
    ];

    const errors = [];
    try {
      // ── Step 0: Nullify nullable FKs agar tidak FK violation ──
      // users.branch_id → branches (nullable)
      try {
        await db.from('users').update({ branch_id: null }).not('id', 'is', null);
      } catch(e) { console.warn('[reset] nullify users.branch_id:', e.message); }

      // ── Step 1: Hapus semua tabel dalam urutan FK ──────────────
      for (const t of tables) {
        btn.textContent = `Menghapus ${t}...`;
        try {
          const { error } = await db.from(t).delete().not('id', 'is', null);
          if (error) {
            const isNotExist = /does not exist|relation.*not found|undefined table/i.test(error.message);
            if (isNotExist) {
              console.info(`[reset] "${t}" tidak ada di DB — dilewati.`);
            } else {
              console.warn(`[reset] ${t}:`, error.message);
              errors.push(`${t}: ${error.message}`);
            }
          }
        } catch(e) {
          const isNotExist = /does not exist|relation.*not found|undefined table/i.test(e.message);
          if (isNotExist) {
            console.info(`[reset] "${t}" tidak ada di DB — dilewati.`);
          } else {
            console.error(`[reset] ${t}:`, e);
            errors.push(`${t}: ${e.message}`);
          }
        }
      }

      // ── Step 2: Hapus users/staff KECUALI admin yang sedang login ──
      btn.textContent = 'Menghapus users...';
      try {
        const currentUserId = this.user?.id;
        let q = db.from('users').delete();
        // Jika ada ID admin aktif, jangan hapus dirinya sendiri
        if (currentUserId) {
          q = q.neq('id', currentUserId);
        } else {
          q = q.not('id', 'is', null);
        }
        const { error } = await q;
        if (error) {
          const isNotExist = /does not exist|relation.*not found|undefined table/i.test(error.message);
          if (!isNotExist) { console.warn('[reset] users:', error.message); errors.push(`users: ${error.message}`); }
        }
      } catch(e) { console.warn('[reset] users exception:', e.message); errors.push(`users: ${e.message}`); }

      // ── Toast hasil ───────────────────────────────────────────
      if (errors.length === 0) {
        showToast('Semua data berhasil direset ✓', 'success');
      } else if (errors.length < tables.length + 1) {
        showToast(`Reset selesai (${errors.length} error) — cek konsol browser`, 'warning');
        console.warn('[reset] Error detail:', errors);
      } else {
        showToast('Reset gagal — cek permission di database atau log PHP', 'error');
        console.error('[reset] Semua tabel gagal:', errors);
      }

    } finally {
      // Selalu jalankan cleanup agar spinner tidak stuck
      closeModal('modal-reset-data');
      document.getElementById('page-loader').style.display = 'none';
      btn.disabled = false;
      btn.textContent = 'Reset Data';
      setTimeout(() => location.reload(), 1200);
    }
  },

  async editPaymentMethod(idx) {
    const m = (this.paymentMethods || [])[idx];
    if (!m) return;
    const newLabel = await showPrompt({ title: 'Edit Label Metode', message: 'Label yang ditampilkan di kasir', placeholder: 'Contoh: Tunai', defaultValue: m.label });
    if (newLabel === null) return;
    const newFeeLabel = await showPrompt({ title: 'Nama Biaya Tambahan', message: 'Kosongkan jika tidak ada biaya', placeholder: 'Contoh: Biaya Admin', defaultValue: m.fee_label || '' });
    if (newFeeLabel === null) return;
    const newFeePercentStr = await showPrompt({ title: 'Persentase Biaya (%)', message: 'Isi 0 jika tidak ada biaya', placeholder: '0', defaultValue: String(m.fee_percent || 0), inputType: 'number' });
    if (newFeePercentStr === null) return;
    const pct = parseFloat(newFeePercentStr);
    m.label = newLabel.trim() || m.label;
    m.fee_label = (newFeeLabel || '').trim() || null;
    m.fee_percent = isNaN(pct) ? (m.fee_percent || 0) : pct;
    m.is_fee_enabled = !!(m.fee_label || Number(m.fee_percent || 0) > 0);
    this.renderPaymentMethodsSettings();
    const saved = await this.saveSettings();
    if (saved) showToast('Metode diperbarui', 'success');
    else showToast('Perubahan disimpan lokal, gagal sinkron ke DB', 'warning');
  },

  async deletePaymentMethod(idx) {
    const m = (this.paymentMethods || [])[idx];
    if (!m) return;
    const ok = await showConfirm({
      title:       `Hapus Metode "${m.label}"?`,
      message:     'Metode pembayaran ini akan dihapus dari sistem.',
      confirmText: 'Ya, Hapus',
      danger:      true,
    });
    if (!ok) return;
    this.paymentMethods.splice(idx, 1);
    this.renderPaymentMethodsSettings();
    const saved = await this.saveSettings();
    if (saved) showToast('Metode dihapus', 'success');
    else showToast('Perubahan disimpan lokal, gagal sinkron ke DB', 'warning');
  },

  closeModal(id) { closeModal(id); },
  hideLoader()   { document.getElementById('page-loader').style.display = 'none'; },

  // ── Cash Categories CRUD ──────────────────────────────────────
  async loadCashCategories() {
    const container = document.getElementById('cash-categories-list');
    if (!container) return;
    const cats = await cashService.getCategories();
    container.innerHTML = cats.length
      ? `<div class="admin-list">${cats.map(c => `
          <div class="admin-list-card">
            <div class="list-card-icon"><i data-lucide="${c.type === 'in' ? 'trending-up' : 'trending-down'}" class="icon"></i></div>
            <div class="list-card-info">
              <div class="list-card-title">${escHtml(c.name)}</div>
              <div class="list-card-sub"><span class="badge ${c.type === 'in' ? 'badge-green' : 'badge-red'}">${c.type === 'in' ? 'Masuk' : 'Keluar'}</span></div>
            </div>
            <div class="list-card-actions">
              <button class="btn btn-outline btn-sm" data-admin-action="open-cash-category-modal" data-id="${c.id}" data-name="${escHtml(c.name)}" data-type="${c.type}">Edit</button>
              <button class="btn btn-danger-soft btn-sm" data-admin-action="delete-cash-category" data-id="${c.id}" data-name="${escHtml(c.name)}">Hapus</button>
            </div>
          </div>`).join('')}</div>`
      : '<div class="empty-state"><div class="empty-title">Belum ada kategori kas</div></div>';
    if (window.lucide) lucide.createIcons();
  },

  openCashCategoryModal(id = null, name = '', type = 'in') {
    document.getElementById('cash-cat-id').value   = id || '';
    document.getElementById('cash-cat-name').value = name;
    document.getElementById('cash-cat-type').value = type;
    document.getElementById('cash-cat-modal-title').textContent = id ? 'Edit Kategori' : 'Tambah Kategori';
    openModal('modal-cash-category');
  },

  async saveCashCategory() {
    const id   = document.getElementById('cash-cat-id').value;
    const name = document.getElementById('cash-cat-name').value.trim();
    const type = document.getElementById('cash-cat-type').value;
    if (!name) { showToast('Nama kategori wajib diisi', 'error'); return; }
    try {
      await cashService.saveCategory({ id: id || null, name, type });
      this.closeModal('modal-cash-category');
      await this.loadCashCategories();
      showToast('Kategori disimpan', 'success');
    } catch (e) { showDbError(e, { action: 'menyimpan kategori kas', entity: 'Kategori kas' }); }
  },

  async deleteCashCategory(id, name) {
    const ok = await showConfirm({
      title:       `Hapus Kategori "${name}"?`,
      message:     'Kategori ini akan dihapus permanen.',
      confirmText: 'Ya, Hapus',
      danger:      true,
    });
    if (!ok) return;
    try {
      await cashService.deleteCategory(id);
      await this.loadCashCategories();
      showToast('Kategori dihapus', 'success');
    } catch (e) { showDbError(e, { action: 'menghapus kategori kas', entity: 'Kategori kas' }); }
  },

  // ── Branch Cash (Kas Outlet) ──────────────────────────────────
  loadBranchCash() {
    if (window.adminBranchCashUi) {
      adminBranchCashUi.load();
    }
  },

  // ── Finance Integration (Portal Integrasi Kas Keluar) ─────────
  loadFinanceIntegration() {
    if (window.adminFinanceIntegrationUi) {
      adminFinanceIntegrationUi.populateBranchSelect(this.branches);
      adminFinanceIntegrationUi.load();
    }
  },

  // ── Transfer Monitoring (Admin: lihat semua transfer) ─────────
  async loadTransferMonitoring() {
    const tbody  = document.getElementById('transfer-monitoring-body');
    const status = document.getElementById('transfer-status-filter')?.value || null;
    if (!tbody) return;
    tbody.innerHTML = '<tr><td colspan="8" class="empty-td">Memuat...</td></tr>';
    try {
      const transfers = await inventoryService.getAllTransfersAdmin(100, 0, status || null);
      if (!transfers.length) {
        tbody.innerHTML = '<tr><td colspan="8" class="empty-td">Tidak ada data transfer.</td></tr>';
        return;
      }
      const statusCfg = {
        pending:   { label: 'Menunggu',   cls: 'badge-orange' },
        confirmed: { label: 'Selesai',    cls: 'badge-green'  },
        rejected:  { label: 'Ditolak',    cls: 'badge-red'    },
        cancelled: { label: 'Dibatalkan', cls: 'badge-default' }
      };
      tbody.innerHTML = transfers.map(t => {
        const sc      = statusCfg[t.status] || { label: t.status, cls: 'badge-default' };
        const dateStr = new Date(t.created_at).toLocaleString('id-ID', { day:'2-digit', month:'short', year:'numeric', hour:'2-digit', minute:'2-digit' });
        const items   = (t.items || []).map(i => `${escHtml(i.ingredient_name)}: ${parseFloat(i.qty).toLocaleString('id-ID')} ${escHtml(i.unit)}`).join('; ');
        const actions = t.status === 'pending'
          ? `<button class="btn btn-primary btn-sm" style="font-size:11px;" data-admin-action="admin-confirm-transfer" data-id="${t.id}">Terima</button>
             <button class="btn btn-sm" style="font-size:11px;border:1px solid var(--danger);color:var(--danger);background:transparent;margin-left:4px;" data-admin-action="admin-reject-transfer" data-id="${t.id}">Tolak</button>`
          : '—';
        return `<tr>
          <td><span style="font-weight:700;color:var(--primary);font-size:12px;">${escHtml(t.transfer_code)}</span></td>
          <td style="font-size:12px;">${dateStr}</td>
          <td style="font-size:12px;">${escHtml(t.from_branch_name)}</td>
          <td style="font-size:12px;">${escHtml(t.to_branch_name)}</td>
          <td style="font-size:11px;max-width:200px;">${escHtml(items)}</td>
          <td><span class="badge ${sc.cls}" style="font-size:11px;">${sc.label}</span></td>
          <td style="font-size:12px;">${escHtml(t.created_by_name || '—')}</td>
          <td style="font-size:12px;">${escHtml(t.confirmed_by_name || t.rejected_by_name || '—')}</td>
        </tr>`;
      }).join('');
      if (window.lucide) lucide.createIcons();
    } catch (e) {
      tbody.innerHTML = `<tr><td colspan="8" class="empty-td" style="color:var(--danger);">Gagal memuat: ${escHtml(e.message)}</td></tr>`;
    }
  },

  async adminConfirmTransfer(transferId) {
    const ok = await showConfirm({
      title:       'Konfirmasi Transfer?',
      message:     'Konfirmasi penerimaan transfer ini atas nama outlet tujuan? Stok outlet tujuan akan bertambah.',
      confirmText: 'Ya, Konfirmasi',
    });
    if (!ok) return;
    try {
      const code = await inventoryService.confirmTransfer({ transferId, userId: this.user.id });
      showToast(`Transfer ${code} dikonfirmasi.`, 'success');
      this.loadTransferMonitoring();
    } catch (e) {
      showToast('Gagal konfirmasi: ' + e.message, 'error');
    }
  },

  async adminRejectTransfer(transferId) {
    const reason = await showPrompt({
      title:       'Tolak Transfer',
      message:     'Alasan penolakan (opsional):',
      placeholder: 'Contoh: Barang tidak sesuai',
      confirmText: 'Tolak',
    });
    if (reason === null) return;
    try {
      const code = await inventoryService.rejectTransfer({ transferId, userId: this.user.id, reason });
      showToast(`Transfer ${code} ditolak. Stok pengirim dikembalikan.`, 'success');
      this.loadTransferMonitoring();
    } catch (e) {
      showToast('Gagal menolak: ' + e.message, 'error');
    }
  },

  // ── Cash Report ───────────────────────────────────────────────
  // BUG-13 FIX: Show informative empty-state when no branch is selected
  async loadCashReport() {
    const dateFromEl = document.getElementById('cash-report-date-from');
    const dateToEl   = document.getElementById('cash-report-date-to');
    const branchEl   = document.getElementById('cash-report-branch');
    if (!dateFromEl) return;
    if (!dateFromEl.value) {
      const today = fmt.getBusinessDate();
      dateFromEl.value = today;
      dateToEl.value   = today;
    }

    if (branchEl && branchEl.options.length <= 1 && this.branches?.length) {
      branchEl.innerHTML = '<option value="">-- Pilih Cabang --</option>' +
        this.branches.map(b => `<option value="${b.id}">${escHtml(b.name)}</option>`).join('');
    }

    const branchId = branchEl?.value || '';
    const dateFrom = dateFromEl.value;
    const dateTo   = dateToEl.value;

    const balEl  = document.getElementById('cash-balance-status');
    const sumEl  = document.getElementById('cash-report-summary');
    const tabsEl = document.getElementById('cash-detail-tabs');

    if (!branchId) {
      if (balEl)  balEl.innerHTML  = '';
      if (sumEl)  sumEl.innerHTML  = `<div class="empty-state"><div class="empty-icon">📋</div><div class="empty-title">Pilih cabang dan tanggal untuk melihat laporan kas</div></div>`;
      if (tabsEl) tabsEl.style.display = 'none';
      document.getElementById('cash-tab-in').style.display  = '';
      document.getElementById('cash-tab-out').style.display = 'none';
      document.getElementById('cash-tab-all').style.display = 'none';
      ['cash-tab-in-body','cash-tab-out-body'].forEach(id => {
        const el = document.getElementById(id);
        if (el) el.innerHTML = '<tr><td colspan="6" class="empty-td">— Belum ada cabang dipilih —</td></tr>';
      });
      const allBody = document.getElementById('cash-report-body');
      if (allBody) allBody.innerHTML = '<tr><td colspan="7" class="empty-td">— Belum ada cabang dipilih —</td></tr>';
      return;
    }

    // Loading state
    if (balEl) balEl.innerHTML = '<div class="text-muted text-sm" style="padding:8px 0">Memuat data kas...</div>';
    ['cash-tab-in-body','cash-tab-out-body'].forEach(id => {
      const el = document.getElementById(id);
      if (el) el.innerHTML = '<tr><td colspan="6" class="empty-td">Memuat...</td></tr>';
    });
    const allBody = document.getElementById('cash-report-body');
    if (allBody) allBody.innerHTML = '<tr><td colspan="7" class="empty-td">Memuat...</td></tr>';

    try {
      const [summary, logs] = await Promise.all([
        cashService.getSummary({ branchId: parseInt(branchId), dateFrom, dateTo }),
        cashService.getLogs({ branchId: parseInt(branchId), dateFrom, dateTo, includeVoided: true })
      ]);

      const { openingCash, salesIn, manualIn, manualOut, refundOut, voidOut, depositOut = 0, expectedCash } = summary;
      const totalMasuk  = salesIn + manualIn;
      const totalKeluar = manualOut + refundOut + voidOut;
      const isOk = expectedCash >= 0;
      const statusClass = isOk ? 'ok' : 'warn';

      // ── Balance card ───────────────────────────────────────
      if (balEl) balEl.innerHTML = `
        <div class="cash-balance-card ${statusClass}">
          <div class="cbc-icon">${isOk ? '✅' : '⚠️'}</div>
          <div class="cbc-main">
            <div class="cbc-label">${isOk ? 'Saldo Kas Berjalan' : 'Perhatian — Saldo Minus'}</div>
            <div class="cbc-amount ${statusClass}">${fRp(expectedCash)}</div>
          </div>
          <div class="cbc-formula">
            <div class="cbf-item">
              <div class="cbf-val">${fRp(openingCash)}</div>
              <div class="cbf-lbl">Kas Awal</div>
            </div>
            <div class="cbf-op">+</div>
            <div class="cbf-item">
              <div class="cbf-val text-green">+${fRp(totalMasuk)}</div>
              <div class="cbf-lbl">Total Masuk</div>
            </div>
            <div class="cbf-op">−</div>
            <div class="cbf-item">
              <div class="cbf-val text-danger">−${fRp(totalKeluar)}</div>
              <div class="cbf-lbl">Total Keluar</div>
            </div>
            <div class="cbf-op">=</div>
            <div class="cbf-item">
              <div class="cbf-val fw-700 ${statusClass === 'ok' ? 'text-green' : 'text-danger'}" style="font-size:16px">${fRp(expectedCash)}</div>
              <div class="cbf-lbl">Saldo</div>
            </div>
          </div>
        </div>`;

      // ── Summary stats ──────────────────────────────────────
      if (sumEl) sumEl.innerHTML = `
        <div class="stat-card"><div class="stat-label">Kas Awal</div><div class="stat-value">${fRp(openingCash)}</div></div>
        <div class="stat-card"><div class="stat-label">Penjualan Tunai</div><div class="stat-value text-green">+${fRp(salesIn)}</div></div>
        <div class="stat-card"><div class="stat-label">Kas Masuk Manual</div><div class="stat-value text-green">+${fRp(manualIn)}</div></div>
        <div class="stat-card"><div class="stat-label">Kas Keluar Manual</div><div class="stat-value text-danger">−${fRp(manualOut)}</div></div>
        <div class="stat-card"><div class="stat-label">Refund</div><div class="stat-value text-danger">−${fRp(refundOut)}</div></div>
        ${voidOut > 0 ? `<div class="stat-card"><div class="stat-label">Void</div><div class="stat-value text-danger">−${fRp(voidOut)}</div></div>` : ''}
        ${depositOut > 0 ? `<div class="stat-card"><div class="stat-label">Setoran Outlet</div><div class="stat-value text-danger">−${fRp(depositOut)}</div><div class="stat-hint">Di luar expected shift</div></div>` : ''}
        <div class="stat-card stat-card-hero"><div class="stat-label">Saldo Ekspektasi</div><div class="stat-value">${fRp(expectedCash)}</div></div>`;

      // ── Show tabs & reset to first tab ────────────────────
      if (tabsEl) {
        tabsEl.style.display = '';
        tabsEl.querySelectorAll('.inner-tab').forEach((t, i) => t.classList.toggle('active', i === 0));
      }
      document.getElementById('cash-tab-in').style.display  = '';
      document.getElementById('cash-tab-out').style.display = 'none';
      document.getElementById('cash-tab-all').style.display = 'none';

      // ── Render table rows ─────────────────────────────────
      const validLogs = logs || [];
      const logsIn    = validLogs.filter(l => l.type === 'in');
      const logsOut   = validLogs.filter(l => l.type === 'out');

      const rowIn = l => `
        <tr class="${l.is_void ? 'opacity-50' : ''}">
          <td class="text-xs nowrap">${fDate(l.created_at)}</td>
          <td>${escHtml(l.cash_categories?.name || '—')}</td>
          <td class="fw-700 text-green">+${fRp(l.amount)}</td>
          <td class="text-xs">${escHtml(l.note || '—')}</td>
          <td>${escHtml(l.creator?.name || '—')}</td>
          <td>${l.is_void
            ? `<span class="badge badge-red">VOID${l.voider?.name ? ' oleh ' + escHtml(l.voider.name) : ''}</span>`
            : `<button class="btn btn-danger-soft btn-sm" data-admin-action="void-cash-log" data-id="${l.id}">Void</button>`}</td>
        </tr>`;

      const rowOut = l => `
        <tr class="${l.is_void ? 'opacity-50' : ''}">
          <td class="text-xs nowrap">${fDate(l.created_at)}</td>
          <td>${escHtml(l.cash_categories?.name || '—')}</td>
          <td class="fw-700 text-danger">−${fRp(l.amount)}</td>
          <td class="text-xs">${escHtml(l.note || '—')}</td>
          <td>${escHtml(l.creator?.name || '—')}</td>
          <td>${l.is_void
            ? `<span class="badge badge-red">VOID${l.voider?.name ? ' oleh ' + escHtml(l.voider.name) : ''}</span>`
            : `<button class="btn btn-danger-soft btn-sm" data-admin-action="void-cash-log" data-id="${l.id}">Void</button>`}</td>
        </tr>`;

      const rowAll = l => `
        <tr class="${l.is_void ? 'opacity-50' : ''}">
          <td class="text-xs nowrap">${fDate(l.created_at)}</td>
          <td><span class="badge ${l.type === 'in' ? 'badge-green' : 'badge-red'}">${l.type === 'in' ? 'Masuk' : 'Keluar'}</span></td>
          <td>${escHtml(l.cash_categories?.name || '—')}</td>
          <td class="fw-700 ${l.type === 'in' ? 'text-green' : 'text-danger'}">${l.type === 'in' ? '+' : '−'}${fRp(l.amount)}</td>
          <td class="text-xs">${escHtml(l.note || '—')}</td>
          <td>${escHtml(l.creator?.name || '—')}</td>
          <td>${l.is_void
            ? `<span class="badge badge-red">VOID${l.voider?.name ? ' oleh ' + escHtml(l.voider.name) : ''}</span>`
            : `<button class="btn btn-danger-soft btn-sm" data-admin-action="void-cash-log" data-id="${l.id}">Void</button>`}</td>
        </tr>`;

      const inBody  = document.getElementById('cash-tab-in-body');
      const outBody = document.getElementById('cash-tab-out-body');
      if (inBody)  inBody.innerHTML  = logsIn.length  ? logsIn.map(rowIn).join('')   : '<tr><td colspan="6" class="empty-td">Tidak ada kas masuk pada periode ini</td></tr>';
      if (outBody) outBody.innerHTML = logsOut.length ? logsOut.map(rowOut).join('') : '<tr><td colspan="6" class="empty-td">Tidak ada kas keluar pada periode ini</td></tr>';
      if (allBody) allBody.innerHTML = validLogs.length ? validLogs.map(rowAll).join('') : '<tr><td colspan="7" class="empty-td">Tidak ada data kas pada periode ini</td></tr>';

    } catch (e) {
      showToast('Gagal memuat laporan kas: ' + e.message, 'error');
    }
  },

  switchCashTab(tab, el) {
    document.querySelectorAll('#section-cash-report .inner-tab').forEach(t => t.classList.remove('active'));
    if (el) el.classList.add('active');
    document.getElementById('cash-tab-in').style.display  = tab === 'in'  ? '' : 'none';
    document.getElementById('cash-tab-out').style.display = tab === 'out' ? '' : 'none';
    document.getElementById('cash-tab-all').style.display = tab === 'all' ? '' : 'none';
  },

  async voidCashLog(logId) {
    const reason = await showPrompt({
      title:       'Alasan Void Kas',
      message:     'Berikan alasan pembatalan log kas ini.',
      placeholder: 'Contoh: Input salah',
      confirmText: 'Lanjutkan',
    });
    if (!reason?.trim()) return;
    const ok = await showConfirm({
      title:       'Void Log Kas?',
      message:     'Log kas ini akan dibatalkan.',
      confirmText: 'Ya, Void',
      danger:      true,
    });
    if (!ok) return;
    try {
      await cashService.voidLog({ logId, reason: reason.trim(), voidedBy: this.user.id });
      showToast('Cash log di-void', 'success');
      this.loadCashReport();
    } catch (e) { showDbError(e, { action: 'membatalkan log kas', entity: 'Log kas' }); }
  },

  async confirmLogout() {
    const ok = await showConfirm({
      title:       'Yakin ingin keluar?',
      message:     'Sesi admin akan diakhiri.',
      confirmText: 'Ya, Keluar',
      danger:      true,
      icon:        '🚪'
    });
    if (ok) auth.logout();
  },

  // ── Bulk Menu Import / Template ───────────────────────────

  // Helper: switch visible state panel inside modal-bulk-import
  _bulkShowState(state) {
    ['parsing','preview','importing','done'].forEach(s => {
      const el = document.getElementById(`bulk-state-${s}`);
      if (el) el.classList.toggle('hidden', s !== state);
    });
  },

  // Wire up the bulk import modal close / cancel buttons (called once after DOM ready)
  _bulkModalInit() {
    if (this._bulkModalWired) return;
    this._bulkModalWired = true;
    const overlay = document.getElementById('modal-bulk-import');
    const closeX  = document.getElementById('btn-bulk-close-x');
    const cancel  = document.getElementById('btn-bulk-cancel');
    const done    = document.getElementById('btn-bulk-done');
    const hide = () => { if (overlay) overlay.classList.remove('active'); };
    [closeX, cancel, done].forEach(btn => btn && btn.addEventListener('click', hide));

    // Drag-and-drop on the dropzone
    const dz = document.getElementById('bulk-dropzone');
    const fi = document.getElementById('bulk-import-file');
    if (dz && fi) {
      dz.addEventListener('dragover',  e => { e.preventDefault(); dz.classList.add('drag-over'); });
      dz.addEventListener('dragleave', () => dz.classList.remove('drag-over'));
      dz.addEventListener('drop', e => {
        e.preventDefault(); dz.classList.remove('drag-over');
        const file = e.dataTransfer?.files?.[0];
        if (file) { const dt = new DataTransfer(); dt.items.add(file); fi.files = dt.files; fi.dispatchEvent(new Event('change', { bubbles: true })); }
      });
    }
  },

  async downloadMenuTemplate() {
    const btn = document.getElementById('btn-download-menu-template');
    if (btn) { btn.disabled = true; btn.textContent = 'Memuat...'; }
    try {
      if (!window.XLSX) throw new Error('Library SheetJS belum dimuat');
      const { data: branches } = await db.from('branches').select('*').order('name');
      const branchNames = this._activeBranches(branches).map(b => b.name);

      const header = ['product_name','variant_name','default_price','category','sku', ...branchNames];
      // Example rows — 1 sample per branch to show the override concept
      const mk = (p,v,dp,cat,...prices) => [p,v,dp,cat,'', ...prices];
      const bFill = (arr, len) => { while (arr.length < len) arr.push(''); return arr; };
      const sampleRows = [
        mk('Roti Bakar Coklat','Kecil',14000,'Roti Bakar', ...bFill([13000],branchNames.length)),
        mk('Roti Bakar Coklat','Besar',20000,'Roti Bakar', ...bFill([19000],branchNames.length)),
        mk('Roti Bakar Keju','Kecil',14000,'Roti Bakar',  ...bFill([],branchNames.length)),
        mk('Roti Bakar Keju','Besar',20000,'Roti Bakar',  ...bFill([],branchNames.length)),
        mk('Roti Bakar Strawberry','Kecil',12000,'Roti Bakar',...bFill([],branchNames.length)),
        mk('Roti Bakar Strawberry','Besar',16000,'Roti Bakar',...bFill([],branchNames.length)),
        mk('Kopi Hitam','Hot',10000,'Minuman',            ...bFill([],branchNames.length)),
        mk('Kopi Hitam','Ice',12000,'Minuman',            ...bFill([],branchNames.length)),
      ];

      const aoa = [header, ...sampleRows];
      const ws  = XLSX.utils.aoa_to_sheet(aoa);

      // Style header row (column widths)
      ws['!cols'] = header.map((h,i) => ({ wch: i < 5 ? 24 : 18 }));

      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, ws, 'menu_import');

      // Second sheet: instructions
      const instrRows = [
        ['PANDUAN PENGISIAN TEMPLATE BULK IMPORT MENU'],
        [''],
        ['Kolom Wajib:'],
        ['  product_name  — Nama produk (string). Jika sudah ada di DB, varian akan di-update/ditambah.'],
        ['  variant_name  — Nama varian (string). Misal: Kecil, Besar, Hot, Ice.'],
        ['  default_price — Harga jual global (angka tanpa titik/koma). Contoh: 15000'],
        [''],
        ['Kolom Opsional:'],
        ['  category — Kategori produk (string).'],
        ['  sku      — Kode SKU (string).'],
        [''],
        ['Kolom Harga Per-Cabang (warna orange):'],
        ...branchNames.map(b => [`  ${b} — Harga override khusus cabang ini. Kosongkan = pakai default_price.`]),
        [''],
        ['Catatan:'],
        ['  • Produk & varian baru dibuat otomatis jika nama belum ada.'],
        ['  • Nama produk/varian sama persis = update harga (tidak duplikat).'],
        ['  • Kolom cabang yang kosong tidak memengaruhi harga default.'],
      ];
      const ws2 = XLSX.utils.aoa_to_sheet(instrRows);
      ws2['!cols'] = [{ wch: 80 }];
      XLSX.utils.book_append_sheet(wb, ws2, 'Panduan');

      const wbout = XLSX.write(wb, { bookType:'xlsx', type:'array' });
      const blob  = new Blob([wbout], { type:'application/octet-stream' });
      const url   = URL.createObjectURL(blob);
      const a     = document.createElement('a');
      a.href = url; a.download = 'menu_import_template.xlsx';
      document.body.appendChild(a); a.click(); a.remove(); URL.revokeObjectURL(url);
      showToast('Template Excel diunduh!', 'success');
    } catch (e) {
      console.error('downloadMenuTemplate', e);
      showToast('Gagal membuat template: ' + e.message, 'error');
    } finally {
      if (btn) { btn.disabled = false; btn.innerHTML = '<i data-lucide="download" class="icon-sm"></i> Download Template .xlsx'; if(window.lucide) lucide.createIcons(); }
    }
  },

  async handleImportMenuFile(node) {
    if (!node?.files?.[0]) return;
    this._bulkModalInit();
    const overlay = document.getElementById('modal-bulk-import');
    if (overlay) overlay.classList.add('active');
    this._bulkShowState('parsing');
    // Reset footer buttons
    document.getElementById('btn-confirm-bulk-import')?.classList.add('hidden');
    document.getElementById('btn-bulk-done')?.classList.add('hidden');
    document.getElementById('btn-bulk-cancel')?.classList.remove('hidden');

    try {
      if (!window.XLSX) throw new Error('Library SheetJS belum dimuat');
      const buf  = await node.files[0].arrayBuffer();
      const wb   = XLSX.read(buf, { type:'array' });
      const sheet = wb.Sheets[wb.SheetNames[0]];
      if (!sheet) throw new Error('Sheet tidak ditemukan di file');
      const rawRows = XLSX.utils.sheet_to_json(sheet, { defval:'' });
      if (!rawRows.length) throw new Error('File kosong atau tidak terbaca');

      // Fetch branches to detect branch-price columns
      const { data: branches } = await db.from('branches').select('*').order('name');
      const branchList = this._activeBranches(branches);
      const branchNameMap = {}; // lowercase name -> branch obj
      branchList.forEach(b => { branchNameMap[b.name.trim().toLowerCase()] = b; });

      // Detect which header columns are branch names
      const allHeaders = rawRows.length ? Object.keys(rawRows[0]) : [];
      const fixedCols  = new Set(['product_name','variant_name','default_price','price','category','sku']);
      const branchCols = allHeaders.filter(h => {
        const norm = h.trim().toLowerCase();
        return !fixedCols.has(norm) && branchNameMap[norm] !== undefined;
      });

      // Normalize rows
      const get = (r, ...keys) => {
        for (const k of keys) {
          const found = Object.keys(r).find(h => h.trim().toLowerCase() === k.toLowerCase());
          if (found !== undefined && r[found] !== '') return r[found];
        }
        return '';
      };

      const errors = [];
      const parsed = rawRows.map((r, idx) => {
        const pname = String(get(r,'product_name','product') || '').trim();
        const vname = String(get(r,'variant_name','variant') || '').trim();
        const dpRaw = get(r,'default_price','price');
        const dp    = Number(dpRaw) || 0;
        const cat   = String(get(r,'category') || '').trim();
        const sku   = String(get(r,'sku') || '').trim();

        if (!pname || !vname) {
          errors.push(`Baris ${idx+2}: product_name atau variant_name kosong`);
          return null;
        }
        if (isNaN(Number(dpRaw)) || Number(dpRaw) < 0) {
          errors.push(`Baris ${idx+2}: default_price tidak valid (${dpRaw})`);
          return null;
        }

        const branchPrices = {}; // branchId -> price
        branchCols.forEach(col => {
          const val = r[col];
          if (val !== '' && val !== null && val !== undefined) {
            const branch = branchNameMap[col.trim().toLowerCase()];
            if (branch) {
              const p = Number(val);
              if (!isNaN(p) && p >= 0) branchPrices[branch.id] = p;
            }
          }
        });
        return { pname, vname, dp, cat, sku, branchPrices };
      }).filter(Boolean);

      if (!parsed.length) throw new Error('Tidak ditemukan baris valid (pastikan kolom product_name & variant_name terisi)');

      // Count stats for preview
      const uniqueProducts = new Set(parsed.map(r => r.pname)).size;
      const totalBranchPrices = parsed.reduce((s,r) => s + Object.keys(r.branchPrices).length, 0);

      document.getElementById('bp-cnt-products').textContent = uniqueProducts;
      document.getElementById('bp-cnt-variants').textContent  = parsed.length;
      document.getElementById('bp-cnt-prices').textContent   = totalBranchPrices;
      document.getElementById('bp-cnt-errors').textContent   = errors.length;

      // Show errors strip
      const errEl = document.getElementById('bulk-preview-errors');
      if (errors.length && errEl) {
        errEl.classList.remove('hidden');
        errEl.innerHTML = '<strong>Peringatan baris dilewati:</strong><br>' + errors.map(escHtml).join('<br>');
      } else if (errEl) { errEl.classList.add('hidden'); }

      // Build preview table
      const thead = document.getElementById('bulk-preview-thead');
      const tbody = document.getElementById('bulk-preview-tbody');
      const branchColHeaders = branchCols.map(c => `<th class="col-branch-price">${escHtml(c)}</th>`).join('');
      thead.innerHTML = `<tr><th>#</th><th>Produk</th><th>Varian</th><th>Harga Default</th><th>Kategori</th>${branchColHeaders}</tr>`;
      tbody.innerHTML = parsed.map((r,i) => {
        const bpCells = branchCols.map(col => {
          const branch = branchNameMap[col.trim().toLowerCase()];
          const price  = branch ? r.branchPrices[branch.id] : undefined;
          return `<td class="col-branch-price">${price !== undefined ? fRp(price) : '<span class="text-muted">—</span>'}</td>`;
        }).join('');
        return `<tr><td class="text-muted">${i+1}</td><td class="fw-600">${escHtml(r.pname)}</td><td>${escHtml(r.vname)}</td><td class="fw-700 text-orange">${fRp(r.dp)}</td><td>${escHtml(r.cat||'—')}</td>${bpCells}</tr>`;
      }).join('');

      // Store for confirm step
      this._bulkImportData = { rows: parsed, branchList, branchCols, branchNameMap };

      // Update footer
      const countEl = document.getElementById('bulk-row-count');
      if (countEl) countEl.textContent = parsed.length;
      document.getElementById('btn-confirm-bulk-import')?.classList.remove('hidden');
      if (window.lucide) lucide.createIcons();

      this._bulkShowState('preview');
    } catch (e) {
      console.error('handleImportMenuFile', e);
      showToast('Gagal membaca file: ' + e.message, 'error');
      const overlay = document.getElementById('modal-bulk-import');
      if (overlay) overlay.classList.remove('active');
    } finally {
      try { node.value = ''; } catch(_) {}
    }
  },

  async confirmBulkImport() {
    if (!this._bulkImportData) return;
    const { rows, branchNameMap } = this._bulkImportData;

    // Switch to importing state
    this._bulkShowState('importing');
    document.getElementById('btn-confirm-bulk-import')?.classList.add('hidden');
    document.getElementById('btn-bulk-cancel')?.classList.add('hidden');

    const bar    = document.getElementById('bulk-progress-bar');
    const txtEl  = document.getElementById('bulk-progress-text');
    const curEl  = document.getElementById('bulk-progress-current');
    const total  = rows.length;
    let created = 0, updated = 0, skipped = 0, branchPricesSet = 0;

    const setProgress = (done, msg) => {
      const pct = total ? Math.round(done / total * 100) : 100;
      if (bar)   bar.style.width = pct + '%';
      if (txtEl) txtEl.textContent = `${done} / ${total} baris diproses (${pct}%)`;
      if (curEl && msg) curEl.textContent = msg;
    };

    try {
      // Pre-load existing products & variants
      const { data: prodData } = await db.from('products').select('id,name');
      const { data: varData  } = await db.from('product_variants').select('id,name,product_id,price');
      const prodMap = {};
      (prodData || []).forEach(p => { prodMap[p.name.trim().toLowerCase()] = p; });
      const varMapByProd = {};
      (varData || []).forEach(v => {
        varMapByProd[v.product_id] = varMapByProd[v.product_id] || {};
        varMapByProd[v.product_id][v.name.trim().toLowerCase()] = v;
      });

      for (let i = 0; i < rows.length; i++) {
        const r = rows[i];
        setProgress(i, `Memproses: ${r.pname} — ${r.vname}`);

        // ── Find or create product ──
        let prod = prodMap[r.pname.toLowerCase()];
        if (!prod) {
          try {
            const { data: np, error: pe } = await db.from('products')
              .insert({ name: r.pname, category: r.cat || null })
              .select().single();
            if (pe) throw pe;
            prod = np;
            prodMap[prod.name.trim().toLowerCase()] = prod;
            created++;
          } catch (e) {
            console.error('create product', r.pname, e);
            skipped++; continue;
          }
        }

        // ── Find or create/update variant ──
        varMapByProd[prod.id] = varMapByProd[prod.id] || {};
        let variant = varMapByProd[prod.id][r.vname.toLowerCase()];
        if (!variant) {
          try {
            const { data: nv, error: ve } = await db.from('product_variants')
              .insert({ product_id: prod.id, name: r.vname, price: r.dp })
              .select().single();
            if (ve) throw ve;
            variant = nv;
            varMapByProd[prod.id][variant.name.trim().toLowerCase()] = variant;
            created++;
          } catch (e) {
            console.error('create variant', prod.id, r.vname, e);
            skipped++; continue;
          }
        } else if (Number(variant.price) !== r.dp) {
          try {
            const { error: ue } = await db.from('product_variants')
              .update({ price: r.dp }).eq('id', variant.id);
            if (ue) throw ue;
            variant.price = r.dp;
            updated++;
          } catch (e) {
            console.error('update variant price', variant.id, e);
          }
        }

        // ── Upsert branch-variant prices ──
        const bpEntries = Object.entries(r.branchPrices);
        if (bpEntries.length && variant) {
          const upserts = bpEntries.map(([bId, price]) => ({
            branch_id: parseInt(bId), variant_id: variant.id, price,
            updated_at: new Date().toISOString()
          }));
          try {
            const { error: bpe } = await db.from('branch_variant_prices')
              .upsert(upserts, { onConflict: 'branch_id,variant_id' });
            if (bpe && !/does not exist|relation.*not found/i.test(bpe.message)) throw bpe;
            branchPricesSet += upserts.length;
          } catch (e) {
            console.error('upsert branch prices', e);
          }
        }
      }

      setProgress(total, 'Selesai!');
      await this.loadMasterData();

      // Show done state
      document.getElementById('bulk-done-desc').textContent =
        `${total} baris diproses dari file Excel`;
      document.getElementById('bulk-done-stats').innerHTML = `
        <div class="bulk-stat-box"><div class="bulk-stat-val text-primary">${created}</div><div class="bulk-stat-lbl">Dibuat Baru</div></div>
        <div class="bulk-stat-box"><div class="bulk-stat-val text-orange">${updated}</div><div class="bulk-stat-lbl">Diperbarui</div></div>
        <div class="bulk-stat-box"><div class="bulk-stat-val" style="color:var(--success)">${branchPricesSet}</div><div class="bulk-stat-lbl">Harga Cabang</div></div>
        <div class="bulk-stat-box"><div class="bulk-stat-val text-danger">${skipped}</div><div class="bulk-stat-lbl">Terlewat</div></div>
      `;
      this._bulkShowState('done');
      document.getElementById('btn-bulk-done')?.classList.remove('hidden');
      this._bulkImportData = null;

      if (this.currentSection === 'products') this.loadProducts();
      showToast(`Import selesai — ${created} baru, ${updated} update, ${branchPricesSet} harga cabang`, 'success');
    } catch (e) {
      console.error('confirmBulkImport', e);
      showToast('Import gagal: ' + e.message, 'error');
      this._bulkShowState('preview');
      document.getElementById('btn-confirm-bulk-import')?.classList.remove('hidden');
      document.getElementById('btn-bulk-cancel')?.classList.remove('hidden');
    }
  },

  // End of bulk import helpers (legacy handlers removed)

  _sessionToken() {
    return auth.getSession()?.session_token || this.user?.session_token || '';
  },

  _isMissingRpcError(error) {
    const msg  = String(error?.message || error || '').toLowerCase();
    const code = String(error?.code || '');
    return code === '42883'
      || code === 'PGRST202'
      || msg.includes('could not find the function')
      || (msg.includes('function') && msg.includes('does not exist'));
  },

  async _rpcWithLegacy(rpcName, params, legacyFn = null) {
    const { data, error } = await db.rpc(rpcName, params);
    if (error) {
      if (legacyFn && this._isMissingRpcError(error)) return legacyFn();
      throw error;
    }
    return data;
  },

  _firstRpcRow(data) {
    return Array.isArray(data) ? data[0] : data;
  },

  // ── Toppings ─────────────────────────────────────────────────
  async loadToppingSection() {
    // Populate product select for mapping
    const opts = this.products.map(p => `<option value="${p.id}">${escHtml(p.name)}</option>`).join('');
    setSelect('topping-mapping-product', `<option value="">— Pilih Produk —</option>${opts}`);
    await this.loadToppings();
  },

  async loadToppings() {
    const tbody = document.getElementById('toppings-list');
    if (!tbody) return;
    tbody.innerHTML = '<tr><td colspan="5" class="empty-td">Memuat...</td></tr>';
    const { data, error } = await db.from('toppings').select('*').order('name');
    if (error) {
      tbody.innerHTML = `<tr><td colspan="5" class="empty-td text-danger">Gagal memuat: ${escHtml(error.message)}. Pastikan sudah menjalankan schema_toppings_apikeys.sql</td></tr>`;
      return;
    }
    if (!data?.length) {
      tbody.innerHTML = '<tr><td colspan="5" class="empty-td">Belum ada topping. Klik "+ Tambah Topping" untuk mulai.</td></tr>';
      return;
    }
    tbody.innerHTML = data.map((t, i) => `
      <tr>
        <td>${i + 1}</td>
        <td class="fw-600">${escHtml(t.name)}</td>
        <td>${t.price > 0 ? fRp(t.price) : '<span class="text-muted">Gratis</span>'}</td>
        <td>
          <span class="badge ${t.is_active ? 'badge-green' : 'badge-red'}">${t.is_active ? 'Aktif' : 'Nonaktif'}</span>
        </td>
        <td>
          <div class="flex gap-1">
            <button class="btn btn-outline btn-sm" data-admin-action="open-topping-modal" data-id="${t.id}">Edit</button>
            <button class="btn btn-sm ${t.is_active ? 'btn-warning' : 'btn-success'}" data-admin-action="toggle-topping-active" data-id="${t.id}" data-active="${t.is_active}">${t.is_active ? 'Nonaktifkan' : 'Aktifkan'}</button>
            <button class="btn btn-danger btn-sm" data-admin-action="delete-topping" data-id="${t.id}" data-name="${escHtml(t.name)}">Hapus</button>
          </div>
        </td>
      </tr>`).join('');
    if (window.lucide) lucide.createIcons();
  },

  openToppingModal(id = null) {
    document.getElementById('topping-id').value    = id || '';
    document.getElementById('topping-name').value  = '';
    document.getElementById('topping-price').value = '';
    document.getElementById('topping-is-active').checked = true;
    document.getElementById('topping-modal-title').textContent = id ? 'Edit Topping' : 'Tambah Topping';

    if (id) {
      db.from('toppings').select('*').eq('id', id).single().then(({ data }) => {
        if (!data) return;
        document.getElementById('topping-name').value  = data.name;
        document.getElementById('topping-price').value = data.price;
        document.getElementById('topping-is-active').checked = data.is_active;
      });
    }
    openModal('modal-topping');
  },

  async saveTopping() {
    const id       = document.getElementById('topping-id').value;
    const name     = document.getElementById('topping-name').value.trim();
    const price    = parseFloat(document.getElementById('topping-price').value) || 0;
    const isActive = document.getElementById('topping-is-active').checked;

    if (!name) { showToast('Nama topping wajib diisi', 'error'); return; }
    if (price < 0) { showToast('Harga tidak boleh negatif', 'error'); return; }

    try {
      await this._rpcWithLegacy('rbn_admin_save_topping', {
        p_session_token: this._sessionToken() || null,
        p_id:            id ? Number(id) : null,
        p_name:          name,
        p_price:         price,
        p_is_active:     isActive
      }, async () => {
        if (id) {
          const { error } = await db.from('toppings').update({ name, price, is_active: isActive }).eq('id', Number(id));
          if (error) throw error;
        } else {
          const { error } = await db.from('toppings').insert({ name, price, is_active: isActive });
          if (error) throw error;
        }
      });
      closeModal('modal-topping');
      await this.loadToppings();
      showToast(id ? 'Topping diperbarui' : 'Topping berhasil ditambahkan', 'success');
      window.RBNDataEvents?.publish('toppings:changed', { source: 'admin' });
    } catch (e) {
      showDbError(e, { action: 'menyimpan topping', entity: 'Topping' });
    }
  },

  async deleteTopping(id, name) {
    const ok = await showConfirm({
      title:       `Hapus "${name}"?`,
      message:     'Topping ini akan dihapus dari semua produk yang menggunakannya.',
      confirmText: 'Ya, Hapus',
      danger:      true
    });
    if (!ok) return;
    try {
      await this._rpcWithLegacy('rbn_admin_delete_topping', {
        p_session_token: this._sessionToken() || null,
        p_id:            id
      }, async () => {
        const { error } = await db.from('toppings').delete().eq('id', id);
        if (error) throw error;
      });
    } catch (error) {
      showDbError(error, { action: 'menghapus topping', entity: 'Topping' });
      return;
    }
    await this.loadToppings();
    showToast('Topping dihapus', 'success');
  },

  async toggleToppingActive(id, currentActive) {
    try {
      await this._rpcWithLegacy('rbn_admin_set_topping_active', {
        p_session_token: this._sessionToken() || null,
        p_id:            id,
        p_is_active:     !currentActive
      }, async () => {
        const { error } = await db.from('toppings').update({ is_active: !currentActive }).eq('id', id);
        if (error) throw error;
      });
    } catch (error) {
      showDbError(error, { action: 'mengubah status topping', entity: 'Topping' });
      return;
    }
    await this.loadToppings();
    showToast(currentActive ? 'Topping dinonaktifkan' : 'Topping diaktifkan', 'success');
  },

  async loadToppingMapping(productId) {
    const container = document.getElementById('topping-mapping-list');
    if (!container) return;
    if (!productId) {
      container.innerHTML = '<div class="empty-state py-6"><div class="empty-title text-sm">Pilih produk di atas</div></div>';
      return;
    }
    container.innerHTML = '<div class="text-center p-4 text-muted text-sm">Memuat...</div>';

    const [toppingRes, mappingRes] = await Promise.all([
      db.from('toppings').select('id, name, price, is_active').eq('is_active', true).order('name'),
      db.from('product_toppings').select('topping_id').eq('product_id', Number(productId))
    ]);

    const toppings  = toppingRes.data || [];
    const mapped    = new Set((mappingRes.data || []).map(r => r.topping_id));

    if (!toppings.length) {
      container.innerHTML = '<div class="empty-state py-6"><div class="empty-title text-sm">Belum ada topping aktif. Tambah topping terlebih dahulu.</div></div>';
      return;
    }

    container.innerHTML = toppings.map(t => `
      <label class="flex items-center gap-3 p-3 rounded cursor-pointer" style="border:1px solid var(--border);background:var(--bg-alt);user-select:none" onchange="ADMIN._onToppingMappingChange(${productId}, ${t.id}, this.querySelector('input').checked)">
        <input type="checkbox" ${mapped.has(t.id) ? 'checked' : ''} style="width:16px;height:16px;accent-color:var(--primary);flex-shrink:0" />
        <div class="flex-1">
          <div class="fw-600 text-sm">${escHtml(t.name)}</div>
          <div class="text-xs text-muted">${t.price > 0 ? '+' + fRp(t.price) : 'Gratis'}</div>
        </div>
      </label>`).join('');
  },

  async _onToppingMappingChange(productId, toppingId, checked) {
    try {
      await this._rpcWithLegacy('rbn_admin_set_product_topping', {
        p_session_token: this._sessionToken() || null,
        p_product_id:    Number(productId),
        p_topping_id:    Number(toppingId),
        p_enabled:       !!checked
      }, async () => {
        if (checked) {
          const { error } = await db.from('product_toppings').upsert(
            { product_id: productId, topping_id: toppingId },
            { onConflict: 'product_id,topping_id', ignoreDuplicates: true }
          );
          if (error) throw error;
        } else {
          const { error } = await db.from('product_toppings').delete()
            .eq('product_id', productId).eq('topping_id', toppingId);
          if (error) throw error;
        }
      });
    } catch (e) {
      showDbError(e, { action: 'menyimpan pilihan topping', entity: 'Mapping topping' });
      // Revert checkbox
      this.loadToppingMapping(productId);
    }
  },

  // ── API Keys ─────────────────────────────────────────────────
  async loadApiKeysSection() {
    // Fill endpoint display
    const epEl   = document.getElementById('api-endpoint-display');
    const codeEl = document.getElementById('api-code-example');
    const apiBase = (typeof API_BASE !== 'undefined' ? API_BASE : 'https://api.rotibakarngeunah.my.id/api/api.php');

    if (epEl)   epEl.textContent   = `${apiBase}/rpc/get_transactions_api`;
    if (codeEl) codeEl.textContent = `fetch('${apiBase}/rpc/get_transactions_api?p_api_key=YOUR_API_KEY_HERE&p_from=2025-01-01&p_to=2025-12-31')`;

    await this.loadApiKeys();
  },

  async loadApiKeys() {
    const tbody = document.getElementById('api-keys-list');
    if (!tbody) return;
    tbody.innerHTML = '<tr><td colspan="5" class="empty-td">Memuat...</td></tr>';
    let data, error = null;
    try {
      data = await this._rpcWithLegacy('rbn_admin_list_api_keys', {
        p_session_token: this._sessionToken() || null
      }, async () => {
        const res = await db.from('api_keys').select('*').order('created_at', { ascending: false });
        if (res.error) throw res.error;
        return res.data;
      });
    } catch (e) {
      error = e;
    }
    if (error) {
      tbody.innerHTML = `<tr><td colspan="5" class="empty-td text-danger">Gagal memuat: ${escHtml(error.message)}. Jalankan migration 054 dan login ulang.</td></tr>`;
      return;
    }
    if (!data?.length) {
      tbody.innerHTML = '<tr><td colspan="5" class="empty-td">Belum ada API key. Klik "+ Buat API Key Baru".</td></tr>';
      return;
    }
    tbody.innerHTML = data.map(k => `
      <tr>
        <td class="fw-600">${escHtml(k.name)}</td>
        <td>
          <div class="flex items-center gap-2">
            <code class="text-xs" style="background:var(--bg-alt);padding:3px 8px;border-radius:6px;border:1px solid var(--border);word-break:break-all;font-family:monospace">${escHtml(k.key_value)}</code>
            <button class="btn btn-outline btn-sm flex-shrink-0" data-admin-action="copy-api-key" data-key="${escHtml(k.key_value)}" title="Salin">
              <i data-lucide="copy" style="width:13px;height:13px"></i>
            </button>
          </div>
        </td>
        <td><span class="badge ${k.is_active ? 'badge-green' : 'badge-red'}">${k.is_active ? 'Aktif' : 'Nonaktif'}</span></td>
        <td class="text-xs text-muted nowrap">${fDate(k.created_at)}</td>
        <td>
          <div class="flex gap-1">
            <button class="btn btn-sm ${k.is_active ? 'btn-warning' : 'btn-success'}" data-admin-action="toggle-api-key" data-id="${k.id}" data-active="${k.is_active}">${k.is_active ? 'Nonaktifkan' : 'Aktifkan'}</button>
            <button class="btn btn-danger btn-sm" data-admin-action="delete-api-key" data-id="${k.id}" data-name="${escHtml(k.name)}">Hapus</button>
          </div>
        </td>
      </tr>`).join('');
    if (window.lucide) lucide.createIcons();
  },

  openApiKeyModal() {
    document.getElementById('api-key-name').value = '';
    openModal('modal-api-key');
  },

  async confirmGenerateApiKey() {
    const name = document.getElementById('api-key-name').value.trim();
    if (!name) { showToast('Nama API key wajib diisi', 'error'); return; }

    // Generate secure random key
    const arr = new Uint8Array(32);
    crypto.getRandomValues(arr);
    const keyValue = 'rbn_' + Array.from(arr).map(b => b.toString(16).padStart(2, '0')).join('');

    try {
      const created = await this._rpcWithLegacy('rbn_admin_create_api_key', {
        p_session_token: this._sessionToken() || null,
        p_name:          name
      }, async () => {
        const { error } = await db.from('api_keys').insert({ name, key_value: keyValue, is_active: true });
        if (error) throw error;
        return [{ key_value: keyValue }];
      });
      const createdRow = this._firstRpcRow(created) || {};
      const copiedKey = createdRow.key_value || keyValue;
      closeModal('modal-api-key');
      showToast('API key berhasil dibuat', 'success');
      await this.loadApiKeys();
      // Auto copy to clipboard
      try {
        await navigator.clipboard.writeText(copiedKey);
        showToast('Key disalin ke clipboard!', 'success');
      } catch(e) { /* clipboard not available */ }
    } catch (e) {
      showDbError(e, { action: 'membuat API key', entity: 'API key' });
    }
  },

  async deleteApiKey(id, name) {
    const ok = await showConfirm({
      title:       `Hapus API key "${name}"?`,
      message:     'Aplikasi yang menggunakan key ini tidak akan bisa mengakses data lagi.',
      confirmText: 'Ya, Hapus',
      danger:      true
    });
    if (!ok) return;
    try {
      await this._rpcWithLegacy('rbn_admin_delete_api_key', {
        p_session_token: this._sessionToken() || null,
        p_id:            id
      }, async () => {
        const { error } = await db.from('api_keys').delete().eq('id', id);
        if (error) throw error;
      });
    } catch (error) {
      showDbError(error, { action: 'menghapus API key', entity: 'API key' });
      return;
    }
    await this.loadApiKeys();
    showToast('API key dihapus', 'success');
  },

  async toggleApiKey(id, currentActive) {
    try {
      await this._rpcWithLegacy('rbn_admin_set_api_key_active', {
        p_session_token: this._sessionToken() || null,
        p_id:            id,
        p_is_active:     !currentActive
      }, async () => {
        const { error } = await db.from('api_keys').update({ is_active: !currentActive }).eq('id', id);
        if (error) throw error;
      });
    } catch (error) {
      showDbError(error, { action: 'mengubah status API key', entity: 'API key' });
      return;
    }
    await this.loadApiKeys();
    showToast(currentActive ? 'API key dinonaktifkan' : 'API key diaktifkan', 'success');
  },

  async copyApiKey(key) {
    try {
      await navigator.clipboard.writeText(key);
      showToast('Key disalin ke clipboard!', 'success');
    } catch(e) {
      showToast('Gagal menyalin. Salin manual dari tabel.', 'warning');
    }
  },
};


// ── Global helpers ─────────────────────────────────────────────
// Formatting helpers are provided by js/utils/formatter.js (window.fRp, window.formatRupiah, window.escHtml)
function setSelect(id, html) {
  const el = document.getElementById(id);
  if (el) el.innerHTML = html;
}
// Alias for backward compat
function setSelectOptions(id, html) { setSelect(id, html); }
// Modal/loader helpers are provided by `js/utils/formatter.js` (openModal/closeModal/showLoader/hideLoader)
// `showToast` provided by js/utils/formatter.js

document.addEventListener('DOMContentLoaded', () => ADMIN.init());

// Global overlay click handler for modals: close when clicking on overlay
document.addEventListener('click', function(e) {
  if (!e.target.classList || !e.target.classList.contains('modal-overlay')) return;
  const lockedModals = ['modal-shift', 'modal-branch'];
  if (lockedModals.includes(e.target.id)) return;
  e.target.classList.remove('active');
});
