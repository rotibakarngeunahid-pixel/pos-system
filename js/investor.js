'use strict';

const INVESTOR = {
  user:             null,
  branches:         [],
  selectedBranchId: null,
  currentTab:       'overview',
  salesCache:       null,

  async init() {
    this.user = auth.requireRole('investor');
    if (!this.user) return;

    this.user = await auth.validateCurrentUser();
    if (!this.user) return;

    document.getElementById('inv-user-name').textContent = this.user.name || '';

    this._setDefaultDates();
    await this.loadAllowedBranches();
    this._bindEvents();
  },

  _setDefaultDates() {
    const today = new Date();
    const yyyy  = today.getFullYear();
    const mm    = String(today.getMonth() + 1).padStart(2, '0');
    const dd    = String(today.getDate()).padStart(2, '0');
    const first = `${yyyy}-${mm}-01`;
    const last  = `${yyyy}-${mm}-${dd}`;
    document.getElementById('inv-date-from').value = first;
    document.getElementById('inv-date-to').value   = last;
  },

  async loadAllowedBranches() {
    try {
      this.branches = await investorService.getAllowedBranches(this.user.id);
    } catch (e) {
      this._showError('Gagal memuat daftar cabang: ' + e.message);
      return;
    }

    const select = document.getElementById('inv-branch-filter');
    if (!this.branches.length) {
      select.innerHTML = '<option value="">Tidak ada cabang</option>';
      this._showError('Akun investor belum memiliki akses cabang. Hubungi admin.');
      return;
    }

    select.innerHTML = this.branches.map(b =>
      `<option value="${b.branch_id}">${b.branch_name}</option>`
    ).join('');

    this.selectedBranchId = this.branches[0].branch_id;
    await this.loadDashboard();
  },

  _bindEvents() {
    document.getElementById('inv-logout-btn').addEventListener('click', () => auth.logout());

    document.getElementById('inv-refresh-btn').addEventListener('click', () => this.loadDashboard());

    document.getElementById('inv-branch-filter').addEventListener('change', e => {
      this.selectedBranchId = Number(e.target.value);
      this.loadDashboard();
    });

    document.querySelectorAll('[data-inv-tab]').forEach(btn => {
      btn.addEventListener('click', e => {
        const tab = e.currentTarget.dataset.invTab;
        this._switchTab(tab);
        if (this.salesCache) this._renderTabFromCache(tab);
        else this.loadDashboard();
      });
    });
  },

  _switchTab(tab) {
    this.currentTab = tab;
    document.querySelectorAll('.inv-tab').forEach(b => b.classList.toggle('active', b.dataset.invTab === tab));
    document.querySelectorAll('.inv-panel').forEach(p => p.classList.toggle('active', p.id === `inv-panel-${tab}`));
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

    this._hideError();
    this.salesCache = null;

    try {
      const [salesData, productData, inventoryData, usageData] = await Promise.all([
        investorService.getSalesReport({ userId: this.user.id, branchId, dateFrom, dateTo, paymentMethod }),
        investorService.getProductPerformance({ userId: this.user.id, branchId, dateFrom, dateTo }),
        investorService.getInventorySummary({ userId: this.user.id, branchId, date: dateTo }),
        investorService.getInventoryUsage({ userId: this.user.id, branchId, dateFrom, dateTo })
      ]);

      this.salesCache = { salesData, productData, inventoryData, usageData };
      this._renderOverview(salesData, productData);
      this._renderSales(salesData);
      this._renderProducts(productData);
      this._renderInventory(inventoryData);
      this._renderUsage(usageData);
    } catch (e) {
      this._showError('Gagal memuat data: ' + e.message);
    }
  },

  _renderTabFromCache(tab) {
    const { salesData, productData, inventoryData, usageData } = this.salesCache;
    if (tab === 'overview')   this._renderOverview(salesData, productData);
    if (tab === 'sales')      this._renderSales(salesData);
    if (tab === 'products')   this._renderProducts(productData);
    if (tab === 'inventory')  this._renderInventory(inventoryData);
    if (tab === 'usage')      this._renderUsage(usageData);
  },

  _renderOverview(sales, products) {
    const avgTrx = sales.count > 0 ? (sales.totalRevenue / sales.count) : 0;
    const topProduct = products?.[0];

    const cards = [
      { label: 'Total Penjualan',    value: fmt.rupiah(sales.totalRevenue), cls: 'text-success' },
      { label: 'Jumlah Transaksi',   value: sales.count,                    cls: '' },
      { label: 'Rata-rata Transaksi',value: fmt.rupiah(avgTrx),             cls: '' },
      { label: 'Total Diskon',       value: fmt.rupiah(sales.totalDiscount),cls: '' },
      { label: 'Transaksi Void',     value: sales.voidCount,                cls: sales.voidCount > 0 ? 'text-danger' : '' },
      { label: 'Produk Terlaris',    value: topProduct ? `${topProduct.product} (${topProduct.qty}x)` : '—', cls: 'text-primary' }
    ];

    document.getElementById('inv-overview-stats').innerHTML = cards.map(c => `
      <div class="inv-stat">
        <div class="inv-stat-label">${c.label}</div>
        <div class="inv-stat-value ${c.cls}">${c.value}</div>
      </div>
    `).join('');
  },

  _renderSales(sales) {
    const rows = (sales.transactions || []);
    const voidRows = (sales.voidedTransactions || []);
    const all = [...rows, ...voidRows].sort((a, b) => new Date(b.created_at) - new Date(a.created_at));

    document.getElementById('inv-sales-tbody').innerHTML = all.length
      ? all.map(t => {
          const isVoid = t.status === 'void' || t.status === 'voided';
          return `<tr>
            <td>${fmt.date(t.created_at)}</td>
            <td>${t.staff_name || '—'}</td>
            <td>${t.payment_method || '—'}</td>
            <td><span class="${isVoid ? 'badge-void' : 'badge-completed'}">${isVoid ? 'VOID' : 'Selesai'}</span></td>
            <td style="text-align:right;">${fmt.rupiah(t.total)}</td>
          </tr>`;
        }).join('')
      : `<tr><td colspan="5" class="inv-empty">Tidak ada transaksi untuk periode ini</td></tr>`;
  },

  _renderProducts(products) {
    document.getElementById('inv-products-tbody').innerHTML = products?.length
      ? products.map(p => `<tr>
          <td>${p.product || '—'}</td>
          <td>${p.variant || '—'}</td>
          <td style="text-align:right;">${p.qty}</td>
          <td style="text-align:right;">${fmt.rupiah(p.revenue)}</td>
        </tr>`).join('')
      : `<tr><td colspan="4" class="inv-empty">Tidak ada data produk untuk periode ini</td></tr>`;
  },

  _renderInventory(items) {
    document.getElementById('inv-inventory-tbody').innerHTML = items?.length
      ? items.map(i => `<tr>
          <td>${i.ingredient_name || '—'}</td>
          <td>${fmt.num(i.stock)}</td>
          <td>${i.unit || '—'}</td>
          <td style="text-align:right;">${fmt.num(i.used_today)}</td>
          <td>${i.last_updated ? fmt.date(i.last_updated) : '—'}</td>
        </tr>`).join('')
      : `<tr><td colspan="5" class="inv-empty">Tidak ada data stok</td></tr>`;
  },

  _renderUsage(items) {
    document.getElementById('inv-usage-tbody').innerHTML = items?.length
      ? items.map(i => `<tr>
          <td>${i.ingredient_name || '—'}</td>
          <td style="text-align:right;">${fmt.num(i.total_used)}</td>
          <td>${i.unit || '—'}</td>
        </tr>`).join('')
      : `<tr><td colspan="3" class="inv-empty">Tidak ada pemakaian bahan untuk periode ini</td></tr>`;
  },

  _showError(msg) {
    const el = document.getElementById('inv-error-banner');
    if (!el) return;
    el.textContent = msg;
    el.style.display = 'block';
  },

  _hideError() {
    const el = document.getElementById('inv-error-banner');
    if (el) el.style.display = 'none';
  }
};
