<?php
// ══════════════════════════════════════════════════════════════════════════════
// migrate_from_supabase.php — Migrasi Data Supabase → MySQL (cPanel)
// Jalankan SEKALI dari browser: https://rotibakarngeunah.my.id/api/migrate_from_supabase.php?key=MIGRATION_KEY
// Setelah selesai, HAPUS file ini dari hosting!
// ══════════════════════════════════════════════════════════════════════════════

// ── KONFIGURASI — WAJIB DIISI SEBELUM UPLOAD ─────────────────────────────────
$SUPABASE_URL   = 'https://mcrhlwqmeccighmxmccz.supabase.co';   // URL project Supabase Anda
$SUPABASE_KEY   = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im1jcmhsd3FtZWNjaWdobXhtY2N6Iiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc3NzE4MzA3MCwiZXhwIjoyMDkyNzU5MDcwfQ.toSrxb6i4VMWzl6oxuKnSrNCQohrj1aKI2etdM-oZYs';           // service_role key (bukan anon key!)
$MYSQL_HOST     = 'localhost';
$MYSQL_DB       = 'rotw4785_rotibakar_pos';                       // sama seperti config.php
$MYSQL_USER     = 'rotw4785_rotibakaradmin';
$MYSQL_PASS     = '@iCYdX9QPC3iYnM';
$MIGRATION_KEY  = 'rbn2026xK9mPqL3vWnHjRtYcBfDsAeUo';          // bebas, tapi ganti! untuk keamanan
// ─────────────────────────────────────────────────────────────────────────────

// Keamanan: hanya bisa diakses dengan ?key=MIGRATION_KEY
if (($_GET['key'] ?? '') !== $MIGRATION_KEY) {
    http_response_code(403);
    die('Akses ditolak. Tambahkan ?key=MIGRATION_KEY di URL.');
}

// Batasi waktu eksekusi — migrasi data besar butuh waktu lama
set_time_limit(0);
ini_set('max_execution_time', 0);

// Output langsung ke browser (streaming)
ob_implicit_flush(true);
ob_end_flush();
header('Content-Type: text/html; charset=utf-8');
header('X-Accel-Buffering: no');

echo '<!DOCTYPE html><html><head><meta charset="utf-8">
<title>Migrasi Supabase → MySQL</title>
<style>
  body { font-family: monospace; background: #1a1a2e; color: #eee; padding: 20px; }
  h1 { color: #e94560; }
  .ok   { color: #4ecca3; }
  .warn { color: #f5a623; }
  .err  { color: #e94560; }
  .info { color: #8892b0; }
  .tbl  { color: #ccd6f6; font-weight: bold; }
  hr    { border-color: #333; }
  pre   { white-space: pre-wrap; }
</style></head><body>';
echo '<h1>Migrasi Supabase &rarr; MySQL</h1>';
echo '<pre>';

function log_msg(string $msg, string $type = 'info'): void {
    $ts = date('H:i:s');
    echo "<span class=\"$type\">[$ts] $msg</span>\n";
    flush();
}

// ── Koneksi MySQL ─────────────────────────────────────────────────────────────
try {
    $pdo = new PDO(
        "mysql:host=$MYSQL_HOST;dbname=$MYSQL_DB;charset=utf8mb4",
        $MYSQL_USER, $MYSQL_PASS,
        [PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION, PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC]
    );
    log_msg("Koneksi MySQL OK", 'ok');
} catch (Exception $e) {
    log_msg("GAGAL koneksi MySQL: " . $e->getMessage(), 'err');
    die("</pre></body></html>");
}

// ── Ambil daftar kolom dari MySQL ─────────────────────────────────────────────
function get_mysql_columns(PDO $pdo, string $table): ?array {
    try {
        $stmt = $pdo->query("SHOW COLUMNS FROM `$table`");
        return array_column($stmt->fetchAll(PDO::FETCH_ASSOC), 'Field');
    } catch (Exception $e) {
        return null; // tabel tidak ada di MySQL
    }
}

// ── Tebak tipe MySQL dari nama kolom / nilai ──────────────────────────────────
function guess_mysql_type(string $col, $val): string {
    // Dari nama kolom
    if (preg_match('/(_at|_date|_time)$/', $col))          return 'DATETIME NULL';
    if (preg_match('/^(is_|has_|can_|allow_)/', $col))     return 'TINYINT(1) NOT NULL DEFAULT 0';
    if (preg_match('/_id$/', $col) && $col !== 'uuid')      return 'BIGINT NULL';

    // Dari nilai
    if ($val === null)                                       return 'TEXT NULL';
    if (is_bool($val))                                      return 'TINYINT(1) NOT NULL DEFAULT 0';
    if (is_int($val))                                       return 'BIGINT NULL';
    if (is_float($val))                                     return 'DECIMAL(15,2) NULL';
    if (is_array($val))                                     return 'JSON NULL';
    if (is_string($val)) {
        if (preg_match('/^\d{4}-\d{2}-\d{2}T/', $val))     return 'DATETIME NULL';
        if (preg_match('/^[0-9a-f-]{36}$/', $val))         return 'CHAR(36) NULL';
        if (strlen($val) > 500)                             return 'TEXT NULL';
        return 'VARCHAR(255) NULL';
    }
    return 'TEXT NULL';
}

// ── Pastikan semua kolom Supabase ada di MySQL (AUTO ALTER TABLE) ──────────────
function ensure_mysql_columns(PDO $pdo, string $table, array $sampleRow, array $existingCols): array {
    foreach ($sampleRow as $col => $val) {
        if (in_array($col, $existingCols, true)) continue;
        $type = guess_mysql_type($col, $val);
        try {
            $pdo->exec("ALTER TABLE `$table` ADD COLUMN `$col` $type");
            $existingCols[] = $col;
        } catch (Exception $e) {
            // Kolom sudah ada (kemungkinan dijalankan ulang) — abaikan
        }
    }
    return $existingCols;
}

// ── Fetch dari Supabase REST API ──────────────────────────────────────────────
// Tanpa ORDER BY — biarkan Supabase pakai urutan default (primary key)
function supabase_fetch(string $url, string $key, string $table, int $offset = 0, int $limit = 1000): array {
    $ch = curl_init();
    $endpoint = rtrim($url, '/') . "/rest/v1/{$table}?select=*&limit={$limit}&offset={$offset}";
    curl_setopt_array($ch, [
        CURLOPT_URL            => $endpoint,
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_HTTPHEADER     => [
            "apikey: $key",
            "Authorization: Bearer $key",
            "Accept: application/json",
            "Range-Unit: items",
            "Prefer: count=none",
        ],
        CURLOPT_TIMEOUT        => 60,
        CURLOPT_SSL_VERIFYPEER => true,
    ]);
    $body   = curl_exec($ch);
    $status = curl_getinfo($ch, CURLINFO_HTTP_CODE);
    $err    = curl_error($ch);
    curl_close($ch);

    if ($err) throw new RuntimeException("cURL error untuk tabel $table: $err");
    if ($status === 404) return [];   // tabel tidak ada di Supabase — skip
    if ($status !== 200) {
        $decoded = json_decode($body, true);
        $msg = $decoded['message'] ?? $decoded['hint'] ?? $body;
        throw new RuntimeException("HTTP $status untuk tabel $table: $msg");
    }
    $result = json_decode($body, true);
    return is_array($result) ? $result : [];
}

// ── Konversi tipe data PostgreSQL → MySQL ─────────────────────────────────────
function convert_row(array $row): array {
    $out = [];
    foreach ($row as $col => $val) {
        if ($val === null) {
            $out[$col] = null;
        } elseif (is_bool($val)) {
            $out[$col] = $val ? 1 : 0;
        } elseif (is_array($val)) {
            // jsonb / array → JSON string
            $out[$col] = json_encode($val, JSON_UNESCAPED_UNICODE);
        } elseif (is_string($val)) {
            // timestamptz: "2024-01-15T10:30:00+07:00" → "2024-01-15 10:30:00"
            if (preg_match('/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/', $val)) {
                $out[$col] = date('Y-m-d H:i:s', strtotime($val));
            } else {
                $out[$col] = $val;
            }
        } else {
            $out[$col] = $val;
        }
    }
    return $out;
}

// ── Insert batch ke MySQL ─────────────────────────────────────────────────────
function insert_batch(PDO $pdo, string $table, array $rows): int {
    if (empty($rows)) return 0;

    // Hapus baris kosong (semua kolom null setelah filter)
    $rows = array_values(array_filter($rows, fn($r) => !empty($r)));
    if (empty($rows)) return 0;

    $cols        = array_keys($rows[0]);
    $colList     = implode(', ', array_map(fn($c) => "`$c`", $cols));
    $placeholder = '(' . implode(', ', array_fill(0, count($cols), '?')) . ')';
    $placeholders = implode(', ', array_fill(0, count($rows), $placeholder));

    $sql = "INSERT IGNORE INTO `$table` ($colList) VALUES $placeholders";
    $stmt = $pdo->prepare($sql);

    $values = [];
    foreach ($rows as $row) {
        foreach ($cols as $col) {
            $values[] = $row[$col] ?? null;
        }
    }

    $stmt->execute($values);
    return $stmt->rowCount();
}

// ── Daftar tabel & urutan insert (sesuai foreign key) ────────────────────────
// Tabel yang tidak ada di Supabase atau memang kosong akan dilewati otomatis.
$TABLES = [
    // Grup 1 — tidak ada dependency
    'branches',
    'product_categories',
    'suppliers',
    'cash_categories',
    'toppings',
    'deposit_accounts',
    'payment_methods',

    // Grup 2 — butuh grup 1
    'users',
    'products',
    'ingredients',
    'api_keys',

    // Grup 3 — butuh grup 2
    'app_sessions',
    'product_variants',
    'branch_products',
    'recipes',
    'investor_branch_access',
    'investor_feature_access',

    // Grup 4 — butuh grup 3
    'branch_variant_prices',
    'recipe_items',
    'branch_inventory',
    'product_toppings',

    // Grup 5 — butuh grup 4
    'cashier_sessions',
    'cash_logs',
    'inventory_logs',
    'staff_cash_balances',
    'branch_cash_balances',

    // Grup 6 — butuh grup 5
    'transactions',
    'stock_transfers',
    'cash_deposits',
    'staff_cash_ledger',
    'branch_cash_ledger',
    'cash_branch_transfers',

    // Grup 7 — butuh grup 6
    'transaction_items',
    'refund_transactions',
    'stock_transfer_items',

    // Grup 8 — butuh grup sebelumnya
    'onboarding_assignments',
    'onboarding_step_completions',
];

// ── Mulai migrasi ─────────────────────────────────────────────────────────────
log_msg("Menonaktifkan foreign key checks sementara...", 'warn');
$pdo->exec("SET FOREIGN_KEY_CHECKS = 0");

$totalRows    = 0;
$totalInserted = 0;

foreach ($TABLES as $table) {
    echo "<hr>";
    log_msg("Tabel: <span class='tbl'>$table</span>", 'info');

    // Ambil kolom MySQL untuk tabel ini
    $mysqlCols = get_mysql_columns($pdo, $table);
    if ($mysqlCols === null) {
        log_msg("  → Tabel tidak ada di MySQL (schema belum diimport?), dilewati.", 'warn');
        continue;
    }

    $offset    = 0;
    $limit     = 1000;
    $tableRows = 0;
    $tableIns  = 0;
    $batchNum  = 0;

    try {
        while (true) {
            $rows = supabase_fetch($SUPABASE_URL, $SUPABASE_KEY, $table, $offset, $limit);

            if (empty($rows)) {
                if ($batchNum === 0) {
                    log_msg("  → Kosong / tidak ada di Supabase, dilewati.", 'warn');
                }
                break;
            }

            // Konversi tipe data
            $converted = array_map('convert_row', $rows);

            // Batch pertama: deteksi kolom baru dan tambahkan ke MySQL otomatis
            if ($batchNum === 0) {
                $supabaseCols = array_keys($converted[0]);
                $missing = array_diff($supabaseCols, $mysqlCols);
                if (!empty($missing)) {
                    log_msg("  Kolom baru ditemukan di Supabase, menambahkan ke MySQL: " . implode(', ', $missing), 'warn');
                    $mysqlCols = ensure_mysql_columns($pdo, $table, $converted[0], $mysqlCols);
                    log_msg("  Kolom berhasil ditambahkan.", 'ok');
                }
            }

            // Sekarang semua kolom ada di MySQL — insert langsung tanpa filter
            $inserted = insert_batch($pdo, $table, $converted);

            $tableRows += count($rows);
            $tableIns  += $inserted;
            $batchNum++;

            log_msg(
                "  Batch $batchNum: " . count($rows) . " baris diambil, $inserted baris dimasukkan" .
                ($inserted < count($rows) ? " (" . (count($rows) - $inserted) . " sudah ada/dilewati)" : ""),
                'ok'
            );

            if (count($rows) < $limit) break; // halaman terakhir
            $offset += $limit;

            usleep(100000); // 0.1 detik jeda antar request
        }

        if ($tableRows > 0) {
            log_msg("  SELESAI: $tableRows baris total, $tableIns baris baru dimasukkan", 'ok');
        }

        $totalRows     += $tableRows;
        $totalInserted += $tableIns;

    } catch (Exception $e) {
        log_msg("  ERROR: " . $e->getMessage(), 'err');
        log_msg("  Tabel ini dilewati, lanjut ke berikutnya.", 'warn');
    }
}

echo "<hr>";
log_msg("Mengaktifkan kembali foreign key checks...", 'warn');
$pdo->exec("SET FOREIGN_KEY_CHECKS = 1");

echo "<hr>";
log_msg("═══════════════════════════════════════════", 'ok');
log_msg("MIGRASI SELESAI!", 'ok');
log_msg("Total baris diproses : $totalRows", 'ok');
log_msg("Total baris dimasukkan: $totalInserted", 'ok');
log_msg("═══════════════════════════════════════════", 'ok');

echo "\n\n";
echo '<span class="err">⚠️  PENTING: Hapus file migrate_from_supabase.php dari hosting sekarang!</span>';
echo "\n";
echo '<span class="warn">File ini bisa dipakai siapa saja jika tidak dihapus.</span>';

echo '</pre></body></html>';
