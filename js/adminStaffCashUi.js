'use strict';

// Admin cash session UI.
// Staff is only the actor recorded on each shift; the cash position itself is
// owned by the outlet and corrected from the Kas Outlet page.

const adminStaffCashUi = {
  _sessions: [],
  _branches: [],
  _staffRows: [],
  _loading: false,
  _lastUpdated: null,
  _activeDetail: null,
  _activeAction: null,
  _savingAction: false,

  // Legacy staff-balance tab state. The tab is intentionally disabled.
  _balances: [],
  _balancesLoading: false,
  _activeTab: 'sessions',

  // Balance correction modal state
  _bcTarget: null,          // { staffId, staffName, branchId, branchName, currentBalance, version }
  _bcSaving: false,

  // Staff ledger modal state
  _slTarget: null,          // { staffId, staffName, branchId }
  _slData: [],

  init() {
    document.addEventListener('DOMContentLoaded', () => {
      try {
        if (!auth.requireAnyRole(['admin', 'owner'])) return;
        this._bindFilterEvents();
        this._bindRefreshBtn();
        this._bindDetailModalControls();
        this._bindTabEvents();
      } catch (e) {
        console.error('adminStaffCashUi.init', e);
      }
    });
  },

  async load() {
    this._activeTab = 'sessions';
    await this._loadBranches();
    await this._loadStaff();
    await this._loadSessions();
  },

  markDirty() {
    if (window.ADMIN && ADMIN.currentSection === 'staff-cash-position') {
      this._loadSessions();
    }
    if (this._activeDetail?.session?.id) {
      this._refreshActiveDetail(this._activeDetail.session.id).catch(err => {
        console.warn('adminStaffCashUi.markDirty detail refresh failed', err);
      });
    }
  },

  async _loadBranches() {
    if (this._branches.length) {
      this._populateBranchFilter();
      return;
    }
    try {
      const { data, error } = await db.from('branches').select('id, name, is_active').order('name');
      if (error) throw error;
      this._branches = (data || []).filter(b => b.is_active !== false);
      this._populateBranchFilter();
    } catch (e) {
      console.warn('adminStaffCashUi._loadBranches', e);
    }
  },

  async _loadStaff() {
    if (this._staffRows.length) {
      this._populateStaffFilter();
      return;
    }
    try {
      let { data, error } = await db.from('users').select('id, name, role, branch_id, is_active').order('name');
      const errMsg = String(error?.message || '').toLowerCase();
      if (error && (error.code === '42703' || errMsg.includes('is_active'))) {
        ({ data, error } = await db.from('users').select('id, name, role, branch_id').order('name'));
      }
      if (error) throw error;
      this._staffRows = (data || []).filter(u => u.role === 'staff' && u.is_active !== false);
      this._populateStaffFilter();
    } catch (e) {
      console.warn('adminStaffCashUi._loadStaff', e);
    }
  },

  _populateBranchFilter() {
    const sel = document.getElementById('scp-filter-branch');
    if (!sel) return;
    const current = sel.value || '';
    const opts = this._branches.map(b => `<option value="${b.id}">${escHtml(b.name)}</option>`).join('');
    sel.innerHTML = '<option value="">Semua Cabang</option>' + opts;
    sel.value = current;
  },

  _populateStaffFilter() {
    const sel = document.getElementById('scp-filter-staff');
    if (!sel) return;
    const current = sel.value || '';
    const opts = this._staffRows.map(u => `<option value="${u.id}">${escHtml(u.name)}</option>`).join('');
    sel.innerHTML = '<option value="">Semua Staff</option>' + opts;
    sel.value = current;
  },

  async _loadSessions() {
    if (this._loading) return;
    this._loading = true;
    this._showLoading();

    try {
      const session = auth.getSession();
      const branchId = Number(document.getElementById('scp-filter-branch')?.value || 0) || null;
      const staffId = Number(document.getElementById('scp-filter-staff')?.value || 0) || null;
      const status = document.getElementById('scp-filter-status')?.value || 'open';
      const dateFrom = document.getElementById('scp-filter-date-from')?.value || null;
      const dateTo = document.getElementById('scp-filter-date-to')?.value || null;

      this._sessions = await cashService.getAdminCashSessions({
        adminId: session?.id,
        branchId,
        staffId,
        status,
        dateFrom,
        dateTo
      });
      this._lastUpdated = new Date();
      this._render();
    } catch (e) {
      console.error('adminStaffCashUi._loadSessions', e);
      this._showError(e.message || 'Gagal memuat daftar kas');
    } finally {
      this._loading = false;
    }
  },

  _showLoading() {
    const cards = document.getElementById('scp-summary-cards');
    const tbody = document.getElementById('scp-table-body');
    if (cards) {
      cards.innerHTML = Array(4).fill(
        '<div class="stat-card scp-skeleton"><div class="stat-label">Memuat...</div><div class="stat-value">&mdash;</div></div>'
      ).join('');
    }
    if (tbody) tbody.innerHTML = '<tr><td colspan="11" class="empty-td" style="padding:24px">Memuat daftar kas...</td></tr>';
  },

  _showError(msg) {
    const tbody = document.getElementById('scp-table-body');
    if (tbody) tbody.innerHTML = `<tr><td colspan="11" class="empty-td text-danger">${escHtml(msg)}</td></tr>`;
    const cards = document.getElementById('scp-summary-cards');
    if (cards) cards.innerHTML = '';
  },

  _getFilteredSessions() {
    const risk = document.getElementById('scp-filter-risk')?.value || 'all';
    let rows = this._sessions.slice();

    if (risk === 'gt500') {
      rows = rows.filter(r => this._num(r.system_cash_amount) > 500000);
    } else if (risk === 'gt1m') {
      rows = rows.filter(r => this._num(r.system_cash_amount) > 1000000);
    } else if (risk === 'pending') {
      rows = rows.filter(r => this._num(r.deposit_pending) > 0);
    }

    return rows;
  },

  _render() {
    const rows = this._getFilteredSessions();
    this._renderSummaryCards(rows);
    this._renderTable(rows);
    this._updateLastUpdatedLabel();
    if (window.lucide) requestAnimationFrame(() => lucide.createIcons());
  },

  _renderSummaryCards(rows) {
    const el = document.getElementById('scp-summary-cards');
    if (!el) return;

    const openRows = rows.filter(r => r.session_status === 'open');
    const totalSystem = openRows.reduce((s, r) => s + this._num(r.system_cash_amount), 0);
    const totalActual = openRows.reduce((s, r) => s + this._num(r.current_cash_amount), 0);
    const manualCount = rows.filter(r => r.closed_manually || r.has_manual_adjustment).length;
    const pending = rows.reduce((s, r) => s + this._num(r.deposit_pending), 0);

    el.innerHTML = `
      <div class="stat-card">
        <div class="stat-label">Sesi Kas Terbuka</div>
        <div class="stat-value">${openRows.length}</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">Nominal Sistem Aktif</div>
        <div class="stat-value">${fRp(totalSystem)}</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">Posisi Aktual Aktif</div>
        <div class="stat-value">${fRp(totalActual)}</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">Manual / Pending</div>
        <div class="stat-value ${manualCount || pending ? 'text-warning' : ''}">${manualCount} / ${fRp(pending)}</div>
      </div>`;
  },

  _renderTable(rows) {
    const tbody = document.getElementById('scp-table-body');
    if (!tbody) return;

    if (!rows.length) {
      tbody.innerHTML = '<tr><td colspan="11" class="empty-td">Tidak ada sesi kas untuk filter ini</td></tr>';
      return;
    }

    tbody.innerHTML = rows.map((r, i) => {
      const openedAt = r.opened_at ? fDate(r.opened_at) : '<span class="text-muted">&mdash;</span>';
      const closedAt = r.closed_at ? fDate(r.closed_at) : '<span class="text-muted">&mdash;</span>';
      const system = this._num(r.system_cash_amount);
      const actual = this._num(r.current_cash_amount);
      const diff = actual - system;
      const diffCls = diff === 0 ? 'text-muted' : diff > 0 ? 'text-green' : 'text-danger';
      const manualBadges = this._manualBadges(r) || '<span class="text-muted">&mdash;</span>';
      const pending = this._num(r.deposit_pending) > 0
        ? `<span class="badge badge-warning" style="font-size:10px">${fRp(r.deposit_pending)}</span>`
        : '<span class="text-muted">&mdash;</span>';
      const detailBtn = `<button type="button" class="btn btn-outline btn-sm scp-detail-btn" data-row="${i}" title="Lihat detail kas"><i data-lucide="eye" style="width:13px;height:13px"></i></button>`;
      let depositBtn;
      if (!r.branch_id || !r.staff_id) {
        depositBtn = `<button type="button" class="btn btn-outline btn-sm" disabled title="Data cabang/staff tidak lengkap"><i data-lucide="ban" style="width:13px;height:13px"></i></button>`;
      } else if (r.session_status === 'closed') {
        depositBtn = `<button type="button" class="btn btn-outline btn-sm scp-deposit-btn" data-row="${i}" title="Input setoran manual"><i data-lucide="banknote" style="width:13px;height:13px"></i> Setor</button>`;
      } else {
        depositBtn = `<button type="button" class="btn btn-outline btn-sm" disabled title="Tutup kas terlebih dahulu"><i data-lucide="lock" style="width:13px;height:13px"></i> Tutup Dulu</button>`;
      }

      return `<tr class="scp-row ${r.session_status === 'open' ? 'scp-row-active' : ''}">
        <td class="text-muted text-xs">#${escHtml(String(r.session_id || ''))}</td>
        <td class="fw-700">${escHtml(r.staff_name || '-')}</td>
        <td>${escHtml(r.branch_name || '-')}</td>
        <td>${this._sessionStatusBadge(r)}</td>
        <td class="text-muted" style="font-size:12px">${openedAt}</td>
        <td class="text-muted" style="font-size:12px">${closedAt}</td>
        <td class="${this._cashClass(r)} fw-700">${fRp(system)}</td>
        <td class="fw-700">${fRp(actual)} <span class="${diffCls}" style="font-size:11px">(${this._formatDiff(diff)})</span></td>
        <td>${manualBadges}</td>
        <td>${pending}</td>
        <td style="white-space:nowrap">
          <div class="flex gap-1">
            ${detailBtn}
            ${depositBtn}
          </div>
        </td>
      </tr>`;
    }).join('');

    tbody.querySelectorAll('.scp-detail-btn').forEach(btn => {
      const row = rows[parseInt(btn.dataset.row, 10)];
      btn.addEventListener('click', () => this._openDetail(row));
    });
    tbody.querySelectorAll('.scp-deposit-btn').forEach(btn => {
      const row = rows[parseInt(btn.dataset.row, 10)];
      btn.addEventListener('click', () => this._openManualDeposit(row));
    });
  },

  _sessionStatusBadge(row) {
    if (row.session_status === 'open') return '<span class="badge badge-success">Terbuka</span>';
    if (row.closed_manually) return '<span class="badge badge-danger">Ditutup Manual Admin</span>';
    if (row.session_status === 'closed') return '<span class="badge badge-warning">Tertutup</span>';
    return `<span class="badge">${escHtml(row.session_status || 'Tidak diketahui')}</span>`;
  },

  _manualBadges(row) {
    const badges = [];
    if (row.closed_manually) badges.push('<span class="badge badge-danger" style="font-size:10px">Ditutup Manual Admin</span>');
    if (row.has_manual_adjustment) badges.push('<span class="badge badge-warning" style="font-size:10px">Ada Penyesuaian Manual</span>');
    return badges.join(' ');
  },

  _cashClass(row) {
    if (row.risk_level === 'danger' || this._num(row.system_cash_amount) < 0) return 'text-danger';
    if (row.risk_level === 'high' || row.risk_level === 'warning') return 'text-warning';
    return 'text-green';
  },

  _updateLastUpdatedLabel() {
    const el = document.getElementById('scp-last-updated');
    if (!el || !this._lastUpdated) return;
    el.textContent = 'Diperbarui: ' + fDate(this._lastUpdated.toISOString());
  },

  _bindFilterEvents() {
    [
      'scp-filter-branch',
      'scp-filter-staff',
      'scp-filter-status',
      'scp-filter-date-from',
      'scp-filter-date-to'
    ].forEach(id => {
      const el = document.getElementById(id);
      if (el) el.addEventListener('change', () => this._loadSessions());
    });

    const riskFilter = document.getElementById('scp-filter-risk');
    if (riskFilter) {
      riskFilter.addEventListener('change', () => {
        const rows = this._getFilteredSessions();
        this._renderSummaryCards(rows);
        this._renderTable(rows);
        if (window.lucide) requestAnimationFrame(() => lucide.createIcons());
      });
    }
  },

  _bindRefreshBtn() {
    const btn = document.getElementById('scp-refresh-btn');
    if (btn) btn.addEventListener('click', () => this._loadSessions());
  },

  _bindDetailModalControls() {
    ['scp-detail-close-btn', 'scp-detail-close-btn-footer'].forEach(id => {
      const btn = document.getElementById(id);
      if (btn) btn.addEventListener('click', () => closeModal('modal-scp-detail'));
    });

    const closeBtn = document.getElementById('scp-manual-close-btn');
    if (closeBtn) closeBtn.addEventListener('click', () => this._startAction('manual_close'));

    const editBtn = document.getElementById('scp-edit-actual-btn');
    if (editBtn) editBtn.addEventListener('click', () => this._startAction('adjust'));

    const cancelBtn = document.getElementById('scp-action-cancel-btn');
    if (cancelBtn) cancelBtn.addEventListener('click', () => this._hideActionPanel());

    const saveBtn = document.getElementById('scp-action-save-btn');
    if (saveBtn) saveBtn.addEventListener('click', () => this._submitAction());

    const amountInput = document.getElementById('scp-action-new-amount');
    if (amountInput) {
      amountInput.addEventListener('input', () => {
        this._formatActionAmountInput();
        this._updateActionDiff();
      });
    }
  },

  async _openDetail(row) {
    this._activeDetail = {
      session: {
        id: row.session_id,
        ...row
      },
      systemCashAmount: this._num(row.system_cash_amount),
      actualCashAmount: this._num(row.current_cash_amount),
      summary: null,
      logs: [],
      deposits: [],
      adjustments: []
    };

    this._renderDetailShell(this._activeDetail);
    this._hideActionPanel();
    this._clearDetailHistory();
    openModal('modal-scp-detail');
    if (window.lucide) requestAnimationFrame(() => lucide.createIcons());

    await this._refreshActiveDetail(row.session_id);
  },

  async _refreshActiveDetail(sessionId) {
    if (!sessionId) return;
    try {
      const detail = await cashService.getAdminCashSessionDetail({ sessionId });
      this._activeDetail = detail;
      this._renderDetailShell(detail);
      this._renderDetailHistory(detail.logs, detail.deposits, detail.adjustments);
      this._renderActionButtons(detail);
      if (window.lucide) requestAnimationFrame(() => lucide.createIcons());
    } catch (e) {
      console.error('adminStaffCashUi._refreshActiveDetail', e);
      const logsBody = document.getElementById('scp-detail-adjustments-body');
      if (logsBody) {
        logsBody.innerHTML = `<tr><td colspan="7" class="empty-td text-danger">Gagal memuat detail: ${escHtml(e.message || '')}</td></tr>`;
      }
      showToast('Gagal memuat detail kas: ' + (e.message || ''), 'error');
    }
  },

  _renderDetailShell(detail) {
    const session = detail.session || {};
    const summary = detail.summary || {};
    const system = this._num(detail.systemCashAmount ?? session.system_cash_amount);
    const actual = this._num(detail.actualCashAmount ?? session.current_cash_amount);
    const diff = actual - system;

    this._setText('scp-detail-staff-name', session.staff_name || '-');
    this._setText('scp-detail-branch', session.branch_name || '-');
    this._setText('scp-detail-session-id', session.id || session.session_id || '-');
    this._setHtml('scp-detail-status', this._sessionStatusBadge({
      session_status: session.status || session.session_status,
      closed_manually: session.closed_manually
    }));
    this._setText('scp-detail-opened-at', session.opened_at ? fDate(session.opened_at) : '-');
    this._setText('scp-detail-closed-at', session.closed_at ? fDate(session.closed_at) : '-');
    this._setHtml('scp-detail-manual-status', this._manualBadges({
      closed_manually: session.closed_manually,
      has_manual_adjustment: session.has_manual_adjustment
    }) || '<span class="text-muted">Normal</span>');
    this._setText('scp-detail-updated-at', session.updated_at ? fDate(session.updated_at) : '-');

    this._setText('scp-detail-opening', fRp(summary.openingCash ?? session.opening_cash));
    this._setText('scp-detail-sales', fRp(summary.cashSalesIn ?? summary.salesIn ?? session.cash_sales_in));
    this._setText('scp-detail-manual-in', fRp(summary.manualIn ?? session.manual_in));
    this._setText('scp-detail-manual-out', fRp(summary.manualOut ?? session.manual_out));
    this._setText('scp-detail-refund', fRp(summary.refundOut ?? session.refund_out));
    this._setText('scp-detail-void', fRp(summary.voidOut ?? session.void_out));
    this._setText('scp-detail-deposit', fRp(summary.depositOut ?? session.deposit_confirmed));
    this._setText('scp-detail-expected', fRp(system));
    this._setText('scp-detail-actual', fRp(actual));
    this._setText('scp-detail-adjustment-diff', this._formatDiff(diff));
    this._setText('scp-detail-pending', fRp(session.deposit_pending || 0));

    const diffEl = document.getElementById('scp-detail-adjustment-diff');
    if (diffEl) {
      diffEl.className = diff === 0
        ? 'scp-balance-value text-muted'
        : diff > 0
          ? 'scp-balance-value text-green'
          : 'scp-balance-value text-danger';
    }

    this._renderActionButtons(detail);
  },

  _renderActionButtons(detail) {
    const session = detail.session || {};
    const canManualAction = this._canManualAction();
    const status = session.status || session.session_status;
    const closeBtn = document.getElementById('scp-manual-close-btn');
    const editBtn = document.getElementById('scp-edit-actual-btn');

    if (closeBtn) {
      closeBtn.style.display = canManualAction && status === 'open' ? '' : 'none';
      closeBtn.disabled = !canManualAction || status !== 'open' || this._savingAction;
    }
    if (editBtn) {
      editBtn.style.display = 'none';
      editBtn.disabled = true;
    }
  },

  _clearDetailHistory() {
    this._setHtml('scp-detail-logs-body', '<tr><td colspan="5" class="empty-td">Memuat...</td></tr>');
    this._setHtml('scp-detail-deposits-body', '<tr><td colspan="6" class="empty-td">Memuat...</td></tr>');
    this._setHtml('scp-detail-adjustments-body', '<tr><td colspan="7" class="empty-td">Memuat...</td></tr>');
  },

  _renderDetailHistory(logs, deposits, adjustments) {
    this._renderCashLogs(logs || []);
    this._renderDeposits(deposits || []);
    this._renderAdjustments(adjustments || []);
  },

  _renderCashLogs(logs) {
    const body = document.getElementById('scp-detail-logs-body');
    if (!body) return;
    if (!logs.length) {
      body.innerHTML = '<tr><td colspan="5" class="empty-td text-muted">Tidak ada log kas</td></tr>';
      return;
    }
    body.innerHTML = logs.map(l => {
      const typeCls = l.type === 'in' ? 'text-green' : 'text-danger';
      const sign = l.type === 'in' ? '+' : '-';
      const voided = l.is_void ? ' <span class="badge badge-danger" style="font-size:10px">VOID</span>' : '';
      const cat = l.cash_categories?.name || l.reference_type || '-';
      return `<tr class="${l.is_void ? 'scp-voided-row' : ''}">
        <td class="text-muted" style="font-size:11px">${fDate(l.created_at)}</td>
        <td>${escHtml(cat)}${voided}</td>
        <td class="${typeCls} fw-700">${sign}${fRp(l.amount)}</td>
        <td class="text-muted" style="font-size:11px">${escHtml(l.creator?.name || '-')}</td>
        <td class="text-muted" style="font-size:11px">${escHtml(l.note || '-')}</td>
      </tr>`;
    }).join('');
  },

  _renderDeposits(deposits) {
    const body = document.getElementById('scp-detail-deposits-body');
    if (!body) return;
    if (!deposits.length) {
      body.innerHTML = '<tr><td colspan="6" class="empty-td text-muted">Tidak ada riwayat setoran terkait</td></tr>';
      return;
    }
    body.innerHTML = deposits.map(d => {
      const sl = {
        pending: { text: 'Menunggu', cls: 'badge-warning' },
        confirmed: { text: 'Dikonfirmasi', cls: 'badge-success' },
        rejected: { text: 'Ditolak', cls: 'badge-danger' }
      }[d.status] || { text: d.status || '-', cls: '' };
      const method = escHtml(d.deposit_account_name_snapshot || 'Metode lama/tidak tersedia');
      const proofUrl = depositService.normalizeProofUrl(d.proof_url);
      const proof = proofUrl
        ? `<a class="deposit-admin-proof-link" href="${escHtml(proofUrl)}" target="_blank" rel="noopener">${escHtml(d.proof_file_name || 'Lihat Bukti')}</a>`
        : '<span class="text-muted">Bukti belum tersedia</span>';
      const sessionBadge = String(d.session_id || '') === String(this._activeDetail?.session?.id || '')
        ? '<span class="badge badge-success" style="font-size:10px">Sesi ini</span>'
        : '<span class="text-muted">Staff/cabang</span>';
      return `<tr>
        <td class="text-muted" style="font-size:11px">${fDate(d.created_at)}</td>
        <td class="fw-700">${fRp(d.amount)}</td>
        <td class="text-muted" style="font-size:11px">${method}<br>${sessionBadge}</td>
        <td class="text-muted" style="font-size:11px">${proof}</td>
        <td><span class="badge ${sl.cls}">${escHtml(sl.text)}</span></td>
        <td class="text-muted" style="font-size:11px">${escHtml(d.notes || '-')}</td>
      </tr>`;
    }).join('');
  },

  _renderAdjustments(adjustments) {
    const body = document.getElementById('scp-detail-adjustments-body');
    if (!body) return;
    if (!adjustments.length) {
      body.innerHTML = '<tr><td colspan="7" class="empty-td text-muted">Belum ada audit log perubahan kas</td></tr>';
      return;
    }
    body.innerHTML = adjustments.map(a => {
      const diff = this._num(a.adjustment_amount);
      const diffCls = diff === 0 ? 'text-muted' : diff > 0 ? 'text-green' : 'text-danger';
      return `<tr>
        <td class="text-muted" style="font-size:11px">${fDate(a.created_at)}</td>
        <td>${this._actionLabel(a.action_type)}</td>
        <td class="text-right">${fRp(a.previous_cash_amount)}</td>
        <td class="text-right fw-700">${fRp(a.new_cash_amount)}</td>
        <td class="text-right ${diffCls}">${this._formatDiff(diff)}</td>
        <td class="text-muted" style="font-size:11px">${escHtml(a.created_by_name || '-')}</td>
        <td class="text-muted" style="font-size:11px">${escHtml(a.reason || '-')}</td>
      </tr>`;
    }).join('');
  },

  _startAction(type) {
    if (!this._activeDetail?.session?.id) return;
    if (!this._canManualAction()) {
      showToast('Hanya owner/admin yang dapat melakukan aksi ini', 'error');
      return;
    }
    if (type !== 'manual_close') {
      showToast('Koreksi posisi kas dilakukan dari menu Kas Outlet.', 'info');
      return;
    }

    const session = this._activeDetail.session;
    if (type === 'manual_close' && (session.status || session.session_status) !== 'open') {
      showToast('Kas sudah tertutup dan tidak dapat ditutup ulang', 'error');
      return;
    }

    this._activeAction = type;
    const previous = this._num(this._activeDetail.actualCashAmount);
    this._setText('scp-action-title', type === 'manual_close' ? 'Tutup Kas Manual' : 'Edit Posisi Kas Aktual');
    this._setText('scp-action-previous', fRp(previous));
    this._setText('scp-action-system', fRp(this._activeDetail.systemCashAmount));
    this._setText('scp-action-error', '');

    const amountInput = document.getElementById('scp-action-new-amount');
    if (amountInput) {
      amountInput.value = this._formatPlainAmount(previous);
    }
    const reasonInput = document.getElementById('scp-action-reason');
    if (reasonInput) reasonInput.value = '';
    const saveBtn = document.getElementById('scp-action-save-btn');
    if (saveBtn) {
      saveBtn.className = type === 'manual_close' ? 'btn btn-danger btn-sm' : 'btn btn-primary btn-sm';
      saveBtn.innerHTML = type === 'manual_close'
        ? '<i data-lucide="lock" class="icon-sm"></i> Konfirmasi Tutup Kas'
        : '<i data-lucide="save" class="icon-sm"></i> Simpan Posisi Kas';
    }

    const panel = document.getElementById('scp-cash-action-panel');
    if (panel) {
      panel.style.display = 'block';
      requestAnimationFrame(() => {
        panel.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
        if (window.lucide) lucide.createIcons();
      });
    }
    this._updateActionDiff();
    amountInput?.focus();
  },

  _hideActionPanel() {
    this._activeAction = null;
    const panel = document.getElementById('scp-cash-action-panel');
    if (panel) panel.style.display = 'none';
    this._setText('scp-action-error', '');
  },

  _updateActionDiff() {
    const previous = this._num(this._activeDetail?.actualCashAmount);
    const next = this._parseActionAmount();
    const diff = Number.isFinite(next) ? next - previous : 0;
    this._setText('scp-action-diff', this._formatDiff(diff));
    const diffEl = document.getElementById('scp-action-diff');
    if (diffEl) diffEl.className = diff === 0 ? 'fw-700 text-muted' : diff > 0 ? 'fw-700 text-green' : 'fw-700 text-danger';
  },

  async _submitAction() {
    if (this._savingAction || !this._activeAction || !this._activeDetail?.session?.id) return;

    const amount = this._parseActionAmount();
    const reason = document.getElementById('scp-action-reason')?.value?.trim() || '';
    const previous = this._num(this._activeDetail.actualCashAmount);
    const diff = Number.isFinite(amount) ? amount - previous : 0;

    const error = this._validateAction(amount, reason);
    if (error) {
      this._setText('scp-action-error', error);
      return;
    }

    const isClose = this._activeAction === 'manual_close';
    const diffWarn = Math.abs(diff) > Math.max(100000, Math.abs(this._num(this._activeDetail.systemCashAmount)) * 0.2)
      ? 'Selisih besar terhadap nominal sistem. Pastikan nominal sudah dicek.'
      : '';
    const ok = await showConfirm({
      title: isClose ? 'Konfirmasi Tutup Kas Manual' : 'Konfirmasi Edit Posisi Kas',
      message: [
        `Sebelum: ${fRp(previous)}`,
        `Sesudah: ${fRp(amount)}`,
        `Selisih: ${this._formatDiff(diff)}`,
        `Alasan: ${reason}`
      ].join('\n'),
      subText: diffWarn,
      confirmText: isClose ? 'Ya, Tutup Kas' : 'Ya, Simpan',
      danger: isClose
    });
    if (!ok) return;

    const saveBtn = document.getElementById('scp-action-save-btn');
    this._savingAction = true;
    if (saveBtn) {
      saveBtn.disabled = true;
      saveBtn.innerHTML = '<span class="btn-spinner"></span><span>Menyimpan...</span>';
    }

    try {
      const adminId = auth.getSession()?.id || null;
      if (isClose) {
        await transactionService.adminForceCloseBranchSession({
          sessionId: this._activeDetail.session.id,
          adminId,
          closingCash: amount,
          reason
        });
      } else {
        throw new Error('Koreksi posisi kas dilakukan dari menu Kas Outlet.');
      }

      showToast(isClose ? 'Kas berhasil ditutup manual' : 'Posisi kas berhasil disimpan', 'success');
      this._hideActionPanel();
      await this._loadSessions();
      await this._refreshActiveDetail(this._activeDetail.session.id);
      if (window.RBNDataEvents) {
        RBNDataEvents.publish('cash:changed', { source: 'admin-manual-cash' });
      }
    } catch (e) {
      console.error('adminStaffCashUi._submitAction', e);
      if (window.showDbError) showDbError(e, { action: isClose ? 'menutup kas manual' : 'mengedit posisi kas', entity: 'Kas' });
      else showToast(e.message || 'Gagal menyimpan perubahan kas', 'error');
    } finally {
      this._savingAction = false;
      if (saveBtn) {
        saveBtn.disabled = false;
        saveBtn.className = isClose ? 'btn btn-danger btn-sm' : 'btn btn-primary btn-sm';
        saveBtn.innerHTML = isClose
          ? '<i data-lucide="lock" class="icon-sm"></i> Konfirmasi Tutup Kas'
          : '<i data-lucide="save" class="icon-sm"></i> Simpan Posisi Kas';
        if (window.lucide) lucide.createIcons();
      }
      this._renderActionButtons(this._activeDetail || {});
    }
  },

  _validateAction(amount, reason) {
    if (!Number.isFinite(amount)) return 'Nominal kas aktual wajib diisi';
    if (amount < 0) return 'Nominal kas aktual tidak boleh negatif';
    if (!reason.trim()) return 'Alasan wajib diisi';
    if (this._activeAction === 'manual_close') {
      const status = this._activeDetail?.session?.status || this._activeDetail?.session?.session_status;
      if (status !== 'open') return 'Kas sudah tertutup dan tidak dapat ditutup ulang';
    }
    return '';
  },

  _openManualDeposit(row) {
    if (!window.adminDepositUi) {
      showToast('Modul setoran belum siap', 'error');
      return;
    }
    if (!row.branch_id) {
      showToast('Staff tidak memiliki cabang', 'error');
      return;
    }
    if (row.session_status !== 'closed') {
      showToast('Tutup kas terlebih dahulu sebelum setoran tunai', 'error');
      return;
    }

    const depositUi = window.adminDepositUi;
    if (!depositUi.branches.length) {
      showToast('Memuat data cabang...', 'info');
      return;
    }

    // Prefill branch, staff, dan session_id dari row Sesi Kas.
    depositUi.openManualDepositModal({
      prefillBranchId: row.branch_id,
      prefillStaffId: row.staff_id,
      prefillSessionId: row.session_id
    });
  },

  _canManualAction() {
    const role = auth.getSession()?.role;
    return role === 'admin' || role === 'owner';
  },

  _parseActionAmount() {
    const value = document.getElementById('scp-action-new-amount')?.value;
    if (value === '' || value == null) return NaN;
    const digits = String(value).replace(/[^\d]/g, '');
    return digits ? Number(digits) : NaN;
  },

  _formatPlainAmount(value) {
    const amount = Math.round(this._num(value));
    return amount > 0 ? amount.toLocaleString('id-ID') : '0';
  },

  _formatActionAmountInput() {
    const input = document.getElementById('scp-action-new-amount');
    if (!input) return;
    const digits = String(input.value || '').replace(/[^\d]/g, '');
    input.value = digits ? Number(digits).toLocaleString('id-ID') : '';
  },

  _actionLabel(actionType) {
    if (actionType === 'manual_close') return '<span class="badge badge-danger">Tutup Kas Manual Admin</span>';
    if (actionType === 'manual_cash_adjustment') return '<span class="badge badge-warning">Penyesuaian Manual Admin</span>';
    if (actionType === 'manual_actual_cash_input') return '<span class="badge badge-success">Input Posisi Aktual</span>';
    return `<span class="badge">${escHtml(actionType || '-')}</span>`;
  },

  _formatDiff(value) {
    const amount = this._num(value);
    if (amount === 0) return fRp(0);
    return `${amount > 0 ? '+' : '-'}${fRp(Math.abs(amount))}`;
  },

  _num(value) {
    const n = Number.parseFloat(value);
    return Number.isFinite(n) ? n : 0;
  },

  _setText(id, value) {
    const el = document.getElementById(id);
    if (el) el.textContent = value;
  },

  _setHtml(id, value) {
    const el = document.getElementById(id);
    if (el) el.innerHTML = value;
  },

  // ─────────────────────────────────────────────────────────────
  // Legacy staff-balance tab: disabled. Kas Outlet is the source of truth.
  // ─────────────────────────────────────────────────────────────

  _bindTabEvents() {
    document.querySelectorAll('.scp-tab-btn').forEach(btn => {
      btn.addEventListener('click', () => this._switchTab(btn.dataset.tab));
    });
  },

  _switchTab(tab) {
    if (tab && tab !== 'sessions') {
      showToast('Saldo staff sudah dinonaktifkan. Gunakan menu Kas Outlet.', 'info');
    }
    this._activeTab = 'sessions';
    document.querySelectorAll('.scp-tab-btn').forEach(b => {
      b.classList.toggle('active', b.dataset.tab === this._activeTab);
    });
    const sessTab = document.getElementById('scp-tab-sessions');
    const balTab  = document.getElementById('scp-tab-balances');
    if (sessTab) sessTab.style.display = '';
    if (balTab)  balTab.style.display  = 'none';
  },

  async _loadBalances() {
    if (this._balancesLoading) return;
    this._balancesLoading = true;
    this._renderBalancesLoading();
    try {
      this._balances = [];
      this._renderBalancesTable();
    } catch (e) {
      console.error('adminStaffCashUi._loadBalances', e);
      const tbody = document.getElementById('scp-balances-body');
      if (tbody) tbody.innerHTML = `<tr><td colspan="7" class="empty-td text-danger">${escHtml(e.message || 'Gagal memuat saldo staff')}</td></tr>`;
    } finally {
      this._balancesLoading = false;
    }
  },

  _renderBalancesLoading() {
    const tbody = document.getElementById('scp-balances-body');
    if (tbody) tbody.innerHTML = '<tr><td colspan="7" class="empty-td">Saldo staff sudah dinonaktifkan. Gunakan Kas Outlet.</td></tr>';
  },

  _renderBalancesTable() {
    const tbody = document.getElementById('scp-balances-body');
    if (!tbody) return;
    if (!this._balances.length) {
      tbody.innerHTML = '<tr><td colspan="7" class="empty-td">Tidak ada staff aktif ditemukan</td></tr>';
      return;
    }
    tbody.innerHTML = this._balances.map((r, i) => {
      const balance    = this._num(r.current_balance);
      const pending    = this._num(r.pending_deposit);
      const hasSession = !!r.open_session_id;
      const sessionBadge = hasSession
        ? `<span class="badge badge-success" style="font-size:10px">Sesi Terbuka</span>`
        : `<span class="text-muted" style="font-size:11px">Tidak ada sesi</span>`;
      const lastUpd = r.last_updated ? fDate(r.last_updated) : '<span class="text-muted">Belum pernah</span>';
      const pendingCell = pending > 0
        ? `<span class="text-warning fw-700">${fRp(pending)}</span>`
        : `<span class="text-muted">—</span>`;
      return `<tr>
        <td class="fw-700">${escHtml(r.staff_name || '-')}</td>
        <td>${escHtml(r.branch_name || '-')}</td>
        <td class="fw-700 text-green" style="font-size:15px">${fRp(balance)}</td>
        <td>${pendingCell}</td>
        <td>${sessionBadge}</td>
        <td class="text-muted" style="font-size:11px">${lastUpd}</td>
        <td style="white-space:nowrap">
          <div class="flex gap-1">
            <button type="button" class="btn btn-outline btn-sm scp-balance-correct-btn" data-row="${i}" title="Set/Koreksi Saldo">
              <i data-lucide="edit-3" style="width:12px;height:12px"></i> Koreksi
            </button>
            <button type="button" class="btn btn-outline btn-sm scp-balance-ledger-btn" data-row="${i}" title="Riwayat Saldo">
              <i data-lucide="list" style="width:12px;height:12px"></i>
            </button>
          </div>
        </td>
      </tr>`;
    }).join('');

    tbody.querySelectorAll('.scp-balance-correct-btn').forEach(btn => {
      const row = this._balances[parseInt(btn.dataset.row, 10)];
      btn.addEventListener('click', () => this._openBalanceCorrection(row));
    });
    tbody.querySelectorAll('.scp-balance-ledger-btn').forEach(btn => {
      const row = this._balances[parseInt(btn.dataset.row, 10)];
      btn.addEventListener('click', () => this._openStaffLedger(row));
    });
    if (window.lucide) requestAnimationFrame(() => lucide.createIcons());
  },

  // ─────────────────────────────────────────────────────────────
  // MODAL: Koreksi Saldo Staff
  // ─────────────────────────────────────────────────────────────

  _bindBalanceModalEvents() {
    const closeBtn   = document.getElementById('bc-close-btn');
    const cancelBtn  = document.getElementById('bc-cancel-btn');
    const saveBtn    = document.getElementById('bc-save-btn');
    const amtInput   = document.getElementById('bc-new-balance');

    if (closeBtn)  closeBtn.addEventListener('click', () => closeModal('modal-balance-correction'));
    if (cancelBtn) cancelBtn.addEventListener('click', () => closeModal('modal-balance-correction'));
    if (saveBtn)   saveBtn.addEventListener('click', () => this._saveBalanceCorrection());
    if (amtInput)  amtInput.addEventListener('input', () => this._updateBcDiff());
  },

  _openBalanceCorrection(row) {
    this._bcTarget = {
      staffId:        row.staff_id,
      staffName:      row.staff_name || '-',
      branchId:       row.branch_id,
      branchName:     row.branch_name || '-',
      currentBalance: this._num(row.current_balance),
      version:        this._num(row.version)
    };
    this._bcSaving = false;

    this._setText('bc-staff-name',       this._bcTarget.staffName);
    this._setText('bc-branch-name',      this._bcTarget.branchName);
    this._setText('bc-current-balance',  fRp(this._bcTarget.currentBalance));

    const amtInput = document.getElementById('bc-new-balance');
    if (amtInput) amtInput.value = '';
    const reasonInput = document.getElementById('bc-reason');
    if (reasonInput) reasonInput.value = '';
    this._setText('bc-error', '');
    this._setText('bc-balance-diff', '');

    const saveBtn = document.getElementById('bc-save-btn');
    if (saveBtn) {
      saveBtn.disabled = false;
      saveBtn.innerHTML = '<i data-lucide="save" class="icon-sm"></i> Simpan Saldo';
    }
    openModal('modal-balance-correction');
    if (window.lucide) requestAnimationFrame(() => lucide.createIcons());
    setTimeout(() => document.getElementById('bc-new-balance')?.focus(), 200);
  },

  _updateBcDiff() {
    const input   = document.getElementById('bc-new-balance');
    const diffEl  = document.getElementById('bc-balance-diff');
    if (!input || !diffEl || !this._bcTarget) return;
    const digits  = String(input.value || '').replace(/[^\d]/g, '');
    input.value   = digits ? Number(digits).toLocaleString('id-ID') : '';
    const newVal  = digits ? Number(digits) : NaN;
    if (!Number.isFinite(newVal)) { diffEl.textContent = ''; return; }
    const diff    = newVal - this._bcTarget.currentBalance;
    const sign    = diff >= 0 ? '+' : '−';
    diffEl.textContent = `Selisih: ${sign}${fRp(Math.abs(diff))}`;
    diffEl.style.color = diff === 0 ? 'var(--text-muted)' : diff > 0 ? 'var(--success, #22c55e)' : 'var(--danger, #ef4444)';
  },

  async _saveBalanceCorrection() {
    if (this._bcSaving || !this._bcTarget) return;
    this._setText('bc-error', 'Saldo staff sudah dinonaktifkan. Gunakan menu Kas Outlet.');
    return;
    const digits  = String(document.getElementById('bc-new-balance')?.value || '').replace(/[^\d]/g, '');
    const newBal  = digits ? Number(digits) : NaN;
    const reason  = document.getElementById('bc-reason')?.value?.trim() || '';
    if (!Number.isFinite(newBal)) {
      this._setText('bc-error', 'Nominal saldo baru wajib diisi');
      return;
    }
    if (newBal < 0) {
      this._setText('bc-error', 'Nominal tidak boleh negatif');
      return;
    }
    if (!reason) {
      this._setText('bc-error', 'Alasan koreksi wajib diisi');
      return;
    }
    this._setText('bc-error', '');

    const diff = newBal - this._bcTarget.currentBalance;
    const warnMsg = Math.abs(diff) > 1000000 ? 'Selisih sangat besar (>Rp1 juta). Yakin?' : '';
    const ok = await showConfirm({
      title:       'Konfirmasi Koreksi Saldo',
      message:     `Staff: ${this._bcTarget.staffName}\nSebelum: ${fRp(this._bcTarget.currentBalance)}\nSesudah: ${fRp(newBal)}\nSelisih: ${diff >= 0 ? '+' : '−'}${fRp(Math.abs(diff))}\nAlasan: ${reason}`,
      subText:     warnMsg,
      confirmText: 'Ya, Simpan Saldo',
      danger:      false
    });
    if (!ok) return;

    this._bcSaving = true;
    const saveBtn = document.getElementById('bc-save-btn');
    if (saveBtn) { saveBtn.disabled = true; saveBtn.innerHTML = '<span class="btn-spinner"></span> Menyimpan...'; }

    try {
      throw new Error('Saldo staff sudah dinonaktifkan. Gunakan menu Kas Outlet.');
    } catch (e) {
      console.error('adminStaffCashUi._saveBalanceCorrection', e);
      this._setText('bc-error', e.message || 'Gagal menyimpan koreksi saldo');
    } finally {
      this._bcSaving = false;
      if (saveBtn) {
        saveBtn.disabled = false;
        saveBtn.innerHTML = '<i data-lucide="save" class="icon-sm"></i> Simpan Saldo';
        if (window.lucide) lucide.createIcons();
      }
    }
  },

  // ─────────────────────────────────────────────────────────────
  // MODAL: Riwayat Saldo Staff (Ledger)
  // ─────────────────────────────────────────────────────────────

  _bindLedgerModalEvents() {
    ['sl-close-btn', 'sl-close-btn-footer'].forEach(id => {
      const btn = document.getElementById(id);
      if (btn) btn.addEventListener('click', () => closeModal('modal-staff-ledger'));
    });
  },

  async _openStaffLedger(row) {
    showToast('Ledger saldo staff sudah dinonaktifkan. Gunakan riwayat Kas Outlet.', 'info');
    return;
    this._slTarget = {
      staffId:   row.staff_id,
      staffName: row.staff_name || '-',
      branchId:  row.branch_id
    };
    this._setText('sl-staff-name', this._slTarget.staffName);
    const tbody = document.getElementById('sl-ledger-body');
    if (tbody) tbody.innerHTML = '<tr><td colspan="7" class="empty-td">Memuat riwayat...</td></tr>';
    openModal('modal-staff-ledger');
    try {
      throw new Error('Ledger saldo staff sudah dinonaktifkan. Gunakan riwayat Kas Outlet.');
    } catch (e) {
      console.error('adminStaffCashUi._openStaffLedger', e);
      if (tbody) tbody.innerHTML = `<tr><td colspan="7" class="empty-td text-danger">${escHtml(e.message || 'Gagal memuat riwayat')}</td></tr>`;
    }
  },

  _renderLedgerTable() {
    const tbody = document.getElementById('sl-ledger-body');
    if (!tbody) return;
    if (!this._slData.length) {
      tbody.innerHTML = '<tr><td colspan="7" class="empty-td text-muted">Belum ada riwayat perubahan saldo</td></tr>';
      return;
    }
    const typeLabel = {
      admin_set_balance:    '<span class="badge badge-success">Set Saldo Admin</span>',
      admin_adjustment:     '<span class="badge badge-warning">Koreksi Admin</span>',
      session_open_confirm: '<span class="badge badge-info" style="background:var(--info,#3b82f6);color:#fff">Buka Kas</span>',
      opening_variance:     '<span class="badge badge-warning">Selisih Buka</span>',
      session_close:        '<span class="badge badge-success">Tutup Kas</span>',
      deposit_approved:     '<span class="badge badge-danger">Setoran Approved</span>',
      deposit_rejected:     '<span class="badge badge-secondary" style="background:#6b7280;color:#fff">Setoran Ditolak</span>',
      system_repair:        '<span class="badge badge-secondary" style="background:#6b7280;color:#fff">Perbaikan Sistem</span>'
    };
    tbody.innerHTML = this._slData.map(l => {
      const dirCls  = l.direction === 'in' ? 'text-green' : l.direction === 'out' ? 'text-danger' : 'text-muted';
      const sign    = l.direction === 'in' ? '+' : l.direction === 'out' ? '−' : '';
      const amtText = l.direction === 'none' ? '—' : `${sign}${fRp(l.amount)}`;
      const label   = typeLabel[l.movement_type] || `<span class="badge">${escHtml(l.movement_type)}</span>`;
      const byName  = escHtml(l.created_by_name || l.approved_by_name || '-');
      return `<tr>
        <td class="text-muted" style="font-size:11px">${fDate(l.created_at)}</td>
        <td>${label}</td>
        <td class="${dirCls} fw-700">${amtText}</td>
        <td class="text-right text-muted">${fRp(l.balance_before)}</td>
        <td class="text-right fw-700">${fRp(l.balance_after)}</td>
        <td class="text-muted" style="font-size:11px">${byName}</td>
        <td class="text-muted" style="font-size:11px">${escHtml(l.reason || '-')}</td>
      </tr>`;
    }).join('');
  }
};

window.adminStaffCashUi = adminStaffCashUi;
adminStaffCashUi.init();
