'use strict';

// ═══════════════════════════════════════════════════════════════
// RBN Admin Member UI — Tab "Member" di halaman admin
// Depends on: apiClient.js (db, API_BASE, API_KEY, getRbnSessionToken)
//             admin.js (showToast, escapeHtml, formatRupiah, fmt)
// ═══════════════════════════════════════════════════════════════
const adminMemberUi = (() => {

  // ── State ───────────────────────────────────────────────────
  let currentTab   = 'dashboard';
  let memberOffset = 0;
  const PAGE_SIZE  = 30;

  // ── API helpers ─────────────────────────────────────────────
  async function rpc(name, params = {}) {
    const { data, error } = await db.rpc(name, params);
    if (error) throw new Error(error.message || 'RPC gagal');
    return data;
  }

  // ── Main entry point ────────────────────────────────────────
  function load(tab) {
    if (tab) currentTab = tab;
    renderShell();
    switchTab(currentTab);
  }

  function renderShell() {
    const sec = document.getElementById('section-member');
    if (!sec) return;
    sec.innerHTML = `
      <div class="section-header">
        <h2 class="section-title">Member &amp; Loyalty</h2>
        <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
          <button class="btn btn-outline btn-sm" onclick="adminMemberUi.load()">
            <i data-lucide="refresh-cw" class="icon-sm"></i> Refresh
          </button>
        </div>
      </div>
      <div class="inner-tabs" id="member-subtabs" style="flex-wrap:wrap">
        ${['dashboard','members','rewards','settings','approvals','fraud'].map(t =>
          `<div class="inner-tab${t === currentTab ? ' active' : ''}" data-member-tab="${t}" onclick="adminMemberUi.switchTab('${t}')">${tabLabel(t)}</div>`
        ).join('')}
      </div>
      <div id="member-tab-content" style="margin-top:16px"></div>
    `;
    if (typeof lucide !== 'undefined') lucide.createIcons();
  }

  function tabLabel(t) {
    return { dashboard:'Dashboard', members:'Kelola Member', rewards:'Kelola Reward',
      settings:'Aturan Point', approvals:'Antrian Klaim', fraud:'Fraud Monitor' }[t] || t;
  }

  function switchTab(tab) {
    currentTab = tab;
    document.querySelectorAll('#member-subtabs .inner-tab').forEach(el => {
      el.classList.toggle('active', el.dataset.memberTab === tab);
    });
    const content = document.getElementById('member-tab-content');
    if (!content) return;
    content.innerHTML = '<div class="d-flex justify-center p-5"><div class="spinner-border text-primary"></div></div>' +
      '<style>.spinner-border{width:32px;height:32px;border:3px solid #e5e7eb;border-top-color:var(--primary);border-radius:50%;animation:spin .7s linear infinite}@keyframes spin{to{transform:rotate(360deg)}}</style>';
    switch (tab) {
      case 'dashboard':  loadDashboard();  break;
      case 'members':    loadMembers();    break;
      case 'rewards':    loadRewards();    break;
      case 'settings':   loadSettings();   break;
      case 'approvals':  loadApprovals();  break;
      case 'fraud':      loadFraud();      break;
    }
  }

  // ═══════════════════════════════════════════════════════════
  // TAB: Dashboard
  // ═══════════════════════════════════════════════════════════
  async function loadDashboard() {
    const content = document.getElementById('member-tab-content');
    try {
      const stats = await rpc('member_dashboard_stats');
      content.innerHTML = `
        <div class="stats-grid" style="margin-bottom:20px">
          ${statCard('Total Member', stats.total_members ?? 0, 'users')}
          ${statCard('Member Aktif Bulan Ini', stats.active_members_this_month ?? 0, 'user-check')}
          ${statCard('Total Point Beredar', (stats.total_points_active ?? 0).toLocaleString('id-ID'), 'trending-up')}
          ${statCard('Point Diklaim Bulan Ini', (stats.total_points_redeemed_month ?? 0).toLocaleString('id-ID'), 'gift')}
        </div>

        <div class="card mb-4">
          <div class="card-header"><span class="card-title">Top 10 Member (Point Tertinggi)</span></div>
          <div class="card-body p-0">
            ${topMembersTable(stats.top_members || [])}
          </div>
        </div>

        <div class="card">
          <div class="card-header"><span class="card-title">Top 5 Reward Terbanyak Diklaim</span></div>
          <div class="card-body p-0">
            ${topRewardsTable(stats.top_rewards || [])}
          </div>
        </div>
      `;
    } catch (e) {
      content.innerHTML = errHtml(e.message);
    }
    lucideRefresh();
  }

  function statCard(label, val, icon) {
    return `<div class="stat-card">
      <div class="mb-2"><div class="stat-icon-wrap"><i data-lucide="${icon}" class="icon"></i></div></div>
      <div class="stat-label">${label}</div>
      <div class="stat-value">${val}</div>
    </div>`;
  }

  function topMembersTable(rows) {
    if (!rows.length) return '<p class="p-3 text-muted small">Belum ada data</p>';
    return `<table class="table table-sm"><thead><tr><th>#</th><th>Nama</th><th>Kode</th><th>Point Aktif</th><th>Total Earn</th></tr></thead><tbody>
      ${rows.map((m, i) => `<tr>
        <td>${i + 1}</td>
        <td><a href="javascript:void(0)" onclick="adminMemberUi.openMemberDetail(${m.id})" class="link">${escapeHtml(m.name)}</a></td>
        <td><code>${escapeHtml(m.member_code)}</code></td>
        <td><b>${(m.balance_active ?? 0).toLocaleString('id-ID')}</b></td>
        <td>${(m.lifetime_points_earned ?? 0).toLocaleString('id-ID')}</td>
      </tr>`).join('')}
    </tbody></table>`;
  }

  function topRewardsTable(rows) {
    if (!rows.length) return '<p class="p-3 text-muted small">Belum ada data</p>';
    return `<table class="table table-sm"><thead><tr><th>#</th><th>Reward</th><th>Total Klaim</th><th>Cost (pt)</th></tr></thead><tbody>
      ${rows.map((r, i) => `<tr>
        <td>${i + 1}</td>
        <td>${escapeHtml(r.name)}</td>
        <td><b>${r.claim_count ?? 0}</b></td>
        <td>${r.cost_point}</td>
      </tr>`).join('')}
    </tbody></table>`;
  }

  // ═══════════════════════════════════════════════════════════
  // TAB: Members
  // ═══════════════════════════════════════════════════════════
  async function loadMembers(query = '', offset = 0) {
    memberOffset = offset;
    const content = document.getElementById('member-tab-content');
    try {
      const data = await rpc('member_admin_search', { query, limit: PAGE_SIZE, offset });
      const members = data?.members || [];
      const total   = data?.total ?? members.length;

      content.innerHTML = `
        <div style="display:flex;gap:8px;align-items:center;margin-bottom:12px;flex-wrap:wrap">
          <div class="search-wrap search-compact" style="flex:1;min-width:200px">
            <span class="search-icon"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/></svg></span>
            <input type="text" class="form-control" id="member-search-q" placeholder="Cari nama, HP, atau kode member..." value="${escapeHtml(query)}" />
          </div>
          <button class="btn btn-primary btn-sm" onclick="adminMemberUi._searchMembers()">
            <i data-lucide="search" class="icon-sm"></i> Cari
          </button>
          <button class="btn btn-outline btn-sm" onclick="adminMemberUi.openCreateMember()">
            <i data-lucide="user-plus" class="icon-sm"></i> Tambah Member
          </button>
        </div>

        <div class="card">
          <div class="card-body p-0">
            ${membersTable(members)}
          </div>
          ${total > PAGE_SIZE ? `
          <div class="card-footer" style="display:flex;justify-content:space-between;align-items:center;padding:10px 16px">
            <span class="small text-muted">Menampilkan ${offset + 1}–${Math.min(offset + PAGE_SIZE, total)} dari ${total}</span>
            <div style="display:flex;gap:6px">
              ${offset > 0 ? `<button class="btn btn-outline btn-sm" onclick="adminMemberUi.loadMembers('${escapeHtml(query)}',${offset - PAGE_SIZE})">← Sebelum</button>` : ''}
              ${offset + PAGE_SIZE < total ? `<button class="btn btn-outline btn-sm" onclick="adminMemberUi.loadMembers('${escapeHtml(query)}',${offset + PAGE_SIZE})">Berikutnya →</button>` : ''}
            </div>
          </div>` : ''}
        </div>
      `;
    } catch (e) {
      content.innerHTML = errHtml(e.message);
    }
    lucideRefresh();

    document.getElementById('member-search-q')?.addEventListener('keydown', e => {
      if (e.key === 'Enter') adminMemberUi._searchMembers();
    });
  }

  function membersTable(rows) {
    if (!rows.length) return '<p class="p-3 text-muted small text-center">Tidak ada member ditemukan</p>';
    return `<div class="table-responsive"><table class="table table-sm">
      <thead><tr><th>Nama</th><th>Kode</th><th>HP</th><th>Point</th><th>Status</th><th>Bergabung</th><th style="width:100px">Aksi</th></tr></thead>
      <tbody>
      ${rows.map(m => `<tr>
        <td><a href="javascript:void(0)" onclick="adminMemberUi.openMemberDetail(${m.id})" class="link fw-600">${escapeHtml(m.name)}</a></td>
        <td><code class="small">${escapeHtml(m.member_code)}</code></td>
        <td>${escapeHtml(m.phone || '-')}</td>
        <td>${(m.balance_active ?? 0).toLocaleString('id-ID')}</td>
        <td><span class="badge ${m.is_active ? 'badge-success' : 'badge-danger'}">${m.is_active ? 'Aktif' : 'Nonaktif'}</span></td>
        <td class="small text-muted">${fmtDate(m.created_at)}</td>
        <td>
          <button class="btn btn-ghost btn-sm" onclick="adminMemberUi.openMemberDetail(${m.id})" title="Detail"><i data-lucide="eye" class="icon-sm"></i></button>
          <button class="btn btn-ghost btn-sm" onclick="adminMemberUi.toggleActive(${m.id},${m.is_active})" title="${m.is_active ? 'Nonaktifkan' : 'Aktifkan'}">
            <i data-lucide="${m.is_active ? 'user-x' : 'user-check'}" class="icon-sm"></i>
          </button>
        </td>
      </tr>`).join('')}
      </tbody>
    </table></div>`;
  }

  // Member detail modal
  async function openMemberDetail(memberId) {
    showModal('modal-member-detail', '<div class="p-4 text-center"><div class="spinner-border"></div></div><style>.spinner-border{width:32px;height:32px;border:3px solid #e5e7eb;border-top-color:var(--primary);border-radius:50%;animation:spin .7s linear infinite}@keyframes spin{to{transform:rotate(360deg)}}</style>');
    try {
      const data = await rpc('member_admin_get_detail', { member_id: memberId });
      renderMemberDetail(data);
    } catch (e) {
      document.getElementById('modal-member-detail-body').innerHTML = errHtml(e.message);
    }
    lucideRefresh();
  }

  function renderMemberDetail(d) {
    const m    = d.member;
    const bal  = d.balance || { active: 0, pending: 0 };
    const body = document.getElementById('modal-member-detail-body');
    if (!body) return;

    body.innerHTML = `
      <!-- Member summary -->
      <div style="display:flex;gap:12px;flex-wrap:wrap;margin-bottom:16px">
        <div style="flex:1;min-width:180px">
          <div class="fw-700 text-lg">${escapeHtml(m.name)}</div>
          <div class="small text-muted">${escapeHtml(m.member_code)} · ${escapeHtml(m.phone)}</div>
          ${m.email ? `<div class="small text-muted">${escapeHtml(m.email)}</div>` : ''}
          <div class="mt-1">
            <span class="badge ${m.is_active ? 'badge-success' : 'badge-danger'}">${m.is_active ? 'Aktif' : 'Nonaktif'}</span>
            ${m.staff_link_user_id ? '<span class="badge badge-warning ml-1">Staff Link</span>' : ''}
          </div>
        </div>
        <div style="text-align:right;flex-shrink:0">
          <div style="font-size:28px;font-weight:800;color:var(--primary)">${bal.active.toLocaleString('id-ID')}</div>
          <div class="small text-muted">Point Aktif</div>
          ${bal.pending > 0 ? `<div class="small" style="color:var(--warning)">${bal.pending.toLocaleString('id-ID')} pending</div>` : ''}
        </div>
      </div>

      <!-- Action buttons -->
      <div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:16px">
        <button class="btn btn-outline btn-sm" onclick="adminMemberUi.openManualAdjust(${m.id})">
          <i data-lucide="plus-minus" class="icon-sm"></i> Sesuaikan Point
        </button>
        <button class="btn btn-outline btn-sm" onclick="adminMemberUi.openResetPassword(${m.id})">
          <i data-lucide="key" class="icon-sm"></i> Reset Password
        </button>
        <button class="btn btn-outline btn-sm ${m.is_active ? 'text-danger' : 'text-success'}" onclick="adminMemberUi.toggleActive(${m.id},${m.is_active});adminMemberUi.closeModal('modal-member-detail')">
          <i data-lucide="${m.is_active ? 'user-x' : 'user-check'}" class="icon-sm"></i> ${m.is_active ? 'Nonaktifkan' : 'Aktifkan'}
        </button>
      </div>

      <!-- Sub-tabs -->
      <div class="inner-tabs" style="margin-bottom:12px">
        <div class="inner-tab active" data-dtab="point-history" onclick="adminMemberUi._switchDetailTab(this,'point-history',${m.id})">Histori Point</div>
        <div class="inner-tab" data-dtab="tx-history" onclick="adminMemberUi._switchDetailTab(this,'tx-history',${m.id})">Transaksi</div>
        <div class="inner-tab" data-dtab="claims" onclick="adminMemberUi._switchDetailTab(this,'claims',${m.id})">Klaim</div>
        <div class="inner-tab" data-dtab="fraud-flags" onclick="adminMemberUi._switchDetailTab(this,'fraud-flags',${m.id})">Fraud Flags</div>
      </div>
      <div id="member-detail-sub-content">
        ${renderPointHistory(d.point_history || [])}
      </div>
    `;
    lucideRefresh();
  }

  async function _switchDetailTab(el, tab, memberId) {
    document.querySelectorAll('#modal-member-detail-body .inner-tab').forEach(t => t.classList.remove('active'));
    el.classList.add('active');
    const sub = document.getElementById('member-detail-sub-content');
    if (!sub) return;
    sub.innerHTML = '<div class="p-3 text-center text-muted small">Memuat...</div>';
    try {
      const data = await rpc('member_admin_get_detail', { member_id: memberId });
      switch (tab) {
        case 'point-history': sub.innerHTML = renderPointHistory(data.point_history || []); break;
        case 'tx-history':    sub.innerHTML = renderTxHistory(data.transactions || []); break;
        case 'claims':        sub.innerHTML = renderClaimHistory(data.claims || []); break;
        case 'fraud-flags':   sub.innerHTML = renderFraudFlags(data.fraud_flags || []); break;
      }
    } catch (e) {
      sub.innerHTML = errHtml(e.message);
    }
    lucideRefresh();
  }

  function renderPointHistory(entries) {
    if (!entries.length) return '<p class="p-3 text-muted small text-center">Belum ada histori point</p>';
    return `<div class="table-responsive"><table class="table table-sm">
      <thead><tr><th>Waktu</th><th>Tipe</th><th>Point</th><th>Aktif Sesudah</th><th>Alasan</th></tr></thead>
      <tbody>
      ${entries.map(e => `<tr>
        <td class="small text-muted">${fmtDateTime(e.created_at)}</td>
        <td><code class="small">${escapeHtml(e.movement_type)}</code></td>
        <td class="${e.direction === 'in' ? 'text-success fw-600' : 'text-danger fw-600'}">${e.direction === 'in' ? '+' : '-'}${e.points}</td>
        <td>${e.balance_active_after.toLocaleString('id-ID')}</td>
        <td class="small">${escapeHtml(e.reason || '-')}</td>
      </tr>`).join('')}
      </tbody>
    </table></div>`;
  }

  function renderTxHistory(txList) {
    if (!txList.length) return '<p class="p-3 text-muted small text-center">Belum ada transaksi</p>';
    return `<div class="table-responsive"><table class="table table-sm">
      <thead><tr><th>Waktu</th><th>Total</th><th>Point</th><th>Status</th></tr></thead>
      <tbody>
      ${txList.map(t => `<tr>
        <td class="small">${fmtDateTime(t.created_at)}</td>
        <td>${formatRupiah(t.total)}</td>
        <td class="text-success">${t.points_awarded > 0 ? '+' + t.points_awarded : '-'}</td>
        <td><span class="badge ${t.status === 'completed' ? 'badge-success' : 'badge-warning'}">${escapeHtml(t.status)}</span></td>
      </tr>`).join('')}
      </tbody>
    </table></div>`;
  }

  function renderClaimHistory(claims) {
    if (!claims.length) return '<p class="p-3 text-muted small text-center">Belum ada klaim reward</p>';
    return `<div class="table-responsive"><table class="table table-sm">
      <thead><tr><th>Reward</th><th>Kode</th><th>Status</th><th>Klaim</th><th>Kadaluarsa</th><th>Aksi</th></tr></thead>
      <tbody>
      ${claims.map(c => `<tr>
        <td>${escapeHtml(c.reward_name || '-')}</td>
        <td><code class="small">${escapeHtml(c.redemption_code)}</code></td>
        <td><span class="badge ${claimStatusBadge(c.status)}">${escapeHtml(c.status)}</span></td>
        <td class="small text-muted">${fmtDate(c.claimed_at)}</td>
        <td class="small">${fmtDate(c.expires_at)}</td>
        <td>
          ${c.status === 'pending_approval' ? `<button class="btn btn-primary btn-sm" onclick="adminMemberUi.approveClaim(${c.id})">Approve</button>` : ''}
          ${['redeemable','pending_approval'].includes(c.status) ? `<button class="btn btn-ghost btn-sm text-danger" onclick="adminMemberUi.voidClaim(${c.id})">Void</button>` : ''}
        </td>
      </tr>`).join('')}
      </tbody>
    </table></div>`;
  }

  function renderFraudFlags(flags) {
    if (!flags.length) return '<p class="p-3 text-muted small text-center">Tidak ada fraud flag</p>';
    return `<div class="table-responsive"><table class="table table-sm">
      <thead><tr><th>Tipe</th><th>Severity</th><th>Status</th><th>Deteksi</th></tr></thead>
      <tbody>
      ${flags.map(f => `<tr>
        <td><code class="small">${escapeHtml(f.flag_type)}</code></td>
        <td><span class="badge badge-${severityBadge(f.severity)}">${escapeHtml(f.severity)}</span></td>
        <td>${escapeHtml(f.status)}</td>
        <td class="small text-muted">${fmtDateTime(f.detected_at)}</td>
      </tr>`).join('')}
      </tbody>
    </table></div>`;
  }

  // Manual adjust modal
  function openManualAdjust(memberId) {
    showModal('modal-manual-adjust', `
      <div class="form-group mb-3">
        <label class="form-label">Jumlah Point <span style="color:var(--danger)">*</span></label>
        <input type="number" class="form-control" id="adj-amount" placeholder="Positif = tambah, negatif = kurang" />
      </div>
      <div class="form-group">
        <label class="form-label">Alasan <span style="color:var(--danger)">*</span></label>
        <textarea class="form-control" id="adj-reason" rows="2" placeholder="Contoh: Koreksi poin, promosi ulang tahun..."></textarea>
      </div>
    `, `<button class="btn btn-primary" onclick="adminMemberUi._submitManualAdjust(${memberId})">Simpan</button>`);
  }

  async function _submitManualAdjust(memberId) {
    const amount = parseInt(document.getElementById('adj-amount')?.value || '0');
    const reason = document.getElementById('adj-reason')?.value?.trim();
    if (!amount) { showToast('Jumlah point wajib diisi', 'error'); return; }
    if (!reason) { showToast('Alasan wajib diisi', 'error'); return; }
    try {
      await rpc('member_admin_manual_adjust', { member_id: memberId, points: amount, reason });
      closeModal('modal-manual-adjust');
      showToast('Point berhasil disesuaikan', 'success');
      openMemberDetail(memberId);
    } catch (e) { showToast(e.message, 'error'); }
  }

  function openResetPassword(memberId) {
    showModal('modal-reset-pw', `
      <p class="mb-3 small text-muted">Password member akan direset ke password sementara yang bisa dikomunikasikan ke member.</p>
      <div class="form-group">
        <label class="form-label">Password Baru <span style="color:var(--danger)">*</span></label>
        <input type="text" class="form-control" id="reset-pw-val" placeholder="Min. 6 karakter" />
      </div>
    `, `<button class="btn btn-primary" onclick="adminMemberUi._submitResetPw(${memberId})">Reset Password</button>`);
  }

  async function _submitResetPw(memberId) {
    const pw = document.getElementById('reset-pw-val')?.value?.trim();
    if (!pw || pw.length < 6) { showToast('Password minimal 6 karakter', 'error'); return; }
    try {
      await rpc('member_admin_reset_password', { member_id: memberId, new_password: pw });
      closeModal('modal-reset-pw');
      showToast('Password berhasil direset', 'success');
    } catch (e) { showToast(e.message, 'error'); }
  }

  async function toggleActive(memberId, isActive) {
    if (!confirm(`${isActive ? 'Nonaktifkan' : 'Aktifkan kembali'} member ini?`)) return;
    try {
      await rpc('member_admin_set_active', { member_id: memberId, is_active: !isActive });
      showToast('Status member diperbarui', 'success');
      loadMembers();
    } catch (e) { showToast(e.message, 'error'); }
  }

  function openCreateMember() {
    showModal('modal-create-member', `
      <div class="form-group mb-3">
        <label class="form-label">Nama <span style="color:var(--danger)">*</span></label>
        <input type="text" class="form-control" id="cm-name" />
      </div>
      <div class="form-group mb-3">
        <label class="form-label">Nomor HP <span style="color:var(--danger)">*</span></label>
        <input type="tel" class="form-control" id="cm-phone" placeholder="08xxxxxxxxxx" />
      </div>
      <div class="form-group mb-3">
        <label class="form-label">Email <span style="color:var(--text-muted)">(opsional)</span></label>
        <input type="email" class="form-control" id="cm-email" />
      </div>
      <div class="form-group">
        <label class="form-label">Password Awal <span style="color:var(--danger)">*</span></label>
        <input type="text" class="form-control" id="cm-pw" placeholder="Min. 6 karakter" />
      </div>
    `, `<button class="btn btn-primary" onclick="adminMemberUi._submitCreateMember()">Buat Member</button>`);
  }

  async function _submitCreateMember() {
    const name  = document.getElementById('cm-name')?.value?.trim();
    const phone = document.getElementById('cm-phone')?.value?.trim();
    const email = document.getElementById('cm-email')?.value?.trim();
    const pw    = document.getElementById('cm-pw')?.value?.trim();
    if (!name || !phone || !pw || pw.length < 6) {
      showToast('Nama, HP, dan password (min. 6 karakter) wajib diisi', 'error');
      return;
    }
    try {
      const params = { name, phone, password: pw };
      if (email) params.email = email;
      await rpc('member_admin_create', params);
      closeModal('modal-create-member');
      showToast('Member berhasil dibuat', 'success');
      loadMembers();
    } catch (e) { showToast(e.message, 'error'); }
  }

  // ═══════════════════════════════════════════════════════════
  // TAB: Rewards
  // ═══════════════════════════════════════════════════════════
  async function loadRewards() {
    const content = document.getElementById('member-tab-content');
    try {
      const { data, error } = await db.from('member_rewards')
        .select('*')
        .is('deleted_at', null)
        .order('created_at', { ascending: false });
      if (error) throw new Error(error.message);
      const rewards = data || [];

      content.innerHTML = `
        <div style="display:flex;justify-content:flex-end;margin-bottom:12px">
          <button class="btn btn-primary btn-sm" onclick="adminMemberUi.openCreateReward()">
            <i data-lucide="plus" class="icon-sm"></i> Buat Reward Baru
          </button>
        </div>
        <div class="card">
          <div class="card-body p-0">
            ${rewardsTable(rewards)}
          </div>
        </div>
      `;
    } catch (e) {
      content.innerHTML = errHtml(e.message);
    }
    lucideRefresh();
  }

  function rewardsTable(rows) {
    if (!rows.length) return '<p class="p-3 text-muted small text-center">Belum ada reward. Buat reward pertama!</p>';
    const typeLabel = { free_product:'Produk Gratis', discount_amount:'Diskon Nominal', discount_percent:'Diskon %', other:'Lainnya' };
    return `<div class="table-responsive"><table class="table table-sm">
      <thead><tr><th>Nama</th><th>Tipe</th><th>Cost (pt)</th><th>Kuota</th><th>Valid Sampai</th><th>Status</th><th>Aksi</th></tr></thead>
      <tbody>
      ${rows.map(r => `<tr>
        <td class="fw-600">${escapeHtml(r.name)}</td>
        <td class="small">${typeLabel[r.reward_type] || r.reward_type}</td>
        <td>${r.cost_point}</td>
        <td>${r.quota_total != null ? r.quota_used + '/' + r.quota_total : '∞'}</td>
        <td class="small text-muted">${r.valid_until ? fmtDate(r.valid_until) : '—'}</td>
        <td><span class="badge ${r.is_active ? 'badge-success' : 'badge-neutral'}">${r.is_active ? 'Aktif' : 'Nonaktif'}</span></td>
        <td style="white-space:nowrap">
          <button class="btn btn-ghost btn-sm" onclick="adminMemberUi.openEditReward(${r.id})" title="Edit"><i data-lucide="edit" class="icon-sm"></i></button>
          <button class="btn btn-ghost btn-sm" onclick="adminMemberUi.toggleRewardActive(${r.id},${r.is_active})" title="${r.is_active ? 'Nonaktifkan' : 'Aktifkan'}">
            <i data-lucide="${r.is_active ? 'eye-off' : 'eye'}" class="icon-sm"></i>
          </button>
        </td>
      </tr>`).join('')}
      </tbody>
    </table></div>`;
  }

  function openCreateReward() {
    showModal('modal-reward-form', rewardFormHtml({}),
      `<button class="btn btn-primary" onclick="adminMemberUi._submitRewardForm()">Simpan Reward</button>`);
    document.getElementById('rf-title').textContent = 'Buat Reward Baru';
  }

  async function openEditReward(rewardId) {
    showModal('modal-reward-form', '<div class="p-3 text-center text-muted small">Memuat...</div>');
    const { data, error } = await db.from('member_rewards').select('*').eq('id', rewardId).maybeSingle();
    if (error || !data) { document.getElementById('modal-reward-form-body').innerHTML = errHtml('Reward tidak ditemukan'); return; }
    document.getElementById('modal-reward-form-body').innerHTML = rewardFormHtml(data);
    document.getElementById('rf-title').textContent = 'Edit Reward';
    document.getElementById('rf-id').value = rewardId;
    lucideRefresh();
  }

  function rewardFormHtml(r) {
    const typeLabel = { free_product:'Produk Gratis', discount_amount:'Diskon Nominal', discount_percent:'Diskon %', other:'Lainnya' };
    return `
      <input type="hidden" id="rf-id" value="${r.id || ''}" />
      <div class="form-group mb-3">
        <label class="form-label">Nama Reward <span style="color:var(--danger)">*</span></label>
        <input type="text" class="form-control" id="rf-name" value="${escapeHtml(r.name || '')}" />
      </div>
      <div class="form-group mb-3">
        <label class="form-label">Deskripsi</label>
        <textarea class="form-control" id="rf-desc" rows="2">${escapeHtml(r.description || '')}</textarea>
      </div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:12px">
        <div class="form-group">
          <label class="form-label">Tipe Reward <span style="color:var(--danger)">*</span></label>
          <select class="form-control" id="rf-type">
            ${Object.entries(typeLabel).map(([k,v]) => `<option value="${k}" ${r.reward_type === k ? 'selected' : ''}>${v}</option>`).join('')}
          </select>
        </div>
        <div class="form-group">
          <label class="form-label">Cost (point) <span style="color:var(--danger)">*</span></label>
          <input type="number" class="form-control" id="rf-cost" value="${r.cost_point || ''}" min="1" />
        </div>
      </div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:12px">
        <div class="form-group">
          <label class="form-label">Nilai Diskon</label>
          <input type="number" class="form-control" id="rf-discount-val" value="${r.discount_value || ''}" placeholder="Nominal atau %" />
        </div>
        <div class="form-group">
          <label class="form-label">Kuota Total</label>
          <input type="number" class="form-control" id="rf-quota" value="${r.quota_total != null ? r.quota_total : ''}" placeholder="Kosong = tidak terbatas" />
        </div>
      </div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:12px">
        <div class="form-group">
          <label class="form-label">Berlaku Dari</label>
          <input type="datetime-local" class="form-control" id="rf-valid-from" value="${r.valid_from ? r.valid_from.slice(0,16) : ''}" />
        </div>
        <div class="form-group">
          <label class="form-label">Berlaku Sampai</label>
          <input type="datetime-local" class="form-control" id="rf-valid-until" value="${r.valid_until ? r.valid_until.slice(0,16) : ''}" />
        </div>
      </div>
      <div class="form-group mb-3">
        <label class="form-label">Syarat &amp; Ketentuan</label>
        <textarea class="form-control" id="rf-tnc" rows="2">${escapeHtml(r.terms_and_conditions || '')}</textarea>
      </div>
      <div style="display:flex;gap:12px;flex-wrap:wrap">
        <label style="display:flex;align-items:center;gap:6px;font-size:13px;cursor:pointer">
          <input type="checkbox" id="rf-active" ${r.is_active !== false ? 'checked' : ''} /> Aktif
        </label>
        <label style="display:flex;align-items:center;gap:6px;font-size:13px;cursor:pointer">
          <input type="checkbox" id="rf-approval" ${r.requires_admin_approval ? 'checked' : ''} /> Butuh Persetujuan Admin
        </label>
      </div>
    `;
  }

  async function _submitRewardForm() {
    const id   = document.getElementById('rf-id')?.value;
    const payload = {
      name:                  document.getElementById('rf-name')?.value?.trim(),
      description:           document.getElementById('rf-desc')?.value?.trim() || null,
      reward_type:           document.getElementById('rf-type')?.value,
      cost_point:            parseInt(document.getElementById('rf-cost')?.value || '0'),
      discount_value:        parseFloat(document.getElementById('rf-discount-val')?.value || '0') || null,
      quota_total:           parseInt(document.getElementById('rf-quota')?.value || '') || null,
      valid_from:            document.getElementById('rf-valid-from')?.value || null,
      valid_until:           document.getElementById('rf-valid-until')?.value || null,
      terms_and_conditions:  document.getElementById('rf-tnc')?.value?.trim() || null,
      is_active:             document.getElementById('rf-active')?.checked ? 1 : 0,
      requires_admin_approval: document.getElementById('rf-approval')?.checked ? 1 : 0,
    };
    if (!payload.name || !payload.cost_point) { showToast('Nama dan cost point wajib diisi', 'error'); return; }
    try {
      if (id) {
        const { error } = await db.from('member_rewards').update(payload).eq('id', id);
        if (error) throw new Error(error.message);
      } else {
        const { error } = await db.from('member_rewards').insert(payload);
        if (error) throw new Error(error.message);
      }
      closeModal('modal-reward-form');
      showToast('Reward berhasil disimpan', 'success');
      loadRewards();
    } catch (e) { showToast(e.message, 'error'); }
  }

  async function toggleRewardActive(rewardId, isActive) {
    const { error } = await db.from('member_rewards').update({ is_active: isActive ? 0 : 1 }).eq('id', rewardId);
    if (error) { showToast(error.message, 'error'); return; }
    showToast('Status reward diperbarui', 'success');
    loadRewards();
  }

  // ═══════════════════════════════════════════════════════════
  // TAB: Settings (Aturan Point)
  // ═══════════════════════════════════════════════════════════
  async function loadSettings() {
    const content = document.getElementById('member-tab-content');
    try {
      const { data, error } = await db.from('member_settings').select('*').order('setting_key');
      if (error) throw new Error(error.message);
      const settings = data || [];
      const settingMap = {};
      settings.forEach(s => { settingMap[s.setting_key] = s.setting_value; });

      content.innerHTML = `
        <div class="card" style="max-width:680px">
          <div class="card-header">
            <span class="card-title">Aturan Point &amp; Modul Loyalty</span>
          </div>
          <div class="card-body">
            <!-- Master switch -->
            <div style="background:${settingMap['enable_loyalty_module']==='1'?'var(--success-bg)':'var(--danger-bg)'};border-radius:10px;padding:14px 16px;display:flex;align-items:center;justify-content:space-between;margin-bottom:20px">
              <div>
                <div class="fw-700">Modul Loyalty</div>
                <div class="small text-muted">Aktifkan untuk menampilkan panel member di kasir</div>
              </div>
              <label style="display:flex;align-items:center;gap:8px;cursor:pointer">
                <input type="checkbox" id="setting-enable" ${settingMap['enable_loyalty_module']==='1'?'checked':''} onchange="adminMemberUi._saveSingleSetting('enable_loyalty_module',this.checked?'1':'0')" />
                <span class="fw-600">${settingMap['enable_loyalty_module']==='1'?'AKTIF':'NONAKTIF'}</span>
              </label>
            </div>

            <form id="form-settings">
              ${settingRow('Rasio: Rp per 1 Point', 'point_ratio_rupiah_per_point', settingMap, 'number', 'Rp10.000 = 1 point (default)')}
              ${settingRow('Mode Pembulatan', 'point_rounding_mode', settingMap, 'select:floor,round,ceil')}
              ${settingRow('Minimum Transaksi untuk Point (Rp)', 'min_transaction_for_point', settingMap, 'number')}
              ${settingRow('Maksimum Point per Transaksi', 'max_point_per_transaction', settingMap, 'number')}
              ${settingRow('Maksimum Point per Member per Hari (Anti-fraud)', 'max_point_per_member_per_day', settingMap, 'number')}
              ${settingRow('Masa Berlaku Point (hari, 0=unlimited)', 'point_validity_days', settingMap, 'number')}
              ${settingRow('Jam Pending Point (jam)', 'point_pending_window_hours', settingMap, 'number')}
              ${settingRow('Masa Berlaku Kode Klaim (hari)', 'claim_validity_days', settingMap, 'number')}
              ${settingRow('Window Attach Member Setelah Tx (menit)', 'member_late_attach_window_minutes', settingMap, 'number')}
              ${settingRow('Point pada Transaksi Reward?', 'point_on_reward_transaction', settingMap, 'select:0,1', 'select-bool')}
              ${settingRow('Wajib Scan QR (tidak bisa manual HP)?', 'require_qr_scan_for_member', settingMap, 'select:0,1', 'select-bool')}
            </form>
            <div style="margin-top:16px;display:flex;justify-content:flex-end">
              <button class="btn btn-primary" onclick="adminMemberUi._saveAllSettings()">
                <i data-lucide="save" class="icon-sm"></i> Simpan Semua
              </button>
            </div>
          </div>
        </div>
      `;
    } catch (e) {
      content.innerHTML = errHtml(e.message);
    }
    lucideRefresh();
  }

  function settingRow(label, key, map, type, hint = '') {
    const val = map[key] ?? '';
    let input;
    if (type === 'number') {
      input = `<input type="number" class="form-control" id="setting-${key}" name="${key}" value="${escapeHtml(val)}" />`;
    } else if (type.startsWith('select:')) {
      const opts = type.replace('select:', '').split(',');
      const isBool = hint === 'select-bool';
      input = `<select class="form-control" id="setting-${key}" name="${key}">
        ${opts.map(o => `<option value="${o}" ${val === o ? 'selected' : ''}>${isBool ? (o === '1' ? 'Ya' : 'Tidak') : o}</option>`).join('')}
      </select>`;
    } else {
      input = `<input type="text" class="form-control" id="setting-${key}" name="${key}" value="${escapeHtml(val)}" />`;
    }
    return `<div class="form-group mb-3">
      <label class="form-label">${label}${hint && hint !== 'select-bool' ? `<span class="text-muted ml-1 small">(${hint})</span>` : ''}</label>
      ${input}
    </div>`;
  }

  async function _saveSingleSetting(key, value) {
    try {
      const { error } = await db.from('member_settings')
        .update({ setting_value: value })
        .eq('setting_key', key);
      if (error) throw new Error(error.message);
      showToast('Pengaturan disimpan', 'success');
      loadSettings();
    } catch (e) { showToast(e.message, 'error'); }
  }

  async function _saveAllSettings() {
    const form = document.getElementById('form-settings');
    if (!form) return;
    const inputs = form.querySelectorAll('[name]');
    const updates = [];
    inputs.forEach(inp => {
      updates.push(db.from('member_settings').update({ setting_value: inp.value }).eq('setting_key', inp.name));
    });
    try {
      const results = await Promise.all(updates);
      const errs = results.filter(r => r.error);
      if (errs.length) { showToast('Beberapa pengaturan gagal disimpan: ' + errs[0].error.message, 'error'); return; }
      showToast('Semua pengaturan berhasil disimpan', 'success');
      loadSettings();
    } catch (e) { showToast(e.message, 'error'); }
  }

  // ═══════════════════════════════════════════════════════════
  // TAB: Approvals (Antrian Klaim)
  // ═══════════════════════════════════════════════════════════
  async function loadApprovals() {
    const content = document.getElementById('member-tab-content');
    try {
      const { data, error } = await db.from('member_reward_claims')
        .select('id, member_id, reward_id, redemption_code, cost_point, claimed_at, expires_at')
        .eq('status', 'pending_approval')
        .order('claimed_at');
      if (error) throw new Error(error.message);
      const claims = data || [];

      if (claims.length === 0) {
        content.innerHTML = `<div class="empty-state"><div class="empty-icon"><i data-lucide="check-circle" class="icon"></i></div><div class="empty-title">Tidak ada antrian persetujuan</div><div class="empty-desc">Semua klaim reward sudah diproses</div></div>`;
        lucideRefresh(); return;
      }

      content.innerHTML = `
        <div class="card">
          <div class="card-header"><span class="card-title">Antrian Persetujuan Klaim (${claims.length})</span></div>
          <div class="card-body p-0">
            <div class="table-responsive"><table class="table table-sm">
              <thead><tr><th>ID Klaim</th><th>Member ID</th><th>Kode</th><th>Cost</th><th>Klaim Pada</th><th>Aksi</th></tr></thead>
              <tbody>
              ${claims.map(c => `<tr>
                <td>${c.id}</td>
                <td>${c.member_id}</td>
                <td><code>${escapeHtml(c.redemption_code)}</code></td>
                <td>${c.cost_point} pt</td>
                <td class="small text-muted">${fmtDateTime(c.claimed_at)}</td>
                <td>
                  <button class="btn btn-success btn-sm" onclick="adminMemberUi.approveClaim(${c.id})">Approve</button>
                  <button class="btn btn-danger btn-sm" onclick="adminMemberUi.voidClaim(${c.id})">Tolak</button>
                </td>
              </tr>`).join('')}
              </tbody>
            </table></div>
          </div>
        </div>
      `;
    } catch (e) {
      content.innerHTML = errHtml(e.message);
    }
    lucideRefresh();
  }

  async function approveClaim(claimId) {
    if (!confirm('Approve klaim reward ini?')) return;
    try {
      await rpc('member_admin_approve_claim', { claim_id: claimId });
      showToast('Klaim disetujui', 'success');
      if (currentTab === 'approvals') loadApprovals();
      else if (currentTab === 'members') {/* refresh not needed */ }
    } catch (e) { showToast(e.message, 'error'); }
  }

  async function voidClaim(claimId) {
    const reason = prompt('Alasan pembatalan klaim:');
    if (reason === null) return;
    if (!reason.trim()) { showToast('Alasan wajib diisi', 'error'); return; }
    try {
      await rpc('member_admin_void_claim', { claim_id: claimId, reason: reason.trim() });
      showToast('Klaim dibatalkan', 'success');
      if (currentTab === 'approvals') loadApprovals();
    } catch (e) { showToast(e.message, 'error'); }
  }

  // ═══════════════════════════════════════════════════════════
  // TAB: Fraud Monitoring
  // ═══════════════════════════════════════════════════════════
  async function loadFraud() {
    const content = document.getElementById('member-tab-content');
    try {
      const { data, error } = await db.from('member_fraud_flags')
        .select('id, member_id, staff_user_id, transaction_id, flag_type, severity, risk_score, detected_at, status, resolution_note')
        .order('detected_at', { ascending: false })
        .limit(100);
      if (error) throw new Error(error.message);
      const flags = data || [];

      const open = flags.filter(f => f.status === 'open');
      content.innerHTML = `
        <div class="stats-grid" style="margin-bottom:16px">
          ${statCard('Total Flag', flags.length, 'alert-triangle')}
          ${statCard('Flag Terbuka', open.length, 'alert-circle')}
          ${statCard('Critical/High', flags.filter(f => ['critical','high'].includes(f.severity) && f.status === 'open').length, 'shield-x')}
        </div>
        <div class="card">
          <div class="card-header">
            <span class="card-title">Daftar Fraud Flag (100 Terbaru)</span>
          </div>
          <div class="card-body p-0">
            ${fraudTable(flags)}
          </div>
        </div>
      `;
    } catch (e) {
      content.innerHTML = errHtml(e.message);
    }
    lucideRefresh();
  }

  function fraudTable(rows) {
    if (!rows.length) return '<p class="p-3 text-muted small text-center">Tidak ada fraud flag</p>';
    return `<div class="table-responsive"><table class="table table-sm">
      <thead><tr><th>Tipe Flag</th><th>Member</th><th>Staff</th><th>Severity</th><th>Risk</th><th>Status</th><th>Waktu</th><th>Aksi</th></tr></thead>
      <tbody>
      ${rows.map(f => `<tr>
        <td><code class="small">${escapeHtml(f.flag_type)}</code></td>
        <td class="small">${f.member_id ?? '-'}</td>
        <td class="small">${f.staff_user_id ?? '-'}</td>
        <td><span class="badge badge-${severityBadge(f.severity)}">${escapeHtml(f.severity)}</span></td>
        <td>${f.risk_score}</td>
        <td><span class="badge ${f.status === 'open' ? 'badge-danger' : 'badge-neutral'}">${escapeHtml(f.status)}</span></td>
        <td class="small text-muted">${fmtDateTime(f.detected_at)}</td>
        <td>
          ${f.status === 'open' ? `
            <select class="form-control" style="font-size:11px;height:28px;width:auto;display:inline-block;" onchange="if(this.value)adminMemberUi._resolveFraud(${f.id},this.value)" >
              <option value="">Tindakan...</option>
              <option value="acknowledged">Catat</option>
              <option value="dismissed">Abaikan</option>
              <option value="action_taken">Tindakan Diambil</option>
            </select>` : ''}
        </td>
      </tr>`).join('')}
      </tbody>
    </table></div>`;
  }

  async function _resolveFraud(flagId, status) {
    const note = prompt(`Catatan resolusi (${status}):`, '');
    if (note === null) return;
    try {
      await rpc('member_fraud_resolve', { flag_id: flagId, status, resolution_note: note || '' });
      showToast('Flag diperbarui', 'success');
      loadFraud();
    } catch (e) { showToast(e.message, 'error'); }
  }

  // ═══════════════════════════════════════════════════════════
  // Modal helpers
  // ═══════════════════════════════════════════════════════════
  function showModal(id, bodyHtml, footerHtml = '') {
    let modal = document.getElementById(id);
    if (!modal) {
      modal = document.createElement('div');
      modal.id = id;
      modal.className = 'modal-overlay';
      document.body.appendChild(modal);
    }
    const defaultTitle = {
      'modal-member-detail': 'Detail Member',
      'modal-manual-adjust': 'Sesuaikan Point Manual',
      'modal-reset-pw': 'Reset Password Member',
      'modal-create-member': 'Buat Member Baru',
      'modal-reward-form': '<span id="rf-title">Form Reward</span>',
    };
    modal.innerHTML = `
      <div class="modal">
        <div class="modal-header">
          <div class="modal-title">${defaultTitle[id] || 'Form'}</div>
          <button class="modal-close" onclick="adminMemberUi.closeModal('${id}')">✕</button>
        </div>
        <div class="modal-body" id="${id}-body">${bodyHtml}</div>
        ${footerHtml ? `<div class="modal-footer"><button class="btn btn-outline" onclick="adminMemberUi.closeModal('${id}')">Batal</button>${footerHtml}</div>` : ''}
      </div>
    `;
    modal.classList.add('active');
    lucideRefresh();
  }

  function closeModal(id) {
    document.getElementById(id)?.classList.remove('active');
  }

  // ── Utility functions ────────────────────────────────────────
  function errHtml(msg) {
    return `<div class="empty-state"><div class="empty-icon text-danger"><i data-lucide="alert-circle" class="icon"></i></div><div class="empty-title">Error</div><div class="empty-desc">${escapeHtml(msg)}</div></div>`;
  }

  function lucideRefresh() {
    if (typeof lucide !== 'undefined') lucide.createIcons();
  }

  function fmtDate(d) { return d ? new Date(d).toLocaleDateString('id-ID', { day:'numeric', month:'short', year:'numeric' }) : '-'; }
  function fmtDateTime(d) { return d ? new Date(d).toLocaleDateString('id-ID', { day:'numeric', month:'short', year:'numeric', hour:'2-digit', minute:'2-digit' }) : '-'; }

  function claimStatusBadge(s) {
    return { redeemable:'badge-success', redeemed:'badge-neutral', cancelled:'badge-danger', expired:'badge-neutral', pending_approval:'badge-warning' }[s] || 'badge-neutral';
  }

  function severityBadge(s) {
    return { critical:'danger', high:'danger', medium:'warning', low:'neutral' }[s] || 'neutral';
  }

  // ── Public API ────────────────────────────────────────────────
  return {
    load,
    switchTab,
    openMemberDetail,
    openManualAdjust,
    _submitManualAdjust,
    openResetPassword,
    _submitResetPw,
    toggleActive,
    openCreateMember,
    _submitCreateMember,
    _searchMembers: () => {
      const q = document.getElementById('member-search-q')?.value?.trim() || '';
      loadMembers(q, 0);
    },
    loadMembers,
    openCreateReward,
    openEditReward,
    _submitRewardForm,
    toggleRewardActive,
    _saveSingleSetting,
    _saveAllSettings,
    approveClaim,
    voidClaim,
    _resolveFraud,
    _switchDetailTab,
    closeModal,
  };

})();

window.adminMemberUi = adminMemberUi;
