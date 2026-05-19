'use strict';

const adminBranchCashUi = {

  // ── State ─────────────────────────────────────────────────────
  _rows:        [],
  _loading:     false,
  _lastUpdated: null,

  // Correction modal
  _corrTarget: null, // { branchId, branchName, currentBalance, version, hasActiveShift }
  _corrSaving: false,

  // Force-close modal
  _fcTarget: null,   // { branchId, branchName, openSessionId, staffName }
  _fcSaving: false,

  // Ledger modal
  _ledgerTarget: null, // { branchId, branchName }
  _ledgerData:   [],

  // ── Init ─────────────────────────────────────────────────────
  init() {
    document.addEventListener('DOMContentLoaded', () => this._bindEvents());
  },

  _bindEvents() {
    const on = (id, ev, fn) => {
      const el = document.getElementById(id);
      if (el) el.addEventListener(ev, fn);
    };

    on('bc-refresh-btn',          'click', () => this.load());
    on('bc-filter-branch',        'change', () => this._applyFilters());
    on('bc-filter-status',        'change', () => this._applyFilters());
    on('bc-filter-has-pending',   'change', () => this._applyFilters());
    on('bc-filter-has-variance',  'change', () => this._applyFilters());

    // Correction modal
    on('bc-correction-close-btn',  'click', () => this._closeModal('modal-branch-cash-correction'));
    on('bc-correction-cancel-btn', 'click', () => this._closeModal('modal-branch-cash-correction'));
    on('bc-correction-save-btn',   'click', () => this._saveCorrection());

    // Force-close modal
    on('bc-forceclose-close-btn',  'click', () => this._closeModal('modal-branch-force-close'));
    on('bc-forceclose-cancel-btn', 'click', () => this._closeModal('modal-branch-force-close'));
    on('bc-forceclose-save-btn',   'click', () => this._saveForceClose());

    // Ledger modal
    on('bc-ledger-close-btn',         'click', () => this._closeModal('modal-branch-cash-ledger'));
    on('bc-ledger-close-btn-footer',   'click', () => this._closeModal('modal-branch-cash-ledger'));

    // Table action delegation
    const tbodyEl = document.getElementById('bc-table-body');
    if (tbodyEl) {
      tbodyEl.addEventListener('click', e => {
        const btn = e.target.closest('[data-bc-action]');
        if (!btn) return;
        const action   = btn.dataset.bcAction;
        const branchId = Number(btn.dataset.branchId);
        const row = this._rows.find(r => Number(r.branch_id) === branchId);
        if (!row) return;
        if (action === 'correct')      this._openCorrection(row);
        else if (action === 'ledger')  this._openLedger(row);
        else if (action === 'force-close') this._openForceClose(row);
      });
    }
  },

  // ── Load ──────────────────────────────────────────────────────
  async load() {
    if (this._loading) return;
    this._loading = true;
    this._setTableLoading(true);
    try {
      const adminId = auth.getSession()?.id;
      if (!adminId) throw new Error('Tidak ada sesi admin');

      this._rows = await cashService.getAdminBranchCashPositions({ adminId });

      // Populate branch filter dropdown
      const branchSel = document.getElementById('bc-filter-branch');
      if (branchSel && branchSel.options.length <= 1) {
        const uniqueBranches = [...new Map(this._rows.map(r => [r.branch_id, r.branch_name])).entries()];
        uniqueBranches.forEach(([id, name]) => {
          const opt = document.createElement('option');
          opt.value = id; opt.textContent = name;
          branchSel.appendChild(opt);
        });
      }
      this._lastUpdated = new Date();
      const el = document.getElementById('bc-last-updated');
      if (el) el.textContent = 'Diperbarui ' + (fTimeOnly ? fTimeOnly(this._lastUpdated) : fDate(this._lastUpdated));

      this._renderSummaryCards();
      this._applyFilters();
    } catch (e) {
      showDbError(e, { action: 'memuat posisi kas outlet', entity: 'Kas Outlet' });
      const tbody = document.getElementById('bc-table-body');
      if (tbody) tbody.innerHTML = '<tr><td colspan="11" class="empty-td">Gagal memuat data. Klik Refresh untuk coba lagi.</td></tr>';
    } finally {
      this._loading = false;
    }
  },

  markDirty() {
    this.load();
  },

  // ── Render ────────────────────────────────────────────────────
  _renderSummaryCards() {
    const el = document.getElementById('bc-summary-cards');
    if (!el) return;
    const totalKas      = this._rows.reduce((s, r) => s + Number(r.current_balance || 0), 0);
    const activeCount   = this._rows.filter(r => r.shift_status === 'open').length;
    const pendingCount  = this._rows.filter(r => Number(r.pending_deposit_amount || 0) > 0).length;
    const pendingTotal  = this._rows.reduce((s, r) => s + Number(r.pending_deposit_amount || 0), 0);
    const varianceCount = this._rows.filter(r => r.has_variance).length;

    el.innerHTML = `
      <div class="stat-card">
        <div class="stat-icon"><i data-lucide="wallet"></i></div>
        <div class="stat-info">
          <div class="stat-label">Total Kas Outlet</div>
          <div class="stat-value">${formatRupiah(totalKas)}</div>
        </div>
      </div>
      <div class="stat-card">
        <div class="stat-icon"><i data-lucide="play-circle"></i></div>
        <div class="stat-info">
          <div class="stat-label">Shift Aktif</div>
          <div class="stat-value">${activeCount} outlet</div>
        </div>
      </div>
      <div class="stat-card">
        <div class="stat-icon"><i data-lucide="clock"></i></div>
        <div class="stat-info">
          <div class="stat-label">Setoran Pending</div>
          <div class="stat-value">${pendingCount} item · ${formatRupiah(pendingTotal)}</div>
        </div>
      </div>
      <div class="stat-card">
        <div class="stat-icon"><i data-lucide="alert-triangle"></i></div>
        <div class="stat-info">
          <div class="stat-label">Ada Selisih</div>
          <div class="stat-value">${varianceCount} outlet</div>
        </div>
      </div>`;
    if (window.lucide) lucide.createIcons();
  },

  _applyFilters() {
    const filterBranch   = document.getElementById('bc-filter-branch')?.value   || '';
    const filterStatus   = document.getElementById('bc-filter-status')?.value   || 'all';
    const hasPending     = document.getElementById('bc-filter-has-pending')?.checked || false;
    const hasVariance    = document.getElementById('bc-filter-has-variance')?.checked || false;

    let rows = this._rows;
    if (filterBranch) rows = rows.filter(r => String(r.branch_id) === filterBranch);
    if (filterStatus !== 'all') rows = rows.filter(r => r.shift_status === filterStatus);
    if (hasPending)   rows = rows.filter(r => Number(r.pending_deposit_amount || 0) > 0);
    if (hasVariance)  rows = rows.filter(r => r.has_variance);

    this._renderTable(rows);
  },

  _renderTable(rows) {
    const tbody = document.getElementById('bc-table-body');
    if (!tbody) return;
    if (!rows.length) {
      tbody.innerHTML = '<tr><td colspan="11" class="empty-td">Tidak ada data outlet.</td></tr>';
      return;
    }

    tbody.innerHTML = rows.map(r => {
      const statusBadge = this._shiftStatusBadge(r);
      const pendingBadge = Number(r.pending_deposit_amount || 0) > 0
        ? `<span class="badge badge-warning">${formatRupiah(r.pending_deposit_amount)}</span>`
        : '<span class="text-muted">—</span>';
      const varianceBadge = r.has_variance && r.last_variance_amount != null
        ? `<span class="badge ${Number(r.last_variance_amount) >= 0 ? 'badge-success' : 'badge-danger'}">${Number(r.last_variance_amount) >= 0 ? '+' : ''}${formatRupiah(r.last_variance_amount)}</span>`
        : '<span class="text-muted">—</span>';
      const estKas = r.open_session_id && r.running_estimated_cash != null
        ? `<div style="font-size:11px;color:var(--primary)">${formatRupiah(r.running_estimated_cash)}</div>`
        : '';
      const forceCloseBtn = r.shift_status === 'open'
        ? `<button class="btn btn-danger btn-xs" data-bc-action="force-close" data-branch-id="${r.branch_id}" title="Paksa Tutup Shift">
             <i data-lucide="x-octagon" style="width:12px;height:12px"></i>
           </button>`
        : '';

      return `<tr>
        <td><span style="font-weight:600">${escHtml(r.branch_name)}</span></td>
        <td style="font-weight:700;color:var(--text)">${formatRupiah(r.current_balance)}</td>
        <td>${estKas || '<span class="text-muted">—</span>'}</td>
        <td>${r.last_opening_cash != null ? formatRupiah(r.last_opening_cash) : '<span class="text-muted">—</span>'}</td>
        <td>${r.last_closing_cash != null ? formatRupiah(r.last_closing_cash) : '<span class="text-muted">—</span>'}</td>
        <td style="font-size:12px">${escHtml(r.last_opened_by_name || '—')}</td>
        <td style="font-size:12px">${escHtml(r.last_closed_by_name || '—')}</td>
        <td>${statusBadge}</td>
        <td>${pendingBadge}</td>
        <td>${varianceBadge}</td>
        <td>
          <div class="flex gap-1">
            <button class="btn btn-outline btn-xs" data-bc-action="ledger" data-branch-id="${r.branch_id}" title="Riwayat Kas">
              <i data-lucide="scroll-text" style="width:12px;height:12px"></i>
            </button>
            <button class="btn btn-outline btn-xs" data-bc-action="correct" data-branch-id="${r.branch_id}" title="Set / Input Kas Outlet">
              <i data-lucide="edit-3" style="width:12px;height:12px"></i> Set Kas
            </button>
            ${forceCloseBtn}
          </div>
        </td>
      </tr>`;
    }).join('');
    if (window.lucide) lucide.createIcons();
  },

  _shiftStatusBadge(r) {
    if (r.shift_status === 'open') {
      const dur = r.open_session_opened_at ? this._duration(r.open_session_opened_at) : '';
      return `<span class="badge badge-success">Aktif${r.open_staff_name ? ' · ' + escHtml(r.open_staff_name) : ''}${dur ? ' · ' + dur : ''}</span>`;
    }
    if (r.shift_status === 'closed_today') return '<span class="badge badge-info">Sudah Tutup</span>';
    return '<span class="badge badge-default">Belum Buka</span>';
  },

  _duration(openedAt) {
    const ms  = Date.now() - new Date(openedAt).getTime();
    const min = Math.floor(ms / 60000);
    if (min < 60) return `${min}m`;
    const h = Math.floor(min / 60);
    return `${h}j ${min % 60}m`;
  },

  _setTableLoading(loading) {
    const tbody = document.getElementById('bc-table-body');
    if (tbody && loading) {
      tbody.innerHTML = '<tr><td colspan="11" class="empty-td">Memuat...</td></tr>';
    }
  },

  // ── Correction Modal ──────────────────────────────────────────
  _openCorrection(row) {
    this._corrTarget = {
      branchId:       row.branch_id,
      branchName:     row.branch_name,
      currentBalance: Number(row.current_balance || 0),
      version:        Number(row.version || 0),
      hasActiveShift: row.shift_status === 'open'
    };
    this._corrSaving = false;

    const g = id => document.getElementById(id);
    const nameEl    = g('bc-correction-branch-name');
    const curEl     = g('bc-correction-current');
    const warnEl    = g('bc-correction-shift-warn');
    const inputEl   = g('bc-correction-new-balance');
    const reasonEl  = g('bc-correction-reason');
    const saveBtn   = g('bc-correction-save-btn');

    if (nameEl)   nameEl.textContent   = row.branch_name;
    if (curEl)    curEl.textContent    = formatRupiah(this._corrTarget.currentBalance);
    if (warnEl)   warnEl.style.display = row.shift_status === 'open' ? '' : 'none';
    if (inputEl)  inputEl.value        = '';
    if (reasonEl) reasonEl.value       = '';
    if (saveBtn)  saveBtn.disabled     = false;
    if (saveBtn)  saveBtn.textContent  = 'Simpan Koreksi';

    this._openModal('modal-branch-cash-correction');
  },

  async _saveCorrection() {
    if (this._corrSaving || !this._corrTarget) return;
    const g = id => document.getElementById(id);
    const newBalanceStr = g('bc-correction-new-balance')?.value;
    const reason        = g('bc-correction-reason')?.value?.trim() || '';
    const saveBtn       = g('bc-correction-save-btn');

    const newBalance = parseFloat(newBalanceStr);
    if (isNaN(newBalance) || newBalance < 0) {
      showToast('Masukkan posisi kas baru yang valid (≥ 0)', 'error'); return;
    }
    if (reason.length < 3) {
      showToast('Keterangan wajib diisi minimal 3 karakter', 'error'); return;
    }

    this._corrSaving = true;
    if (saveBtn) { saveBtn.disabled = true; saveBtn.textContent = 'Menyimpan…'; }
    try {
      const adminId = auth.getSession()?.id;
      await cashService.adminSetBranchCashBalance({
        adminId,
        branchId:   this._corrTarget.branchId,
        newBalance,
        reason,
        version:    this._corrTarget.version
      });
      showToast(`Posisi kas ${this._corrTarget.branchName} diset ke ${formatRupiah(newBalance)}. Shift berikutnya akan mulai dari nilai ini.`, 'success');
      this._closeModal('modal-branch-cash-correction');
      this.load();
    } catch (e) {
      showToast(e.message, 'error');
    } finally {
      this._corrSaving = false;
      if (saveBtn) { saveBtn.disabled = false; saveBtn.textContent = 'Simpan'; }
    }
  },

  // ── Force Close Modal ─────────────────────────────────────────
  _openForceClose(row) {
    if (row.shift_status !== 'open' || !row.open_session_id) {
      showToast('Tidak ada shift aktif untuk outlet ini', 'warning'); return;
    }
    this._fcTarget = {
      branchId:      row.branch_id,
      branchName:    row.branch_name,
      openSessionId: row.open_session_id,
      staffName:     row.open_staff_name || '—'
    };
    this._fcSaving = false;

    const g = id => document.getElementById(id);
    const nameEl   = g('bc-forceclose-branch-name');
    const staffEl  = g('bc-forceclose-staff-name');
    const cashEl   = g('bc-forceclose-cash');
    const reasonEl = g('bc-forceclose-reason');
    const saveBtn  = g('bc-forceclose-save-btn');

    if (nameEl)   nameEl.textContent  = row.branch_name;
    if (staffEl)  staffEl.textContent = `Staff aktif: ${row.open_staff_name || '—'}`;
    if (cashEl)   cashEl.value        = '';
    if (reasonEl) reasonEl.value      = '';
    if (saveBtn)  saveBtn.disabled    = false;
    if (saveBtn)  saveBtn.textContent = 'Paksa Tutup Shift';

    this._openModal('modal-branch-force-close');
  },

  async _saveForceClose() {
    if (this._fcSaving || !this._fcTarget) return;
    const g = id => document.getElementById(id);
    const cashStr  = g('bc-forceclose-cash')?.value;
    const reason   = g('bc-forceclose-reason')?.value?.trim() || '';
    const saveBtn  = g('bc-forceclose-save-btn');

    const closingCash = parseFloat(cashStr);
    if (isNaN(closingCash) || closingCash < 0) {
      showToast('Masukkan kas akhir aktual yang valid (≥ 0)', 'error'); return;
    }
    if (reason.length < 5) {
      showToast('Alasan forced close wajib diisi minimal 5 karakter', 'error'); return;
    }

    this._fcSaving = true;
    if (saveBtn) { saveBtn.disabled = true; saveBtn.textContent = 'Menutup...'; }
    try {
      const adminId = auth.getSession()?.id;
      await transactionService.adminForceCloseBranchSession({
        adminId,
        sessionId:   this._fcTarget.openSessionId,
        closingCash,
        reason
      });
      showToast(`Shift ${this._fcTarget.branchName} berhasil ditutup secara paksa.`, 'success');
      this._closeModal('modal-branch-force-close');
      this.load();
    } catch (e) {
      showToast(e.message, 'error');
    } finally {
      this._fcSaving = false;
      if (saveBtn) { saveBtn.disabled = false; saveBtn.textContent = 'Paksa Tutup Shift'; }
    }
  },

  // ── Ledger Modal ──────────────────────────────────────────────
  async _openLedger(row) {
    this._ledgerTarget = { branchId: row.branch_id, branchName: row.branch_name };
    const nameEl  = document.getElementById('bc-ledger-branch-name');
    const tbody   = document.getElementById('bc-ledger-table-body');
    if (nameEl) nameEl.textContent = row.branch_name;
    if (tbody)  tbody.innerHTML = '<tr><td colspan="9" class="empty-td">Memuat...</td></tr>';
    this._openModal('modal-branch-cash-ledger');

    try {
      const adminId = auth.getSession()?.id;
      this._ledgerData = await cashService.getBranchCashLedger({
        adminId,
        branchId: row.branch_id,
        limit: 100
      });
      this._renderLedger();
    } catch (e) {
      if (tbody) tbody.innerHTML = `<tr><td colspan="9" class="empty-td text-danger">${escHtml(e.message)}</td></tr>`;
    }
  },

  _renderLedger() {
    const tbody = document.getElementById('bc-ledger-table-body');
    if (!tbody) return;
    if (!this._ledgerData.length) {
      tbody.innerHTML = '<tr><td colspan="9" class="empty-td">Belum ada riwayat.</td></tr>';
      return;
    }

    const typeLabels = {
      default_seed:         'Inisialisasi',
      session_open_confirm: 'Buka Shift',
      opening_variance:     'Selisih Buka',
      session_close:        'Tutup Shift',
      deposit_approved:     'Setoran Approved',
      deposit_rejected:     'Setoran Ditolak',
      admin_adjustment:     'Koreksi Admin',
      force_close:          'Paksa Tutup',
      system_repair:        'Perbaikan Sistem'
    };
    const dirBadge = dir => {
      if (dir === 'in')     return '<span class="badge badge-success">Masuk</span>';
      if (dir === 'out')    return '<span class="badge badge-danger">Keluar</span>';
      if (dir === 'adjust') return '<span class="badge badge-warning">Adjust</span>';
      return '<span class="badge badge-default">—</span>';
    };

    tbody.innerHTML = this._ledgerData.map(row => `<tr>
      <td style="font-size:11px;white-space:nowrap">${fDate(row.created_at)}</td>
      <td><span class="badge badge-default" style="font-size:10px">${typeLabels[row.movement_type] || row.movement_type}</span></td>
      <td>${dirBadge(row.direction)}</td>
      <td style="font-weight:700">${formatRupiah(row.amount)}</td>
      <td>${formatRupiah(row.balance_before)}</td>
      <td style="font-weight:700;color:var(--primary)">${formatRupiah(row.balance_after)}</td>
      <td>${row.variance_amount != null && row.variance_amount !== 0
        ? `<span style="color:${Number(row.variance_amount) >= 0 ? 'var(--success)' : 'var(--danger)'}">${Number(row.variance_amount) >= 0 ? '+' : ''}${formatRupiah(row.variance_amount)}</span>`
        : '<span class="text-muted">—</span>'}</td>
      <td style="font-size:12px">${escHtml(row.staff_name || row.admin_name || '—')}</td>
      <td style="font-size:11px;max-width:180px;word-break:break-word">${escHtml(row.reason || '—')}</td>
    </tr>`).join('');
    if (window.lucide) lucide.createIcons();
  },

  // ── Modal Helpers ─────────────────────────────────────────────
  _openModal(id) {
    const el = document.getElementById(id);
    if (el) el.style.display = 'flex';
    if (window.lucide) requestAnimationFrame(() => lucide.createIcons());
  },
  _closeModal(id) {
    const el = document.getElementById(id);
    if (el) el.style.display = 'none';
  }
};

adminBranchCashUi.init();
