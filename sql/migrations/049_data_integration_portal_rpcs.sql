-- ══════════════════════════════════════════════════════════════════════════
-- Migration 049: Portal Integrasi Data — Sales & Summary RPCs
-- Jalankan di Supabase Dashboard → SQL Editor → Run
-- ══════════════════════════════════════════════════════════════════════════
--
-- Menambahkan dua RPC baru untuk Portal Integrasi Data:
--   1. get_sales_integration      — data penjualan per tanggal & cabang
--   2. get_integration_summary    — ringkasan gabungan penjualan + kas keluar
--
-- Data kas keluar sudah tersedia via get_kas_keluar_integration (migration 039).
-- Ketiga fungsi menggunakan pola validasi API key yang sama.
-- ══════════════════════════════════════════════════════════════════════════

-- ── 1. get_sales_integration ───────────────────────────────────────────────
-- Mengembalikan data transaksi penjualan (hanya status = 'completed')
-- dalam format JSON terstruktur yang bisa langsung dibaca sistem keuangan.

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
  -- ── Validasi API key ──────────────────────────────────────────
  IF NOT EXISTS (
    SELECT 1 FROM api_keys
    WHERE key_value = p_api_key AND is_active = TRUE
  ) THEN
    RETURN jsonb_build_object(
      'success', false,
      'error',   'API key tidak valid atau tidak aktif. Periksa kembali API key Anda di halaman Portal Integrasi Data.'
    );
  END IF;

  -- ── Ambil data penjualan ──────────────────────────────────────
  -- Hanya status = 'completed'; void dieksklusi secara eksplisit
  SELECT
    COALESCE(SUM(t.total), 0),
    COUNT(*),
    COALESCE(
      jsonb_agg(
        jsonb_build_object(
          'id',                t.id,
          'tanggal',           TO_CHAR((t.created_at AT TIME ZONE 'Asia/Jakarta'), 'YYYY-MM-DD'),
          'waktu',             TO_CHAR((t.created_at AT TIME ZONE 'Asia/Jakarta'), 'HH24:MI:SS'),
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
      OR (t.created_at AT TIME ZONE 'Asia/Jakarta')::DATE >= p_date_from
    )
    AND (
      p_date_to IS NULL
      OR (t.created_at AT TIME ZONE 'Asia/Jakarta')::DATE <= p_date_to
    );

  -- ── Return structured JSON ────────────────────────────────────
  RETURN jsonb_build_object(
    'success',          true,
    'type',             'sales',
    'diambil_pada',     TO_CHAR((NOW() AT TIME ZONE 'Asia/Jakarta'), 'YYYY-MM-DD HH24:MI:SS'),
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

-- Grant akses: anon untuk URL publik, authenticated untuk preview UI
GRANT EXECUTE ON FUNCTION get_sales_integration TO anon, authenticated;


-- ── 2. get_integration_summary ─────────────────────────────────────────────
-- Mengembalikan ringkasan gabungan: penjualan + kas keluar + selisih
-- Termasuk breakdown per cabang dan per tanggal (dalam rentang yang diminta).

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
  -- ── Validasi API key ──────────────────────────────────────────
  IF NOT EXISTS (
    SELECT 1 FROM api_keys
    WHERE key_value = p_api_key AND is_active = TRUE
  ) THEN
    RETURN jsonb_build_object(
      'success', false,
      'error',   'API key tidak valid atau tidak aktif.'
    );
  END IF;

  -- ── Total penjualan (completed only) ─────────────────────────
  SELECT
    COALESCE(SUM(t.total), 0),
    COUNT(*)
  INTO v_total_sales, v_count_sales
  FROM transactions t
  WHERE t.status = 'completed'
    AND (p_branch_id IS NULL OR t.branch_id = p_branch_id)
    AND (p_date_from IS NULL OR (t.created_at AT TIME ZONE 'Asia/Jakarta')::DATE >= p_date_from)
    AND (p_date_to   IS NULL OR (t.created_at AT TIME ZONE 'Asia/Jakarta')::DATE <= p_date_to);

  -- ── Total kas keluar (non-void only) ─────────────────────────
  SELECT
    COALESCE(SUM(cl.amount), 0),
    COUNT(*)
  INTO v_total_cashout, v_count_cashout
  FROM cash_logs cl
  WHERE cl.type    = 'out'
    AND cl.is_void = false
    AND (p_branch_id IS NULL OR cl.branch_id = p_branch_id)
    AND (p_date_from IS NULL OR (cl.created_at AT TIME ZONE 'Asia/Jakarta')::DATE >= p_date_from)
    AND (p_date_to   IS NULL OR (cl.created_at AT TIME ZONE 'Asia/Jakarta')::DATE <= p_date_to);

  -- ── Per-cabang ringkasan ──────────────────────────────────────
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
          AND (p_date_from IS NULL OR (cl2.created_at AT TIME ZONE 'Asia/Jakarta')::DATE >= p_date_from)
          AND (p_date_to   IS NULL OR (cl2.created_at AT TIME ZONE 'Asia/Jakarta')::DATE <= p_date_to)
      ), 0) AS total_kas_keluar
    FROM transactions t
    LEFT JOIN branches b ON b.id = t.branch_id
    WHERE (p_branch_id IS NULL OR t.branch_id = p_branch_id)
      AND (p_date_from IS NULL OR (t.created_at AT TIME ZONE 'Asia/Jakarta')::DATE >= p_date_from)
      AND (p_date_to   IS NULL OR (t.created_at AT TIME ZONE 'Asia/Jakarta')::DATE <= p_date_to)
    GROUP BY b.name, t.branch_id
  ) sub;

  -- ── Per-tanggal ringkasan (menggunakan rentang yang diminta) ──
  -- Hanya jalankan per-date jika tanggal eksplisit (maksimal 366 hari)
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
              AND (t2.created_at AT TIME ZONE 'Asia/Jakarta')::DATE = d
          ), 0),
          'total_kas_keluar', COALESCE((
            SELECT SUM(cl3.amount) FROM cash_logs cl3
            WHERE cl3.type = 'out' AND cl3.is_void = false
              AND (p_branch_id IS NULL OR cl3.branch_id = p_branch_id)
              AND (cl3.created_at AT TIME ZONE 'Asia/Jakarta')::DATE = d
          ), 0)
        ) ORDER BY d
      ),
      '[]'::jsonb
    )
    INTO v_by_date
    FROM generate_series(p_date_from, p_date_to, '1 day'::INTERVAL) AS gs(d);
  END IF;

  -- ── Return structured JSON ────────────────────────────────────
  RETURN jsonb_build_object(
    'success',          true,
    'type',             'summary',
    'diambil_pada',     TO_CHAR((NOW() AT TIME ZONE 'Asia/Jakarta'), 'YYYY-MM-DD HH24:MI:SS'),
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

-- Grant akses
GRANT EXECUTE ON FUNCTION get_integration_summary TO anon, authenticated;
