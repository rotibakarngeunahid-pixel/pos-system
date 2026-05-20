'use strict';

// ── Portal Integrasi Kas Keluar ───────────────────────────────────────────────
// Halaman ini membantu admin menghubungkan data kas keluar
// dengan sistem keuangan eksternal melalui link integrasi (API).
// Tidak ada perubahan struktur data — hanya membaca cash_logs.

const adminFinanceIntegrationUi = {

  // ── State ─────────────────────────────────────────────────────
  _apiKeys:     [],
  _previewData: null,
  _bound:       false,

  // ── Init ─────────────────────────────────────────────────────
  init() {
    const boot = () => {
      try { this._bindEvents(); } catch (e) {
        console.error('adminFinanceIntegrationUi.init', e);
      }
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
      if (el) el.addEventListener(ev, fn);
    };

    on('fi-date-from',       'change', () => this._onFilterChange());
    on('fi-date-to',         'change', () => this._onFilterChange());
    on('fi-branch',          'change', () => this._onFilterChange());
    on('fi-api-key-select',  'change', () => this._onFilterChange());
    on('fi-copy-link-btn',   'click',  () => this._copyLink());
    on('fi-preview-btn',     'click',  () => this._loadPreview());
    on('fi-export-csv-btn',  'click',  () => this._exportCsv());
    on('fi-refresh-btn',     'click',  () => this.load());
  },

  // ── Load halaman ─────────────────────────────────────────────
  async load() {
    this._setDefaults();
    await this._loadApiKeys();
    this._onFilterChange();
  },

  _setDefaults() {
    const today = new Date().toISOString().slice(0, 10);
    const fromEl = document.getElementById('fi-date-from');
    const toEl   = document.getElementById('fi-date-to');
    if (fromEl && !fromEl.value) fromEl.value = today;
    if (toEl   && !toEl.value)   toEl.value   = today;
  },

  // ── Muat daftar API key ───────────────────────────────────────
  async _loadApiKeys() {
    const sel = document.getElementById('fi-api-key-select');
    if (!sel) return;

    sel.innerHTML = '<option value="">Memuat...</option>';
    try {
      const { data, error } = await db.from('api_keys')
        .select('id, name, key_value, is_active')
        .eq('is_active', true)
        .order('created_at', { ascending: false });

      if (error) throw error;
      this._apiKeys = data || [];

      if (!this._apiKeys.length) {
        sel.innerHTML = '<option value="">— Belum ada API key aktif —</option>';
        this._showApiKeyWarning();
        return;
      }

      sel.innerHTML = '<option value="">— Pilih API Key —</option>' +
        this._apiKeys.map(k =>
          `<option value="${escHtml(k.key_value)}">${escHtml(k.name)}</option>`
        ).join('');

      this._hideApiKeyWarning();
    } catch (e) {
      sel.innerHTML = '<option value="">Gagal memuat API key</option>';
      console.error('fi: loadApiKeys', e);
    }
  },

  _showApiKeyWarning() {
    const el = document.getElementById('fi-apikey-warning');
    if (el) el.style.display = '';
  },
  _hideApiKeyWarning() {
    const el = document.getElementById('fi-apikey-warning');
    if (el) el.style.display = 'none';
  },

  // ── Saat filter berubah ───────────────────────────────────────
  _onFilterChange() {
    const err = this._validateDates();
    const linkBox = document.getElementById('fi-link-box');
    const copyBtn = document.getElementById('fi-copy-link-btn');
    const prevBtn = document.getElementById('fi-preview-btn');

    if (err) {
      this._showError(err);
      if (linkBox) linkBox.textContent = '';
      if (copyBtn) copyBtn.disabled = true;
      if (prevBtn) prevBtn.disabled = true;
      return;
    }
    this._hideError();
    this._buildLink();

    const hasKey = !!document.getElementById('fi-api-key-select')?.value;
    if (copyBtn) copyBtn.disabled = !hasKey;
    if (prevBtn) prevBtn.disabled = !hasKey;
  },

  // ── Validasi tanggal ─────────────────────────────────────────
  _validateDates() {
    const from = document.getElementById('fi-date-from')?.value;
    const to   = document.getElementById('fi-date-to')?.value;
    if (!from || !to) return null;
    if (from > to) return 'Tanggal mulai tidak boleh lebih besar dari tanggal akhir.';
    const daysDiff = (new Date(to) - new Date(from)) / (1000 * 60 * 60 * 24);
    if (daysDiff > 365) return 'Rentang tanggal maksimal 365 hari sekaligus.';
    return null;
  },

  _showError(msg) {
    const el = document.getElementById('fi-date-error');
    if (el) { el.textContent = msg; el.style.display = ''; }
  },
  _hideError() {
    const el = document.getElementById('fi-date-error');
    if (el) el.style.display = 'none';
  },

  // ── Bangun link integrasi ─────────────────────────────────────
  _buildLink() {
    const from     = document.getElementById('fi-date-from')?.value || '';
    const to       = document.getElementById('fi-date-to')?.value   || '';
    const apiKey   = document.getElementById('fi-api-key-select')?.value || '';
    const branchId = document.getElementById('fi-branch')?.value || '';

    const linkBox  = document.getElementById('fi-link-box');
    const copyBtn  = document.getElementById('fi-copy-link-btn');

    if (!apiKey) {
      if (linkBox) linkBox.textContent = '← Pilih API Key terlebih dahulu';
      if (copyBtn) copyBtn.disabled = true;
      return;
    }

    const supaUrl = (typeof SUPABASE_URL !== 'undefined' ? SUPABASE_URL : '') || '';
    const supaKey = (typeof SUPABASE_KEY !== 'undefined' ? SUPABASE_KEY : '') || '';

    const params = new URLSearchParams({
      apikey:      supaKey,
      p_api_key:   apiKey,
      p_date_from: from,
      p_date_to:   to,
    });
    if (branchId) params.set('p_branch_id', branchId);

    const link = `${supaUrl}/rest/v1/rpc/get_kas_keluar_integration?${params.toString()}`;
    if (linkBox) linkBox.textContent = link;
    if (copyBtn) copyBtn.disabled = false;
  },

  // ── Salin link ────────────────────────────────────────────────
  async _copyLink() {
    const linkBox = document.getElementById('fi-link-box');
    const link    = linkBox?.textContent?.trim();
    if (!link || link.startsWith('←')) {
      showToast('Pilih API Key terlebih dahulu', 'warning');
      return;
    }
    try {
      await navigator.clipboard.writeText(link);
      showToast('Link integrasi berhasil disalin!', 'success');
      const btn = document.getElementById('fi-copy-link-btn');
      if (btn) {
        const orig = btn.innerHTML;
        btn.innerHTML = '<i data-lucide="check" style="width:14px;height:14px"></i> Tersalin!';
        if (window.lucide) lucide.createIcons();
        setTimeout(() => { btn.innerHTML = orig; if (window.lucide) lucide.createIcons(); }, 2000);
      }
    } catch (e) {
      showToast('Gagal menyalin. Salin manual dari kotak link.', 'warning');
    }
  },

  // ── Preview data ─────────────────────────────────────────────
  async _loadPreview() {
    const from     = document.getElementById('fi-date-from')?.value;
    const to       = document.getElementById('fi-date-to')?.value;
    const apiKey   = document.getElementById('fi-api-key-select')?.value;
    const branchId = document.getElementById('fi-branch')?.value;

    if (!apiKey) { showToast('Pilih API Key terlebih dahulu', 'warning'); return; }

    const err = this._validateDates();
    if (err) { showToast(err, 'error'); return; }

    const previewSection = document.getElementById('fi-preview-section');
    const previewBody    = document.getElementById('fi-preview-body');
    const totalEl        = document.getElementById('fi-preview-total');
    const countEl        = document.getElementById('fi-preview-count');
    const btn            = document.getElementById('fi-preview-btn');
    const exportBtn      = document.getElementById('fi-export-csv-btn');

    if (previewSection) previewSection.style.display = '';
    if (previewBody)    previewBody.innerHTML = '<tr><td colspan="6" class="empty-td">Memuat data...</td></tr>';
    if (totalEl)        totalEl.textContent = '—';
    if (countEl)        countEl.textContent = '—';
    if (exportBtn)      exportBtn.disabled = true;
    if (btn)            { btn.disabled = true; btn.textContent = 'Memuat...'; }

    try {
      const params = {
        p_api_key:   apiKey,
        p_date_from: from || null,
        p_date_to:   to   || null,
        p_branch_id: branchId ? parseInt(branchId) : null
      };

      const { data: result, error } = await db.rpc('get_kas_keluar_integration', params);
      if (error) throw error;

      if (!result?.success) {
        throw new Error(result?.error || 'Gagal mengambil data dari database');
      }

      this._previewData = result;
      this._renderPreview(result);

      if (exportBtn && result.data?.length > 0) exportBtn.disabled = false;

    } catch (e) {
      if (previewBody) previewBody.innerHTML = `
        <tr><td colspan="6" class="empty-td text-danger">
          Gagal memuat data: ${escHtml(e.message || 'Error tidak diketahui')}.<br>
          <small>Pastikan migrasi 039 sudah dijalankan di Supabase.</small>
        </td></tr>`;
      this._previewData = null;
      showToast('Gagal memuat data kas keluar', 'error');
    } finally {
      if (btn) { btn.disabled = false; btn.innerHTML = '<i data-lucide="eye" style="width:14px;height:14px"></i> Lihat Data'; if (window.lucide) lucide.createIcons(); }
    }
  },

  _renderPreview(result) {
    const previewBody = document.getElementById('fi-preview-body');
    const totalEl     = document.getElementById('fi-preview-total');
    const countEl     = document.getElementById('fi-preview-count');

    if (totalEl) totalEl.textContent = fRp(result.total_pengeluaran || 0);
    if (countEl) countEl.textContent = (result.jumlah_data || 0) + ' transaksi';

    if (!previewBody) return;

    const rows = result.data || [];
    if (!rows.length) {
      previewBody.innerHTML = `
        <tr><td colspan="6" class="empty-td" style="padding:24px 0;text-align:center;">
          <div style="font-size:1.5rem;margin-bottom:8px;">📭</div>
          <div style="font-weight:600;color:var(--text);">Tidak ada data kas keluar</div>
          <div style="font-size:12px;color:var(--text-muted);margin-top:4px;">pada rentang tanggal yang dipilih</div>
        </td></tr>`;
      return;
    }

    previewBody.innerHTML = rows.map(r => `
      <tr>
        <td class="text-xs nowrap">${escHtml(r.tanggal || '—')}</td>
        <td class="text-xs">${escHtml(r.cabang || '—')}</td>
        <td class="fw-600 text-sm">${escHtml(r.nama_pengeluaran || '—')}</td>
        <td>
          ${r.kategori
            ? `<span class="badge badge-orange" style="font-size:10px;">${escHtml(r.kategori)}</span>`
            : '<span class="text-muted" style="font-size:11px;">—</span>'}
        </td>
        <td class="fw-700 text-danger" style="white-space:nowrap;">−${fRp(r.nominal || 0)}</td>
        <td class="text-xs text-muted">${escHtml(r.keterangan || '—')}</td>
      </tr>`).join('');
  },

  // ── Export CSV ────────────────────────────────────────────────
  _exportCsv() {
    if (!this._previewData?.data?.length) {
      showToast('Tidak ada data untuk dieksport', 'warning');
      return;
    }

    const rows = this._previewData.data;
    const from = document.getElementById('fi-date-from')?.value || 'semua';
    const to   = document.getElementById('fi-date-to')?.value   || 'semua';

    const headers = ['ID', 'Tanggal', 'Waktu', 'Cabang', 'Nama Pengeluaran', 'Kategori', 'Nominal', 'Keterangan', 'Dicatat Oleh'];
    const csvRows = [headers.join(',')];

    rows.forEach(r => {
      const cols = [
        r.id,
        r.tanggal || '',
        r.waktu || '',
        `"${(r.cabang || '').replace(/"/g, '""')}"`,
        `"${(r.nama_pengeluaran || '').replace(/"/g, '""')}"`,
        `"${(r.kategori || '').replace(/"/g, '""')}"`,
        r.nominal || 0,
        `"${(r.keterangan || '').replace(/"/g, '""')}"`,
        `"${(r.dicatat_oleh || '').replace(/"/g, '""')}"`
      ];
      csvRows.push(cols.join(','));
    });

    // Tambah baris total
    csvRows.push('');
    csvRows.push(`,,,,,,${this._previewData.total_pengeluaran || 0},,Total Pengeluaran`);

    const csv = '﻿' + csvRows.join('\r\n'); // BOM untuk Excel UTF-8
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href     = url;
    a.download = `kas-keluar_${from}_sd_${to}.csv`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);

    showToast('File CSV berhasil diunduh', 'success');
  },

  // ── Populate branch select ────────────────────────────────────
  populateBranchSelect(branches) {
    const sel = document.getElementById('fi-branch');
    if (!sel) return;
    const opts = (branches || []).map(b =>
      `<option value="${b.id}">${escHtml(b.name)}</option>`
    ).join('');
    sel.innerHTML = '<option value="">Semua Cabang</option>' + opts;
  },
};

adminFinanceIntegrationUi.init();
