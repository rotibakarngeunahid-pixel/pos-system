-- ══════════════════════════════════════════════════════════════
-- Migration 039: RPC Integrasi Kas Keluar untuk Sistem Keuangan
-- Jalankan di Supabase Dashboard → SQL Editor → Run
-- ══════════════════════════════════════════════════════════════
--
-- Fungsi ini menyediakan data kas keluar terformat untuk
-- ditarik oleh sistem keuangan eksternal menggunakan API key.
-- Keamanan: API key divalidasi dari tabel api_keys (migration
-- sebelumnya via schema_toppings_apikeys.sql).
-- ══════════════════════════════════════════════════════════════

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
  v_total NUMERIC := 0;
  v_count BIGINT  := 0;
  v_data  JSONB   := '[]'::jsonb;
BEGIN
  -- ── Validasi API key ──────────────────────────────────────────
  IF NOT EXISTS (
    SELECT 1 FROM api_keys WHERE key_value = p_api_key AND is_active = TRUE
  ) THEN
    RETURN jsonb_build_object(
      'success', false,
      'error',   'API key tidak valid atau tidak aktif. Periksa kembali API key Anda di halaman Integrasi Keuangan.'
    );
  END IF;

  -- ── Ambil data kas keluar ─────────────────────────────────────
  -- Hanya ambil: type = 'out', is_void = false
  -- Filter tanggal menggunakan timezone Asia/Jakarta agar konsisten
  -- dengan tanggal bisnis yang dipakai admin.
  SELECT
    COALESCE(SUM(cl.amount), 0),
    COUNT(*),
    COALESCE(
      jsonb_agg(
        jsonb_build_object(
          'id',               cl.id,
          'tanggal',          TO_CHAR((cl.created_at AT TIME ZONE 'Asia/Jakarta'), 'YYYY-MM-DD'),
          'waktu',            TO_CHAR((cl.created_at AT TIME ZONE 'Asia/Jakarta'), 'HH24:MI:SS'),
          'cabang',           COALESCE(b.name, '—'),
          'nama_pengeluaran', COALESCE(cc.name, COALESCE(cl.note, 'Kas Keluar')),
          'kategori',         cc.name,
          'nominal',          cl.amount,
          'keterangan',       cl.note,
          'dicatat_oleh',     u.name,
          'reference_type',   cl.reference_type
        ) ORDER BY cl.created_at DESC
      ),
      '[]'::jsonb
    )
  INTO v_total, v_count, v_data
  FROM cash_logs cl
  LEFT JOIN branches       b  ON b.id  = cl.branch_id
  LEFT JOIN cash_categories cc ON cc.id = cl.category_id
  LEFT JOIN users           u  ON u.id  = cl.created_by
  WHERE cl.type    = 'out'
    AND cl.is_void = false
    AND (p_branch_id IS NULL OR cl.branch_id = p_branch_id)
    AND (
      p_date_from IS NULL
      OR (cl.created_at AT TIME ZONE 'Asia/Jakarta')::DATE >= p_date_from
    )
    AND (
      p_date_to IS NULL
      OR (cl.created_at AT TIME ZONE 'Asia/Jakarta')::DATE <= p_date_to
    );

  -- ── Return structured JSON ────────────────────────────────────
  RETURN jsonb_build_object(
    'success',           true,
    'diambil_pada',      TO_CHAR((NOW() AT TIME ZONE 'Asia/Jakarta'), 'YYYY-MM-DD HH24:MI:SS WIB'),
    'periode',           jsonb_build_object(
      'tanggal_mulai',  COALESCE(p_date_from::TEXT, 'semua'),
      'tanggal_akhir',  COALESCE(p_date_to::TEXT,   'semua')
    ),
    'filter_cabang_id',  p_branch_id,
    'total_pengeluaran', v_total,
    'jumlah_data',       v_count,
    'data',              v_data
  );
END;
$$;

-- ── Grant akses ke fungsi ─────────────────────────────────────
-- anon: agar bisa dipanggil dari URL publik dengan apikey query param
-- authenticated: agar admin bisa preview dari UI
GRANT EXECUTE ON FUNCTION get_kas_keluar_integration TO anon, authenticated;
