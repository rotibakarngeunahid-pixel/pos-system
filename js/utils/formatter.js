'use strict';

// ── Timezone standar sistem: WITA (Waktu Indonesia Tengah, UTC+8) ─────────
// Semua tanggal dan jam di seluruh sistem menggunakan timezone ini.
// Asia/Makassar = WITA = UTC+8 (Bali, Sulawesi, Kalimantan Tengah & Timur, dll.)
const SYSTEM_TZ = 'Asia/Makassar';

const fmt = {
  rupiah(n) {
    return 'Rp ' + Number(n || 0).toLocaleString('id-ID');
  },

  // Parse MySQL DATETIME string ('YYYY-MM-DD HH:MM:SS') sebagai WITA.
  // Tanpa suffix timezone, Chrome bisa interpretasi space-format sebagai UTC →
  // jam maju 8 jam. Dengan append '+08:00' kita paksa interpretasi WITA eksplisit.
  _parseWita(iso) {
    if (!iso) return new Date(NaN);
    if (typeof iso === 'string' && /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(iso)) {
      return new Date(iso.replace(' ', 'T') + '+08:00');
    }
    return new Date(iso);
  },

  date(iso) {
    if (!iso) return '—';
    const d = this._parseWita(iso);
    return d.toLocaleDateString('id-ID', {
      day: '2-digit', month: 'short', year: 'numeric',
      timeZone: SYSTEM_TZ
    }) + ' ' + d.toLocaleTimeString('id-ID', {
      hour: '2-digit', minute: '2-digit',
      timeZone: SYSTEM_TZ
    });
  },

  dateOnly(iso) {
    if (!iso) return '—';
    return this._parseWita(iso).toLocaleDateString('id-ID', {
      day: '2-digit', month: 'long', year: 'numeric',
      timeZone: SYSTEM_TZ
    });
  },

  timeOnly(iso) {
    if (!iso) return '—';
    return this._parseWita(iso).toLocaleTimeString('id-ID', {
      hour: '2-digit', minute: '2-digit',
      timeZone: SYSTEM_TZ
    });
  },

  num(n, dec = 2) {
    return Number(n || 0).toLocaleString('id-ID', { maximumFractionDigits: dec });
  },

  html(str) {
    if (!str) return '';
    return String(str)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  },

  // ── Title Case with acronym exclusions ──────────────────────
  // Words in this set always remain FULL CAPS
  _ACRONYMS: new Set(['QRIS','BCA','BNI','BRI','OVO','DANA','ATM','POS','PIN','GOPAY','SHOPEEPAY','MANDIRI','BSI','BTN','CIMB']),

  titleCase(str) {
    if (!str) return '';
    return String(str).split(/\s+/).map(word => {
      const upper = word.toUpperCase();
      if (this._ACRONYMS.has(upper)) return upper;
      if (!word) return word;
      return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();
    }).join(' ');
  },

  BUSINESS_DAY_CUTOFF_HOUR: 3,

  getBusinessDate(dateInput = null) {
    // Hitung jam dalam WITA untuk business date cutoff
    const now = dateInput ? new Date(dateInput) : new Date();
    const witaOffset = 8 * 60; // WITA = UTC+8
    const localOffset = now.getTimezoneOffset(); // menit, negatif untuk positif offset
    const witaMs = now.getTime() + (witaOffset + localOffset) * 60000;
    const witaDate = new Date(witaMs);
    if (witaDate.getHours() < this.BUSINESS_DAY_CUTOFF_HOUR) {
      witaDate.setDate(witaDate.getDate() - 1);
    }
    return witaDate.toISOString().slice(0, 10);
  },

  // Menghasilkan WITA literal yang cocok dengan data tersimpan di MySQL.
  // DB menyimpan DATETIME dalam WITA (hasil migrasi dengan server timezone WITA).
  // Filter dikirim tanpa konversi timezone — PHP normalizeSqlValue pakai sebagai literal.
  // Contoh: business date '2026-05-28', cutoff 03:00 WITA
  //   from = '2026-05-28T03:00:00' → PHP → '2026-05-28 03:00:00' WITA literal
  //   to   = '2026-05-29T02:59:59' → PHP → '2026-05-29 02:59:59' WITA literal
  // Menghasilkan DATETIME string format MySQL dalam WITA (UTC+8).
  // Contoh output: '2026-05-29 14:35:00' — cocok untuk kolom DATETIME MySQL.
  getWitaTimestamp() {
    const now = new Date();
    const witaOffset = 8 * 60;
    const localOffset = now.getTimezoneOffset();
    const witaMs = now.getTime() + (witaOffset + localOffset) * 60000;
    return new Date(witaMs).toISOString().slice(0, 19).replace('T', ' ');
  },

  getBusinessDateRange(businessDate) {
    const cutoff = this.BUSINESS_DAY_CUTOFF_HOUR;
    const from = `${businessDate}T${String(cutoff).padStart(2, '0')}:00:00`;

    const endH = cutoff > 0 ? cutoff - 1 : 23;
    // Hitung tanggal berikutnya (operasi kalender murni, tanpa timezone issue)
    const [y, m, d] = businessDate.split('-').map(Number);
    const next = new Date(y, m - 1, d + 1);
    const nextDate = [
      next.getFullYear(),
      String(next.getMonth() + 1).padStart(2, '0'),
      String(next.getDate()).padStart(2, '0')
    ].join('-');
    const to = `${nextDate}T${String(endH).padStart(2, '0')}:59:59`;

    return { from, to };
  }
};

// ── Window-level helpers — delegate ke fmt (single source of truth) ──────────
window.fRp = window.formatRupiah = (n) => fmt.rupiah(n);
window.escHtml = window.escapeHtml = (str) => fmt.html(str);

window.showToast = function(msg, type = 'info') {
  const c = document.getElementById('toast-container');
  if (!c) return;
  const t = document.createElement('div');
  t.className = `toast toast-${type}`;
  t.textContent = String(msg);
  c.appendChild(t);
  setTimeout(() => t.remove(), 3500); // unified 3500 ms
};

// BUG-H1 FIX: expose fDate globally so admin.js templates can call fDate(iso)
window.fDate     = (iso) => fmt.date(iso);
window.fDateOnly = (iso) => fmt.dateOnly(iso);
window.fTimeOnly = (iso) => fmt.timeOnly(iso);

// Modal & loader helpers (single source of truth)
window.openModal = function(id) {
  const el = document.getElementById(id);
  if (el) {
    el.classList.add('active');
    window.dispatchEvent(new CustomEvent('rbn:modal:opened', { detail: { id } }));
  }
};

window.closeModal = function(id) {
  const el = document.getElementById(id);
  if (el) {
    el.classList.remove('active');
    window.dispatchEvent(new CustomEvent('rbn:modal:closed', { detail: { id } }));
  }
};

window.showLoader = function() {
  const l = document.getElementById('page-loader');
  if (l) l.style.display = 'flex';
};

window.hideLoader = function() {
  const l = document.getElementById('page-loader');
  if (l) l.style.display = 'none';
};

