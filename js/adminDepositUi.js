'use strict';

const adminDepositUi = {
  el: {},
  branches: [],
  accounts: [],
  selectedQrisFile: null,

  init() {
    document.addEventListener('DOMContentLoaded', async () => {
      try {
        const adm = auth.requireRole('admin');
        if (!adm) return;
        this.bindElements();
        await this.loadBranches();
        await this.loadAccounts();
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
    this.el.addAccountBtn = document.getElementById('btn-add-deposit-account');

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
    if (this.el.addAccountBtn) this.el.addAccountBtn.addEventListener('click', () => this.openAccountModal());
    if (this.el.accountType) this.el.accountType.addEventListener('change', () => this.toggleAccountTypeFields());
    if (this.el.qrisFile) this.el.qrisFile.addEventListener('change', e => this.handleQrisFile(e.target.files));
    if (this.el.qrisImageUrl) this.el.qrisImageUrl.addEventListener('input', () => this.renderQrisPreview(this.el.qrisImageUrl.value));
    if (this.el.saveAccountBtn) this.el.saveAccountBtn.addEventListener('click', () => this.saveAccount());
  },

  async loadBranches() {
    const { data: branches, error } = await db.from('branches').select('*').order('name');
    if (error) return;
    this.branches = branches || [];
    const options = this.branches.map(b => `<option value="${b.id}">${escHtml(b.name)}</option>`).join('');
    if (this.el.branch) this.el.branch.innerHTML = '<option value="">Semua Cabang</option>' + options;
  },

  async loadDeposits() {
    if (!this.el.tableBody) return;
    const branchId = this.el.branch?.value || null;
    const status = this.el.status?.value || null;
    const dateFrom = this.el.dateFrom?.value || null;
    const dateTo = this.el.dateTo?.value || null;
    try {
      const rows = await depositService.getAllDeposits({ branchId, status, dateFrom, dateTo, limit: 200 });
      if (!rows || !rows.length) {
        this.el.tableBody.innerHTML = '<tr><td colspan="9" class="empty-td">Tidak ada data</td></tr>';
        return;
      }
      this.el.tableBody.innerHTML = rows.map(r => {
        const date = fDate(r.created_at);
        const staff = r.staff?.name || '-';
        const br = r.branches?.name || '-';
        const method = r.deposit_accounts?.label || '-';
        const proof = r.proof_url ? `<a href="${r.proof_url}" target="_blank">Bukti</a>` : '-';
        const statusBadge = r.status === 'pending'
          ? '<span class="badge badge-warning">pending</span>'
          : (r.status === 'confirmed' ? '<span class="badge badge-success">confirmed</span>' : '<span class="badge badge-danger">rejected</span>');
        const actions = r.status === 'pending' ? `
          <button class="btn btn-success btn-sm" data-action="confirm-deposit" data-id="${r.id}">Konfirmasi</button>
          <button class="btn btn-danger btn-sm" data-action="reject-deposit" data-id="${r.id}">Tolak</button>
        ` : '';
        return `<tr>
          <td>${escHtml(r.id)}</td>
          <td>${date}</td>
          <td>${escHtml(staff)}</td>
          <td>${escHtml(br)}</td>
          <td>${fRp(r.amount)}</td>
          <td>${fRp(r.cash_balance_at_deposit)}</td>
          <td>${escHtml(method)}</td>
          <td>${proof}</td>
          <td>${statusBadge} ${actions}</td>
        </tr>`;
      }).join('');

      this.el.tableBody.querySelectorAll('[data-action="confirm-deposit"]').forEach(btn => btn.addEventListener('click', e => this.handleConfirm(e)));
      this.el.tableBody.querySelectorAll('[data-action="reject-deposit"]').forEach(btn => btn.addEventListener('click', e => this.handleReject(e)));
    } catch (e) {
      console.error('loadDeposits', e);
      showToast('Gagal memuat setoran', 'error');
    }
  },

  async handleConfirm(e) {
    const id = e.currentTarget.dataset.id;
    const ok = await showConfirm({
      title: 'Konfirmasi Setoran',
      message: 'Konfirmasi setoran ini? Setelah dikonfirmasi, kas akan berkurang.',
      confirmText: 'Konfirmasi'
    });
    if (!ok) return;
    try {
      const adminId = auth.getSession()?.id || null;
      await depositService.confirmDeposit({ depositId: id, adminId, action: 'confirmed' });
      showToast('Setoran dikonfirmasi', 'success');
      await this.loadDeposits();
    } catch (err) {
      showToast(err.message || 'Gagal konfirmasi', 'error');
    }
  },

  async handleReject(e) {
    const id = e.currentTarget.dataset.id;
    const reason = await showPrompt({ title: 'Tolak Setoran', placeholder: 'Alasan penolakan (opsional)' });
    if (reason === null) return;
    try {
      const adminId = auth.getSession()?.id || null;
      await depositService.confirmDeposit({ depositId: id, adminId, action: 'rejected', rejectReason: reason || null });
      showToast('Setoran ditolak', 'success');
      await this.loadDeposits();
    } catch (err) {
      showToast(err.message || 'Gagal menolak', 'error');
    }
  },

  async loadAccounts() {
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
      if (this.el.accountsList) this.el.accountsList.innerHTML = `<div class="text-danger p-4">Gagal memuat metode setoran: ${escHtml(e.message || '')}</div>`;
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
      showToast(e.message || 'Gagal menyimpan metode setoran', 'error');
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
      showToast('Gagal mengubah status rekening', 'error');
    }
  }
};

window.adminDepositUi = adminDepositUi;
adminDepositUi.init();
