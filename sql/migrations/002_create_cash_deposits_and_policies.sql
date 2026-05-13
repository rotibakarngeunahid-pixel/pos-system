-- 002_create_cash_deposits_and_policies.sql
-- Create cash_deposits table + permissive RLS (application layer enforces ACL)

BEGIN;

CREATE TABLE IF NOT EXISTS public.cash_deposits (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  branch_id bigint NOT NULL REFERENCES public.branches(id),
  session_id bigint REFERENCES public.cashier_sessions(id),
  staff_id uuid NOT NULL REFERENCES public.users(id),
  deposit_account_id uuid NOT NULL REFERENCES public.deposit_accounts(id),
  amount numeric(15,2) NOT NULL CHECK (amount > 0),
  cash_balance_at_deposit numeric(15,2) NOT NULL,
  proof_url text,
  notes text,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','confirmed','rejected')),
  reviewed_by uuid REFERENCES public.users(id),
  reviewed_at timestamptz,
  reject_reason text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_cash_deposits_branch  ON public.cash_deposits(branch_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_cash_deposits_staff   ON public.cash_deposits(staff_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_cash_deposits_status  ON public.cash_deposits(status);

-- Row Level Security: permissive (app-layer enforcement)
ALTER TABLE public.cash_deposits ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_policy WHERE polname = 'staff_self_read' AND polrelid = 'public.cash_deposits'::regclass) THEN
    DROP POLICY staff_self_read ON public.cash_deposits;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_policy WHERE polname = 'staff_insert' AND polrelid = 'public.cash_deposits'::regclass) THEN
    DROP POLICY staff_insert ON public.cash_deposits;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_policy WHERE polname = 'admin_all' AND polrelid = 'public.cash_deposits'::regclass) THEN
    DROP POLICY admin_all ON public.cash_deposits;
  END IF;
END$$;

-- Allow application to enforce staff scoping; keep policies permissive so RPCs still work
CREATE POLICY staff_self_read ON public.cash_deposits FOR SELECT USING (true);
CREATE POLICY staff_insert ON public.cash_deposits FOR INSERT WITH CHECK (true);
CREATE POLICY admin_all ON public.cash_deposits FOR ALL USING (true);

COMMIT;
