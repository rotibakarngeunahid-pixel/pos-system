'use strict';

/* ── ui.js — Custom Modal System ──────────────────────────────────────────────
   Replaces native confirm() and prompt() with premium animated modals.
   All functions return Promises for use with async/await.
   ─────────────────────────────────────────────────────────────────────────── */

(function () {
  /* ── Inject CSS once ─────────────────────────────────────────────────────── */
  function _injectCSS() {
    if (document.getElementById('ui-modal-style')) return;
    const style = document.createElement('style');
    style.id = 'ui-modal-style';
    style.textContent = `
      /* ── UI Custom Modal Overlay ─────── */
      .ui-modal-overlay {
        position: fixed; inset: 0;
        background: rgba(0,0,0,0.55);
        backdrop-filter: blur(6px);
        -webkit-backdrop-filter: blur(6px);
        z-index: 9000;
        display: flex; align-items: center; justify-content: center;
        padding: 16px;
        opacity: 0;
        transition: opacity 0.18s ease;
      }
      .ui-modal-overlay.ui-show { opacity: 1; }

      .ui-modal-box {
        background: var(--surface, #fff);
        border-radius: 20px;
        box-shadow: 0 32px 80px rgba(0,0,0,0.22), 0 8px 24px rgba(0,0,0,0.10);
        border: 1px solid var(--border, #E5E7EB);
        width: 100%; max-width: 400px;
        transform: scale(0.93) translateY(16px);
        transition: transform 0.2s cubic-bezier(0.34, 1.56, 0.64, 1), opacity 0.18s ease;
        opacity: 0;
        overflow: hidden;
      }
      .ui-modal-overlay.ui-show .ui-modal-box {
        transform: scale(1) translateY(0);
        opacity: 1;
      }

      /* Icon strip */
      .ui-modal-icon-strip {
        padding: 28px 24px 12px;
        text-align: center;
      }
      .ui-modal-icon-wrap {
        width: 60px; height: 60px;
        border-radius: 50%;
        display: inline-flex; align-items: center; justify-content: center;
        font-size: 28px;
        margin: 0 auto;
      }
      .ui-modal-icon-wrap.danger  { background: var(--danger-bg, #FEE2E2); color: var(--danger, #DC2626); }
      .ui-modal-icon-wrap.warning { background: var(--warning-bg, #FFEDD5); color: var(--warning, #F97316); }
      .ui-modal-icon-wrap.info    { background: var(--info-bg, #DBEAFE); color: var(--info, #2563EB); }
      .ui-modal-icon-wrap.success { background: var(--success-bg, #DCFCE7); color: var(--success, #16A34A); }

      /* Content */
      .ui-modal-content { padding: 0 24px 20px; text-align: center; }
      .ui-modal-title {
        font-size: 18px; font-weight: 800;
        color: var(--text, #111827);
        margin-bottom: 8px; line-height: 1.25;
      }
      .ui-modal-message {
        font-size: 14px; color: var(--text-muted, #6B7280);
        line-height: 1.55; margin-bottom: 4px;
      }
      .ui-modal-subtext {
        font-size: 12px; color: var(--text-muted, #6B7280);
        line-height: 1.5; margin-top: 4px;
      }

      /* Prompt input */
      .ui-modal-input {
        width: 100%; margin-top: 14px;
        padding: 11px 14px;
        border: 1.5px solid var(--border, #E5E7EB);
        border-radius: 10px;
        font-size: 14px;
        color: var(--text, #111827);
        background: var(--surface, #fff);
        font-family: inherit;
        transition: border-color 0.14s, box-shadow 0.14s;
        outline: none;
      }
      .ui-modal-input:focus {
        border-color: var(--warning, #F97316);
        box-shadow: 0 0 0 3px rgba(249,115,22,0.14);
      }

      /* Footer */
      .ui-modal-footer {
        padding: 14px 20px 18px;
        display: flex; gap: 10px;
        border-top: 1px solid var(--border, #E5E7EB);
        background: var(--surface-2, #F9FAFB);
        border-radius: 0 0 20px 20px;
      }
      .ui-modal-footer .ui-btn {
        flex: 1; padding: 11px 16px;
        border-radius: 10px;
        font-size: 14px; font-weight: 700;
        border: 1.5px solid transparent;
        cursor: pointer; font-family: inherit;
        transition: all 0.14s ease;
        line-height: 1;
      }
      .ui-btn-cancel {
        background: var(--surface, #fff);
        color: var(--text-sub, #374151);
        border-color: var(--border-strong, #D1D5DB) !important;
      }
      .ui-btn-cancel:hover { background: var(--bg-alt, #F1F1F1); }
      .ui-btn-cancel:active { transform: scale(0.97); }

      .ui-btn-confirm-danger {
        background: var(--danger, #DC2626);
        color: #fff;
        border-color: var(--danger, #DC2626) !important;
        box-shadow: 0 4px 12px rgba(220,38,38,0.28);
      }
      .ui-btn-confirm-danger:hover { background: #B91C1C; transform: translateY(-1px); }
      .ui-btn-confirm-danger:active { transform: scale(0.97); }

      /* BUG-14 FIX: non-destructive confirm should be blue, not red */
      .ui-btn-confirm-primary {
        background: #2563EB;
        color: #fff;
        border-color: #2563EB !important;
        box-shadow: 0 4px 12px rgba(37,99,235,0.22);
      }
      .ui-btn-confirm-primary:hover { background: #1D4ED8; transform: translateY(-1px); }
      .ui-btn-confirm-primary:active { transform: scale(0.97); }

      .ui-btn-confirm-success {
        background: var(--success, #16A34A);
        color: #fff;
        border-color: var(--success, #16A34A) !important;
        box-shadow: 0 4px 12px rgba(22,163,74,0.22);
      }
      .ui-btn-confirm-success:hover { filter: brightness(1.08); transform: translateY(-1px); }

      @media (max-width: 480px) {
        .ui-modal-box { max-width: 100%; border-radius: 16px 16px 0 0; }
        .ui-modal-overlay { align-items: flex-end; padding: 0; }
        .ui-modal-overlay.ui-show .ui-modal-box { transform: scale(1) translateY(0); }
        .ui-modal-box { transform: translateY(100%); }
        .ui-modal-overlay.ui-show .ui-modal-box { transform: translateY(0); }
      }
    `;
    document.head.appendChild(style);
  }

  /* ── Helper: escape HTML ───────────────────────────────────────────────── */
  function _esc(str) {
    if (!str) return '';
    return String(str)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  /* ── Create & show overlay ─────────────────────────────────────────────── */
  function _createOverlay() {
    const overlay = document.createElement('div');
    overlay.className = 'ui-modal-overlay';
    document.body.appendChild(overlay);
    // Trigger animation
    requestAnimationFrame(() => requestAnimationFrame(() => overlay.classList.add('ui-show')));
    return overlay;
  }

  function _removeOverlay(overlay) {
    overlay.classList.remove('ui-show');
    overlay.addEventListener('transitionend', () => {
      if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
    }, { once: true });
    // Fallback removal
    setTimeout(() => { if (overlay.parentNode) overlay.parentNode.removeChild(overlay); }, 400);
  }

  /* ── showConfirm ───────────────────────────────────────────────────────── */
  /**
   * @param {Object} opts
   * @param {string} opts.title
   * @param {string} opts.message
   * @param {string} [opts.subText]
   * @param {string} [opts.confirmText='Ya, Lanjutkan']
   * @param {string} [opts.cancelText='Batal']
   * @param {boolean} [opts.danger=false]       — merah jika true
   * @param {boolean} [opts.success=false]      — hijau jika true
   * @param {string}  [opts.icon]               — emoji atau teks ikon
   * @returns {Promise<boolean>}
   */
  window.showConfirm = function ({
    title        = 'Konfirmasi',
    message      = 'Apakah Anda yakin?',
    subText      = '',
    confirmText  = 'Ya, Lanjutkan',
    cancelText   = 'Batal',
    danger       = false,
    success      = false,
    icon         = null,
  } = {}) {
    _injectCSS();
    return new Promise((resolve) => {
      const overlay = _createOverlay();

      // Choose icon & color
      const iconEmoji = icon || (danger ? '⚠️' : success ? '✅' : 'ℹ️');
      const iconClass = danger ? 'danger' : success ? 'success' : 'info';
      const btnClass  = danger ? 'ui-btn-confirm-danger' : success ? 'ui-btn-confirm-success' : 'ui-btn-confirm-primary';

      overlay.innerHTML = `
        <div class="ui-modal-box">
          <div class="ui-modal-icon-strip">
            <div class="ui-modal-icon-wrap ${iconClass}">${_esc(iconEmoji)}</div>
          </div>
          <div class="ui-modal-content">
            <div class="ui-modal-title">${_esc(title)}</div>
            <div class="ui-modal-message">${_esc(message)}</div>
            ${subText ? `<div class="ui-modal-subtext">${_esc(subText)}</div>` : ''}
          </div>
          <div class="ui-modal-footer">
            <button class="ui-btn ui-btn-cancel" id="ui-cancel-btn">${_esc(cancelText)}</button>
            <button class="ui-btn ${btnClass}" id="ui-confirm-btn">${_esc(confirmText)}</button>
          </div>
        </div>
      `;

      const confirmBtn = overlay.querySelector('#ui-confirm-btn');
      const cancelBtn  = overlay.querySelector('#ui-cancel-btn');

      // BUG-15 FIX: Use AbortController so keydown listener auto-cleans if overlay removed externally
      const ac = new AbortController();

      function close(result) {
        ac.abort();
        _removeOverlay(overlay);
        resolve(result);
      }

      confirmBtn.addEventListener('click', () => close(true));
      cancelBtn.addEventListener('click',  () => close(false));

      // Close on overlay click (outside box)
      overlay.addEventListener('click', (e) => {
        if (e.target === overlay) close(false);
      });

      // Keyboard: Enter = confirm, Escape = cancel
      document.addEventListener('keydown', (e) => {
        if (e.key === 'Enter')  close(true);
        if (e.key === 'Escape') close(false);
      }, { signal: ac.signal });

      // Focus confirm button
      setTimeout(() => confirmBtn && confirmBtn.focus(), 80);
    });
  };

  /* ── showPrompt ────────────────────────────────────────────────────────── */
  /**
   * @param {Object} opts
   * @param {string} opts.title
   * @param {string} opts.message
   * @param {string} [opts.placeholder='']
   * @param {string} [opts.defaultValue='']
   * @param {string} [opts.confirmText='OK']
   * @param {string} [opts.cancelText='Batal']
   * @param {string} [opts.inputType='text']
   * @returns {Promise<string|null>} — null if cancelled
   */
  window.showPrompt = function ({
    title        = 'Input',
    message      = '',
    placeholder  = '',
    defaultValue = '',
    confirmText  = 'OK',
    cancelText   = 'Batal',
    inputType    = 'text',
  } = {}) {
    _injectCSS();
    return new Promise((resolve) => {
      const overlay = _createOverlay();

      overlay.innerHTML = `
        <div class="ui-modal-box">
          <div class="ui-modal-icon-strip">
            <div class="ui-modal-icon-wrap info">✏️</div>
          </div>
          <div class="ui-modal-content">
            <div class="ui-modal-title">${_esc(title)}</div>
            ${message ? `<div class="ui-modal-message">${_esc(message)}</div>` : ''}
            <input class="ui-modal-input" id="ui-prompt-input"
              type="${_esc(inputType)}"
              placeholder="${_esc(placeholder)}"
              value="${_esc(defaultValue)}"
              autocomplete="off" />
          </div>
          <div class="ui-modal-footer">
            <button class="ui-btn ui-btn-cancel" id="ui-cancel-btn">${_esc(cancelText)}</button>
            <button class="ui-btn ui-btn-confirm-primary" id="ui-confirm-btn">${_esc(confirmText)}</button>
          </div>
        </div>
      `;

      const input      = overlay.querySelector('#ui-prompt-input');
      const confirmBtn = overlay.querySelector('#ui-confirm-btn');
      const cancelBtn  = overlay.querySelector('#ui-cancel-btn');

      // BUG-15 FIX: Use AbortController for auto-cleanup of keyboard listeners
      const ac = new AbortController();

      function close(result) {
        ac.abort();
        _removeOverlay(overlay);
        resolve(result);
      }

      confirmBtn.addEventListener('click', () => close(input.value));
      cancelBtn.addEventListener('click',  () => close(null));

      overlay.addEventListener('click', (e) => {
        if (e.target === overlay) close(null);
      });

      document.addEventListener('keydown', (e) => {
        if (e.key === 'Enter')  close(input.value);
        if (e.key === 'Escape') close(null);
      }, { signal: ac.signal });

      // Focus & select input
      setTimeout(() => {
        if (input) { input.focus(); input.select(); }
      }, 80);
    });
  };

  /* ── Image / Proof Viewer (Lightbox) ───────────────────────────────────── */
  function _injectImageViewerCSS() {
    if (document.getElementById('ui-iv-style')) return;
    const style = document.createElement('style');
    style.id = 'ui-iv-style';
    style.textContent = `
      .ui-iv-overlay {
        position: fixed; inset: 0;
        background: rgba(0,0,0,0.78);
        z-index: 9200;
        display: flex; align-items: center; justify-content: center;
        padding: 24px;
        opacity: 0;
        transition: opacity 0.18s ease;
      }
      .ui-iv-overlay.ui-show { opacity: 1; }
      .ui-iv-box {
        width: 100%; max-width: 720px; max-height: 90vh;
        display: flex; flex-direction: column;
        background: var(--surface, #fff);
        border-radius: 16px;
        overflow: hidden;
        transform: scale(0.94);
        transition: transform 0.2s cubic-bezier(0.34, 1.56, 0.64, 1);
        box-shadow: 0 32px 80px rgba(0,0,0,0.35);
      }
      .ui-iv-overlay.ui-show .ui-iv-box { transform: scale(1); }
      .ui-iv-header {
        display: flex; align-items: center; justify-content: space-between;
        gap: 12px; padding: 12px 16px;
        border-bottom: 1px solid var(--border, #E5E7EB);
        flex-shrink: 0;
      }
      .ui-iv-title { font-weight: 600; font-size: 14px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--text, #111827); }
      .ui-iv-actions { display: flex; align-items: center; gap: 2px; flex-shrink: 0; }
      .ui-iv-icon-btn {
        display: inline-flex; align-items: center; justify-content: center;
        width: 32px; height: 32px; border-radius: 8px;
        color: var(--text-muted, #6B7280); background: transparent; border: none; cursor: pointer;
        text-decoration: none;
      }
      .ui-iv-icon-btn:hover { background: var(--bg-hover, rgba(0,0,0,0.06)); color: var(--text, #111827); }
      .ui-iv-body {
        flex: 1; min-height: 0;
        display: flex; align-items: center; justify-content: center;
        background: repeating-conic-gradient(#00000008 0% 25%, transparent 0% 50%) 50% / 20px 20px;
        overflow: auto;
        padding: 12px;
      }
      .ui-iv-body img { max-width: 100%; max-height: 78vh; object-fit: contain; border-radius: 4px; display: block; }
      .ui-iv-fallback { display: flex; flex-direction: column; align-items: center; gap: 12px; padding: 40px 20px; color: var(--text-muted, #6B7280); text-align: center; }
    `;
    document.head.appendChild(style);
  }

  // Assume image unless there's positive evidence otherwise (e.g. a .pdf name/url) —
  // most proof uploads are photos and proof_file_name may be a generic fallback with no extension.
  const UI_IV_NON_IMAGE_RE = /\.pdf(\?.*)?$/i;

  /**
   * @param {Object} opts
   * @param {string} opts.url
   * @param {string} [opts.title='Bukti']
   * @param {string} [opts.fileName='']
   * @returns {Promise<void>}
   */
  window.showImagePreview = function ({ url, title = 'Bukti', fileName = '' } = {}) {
    if (!url) return Promise.resolve();
    _injectImageViewerCSS();
    return new Promise((resolve) => {
      const overlay = _createOverlay();
      overlay.className = 'ui-iv-overlay';

      const isImage = !UI_IV_NON_IMAGE_RE.test(fileName || '') && !UI_IV_NON_IMAGE_RE.test(url);
      const bodyHtml = isImage
        ? `<img src="${_esc(url)}" alt="${_esc(fileName || title)}" />`
        : `<div class="ui-iv-fallback">
             <i data-lucide="file-text" style="width:40px;height:40px"></i>
             <span>${_esc(fileName || 'Berkas bukti')}</span>
           </div>`;

      overlay.innerHTML = `
        <div class="ui-iv-box">
          <div class="ui-iv-header">
            <span class="ui-iv-title">${_esc(fileName || title)}</span>
            <div class="ui-iv-actions">
              <a href="${_esc(url)}" target="_blank" rel="noopener" class="ui-iv-icon-btn" title="Buka di tab baru"><i data-lucide="external-link" style="width:16px;height:16px"></i></a>
              <button class="ui-iv-icon-btn" id="ui-iv-close" title="Tutup"><i data-lucide="x" style="width:18px;height:18px"></i></button>
            </div>
          </div>
          <div class="ui-iv-body">${bodyHtml}</div>
        </div>
      `;

      const ac = new AbortController();
      function close() {
        ac.abort();
        _removeOverlay(overlay);
        resolve();
      }

      overlay.querySelector('#ui-iv-close').addEventListener('click', close);
      overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
      document.addEventListener('keydown', (e) => { if (e.key === 'Escape') close(); }, { signal: ac.signal });

      const img = overlay.querySelector('.ui-iv-body img');
      if (img) {
        img.addEventListener('error', () => {
          img.closest('.ui-iv-body').innerHTML = `<div class="ui-iv-fallback"><i data-lucide="image-off" style="width:40px;height:40px"></i><span>Gagal memuat gambar</span></div>`;
          if (window.lucide) requestAnimationFrame(() => lucide.createIcons());
        }, { once: true });
      }

      if (window.lucide) requestAnimationFrame(() => lucide.createIcons());
    });
  };

  // Global delegated trigger: any element with data-proof-url opens the lightbox on click,
  // while its native href/target still works for ctrl/middle-click or right-click "open in new tab".
  document.addEventListener('click', (e) => {
    const trigger = e.target.closest('[data-proof-url]');
    if (!trigger) return;
    const url = trigger.getAttribute('data-proof-url');
    if (!url) return;
    e.preventDefault();
    window.showImagePreview({
      url,
      fileName: trigger.getAttribute('data-proof-name') || '',
    });
  });

})();

window.formatDbError = function (error, { action = 'memproses data', entity = 'data ini' } = {}) {
  const rawMessage = String(error?.message || error?.error || error || '').trim();
  const msg = rawMessage.toLowerCase();
  const code = String(error?.code || '');

  if (code === '23503' || msg.includes('foreign key') || msg.includes('violates foreign key constraint')) {
    if (action.includes('hapus') || action.includes('menghapus')) {
      return `${entity} tidak bisa dihapus permanen karena sudah dipakai di data lain, seperti transaksi, log, atau pengaturan. Riwayat tetap aman. Gunakan nonaktifkan/arsip jika tersedia.`;
    }
    return `${entity} belum bisa diubah karena masih terhubung dengan data lain. Periksa data terkait lalu coba lagi.`;
  }

  if (code === '23505' || msg.includes('duplicate key') || msg.includes('already exists')) {
    return `${entity} dengan nama atau kode yang sama sudah ada. Gunakan nama atau kode lain.`;
  }

  if (code === '23502' || msg.includes('null value')) {
    return `Ada kolom wajib yang belum diisi. Lengkapi data ${entity}, lalu simpan lagi.`;
  }

  if (code === '23514' || msg.includes('violates check constraint')) {
    return `Nilai yang diisi belum sesuai aturan. Periksa kembali data ${entity}.`;
  }

  if (code === '22P02' || msg.includes('invalid input syntax')) {
    return `Format data tidak sesuai. Periksa angka, tanggal, atau pilihan yang diisi.`;
  }

  if (code === '42703' || msg.includes('schema cache') || msg.includes('does not exist') || msg.includes('relation')) {
    return 'Database belum memakai pembaruan terbaru. Hubungi developer untuk menjalankan pembaruan database, lalu coba lagi.';
  }

  if (code === '42501' || msg.includes('permission denied')) {
    return 'Akses ditolak. Akun ini belum punya izin untuk melakukan tindakan tersebut.';
  }

  if (msg.includes('failed to fetch') || msg.includes('network') || msg.includes('fetch')) {
    return 'Koneksi ke server bermasalah. Periksa internet, lalu coba lagi.';
  }

  return `Gagal ${action}. Coba lagi. Jika masih gagal, hubungi developer.`;
};

window.showDbError = function (error, opts = {}) {
  showToast(window.formatDbError(error, opts), opts.type || 'error');
};
