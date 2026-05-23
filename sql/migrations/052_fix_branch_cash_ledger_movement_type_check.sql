-- ══════════════════════════════════════════════════════════════════════════
-- Migration 052: Fix branch_cash_ledger — movement_type CHECK constraint
-- ══════════════════════════════════════════════════════════════════════════
--
-- Root cause:
--   Migration 035 membuat tabel branch_cash_ledger dengan CHECK constraint:
--     movement_type IN ('default_seed','session_open_confirm','opening_variance',
--                       'session_close','deposit_approved','deposit_rejected',
--                       'admin_adjustment','force_close','system_repair')
--
--   Migration 041 mencoba rekreasi tabel TANPA constraint, tapi pakai
--   CREATE TABLE IF NOT EXISTS → tabel lama (dengan constraint) tidak berubah.
--
--   Migration 050 menambahkan trigger yang memasukkan movement_type baru:
--     'sale_cash_in', 'sale_cash_void',
--     'manual_cash_in', 'manual_cash_out',
--     'manual_cash_in_void', 'manual_cash_out_void'
--
--   Nilai-nilai baru ini TIDAK ADA di constraint lama → checkout tunai gagal
--   dengan error: "violates check constraint branch_cash_ledger_movement_type_check"
--
-- Fix:
--   Drop constraint lama, tambahkan constraint baru yang mencakup semua nilai.
-- ══════════════════════════════════════════════════════════════════════════

BEGIN;

-- ── Drop constraint lama (jika masih ada) ────────────────────────────────
ALTER TABLE public.branch_cash_ledger
  DROP CONSTRAINT IF EXISTS branch_cash_ledger_movement_type_check;

-- ── Tambah constraint baru yang mencakup semua movement_type yang valid ───
ALTER TABLE public.branch_cash_ledger
  ADD CONSTRAINT branch_cash_ledger_movement_type_check
  CHECK (movement_type IN (
    -- Nilai lama (dari migration 035)
    'default_seed',
    'session_open_confirm',
    'opening_variance',
    'session_close',
    'deposit_approved',
    'deposit_rejected',
    'admin_adjustment',
    'force_close',
    'system_repair',
    -- Nilai baru (dari migration 050 — real-time sync trigger)
    'sale_cash_in',
    'sale_cash_void',
    'manual_cash_in',
    'manual_cash_out',
    'manual_cash_in_void',
    'manual_cash_out_void'
  ));

-- ── Pastikan direction constraint juga mencakup semua nilai yang dipakai ──
-- (biasanya tidak bermasalah, tapi pastikan saja)
ALTER TABLE public.branch_cash_ledger
  DROP CONSTRAINT IF EXISTS branch_cash_ledger_direction_check;

ALTER TABLE public.branch_cash_ledger
  ADD CONSTRAINT branch_cash_ledger_direction_check
  CHECK (direction IN ('in', 'out', 'adjust', 'none'));

COMMIT;
