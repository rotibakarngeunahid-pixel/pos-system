<?php
/**
 * upload.php — Endpoint upload bukti setoran
 * Domain  : https://bukti-setoran.rotibakarngeunah.my.id
 * Folder  : /public_html/bukti-setoran.rotibakarngeunah.my.id/
 *
 * Cara kerja:
 *   POST multipart/form-data  →  field "file"
 *   Response: JSON { url, path, fileName, fileType, fileSize, uploadedAt }
 */

declare(strict_types=1);

// ── Konfigurasi ──────────────────────────────────────────────────────────────
define('SUPABASE_URL', getenv('SUPABASE_URL') ?: 'https://mcrhlwqmeccighmxmccz.supabase.co');
define('SUPABASE_ANON_KEY', getenv('SUPABASE_ANON_KEY') ?: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im1jcmhsd3FtZWNjaWdobXhtY2N6Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzcxODMwNzAsImV4cCI6MjA5Mjc1OTA3MH0.XBe3IxqnI3TLMNF05UyA_kuo0EnQP7zWdQeGKltmXys');

// Ukuran maks upload (5 MB)
define('MAX_FILE_SIZE', 5 * 1024 * 1024);

// Tipe MIME yang diizinkan
const ALLOWED_MIME = ['image/jpeg', 'image/png', 'application/pdf'];

// Ekstensi yang diizinkan
const ALLOWED_EXT  = ['jpg', 'jpeg', 'png', 'pdf'];

// Folder penyimpanan relatif terhadap upload.php
define('UPLOAD_DIR', __DIR__ . '/proofs/');

// Base URL publik folder proofs
define('BASE_URL', 'https://bukti-setoran.rotibakarngeunah.my.id/proofs/');
// ─────────────────────────────────────────────────────────────────────────────

// CORS — izinkan dari domain app Anda saja
$allowedOrigins = [
    'https://rotibakarngeunah.my.id',
    'https://www.rotibakarngeunah.my.id',
    // Tambahkan domain lain jika perlu, misal: 'https://pos.rotibakarngeunah.my.id'
];

$origin = $_SERVER['HTTP_ORIGIN'] ?? '';
if (in_array($origin, $allowedOrigins, true)) {
    header("Access-Control-Allow-Origin: $origin");
} else {
    // Fallback untuk development lokal — hapus baris ini di production
    header('Access-Control-Allow-Origin: *');
}
header('Access-Control-Allow-Methods: POST, OPTIONS');
header('Access-Control-Allow-Headers: Content-Type, Authorization');
header('Content-Type: application/json; charset=utf-8');

// Preflight
if ($_SERVER['REQUEST_METHOD'] === 'OPTIONS') {
    http_response_code(204);
    exit;
}

// Hanya terima POST
if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
    http_response_code(405);
    echo json_encode(['error' => 'Method not allowed']);
    exit;
}

// ── Verifikasi secret key ────────────────────────────────────────────────────
function getAuthorizationHeader(): string
{
    if (!empty($_SERVER['HTTP_AUTHORIZATION'])) {
        return (string) $_SERVER['HTTP_AUTHORIZATION'];
    }
    if (!empty($_SERVER['REDIRECT_HTTP_AUTHORIZATION'])) {
        return (string) $_SERVER['REDIRECT_HTTP_AUTHORIZATION'];
    }
    if (function_exists('getallheaders')) {
        foreach (getallheaders() as $name => $value) {
            if (strtolower((string) $name) === 'authorization') {
                return (string) $value;
            }
        }
    }
    return '';
}

function getBearerToken(): string
{
    $header = getAuthorizationHeader();
    if (preg_match('/^Bearer\s+(.+)$/i', $header, $matches)) {
        return trim($matches[1]);
    }
    return '';
}

function validateSessionToken(string $sessionToken): ?array
{
    if ($sessionToken === '') {
        return null;
    }

    $url = rtrim(SUPABASE_URL, '/') . '/rest/v1/rpc/rbn_validate_session';
    $payload = json_encode(['p_session_token' => $sessionToken], JSON_UNESCAPED_SLASHES);
    $headers = [
        'Content-Type: application/json',
        'apikey: ' . SUPABASE_ANON_KEY,
        'Authorization: Bearer ' . SUPABASE_ANON_KEY,
    ];

    if (function_exists('curl_init')) {
        $ch = curl_init($url);
        curl_setopt_array($ch, [
            CURLOPT_POST           => true,
            CURLOPT_POSTFIELDS     => $payload,
            CURLOPT_HTTPHEADER     => $headers,
            CURLOPT_RETURNTRANSFER => true,
            CURLOPT_TIMEOUT        => 10,
        ]);
        $body = curl_exec($ch);
        $status = (int) curl_getinfo($ch, CURLINFO_HTTP_CODE);
        $curlError = curl_error($ch);
        curl_close($ch);

        if ($body === false) {
            throw new RuntimeException($curlError ?: 'Supabase request failed');
        }
    } else {
        $context = stream_context_create([
            'http' => [
                'method'        => 'POST',
                'header'        => implode("\r\n", $headers),
                'content'       => $payload,
                'ignore_errors' => true,
                'timeout'       => 10,
            ],
        ]);
        $body = file_get_contents($url, false, $context);
        $status = 0;
        foreach ($http_response_header ?? [] as $line) {
            if (preg_match('#^HTTP/\S+\s+(\d{3})#', $line, $matches)) {
                $status = (int) $matches[1];
                break;
            }
        }
        if ($body === false) {
            throw new RuntimeException('Supabase request failed');
        }
    }

    if ($status < 200 || $status >= 300) {
        throw new RuntimeException('Supabase HTTP ' . $status);
    }

    $data = json_decode((string) $body, true);
    if (json_last_error() !== JSON_ERROR_NONE) {
        throw new RuntimeException('Invalid Supabase JSON response');
    }

    return is_array($data) && !empty($data['id']) ? $data : null;
}

try {
    $session = validateSessionToken(getBearerToken());
} catch (Throwable $err) {
    http_response_code(502);
    echo json_encode(['error' => 'Gagal memvalidasi sesi upload']);
    exit;
}

if (!$session) {
    http_response_code(401);
    echo json_encode(['error' => 'Sesi login tidak valid atau sudah kedaluwarsa']);
    exit;
}

// ── Cek file ada ─────────────────────────────────────────────────────────────
if (empty($_FILES['file']) || $_FILES['file']['error'] === UPLOAD_ERR_NO_FILE) {
    http_response_code(400);
    echo json_encode(['error' => 'Tidak ada file yang dikirim']);
    exit;
}

$file = $_FILES['file'];

// Error upload dari PHP
if ($file['error'] !== UPLOAD_ERR_OK) {
    http_response_code(400);
    echo json_encode(['error' => 'Upload error code: ' . $file['error']]);
    exit;
}

// ── Validasi ukuran ──────────────────────────────────────────────────────────
if ($file['size'] <= 0 || $file['size'] > MAX_FILE_SIZE) {
    http_response_code(400);
    echo json_encode(['error' => 'Ukuran file tidak valid (maks 5 MB)']);
    exit;
}

// ── Validasi MIME (finfo — tidak mengandalkan ekstensi dari client) ───────────
$finfo    = new finfo(FILEINFO_MIME_TYPE);
$mimeType = $finfo->file($file['tmp_name']);

if (!in_array($mimeType, ALLOWED_MIME, true)) {
    http_response_code(400);
    echo json_encode(['error' => 'Tipe file tidak diizinkan. Hanya JPG, PNG, atau PDF.']);
    exit;
}

// ── Tentukan ekstensi berdasarkan MIME (aman, bukan dari client) ─────────────
$extMap = [
    'image/jpeg'      => 'jpg',
    'image/png'       => 'png',
    'application/pdf' => 'pdf',
];
$ext = $extMap[$mimeType];

// ── Ambil branchId dari form (opsional, untuk pengelompokan folder) ──────────
$branchId = preg_replace('/[^a-z0-9_\-]/i', '', $_POST['branch_id'] ?? 'global');
if ($branchId === '') $branchId = 'global';

// ── Buat nama file acak ───────────────────────────────────────────────────────
$randomPart = bin2hex(random_bytes(10));
$timestamp  = time();
$fileName   = "{$timestamp}-{$randomPart}.{$ext}";
$subDir     = UPLOAD_DIR . $branchId . '/';
$destPath   = $subDir . $fileName;
$relativePath = $branchId . '/' . $fileName;

// ── Buat folder jika belum ada ───────────────────────────────────────────────
if (!is_dir($subDir)) {
    if (!mkdir($subDir, 0750, true)) {
        http_response_code(500);
        echo json_encode(['error' => 'Gagal membuat folder penyimpanan']);
        exit;
    }
}

// ── Pindahkan file dari tmp ───────────────────────────────────────────────────
if (!move_uploaded_file($file['tmp_name'], $destPath)) {
    http_response_code(500);
    echo json_encode(['error' => 'Gagal menyimpan file']);
    exit;
}

// ── Berhasil — kembalikan data ────────────────────────────────────────────────
$publicUrl   = BASE_URL . $branchId . '/' . rawurlencode($fileName);
$uploadedAt  = gmdate('Y-m-d\TH:i:s\Z');
$originalName = basename($file['name'] ?? $fileName);

echo json_encode([
    'url'        => $publicUrl,
    'path'       => $relativePath,
    'fileName'   => $originalName,
    'fileType'   => $mimeType,
    'fileSize'   => $file['size'],
    'uploadedAt' => $uploadedAt,
]);
