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
  _actionBusy: new Set(),

  // State untuk create modal
  _createBusy: false,
  _createRequestId: null,
  _fromBranchBalance: null,
  _fromBranchBalanceLoading: false,

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

    // Tombol buat transfer admin
    on('cbt-create-btn', 'click', () => this._openCreateModal());

    // Create modal events
    on('act-modal-close',   'click', () => this._closeCreateModal());
    on('act-modal-cancel',  'click', () => this._closeCreateModal());
    on('act-from-branch',   'change', e => this._onFromBranchChange(e.target.value));
    on('act-modal-submit',  'click', () => this._submitCreate());

    // Tutup create modal saat klik overlay
    const createModal = document.getElementById('modal-admin-create-cash-transfer');
    if (createModal) {
      createModal.addEventListener('click', e => {
        if (e.target === createModal) this._closeCreateModal();
      });
    }

    // Format input nominal jadi angka saja saat blur
    const amtInput = document.getElementById('act-amount');
    if (amtInput) {
      amtInput.addEventListener('input', () => {
        amtInput.value = amtInput.value.replace(/[^0-9]/g, '');
      });
    }

    // Table delegation
    const tbody = document.getElementById('cbt-table-body');
    if (tbody) {
      tbody.addEventListener('click', e => {
        const btn = e.target.closest('[data-cbt-action]');
        if (!btn) return;
        const action     = btn.dataset.cbtAction;
        const transferId = btn.dataset.transferId;
        const row        = this._rows.find(r => String(r.transfer_id) === String(transferId));
        if (!row) return;
        if (action === 'detail') this._openDetail(row);
        if (action === 'approve') this._approveTransfer(row);
        if (action === 'reject') this._rejectTransfer(row);
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
        const btn = e.target.closest('[data-cbt-detail-action]');
        if (!btn) return;
        const row = this._rows.find(r => String(r.transfer_id) === String(btn.dataset.transferId));
        if (!row) return;
        const action = btn.dataset.cbtDetailAction;
        if (action === 'approve') this._approveTransfer(row);
        if (action === 'reject') this._rejectTransfer(row);
        if (action === 'cancel') this._cancelTransfer(row);
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

    // Isi dropdown create modal juga
    const createOpts = '<option value="">-- Pilih Outlet --</option>' + opts;
    ['act-from-branch', 'act-to-branch'].forEach(id => {
      const sel = document.getElementById(id);
      if (sel) sel.innerHTML = createOpts;
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
      const canAct = row.status === 'pending';
      const busy = this._actionBusy.has(String(row.transfer_id));
      const pendingActions = canAct ? `
            <button class="btn btn-ghost btn-sm" data-cbt-action="approve" data-transfer-id="${escHtml(row.transfer_id)}" title="Approve sebagai admin" ${busy ? 'disabled' : ''} style="color:var(--success)">
              <i data-lucide="check-circle-2" style="width:14px;height:14px"></i>
            </button>
            <button class="btn btn-ghost btn-sm" data-cbt-action="reject" data-transfer-id="${escHtml(row.transfer_id)}" title="Tolak sebagai admin" ${busy ? 'disabled' : ''} style="color:var(--danger)">
              <i data-lucide="x" style="width:14px;height:14px"></i>
            </button>
            <button class="btn btn-ghost btn-sm" data-cbt-action="cancel" data-transfer-id="${escHtml(row.transfer_id)}" title="Batalkan" ${busy ? 'disabled' : ''} style="color:var(--danger)">
              <i data-lucide="ban" style="width:14px;height:14px"></i>
            </button>` : '';

      return `
        <tr>
          <td class="text-muted" style="font-size:11px">${idx + 1}</td>
          <td><code style="font-size:11px">${escHtml(row.transfer_code || '-')}</code></td>
          <td style="font-size:12px">${fmtDt(row.requested_at)}</td>
          <td>${escHtml(row.from_branch_name || '-')}</td>
          <td>${escHtml(row.to_branch_name || '-')}</td>
          <td style="font-size:12px">${row.staff_name ? escHtml(row.staff_name) : '<span class="badge badge-info" style="font-size:10px">Admin</span>'}</td>
          <td class="text-right"><strong>${fmtRp(row.amount)}</strong></td>
          <td><span class="badge ${status.cls}">${escHtml(status.label)}</span>${Number(row.auto_approved) === 1 ? ' <span class="badge badge-info" style="font-size:9px">Auto</span>' : ''}</td>
          <td style="font-size:12px">${Number(row.auto_approved) === 1 ? '<span class="text-muted">Otomatis (foto)</span>' : (row.confirmed_by_name ? escHtml(row.confirmed_by_name) : (row.rejected_by_name ? escHtml(row.rejected_by_name) : '-'))}</td>
          <td>
            <button class="btn btn-ghost btn-sm" data-cbt-action="detail" data-transfer-id="${escHtml(row.transfer_id)}" title="Lihat Detail">
              <i data-lucide="eye" style="width:14px;height:14px"></i>
            </button>
            ${pendingActions}
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
    const isPending = row.status === 'pending';
    const busy = this._actionBusy.has(String(row.transfer_id));

    body.innerHTML = `
      <div class="cbt-detail-grid">
        <div class="cbt-detail-row"><span>Kode Transfer</span><strong>${escHtml(row.transfer_code || '-')}</strong></div>
        <div class="cbt-detail-row"><span>Status</span><span class="badge ${status.cls}">${escHtml(status.label)}</span>${Number(row.auto_approved) === 1 ? ' <span class="badge badge-info" style="font-size:9px">Auto</span>' : ''}</div>
        <div class="cbt-detail-row"><span>Dari Outlet</span><strong>${escHtml(row.from_branch_name || '-')}</strong></div>
        <div class="cbt-detail-row"><span>Ke Outlet</span><strong>${escHtml(row.to_branch_name || '-')}</strong></div>
        <div class="cbt-detail-row"><span>${row.staff_name ? 'Staff Pengirim' : 'Inisiator'}</span><strong>${row.staff_name ? escHtml(row.staff_name) : '<span class="badge badge-info">Transfer Langsung Admin</span>'}</strong></div>
        <div class="cbt-detail-row"><span>Jumlah</span><strong>${fmtRp(row.amount)}</strong></div>
        <div class="cbt-detail-row"><span>Waktu Request</span><strong>${fmtDt(row.requested_at)}</strong></div>
        ${row.notes ? `<div class="cbt-detail-row"><span>Catatan</span><strong>${escHtml(row.notes)}</strong></div>` : ''}
        ${row.proof_url ? `<div class="cbt-detail-row"><span>Bukti</span><a href="${escHtml(depositService.normalizeProofUrl(row.proof_url))}" target="_blank" rel="noopener">${escHtml(row.proof_file_name || 'Lihat bukti')}</a></div>` : ''}
        ${row.confirmed_by_name ? `
          <div class="cbt-detail-row cbt-detail-divider"><span>Persetujuan</span><strong>${Number(row.auto_approved) === 1 ? 'Otomatis (foto bukti realtime)' : escHtml(row.confirmed_by_name)}</strong></div>
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
        ${isPending ? `
          <div class="cbt-detail-row cbt-detail-divider" style="display:block">
            <span style="display:block;margin-bottom:8px">Aksi Admin</span>
            <div style="display:flex;flex-wrap:wrap;gap:8px;justify-content:flex-end">
              <button class="btn btn-success btn-sm" data-cbt-detail-action="approve" data-transfer-id="${escHtml(row.transfer_id)}" ${busy ? 'disabled' : ''}>
                <i data-lucide="check-circle-2" class="icon-sm"></i> Approve
              </button>
              <button class="btn btn-outline btn-sm" data-cbt-detail-action="reject" data-transfer-id="${escHtml(row.transfer_id)}" ${busy ? 'disabled' : ''} style="border-color:var(--danger);color:var(--danger)">
                <i data-lucide="x" class="icon-sm"></i> Tolak
              </button>
              <button class="btn btn-outline btn-sm" data-cbt-detail-action="cancel" data-transfer-id="${escHtml(row.transfer_id)}" ${busy ? 'disabled' : ''} style="border-color:var(--danger);color:var(--danger)">
                <i data-lucide="ban" class="icon-sm"></i> Batalkan
              </button>
            </div>
          </div>
        ` : ''}
      </div>`;

    modal.classList.add('active');
    modal.style.display = 'flex';
    if (window.lucide) window.requestAnimationFrame(() => lucide.createIcons());
  },

  _closeDetail() {
    const modal = document.getElementById('modal-cbt-detail');
    if (modal) { modal.classList.remove('active'); modal.style.display = 'none'; }
  },

  async _confirmDialog(opts) {
    if (typeof showConfirm === 'function') return showConfirm(opts);
    return window.confirm(`${opts.title || 'Konfirmasi'}\n\n${opts.message || ''}`);
  },

  async _promptDialog(opts) {
    if (typeof showPrompt === 'function') return showPrompt(opts);
    return window.prompt(`${opts.title || 'Input'}\n\n${opts.message || ''}`, opts.defaultValue || '');
  },

  _setActionBusy(transferId, on) {
    const key = String(transferId);
    if (on) this._actionBusy.add(key);
    else this._actionBusy.delete(key);
    this._renderTable();
  },

  _publishCashChanged(source) {
    if (window.RBNDataEvents) RBNDataEvents.publish('cash:changed', { source });
    if (window.adminBranchCashUi) adminBranchCashUi.markDirty();
  },

  async _approveTransfer(row) {
    const transferId = row?.transfer_id;
    const adminId = auth.getSession()?.id;
    if (!transferId || !adminId || this._actionBusy.has(String(transferId))) return;

    const fmtRp = v => typeof formatRupiah === 'function' ? formatRupiah(v || 0) : ('Rp' + (v || 0));
    const ok = await this._confirmDialog({
      title: 'Approve Setoran Antar Outlet',
      message: `Approve ${row.transfer_code || 'transfer ini'} senilai ${fmtRp(row.amount)} dari ${row.from_branch_name || '-'} ke ${row.to_branch_name || '-'}?`,
      subText: 'Saldo outlet asal akan berkurang dan saldo outlet tujuan akan bertambah.',
      confirmText: 'Ya, Approve',
      success: true
    });
    if (!ok) return;

    this._setActionBusy(transferId, true);
    try {
      const result = await cashBranchTransferService.confirmTransfer({
        transferId,
        userId: adminId
      });
      if (typeof showToast === 'function') showToast(result?.message || 'Setoran antar outlet berhasil di-approve.', 'success');
      this._closeDetail();
      await this.load();
      this._publishCashChanged('admin-cbt-approve');
    } catch (e) {
      if (window.showDbError) showDbError(e, { action: 'approve setoran antar outlet', entity: 'Setoran antar outlet' });
      else if (typeof showToast === 'function') showToast(e.message || 'Gagal approve transfer', 'error');
    } finally {
      this._setActionBusy(transferId, false);
    }
  },

  async _rejectTransfer(row) {
    const transferId = row?.transfer_id;
    const adminId = auth.getSession()?.id;
    if (!transferId || !adminId || this._actionBusy.has(String(transferId))) return;

    const reason = await this._promptDialog({
      title: 'Tolak Setoran Antar Outlet',
      message: `Masukkan alasan penolakan untuk ${row.transfer_code || 'transfer ini'}.`,
      placeholder: 'Alasan penolakan',
      confirmText: 'Tolak'
    });
    if (reason === null) return;
    if (!reason || reason.trim().length < 3) {
      if (typeof showToast === 'function') showToast('Alasan wajib diisi minimal 3 karakter', 'error');
      return;
    }

    this._setActionBusy(transferId, true);
    try {
      await cashBranchTransferService.rejectTransfer({
        transferId,
        userId: adminId,
        reason: reason.trim()
      });
      if (typeof showToast === 'function') showToast('Transfer ditolak. Saldo outlet tidak berubah.', 'info');
      this._closeDetail();
      await this.load();
      this._publishCashChanged('admin-cbt-reject');
    } catch (e) {
      if (window.showDbError) showDbError(e, { action: 'menolak setoran antar outlet', entity: 'Setoran antar outlet' });
      else if (typeof showToast === 'function') showToast(e.message || 'Gagal menolak transfer', 'error');
    } finally {
      this._setActionBusy(transferId, false);
    }
  },

  async _cancelTransfer(row) {
    const transferId = row?.transfer_id;
    const adminId = auth.getSession()?.id;
    if (!transferId || !adminId || this._actionBusy.has(String(transferId))) return;

    const reason = await this._promptDialog({
      title: 'Batalkan Setoran Antar Outlet',
      message: `Masukkan alasan pembatalan untuk ${row.transfer_code || 'transfer ini'} (wajib untuk admin).`,
      placeholder: 'Alasan pembatalan',
      confirmText: 'Batalkan Transfer'
    });
    if (reason === null) return;
    if (!reason || reason.trim().length < 3) {
      if (typeof showToast === 'function') showToast('Alasan wajib diisi minimal 3 karakter', 'error');
      return;
    }
    this._setActionBusy(transferId, true);
    try {
      await cashBranchTransferService.cancelTransfer({
        transferId,
        userId:     adminId,
        reason:     reason.trim()
      });
      if (typeof showToast === 'function') showToast('Transfer dibatalkan.', 'info');
      this._closeDetail();
      await this.load();
      this._publishCashChanged('admin-cbt-cancel');
    } catch (e) {
      if (window.showDbError) showDbError(e, { action: 'membatalkan setoran antar outlet', entity: 'Setoran antar outlet' });
      else if (typeof showToast === 'function') showToast(e.message || 'Gagal membatalkan transfer', 'error');
    } finally {
      this._setActionBusy(transferId, false);
    }
  },

  // ── Create Transfer Admin ─────────────────────────────────────────────────

  _openCreateModal() {
    // Generate idempotency key baru untuk setiap pembukaan modal
    this._createRequestId = (typeof crypto !== 'undefined' && crypto.randomUUID)
      ? crypto.randomUUID()
      : (Date.now() + '-' + Math.random().toString(36).slice(2));

    this._fromBranchBalance = null;
    this._createBusy        = false;

    // Reset form
    const fields = ['act-from-branch', 'act-to-branch', 'act-amount', 'act-notes'];
    fields.forEach(id => {
      const el = document.getElementById(id);
      if (el) el.value = '';
    });
    this._updateBalanceDisplay(null, false);
    this._setCreateSubmitState(false);

    // Pastikan dropdown terisi
    if (this._branches.length) this._populateBranchFilters();

    const modal = document.getElementById('modal-admin-create-cash-transfer');
    if (modal) { modal.style.display = 'flex'; modal.classList.add('active'); }
    if (window.lucide) window.requestAnimationFrame(() => lucide.createIcons());
  },

  _closeCreateModal() {
    const modal = document.getElementById('modal-admin-create-cash-transfer');
    if (modal) { modal.classList.remove('active'); modal.style.display = 'none'; }
  },

  async _onFromBranchChange(branchId) {
    if (!branchId) {
      this._updateBalanceDisplay(null, false);
      return;
    }
    this._updateBalanceDisplay(null, true);
    try {
      const balance = await cashBranchTransferService.getBranchBalance(branchId);
      this._fromBranchBalance = balance;
      this._updateBalanceDisplay(balance, false);
    } catch {
      this._updateBalanceDisplay(null, false);
    }
  },

  _updateBalanceDisplay(balance, loading) {
    const wrap = document.getElementById('act-from-balance-info');
    const text = document.getElementById('act-from-balance-display');
    if (!wrap || !text) return;

    if (loading) {
      wrap.style.display = 'block';
      text.textContent = 'Memuat...';
      return;
    }
    if (balance === null) {
      wrap.style.display = 'none';
      return;
    }
    wrap.style.display = 'block';
    const fmt = v => typeof formatRupiah === 'function' ? formatRupiah(v || 0) : ('Rp ' + (v || 0));
    text.textContent = fmt(balance);
    text.style.color = balance > 0 ? 'var(--success, #16a34a)' : 'var(--danger, #dc2626)';
  },

  _setCreateSubmitState(busy) {
    const btn = document.getElementById('act-modal-submit');
    if (!btn) return;
    btn.disabled = busy;
    btn.innerHTML = busy
      ? '<span class="btn-spinner"></span> Memproses...'
      : '<i data-lucide="send" style="width:14px;height:14px"></i> Transfer Sekarang';
    if (!busy && window.lucide) window.requestAnimationFrame(() => lucide.createIcons());
  },

  async _submitCreate() {
    if (this._createBusy) return;

    const adminId    = auth.getSession()?.id;
    const fromBranch = document.getElementById('act-from-branch')?.value;
    const toBranch   = document.getElementById('act-to-branch')?.value;
    const amountRaw  = document.getElementById('act-amount')?.value?.replace(/[^0-9]/g, '') || '';
    const notes      = document.getElementById('act-notes')?.value?.trim() || '';

    // Validasi frontend
    if (!fromBranch) { if (typeof showToast === 'function') showToast('Outlet asal wajib dipilih', 'error'); return; }
    if (!toBranch)   { if (typeof showToast === 'function') showToast('Outlet tujuan wajib dipilih', 'error'); return; }
    if (String(fromBranch) === String(toBranch)) { if (typeof showToast === 'function') showToast('Outlet asal dan tujuan tidak boleh sama', 'error'); return; }
    if (!amountRaw || amountRaw === '0') { if (typeof showToast === 'function') showToast('Nominal transfer wajib diisi', 'error'); return; }

    const amount = Number(amountRaw);
    if (!amount || amount <= 0) { if (typeof showToast === 'function') showToast('Nominal transfer harus lebih dari 0', 'error'); return; }
    if (this._fromBranchBalance !== null && amount > this._fromBranchBalance) {
      const fmt = v => typeof formatRupiah === 'function' ? formatRupiah(v) : ('Rp ' + v);
      if (typeof showToast === 'function') showToast(`Saldo tidak cukup. Tersedia: ${fmt(this._fromBranchBalance)}`, 'error');
      return;
    }

    const fromName = this._branches.find(b => String(b.id) === String(fromBranch))?.name || 'Outlet Asal';
    const toName   = this._branches.find(b => String(b.id) === String(toBranch))?.name   || 'Outlet Tujuan';
    const fmt = v => typeof formatRupiah === 'function' ? formatRupiah(v) : ('Rp ' + v);

    const ok = await this._confirmDialog({
      title:       'Konfirmasi Transfer Kas',
      message:     `Transfer ${fmt(amount)} dari <strong>${fromName}</strong> ke <strong>${toName}</strong>?`,
      subText:     'Saldo kedua outlet akan berubah seketika dan tidak bisa diurungkan.',
      confirmText: 'Ya, Transfer Sekarang',
      success:     true
    });
    if (!ok) return;

    this._createBusy = true;
    this._setCreateSubmitState(true);
    try {
      const result = await cashBranchTransferService.adminCreateTransfer({
        adminId,
        fromBranchId:    fromBranch,
        toBranchId:      toBranch,
        amount,
        notes:           notes || null,
        clientRequestId: this._createRequestId
      });

      if (typeof showToast === 'function') {
        showToast(
          `Transfer ${result.transfer_code || ''} berhasil. Saldo ${fromName} berkurang dan ${toName} bertambah.`,
          'success'
        );
      }
      this._closeCreateModal();
      await this.load();
      this._publishCashChanged('admin-create-transfer');
    } catch (e) {
      if (window.showDbError) showDbError(e, { action: 'membuat transfer kas outlet', entity: 'Transfer Kas' });
      else if (typeof showToast === 'function') showToast(e.message || 'Gagal membuat transfer', 'error');
    } finally {
      this._createBusy = false;
      this._setCreateSubmitState(false);
    }
  }
};

window.adminCashBranchTransferUi = adminCashBranchTransferUi;
adminCashBranchTransferUi.init();
