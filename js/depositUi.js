'use strict';

const depositUi = {
  el: {},
  accounts: [],
  expectedCash: 0,
  selectedFile: null,

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
    this.el.accountSelect = document.getElementById('deposit-account-select');
    this.el.fileInput = document.getElementById('deposit-proof-file');
    this.el.filePreview = document.getElementById('deposit-proof-preview');
    this.el.notesInput = document.getElementById('deposit-notes');
    this.el.submitBtn = document.getElementById('btn-submit-deposit');
    this.el.historyBody = document.getElementById('deposit-history-body');
    this.el.infoNoCash = document.getElementById('deposit-no-cash');

    if (this.el.fileInput) this.el.fileInput.addEventListener('change', e => this.onFileChange(e.target.files));
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
    if (this.expectedCash <= 0) {
      if (this.el.infoNoCash) this.el.infoNoCash.style.display = '';
      if (this.el.panel) this.el.panel.classList.add('no-cash');
    } else {
      if (this.el.infoNoCash) this.el.infoNoCash.style.display = 'none';
      if (this.el.panel) this.el.panel.classList.remove('no-cash');
    }

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
    const opts = ['<option value="">Pilih metode...</option>'];
    this.accounts.forEach(a => {
      opts.push(`<option value="${a.id}" data-type="${a.type}">${escHtml(a.label)}</option>`);
    });
    this.el.accountSelect.innerHTML = opts.join('');
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
    if (file.size > 5 * 1024 * 1024) { showToast('Ukuran file maksimal 5 MB', 'error'); this.el.fileInput.value = ''; return; }
    const allowed = ['image/jpeg','image/png','image/webp','application/pdf'];
    if (!allowed.includes(file.type)) { showToast('Hanya JPG, PNG, PDF yang diterima', 'error'); this.el.fileInput.value = ''; return; }
    if (file.type === 'application/pdf') {
      if (this.el.filePreview) this.el.filePreview.innerHTML = `<div class="file-pdf">PDF: ${escHtml(file.name)}</div>`;
    } else {
      const url = URL.createObjectURL(file);
      if (this.el.filePreview) this.el.filePreview.innerHTML = `<img src="${url}" style="max-width:140px;max-height:100px;border-radius:8px">`;
    }
    this.selectedFile = file;
  },

  async onSubmit() {
    if (!window.POS || !POS.branch) { showToast('Cabang belum dipilih', 'error'); return; }
    const branchId = POS.branch.id;
    const sessionId = POS.session?.id || null;
    let amount = 0;
    try { amount = safeNum(this.el.amountInput.value || 0, 'Jumlah setoran'); } catch (e) { showToast(e.message, 'error'); return; }
    if (amount <= 0) { showToast('Jumlah setoran harus lebih dari 0', 'error'); return; }
    if (amount > this.expectedCash) { showToast(`Jumlah setoran melebihi saldo kas (Rp ${fRp(this.expectedCash)})`, 'error'); return; }
    const accId = this.el.accountSelect.value;
    if (!accId) { showToast('Pilih metode setoran', 'error'); return; }
    const acc = this.accounts.find(a => a.id === accId);
    if ((acc?.type === 'bank' || acc?.type === 'qris') && !this.selectedFile) { showToast('Bukti setoran wajib untuk metode ini', 'error'); return; }
    const notes = this.el.notesInput.value || null;
    this.el.submitBtn.disabled = true;
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
      this.el.submitBtn.disabled = false;
      this.el.submitBtn.textContent = prevText;
    }
  },

  clearForm() {
    if (this.el.amountInput) this.el.amountInput.value = '';
    if (this.el.accountSelect) this.el.accountSelect.value = '';
    if (this.el.fileInput) this.el.fileInput.value = '';
    if (this.el.filePreview) this.el.filePreview.innerHTML = '';
    if (this.el.notesInput) this.el.notesInput.value = '';
    this.selectedFile = null;
  }
};

window.depositUi = depositUi;
depositUi.init();
