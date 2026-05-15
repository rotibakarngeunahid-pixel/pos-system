-- ═══════════════════════════════════════════════════════════════
-- Migration 022: Fix onboarding step selectors
-- Steps pointing to elements inside closed modals are replaced
-- with their visible trigger buttons on the main POS layout.
-- ═══════════════════════════════════════════════════════════════

BEGIN;

DO $$
DECLARE v_tid BIGINT;
BEGIN
  SELECT id INTO v_tid
  FROM onboarding_templates
  WHERE template_key = 'staff_pos_basics' AND version = 1;

  IF v_tid IS NULL THEN RETURN; END IF;

  -- m2_discount, m2_payment, m2_checkout: were pointing to elements inside
  -- modal-payment which is closed during tour → point to FAB cart button
  UPDATE onboarding_steps SET target_selector = '#fab-cart-btn'
  WHERE template_id = v_tid AND step_key = 'm2_discount';

  UPDATE onboarding_steps SET target_selector = '#fab-cart-btn'
  WHERE template_id = v_tid AND step_key = 'm2_payment';

  UPDATE onboarding_steps SET target_selector = '#fab-cart-btn'
  WHERE template_id = v_tid AND step_key = 'm2_checkout';

  -- m4_stock_transfer: was pointing to #stock-adj-type inside modal-stock-adjust
  -- → point to the Ubah Stok button that's always visible on stock tab
  UPDATE onboarding_steps SET target_selector = 'button[data-action="open-stock-adjust-modal"]'
  WHERE template_id = v_tid AND step_key = 'm4_stock_transfer';

  -- m1_open_shift: #btn-open-shift is inside modal-shift (only visible when shift
  -- hasn't been opened yet). Safe fallback: point to the Tutup Shift button in header
  -- which is always visible after shift is open; or just remove selector for welcome step.
  -- For new staff the shift modal IS open, so this one is fine as-is.
  -- No change needed.

END;
$$;

COMMIT;
