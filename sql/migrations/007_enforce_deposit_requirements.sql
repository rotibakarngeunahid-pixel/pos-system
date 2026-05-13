-- 007_enforce_deposit_requirements.sql
-- Enforce deposit amount/proof rules and repair missing deposit objects.

BEGIN;

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

ALTER TABLE public.deposit_accounts
  ADD COLUMN IF NOT EXISTS account_holder text,
  ADD COLUMN IF NOT EXISTS qris_image_url text;

CREATE INDEX IF NOT EXISTS idx_deposit_accounts_branch
  ON public.deposit_accounts(branch_id);

ALTER TABLE public.deposit_accounts ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policy
    WHERE polname = 'anon_read_active'
      AND polrelid = 'public.deposit_accounts'::regclass
  ) THEN
    CREATE POLICY anon_read_active
      ON public.deposit_accounts FOR SELECT
      USING (is_active = true);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policy
    WHERE polname = 'admin_all'
      AND polrelid = 'public.deposit_accounts'::regclass
  ) THEN
    CREATE POLICY admin_all
      ON public.deposit_accounts FOR ALL
      USING (true);
  END IF;
END$$;

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

CREATE INDEX IF NOT EXISTS idx_cash_deposits_branch
  ON public.cash_deposits(branch_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_cash_deposits_staff
  ON public.cash_deposits(staff_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_cash_deposits_status
  ON public.cash_deposits(status);

ALTER TABLE public.cash_deposits ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policy
    WHERE polname = 'staff_self_read'
      AND polrelid = 'public.cash_deposits'::regclass
  ) THEN
    CREATE POLICY staff_self_read
      ON public.cash_deposits FOR SELECT
      USING (true);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policy
    WHERE polname = 'staff_insert'
      AND polrelid = 'public.cash_deposits'::regclass
  ) THEN
    CREATE POLICY staff_insert
      ON public.cash_deposits FOR INSERT
      WITH CHECK (true);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policy
    WHERE polname = 'admin_all'
      AND polrelid = 'public.cash_deposits'::regclass
  ) THEN
    CREATE POLICY admin_all
      ON public.cash_deposits FOR ALL
      USING (true);
  END IF;
END$$;

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

DO $$
BEGIN
  IF to_regclass('public.cash_categories') IS NOT NULL THEN
    INSERT INTO public.cash_categories (name, type)
    SELECT 'Setoran Tunai', 'out'
    WHERE NOT EXISTS (
      SELECT 1
      FROM public.cash_categories
      WHERE name = 'Setoran Tunai'
        AND type = 'out'
    );
  END IF;
END$$;

DO $$
BEGIN
  IF to_regclass('storage.buckets') IS NOT NULL THEN
    IF NOT EXISTS (SELECT 1 FROM storage.buckets WHERE id = 'deposit-proofs') THEN
      INSERT INTO storage.buckets (id, name, "public", file_size_limit, allowed_mime_types)
      VALUES ('deposit-proofs', 'deposit-proofs', false, 5242880,
              ARRAY['image/jpeg','image/png','image/webp','application/pdf']);
    END IF;

    IF NOT EXISTS (SELECT 1 FROM storage.buckets WHERE id = 'deposit-qris') THEN
      INSERT INTO storage.buckets (id, name, "public", file_size_limit, allowed_mime_types)
      VALUES ('deposit-qris', 'deposit-qris', true, 5242880,
              ARRAY['image/png','image/jpeg','image/webp']);
    END IF;
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

CREATE OR REPLACE FUNCTION public.confirm_deposit(
  p_deposit_id uuid,
  p_admin_id uuid,
  p_action text,
  p_reject_reason text DEFAULT NULL
) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE v_dep public.cash_deposits%ROWTYPE;
        v_cat_id uuid;
BEGIN
  IF p_action NOT IN ('confirmed','rejected') THEN
    RAISE EXCEPTION 'p_action must be ''confirmed'' or ''rejected''';
  END IF;

  SELECT * INTO v_dep
  FROM public.cash_deposits
  WHERE id = p_deposit_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Deposit tidak ditemukan';
  END IF;

  IF v_dep.status <> 'pending' THEN
    RAISE EXCEPTION 'Deposit sudah diproses';
  END IF;

  UPDATE public.cash_deposits SET
    status = p_action,
    reviewed_by = p_admin_id,
    reviewed_at = now(),
    reject_reason = p_reject_reason
  WHERE id = p_deposit_id;

  IF p_action = 'confirmed' THEN
    SELECT id INTO v_cat_id
    FROM public.cash_categories
    WHERE name = 'Setoran Tunai'
      AND type = 'out'
    LIMIT 1;

    INSERT INTO public.cash_logs (
      branch_id, session_id, type, category_id, amount, note,
      created_by, reference_type, reference_id, is_void
    ) VALUES (
      v_dep.branch_id, v_dep.session_id, 'out', v_cat_id,
      v_dep.amount,
      'Setoran #' || v_dep.id::text,
      p_admin_id, 'deposit', v_dep.id, false
    );
  END IF;
END;
$$;

COMMIT;
