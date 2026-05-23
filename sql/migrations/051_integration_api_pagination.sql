-- ══════════════════════════════════════════════════════════════════════════
-- Migration 051: Integration API — Pagination + Semua Data Tanpa Batasan
-- ══════════════════════════════════════════════════════════════════════════
--
-- Perubahan:
--   - Tambah p_limit (DEFAULT 1000) dan p_offset (DEFAULT 0) ke semua RPC
--   - Response sekarang menyertakan total_count + has_more untuk pagination
--   - Tanggal tetap opsional — filter dilakukan di sistem keuangan eksternal
--   - Hapus batasan 365 hari (batasan itu ada di JS, bukan di SQL)
--
-- Pola pemakaian dari sistem keuangan:
--   1. Tarik semua data:   GET /rpc/get_sales_integration?p_api_key=KEY&p_limit=1000&p_offset=0
--   2. Halaman berikutnya: GET /rpc/get_sales_integration?p_api_key=KEY&p_limit=1000&p_offset=1000
--   3. Ulangi sampai has_more = false
--   4. Filter tanggal di sistem keuangan dari field tanggal di setiap record
-- ══════════════════════════════════════════════════════════════════════════

BEGIN;

-- ── 1. get_sales_integration — dengan pagination ──────────────────────────

CREATE OR REPLACE FUNCTION get_sales_integration(
  p_api_key    TEXT,
  p_date_from  DATE    DEFAULT NULL,
  p_date_to    DATE    DEFAULT NULL,
  p_branch_id  INTEGER DEFAULT NULL,
  p_limit      INTEGER DEFAULT 1000,
  p_offset     INTEGER DEFAULT 0
)
RETURNS JSONB
SECURITY DEFINER
SET search_path = public
LANGUAGE plpgsql AS $$
DECLARE
  v_total_all  BIGINT  := 0;  -- total semua record (tanpa limit/offset)
  v_total_rp   NUMERIC := 0;  -- total rupiah (pada halaman ini saja)
  v_data       JSONB   := '[]'::jsonb;
  v_limit      INTEGER;
  v_offset     INTEGER;
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

  -- Batasi p_limit maks 5000 untuk mencegah timeout
  v_limit  := LEAST(COALESCE(p_limit, 1000), 5000);
  v_offset := GREATEST(COALESCE(p_offset, 0), 0);

  -- Hitung total semua record (untuk has_more)
  SELECT COUNT(*)
  INTO v_total_all
  FROM transactions t
  WHERE t.status = 'completed'
    AND (p_branch_id IS NULL OR t.branch_id = p_branch_id)
    AND (p_date_from IS NULL OR (t.created_at AT TIME ZONE 'Asia/Makassar')::DATE >= p_date_from)
    AND (p_date_to   IS NULL OR (t.created_at AT TIME ZONE 'Asia/Makassar')::DATE <= p_date_to);

  -- Ambil halaman data + hitung total rupiah pada halaman ini
  SELECT
    COALESCE(SUM(t.total), 0),
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
  INTO v_total_rp, v_data
  FROM (
    SELECT t.*
    FROM transactions t
    WHERE t.status = 'completed'
      AND (p_branch_id IS NULL OR t.branch_id = p_branch_id)
      AND (p_date_from IS NULL OR (t.created_at AT TIME ZONE 'Asia/Makassar')::DATE >= p_date_from)
      AND (p_date_to   IS NULL OR (t.created_at AT TIME ZONE 'Asia/Makassar')::DATE <= p_date_to)
    ORDER BY t.created_at DESC
    LIMIT v_limit OFFSET v_offset
  ) t
  LEFT JOIN branches b ON b.id = t.branch_id
  LEFT JOIN users    u ON u.id = t.staff_id;

  RETURN jsonb_build_object(
    'success',          true,
    'type',             'sales',
    'diambil_pada',     TO_CHAR((NOW() AT TIME ZONE 'Asia/Makassar'), 'YYYY-MM-DD HH24:MI:SS WITA'),
    'periode',          jsonb_build_object(
      'tanggal_mulai',  COALESCE(p_date_from::TEXT, 'semua'),
      'tanggal_akhir',  COALESCE(p_date_to::TEXT,   'semua')
    ),
    'filter_cabang_id', p_branch_id,
    'pagination',       jsonb_build_object(
      'limit',          v_limit,
      'offset',         v_offset,
      'total_count',    v_total_all,
      'returned_count', jsonb_array_length(v_data),
      'has_more',       (v_offset + v_limit) < v_total_all
    ),
    'summary',          jsonb_build_object(
      'total_penjualan',   v_total_rp,
      'jumlah_transaksi',  jsonb_array_length(v_data)
    ),
    'data',             v_data
  );
END;
$$;

GRANT EXECUTE ON FUNCTION get_sales_integration TO anon, authenticated;


-- ── 2. get_kas_keluar_integration — dengan pagination ─────────────────────

CREATE OR REPLACE FUNCTION get_kas_keluar_integration(
  p_api_key    TEXT,
  p_date_from  DATE    DEFAULT NULL,
  p_date_to    DATE    DEFAULT NULL,
  p_branch_id  INTEGER DEFAULT NULL,
  p_limit      INTEGER DEFAULT 1000,
  p_offset     INTEGER DEFAULT 0
)
RETURNS JSONB
SECURITY DEFINER
SET search_path = public
LANGUAGE plpgsql AS $$
DECLARE
  v_total_all  BIGINT  := 0;
  v_total_rp   NUMERIC := 0;
  v_data       JSONB   := '[]'::jsonb;
  v_limit      INTEGER;
  v_offset     INTEGER;
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

  v_limit  := LEAST(COALESCE(p_limit, 1000), 5000);
  v_offset := GREATEST(COALESCE(p_offset, 0), 0);

  SELECT COUNT(*)
  INTO v_total_all
  FROM cash_logs cl
  WHERE cl.type    = 'out'
    AND cl.is_void = false
    AND (p_branch_id IS NULL OR cl.branch_id = p_branch_id)
    AND (p_date_from IS NULL OR (cl.created_at AT TIME ZONE 'Asia/Makassar')::DATE >= p_date_from)
    AND (p_date_to   IS NULL OR (cl.created_at AT TIME ZONE 'Asia/Makassar')::DATE <= p_date_to);

  SELECT
    COALESCE(SUM(cl.amount), 0),
    COALESCE(
      jsonb_agg(
        jsonb_build_object(
          'id',           cl.id,
          'tanggal',      TO_CHAR((cl.created_at AT TIME ZONE 'Asia/Makassar'), 'YYYY-MM-DD'),
          'waktu',        TO_CHAR((cl.created_at AT TIME ZONE 'Asia/Makassar'), 'HH24:MI:SS'),
          'cabang',       COALESCE(b.name, '—'),
          'kategori',     COALESCE(cc.name, '—'),
          'nominal',      cl.amount,
          'keterangan',   COALESCE(cl.note, '—'),
          'dicatat_oleh', COALESCE(u.name, '—')
        ) ORDER BY cl.created_at DESC
      ),
      '[]'::jsonb
    )
  INTO v_total_rp, v_data
  FROM (
    SELECT cl.*
    FROM cash_logs cl
    WHERE cl.type    = 'out'
      AND cl.is_void = false
      AND (p_branch_id IS NULL OR cl.branch_id = p_branch_id)
      AND (p_date_from IS NULL OR (cl.created_at AT TIME ZONE 'Asia/Makassar')::DATE >= p_date_from)
      AND (p_date_to   IS NULL OR (cl.created_at AT TIME ZONE 'Asia/Makassar')::DATE <= p_date_to)
    ORDER BY cl.created_at DESC
    LIMIT v_limit OFFSET v_offset
  ) cl
  LEFT JOIN branches       b  ON b.id  = cl.branch_id
  LEFT JOIN cash_categories cc ON cc.id = cl.category_id
  LEFT JOIN users          u  ON u.id  = cl.created_by;

  RETURN jsonb_build_object(
    'success',           true,
    'type',              'kas_keluar',
    'diambil_pada',      TO_CHAR((NOW() AT TIME ZONE 'Asia/Makassar'), 'YYYY-MM-DD HH24:MI:SS WITA'),
    'periode',           jsonb_build_object(
      'tanggal_mulai',   COALESCE(p_date_from::TEXT, 'semua'),
      'tanggal_akhir',   COALESCE(p_date_to::TEXT,   'semua')
    ),
    'filter_cabang_id',  p_branch_id,
    'pagination',        jsonb_build_object(
      'limit',           v_limit,
      'offset',          v_offset,
      'total_count',     v_total_all,
      'returned_count',  jsonb_array_length(v_data),
      'has_more',        (v_offset + v_limit) < v_total_all
    ),
    'summary',           jsonb_build_object(
      'total_kas_keluar',  v_total_rp,
      'jumlah_transaksi',  jsonb_array_length(v_data)
    ),
    'data',              v_data
  );
END;
$$;

GRANT EXECUTE ON FUNCTION get_kas_keluar_integration TO anon, authenticated;


-- ── 3. get_integration_summary — dengan pagination (per tanggal) ──────────

CREATE OR REPLACE FUNCTION get_integration_summary(
  p_api_key    TEXT,
  p_date_from  DATE    DEFAULT NULL,
  p_date_to    DATE    DEFAULT NULL,
  p_branch_id  INTEGER DEFAULT NULL,
  p_limit      INTEGER DEFAULT 1000,
  p_offset     INTEGER DEFAULT 0
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
  v_limit         INTEGER;
  v_offset        INTEGER;
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

  v_limit  := LEAST(COALESCE(p_limit, 1000), 5000);
  v_offset := GREATEST(COALESCE(p_offset, 0), 0);

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

  -- Per tanggal: jika filter tanggal diisi → generate_series; jika tidak → aggregate dari data nyata
  IF p_date_from IS NOT NULL AND p_date_to IS NOT NULL THEN
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
  ELSE
    -- Tanpa filter tanggal: kelompokkan per tanggal dari data nyata
    SELECT COALESCE(
      jsonb_agg(
        jsonb_build_object(
          'tanggal',          tgl::TEXT,
          'total_penjualan',  total_p,
          'total_kas_keluar', total_k
        ) ORDER BY tgl DESC
      ),
      '[]'::jsonb
    )
    INTO v_by_date
    FROM (
      SELECT
        (t.created_at AT TIME ZONE 'Asia/Makassar')::DATE AS tgl,
        SUM(CASE WHEN t.status = 'completed' THEN t.total ELSE 0 END) AS total_p,
        0::numeric AS total_k
      FROM transactions t
      WHERE (p_branch_id IS NULL OR t.branch_id = p_branch_id)
      GROUP BY 1

      UNION ALL

      SELECT
        (cl.created_at AT TIME ZONE 'Asia/Makassar')::DATE AS tgl,
        0::numeric AS total_p,
        SUM(CASE WHEN cl.type='out' AND NOT cl.is_void THEN cl.amount ELSE 0 END) AS total_k
      FROM cash_logs cl
      WHERE (p_branch_id IS NULL OR cl.branch_id = p_branch_id)
      GROUP BY 1
    ) raw
    GROUP BY tgl
    LIMIT v_limit OFFSET v_offset;
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


-- ── Reload schema cache ───────────────────────────────────────────────────
NOTIFY pgrst, 'reload schema';

COMMIT;
