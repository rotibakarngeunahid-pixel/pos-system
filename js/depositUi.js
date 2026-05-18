'use strict';

const DEPOSIT_STEP = 50000;
const DEPOSIT_MAX_FILE_SIZE = 5 * 1024 * 1024;
const DEPOSIT_ALLOWED_MIME = ['image/jpeg', 'image/png', 'application/pdf'];
const DEPOSIT_ALLOWED_EXT = ['jpg', 'jpeg', 'png', 'pdf'];

const depositUi = {
  el: {},
  accounts: [],
  eligibleSessions: [],
  selectedClosedSession: null,
  depositableCash: 0,
  selectedFile: null,
  selectedFileUrl: null,
  isSubmitting: false,
  readyRefreshTimer: null,
  clockTimer: null,
  accountLoadError: null,
  didBind: false,

  getPOS() {
    if (typeof window !== 'undefined' && window.POS) return window.POS;
    if (typeof POS !== 'undefined') return POS;
    return null;
  },

  hasEligibleClosedShift() {
    return this.selectedClosedSession !== null && this.selectedClosedSession.session_status === 'closed';
  },

  init() {
    const start = () => {
      try {
        this.bindElements();
        this.refreshWhenReady();
      } catch (e) {
        console.warn('depositUi.init error', e);
      }
    };
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', start);
    } else {
      start();
    }
  },

  bindElements() {
    if (this.didBind) return;
    this.didBind = true;

    this.el.panel = document.getElementById('panel-deposits');
    this.el.expectedCashEl = document.getElementById('deposit-expected-cash');
    this.el.amountInput = document.getElementById('deposit-amount');
    this.el.amountError = document.getElementById('deposit-amount-error');
    this.el.quickButtons = Array.from(document.querySelectorAll('[data-deposit-quick]'));
    this.el.accountSelect = document.getElementById('deposit-account-select');
    this.el.accountOptions = document.getElementById('deposit-account-options');
    this.el.accountEmpty = document.getElementById('deposit-account-empty');
    this.el.fileInput = document.getElementById('deposit-proof-file');
    this.el.proofZone = document.getElementById('deposit-proof-zone');
    this.el.uploadEmpty = document.getElementById('deposit-upload-empty');
    this.el.filePreview = document.getElementById('deposit-proof-preview');
    this.el.proofHint = document.getElementById('deposit-proof-hint');
    this.el.notesInput = document.getElementById('deposit-notes');
    this.el.submitBtn = document.getElementById('btn-submit-deposit');
    this.el.historyBody = document.getElementById('deposit-history-body');
    this.el.infoNoCash = document.getElementById('deposit-no-cash');
    this.el.success = document.getElementById('deposit-success');
    this.el.summaryShift = document.getElementById('deposit-summary-shift');
    this.el.summaryStaff = document.getElementById('deposit-summary-staff');
    this.el.summaryTime = document.getElementById('deposit-summary-time');
    this.el.headerShift = document.getElementById('deposit-header-shift');
    this.el.cashCard = document.getElementById('deposit-cash-card');

    if (this.el.amountInput) this.el.amountInput.addEventListener('input', () => this.onAmountInput());
    this.el.quickButtons.forEach(btn => {
      btn.addEventListener('click', () => this.setQuickAmount(btn.dataset.depositQuick));
    });
    if (this.el.accountOptions) {
      this.el.accountOptions.addEventListener('click', e => {
        const card = e.target.closest('[data-deposit-account-id]');
        if (card) this.selectAccount(card.dataset.depositAccountId);
      });
      this.el.accountOptions.addEventListener('keydown', e => {
        if (e.key !== 'Enter' && e.key !== ' ') return;
        const card = e.target.closest('[data-deposit-account-id]');
        if (!card) return;
        e.preventDefault();
        this.selectAccount(card.dataset.depositAccountId);
      });
    }
    if (this.el.fileInput) this.el.fileInput.addEventListener('change', e => this.onFileChange(e.target.files));
    this.bindUploadZone();
    if (this.el.submitBtn) this.el.submitBtn.addEventListener('click', () => this.onSubmit());

    this.startClock();
  },

  bindUploadZone() {
    const zone = this.el.proofZone;
    if (!zone) return;
    zone.addEventListener('click', e => {
      if (e.target.closest('.deposit-proof-remove')) {
        this.removeFile();
        return;
      }
      if (e.target.closest('a')) return;
      this.el.fileInput?.click();
    });
    zone.addEventListener('keydown', e => {
      if (e.key !== 'Enter' && e.key !== ' ') return;
      if (e.target.closest('.deposit-proof-remove')) return;
      e.preventDefault();
      this.el.fileInput?.click();
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
      this.onFileChange(e.dataTransfer?.files);
    });
  },

  refreshWhenReady(attempt = 0, opts = {}) {
    const pos = this.getPOS();
    if (pos?.user && pos?.branch) {
      this.refresh(opts);
      return;
    }
    if (attempt >= 40) return;
    clearTimeout(this.readyRefreshTimer);
    this.readyRefreshTimer = setTimeout(() => this.refreshWhenReady(attempt + 1, opts), 250);
  },

  async refresh({ preferSessionId = null } = {}) {
    const pos = this.getPOS();
    if (!pos?.branch) return;

    const branchId = pos.branch.id;
    const staffId = pos.user?.id;
    this.accountLoadError = null;
    this.renderAccountLoading();

    // Load eligible closed sessions dari RPC
    try {
      this.eligibleSessions = await depositService.getEligibleSessions({ branchId, staffId });
    } catch (e) {
      console.warn('depositUi.refresh getEligibleSessions failed', e);
      this.eligibleSessions = [];
    }

    // Pilih session: preferSessionId (dari close shift) atau yang terbaru
    const preferred = preferSessionId
      ? this.eligibleSessions.find(s => s.session_id === preferSessionId)
      : null;
    this.selectedClosedSession = preferred || this.eligibleSessions[0] || null;
    this.depositableCash = this.selectedClosedSession
      ? Number(this.selectedClosedSession.depositable_cash || 0)
      : 0;

    this.updateSummaryCard();

    try {
      this.accounts = await depositService.getAccounts({ branchId });
    } catch (e) {
      console.error('getAccounts', e);
      this.accountLoadError = e.message || 'Gagal memuat metode setoran';
      if (typeof showToast === 'function') showToast(this.accountLoadError, 'error');
      this.accounts = [];
    }
    this.renderAccounts();
    this.updateSummaryCard();
    this.updateSubmitState();

    try {
      const rows = await depositService.getMyDeposits({
        staffId,
        branchId,
        daysBack: 7
      });
      this.renderHistory(rows);
    } catch (e) {
      console.error('getMyDeposits', e);
      if (typeof showToast === 'function') showToast('Gagal memuat riwayat setoran', 'error');
    }
  },

  startClock() {
    this.updateClock();
    clearInterval(this.clockTimer);
    this.clockTimer = setInterval(() => this.updateClock(), 30000);
  },

  updateClock() {
    const text = this.formatDateTime(new Date().toISOString());
    if (this.el.summaryTime) this.el.summaryTime.textContent = text;
  },

  updateSummaryCard() {
    const pos = this.getPOS();
    const sess = this.selectedClosedSession;
    const hasEligible = this.hasEligibleClosedShift();
    const staffLabel = pos?.user?.name || '-';

    // Label shift
    const shiftLabel = sess
      ? `Shift #${sess.session_id} (Tertutup)`
      : 'Belum ada shift tertutup';

    const cardLabel = document.getElementById('deposit-card-label');
    if (cardLabel) cardLabel.textContent = hasEligible ? 'Kas Final Shift' : 'Menunggu Shift Ditutup';

    if (this.el.expectedCashEl) {
      this.el.expectedCashEl.textContent = hasEligible ? fRp(this.depositableCash) : '—';
    }
    if (this.el.summaryShift) this.el.summaryShift.textContent = shiftLabel;
    if (this.el.summaryStaff) this.el.summaryStaff.textContent = staffLabel;

    if (this.el.headerShift) {
      this.el.headerShift.textContent = hasEligible
        ? shiftLabel
        : 'Belum ada shift tertutup yang bisa disetor';
    }

    // Blocking state info
    if (this.el.infoNoCash) {
      const pos = this.getPOS();
      const hasOpenShift = Boolean(pos?.session?.id);
      if (!hasEligible && hasOpenShift) {
        this.el.infoNoCash.textContent = 'Tutup shift terlebih dahulu sebelum setoran tunai';
        this.el.infoNoCash.style.display = '';
      } else if (!hasEligible) {
        this.el.infoNoCash.textContent = 'Belum ada shift tertutup untuk disetor';
        this.el.infoNoCash.style.display = '';
      } else if (sess?.block_reason) {
        this.el.infoNoCash.textContent = sess.block_reason;
        this.el.infoNoCash.style.display = '';
      } else if (hasEligible && this.depositableCash <= 0) {
        this.el.infoNoCash.textContent = 'Tidak ada kas yang dapat disetor pada shift ini';
        this.el.infoNoCash.style.display = '';
      } else {
        this.el.infoNoCash.style.display = 'none';
      }
    }

    const noCash = hasEligible && this.depositableCash <= 0;
    if (this.el.panel)    this.el.panel.classList.toggle('no-cash', noCash);
    if (this.el.cashCard) {
      this.el.cashCard.classList.toggle('no-cash', noCash);
      this.el.cashCard.classList.toggle('no-session', !hasEligible);
    }
    this.updateClock();
  },

  renderAccountLoading() {
    if (this.el.accountOptions) {
      this.el.accountOptions.innerHTML = `
        <div class="deposit-method-loading">
          <span></span><span></span><span></span><span></span>
        </div>`;
    }
    if (this.el.accountEmpty) this.el.accountEmpty.style.display = 'none';
    if (this.el.accountSelect) this.el.accountSelect.value = '';
  },

  renderAccounts() {
    if (!this.el.accountOptions || !this.el.accountSelect) return;

    if (this.accountLoadError) {
      this.el.accountOptions.innerHTML = '';
      this.el.accountSelect.value = '';
      if (this.el.accountEmpty) {
        this.el.accountEmpty.textContent = `Gagal memuat metode setoran: ${this.accountLoadError}`;
        this.el.accountEmpty.style.display = '';
      }
      this.updateSubmitState();
      return;
    }

    const accounts = this.sortAccounts(this.accounts);
    if (!accounts.length) {
      this.el.accountOptions.innerHTML = '';
      this.el.accountSelect.value = '';
      if (this.el.accountEmpty) {
        this.el.accountEmpty.textContent = 'Belum ada metode setoran aktif. Hubungi admin.';
        this.el.accountEmpty.style.display = '';
      }
      this.updateSubmitState();
      return;
    }

    if (this.el.accountEmpty) this.el.accountEmpty.style.display = 'none';

    const currentId = this.el.accountSelect.value;
    const lastId = this.getLastAccountId();
    const selectedId = accounts.some(a => String(a.id) === String(currentId))
      ? currentId
      : (accounts.some(a => String(a.id) === String(lastId)) ? lastId : '');
    this.el.accountSelect.value = selectedId;

    this.el.accountOptions.innerHTML = accounts.map(account => {
      const id = this.esc(account.id);
      const checked = String(account.id) === String(selectedId);
      const label = this.esc(account.label || 'Metode Setoran');
      const detail = this.esc(this.getAccountDetail(account));
      const icon = this.getAccountIcon(account);
      return `
        <label class="deposit-method-card ${checked ? 'selected' : ''}"
          data-deposit-account-id="${id}"
          role="radio"
          tabindex="0"
          aria-checked="${checked ? 'true' : 'false'}">
          <input type="radio" name="deposit-method" value="${id}" ${checked ? 'checked' : ''} tabindex="-1" />
          <span class="deposit-method-icon"><i data-lucide="${icon}" class="icon-sm"></i></span>
          <span class="deposit-method-copy">
            <strong>${label}</strong>
            <small>${detail}</small>
          </span>
        </label>`;
    }).join('');

    this.updateMethodDependentFields();
    this.updateSubmitState();
    if (window.lucide) window.requestAnimationFrame(() => lucide.createIcons());
  },

  sortAccounts(accounts) {
    return this.dedupeAccounts(accounts).sort((a, b) => {
      const rankA = this.accountRank(a);
      const rankB = this.accountRank(b);
      if (rankA !== rankB) return rankA - rankB;
      return String(a.label || '').localeCompare(String(b.label || ''), 'id');
    });
  },

  dedupeAccounts(accounts) {
    const seen = new Set();
    const output = [];
    (accounts || []).forEach(account => {
      const key = `${account?.type || ''}:${String(account?.label || '').trim().toLowerCase()}`;
      if (seen.has(key)) return;
      seen.add(key);
      output.push(account);
    });
    return output;
  },

  accountRank(account) {
    const raw = `${account?.label || ''} ${account?.bank_name || ''}`.toLowerCase();
    if (raw.includes('bca')) return 1;
    if (raw.includes('bni')) return 2;
    if (raw.includes('bri')) return 3;
    if (account?.type === 'cash' || raw.includes('manager')) return 4;
    if (account?.type === 'qris') return 5;
    return 9;
  },

  selectAccount(id, { persist = true } = {}) {
    if (!this.el.accountSelect) return;
    this.el.accountSelect.value = id || '';
    this.el.accountOptions?.querySelectorAll('[data-deposit-account-id]').forEach(card => {
      const checked = String(card.dataset.depositAccountId) === String(id);
      card.classList.toggle('selected', checked);
      card.setAttribute('aria-checked', checked ? 'true' : 'false');
      const input = card.querySelector('input[type="radio"]');
      if (input) input.checked = checked;
    });
    if (persist && id) this.setLastAccountId(id);
    this.updateMethodDependentFields();
    this.updateSubmitState();
  },

  updateMethodDependentFields() {
    const account = this.getSelectedAccount();
    if (this.el.proofHint) {
      if (!account) {
        this.el.proofHint.textContent = 'Pilih metode setoran terlebih dahulu.';
      } else if (account.type === 'cash') {
        this.el.proofHint.textContent = 'Bukti opsional untuk penyerahan tunai langsung.';
      } else if (account.type === 'qris') {
        this.el.proofHint.textContent = 'Bukti wajib untuk pembayaran QRIS.';
      } else {
        this.el.proofHint.textContent = 'Bukti wajib untuk transfer bank.';
      }
    }
    this.el.proofZone?.classList.toggle('optional', !this.isProofRequired(account));
  },

  getSelectedAccount() {
    const id = this.el.accountSelect?.value;
    return this.accounts.find(a => String(a.id) === String(id)) || null;
  },

  isProofRequired(account = this.getSelectedAccount()) {
    if (!account) return true;
    return account.type !== 'cash';
  },

  getAccountIcon(account) {
    if (account?.type === 'cash') return 'hand-coins';
    if (account?.type === 'qris') return 'qr-code';
    return 'landmark';
  },

  getAccountDetail(account) {
    if (!account) return '';
    if (account.type === 'cash') return 'Serahkan langsung ke manager';
    const parts = [account.bank_name, account.account_number].filter(Boolean);
    if (parts.length) return parts.join(' - ');
    if (account.type === 'qris') return 'Scan atau unggah bukti QRIS';
    return 'Transfer bank';
  },

  getLastAccountKey() {
    const pos = this.getPOS();
    return `rbn.deposit.lastAccountId.${pos?.branch?.id || 'global'}.${pos?.user?.id || 'staff'}`;
  },

  getLastAccountId() {
    try {
      return localStorage.getItem(this.getLastAccountKey()) || '';
    } catch (e) {
      return '';
    }
  },

  setLastAccountId(id) {
    try {
      localStorage.setItem(this.getLastAccountKey(), id);
    } catch (e) {
      // Ignore private browsing storage errors.
    }
  },

  onAmountInput() {
    const amount = this.parseAmountInput(this.el.amountInput?.value || '');
    this.setAmountInput(amount, { validate: false });
    this.updateSubmitState();
  },

  setQuickAmount(value) {
    if (this.isSubmitting) return;
    const amount = value === 'all' ? this.depositableCash : Number(value || 0);
    this.setAmountInput(amount);
  },

  setAmountInput(amount, { validate = true } = {}) {
    if (!this.el.amountInput) return;
    const numeric = Number(amount || 0);
    this.el.amountInput.value = numeric > 0 ? numeric.toLocaleString('id-ID') : '';
    if (validate) this.updateSubmitState();
  },

  parseAmountInput(value) {
    const digits = String(value || '').replace(/\D/g, '');
    return digits ? Number(digits) : 0;
  },

  validateAmount({ showEmpty = false } = {}) {
    const amount = this.parseAmountInput(this.el.amountInput?.value || '');
    let message = '';

    if (amount <= 0) {
      message = showEmpty ? 'Jumlah setoran harus lebih dari 0' : '';
    } else if (this.hasEligibleClosedShift() && amount > this.depositableCash) {
      message = `Melebihi kas yang dapat disetor (${fRp(this.depositableCash)})`;
    } else if (amount % DEPOSIT_STEP !== 0) {
      message = 'Nominal harus kelipatan Rp 50.000';
    }

    if (this.el.amountError) {
      this.el.amountError.textContent = message;
      this.el.amountError.classList.toggle('show', Boolean(message));
    }
    this.el.amountInput?.classList.toggle('error', Boolean(message));
    this.el.amountInput?.closest('.deposit-currency-field')?.classList.toggle('error', Boolean(message));
    return { amount, valid: amount > 0 && !message };
  },

  updateSubmitState() {
    const { valid } = this.validateAmount();
    const account = this.getSelectedAccount();
    const proofOk = !this.isProofRequired(account) || Boolean(this.selectedFile);
    const hasEligible = this.hasEligibleClosedShift();
    const sess = this.selectedClosedSession;
    // Disable jika tidak ada shift closed, ada deposit aktif, atau kas 0
    const blocked = !hasEligible || Boolean(sess?.block_reason) || this.depositableCash <= 0;
    const disabled = this.isSubmitting || blocked || !valid || !account || !proofOk;
    if (this.el.submitBtn) this.el.submitBtn.disabled = disabled;
    this.el.quickButtons.forEach(btn => {
      btn.disabled = this.isSubmitting || !hasEligible || this.depositableCash <= 0;
    });
  },

  onFileChange(files) {
    const file = files && files[0];
    if (!file) {
      this.removeFile({ clearInput: false });
      return;
    }

    const ext = (file.name || '').split('.').pop().toLowerCase();
    if (file.size <= 0) {
      this.rejectFile('File tidak boleh kosong');
      return;
    }
    if (file.size > DEPOSIT_MAX_FILE_SIZE) {
      this.rejectFile('Ukuran file maksimal 5 MB');
      return;
    }
    if (!DEPOSIT_ALLOWED_MIME.includes(file.type) && !DEPOSIT_ALLOWED_EXT.includes(ext)) {
      this.rejectFile('Hanya JPG, PNG, atau PDF yang diterima');
      return;
    }

    this.removeObjectUrl();
    this.selectedFile = file;
    this.renderFilePreview(file);
    this.updateSubmitState();
  },

  rejectFile(message) {
    if (typeof showToast === 'function') showToast(message, 'error');
    this.removeFile();
  },

  renderFilePreview(file) {
    if (!this.el.filePreview) return;
    if (this.el.uploadEmpty) this.el.uploadEmpty.style.display = 'none';
    this.el.filePreview.style.display = '';

    const safeName = this.esc(file.name || 'Bukti setoran');
    if (file.type === 'application/pdf' || safeName.toLowerCase().endsWith('.pdf')) {
      this.el.filePreview.innerHTML = `
        <div class="deposit-preview-file">
          <i data-lucide="file-text" class="icon-lg"></i>
          <div>
            <strong>${safeName}</strong>
            <span>${this.formatFileSize(file.size)}</span>
          </div>
          <button type="button" class="deposit-proof-remove" aria-label="Hapus bukti">
            <i data-lucide="x" class="icon-sm"></i>
          </button>
        </div>`;
    } else {
      this.selectedFileUrl = URL.createObjectURL(file);
      this.el.filePreview.innerHTML = `
        <div class="deposit-preview-image">
          <img src="${this.selectedFileUrl}" alt="Preview bukti setoran" />
          <div class="deposit-preview-meta">
            <strong>${safeName}</strong>
            <span>${this.formatFileSize(file.size)}</span>
          </div>
          <button type="button" class="deposit-proof-remove" aria-label="Hapus bukti">
            <i data-lucide="x" class="icon-sm"></i>
          </button>
        </div>`;
    }
    if (window.lucide) window.requestAnimationFrame(() => lucide.createIcons());
  },

  removeFile({ clearInput = true } = {}) {
    this.removeObjectUrl();
    this.selectedFile = null;
    if (clearInput && this.el.fileInput) this.el.fileInput.value = '';
    if (this.el.filePreview) {
      this.el.filePreview.innerHTML = '';
      this.el.filePreview.style.display = 'none';
    }
    if (this.el.uploadEmpty) this.el.uploadEmpty.style.display = '';
    this.updateSubmitState();
  },

  removeObjectUrl() {
    if (this.selectedFileUrl) {
      URL.revokeObjectURL(this.selectedFileUrl);
      this.selectedFileUrl = null;
    }
  },

  async onSubmit() {
    const pos = this.getPOS();
    if (!pos?.branch) {
      if (typeof showToast === 'function') showToast('Cabang belum dipilih', 'error');
      return;
    }

    if (!this.hasEligibleClosedShift()) {
      const hasOpenShift = Boolean(pos?.session?.id);
      const msg = hasOpenShift
        ? 'Tutup shift terlebih dahulu sebelum setoran tunai'
        : 'Belum ada shift tertutup untuk disetor';
      if (typeof showToast === 'function') showToast(msg, 'error');
      return;
    }

    const sess = this.selectedClosedSession;
    if (sess?.block_reason) {
      if (typeof showToast === 'function') showToast(sess.block_reason, 'error');
      return;
    }

    const { amount, valid } = this.validateAmount({ showEmpty: true });
    if (!valid) {
      if (typeof showToast === 'function') showToast(this.el.amountError?.textContent || 'Nominal setoran tidak valid', 'error');
      return;
    }

    const account = this.getSelectedAccount();
    if (!account) {
      if (typeof showToast === 'function') showToast('Pilih metode setoran', 'error');
      return;
    }
    const proofRequired = this.isProofRequired(account);
    if (proofRequired && !this.selectedFile) {
      if (typeof showToast === 'function') showToast('Bukti setoran wajib dilampirkan untuk transfer bank', 'error');
      return;
    }

    const ok = await this.showDepositConfirm({ amount, account });
    if (!ok) return;

    this.isSubmitting = true;
    this.renderSubmitting(true);

    try {
      const depositId = await depositService.submitDeposit({
        branchId: pos.branch.id,
        sessionId: sess.session_id,
        staffId: pos.user.id,
        accountId: account.id,
        amount,
        cashBalance: this.depositableCash,
        file: this.selectedFile,
        notes: this.composeNotes(),
        requireProof: proofRequired
      });
      this.setLastAccountId(account.id);
      this.clearForm({ keepAccount: true });
      await this.refresh();
      this.showSuccess(depositId);
    } catch (e) {
      console.error('submitDeposit', e);
      if (typeof showToast === 'function') showToast(e.message || 'Gagal mengirim setoran', 'error');
    } finally {
      this.isSubmitting = false;
      this.renderSubmitting(false);
    }
  },

  composeNotes() {
    const notes = this.el.notesInput?.value?.trim() || '';
    return notes || null;
  },

  renderSubmitting(isSubmitting) {
    this.updateSubmitState();
    if (!this.el.submitBtn) return;
    this.el.submitBtn.classList.toggle('loading', isSubmitting);
    this.el.submitBtn.innerHTML = isSubmitting
      ? '<span class="btn-spinner"></span><span>Mengirim...</span>'
      : '<i data-lucide="send" class="icon-sm"></i><span>Setor Sekarang</span>';
    if (window.lucide && !isSubmitting) window.requestAnimationFrame(() => lucide.createIcons());
  },

  showSuccess(depositId) {
    const ref = depositId ? String(depositId).slice(0, 8).toUpperCase() : '-';
    if (this.el.success) {
      this.el.success.style.display = '';
      this.el.success.innerHTML = `
        <i data-lucide="check-circle-2" class="icon-lg"></i>
        <div>
          <strong>Setoran berhasil dikirim</strong>
          <span>No. referensi setoran: ${this.esc(ref)}</span>
        </div>`;
      setTimeout(() => {
        if (this.el.success) this.el.success.style.display = 'none';
      }, 7000);
    }
    if (typeof showToast === 'function') showToast(`Setoran berhasil dikirim. Ref: ${ref}`, 'success');
    if (window.lucide) window.requestAnimationFrame(() => lucide.createIcons());
  },

  showDepositConfirm({ amount, account }) {
    return new Promise(resolve => {
      const sess = this.selectedClosedSession;
      const remaining = this.depositableCash - amount;
      const kasRows = sess ? `
        <div><span>Shift</span><strong>${this.esc(`#${sess.session_id}`)}</strong></div>
        <div><span>Kas Dapat Disetor</span><strong>${this.esc(fRp(this.depositableCash))}</strong></div>
        <div><span>Sisa Kas Setelah Setor</span><strong class="${remaining < 0 ? 'text-danger' : ''}">${this.esc(fRp(remaining))}</strong></div>` : `
        <div><span>Kas</span><strong>—</strong></div>`;
      const overlay = document.createElement('div');
      overlay.className = 'deposit-confirm-overlay';
      overlay.innerHTML = `
        <div class="deposit-confirm-modal" role="dialog" aria-modal="true" aria-labelledby="deposit-confirm-title">
          <div class="deposit-confirm-header">
            <div>
              <div class="deposit-confirm-kicker">Konfirmasi Setoran</div>
              <h3 id="deposit-confirm-title">Periksa data sebelum dikirim</h3>
            </div>
            <button type="button" class="deposit-confirm-close" aria-label="Batalkan">
              <i data-lucide="x" class="icon-sm"></i>
            </button>
          </div>
          <div class="deposit-confirm-body">
            <div class="deposit-confirm-amount">${this.esc(fRp(amount))}</div>
            <div class="deposit-confirm-summary">
              <div><span>Metode</span><strong>${this.esc(account.label || '-')}</strong></div>
              ${kasRows}
              <div><span>Waktu</span><strong>${this.esc(this.formatDateTime(new Date().toISOString()))}</strong></div>
            </div>
          </div>
          <div class="deposit-confirm-footer">
            <button type="button" class="btn btn-outline deposit-confirm-cancel">Batalkan</button>
            <button type="button" class="btn btn-primary deposit-confirm-ok">Konfirmasi Setoran</button>
          </div>
        </div>`;
      document.body.appendChild(overlay);
      requestAnimationFrame(() => overlay.classList.add('active'));
      if (window.lucide) window.requestAnimationFrame(() => lucide.createIcons());

      const ac = new AbortController();
      const close = result => {
        ac.abort();
        overlay.classList.remove('active');
        setTimeout(() => overlay.remove(), 180);
        resolve(result);
      };

      overlay.querySelector('.deposit-confirm-ok')?.addEventListener('click', () => close(true), { signal: ac.signal });
      overlay.querySelector('.deposit-confirm-cancel')?.addEventListener('click', () => close(false), { signal: ac.signal });
      overlay.querySelector('.deposit-confirm-close')?.addEventListener('click', () => close(false), { signal: ac.signal });
      overlay.addEventListener('click', e => {
        if (e.target === overlay) close(false);
      }, { signal: ac.signal });
      document.addEventListener('keydown', e => {
        if (e.key === 'Escape') close(false);
      }, { signal: ac.signal });
      setTimeout(() => overlay.querySelector('.deposit-confirm-ok')?.focus(), 80);
    });
  },

  clearForm({ keepAccount = false } = {}) {
    if (this.el.amountInput) this.el.amountInput.value = '';
    if (!keepAccount && this.el.accountSelect) this.selectAccount('', { persist: false });
    if (this.el.notesInput) this.el.notesInput.value = '';
    this.removeFile();
    this.updateSubmitState();
  },

  renderHistory(rows) {
    if (!this.el.historyBody) return;
    if (!rows || !rows.length) {
      this.el.historyBody.innerHTML = `
        <div class="deposit-history-empty">
          <div class="deposit-history-empty-icon"><i data-lucide="receipt-text" class="icon-lg"></i></div>
          <strong>Belum ada setoran hari ini.</strong>
          <span>Lakukan setoran pertama Anda.</span>
        </div>`;
      if (window.lucide) window.requestAnimationFrame(() => lucide.createIcons());
      return;
    }

    this.el.historyBody.innerHTML = rows.map(row => {
      const status = this.getStatusMeta(row.status);
      const method = row.deposit_account_name_snapshot
        || row.deposit_accounts?.label
        || 'Metode lama/tidak tersedia';
      const proof = row.proof_url
        ? `<a href="${this.esc(row.proof_url)}" target="_blank" rel="noopener">${this.esc(row.proof_file_name || 'Lihat bukti')}</a>`
        : '<span class="text-muted">Bukti belum tersedia</span>';
      const rejectRow = row.status === 'rejected' && row.reject_reason
        ? `<div><span>Alasan Penolakan</span><strong class="text-danger">${this.esc(row.reject_reason)}</strong></div>`
        : '';
      return `
        <details class="deposit-history-card">
          <summary class="deposit-history-summary">
            <div class="deposit-history-main">
              <strong>${this.esc(fRp(row.amount))}</strong>
              <span>${this.esc(method)} &mdash; ${this.esc(this.formatDateTime(row.created_at))}</span>
            </div>
            <span class="badge ${status.className}">${this.esc(status.label)}</span>
          </summary>
          <div class="deposit-history-detail">
            <div><span>Waktu</span><strong>${this.esc(this.formatDateTime(row.created_at))}</strong></div>
            <div><span>Metode</span><strong>${this.esc(method)}</strong></div>
            <div><span>Bukti</span><strong>${proof}</strong></div>
            <div><span>Catatan</span><strong>${this.esc(row.notes || '-')}</strong></div>
            ${rejectRow}
          </div>
        </details>`;
    }).join('');
  },

  getStatusMeta(status) {
    if (status === 'confirmed') return { label: 'Berhasil', className: 'badge-success' };
    if (status === 'rejected') return { label: 'Gagal', className: 'badge-danger' };
    return { label: 'Diproses', className: 'badge-warning' };
  },

  formatDateTime(iso) {
    if (!iso) return '-';
    if (typeof fDate === 'function') return fDate(iso);
    const d = new Date(iso);
    return d.toLocaleDateString('id-ID', { day: '2-digit', month: 'short', year: 'numeric' })
      + ' ' + d.toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' });
  },

  formatFileSize(size) {
    if (!size) return '0 KB';
    if (size >= 1024 * 1024) return `${(size / 1024 / 1024).toFixed(1)} MB`;
    return `${Math.ceil(size / 1024)} KB`;
  },

  esc(value) {
    if (typeof escHtml === 'function') return escHtml(value);
    return String(value ?? '').replace(/[&<>"']/g, ch => ({
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;'
    }[ch]));
  }
};

window.depositUi = depositUi;
depositUi.init();
