'use strict';

const DEPOSIT_STEP = 50000;

const depositUi = {
  el: {},
  accounts: [],
  expectedCash: 0,
  selectedFile: null,
  isSubmitting: false,

  init() {
    document.addEventListener('DOMContentLoaded', () => {
      try {
        this.bindElements();
        // If POS already initialized, refresh when user/session ready
        if (window.POS && POS.user && POS.branch) this.refresh();
      } catch (e) {
        console.warn('depositUi.init error', e);
      }
    });
  },

  bindElements() {
    this.el.panel = document.getElementById('panel-deposits');
    this.el.expectedCashEl = document.getElementById('deposit-expected-cash');
    this.el.amountInput = document.getElementById('deposit-amount');
    this.el.amountError = document.getElementById('deposit-amount-error');
    this.el.amountDecBtn = document.getElementById('deposit-amount-dec');
    this.el.amountIncBtn = document.getElementById('deposit-amount-inc');
    this.el.accountSelect = document.getElementById('deposit-account-select');
    this.el.accountEmpty = document.getElementById('deposit-account-empty');
    this.el.fileInput = document.getElementById('deposit-proof-file');
    this.el.filePreview = document.getElementById('deposit-proof-preview');
    this.el.notesInput = document.getElementById('deposit-notes');
    this.el.submitBtn = document.getElementById('btn-submit-deposit');
    this.el.historyBody = document.getElementById('deposit-history-body');
    this.el.infoNoCash = document.getElementById('deposit-no-cash');

    if (this.el.fileInput) this.el.fileInput.addEventListener('change', e => this.onFileChange(e.target.files));
    if (this.el.amountInput) this.el.amountInput.addEventListener('input', () => this.updateSubmitState());
    if (this.el.amountDecBtn) this.el.amountDecBtn.addEventListener('click', () => this.changeAmount(-DEPOSIT_STEP));
    if (this.el.amountIncBtn) this.el.amountIncBtn.addEventListener('click', () => this.changeAmount(DEPOSIT_STEP));
    if (this.el.accountSelect) this.el.accountSelect.addEventListener('change', () => this.updateSubmitState());
    if (this.el.submitBtn) this.el.submitBtn.addEventListener('click', () => this.onSubmit());
    const refreshBtn = document.getElementById('deposit-refresh-btn');
    if (refreshBtn) refreshBtn.addEventListener('click', () => this.refresh());
  },

  async refresh() {
    if (!window.POS || !POS.branch) return;
    const branchId = POS.branch.id;
    const sessionId = POS.session?.id || null;
    try {
      this.accounts = await depositService.getAccounts(branchId);
    } catch (e) {
      console.error('getAccounts', e);
      showToast('Gagal memuat metode setoran', 'error');
      this.accounts = [];
    }
    this.renderAccounts();

    try {
      const summary = await cashService.getSummary({ branchId, sessionId });
      this.expectedCash = summary?.expectedCash || 0;
    } catch (e) {
      this.expectedCash = 0;
    }
    if (this.el.expectedCashEl) this.el.expectedCashEl.textContent = fRp(this.expectedCash);
    if (this.el.amountInput) this.el.amountInput.max = String(this.expectedCash || '');
    if (this.expectedCash <= 0) {
      if (this.el.infoNoCash) this.el.infoNoCash.style.display = '';
      if (this.el.panel) this.el.panel.classList.add('no-cash');
    } else {
      if (this.el.infoNoCash) this.el.infoNoCash.style.display = 'none';
      if (this.el.panel) this.el.panel.classList.remove('no-cash');
    }
    this.updateSubmitState();

    // load history
    try {
      const rows = await depositService.getMyDeposits({ staffId: POS.user.id, branchId });
      this.renderHistory(rows);
    } catch (e) {
      console.error('getMyDeposits', e);
      showToast('Gagal memuat riwayat setoran', 'error');
    }
  },

  renderAccounts() {
    if (!this.el.accountSelect) return;
    if (!this.accounts.length) {
      this.el.accountSelect.innerHTML = '<option value="">Tidak ada metode aktif</option>';
      this.el.accountSelect.disabled = true;
      if (this.el.accountEmpty) this.el.accountEmpty.style.display = '';
      this.updateSubmitState();
      return;
    }
    const opts = ['<option value="">Pilih metode...</option>'];
    this.accounts.forEach(a => {
      opts.push(`<option value="${a.id}" data-type="${a.type}">${escHtml(a.label)}</option>`);
    });
    this.el.accountSelect.innerHTML = opts.join('');
    this.el.accountSelect.disabled = false;
    if (this.el.accountEmpty) this.el.accountEmpty.style.display = 'none';
    this.updateSubmitState();
  },

  renderHistory(rows) {
    if (!this.el.historyBody) return;
    if (!rows || !rows.length) {
      this.el.historyBody.innerHTML = `<tr><td colspan="6" class="empty-td">Belum ada setoran</td></tr>`;
      return;
    }
    this.el.historyBody.innerHTML = rows.map(r => {
      const date = fDate(r.created_at);
      const proof = r.proof_url ? `<a href="${r.proof_url}" target="_blank">Bukti</a>` : '-';
      const status = r.status === 'pending' ? '<span class="badge badge-warning">pending</span>' : (r.status === 'confirmed' ? '<span class="badge badge-success">confirmed</span>' : '<span class="badge badge-danger">rejected</span>');
      return `<tr><td>${date}</td><td>${fRp(r.amount)}</td><td>${escHtml(r.deposit_accounts?.label || '-')}</td><td>${proof}</td><td>${status}</td><td>${escHtml(r.notes||'')}</td></tr>`;
    }).join('');
  },

  onFileChange(files) {
    const file = files && files[0];
    if (!file) { if (this.el.filePreview) this.el.filePreview.innerHTML = ''; this.selectedFile = null; return; }
    if (file.size > 5 * 1024 * 1024) { showToast('Ukuran file maksimal 5 MB', 'error'); this.el.fileInput.value = ''; if (this.el.filePreview) this.el.filePreview.innerHTML = ''; this.selectedFile = null; return; }
    const allowed = ['image/jpeg','image/png','image/webp','application/pdf'];
    if (!allowed.includes(file.type)) { showToast('Hanya JPG, PNG, WEBP, PDF yang diterima', 'error'); this.el.fileInput.value = ''; if (this.el.filePreview) this.el.filePreview.innerHTML = ''; this.selectedFile = null; return; }
    if (file.type === 'application/pdf') {
      if (this.el.filePreview) this.el.filePreview.innerHTML = `<div class="file-pdf">PDF: ${escHtml(file.name)}</div>`;
    } else {
      const url = URL.createObjectURL(file);
      if (this.el.filePreview) this.el.filePreview.innerHTML = `<img src="${url}" style="max-width:140px;max-height:100px;border-radius:8px">`;
    }
    this.selectedFile = file;
  },

  changeAmount(delta) {
    if (!this.el.amountInput) return;
    let current = Number(this.el.amountInput.value || 0);
    if (Number.isNaN(current)) current = 0;
    const maxStep = Math.floor((this.expectedCash || 0) / DEPOSIT_STEP) * DEPOSIT_STEP;
    const base = current > 0 ? current : 0;
    let next = base + delta;
    if (delta > 0 && next < DEPOSIT_STEP) next = DEPOSIT_STEP;
    if (delta < 0 && next < DEPOSIT_STEP) next = '';
    if (maxStep > 0 && next > maxStep) next = maxStep;
    this.el.amountInput.value = next || '';
    this.updateSubmitState();
  },

  validateAmount({ showEmpty = false } = {}) {
    let amount = 0;
    let message = '';
    try {
      amount = safeNum(this.el.amountInput?.value || 0, 'Jumlah setoran');
    } catch (e) {
      message = e.message;
    }

    if (!message) {
      if (amount <= 0) {
        message = showEmpty ? 'Jumlah setoran harus lebih dari 0' : '';
      } else if (amount % DEPOSIT_STEP !== 0) {
        message = 'Nominal harus kelipatan Rp 50.000';
      } else if (amount > this.expectedCash) {
        message = `Melebihi saldo kas (${fRp(this.expectedCash)})`;
      }
    }

    if (this.el.amountError) {
      this.el.amountError.textContent = message;
      this.el.amountError.classList.toggle('show', Boolean(message));
    }
    return { amount, valid: amount > 0 && !message };
  },

  updateSubmitState() {
    const { valid } = this.validateAmount();
    const disabled = this.isSubmitting || !valid || this.expectedCash <= 0 || !this.accounts.length;
    if (this.el.submitBtn) this.el.submitBtn.disabled = disabled;
    if (this.el.amountDecBtn) this.el.amountDecBtn.disabled = this.isSubmitting;
    if (this.el.amountIncBtn) this.el.amountIncBtn.disabled = this.isSubmitting || this.expectedCash < DEPOSIT_STEP;
  },

  async onSubmit() {
    if (!window.POS || !POS.branch) { showToast('Cabang belum dipilih', 'error'); return; }
    const branchId = POS.branch.id;
    const sessionId = POS.session?.id || null;
    const { amount, valid } = this.validateAmount({ showEmpty: true });
    if (!valid) { showToast(this.el.amountError?.textContent || 'Nominal setoran tidak valid', 'error'); return; }
    const accId = this.el.accountSelect.value;
    if (!accId) { showToast('Pilih metode setoran', 'error'); return; }
    const acc = this.accounts.find(a => a.id === accId);
    if (!acc) { showToast('Metode setoran tidak ditemukan', 'error'); return; }
    if (!this.selectedFile) { showToast('Bukti setoran wajib dilampirkan', 'error'); return; }
    const notes = this.el.notesInput.value || null;
    const ok = await showConfirm({
      title: 'Konfirmasi Setoran',
      message: `Setor ${fRp(amount)} via ${acc.label}?`,
      confirmText: 'Ya, Setor'
    });
    if (!ok) return;
    this.isSubmitting = true;
    this.updateSubmitState();
    const prevText = this.el.submitBtn.textContent;
    this.el.submitBtn.textContent = 'Mengirim...';
    try {
      await depositService.submitDeposit({
        branchId,
        sessionId,
        staffId: POS.user.id,
        accountId: accId,
        amount,
        cashBalance: this.expectedCash,
        file: this.selectedFile,
        notes
      });
      showToast('Setoran berhasil dikirim', 'success');
      this.clearForm();
      await this.refresh();
    } catch (e) {
      console.error('submitDeposit', e);
      showToast(e.message || 'Gagal mengirim setoran', 'error');
    } finally {
      this.isSubmitting = false;
      this.el.submitBtn.textContent = prevText;
      this.updateSubmitState();
    }
  },

  clearForm() {
    if (this.el.amountInput) this.el.amountInput.value = '';
    if (this.el.accountSelect) this.el.accountSelect.value = '';
    if (this.el.fileInput) this.el.fileInput.value = '';
    if (this.el.filePreview) this.el.filePreview.innerHTML = '';
    if (this.el.notesInput) this.el.notesInput.value = '';
    this.selectedFile = null;
    this.updateSubmitState();
  }
};

window.depositUi = depositUi;
depositUi.init();
