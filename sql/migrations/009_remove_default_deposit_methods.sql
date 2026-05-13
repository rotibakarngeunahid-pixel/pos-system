-- 009_remove_default_deposit_methods.sql
-- Revert the seeded default deposit methods from migration 008.
-- Staff UI must show only methods configured from Admin.

BEGIN;

WITH seeded_defaults AS (
  SELECT id
  FROM public.deposit_accounts
  WHERE branch_id IS NULL
    AND label IN ('Transfer BCA', 'Transfer BNI', 'Transfer BRI', 'Tunai ke Manager')
    AND account_number IS NULL
    AND account_holder IS NULL
    AND qris_image_url IS NULL
),
referenced_defaults AS (
  SELECT DISTINCT deposit_account_id AS id
  FROM public.cash_deposits
  WHERE deposit_account_id IN (SELECT id FROM seeded_defaults)
)
UPDATE public.deposit_accounts
SET is_active = false
WHERE id IN (SELECT id FROM referenced_defaults);

WITH seeded_defaults AS (
  SELECT id
  FROM public.deposit_accounts
  WHERE branch_id IS NULL
    AND label IN ('Transfer BCA', 'Transfer BNI', 'Transfer BRI', 'Tunai ke Manager')
    AND account_number IS NULL
    AND account_holder IS NULL
    AND qris_image_url IS NULL
),
unreferenced_defaults AS (
  SELECT id
  FROM seeded_defaults
  WHERE id NOT IN (
    SELECT deposit_account_id
    FROM public.cash_deposits
    WHERE deposit_account_id IS NOT NULL
  )
)
DELETE FROM public.deposit_accounts
WHERE id IN (SELECT id FROM unreferenced_defaults);

COMMIT;
