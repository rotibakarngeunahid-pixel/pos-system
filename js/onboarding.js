'use strict';

/**
 * Onboarding Tutorial Module — Roti Bakar Ngeunah POS
 *
 * Guided tour that:
 *  - Auto-navigates to the correct POS tab for each module
 *  - Spotlights the target element with a cutout overlay
 *  - Shows an animated bouncing pointer above the target
 *  - Persists progress to DB; localStorage as offline buffer
 *  - Never creates any business data
 */
const Onboarding = (() => {

  // ── State ────────────────────────────────────────────────────
  let _user         = null;
  let _assignment   = null;
  let _steps        = [];
  let _currentIdx   = 0;
  let _saving       = false;
  let _dismissed    = false;
  let _highlightEl  = null;
  let _transitioning = false;
  let _resizeTimer  = null;
  const PENDING_KEY = 'ob_pending_steps';

  // Which tab to switch to for each module
  const MODULE_TAB = {
    modul_1_shift:          'kasir',
    modul_2_penjualan:      'kasir',
    modul_3_stok_otomatis:  'stock',
    modul_4_manajemen_stok: 'stock',
    modul_5_riwayat:        'transactions',
    modul_6_kas_shift:      'cash',
  };
  // Per-step overrides take precedence
  const STEP_TAB = { m6_deposit: 'deposits' };

  // ── Helpers ──────────────────────────────────────────────────
  const $  = id  => document.getElementById(id);
  const $$ = sel => document.querySelector(sel);

  function esc(s) {
    if (s == null) return '';
    return String(s)
      .replace(/&/g,'&amp;').replace(/</g,'&lt;')
      .replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
  }

  const sleep = ms => new Promise(r => setTimeout(r, ms));

  // ── Tab Navigation ───────────────────────────────────────────
  function getRequiredTab(step) {
    return STEP_TAB[step.step_key] || MODULE_TAB[step.module_key] || 'kasir';
  }

  function switchToTab(tabName) {
    const btn = document.querySelector(`.pos-tab-item[data-tab="${tabName}"]`);
    if (btn && !btn.classList.contains('active')) {
      btn.click();
      return true;
    }
    return false;
  }

  // ── Entry Panel ──────────────────────────────────────────────
  function showEntryPanel() {
    const panel = $('ob-entry-panel');
    if (!panel) return;
    $('ob-reopen-btn')?.classList.remove('visible');
    _dismissed = false;

    const done  = _steps.filter(s => s.status === 'completed').length;
    const total = _steps.length;
    const isNew = _assignment.status === 'not_started';

    panel.querySelector('.ob-entry-progress').textContent =
      `${done} dari ${total} langkah selesai`;
    panel.querySelector('.ob-entry-title').textContent =
      isNew ? 'Pelatihan Staff Baru 🎓' : 'Lanjutkan Pelatihan 📚';
    panel.querySelector('.ob-entry-desc').textContent =
      isNew
        ? 'Ikuti panduan ini agar Anda siap menggunakan POS sebelum mulai bertugas.'
        : 'Anda masih punya langkah pelatihan yang belum selesai. Lanjutkan sekarang?';
    panel.querySelector('[data-ob-action="start"]').textContent =
      isNew ? 'Mulai Pelatihan' : 'Lanjutkan';
    panel.classList.add('visible');
  }

  function hideEntryPanel() {
    $('ob-entry-panel')?.classList.remove('visible');
  }

  // ── Tour Overlay ─────────────────────────────────────────────
  async function showTour() {
    hideEntryPanel();
    $('ob-reopen-btn')?.classList.remove('visible');
    _dismissed = false;

    _currentIdx = _steps.findIndex(s => s.status !== 'completed');
    if (_currentIdx < 0) _currentIdx = _steps.length - 1;

    $('ob-overlay')?.classList.add('visible');
    await renderStep(_currentIdx);
  }

  function hideTour() {
    clearHighlight();
    clearPointer();
    $('ob-overlay')?.classList.remove('visible', 'ob-no-target');
  }

  // ── Render Step ──────────────────────────────────────────────
  async function renderStep(idx) {
    if (_transitioning) return;
    _transitioning = true;

    const overlay = $('ob-overlay');
    const tooltip = $('ob-tooltip');
    const step    = _steps[idx];
    if (!step || !tooltip || !overlay) { _transitioning = false; return; }

    // 1. Fade out tooltip
    tooltip.classList.remove('ob-tooltip-in');
    tooltip.classList.add('ob-tooltip-out');
    clearHighlight();
    clearPointer();
    await sleep(160);

    // 2. Switch tab if needed (auto-navigate)
    const requiredTab = getRequiredTab(step);
    const switched    = switchToTab(requiredTab);
    if (switched) await sleep(300);

    // 3. Fill tooltip content (module label, title, body, buttons)
    fillTooltipContent(step, idx);

    // 4. Find and spotlight target
    let target = null;
    if (step.target_selector) {
      target = safeQuerySelector(step.target_selector);
    }

    if (target) {
      overlay.classList.remove('ob-no-target');

      // Scroll target into view, wait for scroll
      target.scrollIntoView({ behavior: 'smooth', block: 'center' });
      await sleep(360);

      // Apply spotlight on target
      _highlightEl = target;
      target.classList.add('ob-target-active');
      positionSpotlight(target);
      showPointer(target);
      positionTooltipNearTarget(target, tooltip);

    } else {
      overlay.classList.add('ob-no-target');
      positionTooltipCenter(tooltip);
      if (step.target_selector) logMissingTarget(step);
    }

    // 5. Fade in tooltip
    tooltip.classList.remove('ob-tooltip-out');
    tooltip.classList.add('ob-tooltip-in');

    _transitioning = false;

    // Reposition on next resize
    if (!_resizeObserver && target) {
      window.addEventListener('resize', _onResize, { passive: true });
    }
  }

  let _resizeObserver = null;

  function _onResize() {
    clearTimeout(_resizeTimer);
    _resizeTimer = setTimeout(() => {
      if (!_highlightEl) return;
      positionSpotlight(_highlightEl);
      showPointer(_highlightEl);
      const tooltip = $('ob-tooltip');
      if (tooltip) positionTooltipNearTarget(_highlightEl, tooltip);
    }, 200);
  }

  // ── Spotlight (cutout via box-shadow) ────────────────────────
  function positionSpotlight(target) {
    const box = $('ob-highlight-box');
    if (!box) return;

    const rect = target.getBoundingClientRect();
    const pad  = 10;

    box.style.top    = `${rect.top    + window.scrollY - pad}px`;
    box.style.left   = `${rect.left   + window.scrollX - pad}px`;
    box.style.width  = `${rect.width  + pad * 2}px`;
    box.style.height = `${rect.height + pad * 2}px`;

    // Inherit target border-radius for a natural feel
    const targetRadius = parseInt(getComputedStyle(target).borderRadius) || 4;
    box.style.borderRadius = `${Math.max(8, targetRadius + 4)}px`;
    box.style.display = 'block';
  }

  function clearHighlight() {
    const box = $('ob-highlight-box');
    if (box) box.style.display = 'none';
    if (_highlightEl) {
      _highlightEl.classList.remove('ob-target-active');
      _highlightEl = null;
    }
  }

  // ── Animated Pointer ─────────────────────────────────────────
  function showPointer(target) {
    const ptr = $('ob-pointer');
    if (!ptr) return;
    const rect = target.getBoundingClientRect();

    // Place pointer icon centered on top edge of target
    const x = rect.left + window.scrollX + rect.width  * 0.65;
    const y = rect.top  + window.scrollY - 32;

    ptr.style.left = `${x}px`;
    ptr.style.top  = `${y}px`;
    ptr.classList.add('visible');
  }

  function clearPointer() {
    $('ob-pointer')?.classList.remove('visible');
  }

  // ── Tooltip Content ──────────────────────────────────────────
  function fillTooltipContent(step, idx) {
    const tooltip = $('ob-tooltip');
    if (!tooltip) return;

    const total  = _steps.length;
    const isLast = idx === _steps.length - 1;

    tooltip.querySelector('.ob-step-module').textContent = moduleLabel(step.module_key);
    tooltip.querySelector('.ob-step-title').textContent  = step.title;
    tooltip.querySelector('.ob-step-body').textContent   = step.body;
    tooltip.querySelector('.ob-progress-text').textContent =
      `Langkah ${idx + 1} dari ${total}`;

    const fill = tooltip.querySelector('.ob-progress-bar-fill');
    if (fill) fill.style.width = `${Math.round(((idx + 1) / total) * 100)}%`;

    renderDots(idx, total);

    const btnBack = tooltip.querySelector('[data-ob-action="back"]');
    const btnNext = tooltip.querySelector('[data-ob-action="next"]');
    const btnDone = tooltip.querySelector('[data-ob-action="done"]');

    if (btnBack) btnBack.disabled = idx === 0;
    if (btnNext) {
      btnNext.style.display = isLast ? 'none' : '';
      btnNext.disabled = _saving;
    }
    if (btnDone) {
      btnDone.style.display = isLast ? '' : 'none';
      btnDone.disabled = _saving;
    }
  }

  function renderDots(activeIdx, total) {
    const wrap = $('ob-dots');
    if (!wrap) return;
    const max   = Math.min(total, 12);
    const start = Math.max(0, activeIdx - Math.floor(max / 2));
    const count = Math.min(max, total - start);
    wrap.innerHTML = Array.from({ length: count }, (_, i) => {
      const ri  = start + i;
      const cls = ri === activeIdx       ? 'ob-dot ob-dot-active'
                : _steps[ri]?.status === 'completed' ? 'ob-dot ob-dot-done'
                : 'ob-dot';
      return `<span class="${cls}"></span>`;
    }).join('');
  }

  function moduleLabel(key) {
    return ({
      modul_1_shift:          'Modul 1 — Shift & Cabang',
      modul_2_penjualan:      'Modul 2 — Penjualan',
      modul_3_stok_otomatis:  'Modul 3 — Stok Otomatis',
      modul_4_manajemen_stok: 'Modul 4 — Manajemen Stok',
      modul_5_riwayat:        'Modul 5 — Riwayat & Void',
      modul_6_kas_shift:      'Modul 6 — Kas & Setoran',
    })[key] || key;
  }

  // ── Tooltip Positioning ──────────────────────────────────────
  function positionTooltipNearTarget(target, tooltip) {
    const rect = target.getBoundingClientRect();
    const tw   = Math.min(tooltip.offsetWidth  || 340, 340);
    const th   = tooltip.offsetHeight || 240;
    const vw   = window.innerWidth;
    const vh   = window.innerHeight;
    const gap  = 18;

    let top, left;

    if (rect.bottom + th + gap < vh) {
      top = rect.bottom + gap + window.scrollY;
    } else if (rect.top - th - gap > 0) {
      top = rect.top - th - gap + window.scrollY;
    } else {
      top = window.scrollY + vh - th - 12;
    }

    left = rect.left + rect.width / 2 - tw / 2 + window.scrollX;
    left = Math.max(12, Math.min(left, vw - tw - 12));

    tooltip.style.position  = 'absolute';
    tooltip.style.top       = `${top}px`;
    tooltip.style.left      = `${left}px`;
    tooltip.style.bottom    = 'auto';
    tooltip.style.right     = 'auto';
    tooltip.style.transform = '';
  }

  function positionTooltipCenter(tooltip) {
    tooltip.style.position  = 'fixed';
    tooltip.style.top       = '50%';
    tooltip.style.left      = '50%';
    tooltip.style.bottom    = 'auto';
    tooltip.style.right     = 'auto';
    tooltip.style.transform = 'translate(-50%, -50%)';
  }

  // ── Navigation ───────────────────────────────────────────────
  async function nextStep() {
    if (_saving || _transitioning) return;
    const step = _steps[_currentIdx];
    if (step) await saveStepProgress(step.step_key);
    if (_currentIdx < _steps.length - 1) {
      _currentIdx++;
      await renderStep(_currentIdx);
    }
  }

  async function prevStep() {
    if (_transitioning) return;
    if (_currentIdx > 0) {
      _currentIdx--;
      await renderStep(_currentIdx);
    }
  }

  async function finishOnboarding() {
    if (_saving || _transitioning) return;
    const step = _steps[_currentIdx];
    if (step) await saveStepProgress(step.step_key);

    // Ensure all required steps are marked done
    for (const s of _steps.filter(s => s.is_required && s.status !== 'completed')) {
      await saveStepProgress(s.step_key);
    }

    hideTour();
    showCompletionBanner();
  }

  function dismissTemporarily() {
    _dismissed = true;
    hideEntryPanel();
    hideTour();
    const fab = $('ob-reopen-btn');
    if (fab) fab.classList.add('visible');
  }

  // ── Progress Persistence ─────────────────────────────────────
  function setNavDisabled(disabled) {
    const tooltip = $('ob-tooltip');
    if (!tooltip) return;
    ['next','done'].forEach(a => {
      const b = tooltip.querySelector(`[data-ob-action="${a}"]`);
      if (b) b.disabled = disabled;
    });
  }

  async function saveStepProgress(stepKey) {
    if (_saving) return;
    _saving = true;
    setNavDisabled(true);

    // Optimistic local
    const step = _steps.find(s => s.step_key === stepKey);
    if (step) step.status = 'completed';

    try {
      const { data, error } = await db.rpc('complete_onboarding_step', {
        p_assignment_id: _assignment.id,
        p_step_key:      stepKey,
        p_user_id:       _user.id,
      });
      if (error) throw error;
      if (data?.assignment_completed) _assignment.status = 'completed';
      await syncPendingSteps();
    } catch {
      queuePendingStep(stepKey);
    } finally {
      _saving = false;
      setNavDisabled(false);
    }
  }

  function queuePendingStep(stepKey) {
    try {
      const arr = JSON.parse(localStorage.getItem(PENDING_KEY) || '[]');
      if (!arr.includes(stepKey)) {
        arr.push(stepKey);
        localStorage.setItem(PENDING_KEY, JSON.stringify(arr));
      }
    } catch { /* ignore */ }
  }

  async function syncPendingSteps() {
    try {
      const arr = JSON.parse(localStorage.getItem(PENDING_KEY) || '[]');
      if (!arr.length) return;
      for (const key of [...arr]) {
        const { error } = await db.rpc('complete_onboarding_step', {
          p_assignment_id: _assignment.id,
          p_step_key:      key,
          p_user_id:       _user.id,
        });
        if (!error) {
          const cur = JSON.parse(localStorage.getItem(PENDING_KEY) || '[]');
          localStorage.setItem(PENDING_KEY, JSON.stringify(cur.filter(k => k !== key)));
        }
      }
    } catch { /* ignore */ }
  }

  // ── Audit Log ────────────────────────────────────────────────
  async function logMissingTarget(step) {
    try {
      await db.from('onboarding_events').insert({
        assignment_id: _assignment.id,
        user_id:       _user.id,
        event_type:    'target_missing',
        step_key:      step.step_key,
        metadata:      { selector: step.target_selector },
      });
    } catch { /* ignore */ }
  }

  function safeQuerySelector(sel) {
    try { return document.querySelector(sel) || null; }
    catch { return null; }
  }

  // ── Completion Banner ────────────────────────────────────────
  function showCompletionBanner() {
    $('ob-reopen-btn')?.classList.remove('visible');
    const banner = $('ob-complete-banner');
    if (!banner) return;
    banner.classList.add('visible');
    setTimeout(() => banner.classList.remove('visible'), 5500);
  }

  // ── Start ────────────────────────────────────────────────────
  async function startTour() {
    if (_assignment.status === 'not_started') {
      try {
        await db.rpc('start_my_onboarding', {
          p_assignment_id: _assignment.id,
          p_user_id:       _user.id,
        });
        _assignment.status = 'in_progress';
      } catch { /* non-fatal */ }
    }
    await showTour();
  }

  // ── Event Binding ────────────────────────────────────────────
  function bindEvents() {
    document.addEventListener('click', async e => {
      const btn = e.target.closest('[data-ob-action]');
      if (!btn) return;
      const action = btn.dataset.obAction;
      switch (action) {
        case 'start':   await startTour(); break;
        case 'next':    await nextStep(); break;
        case 'back':    await prevStep(); break;
        case 'done':    await finishOnboarding(); break;
        case 'dismiss': dismissTemporarily(); break;
        case 'reopen':  showEntryPanel(); break;
      }
    });
  }

  // ── Public API ────────────────────────────────────────────────
  async function init(user) {
    if (!user || user.role !== 'staff') return;
    _user = user;

    bindEvents();
    await syncPendingSteps();

    let data;
    try {
      const { data: d, error } = await db.rpc('get_my_onboarding', { p_user_id: user.id });
      if (error) throw error;
      data = d;
    } catch {
      if (window.showToast) showToast('Info pelatihan tidak tersedia.', 'info');
      return;
    }

    if (!data?.assignment) return;
    if (data.assignment.status === 'completed') return;

    _assignment = data.assignment;
    _steps      = Array.isArray(data.steps) ? data.steps : [];
    if (!_steps.length) return;

    showEntryPanel();
  }

  return { init };

})();
