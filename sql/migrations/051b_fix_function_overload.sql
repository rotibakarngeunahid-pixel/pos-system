-- ══════════════════════════════════════════════════════════════════════════
-- Migration 051b: Fix — Drop versi lama fungsi integrasi (4 parameter)
-- ══════════════════════════════════════════════════════════════════════════
--
-- Error 42725: function name "get_sales_integration" is not unique
-- Terjadi karena ada DUA versi fungsi:
--   - Lama (dari migration 049/050): 4 parameter (text, date, date, integer)
--   - Baru (dari migration 051):     6 parameter (text, date, date, integer, integer, integer)
--
-- Solusi: drop versi lama, versi baru dari migration 051 tetap aktif.
-- ══════════════════════════════════════════════════════════════════════════

BEGIN;

-- ── Drop versi lama get_sales_integration (4 parameter) ──────────────────
DROP FUNCTION IF EXISTS public.get_sales_integration(text, date, date, integer);

-- ── Drop versi lama get_kas_keluar_integration (4 parameter) ─────────────
DROP FUNCTION IF EXISTS public.get_kas_keluar_integration(text, date, date, integer);

-- ── Drop versi lama get_integration_summary (4 parameter) ────────────────
DROP FUNCTION IF EXISTS public.get_integration_summary(text, date, date, integer);

-- ── Perbaiki GRANT dengan signature lengkap (6 parameter) ────────────────
REVOKE ALL ON FUNCTION public.get_sales_integration(text, date, date, integer, integer, integer)
  FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_sales_integration(text, date, date, integer, integer, integer)
  TO anon, authenticated;

REVOKE ALL ON FUNCTION public.get_kas_keluar_integration(text, date, date, integer, integer, integer)
  FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_kas_keluar_integration(text, date, date, integer, integer, integer)
  TO anon, authenticated;

REVOKE ALL ON FUNCTION public.get_integration_summary(text, date, date, integer, integer, integer)
  FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_integration_summary(text, date, date, integer, integer, integer)
  TO anon, authenticated;

-- ── Reload schema cache ───────────────────────────────────────────────────
NOTIFY pgrst, 'reload schema';

COMMIT;
