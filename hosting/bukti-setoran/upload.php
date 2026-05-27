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
// Harus sama persis dengan DEPOSIT_UPLOAD_SECRET di depositService.js
define('UPLOAD_SECRET', '78998219380f85802eb86a9b4f2d3f6f');

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

define('PUBLIC_DIR_MODE', 0755);
define('PUBLIC_FILE_MODE', 0644);

function respondError(int $status, string $message): void
{
    http_response_code($status);
    echo json_encode(['error' => $message]);
    exit;
}

function ensurePublicUploadDirectory(string $dir): void
{
    if (!is_dir($dir)) {
        if (!mkdir($dir, PUBLIC_DIR_MODE, true) && !is_dir($dir)) {
            respondError(500, 'Gagal membuat folder penyimpanan');
        }
    }

    @chmod($dir, PUBLIC_DIR_MODE);
    clearstatcache(true, $dir);

    if (!is_dir($dir) || !is_writable($dir)) {
        respondError(500, 'Folder penyimpanan tidak dapat ditulis');
    }
}

function normalizeExistingUploadRules(): void
{
    foreach ([__DIR__ . '/.htaccess', UPLOAD_DIR . '.htaccess'] as $rulesFile) {
        if (is_file($rulesFile)) {
            @chmod($rulesFile, PUBLIC_FILE_MODE);
        }
    }
}

function repairProofPermissions(): array
{
    $summary = [
        'ok' => true,
        'directories' => 0,
        'files' => 0,
        'skipped' => 0,
        'errors' => [],
    ];

    ensurePublicUploadDirectory(UPLOAD_DIR);
    normalizeExistingUploadRules();

    try {
        $iterator = new RecursiveIteratorIterator(
            new RecursiveDirectoryIterator(UPLOAD_DIR, FilesystemIterator::SKIP_DOTS),
            RecursiveIteratorIterator::SELF_FIRST
        );

        foreach ($iterator as $item) {
            $path = $item->getPathname();

            if ($item->isDir()) {
                if (@chmod($path, PUBLIC_DIR_MODE)) {
                    $summary['directories']++;
                } else {
                    $summary['errors'][] = $path;
                }
                continue;
            }

            $baseName = $item->getBasename();
            $ext = strtolower(pathinfo($path, PATHINFO_EXTENSION));
            if ($baseName === '.htaccess' || in_array($ext, ALLOWED_EXT, true)) {
                if (@chmod($path, PUBLIC_FILE_MODE)) {
                    $summary['files']++;
                } else {
                    $summary['errors'][] = $path;
                }
            } else {
                $summary['skipped']++;
            }
        }
    } catch (Throwable $e) {
        $summary['errors'][] = $e->getMessage();
    }

    $summary['ok'] = count($summary['errors']) === 0;
    return $summary;
}
// ─────────────────────────────────────────────────────────────────────────────

// ── CORS ─────────────────────────────────────────────────────────────────────
$allowedOrigins = [
    'https://rotibakarngeunah.my.id',
    'https://www.rotibakarngeunah.my.id',
    'https://pos-rbngeunah.vercel.app',
];

$origin = $_SERVER['HTTP_ORIGIN'] ?? '';
if (in_array($origin, $allowedOrigins, true)) {
    header("Access-Control-Allow-Origin: $origin");
} else {
    http_response_code(403);
    echo json_encode(['error' => 'Origin tidak diizinkan: ' . $origin]);
    exit;
}
header('Access-Control-Allow-Methods: POST, OPTIONS');
header('Access-Control-Allow-Headers: Content-Type, X-Upload-Secret');
header('Content-Type: application/json; charset=utf-8');
// ─────────────────────────────────────────────────────────────────────────────

// Preflight OPTIONS
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
$secret = $_SERVER['HTTP_X_UPLOAD_SECRET'] ?? '';
if (!hash_equals(UPLOAD_SECRET, $secret)) {
    http_response_code(401);
    echo json_encode(['error' => 'Unauthorized']);
    exit;
}

if (($_POST['action'] ?? '') === 'repair_permissions') {
    echo json_encode(repairProofPermissions());
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

// ── Tentukan ekstensi berdasarkan MIME ───────────────────────────────────────
$extMap = [
    'image/jpeg'      => 'jpg',
    'image/png'       => 'png',
    'application/pdf' => 'pdf',
];
$ext = $extMap[$mimeType];

// ── Ambil branchId dari form ──────────────────────────────────────────────────
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
ensurePublicUploadDirectory(UPLOAD_DIR);
ensurePublicUploadDirectory($subDir);
normalizeExistingUploadRules();

// ── Pindahkan file dari tmp ───────────────────────────────────────────────────
if (!move_uploaded_file($file['tmp_name'], $destPath)) {
    http_response_code(500);
    echo json_encode(['error' => 'Gagal menyimpan file']);
    exit;
}
@chmod($destPath, PUBLIC_FILE_MODE);

// ── Berhasil ──────────────────────────────────────────────────────────────────
$publicUrl    = BASE_URL . $branchId . '/' . rawurlencode($fileName);
$uploadedAt   = gmdate('Y-m-d\TH:i:s\Z');
$originalName = basename($file['name'] ?? $fileName);

echo json_encode([
    'url'        => $publicUrl,
    'path'       => $relativePath,
    'fileName'   => $originalName,
    'fileType'   => $mimeType,
    'fileSize'   => $file['size'],
    'uploadedAt' => $uploadedAt,
]);
