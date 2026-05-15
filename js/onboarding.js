'use strict';

/**
 * Onboarding Tutorial Module — Roti Bakar Ngeunah POS
 *
 * Loads guided tour for new staff users only.
 * Never blocks POS, never creates business data.
 * Progress is persisted to DB; localStorage used as offline buffer only.
 */
const Onboarding = (() => {

  // ── Private State ────────────────────────────────────────────
  let _user         = null;
  let _assignment   = null;
  let _steps        = [];
  let _currentIdx   = 0;
  let _saving       = false;
  let _dismissed    = false;   // sementara ditutup dalam session ini
  let _highlightEl  = null;
  let _scrollParent = null;
  let _resizeTimer  = null;
  const PENDING_KEY = 'ob_pending_steps';

  // ── DOM helpers ──────────────────────────────────────────────
  const qs  = id  => document.getElementById(id);
  const qss = sel => document.querySelector(sel);

  function escHtml(str) {
    if (str == null) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  // ── Entry Panel (pré-start) ──────────────────────────────────
  function showEntryPanel() {
    const panel  = qs('ob-entry-panel');
    if (!panel) return;
    // Hide reopen FAB when entry panel is visible
    const fab = qs('ob-reopen-btn');
    if (fab) fab.classList.remove('visible');
    _dismissed = false;
    const done   = _steps.filter(s => s.status === 'completed').length;
    const total  = _steps.length;
    const isNew  = _assignment.status === 'not_started';

    panel.querySelector('.ob-entry-progress').textContent =
      `${done} dari ${total} langkah selesai`;
    panel.querySelector('.ob-entry-title').textContent =
      isNew ? 'Pelatihan Staff Baru 🎓' : 'Lanjutkan Pelatihan 📚';
    panel.querySelector('.ob-entry-desc').textContent =
      isNew
        ? 'Sebelum mulai bertugas, ikuti panduan singkat agar Anda siap menggunakan POS.'
        : 'Anda belum menyelesaikan semua langkah pelatihan. Lanjutkan dari langkah terakhir.';
    panel.querySelector('[data-ob-action="start"]').textContent =
      isNew ? 'Mulai Pelatihan' : 'Lanjutkan';

    panel.classList.add('visible');
  }

  function hideEntryPanel() {
    const panel = qs('ob-entry-panel');
    if (panel) panel.classList.remove('visible');
  }

  // ── Tour Overlay ─────────────────────────────────────────────
  function showTour() {
    hideEntryPanel();
    const fab = qs('ob-reopen-btn');
    if (fab) fab.classList.remove('visible');
    _dismissed = false;
    // Find first uncompleted step
    _currentIdx = _steps.findIndex(s => s.status !== 'completed');
    if (_currentIdx < 0) {
      _currentIdx = _steps.length - 1;
    }
    renderStep(_currentIdx);
    qs('ob-overlay')?.classList.add('visible');
  }

  function hideTour() {
    qs('ob-overlay')?.classList.remove('visible');
    clearHighlight();
  }

  function renderStep(idx) {
    const step = _steps[idx];
    if (!step) return;

    const overlay    = qs('ob-overlay');
    const tooltip    = qs('ob-tooltip');
    if (!overlay || !tooltip) return;

    const done  = _steps.filter(s => s.status === 'completed').length;
    const total = _steps.length;

    // Fill tooltip content
    tooltip.querySelector('.ob-step-module').textContent = moduleLabel(step.module_key);
    tooltip.querySelector('.ob-step-title').textContent  = step.title;
    tooltip.querySelector('.ob-step-body').innerHTML     = escHtml(step.body);
    tooltip.querySelector('.ob-progress-text').textContent =
      `Langkah ${idx + 1} dari ${total}`;

    // Progress bar
    const bar = tooltip.querySelector('.ob-progress-bar-fill');
    if (bar) bar.style.width = `${Math.round(((done + 1) / total) * 100)}%`;

    // Dots
    renderDots(idx, total);

    // Button states
    const btnBack = tooltip.querySelector('[data-ob-action="back"]');
    const btnNext = tooltip.querySelector('[data-ob-action="next"]');
    const btnDone = tooltip.querySelector('[data-ob-action="done"]');
    const isLast  = idx === _steps.length - 1;

    if (btnBack) btnBack.disabled = idx === 0;
    if (btnNext) {
      btnNext.style.display = isLast ? 'none' : '';
      btnNext.disabled      = _saving;
    }
    if (btnDone) {
      btnDone.style.display = isLast ? '' : 'none';
      btnDone.disabled      = _saving;
    }

    // Highlight target element
    clearHighlight();
    if (step.target_selector) {
      const target = findTarget(step.target_selector);
      if (target) {
        highlightTarget(target, tooltip, overlay);
      } else {
        // Fallback: no highlight, checklist mode
        positionTooltipCenter(tooltip);
        overlay.classList.add('ob-checklist-mode');
        logMissingTarget(step);
      }
    } else {
      positionTooltipCenter(tooltip);
    }
  }

  function renderDots(activeIdx, total) {
    const container = qs('ob-dots');
    if (!container) return;
    const showDots  = Math.min(total, 12);
    const startIdx  = activeIdx >= showDots
      ? activeIdx - showDots + 1
      : 0;

    container.innerHTML = Array.from({ length: Math.min(showDots, total) }, (_, i) => {
      const realIdx = startIdx + i;
      const cls = realIdx === activeIdx
        ? 'ob-dot ob-dot-active'
        : _steps[realIdx]?.status === 'completed'
          ? 'ob-dot ob-dot-done'
          : 'ob-dot';
      return `<span class="${cls}"></span>`;
    }).join('');
  }

  function moduleLabel(key) {
    const map = {
      modul_1_shift:          'Modul 1 — Shift & Cabang',
      modul_2_penjualan:      'Modul 2 — Penjualan',
      modul_3_stok_otomatis:  'Modul 3 — Stok Otomatis',
      modul_4_manajemen_stok: 'Modul 4 — Manajemen Stok',
      modul_5_riwayat:        'Modul 5 — Riwayat & Void',
      modul_6_kas_shift:      'Modul 6 — Kas & Setoran',
    };
    return map[key] || key;
  }

  // ── Target Highlight ─────────────────────────────────────────
  function findTarget(selector) {
    try {
      return document.querySelector(selector) || null;
    } catch {
      return null;
    }
  }

  function highlightTarget(target, tooltip, overlay) {
    overlay.classList.remove('ob-checklist-mode');

    target.scrollIntoView({ behavior: 'smooth', block: 'center' });

    requestAnimationFrame(() => {
      setTimeout(() => positionHighlight(target, tooltip), 350);
    });

    _highlightEl = target;
    target.classList.add('ob-target-highlight');
  }

  function positionHighlight(target, tooltip) {
    const rect     = target.getBoundingClientRect();
    const highlightBox = qs('ob-highlight-box');
    if (!highlightBox) return;

    const pad = 8;
    highlightBox.style.top    = `${rect.top    - pad + window.scrollY}px`;
    highlightBox.style.left   = `${rect.left   - pad + window.scrollX}px`;
    highlightBox.style.width  = `${rect.width  + pad * 2}px`;
    highlightBox.style.height = `${rect.height + pad * 2}px`;
    highlightBox.style.display = 'block';

    // Position tooltip below or above target
    positionTooltipNearTarget(rect, tooltip);
  }

  function positionTooltipNearTarget(targetRect, tooltip) {
    const tw   = tooltip.offsetWidth  || 340;
    const th   = tooltip.offsetHeight || 220;
    const vw   = window.innerWidth;
    const vh   = window.innerHeight;
    const gap  = 16;

    let top, left;

    // Prefer below
    if (targetRect.bottom + th + gap < vh) {
      top = targetRect.bottom + gap;
    } else {
      top = Math.max(8, targetRect.top - th - gap);
    }

    // Center horizontally on target, clamped to viewport
    left = targetRect.left + targetRect.width / 2 - tw / 2;
    left = Math.max(12, Math.min(left, vw - tw - 12));

    tooltip.style.top    = `${top  + window.scrollY}px`;
    tooltip.style.left   = `${left + window.scrollX}px`;
    tooltip.style.bottom = 'auto';
    tooltip.style.right  = 'auto';
  }

  function positionTooltipCenter(tooltip) {
    const highlightBox = qs('ob-highlight-box');
    if (highlightBox) highlightBox.style.display = 'none';
    tooltip.style.top    = '50%';
    tooltip.style.left   = '50%';
    tooltip.style.bottom = 'auto';
    tooltip.style.right  = 'auto';
    tooltip.style.transform = 'translate(-50%, -50%)';
  }

  function clearHighlight() {
    const highlightBox = qs('ob-highlight-box');
    if (highlightBox) highlightBox.style.display = 'none';
    if (_highlightEl) {
      _highlightEl.classList.remove('ob-target-highlight');
      _highlightEl = null;
    }
    const tooltip = qs('ob-tooltip');
    if (tooltip) tooltip.style.transform = '';
    qs('ob-overlay')?.classList.remove('ob-checklist-mode');
  }

  // ── Navigation ───────────────────────────────────────────────
  async function nextStep() {
    if (_saving) return;
    const step = _steps[_currentIdx];
    if (!step) return;

    await saveStepProgress(step.step_key);

    if (_currentIdx < _steps.length - 1) {
      _currentIdx++;
      renderStep(_currentIdx);
    }
  }

  async function prevStep() {
    if (_currentIdx > 0) {
      _currentIdx--;
      renderStep(_currentIdx);
    }
  }

  async function finishOnboarding() {
    if (_saving) return;
    const step = _steps[_currentIdx];
    if (step) await saveStepProgress(step.step_key);

    // Mark remaining required steps as complete if somehow skipped
    const remaining = _steps.filter(s => s.is_required && s.status !== 'completed');
    for (const s of remaining) {
      await saveStepProgress(s.step_key);
    }

    hideTour();
    showCompletionBanner();
  }

  function dismissTemporarily() {
    _dismissed = true;
    hideEntryPanel();
    hideTour();
    // Show reopen FAB so staff can get back to tutorial anytime
    const fab = qs('ob-reopen-btn');
    if (fab) fab.classList.add('visible');
  }

  // ── Progress Persistence ─────────────────────────────────────
  async function saveStepProgress(stepKey) {
    if (_saving) return;
    _saving = true;
    setNextDisabled(true);

    // Optimistic local update
    const step = _steps.find(s => s.step_key === stepKey);
    if (step) step.status = 'completed';

    try {
      const { data, error } = await db.rpc('complete_onboarding_step', {
        p_assignment_id: _assignment.id,
        p_step_key:      stepKey,
        p_user_id:       _user.id,
      });

      if (error) throw error;

      // Check if assignment fully completed
      if (data?.assignment_completed) {
        _assignment.status = 'completed';
      }

      // Sync any pending offline steps
      await syncPendingSteps();

    } catch (err) {
      // Offline fallback: queue in localStorage
      queuePendingStep(stepKey);
      // Don't show error to user — silent offline handling
    } finally {
      _saving = false;
      setNextDisabled(false);
    }
  }

  function setNextDisabled(disabled) {
    const btn = qs('ob-tooltip')?.querySelector('[data-ob-action="next"]');
    const btnDone = qs('ob-tooltip')?.querySelector('[data-ob-action="done"]');
    if (btn) btn.disabled = disabled;
    if (btnDone) btnDone.disabled = disabled;
  }

  function queuePendingStep(stepKey) {
    try {
      const existing = JSON.parse(localStorage.getItem(PENDING_KEY) || '[]');
      if (!existing.includes(stepKey)) {
        existing.push(stepKey);
        localStorage.setItem(PENDING_KEY, JSON.stringify(existing));
      }
    } catch { /* ignore */ }
  }

  async function syncPendingSteps() {
    try {
      const pending = JSON.parse(localStorage.getItem(PENDING_KEY) || '[]');
      if (!pending.length) return;

      for (const stepKey of [...pending]) {
        const { error } = await db.rpc('complete_onboarding_step', {
          p_assignment_id: _assignment.id,
          p_step_key:      stepKey,
          p_user_id:       _user.id,
        });
        if (!error) {
          const arr = JSON.parse(localStorage.getItem(PENDING_KEY) || '[]');
          localStorage.setItem(PENDING_KEY, JSON.stringify(arr.filter(k => k !== stepKey)));
        }
      }
    } catch { /* ignore */ }
  }

  // ── Missing Target Audit ────────────────────────────────────
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

  // ── Completion Banner ────────────────────────────────────────
  function showCompletionBanner() {
    // Hide reopen FAB permanently — training is done
    const fab = qs('ob-reopen-btn');
    if (fab) { fab.classList.remove('visible'); }

    const banner = qs('ob-complete-banner');
    if (!banner) return;
    banner.classList.add('visible');
    setTimeout(() => banner.classList.remove('visible'), 5000);
  }

  // ── Start Flow ───────────────────────────────────────────────
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
    showTour();
  }

  // ── Event Delegation (onboarding actions) ────────────────────
  function bindEvents() {
    document.addEventListener('click', async e => {
      const btn = e.target.closest('[data-ob-action]');
      if (!btn) return;
      const action = btn.dataset.obAction;

      switch (action) {
        case 'start':     await startTour(); break;
        case 'next':      await nextStep(); break;
        case 'back':      prevStep(); break;
        case 'done':      await finishOnboarding(); break;
        case 'dismiss':   dismissTemporarily(); break;
        case 'reopen':    showEntryPanel(); break;
      }
    });

    // Reposition on resize
    window.addEventListener('resize', () => {
      clearTimeout(_resizeTimer);
      _resizeTimer = setTimeout(() => {
        if (_highlightEl) {
          const tooltip = qs('ob-tooltip');
          positionHighlight(_highlightEl, tooltip);
        }
      }, 200);
    });
  }

  // ── Public API ────────────────────────────────────────────────
  async function init(user) {
    if (!user || user.role !== 'staff') return;
    _user = user;

    bindEvents();

    // Try to sync any offline-queued steps first
    await syncPendingSteps();

    let data;
    try {
      const { data: rpcData, error } = await db.rpc('get_my_onboarding', {
        p_user_id: user.id,
      });
      if (error) throw error;
      data = rpcData;
    } catch (err) {
      // Non-fatal: onboarding unavailable, POS continues normally
      if (window.showToast) {
        showToast('Pelatihan tidak tersedia saat ini.', 'info');
      }
      return;
    }

    // No assignment or already completed
    if (!data || !data.assignment) return;
    if (data.assignment.status === 'completed') return;

    _assignment = data.assignment;
    _steps      = Array.isArray(data.steps) ? data.steps : [];

    if (!_steps.length) return;

    showEntryPanel();
  }

  return { init };

})();
