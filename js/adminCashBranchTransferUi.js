'use strict';

/**
 * adminCashBranchTransferUi
 * Monitoring Setoran Tunai Antar Outlet untuk Admin / Owner.
 */
const adminCashBranchTransferUi = {

  _rows: [],
  _summary: {},
  _branches: [],
  _loading: false,

  init() {
    document.addEventListener('DOMContentLoaded', async () => {
      try {
        if (!auth.requireAnyRole(['admin', 'owner'])) return;
        this._bindEvents();
        await this._loadBranches();
      } catch (e) {
        console.error('adminCashBranchTransferUi.init', e);
      }
    });
  },

  _bindEvents() {
    const on = (id, ev, fn) => {
      const el = document.getElementById(id);
      if (el) el.addEventListener(ev, fn);
    };

    on('cbt-filter-btn',        'click', () => this.load());
    on('cbt-filter-from-branch','change', () => {});
    on('cbt-filter-to-branch',  'change', () => {});

    // Table delegation
    const tbody = document.getElementById('cbt-table-body');
    if (tbody) {
      tbody.addEventListener('click', e => {
        const btn = e.target.closest('[data-cbt-action]');
        if (!btn) return;
        const action     = btn.dataset.cbtAction;
        const transferId = btn.dataset.transferId;
        const row        = this._rows.find(r => r.transfer_id === transferId);
        if (!row) return;
        if (action === 'detail') this._openDetail(row);
        if (action === 'cancel') this._cancelTransfer(row);
      });
    }

    // Modal close
    on('cbt-detail-close',        'click', () => this._closeDetail());
    on('cbt-detail-close-footer', 'click', () => this._closeDetail());
    const modal = document.getElementById('modal-cbt-detail');
    if (modal) {
      modal.addEventListener('click', e => {
        if (e.target === modal) this._closeDetail();
      });
    }
  },

  async _loadBranches() {
    try {
      const { data, error } = await db
        .from('branches')
        .select('id, name')
        .eq('is_active', true)
        .order('name');
      if (error) throw error;
      this._branches = data || [];
      this._populateBranchFilters();
    } catch (e) {
      console.warn('adminCashBranchTransferUi._loadBranches', e);
    }
  },

  _populateBranchFilters() {
    const opts = this._branches.map(b =>
      `<option value="${escHtml(b.id)}">${escHtml(b.name)}</option>`
    ).join('');

    ['cbt-filter-from-branch', 'cbt-filter-to-branch'].forEach(id => {
      const sel = document.getElementById(id);
      if (!sel) return;
      const current = sel.value;
      sel.innerHTML = '<option value="">Semua Outlet</option>' + opts;
      if (current) sel.value = current;
    });
  },

  async load() {
    if (this._loading) return;
    this._loading = true;
    this._setLoading(true);

    try {
      const adminId      = auth.getSession()?.id;
      const fromBranchId = document.getElementById('cbt-filter-from-branch')?.value || null;
      const toBranchId   = document.getElementById('cbt-filter-to-branch')?.value   || null;
      const status       = document.getElementById('cbt-filter-status')?.value       || null;
      const dateFrom     = document.getElementById('cbt-filter-from')?.value         || null;
      const dateTo       = document.getElementById('cbt-filter-to')?.value           || null;

      const result = await cashBranchTransferService.getAdminTransfers({
        adminId,
        fromBranchId: fromBranchId || null,
        toBranchId:   toBranchId   || null,
        status:       status       || null,
        dateFrom:     dateFrom     || null,
        dateTo:       dateTo       || null,
        limit: 300,
        offset: 0
      });

      this._rows    = Array.isArray(result.transfers) ? result.transfers : [];
      this._summary = result.summary || {};
      this._renderSummaryCards();
      this._renderTable();
    } catch (e) {
      console.error('adminCashBranchTransferUi.load', e);
      if (typeof showToast === 'function') showToast('Gagal memuat data transfer: ' + (e.message || e), 'error');
      this._renderError(e.message || 'Error tidak diketahui');
    } finally {
      this._loading = false;
      this._setLoading(false);
    }
  },

  _setLoading(on) {
    const btn = document.getElementById('cbt-filter-btn');
    if (!btn) return;
    btn.disabled = on;
    btn.innerHTML = on
      ? '<span class="btn-spinner"></span> Memuat...'
      : '<i data-lucide="search" style="width:15px;height:15px"></i> Tampilkan';
    if (!on && window.lucide) window.requestAnimationFrame(() => lucide.createIcons());
  },

  _renderSummaryCards() {
    const el = document.getElementById('cbt-summary-cards');
    if (!el) return;
    const s = this._summary;
    const fmt = v => typeof formatRupiah === 'function' ? formatRupiah(v || 0) : ('Rp' + (v || 0));

    el.innerHTML = `
      <div class="stat-card">
        <div class="stat-icon"><i data-lucide="clock"></i></div>
        <div class="stat-info">
          <div class="stat-label">Pending Antar Outlet</div>
          <div class="stat-value">${s.total_pending_count || 0} item &middot; ${fmt(s.total_pending_amount)}</div>
        </div>
      </div>
      <div class="stat-card">
        <div class="stat-icon"><i data-lucide="check-circle-2"></i></div>
        <div class="stat-info">
          <div class="stat-label">Total Dikonfirmasi</div>
          <div class="stat-value">${fmt(s.total_confirmed_amount)}</div>
        </div>
      </div>
      <div class="stat-card">
        <div class="stat-icon"><i data-lucide="x-circle"></i></div>
        <div class="stat-info">
          <div class="stat-label">Total Ditolak</div>
          <div class="stat-value">${s.total_rejected_count || 0} item &middot; ${fmt(s.total_rejected_amount)}</div>
        </div>
      </div>
      <div class="stat-card">
        <div class="stat-icon"><i data-lucide="building-2"></i></div>
        <div class="stat-info">
          <div class="stat-label">Outlet Terlibat</div>
          <div class="stat-value">${this._countUniqueOutlets()} outlet</div>
        </div>
      </div>`;
    if (window.lucide) lucide.createIcons();
  },

  _countUniqueOutlets() {
    const ids = new Set();
    this._rows.forEach(r => { ids.add(r.from_branch_id); ids.add(r.to_branch_id); });
    return ids.size;
  },

  _renderTable() {
    const tbody = document.getElementById('cbt-table-body');
    if (!tbody) return;

    if (!this._rows.length) {
      tbody.innerHTML = `<tr><td colspan="10" class="empty-td">Tidak ada data. Gunakan filter lalu klik Tampilkan.</td></tr>`;
      return;
    }

    tbody.innerHTML = this._rows.map((row, idx) => {
      const status = this._statusMeta(row.status);
      const fmtRp  = v => typeof formatRupiah === 'function' ? formatRupiah(v || 0) : ('Rp' + (v || 0));
      const fmtDt  = v => v ? (typeof fDate === 'function' ? fDate(v) : new Date(v).toLocaleString('id-ID')) : '-';
      const canCancel = row.status === 'pending';

      return `
        <tr>
          <td class="text-muted" style="font-size:11px">${idx + 1}</td>
          <td><code style="font-size:11px">${escHtml(row.transfer_code || '-')}</code></td>
          <td style="font-size:12px">${fmtDt(row.requested_at)}</td>
          <td>${escHtml(row.from_branch_name || '-')}</td>
          <td>${escHtml(row.to_branch_name || '-')}</td>
          <td style="font-size:12px">${escHtml(row.staff_name || '-')}</td>
          <td class="text-right"><strong>${fmtRp(row.amount)}</strong></td>
          <td><span class="badge ${status.cls}">${escHtml(status.label)}</span></td>
          <td style="font-size:12px">${row.confirmed_by_name ? escHtml(row.confirmed_by_name) : (row.rejected_by_name ? escHtml(row.rejected_by_name) : '-')}</td>
          <td>
            <button class="btn btn-ghost btn-sm" data-cbt-action="detail" data-transfer-id="${escHtml(row.transfer_id)}" title="Lihat Detail">
              <i data-lucide="eye" style="width:14px;height:14px"></i>
            </button>
            ${canCancel ? `<button class="btn btn-ghost btn-sm" data-cbt-action="cancel" data-transfer-id="${escHtml(row.transfer_id)}" title="Batalkan" style="color:var(--danger)"><i data-lucide="x-circle" style="width:14px;height:14px"></i></button>` : ''}
          </td>
        </tr>`;
    }).join('');

    if (window.lucide) window.requestAnimationFrame(() => lucide.createIcons());
  },

  _renderError(msg) {
    const tbody = document.getElementById('cbt-table-body');
    if (tbody) tbody.innerHTML = `<tr><td colspan="10" class="empty-td" style="color:var(--danger)">${escHtml(msg)}</td></tr>`;
  },

  _statusMeta(status) {
    if (status === 'confirmed')  return { label: 'Diterima',   cls: 'badge-success' };
    if (status === 'rejected')   return { label: 'Ditolak',    cls: 'badge-danger' };
    if (status === 'cancelled')  return { label: 'Dibatalkan', cls: 'badge-secondary' };
    return { label: 'Menunggu', cls: 'badge-warning' };
  },

  _openDetail(row) {
    const modal = document.getElementById('modal-cbt-detail');
    const body  = document.getElementById('cbt-detail-body');
    if (!modal || !body) return;

    const fmtRp = v => typeof formatRupiah === 'function' ? formatRupiah(v || 0) : ('Rp' + (v || 0));
    const fmtDt = v => v ? (typeof fDate === 'function' ? fDate(v) : new Date(v).toLocaleString('id-ID')) : '-';
    const status = this._statusMeta(row.status);

    body.innerHTML = `
      <div class="cbt-detail-grid">
        <div class="cbt-detail-row"><span>Kode Transfer</span><strong>${escHtml(row.transfer_code || '-')}</strong></div>
        <div class="cbt-detail-row"><span>Status</span><span class="badge ${status.cls}">${escHtml(status.label)}</span></div>
        <div class="cbt-detail-row"><span>Dari Outlet</span><strong>${escHtml(row.from_branch_name || '-')}</strong></div>
        <div class="cbt-detail-row"><span>Ke Outlet</span><strong>${escHtml(row.to_branch_name || '-')}</strong></div>
        <div class="cbt-detail-row"><span>Staff Pengirim</span><strong>${escHtml(row.staff_name || '-')}</strong></div>
        <div class="cbt-detail-row"><span>Jumlah</span><strong>${fmtRp(row.amount)}</strong></div>
        <div class="cbt-detail-row"><span>Waktu Request</span><strong>${fmtDt(row.requested_at)}</strong></div>
        ${row.notes ? `<div class="cbt-detail-row"><span>Catatan</span><strong>${escHtml(row.notes)}</strong></div>` : ''}
        ${row.proof_url ? `<div class="cbt-detail-row"><span>Bukti</span><a href="${escHtml(row.proof_url)}" target="_blank" rel="noopener">${escHtml(row.proof_file_name || 'Lihat bukti')}</a></div>` : ''}
        ${row.confirmed_by_name ? `
          <div class="cbt-detail-row cbt-detail-divider"><span>Dikonfirmasi Oleh</span><strong>${escHtml(row.confirmed_by_name)}</strong></div>
          <div class="cbt-detail-row"><span>Waktu Konfirmasi</span><strong>${fmtDt(row.confirmed_at)}</strong></div>
          <div class="cbt-detail-row"><span>Saldo Asal Sebelum</span><strong>${fmtRp(row.source_balance_before)}</strong></div>
          <div class="cbt-detail-row"><span>Saldo Asal Sesudah</span><strong>${fmtRp(row.source_balance_after)}</strong></div>
          <div class="cbt-detail-row"><span>Saldo Tujuan Sebelum</span><strong>${fmtRp(row.target_balance_before)}</strong></div>
          <div class="cbt-detail-row"><span>Saldo Tujuan Sesudah</span><strong>${fmtRp(row.target_balance_after)}</strong></div>
        ` : ''}
        ${row.rejected_by_name ? `
          <div class="cbt-detail-row cbt-detail-divider"><span>Ditolak Oleh</span><strong>${escHtml(row.rejected_by_name)}</strong></div>
          <div class="cbt-detail-row"><span>Waktu Penolakan</span><strong>${fmtDt(row.rejected_at)}</strong></div>
          <div class="cbt-detail-row"><span>Alasan Penolakan</span><strong class="text-danger">${escHtml(row.reject_reason || '-')}</strong></div>
        ` : ''}
        ${row.cancel_reason ? `
          <div class="cbt-detail-row cbt-detail-divider"><span>Dibatalkan Oleh</span><strong>${escHtml(row.cancelled_by_name || '-')}</strong></div>
          <div class="cbt-detail-row"><span>Alasan Pembatalan</span><strong>${escHtml(row.cancel_reason)}</strong></div>
        ` : ''}
      </div>`;

    modal.classList.add('active');
    modal.style.display = 'flex';
  },

  _closeDetail() {
    const modal = document.getElementById('modal-cbt-detail');
    if (modal) { modal.classList.remove('active'); modal.style.display = 'none'; }
  },

  async _cancelTransfer(row) {
    const adminId = auth.getSession()?.id;
    if (!adminId) return;
    const reason = window.prompt(
      `Batalkan transfer ${row.transfer_code}?\n\nMasukkan alasan pembatalan (wajib untuk admin):`
    );
    if (!reason || reason.trim().length < 3) {
      if (reason !== null) {
        if (typeof showToast === 'function') showToast('Alasan wajib diisi minimal 3 karakter', 'error');
      }
      return;
    }
    try {
      await cashBranchTransferService.cancelTransfer({
        transferId: row.transfer_id,
        userId:     adminId,
        reason:     reason.trim()
      });
      if (typeof showToast === 'function') showToast('Transfer dibatalkan.', 'info');
      await this.load();
      if (window.RBNDataEvents) RBNDataEvents.publish('cash:changed', { source: 'admin-cbt-cancel' });
    } catch (e) {
      if (typeof showToast === 'function') showToast(e.message || 'Gagal membatalkan transfer', 'error');
    }
  }
};

window.adminCashBranchTransferUi = adminCashBranchTransferUi;
adminCashBranchTransferUi.init();
