-- 001_create_deposit_accounts_and_policies.sql
-- Create deposit_accounts table + permissive RLS (app-layer enforces roles)

BEGIN;

-- gen_random_uuid() helper
CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS public.deposit_accounts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  branch_id bigint REFERENCES public.branches(id) ON DELETE CASCADE,
  type text NOT NULL CHECK (type IN ('bank','qris','cash')),
  label text NOT NULL,
  bank_name text,
  account_number text,
  account_holder text,
  qris_image_url text,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_deposit_accounts_branch ON public.deposit_accounts(branch_id);

-- Row Level Security: permissive by intention (app enforces roles)
ALTER TABLE public.deposit_accounts ENABLE ROW LEVEL SECURITY;

-- Drop policies if exist to allow idempotent migration
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_policy WHERE polname = 'anon_read_active' AND polrelid = 'public.deposit_accounts'::regclass) THEN
    DROP POLICY anon_read_active ON public.deposit_accounts;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_policy WHERE polname = 'admin_all' AND polrelid = 'public.deposit_accounts'::regclass) THEN
    DROP POLICY admin_all ON public.deposit_accounts;
  END IF;
END$$;

CREATE POLICY anon_read_active ON public.deposit_accounts FOR SELECT USING (is_active = true);
CREATE POLICY admin_all ON public.deposit_accounts FOR ALL USING (true);

GRANT USAGE ON SCHEMA public TO anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.deposit_accounts TO anon, authenticated;

COMMIT;
