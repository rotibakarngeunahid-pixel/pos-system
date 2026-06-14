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
  isRefreshing: false,
  readyRefreshTimer: null,
  clockTimer: null,
  accountLoadError: null,
  didBind: false,

  // ── Transfer Antar Outlet state ──
  depositMode: 'regular',         // 'regular' | 'outlet'
  activeBranches: [],
  selectedTransferFile: null,
  selectedTransferFileUrl: null,
  isTransferSubmitting: false,

  getPOS() {
    if (typeof window !== 'undefined' && window.POS) return window.POS;
    if (typeof POS !== 'undefined') return POS;
    return null;
  },

  hasEligibleClosedShift() {
    const sess = this.selectedClosedSession;
    if (!sess) return false;
    // RPC may return 'status' or 'session_status' depending on code path
    const status = sess.session_status ?? sess.status;
    return status === 'closed';
  },

  isFormBlocked() {
    const sess = this.selectedClosedSession;
    return !this.hasEligibleClosedShift()
      || Boolean(sess?.block_reason)
      || this.depositableCash <= 0;
  },

  canInteractWithForm() {
    return !this.isSubmitting && !this.isFormBlocked();
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
    this.el.accountEmpty = document.getElementById('deposit-account-empty');
    this.el.methodDetail = document.getElementById('deposit-method-detail');
    this.el.fileInput = document.getElementById('deposit-proof-file');
    this.el.proofZone = document.getElementById('deposit-proof-zone');
    this.el.uploadEmpty = document.getElementById('deposit-upload-empty');
    this.el.filePreview = document.getElementById('deposit-proof-preview');
    this.el.proofHint = document.getElementById('deposit-proof-hint');
    this.el.notesInput = document.getElementById('deposit-notes');
    this.el.submitBtn = document.getElementById('btn-submit-deposit');
    this.el.historyBody = document.getElementById('deposit-history-body');
    this.el.blockingAlert = document.getElementById('deposit-blocking-alert');
    this.el.infoNoCash = null;
    this.el.success = document.getElementById('deposit-success');
    this.el.summaryShift = document.getElementById('deposit-summary-shift');
    this.el.summaryStaff = document.getElementById('deposit-summary-staff');
    this.el.summaryTime = document.getElementById('deposit-summary-time');
    this.el.shiftMetaLabel = document.getElementById('deposit-shift-meta-label');
    this.el.headerShift = document.getElementById('deposit-header-shift');
    this.el.cashCard = document.getElementById('deposit-cash-card');
    this.el.cardLabel = document.getElementById('deposit-card-label');

    // ── Transfer Antar Outlet elements ──
    this.el.modeTabs        = document.getElementById('deposit-mode-tabs');
    this.el.modeRegularBtn  = document.getElementById('deposit-mode-regular');
    this.el.modeOutletBtn   = document.getElementById('deposit-mode-outlet');
    this.el.panelRegular    = document.getElementById('deposit-panel-regular');
    this.el.panelOutlet     = document.getElementById('deposit-panel-outlet');

    this.el.transferToBranch       = document.getElementById('transfer-to-branch');
    this.el.transferToBranchError  = document.getElementById('transfer-to-branch-error');
    this.el.transferAmountInput    = document.getElementById('transfer-amount');
    this.el.transferAmountError    = document.getElementById('transfer-amount-error');
    this.el.transferQuickButtons   = Array.from(document.querySelectorAll('[data-transfer-quick]'));
    this.el.transferProofFile      = document.getElementById('transfer-proof-file');
    this.el.transferProofZone      = document.getElementById('transfer-proof-zone');
    this.el.transferUploadEmpty    = document.getElementById('transfer-upload-empty');
    this.el.transferProofPreview   = document.getElementById('transfer-proof-preview');
    this.el.transferNotesInput     = document.getElementById('transfer-notes');
    this.el.transferSubmitBtn      = document.getElementById('btn-submit-transfer');
    this.el.transferSuccess        = document.getElementById('transfer-success');

    this.el.incomingSection = document.getElementById('deposit-incoming-section');
    this.el.incomingBody    = document.getElementById('deposit-incoming-body');
    this.el.incomingBadge   = document.getElementById('deposit-incoming-badge');

    this.bindModeSelector();
    this.bindTransferForm();

    if (this.el.amountInput) {
      // Block non-numeric keystrokes (allow control keys, digits only)
      this.el.amountInput.addEventListener('keydown', e => {
        const passKeys = ['Backspace','Delete','Tab','Escape','Enter',
                          'ArrowLeft','ArrowRight','ArrowUp','ArrowDown','Home','End'];
        if (passKeys.includes(e.key) || e.ctrlKey || e.metaKey) return;
        if (!/^\d$/.test(e.key)) e.preventDefault();
      });
      this.el.amountInput.addEventListener('input', () => this.onAmountInput());
    }
    this.el.quickButtons.forEach(btn => {
      btn.addEventListener('click', () => this.setQuickAmount(btn.dataset.depositQuick));
    });

    if (this.el.accountSelect) {
      this.el.accountSelect.addEventListener('change', () => {
        const id = this.el.accountSelect.value;
        if (id) this.selectAccount(id);
        else {
          if (this.el.methodDetail) {
            this.el.methodDetail.style.display = 'none';
            this.el.methodDetail.innerHTML = '';
          }
          this.updateMethodDependentFields();
          this.updateSubmitState();
        }
      });
    }

    if (this.el.methodDetail) {
      this.el.methodDetail.addEventListener('click', e => {
        if (e.target.closest('[data-action="copy-deposit-account-number"]')) {
          this.copySelectedAccountNumber();
        }
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
      if (!this.canInteractWithForm()) return;
      this.el.fileInput?.click();
    });
    zone.addEventListener('keydown', e => {
      if (e.key !== 'Enter' && e.key !== ' ') return;
      if (e.target.closest('.deposit-proof-remove')) return;
      e.preventDefault();
      if (!this.canInteractWithForm()) return;
      this.el.fileInput?.click();
    });
    zone.addEventListener('dragover', e => {
      if (!this.canInteractWithForm()) return;
      e.preventDefault();
      zone.classList.add('dragover');
    });
    zone.addEventListener('dragleave', e => {
      if (e.currentTarget === zone) zone.classList.remove('dragover');
    });
    zone.addEventListener('drop', e => {
      e.preventDefault();
      zone.classList.remove('dragover');
      if (!this.canInteractWithForm()) return;
      this.onFileChange(e.dataTransfer?.files);
    });
  },

  refreshWhenReady(attemptOrOpts = 0, opts = {}) {
    // Support two call signatures:
    //   refreshWhenReady()                          — no-arg
    //   refreshWhenReady({ preferSessionId })       — opts as first arg (legacy callers)
    //   refreshWhenReady(attempt, opts)             — internal recursive call
    let attempt, resolvedOpts;
    if (typeof attemptOrOpts === 'object' && attemptOrOpts !== null) {
      attempt = 0;
      resolvedOpts = attemptOrOpts;
    } else {
      attempt = Number(attemptOrOpts) || 0;
      resolvedOpts = opts;
    }
    const pos = this.getPOS();
    if (pos?.user && pos?.branch) {
      this.refresh(resolvedOpts);
      return;
    }
    if (attempt >= 40) return;
    clearTimeout(this.readyRefreshTimer);
    this.readyRefreshTimer = setTimeout(() => this.refreshWhenReady(attempt + 1, resolvedOpts), 250);
  },

  async refresh({ preferSessionId = null } = {}) {
    const pos = this.getPOS();
    if (!pos?.branch) return;

    this.isRefreshing = true;
    this.updateSummaryCard();

    const branchId = pos.branch.id;
    const staffId = pos.user?.id;
    this.accountLoadError = null;
    this.renderAccountLoading();

    try {
      this.eligibleSessions = await depositService.getEligibleSessions({ branchId, staffId });
    } catch (e) {
      console.error('depositUi.refresh getEligibleSessions failed', e);
      this.eligibleSessions = [];
      if (typeof showToast === 'function') showToast('Gagal memuat data shift. Coba tekan Refresh.', 'error');
    }

    const preferred = preferSessionId
      ? this.eligibleSessions.find(s => s.session_id === preferSessionId)
      : null;
    this.selectedClosedSession = preferred || this.eligibleSessions[0] || null;
    this.depositableCash = this.selectedClosedSession
      ? Number(this.selectedClosedSession.depositable_cash || 0)
      : 0;

    this.isRefreshing = false;
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
    this.syncDepositBlocker();

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

    // Load incoming transfer approvals
    try {
      await this.loadIncoming();
    } catch (e) {
      console.warn('loadIncoming', e);
    }
  },

  syncDepositBlocker() {
    const pos = this.getPOS();
    if (!pos) return;
    const hasEligible = this.hasEligibleClosedShift();

    if (!hasEligible) {
      if (window.POS && typeof POS.updateDepositBlocker === 'function') {
        POS.updateDepositBlocker();
      }
      if (pos.session?.id && typeof openModal === 'function') {
        openModal('modal-deposit-blocked');
      }
    } else {
      if (typeof closeModal === 'function') closeModal('modal-deposit-blocked');
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

  getBlockedReasonMeta() {
    if (this.isRefreshing) return null;
    const pos = this.getPOS();
    const sess = this.selectedClosedSession;
    const hasEligible = this.hasEligibleClosedShift();
    const hasOpenShift = Boolean(pos?.session?.id);

    if (!hasEligible && hasOpenShift) {
      return {
        type: 'shift-open',
        title: 'Setoran belum bisa dilakukan',
        body: 'Tutup shift terlebih dahulu agar kas akhir terkunci. Setelah itu form setoran akan aktif.',
        ctaLabel: 'Tutup Shift Sekarang',
        ctaAction: 'deposit-blocker-tutup-shift'
      };
    }
    if (!hasEligible) {
      return {
        type: 'no-shift',
        title: 'Belum ada shift tertutup',
        body: 'Buka shift, selesaikan transaksi, lalu tutup shift sebelum melakukan setoran tunai.',
        ctaLabel: 'Buka Shift',
        ctaAction: 'deposit-blocker-buka-shift'
      };
    }
    if (sess?.block_reason) {
      const reason = String(sess.block_reason).toLowerCase();
      const isCrossShift = reason.includes('shift lain');
      const isPending = reason.includes('menunggu') || reason.includes('pending');
      const isConfirmed = reason.includes('selesai') || reason.includes('terkonfirmasi') || reason.includes('confirm');
      const isRejected = reason.includes('ditolak') || reason.includes('reject');

      if (isCrossShift) {
        return {
          type: 'pending',
          title: 'Ada setoran shift lain yang belum selesai',
          body: 'Setoran dari shift sebelumnya masih diproses. Tunggu sampai selesai sebelum membuat setoran baru.',
          ctaLabel: null,
          ctaAction: null
        };
      }
      if (isPending) {
        return {
          type: 'pending',
          title: 'Setoran sedang diproses',
          body: 'Setoran shift ini sudah dikirim dan sedang diproses.',
          ctaLabel: null,
          ctaAction: null
        };
      }
      if (isConfirmed) {
        return {
          type: 'confirmed',
          title: 'Setoran shift ini selesai',
          body: 'Shift ini sudah memiliki setoran terkonfirmasi.',
          ctaLabel: null,
          ctaAction: null
        };
      }
      if (isRejected) {
        return {
          type: 'rejected',
          title: 'Setoran sebelumnya ditolak',
          body: this.esc(sess.block_reason),
          ctaLabel: null,
          ctaAction: null
        };
      }
      return {
        type: 'blocked',
        title: 'Setoran belum bisa dilakukan',
        body: this.esc(sess.block_reason),
        ctaLabel: null,
        ctaAction: null
      };
    }
    if (hasEligible && this.depositableCash <= 0) {
      return {
        type: 'no-cash',
        title: 'Tidak ada kas yang dapat disetor',
        body: 'Shift ini sudah ditutup tetapi kas yang dapat disetor adalah Rp 0.',
        ctaLabel: null,
        ctaAction: null
      };
    }
    return null;
  },

  renderBlockingAlert() {
    const alert = this.el.blockingAlert;
    if (!alert) return;

    const meta = this.getBlockedReasonMeta();
    if (!meta) {
      alert.style.display = 'none';
      alert.innerHTML = '';
      return;
    }

    const ctaHtml = meta.ctaLabel && meta.ctaAction
      ? `<button type="button" class="deposit-blocking-cta" data-action="${this.esc(meta.ctaAction)}">${this.esc(meta.ctaLabel)}</button>`
      : '';

    alert.innerHTML = `
      <div class="deposit-blocking-alert-icon">
        <i data-lucide="alert-circle"></i>
      </div>
      <div class="deposit-blocking-alert-body">
        <strong class="deposit-blocking-alert-title">${this.esc(meta.title)}</strong>
        <p class="deposit-blocking-alert-text">${meta.body}</p>
        ${ctaHtml}
      </div>`;
    alert.style.display = '';
    if (window.lucide) window.requestAnimationFrame(() => lucide.createIcons());
  },

  applyFormAvailability() {
    const blocked = this.isFormBlocked();
    const disabled = blocked || this.isSubmitting;

    if (this.el.amountInput) this.el.amountInput.disabled = disabled;
    if (this.el.fileInput) this.el.fileInput.disabled = disabled;
    if (this.el.notesInput) this.el.notesInput.disabled = disabled;

    if (this.el.accountSelect && this.el.accountSelect.tagName === 'SELECT') {
      this.el.accountSelect.disabled = disabled || !this.accounts.length;
    }

    this.el.amountInput?.closest('.deposit-currency-field')?.classList.toggle('is-disabled', disabled);

    if (this.el.proofZone) {
      this.el.proofZone.classList.toggle('is-disabled', disabled);
      this.el.proofZone.setAttribute('aria-disabled', disabled ? 'true' : 'false');
      this.el.proofZone.setAttribute('tabindex', disabled ? '-1' : '0');
      this.el.proofZone.setAttribute('role', disabled ? 'presentation' : 'button');
    }

    this.el.quickButtons.forEach(btn => { btn.disabled = disabled; });

    if (this.el.proofHint && blocked && !this.hasEligibleClosedShift()) {
      this.el.proofHint.textContent = 'Upload bukti aktif setelah shift ditutup.';
    }
  },

  updateSummaryCard() {
    const pos = this.getPOS();
    const sess = this.selectedClosedSession;
    const hasEligible = this.hasEligibleClosedShift();
    const staffLabel = pos?.user?.name || '-';

    const shiftLabel = sess
      ? `Shift #${sess.session_id} (Tertutup)`
      : 'Belum ada shift tertutup';

    if (this.el.cardLabel) {
      this.el.cardLabel.textContent = hasEligible ? 'Kas Final Shift'
        : (this.isRefreshing ? 'Memuat...' : 'Menunggu Shift Ditutup');
    }
    if (this.el.shiftMetaLabel) {
      this.el.shiftMetaLabel.textContent = hasEligible ? 'Shift Tertutup' : 'Status Shift';
    }
    if (this.el.expectedCashEl) {
      this.el.expectedCashEl.textContent = hasEligible ? fRp(this.depositableCash) : '—';
    }
    if (this.el.summaryShift) this.el.summaryShift.textContent = shiftLabel;
    if (this.el.summaryStaff) this.el.summaryStaff.textContent = staffLabel;
    if (this.el.headerShift) {
      this.el.headerShift.textContent = hasEligible
        ? shiftLabel
        : (this.isRefreshing ? 'Memuat data shift...' : 'Belum ada shift tertutup yang bisa disetor');
    }

    const noCash = hasEligible && this.depositableCash <= 0;
    if (this.el.panel) this.el.panel.classList.toggle('no-cash', noCash);
    if (this.el.cashCard) {
      this.el.cashCard.classList.toggle('no-cash', noCash);
      this.el.cashCard.classList.toggle('no-session', !hasEligible);
    }

    this.renderBlockingAlert();
    this.applyFormAvailability();
    this.updateClock();
  },

  renderAccountLoading() {
    const select = this.el.accountSelect;
    if (select && select.tagName === 'SELECT') {
      select.innerHTML = '<option value="">Memuat metode...</option>';
      select.disabled = true;
    }
    if (this.el.accountEmpty) this.el.accountEmpty.style.display = 'none';
    if (this.el.methodDetail) {
      this.el.methodDetail.style.display = 'none';
      this.el.methodDetail.innerHTML = '';
    }
  },

  renderAccounts() {
    const select = this.el.accountSelect;
    if (!select) return;

    if (this.accountLoadError) {
      select.innerHTML = '<option value="">Pilih metode setoran</option>';
      select.disabled = false;
      if (this.el.accountEmpty) {
        this.el.accountEmpty.textContent = `Gagal memuat metode setoran: ${this.accountLoadError}`;
        this.el.accountEmpty.style.display = '';
      }
      if (this.el.methodDetail) {
        this.el.methodDetail.style.display = 'none';
        this.el.methodDetail.innerHTML = '';
      }
      this.updateSubmitState();
      return;
    }

    const accounts = this.sortAccounts(this.accounts);
    if (!accounts.length) {
      select.innerHTML = '<option value="">Pilih metode setoran</option>';
      select.disabled = true;
      if (this.el.accountEmpty) {
        this.el.accountEmpty.textContent = 'Belum ada metode setoran aktif. Hubungi admin.';
        this.el.accountEmpty.style.display = '';
      }
      if (this.el.methodDetail) {
        this.el.methodDetail.style.display = 'none';
        this.el.methodDetail.innerHTML = '';
      }
      this.updateSubmitState();
      return;
    }

    if (this.el.accountEmpty) this.el.accountEmpty.style.display = 'none';

    const currentId = select.value;
    const lastId = this.getLastAccountId();
    const selectedId = accounts.some(a => String(a.id) === String(currentId))
      ? currentId
      : (accounts.some(a => String(a.id) === String(lastId)) ? lastId : '');

    select.innerHTML = '<option value="">Pilih metode setoran</option>'
      + accounts.map(account => {
        const id = this.esc(account.id);
        const label = this.esc(account.label || 'Metode Setoran');
        return `<option value="${id}">${label}</option>`;
      }).join('');
    select.value = selectedId;

    this.renderSelectedAccountDetail();
    this.updateMethodDependentFields();
    this.updateSubmitState();
  },

  // ── Account Detail Rendering ───────────────────────────────────────

  renderSelectedAccountDetail() {
    const detail = this.el.methodDetail;
    if (!detail) return;
    const account = this.getSelectedAccount();
    if (!account) {
      detail.style.display = 'none';
      detail.innerHTML = '';
      return;
    }
    detail.style.display = '';
    if (depositService.isCashDepositMethod(account)) {
      detail.innerHTML = this.renderCashAccountDetail(account);
    } else if (account.type === 'qris') {
      detail.innerHTML = this.renderQrisAccountDetail(account);
    } else {
      detail.innerHTML = this.renderBankAccountDetail(account);
    }
    if (window.lucide) window.requestAnimationFrame(() => lucide.createIcons());
  },

  renderBankAccountDetail(account) {
    const bankName = this.esc(account.bank_name || '-');
    const accountNumber = account.account_number || '';
    const accountHolder = this.esc(account.account_holder || '-');

    if (!accountNumber) {
      return `<div class="deposit-method-config-error">
        <i data-lucide="alert-circle" class="icon-sm"></i>
        <span>Nomor rekening belum dikonfigurasi. Hubungi admin.</span>
      </div>`;
    }

    return `
      <div class="deposit-method-detail-inner">
        <div class="deposit-method-detail-title">Transfer ke rekening ini</div>
        <div class="deposit-bank-detail">
          <div class="deposit-method-detail-row">
            <span>Bank</span>
            <strong>${bankName}</strong>
          </div>
          <div class="deposit-account-number-row">
            <div class="deposit-account-number-info">
              <span>Nomor Rekening</span>
              <strong class="deposit-account-number">${this.esc(accountNumber)}</strong>
            </div>
            <button type="button" class="btn btn-outline btn-sm deposit-copy-btn" data-action="copy-deposit-account-number" aria-label="Salin nomor rekening">
              <i data-lucide="copy" class="icon-sm"></i>
              <span>Salin Nomor</span>
            </button>
          </div>
          <div class="deposit-method-detail-row">
            <span>Atas Nama</span>
            <strong>${accountHolder}</strong>
          </div>
        </div>
        <div class="deposit-copy-feedback" id="deposit-copy-feedback" aria-live="polite" style="display:none">
          <i data-lucide="check" class="icon-sm"></i>
          <span>Nomor rekening disalin</span>
        </div>
      </div>`;
  },

  renderQrisAccountDetail(account) {
    const qrisUrl = depositService.normalizeUploadUrl(account.qris_image_url || '');

    if (!qrisUrl || !this.isSafeHttpUrl(qrisUrl)) {
      return `<div class="deposit-method-config-error">
        <i data-lucide="alert-circle" class="icon-sm"></i>
        <span>QRIS belum dikonfigurasi. Hubungi admin.</span>
      </div>`;
    }

    const safeUrl = this.esc(qrisUrl);
    return `
      <div class="deposit-method-detail-inner">
        <div class="deposit-method-detail-title">Gunakan QRIS ini</div>
        <div class="deposit-qris-detail">
          <div class="deposit-qris-preview">
            <img src="${safeUrl}" alt="QRIS setoran Roti Bakar Ngeunah"
              onerror="this.parentElement.innerHTML='<div class=\\'deposit-qris-img-error\\'>Gambar QRIS gagal dimuat. Gunakan tombol Buka QRIS.</div>'" />
          </div>
          <div class="deposit-qris-actions">
            <a class="btn btn-primary btn-sm" href="${safeUrl}" download="QRIS-Setoran.png" rel="noopener noreferrer">
              <i data-lucide="download" class="icon-sm"></i>
              <span>Unduh QRIS</span>
            </a>
            <a class="btn btn-outline btn-sm" href="${safeUrl}" target="_blank" rel="noopener noreferrer">
              <i data-lucide="external-link" class="icon-sm"></i>
              <span>Buka QRIS</span>
            </a>
          </div>
          <p class="deposit-qris-note">Setelah pembayaran QRIS selesai, upload bukti pembayaran.</p>
        </div>
      </div>`;
  },

  renderCashAccountDetail(account) {
    return `
      <div class="deposit-method-detail-inner deposit-cash-detail">
        <i data-lucide="hand-coins" class="icon-sm deposit-cash-icon"></i>
        <span>Serahkan tunai langsung ke manager atau admin. Bukti setoran opsional.</span>
      </div>`;
  },

  // ── Copy Rekening ──────────────────────────────────────────────────

  async copySelectedAccountNumber() {
    const account = this.getSelectedAccount();
    if (!account?.account_number) return;

    const text = String(account.account_number);
    const success = await this.copyTextToClipboard(text);

    const feedback = this.el.methodDetail?.querySelector('#deposit-copy-feedback');
    if (feedback) {
      feedback.style.display = '';
      clearTimeout(this._copyFeedbackTimer);
      this._copyFeedbackTimer = setTimeout(() => {
        if (feedback) feedback.style.display = 'none';
      }, 2500);
      if (window.lucide) window.requestAnimationFrame(() => lucide.createIcons());
    }

    if (!success) {
      if (typeof showToast === 'function') showToast('Salin manual: ' + text, 'info');
    }
  },

  async copyTextToClipboard(text) {
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
        return true;
      }
    } catch (e) {
      // fall through to execCommand
    }
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.cssText = 'position:fixed;top:-9999px;left:-9999px;opacity:0;pointer-events:none';
      document.body.appendChild(ta);
      ta.focus();
      ta.select();
      const ok = document.execCommand('copy');
      ta.remove();
      return ok;
    } catch (e) {
      return false;
    }
  },

  // ── Method Readiness ───────────────────────────────────────────────

  isSafeHttpUrl(url) {
    if (!url || typeof url !== 'string') return false;
    try {
      const parsed = new URL(url);
      return parsed.protocol === 'http:' || parsed.protocol === 'https:';
    } catch (e) {
      return false;
    }
  },

  isSelectedMethodReady(account) {
    if (!account) return false;
    if (depositService.isCashDepositMethod(account)) return true;
    if (account.type === 'qris') {
      return Boolean(account.qris_image_url) && this.isSafeHttpUrl(account.qris_image_url);
    }
    return Boolean(account.account_number);
  },

  // ── Account Selection ──────────────────────────────────────────────

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
    if (depositService.isCashDepositMethod(account) || raw.includes('manager')) return 4;
    if (account?.type === 'qris') return 5;
    return 9;
  },

  selectAccount(id, { persist = true } = {}) {
    if (!this.canInteractWithForm()) return;
    if (!this.el.accountSelect) return;
    this.el.accountSelect.value = id || '';
    if (persist && id) this.setLastAccountId(id);
    this.renderSelectedAccountDetail();
    this.updateMethodDependentFields();
    this.updateSubmitState();
  },

  updateMethodDependentFields() {
    const account = this.getSelectedAccount();
    const isCash = account ? depositService.isCashDepositMethod(account) : false;
    const blocked = this.isFormBlocked();

    if (this.el.proofHint) {
      if (blocked) {
        this.el.proofHint.textContent = 'Upload bukti aktif setelah shift ditutup.';
      } else if (!account) {
        this.el.proofHint.textContent = 'Pilih metode setoran terlebih dahulu.';
      } else if (isCash) {
        this.el.proofHint.textContent = 'Bukti opsional untuk penyerahan tunai langsung.';
      } else if (account.type === 'qris') {
        this.el.proofHint.textContent = 'Setelah pembayaran QRIS selesai, upload bukti pembayaran.';
      } else {
        this.el.proofHint.textContent = 'Setelah transfer selesai, upload bukti transfer.';
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
    return !depositService.isCashDepositMethod(account);
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
    if (!this.canInteractWithForm()) return;
    const amount = this.parseAmountInput(this.el.amountInput?.value || '');
    this.setAmountInput(amount, { validate: false });
    this.updateSubmitState();
  },

  setQuickAmount(value) {
    if (!this.canInteractWithForm()) return;
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
    this.applyFormAvailability();
    const { valid } = this.validateAmount();
    const account = this.getSelectedAccount();
    const proofOk = !this.isProofRequired(account) || Boolean(this.selectedFile);
    const blocked = this.isFormBlocked();
    const methodReady = this.isSelectedMethodReady(account);
    const disabled = this.isSubmitting || blocked || !valid || !account || !proofOk || !methodReady;
    if (this.el.submitBtn) this.el.submitBtn.disabled = disabled;
  },

  onFileChange(files) {
    if (!this.canInteractWithForm()) {
      if (this.el.fileInput) this.el.fileInput.value = '';
      return;
    }
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
    if (this.isSubmitting) return;
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

    if (!this.isSelectedMethodReady(account)) {
      if (account.type === 'qris') {
        if (typeof showToast === 'function') showToast('QRIS belum dikonfigurasi. Hubungi admin.', 'error');
      } else {
        if (typeof showToast === 'function') showToast('Nomor rekening belum dikonfigurasi. Hubungi admin.', 'error');
      }
      return;
    }

    const proofRequired = this.isProofRequired(account);
    if (proofRequired && !this.selectedFile) {
      if (typeof showToast === 'function') showToast('Bukti setoran wajib dilampirkan', 'error');
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
    this.applyFormAvailability();
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
          <strong>Setoran berhasil dikonfirmasi</strong>
          <span>No. referensi setoran: ${this.esc(ref)}</span>
        </div>`;
      setTimeout(() => {
        if (this.el.success) this.el.success.style.display = 'none';
      }, 7000);
    }
    if (typeof showToast === 'function') showToast(`Setoran berhasil dikonfirmasi. Ref: ${ref}`, 'success');
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

      const okBtn = overlay.querySelector('.deposit-confirm-ok');
      let okClicked = false;
      okBtn?.addEventListener('click', () => {
        if (okClicked) return;
        okClicked = true;
        if (okBtn) okBtn.disabled = true;
        close(true);
      }, { signal: ac.signal });
      overlay.querySelector('.deposit-confirm-cancel')?.addEventListener('click', () => close(false), { signal: ac.signal });
      overlay.querySelector('.deposit-confirm-close')?.addEventListener('click', () => close(false), { signal: ac.signal });
      overlay.addEventListener('click', e => {
        if (e.target === overlay) close(false);
      }, { signal: ac.signal });
      document.addEventListener('keydown', e => {
        if (e.key === 'Escape') close(false);
      }, { signal: ac.signal });
      setTimeout(() => okBtn?.focus(), 80);
    });
  },

  clearForm({ keepAccount = false } = {}) {
    if (this.el.amountInput) this.el.amountInput.value = '';
    if (!keepAccount) {
      if (this.el.accountSelect) this.el.accountSelect.value = '';
      if (this.el.methodDetail) {
        this.el.methodDetail.style.display = 'none';
        this.el.methodDetail.innerHTML = '';
      }
    }
    if (this.el.notesInput) this.el.notesInput.value = '';
    this.removeFile();
    this.applyFormAvailability();
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
      const method = row.deposit_accounts?.label
        || row.method
        || 'Metode lama/tidak tersedia';
      const proofUrl = depositService.normalizeProofUrl(row.proof_url);
      const proof = proofUrl
        ? `<a href="${this.esc(proofUrl)}" target="_blank" rel="noopener">${this.esc(row.proof_file_name || 'Lihat bukti')}</a>`
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
  },

  // ══════════════════════════════════════════════════════════════════
  // TRANSFER ANTAR OUTLET — mode selector & form
  // ══════════════════════════════════════════════════════════════════

  bindModeSelector() {
    const modeButtons = document.querySelectorAll('[data-deposit-mode]');
    modeButtons.forEach(btn => {
      btn.addEventListener('click', () => this.switchMode(btn.dataset.depositMode));
    });
  },

  switchMode(mode) {
    this.depositMode = mode;

    // Toggle tab active states
    const regularBtn = this.el.modeRegularBtn;
    const outletBtn  = this.el.modeOutletBtn;
    if (regularBtn) regularBtn.classList.toggle('active', mode === 'regular');
    if (regularBtn) regularBtn.setAttribute('aria-selected', mode === 'regular');
    if (outletBtn)  outletBtn.classList.toggle('active', mode === 'outlet');
    if (outletBtn)  outletBtn.setAttribute('aria-selected', mode === 'outlet');

    // Toggle panels
    if (this.el.panelRegular) this.el.panelRegular.style.display = mode === 'regular' ? '' : 'none';
    if (this.el.panelOutlet)  this.el.panelOutlet.style.display  = mode === 'outlet'  ? '' : 'none';

    // Load branches when switching to outlet mode for the first time
    if (mode === 'outlet' && !this.activeBranches.length) {
      this.loadActiveBranches();
    }
  },

  async loadActiveBranches() {
    const pos = this.getPOS();
    try {
      const all = await cashBranchTransferService.getActiveBranches();
      // Exclude current branch
      this.activeBranches = all.filter(b => Number(b.id) !== Number(pos?.branch?.id));
      this.renderBranchOptions();
    } catch (e) {
      if (typeof showToast === 'function') showToast('Gagal memuat daftar outlet: ' + (e.message || e), 'error');
    }
  },

  renderBranchOptions() {
    const sel = this.el.transferToBranch;
    if (!sel) return;
    sel.innerHTML = '<option value="">Pilih outlet tujuan</option>'
      + this.activeBranches.map(b =>
          `<option value="${this.esc(b.id)}">${this.esc(b.name)}</option>`
        ).join('');
    this.updateTransferSubmitState();
  },

  bindTransferForm() {
    // Amount input — numeric-only with live currency formatting
    if (this.el.transferAmountInput) {
      this.el.transferAmountInput.addEventListener('keydown', e => {
        const passKeys = ['Backspace','Delete','Tab','Escape','Enter',
                          'ArrowLeft','ArrowRight','ArrowUp','ArrowDown','Home','End'];
        if (passKeys.includes(e.key) || e.ctrlKey || e.metaKey) return;
        if (!/^\d$/.test(e.key)) e.preventDefault();
      });
      this.el.transferAmountInput.addEventListener('input', () => {
        const digits = String(this.el.transferAmountInput.value || '').replace(/\D/g, '');
        const num = digits ? Number(digits) : 0;
        const cursor = this.el.transferAmountInput.selectionStart;
        this.el.transferAmountInput.value = num > 0 ? num.toLocaleString('id-ID') : '';
        this.updateTransferSubmitState();
      });
    }
    // Quick buttons
    this.el.transferQuickButtons.forEach(btn => {
      btn.addEventListener('click', () => {
        const val = btn.dataset.transferQuick;
        const amount = val === 'all' ? this.depositableCash : Number(val || 0);
        if (this.el.transferAmountInput) {
          this.el.transferAmountInput.value = amount > 0 ? amount.toLocaleString('id-ID') : '';
        }
        this.updateTransferSubmitState();
      });
    });
    // Branch select
    if (this.el.transferToBranch) {
      this.el.transferToBranch.addEventListener('change', () => this.updateTransferSubmitState());
    }
    // Proof file
    if (this.el.transferProofFile) {
      this.el.transferProofFile.addEventListener('change', e => this.onTransferFileChange(e.target.files));
    }
    this.bindTransferUploadZone();
    // Submit
    if (this.el.transferSubmitBtn) {
      this.el.transferSubmitBtn.addEventListener('click', () => this.onTransferSubmit());
    }
  },

  bindTransferUploadZone() {
    const zone = this.el.transferProofZone;
    if (!zone) return;
    zone.addEventListener('click', e => {
      if (e.target.closest('.deposit-proof-remove')) { this.removeTransferFile(); return; }
      if (e.target.closest('a')) return;
      this.el.transferProofFile?.click();
    });
    zone.addEventListener('dragover', e => { e.preventDefault(); zone.classList.add('dragover'); });
    zone.addEventListener('dragleave', e => { if (e.currentTarget === zone) zone.classList.remove('dragover'); });
    zone.addEventListener('drop', e => {
      e.preventDefault(); zone.classList.remove('dragover');
      this.onTransferFileChange(e.dataTransfer?.files);
    });
  },

  onTransferFileChange(files) {
    const file = files && files[0];
    if (!file) { this.removeTransferFile({ clearInput: false }); return; }
    const ext = (file.name || '').split('.').pop().toLowerCase();
    if (file.size <= 0)                           { this.rejectFile('File tidak boleh kosong'); return; }
    if (file.size > DEPOSIT_MAX_FILE_SIZE)         { this.rejectFile('Ukuran file maksimal 5 MB'); return; }
    if (!DEPOSIT_ALLOWED_MIME.includes(file.type) && !DEPOSIT_ALLOWED_EXT.includes(ext)) {
      this.rejectFile('Hanya JPG, PNG, atau PDF yang diterima'); return;
    }
    this.removeTransferObjectUrl();
    this.selectedTransferFile = file;
    // Render preview inside transfer zone
    const preview = this.el.transferProofPreview;
    const empty   = this.el.transferUploadEmpty;
    if (empty)   empty.style.display = 'none';
    if (preview) {
      preview.style.display = '';
      const safeName = this.esc(file.name || 'Bukti');
      if (file.type === 'application/pdf' || safeName.toLowerCase().endsWith('.pdf')) {
        preview.innerHTML = `<div class="deposit-preview-file"><i data-lucide="file-text" class="icon-lg"></i><div><strong>${safeName}</strong><span>${this.formatFileSize(file.size)}</span></div><button type="button" class="deposit-proof-remove" aria-label="Hapus"><i data-lucide="x" class="icon-sm"></i></button></div>`;
      } else {
        this.selectedTransferFileUrl = URL.createObjectURL(file);
        preview.innerHTML = `<div class="deposit-preview-image"><img src="${this.selectedTransferFileUrl}" alt="Preview" /><div class="deposit-preview-meta"><strong>${safeName}</strong><span>${this.formatFileSize(file.size)}</span></div><button type="button" class="deposit-proof-remove" aria-label="Hapus"><i data-lucide="x" class="icon-sm"></i></button></div>`;
      }
      if (window.lucide) window.requestAnimationFrame(() => lucide.createIcons());
    }
    this.updateTransferSubmitState();
  },

  removeTransferFile({ clearInput = true } = {}) {
    this.removeTransferObjectUrl();
    this.selectedTransferFile = null;
    if (clearInput && this.el.transferProofFile) this.el.transferProofFile.value = '';
    if (this.el.transferProofPreview) { this.el.transferProofPreview.innerHTML = ''; this.el.transferProofPreview.style.display = 'none'; }
    if (this.el.transferUploadEmpty) this.el.transferUploadEmpty.style.display = '';
    this.updateTransferSubmitState();
  },

  removeTransferObjectUrl() {
    if (this.selectedTransferFileUrl) {
      URL.revokeObjectURL(this.selectedTransferFileUrl);
      this.selectedTransferFileUrl = null;
    }
  },

  parseTransferAmount() {
    const digits = String(this.el.transferAmountInput?.value || '').replace(/\D/g, '');
    return digits ? Number(digits) : 0;
  },

  updateTransferSubmitState() {
    const btn = this.el.transferSubmitBtn;
    if (!btn) return;
    const blocked     = this.isFormBlocked();
    const amount      = this.parseTransferAmount();
    const branchId    = this.el.transferToBranch?.value || '';
    const amountErr   = this.el.transferAmountError;

    let msg = '';
    if (amount <= 0) {
      msg = '';
    } else if (blocked) {
      msg = '';
    } else if (amount > this.depositableCash) {
      msg = `Melebihi kas yang dapat disetor (${typeof fRp === 'function' ? fRp(this.depositableCash) : this.depositableCash})`;
    }
    // Transfer antar outlet tidak wajib kelipatan Rp 50.000
    if (amountErr) { amountErr.textContent = msg; amountErr.classList.toggle('show', Boolean(msg)); }

    const valid   = !blocked && amount > 0 && !msg && branchId;
    btn.disabled  = this.isTransferSubmitting || !valid;
  },

  async onTransferSubmit() {
    if (this.isTransferSubmitting) return;
    const pos = this.getPOS();
    if (!pos?.branch) { if (typeof showToast === 'function') showToast('Cabang belum dipilih', 'error'); return; }
    if (!this.hasEligibleClosedShift()) {
      if (typeof showToast === 'function') showToast('Tutup shift terlebih dahulu sebelum membuat setoran antar outlet', 'error');
      return;
    }
    const sess = this.selectedClosedSession;
    if (sess?.block_reason) { if (typeof showToast === 'function') showToast(sess.block_reason, 'error'); return; }

    const amount   = this.parseTransferAmount();
    const branchId = this.el.transferToBranch?.value || '';
    if (!branchId) { if (typeof showToast === 'function') showToast('Pilih outlet tujuan', 'error'); return; }

    if (amount <= 0) { if (typeof showToast === 'function') showToast('Jumlah setoran harus lebih dari 0', 'error'); return; }
    // Transfer antar outlet tidak wajib kelipatan Rp 50.000
    if (amount > this.depositableCash) {
      if (typeof showToast === 'function') showToast(`Melebihi kas yang dapat disetor (${typeof fRp === 'function' ? fRp(this.depositableCash) : this.depositableCash})`, 'error');
      return;
    }

    const branchName = this.el.transferToBranch?.options[this.el.transferToBranch.selectedIndex]?.text || branchId;
    const ok = await this.showTransferConfirm({ amount, branchName });
    if (!ok) return;

    this.isTransferSubmitting = true;
    if (this.el.transferSubmitBtn) {
      this.el.transferSubmitBtn.disabled = true;
      this.el.transferSubmitBtn.innerHTML = '<span class="btn-spinner"></span><span>Mengirim...</span>';
    }

    try {
      const clientRequestId = `tr-${Date.now()}-${Math.random().toString(36).slice(2)}`;
      const result = await cashBranchTransferService.createTransfer({
        fromBranchId:    pos.branch.id,
        toBranchId:      branchId,
        sessionId:       sess.session_id,
        staffId:         pos.user.id,
        amount,
        notes:           this.el.transferNotesInput?.value?.trim() || null,
        proofFile:       this.selectedTransferFile || null,
        clientRequestId
      });

      // Reset form
      if (this.el.transferAmountInput) this.el.transferAmountInput.value = '';
      if (this.el.transferToBranch)    this.el.transferToBranch.value = '';
      if (this.el.transferNotesInput)  this.el.transferNotesInput.value = '';
      this.removeTransferFile();

      // Show success
      const code = result?.transfer_code || '';
      if (this.el.transferSuccess) {
        this.el.transferSuccess.style.display = '';
        this.el.transferSuccess.innerHTML = `
          <i data-lucide="check-circle-2" class="icon-lg"></i>
          <div>
            <strong>Setoran ke ${this.esc(branchName)} berhasil dikirim</strong>
            <span>Menunggu approval staff ${this.esc(branchName)}. Kode: ${this.esc(code)}</span>
          </div>`;
        setTimeout(() => { if (this.el.transferSuccess) this.el.transferSuccess.style.display = 'none'; }, 8000);
        if (window.lucide) window.requestAnimationFrame(() => lucide.createIcons());
      }
      if (typeof showToast === 'function') showToast(result?.message || `Transfer ke ${branchName} dikirim. Kode: ${code}`, 'success');

      // Refresh data
      await this.refresh();
      if (window.RBNDataEvents) RBNDataEvents.publish('cash:changed', { source: 'deposit-transfer' });

    } catch (e) {
      if (typeof showToast === 'function') showToast(e.message || 'Gagal membuat transfer antar outlet', 'error');
    } finally {
      this.isTransferSubmitting = false;
      if (this.el.transferSubmitBtn) {
        this.el.transferSubmitBtn.innerHTML = '<i data-lucide="send" class="icon-sm"></i><span>Kirim ke Outlet</span>';
        if (window.lucide) window.requestAnimationFrame(() => lucide.createIcons());
      }
      this.updateTransferSubmitState();
    }
  },

  showTransferConfirm({ amount, branchName }) {
    return new Promise(resolve => {
      const overlay = document.createElement('div');
      overlay.className = 'deposit-confirm-overlay';
      overlay.innerHTML = `
        <div class="deposit-confirm-modal" role="dialog" aria-modal="true">
          <div class="deposit-confirm-header">
            <div>
              <div class="deposit-confirm-kicker">Konfirmasi Transfer Outlet</div>
              <h3>Periksa data sebelum dikirim</h3>
            </div>
            <button type="button" class="deposit-confirm-close" aria-label="Batalkan">
              <i data-lucide="x" class="icon-sm"></i>
            </button>
          </div>
          <div class="deposit-confirm-body">
            <div class="deposit-confirm-amount">${this.esc(typeof fRp === 'function' ? fRp(amount) : 'Rp' + amount)}</div>
            <div class="deposit-confirm-summary">
              <div><span>Ke Outlet</span><strong>${this.esc(branchName)}</strong></div>
              <div><span>Kas Dapat Disetor</span><strong>${this.esc(typeof fRp === 'function' ? fRp(this.depositableCash) : this.depositableCash)}</strong></div>
              <div><span>Sisa Setelah Transfer</span><strong>${this.esc(typeof fRp === 'function' ? fRp(this.depositableCash - amount) : (this.depositableCash - amount))}</strong></div>
            </div>
            <p style="font-size:13px;color:var(--text-muted);margin:12px 0 0">
              Transfer akan menunggu konfirmasi dari staff ${this.esc(branchName)}.
              Saldo outlet belum berubah sampai disetujui.
            </p>
          </div>
          <div class="deposit-confirm-footer">
            <button type="button" class="btn btn-outline deposit-confirm-cancel">Batalkan</button>
            <button type="button" class="btn btn-primary deposit-confirm-ok">Kirim ke Outlet</button>
          </div>
        </div>`;
      document.body.appendChild(overlay);
      requestAnimationFrame(() => overlay.classList.add('active'));
      if (window.lucide) window.requestAnimationFrame(() => lucide.createIcons());
      const ac = new AbortController();
      const close = result => { ac.abort(); overlay.classList.remove('active'); setTimeout(() => overlay.remove(), 180); resolve(result); };
      let okClicked = false;
      overlay.querySelector('.deposit-confirm-ok')?.addEventListener('click', () => {
        if (okClicked) return; okClicked = true;
        overlay.querySelector('.deposit-confirm-ok').disabled = true;
        close(true);
      }, { signal: ac.signal });
      overlay.querySelector('.deposit-confirm-cancel')?.addEventListener('click', () => close(false), { signal: ac.signal });
      overlay.querySelector('.deposit-confirm-close')?.addEventListener('click', () => close(false), { signal: ac.signal });
      overlay.addEventListener('click', e => { if (e.target === overlay) close(false); }, { signal: ac.signal });
      document.addEventListener('keydown', e => { if (e.key === 'Escape') close(false); }, { signal: ac.signal });
      setTimeout(() => overlay.querySelector('.deposit-confirm-ok')?.focus(), 80);
    });
  },

  // ── Incoming Transfers (Setoran Masuk / Approval) ─────────────────────

  async loadIncoming() {
    const pos = this.getPOS();
    if (!pos?.branch || !pos?.user) return;

    if (this.el.incomingBody) {
      this.el.incomingBody.innerHTML = '<div class="deposit-history-loading">Memuat...</div>';
    }

    try {
      const items = await cashBranchTransferService.getPendingIncoming({
        branchId: pos.branch.id,
        userId:   pos.user.id
      });
      this.renderIncoming(items);
    } catch (e) {
      if (this.el.incomingBody) {
        this.el.incomingBody.innerHTML = `<div class="deposit-incoming-item" style="color:var(--danger)">Gagal memuat: ${this.esc(e.message || e)}</div>`;
      }
    }
  },

  renderIncoming(items) {
    const section = this.el.incomingSection;
    const body    = this.el.incomingBody;
    const badge   = this.el.incomingBadge;
    if (!section || !body) return;

    // Selalu tampilkan section (walau kosong) agar staff tahu ada panel ini
    section.style.display = '';

    if (!items || !items.length) {
      body.innerHTML = `
        <div class="deposit-incoming-item" style="text-align:center;color:var(--text-muted);padding:16px 16px">
          <i data-lucide="inbox" style="width:24px;height:24px;display:block;margin:0 auto 6px"></i>
          Belum ada setoran masuk yang menunggu approval.
        </div>`;
      if (badge) badge.style.display = 'none';
      if (window.lucide) window.requestAnimationFrame(() => lucide.createIcons());
      return;
    }

    if (badge) { badge.style.display = ''; badge.textContent = items.length; }

    body.innerHTML = items.map(item => {
      const proofUrl = depositService.normalizeProofUrl(item.proof_url);
      const proofHtml = proofUrl
        ? `<a class="deposit-incoming-proof" href="${this.esc(proofUrl)}" target="_blank" rel="noopener">Lihat Bukti</a>`
        : '';
      return `
        <div class="deposit-incoming-item">
          <div class="deposit-incoming-meta">
            <span class="deposit-incoming-amount">${this.esc(typeof fRp === 'function' ? fRp(item.amount) : 'Rp' + item.amount)}</span>
            <span class="badge badge-warning">Menunggu</span>
          </div>
          <div class="deposit-incoming-from">
            Dari <strong>${this.esc(item.from_branch_name || '-')}</strong>
            &mdash; ${this.esc(item.staff_name || '-')}
            &mdash; ${this.esc(this.formatDateTime(item.requested_at))}
          </div>
          ${item.notes ? `<div style="font-size:12px;color:var(--text-muted)">${this.esc(item.notes)}</div>` : ''}
          ${proofHtml}
          <div class="deposit-incoming-actions">
            <button class="btn btn-success btn-sm" data-incoming-action="approve" data-transfer-id="${this.esc(item.transfer_id)}" data-from-branch="${this.esc(item.from_branch_name)}" data-amount="${this.esc(item.amount)}">
              <i data-lucide="check" class="icon-sm"></i> Terima
            </button>
            <button class="btn btn-outline btn-sm" style="border-color:var(--danger);color:var(--danger)" data-incoming-action="reject" data-transfer-id="${this.esc(item.transfer_id)}" data-from-branch="${this.esc(item.from_branch_name)}" data-amount="${this.esc(item.amount)}">
              <i data-lucide="x" class="icon-sm"></i> Tolak
            </button>
          </div>
        </div>`;
    }).join('');

    // Bind action buttons
    body.querySelectorAll('[data-incoming-action]').forEach(btn => {
      btn.addEventListener('click', () => {
        const action     = btn.dataset.incomingAction;
        const transferId = btn.dataset.transferId;
        const fromBranch = btn.dataset.fromBranch;
        const amount     = Number(btn.dataset.amount);
        if (action === 'approve') this.onApproveIncoming(transferId, fromBranch, amount);
        if (action === 'reject')  this.onRejectIncoming(transferId, fromBranch, amount);
      });
    });

    if (window.lucide) window.requestAnimationFrame(() => lucide.createIcons());
  },

  async onApproveIncoming(transferId, fromBranch, amount) {
    const pos = this.getPOS();
    if (!pos?.user) return;

    const amountFmt = typeof fRp === 'function' ? fRp(amount) : 'Rp' + amount;
    const confirmed = window.confirm(
      `Terima setoran ${amountFmt} dari ${fromBranch}?\n\nPastikan uang fisik sudah Anda terima sebelum konfirmasi.`
    );
    if (!confirmed) return;

    try {
      const result = await cashBranchTransferService.confirmTransfer({
        transferId,
        userId: pos.user.id
      });
      if (typeof showToast === 'function') showToast(
        result?.message || `Setoran diterima. Kas outlet bertambah ${amountFmt}.`,
        'success'
      );
      await this.loadIncoming();
      if (window.RBNDataEvents) RBNDataEvents.publish('cash:changed', { source: 'deposit-transfer-approve' });
    } catch (e) {
      if (typeof showToast === 'function') showToast(e.message || 'Gagal konfirmasi transfer', 'error');
    }
  },

  async onRejectIncoming(transferId, fromBranch, amount) {
    const pos = this.getPOS();
    if (!pos?.user) return;

    const reason = window.prompt(
      `Tolak setoran dari ${fromBranch}?\n\nMasukkan alasan penolakan (wajib):`
    );
    if (!reason || reason.trim().length < 3) {
      if (reason !== null) {
        if (typeof showToast === 'function') showToast('Alasan wajib diisi minimal 3 karakter', 'error');
      }
      return;
    }

    try {
      await cashBranchTransferService.rejectTransfer({
        transferId,
        userId: pos.user.id,
        reason: reason.trim()
      });
      if (typeof showToast === 'function') showToast('Transfer ditolak. Saldo tidak berubah.', 'info');
      await this.loadIncoming();
      if (window.RBNDataEvents) RBNDataEvents.publish('cash:changed', { source: 'deposit-transfer-reject' });
    } catch (e) {
      if (typeof showToast === 'function') showToast(e.message || 'Gagal menolak transfer', 'error');
    }
  }
};

window.depositUi = depositUi;
depositUi.init();
