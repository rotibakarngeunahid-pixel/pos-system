'use strict';

// ═══════════════════════════════════════════════════════════════
// RBN Member UI — Panel kasir untuk modul loyalty
// Depends on: apiClient.js (API_BASE, API_KEY, db, getRbnSessionToken)
// ═══════════════════════════════════════════════════════════════
const memberUi = (() => {

  // ── State ───────────────────────────────────────────────────
  const state = {
    enabled:       false,
    pointRatio:    10000,   // rupiah per 1 point (from settings)
    member:        null,    // { id, name, member_code, phone, qr_token, is_active }
    balance:       null,    // { active, pending }
    previewPts:    null,    // computed int
    redemptionCode: null,   // 8-char code entered by cashier
    redemptionInfo: null,   // { reward_name, reward_type, discount_value, reward_product_id, reward_variant_id, cost_point }
    _validated:    null,    // hasil validasi sementara: { code, reward, claim }
  };

  // ── API helpers (staff session) ─────────────────────────────
  async function staffRpc(name, params = {}) {
    const token = getRbnSessionToken();
    const res = await fetch(`${API_BASE}/rpc/${name}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-API-Key': API_KEY,
        ...(token ? { 'X-Session-Token': token } : {}),
      },
      body: JSON.stringify(params),
    });
    const json = await res.json();
    if (!res.ok) throw new Error(json?.error?.message || json?.error?.code || 'RPC gagal');
    return json;
  }

  // ── Init ─────────────────────────────────────────────────────
  async function init() {
    try {
      const { data } = await db.from('member_settings')
        .select('setting_key, setting_value')
        .in('setting_key', ['enable_loyalty_module', 'point_ratio_rupiah_per_point']);
      (data || []).forEach(r => {
        if (r.setting_key === 'enable_loyalty_module')    state.enabled    = r.setting_value === '1';
        if (r.setting_key === 'point_ratio_rupiah_per_point') state.pointRatio = parseInt(r.setting_value) || 10000;
      });
    } catch {
      state.enabled = false;
    }

    // Register event listeners (action delegation)
    document.addEventListener('click', _handleAction);

    // Keypress: Enter in search input
    document.addEventListener('keydown', e => {
      if (e.key === 'Enter' && document.activeElement?.id === 'pos-member-search-input') {
        document.getElementById('pos-member-search-btn')?.click();
      }
      if (e.key === 'Enter' && document.activeElement?.id === 'pos-redeem-code-input') {
        document.getElementById('pos-redeem-validate-btn')?.click();
      }
    });

    renderPanel();
  }

  function _handleAction(e) {
    const btn = e.target.closest('[data-action]');
    if (!btn) return;
    switch (btn.dataset.action) {
      case 'pos-member-search':   openSearchModal(); break;
      case 'pos-member-detach':   detachMember(); break;
      case 'pos-reward-redeem':   openRedeemModal(); break;
      case 'pos-reward-cancel':   cancelRedemption(); break;
      case 'pos-member-confirm':  confirmSearchResult(); break;
      case 'pos-redeem-validate': validateRedeemInput(); break;
      case 'pos-redeem-apply':    applyRedemption(); break;
    }
  }

  // ── Render panel ─────────────────────────────────────────────
  function renderPanel() {
    const container = document.getElementById('member-panel-container');
    if (!container) return;
    if (!state.enabled) { container.innerHTML = ''; return; }
    container.innerHTML = panelHtml();
    if (typeof lucide !== 'undefined') lucide.createIcons();
  }

  function panelHtml() {
    if (!state.member) {
      return `<div class="mem-pos-panel">
        <div class="mem-pos-row">
          <div class="mem-pos-empty-label"><i data-lucide="user-x"></i> Tanpa Member</div>
          <button class="btn btn-outline btn-sm" data-action="pos-member-search" style="font-size:12px;padding:5px 10px;">
            <i data-lucide="search"></i> Cari Member
          </button>
        </div>
      </div>`;
    }

    const m = state.member;
    const bal = state.balance;
    const activeStr = bal != null ? bal.active.toLocaleString('id-ID') + ' pt' : '...';
    const previewStr = state.redemptionInfo
      ? `<div class="mem-pos-preview" style="color:var(--text-muted);background:var(--surface-2)"><i data-lucide="info"></i> Transaksi reward — tidak dapat point</div>`
      : (state.previewPts !== null
        ? `<div class="mem-pos-preview"><i data-lucide="trending-up"></i> +${state.previewPts} point dari transaksi ini</div>`
        : '');
    const rewardSection = state.redemptionInfo
      ? `<div class="mem-pos-reward-applied">
           <i data-lucide="check-circle" style="color:var(--success);"></i>
           <span style="font-size:12px;flex:1">Reward: <b>${escapeHtml(state.redemptionInfo.reward_name)}</b></span>
           <button data-action="pos-reward-cancel" style="font-size:11px;color:var(--danger);background:none;border:none;cursor:pointer;">✕ Hapus</button>
         </div>`
      : `<button class="btn btn-outline btn-sm" data-action="pos-reward-redeem" style="font-size:11px;width:100%;margin-top:4px;">
           <i data-lucide="gift"></i> Gunakan Kode Reward
         </button>`;

    return `<div class="mem-pos-panel">
      <div class="mem-pos-row">
        <div class="mem-pos-member-info">
          <div class="mem-pos-name">${escapeHtml(m.name)}</div>
          <div class="mem-pos-meta">${escapeHtml(m.member_code)} · ${activeStr}</div>
        </div>
        <button class="btn btn-ghost btn-sm" data-action="pos-member-detach"
          style="font-size:11px;color:var(--danger);padding:4px 8px;" title="Lepas member">
          ✕ Lepas
        </button>
      </div>
      ${previewStr}
      ${rewardSection}
    </div>`;
  }

  // ── Member Search Modal ───────────────────────────────────────
  function openSearchModal() {
    if (!state.enabled) return;
    const modal = document.getElementById('modal-member-search');
    if (!modal) return;
    // Reset state
    const inp = document.getElementById('pos-member-search-input');
    const res = document.getElementById('pos-member-search-result');
    if (inp) inp.value = '';
    if (res) res.innerHTML = '';
    modal.classList.add('active');
    inp?.focus();
    if (typeof lucide !== 'undefined') lucide.createIcons();
  }

  async function confirmSearchResult() {
    const resultEl = document.getElementById('pos-member-search-result');
    const selected = resultEl?.querySelector('[data-member-id]');
    if (!selected) return;
    const m = JSON.parse(selected.dataset.memberData || '{}');
    attachMember(m);
    closeSearchModal();
  }

  function closeSearchModal() {
    document.getElementById('modal-member-search')?.classList.remove('active');
  }

  // Called by the Search button
  async function _doSearch() {
    const inp = document.getElementById('pos-member-search-input');
    const resultEl = document.getElementById('pos-member-search-result');
    if (!inp || !resultEl) return;
    const query = inp.value.trim();
    if (!query) { resultEl.innerHTML = '<p style="font-size:12px;color:var(--text-muted)">Masukkan nomor HP atau kode member</p>'; return; }

    resultEl.innerHTML = '<div style="display:flex;justify-content:center;padding:12px"><div class="spinner" style="width:24px;height:24px;border-width:2px"></div></div>';
    try {
      const data = await staffRpc('member_lookup', { query });
      if (!data || !data.id) {
        resultEl.innerHTML = '<p style="font-size:12px;color:var(--danger)">Member tidak ditemukan</p>';
        return;
      }
      const bal = data.balance_active != null ? data.balance_active : '—';
      resultEl.innerHTML = `
        <div class="mem-search-result" data-member-id="${data.id}" data-member-data='${JSON.stringify(data).replace(/'/g, '&#39;')}'>
          <div style="flex:1;min-width:0">
            <div style="font-weight:700;font-size:14px">${escapeHtml(data.name)}</div>
            <div style="font-size:12px;color:var(--text-muted)">${escapeHtml(data.member_code)} · ${escapeHtml(data.phone || '')}</div>
            <div style="font-size:12px;color:var(--primary);font-weight:600">${typeof bal === 'number' ? bal.toLocaleString('id-ID') + ' pt aktif' : ''}</div>
            ${!data.is_active ? '<div style="font-size:11px;color:var(--danger)">⚠ Akun tidak aktif</div>' : ''}
          </div>
          <button class="btn btn-primary btn-sm" data-action="pos-member-confirm" style="flex-shrink:0" ${!data.is_active ? 'disabled' : ''}>
            Pilih
          </button>
        </div>
      `;
    } catch (err) {
      resultEl.innerHTML = `<p style="font-size:12px;color:var(--danger)">${escapeHtml(err.message)}</p>`;
    }
    if (typeof lucide !== 'undefined') lucide.createIcons();
  }

  // ── Reward Redeem Modal ───────────────────────────────────────
  function openRedeemModal() {
    if (!state.member) {
      showToast('Pilih member terlebih dahulu sebelum menggunakan reward', 'warning');
      return;
    }
    const modal = document.getElementById('modal-reward-redeem');
    if (!modal) return;
    const inp = document.getElementById('pos-redeem-code-input');
    const res = document.getElementById('pos-redeem-result');
    if (inp) inp.value = state.redemptionCode || '';
    if (res) res.innerHTML = '';
    modal.classList.add('active');
    inp?.focus();
    if (typeof lucide !== 'undefined') lucide.createIcons();
  }

  async function validateRedeemInput() {
    const inp = document.getElementById('pos-redeem-code-input');
    const resultEl = document.getElementById('pos-redeem-result');
    if (!inp || !resultEl) return;
    const code = inp.value.trim().toUpperCase();
    if (code.length < 6) {
      resultEl.innerHTML = '<p style="font-size:12px;color:var(--danger)">Kode klaim tidak valid (min. 6 karakter)</p>';
      return;
    }

    resultEl.innerHTML = '<div style="display:flex;justify-content:center;padding:12px"><div class="spinner" style="width:24px;height:24px;border-width:2px"></div></div>';
    try {
      // Validate via table query (read-only, no commit)
      const { data: claim, error: claimErr } = await db.from('member_reward_claims')
        .select('id, status, expires_at, cost_point, member_id, reward_id, redemption_code')
        .eq('redemption_code', code)
        .maybeSingle();

      if (claimErr || !claim) {
        resultEl.innerHTML = '<p style="font-size:12px;color:var(--danger)">Kode tidak ditemukan</p>';
        return;
      }
      if (claim.status !== 'redeemable') {
        const statusMap = { pending_approval: 'Menunggu persetujuan', redeemed: 'Sudah digunakan', cancelled: 'Dibatalkan', expired: 'Kedaluwarsa' };
        resultEl.innerHTML = `<p style="font-size:12px;color:var(--danger)">Kode tidak bisa digunakan: ${statusMap[claim.status] || claim.status}</p>`;
        return;
      }
      if (new Date(claim.expires_at) < new Date()) {
        resultEl.innerHTML = '<p style="font-size:12px;color:var(--danger)">Kode sudah kedaluwarsa</p>';
        return;
      }
      if (state.member && claim.member_id !== state.member.id) {
        resultEl.innerHTML = '<p style="font-size:12px;color:var(--danger)">Kode bukan milik member yang terpilih</p>';
        return;
      }

      // Get reward detail (termasuk target produk untuk free_product)
      const { data: reward } = await db.from('member_rewards')
        .select('name, reward_type, discount_value, reward_product_id, reward_variant_id')
        .eq('id', claim.reward_id)
        .maybeSingle();

      const rewardName = reward?.name || 'Reward';
      // Simpan untuk applyRedemption (hitung diskon saat checkout)
      state._validated = { code, reward: reward || null, claim };
      resultEl.innerHTML = `
        <div style="background:var(--success-bg);border:1px solid #bbf7d0;border-radius:8px;padding:12px;" data-code="${code}" data-reward-name="${escapeHtml(rewardName)}">
          <div style="font-weight:700;font-size:14px;color:var(--success)">${escapeHtml(rewardName)}</div>
          <div style="font-size:12px;color:var(--text-muted);margin-top:2px">Kode: ${code} · ${claim.cost_point} pt</div>
          <button class="btn btn-primary btn-sm" data-action="pos-redeem-apply" style="margin-top:10px;width:100%">
            Terapkan ke Transaksi
          </button>
        </div>
      `;
    } catch (err) {
      resultEl.innerHTML = `<p style="font-size:12px;color:var(--danger)">${escapeHtml(err.message)}</p>`;
    }
    if (typeof lucide !== 'undefined') lucide.createIcons();
  }

  function applyRedemption() {
    const resultEl = document.getElementById('pos-redeem-result');
    const infoEl = resultEl?.querySelector('[data-code]');
    const v = state._validated;
    const code = v?.code || infoEl?.dataset.code;
    if (!code) return;
    const reward = v?.reward || null;
    state.redemptionCode = code;
    state.redemptionInfo = {
      reward_name:       reward?.name || infoEl?.dataset.rewardName || 'Reward',
      reward_type:       reward?.reward_type || 'other',
      discount_value:    Number(reward?.discount_value ?? 0) || 0,
      reward_product_id: reward?.reward_product_id ?? null,
      reward_variant_id: reward?.reward_variant_id ?? null,
      cost_point:        Number(v?.claim?.cost_point ?? 0) || 0,
    };
    document.getElementById('modal-reward-redeem')?.classList.remove('active');
    renderPanel();
    // Refresh cart agar diskon reward langsung masuk ke total & layar pembayaran
    if (window.POS && typeof POS.renderCart === 'function') POS.renderCart();
    showToast('Reward diterapkan — diskon otomatis masuk ke total', 'success');
  }

  function cancelRedemption() {
    state.redemptionCode = null;
    state.redemptionInfo = null;
    state._validated     = null;
    renderPanel();
    if (window.POS && typeof POS.renderCart === 'function') POS.renderCart();
  }

  // Diskon reward (Rp) untuk subtotal saat ini — dipanggil POS.calcDiscount.
  // Logika WAJIB identik dengan memberComputeRewardDiscount() di backend.
  function getRewardDiscount(subtotal) {
    const info = state.redemptionInfo;
    if (!state.enabled || !info || !info.reward_type) return 0;
    const sub = Number(subtotal) || 0;
    if (sub <= 0) return 0;
    const val = Number(info.discount_value) || 0;
    let d = 0;
    switch (info.reward_type) {
      case 'discount_amount':  d = val; break;
      case 'discount_percent': d = Math.round(sub * val / 100); break;
      case 'free_product': {
        const pid = info.reward_product_id ? Number(info.reward_product_id) : 0;
        const vid = info.reward_variant_id ? Number(info.reward_variant_id) : 0;
        const cart = (window.POS && Array.isArray(POS.cart)) ? POS.cart : [];
        for (const it of cart) {
          const ipid = Number(it.productId ?? it.product_id ?? 0);
          const ivid = Number(it.variantId ?? it.variant_id ?? 0);
          if ((vid && ivid === vid) || (!vid && pid && ipid === pid)) {
            // Satu unit gratis termasuk topping — samakan dengan harga per-unit yang
            // dihitung backend (basePrice + toppingTotal) agar cakupan diskon cocok.
            const tT = (it.toppings || []).reduce((s, t) => s + (Number(t.price) || 0), 0);
            d = (Number(it.price) || 0) + tT;
            break;
          }
        }
        break;
      }
      default: d = 0; // 'other'
    }
    if (d < 0) d = 0;
    if (d > sub) d = sub;
    return d;
  }

  // ── Member attach / detach ────────────────────────────────────
  function attachMember(memberData) {
    state.member = memberData;
    state.balance = memberData.balance_active != null
      ? { active: memberData.balance_active, pending: memberData.balance_pending ?? 0 }
      : null;
    state.previewPts = null;
    renderPanel();
  }

  function detachMember() {
    const hadReward = !!state.redemptionInfo;
    state.member = null;
    state.balance = null;
    state.previewPts = null;
    state.redemptionCode = null;
    state.redemptionInfo = null;
    state._validated = null;
    renderPanel();
    // Jika tadi ada diskon reward, refresh cart agar total kembali normal
    if (hadReward && window.POS && typeof POS.renderCart === 'function') POS.renderCart();
  }

  // ── Preview points (called by pos.js renderCart) ──────────────
  function updatePreview(subtotal) {
    if (!state.enabled || !state.member || !subtotal) {
      if (state.previewPts !== null) { state.previewPts = null; renderPanel(); }
      return;
    }
    const pts = Math.floor(subtotal / state.pointRatio);
    if (pts !== state.previewPts) {
      state.previewPts = pts;
      renderPanel();
    }
  }

  // ── After checkout ────────────────────────────────────────────
  function afterCheckout(result) {
    const trx = result?.trx;
    if (trx?.reward_redeemed) {
      showToast(`Reward "${escapeHtml(trx.reward_redeemed.reward_name || '')}" berhasil dipakai`, 'success', 5000);
    } else if (trx?.points_awarded > 0) {
      showToast(`Member ${escapeHtml(state.member?.name || '')} mendapat +${trx.points_awarded} point`, 'success', 5000);
    }
    detachMember();
  }

  // ── Public API ────────────────────────────────────────────────
  return {
    init,
    getMemberId:       () => state.member?.id || null,
    getRedemptionCode: () => state.redemptionCode || null,
    getRewardDiscount,
    updatePreview,
    afterCheckout,
    _doSearch,        // exposed for inline button handler
  };

})();

// ═══════════════════════════════════════════════════════════════
// CSS for member panel (injected once)
// ═══════════════════════════════════════════════════════════════
(function injectMemberPosStyles() {
  if (document.getElementById('member-pos-styles')) return;
  const s = document.createElement('style');
  s.id = 'member-pos-styles';
  s.textContent = `
    .mem-pos-panel {
      border-top: 1px solid var(--border);
      padding: 10px 0 6px;
      display: flex; flex-direction: column; gap: 6px;
    }
    .mem-pos-row {
      display: flex; align-items: center; justify-content: space-between; gap: 8px;
    }
    .mem-pos-empty-label {
      display: flex; align-items: center; gap: 6px;
      font-size: 13px; color: var(--text-muted);
    }
    .mem-pos-empty-label svg { width: 16px; height: 16px; }
    .mem-pos-member-info { flex: 1; min-width: 0; }
    .mem-pos-name { font-size: 13px; font-weight: 700; color: var(--text); }
    .mem-pos-meta { font-size: 11px; color: var(--text-muted); margin-top: 1px; }
    .mem-pos-preview {
      display: flex; align-items: center; gap: 5px;
      font-size: 12px; font-weight: 600; color: var(--success);
      background: var(--success-bg); border-radius: 6px; padding: 4px 8px;
    }
    .mem-pos-preview svg { width: 13px; height: 13px; }
    .mem-pos-reward-applied {
      display: flex; align-items: center; gap: 6px;
      background: var(--success-bg); border-radius: 6px; padding: 6px 8px;
      font-size: 12px;
    }
    .mem-pos-reward-applied svg { width: 14px; height: 14px; flex-shrink: 0; }
    .mem-search-result {
      display: flex; align-items: center; justify-content: space-between; gap: 12px;
      background: var(--surface-2); border: 1px solid var(--border);
      border-radius: 8px; padding: 12px;
    }
    /* Spinner reuse */
    .spinner { border-radius:50%; animation: spin .7s linear infinite; border-top-color:var(--primary); border: 3px solid var(--border); }
    @keyframes spin { to { transform: rotate(360deg); } }
  `;
  document.head.appendChild(s);
})();

window.memberUi = memberUi;
