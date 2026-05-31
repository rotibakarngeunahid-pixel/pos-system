<?php
// ══════════════════════════════════════════════════════════════
// config.php — Konfigurasi Database cPanel
// Credential dibaca dari file .env di root project (TIDAK di-commit ke Git).
// Salin .env.example → .env lalu isi nilai asli di server.
// ══════════════════════════════════════════════════════════════

// ── Muat .env dari root project ──────────────────────────────────────────────
(function() {
    $envFile = dirname(__DIR__) . '/.env';
    if (!file_exists($envFile)) return;
    $lines = file($envFile, FILE_IGNORE_NEW_LINES | FILE_SKIP_EMPTY_LINES);
    foreach ($lines as $line) {
        $line = trim($line);
        if ($line === '' || $line[0] === '#') continue;
        if (strpos($line, '=') === false) continue;
        [$key, $val] = explode('=', $line, 2);
        $key = trim($key);
        $val = trim($val);
        // Hapus kutip pembungkus jika ada
        if (strlen($val) >= 2 && (($val[0] === '"' && $val[-1] === '"') || ($val[0] === "'" && $val[-1] === "'"))) {
            $val = substr($val, 1, -1);
        }
        if ($key !== '') putenv("$key=$val");
    }
})();

define('DB_HOST',        getenv('DB_HOST')        ?: 'localhost');
define('DB_NAME',        getenv('DB_NAME')        ?: '');
define('DB_USER',        getenv('DB_USER')        ?: '');
define('DB_PASS',        getenv('DB_PASS')        ?: '');
define('DB_CHARSET',     'utf8mb4');
define('API_SECRET_KEY', getenv('API_SECRET_KEY') ?: '');
define('SITE_URL',       getenv('SITE_URL')       ?: 'https://pos.rotibakarngeunah.my.id');

// Domain frontend yang boleh akses API ini
define('ALLOWED_ORIGINS', [
    'https://rotibakarngeunah.my.id',
    'https://www.rotibakarngeunah.my.id',
    'http://pos.rotibakarngeunah.my.id',
    'https://pos.rotibakarngeunah.my.id',
    'https://pos-system.rotibakarngeunah.my.id',
    'http://localhost',
    'http://127.0.0.1',
]);

// Pola domain tambahan (misal Vercel preview URL)
define('ALLOWED_ORIGIN_PATTERNS', [
    '/^https:\/\/[a-zA-Z0-9\-]+\.vercel\.app$/',
]);

function isOriginAllowed(string $origin): bool {
    if (in_array($origin, ALLOWED_ORIGINS, true)) return true;
    $parts = parse_url($origin);
    if ($parts) {
        $scheme = $parts['scheme'] ?? '';
        $host   = trim($parts['host'] ?? '', '[]');
        if (in_array($scheme, ['http', 'https'], true) && in_array($host, ['localhost', '127.0.0.1', '::1'], true)) {
            return true;
        }
    }
    foreach (ALLOWED_ORIGIN_PATTERNS as $pattern) {
        if (preg_match($pattern, $origin)) return true;
    }
    return false;
}

// Gunakan WITA (UTC+8) di PHP agar konsisten dengan data di MySQL.
date_default_timezone_set('Asia/Makassar');

// Koneksi PDO (jangan diubah)
function getDB(): PDO {
    static $pdo = null;
    if ($pdo === null) {
        $dsn = 'mysql:host=' . DB_HOST . ';dbname=' . DB_NAME . ';charset=' . DB_CHARSET;
        $pdo = new PDO($dsn, DB_USER, DB_PASS, [
            PDO::ATTR_ERRMODE            => PDO::ERRMODE_EXCEPTION,
            PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC,
            PDO::ATTR_EMULATE_PREPARES   => false,
        ]);
        $pdo->exec("SET time_zone = '+08:00'");
    }
    return $pdo;
}
