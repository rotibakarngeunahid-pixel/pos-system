'use strict';

const INVESTOR = {
  user:             null,
  branches:         [],
  features:         [],   // active feature keys from permission config
  paymentMethods:   [],
  selectedBranchId: null,
  currentTab:       'overview',
  cache:            null, // { salesData, productData, inventoryData, usageData }
  _swipeObserver:   null,

  _DEFAULT_PAYMENT_METHODS: [
    { code: 'cash', label: 'Tunai' },
    { code: 'qris', label: 'QRIS' },
    { code: 'transfer', label: 'Transfer' },
  ],

  // Tab config: key, label, feature (null = always show)
  _TAB_CONFIG: [
    { key: 'overview',   label: 'Overview',        feature: null },
    { key: 'sales',      label: 'Penjualan',        feature: 'sales' },
    { key: 'products',   label: 'Produk',           feature: 'products' },
    { key: 'inventory',  label: 'Stok',             feature: 'inventory_stock' },
    { key: 'usage',      label: 'Pemakaian Bahan',  feature: 'inventory_usage' },
  ],

  async init() {
    this.user = auth.requireRole('investor');
    if (!this.user) return;
    this.user = await auth.validateCurrentUser(['investor']);
    if (!this.user) return;

    document.getElementById('inv-user-name').textContent = this.user.name || '';
    this._setDefaultDates();
    this._bindFilterToggle();

    await this._loadAccessConfig();
  },

  _setDefaultDates() {
    // Use fmt.getBusinessDate() for WITA-correct date (UTC+8)
    const todayWita = (typeof fmt !== 'undefined')
      ? fmt.getBusinessDate()
      : new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10);
    document.getElementById('inv-date-from').value = todayWita.slice(0, 7) + '-01';
    document.getElementById('inv-date-to').value   = todayWita;
  },

  async _loadAccessConfig() {
    this._showGlobalState('loading', 'Memuat konfigurasi akses...');
    try {
      const config = await investorService.getAccessConfig(this.user.id);
      this.branches = config.branches || [];
      this.features = config.features || [];
    } catch (e) {
      this._showGlobalState('error', 'Gagal memuat konfigurasi: ' + e.message);
      return;
    }

    if (!this.branches.length) {
      this._showGlobalState('no-branch', 'Akun investor belum memiliki akses cabang. Hubungi admin.');
      return;
    }
    if (!this.features.length) {
      this._showGlobalState('no-feature', 'Akun investor belum memiliki izin fitur. Hubungi admin.');
      return;
    }

    this._hideGlobalState();
    this._populateBranches();
    await this._loadPaymentMethods();
    this._renderTabs();
    this._setupSwipe();
    this._bindEvents();
    this.selectedBranchId = this.branches[0].branch_id;
    document.getElementById('inv-branch-filter').value = this.selectedBranchId;
    this._updateFilterSummary();
    await this.loadDashboard();
  },

  _populateBranches() {
    const select = document.getElementById('inv-branch-filter');
    select.innerHTML = this.branches.map(b =>
      `<option value="${b.branch_id}">${escHtml(b.branch_name)}</option>`
    ).join('');
  },

  async _loadPaymentMethods() {
    let methods = [];
    try {
      methods = await investorService.getPaymentMethods();
    } catch (e) {
      console.warn('Investor payment methods fallback:', e.message || e);
      methods = this._getLocalPaymentMethods();
    }
    if (!methods.length) methods = this._getLocalPaymentMethods();

    this.paymentMethods = this._normalizePaymentMethods(methods);
    this._populatePaymentMethods();
  },

  _getLocalPaymentMethods() {
    try {
      const settings = JSON.parse(localStorage.getItem('pos_settings') || '{}');
      if (Array.isArray(settings.paymentMethods) && settings.paymentMethods.length) {
        return settings.paymentMethods;
      }
    } catch (e) {}
    return this._DEFAULT_PAYMENT_METHODS;
  },

  _normalizePaymentMethods(methods) {
    const source = Array.isArray(methods) && methods.length ? methods : this._DEFAULT_PAYMENT_METHODS;
    const seen = new Set();
    return source
      .filter(m => m && m.code && m.label && m.is_active !== false)
      .map(m => ({ code: String(m.code), label: String(m.label) }))
      .filter(m => {
        if (seen.has(m.code)) return false;
        seen.add(m.code);
        return true;
      });
  },

  _populatePaymentMethods() {
    const select = document.getElementById('inv-payment-method');
    if (!select) return;

    const current = select.value;
    select.innerHTML = '<option value="">Semua</option>' + this.paymentMethods.map(m =>
      `<option value="${escHtml(m.code)}">${escHtml(m.label)}</option>`
    ).join('');

    if ([...select.options].some(o => o.value === current)) {
      select.value = current;
    }
  },

  _getPaymentMethodLabel(code) {
    if (!code) return 'N/A';
    const method = this.paymentMethods.find(m => m.code === code);
    if (method) return method.label;
    const fallback = this._DEFAULT_PAYMENT_METHODS.find(m => m.code === code);
    return fallback?.label || fmt.titleCase(String(code).replace(/_/g, ' '));
  },

  _visibleTabs() {
    return this._TAB_CONFIG.filter(t =>
      t.feature === null || this.features.includes(t.feature)
    );
  },

  _renderTabs() {
    const tabs     = this._visibleTabs();
    const tabsNav  = document.getElementById('inv-tabs');
    const container = document.getElementById('inv-panels-container');

    tabsNav.innerHTML = tabs.map((t, i) =>
      `<button class="inv-tab${i === 0 ? ' active' : ''}" data-inv-tab="${t.key}">${t.label}</button>`
    ).join('');

    // Show only panels for visible tabs, hide others
    document.querySelectorAll('.inv-panel').forEach(p => {
      const key = p.dataset.panel;
      const visible = tabs.some(t => t.key === key);
      p.style.display = visible ? '' : 'none';
    });
  },

  _setupSwipe() {
    const container = document.getElementById('inv-panels-container');
    if (!container) return;

    if (this._swipeObserver) this._swipeObserver.disconnect();

    const visiblePanels = this._visibleTabs().map(t =>
      document.getElementById('inv-panel-' + t.key)
    ).filter(Boolean);

    this._swipeObserver = new IntersectionObserver(entries => {
      entries.forEach(entry => {
        if (entry.intersectionRatio >= 0.5) {
          const key = entry.target.dataset.panel;
          this._activateTab(key, false);
          if (this.cache) this._renderTabFromCache(key);
          else this.loadDashboard();
        }
      });
    }, { root: container, threshold: 0.5 });

    visiblePanels.forEach(p => this._swipeObserver.observe(p));
  },

  _bindEvents() {
    document.getElementById('inv-logout-btn').addEventListener('click', () => auth.logout());

    document.getElementById('inv-refresh-btn').addEventListener('click', () => {
      this.cache = null;
      this._updateFilterSummary();
      this.loadDashboard();
    });

    document.getElementById('inv-branch-filter').addEventListener('change', e => {
      this.selectedBranchId = Number(e.target.value);
      this._updateFilterSummary();
      this.cache = null;
      this.loadDashboard();
    });

    document.getElementById('inv-tabs').addEventListener('click', e => {
      const btn = e.target.closest('[data-inv-tab]');
      if (!btn) return;
      const key = btn.dataset.invTab;
      this._activateTab(key, true);
      if (this.cache) this._renderTabFromCache(key);
      else this.loadDashboard();
    });
  },

  _bindFilterToggle() {
    const toggle = document.getElementById('inv-filter-toggle');
    const panel  = document.getElementById('inv-filter-panel');
    if (!toggle || !panel) return;
    toggle.addEventListener('click', () => {
      const open = panel.classList.toggle('open');
      toggle.setAttribute('aria-expanded', open);
    });
  },

  _updateFilterSummary() {
    const branch = this.branches.find(b => b.branch_id === this.selectedBranchId);
    const from   = document.getElementById('inv-date-from').value || '';
    const to     = document.getElementById('inv-date-to').value   || '';
    const paymentCode = document.getElementById('inv-payment-method')?.value || '';
    const paymentText = paymentCode ? this._getPaymentMethodLabel(paymentCode) : 'Semua metode';
    const el     = document.getElementById('inv-filter-summary-text');
    if (el && branch) {
      el.textContent = `${branch.branch_name}  |  ${from} s/d ${to}  |  ${paymentText}`;
    }
  },

  _activateTab(key, scroll) {
    this.currentTab = key;
    document.querySelectorAll('[data-inv-tab]').forEach(b =>
      b.classList.toggle('active', b.dataset.invTab === key)
    );
    if (scroll) {
      const panel = document.getElementById('inv-panel-' + key);
      if (panel) panel.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'start' });
    }
  },

  _getFilters() {
    return {
      branchId:      Number(document.getElementById('inv-branch-filter').value),
      dateFrom:      document.getElementById('inv-date-from').value,
      dateTo:        document.getElementById('inv-date-to').value,
      paymentMethod: document.getElementById('inv-payment-method').value || null
    };
  },

  async loadDashboard() {
    const { branchId, dateFrom, dateTo, paymentMethod } = this._getFilters();
    if (!branchId) return;

    this.cache = null;
    this._setPanelsLoading();

    const promises = {};
    if (this.features.includes('sales'))
      promises.sales = investorService.getSalesReport({ userId: this.user.id, branchId, dateFrom, dateTo, paymentMethod });
    if (this.features.includes('products'))
      promises.products = investorService.getProductPerformance({ userId: this.user.id, branchId, dateFrom, dateTo });
    if (this.features.includes('inventory_stock'))
      promises.inventory = investorService.getInventorySummary({ userId: this.user.id, branchId, date: dateTo });
    if (this.features.includes('inventory_usage'))
      promises.usage = investorService.getInventoryUsage({ userId: this.user.id, branchId, dateFrom, dateTo });

    const keys = Object.keys(promises);
    try {
      const results = await Promise.all(keys.map(k => promises[k]));
      const data = {};
      keys.forEach((k, i) => { data[k] = results[i]; });

      this.cache = {
        salesData:     data.sales     || null,
        productData:   data.products  || null,
        inventoryData: data.inventory || null,
        usageData:     data.usage     || null,
      };

      this._renderOverview();
      if (this.cache.salesData)     this._renderSales(this.cache.salesData);
      if (this.cache.productData)   this._renderProducts(this.cache.productData);
      if (this.cache.inventoryData) this._renderInventory(this.cache.inventoryData);
      if (this.cache.usageData)     this._renderUsage(this.cache.usageData);
    } catch (e) {
      this._setPanelsError('Gagal memuat data: ' + e.message);
    }
  },

  _renderTabFromCache(tab) {
    if (!this.cache) return;
    if (tab === 'overview')  this._renderOverview();
    if (tab === 'sales'     && this.cache.salesData)     this._renderSales(this.cache.salesData);
    if (tab === 'products'  && this.cache.productData)   this._renderProducts(this.cache.productData);
    if (tab === 'inventory' && this.cache.inventoryData) this._renderInventory(this.cache.inventoryData);
    if (tab === 'usage'     && this.cache.usageData)     this._renderUsage(this.cache.usageData);
  },

  _setPanelsLoading() {
    document.getElementById('inv-overview-cards').innerHTML =
      '<div class="inv-loading"><div class="inv-spinner"></div> Memuat data...</div>';
    this._visibleTabs().forEach(t => {
      if (t.key === 'overview') return;
      const el = document.getElementById('inv-panel-' + t.key);
      if (el) el.querySelector('.inv-panel-body').innerHTML =
        '<div class="inv-loading"><div class="inv-spinner"></div> Memuat...</div>';
    });
  },

  _setPanelsError(msg) {
    document.getElementById('inv-overview-cards').innerHTML =
      `<div class="inv-state-msg inv-state-error"><span class="inv-state-icon">!</span>${msg}</div>`;
  },

  // ── Overview ──────────────────────────────────────────────────
  _renderOverview() {
    const cards = [];

    if (this.cache?.salesData) {
      const s = this.cache.salesData;
      const avg = s.count > 0 ? (s.totalRevenue / s.count) : 0;
      cards.push({ label: 'Total Penjualan',     value: fmt.rupiah(s.totalRevenue), cls: 'text-success' });
      cards.push({ label: 'Jumlah Transaksi',    value: s.count,                    cls: '' });
      cards.push({ label: 'Rata-rata Transaksi', value: fmt.rupiah(avg),            cls: '' });
      cards.push({ label: 'Total Diskon',        value: fmt.rupiah(s.totalDiscount),cls: '' });
      cards.push({ label: 'Transaksi Void',      value: s.voidCount,                cls: s.voidCount > 0 ? 'text-danger' : '' });
    }

    if (this.cache?.productData?.length) {
      const top = this.cache.productData[0];
      cards.push({ label: 'Produk Terlaris', value: `${top.product} (${top.qty}x)`, cls: 'text-primary' });
    }

    if (this.cache?.inventoryData?.length) {
      cards.push({ label: 'Total Bahan', value: this.cache.inventoryData.length + ' jenis', cls: '' });
    }

    const el = document.getElementById('inv-overview-cards');
    if (!cards.length) {
      el.innerHTML = '<div class="inv-state-msg">Pilih cabang dan periode untuk memuat data.</div>';
      return;
    }
    el.innerHTML = cards.map(c => `
      <div class="inv-kpi-card">
        <div class="inv-kpi-label">${c.label}</div>
        <div class="inv-kpi-value ${c.cls}">${c.value}</div>
      </div>
    `).join('');
  },

  // ── Penjualan ─────────────────────────────────────────────────
  _renderSales(sales) {
    const rows = sales.transactions || [];
    const voidRows = sales.voidedTransactions || [];
    const all = [...rows, ...voidRows].sort((a, b) => new Date(b.created_at) - new Date(a.created_at));

    const el = document.getElementById('inv-sales-list');
    if (!el) return;

    if (!all.length) {
      el.innerHTML = '<div class="inv-state-msg">Tidak ada transaksi untuk periode ini.</div>';
      return;
    }

    el.innerHTML = all.map(t => {
      const isVoid = t.status === 'void' || t.status === 'voided';
      const methodLabel = this._getPaymentMethodLabel(t.payment_method);
      return `
        <div class="inv-trx-card${isVoid ? ' inv-trx-void' : ''}">
          <div class="inv-trx-row">
            <span class="inv-trx-time">${fmt.date(t.created_at)}</span>
            <span class="inv-trx-badge ${isVoid ? 'badge-void' : 'badge-completed'}">${isVoid ? 'VOID' : 'Selesai'}</span>
          </div>
          <div class="inv-trx-row">
            <span class="inv-trx-meta">${escHtml(methodLabel)} &middot; ${escHtml(t.staff_name || 'N/A')}</span>
            <span class="inv-trx-total">${fmt.rupiah(t.total)}</span>
          </div>
        </div>
      `;
    }).join('');
  },

  // ── Produk ────────────────────────────────────────────────────
  _renderProducts(products) {
    const el = document.getElementById('inv-products-list');
    if (!el) return;

    if (!products?.length) {
      el.innerHTML = '<div class="inv-state-msg">Tidak ada data produk untuk periode ini.</div>';
      return;
    }

    el.innerHTML = products.map((p, i) => `
      <div class="inv-rank-card">
        <div class="inv-rank-num">${i + 1}</div>
        <div class="inv-rank-info">
          <div class="inv-rank-name">${p.product || '—'}${p.variant ? ' <span class="inv-rank-variant">' + p.variant + '</span>' : ''}</div>
          <div class="inv-rank-meta">${p.qty} terjual &middot; ${fmt.rupiah(p.revenue)}</div>
        </div>
      </div>
    `).join('');
  },

  // ── Stok ──────────────────────────────────────────────────────
  _renderInventory(items) {
    const el = document.getElementById('inv-inventory-list');
    if (!el) return;

    if (!items?.length) {
      el.innerHTML = '<div class="inv-state-msg">Tidak ada data stok.</div>';
      return;
    }

    el.innerHTML = items.map(i => {
      const stockNum = parseFloat(i.stock) || 0;
      const low = stockNum < 5;
      return `
        <div class="inv-stock-card">
          <div class="inv-stock-top">
            <span class="inv-stock-name">${i.ingredient_name || '—'}</span>
            <span class="inv-stock-badge ${low ? 'badge-low' : 'badge-ok'}">${low ? 'Rendah' : 'Normal'}</span>
          </div>
          <div class="inv-stock-bottom">
            <span class="inv-stock-qty">${fmt.num(i.stock)} ${i.unit || ''}</span>
            <span class="inv-stock-meta">Pakai hari ini: ${fmt.num(i.used_today)} &middot; Update: ${i.last_updated ? fmt.date(i.last_updated) : '—'}</span>
          </div>
        </div>
      `;
    }).join('');
  },

  // ── Pemakaian Bahan ───────────────────────────────────────────
  _renderUsage(items) {
    const el = document.getElementById('inv-usage-list');
    if (!el) return;

    if (!items?.length) {
      el.innerHTML = '<div class="inv-state-msg">Tidak ada pemakaian bahan untuk periode ini.</div>';
      return;
    }

    el.innerHTML = items.map(i => `
      <div class="inv-usage-card">
        <span class="inv-usage-name">${i.ingredient_name || '—'}</span>
        <span class="inv-usage-qty">${fmt.num(i.total_used)} ${i.unit || ''}</span>
      </div>
    `).join('');
  },

  // ── Global State ──────────────────────────────────────────────
  _showGlobalState(type, msg) {
    const overlay = document.getElementById('inv-global-state');
    if (!overlay) return;
    overlay.style.display = 'flex';

    const icons = {
      loading:    '<div class="inv-spinner"></div>',
      error:      '<span style="font-size:2rem;opacity:.5;">!</span>',
      'no-branch':'<span style="font-size:2rem;opacity:.4;">&#127968;</span>',
      'no-feature':'<span style="font-size:2rem;opacity:.4;">&#128274;</span>',
    };
    overlay.innerHTML = `
      <div class="inv-global-state-inner">
        ${icons[type] || ''}
        <p class="inv-global-msg">${msg}</p>
      </div>
    `;

    document.getElementById('inv-tabs').style.display = 'none';
    document.getElementById('inv-panels-container').style.display = 'none';
  },

  _hideGlobalState() {
    const overlay = document.getElementById('inv-global-state');
    if (overlay) overlay.style.display = 'none';
    document.getElementById('inv-tabs').style.display = '';
    document.getElementById('inv-panels-container').style.display = '';
  },
};
