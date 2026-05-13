-- 008_revise_staff_deposit_ui_requirements.sql
-- Support revised staff deposit UI requirements:
-- - seed minimum deposit methods
-- - allow optional proof only for cash handoff to manager

BEGIN;

INSERT INTO public.deposit_accounts (
  branch_id, type, label, bank_name, account_number, account_holder, is_active
)
SELECT NULL, 'bank', 'Transfer BCA', 'BCA', NULL, NULL, true
WHERE NOT EXISTS (
  SELECT 1 FROM public.deposit_accounts
  WHERE branch_id IS NULL
    AND lower(label) = lower('Transfer BCA')
);

INSERT INTO public.deposit_accounts (
  branch_id, type, label, bank_name, account_number, account_holder, is_active
)
SELECT NULL, 'bank', 'Transfer BNI', 'BNI', NULL, NULL, true
WHERE NOT EXISTS (
  SELECT 1 FROM public.deposit_accounts
  WHERE branch_id IS NULL
    AND lower(label) = lower('Transfer BNI')
);

INSERT INTO public.deposit_accounts (
  branch_id, type, label, bank_name, account_number, account_holder, is_active
)
SELECT NULL, 'bank', 'Transfer BRI', 'BRI', NULL, NULL, true
WHERE NOT EXISTS (
  SELECT 1 FROM public.deposit_accounts
  WHERE branch_id IS NULL
    AND lower(label) = lower('Transfer BRI')
);

INSERT INTO public.deposit_accounts (
  branch_id, type, label, bank_name, account_number, account_holder, is_active
)
SELECT NULL, 'cash', 'Tunai ke Manager', NULL, NULL, NULL, true
WHERE NOT EXISTS (
  SELECT 1 FROM public.deposit_accounts
  WHERE branch_id IS NULL
    AND lower(label) = lower('Tunai ke Manager')
);

ALTER TABLE public.cash_deposits
  ALTER COLUMN proof_url DROP NOT NULL;

DROP FUNCTION IF EXISTS public.create_deposit(bigint, bigint, uuid, uuid, numeric, numeric, text, text);
DROP FUNCTION IF EXISTS public.create_deposit(bigint, bigint, bigint, uuid, numeric, numeric, text, text);

CREATE OR REPLACE FUNCTION public.create_deposit(
  p_branch_id bigint,
  p_session_id bigint,
  p_staff_id bigint,
  p_deposit_account_id uuid,
  p_amount numeric,
  p_cash_balance_at_deposit numeric,
  p_proof_url text DEFAULT NULL,
  p_notes text DEFAULT NULL
) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_id uuid;
  v_account_type text;
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

  SELECT type INTO v_account_type
  FROM public.deposit_accounts
  WHERE id = p_deposit_account_id
    AND is_active = true;

  IF v_account_type IS NULL THEN
    RAISE EXCEPTION 'Metode setoran tidak valid';
  END IF;

  IF v_account_type <> 'cash'
     AND NULLIF(BTRIM(COALESCE(p_proof_url, '')), '') IS NULL THEN
    RAISE EXCEPTION 'Bukti setoran wajib dilampirkan';
  END IF;

  INSERT INTO public.cash_deposits (
    branch_id, session_id, staff_id, deposit_account_id,
    amount, cash_balance_at_deposit, proof_url, notes, status
  ) VALUES (
    p_branch_id, p_session_id, p_staff_id, p_deposit_account_id,
    p_amount, p_cash_balance_at_deposit, NULLIF(BTRIM(COALESCE(p_proof_url, '')), ''), p_notes, 'pending'
  ) RETURNING id INTO v_id;

  RETURN v_id;
END;
$$;

GRANT EXECUTE ON FUNCTION public.create_deposit(bigint, bigint, bigint, uuid, numeric, numeric, text, text)
  TO anon, authenticated;

COMMIT;
