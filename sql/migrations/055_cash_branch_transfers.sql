-- ══════════════════════════════════════════════════════════════════════════
-- Migration 055: Cash Branch Transfers — Setoran Tunai Antar Outlet
-- ══════════════════════════════════════════════════════════════════════════
--
-- Fitur baru:
--   Outlet asal dapat mengirim setoran tunai ke outlet lain.
--   Outlet tujuan harus approve sebelum saldo berubah.
--   Perubahan saldo hanya terjadi saat approved (atomic).
--   Setoran existing (cash_deposits) tidak diubah.
--
-- File baru: public.cash_branch_transfers
-- Perubahan: branch_cash_ledger movement_type constraint
--            get_deposit_eligible_sessions — hitung transfer aktif
-- RPC baru:  create_cash_branch_transfer
--            get_pending_incoming_cash_branch_transfers
--            confirm_cash_branch_transfer
--            reject_cash_branch_transfer
--            cancel_cash_branch_transfer
--            get_cash_branch_transfer_history
--            get_admin_cash_branch_transfers
-- ══════════════════════════════════════════════════════════════════════════

BEGIN;

-- ── 1. Tabel cash_branch_transfers ───────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.cash_branch_transfers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  transfer_code text UNIQUE NOT NULL,

  from_branch_id bigint NOT NULL REFERENCES public.branches(id),
  to_branch_id   bigint NOT NULL REFERENCES public.branches(id),
  session_id     bigint NOT NULL REFERENCES public.cashier_sessions(id),

  staff_id       bigint NOT NULL REFERENCES public.users(id),
  requested_by   bigint NOT NULL REFERENCES public.users(id),
  requested_at   timestamptz NOT NULL DEFAULT now(),

  amount             numeric(15,2) NOT NULL CHECK (amount > 0),
  cash_balance_at_request numeric(15,2),

  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','confirmed','rejected','cancelled')),

  notes         text,
  reject_reason text,
  cancel_reason text,

  proof_url         text,
  proof_file_name   text,
  proof_file_type   text,
  proof_file_size   bigint,
  proof_uploaded_at timestamptz,

  confirmed_by bigint REFERENCES public.users(id),
  confirmed_at timestamptz,
  rejected_by  bigint REFERENCES public.users(id),
  rejected_at  timestamptz,
  cancelled_by bigint REFERENCES public.users(id),
  cancelled_at timestamptz,

  source_balance_before numeric(15,2),
  source_balance_after  numeric(15,2),
  target_balance_before numeric(15,2),
  target_balance_after  numeric(15,2),
  source_branch_cash_ledger_id bigint REFERENCES public.branch_cash_ledger(id),
  target_branch_cash_ledger_id bigint REFERENCES public.branch_cash_ledger(id),

  client_request_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,

  CONSTRAINT cash_branch_transfers_different_branch
    CHECK (from_branch_id <> to_branch_id)
);

CREATE INDEX IF NOT EXISTS idx_cash_branch_transfers_from_created
  ON public.cash_branch_transfers(from_branch_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_cash_branch_transfers_to_status_created
  ON public.cash_branch_transfers(to_branch_id, status, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_cash_branch_transfers_session_status
  ON public.cash_branch_transfers(session_id, status);

CREATE UNIQUE INDEX IF NOT EXISTS idx_cash_branch_transfers_client_request
  ON public.cash_branch_transfers(client_request_id)
  WHERE client_request_id IS NOT NULL;

-- ── 2. Update branch_cash_ledger movement_type constraint ────────────────

ALTER TABLE public.branch_cash_ledger
  DROP CONSTRAINT IF EXISTS branch_cash_ledger_movement_type_check;

ALTER TABLE public.branch_cash_ledger
  ADD CONSTRAINT branch_cash_ledger_movement_type_check
  CHECK (movement_type IN (
    -- Legacy (migration 035)
    'default_seed',
    'session_open_confirm',
    'opening_variance',
    'session_close',
    'deposit_approved',
    'deposit_rejected',
    'admin_adjustment',
    'force_close',
    'system_repair',
    -- Realtime (migration 050)
    'sale_cash_in',
    'sale_cash_void',
    'manual_cash_in',
    'manual_cash_out',
    'manual_cash_in_void',
    'manual_cash_out_void',
    -- Transfer antar outlet (migration 055) ← baru
    'cash_branch_transfer_out',
    'cash_branch_transfer_in',
    'cash_branch_transfer_rejected',
    'cash_branch_transfer_cancelled'
  ));

-- ── 3. Helper: generate transfer_code ────────────────────────────────────

CREATE OR REPLACE FUNCTION public.generate_transfer_code(
  p_date date DEFAULT CURRENT_DATE
) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_date_str text;
  v_seq      int;
  v_code     text;
BEGIN
  v_date_str := TO_CHAR(p_date, 'YYYYMMDD');

  SELECT COUNT(*) + 1
    INTO v_seq
  FROM public.cash_branch_transfers
  WHERE transfer_code LIKE 'KAS-' || v_date_str || '-%';

  v_code := 'KAS-' || v_date_str || '-' || LPAD(v_seq::text, 3, '0');

  -- Deduplicate (edge case simultaneous inserts)
  WHILE EXISTS (SELECT 1 FROM public.cash_branch_transfers WHERE transfer_code = v_code) LOOP
    v_seq := v_seq + 1;
    v_code := 'KAS-' || v_date_str || '-' || LPAD(v_seq::text, 3, '0');
  END LOOP;

  RETURN v_code;
END;
$$;

-- ── 4. Update get_deposit_eligible_sessions ───────────────────────────────
-- Memperhitungkan cash_branch_transfers pending/confirmed agar depositable_cash
-- dan has_active_deposit tepat saat ada transfer aktif untuk session tersebut.

CREATE OR REPLACE FUNCTION public.get_deposit_eligible_sessions(
  p_branch_id bigint,
  p_staff_id  bigint,
  p_limit     integer DEFAULT 10
) RETURNS TABLE (
  session_id          bigint,
  branch_id           bigint,
  staff_id            bigint,
  session_status      text,
  opened_at           timestamptz,
  closed_at           timestamptz,
  closing_cash        numeric,
  expected_cash       numeric,
  current_cash_amount numeric,
  final_cash_amount   numeric,
  deposit_pending     numeric,
  deposit_confirmed   numeric,
  depositable_cash    numeric,
  has_active_deposit  boolean,
  last_deposit_status text,
  block_reason        text
)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_user record;
BEGIN
  SELECT id, role, branch_id
    INTO v_user
  FROM public.users
  WHERE id = p_staff_id
    AND COALESCE(is_active, true) = true;

  IF p_staff_id IS NOT NULL AND NOT FOUND THEN
    RAISE EXCEPTION 'User tidak ditemukan atau tidak aktif';
  END IF;

  IF p_staff_id IS NOT NULL
     AND v_user.role NOT IN ('admin', 'owner')
     AND v_user.branch_id IS DISTINCT FROM p_branch_id THEN
    RAISE EXCEPTION 'Tidak memiliki akses ke outlet ini';
  END IF;

  RETURN QUERY
  WITH closed_sessions AS (
    SELECT cs.id
    FROM public.cashier_sessions cs
    WHERE cs.branch_id = p_branch_id
      AND cs.status = 'closed'
  ),
  session_deposits AS (
    -- cash_deposits (setoran ke rekening/QRIS/cash)
    SELECT
      cd.session_id,
      COALESCE(SUM(cd.amount) FILTER (WHERE cd.status = 'pending'),   0)::numeric AS dep_pending,
      COALESCE(SUM(cd.amount) FILTER (WHERE cd.status = 'confirmed'), 0)::numeric AS dep_confirmed,
      MAX(cd.created_at) FILTER (WHERE cd.status IN ('pending','confirmed')) AS last_at,
      (
        SELECT cd2.status
        FROM public.cash_deposits cd2
        WHERE cd2.session_id = cd.session_id
        ORDER BY cd2.created_at DESC
        LIMIT 1
      )::text AS last_status
    FROM public.cash_deposits cd
    WHERE cd.session_id IN (SELECT id FROM closed_sessions)
      AND cd.status IN ('pending', 'confirmed')
    GROUP BY cd.session_id
  ),
  session_transfers AS (
    -- cash_branch_transfers (setoran antar outlet)
    SELECT
      cbt.session_id,
      COALESCE(SUM(cbt.amount) FILTER (WHERE cbt.status = 'pending'),   0)::numeric AS tr_pending,
      COALESCE(SUM(cbt.amount) FILTER (WHERE cbt.status = 'confirmed'), 0)::numeric AS tr_confirmed,
      MAX(cbt.created_at) FILTER (WHERE cbt.status IN ('pending','confirmed')) AS last_at,
      (
        SELECT cbt2.status
        FROM public.cash_branch_transfers cbt2
        WHERE cbt2.session_id = cbt.session_id
        ORDER BY cbt2.created_at DESC
        LIMIT 1
      )::text AS last_status
    FROM public.cash_branch_transfers cbt
    WHERE cbt.session_id IN (SELECT id FROM closed_sessions)
      AND cbt.status IN ('pending', 'confirmed')
    GROUP BY cbt.session_id
  ),
  combined AS (
    SELECT
      cs.id AS session_id,
      cs.branch_id,
      cs.staff_id,
      cs.status::text AS session_status,
      cs.opened_at,
      cs.closed_at,
      cs.closing_cash,
      cs.expected_cash,
      cs.current_cash_amount,
      COALESCE(
        cs.current_cash_amount,
        cs.closing_cash,
        cs.expected_cash,
        public.compute_cash_session_system_amount(cs.id),
        0
      )::numeric AS final_cash_amount,
      COALESCE(sd.dep_pending,  0)::numeric AS dep_pending,
      COALESCE(sd.dep_confirmed,0)::numeric AS dep_confirmed,
      COALESCE(st.tr_pending,   0)::numeric AS tr_pending,
      COALESCE(st.tr_confirmed, 0)::numeric AS tr_confirmed,
      -- last status: prefer transfer pending over deposit pending
      CASE
        WHEN COALESCE(st.tr_pending, 0) > 0   THEN 'pending_transfer'
        WHEN COALESCE(sd.dep_pending, 0) > 0  THEN 'pending'
        WHEN COALESCE(st.tr_confirmed, 0) > 0 THEN 'confirmed_transfer'
        WHEN COALESCE(sd.dep_confirmed,0) > 0 THEN 'confirmed'
        ELSE NULL
      END::text AS combined_last_status
    FROM public.cashier_sessions cs
    LEFT JOIN session_deposits sd ON sd.session_id = cs.id
    LEFT JOIN session_transfers st ON st.session_id = cs.id
    WHERE cs.branch_id = p_branch_id
      AND cs.status = 'closed'
      AND cs.closing_cash IS NOT NULL
    ORDER BY cs.closed_at DESC NULLS LAST, cs.id DESC
    LIMIT COALESCE(p_limit, 10)
  )
  SELECT
    c.session_id,
    c.branch_id,
    c.staff_id,
    c.session_status,
    c.opened_at,
    c.closed_at,
    c.closing_cash,
    c.expected_cash,
    c.current_cash_amount,
    c.final_cash_amount,
    (c.dep_pending + c.tr_pending)::numeric   AS deposit_pending,
    (c.dep_confirmed + c.tr_confirmed)::numeric AS deposit_confirmed,
    GREATEST(
      c.final_cash_amount - (c.dep_pending + c.dep_confirmed + c.tr_pending + c.tr_confirmed),
      0
    )::numeric AS depositable_cash,
    (c.dep_pending + c.dep_confirmed + c.tr_pending + c.tr_confirmed) > 0 AS has_active_deposit,
    c.combined_last_status AS last_deposit_status,
    CASE
      WHEN c.tr_pending   > 0 THEN 'Transfer antar outlet sedang menunggu approval'
      WHEN c.dep_pending  > 0 THEN 'Setoran sedang menunggu konfirmasi'
      WHEN c.tr_confirmed > 0 THEN 'Transfer antar outlet shift ini sudah selesai'
      WHEN c.dep_confirmed> 0 THEN 'Setoran shift ini sudah selesai'
      ELSE NULL
    END::text AS block_reason
  FROM combined c;
END;
$$;

GRANT EXECUTE ON FUNCTION public.get_deposit_eligible_sessions(bigint, bigint, integer)
  TO anon, authenticated;

-- ── 5. RPC: create_cash_branch_transfer ──────────────────────────────────

CREATE OR REPLACE FUNCTION public.create_cash_branch_transfer(
  p_from_branch_id    bigint,
  p_to_branch_id      bigint,
  p_session_id        bigint,
  p_staff_id          bigint,
  p_amount            numeric,
  p_notes             text    DEFAULT NULL,
  p_proof_url         text    DEFAULT NULL,
  p_proof_file_name   text    DEFAULT NULL,
  p_proof_file_type   text    DEFAULT NULL,
  p_proof_file_size   bigint  DEFAULT NULL,
  p_proof_uploaded_at timestamptz DEFAULT NULL,
  p_client_request_id text    DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_user        record;
  v_from_branch record;
  v_to_branch   record;
  v_session     record;
  v_final_cash  numeric;
  v_dep_active  numeric;
  v_tr_active   numeric;
  v_depositable numeric;
  v_transfer    record;
  v_code        text;
BEGIN
  -- ── Idempotency: client_request_id ────────────────────────────────────
  IF p_client_request_id IS NOT NULL THEN
    SELECT * INTO v_transfer
    FROM public.cash_branch_transfers
    WHERE client_request_id = p_client_request_id;
    IF FOUND THEN
      RETURN jsonb_build_object(
        'success',       true,
        'transfer_id',   v_transfer.id,
        'transfer_code', v_transfer.transfer_code,
        'status',        v_transfer.status,
        'idempotent',    true,
        'message',       'Setoran antar outlet dikirim dan menunggu approval outlet tujuan.'
      );
    END IF;
  END IF;

  -- ── Validasi user ───────────────────────────────────────────────────────
  SELECT id, role, branch_id
    INTO v_user
  FROM public.users
  WHERE id = p_staff_id
    AND COALESCE(is_active, true) = true;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Staff tidak ditemukan atau tidak aktif';
  END IF;

  -- Staff biasa hanya dari outlet miliknya
  IF v_user.role NOT IN ('admin', 'owner')
     AND v_user.branch_id IS DISTINCT FROM p_from_branch_id THEN
    RAISE EXCEPTION 'Hanya boleh membuat transfer dari outlet milik Anda';
  END IF;

  -- ── Validasi outlet ─────────────────────────────────────────────────────
  IF p_from_branch_id = p_to_branch_id THEN
    RAISE EXCEPTION 'Outlet asal dan tujuan tidak boleh sama';
  END IF;

  SELECT id, name, COALESCE(is_active, true) AS is_active
    INTO v_from_branch
  FROM public.branches
  WHERE id = p_from_branch_id;
  IF NOT FOUND OR NOT v_from_branch.is_active THEN
    RAISE EXCEPTION 'Outlet asal tidak ditemukan atau tidak aktif';
  END IF;

  SELECT id, name, COALESCE(is_active, true) AS is_active
    INTO v_to_branch
  FROM public.branches
  WHERE id = p_to_branch_id;
  IF NOT FOUND OR NOT v_to_branch.is_active THEN
    RAISE EXCEPTION 'Outlet tujuan tidak ditemukan atau tidak aktif';
  END IF;

  -- ── Validasi session (lock) ─────────────────────────────────────────────
  SELECT *
    INTO v_session
  FROM public.cashier_sessions
  WHERE id = p_session_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Shift tidak ditemukan';
  END IF;
  IF v_session.status <> 'closed' THEN
    RAISE EXCEPTION 'Tutup shift terlebih dahulu sebelum membuat setoran antar outlet';
  END IF;
  IF v_session.branch_id <> p_from_branch_id THEN
    RAISE EXCEPTION 'Shift tidak milik outlet asal';
  END IF;

  -- ── Validasi amount ─────────────────────────────────────────────────────
  IF p_amount <= 0 THEN
    RAISE EXCEPTION 'Jumlah setoran harus lebih dari 0';
  END IF;
  -- Transfer tunai antar outlet tidak wajib kelipatan Rp 50.000
  -- (berbeda dengan setoran ke rekening/QRIS yang tetap wajib kelipatan)

  -- ── Hitung kas eligible ─────────────────────────────────────────────────
  v_final_cash := COALESCE(
    v_session.current_cash_amount,
    v_session.closing_cash,
    v_session.expected_cash,
    0
  );

  SELECT COALESCE(SUM(amount), 0)
    INTO v_dep_active
  FROM public.cash_deposits
  WHERE session_id = p_session_id
    AND status IN ('pending', 'confirmed');

  SELECT COALESCE(SUM(amount), 0)
    INTO v_tr_active
  FROM public.cash_branch_transfers
  WHERE session_id = p_session_id
    AND status IN ('pending', 'confirmed');

  v_depositable := GREATEST(v_final_cash - v_dep_active - v_tr_active, 0);

  -- Blokir jika ada setoran/transfer aktif lain
  IF v_dep_active > 0 THEN
    RAISE EXCEPTION 'Shift ini sudah memiliki setoran aktif. Selesaikan terlebih dahulu.';
  END IF;
  IF v_tr_active > 0 THEN
    RAISE EXCEPTION 'Shift ini sudah memiliki transfer antar outlet aktif. Selesaikan terlebih dahulu.';
  END IF;

  IF p_amount > v_depositable THEN
    RAISE EXCEPTION 'Jumlah transfer (%) melebihi kas yang dapat disetor (%)',
      p_amount, v_depositable;
  END IF;

  -- ── Generate transfer code ──────────────────────────────────────────────
  v_code := public.generate_transfer_code(CURRENT_DATE);

  -- ── Insert transfer ─────────────────────────────────────────────────────
  INSERT INTO public.cash_branch_transfers (
    transfer_code,
    from_branch_id, to_branch_id, session_id,
    staff_id, requested_by, requested_at,
    amount, cash_balance_at_request,
    status,
    notes,
    proof_url, proof_file_name, proof_file_type, proof_file_size, proof_uploaded_at,
    client_request_id, metadata
  ) VALUES (
    v_code,
    p_from_branch_id, p_to_branch_id, p_session_id,
    p_staff_id, p_staff_id, now(),
    p_amount, v_final_cash,
    'pending',
    p_notes,
    p_proof_url, p_proof_file_name, p_proof_file_type, p_proof_file_size, p_proof_uploaded_at,
    p_client_request_id,
    jsonb_build_object(
      'from_branch_name', v_from_branch.name,
      'to_branch_name',   v_to_branch.name
    )
  )
  RETURNING * INTO v_transfer;

  RETURN jsonb_build_object(
    'success',       true,
    'transfer_id',   v_transfer.id,
    'transfer_code', v_transfer.transfer_code,
    'status',        v_transfer.status,
    'message',       'Setoran ke ' || v_to_branch.name || ' berhasil dikirim dan menunggu approval staff ' || v_to_branch.name || '.'
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.create_cash_branch_transfer(bigint,bigint,bigint,bigint,numeric,text,text,text,text,bigint,timestamptz,text)
  TO anon, authenticated;

-- ── 6. RPC: get_pending_incoming_cash_branch_transfers ───────────────────

CREATE OR REPLACE FUNCTION public.get_pending_incoming_cash_branch_transfers(
  p_branch_id bigint,
  p_user_id   bigint
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_user   record;
  v_result jsonb;
BEGIN
  SELECT id, role, branch_id
    INTO v_user
  FROM public.users
  WHERE id = p_user_id
    AND COALESCE(is_active, true) = true;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'User tidak ditemukan atau tidak aktif';
  END IF;

  -- Staff biasa hanya bisa melihat transfer masuk untuk outletnya
  IF v_user.role NOT IN ('admin', 'owner')
     AND v_user.branch_id IS DISTINCT FROM p_branch_id THEN
    RAISE EXCEPTION 'Tidak memiliki akses ke outlet ini';
  END IF;

  SELECT jsonb_agg(
    jsonb_build_object(
      'transfer_id',      cbt.id,
      'transfer_code',    cbt.transfer_code,
      'from_branch_id',   cbt.from_branch_id,
      'from_branch_name', fb.name,
      'to_branch_id',     cbt.to_branch_id,
      'to_branch_name',   tb.name,
      'session_id',       cbt.session_id,
      'staff_id',         cbt.staff_id,
      'staff_name',       su.name,
      'amount',           cbt.amount,
      'cash_balance_at_request', cbt.cash_balance_at_request,
      'notes',            cbt.notes,
      'proof_url',        cbt.proof_url,
      'proof_file_name',  cbt.proof_file_name,
      'proof_file_type',  cbt.proof_file_type,
      'proof_file_size',  cbt.proof_file_size,
      'requested_at',     cbt.requested_at,
      'status',           cbt.status
    )
    ORDER BY cbt.requested_at ASC
  )
    INTO v_result
  FROM public.cash_branch_transfers cbt
  JOIN public.branches fb ON fb.id = cbt.from_branch_id
  JOIN public.branches tb ON tb.id = cbt.to_branch_id
  LEFT JOIN public.users su ON su.id = cbt.staff_id
  WHERE cbt.to_branch_id = p_branch_id
    AND cbt.status = 'pending';

  RETURN COALESCE(v_result, '[]'::jsonb);
END;
$$;

GRANT EXECUTE ON FUNCTION public.get_pending_incoming_cash_branch_transfers(bigint, bigint)
  TO anon, authenticated;

-- ── 7. RPC: confirm_cash_branch_transfer ─────────────────────────────────

CREATE OR REPLACE FUNCTION public.confirm_cash_branch_transfer(
  p_transfer_id uuid,
  p_user_id     bigint
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_user       record;
  v_transfer   record;
  v_from_pos   record;
  v_to_pos     record;
  v_from_br    record;
  v_to_br      record;
  v_src_bal_before numeric;
  v_dst_bal_before numeric;
  v_src_bal_after  numeric;
  v_dst_bal_after  numeric;
  v_src_ledger_id bigint;
  v_dst_ledger_id bigint;
  v_lock_a bigint;
  v_lock_b bigint;
  v_is_override boolean := false;
BEGIN
  -- ── Lock transfer ───────────────────────────────────────────────────────
  SELECT *
    INTO v_transfer
  FROM public.cash_branch_transfers
  WHERE id = p_transfer_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Transfer kas tidak ditemukan';
  END IF;

  -- Idempotency: sudah confirmed
  IF v_transfer.status = 'confirmed' THEN
    RETURN jsonb_build_object(
      'success',         true,
      'already_confirmed', true,
      'transfer_id',     v_transfer.id,
      'transfer_code',   v_transfer.transfer_code,
      'status',          'confirmed',
      'message',         'Transfer sudah dikonfirmasi sebelumnya.'
    );
  END IF;

  IF v_transfer.status <> 'pending' THEN
    RAISE EXCEPTION 'Transfer tidak dapat dikonfirmasi karena status saat ini adalah: %', v_transfer.status;
  END IF;

  -- ── Validasi user ───────────────────────────────────────────────────────
  SELECT id, role, branch_id
    INTO v_user
  FROM public.users
  WHERE id = p_user_id
    AND COALESCE(is_active, true) = true;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'User tidak ditemukan atau tidak aktif';
  END IF;

  IF v_user.role NOT IN ('admin', 'owner') THEN
    -- Staff biasa harus di outlet tujuan
    IF v_user.branch_id IS DISTINCT FROM v_transfer.to_branch_id THEN
      RAISE EXCEPTION 'Hanya staff outlet tujuan yang dapat menyetujui transfer ini';
    END IF;
  ELSE
    v_is_override := true;
  END IF;

  -- ── Load branch info ────────────────────────────────────────────────────
  SELECT name INTO v_from_br FROM public.branches WHERE id = v_transfer.from_branch_id;
  SELECT name INTO v_to_br   FROM public.branches WHERE id = v_transfer.to_branch_id;

  -- ── Lock branch_cash_positions (deterministic order untuk menghindari deadlock) ──
  v_lock_a := LEAST(v_transfer.from_branch_id, v_transfer.to_branch_id);
  v_lock_b := GREATEST(v_transfer.from_branch_id, v_transfer.to_branch_id);

  -- Lock pertama (ID lebih kecil)
  SELECT *
    INTO v_from_pos
  FROM public.branch_cash_positions
  WHERE branch_id = v_lock_a
  FOR UPDATE;

  -- Lock kedua (ID lebih besar)
  IF v_lock_b <> v_lock_a THEN
    SELECT *
      INTO v_to_pos
    FROM public.branch_cash_positions
    WHERE branch_id = v_lock_b
    FOR UPDATE;
  END IF;

  -- Reassign ke from/to sesuai transfer
  IF v_transfer.from_branch_id = v_lock_a THEN
    -- v_from_pos sudah berisi from, v_to_pos berisi to
    NULL;
  ELSE
    -- Swap
    DECLARE v_tmp record;
    BEGIN
      v_tmp := v_from_pos;
      v_from_pos := v_to_pos;
      v_to_pos := v_tmp;
    END;
  END IF;

  -- Seed source position jika belum ada
  IF v_from_pos.id IS NULL THEN
    INSERT INTO public.branch_cash_positions (branch_id, balance, version, updated_at, updated_by)
    VALUES (v_transfer.from_branch_id, 0, 1, now(), p_user_id)
    ON CONFLICT (branch_id) DO UPDATE
      SET updated_at = now()
    RETURNING * INTO v_from_pos;
  END IF;

  -- Seed target position jika belum ada
  IF v_to_pos.id IS NULL THEN
    INSERT INTO public.branch_cash_positions (branch_id, balance, version, updated_at, updated_by)
    VALUES (v_transfer.to_branch_id, 0, 1, now(), p_user_id)
    ON CONFLICT (branch_id) DO NOTHING;

    SELECT * INTO v_to_pos
    FROM public.branch_cash_positions
    WHERE branch_id = v_transfer.to_branch_id
    FOR UPDATE;
  END IF;

  -- ── Validasi saldo source ────────────────────────────────────────────────
  v_src_bal_before := COALESCE(v_from_pos.balance, 0);
  v_dst_bal_before := COALESCE(v_to_pos.balance, 0);

  IF v_src_bal_before < v_transfer.amount THEN
    RAISE EXCEPTION 'Saldo kas outlet asal tidak cukup untuk transfer ini. Koreksi kas outlet asal terlebih dahulu. (Saldo: %, Dibutuhkan: %)',
      v_src_bal_before, v_transfer.amount;
  END IF;

  v_src_bal_after := v_src_bal_before - v_transfer.amount;
  v_dst_bal_after := v_dst_bal_before + v_transfer.amount;

  -- ── Update source balance ────────────────────────────────────────────────
  UPDATE public.branch_cash_positions
    SET balance    = v_src_bal_after,
        version    = version + 1,
        updated_at = now(),
        updated_by = p_user_id
  WHERE branch_id = v_transfer.from_branch_id;

  -- ── Update target balance ────────────────────────────────────────────────
  UPDATE public.branch_cash_positions
    SET balance    = v_dst_bal_after,
        version    = version + 1,
        updated_at = now(),
        updated_by = p_user_id
  WHERE branch_id = v_transfer.to_branch_id;

  -- ── Insert ledger source (out) ───────────────────────────────────────────
  INSERT INTO public.branch_cash_ledger (
    branch_id, admin_id, movement_type, direction, amount,
    balance_before, balance_after,
    reason, source_table, source_id, metadata
  ) VALUES (
    v_transfer.from_branch_id, p_user_id,
    'cash_branch_transfer_out', 'out', v_transfer.amount,
    v_src_bal_before, v_src_bal_after,
    'Transfer kas ke ' || v_to_br.name || ' [' || v_transfer.transfer_code || ']',
    'cash_branch_transfers', v_transfer.id::text,
    jsonb_build_object(
      'transfer_id',     v_transfer.id,
      'transfer_code',   v_transfer.transfer_code,
      'from_branch_id',  v_transfer.from_branch_id,
      'to_branch_id',    v_transfer.to_branch_id,
      'from_branch_name',v_from_br.name,
      'to_branch_name',  v_to_br.name,
      'requested_by',    v_transfer.requested_by,
      'confirmed_by',    p_user_id,
      'override',        v_is_override
    )
  )
  ON CONFLICT DO NOTHING
  RETURNING id INTO v_src_ledger_id;

  -- ── Insert ledger target (in) ────────────────────────────────────────────
  INSERT INTO public.branch_cash_ledger (
    branch_id, admin_id, movement_type, direction, amount,
    balance_before, balance_after,
    reason, source_table, source_id, metadata
  ) VALUES (
    v_transfer.to_branch_id, p_user_id,
    'cash_branch_transfer_in', 'in', v_transfer.amount,
    v_dst_bal_before, v_dst_bal_after,
    'Terima transfer kas dari ' || v_from_br.name || ' [' || v_transfer.transfer_code || ']',
    'cash_branch_transfers', v_transfer.id::text,
    jsonb_build_object(
      'transfer_id',     v_transfer.id,
      'transfer_code',   v_transfer.transfer_code,
      'from_branch_id',  v_transfer.from_branch_id,
      'to_branch_id',    v_transfer.to_branch_id,
      'from_branch_name',v_from_br.name,
      'to_branch_name',  v_to_br.name,
      'requested_by',    v_transfer.requested_by,
      'confirmed_by',    p_user_id,
      'override',        v_is_override
    )
  )
  ON CONFLICT DO NOTHING
  RETURNING id INTO v_dst_ledger_id;

  -- ── Insert cash_logs (best-effort, tidak gagalkan transaksi) ─────────────
  BEGIN
    INSERT INTO public.cash_logs (
      branch_id, type, amount, note, created_by, reference_type, reference_id, is_void
    ) VALUES (
      v_transfer.from_branch_id,
      'out',
      v_transfer.amount,
      'Setoran antar outlet ke ' || v_to_br.name || ' [' || v_transfer.transfer_code || ']',
      p_user_id,
      'cash_branch_transfer',
      v_transfer.id,
      false
    )
    ON CONFLICT DO NOTHING;

    INSERT INTO public.cash_logs (
      branch_id, type, amount, note, created_by, reference_type, reference_id, is_void
    ) VALUES (
      v_transfer.to_branch_id,
      'in',
      v_transfer.amount,
      'Setoran antar outlet dari ' || v_from_br.name || ' [' || v_transfer.transfer_code || ']',
      p_user_id,
      'cash_branch_transfer',
      v_transfer.id,
      false
    )
    ON CONFLICT DO NOTHING;
  EXCEPTION WHEN OTHERS THEN
    -- cash_logs adalah laporan, tidak gagalkan transaksi utama
    NULL;
  END;

  -- ── Update transfer menjadi confirmed ────────────────────────────────────
  UPDATE public.cash_branch_transfers
    SET status       = 'confirmed',
        confirmed_by = p_user_id,
        confirmed_at = now(),
        source_balance_before = v_src_bal_before,
        source_balance_after  = v_src_bal_after,
        target_balance_before = v_dst_bal_before,
        target_balance_after  = v_dst_bal_after,
        source_branch_cash_ledger_id = v_src_ledger_id,
        target_branch_cash_ledger_id = v_dst_ledger_id,
        updated_at   = now(),
        metadata     = metadata || jsonb_build_object(
          'override', v_is_override,
          'confirmed_by_role', v_user.role
        )
  WHERE id = p_transfer_id;

  RETURN jsonb_build_object(
    'success',              true,
    'transfer_id',          p_transfer_id,
    'transfer_code',        v_transfer.transfer_code,
    'status',               'confirmed',
    'source_balance_before',v_src_bal_before,
    'source_balance_after', v_src_bal_after,
    'target_balance_before',v_dst_bal_before,
    'target_balance_after', v_dst_bal_after,
    'from_branch_name',     v_from_br.name,
    'to_branch_name',       v_to_br.name,
    'amount',               v_transfer.amount,
    'message',              'Setoran diterima. Kas ' || v_to_br.name || ' bertambah ' || v_transfer.amount::text ||
                            ' dan kas ' || v_from_br.name || ' berkurang ' || v_transfer.amount::text || '.'
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.confirm_cash_branch_transfer(uuid, bigint)
  TO anon, authenticated;

-- ── 8. RPC: reject_cash_branch_transfer ──────────────────────────────────

CREATE OR REPLACE FUNCTION public.reject_cash_branch_transfer(
  p_transfer_id uuid,
  p_user_id     bigint,
  p_reason      text
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_user     record;
  v_transfer record;
  v_is_override boolean := false;
BEGIN
  IF p_reason IS NULL OR LENGTH(TRIM(p_reason)) < 3 THEN
    RAISE EXCEPTION 'Alasan penolakan wajib diisi (minimal 3 karakter)';
  END IF;

  SELECT *
    INTO v_transfer
  FROM public.cash_branch_transfers
  WHERE id = p_transfer_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Transfer tidak ditemukan';
  END IF;

  IF v_transfer.status <> 'pending' THEN
    RAISE EXCEPTION 'Transfer tidak dapat ditolak karena status saat ini adalah: %', v_transfer.status;
  END IF;

  SELECT id, role, branch_id
    INTO v_user
  FROM public.users
  WHERE id = p_user_id
    AND COALESCE(is_active, true) = true;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'User tidak ditemukan atau tidak aktif';
  END IF;

  IF v_user.role NOT IN ('admin', 'owner') THEN
    IF v_user.branch_id IS DISTINCT FROM v_transfer.to_branch_id THEN
      RAISE EXCEPTION 'Hanya staff outlet tujuan yang dapat menolak transfer ini';
    END IF;
  ELSE
    v_is_override := true;
  END IF;

  -- Ledger rejection (best-effort idempotent)
  INSERT INTO public.branch_cash_ledger (
    branch_id, admin_id, movement_type, direction, amount,
    balance_before, balance_after,
    reason, source_table, source_id, metadata
  )
  SELECT
    v_transfer.from_branch_id, p_user_id,
    'cash_branch_transfer_rejected', 'none', v_transfer.amount,
    COALESCE(bcp.balance, 0), COALESCE(bcp.balance, 0),
    'Transfer antar outlet ditolak [' || v_transfer.transfer_code || ']: ' || TRIM(p_reason),
    'cash_branch_transfers', v_transfer.id::text,
    jsonb_build_object(
      'transfer_id',   v_transfer.id,
      'transfer_code', v_transfer.transfer_code,
      'rejected_by',   p_user_id,
      'reason',        TRIM(p_reason),
      'override',      v_is_override
    )
  FROM public.branch_cash_positions bcp
  WHERE bcp.branch_id = v_transfer.from_branch_id
  ON CONFLICT DO NOTHING;

  UPDATE public.cash_branch_transfers
    SET status       = 'rejected',
        rejected_by  = p_user_id,
        rejected_at  = now(),
        reject_reason= TRIM(p_reason),
        updated_at   = now(),
        metadata     = metadata || jsonb_build_object('override', v_is_override)
  WHERE id = p_transfer_id;

  RETURN jsonb_build_object(
    'success',     true,
    'transfer_id', p_transfer_id,
    'status',      'rejected',
    'message',     'Transfer ditolak. Saldo kedua outlet tidak berubah.'
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.reject_cash_branch_transfer(uuid, bigint, text)
  TO anon, authenticated;

-- ── 9. RPC: cancel_cash_branch_transfer ──────────────────────────────────

CREATE OR REPLACE FUNCTION public.cancel_cash_branch_transfer(
  p_transfer_id uuid,
  p_user_id     bigint,
  p_reason      text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_user     record;
  v_transfer record;
  v_is_override boolean := false;
BEGIN
  SELECT *
    INTO v_transfer
  FROM public.cash_branch_transfers
  WHERE id = p_transfer_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Transfer tidak ditemukan';
  END IF;

  IF v_transfer.status <> 'pending' THEN
    RAISE EXCEPTION 'Transfer tidak dapat dibatalkan karena status saat ini adalah: %', v_transfer.status;
  END IF;

  SELECT id, role, branch_id
    INTO v_user
  FROM public.users
  WHERE id = p_user_id
    AND COALESCE(is_active, true) = true;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'User tidak ditemukan atau tidak aktif';
  END IF;

  IF v_user.role NOT IN ('admin', 'owner') THEN
    IF v_user.branch_id IS DISTINCT FROM v_transfer.from_branch_id THEN
      RAISE EXCEPTION 'Hanya staff outlet asal yang dapat membatalkan transfer ini';
    END IF;
  ELSE
    v_is_override := true;
    IF p_reason IS NULL OR LENGTH(TRIM(p_reason)) < 3 THEN
      RAISE EXCEPTION 'Admin wajib mengisi alasan pembatalan (minimal 3 karakter)';
    END IF;
  END IF;

  -- Ledger cancellation (best-effort idempotent)
  INSERT INTO public.branch_cash_ledger (
    branch_id, admin_id, movement_type, direction, amount,
    balance_before, balance_after,
    reason, source_table, source_id, metadata
  )
  SELECT
    v_transfer.from_branch_id, p_user_id,
    'cash_branch_transfer_cancelled', 'none', v_transfer.amount,
    COALESCE(bcp.balance, 0), COALESCE(bcp.balance, 0),
    'Transfer antar outlet dibatalkan [' || v_transfer.transfer_code || ']' ||
      CASE WHEN p_reason IS NOT NULL THEN ': ' || TRIM(p_reason) ELSE '' END,
    'cash_branch_transfers', v_transfer.id::text,
    jsonb_build_object(
      'transfer_id',   v_transfer.id,
      'transfer_code', v_transfer.transfer_code,
      'cancelled_by',  p_user_id,
      'reason',        p_reason,
      'override',      v_is_override
    )
  FROM public.branch_cash_positions bcp
  WHERE bcp.branch_id = v_transfer.from_branch_id
  ON CONFLICT DO NOTHING;

  UPDATE public.cash_branch_transfers
    SET status        = 'cancelled',
        cancelled_by  = p_user_id,
        cancelled_at  = now(),
        cancel_reason = TRIM(COALESCE(p_reason, '')),
        updated_at    = now(),
        metadata      = metadata || jsonb_build_object('override', v_is_override)
  WHERE id = p_transfer_id;

  RETURN jsonb_build_object(
    'success',     true,
    'transfer_id', p_transfer_id,
    'status',      'cancelled',
    'message',     'Transfer dibatalkan. Saldo outlet tidak berubah.'
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.cancel_cash_branch_transfer(uuid, bigint, text)
  TO anon, authenticated;

-- ── 10. RPC: get_cash_branch_transfer_history ─────────────────────────────

CREATE OR REPLACE FUNCTION public.get_cash_branch_transfer_history(
  p_branch_id bigint,
  p_user_id   bigint,
  p_status    text    DEFAULT NULL,
  p_limit     integer DEFAULT 50,
  p_offset    integer DEFAULT 0
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_user   record;
  v_result jsonb;
BEGIN
  SELECT id, role, branch_id
    INTO v_user
  FROM public.users
  WHERE id = p_user_id
    AND COALESCE(is_active, true) = true;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'User tidak ditemukan atau tidak aktif';
  END IF;

  IF v_user.role NOT IN ('admin', 'owner')
     AND v_user.branch_id IS DISTINCT FROM p_branch_id THEN
    RAISE EXCEPTION 'Tidak memiliki akses ke outlet ini';
  END IF;

  SELECT jsonb_agg(row ORDER BY row.requested_at DESC)
    INTO v_result
  FROM (
    SELECT
      jsonb_build_object(
        'transfer_id',      cbt.id,
        'transfer_code',    cbt.transfer_code,
        'from_branch_id',   cbt.from_branch_id,
        'from_branch_name', fb.name,
        'to_branch_id',     cbt.to_branch_id,
        'to_branch_name',   tb.name,
        'session_id',       cbt.session_id,
        'staff_name',       su.name,
        'amount',           cbt.amount,
        'status',           cbt.status,
        'notes',            cbt.notes,
        'reject_reason',    cbt.reject_reason,
        'cancel_reason',    cbt.cancel_reason,
        'proof_url',        cbt.proof_url,
        'proof_file_name',  cbt.proof_file_name,
        'requested_at',     cbt.requested_at,
        'confirmed_at',     cbt.confirmed_at,
        'confirmed_by_name',(SELECT u2.name FROM public.users u2 WHERE u2.id = cbt.confirmed_by),
        'rejected_at',      cbt.rejected_at,
        'direction',        CASE WHEN cbt.from_branch_id = p_branch_id THEN 'out' ELSE 'in' END
      ) AS row
    FROM public.cash_branch_transfers cbt
    JOIN public.branches fb ON fb.id = cbt.from_branch_id
    JOIN public.branches tb ON tb.id = cbt.to_branch_id
    LEFT JOIN public.users su ON su.id = cbt.staff_id
    WHERE (cbt.from_branch_id = p_branch_id OR cbt.to_branch_id = p_branch_id)
      AND (p_status IS NULL OR cbt.status = p_status)
    ORDER BY cbt.requested_at DESC
    LIMIT COALESCE(p_limit, 50)
    OFFSET COALESCE(p_offset, 0)
  ) sub;

  RETURN COALESCE(v_result, '[]'::jsonb);
END;
$$;

GRANT EXECUTE ON FUNCTION public.get_cash_branch_transfer_history(bigint, bigint, text, integer, integer)
  TO anon, authenticated;

-- ── 11. RPC: get_admin_cash_branch_transfers ──────────────────────────────

CREATE OR REPLACE FUNCTION public.get_admin_cash_branch_transfers(
  p_admin_id       bigint,
  p_from_branch_id bigint  DEFAULT NULL,
  p_to_branch_id   bigint  DEFAULT NULL,
  p_status         text    DEFAULT NULL,
  p_date_from      date    DEFAULT NULL,
  p_date_to        date    DEFAULT NULL,
  p_limit          integer DEFAULT 200,
  p_offset         integer DEFAULT 0
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_admin  record;
  v_result jsonb;
BEGIN
  SELECT id, role
    INTO v_admin
  FROM public.users
  WHERE id = p_admin_id
    AND COALESCE(is_active, true) = true;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Admin tidak ditemukan atau tidak aktif';
  END IF;
  IF v_admin.role NOT IN ('admin', 'owner') THEN
    RAISE EXCEPTION 'Hanya admin atau owner yang dapat melihat semua transfer';
  END IF;

  SELECT jsonb_build_object(
    'transfers', COALESCE(jsonb_agg(row ORDER BY row->>'requested_at' DESC), '[]'::jsonb),
    'summary', jsonb_build_object(
      'total_pending_count', COUNT(*) FILTER (WHERE (row->>'status')::text = 'pending'),
      'total_pending_amount', COALESCE(SUM((row->>'amount')::numeric) FILTER (WHERE (row->>'status')::text = 'pending'), 0),
      'total_confirmed_amount', COALESCE(SUM((row->>'amount')::numeric) FILTER (WHERE (row->>'status')::text = 'confirmed'), 0),
      'total_rejected_count', COUNT(*) FILTER (WHERE (row->>'status')::text = 'rejected'),
      'total_rejected_amount', COALESCE(SUM((row->>'amount')::numeric) FILTER (WHERE (row->>'status')::text = 'rejected'), 0)
    )
  )
    INTO v_result
  FROM (
    SELECT jsonb_build_object(
      'transfer_id',         cbt.id,
      'transfer_code',       cbt.transfer_code,
      'from_branch_id',      cbt.from_branch_id,
      'from_branch_name',    fb.name,
      'to_branch_id',        cbt.to_branch_id,
      'to_branch_name',      tb.name,
      'session_id',          cbt.session_id,
      'staff_id',            cbt.staff_id,
      'staff_name',          su.name,
      'amount',              cbt.amount,
      'status',              cbt.status,
      'notes',               cbt.notes,
      'reject_reason',       cbt.reject_reason,
      'cancel_reason',       cbt.cancel_reason,
      'proof_url',           cbt.proof_url,
      'proof_file_name',     cbt.proof_file_name,
      'requested_at',        cbt.requested_at,
      'confirmed_at',        cbt.confirmed_at,
      'confirmed_by_name',   cu.name,
      'rejected_at',         cbt.rejected_at,
      'rejected_by_name',    ru.name,
      'cancelled_at',        cbt.cancelled_at,
      'cancelled_by_name',   cxu.name,
      'source_balance_before', cbt.source_balance_before,
      'source_balance_after',  cbt.source_balance_after,
      'target_balance_before', cbt.target_balance_before,
      'target_balance_after',  cbt.target_balance_after
    ) AS row
    FROM public.cash_branch_transfers cbt
    JOIN public.branches fb ON fb.id = cbt.from_branch_id
    JOIN public.branches tb ON tb.id = cbt.to_branch_id
    LEFT JOIN public.users su  ON su.id  = cbt.staff_id
    LEFT JOIN public.users cu  ON cu.id  = cbt.confirmed_by
    LEFT JOIN public.users ru  ON ru.id  = cbt.rejected_by
    LEFT JOIN public.users cxu ON cxu.id = cbt.cancelled_by
    WHERE (p_from_branch_id IS NULL OR cbt.from_branch_id = p_from_branch_id)
      AND (p_to_branch_id   IS NULL OR cbt.to_branch_id   = p_to_branch_id)
      AND (p_status         IS NULL OR cbt.status         = p_status)
      AND (p_date_from      IS NULL OR cbt.requested_at >= (p_date_from::timestamp AT TIME ZONE 'Asia/Makassar'))
      AND (p_date_to        IS NULL OR cbt.requested_at <  ((p_date_to + 1)::timestamp AT TIME ZONE 'Asia/Makassar'))
    ORDER BY cbt.requested_at DESC
    LIMIT COALESCE(p_limit, 200)
    OFFSET COALESCE(p_offset, 0)
  ) sub;

  RETURN COALESCE(v_result, jsonb_build_object('transfers','[]'::jsonb,'summary','{}'::jsonb));
END;
$$;

GRANT EXECUTE ON FUNCTION public.get_admin_cash_branch_transfers(bigint,bigint,bigint,text,date,date,integer,integer)
  TO anon, authenticated;

-- ── 12. NOTIFY PostgREST ──────────────────────────────────────────────────

NOTIFY pgrst, 'reload schema';

COMMIT;
