'use strict';

// ═══════════════════════════════════════════════════════════════
// RBN Member PWA — js/member.js
// Depends on: apiClient.js (provides API_BASE, API_KEY globals)
// ═══════════════════════════════════════════════════════════════

// ── State ──────────────────────────────────────────────────────
const memberState = {
  member: null,
  balance: { active: 0, pending: 0 },
  currentRewardId: null,
  historyTab: 'point',
};

// ── Storage ─────────────────────────────────────────────────────
function getMemberToken() {
  try {
    const raw = localStorage.getItem('member_session');
    if (!raw) return '';
    const s = JSON.parse(raw);
    if (s?.expires_at && new Date(s.expires_at) < new Date()) return '';
    return s?.token || '';
  } catch { return ''; }
}

function saveMemberSession(token, expiresAt) {
  localStorage.setItem('member_session', JSON.stringify({ token, expires_at: expiresAt }));
}

function clearMemberSession() {
  localStorage.removeItem('member_session');
  memberState.member = null;
  memberState.balance = { active: 0, pending: 0 };
}

// ── API Client ──────────────────────────────────────────────────
const memberApi = {
  _headers() {
    const token = getMemberToken();
    const h = { 'Content-Type': 'application/json', 'X-API-Key': API_KEY };
    if (token) h['X-Member-Session-Token'] = token;
    return h;
  },

  async rpc(name, params = {}) {
    try {
      const res = await fetch(`${API_BASE}/rpc/${name}`, {
        method: 'POST',
        headers: this._headers(),
        body: JSON.stringify(params),
      });
      const json = await res.json();
      if (!res.ok) return { data: null, error: json?.error ?? { message: 'Permintaan gagal' } };
      return { data: json, error: null };
    } catch (e) {
      return { data: null, error: { message: e.message } };
    }
  },

  async get(table, params = {}) {
    const h = this._headers();
    delete h['Content-Type'];
    const url = new URL(`${API_BASE}/${table}`);
    Object.entries(params).forEach(([k, v]) => url.searchParams.append(k, v));
    try {
      const res = await fetch(url.toString(), { headers: h });
      const json = await res.json();
      if (!res.ok) return { data: null, error: json?.error ?? { message: 'Permintaan gagal' } };
      return { data: json, error: null };
    } catch (e) {
      return { data: null, error: { message: e.message } };
    }
  },
};

// ── Utilities ───────────────────────────────────────────────────
function toast(msg, type = 'info', dur = 3500) {
  const el = document.createElement('div');
  el.className = `toast toast-${type}`;
  el.textContent = msg;
  document.getElementById('toast-container').appendChild(el);
  setTimeout(() => el.remove(), dur);
}

function esc(s) {
  if (s == null) return '';
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function formatRp(n) {
  return 'Rp' + (n || 0).toLocaleString('id-ID');
}

function formatDate(d) {
  if (!d) return '-';
  return new Date(d).toLocaleDateString('id-ID', { day: 'numeric', month: 'short', year: 'numeric' });
}

function formatDateTime(d) {
  if (!d) return '-';
  return new Date(d).toLocaleDateString('id-ID', {
    day: 'numeric', month: 'short', year: 'numeric',
    hour: '2-digit', minute: '2-digit',
  });
}

function countdown(expiresAt) {
  const diff = new Date(expiresAt) - Date.now();
  if (diff <= 0) return 'Kedaluwarsa';
  const d = Math.floor(diff / 86400000);
  const h = Math.floor((diff % 86400000) / 3600000);
  if (d > 0) return `${d} hari ${h} jam lagi`;
  const m = Math.floor((diff % 3600000) / 60000);
  return `${h} jam ${m} menit lagi`;
}

function generateQR(data, container) {
  if (!container) return;
  try {
    const qr = qrcode(0, 'M');
    qr.addData(String(data));
    qr.make();
    container.innerHTML = qr.createSvgTag({ scalable: true, margin: 1 });
  } catch {
    container.innerHTML = '<p style="font-size:11px;color:var(--text-muted);text-align:center">QR tidak tersedia</p>';
  }
}

function showFormError(el, msg) {
  if (!el) return;
  el.textContent = msg;
  el.style.display = 'block';
}

function hideFormError(el) {
  if (!el) return;
  el.style.display = 'none';
}

function bindEyeToggles() {
  document.querySelectorAll('.btn-eye').forEach(btn => {
    btn.removeEventListener('click', btn._eyeHandler);
    btn._eyeHandler = () => {
      const inp = document.getElementById(btn.dataset.target);
      if (!inp) return;
      inp.type = inp.type === 'password' ? 'text' : 'password';
      const icon = btn.querySelector('i');
      if (icon) {
        icon.setAttribute('data-lucide', inp.type === 'password' ? 'eye' : 'eye-off');
        if (typeof lucide !== 'undefined') lucide.createIcons();
      }
    };
    btn.addEventListener('click', btn._eyeHandler);
  });
}

function lucideRefresh() {
  if (typeof lucide !== 'undefined') lucide.createIcons();
}

// ── Router ──────────────────────────────────────────────────────
const AUTH_PAGES    = ['dashboard', 'rewards', 'reward-detail', 'my-claims', 'history', 'profile'];
const PUBLIC_PAGES  = ['login', 'register'];
const NAV_PAGES     = ['dashboard', 'rewards', 'my-claims', 'history', 'profile'];

function currentPage() {
  return location.hash.replace('#', '').split('?')[0] || 'login';
}

function getHashParams() {
  const hash = location.hash;
  if (!hash.includes('?')) return {};
  return Object.fromEntries(new URLSearchParams(hash.split('?')[1]));
}

function navigate(page, params = {}) {
  const q = Object.keys(params).length ? '?' + new URLSearchParams(params).toString() : '';
  location.hash = page + q;
}

async function handleRoute() {
  const page = currentPage();
  const token = getMemberToken();

  if (AUTH_PAGES.includes(page) && !token) {
    location.replace('#login');
    return;
  }
  if (PUBLIC_PAGES.includes(page) && token) {
    location.replace('#dashboard');
    return;
  }

  const nav = document.getElementById('bottom-nav');
  if (AUTH_PAGES.includes(page)) {
    nav.classList.add('visible');
    document.querySelectorAll('.nav-item').forEach(b => {
      b.classList.toggle('active', b.dataset.nav === page);
    });
  } else {
    nav.classList.remove('visible');
  }

  switch (page) {
    case 'login':        renderLogin(); break;
    case 'register':     renderRegister(); break;
    case 'dashboard':    await renderDashboard(); break;
    case 'rewards':      await renderRewards(); break;
    case 'reward-detail': await renderRewardDetail(); break;
    case 'my-claims':    await renderMyClaims(); break;
    case 'history':      await renderHistory(); break;
    case 'profile':      await renderProfile(); break;
    default: navigate(token ? 'dashboard' : 'login');
  }
}

// ── Shared UI ───────────────────────────────────────────────────
function setRoot(html) {
  document.getElementById('app-root').innerHTML = html;
}

function renderHeader(title, showBack = false, showLogout = false) {
  const back = showBack
    ? `<button class="mem-back" onclick="history.back()"><i data-lucide="arrow-left"></i></button>`
    : `<div class="mem-header-spacer"></div>`;
  const action = showLogout
    ? `<button class="mem-header-action" id="btn-logout" title="Keluar"><i data-lucide="log-out"></i></button>`
    : `<div class="mem-header-spacer"></div>`;
  return `<header class="mem-header">${back}<h1 class="mem-header-title">${esc(title)}</h1>${action}</header>`;
}

// ── Page: Login ─────────────────────────────────────────────────
function renderLogin() {
  setRoot(`
    <div class="auth-page">
      <div class="auth-brand">
        <img src="https://res.cloudinary.com/dckzmg6c3/image/upload/v1777572835/Untitled-2_tgjm4u.png" class="auth-logo" alt="Logo RBN" />
        <h1>Roti Bakar Ngeunah</h1>
        <p>Program Member Loyalty</p>
      </div>
      <form id="form-login" class="auth-form" autocomplete="off" novalidate>
        <div class="form-group">
          <label class="form-label">Nomor HP / Email</label>
          <input class="form-input" type="text" id="inp-phone" placeholder="08xxxxxxxxxx atau email" autocomplete="username" />
        </div>
        <div class="form-group">
          <label class="form-label">Password</label>
          <div class="input-pw">
            <input class="form-input" type="password" id="inp-pw" placeholder="Password" autocomplete="current-password" />
            <button type="button" class="btn-eye" data-target="inp-pw"><i data-lucide="eye"></i></button>
          </div>
        </div>
        <div id="login-err" class="form-error" style="display:none"></div>
        <button type="submit" class="btn-primary btn-full" id="btn-login">Masuk</button>
      </form>
      <div class="auth-links">
        <a href="#register">Belum punya akun? <b>Daftar sekarang</b></a>
      </div>
    </div>
  `);
  lucideRefresh();
  bindEyeToggles();

  document.getElementById('form-login').addEventListener('submit', async e => {
    e.preventDefault();
    const phone = document.getElementById('inp-phone').value.trim();
    const pw    = document.getElementById('inp-pw').value;
    const errEl = document.getElementById('login-err');
    const btn   = document.getElementById('btn-login');
    hideFormError(errEl);
    if (!phone || !pw) { showFormError(errEl, 'Nomor HP/email dan password wajib diisi'); return; }
    btn.disabled = true; btn.textContent = 'Masuk...';
    const { data, error } = await memberApi.rpc('member_login', { phone, password: pw });
    btn.disabled = false; btn.textContent = 'Masuk';
    if (error) { showFormError(errEl, error.message || 'Login gagal'); return; }
    saveMemberSession(data.session_token, data.expires_at);
    memberState.member = data.member || null;
    navigate('dashboard');
  });
}

// ── Page: Register ──────────────────────────────────────────────
function renderRegister() {
  setRoot(`
    <div class="auth-page">
      <div class="auth-header-back">
        <button class="mem-back" onclick="navigate('login')"><i data-lucide="arrow-left"></i></button>
        <h2>Daftar Member</h2>
      </div>
      <form id="form-reg" class="auth-form" autocomplete="off" novalidate>
        <div class="form-group">
          <label class="form-label">Nama Lengkap <span class="required">*</span></label>
          <input class="form-input" type="text" id="reg-name" placeholder="Nama kamu" autocomplete="name" />
        </div>
        <div class="form-group">
          <label class="form-label">Nomor HP <span class="required">*</span></label>
          <input class="form-input" type="tel" id="reg-phone" placeholder="08xxxxxxxxxx" autocomplete="tel" inputmode="numeric" />
        </div>
        <div class="form-group">
          <label class="form-label">Email <span class="optional">(opsional)</span></label>
          <input class="form-input" type="email" id="reg-email" placeholder="email@contoh.com" autocomplete="email" />
        </div>
        <div class="form-group">
          <label class="form-label">Password <span class="required">*</span></label>
          <div class="input-pw">
            <input class="form-input" type="password" id="reg-pw" placeholder="Min. 6 karakter" />
            <button type="button" class="btn-eye" data-target="reg-pw"><i data-lucide="eye"></i></button>
          </div>
        </div>
        <div class="form-group">
          <label class="form-label">Konfirmasi Password <span class="required">*</span></label>
          <div class="input-pw">
            <input class="form-input" type="password" id="reg-pw2" placeholder="Ulangi password" />
            <button type="button" class="btn-eye" data-target="reg-pw2"><i data-lucide="eye"></i></button>
          </div>
        </div>
        <div class="form-group">
          <label class="form-label">Tanggal Lahir <span class="optional">(opsional)</span></label>
          <input class="form-input" type="date" id="reg-dob" />
        </div>
        <label class="form-check">
          <input type="checkbox" id="reg-tos" />
          <span>Saya setuju dengan <a href="javascript:void(0)">Syarat &amp; Ketentuan</a> program member RBN</span>
        </label>
        <div id="reg-err" class="form-error" style="display:none"></div>
        <button type="submit" class="btn-primary btn-full" id="btn-reg">Daftar Sekarang</button>
      </form>
      <div class="auth-links">
        <a href="#login">Sudah punya akun? <b>Masuk</b></a>
      </div>
    </div>
  `);
  lucideRefresh();
  bindEyeToggles();

  document.getElementById('form-reg').addEventListener('submit', async e => {
    e.preventDefault();
    const name  = document.getElementById('reg-name').value.trim();
    const phone = document.getElementById('reg-phone').value.trim();
    const email = document.getElementById('reg-email').value.trim();
    const pw    = document.getElementById('reg-pw').value;
    const pw2   = document.getElementById('reg-pw2').value;
    const dob   = document.getElementById('reg-dob').value;
    const tos   = document.getElementById('reg-tos').checked;
    const errEl = document.getElementById('reg-err');
    const btn   = document.getElementById('btn-reg');
    hideFormError(errEl);
    if (!name)         { showFormError(errEl, 'Nama wajib diisi'); return; }
    if (!phone)        { showFormError(errEl, 'Nomor HP wajib diisi'); return; }
    if (!pw)           { showFormError(errEl, 'Password wajib diisi'); return; }
    if (pw.length < 6) { showFormError(errEl, 'Password minimal 6 karakter'); return; }
    if (pw !== pw2)    { showFormError(errEl, 'Konfirmasi password tidak cocok'); return; }
    if (!tos)          { showFormError(errEl, 'Harap setujui syarat & ketentuan'); return; }
    btn.disabled = true; btn.textContent = 'Mendaftar...';
    const params = { name, phone, password: pw };
    if (email) params.email = email;
    if (dob)   params.birth_date = dob;
    const { data, error } = await memberApi.rpc('member_register', params);
    btn.disabled = false; btn.textContent = 'Daftar Sekarang';
    if (error) { showFormError(errEl, error.message || 'Registrasi gagal'); return; }
    saveMemberSession(data.session_token, data.expires_at);
    memberState.member = data.member || null;
    toast('Selamat datang, ' + name + '!', 'success');
    navigate('dashboard');
  });
}

// ── Page: Dashboard ─────────────────────────────────────────────
async function renderDashboard() {
  setRoot(`
    <div class="mem-page">
      ${renderHeader('RBN Member', false, true)}
      <div class="mem-content" id="dash-content">
        <div class="loading-center"><div class="spinner"></div></div>
      </div>
    </div>
  `);
  lucideRefresh();
  document.getElementById('btn-logout')?.addEventListener('click', doLogout);

  const [meRes, balRes, rewardsRes, txRes] = await Promise.all([
    memberApi.rpc('member_me'),
    memberApi.rpc('member_get_balance'),
    memberApi.rpc('member_list_rewards', { limit: 6 }),
    memberApi.rpc('member_get_transaction_history', { limit: 5, offset: 0 }),
  ]);

  if (meRes.error) {
    document.getElementById('dash-content').innerHTML =
      `<p class="error-msg">${esc(meRes.error.message)}</p>`;
    return;
  }

  const me      = meRes.data;
  const balance = balRes.data || { active: 0, pending: 0 };
  memberState.member  = me;
  memberState.balance = balance;
  const { active = 0, pending = 0 } = balance;
  const rewards  = rewardsRes.data?.rewards || [];
  const claimable = rewards.filter(r => r.cost_point <= active);
  const txList   = txRes.data?.transactions || [];

  const content = document.getElementById('dash-content');
  content.innerHTML = `
    <!-- Member identity card -->
    <div class="mem-card">
      <div class="mem-card-top">
        <div>
          <div class="mem-card-name">${esc(me.name)}</div>
          <div class="mem-card-code">${esc(me.member_code)}</div>
        </div>
        <button class="mem-qr-btn" id="btn-show-qr" title="Tampilkan QR">
          <div id="qr-thumb"></div>
        </button>
      </div>
    </div>

    <!-- Points -->
    <div class="points-card">
      <div class="points-active">
        <div class="points-active-val">${active.toLocaleString('id-ID')}</div>
        <div class="points-active-label">Point Aktif</div>
      </div>
      ${pending > 0 ? `
      <div class="points-pending">
        <div class="points-pending-val">${pending.toLocaleString('id-ID')}</div>
        <div class="points-pending-label">Pending <i data-lucide="info" style="width:12px;height:12px"></i></div>
      </div>` : ''}
    </div>

    ${claimable.length > 0 ? `
    <div class="claim-banner" onclick="navigate('rewards')">
      <i data-lucide="gift"></i>
      <span><b>${claimable.length} reward</b> bisa kamu klaim sekarang!</span>
      <i data-lucide="chevron-right"></i>
    </div>` : ''}

    ${rewards.length > 0 ? `
    <div class="section-head">
      <span>Reward Tersedia</span>
      <a href="#rewards" class="section-more">Semua <i data-lucide="chevron-right"></i></a>
    </div>
    <div class="rewards-scroll" id="rewards-scroll">
      ${rewards.map(r => rewardMiniCardHtml(r, active)).join('')}
    </div>` : ''}

    <div class="section-head">
      <span>Transaksi Terakhir</span>
      <a href="#history" class="section-more" onclick="memberState.historyTab='tx';return true;">Semua <i data-lucide="chevron-right"></i></a>
    </div>
    ${txList.length > 0
      ? `<div class="tx-list">${txList.map(txItemHtml).join('')}</div>`
      : `<div class="empty-state" style="padding:24px 0"><i data-lucide="shopping-bag"></i><p>Belum ada transaksi</p></div>`
    }
  `;
  lucideRefresh();

  // QR thumbnail
  if (me.qr_token) {
    generateQR(me.qr_token, document.getElementById('qr-thumb'));
  }

  document.getElementById('btn-show-qr')?.addEventListener('click', () => showQrModal(me));

  // Mini reward card clicks
  document.querySelectorAll('.reward-mini-card').forEach(card => {
    card.addEventListener('click', () => {
      memberState.currentRewardId = card.dataset.id;
      navigate('reward-detail');
    });
  });
}

// ── Page: Rewards ───────────────────────────────────────────────
async function renderRewards() {
  setRoot(`
    <div class="mem-page">
      ${renderHeader('Reward', false, false)}
      <div class="filter-tabs">
        <button class="filter-tab active" data-filter="all">Semua</button>
        <button class="filter-tab" data-filter="claimable">Bisa Diklaim</button>
      </div>
      <div class="mem-content" id="rewards-content">
        <div class="loading-center"><div class="spinner"></div></div>
      </div>
    </div>
  `);
  lucideRefresh();

  const [balRes, rewardsRes] = await Promise.all([
    memberState.balance.active !== 0
      ? Promise.resolve({ data: memberState.balance })
      : memberApi.rpc('member_get_balance'),
    memberApi.rpc('member_list_rewards', { limit: 100 }),
  ]);

  const active = balRes.data?.active || memberState.balance.active || 0;
  if (!memberState.balance.active) memberState.balance = balRes.data || { active: 0, pending: 0 };

  let allRewards = rewardsRes.data?.rewards || [];
  let currentFilter = 'all';

  const renderList = (filter) => {
    const content = document.getElementById('rewards-content');
    if (!content) return;
    const rewards = filter === 'claimable'
      ? allRewards.filter(r => r.cost_point <= active && r.is_active)
      : allRewards;
    if (rewards.length === 0) {
      content.innerHTML = `<div class="empty-state"><i data-lucide="gift"></i><p>${
        filter === 'claimable' ? 'Belum cukup point untuk reward apapun' : 'Belum ada reward tersedia'
      }</p></div>`;
      lucideRefresh();
      return;
    }
    content.innerHTML = `<div class="rewards-grid">${rewards.map(r => rewardCardHtml(r, active)).join('')}</div>`;
    lucideRefresh();
    content.querySelectorAll('.reward-card').forEach(card => {
      card.addEventListener('click', () => {
        memberState.currentRewardId = card.dataset.id;
        navigate('reward-detail');
      });
    });
  };

  if (rewardsRes.error) {
    document.getElementById('rewards-content').innerHTML =
      `<p class="error-msg">${esc(rewardsRes.error.message)}</p>`;
    return;
  }

  renderList(currentFilter);

  document.querySelectorAll('.filter-tab').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.filter-tab').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      currentFilter = btn.dataset.filter;
      renderList(currentFilter);
    });
  });
}

// ── Page: Reward Detail ─────────────────────────────────────────
async function renderRewardDetail() {
  const rewardId = memberState.currentRewardId || getHashParams().id;
  if (!rewardId) { navigate('rewards'); return; }

  setRoot(`
    <div class="mem-page">
      ${renderHeader('Detail Reward', true, false)}
      <div class="mem-content" id="rd-content">
        <div class="loading-center"><div class="spinner"></div></div>
      </div>
    </div>
  `);
  lucideRefresh();

  const [balRes, rewardRes] = await Promise.all([
    memberApi.rpc('member_get_balance'),
    memberApi.get('member_rewards', { id: `eq.${rewardId}`, _single: '1' }),
  ]);

  const active  = balRes.data?.active || memberState.balance.active || 0;
  const content = document.getElementById('rd-content');
  if (!content) return;

  if (rewardRes.error || !rewardRes.data) {
    content.innerHTML = `<p class="error-msg">Reward tidak ditemukan</p>`;
    return;
  }

  const r = rewardRes.data;
  const canClaim = r.is_active
    && active >= r.cost_point
    && (!r.quota_total || r.quota_used < r.quota_total);
  const typeLabels = {
    free_product: 'Produk Gratis',
    discount_amount: 'Diskon Nominal',
    discount_percent: 'Diskon Persen',
    other: 'Lainnya',
  };
  const quotaLeft = r.quota_total != null ? r.quota_total - r.quota_used : null;

  content.innerHTML = `
    ${r.image_url ? `<img src="${esc(r.image_url)}" class="reward-detail-img" alt="${esc(r.name)}" />` : ''}
    <div class="reward-detail-body">
      <h2 class="reward-detail-name">${esc(r.name)}</h2>
      <div class="reward-detail-meta">
        <span class="badge badge-primary"><i data-lucide="star"></i> ${r.cost_point} point</span>
        <span class="badge badge-neutral">${esc(typeLabels[r.reward_type] || r.reward_type)}</span>
        ${!r.is_active ? `<span class="badge badge-neutral">Tidak Aktif</span>` : ''}
      </div>
      ${r.description ? `<p class="reward-detail-desc">${esc(r.description)}</p>` : ''}
      <div class="reward-detail-info">
        ${quotaLeft !== null
          ? `<div class="info-row"><i data-lucide="package"></i> Kuota tersisa: ${Math.max(0, quotaLeft)}</div>`
          : `<div class="info-row"><i data-lucide="infinity"></i> Kuota tidak terbatas</div>`}
        ${r.valid_from ? `<div class="info-row"><i data-lucide="calendar"></i> Mulai: ${formatDate(r.valid_from)}</div>` : ''}
        ${r.valid_until ? `<div class="info-row"><i data-lucide="calendar-x"></i> Sampai: ${formatDate(r.valid_until)}</div>` : ''}
        ${r.requires_admin_approval ? `<div class="info-row info-warning"><i data-lucide="clock"></i> Perlu persetujuan admin sebelum digunakan</div>` : ''}
      </div>
      ${r.terms_and_conditions ? `
      <details class="tnc-details">
        <summary>Syarat &amp; Ketentuan</summary>
        <p>${esc(r.terms_and_conditions)}</p>
      </details>` : ''}
      <div class="reward-detail-footer">
        <div class="your-pts">Point kamu: <b>${active.toLocaleString('id-ID')}</b></div>
        ${canClaim
          ? `<button class="btn-primary btn-full" id="btn-claim-reward">Klaim (${r.cost_point} point)</button>`
          : `<button class="btn-primary btn-full" disabled style="opacity:0.5">${
              !r.is_active ? 'Reward tidak aktif'
              : active < r.cost_point ? `Kurang ${(r.cost_point - active).toLocaleString('id-ID')} point lagi`
              : 'Kuota habis'
            }</button>`
        }
      </div>
    </div>
  `;
  lucideRefresh();

  document.getElementById('btn-claim-reward')?.addEventListener('click', () => doClaimReward(r));
}

// ── Page: My Claims ─────────────────────────────────────────────
async function renderMyClaims() {
  setRoot(`
    <div class="mem-page">
      ${renderHeader('Klaim Saya', false, false)}
      <div class="mem-content" id="claims-content">
        <div class="loading-center"><div class="spinner"></div></div>
      </div>
    </div>
  `);
  lucideRefresh();

  const { data, error } = await memberApi.rpc('member_my_claims');
  const content = document.getElementById('claims-content');
  if (!content) return;

  if (error) { content.innerHTML = `<p class="error-msg">${esc(error.message)}</p>`; return; }

  const claims  = data?.claims || [];
  const active  = claims.filter(c => ['redeemable', 'pending_approval'].includes(c.status));
  const history = claims.filter(c => ['redeemed', 'cancelled', 'expired'].includes(c.status));

  if (claims.length === 0) {
    content.innerHTML = `
      <div class="empty-state">
        <i data-lucide="ticket"></i>
        <p>Belum ada klaim reward</p>
        <a href="#rewards" class="btn-primary" style="margin-top:14px;font-size:13px">Lihat Reward</a>
      </div>`;
    lucideRefresh();
    return;
  }

  let html = '';
  if (active.length > 0) {
    html += `<div class="section-label">Klaim Aktif (${active.length})</div>`;
    html += active.map(claimCardHtml).join('');
  }
  if (history.length > 0) {
    html += `<div class="section-label">Riwayat Klaim</div>`;
    html += history.map(claimHistoryItemHtml).join('');
  }

  content.innerHTML = html;
  lucideRefresh();

  // Generate QR for each active claim
  active.forEach(c => {
    const qrEl = document.getElementById(`claim-qr-${c.id}`);
    if (qrEl && c.redemption_qr_token) generateQR(c.redemption_qr_token, qrEl);
  });

  // Cancel buttons
  content.querySelectorAll('[data-cancel-claim]').forEach(btn => {
    btn.addEventListener('click', () => doCancelClaim(Number(btn.dataset.cancelClaim)));
  });
}

// ── Page: History (combined point + tx tabs) ────────────────────
async function renderHistory() {
  setRoot(`
    <div class="mem-page">
      ${renderHeader('Histori', false, false)}
      <div class="filter-tabs">
        <button class="filter-tab ${memberState.historyTab === 'point' ? 'active' : ''}" data-htab="point">Point</button>
        <button class="filter-tab ${memberState.historyTab === 'tx' ? 'active' : ''}" data-htab="tx">Transaksi</button>
      </div>
      <div class="mem-content" id="history-content">
        <div class="loading-center"><div class="spinner"></div></div>
      </div>
    </div>
  `);
  lucideRefresh();

  const loadTab = async (tab) => {
    memberState.historyTab = tab;
    const content = document.getElementById('history-content');
    if (!content) return;
    content.innerHTML = '<div class="loading-center"><div class="spinner"></div></div>';

    if (tab === 'point') {
      const { data, error } = await memberApi.rpc('member_get_point_history', { limit: 50, offset: 0 });
      if (error) { content.innerHTML = `<p class="error-msg">${esc(error.message)}</p>`; return; }
      const entries = data?.entries || [];
      if (entries.length === 0) {
        content.innerHTML = `<div class="empty-state"><i data-lucide="trending-up"></i><p>Belum ada riwayat point</p></div>`;
        lucideRefresh(); return;
      }
      content.innerHTML = `<div class="ledger-list">${entries.map(ledgerItemHtml).join('')}</div>`;
    } else {
      const { data, error } = await memberApi.rpc('member_get_transaction_history', { limit: 50, offset: 0 });
      if (error) { content.innerHTML = `<p class="error-msg">${esc(error.message)}</p>`; return; }
      const txList = data?.transactions || [];
      if (txList.length === 0) {
        content.innerHTML = `<div class="empty-state"><i data-lucide="shopping-bag"></i><p>Belum ada transaksi</p></div>`;
        lucideRefresh(); return;
      }
      content.innerHTML = `<div class="tx-list">${txList.map(txItemHtml).join('')}</div>`;
    }
    lucideRefresh();
  };

  await loadTab(memberState.historyTab);

  document.querySelectorAll('.filter-tab').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.filter-tab').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      loadTab(btn.dataset.htab);
    });
  });
}

// ── Page: Profile ───────────────────────────────────────────────
async function renderProfile() {
  setRoot(`
    <div class="mem-page">
      ${renderHeader('Profil Saya', false, true)}
      <div class="mem-content" id="profile-content">
        <div class="loading-center"><div class="spinner"></div></div>
      </div>
    </div>
  `);
  lucideRefresh();
  document.getElementById('btn-logout')?.addEventListener('click', doLogout);

  const { data: me, error } = await memberApi.rpc('member_me');
  const content = document.getElementById('profile-content');
  if (!content) return;

  if (error) { content.innerHTML = `<p class="error-msg">${esc(error.message)}</p>`; return; }

  memberState.member = me;

  content.innerHTML = `
    <!-- Identity card -->
    <div class="profile-card">
      <div class="profile-card-info">
        <div class="profile-avatar"><i data-lucide="user-circle-2"></i></div>
        <div>
          <div class="profile-name">${esc(me.name)}</div>
          <div class="profile-code">${esc(me.member_code)}</div>
        </div>
      </div>
      <button class="mem-qr-btn sm" id="profile-show-qr" title="QR Code">
        <div id="profile-qr-thumb"></div>
      </button>
    </div>

    <!-- Edit profile form -->
    <div class="form-section-title">Edit Profil</div>
    <form id="form-profile" class="mem-form" novalidate>
      <div class="form-group">
        <label class="form-label">Nama</label>
        <input class="form-input" type="text" id="p-name" value="${esc(me.name)}" />
      </div>
      <div class="form-group">
        <label class="form-label">Email <span class="optional">(opsional)</span></label>
        <input class="form-input" type="email" id="p-email" value="${esc(me.email || '')}" placeholder="email@contoh.com" />
      </div>
      <div class="form-group">
        <label class="form-label">Jenis Kelamin</label>
        <select class="form-input" id="p-gender">
          <option value="">-- Pilih --</option>
          <option value="M" ${me.gender === 'M' ? 'selected' : ''}>Laki-laki</option>
          <option value="F" ${me.gender === 'F' ? 'selected' : ''}>Perempuan</option>
          <option value="other" ${me.gender === 'other' ? 'selected' : ''}>Lainnya</option>
        </select>
      </div>
      <div class="form-group">
        <label class="form-label">Tanggal Lahir <span class="optional">(opsional)</span></label>
        <input class="form-input" type="date" id="p-dob" value="${esc(me.birth_date || '')}" />
      </div>
      <div class="form-group">
        <label class="form-label">Konfirmasi Password Saat Ini <span class="required">*</span></label>
        <div class="input-pw">
          <input class="form-input" type="password" id="p-curpw" placeholder="Wajib diisi untuk menyimpan" />
          <button type="button" class="btn-eye" data-target="p-curpw"><i data-lucide="eye"></i></button>
        </div>
      </div>
      <div id="profile-err" class="form-error" style="display:none"></div>
      <button type="submit" class="btn-primary btn-full">Simpan Perubahan</button>
    </form>

    <!-- Change password -->
    <div class="form-section-title" style="margin-top:24px">Ubah Password</div>
    <form id="form-chpw" class="mem-form" novalidate>
      <div class="form-group">
        <label class="form-label">Password Lama</label>
        <div class="input-pw">
          <input class="form-input" type="password" id="pw-old" />
          <button type="button" class="btn-eye" data-target="pw-old"><i data-lucide="eye"></i></button>
        </div>
      </div>
      <div class="form-group">
        <label class="form-label">Password Baru</label>
        <div class="input-pw">
          <input class="form-input" type="password" id="pw-new" />
          <button type="button" class="btn-eye" data-target="pw-new"><i data-lucide="eye"></i></button>
        </div>
      </div>
      <div class="form-group">
        <label class="form-label">Konfirmasi Password Baru</label>
        <div class="input-pw">
          <input class="form-input" type="password" id="pw-new2" />
          <button type="button" class="btn-eye" data-target="pw-new2"><i data-lucide="eye"></i></button>
        </div>
      </div>
      <div id="chpw-err" class="form-error" style="display:none"></div>
      <button type="submit" class="btn-outline btn-full">Ubah Password</button>
    </form>

    <!-- Account info -->
    <div class="form-section-title" style="margin-top:24px">Info Akun</div>
    <div class="info-block">
      <div class="info-row"><i data-lucide="phone"></i> ${esc(me.phone)}</div>
      ${!me.is_active ? `<div class="info-row" style="color:var(--danger)"><i data-lucide="alert-circle"></i> Akun tidak aktif. Hubungi admin.</div>` : ''}
      <div class="info-row text-muted"><i data-lucide="info"></i> Untuk ubah nomor HP, hubungi admin.</div>
    </div>
  `;

  lucideRefresh();
  bindEyeToggles();

  // QR thumbnail
  if (me.qr_token) {
    generateQR(me.qr_token, document.getElementById('profile-qr-thumb'));
  }
  document.getElementById('profile-show-qr')?.addEventListener('click', () => showQrModal(me));

  // Edit profile
  document.getElementById('form-profile').addEventListener('submit', async e => {
    e.preventDefault();
    const errEl = document.getElementById('profile-err');
    const btn   = e.target.querySelector('[type=submit]');
    hideFormError(errEl);
    const payload = {
      name:             document.getElementById('p-name').value.trim(),
      email:            document.getElementById('p-email').value.trim() || null,
      gender:           document.getElementById('p-gender').value || null,
      birth_date:       document.getElementById('p-dob').value || null,
      current_password: document.getElementById('p-curpw').value,
    };
    if (!payload.name)             { showFormError(errEl, 'Nama wajib diisi'); return; }
    if (!payload.current_password) { showFormError(errEl, 'Konfirmasi password wajib diisi'); return; }
    btn.disabled = true; btn.textContent = 'Menyimpan...';
    const { error } = await memberApi.rpc('member_update_profile', payload);
    btn.disabled = false; btn.textContent = 'Simpan Perubahan';
    if (error) { showFormError(errEl, error.message || 'Gagal menyimpan'); return; }
    document.getElementById('p-curpw').value = '';
    toast('Profil berhasil diperbarui', 'success');
  });

  // Change password
  document.getElementById('form-chpw').addEventListener('submit', async e => {
    e.preventDefault();
    const errEl  = document.getElementById('chpw-err');
    const btn    = e.target.querySelector('[type=submit]');
    const oldPw  = document.getElementById('pw-old').value;
    const newPw  = document.getElementById('pw-new').value;
    const newPw2 = document.getElementById('pw-new2').value;
    hideFormError(errEl);
    if (!oldPw || !newPw || !newPw2) { showFormError(errEl, 'Semua field wajib diisi'); return; }
    if (newPw !== newPw2)            { showFormError(errEl, 'Password baru tidak cocok'); return; }
    if (newPw.length < 6)            { showFormError(errEl, 'Password baru minimal 6 karakter'); return; }
    btn.disabled = true; btn.textContent = 'Menyimpan...';
    const { error } = await memberApi.rpc('member_change_password', { old_password: oldPw, new_password: newPw });
    btn.disabled = false; btn.textContent = 'Ubah Password';
    if (error) { showFormError(errEl, error.message || 'Gagal mengubah password'); return; }
    document.getElementById('pw-old').value  = '';
    document.getElementById('pw-new').value  = '';
    document.getElementById('pw-new2').value = '';
    toast('Password berhasil diubah', 'success');
  });
}

// ── Component helpers ───────────────────────────────────────────
function rewardMiniCardHtml(r, active) {
  const can = r.is_active && active >= r.cost_point && (!r.quota_total || r.quota_used < r.quota_total);
  return `<div class="reward-mini-card${can ? '' : ' dim'}" data-id="${r.id}">
    ${r.image_url
      ? `<img src="${esc(r.image_url)}" alt="${esc(r.name)}" />`
      : `<div class="reward-img-placeholder"><i data-lucide="gift"></i></div>`}
    <div class="reward-mini-name">${esc(r.name)}</div>
    <div class="reward-mini-cost${can ? ' can' : ''}">${r.cost_point} pt</div>
  </div>`;
}

function rewardCardHtml(r, active) {
  const can = r.is_active && active >= r.cost_point && (!r.quota_total || r.quota_used < r.quota_total);
  const quotaLeft = r.quota_total != null ? r.quota_total - r.quota_used : null;
  return `<div class="reward-card" data-id="${r.id}">
    <div class="reward-card-img">
      ${r.image_url
        ? `<img src="${esc(r.image_url)}" alt="${esc(r.name)}" />`
        : `<div class="reward-img-ph"><i data-lucide="gift"></i></div>`}
    </div>
    <div class="reward-card-body">
      <div class="reward-card-name">${esc(r.name)}</div>
      ${quotaLeft !== null ? `<div class="reward-card-quota text-xs text-muted">${Math.max(0, quotaLeft)} tersisa</div>` : ''}
      <div class="reward-card-footer">
        <span class="reward-cost${can ? ' can-claim' : ''}">${r.cost_point} pt</span>
        ${can
          ? `<span class="badge-sm badge-green">Klaim</span>`
          : `<span class="badge-sm badge-gray">${active < r.cost_point ? '-' + (r.cost_point - active) + ' pt' : 'Habis'}</span>`}
      </div>
    </div>
  </div>`;
}

function txItemHtml(t) {
  return `<div class="tx-item">
    <div class="tx-item-left">
      <div class="tx-item-date">${formatDateTime(t.created_at)}</div>
      ${t.branch_name ? `<div class="tx-item-branch text-muted text-xs">${esc(t.branch_name)}</div>` : ''}
    </div>
    <div class="tx-item-right">
      <div class="tx-item-total">${formatRp(t.total)}</div>
      ${t.points_awarded > 0 ? `<div class="tx-item-pts">+${t.points_awarded} pt</div>` : ''}
    </div>
  </div>`;
}

function ledgerItemHtml(e) {
  const isIn = e.direction === 'in';
  const dirClass = e.direction === 'none' ? 'none' : (isIn ? 'in' : 'out');
  const typeLabels = {
    earn_purchase:    'Belanja',
    earn_pending:     'Pending Belanja',
    pending_to_active:'Point Aktif',
    redeem_reserve:   'Klaim Reward',
    redeem_commit:    'Reward Digunakan',
    redeem_refund:    'Klaim Dibatalkan',
    refund_reversal:  'Refund Transaksi',
    manual_adjust_in: 'Penyesuaian (+)',
    manual_adjust_out:'Penyesuaian (-)',
    expire:           'Kedaluwarsa',
    fraud_lock:       'Point Dikunci',
    fraud_unlock:     'Point Dibuka',
  };
  const iconName = isIn ? 'arrow-down-left' : (e.direction === 'none' ? 'minus' : 'arrow-up-right');
  return `<div class="ledger-item">
    <div class="ledger-icon ${dirClass}"><i data-lucide="${iconName}"></i></div>
    <div class="ledger-info">
      <div class="ledger-type">${esc(typeLabels[e.movement_type] || e.movement_type)}</div>
      <div class="ledger-date text-xs text-muted">${formatDateTime(e.created_at)}</div>
      ${e.reason ? `<div class="ledger-reason text-xs text-muted">${esc(e.reason)}</div>` : ''}
    </div>
    <div class="ledger-pts ${dirClass}">${isIn ? '+' : (e.direction === 'none' ? '' : '-')}${e.points}</div>
  </div>`;
}

function claimCardHtml(c) {
  const statusLabels = {
    pending_approval: 'Menunggu Persetujuan',
    redeemable: 'Siap Digunakan',
  };
  return `<div class="claim-card">
    <div class="claim-card-top">
      <div class="claim-card-name">${esc(c.reward_name || 'Reward')}</div>
      <span class="claim-status ${c.status}">${statusLabels[c.status] || c.status}</span>
    </div>
    <div class="claim-qr-area">
      <div id="claim-qr-${c.id}" class="claim-qr-box"></div>
    </div>
    <div class="claim-code">${esc(c.redemption_code)}</div>
    <div class="claim-countdown text-xs text-muted">${countdown(c.expires_at)}</div>
    ${c.status === 'redeemable'
      ? `<button class="btn-outline btn-sm btn-danger" data-cancel-claim="${c.id}" style="margin-top:10px;width:100%">Batalkan Klaim</button>`
      : ''}
  </div>`;
}

function claimHistoryItemHtml(c) {
  const labels = { redeemed: 'Sudah Digunakan', cancelled: 'Dibatalkan', expired: 'Kedaluwarsa' };
  return `<div class="claim-history-item">
    <div class="claim-history-name">${esc(c.reward_name || 'Reward')}</div>
    <div class="claim-history-meta text-xs text-muted">${formatDate(c.claimed_at)} · ${esc(c.redemption_code)}</div>
    <span class="claim-status ${c.status}">${labels[c.status] || c.status}</span>
  </div>`;
}

// ── Actions ─────────────────────────────────────────────────────
async function doClaimReward(reward) {
  if (!confirm(`Klaim "${reward.name}" dengan ${reward.cost_point} point?`)) return;
  const btn = document.getElementById('btn-claim-reward');
  if (btn) { btn.disabled = true; btn.textContent = 'Mengklaim...'; }
  const { data, error } = await memberApi.rpc('member_claim_reward', { reward_id: reward.id });
  if (btn) { btn.disabled = false; btn.textContent = `Klaim (${reward.cost_point} point)`; }
  if (error) { toast(error.message || 'Klaim gagal', 'error'); return; }
  // refresh balance cache
  memberState.balance = { active: data?.balance_active ?? 0, pending: data?.balance_pending ?? 0 };
  toast('Reward berhasil diklaim! Lihat di tab Klaim.', 'success');
  navigate('my-claims');
}

async function doCancelClaim(claimId) {
  if (!confirm('Batalkan klaim ini? Point akan dikembalikan ke akun kamu.')) return;
  const { error } = await memberApi.rpc('member_cancel_claim', { claim_id: claimId });
  if (error) { toast(error.message || 'Gagal membatalkan', 'error'); return; }
  toast('Klaim dibatalkan, point dikembalikan', 'success');
  await renderMyClaims();
}

async function doLogout() {
  if (!confirm('Keluar dari akun member?')) return;
  await memberApi.rpc('member_logout');
  clearMemberSession();
  navigate('login');
}

// ── QR Modal ─────────────────────────────────────────────────────
function showQrModal(me) {
  document.getElementById('qr-modal-name').textContent = me.name || '';
  document.getElementById('qr-modal-code').textContent = me.member_code || '';
  const canvas = document.getElementById('qr-modal-canvas');
  canvas.innerHTML = '';
  if (me.qr_token) generateQR(me.qr_token, canvas);
  document.getElementById('qr-modal').style.display = 'flex';
}

// ── Init ─────────────────────────────────────────────────────────
window.navigate       = navigate;
window.doCancelClaim  = doCancelClaim;

window.addEventListener('hashchange', handleRoute);

document.addEventListener('DOMContentLoaded', () => {
  // Bottom nav
  document.querySelectorAll('.nav-item[data-nav]').forEach(btn => {
    btn.addEventListener('click', () => navigate(btn.dataset.nav));
  });

  // QR modal
  document.getElementById('qr-modal-backdrop')?.addEventListener('click', () => {
    document.getElementById('qr-modal').style.display = 'none';
  });
  document.getElementById('qr-modal-close')?.addEventListener('click', () => {
    document.getElementById('qr-modal').style.display = 'none';
  });

  handleRoute();
});
