-- 005_seed_cash_categories_setoran_tunai.sql
-- Ensure 'Setoran Tunai' cash category exists

BEGIN;

INSERT INTO public.cash_categories (name, type)
SELECT 'Setoran Tunai', 'out'
WHERE NOT EXISTS (
  SELECT 1 FROM public.cash_categories WHERE name = 'Setoran Tunai' AND type = 'out'
);

COMMIT;
