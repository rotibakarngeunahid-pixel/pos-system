<?php
// ── upload.php — File upload endpoint untuk gambar produk & QRIS ──────────────
// Menerima multipart/form-data dengan field 'file' dan 'folder'
// Mengembalikan JSON { success, url } atau { success:false, error }
// ─────────────────────────────────────────────────────────────────────────────

require_once __DIR__ . '/config.php';

function uploadPublicBaseUrl(): string {
    if (defined('UPLOADS_BASE_URL') && UPLOADS_BASE_URL !== '') {
        return UPLOADS_BASE_URL;
    }

    $host = $_SERVER['HTTP_X_FORWARDED_HOST'] ?? ($_SERVER['HTTP_HOST'] ?? '');
    $host = trim(explode(',', (string)$host)[0]);

    $proto = $_SERVER['HTTP_X_FORWARDED_PROTO'] ?? null;
    if (!$proto) {
        $isLocalHost = preg_match('/^(localhost|127\.0\.0\.1|\[?::1\]?)(:\d+)?$/', $host) === 1;
        $proto = (!empty($_SERVER['HTTPS']) && $_SERVER['HTTPS'] !== 'off') || !$isLocalHost ? 'https' : 'http';
    }
    $proto = strtolower(explode(',', (string)$proto)[0]);
    if (!in_array($proto, ['http', 'https'], true)) $proto = 'https';

    if ($host !== '') {
        return $proto . '://' . $host;
    }

    return rtrim(SITE_URL, '/');
}

// ── CORS ──────────────────────────────────────────────────────────────────────
$origin = $_SERVER['HTTP_ORIGIN'] ?? '';
if (function_exists('isOriginAllowed') && isOriginAllowed($origin)) {
    header('Access-Control-Allow-Origin: ' . $origin);
}
// Jika origin tidak diizinkan, tidak kirim CORS header — browser akan menolak otomatis.
header('Access-Control-Allow-Methods: POST, OPTIONS');
header('Access-Control-Allow-Headers: Content-Type, X-API-Key');
header('Content-Type: application/json; charset=utf-8');

if ($_SERVER['REQUEST_METHOD'] === 'OPTIONS') { http_response_code(204); exit; }

// ── Auth ──────────────────────────────────────────────────────────────────────
$apiKey = $_SERVER['HTTP_X_API_KEY'] ?? '';
if ($apiKey !== API_SECRET_KEY) {
    http_response_code(401);
    echo json_encode(['success' => false, 'error' => 'Unauthorized']);
    exit;
}

if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
    http_response_code(405);
    echo json_encode(['success' => false, 'error' => 'Method not allowed']);
    exit;
}

// ── Validasi folder ───────────────────────────────────────────────────────────
$folder = $_POST['folder'] ?? 'products';
$allowed_folders = ['products', 'qris', 'bukti_setoran'];
if (!in_array($folder, $allowed_folders, true)) {
    http_response_code(400);
    echo json_encode(['success' => false, 'error' => 'Folder tidak valid']);
    exit;
}

// ── Validasi file ─────────────────────────────────────────────────────────────
if (empty($_FILES['file']) || $_FILES['file']['error'] !== UPLOAD_ERR_OK) {
    $errCode = $_FILES['file']['error'] ?? -1;
    http_response_code(400);
    echo json_encode(['success' => false, 'error' => 'File tidak ditemukan atau gagal diupload (kode: ' . $errCode . ')']);
    exit;
}

$file = $_FILES['file'];

// Batas ukuran: 2MB untuk produk, 5MB untuk qris dan bukti setoran
$maxSize = ($folder === 'products') ? 2 * 1024 * 1024 : 5 * 1024 * 1024;

// Tipe file yang diizinkan per folder
$isDepositFolder = ($folder === 'bukti_setoran');
$allowed_types   = $isDepositFolder
    ? ['image/jpeg', 'image/png', 'application/pdf']
    : ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];

if ($file['size'] > $maxSize) {
    http_response_code(400);
    echo json_encode(['success' => false, 'error' => 'Ukuran file melebihi batas (' . ($maxSize / 1024 / 1024) . ' MB)']);
    exit;
}

// Cek MIME type dari file itu sendiri (bukan dari ekstensi)
$finfo    = new finfo(FILEINFO_MIME_TYPE);
$mimeType = $finfo->file($file['tmp_name']);
if (!in_array($mimeType, $allowed_types, true)) {
    $allowed_label = $isDepositFolder ? 'JPG, PNG, atau PDF' : 'JPG, PNG, WEBP, atau GIF';
    http_response_code(400);
    echo json_encode(['success' => false, 'error' => 'Tipe file tidak diizinkan. Gunakan ' . $allowed_label . '.']);
    exit;
}

// ── Tentukan ekstensi ─────────────────────────────────────────────────────────
$extMap = [
    'image/jpeg'      => 'jpg',
    'image/png'       => 'png',
    'image/webp'      => 'webp',
    'image/gif'       => 'gif',
    'application/pdf' => 'pdf',
];
$ext = $extMap[$mimeType] ?? 'jpg';

// ── Buat direktori tujuan ─────────────────────────────────────────────────────
// Struktur: [web root]/uploads/products/ atau [web root]/uploads/qris/
$uploadBase = dirname(__DIR__) . '/uploads';
$uploadDir  = $uploadBase . '/' . $folder;

if (!is_dir($uploadBase) && !mkdir($uploadBase, 0755, true)) {
    http_response_code(500);
    echo json_encode(['success' => false, 'error' => 'Gagal membuat direktori upload']);
    exit;
}

if (!is_dir($uploadDir) && !mkdir($uploadDir, 0755, true)) {
    http_response_code(500);
    echo json_encode(['success' => false, 'error' => 'Gagal membuat direktori upload']);
    exit;
}

// Buat .htaccess agar file gambar bisa diakses publik tapi PHP diblokir.
// Gunakan <FilesMatch> bukan php_flag karena php_flag tidak didukung PHP-FPM.
$htaccessPath = $uploadBase . '/.htaccess';
$htaccessContent = "Options -Indexes\n<FilesMatch \"\\.(php[s3-9]?|phtml)$\">\n    deny from all\n</FilesMatch>\n";
if (!is_file($htaccessPath) || strpos(file_get_contents($htaccessPath), 'php_flag') !== false) {
    file_put_contents($htaccessPath, $htaccessContent);
}

// ── Simpan file ───────────────────────────────────────────────────────────────
$filename  = date('Ymd') . '_' . bin2hex(random_bytes(8)) . '.' . $ext;
$destPath  = $uploadDir . '/' . $filename;

if (!move_uploaded_file($file['tmp_name'], $destPath)) {
    http_response_code(500);
    echo json_encode(['success' => false, 'error' => 'Gagal menyimpan file']);
    exit;
}

// ── Return URL ────────────────────────────────────────────────────────────────
$siteUrl  = uploadPublicBaseUrl();
$fileUrl  = $siteUrl . '/uploads/' . $folder . '/' . $filename;
$filePath = $folder . '/' . $filename;

echo json_encode([
    'success'    => true,
    'url'        => $fileUrl,
    'path'       => $filePath,
    'fileName'   => $filename,
    'fileType'   => $mimeType,
    'fileSize'   => $file['size'],
    'uploadedAt' => date('c'),
]);
