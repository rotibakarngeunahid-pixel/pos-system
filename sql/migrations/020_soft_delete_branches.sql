-- 020_soft_delete_branches.sql
-- Add soft-delete fields for branches so branch history, transactions,
-- inventory logs, and copy-menu audit logs can keep their references.

BEGIN;

ALTER TABLE public.branches
  ADD COLUMN IF NOT EXISTS is_active boolean NOT NULL DEFAULT true;

ALTER TABLE public.branches
  ADD COLUMN IF NOT EXISTS deleted_at timestamptz;

CREATE INDEX IF NOT EXISTS idx_branches_active_name
  ON public.branches(is_active, name);

COMMIT;
