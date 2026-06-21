'use strict';

// ════════════════════════════════════════════════════════════════════════════
// adminManualTransactionUi — Input transaksi manual oleh admin
// (transaksi susulan / offline / koreksi). Memanggil RPC
// `admin_create_manual_transaction`. Konsisten dengan transaksi POS: masuk
// laporan penjualan (tabel transactions), ditandai source='manual'. TIDAK
// menyentuh posisi kas outlet / stok (sesuai keputusan desain).
// ════════════════════════════════════════════════════════════════════════════

const adminManualTransactionUi = {
  user: null,
  el: {},
  branches: [],
  staff: [],
  paymentMethods: [],
  catalog: [],        // produk yang tersedia di cabang terpilih
  rows: [],           // baris item: { idx, productId, variantId, qty, price }
  _rowCounter: 0,
  _clientTxId: null,
  _saving: false,
  _bound: false,

  // ── Init ──────────────────────────────────────────────────────────────────
  init() {
    document.addEventListener('DOMContentLoaded', () => {
      try {
        if (!auth.requireAnyRole(['admin', 'owner'])) return;
        this.bindElements();
        this.bindEvents();
      } catch (e) {
        console.error('adminManualTransactionUi.init', e);
      }
    });
  },

  bindElements() {
    this.el.modal        = document.getElementById('modal-manual-trx');
    this.el.branch       = document.getElementById('manual-trx-branch');
    this.el.staff        = document.getElementById('manual-trx-staff');
    this.el.datetime     = document.getElementById('manual-trx-datetime');
    this.el.payment      = document.getElementById('manual-trx-payment');
    this.el.items        = document.getElementById('manual-trx-items');
    this.el.itemsEmpty   = document.getElementById('manual-trx-items-empty');
    this.el.discount     = document.getElementById('manual-trx-discount');
    this.el.paymentAmount= document.getElementById('manual-trx-payment-amount');
    this.el.notes        = document.getElementById('manual-trx-notes');
    this.el.subtotal     = document.getElementById('manual-trx-subtotal');
    this.el.discountView = document.getElementById('manual-trx-discount-view');
    this.el.total        = document.getElementById('manual-trx-total');
    this.el.change       = document.getElementById('manual-trx-change');
    this.el.saveBtn      = document.getElementById('btn-save-manual-trx');
  },

  bindEvents() {
    if (this._bound) return;
    this._bound = true;

    // Aksi tingkat modal (add-item / remove-item / save)
    document.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-manual-trx-action]');
      if (!btn) return;
      const action = btn.dataset.manualTrxAction;
      if (action === 'add-item')    { e.preventDefault(); this.addItem(); }
      else if (action === 'remove-item') { e.preventDefault(); this.removeItem(Number(btn.dataset.rowIndex)); }
      else if (action === 'save')   { e.preventDefault(); this.save(); }
    });

    // Perubahan select (cabang / kasir / metode / produk / varian)
    document.addEventListener('change', (e) => {
      if (e.target === this.el.branch)  { this.onBranchChange(); return; }
      const field = e.target.closest('[data-manual-row-field]');
      if (!field) return;
      const idx  = Number(field.dataset.rowIndex);
      const kind = field.dataset.manualRowField;
      if (kind === 'product') this.onRowProductChange(idx, field.value);
      else if (kind === 'variant') this.onRowVariantChange(idx, field.value);
    });

    // Input angka (qty / harga / diskon / pembayaran) — hanya hitung ulang total
    document.addEventListener('input', (e) => {
      if (e.target === this.el.discount || e.target === this.el.paymentAmount) {
        this.recomputeTotals();
        return;
      }
      const field = e.target.closest('[data-manual-row-field]');
      if (!field) return;
      const idx  = Number(field.dataset.rowIndex);
      const kind = field.dataset.manualRowField;
      const row  = this.rows.find(r => r.idx === idx);
      if (!row) return;
      if (kind === 'qty')   row.qty = field.value;
      if (kind === 'price') row.price = field.value;
      this._updateLineSubtotal(idx);
      this.recomputeTotals();
    });
  },

  // ── Buka modal ────────────────────────────────────────────────────────────
  async open() {
    this.user = auth.requireAnyRole(['admin', 'owner']);
    if (!this.user) return;
    this.bindElements();

    // Reset state
    this.rows = [];
    this._rowCounter = 0;
    this.catalog = [];
    this._saving = false;
    this._clientTxId = 'manual-' + Date.now() + '-' + Math.random().toString(36).slice(2, 10);

    if (this.el.discount)      this.el.discount.value = '';
    if (this.el.paymentAmount) this.el.paymentAmount.value = '';
    if (this.el.notes)         this.el.notes.value = '';
    if (this.el.datetime)      this.el.datetime.value = this._nowWitaInput();
    if (this.el.saveBtn)       this.el.saveBtn.disabled = false;

    this.renderRows();
    this.recomputeTotals();
    openModal('modal-manual-trx');

    // Muat data referensi (branch / payment / staff)
    try {
      await Promise.all([this.loadBranches(), this.loadPaymentMethods(), this.loadStaff()]);
    } catch (e) {
      showToast('Gagal memuat data: ' + e.message, 'error');
    }
  },

  // ── Data referensi ──────────────────────────────────────────────────────────
  async loadBranches() {
    const { data, error } = await db.from('branches').select('id, name, is_active').order('name');
    if (error) throw new Error(error.message);
    this.branches = (data || []).filter(b => b.is_active === undefined || b.is_active === null || Number(b.is_active) === 1);
    this.el.branch.innerHTML = `<option value="">— Pilih Cabang —</option>` +
      this.branches.map(b => `<option value="${b.id}">${escHtml(b.name)}</option>`).join('');
    this.populateStaffOptions();
  },

  async loadPaymentMethods() {
    let methods = [];
    try {
      const { data, error } = await db.from('payment_methods').select('code, label, is_active').order('id');
      if (!error && Array.isArray(data)) {
        methods = data.filter(m => m.is_active === undefined || Number(m.is_active) === 1)
                      .map(m => ({ code: m.code, label: m.label || m.code }));
      }
    } catch (_) { /* fallback di bawah */ }
    if (!methods.length) {
      methods = [{ code: 'cash', label: 'Tunai' }, { code: 'qris', label: 'QRIS' }, { code: 'transfer', label: 'Transfer' }];
    }
    this.paymentMethods = methods;
    this.el.payment.innerHTML = methods.map(m => `<option value="${escHtml(m.code)}">${escHtml(m.label)}</option>`).join('');
  },

  async loadStaff() {
    const { data, error } = await db.from('users').select('id, name, role, branch_id, is_active').order('name');
    if (error) throw new Error(error.message);
    this.staff = (data || []).filter(u => (u.is_active === undefined || Number(u.is_active) === 1)
      && ['staff', 'admin', 'owner'].includes(u.role));
    this.populateStaffOptions();
  },

  populateStaffOptions() {
    if (!this.el.staff) return;
    const branchId = this.el.branch?.value ? Number(this.el.branch.value) : null;
    const adminName = this.user?.name || 'Admin';
    // Kasir yang relevan untuk cabang terpilih (atau semua jika belum pilih cabang)
    const list = this.staff.filter(u => {
      if (u.role === 'admin' || u.role === 'owner') return false; // admin tampil via opsi default
      if (!branchId) return true;
      return !u.branch_id || Number(u.branch_id) === branchId;
    });
    const opts = list.map(u => `<option value="${u.id}">${escHtml(u.name)}</option>`).join('');
    this.el.staff.innerHTML = `<option value="">— Atas nama admin (${escHtml(adminName)}) —</option>` + opts;
  },

  // ── Catalog produk per cabang ───────────────────────────────────────────────
  async onBranchChange() {
    this.populateStaffOptions();
    const branchId = this.el.branch.value ? Number(this.el.branch.value) : null;
    this.catalog = [];
    // Reset item rows saat ganti cabang (harga & ketersediaan berubah)
    this.rows = [];
    this._rowCounter = 0;
    if (!branchId) { this.renderRows(); this.recomputeTotals(); return; }

    try {
      const { data: bps, error } = await db
        .from('branch_products')
        .select('product_id, products(id, name, has_variants, default_price, price, is_active, product_variants(id, name, price, is_active))')
        .eq('branch_id', branchId)
        .eq('is_active', true);
      if (error) throw new Error(error.message);

      let overrideMap = {};
      try {
        const { data: ov } = await db.from('branch_variant_prices').select('variant_id, price').eq('branch_id', branchId);
        (ov || []).forEach(o => { overrideMap[o.variant_id] = parseFloat(o.price); });
      } catch (_) { /* tabel opsional */ }

      const seen = {};
      (bps || []).forEach(row => {
        const p = row.products;
        if (!p) return;
        if (p.is_active !== undefined && Number(p.is_active) === 0) return;
        if (seen[p.id]) return;
        seen[p.id] = true;
        const variants = (p.product_variants || [])
          .filter(v => v.is_active === undefined || Number(v.is_active) === 1)
          .map(v => ({
            // API tabel cPanel mengembalikan id relasi embed sebagai STRING.
            // Normalkan ke Number agar perbandingan `=== Number(...)` cocok.
            id: Number(v.id),
            name: v.name,
            price: overrideMap[v.id] !== undefined ? overrideMap[v.id] : parseFloat(v.price || 0),
          }));
        const basePrice = (p.default_price !== null && p.default_price !== undefined)
          ? parseFloat(p.default_price) : parseFloat(p.price || 0);
        this.catalog.push({
          id: Number(p.id),
          name: p.name || 'Produk',
          hasVariants: Number(p.has_variants) === 1 && variants.length > 0,
          basePrice,
          variants,
        });
      });
      this.catalog.sort((a, b) => a.name.localeCompare(b.name));
    } catch (e) {
      showToast('Gagal memuat produk cabang: ' + e.message, 'error');
    }

    // Mulai dengan satu baris kosong agar admin langsung bisa input
    this.addItem();
  },

  // ── Item rows ───────────────────────────────────────────────────────────────
  addItem() {
    if (!this.el.branch.value) { showToast('Pilih cabang terlebih dahulu', 'warning'); return; }
    this.rows.push({ idx: ++this._rowCounter, productId: '', variantId: '', qty: '1', price: '' });
    this.renderRows();
    this.recomputeTotals();
  },

  removeItem(idx) {
    this.rows = this.rows.filter(r => r.idx !== idx);
    this.renderRows();
    this.recomputeTotals();
  },

  onRowProductChange(idx, value) {
    const row = this.rows.find(r => r.idx === idx);
    if (!row) return;
    row.productId = value;
    row.variantId = '';
    const prod = this.catalog.find(c => c.id === Number(value));
    row.price = (prod && !prod.hasVariants) ? String(prod.basePrice) : '';
    // Update HANYA varian-cell + harga baris ini — jangan rebuild semua baris,
    // agar <select> produk yang baru saja dipilih tidak ikut dihancurkan (penting
    // di mobile: re-render saat event change bisa membatalkan pilihan).
    const rowEl = this.el.items?.querySelector(`[data-row="${idx}"]`);
    if (rowEl) {
      const vCell = rowEl.querySelector('[data-variant-cell]');
      if (vCell) vCell.innerHTML = this._variantCellHtml(row, prod);
      const priceInput = rowEl.querySelector('[data-manual-row-field="price"]');
      if (priceInput) priceInput.value = row.price;
    }
    this._updateLineSubtotal(idx);
    this.recomputeTotals();
  },

  onRowVariantChange(idx, value) {
    const row = this.rows.find(r => r.idx === idx);
    if (!row) return;
    row.variantId = value;
    const prod = this.catalog.find(c => c.id === Number(row.productId));
    const variant = prod?.variants.find(v => v.id === Number(value));
    if (variant) row.price = String(variant.price);
    const rowEl = this.el.items?.querySelector(`[data-row="${idx}"]`);
    const priceInput = rowEl?.querySelector('[data-manual-row-field="price"]');
    if (priceInput) priceInput.value = row.price;
    this._updateLineSubtotal(idx);
    this.recomputeTotals();
  },

  _variantCellHtml(row, prod) {
    if (prod && prod.hasVariants) {
      const vOpts = `<option value="">— Pilih Varian —</option>` +
        prod.variants.map(v => `<option value="${v.id}" ${Number(row.variantId) === v.id ? 'selected' : ''}>${escHtml(v.name)} — ${fRp(v.price)}</option>`).join('');
      return `<label class="form-label" style="font-size:11px;">Varian *</label>
        <select class="form-control" data-manual-row-field="variant" data-row-index="${row.idx}">${vOpts}</select>`;
    }
    return `<label class="form-label" style="font-size:11px;">Varian</label>
      <input class="form-control" value="${prod ? '(tanpa varian)' : '—'}" disabled style="background:#f1f5f9;color:#94a3b8;" />`;
  },

  _lineSubtotal(row) {
    if (!row.productId) return 0;
    const qty = parseInt(row.qty) || 0;
    return this.rowEffectivePrice(row) * Math.max(0, qty);
  },

  _updateLineSubtotal(idx) {
    const row = this.rows.find(r => r.idx === idx);
    const el = this.el.items?.querySelector(`[data-line-subtotal="${idx}"]`);
    if (row && el) el.textContent = fRp(this._lineSubtotal(row));
  },

  renderRows() {
    if (!this.el.items) return;
    if (!this.rows.length) {
      this.el.items.innerHTML = '';
      if (this.el.itemsEmpty) this.el.itemsEmpty.style.display = '';
      return;
    }
    if (this.el.itemsEmpty) this.el.itemsEmpty.style.display = 'none';

    this.el.items.innerHTML = this.rows.map((row, i) => {
      const prod = this.catalog.find(c => c.id === Number(row.productId));
      const productOpts = `<option value="">— Pilih Produk —</option>` +
        this.catalog.map(c => `<option value="${c.id}" ${Number(row.productId) === c.id ? 'selected' : ''}>${escHtml(c.name)}</option>`).join('');
      return `
        <div class="card mtx-item" data-row="${row.idx}">
          <div style="display:flex;justify-content:space-between;align-items:center;gap:8px;">
            <strong style="font-size:12px;color:var(--text-muted,#64748b);">Item ${i + 1}</strong>
            <button class="btn btn-danger-soft btn-sm" data-manual-trx-action="remove-item" data-row-index="${row.idx}">Hapus</button>
          </div>
          <div class="form-group" style="margin:0;">
            <label class="form-label" style="font-size:11px;">Produk *</label>
            <select class="form-control" data-manual-row-field="product" data-row-index="${row.idx}">${productOpts}</select>
          </div>
          <div class="form-group" style="margin:0;" data-variant-cell>${this._variantCellHtml(row, prod)}</div>
          <div class="mtx-item-fields">
            <div class="form-group" style="flex:1;min-width:80px;">
              <label class="form-label" style="font-size:11px;">Qty *</label>
              <input type="number" class="form-control" inputmode="numeric" min="1" step="1" value="${escHtml(row.qty)}" data-manual-row-field="qty" data-row-index="${row.idx}" />
            </div>
            <div class="form-group" style="flex:2;min-width:130px;">
              <label class="form-label" style="font-size:11px;">Harga Satuan (Rp)</label>
              <input type="number" class="form-control" inputmode="numeric" min="0" step="any" value="${escHtml(row.price)}" placeholder="0" data-manual-row-field="price" data-row-index="${row.idx}" />
            </div>
            <div class="form-group" style="flex:1;min-width:110px;text-align:right;">
              <label class="form-label" style="font-size:11px;">Subtotal</label>
              <div class="fw-700" style="padding-top:8px;" data-line-subtotal="${row.idx}">${fRp(this._lineSubtotal(row))}</div>
            </div>
          </div>
        </div>`;
    }).join('');
  },

  // ── Hitung ulang ringkasan ──────────────────────────────────────────────────
  rowEffectivePrice(row) {
    if (row.price !== '' && row.price !== null && !isNaN(parseFloat(row.price))) return parseFloat(row.price);
    const prod = this.catalog.find(c => c.id === Number(row.productId));
    if (!prod) return 0;
    if (prod.hasVariants) {
      const v = prod.variants.find(x => x.id === Number(row.variantId));
      return v ? v.price : 0;
    }
    return prod.basePrice;
  },

  recomputeTotals() {
    let subtotal = 0;
    this.rows.forEach(row => {
      if (!row.productId) return;
      const qty = parseInt(row.qty) || 0;
      subtotal += this.rowEffectivePrice(row) * Math.max(0, qty);
    });
    const discount = Math.max(0, parseFloat(this.el.discount?.value) || 0);
    const effDiscount = Math.min(discount, subtotal);
    const total = Math.max(0, subtotal - effDiscount);
    const payRaw = this.el.paymentAmount?.value;
    const pay = (payRaw === '' || payRaw === null || payRaw === undefined) ? total : Math.max(0, parseFloat(payRaw) || 0);
    const change = Math.max(0, pay - total);

    if (this.el.subtotal)     this.el.subtotal.textContent = fRp(subtotal);
    if (this.el.discountView) this.el.discountView.textContent = effDiscount > 0 ? '−' + fRp(effDiscount) : 'Rp 0';
    if (this.el.total)        this.el.total.textContent = fRp(total);
    if (this.el.change)       this.el.change.textContent = fRp(change);
  },

  // ── Simpan ──────────────────────────────────────────────────────────────────
  async save() {
    if (this._saving) return;

    const branchId = this.el.branch.value ? Number(this.el.branch.value) : null;
    if (!branchId) { showToast('Cabang wajib dipilih', 'error'); return; }

    const datetime = (this.el.datetime.value || '').trim();
    if (!datetime) { showToast('Tanggal & waktu transaksi wajib diisi', 'error'); return; }

    const paymentCode = this.el.payment.value;
    if (!paymentCode) { showToast('Metode pembayaran wajib dipilih', 'error'); return; }

    // Susun item & validasi
    const items = [];
    for (const row of this.rows) {
      if (!row.productId) continue;
      const prod = this.catalog.find(c => c.id === Number(row.productId));
      if (!prod) continue;
      const qty = parseInt(row.qty) || 0;
      if (qty <= 0) { showToast('Qty setiap item minimal 1', 'error'); return; }
      if (prod.hasVariants && !row.variantId) { showToast(`Pilih varian untuk produk "${prod.name}"`, 'error'); return; }
      const priceVal = (row.price !== '' && row.price !== null && !isNaN(parseFloat(row.price))) ? parseFloat(row.price) : this.rowEffectivePrice(row);
      if (priceVal < 0) { showToast('Harga item tidak boleh negatif', 'error'); return; }
      items.push({
        product_id: Number(row.productId),
        variant_id: row.variantId ? Number(row.variantId) : null,
        quantity: qty,
        price: priceVal,
      });
    }
    if (!items.length) { showToast('Tambahkan minimal satu item produk', 'error'); return; }

    const discount = Math.max(0, parseFloat(this.el.discount.value) || 0);
    const payRaw = this.el.paymentAmount.value;
    const paymentAmount = (payRaw === '' || payRaw === null) ? null : Math.max(0, parseFloat(payRaw) || 0);
    const staffId = this.el.staff.value ? Number(this.el.staff.value) : null;
    const notes = (this.el.notes.value || '').trim();

    this._saving = true;
    if (this.el.saveBtn) this.el.saveBtn.disabled = true;
    try {
      const { data, error } = await db.rpc('admin_create_manual_transaction', {
        p_admin_id: this.user.id,
        p_branch_id: branchId,
        p_staff_id: staffId,
        p_items: items,
        p_payment_method: paymentCode,
        p_discount_amount: discount,
        p_payment_amount: paymentAmount,
        p_notes: notes,
        p_created_at: datetime,
        p_client_tx_id: this._clientTxId,
      });
      if (error) throw new Error(error.message);

      showToast(`Transaksi manual #${data?.id ?? ''} berhasil disimpan`, 'success');
      closeModal('modal-manual-trx');
      if (window.ADMIN && typeof ADMIN.loadTransactions === 'function') {
        ADMIN.loadTransactions();
      }
    } catch (e) {
      showToast('Gagal menyimpan: ' + e.message, 'error');
      this._saving = false;
      if (this.el.saveBtn) this.el.saveBtn.disabled = false;
    }
  },

  // ── Helper: waktu sekarang dalam WITA (UTC+8) untuk input datetime-local ────
  _nowWitaInput() {
    const now = new Date();
    const wita = new Date(now.getTime() + (now.getTimezoneOffset() + 480) * 60000);
    const p = n => String(n).padStart(2, '0');
    return `${wita.getFullYear()}-${p(wita.getMonth() + 1)}-${p(wita.getDate())}T${p(wita.getHours())}:${p(wita.getMinutes())}`;
  },
};

adminManualTransactionUi.init();
window.adminManualTransactionUi = adminManualTransactionUi;
