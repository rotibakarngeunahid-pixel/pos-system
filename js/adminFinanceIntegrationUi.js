'use strict';

// ══════════════════════════════════════════════════════════════════════════
// Portal Integrasi Data Keuangan — adminFinanceIntegrationUi.js
// ══════════════════════════════════════════════════════════════════════════
//
// Halaman ini menyediakan portal lengkap untuk membagikan data kasir ke
// sistem keuangan eksternal. Tiga jenis data tersedia:
//   1. get_sales_integration      — data penjualan (migration 049)
//   2. get_kas_keluar_integration — data kas keluar (migration 039)
//   3. get_integration_summary    — ringkasan gabungan (migration 049)
//
// Setiap endpoint divalidasi dengan API key yang dikelola admin.
// Tidak ada perubahan struktur data — hanya membaca tabel yang sudah ada.
// ══════════════════════════════════════════════════════════════════════════

const adminDataIntegrationPortalUi = {

  // ── State ─────────────────────────────────────────────────────────────
  _apiKeys:        [],
  _previewSales:   null,
  _previewCashout: null,
  _previewSummary: null,
  _currentTab:     'sales',
  _bound:          false,

  _sessionToken() {
    return auth.getSession()?.session_token || '';
  },

  _isMissingRpcError(error) {
    const msg  = String(error?.message || error || '').toLowerCase();
    const code = String(error?.code || '');
    return code === '42883'
      || code === 'PGRST202'
      || msg.includes('could not find the function')
      || (msg.includes('function') && msg.includes('does not exist'));
  },

  // ── Init ──────────────────────────────────────────────────────────────
  init() {
    const boot = () => {
      try { this._bindEvents(); }
      catch (e) { console.error('adminDataIntegrationPortalUi.init', e); }
    };
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', boot, { once: true });
    } else {
      boot();
    }
  },

  _bindEvents() {
    if (this._bound) return;
    this._bound = true;

    const on = (id, ev, fn) => {
      const el = document.getElementById(id);
      if (el) el.addEventListener(ev, fn.bind(this));
    };

    // ── Tab navigation ──────────────────────────────────────────
    document.querySelectorAll('[data-dip-tab]').forEach(btn => {
      btn.addEventListener('click', () => this._switchTab(btn.dataset.dipTab));
    });

    // ── Tab: Penjualan ──────────────────────────────────────────
    on('dip-sales-branch',     'change', () => this._buildLink('sales'));
    on('dip-sales-apikey',     'change', () => this._buildLink('sales'));
    on('dip-sales-limit',      'input',  () => this._buildLink('sales'));
    on('dip-sales-offset',     'input',  () => this._buildLink('sales'));
    on('dip-sales-date-from',  'change', () => {}); // tanggal hanya untuk preview
    on('dip-sales-date-to',    'change', () => {});
    on('dip-sales-copy-btn',   'click',  () => this._copyLink('sales'));
    on('dip-sales-preview-btn','click',  () => this._loadPreview('sales'));
    on('dip-sales-export-btn', 'click',  () => this._exportCsv('sales'));

    // ── Tab: Kas Keluar ─────────────────────────────────────────
    on('dip-cashout-branch',      'change', () => this._buildLink('cashout'));
    on('dip-cashout-apikey',      'change', () => this._buildLink('cashout'));
    on('dip-cashout-limit',       'input',  () => this._buildLink('cashout'));
    on('dip-cashout-offset',      'input',  () => this._buildLink('cashout'));
    on('dip-cashout-date-from',   'change', () => {}); // tanggal hanya untuk preview
    on('dip-cashout-date-to',     'change', () => {});
    on('dip-cashout-copy-btn',    'click',  () => this._copyLink('cashout'));
    on('dip-cashout-preview-btn', 'click',  () => this._loadPreview('cashout'));
    on('dip-cashout-export-btn',  'click',  () => this._exportCsv('cashout'));

    // ── Tab: Ringkasan ──────────────────────────────────────────
    on('dip-summary-branch',      'change', () => this._buildLink('summary'));
    on('dip-summary-apikey',      'change', () => this._buildLink('summary'));
    on('dip-summary-date-from',   'change', () => {});
    on('dip-summary-date-to',     'change', () => {});
    on('dip-summary-copy-btn',    'click',  () => this._copyLink('summary'));
    on('dip-summary-preview-btn', 'click',  () => this._loadPreview('summary'));

    // ── Refresh & Docs ──────────────────────────────────────────
    on('dip-refresh-btn',   'click', () => this.load());
    on('dip-copy-docs-btn', 'click', () => this._copyDocs());
  },

  // ── Load (entry point dari admin.js) ──────────────────────────────────
  async load() {
    this._setDefaults();
    await this._loadApiKeys();
    this._buildLink('sales');
    this._buildLink('cashout');
    this._buildLink('summary');
    this._updateDocEndpoints();
  },

  // ── Set defaults (tidak lagi auto-fill tanggal) ───────────────────────
  // Tanggal dibiarkan kosong — semua data dikembalikan oleh API.
  // Filter tanggal dilakukan di sistem keuangan eksternal.
  _setDefaults() {
    // Tidak set default tanggal. Tanggal opsional untuk preview saja.
  },

  // ── Muat daftar API key ke semua dropdown ──────────────────────────────
  async _loadApiKeys() {
    const selIds = ['dip-sales-apikey', 'dip-cashout-apikey', 'dip-summary-apikey'];
    selIds.forEach(id => {
      const el = document.getElementById(id);
      if (el) el.innerHTML = '<option value="">Memuat...</option>';
    });

    const warning = document.getElementById('dip-apikey-warning');

    try {
      let data, error = null;
      const rpcRes = await db.rpc('rbn_admin_list_api_keys', {
        p_session_token: this._sessionToken() || null
      });

      if (rpcRes.error && this._isMissingRpcError(rpcRes.error)) {
        const legacyRes = await db
          .from('api_keys')
          .select('id, name, key_value, is_active')
          .eq('is_active', true)
          .order('created_at', { ascending: false });
        data = legacyRes.data;
        error = legacyRes.error;
      } else {
        data = rpcRes.data;
        error = rpcRes.error;
      }

      if (error) throw error;
      this._apiKeys = (data || []).filter(k => k.is_active);

      if (!this._apiKeys.length) {
        const empty = '<option value="">— Belum ada API key aktif —</option>';
        selIds.forEach(id => {
          const el = document.getElementById(id);
          if (el) el.innerHTML = empty;
        });
        if (warning) warning.style.display = '';
        return;
      }

      if (warning) warning.style.display = 'none';

      const opts = '<option value="">— Pilih API Key —</option>' +
        this._apiKeys.map(k =>
          `<option value="${escHtml(k.key_value)}">${escHtml(k.name)}</option>`
        ).join('');

      selIds.forEach(id => {
        const el = document.getElementById(id);
        if (el) el.innerHTML = opts;
      });
    } catch (e) {
      const errOpt = '<option value="">Gagal memuat API key</option>';
      selIds.forEach(id => {
        const el = document.getElementById(id);
        if (el) el.innerHTML = errOpt;
      });
      console.error('dip._loadApiKeys:', e);
    }
  },

  // ── Tab switching ──────────────────────────────────────────────────────
  _switchTab(tab) {
    this._currentTab = tab;
    ['sales', 'cashout', 'summary'].forEach(t => {
      const btn     = document.getElementById(`dip-tab-${t}`);
      const content = document.getElementById(`dip-content-${t}`);
      const isActive = (t === tab);
      if (btn)     btn.classList.toggle('active', isActive);
      if (content) content.style.display = isActive ? '' : 'none';
    });
    if (window.lucide) lucide.createIcons();
  },

  // ── Build & display endpoint link ─────────────────────────────────────
  // Link utama TIDAK menyertakan tanggal — filter dilakukan di sistem keuangan.
  // Limit & offset disertakan agar sistem keuangan bisa langsung pakai pagination.
  _buildLink(tab) {
    const apiKey   = document.getElementById(`dip-${tab}-apikey`)?.value    || '';
    const branchId = document.getElementById(`dip-${tab}-branch`)?.value    || '';
    // Limit/offset hanya ada di tab sales & cashout; summary tidak pakai
    const limitEl  = document.getElementById(`dip-${tab}-limit`);
    const offsetEl = document.getElementById(`dip-${tab}-offset`);
    const limit    = limitEl  ? (parseInt(limitEl.value, 10)  || 1000) : null;
    const offset   = offsetEl ? (parseInt(offsetEl.value, 10) || 0)    : null;
    const linkBox  = document.getElementById(`dip-${tab}-link-box`);
    const copyBtn  = document.getElementById(`dip-${tab}-copy-btn`);

    if (!apiKey) {
      if (linkBox) { linkBox.textContent = '← Pilih API Key untuk melihat link'; linkBox.style.color = 'var(--text-muted)'; }
      if (copyBtn) copyBtn.disabled = true;
      return;
    }

    const apiBase = (typeof API_BASE !== 'undefined' ? API_BASE : 'https://api.rotibakarngeunah.my.id/api/api.php');

    const rpcName = tab === 'sales'   ? 'get_sales_integration'
                  : tab === 'cashout' ? 'get_kas_keluar_integration'
                  :                     'get_integration_summary';

    const params = new URLSearchParams({ p_api_key: apiKey });
    if (branchId)            params.set('p_branch_id', branchId);
    if (limit  !== null)     params.set('p_limit',  limit);
    if (offset !== null && offset > 0) params.set('p_offset', offset);

    const link = `${apiBase}/rpc/${rpcName}?${params.toString()}`;
    if (linkBox) { linkBox.textContent = link; linkBox.style.color = 'var(--text)'; }
    if (copyBtn) copyBtn.disabled = false;
  },

  // ── Salin link ke clipboard ────────────────────────────────────────────
  async _copyLink(tab) {
    const linkBox = document.getElementById(`dip-${tab}-link-box`);
    const link    = linkBox?.textContent?.trim();
    if (!link || link.startsWith('←')) {
      showToast('Pilih API Key terlebih dahulu', 'warning');
      return;
    }
    try {
      await navigator.clipboard.writeText(link);
      showToast('Link endpoint berhasil disalin! 🎉', 'success');
      const btn = document.getElementById(`dip-${tab}-copy-btn`);
      if (btn) {
        const orig = btn.innerHTML;
        btn.innerHTML = '<i data-lucide="check" style="width:14px;height:14px;vertical-align:middle"></i> Tersalin!';
        if (window.lucide) lucide.createIcons();
        setTimeout(() => { btn.innerHTML = orig; if (window.lucide) lucide.createIcons(); }, 2200);
      }
    } catch (e) {
      showToast('Gagal menyalin. Salin manual dari kotak link.', 'warning');
    }
  },

  // ── Validasi tanggal (opsional — hanya untuk preview) ─────────────────
  // Tidak ada batasan 365 hari. Filter tanggal sepenuhnya opsional.
  _validateDates(tab) {
    const from  = document.getElementById(`dip-${tab}-date-from`)?.value;
    const to    = document.getElementById(`dip-${tab}-date-to`)?.value;
    const errEl = document.getElementById(`dip-${tab}-date-error`);
    const hide  = () => { if (errEl) errEl.style.display = 'none'; };
    const show  = (msg) => { if (errEl) { errEl.textContent = msg; errEl.style.display = ''; } };

    if (from && to && from > to) {
      show('Tanggal mulai tidak boleh lebih besar dari tanggal akhir.');
      return false;
    }
    hide();
    return true;
  },

  // ── Load & tampilkan preview data ──────────────────────────────────────
  async _loadPreview(tab) {
    const apiKey   = document.getElementById(`dip-${tab}-apikey`)?.value    || '';
    const branchId = document.getElementById(`dip-${tab}-branch`)?.value    || '';
    const dateFrom = document.getElementById(`dip-${tab}-date-from`)?.value || '';
    const dateTo   = document.getElementById(`dip-${tab}-date-to`)?.value   || '';

    if (!apiKey) { showToast('Pilih API Key terlebih dahulu', 'warning'); return; }
    if (!this._validateDates(tab)) { showToast('Periksa tanggal yang dimasukkan', 'error'); return; }

    const btn    = document.getElementById(`dip-${tab}-preview-btn`);
    const wrap   = document.getElementById(`dip-${tab}-preview-wrap`);
    const tbody  = tab !== 'summary' ? document.getElementById(`dip-${tab}-tbody`) : null;

    if (wrap)  wrap.style.display = '';
    if (tbody) tbody.innerHTML    = this._loadingRow(tab === 'cashout' ? 7 : 6);
    if (btn)   { btn.disabled = true; btn.innerHTML = '<i data-lucide="loader-2" class="icon-sm dip-spin"></i> Memuat...'; if (window.lucide) lucide.createIcons(); }

    const rpcName = tab === 'sales'   ? 'get_sales_integration'
                  : tab === 'cashout' ? 'get_kas_keluar_integration'
                  :                     'get_integration_summary';

    const params = {
      p_api_key:   apiKey,
      p_date_from: dateFrom || null,
      p_date_to:   dateTo   || null,
      p_branch_id: branchId ? parseInt(branchId, 10) : null
    };

    try {
      const { data: result, error } = await db.rpc(rpcName, params);
      if (error) throw error;
      if (!result?.success) throw new Error(result?.error || 'Gagal mengambil data dari server.');

      if (tab === 'sales')   { this._previewSales   = result; this._renderSales(result); }
      if (tab === 'cashout') { this._previewCashout = result; this._renderCashout(result); }
      if (tab === 'summary') { this._previewSummary = result; this._renderSummary(result); }

    } catch (e) {
      const hintMap = {
        sales:   'Pastikan RPC get_transactions_summary sudah tersedia di api.php.',
        cashout: 'Pastikan RPC get_cashout_summary sudah tersedia di api.php.',
        summary: 'Pastikan RPC get_transactions_summary sudah tersedia di api.php.'
      };
      const hint = hintMap[tab] || '';
      const errHtml = `<tr><td colspan="20" class="empty-td" style="color:var(--danger);padding:20px">
        ❌ Gagal memuat data: ${escHtml(e.message || 'Error tidak diketahui')}
        <br><small style="color:var(--text-muted)">${hint}</small>
      </td></tr>`;

      if (tbody) tbody.innerHTML = errHtml;
      if (tab === 'summary') {
        const summaryWrap = document.getElementById('dip-summary-preview-wrap');
        if (summaryWrap) summaryWrap.innerHTML = `
          <div class="card mb-4"><div class="p-4 text-center" style="color:var(--danger)">
            ❌ Gagal memuat data: ${escHtml(e.message)}
            <br><small style="color:var(--text-muted)">${hint}</small>
          </div></div>`;
      }
      showToast('Gagal memuat preview data', 'error');
    } finally {
      if (btn) {
        btn.disabled = false;
        btn.innerHTML = '<i data-lucide="eye" class="icon-sm"></i> Lihat Preview Data';
        if (window.lucide) lucide.createIcons();
      }
    }
  },

  _loadingRow(cols) {
    return `<tr><td colspan="${cols}" class="empty-td" style="padding:20px;text-align:center">
      <div class="dip-loading-dots"><span></span><span></span><span></span></div>
      <div style="margin-top:8px;font-size:12px;color:var(--text-muted)">Memuat data dari server...</div>
    </td></tr>`;
  },

  // ── Render: Penjualan ──────────────────────────────────────────────────
  _renderSales(result) {
    const tbody   = document.getElementById('dip-sales-tbody');
    const totalEl = document.getElementById('dip-sales-total');
    const countEl = document.getElementById('dip-sales-count');
    const expBtn  = document.getElementById('dip-sales-export-btn');
    const summary = result.summary    || {};
    const page    = result.pagination || {};

    if (totalEl) totalEl.textContent = fRp(summary.total_penjualan  || 0);
    if (countEl) {
      const returned = page.returned_count ?? (result.data?.length ?? 0);
      const total    = page.total_count;
      const hasMore  = page.has_more;
      countEl.textContent = total != null
        ? `${returned.toLocaleString('id-ID')} dari ${total.toLocaleString('id-ID')} transaksi${hasMore ? ' (ada halaman berikutnya)' : ''}`
        : `${returned.toLocaleString('id-ID')} transaksi`;
    }
    if (expBtn)  expBtn.disabled = !(result.data?.length > 0);

    if (!tbody) return;
    const rows = result.data || [];
    if (!rows.length) {
      tbody.innerHTML = this._emptyState('Tidak ada data penjualan', 'pada rentang tanggal & cabang yang dipilih');
      return;
    }
    tbody.innerHTML = rows.map(r => `
      <tr>
        <td class="text-xs" style="white-space:nowrap">
          ${escHtml(r.tanggal || '—')}
          <br><span style="color:var(--text-muted);font-size:10px">${escHtml(r.waktu || '')}</span>
        </td>
        <td class="text-xs fw-600">${escHtml(r.cabang || '—')}</td>
        <td class="text-xs">${escHtml(r.kasir || '—')}</td>
        <td>
          <span style="background:rgba(59,130,246,.1);color:#2563eb;padding:2px 10px;border-radius:999px;font-size:10px;font-weight:700;white-space:nowrap">
            ${escHtml(r.metode_pembayaran || '—')}
          </span>
        </td>
        <td class="fw-700" style="color:var(--success);white-space:nowrap;text-align:right">
          ${fRp(r.total_penjualan || 0)}
        </td>
        <td>
          <span style="background:rgba(22,163,74,.1);color:#16a34a;padding:2px 10px;border-radius:999px;font-size:10px;font-weight:700">
            ✓ Selesai
          </span>
        </td>
      </tr>`).join('');
  },

  // ── Render: Kas Keluar ─────────────────────────────────────────────────
  _renderCashout(result) {
    const tbody   = document.getElementById('dip-cashout-tbody');
    const totalEl = document.getElementById('dip-cashout-total');
    const countEl = document.getElementById('dip-cashout-count');
    const expBtn  = document.getElementById('dip-cashout-export-btn');
    const summary = result.summary    || {};
    const page    = result.pagination || {};

    if (totalEl) totalEl.textContent = fRp(summary.total_kas_keluar || result.total_pengeluaran || 0);
    if (countEl) {
      const returned = page.returned_count ?? (result.data?.length ?? 0);
      const total    = page.total_count;
      const hasMore  = page.has_more;
      countEl.textContent = total != null
        ? `${returned.toLocaleString('id-ID')} dari ${total.toLocaleString('id-ID')} entri${hasMore ? ' (ada halaman berikutnya)' : ''}`
        : `${returned.toLocaleString('id-ID')} entri`;
    }
    if (expBtn)  expBtn.disabled = !(result.data?.length > 0);

    if (!tbody) return;
    const rows = result.data || [];
    if (!rows.length) {
      tbody.innerHTML = this._emptyState('Tidak ada data kas keluar', 'pada rentang tanggal & cabang yang dipilih', 7);
      return;
    }
    tbody.innerHTML = rows.map(r => `
      <tr>
        <td class="text-xs" style="white-space:nowrap">
          ${escHtml(r.tanggal || '—')}
          <br><span style="color:var(--text-muted);font-size:10px">${escHtml(r.waktu || '')}</span>
        </td>
        <td class="text-xs fw-600">${escHtml(r.cabang || '—')}</td>
        <td class="fw-600 text-sm">${escHtml(r.nama_pengeluaran || '—')}</td>
        <td>
          ${r.kategori
            ? `<span style="background:rgba(249,115,22,.1);color:#ea580c;padding:2px 8px;border-radius:999px;font-size:10px;font-weight:700">${escHtml(r.kategori)}</span>`
            : '<span style="color:var(--text-muted);font-size:11px">—</span>'}
        </td>
        <td class="fw-700" style="color:var(--danger);white-space:nowrap;text-align:right">
          −${fRp(r.nominal || 0)}
        </td>
        <td class="text-xs text-muted">${escHtml(r.keterangan || '—')}</td>
        <td class="text-xs text-muted">${escHtml(r.dicatat_oleh || '—')}</td>
      </tr>`).join('');
  },

  // ── Render: Ringkasan Gabungan ─────────────────────────────────────────
  _renderSummary(result) {
    const summary = result.summary || {};
    const setEl   = (id, val, style) => {
      const el = document.getElementById(id);
      if (!el) return;
      el.textContent = val;
      if (style) el.style.color = style;
    };

    setEl('dip-sum-total-sales',   fRp(summary.total_penjualan  || 0), 'var(--success)');
    setEl('dip-sum-total-cashout', fRp(summary.total_kas_keluar || 0), 'var(--danger)');
    setEl('dip-sum-count',         (summary.jumlah_transaksi || 0) + ' transaksi');

    const selisih = summary.selisih || 0;
    setEl('dip-sum-selisih',
      (selisih < 0 ? '−' : '+') + fRp(Math.abs(selisih)),
      selisih >= 0 ? 'var(--success)' : 'var(--danger)'
    );

    // ── Per cabang ──────────────────────────────────────────────
    const branchTbody = document.getElementById('dip-summary-branch-tbody');
    if (branchTbody) {
      const rows = result.per_cabang || [];
      if (!rows.length) {
        branchTbody.innerHTML = '<tr><td colspan="5" class="empty-td">Tidak ada data cabang</td></tr>';
      } else {
        branchTbody.innerHTML = rows.map(r => {
          const sel = (r.total_penjualan || 0) - (r.total_kas_keluar || 0);
          return `<tr>
            <td class="fw-600">${escHtml(r.cabang || '—')}</td>
            <td style="text-align:right;font-weight:700;color:var(--success);white-space:nowrap">${fRp(r.total_penjualan || 0)}</td>
            <td style="text-align:right">${(r.jumlah_transaksi || 0).toLocaleString('id-ID')}</td>
            <td style="text-align:right;font-weight:700;color:var(--danger);white-space:nowrap">−${fRp(r.total_kas_keluar || 0)}</td>
            <td style="text-align:right;font-weight:800;color:${sel >= 0 ? 'var(--success)' : 'var(--danger)'};white-space:nowrap">
              ${sel < 0 ? '−' : '+'}${fRp(Math.abs(sel))}
            </td>
          </tr>`;
        }).join('');
      }
    }

    // ── Per tanggal ─────────────────────────────────────────────
    const dateTbody = document.getElementById('dip-summary-date-tbody');
    if (dateTbody) {
      const rows = result.per_tanggal || [];
      if (!rows.length) {
        dateTbody.innerHTML = '<tr><td colspan="4" class="empty-td">Tidak ada data per tanggal</td></tr>';
      } else {
        dateTbody.innerHTML = rows.map(r => {
          const sel = (r.total_penjualan || 0) - (r.total_kas_keluar || 0);
          return `<tr>
            <td class="fw-600 text-xs" style="white-space:nowrap">${escHtml(r.tanggal || '—')}</td>
            <td style="text-align:right;font-weight:700;color:var(--success);white-space:nowrap">${fRp(r.total_penjualan || 0)}</td>
            <td style="text-align:right;font-weight:700;color:var(--danger);white-space:nowrap">−${fRp(r.total_kas_keluar || 0)}</td>
            <td style="text-align:right;font-weight:800;color:${sel >= 0 ? 'var(--success)' : 'var(--danger)'};white-space:nowrap">
              ${sel < 0 ? '−' : '+'}${fRp(Math.abs(sel))}
            </td>
          </tr>`;
        }).join('');
      }
    }
  },

  // ── Export CSV ─────────────────────────────────────────────────────────
  _exportCsv(tab) {
    const data     = tab === 'sales' ? this._previewSales : this._previewCashout;
    if (!data?.data?.length) { showToast('Tidak ada data untuk dieksport', 'warning'); return; }

    const dateFrom = document.getElementById(`dip-${tab}-date-from`)?.value || 'semua';
    const dateTo   = document.getElementById(`dip-${tab}-date-to`)?.value   || 'semua';
    let headers, csvRows;

    if (tab === 'sales') {
      headers  = ['Tanggal', 'Waktu', 'Cabang', 'Kasir', 'Metode Bayar', 'Total Penjualan', 'Subtotal', 'Diskon', 'Status'];
      csvRows  = [headers.join(',')];
      data.data.forEach(r => {
        csvRows.push([
          r.tanggal || '',
          r.waktu   || '',
          `"${(r.cabang             || '').replace(/"/g,'""')}"`,
          `"${(r.kasir              || '').replace(/"/g,'""')}"`,
          `"${(r.metode_pembayaran  || '').replace(/"/g,'""')}"`,
          r.total_penjualan || 0,
          r.subtotal        || 0,
          r.diskon          || 0,
          r.status          || ''
        ].join(','));
      });
      const s = data.summary || {};
      csvRows.push('', `,,,,TOTAL,${s.total_penjualan || 0},,,${s.jumlah_transaksi || 0} transaksi`);
    } else {
      headers  = ['Tanggal', 'Waktu', 'Cabang', 'Nama Pengeluaran', 'Kategori', 'Nominal', 'Keterangan', 'Dicatat Oleh'];
      csvRows  = [headers.join(',')];
      data.data.forEach(r => {
        csvRows.push([
          r.tanggal || '',
          r.waktu   || '',
          `"${(r.cabang           || '').replace(/"/g,'""')}"`,
          `"${(r.nama_pengeluaran || '').replace(/"/g,'""')}"`,
          `"${(r.kategori         || '').replace(/"/g,'""')}"`,
          r.nominal || 0,
          `"${(r.keterangan  || '').replace(/"/g,'""')}"`,
          `"${(r.dicatat_oleh|| '').replace(/"/g,'""')}"`
        ].join(','));
      });
      csvRows.push('', `,,,,,${data.total_pengeluaran || 0},,Total Pengeluaran`);
    }

    const csv  = '﻿' + csvRows.join('\r\n'); // BOM for Excel UTF-8
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href     = url;
    a.download = `${tab === 'sales' ? 'penjualan' : 'kas-keluar'}_${dateFrom}_sd_${dateTo}.csv`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    showToast('File CSV berhasil diunduh', 'success');
  },

  // ── Update endpoint docs ──────────────────────────────────────────────
  // Tampilkan URL tanpa tanggal — filter tanggal dilakukan di sistem keuangan.
  _updateDocEndpoints() {
    const base = (typeof API_BASE !== 'undefined' ? API_BASE : 'https://api.rotibakarngeunah.my.id/api/api.php');
    const ph   = '<API_KEY>';

    const setEl = (id, val) => { const el = document.getElementById(id); if (el) el.textContent = val; };
    setEl('dip-doc-sales-ep',   `${base}/rpc/get_sales_integration?p_api_key=${ph}&p_limit=1000&p_offset=0`);
    setEl('dip-doc-cashout-ep', `${base}/rpc/get_kas_keluar_integration?p_api_key=${ph}&p_limit=1000&p_offset=0`);
    setEl('dip-doc-summary-ep', `${base}/rpc/get_integration_summary?p_api_key=${ph}`);
  },

  // ── Salin semua dokumentasi ke clipboard ───────────────────────────────
  async _copyDocs() {
    const base = (typeof API_BASE !== 'undefined' ? API_BASE : 'https://api.rotibakarngeunah.my.id/api/api.php') + '/rpc';

    const docs = `# ====================================================================
# Panduan Integrasi API — Portal Integrasi Data Keuangan
# Sistem: Roti Bakar Ngeunah POS
# Dibuat: ${new Date().toLocaleString('id-ID', { dateStyle: 'full', timeStyle: 'short' })}
# ====================================================================

## Konsep Dasar
API ini mengembalikan SEMUA data tanpa filter tanggal wajib.
Filter tanggal, pengelompokan, dan analisis dilakukan di SISTEM KEUANGAN Anda.
Gunakan p_limit + p_offset untuk mengambil data secara bertahap (pagination).

## Base URL
${base}/

## Autentikasi (WAJIB)
Setiap request harus menyertakan:
  - p_api_key : API key yang dibuat di menu API Keys (tambahkan sebagai query parameter)

Jika API key tidak valid:
  { "success": false, "error": "API key tidak valid atau tidak aktif." }

## ─── PAGINATION ──────────────────────────────────────────────────────────
Semua endpoint mendukung pagination dengan parameter:
  - p_limit  : Jumlah record per request (default 1000, maks 5000)
  - p_offset : Mulai dari record ke-N (default 0)

Setiap response menyertakan field "pagination":
  {
    "limit":          1000,
    "offset":         0,
    "total_count":    3500,   ← total semua record di database
    "returned_count": 1000,   ← jumlah record di response ini
    "has_more":       true    ← masih ada halaman berikutnya
  }

Cara tarik semua data (loop di sistem keuangan Anda):
  offset = 0
  LOOP:
    GET ...?p_limit=1000&p_offset={offset}
    proses data[]
    jika has_more = false → STOP
    offset += 1000

## ─── ENDPOINT 1: Data Penjualan ─────────────────────────────────────────
URL   : ${base}/get_sales_integration
Method: GET

Parameter:
  - p_api_key   (wajib)   : API key Anda
  - p_limit     (opsional): Jumlah record (default 1000, maks 5000)
  - p_offset    (opsional): Mulai dari record ke-N (default 0)
  - p_branch_id (opsional): ID integer cabang untuk filter per outlet
  - p_date_from (opsional): Filter tanggal mulai YYYY-MM-DD (WITA)
  - p_date_to   (opsional): Filter tanggal akhir YYYY-MM-DD (WITA)

Contoh — ambil halaman pertama semua data:
${base}/get_sales_integration?p_api_key=<API_KEY>&p_limit=1000&p_offset=0

Contoh — filter bulan Mei 2026 (dilakukan dari sistem keuangan):
${base}/get_sales_integration?p_api_key=<API_KEY>&p_limit=1000&p_offset=0&p_date_from=2026-05-01&p_date_to=2026-05-31

Contoh Response:
{
  "success": true,
  "type": "sales",
  "diambil_pada": "2026-05-23 09:00:00 WITA",
  "periode": { "tanggal_mulai": "semua", "tanggal_akhir": "semua" },
  "pagination": {
    "limit": 1000, "offset": 0,
    "total_count": 3500, "returned_count": 1000, "has_more": true
  },
  "summary": {
    "total_penjualan": 12500000,
    "jumlah_transaksi": 1000
  },
  "data": [
    {
      "id": 1001,
      "tanggal": "2026-05-23",
      "waktu": "09:15:00",
      "cabang": "Bundaran Dalung",
      "total_penjualan": 25000,
      "subtotal": 25000,
      "diskon": 0,
      "metode_pembayaran": "cash",
      "status": "completed",
      "kasir": "Budi"
    }
  ]
}

## ─── ENDPOINT 2: Data Kas Keluar ─────────────────────────────────────────
URL   : ${base}/get_kas_keluar_integration
Method: GET

Parameter: sama seperti endpoint penjualan.

Contoh — ambil halaman pertama semua kas keluar:
${base}/get_kas_keluar_integration?p_api_key=<API_KEY>&p_limit=1000&p_offset=0

Contoh Response:
{
  "success": true,
  "type": "kas_keluar",
  "diambil_pada": "2026-05-23 09:00:00 WITA",
  "periode": { "tanggal_mulai": "semua", "tanggal_akhir": "semua" },
  "pagination": {
    "limit": 1000, "offset": 0,
    "total_count": 450, "returned_count": 450, "has_more": false
  },
  "summary": {
    "total_kas_keluar": 3750000,
    "jumlah_transaksi": 450
  },
  "data": [
    {
      "id": 42,
      "tanggal": "2026-05-23",
      "waktu": "08:45:00",
      "cabang": "Bundaran Dalung",
      "kategori": "Bahan / Operasional",
      "nominal": 50000,
      "keterangan": "Pembelian mentega",
      "dicatat_oleh": "Budi"
    }
  ]
}

## ─── ENDPOINT 3: Ringkasan Gabungan ──────────────────────────────────────
URL   : ${base}/get_integration_summary
Method: GET

Parameter: p_api_key (wajib), p_branch_id / p_date_from / p_date_to (opsional).
Mengembalikan: total penjualan, total kas keluar, selisih,
               ringkasan per cabang, dan ringkasan per tanggal.
Catatan: jika tanggal tidak dikirim, per_tanggal dikelompokkan dari data nyata.

Contoh:
${base}/get_integration_summary?p_api_key=<API_KEY>

Contoh Response:
{
  "success": true,
  "type": "summary",
  "diambil_pada": "2026-05-23 09:00:00 WITA",
  "periode": { "tanggal_mulai": "semua", "tanggal_akhir": "semua" },
  "summary": {
    "total_penjualan": 87500000,
    "jumlah_transaksi": 3500,
    "total_kas_keluar": 22000000,
    "jumlah_kas_keluar": 450,
    "selisih": 65500000
  },
  "per_cabang": [
    {
      "cabang": "Bundaran Dalung",
      "total_penjualan": 45000000,
      "jumlah_transaksi": 1800,
      "total_kas_keluar": 12000000
    }
  ],
  "per_tanggal": [
    { "tanggal": "2026-05-23", "total_penjualan": 850000, "total_kas_keluar": 150000 }
  ]
}

## ─── Penjelasan Field Data ────────────────────────────────────────────────

### Data Penjualan (field "data")
  id               : ID unik transaksi (integer)
  tanggal          : Tanggal (YYYY-MM-DD), WITA (UTC+8)
  waktu            : Jam (HH:MM:SS), WITA (UTC+8)
  cabang           : Nama cabang/outlet
  total_penjualan  : Total yang dibayar pelanggan (rupiah)
  subtotal         : Total sebelum diskon
  diskon           : Jumlah diskon
  metode_pembayaran: cash / qris / transfer / dsb
  status           : Selalu "completed" — void tidak dimasukkan
  kasir            : Nama staff kasir

### Data Kas Keluar (field "data")
  id               : ID unik entri (integer)
  tanggal          : Tanggal (YYYY-MM-DD), WITA (UTC+8)
  waktu            : Jam (HH:MM:SS), WITA (UTC+8)
  cabang           : Nama cabang/outlet
  kategori         : Kategori pengeluaran
  nominal          : Jumlah pengeluaran (rupiah)
  keterangan       : Catatan tambahan
  dicatat_oleh     : Nama staff

## ─── Catatan Penting ──────────────────────────────────────────────────────
1. Semua waktu: WITA — Asia/Makassar (UTC+8, Waktu Indonesia Tengah)
2. Data penjualan: hanya status "completed" — void tidak dimasukkan
3. Data kas keluar: hanya yang belum di-void (is_void = false)
4. Tidak ada data: field "data" berisi array kosong []
5. Pagination: gunakan has_more untuk tahu apakah masih ada halaman berikutnya
6. Maks per request: 5000 record — gunakan pagination untuk data lebih banyak
7. API key bersifat RAHASIA — jangan bagikan ke pihak tidak berwenang
8. Filter tanggal bersifat OPSIONAL — lakukan di sistem keuangan Anda
`;

    try {
      await navigator.clipboard.writeText(docs.trim());
      showToast('Dokumentasi lengkap berhasil disalin! Tempelkan ke AI builder sistem keuangan. 📋', 'success');
      const btn = document.getElementById('dip-copy-docs-btn');
      if (btn) {
        const orig = btn.innerHTML;
        btn.innerHTML = '<i data-lucide="check" class="icon-sm"></i> Tersalin!';
        if (window.lucide) lucide.createIcons();
        setTimeout(() => { btn.innerHTML = orig; if (window.lucide) lucide.createIcons(); }, 2500);
      }
    } catch (e) {
      showToast('Gagal menyalin otomatis. Coba buka dokumentasi dan salin manual.', 'warning');
    }
  },

  // ── Helper: empty state row ────────────────────────────────────────────
  _emptyState(title, desc, cols = 6) {
    return `<tr><td colspan="${cols}" class="empty-td" style="padding:28px 16px;text-align:center">
      <div style="font-size:1.8rem;margin-bottom:8px">📭</div>
      <div style="font-weight:700;font-size:14px;color:var(--text)">${title}</div>
      <div style="font-size:12px;color:var(--text-muted);margin-top:4px">${desc}</div>
    </td></tr>`;
  },

  // ── Populate branch selects (dipanggil dari admin.js) ──────────────────
  populateBranchSelect(branches) {
    ['dip-sales-branch', 'dip-cashout-branch', 'dip-summary-branch'].forEach(id => {
      const sel = document.getElementById(id);
      if (!sel) return;
      const opts = (branches || []).map(b =>
        `<option value="${b.id}">${escHtml(b.name)}</option>`
      ).join('');
      sel.innerHTML = '<option value="">Semua Cabang</option>' + opts;
    });
    // Rebuild links after branch options populated
    ['sales', 'cashout', 'summary'].forEach(tab => this._buildLink(tab));
  },
};

// ── Backward compatibility: expose with old name ────────────────────────────
// admin.js masih memanggil adminFinanceIntegrationUi — tetap berfungsi.
window.adminFinanceIntegrationUi = adminDataIntegrationPortalUi;

adminDataIntegrationPortalUi.init();
