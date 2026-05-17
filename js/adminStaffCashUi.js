'use strict';

// ── Admin Staff Cash Position UI ──────────────────────────────────────────────
// Displays aggregated cash positions for all active staff.
// Uses cashService.getStaffCashPositions() which calls the get_staff_cash_positions RPC
// to avoid N+1 queries.

const adminStaffCashUi = {
  _positions: [],
  _branches:  [],
  _dirty:     false,
  _loading:   false,
  _lastUpdated: null,

  // ── Init ─────────────────────────────────────────────────────
  init() {
    document.addEventListener('DOMContentLoaded', () => {
      try {
        if (!auth.requireRole('admin')) return;
        this._bindFilterEvents();
        this._bindRefreshBtn();
        this._bindDetailModalClose();
      } catch (e) {
        console.error('adminStaffCashUi.init', e);
      }
    });
  },

  // ── Called by ADMIN.navigate() when entering this section ────
  async load() {
    this._dirty = false;
    await this._loadBranches();
    await this._loadPositions();
  },

  // ── Mark as stale; reload if section is currently active ─────
  markDirty() {
    this._dirty = true;
    if (window.ADMIN && ADMIN.currentSection === 'staff-cash-position') {
      this._loadPositions();
    }
  },

  // ── Internal helpers ─────────────────────────────────────────

  async _loadBranches() {
    if (this._branches.length) return; // cached
    try {
      const { data, error } = await db.from('branches').select('id, name').order('name');
      if (error) throw error;
      this._branches = (data || []).filter(b => b.is_active !== false);
      this._populateBranchFilter();
    } catch (e) {
      console.warn('adminStaffCashUi._loadBranches', e);
    }
  },

  _populateBranchFilter() {
    const sel = document.getElementById('scp-filter-branch');
    if (!sel) return;
    const opts = this._branches.map(b => `<option value="${b.id}">${escHtml(b.name)}</option>`).join('');
    sel.innerHTML = '<option value="">Semua Cabang</option>' + opts;
  },

  async _loadPositions() {
    if (this._loading) return;
    this._loading = true;
    this._showLoading();

    try {
      const branchId = Number(document.getElementById('scp-filter-branch')?.value || 0) || null;
      const status   = document.getElementById('scp-filter-status')?.value || 'all';

      this._positions = await cashService.getStaffCashPositions({ branchId, status });
      this._lastUpdated = new Date();
      this._render();
    } catch (e) {
      console.error('adminStaffCashUi._loadPositions', e);
      this._showError(e.message || 'Gagal memuat posisi kas');
    } finally {
      this._loading = false;
    }
  },

  _showLoading() {
    const cards = document.getElementById('scp-summary-cards');
    const tbody = document.getElementById('scp-table-body');
    if (cards) cards.innerHTML = Array(4).fill(
      '<div class="stat-card scp-skeleton"><div class="stat-label">Memuat...</div><div class="stat-value">—</div></div>'
    ).join('');
    if (tbody) tbody.innerHTML = '<tr><td colspan="9" class="empty-td" style="padding:24px">Memuat data...</td></tr>';
  },

  _showError(msg) {
    const tbody = document.getElementById('scp-table-body');
    if (tbody) tbody.innerHTML = `<tr><td colspan="9" class="empty-td text-danger">${escHtml(msg)}</td></tr>`;
    const cards = document.getElementById('scp-summary-cards');
    if (cards) cards.innerHTML = '';
  },

  // ── Filter & Render ──────────────────────────────────────────
  _getFilteredPositions() {
    const risk = document.getElementById('scp-filter-risk')?.value || 'all';
    let rows = this._positions.slice();

    if (risk === 'gt500') {
      rows = rows.filter(r => r.expected_cash > 500000);
    } else if (risk === 'gt1m') {
      rows = rows.filter(r => r.expected_cash > 1000000);
    } else if (risk === 'pending') {
      rows = rows.filter(r => r.deposit_pending > 0);
    }

    return rows;
  },

  _render() {
    const rows = this._getFilteredPositions();
    this._renderSummaryCards(rows);
    this._renderTable(rows);
    this._updateLastUpdatedLabel();
    if (window.lucide) requestAnimationFrame(() => lucide.createIcons());
  },

  _renderSummaryCards(rows) {
    const el = document.getElementById('scp-summary-cards');
    if (!el) return;

    const activeRows   = rows.filter(r => r.session_status === 'open');
    const totalActive  = activeRows.reduce((s, r) => s + Number(r.expected_cash || 0), 0);
    const staffActive  = activeRows.length;
    const totalPending = rows.reduce((s, r) => s + Number(r.deposit_pending || 0), 0);
    const needsAttention = rows.filter(r =>
      r.expected_cash > 500000 || r.expected_cash < 0 || r.deposit_pending > 0
    ).length;

    el.innerHTML = `
      <div class="stat-card">
        <div class="stat-label">Total Posisi Kas Aktif</div>
        <div class="stat-value">${fRp(totalActive)}</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">Staff Shift Aktif</div>
        <div class="stat-value">${staffActive}</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">Setoran Pending</div>
        <div class="stat-value text-warning">${fRp(totalPending)}</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">Perlu Perhatian</div>
        <div class="stat-value ${needsAttention > 0 ? 'text-danger' : ''}">${needsAttention}</div>
      </div>`;
  },

  _renderTable(rows) {
    const tbody = document.getElementById('scp-table-body');
    if (!tbody) return;

    if (!rows.length) {
      tbody.innerHTML = '<tr><td colspan="9" class="empty-td">Tidak ada data untuk filter ini</td></tr>';
      return;
    }

    tbody.innerHTML = rows.map((r, i) => {
      const statusBadge = this._sessionStatusBadge(r.session_status);
      const cashCls     = this._cashClass(r);
      const cashLabel   = r.expected_cash < 0 ? ' <span class="badge badge-danger" style="font-size:10px">Perlu Audit</span>' : '';
      const pendingBadge = r.deposit_pending > 0
        ? `<span class="badge badge-warning" style="font-size:10px;vertical-align:middle">${fRp(r.deposit_pending)}</span>`
        : '<span class="text-muted">—</span>';
      const confirmedVal = r.deposit_confirmed > 0 ? fRp(r.deposit_confirmed) : '<span class="text-muted">—</span>';
      const openedAt    = r.opened_at ? fDate(r.opened_at) : '<span class="text-muted">—</span>';
      const lastAt      = r.last_activity_at ? fDate(r.last_activity_at) : '<span class="text-muted">—</span>';
      const hasNoBranch = !r.branch_id;

      const detailBtn = `<button type="button" class="btn btn-outline btn-sm scp-detail-btn" data-row="${i}" title="Lihat detail posisi kas"><i data-lucide="eye" style="width:13px;height:13px"></i></button>`;
      const depositBtn = hasNoBranch
        ? `<button type="button" class="btn btn-outline btn-sm" disabled title="Staff tidak punya cabang"><i data-lucide="ban" style="width:13px;height:13px"></i></button>`
        : `<button type="button" class="btn btn-outline btn-sm scp-deposit-btn" data-row="${i}" title="Input setoran manual"><i data-lucide="banknote" style="width:13px;height:13px"></i> Setor</button>`;

      return `<tr class="scp-row ${r.session_status === 'open' ? 'scp-row-active' : ''}">
        <td class="fw-700">${escHtml(r.staff_name || '—')}</td>
        <td>${escHtml(r.branch_name || '—')}</td>
        <td>${statusBadge}</td>
        <td class="text-muted" style="font-size:12px">${openedAt}</td>
        <td class="${cashCls} fw-700">${fRp(r.expected_cash)}${cashLabel}</td>
        <td>${pendingBadge}</td>
        <td>${confirmedVal}</td>
        <td class="text-muted" style="font-size:12px">${lastAt}</td>
        <td style="white-space:nowrap">
          <div class="flex gap-1">
            ${detailBtn}
            ${depositBtn}
          </div>
        </td>
      </tr>`;
    }).join('');

    // Bind row buttons using closure — no data-id attributes with sensitive IDs
    tbody.querySelectorAll('.scp-detail-btn').forEach(btn => {
      const row = rows[parseInt(btn.dataset.row, 10)];
      btn.addEventListener('click', () => this._openDetail(row));
    });
    tbody.querySelectorAll('.scp-deposit-btn').forEach(btn => {
      const row = rows[parseInt(btn.dataset.row, 10)];
      btn.addEventListener('click', () => this._openManualDeposit(row));
    });
  },

  _sessionStatusBadge(status) {
    if (status === 'open')         return '<span class="badge badge-success">Aktif</span>';
    if (status === 'closed_today') return '<span class="badge badge-warning">Ditutup Hari Ini</span>';
    return '<span class="badge" style="background:#e0e0e0;color:#555">Tidak Ada Shift</span>';
  },

  _cashClass(row) {
    if (row.expected_cash < 0)       return 'text-danger';
    if (row.risk_level === 'high')    return 'text-danger';
    if (row.risk_level === 'warning') return 'text-warning';
    return 'text-green';
  },

  _updateLastUpdatedLabel() {
    const el = document.getElementById('scp-last-updated');
    if (!el || !this._lastUpdated) return;
    el.textContent = 'Diperbarui: ' + fDate(this._lastUpdated.toISOString());
  },

  // ── Filter events ────────────────────────────────────────────
  _bindFilterEvents() {
    ['scp-filter-branch', 'scp-filter-status'].forEach(id => {
      const el = document.getElementById(id);
      if (el) el.addEventListener('change', () => this._loadPositions());
    });
    const riskFilter = document.getElementById('scp-filter-risk');
    if (riskFilter) riskFilter.addEventListener('change', () => {
      const rows = this._getFilteredPositions();
      this._renderSummaryCards(rows);
      this._renderTable(rows);
      if (window.lucide) requestAnimationFrame(() => lucide.createIcons());
    });
  },

  _bindRefreshBtn() {
    const btn = document.getElementById('scp-refresh-btn');
    if (btn) btn.addEventListener('click', () => this._loadPositions());
  },

  // ── Detail Modal ─────────────────────────────────────────────
  async _openDetail(row) {
    const modal = document.getElementById('modal-scp-detail');
    if (!modal) return;

    document.getElementById('scp-detail-staff-name').textContent = row.staff_name || '—';
    document.getElementById('scp-detail-branch').textContent     = row.branch_name || '—';
    document.getElementById('scp-detail-session-id').textContent = row.session_id  || '—';
    document.getElementById('scp-detail-status').innerHTML       = this._sessionStatusBadge(row.session_status);

    this._renderDetailBreakdown(row);
    this._clearDetailHistory();

    openModal('modal-scp-detail');
    if (window.lucide) requestAnimationFrame(() => lucide.createIcons());

    if (row.branch_id) {
      try {
        const detail = await cashService.getStaffCashPositionDetail({
          staffId:   row.staff_id,
          branchId:  row.branch_id,
          sessionId: row.session_id || null
        });
        this._renderDetailHistory(detail.logs, detail.deposits);
      } catch (e) {
        console.error('adminStaffCashUi._openDetail detail load', e);
        document.getElementById('scp-detail-logs-body').innerHTML =
          `<tr><td colspan="5" class="empty-td text-danger">Gagal memuat riwayat: ${escHtml(e.message || '')}</td></tr>`;
      }
    }
  },

  _renderDetailBreakdown(row) {
    const set = (id, val) => {
      const el = document.getElementById(id);
      if (el) el.textContent = val;
    };
    set('scp-detail-opening',   fRp(row.opening_cash));
    set('scp-detail-sales',     fRp(row.cash_sales_in));
    set('scp-detail-manual-in', fRp(row.manual_in));
    set('scp-detail-manual-out',fRp(row.manual_out));
    set('scp-detail-refund',    fRp(row.refund_out));
    set('scp-detail-void',      fRp(row.void_out));
    set('scp-detail-deposit',   fRp(row.deposit_confirmed));
    set('scp-detail-expected',  fRp(row.expected_cash));
    set('scp-detail-pending',   fRp(row.deposit_pending));

    const expEl = document.getElementById('scp-detail-expected');
    if (expEl) {
      expEl.className = 'fw-700 ' + this._cashClass(row);
    }
  },

  _clearDetailHistory() {
    const logsBody     = document.getElementById('scp-detail-logs-body');
    const depositsBody = document.getElementById('scp-detail-deposits-body');
    if (logsBody)     logsBody.innerHTML     = '<tr><td colspan="5" class="empty-td">Memuat...</td></tr>';
    if (depositsBody) depositsBody.innerHTML = '<tr><td colspan="4" class="empty-td">Memuat...</td></tr>';
  },

  _renderDetailHistory(logs, deposits) {
    const logsBody = document.getElementById('scp-detail-logs-body');
    if (logsBody) {
      if (!logs.length) {
        logsBody.innerHTML = '<tr><td colspan="5" class="empty-td text-muted">Tidak ada log kas</td></tr>';
      } else {
        logsBody.innerHTML = logs.map(l => {
          const typeCls = l.type === 'in' ? 'text-green' : 'text-danger';
          const sign    = l.type === 'in' ? '+' : '−';
          const voided  = l.is_void ? ' <span class="badge badge-danger" style="font-size:10px">VOID</span>' : '';
          const cat     = l.cash_categories?.name || escHtml(l.reference_type || '—');
          return `<tr class="${l.is_void ? 'scp-voided-row' : ''}">
            <td class="text-muted" style="font-size:11px">${fDate(l.created_at)}</td>
            <td>${cat}${voided}</td>
            <td class="${typeCls} fw-700">${sign}${fRp(l.amount)}</td>
            <td class="text-muted" style="font-size:11px">${escHtml(l.creator?.name || '—')}</td>
            <td class="text-muted" style="font-size:11px">${escHtml(l.note || '—')}</td>
          </tr>`;
        }).join('');
      }
    }

    const depositsBody = document.getElementById('scp-detail-deposits-body');
    if (depositsBody) {
      if (!deposits.length) {
        depositsBody.innerHTML = '<tr><td colspan="4" class="empty-td text-muted">Tidak ada riwayat setoran</td></tr>';
      } else {
        depositsBody.innerHTML = deposits.map(d => {
          const sl = { pending: { text:'Menunggu', cls:'badge-warning' }, confirmed: { text:'Dikonfirmasi', cls:'badge-success' }, rejected: { text:'Ditolak', cls:'badge-danger' } }[d.status] || { text: d.status, cls: '' };
          return `<tr>
            <td class="text-muted" style="font-size:11px">${fDate(d.created_at)}</td>
            <td class="fw-700">${fRp(d.amount)}</td>
            <td><span class="badge ${sl.cls}">${sl.text}</span></td>
            <td class="text-muted" style="font-size:11px">${escHtml(d.notes || '—')}</td>
          </tr>`;
        }).join('');
      }
    }

    if (window.lucide) requestAnimationFrame(() => lucide.createIcons());
  },

  _bindDetailModalClose() {
    ['scp-detail-close-btn', 'scp-detail-close-btn-footer'].forEach(id => {
      const btn = document.getElementById(id);
      if (btn) btn.addEventListener('click', () => closeModal('modal-scp-detail'));
    });
  },

  // ── Manual deposit from table row ────────────────────────────
  _openManualDeposit(row) {
    if (!window.adminDepositUi) {
      showToast('Modul setoran belum siap', 'error');
      return;
    }
    if (!row.branch_id) {
      showToast('Staff tidak memiliki cabang', 'error');
      return;
    }

    // Navigate to cash-deposits section to ensure adminDepositUi is ready
    // then open modal with branch pre-selected
    const depositUi = window.adminDepositUi;
    if (!depositUi.branches.length) {
      showToast('Memuat data cabang...', 'info');
      return;
    }

    // Open the manual deposit modal with staff + branch pre-filled
    depositUi.openManualDepositModal();

    // Pre-select branch and staff after modal opens
    requestAnimationFrame(() => {
      const branchSel = document.getElementById('manual-deposit-branch');
      if (branchSel) {
        branchSel.value = String(row.branch_id);
        depositUi.onManualBranchChange();

        // Pre-select staff after branch options are rendered
        requestAnimationFrame(() => {
          const staffSel = document.getElementById('manual-deposit-staff');
          if (staffSel) staffSel.value = String(row.staff_id);
        });
      }
    });
  }
};

window.adminStaffCashUi = adminStaffCashUi;
adminStaffCashUi.init();
