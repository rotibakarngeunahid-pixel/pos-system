'use strict';

const adminDepositUi = {
  el: {},
  branches: [],
  accounts: [],
  accountsLoading: false,
  accountsLoadError: null,
  staffMap: {},
  staffRows: [],
  selectedQrisFile: null,
  selectedManualProofFile: null,
  selectedManualProofUrl: null,
  isSavingManual: false,
  manualSessionId: null,
  manualEligibleSessions: [],
  manualSessionsLoading: false,

  init() {
    document.addEventListener('DOMContentLoaded', async () => {
      try {
        const adm = auth.requireAnyRole(['admin', 'owner']);
        if (!adm) return;
        this.bindElements();
        await this.loadBranches();
        await this.loadAccounts();
        await this.loadStaff();
        await this.loadDeposits();
      } catch (e) {
        console.error('adminDepositUi.init', e);
      }
    });
  },

  bindElements() {
    this.el.section = document.getElementById('section-cash-deposits');
    this.el.branch = document.getElementById('deposits-filter-branch');
    this.el.status = document.getElementById('deposits-filter-status');
    this.el.dateFrom = document.getElementById('deposits-filter-from');
    this.el.dateTo = document.getElementById('deposits-filter-to');
    this.el.btnFilter = document.getElementById('deposits-filter-btn');
    this.el.tableBody = document.getElementById('deposits-table-body');
    this.el.accountsList = document.getElementById('deposit-accounts-list');
    this.el.addManualBtn = document.getElementById('btn-add-manual-deposit');
    this.el.addAccountBtn = document.getElementById('btn-add-deposit-account');

    this.el.manualBranch = document.getElementById('manual-deposit-branch');
    this.el.manualStaff = document.getElementById('manual-deposit-staff');
    this.el.manualStaffHint = document.getElementById('manual-deposit-staff-hint');
    this.el.manualSession = document.getElementById('manual-deposit-session');
    this.el.manualSessionHint = document.getElementById('manual-deposit-session-hint');
    this.el.manualAccount = document.getElementById('manual-deposit-account');
    this.el.manualAccountHint = document.getElementById('manual-deposit-account-hint');
    this.el.manualAmount = document.getElementById('manual-deposit-amount');
    this.el.manualProofLabel = document.getElementById('manual-deposit-proof-label');
    this.el.manualProofFile = document.getElementById('manual-deposit-proof-file');
    this.el.manualProofZone = document.getElementById('manual-deposit-proof-zone');
    this.el.manualProofEmpty = document.getElementById('manual-deposit-proof-empty');
    this.el.manualProofPreview = document.getElementById('manual-deposit-proof-preview');
    this.el.manualProofHint = document.getElementById('manual-deposit-proof-hint');
    this.el.manualProofError = document.getElementById('manual-deposit-proof-error');
    this.el.manualNotes = document.getElementById('manual-deposit-notes');
    this.el.saveManualBtn = document.getElementById('btn-save-manual-deposit');

    this.el.accountModalTitle = document.getElementById('deposit-account-modal-title');
    this.el.accountId = document.getElementById('deposit-account-id');
    this.el.accountLabel = document.getElementById('deposit-account-label');
    this.el.accountType = document.getElementById('deposit-account-type');
    this.el.bankFields = document.getElementById('deposit-account-bank-fields');
    this.el.bankName = document.getElementById('deposit-account-bank-name');
    this.el.accountNumber = document.getElementById('deposit-account-number');
    this.el.accountHolder = document.getElementById('deposit-account-holder');
    this.el.qrisFields = document.getElementById('deposit-account-qris-fields');
    this.el.qrisImageUrl = document.getElementById('deposit-account-qris-image-url');
    this.el.qrisFile = document.getElementById('deposit-account-qris-file');
    this.el.qrisPreview = document.getElementById('deposit-account-qris-preview');
    this.el.accountActive = document.getElementById('deposit-account-is-active');
    this.el.saveAccountBtn = document.getElementById('btn-save-deposit-account');

    if (this.el.btnFilter) this.el.btnFilter.addEventListener('click', () => this.loadDeposits());
    if (this.el.addManualBtn) this.el.addManualBtn.addEventListener('click', () => this.openManualDepositModal());
    if (this.el.manualBranch) this.el.manualBranch.addEventListener('change', () => this.onManualBranchChange());
    if (this.el.manualStaff) this.el.manualStaff.addEventListener('change', () => this.onManualStaffChange());
    if (this.el.manualSession) this.el.manualSession.addEventListener('change', () => this.onManualSessionChange());
    if (this.el.manualAccount) this.el.manualAccount.addEventListener('change', () => {
      this.updateManualProofRequirement();
      this.updateManualSubmitState();
    });
    if (this.el.manualAmount) this.el.manualAmount.addEventListener('input', () => this.formatManualAmountInput());
    if (this.el.manualProofFile) this.el.manualProofFile.addEventListener('change', e => this.handleManualProofFiles(e.target.files));
    this.bindManualProofZone();
    if (this.el.saveManualBtn) this.el.saveManualBtn.addEventListener('click', () => this.saveManualDeposit());
    if (this.el.addAccountBtn) this.el.addAccountBtn.addEventListener('click', () => this.openAccountModal());
    if (this.el.accountType) this.el.accountType.addEventListener('change', () => this.toggleAccountTypeFields());
    if (this.el.qrisFile) this.el.qrisFile.addEventListener('change', e => this.handleQrisFile(e.target.files));
    if (this.el.qrisImageUrl) this.el.qrisImageUrl.addEventListener('input', () => this.renderQrisPreview(this.el.qrisImageUrl.value));
    if (this.el.saveAccountBtn) this.el.saveAccountBtn.addEventListener('click', () => this.saveAccount());
  },

  bindManualProofZone() {
    const zone = this.el.manualProofZone;
    if (!zone) return;

    zone.addEventListener('click', e => {
      if (e.target.closest('.deposit-proof-remove')) {
        this.removeManualProofFile();
        return;
      }
      if (e.target.closest('a')) return;
      this.el.manualProofFile?.click();
    });

    zone.addEventListener('keydown', e => {
      if (e.key !== 'Enter' && e.key !== ' ') return;
      if (e.target.closest('.deposit-proof-remove')) return;
      e.preventDefault();
      this.el.manualProofFile?.click();
    });

    zone.addEventListener('dragover', e => {
      e.preventDefault();
      zone.classList.add('dragover');
    });

    zone.addEventListener('dragleave', e => {
      if (e.currentTarget === zone) zone.classList.remove('dragover');
    });

    zone.addEventListener('drop', e => {
      e.preventDefault();
      zone.classList.remove('dragover');
      this.handleManualProofFiles(e.dataTransfer?.files);
    });
  },

  async loadBranches() {
    const { data: branches, error } = await db.from('branches').select('*').order('name');
    if (error) return;
    this.branches = (branches || []).filter(b => b.is_active !== false);
    const options = this.branches.map(b => `<option value="${b.id}">${escHtml(b.name)}</option>`).join('');
    if (this.el.branch) this.el.branch.innerHTML = '<option value="">Semua Cabang</option>' + options;
  },

  async loadStaff() {
    let { data, error } = await db.from('users').select('id, name, role, branch_id, is_active').order('name');
    const errMsg = String(error?.message || '').toLowerCase();
    if (error && (error.code === '42703' || errMsg.includes('is_active'))) {
      ({ data, error } = await db.from('users').select('id, name, role, branch_id').order('name'));
    }
    if (error) throw error;
    const rows = data || [];
    this.staffRows = rows.filter(u => u.is_active !== false);
    this.staffMap = {};
    rows.forEach(u => { this.staffMap[u.id] = u.name; });
  },

  statusLabel(status) {
    if (status === 'confirmed') return { text: 'Dikonfirmasi', cls: 'badge-success' };
    if (status === 'rejected')  return { text: 'Ditolak',      cls: 'badge-danger' };
    return                              { text: 'Menunggu',     cls: 'badge-warning' };
  },

  async loadDeposits() {
    if (!this.el.tableBody) return;
    const branchId = this.el.branch?.value || null;
    const status   = this.el.status?.value || null;
    const dateFrom = this.el.dateFrom?.value || null;
    const dateTo   = this.el.dateTo?.value || null;

    this.el.tableBody.innerHTML = '<tr><td colspan="10" class="empty-td" style="padding:24px">Memuat data...</td></tr>';

    try {
      const rows = await depositService.getAllDeposits({ branchId, status, dateFrom, dateTo, limit: 200 });

      if (!rows || !rows.length) {
        this.el.tableBody.innerHTML = '<tr><td colspan="10" class="empty-td">Tidak ada data setoran untuk filter ini</td></tr>';
        this.renderDepositTotals([]);
        return;
      }

      // Build HTML without storing IDs in attributes — use closure binding instead
      this.el.tableBody.innerHTML = rows.map((r, i) => {
        // r.id is always the cash_deposits UUID — no joins means no bigint-id collision
        const depositId = r.id;
        const shortId   = String(depositId || '').slice(0, 8).toUpperCase();
        const date      = fDate(r.created_at);
        const staff     = escHtml(this.staffMap[r.staff_id] || '-');
        const br        = escHtml(this.branches.find(b => b.id === r.branch_id)?.name || '-');
        const acc       = this.accounts.find(a => a.id === r.deposit_account_id);
        const method    = escHtml(this.getDepositMethodLabel(r, acc));
        const typeIcon  = this.getAccountIcon(acc);
        const proof     = this.renderProofLink(r);
        const notes     = r.notes ? `<span title="${escHtml(r.notes)}" class="deposit-admin-notes">${escHtml(r.notes)}</span>` : '<span class="text-muted">—</span>';

        const sl       = this.statusLabel(r.status);
        const reviewer = this.staffMap[r.reviewed_by] || null;

        let statusCell = `<div class="deposit-admin-status-wrap">
          <span class="badge ${sl.cls} deposit-admin-badge">${sl.text}</span>`;
        if (reviewer && r.status !== 'pending') {
          statusCell += `<span class="deposit-admin-reviewer">oleh ${escHtml(reviewer)}</span>`;
        }
        if (r.status === 'rejected' && r.reject_reason) {
          statusCell += `<span class="deposit-admin-reject-reason">${escHtml(r.reject_reason)}</span>`;
        }
        statusCell += `</div>`;

        const actionBtns = r.status === 'pending'
          ? `<div class="deposit-admin-actions" data-row="${i}">
               <button type="button" class="btn btn-success btn-sm dep-confirm-btn">
                 <i data-lucide="check" style="width:13px;height:13px"></i> Konfirmasi
               </button>
               <button type="button" class="btn btn-danger btn-sm dep-reject-btn">
                 <i data-lucide="x" style="width:13px;height:13px"></i> Tolak
               </button>
             </div>`
          : '';

        const cashBalance = r.cash_balance_at_deposit == null
          ? '<span class="text-muted">Manual</span>'
          : fRp(r.cash_balance_at_deposit);

        return `<tr class="deposit-admin-row ${r.status}">
          <td class="deposit-admin-id" title="${escHtml(depositId)}">${shortId}</td>
          <td class="deposit-admin-date">${date}</td>
          <td>${staff}</td>
          <td>${br}</td>
          <td class="deposit-admin-amount">${fRp(r.amount)}</td>
          <td class="deposit-admin-kas text-muted">${cashBalance}</td>
          <td>
            <span class="deposit-admin-method">
              <i data-lucide="${typeIcon}" style="width:12px;height:12px;flex-shrink:0"></i>
              ${method}
            </span>
          </td>
          <td>${notes}</td>
          <td>${proof}</td>
          <td>${statusCell}${actionBtns}</td>
        </tr>`;
      }).join('');

      // Bind confirm/reject using closure — no data-id attribute reliance
      this.el.tableBody.querySelectorAll('.deposit-admin-actions').forEach(wrap => {
        const rowIdx = parseInt(wrap.dataset.row, 10);
        const row    = rows[rowIdx];
        const depositId = row.id;

        wrap.querySelector('.dep-confirm-btn')?.addEventListener('click', () => {
          this.doConfirm(depositId);
        });
        wrap.querySelector('.dep-reject-btn')?.addEventListener('click', () => {
          this.doReject(depositId);
        });
      });

      this.renderDepositTotals(rows);
      if (window.lucide) requestAnimationFrame(() => lucide.createIcons());
    } catch (e) {
      console.error('loadDeposits', e);
      this.el.tableBody.innerHTML = '<tr><td colspan="10" class="empty-td text-danger">Gagal memuat data setoran</td></tr>';
      showToast('Gagal memuat setoran: ' + (e.message || ''), 'error');
    }
  },

  getDepositMethodLabel(row, account = null) {
    return row?.deposit_account_name_snapshot
      || account?.label
      || row?.legacy_method
      || 'Metode lama/tidak tersedia';
  },

  getAccountIcon(account) {
    if (account?.type === 'cash') return 'hand-coins';
    if (account?.type === 'qris') return 'qr-code';
    return 'landmark';
  },

  getAccountDetail(account) {
    if (!account) return '';
    if (account.type === 'cash') return 'Serah tunai';
    if (account.type === 'qris') return 'QRIS';
    const parts = [account.bank_name, account.account_number].filter(Boolean);
    return parts.length ? parts.join(' - ') : 'Transfer bank';
  },

  renderProofLink(row) {
    if (!row?.proof_url) {
      return '<span class="text-muted">Bukti belum tersedia</span>';
    }

    const label = row.proof_file_name ? 'Lihat Bukti' : 'Lihat';
    const title = row.proof_file_name ? ` title="${escHtml(row.proof_file_name)}"` : '';
    return `<a class="deposit-admin-proof-link" href="${escHtml(row.proof_url)}" target="_blank" rel="noopener"${title}>
      <i data-lucide="external-link" style="width:12px;height:12px;vertical-align:middle"></i> ${escHtml(label)}
    </a>`;
  },

  renderDepositTotals(rows) {
    const tfoot = document.getElementById('deposits-table-foot');
    if (!tfoot) return;
    if (!rows.length) { tfoot.innerHTML = ''; return; }
    const pending   = rows.filter(r => r.status === 'pending').reduce((s, r)   => s + Number(r.amount || 0), 0);
    const confirmed = rows.filter(r => r.status === 'confirmed').reduce((s, r) => s + Number(r.amount || 0), 0);
    const rejected  = rows.filter(r => r.status === 'rejected').reduce((s, r)  => s + Number(r.amount || 0), 0);
    tfoot.innerHTML = `
      <tr class="deposit-totals-row">
        <td colspan="4"><strong>${rows.length} setoran</strong></td>
        <td class="deposit-admin-amount"><strong>${fRp(pending + confirmed + rejected)}</strong></td>
        <td colspan="6">
          <span class="badge badge-success" style="margin-right:4px">${fRp(confirmed)}</span>
          <span class="badge badge-warning" style="margin-right:4px">${fRp(pending)}</span>
          <span class="badge badge-danger">${fRp(rejected)}</span>
        </td>
      </tr>`;
  },

  openManualDepositModal({ prefillBranchId = null, prefillStaffId = null, prefillSessionId = null } = {}) {
    if (!this.branches.length) {
      showToast('Belum ada cabang aktif', 'warning');
      return;
    }

    this.manualSessionId = null;
    this.manualEligibleSessions = [];

    const branchOptions = '<option value="">Pilih Cabang</option>'
      + this.branches.map(b => `<option value="${b.id}">${escHtml(b.name)}</option>`).join('');
    if (this.el.manualBranch) {
      this.el.manualBranch.innerHTML = branchOptions;
      this.el.manualBranch.value = prefillBranchId ? String(prefillBranchId) : (this.el.branch?.value || '');
    }
    if (this.el.manualAmount) this.el.manualAmount.value = '';
    if (this.el.manualNotes) this.el.manualNotes.value = '';
    this.removeManualProofFile();
    this.onManualBranchChange(prefillStaffId, prefillSessionId);
    this.updateManualSubmitState();
    openModal('modal-manual-deposit');
    if (window.lucide) requestAnimationFrame(() => lucide.createIcons());
  },

  onManualBranchChange(prefillStaffId = null, prefillSessionId = null) {
    this.renderManualStaffOptions(prefillStaffId);
    this.renderManualAccountOptions();
    this.manualSessionId = null;
    this.manualEligibleSessions = [];
    this.renderManualSessionOptions([]);
    // Load sessions jika branch dan staff sudah dipilih
    const branchId = Number(this.el.manualBranch?.value || 0);
    const staffId = Number(prefillStaffId || this.el.manualStaff?.value || 0);
    if (branchId && staffId) {
      this._loadManualSessions(branchId, staffId, prefillSessionId);
    }
    this.updateManualSubmitState();
  },

  onManualStaffChange() {
    this.manualSessionId = null;
    this.manualEligibleSessions = [];
    this.renderManualSessionOptions([]);
    const branchId = Number(this.el.manualBranch?.value || 0);
    const staffId = Number(this.el.manualStaff?.value || 0);
    if (branchId && staffId) {
      this._loadManualSessions(branchId, staffId);
    }
    this.updateManualSubmitState();
  },

  onManualSessionChange() {
    const val = Number(this.el.manualSession?.value || 0);
    this.manualSessionId = val > 0 ? val : null;
    this.updateManualSubmitState();
  },

  async _loadManualSessions(branchId, staffId, prefillSessionId = null) {
    if (this.manualSessionsLoading) return;
    this.manualSessionsLoading = true;
    if (this.el.manualSession) {
      this.el.manualSession.innerHTML = '<option value="">Memuat shift...</option>';
      this.el.manualSession.disabled = true;
    }
    if (this.el.manualSessionHint) this.el.manualSessionHint.textContent = 'Memuat daftar shift tertutup...';

    try {
      const sessions = await depositService.getEligibleSessions({ branchId, staffId });
      this.manualEligibleSessions = sessions;
      this.renderManualSessionOptions(sessions, prefillSessionId);
    } catch (e) {
      console.warn('adminDepositUi._loadManualSessions', e);
      this.manualEligibleSessions = [];
      this.renderManualSessionOptions([], null, 'Gagal memuat shift');
    } finally {
      this.manualSessionsLoading = false;
    }
    this.updateManualSubmitState();
  },

  renderManualSessionOptions(sessions, prefillSessionId = null, errorMsg = null) {
    if (!this.el.manualSession) return;
    const formatDate = iso => {
      if (!iso) return '-';
      if (typeof fDate === 'function') return fDate(iso);
      return new Date(iso).toLocaleString('id-ID');
    };

    if (errorMsg) {
      this.el.manualSession.innerHTML = `<option value="">${escHtml(errorMsg)}</option>`;
      this.el.manualSession.disabled = true;
      if (this.el.manualSessionHint) this.el.manualSessionHint.textContent = errorMsg;
      this.manualSessionId = null;
      return;
    }

    if (!sessions.length) {
      this.el.manualSession.innerHTML = '<option value="">Tidak ada shift tertutup eligible</option>';
      this.el.manualSession.disabled = true;
      if (this.el.manualSessionHint) this.el.manualSessionHint.textContent = 'Belum ada shift tertutup yang dapat disetor untuk staff ini.';
      this.manualSessionId = null;
      return;
    }

    this.el.manualSession.disabled = false;
    this.el.manualSession.innerHTML = '<option value="">Pilih Shift Tertutup</option>'
      + sessions.map(s => {
        const label = `#${s.session_id} — ${formatDate(s.closed_at)} (kas: ${typeof fRp === 'function' ? fRp(s.depositable_cash) : s.depositable_cash})`;
        const blocked = s.block_reason ? ` [${s.block_reason}]` : '';
        return `<option value="${s.session_id}">${escHtml(label + blocked)}</option>`;
      }).join('');

    // Prefill jika ada
    if (prefillSessionId) {
      const found = sessions.find(s => s.session_id === Number(prefillSessionId));
      if (found) {
        this.el.manualSession.value = String(found.session_id);
        this.manualSessionId = found.session_id;
      }
    }

    const selected = sessions.find(s => s.session_id === this.manualSessionId);
    if (this.el.manualSessionHint) {
      this.el.manualSessionHint.textContent = selected
        ? `Kas dapat disetor: ${typeof fRp === 'function' ? fRp(selected.depositable_cash) : selected.depositable_cash}`
        : `${sessions.length} shift tertutup tersedia`;
    }
  },

  renderManualStaffOptions(prefillStaffId = null) {
    if (!this.el.manualStaff) return;
    const branchId = Number(this.el.manualBranch?.value || 0);
    const rows = this.staffRows
      .filter(u => u.role === 'staff' && Number(u.branch_id) === branchId)
      .sort((a, b) => String(a.name || '').localeCompare(String(b.name || ''), 'id'));

    if (!branchId) {
      this.el.manualStaff.innerHTML = '<option value="">Pilih cabang dulu</option>';
      this.el.manualStaff.disabled = true;
      if (this.el.manualStaffHint) this.el.manualStaffHint.textContent = '';
      this.updateManualSubmitState();
      return;
    }

    this.el.manualStaff.disabled = !rows.length;
    this.el.manualStaff.innerHTML = rows.length
      ? '<option value="">Pilih Staff</option>' + rows.map(u => `<option value="${u.id}">${escHtml(u.name)}</option>`).join('')
      : '<option value="">Tidak ada staff di cabang ini</option>';
    if (this.el.manualStaffHint) {
      this.el.manualStaffHint.textContent = rows.length
        ? `${rows.length} staff aktif tersedia`
        : 'Tambahkan atau edit staff agar cabangnya sesuai.';
    }
    if (prefillStaffId && rows.some(u => String(u.id) === String(prefillStaffId))) {
      this.el.manualStaff.value = String(prefillStaffId);
    }
    this.updateManualSubmitState();
  },

  renderManualAccountOptions() {
    if (!this.el.manualAccount) return;
    const branchId = Number(this.el.manualBranch?.value || 0);

    if (this.accountsLoading) {
      this.el.manualAccount.innerHTML = '<option value="">Memuat metode setoran...</option>';
      this.el.manualAccount.disabled = true;
      if (this.el.manualAccountHint) this.el.manualAccountHint.textContent = 'Memuat daftar metode setoran aktif.';
      this.updateManualProofRequirement();
      this.updateManualSubmitState();
      return;
    }

    if (this.accountsLoadError) {
      this.el.manualAccount.innerHTML = '<option value="">Gagal memuat metode setoran</option>';
      this.el.manualAccount.disabled = true;
      if (this.el.manualAccountHint) this.el.manualAccountHint.textContent = this.accountsLoadError;
      this.updateManualProofRequirement();
      this.updateManualSubmitState();
      return;
    }

    const rows = this.accounts
      .filter(a => a.is_active !== false)
      .filter(a => !a.branch_id || Number(a.branch_id) === branchId)
      .sort((a, b) => String(a.label || '').localeCompare(String(b.label || ''), 'id'));

    if (!branchId) {
      this.el.manualAccount.innerHTML = '<option value="">Pilih cabang dulu</option>';
      this.el.manualAccount.disabled = true;
      if (this.el.manualAccountHint) this.el.manualAccountHint.textContent = '';
      this.updateManualProofRequirement();
      this.updateManualSubmitState();
      return;
    }

    this.el.manualAccount.disabled = !rows.length;
    this.el.manualAccount.innerHTML = rows.length
      ? '<option value="">Pilih metode setoran</option>' + rows.map(a => {
        const detail = this.getAccountDetail(a);
        const suffix = detail ? ` - ${detail}` : '';
        return `<option value="${a.id}">${escHtml(a.label)}${escHtml(suffix)}</option>`;
      }).join('')
      : '<option value="">Tidak ada metode setoran aktif</option>';
    if (this.el.manualAccountHint) {
      this.el.manualAccountHint.textContent = rows.length
        ? `${rows.length} metode aktif tersedia`
        : 'Tidak ada metode setoran aktif. Aktifkan atau tambahkan metode setoran terlebih dahulu.';
    }
    this.updateManualProofRequirement();
    this.updateManualSubmitState();
  },

  getSelectedManualAccount() {
    const accountId = this.el.manualAccount?.value || '';
    if (!accountId) return null;
    return this.accounts.find(a => String(a.id) === String(accountId)) || null;
  },

  isManualProofRequired() {
    const account = this.getSelectedManualAccount();
    if (!account) return true;
    return !depositService.isCashDepositMethod(account);
  },

  getManualProofHintText() {
    const account = this.getSelectedManualAccount();
    if (!account) return 'Pilih metode setoran terlebih dahulu.';
    return this.isManualProofRequired()
      ? 'JPG, PNG, atau PDF. Maksimal 5 MB.'
      : 'Opsional untuk setoran tunai/serah tunai.';
  },

  updateManualProofRequirement() {
    const required = this.isManualProofRequired();
    if (this.el.manualProofLabel) {
      this.el.manualProofLabel.textContent = required ? 'Bukti Setoran *' : 'Bukti Setoran (Opsional)';
    }
    if (this.el.manualProofHint && !this.selectedManualProofFile) {
      this.el.manualProofHint.textContent = this.getManualProofHintText();
    }
    this.el.manualProofZone?.classList.toggle('optional', !required);
    this.renderManualProofError();
  },

  renderManualProofError() {
    if (!this.el.manualProofError) return;
    const showError = Boolean(this.el.manualAccount?.value)
      && this.isManualProofRequired()
      && !this.selectedManualProofFile;
    this.el.manualProofError.textContent = showError ? 'Upload bukti setoran terlebih dahulu.' : '';
    this.el.manualProofError.classList.toggle('show', showError);
  },

  parseManualAmount() {
    const digits = String(this.el.manualAmount?.value || '').replace(/\D/g, '');
    return digits ? Number(digits) : 0;
  },

  formatManualAmountInput() {
    if (!this.el.manualAmount) return;
    const amount = this.parseManualAmount();
    this.el.manualAmount.value = amount > 0 ? amount.toLocaleString('id-ID') : '';
    this.updateManualSubmitState();
  },

  handleManualProofFiles(files) {
    const file = files && files[0];
    if (!file) {
      this.removeManualProofFile({ clearInput: false });
      return;
    }

    try {
      depositService.validateProofFile(file);
    } catch (e) {
      showToast(e.message || 'Bukti setoran tidak valid', 'error');
      this.removeManualProofFile();
      return;
    }

    this.removeManualProofObjectUrl();
    this.selectedManualProofFile = file;
    this.renderManualProofPreview(file);
    if (this.el.manualProofHint) {
      this.el.manualProofHint.textContent = this.isManualProofRequired()
        ? 'Bukti siap diupload saat setoran disimpan.'
        : 'Opsional untuk setoran tunai/serah tunai. File siap diupload.';
    }
    this.renderManualProofError();
    this.updateManualSubmitState();
  },

  renderManualProofPreview(file) {
    if (!this.el.manualProofPreview) return;
    if (this.el.manualProofEmpty) this.el.manualProofEmpty.style.display = 'none';
    this.el.manualProofPreview.style.display = '';

    const safeName = escHtml(file.name || 'Bukti setoran');
    const fileSize = this.formatFileSize(file.size);
    if (file.type === 'application/pdf' || safeName.toLowerCase().endsWith('.pdf')) {
      this.el.manualProofPreview.innerHTML = `
        <div class="deposit-preview-file">
          <i data-lucide="file-text" class="icon-lg"></i>
          <div>
            <strong>${safeName}</strong>
            <span>${fileSize}</span>
          </div>
          <button type="button" class="deposit-proof-remove" aria-label="Hapus bukti">
            <i data-lucide="x" class="icon-sm"></i>
          </button>
        </div>`;
    } else {
      this.selectedManualProofUrl = URL.createObjectURL(file);
      this.el.manualProofPreview.innerHTML = `
        <div class="deposit-preview-image">
          <img src="${this.selectedManualProofUrl}" alt="Preview bukti setoran" />
          <div class="deposit-preview-meta">
            <strong>${safeName}</strong>
            <span>${fileSize}</span>
          </div>
          <button type="button" class="deposit-proof-remove" aria-label="Hapus bukti">
            <i data-lucide="x" class="icon-sm"></i>
          </button>
        </div>`;
    }

    if (window.lucide) requestAnimationFrame(() => lucide.createIcons());
  },

  removeManualProofFile({ clearInput = true } = {}) {
    this.removeManualProofObjectUrl();
    this.selectedManualProofFile = null;
    if (clearInput && this.el.manualProofFile) this.el.manualProofFile.value = '';
    if (this.el.manualProofPreview) {
      this.el.manualProofPreview.innerHTML = '';
      this.el.manualProofPreview.style.display = 'none';
    }
    if (this.el.manualProofEmpty) this.el.manualProofEmpty.style.display = '';
    this.updateManualProofRequirement();
    this.updateManualSubmitState();
  },

  removeManualProofObjectUrl() {
    if (this.selectedManualProofUrl) {
      URL.revokeObjectURL(this.selectedManualProofUrl);
      this.selectedManualProofUrl = null;
    }
  },

  formatFileSize(size) {
    if (!size) return '0 KB';
    if (size >= 1024 * 1024) return `${(size / 1024 / 1024).toFixed(1)} MB`;
    return `${Math.ceil(size / 1024)} KB`;
  },

  updateManualSubmitState() {
    if (!this.el.saveManualBtn) return;
    const branchId = Number(this.el.manualBranch?.value || 0);
    const staffId = Number(this.el.manualStaff?.value || 0);
    const sessionId = this.manualSessionId;
    const accountId = this.el.manualAccount?.value || '';
    const amount = this.parseManualAmount();
    const proofRequired = this.isManualProofRequired();
    this.renderManualProofError();
    const disabled = this.isSavingManual
      || !branchId
      || !staffId
      || !sessionId
      || !accountId
      || amount <= 0
      || (proofRequired && !this.selectedManualProofFile);

    this.el.saveManualBtn.disabled = disabled;
  },

  async saveManualDeposit() {
    if (this.isSavingManual) return;

    const branchId = Number(this.el.manualBranch?.value || 0);
    const staffId = Number(this.el.manualStaff?.value || 0);
    const sessionId = this.manualSessionId;
    const accountId = this.el.manualAccount?.value || '';
    const amount = this.parseManualAmount();
    const notes = this.el.manualNotes?.value?.trim() || null;
    const account = this.accounts.find(a => String(a.id) === String(accountId));
    const proofRequired = account ? !depositService.isCashDepositMethod(account) : true;

    if (!branchId) { showToast('Cabang wajib dipilih', 'error'); return; }
    if (!staffId) { showToast('Staff wajib dipilih', 'error'); return; }
    if (!sessionId) { showToast('Pilih shift tertutup terlebih dahulu', 'error'); return; }
    if (!accountId) { showToast('Pilih metode setoran terlebih dahulu', 'error'); return; }
    if (proofRequired && !this.selectedManualProofFile) { showToast('Upload bukti setoran terlebih dahulu.', 'error'); return; }
    if (amount <= 0) { showToast('Jumlah setoran harus lebih dari 0', 'error'); return; }
    if (amount % 50000 !== 0) { showToast('Nominal harus kelipatan Rp 50.000', 'error'); return; }

    const staff = this.staffRows.find(u => Number(u.id) === staffId);
    const branch = this.branches.find(b => Number(b.id) === branchId);
    const ok = await showConfirm({
      title: 'Simpan Setoran Manual',
      message: `Simpan ${fRp(amount)} untuk ${staff?.name || 'staff'} di ${branch?.name || 'cabang'} melalui ${account?.label || 'metode setoran'} (Shift #${sessionId})?`,
      confirmText: 'Ya, Simpan'
    });
    if (!ok) return;

    this.isSavingManual = true;
    if (this.el.saveManualBtn) {
      this.el.saveManualBtn.disabled = true;
      this.el.saveManualBtn.innerHTML = this.selectedManualProofFile
        ? '<span class="btn-spinner"></span><span>Mengupload bukti...</span>'
        : '<span class="btn-spinner"></span><span>Menyimpan...</span>';
    }

    try {
      const adminId = auth.getSession()?.id || null;
      const depositId = await depositService.createManualDeposit({
        adminId,
        branchId,
        staffId,
        sessionId,
        accountId,
        amount,
        proofFile: this.selectedManualProofFile,
        method: account,
        notes
      });
      closeModal('modal-manual-deposit');
      if (this.el.branch) this.el.branch.value = String(branchId);
      if (this.el.status) this.el.status.value = '';
      this.removeManualProofFile();
      showToast(`Setoran manual tersimpan. Ref: ${String(depositId || '').slice(0, 8).toUpperCase()}`, 'success');
      await this.loadDeposits();
      if (window.RBNDataEvents) RBNDataEvents.publish('cash:changed', { source: 'admin-manual-deposit' });
      if (window.adminStaffCashUi) adminStaffCashUi.markDirty();
      if (window.adminBranchCashUi) adminBranchCashUi.markDirty();
    } catch (e) {
      console.error('saveManualDeposit', e);
      if (window.showDbError) showDbError(e, { action: 'menyimpan setoran manual', entity: 'Setoran manual' });
      else showToast(e.message || 'Gagal menyimpan setoran manual', 'error');
    } finally {
      this.isSavingManual = false;
      if (this.el.saveManualBtn) {
        this.el.saveManualBtn.innerHTML = '<i data-lucide="save" class="icon-sm"></i> Simpan Setoran';
        this.updateManualSubmitState();
        if (window.lucide) requestAnimationFrame(() => lucide.createIcons());
      }
    }
  },

  async doConfirm(depositId) {
    const ok = await showConfirm({
      title: 'Konfirmasi Setoran',
      message: 'Konfirmasi setoran ini? Setelah dikonfirmasi, kas akan berkurang.',
      confirmText: 'Ya, Konfirmasi'
    });
    if (!ok) return;
    try {
      const adminId = auth.getSession()?.id || null;
      await depositService.confirmDeposit({ depositId, adminId, action: 'confirmed' });
      showToast('Setoran berhasil dikonfirmasi', 'success');
      await this.loadDeposits();
      if (window.RBNDataEvents) RBNDataEvents.publish('cash:changed', { source: 'admin-deposit-confirm' });
      if (window.adminStaffCashUi) adminStaffCashUi.markDirty();
      if (window.adminBranchCashUi) adminBranchCashUi.markDirty();
    } catch (err) {
      console.error('doConfirm', err);
      this.showDepositActionError(err, {
        action: 'mengkonfirmasi setoran',
        fallback: 'Gagal konfirmasi'
      });
    }
  },

  async doReject(depositId) {
    const reason = await showPrompt({ title: 'Tolak Setoran', placeholder: 'Alasan penolakan (opsional)' });
    if (reason === null) return;
    try {
      const adminId = auth.getSession()?.id || null;
      await depositService.confirmDeposit({ depositId, adminId, action: 'rejected', rejectReason: reason || null });
      showToast('Setoran ditolak', 'success');
      await this.loadDeposits();
      if (window.RBNDataEvents) RBNDataEvents.publish('cash:changed', { source: 'admin-deposit-reject' });
      if (window.adminStaffCashUi) adminStaffCashUi.markDirty();
      if (window.adminBranchCashUi) adminBranchCashUi.markDirty();
    } catch (err) {
      console.error('doReject', err);
      this.showDepositActionError(err, {
        action: 'menolak setoran',
        fallback: 'Gagal menolak'
      });
    }
  },

  showDepositActionError(error, { action, fallback }) {
    const message = String(error?.message || '').trim();
    const code = String(error?.code || '');
    const dbSyntaxError = code === '22P02' || message.toLowerCase().includes('invalid input syntax');

    if (dbSyntaxError && window.showDbError) {
      showDbError(error, { action, entity: 'Setoran' });
      return;
    }

    showToast(message || fallback, 'error');
  },

  async loadAccounts() {
    this.accountsLoading = true;
    this.accountsLoadError = null;
    this.renderManualAccountOptions();

    try {
      const { data, error } = await db.from('deposit_accounts').select('*').order('created_at', { ascending: false });
      if (error) throw error;
      this.accounts = data || [];
      if (!this.el.accountsList) return;
      if (!this.accounts.length) {
        this.el.accountsList.innerHTML = '<div class="empty-state"><div class="empty-title">Belum ada metode setoran</div></div>';
        return;
      }
      this.el.accountsList.innerHTML = `
        <div class="card">
          <div class="table-wrap">
            <table>
              <thead>
                <tr><th>Label</th><th>Tipe</th><th>Bank</th><th>No. Rekening</th><th>Pemilik</th><th>Status</th><th>Aksi</th></tr>
              </thead>
              <tbody>${this.accounts.map(a => this.renderAccountRow(a)).join('')}</tbody>
            </table>
          </div>
        </div>
      `;
      this.el.accountsList.querySelectorAll('[data-action="edit-account"]').forEach(btn => btn.addEventListener('click', ev => this.openAccountModal(ev.currentTarget.dataset.id)));
      this.el.accountsList.querySelectorAll('[data-action="toggle-account"]').forEach(btn => btn.addEventListener('click', ev => this.toggleAccount(ev)));
    } catch (e) {
      console.error('loadAccounts', e);
      this.accountsLoadError = e.message || 'Gagal memuat metode setoran';
      if (this.el.accountsList) this.el.accountsList.innerHTML = `<div class="text-danger p-4">Gagal memuat metode setoran: ${escHtml(e.message || '')}</div>`;
    } finally {
      this.accountsLoading = false;
      this.renderManualAccountOptions();
    }
  },

  renderAccountRow(a) {
    const active = a.is_active
      ? '<span class="badge badge-success">Aktif</span>'
      : '<span class="badge badge-danger">Nonaktif</span>';
    return `<tr>
      <td class="fw-700">${escHtml(a.label)}</td>
      <td>${escHtml(a.type)}</td>
      <td>${escHtml(a.bank_name || '-')}</td>
      <td>${escHtml(a.account_number || '-')}</td>
      <td>${escHtml(a.account_holder || '-')}</td>
      <td>${active}</td>
      <td>
        <div class="flex gap-2">
          <button class="btn btn-outline btn-sm" data-action="edit-account" data-id="${a.id}">Edit</button>
          <button class="btn ${a.is_active ? 'btn-warning' : 'btn-success'} btn-sm" data-action="toggle-account" data-id="${a.id}">${a.is_active ? 'Nonaktifkan' : 'Aktifkan'}</button>
        </div>
      </td>
    </tr>`;
  },

  openAccountModal(id = null) {
    const row = id ? this.accounts.find(a => String(a.id) === String(id)) : null;
    this.selectedQrisFile = null;
    if (this.el.accountModalTitle) this.el.accountModalTitle.textContent = row ? 'Edit Metode Setoran' : 'Tambah Metode Setoran';
    if (this.el.accountId) this.el.accountId.value = row?.id || '';
    if (this.el.accountLabel) this.el.accountLabel.value = row?.label || '';
    if (this.el.accountType) this.el.accountType.value = row?.type || 'bank';
    if (this.el.bankName) this.el.bankName.value = row?.bank_name || '';
    if (this.el.accountNumber) this.el.accountNumber.value = row?.account_number || '';
    if (this.el.accountHolder) this.el.accountHolder.value = row?.account_holder || '';
    if (this.el.qrisImageUrl) this.el.qrisImageUrl.value = row?.qris_image_url || '';
    if (this.el.qrisFile) this.el.qrisFile.value = '';
    if (this.el.accountActive) this.el.accountActive.checked = row ? Boolean(row.is_active) : true;
    this.renderQrisPreview(row?.qris_image_url || '');
    this.toggleAccountTypeFields();
    openModal('modal-deposit-account');
  },

  toggleAccountTypeFields() {
    const type = this.el.accountType?.value || 'bank';
    if (this.el.bankFields) this.el.bankFields.style.display = type === 'bank' ? '' : 'none';
    if (this.el.qrisFields) this.el.qrisFields.style.display = type === 'qris' ? '' : 'none';
  },

  handleQrisFile(files) {
    const file = files && files[0];
    this.selectedQrisFile = null;
    if (!file) {
      this.renderQrisPreview(this.el.qrisImageUrl?.value || '');
      return;
    }
    const allowed = ['image/jpeg','image/png','image/webp'];
    if (!allowed.includes(file.type)) {
      showToast('Hanya JPG, PNG, atau WEBP yang diterima', 'error');
      if (this.el.qrisFile) this.el.qrisFile.value = '';
      this.renderQrisPreview(this.el.qrisImageUrl?.value || '');
      return;
    }
    if (file.size > 5 * 1024 * 1024) {
      showToast('Ukuran file maksimal 5 MB', 'error');
      if (this.el.qrisFile) this.el.qrisFile.value = '';
      this.renderQrisPreview(this.el.qrisImageUrl?.value || '');
      return;
    }
    this.selectedQrisFile = file;
    this.renderQrisPreview(URL.createObjectURL(file));
  },

  renderQrisPreview(url) {
    if (!this.el.qrisPreview) return;
    this.el.qrisPreview.innerHTML = url
      ? `<img src="${escHtml(url)}" alt="Preview QRIS" class="img-preview" style="max-width:160px;margin-top:8px">`
      : '';
  },

  async saveAccount() {
    const id = this.el.accountId?.value || null;
    const type = this.el.accountType?.value || '';
    const label = (this.el.accountLabel?.value || '').trim();
    const bankName = (this.el.bankName?.value || '').trim();
    const accountNumber = (this.el.accountNumber?.value || '').trim();
    const accountHolder = (this.el.accountHolder?.value || '').trim();
    let qrisImageUrl = (this.el.qrisImageUrl?.value || '').trim();
    const isActive = Boolean(this.el.accountActive?.checked);

    if (!label || !type) {
      showToast('Label dan tipe wajib diisi', 'error');
      return;
    }
    if (type === 'bank' && (!bankName || !accountNumber || !accountHolder)) {
      showToast('Nama bank, nomor rekening, dan pemilik rekening wajib diisi', 'error');
      return;
    }
    if (type === 'qris' && isActive && !qrisImageUrl && !this.selectedQrisFile) {
      showToast('Upload atau isi URL gambar QRIS terlebih dahulu.', 'error');
      return;
    }

    const prevText = this.el.saveAccountBtn?.textContent || 'Simpan';
    if (this.el.saveAccountBtn) {
      this.el.saveAccountBtn.disabled = true;
      this.el.saveAccountBtn.textContent = 'Menyimpan...';
    }
    try {
      if (type === 'qris' && this.selectedQrisFile) {
        qrisImageUrl = await depositService.uploadQrisImage(null, this.selectedQrisFile);
        if (this.el.qrisImageUrl) this.el.qrisImageUrl.value = qrisImageUrl || '';
        this.renderQrisPreview(qrisImageUrl);
      }
      await depositService.saveAccount({
        id,
        branchId: null,
        type,
        label,
        bankName: type === 'bank' ? bankName : null,
        accountNumber: type === 'bank' ? accountNumber : null,
        accountHolder: type === 'bank' ? accountHolder : null,
        qrisImageUrl: type === 'qris' ? qrisImageUrl : null,
        isActive
      });
      showToast('Metode setoran berhasil disimpan', 'success');
      closeModal('modal-deposit-account');
      await this.loadAccounts();
    } catch (e) {
      console.error('saveAccount', e);
      if (window.showDbError) showDbError(e, { action: 'menyimpan metode setoran', entity: 'Metode setoran' });
      else showToast('Gagal menyimpan metode setoran', 'error');
    } finally {
      if (this.el.saveAccountBtn) {
        this.el.saveAccountBtn.disabled = false;
        this.el.saveAccountBtn.textContent = prevText;
      }
    }
  },

  async toggleAccount(ev) {
    const id = ev.currentTarget.dataset.id;
    try {
      const { data } = await db.from('deposit_accounts').select('*').eq('id', id).maybeSingle();
      if (!data) throw new Error('Rekening tidak ditemukan');
      const next = !data.is_active;
      await depositService.saveAccount({
        id,
        branchId: null,
        type: data.type,
        label: data.label,
        bankName: data.bank_name,
        accountNumber: data.account_number,
        accountHolder: data.account_holder,
        qrisImageUrl: data.qris_image_url,
        isActive: next
      });
      showToast(next ? 'Akun diaktifkan' : 'Akun dinonaktifkan', 'success');
      await this.loadAccounts();
    } catch (e) {
      console.error('toggleAccount', e);
      if (window.showDbError) showDbError(e, { action: 'mengubah status rekening', entity: 'Rekening setoran' });
      else showToast('Gagal mengubah status rekening', 'error');
    }
  }
};

window.adminDepositUi = adminDepositUi;
adminDepositUi.init();
