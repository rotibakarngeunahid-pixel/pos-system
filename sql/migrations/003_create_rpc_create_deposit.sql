-- 003_create_rpc_create_deposit.sql
-- RPC: create_deposit — insert a pending cash_deposits row and return id

BEGIN;

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
