'use strict';

// ── Timezone standar sistem: WITA (Waktu Indonesia Tengah, UTC+8) ─────────
// Semua tanggal dan jam di seluruh sistem menggunakan timezone ini.
// Asia/Makassar = WITA = UTC+8 (Bali, Sulawesi, Kalimantan Tengah & Timur, dll.)
const SYSTEM_TZ = 'Asia/Makassar';

const fmt = {
  rupiah(n) {
    return 'Rp ' + Number(n || 0).toLocaleString('id-ID');
  },

  date(iso) {
    if (!iso) return '—';
    const d = new Date(iso);
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
    return new Date(iso).toLocaleDateString('id-ID', {
      day: '2-digit', month: 'long', year: 'numeric',
      timeZone: SYSTEM_TZ
    });
  },

  timeOnly(iso) {
    if (!iso) return '—';
    return new Date(iso).toLocaleTimeString('id-ID', {
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

  // BUG 5A FIX: use padStart(2,'0') for both startHour and endHour
  // to prevent malformed timestamps like "T002:59:59" or "T03:00:00" for cutoff >= 10.
  getBusinessDateRange(businessDate) {
    const cutoff    = this.BUSINESS_DAY_CUTOFF_HOUR;
    const startHour = String(cutoff).padStart(2, '0');
    const from      = `${businessDate}T${startHour}:00:00`;

    const d = new Date(businessDate + 'T12:00:00');
    d.setDate(d.getDate() + 1);
    const nextDate = d.toISOString().slice(0, 10);

    // Guard: if cutoff is 0 treat end-of-range as same calendar-day 23:59:59
    const endH  = cutoff > 0 ? cutoff - 1 : 23;
    const endHour = String(endH).padStart(2, '0');
    const to      = cutoff > 0 ? `${nextDate}T${endHour}:59:59` : `${businessDate}T23:59:59`;

    return { from, to };
  }
};

// ── BUG-17 FIX: Unified window-level helpers ───────────────────────────────
// Shared by both pos.js and admin.js — single source of truth.
// Local definitions in those files are thin aliases that defer here.
window.fRp = window.formatRupiah = function(n) {
  return 'Rp ' + Number(n || 0).toLocaleString('id-ID');
};

window.escHtml = window.escapeHtml = function(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g,'&amp;').replace(/</g,'&lt;')
    .replace(/>/g,'&gt;').replace(/"/g,'&quot;')
    .replace(/'/g,'&#39;');
};

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

