-- Migration 036: Posisi Kas Outlet (Simple)
-- Pengganti migration 035 yang gagal dijalankan.
-- Fitur inti: admin input kas outlet → shift berikutnya otomatis mulai dari nilai itu.
--
-- Tabel baru : branch_cash_positions (satu row per outlet)
-- Fungsi baru: get_branch_cash_position, open_cash_session_from_branch_balance,
--              close_cash_session_apply_branch_balance, get_admin_branch_cash_positions,
--              admin_set_branch_cash_balance, get_branch_cash_ledger,
--              admin_force_close_branch_cash_session

BEGIN;

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. Tabel: branch_cash_positions — posisi kas aktif per outlet
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.branch_cash_positions (
  id          bigserial   PRIMARY KEY,
  branch_id   bigint      NOT NULL UNIQUE REFERENCES public.branches(id),
  balance     numeric(15,2) NOT NULL DEFAULT 0 CHECK (balance >= 0),
  version     bigint      NOT NULL DEFAULT 1,
  updated_at  timestamptz NOT NULL DEFAULT now(),
  updated_by  bigint      REFERENCES public.users(id)
);

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. FUNCTION: get_branch_cash_position
--    Dipakai POS saat staff membuka modal shift.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.get_branch_cash_position(
  p_branch_id bigint,
  p_user_id   bigint DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_branch      record;
  v_user        record;
  v_pos         record;
  v_open_sess   record;
  v_last_closed record;
  v_pending_dep numeric(15,2);
  v_source      text;
  v_cur_balance numeric(15,2);
BEGIN
  SELECT id, name INTO v_branch FROM branches WHERE id = p_branch_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Cabang tidak ditemukan';
  END IF;

  -- Cek akses: staff hanya bisa baca branch miliknya
  IF p_user_id IS NOT NULL THEN
    SELECT id, role, branch_id INTO v_user FROM users WHERE id = p_user_id;
    IF FOUND AND v_user.role NOT IN ('admin','owner')
       AND v_user.branch_id IS DISTINCT FROM p_branch_id THEN
      RAISE EXCEPTION 'Tidak memiliki akses ke outlet ini';
    END IF;
  END IF;

  SELECT * INTO v_pos FROM branch_cash_positions WHERE branch_id = p_branch_id;

  SELECT cs.id, cs.staff_id, cs.opened_at, cs.opening_cash,
         u.name AS staff_name
    INTO v_open_sess
    FROM cashier_sessions cs
    LEFT JOIN users u ON u.id = cs.staff_id
   WHERE cs.branch_id = p_branch_id AND cs.status = 'open'
   LIMIT 1;

  SELECT cs.id, cs.staff_id, cs.closed_at, cs.closing_cash, cs.opening_cash,
         u.name AS staff_name
    INTO v_last_closed
    FROM cashier_sessions cs
    LEFT JOIN users u ON u.id = cs.staff_id
   WHERE cs.branch_id = p_branch_id
     AND cs.status = 'closed'
     AND cs.closing_cash IS NOT NULL
   ORDER BY cs.closed_at DESC
   LIMIT 1;

  IF v_pos.id IS NOT NULL THEN
    v_cur_balance := v_pos.balance;
    v_source      := 'branch_balance';
  ELSIF v_last_closed.id IS NOT NULL THEN
    v_cur_balance := v_last_closed.closing_cash;
    v_source      := 'latest_closed_session';
  ELSE
    v_cur_balance := 0;
    v_source      := 'default_cash';
  END IF;

  SELECT COALESCE(SUM(amount), 0) INTO v_pending_dep
    FROM cash_deposits
   WHERE branch_id = p_branch_id AND status = 'pending';

  RETURN jsonb_build_object(
    'branch_id',              p_branch_id,
    'branch_name',            v_branch.name,
    'balance_id',             v_pos.id,
    'current_balance',        v_cur_balance,
    'source',                 v_source,
    'version',                COALESCE(v_pos.version, 0),
    'current_status',
      CASE WHEN v_open_sess.id IS NOT NULL THEN 'active' ELSE 'idle' END,
    'open_session', CASE
      WHEN v_open_sess.id IS NOT NULL THEN jsonb_build_object(
        'id',           v_open_sess.id,
        'staff_id',     v_open_sess.staff_id,
        'staff_name',   v_open_sess.staff_name,
        'opened_at',    v_open_sess.opened_at,
        'opening_cash', v_open_sess.opening_cash
      ) ELSE NULL END,
    'last_closed_session', CASE
      WHEN v_last_closed.id IS NOT NULL THEN jsonb_build_object(
        'id',           v_last_closed.id,
        'staff_id',     v_last_closed.staff_id,
        'staff_name',   v_last_closed.staff_name,
        'closed_at',    v_last_closed.closed_at,
        'opening_cash', v_last_closed.opening_cash,
        'closing_cash', v_last_closed.closing_cash
      ) ELSE NULL END,
    'pending_deposit_amount', v_pending_dep,
    'updated_at',             COALESCE(v_pos.updated_at, now())
  );
END;
$$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 3. FUNCTION: open_cash_session_from_branch_balance
--    Buka shift dengan opening_cash dari posisi kas outlet.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.open_cash_session_from_branch_balance(
  p_branch_id       bigint,
  p_staff_id        bigint,
  p_physical_cash   numeric DEFAULT NULL,
  p_variance_reason text    DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_user         record;
  v_active       record;
  v_opening_cash numeric(15,2);
  v_session      record;
BEGIN
  SELECT id, role, branch_id INTO v_user FROM users WHERE id = p_staff_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Staff tidak ditemukan'; END IF;
  IF v_user.role NOT IN ('admin','owner')
     AND v_user.branch_id IS DISTINCT FROM p_branch_id THEN
    RAISE EXCEPTION 'Staff tidak memiliki akses ke outlet ini';
  END IF;

  -- Guard: tidak boleh ada shift open di outlet yang sama
  SELECT cs.id, u.name AS staff_name, cs.opened_at INTO v_active
    FROM cashier_sessions cs
    LEFT JOIN users u ON u.id = cs.staff_id
   WHERE cs.branch_id = p_branch_id AND cs.status = 'open'
   LIMIT 1;
  IF FOUND THEN
    RAISE EXCEPTION 'Shift sebelumnya di outlet ini belum ditutup. Staff aktif: %. Silakan tutup kas terlebih dahulu atau hubungi admin.',
      v_active.staff_name;
  END IF;

  -- Baca posisi kas outlet
  SELECT balance INTO v_opening_cash
    FROM branch_cash_positions WHERE branch_id = p_branch_id;

  IF NOT FOUND THEN
    -- Fallback: ambil dari session terakhir
    SELECT closing_cash INTO v_opening_cash
      FROM cashier_sessions
     WHERE branch_id = p_branch_id
       AND status = 'closed'
       AND closing_cash IS NOT NULL
     ORDER BY closed_at DESC LIMIT 1;
    v_opening_cash := COALESCE(v_opening_cash, 0);
  END IF;

  -- Buka session
  INSERT INTO cashier_sessions (branch_id, staff_id, opening_cash, status, opened_at)
  VALUES (p_branch_id, p_staff_id, v_opening_cash, 'open', now())
  RETURNING * INTO v_session;

  RETURN jsonb_build_object(
    'id',                  v_session.id,
    'branch_id',           p_branch_id,
    'staff_id',            p_staff_id,
    'status',              'open',
    'opening_cash',        v_opening_cash,
    'opening_cash_source', 'branch_balance',
    'opened_at',           v_session.opened_at
  );
END;
$$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 4. FUNCTION: close_cash_session_apply_branch_balance
--    Tutup shift dan update posisi kas outlet = kas akhir aktual.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.close_cash_session_apply_branch_balance(
  p_session_id   bigint,
  p_closing_cash numeric,
  p_staff_id     bigint,
  p_closing_note text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_session  record;
  v_expected numeric(15,2);
  v_variance numeric(15,2);
BEGIN
  IF p_closing_cash < 0 THEN
    RAISE EXCEPTION 'Kas akhir tidak boleh negatif';
  END IF;

  SELECT * INTO v_session
    FROM cashier_sessions WHERE id = p_session_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Sesi tidak ditemukan'; END IF;

  -- Idempotent
  IF v_session.status = 'closed' THEN
    RETURN jsonb_build_object(
      'already_closed', true,
      'id',             v_session.id,
      'closing_cash',   v_session.closing_cash,
      'balance_after',  v_session.closing_cash
    );
  END IF;

  IF v_session.staff_id <> p_staff_id THEN
    RAISE EXCEPTION 'Sesi ini bukan milik staff yang bersangkutan';
  END IF;

  -- Hitung expected dari cash_logs
  SELECT COALESCE(v_session.opening_cash, 0)
       + COALESCE(SUM(CASE WHEN cl.type = 'in'  AND NOT COALESCE(cl.is_void, false)
                           THEN cl.amount ELSE 0 END), 0)
       - COALESCE(SUM(CASE WHEN cl.type = 'out' AND NOT COALESCE(cl.is_void, false)
                           THEN cl.amount ELSE 0 END), 0)
    INTO v_expected
    FROM cash_logs cl
   WHERE cl.session_id = p_session_id;

  v_variance := p_closing_cash - COALESCE(v_expected, 0);

  -- Tutup session
  UPDATE cashier_sessions SET
    status              = 'closed',
    closing_cash        = p_closing_cash,
    expected_cash       = v_expected,
    current_cash_amount = p_closing_cash,
    closed_at           = now()
  WHERE id = p_session_id;

  -- Update (atau insert) posisi kas outlet
  INSERT INTO branch_cash_positions (branch_id, balance, version, updated_at, updated_by)
  VALUES (v_session.branch_id, p_closing_cash, 1, now(), p_staff_id)
  ON CONFLICT (branch_id) DO UPDATE SET
    balance    = p_closing_cash,
    version    = branch_cash_positions.version + 1,
    updated_at = now(),
    updated_by = p_staff_id;

  RETURN jsonb_build_object(
    'id',             p_session_id,
    'status',         'closed',
    'closing_cash',   p_closing_cash,
    'expected_cash',  v_expected,
    'variance',       v_variance,
    'balance_after',  p_closing_cash,
    'already_closed', false
  );
END;
$$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 5. FUNCTION: get_admin_branch_cash_positions
--    Dashboard admin: daftar semua outlet + posisi kas.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.get_admin_branch_cash_positions(
  p_admin_id   bigint,
  p_branch_id  bigint  DEFAULT NULL,
  p_staff_id   bigint  DEFAULT NULL,
  p_status     text    DEFAULT 'all',
  p_date_from  date    DEFAULT NULL,
  p_date_to    date    DEFAULT NULL
)
RETURNS TABLE (
  branch_id              bigint,
  branch_name            text,
  current_balance        numeric,
  running_estimated_cash numeric,
  balance_id             bigint,
  version                bigint,
  last_opening_cash      numeric,
  last_closing_cash      numeric,
  last_opened_by_name    text,
  last_closed_by_name    text,
  last_updated           timestamptz,
  shift_status           text,
  open_session_id        bigint,
  open_staff_name        text,
  open_session_opened_at timestamptz,
  pending_deposit_amount numeric,
  last_variance_amount   numeric,
  has_variance           boolean,
  default_cash_position  numeric
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_admin record;
BEGIN
  SELECT id, role INTO v_admin FROM users WHERE id = p_admin_id;
  IF NOT FOUND OR v_admin.role NOT IN ('admin','owner') THEN
    RAISE EXCEPTION 'Hanya admin/owner yang dapat mengakses data ini';
  END IF;

  RETURN QUERY
  WITH open_sess AS (
    SELECT cs.id, cs.branch_id, cs.staff_id, cs.opened_at, cs.opening_cash,
           u.name AS staff_name
      FROM cashier_sessions cs
      LEFT JOIN users u ON u.id = cs.staff_id
     WHERE cs.status = 'open'
  ),
  last_closed AS (
    SELECT DISTINCT ON (cs.branch_id)
           cs.branch_id,
           cs.id       AS session_id,
           cs.opening_cash,
           cs.closing_cash,
           cs.closed_at,
           COALESCE(cs.closing_cash, 0) - COALESCE(cs.expected_cash, 0) AS variance,
           u.name AS staff_name
      FROM cashier_sessions cs
      LEFT JOIN users u ON u.id = cs.staff_id
     WHERE cs.status = 'closed' AND cs.closing_cash IS NOT NULL
     ORDER BY cs.branch_id, cs.closed_at DESC
  ),
  pending AS (
    SELECT cd.branch_id, SUM(cd.amount) AS total
      FROM cash_deposits cd
     WHERE cd.status = 'pending'
     GROUP BY cd.branch_id
  )
  SELECT
    b.id                                                 AS branch_id,
    b.name                                               AS branch_name,
    COALESCE(bcp.balance, lc.closing_cash, 0)            AS current_balance,
    NULL::numeric                                         AS running_estimated_cash,
    bcp.id                                                AS balance_id,
    COALESCE(bcp.version, 0)                              AS version,
    lc.opening_cash                                       AS last_opening_cash,
    lc.closing_cash                                       AS last_closing_cash,
    lc.staff_name                                         AS last_opened_by_name,
    lc.staff_name                                         AS last_closed_by_name,
    COALESCE(bcp.updated_at, lc.closed_at)               AS last_updated,
    CASE
      WHEN os.id IS NOT NULL       THEN 'open'
      WHEN lc.session_id IS NOT NULL THEN 'closed_today'
      ELSE 'none'
    END                                                   AS shift_status,
    os.id                                                 AS open_session_id,
    os.staff_name                                         AS open_staff_name,
    os.opened_at                                          AS open_session_opened_at,
    COALESCE(pd.total, 0)                                 AS pending_deposit_amount,
    lc.variance                                           AS last_variance_amount,
    (lc.variance IS NOT NULL AND lc.variance <> 0)        AS has_variance,
    0::numeric                                            AS default_cash_position
  FROM branches b
  LEFT JOIN branch_cash_positions bcp ON bcp.branch_id = b.id
  LEFT JOIN open_sess              os  ON os.branch_id  = b.id
  LEFT JOIN last_closed            lc  ON lc.branch_id  = b.id
  LEFT JOIN pending                pd  ON pd.branch_id  = b.id
  WHERE b.is_active = true
    AND (p_branch_id IS NULL OR b.id = p_branch_id)
  ORDER BY b.name;
END;
$$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 6. FUNCTION: admin_set_branch_cash_balance
--    Admin input / koreksi posisi kas outlet secara manual.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.admin_set_branch_cash_balance(
  p_admin_id    bigint,
  p_branch_id   bigint,
  p_new_balance numeric,
  p_reason      text,
  p_version     bigint DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_admin  record;
  v_pos    record;
  v_before numeric(15,2);
BEGIN
  SELECT id, role INTO v_admin FROM users WHERE id = p_admin_id;
  IF NOT FOUND OR v_admin.role NOT IN ('admin','owner') THEN
    RAISE EXCEPTION 'Hanya admin/owner yang dapat mengatur posisi kas';
  END IF;
  IF p_new_balance < 0 THEN
    RAISE EXCEPTION 'Posisi kas tidak boleh negatif';
  END IF;
  IF p_reason IS NULL OR length(trim(p_reason)) < 3 THEN
    RAISE EXCEPTION 'Keterangan wajib diisi minimal 3 karakter';
  END IF;

  SELECT * INTO v_pos
    FROM branch_cash_positions WHERE branch_id = p_branch_id FOR UPDATE;

  IF FOUND THEN
    IF p_version IS NOT NULL AND v_pos.version <> p_version THEN
      RAISE EXCEPTION 'Data berubah. Muat ulang halaman sebelum menyimpan.';
    END IF;
    v_before := v_pos.balance;
    UPDATE branch_cash_positions SET
      balance    = p_new_balance,
      version    = version + 1,
      updated_at = now(),
      updated_by = p_admin_id
    WHERE id = v_pos.id;
  ELSE
    v_before := 0;
    INSERT INTO branch_cash_positions (branch_id, balance, version, updated_at, updated_by)
    VALUES (p_branch_id, p_new_balance, 1, now(), p_admin_id);
  END IF;

  RETURN jsonb_build_object(
    'branch_id',      p_branch_id,
    'balance_before', v_before,
    'balance_after',  p_new_balance
  );
END;
$$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 7. FUNCTION: get_branch_cash_ledger
--    Riwayat kas outlet — ditampilkan dari riwayat cashier_sessions.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.get_branch_cash_ledger(
  p_admin_id      bigint,
  p_branch_id     bigint,
  p_date_from     timestamptz DEFAULT NULL,
  p_date_to       timestamptz DEFAULT NULL,
  p_movement_type text        DEFAULT NULL,
  p_limit         integer     DEFAULT 50
)
RETURNS TABLE (
  id               bigint,
  movement_type    text,
  direction        text,
  amount           numeric,
  balance_before   numeric,
  balance_after    numeric,
  expected_balance numeric,
  variance_amount  numeric,
  reason           text,
  staff_name       text,
  admin_name       text,
  cash_session_id  bigint,
  deposit_id       uuid,
  source_table     text,
  source_id        text,
  created_at       timestamptz,
  metadata         jsonb
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_admin record;
BEGIN
  SELECT id, role INTO v_admin FROM users WHERE id = p_admin_id;
  IF NOT FOUND OR v_admin.role NOT IN ('admin','owner') THEN
    RAISE EXCEPTION 'Hanya admin/owner yang dapat mengakses riwayat ini';
  END IF;

  RETURN QUERY
  SELECT
    cs.id                                                                      AS id,
    CASE cs.status
      WHEN 'closed' THEN 'session_close'
      ELSE 'session_open_confirm'
    END                                                                        AS movement_type,
    CASE cs.status
      WHEN 'closed' THEN 'adjust'::text
      ELSE 'none'::text
    END                                                                        AS direction,
    COALESCE(cs.closing_cash, cs.opening_cash, 0)                             AS amount,
    COALESCE(cs.opening_cash, 0)                                              AS balance_before,
    COALESCE(cs.closing_cash, cs.opening_cash, 0)                            AS balance_after,
    cs.expected_cash                                                           AS expected_balance,
    COALESCE(cs.closing_cash, 0) - COALESCE(cs.expected_cash, 0)             AS variance_amount,
    CASE cs.status WHEN 'closed' THEN 'Shift ditutup' ELSE 'Shift dibuka' END AS reason,
    u.name                                                                     AS staff_name,
    NULL::text                                                                 AS admin_name,
    cs.id                                                                      AS cash_session_id,
    NULL::uuid                                                                 AS deposit_id,
    'cashier_sessions'::text                                                   AS source_table,
    cs.id::text                                                                AS source_id,
    COALESCE(cs.closed_at, cs.opened_at)                                      AS created_at,
    '{}'::jsonb                                                                AS metadata
  FROM cashier_sessions cs
  LEFT JOIN users u ON u.id = cs.staff_id
  WHERE cs.branch_id = p_branch_id
    AND (p_date_from IS NULL OR COALESCE(cs.closed_at, cs.opened_at) >= p_date_from)
    AND (p_date_to   IS NULL OR COALESCE(cs.closed_at, cs.opened_at) <= p_date_to)
  ORDER BY COALESCE(cs.closed_at, cs.opened_at) DESC
  LIMIT p_limit;
END;
$$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 8. FUNCTION: admin_force_close_branch_cash_session
--    Admin paksa tutup shift yang lupa ditutup staff.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.admin_force_close_branch_cash_session(
  p_admin_id     bigint,
  p_session_id   bigint,
  p_closing_cash numeric,
  p_reason       text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_admin    record;
  v_staff_id bigint;
  v_result   jsonb;
BEGIN
  SELECT id, role INTO v_admin FROM users WHERE id = p_admin_id;
  IF NOT FOUND OR v_admin.role NOT IN ('admin','owner') THEN
    RAISE EXCEPTION 'Hanya admin/owner yang dapat melakukan forced close';
  END IF;
  IF p_reason IS NULL OR length(trim(p_reason)) < 3 THEN
    RAISE EXCEPTION 'Alasan forced close wajib diisi minimal 3 karakter';
  END IF;

  SELECT staff_id INTO v_staff_id FROM cashier_sessions WHERE id = p_session_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Sesi tidak ditemukan'; END IF;

  -- Reuse close logic (staff_id milik sesi yang ditutup)
  SELECT public.close_cash_session_apply_branch_balance(
    p_session_id, p_closing_cash, v_staff_id, p_reason
  ) INTO v_result;

  RETURN v_result || jsonb_build_object('forced_by_admin', p_admin_id);
END;
$$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 9. BACKFILL: seed branch_cash_positions dari session terakhir yang closed
-- ─────────────────────────────────────────────────────────────────────────────
DO $$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT DISTINCT ON (branch_id)
      branch_id, closing_cash
    FROM cashier_sessions
    WHERE status = 'closed' AND closing_cash IS NOT NULL
    ORDER BY branch_id, closed_at DESC
  LOOP
    INSERT INTO branch_cash_positions (branch_id, balance, version, updated_at)
    VALUES (r.branch_id, r.closing_cash, 1, now())
    ON CONFLICT (branch_id) DO NOTHING;
  END LOOP;
END;
$$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 10. PERMISSIONS
-- ─────────────────────────────────────────────────────────────────────────────
REVOKE INSERT, UPDATE, DELETE ON public.branch_cash_positions FROM anon, authenticated;
GRANT  SELECT                  ON public.branch_cash_positions TO   anon, authenticated;

GRANT EXECUTE ON FUNCTION public.get_branch_cash_position                 TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.open_cash_session_from_branch_balance    TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.close_cash_session_apply_branch_balance  TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_admin_branch_cash_positions          TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.admin_set_branch_cash_balance            TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_branch_cash_ledger                   TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.admin_force_close_branch_cash_session    TO anon, authenticated;

NOTIFY pgrst, 'reload schema';

COMMIT;
