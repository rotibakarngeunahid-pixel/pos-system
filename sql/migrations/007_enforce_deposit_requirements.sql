-- 007_enforce_deposit_requirements.sql
-- Enforce deposit amount/proof rules and refresh create_deposit validation.

BEGIN;

ALTER TABLE public.deposit_accounts
  ADD COLUMN IF NOT EXISTS account_holder text,
  ADD COLUMN IF NOT EXISTS qris_image_url text;

UPDATE public.cash_deposits
SET proof_url = ''
WHERE proof_url IS NULL;

ALTER TABLE public.cash_deposits
  ALTER COLUMN proof_url SET NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'chk_deposit_multiple_50k'
      AND conrelid = 'public.cash_deposits'::regclass
  ) THEN
    ALTER TABLE public.cash_deposits
      ADD CONSTRAINT chk_deposit_multiple_50k
      CHECK (amount % 50000 = 0);
  END IF;
END$$;

CREATE OR REPLACE FUNCTION public.create_deposit(
  p_branch_id bigint,
  p_session_id bigint,
  p_staff_id uuid,
  p_deposit_account_id uuid,
  p_amount numeric,
  p_cash_balance_at_deposit numeric,
  p_proof_url text DEFAULT NULL,
  p_notes text DEFAULT NULL
) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE v_id uuid;
BEGIN
  IF p_amount <= 0 THEN
    RAISE EXCEPTION 'Jumlah setoran harus lebih dari 0';
  END IF;

  IF p_amount % 50000 <> 0 THEN
    RAISE EXCEPTION 'Nominal harus kelipatan Rp 50.000';
  END IF;

  IF p_cash_balance_at_deposit IS NOT NULL
     AND p_amount > p_cash_balance_at_deposit THEN
    RAISE EXCEPTION 'Jumlah setoran melebihi saldo kas';
  END IF;

  IF NULLIF(BTRIM(p_proof_url), '') IS NULL THEN
    RAISE EXCEPTION 'Bukti setoran wajib dilampirkan';
  END IF;

  INSERT INTO public.cash_deposits (
    branch_id, session_id, staff_id, deposit_account_id,
    amount, cash_balance_at_deposit, proof_url, notes, status
  ) VALUES (
    p_branch_id, p_session_id, p_staff_id, p_deposit_account_id,
    p_amount, p_cash_balance_at_deposit, p_proof_url, p_notes, 'pending'
  ) RETURNING id INTO v_id;

  RETURN v_id;
END;
$$;

COMMIT;
