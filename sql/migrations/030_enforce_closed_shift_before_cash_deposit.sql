-- 030_enforce_closed_shift_before_cash_deposit.sql
-- Enforce: setoran tunai hanya boleh dibuat setelah shift ditutup (status = 'closed').
-- Perubahan:
--   1. RPC helper get_deposit_eligible_sessions
--   2. Replace create_deposit dengan validasi closed shift
--   3. Replace confirm_deposit dengan validasi closed shift
--   4. Replace admin_create_manual_deposit dengan parameter p_session_id
--   5. Trigger defense-in-depth pada cash_deposits
--   6. Revoke direct DML dari anon, authenticated

BEGIN;

-- ─────────────────────────────────────────────────────────────────
-- 1. Helper: get_deposit_eligible_sessions
--    Kembalikan closed sessions yang eligible untuk setoran.
-- ─────────────────────────────────────────────────────────────────
DROP FUNCTION IF EXISTS public.get_deposit_eligible_sessions(bigint, bigint, integer);

CREATE OR REPLACE FUNCTION public.get_deposit_eligible_sessions(
  p_branch_id bigint,
  p_staff_id  bigint,
  p_limit     integer DEFAULT 10
)
RETURNS TABLE (
  session_id         bigint,
  branch_id          bigint,
  staff_id           bigint,
  session_status     text,
  opened_at          timestamptz,
  closed_at          timestamptz,
  closing_cash       numeric,
  expected_cash      numeric,
  current_cash_amount numeric,
  final_cash_amount  numeric,
  deposit_pending    numeric,
  deposit_confirmed  numeric,
  depositable_cash   numeric,
  has_active_deposit boolean,
  last_deposit_status text,
  block_reason       text
)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_system_cash numeric;
BEGIN
  RETURN QUERY
  WITH session_deps AS (
    SELECT
      cd.session_id,
      COALESCE(SUM(cd.amount) FILTER (WHERE cd.status = 'pending'),  0) AS dep_pending,
      COALESCE(SUM(cd.amount) FILTER (WHERE cd.status = 'confirmed'),0) AS dep_confirmed,
      (
        SELECT cd2.status
        FROM public.cash_deposits cd2
        WHERE cd2.session_id = cd.session_id
        ORDER BY cd2.created_at DESC
        LIMIT 1
      ) AS last_status
    FROM public.cash_deposits cd
    WHERE cd.session_id IN (
      SELECT cs2.id FROM public.cashier_sessions cs2
      WHERE cs2.branch_id = p_branch_id
        AND cs2.staff_id  = p_staff_id
        AND cs2.status    = 'closed'
    )
    GROUP BY cd.session_id
  ),
  sessions AS (
    SELECT
      cs.id              AS session_id,
      cs.branch_id,
      cs.staff_id,
      cs.status          AS session_status,
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
      )                  AS final_cash_amount,
      COALESCE(sd.dep_pending,   0) AS dep_pending,
      COALESCE(sd.dep_confirmed, 0) AS dep_confirmed,
      sd.last_status
    FROM public.cashier_sessions cs
    LEFT JOIN session_deps sd ON sd.session_id = cs.id
    WHERE cs.branch_id = p_branch_id
      AND cs.staff_id  = p_staff_id
      AND cs.status    = 'closed'
    ORDER BY cs.closed_at DESC
    LIMIT p_limit
  )
  SELECT
    s.session_id,
    s.branch_id,
    s.staff_id,
    s.session_status,
    s.opened_at,
    s.closed_at,
    s.closing_cash,
    s.expected_cash,
    s.current_cash_amount,
    s.final_cash_amount,
    s.dep_pending,
    s.dep_confirmed,
    GREATEST(s.final_cash_amount - (s.dep_pending + s.dep_confirmed), 0) AS depositable_cash,
    (s.dep_pending + s.dep_confirmed) > 0                                  AS has_active_deposit,
    s.last_status                                                           AS last_deposit_status,
    CASE
      WHEN (s.dep_pending + s.dep_confirmed) > 0 AND s.last_status = 'pending'
        THEN 'Setoran sedang menunggu konfirmasi'
      WHEN (s.dep_pending + s.dep_confirmed) > 0 AND s.last_status = 'confirmed'
        THEN 'Setoran shift ini sudah selesai'
      ELSE NULL
    END                                                                     AS block_reason
  FROM sessions s;
END;
$$;

GRANT EXECUTE ON FUNCTION public.get_deposit_eligible_sessions(bigint, bigint, integer)
  TO anon, authenticated;


-- ─────────────────────────────────────────────────────────────────
-- 2. Replace create_deposit: wajib closed shift
-- ─────────────────────────────────────────────────────────────────
DROP FUNCTION IF EXISTS public.create_deposit(bigint, bigint, bigint, uuid, numeric, numeric, text, text);

CREATE OR REPLACE FUNCTION public.create_deposit(
  p_branch_id               bigint,
  p_session_id              bigint,
  p_staff_id                bigint,
  p_deposit_account_id      uuid,
  p_amount                  numeric,
  p_cash_balance_at_deposit numeric DEFAULT NULL,
  p_proof_url               text    DEFAULT NULL,
  p_notes                   text    DEFAULT NULL
) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_id               uuid;
  v_session          public.cashier_sessions%ROWTYPE;
  v_account_type     text;
  v_account_branch   bigint;
  v_account_label    text;
  v_final_cash       numeric;
  v_active_deposits  integer;
  v_depositable      numeric;
BEGIN
  -- BR-002: p_session_id wajib
  IF p_session_id IS NULL THEN
    RAISE EXCEPTION 'Setoran tunai hanya bisa dibuat setelah shift ditutup';
  END IF;

  -- BR-001: session harus closed (lock row untuk atomicity)
  SELECT * INTO v_session
  FROM public.cashier_sessions
  WHERE id = p_session_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Shift tidak ditemukan';
  END IF;

  IF v_session.status <> 'closed' THEN
    RAISE EXCEPTION 'Tutup shift terlebih dahulu sebelum setoran tunai';
  END IF;

  -- BR-004 & BR-005: branch/staff harus cocok
  IF v_session.branch_id <> p_branch_id OR v_session.staff_id <> p_staff_id THEN
    RAISE EXCEPTION 'Setoran tidak sesuai dengan shift staff/cabang';
  END IF;

  -- BR-011: nominal validasi
  IF p_amount IS NULL OR p_amount <= 0 THEN
    RAISE EXCEPTION 'Jumlah setoran harus lebih dari 0';
  END IF;

  IF p_amount % 50000 <> 0 THEN
    RAISE EXCEPTION 'Nominal harus kelipatan Rp 50.000';
  END IF;

  -- Hitung final cash & depositable
  v_final_cash := COALESCE(
    v_session.current_cash_amount,
    v_session.closing_cash,
    v_session.expected_cash,
    public.compute_cash_session_system_amount(p_session_id),
    0
  );

  SELECT COALESCE(SUM(cd.amount), 0) INTO v_active_deposits
  FROM public.cash_deposits cd
  WHERE cd.session_id = p_session_id
    AND cd.status IN ('pending', 'confirmed');

  v_depositable := GREATEST(v_final_cash - v_active_deposits, 0);

  -- BR-009: tolak double active deposit
  IF v_active_deposits > 0 THEN
    RAISE EXCEPTION 'Shift ini sudah memiliki setoran aktif. Tunggu konfirmasi atau buat ulang setelah penolakan.';
  END IF;

  -- BR-012: nominal tidak melebihi depositable cash
  IF p_amount > v_depositable THEN
    RAISE EXCEPTION 'Jumlah setoran melebihi kas yang dapat disetor (maks %)' , v_depositable;
  END IF;

  -- Validasi metode setoran
  SELECT type, branch_id, label
    INTO v_account_type, v_account_branch, v_account_label
  FROM public.deposit_accounts
  WHERE id = p_deposit_account_id
    AND is_active = true;

  IF v_account_type IS NULL THEN
    RAISE EXCEPTION 'Metode setoran tidak valid atau tidak aktif';
  END IF;

  IF v_account_branch IS NOT NULL AND v_account_branch <> p_branch_id THEN
    RAISE EXCEPTION 'Metode setoran tidak tersedia untuk cabang ini';
  END IF;

  -- BR-013: bukti wajib untuk non-cash
  IF v_account_type <> 'cash'
     AND NULLIF(BTRIM(COALESCE(p_proof_url, '')), '') IS NULL THEN
    RAISE EXCEPTION 'Bukti setoran wajib dilampirkan untuk metode ini';
  END IF;

  INSERT INTO public.cash_deposits (
    branch_id,
    session_id,
    staff_id,
    deposit_account_id,
    deposit_account_name_snapshot,
    amount,
    cash_balance_at_deposit,
    proof_url,
    notes,
    status
  ) VALUES (
    p_branch_id,
    p_session_id,
    p_staff_id,
    p_deposit_account_id,
    v_account_label,
    p_amount,
    v_depositable,
    NULLIF(BTRIM(COALESCE(p_proof_url, '')), ''),
    NULLIF(BTRIM(COALESCE(p_notes, '')), ''),
    'pending'
  ) RETURNING id INTO v_id;

  RETURN v_id;
END;
$$;

GRANT EXECUTE ON FUNCTION public.create_deposit(bigint, bigint, bigint, uuid, numeric, numeric, text, text)
  TO anon, authenticated;


-- ─────────────────────────────────────────────────────────────────
-- 3. Replace confirm_deposit: revalidasi closed shift
-- ─────────────────────────────────────────────────────────────────
DROP FUNCTION IF EXISTS public.confirm_deposit(uuid, bigint, text, text);

CREATE OR REPLACE FUNCTION public.confirm_deposit(
  p_deposit_id    uuid,
  p_admin_id      bigint,
  p_action        text,
  p_reject_reason text DEFAULT NULL
) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_dep     public.cash_deposits%ROWTYPE;
  v_session public.cashier_sessions%ROWTYPE;
  v_cat_id  uuid;
  v_role    text;
BEGIN
  -- Hanya admin/owner yang boleh konfirmasi
  SELECT role INTO v_role FROM public.users WHERE id = p_admin_id;
  IF v_role IS NULL OR v_role NOT IN ('admin', 'owner') THEN
    RAISE EXCEPTION 'Hanya admin yang dapat mengkonfirmasi atau menolak setoran';
  END IF;

  IF p_action NOT IN ('confirmed', 'rejected') THEN
    RAISE EXCEPTION 'p_action harus ''confirmed'' atau ''rejected''';
  END IF;

  -- Kunci baris deposit
  SELECT * INTO v_dep FROM public.cash_deposits WHERE id = p_deposit_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Setoran tidak ditemukan';
  END IF;
  IF v_dep.status <> 'pending' THEN
    RAISE EXCEPTION 'Setoran sudah diproses (status: %)', v_dep.status;
  END IF;

  -- FR-037 / BR-014: revalidasi closed shift
  IF v_dep.session_id IS NULL THEN
    RAISE EXCEPTION 'Setoran ini tidak memiliki shift yang valid dan tidak bisa dikonfirmasi';
  END IF;

  SELECT * INTO v_session
  FROM public.cashier_sessions
  WHERE id = v_dep.session_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Shift setoran tidak ditemukan';
  END IF;

  IF v_session.status <> 'closed' THEN
    RAISE EXCEPTION 'Shift setoran belum tertutup dan tidak bisa dikonfirmasi';
  END IF;

  -- Update status
  UPDATE public.cash_deposits SET
    status        = p_action,
    reviewed_by   = p_admin_id,
    reviewed_at   = now(),
    reject_reason = CASE
      WHEN p_action = 'rejected'
        THEN NULLIF(BTRIM(COALESCE(p_reject_reason, '')), '')
      ELSE NULL
    END
  WHERE id = p_deposit_id;

  IF p_action = 'confirmed' THEN
    SELECT id INTO v_cat_id
    FROM public.cash_categories
    WHERE name = 'Setoran Tunai' AND type = 'out'
    LIMIT 1;

    INSERT INTO public.cash_logs (
      branch_id, session_id, type, category_id, amount, note,
      created_by, reference_type, reference_id, is_void
    ) VALUES (
      v_dep.branch_id,
      v_dep.session_id,
      'out',
      v_cat_id,
      v_dep.amount,
      'Setoran #' || left(v_dep.id::text, 8),
      p_admin_id,
      'deposit',
      v_dep.id,
      false
    );
  END IF;
END;
$$;

GRANT EXECUTE ON FUNCTION public.confirm_deposit(uuid, bigint, text, text)
  TO anon, authenticated;


-- ─────────────────────────────────────────────────────────────────
-- 4. Replace admin_create_manual_deposit: wajib p_session_id
-- ─────────────────────────────────────────────────────────────────
DROP FUNCTION IF EXISTS public.admin_create_manual_deposit(bigint, bigint, bigint, uuid, numeric, text, text, text, text, text, bigint, timestamptz);

CREATE OR REPLACE FUNCTION public.admin_create_manual_deposit(
  p_admin_id           bigint,
  p_branch_id          bigint,
  p_staff_id           bigint,
  p_session_id         bigint,
  p_deposit_account_id uuid,
  p_amount             numeric,
  p_notes              text        DEFAULT NULL,
  p_status             text        DEFAULT 'confirmed',
  p_proof_url          text        DEFAULT NULL,
  p_proof_file_name    text        DEFAULT NULL,
  p_proof_file_type    text        DEFAULT NULL,
  p_proof_file_size    bigint      DEFAULT NULL,
  p_proof_uploaded_at  timestamptz DEFAULT NULL
) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_id               uuid;
  v_status           text;
  v_admin_role       text;
  v_branch_active    boolean;
  v_staff_role       text;
  v_staff_branch_id  bigint;
  v_staff_active     boolean;
  v_session          public.cashier_sessions%ROWTYPE;
  v_account_type     text;
  v_account_branch   bigint;
  v_account_label    text;
  v_is_cash_method   boolean;
  v_proof_url        text;
  v_active_deposits  integer;
  v_final_cash       numeric;
  v_depositable      numeric;
BEGIN
  -- Validasi admin
  SELECT role INTO v_admin_role
  FROM public.users
  WHERE id::text = p_admin_id::text;

  IF v_admin_role IS NULL OR v_admin_role NOT IN ('admin', 'owner') THEN
    RAISE EXCEPTION 'Hanya admin yang dapat input setoran manual';
  END IF;

  -- BR-002: p_session_id wajib
  IF p_session_id IS NULL THEN
    RAISE EXCEPTION 'Setoran tunai hanya bisa dibuat setelah shift ditutup';
  END IF;

  -- BR-001: session harus closed
  SELECT * INTO v_session
  FROM public.cashier_sessions
  WHERE id = p_session_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Shift tidak ditemukan';
  END IF;

  IF v_session.status <> 'closed' THEN
    RAISE EXCEPTION 'Tutup shift terlebih dahulu sebelum setoran tunai';
  END IF;

  -- BR-004 & BR-005: branch/staff harus cocok dengan session
  IF v_session.branch_id <> p_branch_id OR v_session.staff_id <> p_staff_id THEN
    RAISE EXCEPTION 'Setoran tidak sesuai dengan shift staff/cabang';
  END IF;

  -- Nominal
  IF p_amount IS NULL OR p_amount <= 0 THEN
    RAISE EXCEPTION 'Jumlah setoran harus lebih dari 0';
  END IF;

  IF p_amount % 50000 <> 0 THEN
    RAISE EXCEPTION 'Nominal harus kelipatan Rp 50.000';
  END IF;

  v_status := COALESCE(NULLIF(BTRIM(COALESCE(p_status, '')), ''), 'confirmed');
  IF v_status NOT IN ('pending', 'confirmed') THEN
    RAISE EXCEPTION 'Status setoran manual tidak valid';
  END IF;

  SELECT COALESCE(is_active, true) INTO v_branch_active
  FROM public.branches
  WHERE id = p_branch_id;

  IF v_branch_active IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'Cabang tidak valid atau tidak aktif';
  END IF;

  SELECT role, branch_id, COALESCE(is_active, true)
    INTO v_staff_role, v_staff_branch_id, v_staff_active
  FROM public.users
  WHERE id = p_staff_id;

  IF v_staff_role IS NULL OR v_staff_role <> 'staff' OR v_staff_active IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'Staff tidak valid atau tidak aktif';
  END IF;

  IF v_staff_branch_id IS DISTINCT FROM p_branch_id THEN
    RAISE EXCEPTION 'Staff tidak ditugaskan di cabang ini';
  END IF;

  -- Hitung depositable cash
  v_final_cash := COALESCE(
    v_session.current_cash_amount,
    v_session.closing_cash,
    v_session.expected_cash,
    public.compute_cash_session_system_amount(p_session_id),
    0
  );

  SELECT COALESCE(SUM(cd.amount), 0) INTO v_active_deposits
  FROM public.cash_deposits cd
  WHERE cd.session_id = p_session_id
    AND cd.status IN ('pending', 'confirmed');

  v_depositable := GREATEST(v_final_cash - v_active_deposits, 0);

  -- BR-009: tolak double active deposit
  IF v_active_deposits > 0 THEN
    RAISE EXCEPTION 'Shift ini sudah memiliki setoran aktif';
  END IF;

  -- BR-012: nominal tidak melebihi depositable
  IF p_amount > v_depositable THEN
    RAISE EXCEPTION 'Jumlah setoran melebihi kas yang dapat disetor (maks %)', v_depositable;
  END IF;

  -- Validasi metode setoran
  SELECT type, branch_id, label
    INTO v_account_type, v_account_branch, v_account_label
  FROM public.deposit_accounts
  WHERE id = p_deposit_account_id
    AND is_active = true;

  IF v_account_type IS NULL THEN
    RAISE EXCEPTION 'Metode setoran tidak valid atau tidak aktif';
  END IF;

  IF v_account_branch IS NOT NULL AND v_account_branch <> p_branch_id THEN
    RAISE EXCEPTION 'Metode setoran tidak tersedia untuk cabang ini';
  END IF;

  v_proof_url := NULLIF(BTRIM(COALESCE(p_proof_url, '')), '');
  v_is_cash_method := CASE
    WHEN NULLIF(BTRIM(COALESCE(v_account_type, '')), '') IS NOT NULL THEN
      LOWER(v_account_type) = 'cash'
    ELSE
      LOWER(COALESCE(v_account_label, '')) LIKE '%cash%'
      OR LOWER(COALESCE(v_account_label, '')) LIKE '%tunai%'
  END;

  IF v_is_cash_method IS DISTINCT FROM true AND v_proof_url IS NULL THEN
    RAISE EXCEPTION 'Upload bukti setoran terlebih dahulu.';
  END IF;

  INSERT INTO public.cash_deposits (
    branch_id,
    session_id,
    staff_id,
    deposit_account_id,
    deposit_account_name_snapshot,
    amount,
    cash_balance_at_deposit,
    proof_url,
    proof_file_name,
    proof_file_type,
    proof_file_size,
    proof_uploaded_at,
    notes,
    status
  ) VALUES (
    p_branch_id,
    p_session_id,
    p_staff_id,
    p_deposit_account_id,
    v_account_label,
    p_amount,
    v_depositable,
    v_proof_url,
    NULLIF(BTRIM(COALESCE(p_proof_file_name, '')), ''),
    NULLIF(BTRIM(COALESCE(p_proof_file_type, '')), ''),
    CASE WHEN COALESCE(p_proof_file_size, 0) > 0 THEN p_proof_file_size ELSE NULL END,
    CASE WHEN v_proof_url IS NOT NULL THEN COALESCE(p_proof_uploaded_at, now()) ELSE NULL END,
    NULLIF(BTRIM(COALESCE(p_notes, '')), ''),
    'pending'
  ) RETURNING id INTO v_id;

  IF v_status = 'confirmed' THEN
    PERFORM public.confirm_deposit(v_id, p_admin_id, 'confirmed', NULL);
  END IF;

  RETURN v_id;
END;
$$;

GRANT EXECUTE ON FUNCTION public.admin_create_manual_deposit(bigint, bigint, bigint, bigint, uuid, numeric, text, text, text, text, text, bigint, timestamptz)
  TO anon, authenticated;


-- ─────────────────────────────────────────────────────────────────
-- 5. Trigger defense-in-depth pada cash_deposits
-- ─────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.enforce_cash_deposit_closed_shift()
RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_session      public.cashier_sessions%ROWTYPE;
  v_active_count integer;
BEGIN
  -- Selalu validasi untuk INSERT.
  -- Untuk UPDATE: trigger hanya aktif pada kolom session_id, branch_id,
  -- staff_id, amount, status (lihat definisi trigger di bawah).

  -- BR-003: session_id wajib untuk row baru
  IF NEW.session_id IS NULL THEN
    RAISE EXCEPTION 'Setoran tunai hanya bisa dibuat setelah shift ditutup';
  END IF;

  -- Kunci session row untuk atomicity
  SELECT * INTO v_session
  FROM public.cashier_sessions
  WHERE id = NEW.session_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Shift tidak ditemukan';
  END IF;

  IF v_session.status <> 'closed' THEN
    RAISE EXCEPTION 'Tutup shift terlebih dahulu sebelum setoran tunai';
  END IF;

  -- Branch/staff harus cocok
  IF v_session.branch_id <> NEW.branch_id OR v_session.staff_id <> NEW.staff_id THEN
    RAISE EXCEPTION 'Setoran tidak sesuai dengan shift staff/cabang';
  END IF;

  -- Double submit check (kecualikan row sendiri saat UPDATE)
  IF NEW.status IN ('pending', 'confirmed') THEN
    SELECT COUNT(*) INTO v_active_count
    FROM public.cash_deposits
    WHERE session_id = NEW.session_id
      AND status IN ('pending', 'confirmed')
      AND id <> NEW.id;

    IF v_active_count > 0 THEN
      RAISE EXCEPTION 'Shift ini sudah memiliki setoran aktif';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_cash_deposits_require_closed_shift ON public.cash_deposits;

CREATE TRIGGER trg_cash_deposits_require_closed_shift
BEFORE INSERT OR UPDATE OF session_id, branch_id, staff_id, amount, status
ON public.cash_deposits
FOR EACH ROW
EXECUTE FUNCTION public.enforce_cash_deposit_closed_shift();


-- ─────────────────────────────────────────────────────────────────
-- 6. Revoke direct DML dari anon, authenticated
--    Mutasi hanya lewat RPC SECURITY DEFINER di atas.
-- ─────────────────────────────────────────────────────────────────
REVOKE INSERT, UPDATE, DELETE ON public.cash_deposits FROM anon, authenticated;
GRANT SELECT ON public.cash_deposits TO anon, authenticated;


NOTIFY pgrst, 'reload schema';

COMMIT;
