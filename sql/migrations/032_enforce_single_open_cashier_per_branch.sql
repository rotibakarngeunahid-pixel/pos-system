-- 032_enforce_single_open_cashier_per_branch.sql
-- Enforce one active cashier session per branch.
-- If this migration fails, close or repair duplicate rows where status = 'open'
-- from the admin Kas Aktif screen, then run it again.

CREATE UNIQUE INDEX IF NOT EXISTS idx_cashier_sessions_one_open_per_branch
  ON public.cashier_sessions(branch_id)
  WHERE status = 'open';

