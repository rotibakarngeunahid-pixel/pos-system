-- ══════════════════════════════════════════════════════════════════════════
-- Migration 050: Real-time Branch Cash Balance Sync + Standarisasi WITA
-- Jalankan di Supabase Dashboard → SQL Editor → Run
-- ══════════════════════════════════════════════════════════════════════════
--
-- Masalah yang diperbaiki:
--   1. branch_cash_positions.balance tidak berubah saat ada penjualan tunai.
--   2. Kas masuk/keluar manual staff tidak mempengaruhi saldo kas outlet.
--   3. Void transaksi/log kas tidak membalik saldo kas outlet.
--   4. Semua timezone distandarisasi ke WITA (Asia/Makassar, UTC+8).
--
-- Perubahan:
--   A. Trigger trg_sync_branch_cash_on_transaction
--      → update branch_cash_positions + ledger saat transaksi tunai complete/void
--   B. Trigger trg_sync_branch_cash_on_cash_log
--      → update branch_cash_positions + ledger saat log kas manual insert/void
--   C. Update semua RPC integrasi: Asia/Jakarta → Asia/Makassar (WITA)
--   D. Update get_admin_branch_cash_positions: show live balance saat shift aktif
--   E. Update get_branch_cash_ledger: label tipe gerakan baru
--   F. Backfill: sinkronkan saldo outlet untuk shift yang sedang terbuka
-- ══════════════════════════════════════════════════════════════════════════

BEGIN;

-- ── A. Trigger: sync saldo saat transaksi tunai ───────────────────────────

CREATE OR REPLACE FUNCTION public.trg_sync_branch_cash_on_transaction()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_pos    public.branch_cash_positions%ROWTYPE;
  v_before numeric(15,2);
  v_after  numeric(15,2);
BEGIN
  -- Hanya proses transaksi tunai yang punya branch_id dan session_id
  IF COALESCE(NEW.payment_method, '') <> 'cash'
     OR NEW.branch_id IS NULL
     OR NEW.session_id IS NULL THEN
    RETURN NEW;
  END IF;

  -- ── Kasus 1: Transaksi baru selesai (completed) ─────────────────────
  IF NEW.status = 'completed'
     AND (OLD IS NULL OR COALESCE(OLD.status, '') <> 'completed') THEN

    -- Idempotency: lewati jika sudah ada ledger entry untuk transaksi ini
    IF EXISTS (
      SELECT 1 FROM public.branch_cash_ledger
      WHERE source_table = 'transactions'
        AND source_id     = NEW.id::text
        AND movement_type = 'sale_cash_in'
    ) THEN
      RETURN NEW;
    END IF;

    -- Lock baris posisi kas outlet
    SELECT * INTO v_pos
    FROM public.branch_cash_positions
    WHERE branch_id = NEW.branch_id
    FOR UPDATE;

    -- Jika belum ada baris posisi, skip (admin harus inisialisasi dulu)
    IF v_pos.id IS NULL THEN
      RETURN NEW;
    END IF;

    v_before := COALESCE(v_pos.balance, 0);
    v_after  := v_before + COALESCE(NEW.total, 0);

    UPDATE public.branch_cash_positions
    SET balance    = v_after,
        version    = version + 1,
        updated_at = now(),
        updated_by = NEW.staff_id
    WHERE id = v_pos.id;

    INSERT INTO public.branch_cash_ledger (
      branch_id, staff_id, cash_session_id,
      movement_type, direction, amount,
      balance_before, balance_after,
      reason, source_table, source_id, metadata
    ) VALUES (
      NEW.branch_id, NEW.staff_id, NEW.session_id,
      'sale_cash_in', 'in', COALESCE(NEW.total, 0),
      v_before, v_after,
      'Penjualan Tunai #' || NEW.id::text,
      'transactions', NEW.id::text,
      jsonb_build_object(
        'transaction_id',  NEW.id,
        'payment_method',  'cash',
        'staff_id',        NEW.staff_id
      )
    )
    ON CONFLICT DO NOTHING;

  -- ── Kasus 2: Transaksi tunai di-void ────────────────────────────────
  ELSIF NEW.status = 'void'
        AND OLD IS NOT NULL
        AND COALESCE(OLD.status, '') = 'completed' THEN

    -- Hanya balikkan saldo jika sebelumnya sudah tercatat masuk
    IF NOT EXISTS (
      SELECT 1 FROM public.branch_cash_ledger
      WHERE source_table = 'transactions'
        AND source_id     = NEW.id::text
        AND movement_type = 'sale_cash_in'
    ) THEN
      RETURN NEW;
    END IF;

    -- Idempotency: jika sudah pernah di-reverse, skip
    IF EXISTS (
      SELECT 1 FROM public.branch_cash_ledger
      WHERE source_table = 'transactions'
        AND source_id     = NEW.id::text
        AND movement_type = 'sale_cash_void'
    ) THEN
      RETURN NEW;
    END IF;

    SELECT * INTO v_pos
    FROM public.branch_cash_positions
    WHERE branch_id = NEW.branch_id
    FOR UPDATE;

    IF v_pos.id IS NULL THEN
      RETURN NEW;
    END IF;

    v_before := COALESCE(v_pos.balance, 0);
    v_after  := GREATEST(v_before - COALESCE(NEW.total, 0), 0);

    UPDATE public.branch_cash_positions
    SET balance    = v_after,
        version    = version + 1,
        updated_at = now(),
        updated_by = NEW.staff_id
    WHERE id = v_pos.id;

    INSERT INTO public.branch_cash_ledger (
      branch_id, staff_id, cash_session_id,
      movement_type, direction, amount,
      balance_before, balance_after,
      reason, source_table, source_id, metadata
    ) VALUES (
      NEW.branch_id, NEW.staff_id, NEW.session_id,
      'sale_cash_void', 'out', COALESCE(NEW.total, 0),
      v_before, v_after,
      'Void Penjualan Tunai #' || NEW.id::text,
      'transactions', NEW.id::text,
      jsonb_build_object(
        'transaction_id', NEW.id,
        'voided',         true
      )
    )
    ON CONFLICT DO NOTHING;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_sync_branch_cash_on_transaction ON public.transactions;

CREATE TRIGGER trg_sync_branch_cash_on_transaction
AFTER INSERT OR UPDATE OF status
ON public.transactions
FOR EACH ROW
EXECUTE FUNCTION public.trg_sync_branch_cash_on_transaction();

GRANT EXECUTE ON FUNCTION public.trg_sync_branch_cash_on_transaction() TO authenticated;


-- ── B. Trigger: sync saldo saat log kas manual ────────────────────────────

CREATE OR REPLACE FUNCTION public.trg_sync_branch_cash_on_cash_log()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_pos    public.branch_cash_positions%ROWTYPE;
  v_before numeric(15,2);
  v_after  numeric(15,2);
  v_mv     text;
  v_dir    text;
BEGIN
  -- Hanya proses log kas manual dengan branch_id yang valid
  IF COALESCE(NEW.reference_type, '') <> 'manual'
     OR NEW.branch_id IS NULL THEN
    RETURN NEW;
  END IF;

  -- ── Kasus 1: INSERT log kas baru (masuk atau keluar) ─────────────────
  IF TG_OP = 'INSERT' AND NOT COALESCE(NEW.is_void, false) THEN

    -- Idempotency
    IF EXISTS (
      SELECT 1 FROM public.branch_cash_ledger
      WHERE source_table = 'cash_logs'
        AND source_id     = NEW.id::text
        AND movement_type IN ('manual_cash_in', 'manual_cash_out')
    ) THEN
      RETURN NEW;
    END IF;

    SELECT * INTO v_pos
    FROM public.branch_cash_positions
    WHERE branch_id = NEW.branch_id
    FOR UPDATE;

    IF v_pos.id IS NULL THEN
      RETURN NEW;
    END IF;

    v_before := COALESCE(v_pos.balance, 0);

    IF NEW.type = 'in' THEN
      v_mv    := 'manual_cash_in';
      v_dir   := 'in';
      v_after := v_before + COALESCE(NEW.amount, 0);
    ELSE
      v_mv    := 'manual_cash_out';
      v_dir   := 'out';
      v_after := GREATEST(v_before - COALESCE(NEW.amount, 0), 0);
    END IF;

    UPDATE public.branch_cash_positions
    SET balance    = v_after,
        version    = version + 1,
        updated_at = now(),
        updated_by = NEW.created_by
    WHERE id = v_pos.id;

    INSERT INTO public.branch_cash_ledger (
      branch_id, staff_id, cash_session_id,
      movement_type, direction, amount,
      balance_before, balance_after,
      reason, source_table, source_id, metadata
    ) VALUES (
      NEW.branch_id, NEW.created_by, NEW.session_id,
      v_mv, v_dir, COALESCE(NEW.amount, 0),
      v_before, v_after,
      COALESCE(
        NEW.note,
        'Kas ' || CASE WHEN NEW.type = 'in' THEN 'Masuk' ELSE 'Keluar' END || ' Manual'
      ),
      'cash_logs', NEW.id::text,
      jsonb_build_object(
        'cash_log_id',  NEW.id,
        'category_id',  NEW.category_id,
        'type',         NEW.type
      )
    )
    ON CONFLICT DO NOTHING;

  -- ── Kasus 2: UPDATE — log kas di-void ────────────────────────────────
  ELSIF TG_OP = 'UPDATE'
        AND NEW.is_void = true
        AND NOT COALESCE(OLD.is_void, false)
        AND COALESCE(OLD.reference_type, '') = 'manual' THEN

    -- Hanya balikkan jika sebelumnya sudah tercatat di ledger
    IF NOT EXISTS (
      SELECT 1 FROM public.branch_cash_ledger
      WHERE source_table = 'cash_logs'
        AND source_id     = NEW.id::text
        AND movement_type IN ('manual_cash_in', 'manual_cash_out')
    ) THEN
      RETURN NEW;
    END IF;

    -- Idempotency
    IF EXISTS (
      SELECT 1 FROM public.branch_cash_ledger
      WHERE source_table = 'cash_logs'
        AND source_id     = NEW.id::text
        AND movement_type IN ('manual_cash_in_void', 'manual_cash_out_void')
    ) THEN
      RETURN NEW;
    END IF;

    SELECT * INTO v_pos
    FROM public.branch_cash_positions
    WHERE branch_id = NEW.branch_id
    FOR UPDATE;

    IF v_pos.id IS NULL THEN
      RETURN NEW;
    END IF;

    v_before := COALESCE(v_pos.balance, 0);

    -- Balik efek aslinya
    IF NEW.type = 'in' THEN
      -- Aslinya masuk (menambah), reversal = kurangi
      v_mv    := 'manual_cash_in_void';
      v_dir   := 'out';
      v_after := GREATEST(v_before - COALESCE(NEW.amount, 0), 0);
    ELSE
      -- Aslinya keluar (mengurangi), reversal = tambahkan
      v_mv    := 'manual_cash_out_void';
      v_dir   := 'in';
      v_after := v_before + COALESCE(NEW.amount, 0);
    END IF;

    UPDATE public.branch_cash_positions
    SET balance    = v_after,
        version    = version + 1,
        updated_at = now(),
        updated_by = NEW.voided_by
    WHERE id = v_pos.id;

    INSERT INTO public.branch_cash_ledger (
      branch_id, staff_id, cash_session_id,
      movement_type, direction, amount,
      balance_before, balance_after,
      reason, source_table, source_id, metadata
    ) VALUES (
      NEW.branch_id, NEW.voided_by, NEW.session_id,
      v_mv, v_dir, COALESCE(NEW.amount, 0),
      v_before, v_after,
      COALESCE(
        NEW.void_reason,
        'Void Kas ' || CASE WHEN NEW.type = 'in' THEN 'Masuk' ELSE 'Keluar' END || ' Manual'
      ),
      'cash_logs', NEW.id::text,
      jsonb_build_object(
        'voided',        true,
        'original_type', NEW.type,
        'void_reason',   NEW.void_reason
      )
    )
    ON CONFLICT DO NOTHING;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_sync_branch_cash_on_cash_log ON public.cash_logs;

CREATE TRIGGER trg_sync_branch_cash_on_cash_log
AFTER INSERT OR UPDATE OF is_void
ON public.cash_logs
FOR EACH ROW
EXECUTE FUNCTION public.trg_sync_branch_cash_on_cash_log();

GRANT EXECUTE ON FUNCTION public.trg_sync_branch_cash_on_cash_log() TO authenticated;


-- ── C. Update RPC integrasi: Asia/Jakarta → Asia/Makassar (WITA, UTC+8) ──

-- C.1 get_kas_keluar_integration (dari migration 039)
CREATE OR REPLACE FUNCTION get_kas_keluar_integration(
  p_api_key    TEXT,
  p_date_from  DATE    DEFAULT NULL,
  p_date_to    DATE    DEFAULT NULL,
  p_branch_id  INTEGER DEFAULT NULL
)
RETURNS JSONB
SECURITY DEFINER
SET search_path = public
LANGUAGE plpgsql AS $$
DECLARE
  v_total  NUMERIC := 0;
  v_count  BIGINT  := 0;
  v_data   JSONB   := '[]'::jsonb;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM api_keys
    WHERE key_value = p_api_key AND is_active = TRUE
  ) THEN
    RETURN jsonb_build_object(
      'success', false,
      'error',   'API key tidak valid atau tidak aktif. Periksa kembali API key Anda di halaman Portal Integrasi Data.'
    );
  END IF;

  -- Hanya ambil: type = 'out', is_void = false
  -- Filter tanggal menggunakan timezone WITA (Asia/Makassar = UTC+8)
  SELECT
    COALESCE(SUM(cl.amount), 0),
    COUNT(*),
    COALESCE(
      jsonb_agg(
        jsonb_build_object(
          'id',               cl.id,
          'tanggal',          TO_CHAR((cl.created_at AT TIME ZONE 'Asia/Makassar'), 'YYYY-MM-DD'),
          'waktu',            TO_CHAR((cl.created_at AT TIME ZONE 'Asia/Makassar'), 'HH24:MI:SS'),
          'cabang',           COALESCE(b.name, '—'),
          'kategori',         COALESCE(cc.name, '—'),
          'nominal',          cl.amount,
          'keterangan',       COALESCE(cl.note, '—'),
          'dicatat_oleh',     COALESCE(u.name, '—')
        ) ORDER BY cl.created_at DESC
      ),
      '[]'::jsonb
    )
  INTO v_total, v_count, v_data
  FROM cash_logs cl
  LEFT JOIN branches       b  ON b.id  = cl.branch_id
  LEFT JOIN cash_categories cc ON cc.id = cl.category_id
  LEFT JOIN users          u  ON u.id  = cl.created_by
  WHERE cl.type    = 'out'
    AND cl.is_void = false
    AND (p_branch_id IS NULL OR cl.branch_id = p_branch_id)
    AND (
      p_date_from IS NULL
      OR (cl.created_at AT TIME ZONE 'Asia/Makassar')::DATE >= p_date_from
    )
    AND (
      p_date_to IS NULL
      OR (cl.created_at AT TIME ZONE 'Asia/Makassar')::DATE <= p_date_to
    );

  RETURN jsonb_build_object(
    'success',           true,
    'type',              'kas_keluar',
    'diambil_pada',      TO_CHAR((NOW() AT TIME ZONE 'Asia/Makassar'), 'YYYY-MM-DD HH24:MI:SS WITA'),
    'periode',           jsonb_build_object(
      'tanggal_mulai',   COALESCE(p_date_from::TEXT, 'semua'),
      'tanggal_akhir',   COALESCE(p_date_to::TEXT,   'semua')
    ),
    'filter_cabang_id',  p_branch_id,
    'summary',           jsonb_build_object(
      'total_kas_keluar',  v_total,
      'jumlah_transaksi',  v_count
    ),
    'data',              v_data
  );
END;
$$;

GRANT EXECUTE ON FUNCTION get_kas_keluar_integration TO anon, authenticated;


-- C.2 get_sales_integration (dari migration 049)
CREATE OR REPLACE FUNCTION get_sales_integration(
  p_api_key    TEXT,
  p_date_from  DATE    DEFAULT NULL,
  p_date_to    DATE    DEFAULT NULL,
  p_branch_id  INTEGER DEFAULT NULL
)
RETURNS JSONB
SECURITY DEFINER
SET search_path = public
LANGUAGE plpgsql AS $$
DECLARE
  v_total  NUMERIC := 0;
  v_count  BIGINT  := 0;
  v_data   JSONB   := '[]'::jsonb;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM api_keys
    WHERE key_value = p_api_key AND is_active = TRUE
  ) THEN
    RETURN jsonb_build_object(
      'success', false,
      'error',   'API key tidak valid atau tidak aktif. Periksa kembali API key Anda di halaman Portal Integrasi Data.'
    );
  END IF;

  SELECT
    COALESCE(SUM(t.total), 0),
    COUNT(*),
    COALESCE(
      jsonb_agg(
        jsonb_build_object(
          'id',                t.id,
          'tanggal',           TO_CHAR((t.created_at AT TIME ZONE 'Asia/Makassar'), 'YYYY-MM-DD'),
          'waktu',             TO_CHAR((t.created_at AT TIME ZONE 'Asia/Makassar'), 'HH24:MI:SS'),
          'cabang',            COALESCE(b.name, '—'),
          'total_penjualan',   t.total,
          'subtotal',          COALESCE(t.subtotal, t.total),
          'diskon',            COALESCE(t.discount_amount, 0),
          'metode_pembayaran', COALESCE(t.payment_method, '—'),
          'status',            t.status,
          'kasir',             COALESCE(u.name, '—')
        ) ORDER BY t.created_at DESC
      ),
      '[]'::jsonb
    )
  INTO v_total, v_count, v_data
  FROM transactions t
  LEFT JOIN branches b ON b.id = t.branch_id
  LEFT JOIN users    u ON u.id = t.staff_id
  WHERE t.status = 'completed'
    AND (p_branch_id IS NULL OR t.branch_id = p_branch_id)
    AND (
      p_date_from IS NULL
      OR (t.created_at AT TIME ZONE 'Asia/Makassar')::DATE >= p_date_from
    )
    AND (
      p_date_to IS NULL
      OR (t.created_at AT TIME ZONE 'Asia/Makassar')::DATE <= p_date_to
    );

  RETURN jsonb_build_object(
    'success',          true,
    'type',             'sales',
    'diambil_pada',     TO_CHAR((NOW() AT TIME ZONE 'Asia/Makassar'), 'YYYY-MM-DD HH24:MI:SS WITA'),
    'periode',          jsonb_build_object(
      'tanggal_mulai',  COALESCE(p_date_from::TEXT, 'semua'),
      'tanggal_akhir',  COALESCE(p_date_to::TEXT,   'semua')
    ),
    'filter_cabang_id', p_branch_id,
    'summary',          jsonb_build_object(
      'total_penjualan',   v_total,
      'jumlah_transaksi',  v_count
    ),
    'data',             v_data
  );
END;
$$;

GRANT EXECUTE ON FUNCTION get_sales_integration TO anon, authenticated;


-- C.3 get_integration_summary (dari migration 049)
CREATE OR REPLACE FUNCTION get_integration_summary(
  p_api_key    TEXT,
  p_date_from  DATE    DEFAULT NULL,
  p_date_to    DATE    DEFAULT NULL,
  p_branch_id  INTEGER DEFAULT NULL
)
RETURNS JSONB
SECURITY DEFINER
SET search_path = public
LANGUAGE plpgsql AS $$
DECLARE
  v_total_sales   NUMERIC := 0;
  v_count_sales   BIGINT  := 0;
  v_total_cashout NUMERIC := 0;
  v_count_cashout BIGINT  := 0;
  v_by_branch     JSONB   := '[]'::jsonb;
  v_by_date       JSONB   := '[]'::jsonb;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM api_keys
    WHERE key_value = p_api_key AND is_active = TRUE
  ) THEN
    RETURN jsonb_build_object(
      'success', false,
      'error',   'API key tidak valid atau tidak aktif.'
    );
  END IF;

  SELECT
    COALESCE(SUM(t.total), 0),
    COUNT(*)
  INTO v_total_sales, v_count_sales
  FROM transactions t
  WHERE t.status = 'completed'
    AND (p_branch_id IS NULL OR t.branch_id = p_branch_id)
    AND (p_date_from IS NULL OR (t.created_at AT TIME ZONE 'Asia/Makassar')::DATE >= p_date_from)
    AND (p_date_to   IS NULL OR (t.created_at AT TIME ZONE 'Asia/Makassar')::DATE <= p_date_to);

  SELECT
    COALESCE(SUM(cl.amount), 0),
    COUNT(*)
  INTO v_total_cashout, v_count_cashout
  FROM cash_logs cl
  WHERE cl.type    = 'out'
    AND cl.is_void = false
    AND (p_branch_id IS NULL OR cl.branch_id = p_branch_id)
    AND (p_date_from IS NULL OR (cl.created_at AT TIME ZONE 'Asia/Makassar')::DATE >= p_date_from)
    AND (p_date_to   IS NULL OR (cl.created_at AT TIME ZONE 'Asia/Makassar')::DATE <= p_date_to);

  SELECT COALESCE(
    jsonb_agg(
      jsonb_build_object(
        'cabang',             branch_name,
        'total_penjualan',    total_penjualan,
        'jumlah_transaksi',   jumlah_transaksi,
        'total_kas_keluar',   total_kas_keluar
      ) ORDER BY branch_name
    ),
    '[]'::jsonb
  )
  INTO v_by_branch
  FROM (
    SELECT
      COALESCE(b.name, '—') AS branch_name,
      COALESCE(SUM(CASE WHEN t.status = 'completed' THEN t.total ELSE 0 END), 0) AS total_penjualan,
      COUNT(CASE WHEN t.status = 'completed' THEN 1 END)                          AS jumlah_transaksi,
      COALESCE((
        SELECT SUM(cl2.amount)
        FROM cash_logs cl2
        WHERE cl2.branch_id = t.branch_id
          AND cl2.type = 'out' AND cl2.is_void = false
          AND (p_date_from IS NULL OR (cl2.created_at AT TIME ZONE 'Asia/Makassar')::DATE >= p_date_from)
          AND (p_date_to   IS NULL OR (cl2.created_at AT TIME ZONE 'Asia/Makassar')::DATE <= p_date_to)
      ), 0) AS total_kas_keluar
    FROM transactions t
    LEFT JOIN branches b ON b.id = t.branch_id
    WHERE (p_branch_id IS NULL OR t.branch_id = p_branch_id)
      AND (p_date_from IS NULL OR (t.created_at AT TIME ZONE 'Asia/Makassar')::DATE >= p_date_from)
      AND (p_date_to   IS NULL OR (t.created_at AT TIME ZONE 'Asia/Makassar')::DATE <= p_date_to)
    GROUP BY b.name, t.branch_id
  ) sub;

  IF p_date_from IS NOT NULL AND p_date_to IS NOT NULL
     AND (p_date_to - p_date_from) <= 366
  THEN
    SELECT COALESCE(
      jsonb_agg(
        jsonb_build_object(
          'tanggal',          d::TEXT,
          'total_penjualan',  COALESCE((
            SELECT SUM(t2.total) FROM transactions t2
            WHERE t2.status = 'completed'
              AND (p_branch_id IS NULL OR t2.branch_id = p_branch_id)
              AND (t2.created_at AT TIME ZONE 'Asia/Makassar')::DATE = d
          ), 0),
          'total_kas_keluar', COALESCE((
            SELECT SUM(cl3.amount) FROM cash_logs cl3
            WHERE cl3.type = 'out' AND cl3.is_void = false
              AND (p_branch_id IS NULL OR cl3.branch_id = p_branch_id)
              AND (cl3.created_at AT TIME ZONE 'Asia/Makassar')::DATE = d
          ), 0)
        ) ORDER BY d
      ),
      '[]'::jsonb
    )
    INTO v_by_date
    FROM generate_series(p_date_from, p_date_to, '1 day'::INTERVAL) AS gs(d);
  END IF;

  RETURN jsonb_build_object(
    'success',          true,
    'type',             'summary',
    'diambil_pada',     TO_CHAR((NOW() AT TIME ZONE 'Asia/Makassar'), 'YYYY-MM-DD HH24:MI:SS WITA'),
    'periode',          jsonb_build_object(
      'tanggal_mulai',  COALESCE(p_date_from::TEXT, 'semua'),
      'tanggal_akhir',  COALESCE(p_date_to::TEXT,   'semua')
    ),
    'filter_cabang_id', p_branch_id,
    'summary',          jsonb_build_object(
      'total_penjualan',   v_total_sales,
      'jumlah_transaksi',  v_count_sales,
      'total_kas_keluar',  v_total_cashout,
      'jumlah_kas_keluar', v_count_cashout,
      'selisih',           v_total_sales - v_total_cashout
    ),
    'per_cabang',       v_by_branch,
    'per_tanggal',      v_by_date
  );
END;
$$;

GRANT EXECUTE ON FUNCTION get_integration_summary TO anon, authenticated;


-- ── D. Update get_admin_branch_cash_positions: live balance saat shift aktif ─

CREATE OR REPLACE FUNCTION public.get_admin_branch_cash_positions(
  p_admin_id  bigint,
  p_branch_id bigint  DEFAULT NULL,
  p_staff_id  bigint  DEFAULT NULL,
  p_status    text    DEFAULT 'all',
  p_date_from date    DEFAULT NULL,
  p_date_to   date    DEFAULT NULL
)
RETURNS TABLE (
  branch_id               bigint,
  branch_name             text,
  current_balance         numeric,
  running_estimated_cash  numeric,
  balance_id              bigint,
  version                 bigint,
  last_opening_cash       numeric,
  last_closing_cash       numeric,
  last_opened_by_name     text,
  last_closed_by_name     text,
  last_updated            timestamptz,
  shift_status            text,
  open_session_id         bigint,
  open_staff_name         text,
  open_session_opened_at  timestamptz,
  pending_deposit_amount  numeric,
  last_variance_amount    numeric,
  has_variance            boolean,
  default_cash_position   numeric
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_admin record;
BEGIN
  SELECT u.id, u.role INTO v_admin
  FROM public.users u
  WHERE u.id = p_admin_id;

  IF NOT FOUND OR v_admin.role NOT IN ('admin', 'owner') THEN
    RAISE EXCEPTION 'Hanya admin/owner yang dapat mengakses data ini';
  END IF;

  RETURN QUERY
  WITH open_sess AS (
    SELECT cs.id, cs.branch_id, cs.staff_id, cs.opened_at, cs.opening_cash,
           u.name::text AS staff_name
    FROM public.cashier_sessions cs
    LEFT JOIN public.users u ON u.id = cs.staff_id
    WHERE cs.status = 'open'
      AND (p_staff_id IS NULL OR cs.staff_id = p_staff_id)
  ),
  last_closed AS (
    SELECT DISTINCT ON (cs.branch_id)
           cs.branch_id,
           cs.id AS session_id,
           cs.staff_id,
           cs.opening_cash,
           cs.closing_cash,
           cs.closed_at,
           COALESCE(cs.closing_cash, 0) - COALESCE(cs.expected_cash, 0) AS variance,
           u.name::text AS staff_name
    FROM public.cashier_sessions cs
    LEFT JOIN public.users u ON u.id = cs.staff_id
    WHERE cs.status = 'closed'
      AND cs.closing_cash IS NOT NULL
      AND (p_staff_id IS NULL OR cs.staff_id = p_staff_id)
      AND (p_date_from IS NULL OR cs.closed_at::date >= p_date_from)
      AND (p_date_to   IS NULL OR cs.closed_at::date <= p_date_to)
    ORDER BY cs.branch_id, cs.closed_at DESC
  ),
  pending AS (
    SELECT cd.branch_id, SUM(cd.amount) AS total
    FROM public.cash_deposits cd
    WHERE cd.status = 'pending'
    GROUP BY cd.branch_id
  ),
  rows AS (
    SELECT
      b.id::bigint AS branch_id,
      b.name::text AS branch_name,
      -- Saldo saat ini: selalu dari branch_cash_positions (diupdate real-time oleh trigger)
      COALESCE(bcp.balance, lc.closing_cash, b.default_cash_position, 0)::numeric AS current_balance,
      -- Estimasi kas berjalan: dihitung ulang dari session aktif (untuk verifikasi)
      CASE
        WHEN os.id IS NOT NULL THEN
          public.compute_cash_session_system_amount_outlet(os.id)
        ELSE NULL
      END::numeric AS running_estimated_cash,
      bcp.id::bigint AS balance_id,
      COALESCE(bcp.version, 0)::bigint AS version,
      COALESCE(os.opening_cash, lc.opening_cash)::numeric AS last_opening_cash,
      lc.closing_cash::numeric AS last_closing_cash,
      COALESCE(os.staff_name, lc.staff_name)::text AS last_opened_by_name,
      lc.staff_name::text AS last_closed_by_name,
      COALESCE(bcp.updated_at, os.opened_at, lc.closed_at)::timestamptz AS last_updated,
      CASE
        WHEN os.id IS NOT NULL THEN 'open'
        WHEN lc.session_id IS NOT NULL
          AND (lc.closed_at AT TIME ZONE 'Asia/Makassar')::date
            = (now() AT TIME ZONE 'Asia/Makassar')::date
          THEN 'closed_today'
        ELSE 'none'
      END::text AS shift_status,
      os.id::bigint AS open_session_id,
      os.staff_name::text AS open_staff_name,
      os.opened_at::timestamptz AS open_session_opened_at,
      COALESCE(pd.total, 0)::numeric AS pending_deposit_amount,
      lc.variance::numeric AS last_variance_amount,
      (lc.variance IS NOT NULL AND lc.variance <> 0)::boolean AS has_variance,
      COALESCE(b.default_cash_position, 0)::numeric AS default_cash_position
    FROM public.branches b
    LEFT JOIN public.branch_cash_positions bcp ON bcp.branch_id = b.id
    LEFT JOIN open_sess os  ON os.branch_id  = b.id
    LEFT JOIN last_closed lc ON lc.branch_id = b.id
    LEFT JOIN pending pd     ON pd.branch_id = b.id
    WHERE COALESCE(b.is_active, true) = true
      AND (p_branch_id IS NULL OR b.id = p_branch_id)
  )
  SELECT r.*
  FROM rows r
  WHERE COALESCE(p_status, 'all') = 'all'
     OR r.shift_status = p_status
     OR (p_status = 'adjusted'     AND r.has_variance)
     OR (p_status = 'manual_closed' AND false)
  ORDER BY r.branch_name;
END;
$$;

GRANT EXECUTE ON FUNCTION public.get_admin_branch_cash_positions(bigint, bigint, bigint, text, date, date)
  TO anon, authenticated;


-- ── E. Update get_branch_cash_ledger: label tipe gerakan baru ────────────

CREATE OR REPLACE FUNCTION public.get_branch_cash_ledger(
  p_admin_id      bigint,
  p_branch_id     bigint,
  p_date_from     timestamptz DEFAULT NULL,
  p_date_to       timestamptz DEFAULT NULL,
  p_movement_type text        DEFAULT NULL,
  p_limit         integer     DEFAULT 100
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
  SELECT u.id, u.role INTO v_admin
  FROM public.users u
  WHERE u.id = p_admin_id;

  IF NOT FOUND OR v_admin.role NOT IN ('admin', 'owner') THEN
    RAISE EXCEPTION 'Hanya admin/owner yang dapat mengakses riwayat ini';
  END IF;

  RETURN QUERY
  WITH ledger_rows AS (
    -- ── Baris dari branch_cash_ledger (semua tipe) ─────────────────────
    SELECT
      l.id::bigint,
      l.movement_type::text,
      l.direction::text,
      l.amount::numeric,
      l.balance_before::numeric,
      l.balance_after::numeric,
      l.expected_balance::numeric,
      l.variance_amount::numeric,
      l.reason::text,
      staff.name::text AS staff_name,
      admin.name::text AS admin_name,
      l.cash_session_id::bigint,
      l.deposit_id::uuid,
      l.source_table::text,
      l.source_id::text,
      l.created_at::timestamptz,
      l.metadata::jsonb
    FROM public.branch_cash_ledger l
    LEFT JOIN public.users staff ON staff.id = l.staff_id
    LEFT JOIN public.users admin ON admin.id  = l.admin_id
    WHERE l.branch_id = p_branch_id

    UNION ALL

    -- ── Virtual rows: session yang belum punya ledger entry ────────────
    SELECT
      cs.id::bigint AS id,
      CASE cs.status
        WHEN 'closed' THEN 'session_close'
        ELSE 'session_open_confirm'
      END::text AS movement_type,
      CASE cs.status WHEN 'closed' THEN 'adjust' ELSE 'none' END::text AS direction,
      COALESCE(cs.closing_cash, cs.opening_cash, 0)::numeric AS amount,
      COALESCE(cs.opening_cash, 0)::numeric AS balance_before,
      COALESCE(cs.closing_cash, cs.opening_cash, 0)::numeric AS balance_after,
      cs.expected_cash::numeric AS expected_balance,
      (COALESCE(cs.closing_cash, 0) - COALESCE(cs.expected_cash, 0))::numeric AS variance_amount,
      CASE cs.status WHEN 'closed' THEN 'Shift ditutup' ELSE 'Shift dibuka' END::text AS reason,
      staff.name::text AS staff_name,
      NULL::text AS admin_name,
      cs.id::bigint AS cash_session_id,
      NULL::uuid AS deposit_id,
      'cashier_sessions'::text AS source_table,
      cs.id::text AS source_id,
      COALESCE(cs.closed_at, cs.opened_at)::timestamptz AS created_at,
      jsonb_build_object('legacy_virtual', true) AS metadata
    FROM public.cashier_sessions cs
    LEFT JOIN public.users staff ON staff.id = cs.staff_id
    WHERE cs.branch_id = p_branch_id
      AND NOT EXISTS (
        SELECT 1
        FROM public.branch_cash_ledger existing
        WHERE existing.source_table = 'cashier_sessions'
          AND existing.source_id = cs.id::text
      )

    UNION ALL

    -- ── Virtual rows: setoran confirmed yang belum punya ledger ────────
    SELECT
      NULL::bigint AS id,
      'deposit_approved'::text AS movement_type,
      'out'::text AS direction,
      cd.amount::numeric AS amount,
      cd.branch_cash_balance_before::numeric AS balance_before,
      cd.branch_cash_balance_after::numeric AS balance_after,
      NULL::numeric AS expected_balance,
      NULL::numeric AS variance_amount,
      'Setoran disetujui admin'::text AS reason,
      staff.name::text AS staff_name,
      admin.name::text AS admin_name,
      cd.session_id::bigint AS cash_session_id,
      cd.id::uuid AS deposit_id,
      'cash_deposits'::text AS source_table,
      cd.id::text AS source_id,
      cd.branch_cash_applied_at::timestamptz AS created_at,
      jsonb_build_object(
        'legacy_virtual', true,
        'reviewed_by',    cd.reviewed_by
      ) AS metadata
    FROM public.cash_deposits cd
    LEFT JOIN public.users staff ON staff.id = cd.staff_id
    LEFT JOIN public.users admin ON admin.id::text = cd.reviewed_by::text
    WHERE cd.branch_id = p_branch_id
      AND cd.status = 'confirmed'
      AND cd.branch_cash_applied_at IS NOT NULL
      AND NOT EXISTS (
        SELECT 1
        FROM public.branch_cash_ledger existing
        WHERE existing.source_table = 'cash_deposits'
          AND existing.source_id = cd.id::text
      )
  )
  SELECT
    lr.id,
    lr.movement_type,
    lr.direction,
    lr.amount,
    lr.balance_before,
    lr.balance_after,
    lr.expected_balance,
    lr.variance_amount,
    lr.reason,
    lr.staff_name,
    lr.admin_name,
    lr.cash_session_id,
    lr.deposit_id,
    lr.source_table,
    lr.source_id,
    lr.created_at,
    lr.metadata
  FROM ledger_rows lr
  WHERE (p_date_from IS NULL OR lr.created_at >= p_date_from)
    AND (p_date_to   IS NULL OR lr.created_at <= p_date_to)
    AND (p_movement_type IS NULL OR lr.movement_type = p_movement_type)
  ORDER BY lr.created_at DESC NULLS LAST
  LIMIT COALESCE(p_limit, 100);
END;
$$;

GRANT EXECUTE ON FUNCTION public.get_branch_cash_ledger(bigint, bigint, timestamptz, timestamptz, text, integer)
  TO anon, authenticated;


-- ── F. Backfill: sinkronkan saldo untuk shift yang sedang terbuka ─────────
--
-- Update branch_cash_positions.balance agar mencerminkan semua transaksi tunai
-- dan log kas manual yang sudah terjadi sebelum migration ini dijalankan.
-- Hanya dilakukan untuk outlet yang punya shift aktif SEKARANG.
--
UPDATE public.branch_cash_positions bcp
SET balance    = public.compute_cash_session_system_amount_outlet(cs.id),
    updated_at = now()
FROM public.cashier_sessions cs
WHERE cs.branch_id = bcp.branch_id
  AND cs.status     = 'open'
  AND bcp.id        IS NOT NULL;

-- Catat backfill di ledger agar audit trail jelas
-- (satu entri per outlet yang aktif)
INSERT INTO public.branch_cash_ledger (
  branch_id, staff_id, cash_session_id,
  movement_type, direction, amount,
  balance_before, balance_after,
  reason, metadata
)
SELECT
  cs.branch_id,
  cs.staff_id,
  cs.id,
  'system_repair',
  'adjust',
  ABS(
    COALESCE(bcp.balance, 0) -
    COALESCE(cs.opening_cash, 0)
  ),
  COALESCE(cs.opening_cash, 0),
  COALESCE(bcp.balance, 0),
  'Sinkronisasi saldo kas outlet (migration 050 backfill)',
  jsonb_build_object(
    'migration',    '050',
    'backfill',     true,
    'session_id',   cs.id
  )
FROM public.cashier_sessions cs
JOIN public.branch_cash_positions bcp ON bcp.branch_id = cs.branch_id
WHERE cs.status = 'open'
  AND ABS(COALESCE(bcp.balance, 0) - COALESCE(cs.opening_cash, 0)) > 0;


-- ── G. Update generate_transfer_code: Asia/Jakarta → Asia/Makassar (WITA) ─

CREATE OR REPLACE FUNCTION generate_transfer_code()
RETURNS TEXT
LANGUAGE plpgsql AS $$
DECLARE
  v_date TEXT;
  v_seq  INTEGER;
BEGIN
  v_date := TO_CHAR(NOW() AT TIME ZONE 'Asia/Makassar', 'YYYYMMDD');
  SELECT COUNT(*) + 1 INTO v_seq
  FROM stock_transfers
  WHERE TO_CHAR(created_at AT TIME ZONE 'Asia/Makassar', 'YYYYMMDD') = v_date;
  RETURN 'TRF-' || v_date || '-' || LPAD(v_seq::TEXT, 3, '0');
END;
$$;


-- ── Reload PostgREST schema cache ─────────────────────────────────────────
NOTIFY pgrst, 'reload schema';

COMMIT;
