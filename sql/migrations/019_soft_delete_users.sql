-- 019_soft_delete_users.sql
-- Add soft-delete fields for users so historical rows in transactions,
-- cashier_sessions, cash_deposits, and audit logs can keep their FK references.

BEGIN;

ALTER TABLE public.users
  ADD COLUMN IF NOT EXISTS is_active boolean NOT NULL DEFAULT true;

ALTER TABLE public.users
  ADD COLUMN IF NOT EXISTS deleted_at timestamptz;

CREATE INDEX IF NOT EXISTS idx_users_active_role_name
  ON public.users(is_active, role, name);

COMMIT;
