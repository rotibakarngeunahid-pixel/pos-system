'use strict';

const adminDepositUi = {
  el: {},

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

    if (this.el.btnFilter) this.el.btnFilter.addEventListener('click', () => this.loadDeposits());
  },

  async loadBranches() {
    const { data: branches, error } = await db.from('branches').select('*').order('name');
    if (error) return;
    if (!this.el.branch) return;
    this.el.branch.innerHTML = '<option value="">Semua Cabang</option>' + (branches || []).map(b => `<option value="${b.id}">${escHtml(b.name)}</option>`).join('');
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
        const statusBadge = r.status === 'pending' ? '<span class="badge badge-warning">pending</span>' : (r.status === 'confirmed' ? '<span class="badge badge-success">confirmed</span>' : '<span class="badge badge-danger">rejected</span>');
        const actions = r.status === 'pending' ? (`
          <button class="btn btn-success btn-sm" data-action="confirm-deposit" data-id="${r.id}">✅</button>
          <button class="btn btn-danger btn-sm" data-action="reject-deposit" data-id="${r.id}">❌</button>
        `) : '';
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

      // Attach action handlers
      this.el.tableBody.querySelectorAll('[data-action="confirm-deposit"]').forEach(btn => btn.addEventListener('click', e => this.handleConfirm(e)));
      this.el.tableBody.querySelectorAll('[data-action="reject-deposit"]').forEach(btn => btn.addEventListener('click', e => this.handleReject(e)));

    } catch (e) {
      console.error('loadDeposits', e);
      showToast('Gagal memuat setoran', 'error');
    }
  },

  async handleConfirm(e) {
    const id = e.currentTarget.dataset.id;
    const ok = await showConfirm({ title: 'Konfirmasi Setoran', message: 'Konfirmasi setoran ini? Setelah dikonfirmasi, kas akan berkurang.' });
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
    if (reason === null) return; // cancelled
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
      const list = data || [];
      if (!this.el.accountsList) return;
      this.el.accountsList.innerHTML = list.map(a => `
        <div class="card p-3 mb-2">
          <div style="display:flex;justify-content:space-between;align-items:center;">
            <div>
              <div style="font-weight:700">${escHtml(a.label)}</div>
              <div class="text-xs text-muted">${escHtml(a.type)} ${a.bank_name ? '• ' + escHtml(a.bank_name) : ''}</div>
            </div>
            <div>
              <button class="btn btn-outline btn-sm" data-action="toggle-account" data-id="${a.id}">${a.is_active ? 'Nonaktifkan' : 'Aktifkan'}</button>
            </div>
          </div>
        </div>
      `).join('');
      this.el.accountsList.querySelectorAll('[data-action="toggle-account"]').forEach(btn => btn.addEventListener('click', ev => this.toggleAccount(ev)));
    } catch (e) {
      console.error('loadAccounts', e);
    }
  },

  async toggleAccount(ev) {
    const id = ev.currentTarget.dataset.id;
    try {
      const { data } = await db.from('deposit_accounts').select('*').eq('id', id).maybeSingle();
      if (!data) throw new Error('Rekening tidak ditemukan');
      const next = !data.is_active;
      await depositService.saveAccount({ id, branchId: data.branch_id, type: data.type, label: data.label, bankName: data.bank_name, accountNumber: data.account_number, accountHolder: data.account_holder, qrisImageUrl: data.qris_image_url, isActive: next });
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
