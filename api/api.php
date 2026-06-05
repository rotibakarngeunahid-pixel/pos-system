<?php
// ══════════════════════════════════════════════════════════════════════════════
// api.php — RBN POS REST API untuk cPanel/MySQL
// ══════════════════════════════════════════════════════════════════════════════
declare(strict_types=1);

// Tangkap semua output stray (PHP notices/warnings) agar tidak merusak JSON
ob_start();

require_once __DIR__ . '/config.php';

class ApiHttpException extends Exception {
    public int $status;
    public string $apiCode;

    public function __construct(int $status, string $message, string $apiCode = 'ERROR') {
        parent::__construct($message);
        $this->status = $status;
        $this->apiCode = $apiCode;
    }
}

// Handler error global — semua PHP error → JSON
set_exception_handler(function(Throwable $e) {
    ob_clean();
    $status = ($e instanceof ApiHttpException) ? $e->status : 500;
    $code   = ($e instanceof ApiHttpException) ? $e->apiCode : 'SERVER_ERROR';
    http_response_code($status);
    header('Content-Type: application/json; charset=utf-8');
    echo json_encode(['error' => ['message' => $status >= 500 ? 'Terjadi kesalahan server' : $e->getMessage(), 'code' => $code]]);
    exit;
});
set_error_handler(function(int $errno, string $errstr) {
    // Abaikan notice/warning — jangan sampai merusak JSON
    return true;
});

// ── CORS ─────────────────────────────────────────────────────────────────────
$origin = $_SERVER['HTTP_ORIGIN'] ?? '';
if (isOriginAllowed($origin)) {
    header("Access-Control-Allow-Origin: $origin");
}
// Jika origin tidak diizinkan, tidak kirim CORS header — browser akan menolak otomatis.
header('Access-Control-Allow-Methods: GET, POST, PATCH, PUT, DELETE, OPTIONS');
header('Access-Control-Allow-Headers: Content-Type, X-API-Key, X-Session-Token, X-Member-Session-Token, Authorization');
header('Content-Type: application/json; charset=utf-8');

if ($_SERVER['REQUEST_METHOD'] === 'OPTIONS') { http_response_code(204); exit; }

// ── Auth ──────────────────────────────────────────────────────────────────────
$apiKey = $_SERVER['HTTP_X_API_KEY'] ?? $_SERVER['HTTP_AUTHORIZATION'] ?? '';
$apiKey = str_replace('Bearer ', '', $apiKey);
if ($apiKey !== API_SECRET_KEY) {
    http_response_code(401);
    echo json_encode(['error' => ['message' => 'Unauthorized', 'code' => '401']]);
    exit;
}

// ── Router ────────────────────────────────────────────────────────────────────
$method  = $_SERVER['REQUEST_METHOD'];
$uri     = parse_url($_SERVER['REQUEST_URI'], PHP_URL_PATH);
$uri     = rtrim(preg_replace('#^.*?/api\.php#', '', $uri), '/');
$parts   = array_values(array_filter(explode('/', $uri)));
$rawBody = file_get_contents('php://input');
$body    = $rawBody !== '' ? json_decode($rawBody, true) : [];
if (!is_array($body)) $body = [];
$params  = parseQueryParamsPreserveDots($_SERVER['QUERY_STRING'] ?? '');

// /rpc/function_name
// Merge query-string params + JSON body agar RPC bisa dipanggil via GET maupun POST
if (isset($parts[0]) && $parts[0] === 'rpc' && isset($parts[1])) {
    handleRpc($parts[1], array_merge($params, $body));
    exit;
}

// /table_name
$table = $parts[0] ?? null;
if (!$table) { respond(400, ['error' => ['message' => 'Table tidak ditemukan']]); }

// whitelist tabel
$allowedTables = [
    'branches','users','products','product_variants','product_categories',
    'branch_products','branch_variant_prices','payment_methods',
    'cashier_sessions','transactions','transaction_items','refund_transactions',
    'cash_categories','cash_logs','ingredients','suppliers',
    'recipes','recipe_items','branch_inventory','inventory_logs',
    'stock_transfers','stock_transfer_items',
    'investor_branch_access','investor_feature_access',
    'deposit_accounts','cash_deposits',
    'staff_cash_balances','staff_cash_ledger',
    'branch_cash_balances','branch_cash_ledger',
    'cash_branch_transfers','toppings','product_toppings','api_keys',
    'onboarding_assignments','onboarding_step_completions','app_sessions',
    'cash_session_adjustments','branch_ingredient_assignments','audit_logs',
    // PO sync integration tables
    'po_outlet_branch_mappings','po_material_pos_mappings','po_ignored_materials',
    'po_stock_sync_runs','po_stock_sync_items','po_stock_sync_errors',
    // Member & Loyalty (migration 064) — write ke ledger/sessions diblok di authorizeTableRequest
    'members','member_sessions','member_point_ledger','member_rewards',
    'member_reward_claims','member_fraud_flags','member_settings',
];
if (!in_array($table, $allowedTables, true)) {
    respond(400, ['error' => ['message' => "Tabel '$table' tidak diizinkan"]]);
}

try {
    [$params, $body] = authorizeTableRequest($table, $method, $params, $body);
} catch (ApiHttpException $e) {
    respond($e->status, ['error' => ['message' => $e->getMessage(), 'code' => $e->apiCode]]);
}

switch ($method) {
    case 'GET':    handleSelect($table, $params); break;
    case 'POST':   handleInsert($table, $body, $params); break;
    case 'PATCH':  handleUpdate($table, $body, $params); break;
    case 'PUT':    handleUpsert($table, $body, $params); break;
    case 'DELETE': handleDelete($table, $params); break;
    default: respond(405, ['error' => ['message' => 'Method not allowed']]);
}

// ══════════════════════════════════════════════════════════════════════════════
// TABLE CRUD HANDLERS
// ══════════════════════════════════════════════════════════════════════════════

function denyHttp(int $status, string $message, string $code = 'FORBIDDEN'): void {
    throw new ApiHttpException($status, $message, $code);
}

function requestIp(): string {
    $forwarded = $_SERVER['HTTP_X_FORWARDED_FOR'] ?? '';
    if ($forwarded) {
        $first = trim(explode(',', $forwarded)[0]);
        if ($first !== '') return substr($first, 0, 45);
    }
    return substr((string)($_SERVER['REMOTE_ADDR'] ?? 'unknown'), 0, 45);
}

function requestSessionToken(array $params = []): string {
    $token = trim((string)($_SERVER['HTTP_X_SESSION_TOKEN'] ?? ''));
    if ($token === '') $token = trim((string)($params['p_session_token'] ?? $params['session_token'] ?? ''));
    $auth = trim((string)($_SERVER['HTTP_AUTHORIZATION'] ?? ''));
    if ($token === '' && str_starts_with(strtolower($auth), 'session ')) {
        $token = trim(substr($auth, 8));
    }
    return $token;
}

function currentSessionUser(array $params = []): ?array {
    static $cache = [];
    $token = requestSessionToken($params);
    if ($token === '' || strlen($token) < 32 || strlen($token) > 256) return null;

    $hash = hash('sha256', $token);
    if (array_key_exists($hash, $cache)) return $cache[$hash];

    $pdo = getDB();
    $stmt = $pdo->prepare("
        SELECT u.id,u.name,u.role,u.branch_id,u.is_active,s.expires_at
        FROM app_sessions s
        JOIN users u ON u.id = s.user_id
        WHERE s.token_hash = ?
          AND s.expires_at > NOW()
          AND COALESCE(u.is_active,1)=1
        LIMIT 1
    ");
    $stmt->execute([$hash]);
    $row = $stmt->fetch();
    if (!$row) {
        $cache[$hash] = null;
        return null;
    }

    try { $pdo->prepare("UPDATE app_sessions SET last_seen_at = NOW() WHERE token_hash = ?")->execute([$hash]); } catch (Throwable) {}
    $cache[$hash] = [
        'id'        => (int)$row['id'],
        'name'      => $row['name'],
        'role'      => $row['role'],
        'branch_id' => $row['branch_id'] !== null ? (int)$row['branch_id'] : null,
        'is_active' => (bool)(int)($row['is_active'] ?? 1),
    ];
    return $cache[$hash];
}

function requireSessionUser(array $params = [], ?array $roles = null): array {
    $user = currentSessionUser($params);
    if (!$user) denyHttp(401, 'Session tidak valid atau sudah kedaluwarsa', 'SESSION_INVALID');
    if ($roles && !in_array($user['role'], $roles, true)) {
        denyHttp(403, 'Akses ditolak', 'FORBIDDEN');
    }
    return $user;
}

function isAdminUser(array $user): bool {
    return in_array($user['role'] ?? '', ['admin','owner'], true);
}

function userCanAccessBranch(array $user, int $branchId): bool {
    if (!$branchId) return false;
    if (isAdminUser($user)) return true;
    if (($user['role'] ?? '') === 'staff') {
        return empty($user['branch_id']) || (int)$user['branch_id'] === $branchId;
    }
    return false;
}

function requireBranchAccess(array $user, int $branchId): void {
    if (!userCanAccessBranch($user, $branchId)) {
        denyHttp(403, 'Anda tidak memiliki akses ke cabang ini', 'BRANCH_FORBIDDEN');
    }
}

function extractEqParam(array $params, string $column): mixed {
    if (!array_key_exists($column, $params)) return null;
    $expr = is_array($params[$column]) ? ($params[$column][0] ?? null) : $params[$column];
    if (!is_string($expr) || !str_starts_with($expr, 'eq.')) return null;
    return substr($expr, 3);
}

function forceEqParam(array $params, string $column, int|string $value): array {
    $expected = (string)$value;
    if (array_key_exists($column, $params)) {
        $exprs = is_array($params[$column]) ? $params[$column] : [$params[$column]];
        foreach ($exprs as $expr) {
            if (!is_string($expr) || !str_starts_with($expr, 'eq.') || (string)normalizeSqlValue(substr($expr, 3)) !== $expected) {
                denyHttp(403, 'Filter akses tidak valid', 'SCOPE_FORBIDDEN');
            }
        }
    }
    $params[$column] = 'eq.' . $expected;
    return $params;
}

function rateLimitAction(string $action, int $limit, int $windowSeconds, ?string $identity = null): void {
    try {
        $pdo = getDB();
        if (!dbColumnExists($pdo, 'api_rate_limits', 'action_key')) return;
        $identity = substr($identity ?: requestIp(), 0, 128);
        $action   = substr($action, 0, 80);
        $since    = date('Y-m-d H:i:s', time() - $windowSeconds);
        $stmt = $pdo->prepare("
            SELECT COUNT(*) FROM api_rate_limits
            WHERE action_key = ? AND identity_key = ? AND created_at >= ?
        ");
        $stmt->execute([$action, $identity, $since]);
        if ((int)$stmt->fetchColumn() >= $limit) {
            denyHttp(429, 'Terlalu banyak request. Coba lagi beberapa saat.', 'RATE_LIMITED');
        }
        $pdo->prepare("INSERT INTO api_rate_limits (action_key,identity_key,ip_address) VALUES (?,?,?)")
            ->execute([$action, $identity, requestIp()]);
        if (mt_rand(1, 50) === 1) {
            $pdo->exec("DELETE FROM api_rate_limits WHERE created_at < DATE_SUB(NOW(), INTERVAL 1 DAY) LIMIT 1000");
        }
    } catch (ApiHttpException $e) {
        throw $e;
    } catch (Throwable) {
        // Rate limit table is added by migration 061; older DBs should keep running.
    }
}

function auditLog(?array $user, string $action, ?string $tableName = null, mixed $oldData = null, mixed $newData = null, ?int $branchId = null): void {
    try {
        $pdo = getDB();
        if (!dbColumnExists($pdo, 'audit_logs', 'action')) return;
        $stmt = $pdo->prepare("
            INSERT INTO audit_logs
              (user_id,user_name,user_role,branch_id,action,table_name,old_data,new_data,ip_address,user_agent)
            VALUES (?,?,?,?,?,?,?,?,?,?)
        ");
        $stmt->execute([
            $user['id'] ?? null,
            $user['name'] ?? null,
            $user['role'] ?? null,
            $branchId,
            substr($action, 0, 100),
            $tableName,
            $oldData === null ? null : json_encode($oldData, JSON_UNESCAPED_UNICODE | JSON_PARTIAL_OUTPUT_ON_ERROR),
            $newData === null ? null : json_encode($newData, JSON_UNESCAPED_UNICODE | JSON_PARTIAL_OUTPUT_ON_ERROR),
            requestIp(),
            substr((string)($_SERVER['HTTP_USER_AGENT'] ?? ''), 0, 255),
        ]);
    } catch (Throwable) {}
}

function staffReadableTables(): array {
    return [
        'branches','products','product_variants','product_categories',
        'branch_products','branch_variant_prices','payment_methods',
        'cashier_sessions','transactions','transaction_items',
        'cash_categories','cash_logs','ingredients','recipes','recipe_items',
        'branch_inventory','inventory_logs',
        'deposit_accounts','cash_deposits','branch_cash_balances',
        'toppings','product_toppings',
        'branch_ingredient_assignments','users',
    ];
}

function investorReadableTables(): array {
    return ['payment_methods','users'];
}

function scopeReadParamsForUser(array $user, string $table, array $params): array {
    if (isAdminUser($user)) return $params;
    $selectRaw = strtolower((string)($params['select'] ?? ''));
    if (str_contains($selectRaw, 'password') || str_contains($selectRaw, 'token_hash') || str_contains($selectRaw, 'key_value')) {
        denyHttp(403, 'Kolom sensitif tidak boleh diakses', 'COLUMN_FORBIDDEN');
    }

    if ($user['role'] === 'investor') {
        if (!in_array($table, investorReadableTables(), true)) denyHttp(403, 'Akses tabel ditolak', 'TABLE_FORBIDDEN');
        if ($table === 'users') return forceEqParam($params, 'id', (int)$user['id']);
        return $params;
    }

    if ($user['role'] !== 'staff' || !in_array($table, staffReadableTables(), true)) {
        denyHttp(403, 'Akses tabel ditolak', 'TABLE_FORBIDDEN');
    }

    if ($table === 'users') {
        $select = strtolower((string)($params['select'] ?? ''));
        if ($select === '*' || str_contains($select, 'password')) {
            denyHttp(403, 'Kolom user sensitif tidak boleh diakses', 'COLUMN_FORBIDDEN');
        }
        return forceEqParam($params, 'id', (int)$user['id']);
    }

    if ($table === 'transaction_items' && !empty($user['branch_id'])) {
        $txId = extractEqParam($params, 'transaction_id');
        if (!$txId) denyHttp(403, 'Filter transaksi wajib diisi', 'SCOPE_REQUIRED');
        $pdo = getDB();
        $stmt = $pdo->prepare("SELECT branch_id FROM transactions WHERE id=? LIMIT 1");
        $stmt->execute([(int)$txId]);
        $branchId = (int)($stmt->fetchColumn() ?: 0);
        requireBranchAccess($user, $branchId);
        return $params;
    }

    $branchScoped = [
        'branch_products','branch_variant_prices','cashier_sessions','transactions',
        'cash_logs','branch_inventory','inventory_logs','cash_deposits',
        'branch_cash_balances',
    ];
    if (!empty($user['branch_id']) && in_array($table, $branchScoped, true) && dbColumnExists(getDB(), $table, 'branch_id')) {
        $params = forceEqParam($params, 'branch_id', (int)$user['branch_id']);
    }

    return $params;
}

function sanitizeUserSelectParams(array $params): array {
    $select = trim((string)($params['select'] ?? '*'));
    $lower = strtolower($select);
    if ($lower === '*' || $lower === '') {
        $params['select'] = 'id,name,role,branch_id,is_active,onboarding_status,created_at,deleted_at';
    } elseif (str_contains($lower, 'password')) {
        denyHttp(403, 'Kolom password tidak boleh diakses via API', 'COLUMN_FORBIDDEN');
    }
    return $params;
}

function validateCashLogWrite(array $user, string $method, array $params, array $body): array {
    $pdo = getDB();
    if ($method === 'POST') {
        $rows = isset($body[0]) ? $body : [$body];
        foreach ($rows as &$row) {
            if (!is_array($row)) denyHttp(400, 'Payload kas tidak valid', 'VALIDATION_ERROR');
            $branchId = (int)($row['branch_id'] ?? 0);
            requireBranchAccess($user, $branchId);
            $amount = (float)($row['amount'] ?? 0);
            if ($amount <= 0 || $amount > 100000000) denyHttp(400, 'Nominal kas tidak valid', 'VALIDATION_ERROR');
            if (!in_array($row['type'] ?? '', ['in','out'], true)) denyHttp(400, 'Tipe kas tidak valid', 'VALIDATION_ERROR');

            if (!isAdminUser($user)) {
                $row['created_by'] = (int)$user['id'];
                $row['reference_type'] = $row['reference_type'] ?? 'manual';
                if (!in_array($row['reference_type'], ['manual', null, ''], true)) {
                    denyHttp(403, 'Staff hanya boleh membuat kas manual', 'FORBIDDEN');
                }
                unset($row['is_void'], $row['void_reason'], $row['void_by'], $row['void_at']);
            }

            if (!empty($row['session_id'])) {
                $sess = $pdo->prepare("SELECT branch_id,staff_id,status FROM cashier_sessions WHERE id=? LIMIT 1");
                $sess->execute([(int)$row['session_id']]);
                $s = $sess->fetch();
                if (!$s || (int)$s['branch_id'] !== $branchId || $s['status'] !== 'open') {
                    denyHttp(400, 'Session kas tidak valid', 'VALIDATION_ERROR');
                }
                if (!isAdminUser($user) && (int)$s['staff_id'] !== (int)$user['id']) {
                    denyHttp(403, 'Session kas bukan milik user', 'FORBIDDEN');
                }
            }
        }
        unset($row);
        rateLimitAction('cash_log_create', 30, 60, 'user:' . $user['id']);
        return isset($body[0]) ? $rows : $rows[0];
    }

    if ($method === 'PATCH') {
        $id = extractEqParam($params, 'id');
        if (!$id) denyHttp(400, 'Update kas wajib pakai id', 'VALIDATION_ERROR');
        $stmt = $pdo->prepare("SELECT * FROM cash_logs WHERE id=? LIMIT 1");
        $stmt->execute([(int)$id]);
        $old = $stmt->fetch();
        if (!$old) denyHttp(404, 'Log kas tidak ditemukan', 'NOT_FOUND');
        requireBranchAccess($user, (int)$old['branch_id']);

        if (!isAdminUser($user)) {
            $allowed = ['is_void','void_reason','void_by','void_at'];
            foreach (array_keys($body) as $key) {
                if (!in_array($key, $allowed, true)) denyHttp(403, 'Staff hanya boleh void kas manual', 'FORBIDDEN');
            }
            if ((int)($old['is_void'] ?? 0) === 1) denyHttp(400, 'Log kas sudah di-void', 'VALIDATION_ERROR');
            if (!in_array($old['reference_type'] ?? 'manual', ['manual', null, ''], true)) {
                denyHttp(403, 'Staff tidak boleh void log sistem', 'FORBIDDEN');
            }
            if ((int)($old['created_by'] ?? 0) !== (int)$user['id']) {
                denyHttp(403, 'Staff hanya boleh void kas yang dibuat sendiri', 'FORBIDDEN');
            }
            $reason = trim((string)($body['void_reason'] ?? ''));
            if (strlen($reason) < 3) denyHttp(400, 'Alasan void wajib diisi', 'VALIDATION_ERROR');
            $body = [
                'is_void' => 1,
                'void_reason' => $reason,
                'void_by' => (int)$user['id'],
                'void_at' => date('Y-m-d H:i:s'),
            ];
        }
        auditLog($user, 'cash_log_update', 'cash_logs', $old, $body, (int)$old['branch_id']);
        rateLimitAction('cash_log_update', 30, 60, 'user:' . $user['id']);
        return $body;
    }

    denyHttp(403, 'Metode kas tidak diizinkan', 'FORBIDDEN');
}

function authorizeTableRequest(string $table, string $method, array $params, array $body): array {
    $user = requireSessionUser($params);

    if ($table === 'app_sessions' || $table === 'member_sessions') {
        denyHttp(403, 'Tabel session tidak boleh diakses langsung', 'TABLE_FORBIDDEN');
    }
    // Ledger point hanya boleh ditulis lewat RPC (jaga integritas saldo).
    if ($table === 'member_point_ledger' && $method !== 'GET') {
        denyHttp(403, 'Ledger point hanya bisa diubah lewat RPC', 'TABLE_FORBIDDEN');
    }
    if ($table === 'users') {
        $params = sanitizeUserSelectParams($params);
    }

    if ($method === 'GET') {
        return [scopeReadParamsForUser($user, $table, $params), $body];
    }

    if ($table === 'audit_logs') {
        denyHttp(403, 'Tabel sistem tidak boleh diubah langsung', 'TABLE_FORBIDDEN');
    }

    if (!isAdminUser($user)) {
        if ($user['role'] === 'staff' && $table === 'cash_logs' && in_array($method, ['POST','PATCH'], true)) {
            return [$params, validateCashLogWrite($user, $method, $params, $body)];
        }
        denyHttp(403, 'Aksi ini membutuhkan akses admin', 'FORBIDDEN');
    }

    $sensitiveActions = [
        'POST' => 'insert',
        'PUT' => 'upsert',
        'PATCH' => 'update',
        'DELETE' => 'delete',
    ];
    rateLimitAction('table_' . strtolower($method) . '_' . $table, 60, 60, 'user:' . $user['id']);
    auditLog($user, $table . '_' . ($sensitiveActions[$method] ?? strtolower($method)), $table, null, $body, null);
    return [$params, $body];
}

function handleSelect(string $table, array $params): void {
    try {
        $pdo = getDB();
        $selectStr = $params['select'] ?? '*';
        $selectTree = parseSelectList($selectStr);
        $plan = buildSelectPlan($table, $selectTree);
        [$whereClause, $whereValues] = buildWhere($params, $plan['context']);
        $orderClause = buildOrder($params['order'] ?? null, $plan['context']);
        $limitClause = '';
        if (isset($params['limit']))  $limitClause .= ' LIMIT '  . (int)$params['limit'];
        if (isset($params['offset'])) $limitClause .= ' OFFSET ' . (int)$params['offset'];

        $sql = "SELECT {$plan['selectSql']} FROM `$table` AS `{$plan['baseAlias']}` {$plan['joinSql']} $whereClause $orderClause $limitClause";

        $stmt = $pdo->prepare($sql);
        $stmt->execute($whereValues);
        $rows = $stmt->fetchAll();

        // count only (head request)
        if (isset($params['_head'])) {
            $cntSql = "SELECT COUNT(*) FROM `$table` AS `{$plan['baseAlias']}` {$plan['joinSql']} $whereClause";
            $cntStmt = $pdo->prepare($cntSql);
            $cntStmt->execute($whereValues);
            respond(200, [], ['Content-Range' => "0-0/" . $cntStmt->fetchColumn()]);
            return;
        }

        // Decode JSON columns
        $rows = array_map(fn($r) => decodeJsonCols($r), $rows);
        $rows = hydrateJoinedRows($rows, $plan['joinedRelations']);
        $rows = hydrateDeferredRelations($pdo, $rows, $plan['deferredRelations']);

        if (isset($params['_single'])) {
            respond(200, $rows[0] ?? null);
        } elseif (isset($params['_maybe_single'])) {
            respond(200, $rows[0] ?? null);
        } else {
            respond(200, $rows);
        }
    } catch (Throwable $e) {
        respond(500, ['error' => ['message' => 'Terjadi kesalahan database', 'code' => 'DB_ERROR']]);
    }
}

function handleInsert(string $table, array $body, array $params): void {
    try {
    $pdo = getDB();
    $rows = isset($body[0]) ? $body : [$body]; // single or batch
    $inserted = [];
    foreach ($rows as $row) {
        $row = prepareRow($table, $row);
        $row = filterRowToExistingColumns($pdo, $table, $row);
        if (!$row) { respond(400, ['error' => ['message' => 'Tidak ada kolom valid untuk insert']]); }
        $cols = implode(', ', array_map(fn($c) => "`$c`", array_keys($row)));
        $placeholders = implode(', ', array_fill(0, count($row), '?'));
        $sql = "INSERT INTO `$table` ($cols) VALUES ($placeholders)";
        $stmt = $pdo->prepare($sql);
        $stmt->execute(array_values($row));
        $id = $pdo->lastInsertId();
        if ($id) {
            $fetched = $pdo->query("SELECT * FROM `$table` WHERE id = " . $pdo->quote($id))->fetch();
            $inserted[] = decodeJsonCols($fetched ?: $row);
        } else {
            $inserted[] = $row;
        }
    }
    $wantSelect = isset($params['select']) || isset($params['_single']);
    respond(201, $wantSelect ? (count($inserted) === 1 ? $inserted[0] : $inserted) : $inserted);
    } catch (Throwable $e) {
        respond(500, ['error' => ['message' => 'Terjadi kesalahan database', 'code' => 'DB_ERROR']]);
    }
}

function handleUpdate(string $table, array $body, array $params): void {
    try {
    $pdo = getDB();
    [$whereClause, $whereValues] = buildWhere($params);
    if (!$whereClause) { respond(400, ['error' => ['message' => 'Update wajib pakai filter']]); }
    $body = filterRowToExistingColumns($pdo, $table, encodeStructuredColumns($body));
    if (!$body) { respond(400, ['error' => ['message' => 'Tidak ada kolom valid untuk update']]); }
    $setCols = implode(', ', array_map(fn($c) => "`$c` = ?", array_keys($body)));
    $sql = "UPDATE `$table` SET $setCols $whereClause";
    $stmt = $pdo->prepare($sql);
    $stmt->execute([...array_values($body), ...$whereValues]);

    // Return updated rows if select param present — use full select plan to support JOINs
    if (isset($params['select'])) {
        $selectTree = parseSelectList($params['select']);
        $plan = buildSelectPlan($table, $selectTree);
        [$wc, $wv] = buildWhere($params, $plan['context']);
        $sql2 = "SELECT {$plan['selectSql']} FROM `$table` AS `{$plan['baseAlias']}` {$plan['joinSql']} $wc";
        $rows2 = $pdo->prepare($sql2);
        $rows2->execute($wv);
        $data = array_map(fn($r) => decodeJsonCols($r), $rows2->fetchAll());
        $data = hydrateJoinedRows($data, $plan['joinedRelations']);
        respond(200, isset($params['_single']) ? ($data[0] ?? null) : $data);
    }
    respond(200, ['updated' => $stmt->rowCount()]);
    } catch (Throwable $e) {
        respond(500, ['error' => ['message' => 'Terjadi kesalahan database', 'code' => 'DB_ERROR']]);
    }
}

function handleUpsert(string $table, array $body, array $params): void {
    try {
    $pdo = getDB();
    $data    = $body['data']    ?? $body;
    $opts    = $body['opts']    ?? [];
    $onConflict = $opts['onConflict'] ?? 'id';
    $rows = isset($data[0]) ? $data : [$data];
    foreach ($rows as $row) {
        $row = prepareRow($table, $row);
        $row = filterRowToExistingColumns($pdo, $table, $row);
        if (!$row) continue;
        $cols = implode(', ', array_map(fn($c) => "`$c`", array_keys($row)));
        $placeholders = implode(', ', array_fill(0, count($row), '?'));
        $updateParts = implode(', ', array_map(fn($c) => "`$c` = VALUES(`$c`)", array_keys($row)));
        $sql = "INSERT INTO `$table` ($cols) VALUES ($placeholders) ON DUPLICATE KEY UPDATE $updateParts";
        $stmt = $pdo->prepare($sql);
        $stmt->execute(array_values($row));
    }
    respond(201, ['upserted' => count($rows)]);
    } catch (Throwable $e) {
        respond(500, ['error' => ['message' => 'Terjadi kesalahan database', 'code' => 'DB_ERROR']]);
    }
}

function handleDelete(string $table, array $params): void {
    try {
    $pdo = getDB();
    [$whereClause, $whereValues] = buildWhere($params);
    if (!$whereClause) { respond(400, ['error' => ['message' => 'Delete wajib pakai filter']]); }
    $stmt = $pdo->prepare("DELETE FROM `$table` $whereClause");
    $stmt->execute($whereValues);
    respond(200, ['deleted' => $stmt->rowCount()]);
    } catch (Throwable $e) {
        respond(500, ['error' => ['message' => 'Terjadi kesalahan database', 'code' => 'DB_ERROR']]);
    }
}

// ══════════════════════════════════════════════════════════════════════════════
// QUERY BUILDER HELPERS
// ══════════════════════════════════════════════════════════════════════════════

function parseQueryParamsPreserveDots(string $query): array {
    $params = [];
    foreach (explode('&', $query) as $part) {
        if ($part === '') continue;
        $pair = explode('=', $part, 2);
        $key = urldecode($pair[0] ?? '');
        if ($key === '') continue;
        $val = urldecode($pair[1] ?? '');
        // Support duplicate keys (e.g. created_at=gte.X&created_at=lte.Y for range queries).
        // Without this, URLSearchParams.append() on the JS side would still lose the first value.
        if (!isset($params[$key])) {
            $params[$key] = $val;
        } elseif (is_array($params[$key])) {
            $params[$key][] = $val;
        } else {
            $params[$key] = [$params[$key], $val];
        }
    }
    return $params;
}

function safeIdentifier(string $id): string {
    $id = trim(str_replace('`', '', $id));
    if (!preg_match('/^[A-Za-z_][A-Za-z0-9_]*$|^\*$/', $id)) {
        throw new Exception("Identifier tidak valid: $id");
    }
    return $id;
}

function splitTopLevel(string $input): array {
    $input = trim($input);
    if ($input === '') return [];
    $parts = [];
    $buf = '';
    $depth = 0;
    $len = strlen($input);
    for ($i = 0; $i < $len; $i++) {
        $ch = $input[$i];
        if ($ch === '(') $depth++;
        if ($ch === ')') $depth = max(0, $depth - 1);
        if ($ch === ',' && $depth === 0) {
            $part = trim($buf);
            if ($part !== '') $parts[] = $part;
            $buf = '';
            continue;
        }
        $buf .= $ch;
    }
    $part = trim($buf);
    if ($part !== '') $parts[] = $part;
    return $parts;
}

function parseSelectList(string $select): array {
    $nodes = [];
    foreach (splitTopLevel(preg_replace('/\s+/', ' ', trim($select))) as $part) {
        $nodes[] = parseSelectPart($part);
    }
    return $nodes ?: [['type' => 'column', 'name' => '*', 'alias' => '*']];
}

function parseSelectPart(string $part): array {
    $part = trim($part);
    $open = strpos($part, '(');
    if ($open !== false && str_ends_with($part, ')')) {
        $prefix = trim(substr($part, 0, $open));
        $inside = substr($part, $open + 1, -1);
        $alias = null;
        if (str_contains($prefix, ':')) {
            [$alias, $prefix] = array_map('trim', explode(':', $prefix, 2));
        }
        $bits = array_values(array_filter(array_map('trim', explode('!', $prefix)), fn($v) => $v !== ''));
        $table = array_shift($bits);
        $hint = null;
        $joinType = 'LEFT';
        foreach ($bits as $bit) {
            if (strtolower($bit) === 'inner') $joinType = 'INNER';
            else $hint = $bit;
        }
        return [
            'type' => 'relation',
            'table' => safeIdentifier($table),
            'key' => safeIdentifier($alias ?: $table),
            'hint' => $hint,
            'joinType' => $joinType,
            'children' => parseSelectList($inside),
        ];
    }
    $alias = null;
    if ($part !== '*' && str_contains($part, ':')) {
        [$alias, $part] = array_map('trim', explode(':', $part, 2));
    }
    $name = $part === '*' ? '*' : safeIdentifier($part);
    return ['type' => 'column', 'name' => $name, 'alias' => $alias ? safeIdentifier($alias) : $name];
}

function buildSelectPlan(string $table, array $nodes): array {
    $baseAlias = 't0';
    $selects = [];
    $joins = [];
    $joinedRelations = [];
    $deferredRelations = [];
    $context = [
        'baseAlias' => $baseAlias,
        'baseTable' => $table,
        'relationAliases' => [],
        'tableAliases' => [],
    ];
    $counter = 1;
    addSelectNodes($table, $baseAlias, $nodes, [], $selects, $joins, $joinedRelations, $deferredRelations, $context, $counter);
    if (!$selects) $selects[] = "`$baseAlias`.*";
    return [
        'baseAlias' => $baseAlias,
        'selectSql' => implode(', ', $selects),
        'joinSql' => implode(' ', $joins),
        'joinedRelations' => array_values($joinedRelations),
        'deferredRelations' => $deferredRelations,
        'context' => $context,
    ];
}

function addSelectNodes(
    string $parentTable,
    string $parentAlias,
    array $nodes,
    array $path,
    array &$selects,
    array &$joins,
    array &$joinedRelations,
    array &$deferredRelations,
    array &$context,
    int &$counter
): void {
    foreach ($nodes as $node) {
        if (($node['type'] ?? '') === 'column') {
            if ($node['name'] === '*') {
                if (!$path) $selects[] = "`$parentAlias`.*";
                continue;
            }
            if (!$path) {
                $selects[] = "`$parentAlias`.`{$node['name']}`" . ($node['alias'] !== $node['name'] ? " AS `{$node['alias']}`" : '');
            } else {
                $out = implode('__', [...$path, $node['alias']]);
                $selects[] = "`$parentAlias`.`{$node['name']}` AS `$out`";
                $pathKey = implode('.', $path);
                $joinedRelations[$pathKey] ??= ['path' => $path, 'columns' => []];
                $joinedRelations[$pathKey]['columns'][$out] = $node['alias'];
            }
            continue;
        }

        if (($node['type'] ?? '') !== 'relation') continue;
        $rel = resolveRelation($parentTable, $node['table'], $node['hint'] ?? null);
        $newPath = [...$path, $node['key']];
        if ($rel['type'] === 'has_many') {
            $deferredRelations[] = [
                'parentTable' => $parentTable,
                'parentPath' => $path,
                'table' => $node['table'],
                'key' => $node['key'],
                'fk' => $rel['fk'],
                'children' => $node['children'],
            ];
            continue;
        }

        $alias = 'j' . $counter++;
        $join = ($node['joinType'] === 'INNER') ? 'INNER JOIN' : 'LEFT JOIN';
        $joins[] = "$join `{$node['table']}` AS `$alias` ON `$alias`.`id` = `$parentAlias`.`{$rel['fk']}`";
        $context['relationAliases'][$node['key']] = $alias;
        $context['tableAliases'][$node['table']] ??= $alias;
        $joinedRelations[implode('.', $newPath)] ??= ['path' => $newPath, 'columns' => []];
        addSelectNodes($node['table'], $alias, $node['children'], $newPath, $selects, $joins, $joinedRelations, $deferredRelations, $context, $counter);
    }
}

function resolveRelation(string $parentTable, string $relTable, ?string $hint = null): array {
    $hintCol = fkHintToColumn($hint);
    if ($hintCol) return ['type' => 'belongs_to', 'fk' => $hintCol];
    $fk = inferFkCol($parentTable, $relTable);
    if ($fk) return ['type' => 'belongs_to', 'fk' => $fk];
    $childFk = inferFkCol($relTable, $parentTable);
    if ($childFk) return ['type' => 'has_many', 'fk' => $childFk];
    return ['type' => 'belongs_to', 'fk' => rtrim($relTable, 's') . '_id'];
}

function fkHintToColumn(?string $hint): ?string {
    if (!$hint) return null;
    $direct = [
        'cash_logs_created_by_fkey' => 'created_by',
        'cash_logs_void_by_fkey'    => 'void_by',
    ];
    if (isset($direct[$hint])) return $direct[$hint];
    $known = [
        'deposit_account_id','account_id','from_branch_id','to_branch_id','branch_id',
        'staff_id','session_id','transaction_id','product_id','variant_id','ingredient_id',
        'recipe_id','category_id','user_id','created_by','voided_by','void_by','reviewed_by',
        'confirmed_by','rejected_by','cancelled_by',
    ];
    foreach ($known as $col) {
        if ($hint === $col || str_contains($hint, $col)) return $col;
    }
    return null;
}

function buildSelect(string $table, string $select): string {
    [$cols] = buildSelectAndJoinCols($table, $select);
    return $cols;
}

// Mengembalikan [main_select_cols, join_select_cols]
function buildSelectAndJoinCols(string $table, string $select): array {
    if ($select === '*' || $select === '') return ["`$table`.*", ''];
    $mainCols = [];
    $joinCols = [];
    foreach (explode(',', $select) as $part) {
        $part = trim($part);
        if (preg_match('/^(\w+)(?:!(\w+))?\(([^)]+)\)$/', $part, $m)) {
            // Join pattern: branches(name) atau users!staff_id(name,email)
            $relTable = $m[1];
            $fkHint   = $m[2] ?: null;
            $relCols  = array_map('trim', explode(',', $m[3]));
            $fkCol    = $fkHint ?? inferFkCol($table, $relTable);
            $alias    = $relTable . '__' . $fkCol;
            foreach ($relCols as $c) {
                if ($c === '*') {
                    $joinCols[] = "`$alias`.*";
                } else {
                    $joinCols[] = "`$alias`.`$c` AS `{$relTable}__{$c}`";
                }
            }
            continue;
        }
        if ($part === '*') { $mainCols[] = "`$table`.*"; continue; }
        $mainCols[] = "`$table`.`$part`";
    }
    $main = $mainCols ? implode(', ', $mainCols) : "`$table`.*";
    $join = implode(', ', $joinCols);
    return [$main, $join];
}

function buildJoins(string $table, string $select): string {
    $joins = [];
    preg_match_all('/(\w+)(?:!(\w+))?\(([^)]+)\)/', $select, $matches, PREG_SET_ORDER);
    foreach ($matches as $m) {
        $relTable = $m[1];
        $fkHint   = !empty($m[2]) ? $m[2] : null; // ?: bukan ?? agar string kosong diperlakukan sebagai null
        $fkCol    = $fkHint ?? inferFkCol($table, $relTable);
        if (!$fkCol) continue;
        $alias = $relTable . '__' . $fkCol;
        $joins[] = "LEFT JOIN `$relTable` AS `$alias` ON `$alias`.`id` = `$table`.`$fkCol`";
    }
    return implode(' ', $joins);
}

function inferFkCol(string $mainTable, string $relTable): ?string {
    $map = [
        // transactions
        'transactions:branches'              => 'branch_id',
        'transactions:users'                 => 'staff_id',
        'transactions:cashier_sessions'      => 'session_id',
        // transaction_items
        'transaction_items:transactions'     => 'transaction_id',
        'transaction_items:products'         => 'product_id',
        'transaction_items:product_variants' => 'variant_id',
        // cashier_sessions
        'cashier_sessions:branches'          => 'branch_id',
        'cashier_sessions:users'             => 'staff_id',
        // cash_logs
        'cash_logs:branches'                 => 'branch_id',
        'cash_logs:users'                    => 'created_by',
        'cash_logs:cash_categories'          => 'category_id',
        // cash_deposits
        'cash_deposits:branches'             => 'branch_id',
        'cash_deposits:users'                => 'staff_id',
        'cash_deposits:deposit_accounts'     => 'account_id',
        // cash_branch_transfers
        'cash_branch_transfers:branches'     => 'from_branch_id',
        // products
        'products:product_categories'        => 'category_id',
        // product_variants
        'product_variants:products'          => 'product_id',
        // branch_products
        'branch_products:branches'           => 'branch_id',
        'branch_products:products'           => 'product_id',
        // branch_variant_prices
        'branch_variant_prices:branches'     => 'branch_id',
        'branch_variant_prices:product_variants' => 'variant_id',
        // recipes
        'recipes:product_variants'           => 'variant_id',
        // recipe_items
        'recipe_items:ingredients'           => 'ingredient_id',
        'recipe_items:recipes'               => 'recipe_id',
        // branch_inventory
        'branch_inventory:branches'          => 'branch_id',
        'branch_inventory:ingredients'       => 'ingredient_id',
        // inventory_logs
        'inventory_logs:branches'            => 'branch_id',
        'inventory_logs:ingredients'         => 'ingredient_id',
        'inventory_logs:users'               => 'created_by',
        // PO sync tables
        'po_outlet_branch_mappings:branches'       => 'pos_branch_id',
        'po_material_pos_mappings:branches'        => 'pos_branch_id',
        'po_material_pos_mappings:ingredients'     => 'pos_ingredient_id',
        'po_ignored_materials:branches'            => 'pos_branch_id',
        'po_stock_sync_runs:users'                 => 'triggered_by',
        'po_stock_sync_items:branches'             => 'pos_branch_id',
        'po_stock_sync_items:ingredients'          => 'pos_ingredient_id',
        'po_stock_sync_items:po_stock_sync_runs'   => 'sync_run_id',
        'po_stock_sync_errors:po_stock_sync_runs'  => 'sync_run_id',
        // stock_transfers
        'stock_transfers:branches'           => 'from_branch_id',
        'stock_transfer_items:stock_transfers' => 'transfer_id',
        'stock_transfer_items:ingredients'   => 'ingredient_id',
        // investor
        'investor_branch_access:branches'    => 'branch_id',
        'investor_branch_access:users'       => 'user_id',
        // users
        'users:branches'                     => 'branch_id',
        // product_toppings
        'product_toppings:products'          => 'product_id',
        'product_toppings:toppings'          => 'topping_id',
    ];
    $key = "$mainTable:$relTable";
    if (isset($map[$key])) return $map[$key];

    // Fallback: singular + _id (branches→branch_id, users→user_id, dll)
    $singular = rtrim($relTable, 's');
    // Khusus: 'categorie' → 'category'
    $singular = str_replace('categorie', 'category', $singular);
    return null;
}

function buildWhere(array $params, ?array $context = null): array {
    $reserved = ['select','order','limit','offset','_single','_maybe_single','_head','_count','table','_or'];
    $conditions = [];
    $values = [];
    foreach ($params as $col => $expr) {
        if (in_array($col, $reserved, true)) continue;
        // Support array of filter expressions for the same column (e.g. gte + lte for range queries).
        $exprs = is_array($expr) ? $expr : [$expr];
        foreach ($exprs as $singleExpr) {
            if (!str_contains((string)$singleExpr, '.')) continue;
            [$condition, $conditionValues] = buildCondition($col, (string)$singleExpr, $context);
            if ($condition) {
                $conditions[] = $condition;
                $values = array_merge($values, $conditionValues);
            }
        }
    }
    if (!empty($params['_or'])) {
        $orParts = [];
        $orValues = [];
        foreach (splitTopLevel((string)$params['_or']) as $piece) {
            $bits = explode('.', $piece, 3);
            if (count($bits) < 2) continue;
            [$condition, $conditionValues] = buildCondition($bits[0], $bits[1] . '.' . ($bits[2] ?? ''), $context);
            if ($condition) {
                $orParts[] = $condition;
                $orValues = array_merge($orValues, $conditionValues);
            }
        }
        if ($orParts) {
            $conditions[] = '(' . implode(' OR ', $orParts) . ')';
            $values = array_merge($values, $orValues);
        }
    }
    $clause = $conditions ? 'WHERE ' . implode(' AND ', $conditions) : '';
    return [$clause, $values];
}

function buildCondition(string $col, string $expr, ?array $context = null): array {
    [$op, $val] = explode('.', $expr, 2);
    $colSafe = qualifyColumn($col, $context);
    $values = [];
    $condition = null;
    switch ($op) {
        case 'eq':
            if (strtolower($val) === 'null') $condition = "$colSafe IS NULL";
            else { $condition = "$colSafe = ?"; $values[] = normalizeSqlValue($val); }
            break;
        case 'neq':
            if (strtolower($val) === 'null') $condition = "$colSafe IS NOT NULL";
            else { $condition = "$colSafe != ?"; $values[] = normalizeSqlValue($val); }
            break;
        case 'gt':  $condition = "$colSafe > ?";  $values[] = normalizeSqlValue($val); break;
        case 'gte': $condition = "$colSafe >= ?"; $values[] = normalizeSqlValue($val); break;
        case 'lt':  $condition = "$colSafe < ?";  $values[] = normalizeSqlValue($val); break;
        case 'lte': $condition = "$colSafe <= ?"; $values[] = normalizeSqlValue($val); break;
        case 'like':  $condition = "$colSafe LIKE ?"; $values[] = $val; break;
        case 'ilike': $condition = "LOWER($colSafe) LIKE ?"; $values[] = strtolower($val); break;
        case 'is':
            if (strtolower($val) === 'null') $condition = "$colSafe IS NULL";
            else { $condition = "$colSafe = ?"; $values[] = normalizeSqlValue($val); }
            break;
        case 'not':
            [$op2, $val2] = explode('.', $val, 2);
            if ($op2 === 'is' && strtolower($val2) === 'null') $condition = "$colSafe IS NOT NULL";
            elseif ($op2 === 'eq') { $condition = "$colSafe != ?"; $values[] = normalizeSqlValue($val2); }
            break;
        case 'in':
            $items = array_values(array_filter(array_map('trim', explode(',', trim($val, '()'))), fn($v) => $v !== ''));
            if (!$items) return [null, []];
            $condition = "$colSafe IN (" . implode(',', array_fill(0, count($items), '?')) . ")";
            $values = array_map('normalizeSqlValue', $items);
            break;
    }
    return [$condition, $values];
}

// Convert a WITA calendar date (YYYY-MM-DD) or timezone-aware ISO string to UTC.
// Used by RPC functions whose JS callers pass date strings from date-pickers.
function witaDateToUtc(string $dateOrIso, bool $endOfDay = false): string {
    // DB menyimpan DATETIME dalam WITA (UTC+8) — kembalikan WITA literal, tanpa konversi ke UTC.
    if (preg_match('/T\d{2}:\d{2}:\d{2}/', $dateOrIso)) {
        // Strip timezone suffix jika ada, ambil bagian lokal WITA-nya saja.
        return str_replace('T', ' ', substr($dateOrIso, 0, 19));
    }
    // Plain YYYY-MM-DD
    return $dateOrIso . ($endOfDay ? ' 23:59:59' : ' 00:00:00');
}

function normalizeSqlValue(string $val): mixed {
    $lower = strtolower($val);
    if ($lower === 'true') return 1;
    if ($lower === 'false') return 0;
    if (preg_match('/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/', $val)) {
        // DB menyimpan DATETIME dalam WITA — ambil bagian waktu lokal saja (19 karakter),
        // buang timezone suffix (+08:00 / Z). Ini menghasilkan literal WITA yang cocok
        // dengan data tersimpan tanpa konversi UTC.
        return str_replace('T', ' ', substr($val, 0, 19));
    }
    return $val;
}

function qualifyColumn(string $col, ?array $context = null): string {
    $col = str_replace('`', '', $col);
    if ($context && str_contains($col, '.')) {
        [$prefix, $field] = explode('.', $col, 2);
        $alias = $context['relationAliases'][$prefix] ?? $context['tableAliases'][$prefix] ?? $context['baseAlias'];
        return "`$alias`.`" . safeIdentifier($field) . "`";
    }
    if ($context) return "`{$context['baseAlias']}`.`" . safeIdentifier($col) . "`";
    return '`' . safeIdentifier($col) . '`';
}

function buildOrder(?string $order, ?array $context = null): string {
    if (!$order) return '';
    $parts = [];
    foreach (explode(',', $order) as $o) {
        $o = trim($o);
        if ($o === '') continue;
        $bits = explode('.', $o);
        $direction = 'ASC';
        if (in_array(strtolower(end($bits)), ['asc','desc'], true)) {
            $direction = strtoupper(array_pop($bits));
        } elseif (count($bits) > 1 && in_array(strtolower($bits[count($bits) - 2]), ['asc','desc'], true)) {
            array_pop($bits);
            $direction = strtoupper(array_pop($bits));
        }
        $parts[] = qualifyColumn(implode('.', $bits), $context) . " $direction";
    }
    return $parts ? 'ORDER BY ' . implode(', ', $parts) : '';
}

function hydrateJoinedRows(array $rows, array $relations): array {
    foreach ($rows as &$row) {
        foreach ($relations as $rel) {
            $obj = [];
            $hasValue = false;
            foreach ($rel['columns'] as $flatKey => $field) {
                if (!array_key_exists($flatKey, $row)) continue;
                $obj[$field] = $row[$flatKey];
                if ($row[$flatKey] !== null) $hasValue = true;
                unset($row[$flatKey]);
            }
            if ($rel['columns']) setNestedRelation($row, $rel['path'], $hasValue ? $obj : null);
        }
    }
    unset($row);
    return $rows;
}

function hydrateDeferredRelations(PDO $pdo, array $rows, array $relations): array {
    foreach ($relations as $rel) {
        $parentIds = [];
        foreach ($rows as $row) {
            $parent = getNestedRelation($row, $rel['parentPath']);
            if (is_array($parent) && isset($parent['id'])) $parentIds[] = $parent['id'];
        }
        $parentIds = array_values(array_unique(array_filter($parentIds, fn($v) => $v !== null && $v !== '')));
        if (!$parentIds) {
            foreach ($rows as &$row) attachDeferredRows($row, $rel, []);
            unset($row);
            continue;
        }
        $cols = deferredSelectColumns($rel['children'], $rel['fk']);
        $stmt = $pdo->prepare("SELECT $cols FROM `{$rel['table']}` WHERE `{$rel['fk']}` IN (" . implode(',', array_fill(0, count($parentIds), '?')) . ")");
        $stmt->execute($parentIds);
        $children = array_map(fn($r) => decodeJsonCols($r), $stmt->fetchAll());
        $byParent = [];
        foreach ($children as $child) {
            $pid = $child[$rel['fk']] ?? null;
            if ($pid === null) continue;
            unset($child[$rel['fk']]);
            $byParent[(string)$pid][] = $child;
        }
        foreach ($rows as &$row) attachDeferredRows($row, $rel, $byParent);
        unset($row);
    }
    return $rows;
}

function deferredSelectColumns(array $children, string $fk): string {
    $cols = [$fk];
    foreach ($children as $child) {
        if (($child['type'] ?? '') !== 'column') continue;
        if ($child['name'] === '*') return '*';
        $cols[] = $child['name'];
    }
    $cols = array_values(array_unique($cols));
    return implode(', ', array_map(fn($c) => "`" . safeIdentifier($c) . "`", $cols));
}

function getNestedRelation(array $row, array $path): mixed {
    $cur = $row;
    foreach ($path as $key) {
        if (!is_array($cur) || !array_key_exists($key, $cur)) return null;
        $cur = $cur[$key];
    }
    return $cur;
}

function setNestedRelation(array &$row, array $path, mixed $value): void {
    $cur =& $row;
    $last = array_pop($path);
    foreach ($path as $key) {
        if (!isset($cur[$key]) || !is_array($cur[$key])) $cur[$key] = [];
        $cur =& $cur[$key];
    }
    if ($last !== null) $cur[$last] = $value;
}

function attachDeferredRows(array &$row, array $rel, array $byParent): void {
    $parent =& $row;
    foreach ($rel['parentPath'] as $key) {
        if (!isset($parent[$key]) || !is_array($parent[$key])) return;
        $parent =& $parent[$key];
    }
    $pid = $parent['id'] ?? null;
    $parent[$rel['key']] = $pid !== null ? ($byParent[(string)$pid] ?? []) : [];
}

// UUID v4 generator
function uuid4(): string {
    $data = random_bytes(16);
    $data[6] = chr(ord($data[6]) & 0x0f | 0x40);
    $data[8] = chr(ord($data[8]) & 0x3f | 0x80);
    return vsprintf('%s%s-%s-%s-%s-%s%s%s', str_split(bin2hex($data), 4));
}

function prepareRow(string $table, array $row): array {
    $uuidTables = ['deposit_accounts','cash_deposits','cash_branch_transfers'];
    if (in_array($table, $uuidTables, true) && empty($row['id'])) {
        $row['id'] = uuid4();
    }
    if ($table === 'users' && isset($row['password']) && trim((string)$row['password']) !== '') {
        $password = (string)$row['password'];
        $info = password_get_info($password);
        $looksCryptHash = str_starts_with($password, '$2') || str_starts_with($password, '$1$') || str_starts_with($password, '$5$') || str_starts_with($password, '$6$');
        if (($info['algo'] ?? 0) === 0 && !$looksCryptHash) {
            $row['password'] = password_hash($password, PASSWORD_BCRYPT);
        }
    }
    return encodeStructuredColumns($row);
}

function encodeStructuredColumns(array $row): array {
    // Encode JSON fields
    foreach (['metadata','onboarding_status'] as $col) {
        if (isset($row[$col]) && is_array($row[$col])) {
            $row[$col] = json_encode($row[$col]);
        }
    }
    return $row;
}

function filterRowToExistingColumns(PDO $pdo, string $table, array $row): array {
    if (!$row) return [];
    $filtered = [];
    foreach ($row as $col => $value) {
        if (!is_string($col) || $col === '') continue;
        $safeCol = str_replace('`', '', $col);
        if (dbColumnExists($pdo, $table, $safeCol)) {
            $filtered[$safeCol] = $value;
        }
    }
    return $filtered;
}

function decodeJsonCols(array $row): array {
    $jsonCols = ['metadata','onboarding_status','items'];
    foreach ($jsonCols as $col) {
        if (isset($row[$col]) && is_string($row[$col])) {
            $decoded = json_decode($row[$col], true);
            if ($decoded !== null) $row[$col] = $decoded;
        }
    }
    // Cast tinyint booleans
    foreach (['is_active','is_void','allowed','has_variants'] as $col) {
        if (array_key_exists($col, $row) && $row[$col] !== null) {
            $row[$col] = (bool)(int)$row[$col];
        }
    }
    return $row;
}

function dbColumnExists(PDO $pdo, string $table, string $column): bool {
    static $cache = [];
    $key = "$table.$column";
    if (array_key_exists($key, $cache)) return $cache[$key];
    try {
        $stmt = $pdo->prepare("
            SELECT COUNT(*)
            FROM INFORMATION_SCHEMA.COLUMNS
            WHERE TABLE_SCHEMA = DATABASE()
              AND TABLE_NAME = ?
              AND COLUMN_NAME = ?
        ");
        $stmt->execute([$table, $column]);
        $cache[$key] = ((int)$stmt->fetchColumn()) > 0;
    } catch (Throwable) {
        $cache[$key] = false;
    }
    return $cache[$key];
}

function insertDynamic(PDO $pdo, string $table, array $row): void {
    $cols = array_keys($row);
    $sql = "INSERT INTO `$table` (" . implode(',', array_map(fn($c) => "`$c`", $cols)) . ") VALUES (" . implode(',', array_fill(0, count($cols), '?')) . ")";
    $stmt = $pdo->prepare($sql);
    $stmt->execute(array_values($row));
}

function respond(int $status, mixed $data, array $extraHeaders = []): void {
    ob_clean(); // buang semua output stray sebelum JSON
    http_response_code($status);
    foreach ($extraHeaders as $k => $v) header("$k: $v");
    echo json_encode($data, JSON_UNESCAPED_UNICODE | JSON_PARTIAL_OUTPUT_ON_ERROR);
    exit;
}

// ══════════════════════════════════════════════════════════════════════════════
// RPC HANDLERS
// ══════════════════════════════════════════════════════════════════════════════

function publicRpcNames(): array {
    return [
        'pos_login',
        'rbn_validate_session',
        'rbn_health',
        'get_transactions_api',
        'get_sales_integration',
        'get_kas_keluar_integration',
        'get_integration_summary',
        'get_buduk_calculator_integration',
    ];
}

function adminRpcNames(): array {
    return [
        'admin_force_close_branch_cash_session',
        'admin_set_branch_cash_balance',
        'get_admin_branch_cash_positions',
        'get_admin_cash_sessions',
        'admin_create_manual_deposit',
        'confirm_deposit',
        'get_admin_cash_branch_transfers',
        'admin_save_investor_access',
        'rbn_admin_list_api_keys',
        'admin_preview_branch_menu_copy',
        'admin_copy_branch_menu',
        'get_all_transfers_admin',
        'rbn_require_admin_session',
        'sync_investor_payment_methods',
        // PO sync admin actions
        'po_sync_save_outlet_mapping',
        'po_sync_save_material_mapping',
        'po_sync_save_ignored_material',
        'po_sync_retry',
        'po_sync_get_pending_mappings',
        'po_sync_get_runs',
        'po_sync_get_suggestions',
    ];
}

// RPC khusus integrasi sistem internal yang boleh dipanggil via API key
// tanpa session user POS. API key sudah divalidasi di bagian atas api.php.
function systemRpcNames(): array {
    return [
        'check_shift_status',
        'inventory_list_branches',
        'inventory_list_ingredients',
        'inventory_get_branch_stock',
        'sync_purchase_order_to_inventory',
    ];
}

function authorizeRpcRequest(string $name, array $params): array {
    if (in_array($name, publicRpcNames(), true)) {
        if ($name === 'pos_login') rateLimitAction('rpc_login', 20, 300, 'ip:' . requestIp());
        if (str_contains($name, 'integration') || $name === 'get_transactions_api') {
            rateLimitAction('rpc_integration_' . $name, 120, 60, 'ip:' . requestIp());
        }
        return [$params, null];
    }

    // ── Member loyalty RPC: auth lewat X-Member-Session-Token (terpisah dari staff) ──
    if (in_array($name, memberPublicRpcNames(), true)) {
        if ($name === 'member_register') rateLimitAction('rpc_member_register', 5, 3600, 'ip:' . requestIp());
        if ($name === 'member_login')    rateLimitAction('rpc_member_login_ip', 30, 300, 'ip:' . requestIp());
        if ($name === 'member_forgot_password') rateLimitAction('rpc_member_forgot', 5, 600, 'ip:' . requestIp());
        return [$params, null];
    }
    if (in_array($name, memberSessionRpcNames(), true)) {
        $member = requireMemberSession();
        $params['_member'] = $member;
        rateLimitAction('rpc_member_act', 120, 60, 'member:' . $member['id']);
        return [$params, null];
    }

    // System RPC: dipanggil oleh integrasi internal menggunakan API key saja (tanpa session user).
    // API key sudah divalidasi di bagian atas api.php.
    if (in_array($name, systemRpcNames(), true)) {
        rateLimitAction('rpc_system_' . $name, 120, 60, 'ip:' . requestIp());
        $params['_auth_user'] = ['role' => 'system', 'id' => 0, 'branch_id' => null];
        return [$params, null];
    }

    $roles = (in_array($name, adminRpcNames(), true) || in_array($name, memberAdminRpcNames(), true)) ? ['admin','owner'] : null;
    $user = requireSessionUser($params, $roles);
    $params['_auth_user'] = $user;
    if (($user['role'] ?? '') === 'investor' && !str_starts_with($name, 'investor_')) {
        denyHttp(403, 'Akses investor tidak diizinkan untuk RPC ini', 'FORBIDDEN');
    }

    if (isset($params['p_admin_id'])) {
        if (!isAdminUser($user)) denyHttp(403, 'Akses admin diperlukan', 'FORBIDDEN');
        $params['p_admin_id'] = (int)$user['id'];
    }
    if (isset($params['p_staff_id']) && !isAdminUser($user) && (int)$params['p_staff_id'] !== (int)$user['id']) {
        denyHttp(403, 'staff_id tidak sesuai session', 'FORBIDDEN');
    }
    if (isset($params['p_user_id']) && !isAdminUser($user) && (int)$params['p_user_id'] !== (int)$user['id']) {
        denyHttp(403, 'user_id tidak sesuai session', 'FORBIDDEN');
    }

    if (($user['role'] ?? '') !== 'investor') {
        foreach (['p_branch_id','p_from_branch_id'] as $branchParam) {
            if (!empty($params[$branchParam])) requireBranchAccess($user, (int)$params[$branchParam]);
        }
    }

    $rateRules = [
        'process_transaction' => [20, 60],
        'close_cash_session_apply_branch_balance' => [10, 60],
        'open_cash_session_from_branch_balance' => [10, 60],
        'create_deposit' => [15, 60],
        'create_cash_branch_transfer' => [15, 60],
        'void_transaction' => [20, 60],
        'refund_transaction' => [20, 60],
        'adjust_stock_atomic' => [60, 60],
        'transfer_stock_atomic' => [30, 60],
    ];
    if (isset($rateRules[$name])) {
        [$limit, $window] = $rateRules[$name];
        rateLimitAction('rpc_' . $name, $limit, $window, 'user:' . $user['id']);
    }

    return [$params, $user];
}

function handleRpc(string $name, array $params): void {
    $fn = 'rpc_' . $name;
    if (!function_exists($fn)) {
        respond(404, ['error' => ['message' => "RPC '$name' tidak ditemukan", 'code' => 'PGRST202']]);
    }
    try {
        [$params, $authUser] = authorizeRpcRequest($name, $params);
        $result = $fn($params);
        respond(200, $result);
    } catch (ApiHttpException $e) {
        respond($e->status, ['error' => ['message' => $e->getMessage(), 'code' => $e->apiCode]]);
    } catch (Throwable $e) {
        $msg = $e instanceof PDOException ? 'Terjadi kesalahan database' : $e->getMessage();
        respond(400, ['error' => ['message' => $msg, 'code' => 'P0001']]);
    }
}

// ── pos_login ─────────────────────────────────────────────────────────────────
function rpc_rbn_health(array $p): mixed {
    $pdo = getDB();
    $stmt = $pdo->query("SELECT 1");
    return ['success' => ((int)$stmt->fetchColumn()) === 1, 'server_time' => date('c')];
}

function rpc_pos_login(array $p): mixed {
    $pdo  = getDB();
    $name = trim($p['p_name'] ?? '');
    $pass = $p['p_password'] ?? '';
    if (!$name || !$pass) throw new Exception('Username dan password wajib diisi');

    // ── Rate limiting: blokir setelah 5 gagal dalam 5 menit ──────────────────
    $ip = $_SERVER['REMOTE_ADDR'] ?? 'unknown';
    try {
        $limStmt = $pdo->prepare("
            SELECT COUNT(*) FROM login_attempts
            WHERE (username = ? OR ip_address = ?)
              AND success = 0
              AND attempted_at > DATE_SUB(NOW(), INTERVAL 5 MINUTE)
        ");
        $limStmt->execute([$name, $ip]);
        if ((int)$limStmt->fetchColumn() >= 5) {
            throw new Exception('Terlalu banyak percobaan login. Silakan coba lagi beberapa menit kemudian.');
        }
    } catch (Exception $e) {
        // Jika tabel login_attempts belum ada, lewati rate limiting sementara
        if (strpos($e->getMessage(), 'login_attempts') === false) throw $e;
    }

    $stmt = $pdo->prepare("SELECT * FROM users WHERE LOWER(TRIM(name)) = LOWER(TRIM(?)) AND COALESCE(is_active,1) = 1 LIMIT 1");
    $stmt->execute([$name]);
    $user = $stmt->fetch();

    if (!$user) {
        // Catat percobaan gagal (username tidak ditemukan)
        try { $pdo->prepare("INSERT INTO login_attempts (username,ip_address,success) VALUES (?,?,0)")->execute([$name,$ip]); } catch (Throwable) {}
        auditLog(null, 'login_failed', 'users', null, ['username'=>$name,'reason'=>'not_found'], null);
        return null;
    }

    $stored    = $user['password'] ?? '';
    $valid     = false;
    $isLegacy  = false;
    if (str_starts_with($stored, '$2')) {
        $valid = password_verify($pass, $stored); // bcrypt
    } elseif (str_starts_with($stored, '$1$') || str_starts_with($stored, '$5$') || str_starts_with($stored, '$6$')) {
        $valid = crypt($pass, $stored) === $stored;
    } else {
        $valid    = $stored === $pass; // plain text legacy
        $isLegacy = $valid;
    }

    if (!$valid) {
        // Catat percobaan gagal
        try { $pdo->prepare("INSERT INTO login_attempts (username,ip_address,success) VALUES (?,?,0)")->execute([$name,$ip]); } catch (Throwable) {}
        auditLog(['id'=>(int)$user['id'],'name'=>$user['name'],'role'=>$user['role'],'branch_id'=>$user['branch_id'] ?? null], 'login_failed', 'users', null, ['username'=>$name,'reason'=>'bad_password'], $user['branch_id'] ? (int)$user['branch_id'] : null);
        return null;
    }

    // Migrasi: jika password masih plaintext, langsung upgrade ke bcrypt
    if ($isLegacy) {
        $hash = password_hash($pass, PASSWORD_BCRYPT);
        try { $pdo->prepare("UPDATE users SET password=? WHERE id=?")->execute([$hash, $user['id']]); } catch (Throwable) {}
    }

    // Catat percobaan berhasil
    try { $pdo->prepare("INSERT INTO login_attempts (username,ip_address,success) VALUES (?,?,1)")->execute([$name,$ip]); } catch (Throwable) {}

    // Bersihkan session expired milik user ini
    $pdo->prepare("DELETE FROM app_sessions WHERE user_id = ? AND expires_at <= NOW()")->execute([$user['id']]);
    // Bersihkan session expired global (sampel probabilistik ~5% request)
    if (mt_rand(1, 20) === 1) {
        try { $pdo->exec("DELETE FROM app_sessions WHERE expires_at <= NOW() LIMIT 500"); } catch (Throwable) {}
    }

    $token      = bin2hex(random_bytes(32));
    $tokenHash  = hash('sha256', $token);
    $expiresAt  = date('Y-m-d H:i:s', strtotime('+8 hours'));

    $pdo->prepare("INSERT INTO app_sessions (token_hash, user_id, expires_at) VALUES (?,?,?)")
        ->execute([$tokenHash, $user['id'], $expiresAt]);

    auditLog(['id'=>(int)$user['id'],'name'=>$user['name'],'role'=>$user['role'],'branch_id'=>$user['branch_id'] ?? null], 'login_success', 'users', null, ['session_expires_at'=>$expiresAt], $user['branch_id'] ? (int)$user['branch_id'] : null);

    return [
        'id'            => (int)$user['id'],
        'name'          => $user['name'],
        'role'          => $user['role'],
        'branch_id'     => $user['branch_id'] ? (int)$user['branch_id'] : null,
        'is_active'     => (bool)(int)($user['is_active'] ?? 1),
        'session_token' => $token,
        'expires_at'    => date('c', strtotime($expiresAt)),
    ];
}

// ── rbn_validate_session ──────────────────────────────────────────────────────
function rpc_rbn_validate_session(array $p): mixed {
    $token = trim($p['p_session_token'] ?? '');
    if (!$token) return null;

    $pdo  = getDB();
    $hash = hash('sha256', $token);
    $stmt = $pdo->prepare("
        SELECT u.id,u.name,u.role,u.branch_id,u.is_active,s.expires_at
        FROM app_sessions s
        JOIN users u ON u.id = s.user_id
        WHERE s.token_hash = ? AND s.expires_at > NOW() AND COALESCE(u.is_active,1)=1
        LIMIT 1
    ");
    $stmt->execute([$hash]);
    $row = $stmt->fetch();
    if (!$row) return null;

    $pdo->prepare("UPDATE app_sessions SET last_seen_at = NOW() WHERE token_hash = ?")->execute([$hash]);

    return [
        'id'            => (int)$row['id'],
        'name'          => $row['name'],
        'role'          => $row['role'],
        'branch_id'     => $row['branch_id'] ? (int)$row['branch_id'] : null,
        'is_active'     => (bool)(int)($row['is_active'] ?? 1),
        'session_token' => $token,
        'expires_at'    => date('c', strtotime($row['expires_at'])),
    ];
}

// ── process_transaction ───────────────────────────────────────────────────────
function rpc_rbn_logout(array $p): mixed {
    $token = requestSessionToken($p);
    $user = $p['_auth_user'] ?? currentSessionUser($p);
    if ($token !== '') {
        try {
            getDB()->prepare("DELETE FROM app_sessions WHERE token_hash=?")->execute([hash('sha256', $token)]);
        } catch (Throwable) {}
    }
    auditLog($user, 'logout', 'app_sessions', null, null, $user['branch_id'] ?? null);
    return ['success' => true];
}

function transactionItemSignatureList(array $items): array {
    $out = [];
    foreach ($items as $item) {
        $out[] = implode('|', [
            (string)($item['product_id'] ?? ''),
            (string)($item['variant_id'] ?? ''),
            trim((string)($item['product_name'] ?? '')),
            trim((string)($item['variant_name'] ?? '')),
            number_format((float)($item['quantity'] ?? 0), 4, '.', ''),
            number_format((float)($item['price'] ?? 0), 4, '.', ''),
        ]);
    }
    sort($out, SORT_STRING);
    return $out;
}

function transactionCartMatches(PDO $pdo, int $transactionId, array $cart): bool {
    $stmt = $pdo->prepare("
        SELECT product_id, variant_id, product_name, variant_name, quantity, price
        FROM transaction_items
        WHERE transaction_id = ?
    ");
    $stmt->execute([$transactionId]);
    return transactionItemSignatureList($stmt->fetchAll()) === transactionItemSignatureList($cart);
}

function normalizePaymentMethod(PDO $pdo, string $paymentMethod): string {
    $code = strtolower(trim($paymentMethod));
    if ($code === '') throw new Exception('Metode pembayaran wajib diisi');
    if (!preg_match('/^[a-z0-9_\-]{2,50}$/', $code)) throw new Exception('Metode pembayaran tidak valid');

    try {
        $stmt = $pdo->prepare("SELECT code FROM payment_methods WHERE LOWER(code)=? AND COALESCE(is_active,1)=1 LIMIT 1");
        $stmt->execute([$code]);
        $dbCode = $stmt->fetchColumn();
        if ($dbCode) return strtolower((string)$dbCode);
    } catch (Throwable) {}

    $fallback = ['cash','qris','gofood','grabfood','shopeefood','qpon','transfer','bca','mandiri','bni','bri','gopay','ovo','dana','shopeepay'];
    if (in_array($code, $fallback, true)) return $code;
    throw new Exception('Metode pembayaran tidak terdaftar atau tidak aktif');
}

function normalizeClientTxId(?string $clientTxId): ?string {
    $clientTxId = trim((string)$clientTxId);
    if ($clientTxId === '') return null;
    if (strlen($clientTxId) > 100 || !preg_match('/^[A-Za-z0-9._:-]+$/', $clientTxId)) {
        throw new Exception('client_tx_id tidak valid');
    }
    return $clientTxId;
}

function resolveTransactionCartFromDb(PDO $pdo, int $branchId, array $cart): array {
    $normalized = [];
    $subtotal = 0.0;

    foreach ($cart as $item) {
        if (!is_array($item)) throw new Exception('Item transaksi tidak valid');
        $productId = (int)($item['product_id'] ?? $item['productId'] ?? 0);
        $variantId = !empty($item['variant_id'] ?? $item['variantId'] ?? null) ? (int)($item['variant_id'] ?? $item['variantId']) : null;
        $qty = (int)($item['quantity'] ?? 1);
        if ($productId <= 0) throw new Exception('Produk transaksi tidak valid');
        if ($qty <= 0 || $qty > 999) throw new Exception('Qty item transaksi tidak valid');

        $prodStmt = $pdo->prepare("
            SELECT p.id,p.name,p.price,p.default_price,p.has_variants,p.is_active,
                   bp.id AS branch_product_id, bp.is_active AS branch_is_active
            FROM products p
            LEFT JOIN branch_products bp ON bp.product_id = p.id AND bp.branch_id = ?
            WHERE p.id = ?
            LIMIT 1
        ");
        $prodStmt->execute([$branchId, $productId]);
        $product = $prodStmt->fetch();
        if (!$product || (int)($product['is_active'] ?? 1) !== 1) throw new Exception('Produk tidak aktif atau tidak ditemukan');
        if (empty($product['branch_product_id']) || (int)($product['branch_is_active'] ?? 0) !== 1) {
            throw new Exception('Produk tidak aktif untuk cabang ini');
        }

        $productName = $product['name'];
        $variantName = null;
        $basePrice = $product['default_price'] !== null ? (float)$product['default_price'] : (float)$product['price'];

        if ($variantId) {
            $varStmt = $pdo->prepare("
                SELECT v.id,v.name,v.price,v.is_active,COALESCE(bvp.price, v.price) AS effective_price
                FROM product_variants v
                LEFT JOIN branch_variant_prices bvp ON bvp.variant_id = v.id AND bvp.branch_id = ?
                WHERE v.id = ? AND v.product_id = ?
                LIMIT 1
            ");
            $varStmt->execute([$branchId, $variantId, $productId]);
            $variant = $varStmt->fetch();
            if (!$variant || (int)($variant['is_active'] ?? 1) !== 1) throw new Exception('Varian tidak aktif atau tidak ditemukan');
            $variantName = $variant['name'];
            $basePrice = (float)$variant['effective_price'];
        } elseif ((int)($product['has_variants'] ?? 0) === 1) {
            throw new Exception('Varian produk wajib dipilih');
        }

        $toppingTotal = 0.0;
        $toppingNames = [];
        $toppings = $item['toppings'] ?? [];
        if (is_array($toppings) && $toppings) {
            $ids = [];
            foreach ($toppings as $top) {
                $tid = is_array($top) ? (int)($top['id'] ?? 0) : (int)$top;
                if ($tid > 0) $ids[$tid] = $tid;
            }
            if ($ids) {
                $placeholders = implode(',', array_fill(0, count($ids), '?'));
                $topStmt = $pdo->prepare("
                    SELECT t.id,t.name,t.price
                    FROM toppings t
                    JOIN product_toppings pt ON pt.topping_id = t.id
                    WHERE pt.product_id = ?
                      AND t.id IN ($placeholders)
                      AND COALESCE(t.is_active,1)=1
                ");
                $topStmt->execute(array_merge([$productId], array_values($ids)));
                $rows = $topStmt->fetchAll();
                if (count($rows) !== count($ids)) throw new Exception('Topping tidak valid untuk produk ini');
                foreach ($rows as $topRow) {
                    $toppingTotal += (float)$topRow['price'];
                    $toppingNames[] = $topRow['name'];
                }
            }
        }

        if ($toppingNames) {
            $variantName = trim((string)$variantName . ' [' . implode(', ', $toppingNames) . ']');
        }

        $linePrice = $basePrice + $toppingTotal;
        if ($linePrice < 0) throw new Exception('Harga item tidak valid');
        $lineSubtotal = $linePrice * $qty;
        $normalized[] = [
            'product_id'   => $productId,
            'variant_id'   => $variantId,
            'product_name' => $productName,
            'variant_name' => $variantName,
            'quantity'     => $qty,
            'price'        => $linePrice,
        ];
        $subtotal += $lineSubtotal;
    }

    return [$normalized, $subtotal];
}

function rpc_process_transaction(array $p): mixed {
    $pdo = getDB();
    $pdo->beginTransaction();
    try {
        $cart          = $p['p_cart']           ?? [];
        $branchId      = (int)($p['p_branch_id']     ?? 0);
        $staffId       = (int)($p['p_staff_id']      ?? 0);
        $sessionId     = !empty($p['p_session_id']) ? (int)$p['p_session_id'] : null;
        $paymentMethod = $p['p_payment_method'] ?? 'cash';
        $paymentAmount = (float)($p['p_payment_amount']  ?? 0);
        $discountAmount= (float)($p['p_discount_amount'] ?? 0);
        $taxAmount     = (float)($p['p_tax_amount']      ?? 0);
        $feeAmount     = (float)($p['p_fee_amount']      ?? 0);
        $notes         = $p['p_notes']          ?? null;
        $clientTxId    = normalizeClientTxId($p['p_client_tx_id']   ?? null);
        $authUser      = $p['_auth_user'] ?? null;
        $memberId      = !empty($p['p_member_id']) ? (int)$p['p_member_id'] : null;
        $redemptionCode= isset($p['p_redemption_code']) ? strtoupper(trim((string)$p['p_redemption_code'])) : '';

        if (!is_array($cart) || !$cart || !$branchId || !$staffId || !$paymentMethod)
            throw new Exception('Parameter transaksi tidak lengkap');
        if ($discountAmount < 0 || $taxAmount < 0 || $feeAmount < 0 || $paymentAmount < 0) {
            throw new Exception('Nominal transaksi tidak boleh negatif');
        }
        if ($authUser && !isAdminUser($authUser)) {
            if ((int)$authUser['id'] !== $staffId) throw new Exception('staff_id tidak sesuai session');
            requireBranchAccess($authUser, $branchId);
        }
        $paymentMethod = normalizePaymentMethod($pdo, (string)$paymentMethod);

        // Wajib ada sesi kas yang masih aktif untuk staff + outlet yang sama.
        if (!$sessionId) {
            throw new Exception('Kas belum dibuka. Buka shift terlebih dahulu sebelum transaksi.');
        }
        $sessChk = $pdo->prepare("
            SELECT id
            FROM cashier_sessions
            WHERE id = ?
              AND branch_id = ?
              AND staff_id = ?
              AND status = 'open'
            LIMIT 1
        ");
        $sessChk->execute([$sessionId, $branchId, $staffId]);
        if (!$sessChk->fetch()) {
            throw new Exception('Shift kas tidak aktif atau sudah ditutup. Buka shift lagi sebelum transaksi.');
        }

        // Idempotency check
        if ($clientTxId) {
            $chk = $pdo->prepare("SELECT id,subtotal,total,payment_amount,change_amount,discount_amount,tax_amount,fee_amount,status,client_tx_id FROM transactions WHERE client_tx_id = ? LIMIT 1");
            $chk->execute([$clientTxId]);
            $existing = $chk->fetch();
            if ($existing) { $pdo->rollBack(); return $existing; }
        }

        // Hitung ulang cart dari database. Harga/nama/subtotal dari frontend diabaikan.
        [$cart, $subtotal] = resolveTransactionCartFromDb($pdo, $branchId, $cart);
        if ($discountAmount > $subtotal) throw new Exception('Diskon tidak boleh melebihi subtotal');
        $total        = $subtotal - $discountAmount + $taxAmount + $feeAmount;
        if ($total < 0) throw new Exception('Total transaksi tidak boleh negatif');
        if ($paymentAmount < $total) throw new Exception('Pembayaran kurang dari total transaksi');
        $changeAmount = $paymentAmount - $total;

        // Fallback duplicate detection only for clients without clientTxId.
        // Different clientTxId means different transaction; broad same-total
        // matching can swallow legitimate back-to-back sales.
        if (!$clientTxId) {
            $dupChk = $pdo->prepare("
                SELECT id, subtotal, total, payment_amount, change_amount, discount_amount, tax_amount, fee_amount, status
                FROM transactions
                WHERE branch_id  = ?
                  AND staff_id   = ?
                  AND session_id = ?
                  AND payment_method = ?
                  AND total = ?
                  AND payment_amount = ?
                  AND discount_amount = ?
                  AND tax_amount = ?
                  AND fee_amount = ?
                  AND status = 'completed'
                  AND created_at >= NOW() - INTERVAL 5 SECOND
                ORDER BY created_at DESC
                LIMIT 5
            ");
            $dupChk->execute([$branchId, $staffId, $sessionId, $paymentMethod, $total, $paymentAmount, $discountAmount, $taxAmount, $feeAmount]);
            foreach ($dupChk->fetchAll() as $dupTx) {
                if (transactionCartMatches($pdo, (int)$dupTx['id'], $cart)) {
                    $pdo->rollBack();
                    return $dupTx;
                }
            }
        }

        // ── Member loyalty: validasi & lock klaim reward (jika ada) SEBELUM insert ──
        // Diskon reward sudah disertakan frontend di $discountAmount; di sini kita pastikan
        // klaim valid & cakupan diskonnya benar, lalu dikonsumsi setelah transaksi dibuat.
        $redeemClaim = null;
        if ($redemptionCode !== '' && memberLoyaltyEnabled($pdo)) {
            $redeemClaim = memberValidateClaimForCheckout($pdo, $redemptionCode, $memberId, $subtotal, $cart, $discountAmount);
            if (!$memberId) $memberId = (int)$redeemClaim['member_id']; // adopsi member dari klaim
        }

        // Insert transaction
        $stmt = $pdo->prepare("
            INSERT INTO transactions
              (branch_id,staff_id,session_id,payment_method,payment_amount,
               subtotal,discount_amount,tax_amount,fee_amount,total,change_amount,
               notes,status,client_tx_id)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?,'completed',?)
        ");
        try {
            $stmt->execute([
                $branchId,$staffId,$sessionId,$paymentMethod,$paymentAmount,
                $subtotal,$discountAmount,$taxAmount,$feeAmount,$total,$changeAmount,
                $notes,$clientTxId
            ]);
        } catch (PDOException $e) {
            if ($clientTxId && ($e->getCode() === '23000' || str_contains(strtolower($e->getMessage()), 'duplicate'))) {
                $chk = $pdo->prepare("SELECT id,subtotal,total,payment_amount,change_amount,discount_amount,tax_amount,fee_amount,status,client_tx_id FROM transactions WHERE client_tx_id = ? LIMIT 1");
                $chk->execute([$clientTxId]);
                $existing = $chk->fetch();
                if ($existing) { $pdo->rollBack(); return $existing; }
            }
            throw $e;
        }
        $txId = (int)$pdo->lastInsertId();

        // Insert items
        $itemStmt = $pdo->prepare("
            INSERT INTO transaction_items
              (transaction_id,product_id,variant_id,product_name,variant_name,quantity,price,subtotal)
            VALUES (?,?,?,?,?,?,?,?)
        ");
        foreach ($cart as $item) {
            $itemStmt->execute([
                $txId,
                $item['product_id'],
                $item['variant_id'],
                $item['product_name'],
                $item['variant_name'],
                $item['quantity'], $item['price'], $item['price'] * $item['quantity']
            ]);
        }

        // Log cash if payment is cash
        if (strtolower($paymentMethod) === 'cash' && $total > 0 && $sessionId) {
            $cat = $pdo->query("SELECT id FROM cash_categories WHERE name='Penjualan Tunai' AND type='in' LIMIT 1")->fetch();
            if ($cat) {
                $pdo->prepare("
                    INSERT INTO cash_logs (branch_id,session_id,type,category_id,amount,note,created_by,reference_type,reference_id)
                    VALUES (?,?,'in',?,?,?,?,'sale',?)
                ")->execute([$branchId,$sessionId,$cat['id'],$total,"Penjualan #$txId",$staffId,$txId]);
            }
        }

        // ── Member loyalty: konsumsi klaim reward (atomic, di transaksi yang sama) ──
        if ($redeemClaim) {
            memberCommitClaimAtCheckout($pdo, $redeemClaim, $txId, $branchId, $staffId, $authUser);
        }

        // ── Member loyalty: award point (opt-in, atomic, non-breaking) ──────────
        $pointResult = null;
        if ($memberId && memberLoyaltyEnabled($pdo)) {
            $S = memberGetSettings($pdo);
            // Default: transaksi yang memakai reward tidak mendapat point (point_on_reward_transaction).
            if ($redeemClaim && empty($S['point_on_reward_transaction'])) {
                $pdo->prepare("UPDATE transactions SET member_id=?, member_attached_at=NOW(), points_awarded=0 WHERE id=?")->execute([$memberId, $txId]);
                $pdo->prepare("UPDATE members SET last_transaction_at=NOW() WHERE id=?")->execute([$memberId]);
                $pointResult = ['points_awarded' => 0, 'balance' => memberBalances($pdo, $memberId), 'note' => 'Transaksi memakai reward — tidak dapat point'];
            } else {
                $pointResult = memberAwardPointsForTransaction($pdo, [
                    'tx_id'      => $txId,
                    'branch_id'  => $branchId,
                    'staff_id'   => $staffId,
                    'member_id'  => $memberId,
                    'subtotal'   => $subtotal,
                    'discount'   => $discountAmount,
                    'cart'       => $cart,
                    'auth_user'  => $authUser,
                ]);
            }
        }

        $pdo->commit();
        auditLog($authUser, 'transaction_create', 'transactions', null, ['id'=>$txId,'total'=>$total,'payment_method'=>$paymentMethod], $branchId);
        return [
            'id'              => $txId,
            'subtotal'        => $subtotal,
            'discount_amount' => $discountAmount,
            'tax_amount'      => $taxAmount,
            'fee_amount'      => $feeAmount,
            'total'           => $total,
            'change_amount'   => $changeAmount,
            'status'          => 'completed',
            'member_id'       => $memberId,
            'points_awarded'  => $pointResult['points_awarded'] ?? 0,
            'member_balance'  => $pointResult['balance'] ?? null,
            'point_note'      => $pointResult['note'] ?? null,
            'reward_redeemed' => $redeemClaim ? [
                'claim_id'    => (int)$redeemClaim['id'],
                'reward_name' => $redeemClaim['_reward']['name'] ?? null,
                'discount'    => (float)($redeemClaim['_reward_discount'] ?? 0),
            ] : null,
        ];
    } catch (Throwable $e) {
        $pdo->rollBack();
        throw $e;
    }
}

// ── get_branch_cash_position ──────────────────────────────────────────────────
function rpc_get_branch_cash_position(array $p): mixed {
    $pdo      = getDB();
    $branchId = (int)($p['p_branch_id'] ?? 0);
    if (!$branchId) throw new Exception('branch_id wajib diisi');

    $bal = $pdo->prepare("SELECT * FROM branch_cash_balances WHERE branch_id = ? LIMIT 1");
    $bal->execute([$branchId]);
    $balance = $bal->fetch();

    $pending = $pdo->prepare("SELECT COALESCE(SUM(amount),0) AS total FROM cash_deposits WHERE branch_id=? AND status='pending'");
    $pending->execute([$branchId]);
    $pendingAmt = (float)$pending->fetchColumn();

    $session = $pdo->prepare("SELECT id,staff_id,status,opening_cash,opened_at FROM cashier_sessions WHERE branch_id=? AND status='open' LIMIT 1");
    $session->execute([$branchId]);
    $openSession = $session->fetch() ?: null;

    $lastSessStmt = $pdo->prepare("
        SELECT cs.id, cs.closed_at, u.name AS staff_name
        FROM cashier_sessions cs
        LEFT JOIN users u ON u.id = cs.staff_id
        WHERE cs.branch_id = ? AND cs.status = 'closed' AND cs.closed_at IS NOT NULL
        ORDER BY cs.closed_at DESC
        LIMIT 1
    ");
    $lastSessStmt->execute([$branchId]);
    $lastSess = $lastSessStmt->fetch() ?: null;

    return [
        'balance_id'             => $balance ? (int)$balance['id'] : null,
        'current_balance'        => $balance ? (float)$balance['current_balance'] : 0,
        'current_status'         => $balance['current_status'] ?? 'idle',
        'pending_deposit'        => $pendingAmt,
        'pending_deposit_amount' => $pendingAmt,
        'version'                => $balance ? (int)$balance['version'] : 0,
        'has_balance_row'        => (bool)$balance,
        'open_session'           => $openSession ? [
            'id'           => (int)$openSession['id'],
            'staff_id'     => (int)$openSession['staff_id'],
            'status'       => $openSession['status'],
            'opening_cash' => (float)$openSession['opening_cash'],
            'opened_at'    => $openSession['opened_at'],
        ] : null,
        'last_closed_by'         => $balance['last_closed_by'] ?? null,
        'last_closed_at'         => $lastSess['closed_at'] ?? null,
        'last_closed_session'    => $lastSess ? [
            'staff_name' => $lastSess['staff_name'],
            'closed_at'  => $lastSess['closed_at'],
        ] : null,
    ];
}

// ── check_shift_status ────────────────────────────────────────────────────────
// Dipakai oleh Sistem Inventori untuk menentukan apakah shift kasir sudah ditutup
// sebelum mengizinkan staff mengakses/submit laporan inventori.
function rpc_check_shift_status(array $p): mixed {
    $pdo      = getDB();
    $branchId = (int)($p['p_branch_id'] ?? 0);
    if (!$branchId) throw new Exception('p_branch_id wajib diisi');

    // Hitung reporting date (WITA, cutoff 03:00) server-side jika tidak disediakan
    $date = trim($p['p_date'] ?? '');
    if (!$date || !preg_match('/^\d{4}-\d{2}-\d{2}$/', $date)) {
        $tz  = new DateTimeZone('Asia/Makassar');
        $now = new DateTime('now', $tz);
        if ((int)$now->format('H') < 3) {
            $now->modify('-1 day');
        }
        $date = $now->format('Y-m-d');
    }

    // 1. Cek sesi yang masih terbuka (status = 'open')
    $openStmt = $pdo->prepare("
        SELECT id, staff_id, opened_at
        FROM cashier_sessions
        WHERE branch_id = ? AND status = 'open'
        LIMIT 1
    ");
    $openStmt->execute([$branchId]);
    $openSess = $openStmt->fetch();

    if ($openSess) {
        return [
            'shift_closed'    => false,
            'reason'          => 'shift_open',
            'reporting_date'  => $date,
            'open_session_id' => (int)$openSess['id'],
            'opened_at'       => $openSess['opened_at'],
            'message'         => 'Shift kasir outlet ini masih terbuka dan belum ditutup.',
        ];
    }

    // 2. Cek sesi yang sudah ditutup pada reporting date
    //    Cakupan: opened_at ATAU closed_at ada di tanggal tsb (menangani shift melewati tengah malam)
    $closedStmt = $pdo->prepare("
        SELECT id, opened_at, closed_at
        FROM cashier_sessions
        WHERE branch_id = ?
          AND status = 'closed'
          AND (DATE(opened_at) = ? OR DATE(closed_at) = ?)
        ORDER BY closed_at DESC
        LIMIT 1
    ");
    $closedStmt->execute([$branchId, $date, $date]);
    $closedSess = $closedStmt->fetch();

    if ($closedSess) {
        return [
            'shift_closed'   => true,
            'reporting_date' => $date,
            'session_id'     => (int)$closedSess['id'],
            'opened_at'      => $closedSess['opened_at'],
            'closed_at'      => $closedSess['closed_at'],
        ];
    }

    // 3. Tidak ada sesi sama sekali hari ini
    return [
        'shift_closed'   => false,
        'reason'         => 'no_session',
        'reporting_date' => $date,
        'message'        => 'Belum ada sesi kasir yang dibuka atau ditutup untuk outlet ini hari ini.',
    ];
}

// Inventory integration RPCs used by the Google Apps Script inventory portal.
function rpc_inventory_list_branches(array $p): mixed {
    $pdo = getDB();
    $stmt = $pdo->query("
        SELECT id, name
        FROM branches
        ORDER BY name
        LIMIT 500
    ");
    return $stmt->fetchAll();
}

function rpc_inventory_list_ingredients(array $p): mixed {
    $pdo = getDB();
    $stmt = $pdo->query("
        SELECT id, name, unit
        FROM ingredients
        ORDER BY name
        LIMIT 1000
    ");
    return $stmt->fetchAll();
}

function parsePositiveIntListParam(mixed $value, int $maxItems = 500): array {
    if (is_string($value)) {
        $raw = trim($value);
        if ($raw === '') return [];
        if (str_starts_with($raw, '[')) {
            $decoded = json_decode($raw, true);
            $value = is_array($decoded) ? $decoded : explode(',', $raw);
        } else {
            $value = explode(',', $raw);
        }
    } elseif (!is_array($value)) {
        $value = [$value];
    }

    $ids = [];
    foreach ($value as $item) {
        $id = (int)$item;
        if ($id > 0) $ids[$id] = $id;
        if (count($ids) >= $maxItems) break;
    }
    return array_values($ids);
}

function rpc_inventory_get_branch_stock(array $p): mixed {
    $pdo = getDB();
    $branchId = (int)($p['p_branch_id'] ?? 0);
    if (!$branchId) throw new Exception('p_branch_id wajib diisi');

    $ingredientIds = parsePositiveIntListParam($p['p_ingredient_ids'] ?? []);
    if (!$ingredientIds) return [];

    $placeholders = implode(',', array_fill(0, count($ingredientIds), '?'));
    $stmt = $pdo->prepare("
        SELECT ingredient_id, stock, updated_at
        FROM branch_inventory
        WHERE branch_id = ?
          AND ingredient_id IN ($placeholders)
        LIMIT 500
    ");
    $stmt->execute(array_merge([$branchId], $ingredientIds));
    return $stmt->fetchAll();
}

// open_cash_session_from_branch_balance
function rpc_open_cash_session_from_branch_balance(array $p): mixed {
    $pdo       = getDB();
    $branchId  = (int)($p['p_branch_id']     ?? 0);
    $staffId   = (int)($p['p_staff_id']      ?? 0);
    $physCash  = isset($p['p_physical_cash']) ? (float)$p['p_physical_cash'] : null;
    $varReason = $p['p_variance_reason'] ?? null;
    $authUser  = $p['_auth_user'] ?? null;

    $pdo->beginTransaction();
    try {
        // Check for open session
        $hasOpen = $pdo->prepare("SELECT id FROM cashier_sessions WHERE branch_id=? AND status='open' LIMIT 1");
        $hasOpen->execute([$branchId]);
        if ($hasOpen->fetch()) throw new Exception('Masih ada kas yang belum ditutup di cabang ini');

        // Get or create branch balance
        $balStmt = $pdo->prepare("SELECT * FROM branch_cash_balances WHERE branch_id=? LIMIT 1");
        $balStmt->execute([$branchId]);
        $balance = $balStmt->fetch();

        if (!$balance) {
            $pdo->prepare("INSERT INTO branch_cash_balances (branch_id,current_balance,version) VALUES (?,0,1)")->execute([$branchId]);
            $balStmt->execute([$branchId]);
            $balance = $balStmt->fetch();
        }

        $openingCash = (float)$balance['current_balance'];
        $variance    = ($physCash !== null) ? $physCash - $openingCash : 0;

        if ($variance != 0 && !trim((string)($varReason ?? '')))
            throw new Exception('Alasan selisih kas wajib diisi jika kas fisik berbeda dari saldo sistem');

        // Insert session
        $pdo->prepare("
            INSERT INTO cashier_sessions
              (branch_id,staff_id,opening_cash,status,opening_cash_source,
               opening_physical_cash,opening_variance_amount,opening_variance_reason,
               opening_confirmed_at,opening_confirmed_by)
            VALUES (?,?,?,'open','balance',?,?,?,NOW(),?)
        ")->execute([$branchId,$staffId,$openingCash,$physCash,$variance,$varReason,$staffId]);
        $sessionId = (int)$pdo->lastInsertId();

        // Update balance status
        $pdo->prepare("UPDATE branch_cash_balances SET current_status='active',last_open_session_id=?,last_opened_by=?,updated_at=NOW() WHERE branch_id=?")
            ->execute([$sessionId,$staffId,$branchId]);

        // Ledger entry
        rpcInsertBranchCashLedger($pdo, $branchId, $staffId, null, $sessionId, null,
            'session_open_confirm','none',0,$openingCash,$openingCash,
            'Buka kas dari saldo cabang','cashier_sessions',(string)$sessionId);

        $pdo->commit();
        auditLog($authUser, 'cash_session_open', 'cashier_sessions', null, ['id'=>$sessionId,'opening_cash'=>$openingCash], $branchId);
        return [
            'id'                  => $sessionId,
            'branch_id'           => $branchId,
            'staff_id'            => $staffId,
            'status'              => 'open',
            'opening_cash'        => $openingCash,
            'opening_cash_source' => 'balance',
            'physical_cash'       => $physCash,
            'variance'            => $variance,
        ];
    } catch (Throwable $e) { $pdo->rollBack(); throw $e; }
}

// ── close_cash_session_apply_branch_balance ───────────────────────────────────
function rpc_close_cash_session_apply_branch_balance(array $p): mixed {
    $pdo        = getDB();
    $sessionId  = (int)($p['p_session_id']  ?? 0);
    $closingCash= (float)($p['p_closing_cash'] ?? 0);
    $staffId    = (int)($p['p_staff_id']    ?? 0);
    $closingNote= trim($p['p_closing_note'] ?? '');
    $authUser   = $p['_auth_user'] ?? null;
    if (!$sessionId) throw new Exception('session_id wajib diisi');
    if (!$staffId) throw new Exception('staff_id wajib diisi');
    if ($closingCash < 0) throw new Exception('Kas akhir tidak boleh negatif');

    $pdo->beginTransaction();
    try {
        $sess = $pdo->prepare("SELECT * FROM cashier_sessions WHERE id=? FOR UPDATE");
        $sess->execute([$sessionId]);
        $session = $sess->fetch();
        if (!$session) throw new Exception('Sesi tidak ditemukan');
        if ($session['status'] === 'closed') {
            $pdo->rollBack();
            return ['id'=>$sessionId,'status'=>'closed','already_closed'=>true,'closing_cash'=>(float)$session['closing_cash']];
        }
        if ((int)$session['staff_id'] !== $staffId) throw new Exception('Session ini bukan milik staff yang bersangkutan');

        $branchId   = (int)$session['branch_id'];
        $openingCash= (float)$session['opening_cash'];

        // Compute expected cash from cash_logs
        $exp = $pdo->prepare("
            SELECT COALESCE(SUM(CASE WHEN type='in' AND is_void=0 THEN amount ELSE 0 END),0)
                 - COALESCE(SUM(CASE WHEN type='out' AND is_void=0 THEN amount ELSE 0 END),0)
            FROM cash_logs WHERE session_id=?
        ");
        $exp->execute([$sessionId]);
        $expectedCash = $openingCash + (float)$exp->fetchColumn();

        $pdo->prepare("UPDATE cashier_sessions SET status='closed',closing_cash=?,expected_cash=?,current_cash_amount=?,closed_at=NOW(),balance_applied_at=NOW() WHERE id=?")
            ->execute([$closingCash,$expectedCash,$closingCash,$sessionId]);

        // Update branch_cash_balances
        $balStmt = $pdo->prepare("SELECT * FROM branch_cash_balances WHERE branch_id=? FOR UPDATE");
        $balStmt->execute([$branchId]);
        $balance = $balStmt->fetch();

        $balanceBefore = $balance ? (float)$balance['current_balance'] : 0;

        if (!$balance) {
            $pdo->prepare("INSERT INTO branch_cash_balances (branch_id,current_balance,current_status,last_closed_session_id,last_closed_by,version) VALUES (?,?,'idle',?,?,1)")
                ->execute([$branchId,$closingCash,$sessionId,$staffId]);
        } else {
            $pdo->prepare("UPDATE branch_cash_balances SET current_balance=?,current_status='idle',last_closed_session_id=?,last_closed_by=?,version=version+1,updated_at=NOW(),updated_by=? WHERE branch_id=?")
                ->execute([$closingCash,$sessionId,$staffId,$staffId,$branchId]);
        }

        $ledgerNote = $closingNote ? 'Tutup kas — ' . $closingNote : 'Tutup kas — saldo cabang diperbarui';
        rpcInsertBranchCashLedger($pdo,$branchId,$staffId,null,$sessionId,null,
            'session_close', $closingCash >= $balanceBefore ? 'in' : 'out',
            abs($closingCash - $balanceBefore),$balanceBefore,$closingCash,
            $ledgerNote,'cashier_sessions',(string)$sessionId);

        $pdo->commit();
        auditLog($authUser, 'cash_session_close', 'cashier_sessions', $session, ['closing_cash'=>$closingCash,'expected_cash'=>$expectedCash], $branchId);
        return [
            'id'             => $sessionId,
            'status'         => 'closed',
            'closing_cash'   => $closingCash,
            'expected_cash'  => $expectedCash,
            'balance_before' => $balanceBefore,
            'balance_after'  => $closingCash,
            'already_closed' => false,
        ];
    } catch (Throwable $e) { $pdo->rollBack(); throw $e; }
}

// ── admin_force_close_branch_cash_session ─────────────────────────────────────
function rpc_admin_force_close_branch_cash_session(array $p): mixed {
    $pdo       = getDB();
    $adminId   = (int)($p['p_admin_id']    ?? 0);
    $branchId  = (int)($p['p_branch_id']   ?? 0);
    $sessionId = (int)($p['p_session_id']   ?? 0);
    $closingCash = (float)($p['p_closing_cash'] ?? 0);
    $reason    = trim($p['p_reason'] ?? '');
    if (!$reason) throw new Exception('Alasan force close wajib diisi');
    if ($closingCash < 0) throw new Exception('Kas akhir tidak boleh negatif');

    $admin = $pdo->prepare("SELECT role FROM users WHERE id=? LIMIT 1");
    $admin->execute([$adminId]);
    $ar = $admin->fetch();
    if (!$ar || !in_array($ar['role'],['admin','owner'])) throw new Exception('Hanya admin/owner yang bisa force close');

    if ($sessionId) {
        $sess = $pdo->prepare("SELECT id FROM cashier_sessions WHERE id=? AND status='open' LIMIT 1");
        $sess->execute([$sessionId]);
    } else {
        $sess = $pdo->prepare("SELECT id FROM cashier_sessions WHERE branch_id=? AND status='open' LIMIT 1");
        $sess->execute([$branchId]);
    }
    $s = $sess->fetch();
    if (!$s) throw new Exception('Tidak ada sesi terbuka di cabang ini');

    $sessData = $pdo->prepare("SELECT staff_id FROM cashier_sessions WHERE id=? LIMIT 1");
    $sessData->execute([$s['id']]);
    $sd = $sessData->fetch();
    $note = 'Ditutup paksa oleh admin (ID:' . $adminId . ') — ' . $reason;
    return rpc_close_cash_session_apply_branch_balance([
        'p_session_id'   => $s['id'],
        'p_closing_cash' => $closingCash,
        'p_staff_id'     => $sd['staff_id'],
        'p_closing_note' => $note,
        '_auth_user'     => $p['_auth_user'] ?? null,
    ]);
}

// ── admin_set_branch_cash_balance ─────────────────────────────────────────────
function rpc_admin_set_branch_cash_balance(array $p): mixed {
    $pdo        = getDB();
    $adminId    = (int)($p['p_admin_id']    ?? 0);
    $branchId   = (int)($p['p_branch_id']   ?? 0);
    $newBalance = (float)($p['p_new_balance'] ?? 0);
    $reason     = trim($p['p_reason'] ?? '');
    if (!$branchId) throw new Exception('branch_id wajib diisi');
    if (!$reason) throw new Exception('Alasan koreksi saldo wajib diisi');
    if ($newBalance < 0) throw new Exception('Saldo tidak boleh negatif');

    // Validasi role: hanya admin/owner yang boleh mengubah saldo kas outlet
    $adminStmt = $pdo->prepare("SELECT role FROM users WHERE id=? LIMIT 1");
    $adminStmt->execute([$adminId]);
    $ar = $adminStmt->fetch();
    if (!$ar || !in_array($ar['role'], ['admin', 'owner'], true)) {
        throw new Exception('Hanya admin/owner yang dapat mengubah saldo kas outlet');
    }

    $pdo->beginTransaction();
    try {
        $balStmt = $pdo->prepare("SELECT * FROM branch_cash_balances WHERE branch_id=? FOR UPDATE");
        $balStmt->execute([$branchId]);
        $balance = $balStmt->fetch();
        $before  = $balance ? (float)$balance['current_balance'] : 0;

        if (!$balance) {
            $pdo->prepare("INSERT INTO branch_cash_balances (branch_id,current_balance,version,updated_by) VALUES (?,?,1,?)")
                ->execute([$branchId,$newBalance,$adminId]);
        } else {
            $pdo->prepare("UPDATE branch_cash_balances SET current_balance=?,version=version+1,updated_by=?,updated_at=NOW() WHERE branch_id=?")
                ->execute([$newBalance,$adminId,$branchId]);
        }

        // Gunakan uuid4() sebagai source_id agar setiap koreksi admin
        // menghasilkan row unik di branch_cash_ledger.
        // Bug lama: source_id = branch_id (static) → INSERT IGNORE menolak entry ke-2+
        // karena UNIQUE KEY (source_table, source_id, movement_type) sudah terisi.
        rpcInsertBranchCashLedger($pdo,$branchId,null,$adminId,null,null,
            'admin_adjustment','adjust',abs($newBalance-$before),$before,$newBalance,
            $reason,'admin_adjustment',uuid4());

        $pdo->commit();
        return ['balance_before'=>$before,'balance_after'=>$newBalance,'branch_id'=>$branchId];
    } catch (Throwable $e) { $pdo->rollBack(); throw $e; }
}

// ── get_admin_branch_cash_positions ──────────────────────────────────────────
function rpc_get_admin_branch_cash_positions(array $p): mixed {
    $pdo     = getDB();
    $adminId = (int)($p['p_admin_id'] ?? 0);
    $admin   = $pdo->prepare("SELECT role FROM users WHERE id=? LIMIT 1");
    $admin->execute([$adminId]);
    $ar = $admin->fetch();
    if (!$ar || !in_array($ar['role'],['admin','owner'])) throw new Exception('Hanya admin/owner');

    $stmt = $pdo->query("
        SELECT
          b.id   AS branch_id,
          b.name AS branch_name,
          COALESCE(bcb.current_balance, 0)      AS current_balance,
          COALESCE(bcb.current_status, 'idle')  AS current_status,
          COALESCE(bcb.version, 0)              AS version,

          os.id                                 AS open_session_id,
          os.staff_id                           AS open_staff_id,
          os.staff_id                           AS open_session_staff_id,
          os.opened_at                          AS open_session_opened_at,
          u_open.name                           AS open_staff_name,

          CASE
            WHEN os.id IS NOT NULL THEN 'open'
            WHEN lc.id IS NOT NULL AND DATE(lc.closed_at) = CURDATE() THEN 'closed_today'
            ELSE 'not_open'
          END                                   AS shift_status,

          lc.opening_cash                       AS last_opening_cash,
          lc.closing_cash                       AS last_closing_cash,
          u_lc_open.name                        AS last_opened_by_name,
          u_lc_close.name                       AS last_closed_by_name,

          0                                     AS has_variance,
          NULL                                  AS last_variance_amount,

          (
            SELECT COALESCE(SUM(cd.amount), 0)
            FROM cash_deposits cd
            WHERE cd.branch_id = b.id
              AND cd.status = 'pending'
          )                                     AS pending_deposit_amount,

          -- Kas estimasi saat shift aktif: opening_cash + mutasi cash_logs sesi ini
          (
            SELECT COALESCE(acs.opening_cash, 0)
                 + COALESCE(
                     (SELECT SUM(
                        CASE WHEN cl.type='in'  AND cl.is_void=0 THEN  cl.amount
                             WHEN cl.type='out' AND cl.is_void=0 THEN -cl.amount
                             ELSE 0 END)
                      FROM cash_logs cl WHERE cl.session_id = acs.id),
                     0
                   )
            FROM cashier_sessions acs
            WHERE acs.branch_id = b.id AND acs.status = 'open'
            ORDER BY acs.opened_at DESC
            LIMIT 1
          )                                     AS estimated_running_cash

        FROM branches b
        LEFT JOIN branch_cash_balances bcb
          ON bcb.branch_id = b.id
        LEFT JOIN cashier_sessions os
          ON os.id = (
            SELECT cs1.id
            FROM cashier_sessions cs1
            WHERE cs1.branch_id = b.id
              AND cs1.status = 'open'
            ORDER BY cs1.opened_at DESC
            LIMIT 1
          )
        LEFT JOIN users u_open
          ON u_open.id = os.staff_id
        LEFT JOIN cashier_sessions lc
          ON lc.id = (
            SELECT cs2.id
            FROM cashier_sessions cs2
            WHERE cs2.branch_id = b.id
              AND cs2.status = 'closed'
              AND cs2.closing_cash IS NOT NULL
            ORDER BY cs2.closed_at DESC
            LIMIT 1
          )
        LEFT JOIN users u_lc_open
          ON u_lc_open.id = lc.staff_id
        LEFT JOIN users u_lc_close
          ON u_lc_close.id = COALESCE(bcb.last_closed_by, lc.staff_id)
        WHERE COALESCE(b.is_active, 1) = 1
        ORDER BY b.name
    ");
    return $stmt->fetchAll();
}

// ── get_branch_cash_ledger ────────────────────────────────────────────────────
// Menggabungkan dua sumber data:
//   1. branch_cash_ledger  — perubahan saldo komit (shift buka/tutup, koreksi admin, setoran, transfer)
//   2. cash_logs           — gerakan kas per-sesi (penjualan tunai, kas masuk/keluar manual, refund, void)
//
// cash_logs.reference_type='deposit' & 'opening' dikecualikan agar tidak duplikat dengan
// branch_cash_ledger yang sudah mencatat deposit_approved dan session_open_confirm.
function rpc_get_branch_cash_ledger(array $p): mixed {
    $pdo          = getDB();
    $branchId     = (int)($p['p_branch_id'] ?? 0);
    $dateFrom     = !empty($p['p_date_from'])     ? trim($p['p_date_from'])     : null;
    $dateTo       = !empty($p['p_date_to'])       ? trim($p['p_date_to'])       : null;
    $movementType = !empty($p['p_movement_type']) ? trim($p['p_movement_type']) : null;
    $limit        = (int)($p['p_limit'] ?? 200);

    // ── Sisi 1: branch_cash_ledger (perubahan saldo komit) ──────────────────
    $ledgerConds  = ['bcl.branch_id = ?'];
    $ledgerParams = [$branchId];
    if ($movementType) { $ledgerConds[] = 'bcl.movement_type = ?'; $ledgerParams[] = $movementType; }
    if ($dateFrom)     { $ledgerConds[] = 'bcl.created_at >= ?';   $ledgerParams[] = witaDateToUtc($dateFrom); }
    if ($dateTo)       { $ledgerConds[] = 'bcl.created_at <= ?';   $ledgerParams[] = witaDateToUtc($dateTo, true); }
    $ledgerWhere = 'WHERE ' . implode(' AND ', $ledgerConds);

    // ── Sisi 2: cash_logs (gerakan kas per-sesi) ─────────────────────────────
    // Hanya sertakan tipe yang TIDAK sudah ada di branch_cash_ledger:
    //   - sale    → penjualan tunai (atau void penjualan jika is_void=1)
    //   - manual  → kas masuk/keluar manual staff
    //   - refund  → refund (dicatat oleh rpc_refund_transaction)
    // 'deposit' dan 'opening' dikecualikan (sudah ada di branch_cash_ledger).
    $logConds  = [
        'cl.branch_id = ?',
        "cl.reference_type IN ('sale','manual','refund')",
    ];
    $logParams = [$branchId];
    if ($dateFrom) { $logConds[] = 'cl.created_at >= ?'; $logParams[] = witaDateToUtc($dateFrom); }
    if ($dateTo)   { $logConds[] = 'cl.created_at <= ?'; $logParams[] = witaDateToUtc($dateTo, true); }
    // Jika filter movement_type bukan tipe yang ada di cash_logs, skip sisi ini
    $cashLogMovementTypes = [
        'sale_cash_in','sale_cash_void','manual_cash_in','manual_cash_out',
        'manual_cash_in_void','manual_cash_out_void','refund',
    ];
    $includeCashLogs = !$movementType || in_array($movementType, $cashLogMovementTypes, true);
    $logWhere = 'WHERE ' . implode(' AND ', $logConds);

    // ── UNION query ──────────────────────────────────────────────────────────
    $allParams = $ledgerParams;

    $unionPart = '';
    if ($includeCashLogs) {
        $unionPart = "
        UNION ALL

        SELECT
            CAST(CONCAT('cl-', cl.id) AS CHAR(50)) AS id,
            CASE
                WHEN cl.is_void = 1 AND cl.reference_type = 'sale'   THEN 'sale_cash_void'
                WHEN cl.is_void = 1 AND cl.reference_type = 'manual' AND cl.type = 'in'  THEN 'manual_cash_in_void'
                WHEN cl.is_void = 1 AND cl.reference_type = 'manual' AND cl.type = 'out' THEN 'manual_cash_out_void'
                WHEN cl.reference_type = 'sale'   AND cl.type = 'in'  THEN 'sale_cash_in'
                WHEN cl.reference_type = 'manual' AND cl.type = 'in'  THEN 'manual_cash_in'
                WHEN cl.reference_type = 'manual' AND cl.type = 'out' THEN 'manual_cash_out'
                WHEN cl.reference_type = 'refund'                     THEN 'refund'
                ELSE CONCAT(cl.type, '_', COALESCE(cl.reference_type,'other'))
            END                              AS movement_type,
            CASE
                WHEN cl.is_void = 1 THEN 'adjust'
                ELSE cl.type
            END                              AS direction,
            cl.amount,
            NULL                             AS balance_before,
            NULL                             AS balance_after,
            NULL                             AS variance_amount,
            cl.note                          AS reason,
            cl.created_at,
            COALESCE(u.name,'')              AS staff_name,
            NULL                             AS admin_name
        FROM cash_logs cl
        LEFT JOIN users u ON u.id = cl.created_by
        $logWhere";
        $allParams = array_merge($allParams, $logParams);
    }

    $allParams[] = $limit;

    $stmt = $pdo->prepare("
        SELECT * FROM (
            SELECT
                bcl.id,
                bcl.movement_type,
                bcl.direction,
                bcl.amount,
                bcl.balance_before,
                bcl.balance_after,
                bcl.variance_amount,
                bcl.reason,
                bcl.created_at,
                COALESCE(u.name,'') AS staff_name,
                COALESCE(a.name,'') AS admin_name
            FROM branch_cash_ledger bcl
            LEFT JOIN users u ON u.id = bcl.staff_id
            LEFT JOIN users a ON a.id = bcl.admin_id
            $ledgerWhere
            $unionPart
        ) AS combined
        ORDER BY combined.created_at DESC
        LIMIT ?
    ");
    $stmt->execute($allParams);
    return $stmt->fetchAll();
}

// ── get_admin_cash_sessions ───────────────────────────────────────────────────
function rpc_get_admin_cash_sessions(array $p): mixed {
    $pdo      = getDB();
    $adminId  = (int)($p['p_admin_id'] ?? 0);
    if ($adminId) {
        $adminChk = $pdo->prepare("SELECT role FROM users WHERE id=? LIMIT 1");
        $adminChk->execute([$adminId]);
        $ar = $adminChk->fetch();
        if (!$ar || !in_array($ar['role'],['admin','owner'])) throw new Exception('Hanya admin/owner');
    }
    $branchId = !empty($p['p_branch_id']) ? (int)$p['p_branch_id'] : null;
    $staffId  = !empty($p['p_staff_id'])  ? (int)$p['p_staff_id']  : null;
    $status   = !empty($p['p_status'])    ? trim($p['p_status'])    : null;
    $dateFrom = !empty($p['p_date_from']) ? trim($p['p_date_from']) : null;
    $dateTo   = !empty($p['p_date_to'])   ? trim($p['p_date_to'])   : null;
    $limit    = (int)($p['p_limit']       ?? 50);
    $offset   = (int)($p['p_offset']      ?? 0);

    $conditions = [];
    $params     = [];

    if ($branchId) { $conditions[] = 'cs.branch_id = ?'; $params[] = $branchId; }
    if ($staffId)  { $conditions[] = 'cs.staff_id  = ?'; $params[] = $staffId;  }
    if ($status)   { $conditions[] = 'cs.status    = ?'; $params[] = $status;   }
    if ($dateFrom) { $conditions[] = 'cs.opened_at >= ?'; $params[] = witaDateToUtc($dateFrom); }
    if ($dateTo)   { $conditions[] = 'cs.opened_at <= ?'; $params[] = witaDateToUtc($dateTo, true); }

    $where = $conditions ? 'WHERE ' . implode(' AND ', $conditions) : '';
    $params[] = $limit;
    $params[] = $offset;

    $stmt = $pdo->prepare("
        SELECT cs.*, u.name AS staff_name, b.name AS branch_name
        FROM cashier_sessions cs
        LEFT JOIN users u ON u.id = cs.staff_id
        LEFT JOIN branches b ON b.id = cs.branch_id
        $where
        ORDER BY cs.opened_at DESC
        LIMIT ? OFFSET ?
    ");
    $stmt->execute($params);
    return $stmt->fetchAll();
}

// ── create_deposit ────────────────────────────────────────────────────────────
function rpc_create_deposit(array $p): mixed {
    $pdo       = getDB();
    $branchId  = (int)($p['p_branch_id']  ?? 0);
    $staffId   = (int)($p['p_staff_id']   ?? 0);
    $sessionId = $p['p_session_id'] ? (int)$p['p_session_id'] : null;
    $accountId = $p['p_deposit_account_id'] ?? $p['p_account_id'] ?? null;
    $amount    = (float)($p['p_amount']   ?? 0);
    $method    = $p['p_method']    ?? null;
    $proofUrl  = $p['p_proof_url'] ?? null;
    $notes     = $p['p_notes']     ?? null;
    $cashBalance = $p['p_cash_balance_at_deposit'] ?? null;

    if ($amount <= 0) throw new Exception('Nominal setoran harus lebih dari 0');
    if ((int)round($amount) % 50000 !== 0) throw new Exception('Nominal setoran harus kelipatan Rp 50.000');

    $pdo->beginTransaction();
    try {
        if ($sessionId) {
            $s = $pdo->prepare("SELECT status FROM cashier_sessions WHERE id=? LIMIT 1");
            $s->execute([$sessionId]);
            $sess = $s->fetch();
            if (!$sess || $sess['status'] !== 'closed') throw new Exception('Shift setoran belum tertutup');
        }

        // Blokir jika staff masih punya setoran pending di shift manapun
        $crossStmt = $pdo->prepare("
            SELECT COUNT(*) FROM cash_deposits
            WHERE staff_id=? AND branch_id=? AND status='pending'
        ");
        $crossStmt->execute([$staffId, $branchId]);
        if ((int)$crossStmt->fetchColumn() > 0) {
            throw new Exception('Masih ada setoran yang belum dikonfirmasi admin. Tunggu konfirmasi terlebih dahulu.');
        }

        // Validasi nominal tidak boleh melebihi saldo kas aktual cabang (termasuk transfer masuk).
        // Cek server-side ini memastikan integritas data meskipun frontend mengirim nilai yang stale.
        $branchBalChk = $pdo->prepare("SELECT current_balance FROM branch_cash_balances WHERE branch_id=? LIMIT 1");
        $branchBalChk->execute([$branchId]);
        $branchBalRow = $branchBalChk->fetchColumn();
        if ($branchBalRow !== false) {
            $branchBalance = (float)$branchBalRow;
            $pendingChk = $pdo->prepare("SELECT COALESCE(SUM(amount), 0) FROM cash_deposits WHERE branch_id=? AND status='pending'");
            $pendingChk->execute([$branchId]);
            $pendingTotal = (float)$pendingChk->fetchColumn();
            $availableBalance = max(0.0, $branchBalance - $pendingTotal);
            if ($amount > $availableBalance) {
                throw new Exception(
                    'Nominal setoran (Rp ' . number_format($amount, 0, ',', '.') . ') melebihi saldo kas outlet yang tersedia ' .
                    '(Rp ' . number_format($availableBalance, 0, ',', '.') . '). ' .
                    'Saldo kas sudah mencakup transfer tunai masuk dari cabang lain.'
                );
            }
        }

        $id = uuid4();
        $row = [
            'id'         => $id,
            'branch_id'  => $branchId,
            'staff_id'   => $staffId,
            'session_id' => $sessionId,
            'amount'     => $amount,
            'method'     => $method,
            'proof_url'  => $proofUrl,
            'notes'      => $notes,
            'status'     => 'pending',
            'account_id' => $accountId,
        ];
        if (dbColumnExists($pdo, 'cash_deposits', 'cash_balance_at_deposit')) $row['cash_balance_at_deposit'] = $cashBalance;
        foreach (['proof_file_name','proof_file_type','proof_file_size','proof_uploaded_at'] as $suffix) {
            $param = 'p_' . $suffix;
            if (array_key_exists($param, $p) && dbColumnExists($pdo, 'cash_deposits', $suffix)) $row[$suffix] = $p[$param];
        }
        insertDynamic($pdo, 'cash_deposits', $row);

        $pdo->commit();
        return ['id'=>$id,'status'=>'pending','amount'=>$amount];
    } catch (Throwable $e) {
        $pdo->rollBack();
        throw $e;
    }
}

// ── admin_create_manual_deposit ───────────────────────────────────────────────
function rpc_admin_create_manual_deposit(array $p): mixed {
    $pdo      = getDB();
    $adminId  = (int)($p['p_admin_id']  ?? 0);
    $branchId = (int)($p['p_branch_id'] ?? 0);
    $staffId  = !empty($p['p_staff_id']) ? (int)$p['p_staff_id'] : null;
    $sessionId = !empty($p['p_session_id']) ? (int)$p['p_session_id'] : null;
    $accountId = $p['p_deposit_account_id'] ?? $p['p_account_id'] ?? null;
    $amount   = (float)($p['p_amount']  ?? 0);
    $notes    = $p['p_notes'] ?? null;
    $method   = $p['p_method'] ?? null;
    $proofUrl = $p['p_proof_url'] ?? null;

    $admin = $pdo->prepare("SELECT role FROM users WHERE id=? LIMIT 1");
    $admin->execute([$adminId]);
    $ar = $admin->fetch();
    if (!$ar || !in_array($ar['role'],['admin','owner'])) throw new Exception('Hanya admin/owner');
    if (!$branchId) throw new Exception('Cabang wajib dipilih');
    if (!$accountId) throw new Exception('Metode setoran wajib dipilih');
    if ($amount <= 0) throw new Exception('Nominal setoran harus lebih dari 0');
    if ((int)round($amount) % 50000 !== 0) throw new Exception('Nominal setoran harus kelipatan Rp 50.000');

    $pdo->beginTransaction();
    try {
        $branchStmt = $pdo->prepare("SELECT id FROM branches WHERE id=? AND COALESCE(is_active,1)=1 LIMIT 1");
        $branchStmt->execute([$branchId]);
        if (!$branchStmt->fetch()) throw new Exception('Cabang tidak aktif atau tidak ditemukan');

        $accountStmt = $pdo->prepare("
            SELECT id, label, type
            FROM deposit_accounts
            WHERE id=?
              AND COALESCE(is_active,1)=1
              AND (branch_id IS NULL OR branch_id=?)
            LIMIT 1
        ");
        $accountStmt->execute([$accountId, $branchId]);
        $account = $accountStmt->fetch();
        if (!$account) throw new Exception('Metode setoran tidak aktif untuk cabang ini');
        if (is_array($method)) $method = $method['type'] ?? $method['label'] ?? null;
        if ($method === null || $method === '') $method = $account['type'] ?? 'manual';
        $method = substr((string)$method, 0, 50);

        if ($sessionId) {
            $s = $pdo->prepare("SELECT branch_id, staff_id, status FROM cashier_sessions WHERE id=? LIMIT 1");
            $s->execute([$sessionId]);
            $sess = $s->fetch();
            if (!$sess || (int)$sess['branch_id'] !== $branchId || $sess['status'] !== 'closed') {
                throw new Exception('Shift setoran tidak valid untuk cabang ini');
            }
            if ($staffId === null && !empty($sess['staff_id'])) $staffId = (int)$sess['staff_id'];
        }

        $openStmt = $pdo->prepare("SELECT id FROM cashier_sessions WHERE branch_id=? AND status='open' LIMIT 1");
        $openStmt->execute([$branchId]);
        if ($openStmt->fetch()) {
            throw new Exception('Masih ada shift aktif di outlet ini. Tutup shift terlebih dahulu sebelum setoran manual.');
        }

        $pendingStmt = $pdo->prepare("
            SELECT id, amount
            FROM cash_deposits
            WHERE branch_id=? AND status='pending'
            FOR UPDATE
        ");
        $pendingStmt->execute([$branchId]);
        $pendingAmount = 0.0;
        foreach ($pendingStmt->fetchAll() as $pendingRow) {
            $pendingAmount += (float)$pendingRow['amount'];
        }

        $balStmt = $pdo->prepare("SELECT * FROM branch_cash_balances WHERE branch_id=? FOR UPDATE");
        $balStmt->execute([$branchId]);
        $bal = $balStmt->fetch();
        $before = $bal ? (float)$bal['current_balance'] : 0.0;
        $available = max(0.0, $before - $pendingAmount);
        if ($amount > $available) {
            throw new Exception(
                'Saldo kas outlet tidak mencukupi. ' .
                'Tersedia: Rp ' . number_format($available, 0, ',', '.') .
                ', nominal setoran: Rp ' . number_format($amount, 0, ',', '.')
            );
        }

        $id = uuid4();
        $after = $before - $amount;
        $row = [
            'id' => $id,
            'branch_id' => $branchId,
            'staff_id' => $staffId,
            'session_id' => $sessionId,
            'amount' => $amount,
            'method' => $method,
            'proof_url' => $proofUrl,
            'notes' => $notes,
            'status' => 'confirmed',
            'reviewed_by' => $adminId,
        ];
        if (dbColumnExists($pdo, 'cash_deposits', 'reviewed_at')) $row['reviewed_at'] = date('Y-m-d H:i:s');
        if (dbColumnExists($pdo, 'cash_deposits', 'cash_balance_at_deposit')) $row['cash_balance_at_deposit'] = $before;
        $row['account_id'] = $accountId;
        foreach (['proof_file_name','proof_file_type','proof_file_size','proof_uploaded_at'] as $suffix) {
            $param = 'p_' . $suffix;
            if (array_key_exists($param, $p) && dbColumnExists($pdo, 'cash_deposits', $suffix)) $row[$suffix] = $p[$param];
        }
        insertDynamic($pdo, 'cash_deposits', $row);

        // Cash log untuk konteks sesi
        if ($sessionId) {
            $cat = $pdo->query("SELECT id FROM cash_categories WHERE name='Setoran Tunai' AND type='out' LIMIT 1")->fetch();
            $pdo->prepare("
                INSERT INTO cash_logs (branch_id,session_id,type,category_id,amount,note,created_by,reference_type,reference_id)
                VALUES (?,?,'out',?,?,?,?,'deposit',?)
            ")->execute([
                $branchId,$sessionId,$cat['id']??null,
                $amount,"Setoran Manual #{$id}",$adminId,$id
            ]);
        }

        // Kurangi saldo kas outlet
        if (!$bal) {
            $pdo->prepare("INSERT INTO branch_cash_balances (branch_id,current_balance,version,updated_by) VALUES (?,?,1,?)")
                ->execute([$branchId,$after,$adminId]);
        } else {
            $pdo->prepare("UPDATE branch_cash_balances SET current_balance=?,version=version+1,updated_by=?,updated_at=NOW() WHERE branch_id=?")
                ->execute([$after,$adminId,$branchId]);
        }
        rpcInsertBranchCashLedger($pdo,$branchId,$staffId,$adminId,
            $sessionId,null,
            'deposit_approved','out',$amount,$before,$after,
            'Setoran manual dikonfirmasi admin','cash_deposits',$id);
        if (dbColumnExists($pdo, 'cash_deposits', 'balance_applied_at')) {
            $pdo->prepare("UPDATE cash_deposits SET balance_applied_at=NOW() WHERE id=?")->execute([$id]);
        }

        $pdo->commit();
        return ['id'=>$id,'status'=>'confirmed','amount'=>$amount,'balance_before'=>$before,'balance_after'=>$after];
    } catch (Throwable $e) {
        $pdo->rollBack();
        throw $e;
    }
}

// ── confirm_deposit ───────────────────────────────────────────────────────────
function rpc_confirm_deposit(array $p): mixed {
    $pdo       = getDB();
    $depositId = $p['p_deposit_id'] ?? '';
    $adminId   = (int)($p['p_admin_id'] ?? 0);
    $action    = $p['p_action']    ?? '';
    $rejectReason = $p['p_reject_reason'] ?? null;

    if (!in_array($action,['confirmed','rejected'])) throw new Exception("Action harus 'confirmed' atau 'rejected'");

    $admin = $pdo->prepare("SELECT role FROM users WHERE id=? LIMIT 1");
    $admin->execute([$adminId]);
    $ar = $admin->fetch();
    if (!$ar || !in_array($ar['role'],['admin','owner'])) throw new Exception('Hanya admin/owner');

    // Gunakan transaction + row lock untuk mencegah double approval karena race condition.
    $pdo->beginTransaction();
    try {
        $dep = $pdo->prepare("SELECT * FROM cash_deposits WHERE id=? FOR UPDATE");
        $dep->execute([$depositId]);
        $deposit = $dep->fetch();
        if (!$deposit) throw new Exception('Setoran tidak ditemukan');
        if ($deposit['status'] !== 'pending') throw new Exception("Setoran sudah diproses (status: {$deposit['status']})");
        if ($action === 'rejected' && strlen(trim((string)$rejectReason)) < 3) {
            throw new Exception('Alasan penolakan wajib diisi minimal 3 karakter');
        }

        if ($deposit['session_id']) {
            $s = $pdo->prepare("SELECT status FROM cashier_sessions WHERE id=? LIMIT 1");
            $s->execute([$deposit['session_id']]);
            $sess = $s->fetch();
            if (!$sess || $sess['status'] !== 'closed') throw new Exception('Shift setoran belum tertutup');
        }

        $upd = $pdo->prepare("UPDATE cash_deposits SET status=?,reviewed_by=?,reviewed_at=NOW(),reject_reason=? WHERE id=? AND status='pending'")
            ->execute([$action,$adminId,$action==='rejected' ? $rejectReason : null,$depositId]);
        if ($upd === false) throw new Exception('Gagal memproses status setoran');

        if ($action === 'confirmed') {
            // Cash log
            $cat = $pdo->query("SELECT id FROM cash_categories WHERE name='Setoran Tunai' AND type='out' LIMIT 1")->fetch();
            if ($deposit['session_id']) {
                $pdo->prepare("
                    INSERT INTO cash_logs (branch_id,session_id,type,category_id,amount,note,created_by,reference_type,reference_id)
                    VALUES (?,?,'out',?,?,?,?,'deposit',?)
                ")->execute([
                    $deposit['branch_id'],$deposit['session_id'],$cat['id']??null,
                    $deposit['amount'],"Setoran #{$depositId}",$adminId,$depositId
                ]);
            }

            // Update branch cash balance (only if not already applied to avoid double-deduction)
            $balStmt = $pdo->prepare("SELECT * FROM branch_cash_balances WHERE branch_id=? FOR UPDATE");
            $balStmt->execute([$deposit['branch_id']]);
            $bal = $balStmt->fetch();
            if ($bal && $deposit['balance_applied_at'] === null) {
                $before       = (float)$bal['current_balance'];
                $depositAmt   = (float)$deposit['amount'];
                if ($depositAmt > $before) {
                    throw new Exception(
                        'Saldo kas outlet tidak mencukupi untuk konfirmasi setoran ini. ' .
                        'Saldo tersedia: Rp ' . number_format($before, 0, ',', '.') .
                        ', nominal setoran: Rp ' . number_format($depositAmt, 0, ',', '.')
                    );
                }
                $after  = $before - $depositAmt;
                $pdo->prepare("UPDATE branch_cash_balances SET current_balance=?,version=version+1,updated_at=NOW() WHERE branch_id=?")
                    ->execute([$after,$deposit['branch_id']]);
                $ledgerStaffId = !empty($deposit['staff_id']) ? (int)$deposit['staff_id'] : null;
                rpcInsertBranchCashLedger($pdo,(int)$deposit['branch_id'],$ledgerStaffId,$adminId,
                    $deposit['session_id'] !== null ? (int)$deposit['session_id'] : null,null,
                    'deposit_approved','out',(float)$deposit['amount'],$before,$after,
                    'Setoran diapprove','cash_deposits',$depositId);
                $pdo->prepare("UPDATE cash_deposits SET balance_applied_at=NOW() WHERE id=?")->execute([$depositId]);
            }
        }

        $pdo->commit();
        return ['success'=>true,'status'=>$action];
    } catch (Throwable $e) { $pdo->rollBack(); throw $e; }
}

// ── get_deposit_eligible_sessions ────────────────────────────────────────────
function rpc_get_deposit_eligible_sessions(array $p): mixed {
    $pdo      = getDB();
    $branchId = (int)($p['p_branch_id'] ?? 0);
    $staffId  = (int)($p['p_staff_id']  ?? 0);

    $limit = isset($p['p_limit']) ? (int)$p['p_limit'] : 10;

    // Ambil semua closed sessions (termasuk yang sudah punya deposit)
    $stmt = $pdo->prepare("
        SELECT cs.id, cs.id AS session_id, cs.opened_at, cs.closed_at,
               cs.opening_cash, cs.closing_cash, cs.status,
               cs.status AS session_status,
               u.name AS staff_name,
               COALESCE(cs.closing_cash, cs.opening_cash, 0) AS base_cash
        FROM cashier_sessions cs
        LEFT JOIN users u ON u.id = cs.staff_id
        WHERE cs.branch_id=? AND cs.staff_id=? AND cs.status='closed'
        ORDER BY cs.closed_at DESC
        LIMIT ?
    ");
    $stmt->execute([$branchId, $staffId, $limit]);
    $sessions = $stmt->fetchAll();

    if (empty($sessions)) return [];

    // Ambil deposit aktif untuk semua sessions sekaligus
    $sessionIds = array_column($sessions, 'id');
    $placeholders = implode(',', array_fill(0, count($sessionIds), '?'));
    $depsStmt = $pdo->prepare("
        SELECT session_id, amount, status
        FROM cash_deposits
        WHERE session_id IN ($placeholders)
          AND status IN ('pending','confirmed')
        ORDER BY status DESC
    ");
    $depsStmt->execute($sessionIds);
    $allDeposits = $depsStmt->fetchAll();

    // Group deposit per session
    $depsBySession = [];
    foreach ($allDeposits as $d) {
        $sid = $d['session_id'];
        if (!isset($depsBySession[$sid])) {
            $depsBySession[$sid] = ['pending' => 0.0, 'confirmed' => 0.0, 'lastStatus' => null];
        }
        $depsBySession[$sid][$d['status']] += (float)$d['amount'];
        $depsBySession[$sid]['lastStatus'] = $d['status'];
    }

    // Apakah ada pending deposit di shift manapun untuk staff ini?
    $hasAnyPending = false;
    foreach ($allDeposits as $d) {
        if ($d['status'] === 'pending') { $hasAnyPending = true; break; }
    }

    // Saldo kas aktual cabang dari branch_cash_balances (sudah termasuk transfer masuk/keluar yang dikonfirmasi).
    // Ini adalah nilai yang BENAR untuk menghitung depositable_cash karena mencerminkan
    // semua komponen: kas tutup shift, transfer tunai masuk, transfer tunai keluar, deposit yang sudah dikonfirmasi.
    $branchBalStmt = $pdo->prepare("SELECT COALESCE(current_balance, 0) FROM branch_cash_balances WHERE branch_id=? LIMIT 1");
    $branchBalStmt->execute([$branchId]);
    $branchCurrentBalance = (float)($branchBalStmt->fetchColumn() ?? 0.0);

    // Kurangi dengan total pending deposit di level cabang (semua sesi, bukan hanya sesi ini)
    // agar tidak terjadi over-deposit ketika ada deposit yang belum dikonfirmasi admin.
    $pendingBranchStmt = $pdo->prepare("SELECT COALESCE(SUM(amount), 0) FROM cash_deposits WHERE branch_id=? AND status='pending'");
    $pendingBranchStmt->execute([$branchId]);
    $totalPendingBranch = (float)($pendingBranchStmt->fetchColumn() ?? 0.0);

    // Kas bersih yang bisa disetor = saldo aktual cabang - deposit pending yang belum dikonfirmasi
    $netDepositable = max(0.0, $branchCurrentBalance - $totalPendingBranch);

    return array_map(function($row) use ($depsBySession, $hasAnyPending, $netDepositable, $branchCurrentBalance) {
        $sid = $row['id'];
        $dep = $depsBySession[$sid] ?? ['pending' => 0.0, 'confirmed' => 0.0, 'lastStatus' => null];
        $totalDep  = $dep['pending'] + $dep['confirmed'];

        $blockReason = null;
        if ($totalDep > 0 && $dep['lastStatus'] === 'pending') {
            $blockReason = 'Setoran sedang menunggu konfirmasi';
        } elseif ($totalDep > 0 && $dep['lastStatus'] === 'confirmed') {
            $blockReason = 'Setoran shift ini sudah selesai';
        } elseif ($hasAnyPending && $dep['pending'] == 0) {
            $blockReason = 'Masih ada setoran dari shift lain yang menunggu konfirmasi';
        }

        // Gunakan saldo aktual cabang sebagai depositable (bukan hanya closing_cash sesi),
        // sehingga transfer tunai masuk dari cabang lain ikut terhitung.
        $depositable = $netDepositable;

        $row['depositable_cash']      = $depositable;
        $row['branch_current_balance'] = $branchCurrentBalance;
        $row['has_active_deposit']    = $totalDep > 0;
        $row['last_deposit_status']   = $dep['lastStatus'];
        $row['block_reason']          = $blockReason;
        return $row;
    }, $sessions);
}

// ── create_cash_branch_transfer ───────────────────────────────────────────────
function rpc_create_cash_branch_transfer(array $p): mixed {
    $pdo         = getDB();
    $fromBranch  = (int)($p['p_from_branch_id'] ?? 0);
    $toBranch    = (int)($p['p_to_branch_id']   ?? 0);
    $sessionId   = (int)($p['p_session_id']     ?? 0);
    $staffId     = (int)($p['p_staff_id']       ?? 0);
    $amount      = (float)($p['p_amount']       ?? 0);
    $notes       = $p['p_notes']       ?? null;
    $proofUrl    = $p['p_proof_url']   ?? null;
    $clientReqId = $p['p_client_request_id'] ?? null;

    if ($fromBranch === $toBranch) throw new Exception('Outlet asal dan tujuan tidak boleh sama');
    if ($amount <= 0) throw new Exception('Nominal transfer harus lebih dari 0');
    if (!$sessionId || !$staffId) throw new Exception('Session dan staff wajib diisi');

    // Transfer hanya boleh dibuat dari shift staff sendiri yang sudah ditutup.
    $sess = $pdo->prepare("
        SELECT id, status
        FROM cashier_sessions
        WHERE id = ?
          AND branch_id = ?
          AND staff_id = ?
        LIMIT 1
    ");
    $sess->execute([$sessionId, $fromBranch, $staffId]);
    $sessRow = $sess->fetch();
    if (!$sessRow) throw new Exception('Session tidak valid untuk outlet/staff pengirim');
    if (($sessRow['status'] ?? null) !== 'closed') {
        throw new Exception('Transfer antar outlet hanya boleh dari shift yang sudah ditutup');
    }

    // Idempotency check: jika client_request_id sudah pernah dibuat, kembalikan data lama
    if ($clientReqId) {
        $exist = $pdo->prepare("SELECT id, transfer_code, status, amount FROM cash_branch_transfers WHERE client_request_id=? LIMIT 1");
        $exist->execute([$clientReqId]);
        $existing = $exist->fetch();
        if ($existing) {
            return ['id'=>$existing['id'],'transfer_code'=>$existing['transfer_code'],'status'=>$existing['status'],'amount'=>(float)$existing['amount'],'_idempotent'=>true];
        }
    }

    $id   = uuid4();
    $code = 'TRF-' . strtoupper(substr($id, 0, 8));

    $bal = $pdo->prepare("SELECT current_balance FROM branch_cash_balances WHERE branch_id=? LIMIT 1");
    $bal->execute([$fromBranch]);
    $cashAtRequest = (float)($bal->fetchColumn() ?? 0);
    if ($amount > $cashAtRequest) {
        throw new Exception('Saldo kas outlet asal tidak cukup untuk transfer');
    }

    $pdo->prepare("
        INSERT INTO cash_branch_transfers
          (id,transfer_code,from_branch_id,to_branch_id,session_id,staff_id,requested_by,
           amount,cash_balance_at_request,status,notes,proof_url,client_request_id)
        VALUES (?,?,?,?,?,?,?,?,?,'pending',?,?,?)
    ")->execute([$id,$code,$fromBranch,$toBranch,$sessionId,$staffId,$staffId,
                 $amount,$cashAtRequest,$notes,$proofUrl,$clientReqId]);

    return ['id'=>$id,'transfer_code'=>$code,'status'=>'pending','amount'=>$amount];
}

// ── get_pending_incoming_cash_branch_transfers ────────────────────────────────
function rpc_get_pending_incoming_cash_branch_transfers(array $p): mixed {
    $pdo      = getDB();
    $branchId = (int)($p['p_branch_id'] ?? 0);
    $staffId  = (int)($p['p_staff_id']  ?? 0);

    $stmt = $pdo->prepare("
        SELECT cbt.id AS transfer_id, cbt.*, fb.name AS from_branch_name, tb.name AS to_branch_name, su.name AS staff_name
        FROM cash_branch_transfers cbt
        JOIN branches fb ON fb.id = cbt.from_branch_id
        JOIN branches tb ON tb.id = cbt.to_branch_id
        LEFT JOIN users su ON su.id = cbt.staff_id
        WHERE cbt.to_branch_id=? AND cbt.status='pending'
        ORDER BY cbt.requested_at DESC
    ");
    $stmt->execute([$branchId]);
    return $stmt->fetchAll();
}

// ── confirm_cash_branch_transfer ──────────────────────────────────────────────
function rpc_confirm_cash_branch_transfer(array $p): mixed {
    $pdo        = getDB();
    $transferId = $p['p_transfer_id'] ?? '';
    $adminId    = (int)($p['p_admin_id'] ?? $p['p_user_id'] ?? 0);

    $pdo->beginTransaction();
    try {
        $t = $pdo->prepare("SELECT * FROM cash_branch_transfers WHERE id=? FOR UPDATE");
        $t->execute([$transferId]);
        $transfer = $t->fetch();
        if (!$transfer) throw new Exception('Transfer tidak ditemukan');
        if ($transfer['status'] !== 'pending') throw new Exception("Transfer sudah diproses (status: {$transfer['status']})");

        // Hanya staff outlet tujuan atau admin/owner yang boleh konfirmasi.
        $actor = $pdo->prepare("SELECT id, role, branch_id FROM users WHERE id=? LIMIT 1");
        $actor->execute([$adminId]);
        $actorRow = $actor->fetch();
        if (!$actorRow) throw new Exception('User approval tidak valid');
        $isAdmin = in_array($actorRow['role'] ?? '', ['admin', 'owner'], true);
        $isTargetStaff = (int)($actorRow['branch_id'] ?? 0) === (int)$transfer['to_branch_id'];
        if (!$isAdmin && !$isTargetStaff) {
            throw new Exception('Hanya staff outlet tujuan atau admin/owner yang dapat menyetujui transfer');
        }

        $amount = (float)$transfer['amount'];

        // Deduct source
        $srcBal = $pdo->prepare("SELECT * FROM branch_cash_balances WHERE branch_id=? FOR UPDATE");
        $srcBal->execute([$transfer['from_branch_id']]);
        $src = $srcBal->fetch();
        $srcBefore = $src ? (float)$src['current_balance'] : 0;
        if ($amount > $srcBefore) {
            throw new Exception('Saldo outlet asal tidak cukup untuk konfirmasi transfer');
        }
        $srcAfter  = $srcBefore - $amount;

        if ($src) {
            $pdo->prepare("UPDATE branch_cash_balances SET current_balance=?,version=version+1,updated_at=NOW() WHERE branch_id=?")->execute([$srcAfter,$transfer['from_branch_id']]);
        }

        // Add to destination
        $dstBal = $pdo->prepare("SELECT * FROM branch_cash_balances WHERE branch_id=? FOR UPDATE");
        $dstBal->execute([$transfer['to_branch_id']]);
        $dst = $dstBal->fetch();
        $dstBefore = $dst ? (float)$dst['current_balance'] : 0;
        $dstAfter  = $dstBefore + $amount;

        if ($dst) {
            $pdo->prepare("UPDATE branch_cash_balances SET current_balance=?,version=version+1,updated_at=NOW() WHERE branch_id=?")->execute([$dstAfter,$transfer['to_branch_id']]);
        } else {
            $pdo->prepare("INSERT INTO branch_cash_balances (branch_id,current_balance,version) VALUES (?,?,1)")->execute([$transfer['to_branch_id'],$dstAfter]);
        }

        // Update transfer
        $pdo->prepare("UPDATE cash_branch_transfers SET status='confirmed',confirmed_by=?,confirmed_at=NOW(),source_balance_before=?,source_balance_after=?,target_balance_before=?,target_balance_after=? WHERE id=?")
            ->execute([$adminId,$srcBefore,$srcAfter,$dstBefore,$dstAfter,$transferId]);

        // Ledger entries
        rpcInsertBranchCashLedger($pdo,(int)$transfer['from_branch_id'],(int)$transfer['staff_id'],$adminId,null,$transferId,'cash_branch_transfer_out','out',$amount,$srcBefore,$srcAfter,'Transfer kas keluar','cash_branch_transfers',$transferId);
        rpcInsertBranchCashLedger($pdo,(int)$transfer['to_branch_id'],null,$adminId,null,$transferId,'cash_branch_transfer_in','in',$amount,$dstBefore,$dstAfter,'Transfer kas masuk','cash_branch_transfers',$transferId.'_in');

        $pdo->commit();
        return ['success'=>true,'status'=>'confirmed'];
    } catch (Throwable $e) { $pdo->rollBack(); throw $e; }
}

// ── reject_cash_branch_transfer ───────────────────────────────────────────────
function rpc_reject_cash_branch_transfer(array $p): mixed {
    $pdo    = getDB();
    $id     = $p['p_transfer_id']  ?? '';
    $userId = (int)($p['p_user_id'] ?? 0);
    $reason = trim($p['p_reason']   ?? '');
    if (!$reason) throw new Exception('Alasan penolakan wajib diisi');

    $pdo->beginTransaction();
    try {
        $t = $pdo->prepare("SELECT * FROM cash_branch_transfers WHERE id=? FOR UPDATE");
        $t->execute([$id]);
        $transfer = $t->fetch();
        if (!$transfer) throw new Exception('Transfer tidak ditemukan');
        if (($transfer['status'] ?? null) !== 'pending') throw new Exception("Transfer sudah diproses (status: {$transfer['status']})");

        $actor = $pdo->prepare("SELECT id, role, branch_id FROM users WHERE id=? LIMIT 1");
        $actor->execute([$userId]);
        $actorRow = $actor->fetch();
        if (!$actorRow) throw new Exception('User tidak valid');
        $isAdmin = in_array($actorRow['role'] ?? '', ['admin', 'owner'], true);
        $isTargetStaff = (int)($actorRow['branch_id'] ?? 0) === (int)$transfer['to_branch_id'];
        if (!$isAdmin && !$isTargetStaff) {
            throw new Exception('Hanya staff outlet tujuan atau admin/owner yang dapat menolak transfer');
        }

        $pdo->prepare("UPDATE cash_branch_transfers SET status='rejected',rejected_by=?,rejected_at=NOW(),reject_reason=? WHERE id=? AND status='pending'")
            ->execute([$userId,$reason,$id]);
        $pdo->commit();
    } catch (Throwable $e) {
        $pdo->rollBack();
        throw $e;
    }
    return ['success'=>true,'status'=>'rejected'];
}

// ── cancel_cash_branch_transfer ───────────────────────────────────────────────
function rpc_cancel_cash_branch_transfer(array $p): mixed {
    $pdo    = getDB();
    $id     = $p['p_transfer_id']  ?? '';
    $userId = (int)($p['p_user_id'] ?? 0);
    $reason = trim($p['p_reason']   ?? '');

    $pdo->beginTransaction();
    try {
        $t = $pdo->prepare("SELECT * FROM cash_branch_transfers WHERE id=? FOR UPDATE");
        $t->execute([$id]);
        $transfer = $t->fetch();
        if (!$transfer) throw new Exception('Transfer tidak ditemukan');
        if (($transfer['status'] ?? null) !== 'pending') throw new Exception("Transfer sudah diproses (status: {$transfer['status']})");

        $actor = $pdo->prepare("SELECT id, role FROM users WHERE id=? LIMIT 1");
        $actor->execute([$userId]);
        $actorRow = $actor->fetch();
        if (!$actorRow) throw new Exception('User tidak valid');
        $isAdmin = in_array($actorRow['role'] ?? '', ['admin', 'owner'], true);
        $isRequester = (int)$transfer['requested_by'] === $userId || (int)$transfer['staff_id'] === $userId;
        if (!$isAdmin && !$isRequester) {
            throw new Exception('Hanya pembuat transfer atau admin/owner yang dapat membatalkan transfer');
        }

        $pdo->prepare("UPDATE cash_branch_transfers SET status='cancelled',cancelled_by=?,cancelled_at=NOW(),cancel_reason=? WHERE id=? AND status='pending'")
            ->execute([$userId,$reason,$id]);
        $pdo->commit();
    } catch (Throwable $e) {
        $pdo->rollBack();
        throw $e;
    }
    return ['success'=>true,'status'=>'cancelled'];
}

// ── get_cash_branch_transfer_history ─────────────────────────────────────────
function rpc_get_cash_branch_transfer_history(array $p): mixed {
    $pdo      = getDB();
    $branchId = (int)($p['p_branch_id'] ?? 0);
    $status   = $p['p_status'] ?? null;
    $limit    = (int)($p['p_limit']     ?? 30);
    $offset   = (int)($p['p_offset']    ?? 0);
    $conditions = ['(cbt.from_branch_id=? OR cbt.to_branch_id=?)'];
    $values = [$branchId, $branchId];
    if ($status) { $conditions[] = 'cbt.status=?'; $values[] = $status; }
    $values[] = $limit;
    $values[] = $offset;

    $stmt = $pdo->prepare("
        SELECT cbt.id AS transfer_id, cbt.*, fb.name AS from_branch_name, tb.name AS to_branch_name, su.name AS staff_name
        FROM cash_branch_transfers cbt
        JOIN branches fb ON fb.id = cbt.from_branch_id
        JOIN branches tb ON tb.id = cbt.to_branch_id
        LEFT JOIN users su ON su.id = cbt.staff_id
        WHERE " . implode(' AND ', $conditions) . "
        ORDER BY cbt.requested_at DESC
        LIMIT ? OFFSET ?
    ");
    $stmt->execute($values);
    return $stmt->fetchAll();
}

// ── get_admin_cash_branch_transfers ──────────────────────────────────────────
function rpc_get_admin_cash_branch_transfers(array $p): mixed {
    $pdo        = getDB();
    $adminId    = (int)($p['p_admin_id']       ?? 0);
    $fromBranch = $p['p_from_branch_id'] ? (int)$p['p_from_branch_id'] : null;
    $toBranch   = $p['p_to_branch_id']   ? (int)$p['p_to_branch_id']   : null;
    $status     = $p['p_status']   ?? null;
    $dateFrom   = $p['p_date_from'] ?? null;
    $dateTo     = $p['p_date_to']   ?? null;
    $limit      = (int)($p['p_limit']  ?? 200);
    $offset     = (int)($p['p_offset'] ?? 0);

    $admin = $pdo->prepare("SELECT role FROM users WHERE id=? LIMIT 1");
    $admin->execute([$adminId]);
    $ar = $admin->fetch();
    if (!$ar || !in_array($ar['role'],['admin','owner'])) throw new Exception('Hanya admin/owner');

    $conditions = [];
    $values     = [];
    if ($fromBranch) { $conditions[] = 'cbt.from_branch_id=?'; $values[] = $fromBranch; }
    if ($toBranch)   { $conditions[] = 'cbt.to_branch_id=?';   $values[] = $toBranch;   }
    if ($status)     { $conditions[] = 'cbt.status=?';          $values[] = $status;     }
    if ($dateFrom)   { $conditions[] = 'cbt.requested_at >= ?'; $values[] = witaDateToUtc($dateFrom); }
    if ($dateTo)     { $conditions[] = 'cbt.requested_at <= ?'; $values[] = witaDateToUtc($dateTo, true); }
    $where = $conditions ? 'WHERE ' . implode(' AND ', $conditions) : '';

    $values2 = array_merge($values, [$limit, $offset]);
    $stmt = $pdo->prepare("
        SELECT cbt.id AS transfer_id, cbt.*, fb.name AS from_branch_name, tb.name AS to_branch_name,
               su.name AS staff_name, cu.name AS confirmed_by_name,
               ru.name AS rejected_by_name
        FROM cash_branch_transfers cbt
        JOIN branches fb ON fb.id = cbt.from_branch_id
        JOIN branches tb ON tb.id = cbt.to_branch_id
        LEFT JOIN users su ON su.id = cbt.staff_id
        LEFT JOIN users cu ON cu.id = cbt.confirmed_by
        LEFT JOIN users ru ON ru.id = cbt.rejected_by
        $where
        ORDER BY cbt.requested_at DESC
        LIMIT ? OFFSET ?
    ");
    $stmt->execute($values2);
    $transfers = $stmt->fetchAll();

    $pendingConditions = array_merge($conditions, ["cbt.status='pending'"]);
    $pendingWhere = 'WHERE ' . implode(' AND ', $pendingConditions);
    $cndStmt = $pdo->prepare("SELECT COUNT(*) FROM cash_branch_transfers cbt $pendingWhere");
    $cndStmt2 = $pdo->prepare("SELECT COALESCE(SUM(cbt.amount),0) FROM cash_branch_transfers cbt $pendingWhere");
    $cndStmt->execute($values);
    $cndStmt2->execute($values);

    $sumStmt = $pdo->prepare("
        SELECT
          COALESCE(SUM(CASE WHEN cbt.status='confirmed' THEN cbt.amount ELSE 0 END),0) AS total_confirmed_amount,
          COALESCE(SUM(CASE WHEN cbt.status='rejected' THEN 1 ELSE 0 END),0) AS total_rejected_count,
          COALESCE(SUM(CASE WHEN cbt.status='rejected' THEN cbt.amount ELSE 0 END),0) AS total_rejected_amount
        FROM cash_branch_transfers cbt
        $where
    ");
    $sumStmt->execute($values);
    $summary = $sumStmt->fetch() ?: [];

    return [
        'transfers' => $transfers,
        'summary'   => [
            'total_pending_count'    => (int)$cndStmt->fetchColumn(),
            'total_pending_amount'   => (float)$cndStmt2->fetchColumn(),
            'total_confirmed_amount' => (float)($summary['total_confirmed_amount'] ?? 0),
            'total_rejected_count'    => (int)($summary['total_rejected_count'] ?? 0),
            'total_rejected_amount'   => (float)($summary['total_rejected_amount'] ?? 0),
        ],
    ];
}

// ── void_transaction ──────────────────────────────────────────────────────────
function rpc_void_transaction(array $p): mixed {
    $pdo   = getDB();
    $txId  = (int)($p['p_transaction_id'] ?? 0);
    $reason= trim($p['p_reason'] ?? '');
    $by    = (int)($p['p_user_id'] ?? $p['p_voided_by'] ?? 0);
    $authUser = $p['_auth_user'] ?? null;
    if (!$by && $authUser) $by = (int)$authUser['id'];
    if (!$reason) throw new Exception('Alasan void wajib diisi');

    $pdo->beginTransaction();
    try {
        $tx = $pdo->prepare("SELECT * FROM transactions WHERE id=? FOR UPDATE");
        $tx->execute([$txId]);
        $t = $tx->fetch();
        if (!$t || $t['status'] !== 'completed') throw new Exception('Transaksi tidak ditemukan atau sudah divoid');
        if ($authUser) requireBranchAccess($authUser, (int)$t['branch_id']);
        if ($authUser && !isAdminUser($authUser)) {
            $sess = $pdo->prepare("SELECT id FROM cashier_sessions WHERE id=? AND staff_id=? AND status='open' LIMIT 1");
            $sess->execute([(int)($t['session_id'] ?? 0), (int)$authUser['id']]);
            if (!$sess->fetch()) throw new Exception('Staff hanya boleh void transaksi pada shift aktif miliknya');
        }

        // Validasi akses branch: staff hanya boleh void transaksi outlet sendiri
        if ($by) {
            $userStmt = $pdo->prepare("SELECT role, branch_id FROM users WHERE id=? LIMIT 1");
            $userStmt->execute([$by]);
            $userRow = $userStmt->fetch();
            if ($userRow && !in_array($userRow['role'], ['admin', 'owner'], true)) {
                if ((int)$userRow['branch_id'] !== (int)$t['branch_id']) {
                    throw new Exception('Anda tidak memiliki akses untuk void transaksi outlet lain');
                }
            }
        }

        $pdo->prepare("UPDATE transactions SET status='voided' WHERE id=?")->execute([$txId]);

        $pdo->prepare("UPDATE cash_logs SET is_void=1,void_reason=?,void_by=?,void_at=NOW() WHERE reference_type='sale' AND reference_id=?")
            ->execute([$reason,$by,$txId]);

        // Member loyalty: balik point yang sudah diberikan + batalkan klaim reward terkait
        if (memberLoyaltyEnabled($pdo)) {
            memberReverseTransactionPoints($pdo, $t, null, $by, 'void: ' . $reason);
        }

        // Kembalikan stok bahan baku berdasarkan BOM (recipe)
        $branchId = (int)$t['branch_id'];
        $itemsStmt = $pdo->prepare("SELECT variant_id, quantity FROM transaction_items WHERE transaction_id=?");
        $itemsStmt->execute([$txId]);
        foreach ($itemsStmt->fetchAll() as $item) {
            if (!$item['variant_id']) continue;
            $recipeStmt = $pdo->prepare("SELECT id FROM recipes WHERE variant_id=? LIMIT 1");
            $recipeStmt->execute([$item['variant_id']]);
            $recipe = $recipeStmt->fetch();
            if (!$recipe) continue;
            $riStmt = $pdo->prepare("SELECT ingredient_id, quantity FROM recipe_items WHERE recipe_id=?");
            $riStmt->execute([$recipe['id']]);
            foreach ($riStmt->fetchAll() as $ri) {
                $ingId     = (int)$ri['ingredient_id'];
                $returnQty = (float)$ri['quantity'] * (float)$item['quantity'];
                if ($returnQty <= 0) continue;
                $curStmt = $pdo->prepare("SELECT stock FROM branch_inventory WHERE branch_id=? AND ingredient_id=? FOR UPDATE");
                $curStmt->execute([$branchId, $ingId]);
                $invRow = $curStmt->fetch();
                if (!$invRow) continue;
                $before = (float)$invRow['stock'];
                $after  = $before + $returnQty;
                $pdo->prepare("UPDATE branch_inventory SET stock=? WHERE branch_id=? AND ingredient_id=?")
                    ->execute([$after, $branchId, $ingId]);
                insertInventoryMovement($pdo, $branchId, $ingId, $returnQty, 'in', $before, $after,
                    "Void transaksi #{$txId}", $by ?: null, 'void', (string)$txId);
            }
        }

        $pdo->commit();
        auditLog($authUser, 'transaction_void', 'transactions', $t, ['reason'=>$reason,'voided_by'=>$by], (int)$t['branch_id']);
        return ['success'=>true,'transaction_id'=>$txId,'status'=>'voided'];
    } catch (Throwable $e) { $pdo->rollBack(); throw $e; }
}

// ── refund_transaction ────────────────────────────────────────────────────────
function rpc_refund_transaction(array $p): mixed {
    $pdo    = getDB();
    $txId   = (int)($p['p_transaction_id'] ?? 0);
    $reason = trim($p['p_reason'] ?? '');
    $by     = (int)($p['p_user_id'] ?? $p['p_refunded_by'] ?? 0);
    $refundAmount = isset($p['p_refund_amount']) ? (float)$p['p_refund_amount'] : null;
    $authUser = $p['_auth_user'] ?? null;
    if (!$by && $authUser) $by = (int)$authUser['id'];

    // Validasi akses branch sebelum membuka transaksi DB
    if ($by) {
        $userStmt = $pdo->prepare("SELECT role, branch_id FROM users WHERE id=? LIMIT 1");
        $userStmt->execute([$by]);
        $userRow = $userStmt->fetch();
    }

    $pdo->beginTransaction();
    try {
        $tx = $pdo->prepare("SELECT * FROM transactions WHERE id=? FOR UPDATE");
        $tx->execute([$txId]);
        $t = $tx->fetch();
        if (!$t || $t['status'] !== 'completed') throw new Exception('Transaksi tidak ditemukan atau tidak bisa direfund');
        if ($authUser) requireBranchAccess($authUser, (int)$t['branch_id']);
        if ($authUser && !isAdminUser($authUser)) {
            $sess = $pdo->prepare("SELECT id FROM cashier_sessions WHERE id=? AND staff_id=? AND status='open' LIMIT 1");
            $sess->execute([(int)($t['session_id'] ?? 0), (int)$authUser['id']]);
            if (!$sess->fetch()) throw new Exception('Staff hanya boleh refund transaksi pada shift aktif miliknya');
        }

        // Validasi akses branch: staff hanya boleh refund transaksi outlet sendiri
        if ($by && isset($userRow) && $userRow) {
            if (!in_array($userRow['role'], ['admin', 'owner'], true)) {
                if ((int)$userRow['branch_id'] !== (int)$t['branch_id']) {
                    throw new Exception('Anda tidak memiliki akses untuk refund transaksi outlet lain');
                }
            }
        }

        $amount = $refundAmount && $refundAmount > 0 ? $refundAmount : (float)$t['total'];
        $pdo->prepare("UPDATE transactions SET status='refunded' WHERE id=?")->execute([$txId]);
        $pdo->prepare("INSERT INTO refund_transactions (transaction_id,reason,amount,refunded_by) VALUES (?,?,?,?)")
            ->execute([$txId,$reason,$amount,$by]);
        $refundId = (int)$pdo->lastInsertId();

        // Member loyalty: balik point secara proporsional terhadap nominal refund
        if (memberLoyaltyEnabled($pdo)) {
            memberReverseTransactionPoints($pdo, $t, $amount, $by, 'refund: ' . $reason);
        }

        // Catat ke cash_logs agar refund muncul di Riwayat Kas.
        // Hanya untuk transaksi tunai (cash) karena hanya itu yang memengaruhi kas fisik.
        if (strtolower((string)($t['payment_method'] ?? '')) === 'cash' && $amount > 0) {
            $cat = $pdo->query("SELECT id FROM cash_categories WHERE name='Refund' AND type='out' LIMIT 1")->fetch();
            $pdo->prepare("
                INSERT INTO cash_logs
                  (branch_id, session_id, type, category_id, amount, note,
                   created_by, reference_type, reference_id)
                VALUES (?, ?, 'out', ?, ?, ?, ?, 'refund', ?)
            ")->execute([
                $t['branch_id'],
                $t['session_id'] ?? null,
                $cat['id'] ?? null,
                $amount,
                'Refund transaksi #' . $txId . ' — ' . $reason,
                $by ?: null,
                $refundId,
            ]);
        }

        $pdo->commit();
        auditLog($authUser, 'transaction_refund', 'transactions', $t, ['reason'=>$reason,'amount'=>$amount,'refunded_by'=>$by], (int)$t['branch_id']);
        return ['success'=>true,'refund_id'=>$refundId,'transaction_id'=>$txId,'status'=>'refunded'];
    } catch (Throwable $e) {
        $pdo->rollBack();
        throw $e;
    }
}

// ── adjust_stock_atomic ───────────────────────────────────────────────────────
function rpc_adjust_stock_atomic(array $p): mixed {
    $pdo          = getDB();
    $branchId     = (int)($p['p_branch_id']     ?? 0);
    $ingredientId = (int)($p['p_ingredient_id'] ?? 0);
    $qty          = (float)($p['p_qty'] ?? $p['p_quantity'] ?? 0);
    $type         = $p['p_type']   ?? 'adjustment';
    $note         = $p['p_notes'] ?? $p['p_note'] ?? null;
    $createdBy    = ($p['p_user_id'] ?? $p['p_created_by'] ?? null) ? (int)($p['p_user_id'] ?? $p['p_created_by']) : null;
    $referenceType = $p['p_reference_type'] ?? null;
    $referenceId   = $p['p_reference_id'] ?? null;

    // ── Validasi role ──────────────────────────────────────────────────────────
    $authUser = $p['_auth_user'] ?? null;
    $role     = $authUser['role'] ?? '';
    $isAdmin  = in_array($role, ['admin', 'owner'], true);
    $isStaff  = $role === 'staff';
    $isSystem = $role === '' || $role === 'system'; // sync dari PO pakai API key langsung

    if ($isStaff) {
        if ($type !== 'out') {
            denyHttp(403, 'Staff tidak memiliki izin untuk input stok masuk. Stok masuk hanya dapat dilakukan oleh admin atau otomatis dari purchase order.', 'STAFF_STOCK_IN_FORBIDDEN');
        }
        if (empty(trim((string)($note ?? '')))) {
            denyHttp(400, 'Alasan stok keluar wajib diisi', 'NOTES_REQUIRED');
        }
        $referenceType = 'stok_keluar_staff';
    } elseif ($isAdmin) {
        if ($type === 'in' && empty(trim((string)($note ?? '')))) {
            denyHttp(400, 'Catatan wajib diisi untuk stok masuk manual admin', 'NOTES_REQUIRED');
        }
        if ($type === 'opname' && empty(trim((string)($note ?? '')))) {
            denyHttp(400, 'Catatan wajib diisi untuk opname', 'NOTES_REQUIRED');
        }
        if ($type === 'in' && $referenceType === 'manual') {
            $referenceType = 'stok_masuk_manual_admin';
        }
    }

    // Branch ingredient mapping: jika bahan ini di-assign ke cabang tertentu,
    // hanya proses jika cabang saat ini termasuk dalam assignment-nya.
    $hasAny = $pdo->prepare("SELECT 1 FROM branch_ingredient_assignments WHERE ingredient_id=? LIMIT 1");
    $hasAny->execute([$ingredientId]);
    if ($hasAny->fetch()) {
        $isOk = $pdo->prepare("SELECT 1 FROM branch_ingredient_assignments WHERE ingredient_id=? AND branch_id=? LIMIT 1");
        $isOk->execute([$ingredientId, $branchId]);
        if (!$isOk->fetch()) {
            // Bahan tidak di-assign ke cabang ini → skip tanpa error
            return ['stock_before'=>0,'stock_after'=>0,'ingredient_id'=>$ingredientId,'delta'=>0,'skipped'=>true];
        }
    }

    $pdo->beginTransaction();
    try {
        $cur = $pdo->prepare("SELECT stock FROM branch_inventory WHERE branch_id=? AND ingredient_id=? FOR UPDATE");
        $cur->execute([$branchId,$ingredientId]);
        $row = $cur->fetch();
        $before = $row ? (float)$row['stock'] : 0;

        // Determine delta and final stock based on type:
        // 'out'    → subtract (qty is always positive from frontend, must be negated)
        // 'opname' → set absolute value (qty is the target stock level)
        // 'in' / anything else → add delta
        if ($type === 'opname') {
            $after = $qty; // set absolute stock level
            $delta = $qty - $before;
        } elseif ($type === 'out') {
            $delta = -abs($qty); // always subtract
            $after = $before + $delta;
        } else {
            $delta = $qty;
            $after = $before + $delta;
        }

        if ($row) {
            $pdo->prepare("UPDATE branch_inventory SET stock=? WHERE branch_id=? AND ingredient_id=?")->execute([$after,$branchId,$ingredientId]);
        } elseif ($type !== 'out') {
            // Only auto-create branch_inventory row for 'in' / 'opname' — never for 'out'.
            // Deducting an ingredient that was never explicitly stocked at this branch
            // would pollute the branch inventory view with unintended entries.
            $pdo->prepare("INSERT INTO branch_inventory (branch_id,ingredient_id,stock) VALUES (?,?,?)")->execute([$branchId,$ingredientId,$after]);
        }
        // For 'out' with no existing row: log the event below but do NOT create a row.

        $noteCol = dbColumnExists($pdo, 'inventory_logs', 'notes') ? 'notes' : 'note';
        $logRow = [
            'branch_id'    => $branchId,
            'ingredient_id' => $ingredientId,
            'type'         => $type,
            'quantity'     => $delta,
            'stock_before' => $before,
            'stock_after'  => $after,
            $noteCol       => $note,
            'created_by'   => $createdBy,
        ];
        if (dbColumnExists($pdo, 'inventory_logs', 'reference_type')) $logRow['reference_type'] = $referenceType;
        if (dbColumnExists($pdo, 'inventory_logs', 'reference_id'))   $logRow['reference_id']   = $referenceId;
        insertDynamic($pdo, 'inventory_logs', $logRow);

        $pdo->commit();
        return ['stock_before'=>$before,'stock_after'=>$after,'ingredient_id'=>$ingredientId,'delta'=>$delta];
    } catch (Throwable $e) { $pdo->rollBack(); throw $e; }
}

// ── get_ingredient_inventory_logs ────────────────────────────────────────────
function rpc_get_ingredient_inventory_logs(array $p): mixed {
    $pdo          = getDB();
    $branchId     = (int)($p['p_branch_id']     ?? 0);
    $ingredientId = (int)($p['p_ingredient_id'] ?? 0);
    $dateFrom     = !empty($p['p_date_from']) ? trim($p['p_date_from']) : null;
    $dateTo       = !empty($p['p_date_to'])   ? trim($p['p_date_to'])   : null;
    $type         = !empty($p['p_type'])      ? trim($p['p_type'])      : null;
    $limit        = (int)($p['p_limit']  ?? 50);
    $offset       = (int)($p['p_offset'] ?? 0);

    $conditions = ['il.branch_id=?', 'il.ingredient_id=?'];
    $params     = [$branchId, $ingredientId];
    if ($type)     { $conditions[] = 'il.type=?';          $params[] = $type; }
    if ($dateFrom) { $conditions[] = 'il.created_at >= ?'; $params[] = witaDateToUtc($dateFrom); }
    if ($dateTo)   { $conditions[] = 'il.created_at <= ?'; $params[] = witaDateToUtc($dateTo, true); }

    $where = 'WHERE ' . implode(' AND ', $conditions);
    $params[] = $limit;
    $params[] = $offset;

    $stmt = $pdo->prepare("
        SELECT il.*, i.name AS ingredient_name, i.unit AS ingredient_unit,
               u.name AS created_by_name, u.name AS user_name
        FROM inventory_logs il
        LEFT JOIN ingredients i ON i.id = il.ingredient_id
        LEFT JOIN users u ON u.id = il.created_by
        $where
        ORDER BY il.created_at DESC
        LIMIT ? OFFSET ?
    ");
    $stmt->execute($params);
    return $stmt->fetchAll();
}

// ── get_ingredient_avg_usage ──────────────────────────────────────────────────
function rpc_get_ingredient_avg_usage(array $p): mixed {
    $pdo      = getDB();
    $branchId = !empty($p['p_branch_id']) ? (int)$p['p_branch_id'] : null;
    $dateFrom = $p['p_date_from'] ?? date('Y-m-01');
    $dateTo   = $p['p_date_to']   ?? date('Y-m-d');

    $qtyCol = dbColumnExists($pdo, 'inventory_logs', 'qty') ? 'qty' : 'quantity';

    $conditions = ["il.type = 'out'", 'il.created_at >= ?', 'il.created_at <= ?'];
    $params     = [witaDateToUtc($dateFrom), witaDateToUtc($dateTo, true)];

    if ($branchId) {
        $conditions[] = 'il.branch_id = ?';
        $params[]     = $branchId;
    }

    $where = 'WHERE ' . implode(' AND ', $conditions);

    $stmt = $pdo->prepare("
        SELECT
          b.name AS branch_name,
          b.id   AS branch_id,
          i.name AS ingredient_name,
          i.unit,
          COUNT(DISTINCT DATE(CONVERT_TZ(il.created_at, '+00:00', '+08:00'))) AS active_days,
          COALESCE(SUM(ABS(il.`$qtyCol`)), 0)                                  AS total_used,
          ROUND(
            COALESCE(SUM(ABS(il.`$qtyCol`)), 0) /
            NULLIF(COUNT(DISTINCT DATE(CONVERT_TZ(il.created_at, '+00:00', '+08:00'))), 0),
            0
          ) AS avg_per_day
        FROM inventory_logs il
        JOIN ingredients i ON i.id = il.ingredient_id
        JOIN branches b    ON b.id = il.branch_id
        $where
        GROUP BY i.id, i.name, i.unit, il.branch_id, b.name, b.id
        ORDER BY b.name, avg_per_day DESC
    ");
    $stmt->execute($params);
    return $stmt->fetchAll();
}

// ── investor_get_sales_report ─────────────────────────────────────────────────
function rpc_investor_get_sales_report(array $p): mixed {
    $pdo      = getDB();
    $userId   = (int)($p['p_user_id']    ?? 0);
    $branchId = $p['p_branch_id'] ? (int)$p['p_branch_id'] : null;
    $dateFrom = $p['p_date_from'] ?? null;
    $dateTo   = $p['p_date_to']   ?? null;
    $paymentMethod = $p['p_payment_method'] ?? null;

    // Get allowed branches
    $branches = rpc_investor_get_allowed_branches(['p_user_id'=>$userId]);
    $branchIds = array_column($branches, 'branch_id');
    if ($branchId) {
        if (!in_array($branchId, array_map('intval', $branchIds), true) || !investorHasFeatureAccess($pdo, $userId, $branchId, 'sales')) {
            return ['transactions'=>[],'voidedTransactions'=>[],'totalRevenue'=>0,'totalDiscount'=>0,'count'=>0,'voidCount'=>0,'voidAmount'=>0];
        }
        $branchIds = [$branchId];
    }
    if (!$branchIds) {
        return ['transactions'=>[],'voidedTransactions'=>[],'totalRevenue'=>0,'totalDiscount'=>0,'count'=>0,'voidCount'=>0,'voidAmount'=>0];
    }

    $inPlaceholders = implode(',', array_fill(0, count($branchIds), '?'));
    $values = $branchIds;
    $dateWhere = '';
    if ($dateFrom) { $dateWhere .= ' AND t.created_at >= ?'; $values[] = witaDateToUtc($dateFrom); }
    if ($dateTo)   { $dateWhere .= ' AND t.created_at <= ?'; $values[] = witaDateToUtc($dateTo, true); }
    if ($paymentMethod) { $dateWhere .= ' AND t.payment_method = ?'; $values[] = $paymentMethod; }

    $stmt = $pdo->prepare("
        SELECT t.id, t.created_at, t.total, t.discount_amount, t.payment_method, t.status,
               b.name AS branch_name, u.name AS staff_name
        FROM transactions t
        LEFT JOIN branches b ON b.id = t.branch_id
        LEFT JOIN users u ON u.id = t.staff_id
        WHERE t.branch_id IN ($inPlaceholders) AND t.status='completed' $dateWhere
        ORDER BY t.created_at DESC
    ");
    $stmt->execute($values);
    $completed = $stmt->fetchAll();

    $voidValues = $values;
    $voidStmt = $pdo->prepare("
        SELECT t.id, t.created_at, t.total, t.discount_amount, t.payment_method, t.status,
               b.name AS branch_name, u.name AS staff_name
        FROM transactions t
        LEFT JOIN branches b ON b.id = t.branch_id
        LEFT JOIN users u ON u.id = t.staff_id
        WHERE t.branch_id IN ($inPlaceholders) AND t.status IN ('void','voided','refunded') $dateWhere
        ORDER BY t.created_at DESC
    ");
    $voidStmt->execute($voidValues);
    $voided = $voidStmt->fetchAll();

    $sum = fn(array $rows, string $key) => array_reduce($rows, fn($s, $r) => $s + (float)($r[$key] ?? 0), 0.0);
    return [
        'transactions' => $completed,
        'voidedTransactions' => $voided,
        'totalRevenue' => $sum($completed, 'total'),
        'totalDiscount' => $sum($completed, 'discount_amount'),
        'count' => count($completed),
        'voidCount' => count($voided),
        'voidAmount' => $sum($voided, 'total'),
    ];
}

// ── investor_get_allowed_branches ─────────────────────────────────────────────
function rpc_investor_get_allowed_branches(array $p): mixed {
    return investorAllowedBranches(getDB(), (int)($p['p_user_id'] ?? 0));
}

function investorUserRole(PDO $pdo, int $userId): ?string {
    if ($userId <= 0) return null;
    $stmt = $pdo->prepare("SELECT role FROM users WHERE id=? LIMIT 1");
    $stmt->execute([$userId]);
    $row = $stmt->fetch();
    return $row['role'] ?? null;
}

function investorIsPrivileged(?string $role): bool {
    return in_array($role, ['admin','owner'], true);
}

function investorAllowedBranches(PDO $pdo, int $userId): array {
    $role = investorUserRole($pdo, $userId);
    if (investorIsPrivileged($role)) {
        $stmt = $pdo->query("SELECT id AS branch_id, name AS branch_name, name FROM branches WHERE COALESCE(is_active,1)=1 ORDER BY name");
        return $stmt->fetchAll();
    }

    $stmt = $pdo->prepare("
        SELECT iba.branch_id, b.name AS branch_name, b.name
        FROM investor_branch_access iba
        JOIN branches b ON b.id = iba.branch_id
        WHERE iba.user_id = ? AND COALESCE(b.is_active,1)=1
        ORDER BY b.name
    ");
    $stmt->execute([$userId]);
    return $stmt->fetchAll();
}

function investorHasBranchAccess(PDO $pdo, int $userId, int $branchId): bool {
    if ($userId <= 0 || $branchId <= 0) return false;
    if (investorIsPrivileged(investorUserRole($pdo, $userId))) return true;

    $stmt = $pdo->prepare("SELECT COUNT(*) FROM investor_branch_access WHERE user_id=? AND branch_id=?");
    $stmt->execute([$userId, $branchId]);
    return ((int)$stmt->fetchColumn()) > 0;
}

function investorHasFeatureAccess(PDO $pdo, int $userId, int $branchId, string $feature): bool {
    if (!investorHasBranchAccess($pdo, $userId, $branchId)) return false;
    if (investorIsPrivileged(investorUserRole($pdo, $userId))) return true;

    $stmt = $pdo->prepare("SELECT COUNT(*) FROM investor_feature_access WHERE user_id=? AND feature_key=? AND COALESCE(allowed,1)=1");
    $stmt->execute([$userId, $feature]);
    return ((int)$stmt->fetchColumn()) > 0;
}

// ── investor_get_access_config ────────────────────────────────────────────────
function rpc_investor_get_access_config(array $p): mixed {
    $pdo    = getDB();
    $userId = (int)($p['p_user_id'] ?? 0);
    $branches = investorAllowedBranches($pdo, $userId);

    if (investorIsPrivileged(investorUserRole($pdo, $userId))) {
        $features = ['sales','products','inventory_stock','inventory_usage'];
    } else {
        $stmt = $pdo->prepare("SELECT feature_key FROM investor_feature_access WHERE user_id=? AND COALESCE(allowed,1)=1 ORDER BY feature_key");
        $stmt->execute([$userId]);
        $features = array_values(array_map(fn($r) => $r['feature_key'], $stmt->fetchAll()));
    }

    return ['branches' => $branches, 'features' => $features];
}

// ── admin_save_investor_access ────────────────────────────────────────────────
function rpc_admin_save_investor_access(array $p): mixed {
    $pdo       = getDB();
    $adminId   = (int)($p['p_admin_id']  ?? 0);
    $investorId= (int)($p['p_user_id']   ?? 0);
    $branches  = $p['p_branch_ids']    ?? [];
    $features  = $p['p_feature_keys']  ?? $p['p_features'] ?? [];

    $pdo->prepare("DELETE FROM investor_branch_access WHERE user_id=?")->execute([$investorId]);
    foreach ($branches as $bId) {
        $pdo->prepare("INSERT IGNORE INTO investor_branch_access (user_id,branch_id) VALUES (?,?)")->execute([$investorId,$bId]);
    }
    $pdo->prepare("DELETE FROM investor_feature_access WHERE user_id=?")->execute([$investorId]);
    foreach ($features as $fk) {
        $pdo->prepare("INSERT IGNORE INTO investor_feature_access (user_id,feature_key,allowed) VALUES (?,?,1)")->execute([$investorId,$fk]);
    }
    return ['success'=>true];
}

// ── rbn_admin_list_api_keys ───────────────────────────────────────────────────
function rpc_rbn_admin_list_api_keys(array $p): mixed {
    $pdo     = getDB();
    $adminId = (int)($p['p_admin_id'] ?? 0);
    $stmt    = $pdo->query("SELECT id,name,key_value,is_active,created_at FROM api_keys ORDER BY created_at DESC");
    return $stmt->fetchAll();
}

// ── get_transactions_api ──────────────────────────────────────────────────────
function rpc_get_transactions_api(array $p): mixed {
    $pdo    = getDB();
    $apiKey = $p['p_api_key'] ?? '';
    $from   = $p['p_from']    ?? null;
    $to     = $p['p_to']      ?? null;

    $k = $pdo->prepare("SELECT id FROM api_keys WHERE key_value=? AND is_active=1 LIMIT 1");
    $k->execute([$apiKey]);
    if (!$k->fetch()) throw new Exception('Invalid or inactive API key');

    $values  = [];
    $where   = "WHERE t.status='completed'";
    if ($from) { $where .= ' AND t.created_at >= ?'; $values[] = normalizeSqlValue($from); }
    if ($to)   { $where .= ' AND t.created_at <= ?'; $values[] = normalizeSqlValue($to);   }

    $stmt = $pdo->prepare("
        SELECT t.id,t.created_at,b.name AS branch_name,u.name AS staff_name,
               t.payment_method,COALESCE(t.subtotal,t.total) AS subtotal,
               COALESCE(t.discount_amount,0) AS discount_amount,t.total,t.status
        FROM transactions t
        LEFT JOIN branches b ON b.id = t.branch_id
        LEFT JOIN users u ON u.id = t.staff_id
        $where
        ORDER BY t.created_at DESC
    ");
    $stmt->execute($values);
    return $stmt->fetchAll();
}

// ── get_sales_integration ─────────────────────────────────────────────────────
function rpc_get_sales_integration(array $p): mixed {
    $pdo      = getDB();
    $apiKey   = $p['p_api_key']  ?? '';
    $branchId = !empty($p['p_branch_id']) ? (int)$p['p_branch_id'] : null;
    $dateFrom = !empty($p['p_date_from']) ? trim($p['p_date_from']) : null;
    $dateTo   = !empty($p['p_date_to'])   ? trim($p['p_date_to'])   : null;
    $limit    = (int)($p['p_limit']  ?? 1000);
    $offset   = (int)($p['p_offset'] ?? 0);

    $k = $pdo->prepare("SELECT id FROM api_keys WHERE key_value=? AND is_active=1 LIMIT 1");
    $k->execute([$apiKey]);
    if (!$k->fetch()) throw new Exception('Invalid or inactive API key');

    $conditions = ["t.status='completed'"];
    $values     = [];
    if ($branchId) { $conditions[] = 't.branch_id=?';      $values[] = $branchId; }
    if ($dateFrom) { $conditions[] = 't.created_at >= ?';  $values[] = witaDateToUtc($dateFrom); }
    if ($dateTo)   { $conditions[] = 't.created_at <= ?';  $values[] = witaDateToUtc($dateTo, true); }
    $where = 'WHERE ' . implode(' AND ', $conditions);

    // Count total
    $cntStmt = $pdo->prepare("SELECT COUNT(*) FROM transactions t $where");
    $cntStmt->execute($values);
    $totalCount = (int)$cntStmt->fetchColumn();

    $values[] = $limit;
    $values[] = $offset;
    $stmt = $pdo->prepare("
        SELECT t.id, t.created_at, t.total, t.payment_method,
               b.name AS branch_name, u.name AS staff_name
        FROM transactions t
        LEFT JOIN branches b ON b.id = t.branch_id
        LEFT JOIN users u ON u.id = t.staff_id
        $where
        ORDER BY t.created_at DESC
        LIMIT ? OFFSET ?
    ");
    $stmt->execute($values);
    $rows = $stmt->fetchAll();

    $data = array_map(function($r) {
        $dt = new DateTime($r['created_at']);
        $dt->setTimezone(new DateTimeZone('Asia/Makassar'));
        return [
            // Canonical fields — digunakan oleh cashflow integration
            'id'               => (string)$r['id'],
            'created_at'       => $dt->format('Y-m-d H:i:s'),
            'branch_name'      => $r['branch_name'] ?? '',
            'cashier'          => $r['staff_name']  ?? '',
            'payment_method'   => $r['payment_method'] ?? '',
            'amount'           => (float)$r['total'],
            // Legacy fields — backward compat
            'tanggal'          => $dt->format('d M Y'),
            'waktu'            => $dt->format('H:i'),
            'cabang'           => $r['branch_name'] ?? '—',
            'kasir'            => $r['staff_name']  ?? '—',
            'metode_pembayaran'=> $r['payment_method'] ?? '—',
            'total_penjualan'  => (float)$r['total'],
        ];
    }, $rows);

    $totalSales = array_sum(array_column($data, 'amount'));
    return [
        'success'    => true,
        'data'       => $data,
        'summary'    => ['total_penjualan' => $totalSales],
        'pagination' => [
            'returned_count' => count($data),
            'total_count'    => $totalCount,
            'has_more'       => ($offset + count($data)) < $totalCount,
        ],
    ];
}

// ── get_kas_keluar_integration ────────────────────────────────────────────────
function rpc_get_kas_keluar_integration(array $p): mixed {
    $pdo      = getDB();
    $apiKey   = $p['p_api_key']  ?? '';
    $branchId = !empty($p['p_branch_id']) ? (int)$p['p_branch_id'] : null;
    $dateFrom = !empty($p['p_date_from']) ? trim($p['p_date_from']) : null;
    $dateTo   = !empty($p['p_date_to'])   ? trim($p['p_date_to'])   : null;
    $limit    = (int)($p['p_limit']  ?? 1000);
    $offset   = (int)($p['p_offset'] ?? 0);

    $k = $pdo->prepare("SELECT id FROM api_keys WHERE key_value=? AND is_active=1 LIMIT 1");
    $k->execute([$apiKey]);
    if (!$k->fetch()) throw new Exception('Invalid or inactive API key');

    $conditions = ["cl.type='out'", "COALESCE(cl.is_void,0)=0"];
    $values     = [];
    if ($branchId) { $conditions[] = 'cl.branch_id=?';     $values[] = $branchId; }
    if ($dateFrom) { $conditions[] = 'cl.created_at >= ?'; $values[] = witaDateToUtc($dateFrom); }
    if ($dateTo)   { $conditions[] = 'cl.created_at <= ?'; $values[] = witaDateToUtc($dateTo, true); }
    $where = 'WHERE ' . implode(' AND ', $conditions);

    $cntStmt = $pdo->prepare("SELECT COUNT(*) FROM cash_logs cl $where");
    $cntStmt->execute($values);
    $totalCount = (int)$cntStmt->fetchColumn();

    $values[] = $limit;
    $values[] = $offset;
    $stmt = $pdo->prepare("
        SELECT cl.id, cl.created_at, cl.amount, cl.note,
               b.name AS branch_name,
               cc.name AS category_name,
               u.name  AS staff_name
        FROM cash_logs cl
        LEFT JOIN branches b ON b.id = cl.branch_id
        LEFT JOIN cash_categories cc ON cc.id = cl.category_id
        LEFT JOIN users u ON u.id = cl.created_by
        $where
        ORDER BY cl.created_at DESC
        LIMIT ? OFFSET ?
    ");
    $stmt->execute($values);
    $rows = $stmt->fetchAll();

    $data = array_map(function($r) {
        $dt = new DateTime($r['created_at']);
        $dt->setTimezone(new DateTimeZone('Asia/Makassar'));
        return [
            // Canonical fields — digunakan oleh cashflow integration
            'id'               => (string)$r['id'],
            'created_at'       => $dt->format('Y-m-d H:i:s'),
            'branch_name'      => $r['branch_name']   ?? '',
            'name'             => $r['note']          ?? '',
            'category'         => $r['category_name'] ?? '',
            'amount'           => (float)$r['amount'],
            'notes'            => $r['note']          ?? '',
            'recorded_by'      => $r['staff_name']    ?? '',
            // Legacy fields — backward compat
            'tanggal'          => $dt->format('d M Y'),
            'waktu'            => $dt->format('H:i'),
            'cabang'           => $r['branch_name']   ?? '—',
            'nama_pengeluaran' => $r['note']          ?? '—',
            'kategori'         => $r['category_name'] ?? null,
            'nominal'          => (float)$r['amount'],
            'keterangan'       => $r['note']          ?? '—',
            'dicatat_oleh'     => $r['staff_name']    ?? '—',
        ];
    }, $rows);

    $totalOut = array_sum(array_column($data, 'amount'));
    return [
        'success'    => true,
        'data'       => $data,
        'summary'    => ['total_kas_keluar' => $totalOut],
        'pagination' => [
            'returned_count' => count($data),
            'total_count'    => $totalCount,
            'has_more'       => ($offset + count($data)) < $totalCount,
        ],
    ];
}

// ── get_integration_summary ───────────────────────────────────────────────────
function rpc_get_integration_summary(array $p): mixed {
    $pdo      = getDB();
    $apiKey   = $p['p_api_key']  ?? '';
    $branchId = !empty($p['p_branch_id']) ? (int)$p['p_branch_id'] : null;
    $dateFrom = !empty($p['p_date_from']) ? trim($p['p_date_from']) : null;
    $dateTo   = !empty($p['p_date_to'])   ? trim($p['p_date_to'])   : null;

    $k = $pdo->prepare("SELECT id FROM api_keys WHERE key_value=? AND is_active=1 LIMIT 1");
    $k->execute([$apiKey]);
    if (!$k->fetch()) throw new Exception('Invalid or inactive API key');

    $utcFrom = $dateFrom ? witaDateToUtc($dateFrom)          : null;
    $utcTo   = $dateTo   ? witaDateToUtc($dateTo,   true)    : null;

    // ── Sales per branch ──────────────────────────────────────────
    $sWhere = ["t.status='completed'"];
    $sVals  = [];
    if ($branchId) { $sWhere[] = 't.branch_id=?'; $sVals[] = $branchId; }
    if ($utcFrom)  { $sWhere[] = 't.created_at >= ?'; $sVals[] = $utcFrom; }
    if ($utcTo)    { $sWhere[] = 't.created_at <= ?'; $sVals[] = $utcTo; }
    $sWhereStr = 'WHERE ' . implode(' AND ', $sWhere);

    $sSt = $pdo->prepare("
        SELECT b.name AS branch_name,
               COALESCE(SUM(t.total),0) AS total_sales,
               COUNT(*) AS trx_count
        FROM transactions t
        LEFT JOIN branches b ON b.id = t.branch_id
        $sWhereStr
        GROUP BY t.branch_id, b.name
    ");
    $sSt->execute($sVals);
    $salesRows = $sSt->fetchAll();

    // ── Cash-out per branch ───────────────────────────────────────
    $cWhere = ["cl.type='out'", "COALESCE(cl.is_void,0)=0"];
    $cVals  = [];
    if ($branchId) { $cWhere[] = 'cl.branch_id=?'; $cVals[] = $branchId; }
    if ($utcFrom)  { $cWhere[] = 'cl.created_at >= ?'; $cVals[] = $utcFrom; }
    if ($utcTo)    { $cWhere[] = 'cl.created_at <= ?'; $cVals[] = $utcTo; }
    $cWhereStr = 'WHERE ' . implode(' AND ', $cWhere);

    $cSt = $pdo->prepare("
        SELECT b.name AS branch_name, COALESCE(SUM(cl.amount),0) AS total_out
        FROM cash_logs cl
        LEFT JOIN branches b ON b.id = cl.branch_id
        $cWhereStr
        GROUP BY cl.branch_id, b.name
    ");
    $cSt->execute($cVals);
    $cashoutRows = $cSt->fetchAll();

    // ── Daily sales (WITA date) ───────────────────────────────────
    $dSt = $pdo->prepare("
        SELECT DATE(CONVERT_TZ(t.created_at, '+00:00', '+08:00')) AS wita_date,
               COALESCE(SUM(t.total),0) AS total_sales, COUNT(*) AS trx_count
        FROM transactions t $sWhereStr
        GROUP BY wita_date ORDER BY wita_date DESC
    ");
    $dSt->execute($sVals);
    $dailySales = $dSt->fetchAll();

    $dCSt = $pdo->prepare("
        SELECT DATE(CONVERT_TZ(cl.created_at, '+00:00', '+08:00')) AS wita_date,
               COALESCE(SUM(cl.amount),0) AS total_out
        FROM cash_logs cl $cWhereStr
        GROUP BY wita_date ORDER BY wita_date DESC
    ");
    $dCSt->execute($cVals);
    $dailyCashout = $dCSt->fetchAll();

    // Merge branch data
    $branchMap = [];
    foreach ($salesRows as $r) {
        $branchMap[$r['branch_name']] = [
            'cabang'           => $r['branch_name'],
            'total_penjualan'  => (float)$r['total_sales'],
            'jumlah_transaksi' => (int)$r['trx_count'],
            'total_kas_keluar' => 0,
        ];
    }
    foreach ($cashoutRows as $r) {
        $n = $r['branch_name'];
        if (!isset($branchMap[$n])) $branchMap[$n] = ['cabang'=>$n,'total_penjualan'=>0,'jumlah_transaksi'=>0,'total_kas_keluar'=>0];
        $branchMap[$n]['total_kas_keluar'] = (float)$r['total_out'];
    }

    // Merge daily data
    $dailyMap = [];
    foreach ($dailySales as $r) {
        $dailyMap[$r['wita_date']] = [
            'tanggal'         => $r['wita_date'],
            'total_penjualan' => (float)$r['total_sales'],
            'total_kas_keluar'=> 0,
        ];
    }
    foreach ($dailyCashout as $r) {
        $d = $r['wita_date'];
        if (!isset($dailyMap[$d])) $dailyMap[$d] = ['tanggal'=>$d,'total_penjualan'=>0,'total_kas_keluar'=>0];
        $dailyMap[$d]['total_kas_keluar'] = (float)$r['total_out'];
    }
    krsort($dailyMap);

    $totalSales  = array_sum(array_column($salesRows,   'total_sales'));
    $totalCash   = array_sum(array_column($cashoutRows, 'total_out'));
    $totalTrx    = array_sum(array_column($salesRows,   'trx_count'));

    return [
        'success'     => true,
        'summary'     => [
            'total_penjualan'   => (float)$totalSales,
            'total_kas_keluar'  => (float)$totalCash,
            'jumlah_transaksi'  => (int)$totalTrx,
            'selisih'           => (float)($totalSales - $totalCash),
        ],
        'per_cabang'  => array_values($branchMap),
        'per_tanggal' => array_values($dailyMap),
    ];
}

// ── get_buduk_calculator_integration ─────────────────────────────────────────
function rpc_get_buduk_calculator_integration(array $p): mixed {
    $pdo       = getDB();
    $branchId  = !empty($p['p_branch_id'])  ? (int)$p['p_branch_id']  : null;
    $entryDate = !empty($p['p_entry_date']) ? trim($p['p_entry_date']) : null;

    // Outer X-API-Key header sudah divalidasi di bagian atas api.php — tidak perlu cek api_keys lagi

    if (!$branchId)  throw new ApiHttpException(400, 'p_branch_id wajib diisi', 'INVALID_PARAM');
    if (!$entryDate) throw new ApiHttpException(400, 'p_entry_date wajib diisi', 'INVALID_PARAM');
    if (!preg_match('/^\d{4}-\d{2}-\d{2}$/', $entryDate)) {
        throw new ApiHttpException(400, 'p_entry_date harus format YYYY-MM-DD', 'INVALID_PARAM');
    }

    $bStmt = $pdo->prepare("SELECT id, name FROM branches WHERE id=? AND COALESCE(is_active,1)=1 LIMIT 1");
    $bStmt->execute([$branchId]);
    $branch = $bStmt->fetch();
    if (!$branch) throw new ApiHttpException(404, 'Cabang tidak ditemukan atau tidak aktif', 'BRANCH_NOT_FOUND');

    $dateFrom = witaDateToUtc($entryDate);
    $dateTo   = witaDateToUtc($entryDate, true);

    // Agregasi penjualan tunai dan QRIS
    $sStmt = $pdo->prepare("
        SELECT
          COALESCE(SUM(CASE WHEN LOWER(t.payment_method) = 'cash' THEN t.total ELSE 0 END), 0) AS tunai_roti,
          COALESCE(SUM(CASE WHEN LOWER(t.payment_method) = 'qris'  THEN t.total ELSE 0 END), 0) AS qris_roti,
          SUM(CASE WHEN LOWER(t.payment_method) = 'cash' THEN 1 ELSE 0 END) AS cash_count,
          SUM(CASE WHEN LOWER(t.payment_method) = 'qris'  THEN 1 ELSE 0 END) AS qris_count
        FROM transactions t
        WHERE t.branch_id = ?
          AND t.status = 'completed'
          AND t.created_at >= ?
          AND t.created_at <= ?
    ");
    $sStmt->execute([$branchId, $dateFrom, $dateTo]);
    $sales = $sStmt->fetch();

    // Detail kas manual (in dan out, non-void, reference_type = manual)
    $cStmt = $pdo->prepare("
        SELECT cl.id, cl.type, cl.amount, cl.note, cl.created_at,
               cc.name AS category_name, u.name AS staff_name
        FROM cash_logs cl
        LEFT JOIN cash_categories cc ON cc.id = cl.category_id
        LEFT JOIN users u ON u.id = cl.created_by
        WHERE cl.branch_id = ?
          AND cl.reference_type = 'manual'
          AND COALESCE(cl.is_void, 0) = 0
          AND cl.type IN ('in', 'out')
          AND cl.created_at >= ?
          AND cl.created_at <= ?
        ORDER BY cl.created_at ASC, cl.id ASC
    ");
    $cStmt->execute([$branchId, $dateFrom, $dateTo]);
    $cashRows = $cStmt->fetchAll();

    $kasIn  = 0;
    $kasOut = 0;
    $cashDetails = [];
    foreach ($cashRows as $r) {
        $amount = (int)$r['amount'];
        if ($r['type'] === 'in')  $kasIn  += $amount;
        if ($r['type'] === 'out') $kasOut += $amount;
        $dt = new DateTime($r['created_at']);
        $dt->setTimezone(new DateTimeZone('Asia/Makassar'));
        $cashDetails[] = [
            'pos_cash_log_id' => (string)$r['id'],
            'direction'       => $r['type'],
            'created_at'      => $dt->format('Y-m-d H:i:s'),
            'amount'          => $amount,
            'category'        => $r['category_name'] ?? '',
            'note'            => $r['note'] ?? '',
            'recorded_by'     => $r['staff_name'] ?? '',
        ];
    }

    $tunaiRoti = (int)($sales['tunai_roti'] ?? 0);
    $qrisRoti  = (int)($sales['qris_roti']  ?? 0);
    $now       = new DateTime('now', new DateTimeZone('Asia/Makassar'));

    return [
        'success' => true,
        'source'  => 'point_of_sales',
        'branch'  => ['id' => (int)$branch['id'], 'name' => $branch['name']],
        'period'  => [
            'entry_date' => $entryDate,
            'timezone'   => 'Asia/Makassar',
            'from'       => $dateFrom,
            'to'         => $dateTo,
        ],
        'totals' => [
            'tunai_roti' => $tunaiRoti,
            'qris_roti'  => $qrisRoti,
            'kas_masuk'  => $kasIn,
            'kas_keluar' => $kasOut,
        ],
        'sales_breakdown' => [
            'cash' => ['count' => (int)($sales['cash_count'] ?? 0), 'total' => $tunaiRoti],
            'qris' => ['count' => (int)($sales['qris_count'] ?? 0), 'total' => $qrisRoti],
        ],
        'cash_details' => $cashDetails,
        'generated_at' => $now->format('Y-m-d H:i:s'),
    ];
}

// ── Stub for unimplemented RPCs ───────────────────────────────────────────────
function rpc_get_staff_onboarding_statuses(array $p): mixed { return []; }
function rpc_complete_onboarding_step(array $p): mixed { return ['success'=>true]; }
function rpc_start_my_onboarding(array $p): mixed { return ['success'=>true]; }
function rpc_get_my_onboarding(array $p): mixed { return null; }
function rpc_admin_preview_branch_menu_copy(array $p): mixed { return []; }
function rpc_admin_copy_branch_menu(array $p): mixed { return ['success'=>true]; }
function stockTransferQtyCol(PDO $pdo): string {
    return dbColumnExists($pdo, 'stock_transfer_items', 'qty') ? 'qty' : 'quantity';
}

function inventoryLogQtyCol(PDO $pdo): string {
    return dbColumnExists($pdo, 'inventory_logs', 'qty') ? 'qty' : 'quantity';
}

function inventoryLogNoteCol(PDO $pdo): string {
    return dbColumnExists($pdo, 'inventory_logs', 'notes') ? 'notes' : 'note';
}

function stockTransferCreatorCol(PDO $pdo): string {
    return dbColumnExists($pdo, 'stock_transfers', 'created_by') ? 'created_by' : 'requested_by';
}

function stockTransferReasonCol(PDO $pdo): ?string {
    if (dbColumnExists($pdo, 'stock_transfers', 'rejection_reason')) return 'rejection_reason';
    if (dbColumnExists($pdo, 'stock_transfers', 'reject_reason')) return 'reject_reason';
    return null;
}

function stockTransferCancelReasonCol(PDO $pdo): ?string {
    return dbColumnExists($pdo, 'stock_transfers', 'cancel_reason') ? 'cancel_reason' : null;
}

function stockTransferCode(PDO $pdo): string {
    $prefix = 'TRF-' . date('Ymd') . '-';
    for ($i = 1; $i <= 999; $i++) {
        $code = $prefix . str_pad((string)$i, 3, '0', STR_PAD_LEFT);
        $stmt = $pdo->prepare("SELECT COUNT(*) FROM stock_transfers WHERE transfer_code=?");
        $stmt->execute([$code]);
        if ((int)$stmt->fetchColumn() === 0) return $code;
    }
    return $prefix . strtoupper(substr(bin2hex(random_bytes(3)), 0, 6));
}

function normalizeStockTransferItems(array $items): array {
    $normalized = [];
    foreach ($items as $item) {
        if (!is_array($item)) continue;
        $ingredientId = (int)($item['ingredient_id'] ?? 0);
        $qty = (float)($item['qty'] ?? $item['quantity'] ?? 0);
        if ($ingredientId <= 0 || $qty <= 0) continue;
        $key = (string)$ingredientId;
        $normalized[$key] = [
            'ingredient_id' => $ingredientId,
            'qty' => ($normalized[$key]['qty'] ?? 0) + $qty,
        ];
    }
    return array_values($normalized);
}

function adjustBranchInventory(PDO $pdo, int $branchId, int $ingredientId, float $delta): array {
    $stmt = $pdo->prepare("SELECT stock FROM branch_inventory WHERE branch_id=? AND ingredient_id=? FOR UPDATE");
    $stmt->execute([$branchId, $ingredientId]);
    $row = $stmt->fetch();
    $before = $row ? (float)$row['stock'] : 0.0;
    $after = $before + $delta;

    if ($row) {
        $pdo->prepare("UPDATE branch_inventory SET stock=? WHERE branch_id=? AND ingredient_id=?")->execute([$after, $branchId, $ingredientId]);
    } else {
        $pdo->prepare("INSERT INTO branch_inventory (branch_id,ingredient_id,stock) VALUES (?,?,?)")->execute([$branchId, $ingredientId, $after]);
    }
    return [$before, $after];
}

function insertInventoryMovement(PDO $pdo, int $branchId, int $ingredientId, float $qty, string $type, float $before, float $after, ?string $note, ?int $createdBy, ?string $referenceType, ?string $referenceId): void {
    $noteCol = inventoryLogNoteCol($pdo);
    $row = [
        'branch_id'    => $branchId,
        'ingredient_id' => $ingredientId,
        'type'         => $type,
        'quantity'     => $qty,
        'stock_before' => $before,
        'stock_after'  => $after,
        $noteCol       => $note,
        'created_by'   => $createdBy,
    ];
    if (dbColumnExists($pdo, 'inventory_logs', 'reference_type')) $row['reference_type'] = $referenceType;
    if (dbColumnExists($pdo, 'inventory_logs', 'reference_id'))   $row['reference_id']   = $referenceId;
    insertDynamic($pdo, 'inventory_logs', $row);
}

function fetchStockTransferItems(PDO $pdo, array $transferIds): array {
    $transferIds = array_values(array_unique(array_filter($transferIds, fn($v) => $v !== null && $v !== '')));
    if (!$transferIds) return [];
    $qtyCol = stockTransferQtyCol($pdo);
    $stmt = $pdo->prepare("
        SELECT sti.transfer_id, sti.ingredient_id, i.name AS ingredient_name, i.unit, sti.`$qtyCol` AS qty
        FROM stock_transfer_items sti
        LEFT JOIN ingredients i ON i.id = sti.ingredient_id
        WHERE sti.transfer_id IN (" . implode(',', array_fill(0, count($transferIds), '?')) . ")
        ORDER BY i.name
    ");
    $stmt->execute($transferIds);
    $items = [];
    foreach ($stmt->fetchAll() as $row) {
        $items[(string)$row['transfer_id']][] = $row;
    }
    return $items;
}

function attachStockTransferItems(PDO $pdo, array $rows): array {
    $itemsByTransfer = fetchStockTransferItems($pdo, array_column($rows, 'id'));
    foreach ($rows as &$row) {
        $row['items'] = $itemsByTransfer[(string)$row['id']] ?? [];
    }
    unset($row);
    return $rows;
}

function stockTransferRows(PDO $pdo, string $where, array $values, int $limit, int $offset): array {
    $creatorCol = stockTransferCreatorCol($pdo);
    $reasonCol = stockTransferReasonCol($pdo);
    $reasonExpr = $reasonCol ? "st.`$reasonCol`" : "NULL";
    $confirmedAt = dbColumnExists($pdo, 'stock_transfers', 'confirmed_at') ? 'st.confirmed_at' : 'NULL';
    $rejectedAt = dbColumnExists($pdo, 'stock_transfers', 'rejected_at') ? 'st.rejected_at' : 'NULL';
    $cancelledAt = dbColumnExists($pdo, 'stock_transfers', 'cancelled_at') ? 'st.cancelled_at' : 'NULL';
    $limit = max(1, min(500, $limit));
    $offset = max(0, $offset);

    $stmt = $pdo->prepare("
        SELECT st.id, st.transfer_code, st.from_branch_id, st.to_branch_id, st.status, st.notes,
               $reasonExpr AS rejection_reason, st.created_at,
               $confirmedAt AS confirmed_at, $rejectedAt AS rejected_at, $cancelledAt AS cancelled_at,
               fb.name AS from_branch_name, tb.name AS to_branch_name,
               uc.name AS created_by_name, ucf.name AS confirmed_by_name, urj.name AS rejected_by_name
        FROM stock_transfers st
        LEFT JOIN branches fb ON fb.id = st.from_branch_id
        LEFT JOIN branches tb ON tb.id = st.to_branch_id
        LEFT JOIN users uc ON uc.id = st.`$creatorCol`
        LEFT JOIN users ucf ON ucf.id = st.confirmed_by
        LEFT JOIN users urj ON urj.id = st.rejected_by
        $where
        ORDER BY st.created_at DESC
        LIMIT $limit OFFSET $offset
    ");
    $stmt->execute($values);
    return attachStockTransferItems($pdo, $stmt->fetchAll());
}

function updateStockTransferStatus(PDO $pdo, int $transferId, string $status, int $userId, ?string $reason = null): void {
    $sets = ['status=?'];
    $values = [$status];
    $userCol = [
        'confirmed' => 'confirmed_by',
        'rejected' => 'rejected_by',
        'cancelled' => 'cancelled_by',
    ][$status] ?? null;
    $timeCol = [
        'confirmed' => 'confirmed_at',
        'rejected' => 'rejected_at',
        'cancelled' => 'cancelled_at',
    ][$status] ?? null;

    if ($userCol && dbColumnExists($pdo, 'stock_transfers', $userCol)) {
        $sets[] = "`$userCol`=?";
        $values[] = $userId;
    }
    if ($timeCol && dbColumnExists($pdo, 'stock_transfers', $timeCol)) {
        $sets[] = "`$timeCol`=NOW()";
    }
    if ($status === 'rejected' && ($reasonCol = stockTransferReasonCol($pdo))) {
        $sets[] = "`$reasonCol`=?";
        $values[] = $reason;
    }
    if ($status === 'cancelled' && ($cancelReasonCol = stockTransferCancelReasonCol($pdo))) {
        $sets[] = "`$cancelReasonCol`=?";
        $values[] = $reason;
    }
    if (dbColumnExists($pdo, 'stock_transfers', 'updated_at')) {
        $sets[] = "updated_at=NOW()";
    }

    $values[] = $transferId;
    $pdo->prepare("UPDATE stock_transfers SET " . implode(',', $sets) . " WHERE id=?")->execute($values);
}

function rpc_create_stock_transfer(array $p): mixed {
    $pdo = getDB();
    $fromBranch = (int)($p['p_from_branch_id'] ?? 0);
    $toBranch = (int)($p['p_to_branch_id'] ?? 0);
    $items = normalizeStockTransferItems($p['p_items'] ?? []);
    $notes = $p['p_notes'] ?? null;
    $userId = (int)($p['p_user_id'] ?? 0);

    if ($fromBranch <= 0 || $toBranch <= 0 || $fromBranch === $toBranch) throw new Exception('Outlet asal dan tujuan tidak valid');
    if (!$items) throw new Exception('Tidak ada bahan yang dipilih untuk dikirim');

    $pdo->beginTransaction();
    try {
        foreach ($items as $item) {
            $stmt = $pdo->prepare("SELECT stock FROM branch_inventory WHERE branch_id=? AND ingredient_id=? FOR UPDATE");
            $stmt->execute([$fromBranch, $item['ingredient_id']]);
            $stock = (float)($stmt->fetch()['stock'] ?? 0);
            if ($stock < $item['qty']) {
                $nameStmt = $pdo->prepare("SELECT name FROM ingredients WHERE id=? LIMIT 1");
                $nameStmt->execute([$item['ingredient_id']]);
                $name = $nameStmt->fetchColumn() ?: 'Bahan';
                throw new Exception("Stok $name tidak cukup. Tersedia: $stock");
            }
        }

        $code = stockTransferCode($pdo);
        $creatorCol = stockTransferCreatorCol($pdo);
        $transferRow = [
            'transfer_code' => $code,
            'from_branch_id' => $fromBranch,
            'to_branch_id' => $toBranch,
            'status' => 'pending',
            'notes' => $notes,
            $creatorCol => $userId,
        ];
        insertDynamic($pdo, 'stock_transfers', $transferRow);
        $transferId = (int)$pdo->lastInsertId();

        $toNameStmt = $pdo->prepare("SELECT name FROM branches WHERE id=? LIMIT 1");
        $toNameStmt->execute([$toBranch]);
        $toName = $toNameStmt->fetchColumn() ?: 'outlet tujuan';
        $qtyCol = stockTransferQtyCol($pdo);

        foreach ($items as $item) {
            insertDynamic($pdo, 'stock_transfer_items', [
                'transfer_id' => $transferId,
                'ingredient_id' => $item['ingredient_id'],
                $qtyCol => $item['qty'],
            ]);
            [$before, $after] = adjustBranchInventory($pdo, $fromBranch, $item['ingredient_id'], -$item['qty']);
            insertInventoryMovement($pdo, $fromBranch, $item['ingredient_id'], -$item['qty'], 'transfer_out', $before, $after, "Dikirim ke $toName [$code] - menunggu konfirmasi", $userId, 'transfer', (string)$transferId);
        }

        $pdo->commit();
        return ['success'=>true,'transfer_id'=>$transferId,'transfer_code'=>$code];
    } catch (Throwable $e) {
        $pdo->rollBack();
        throw $e;
    }
}

function rpc_confirm_stock_transfer(array $p): mixed {
    $pdo = getDB();
    $transferId = (int)($p['p_transfer_id'] ?? 0);
    $userId = (int)($p['p_user_id'] ?? 0);

    $pdo->beginTransaction();
    try {
        $stmt = $pdo->prepare("SELECT * FROM stock_transfers WHERE id=? FOR UPDATE");
        $stmt->execute([$transferId]);
        $transfer = $stmt->fetch();
        if (!$transfer) throw new Exception('Transfer tidak ditemukan');
        if ($transfer['status'] !== 'pending') throw new Exception('Transfer tidak bisa diproses, status saat ini: ' . $transfer['status']);

        $items = fetchStockTransferItems($pdo, [$transferId])[(string)$transferId] ?? [];
        $fromNameStmt = $pdo->prepare("SELECT name FROM branches WHERE id=? LIMIT 1");
        $fromNameStmt->execute([(int)$transfer['from_branch_id']]);
        $fromName = $fromNameStmt->fetchColumn() ?: 'outlet asal';

        foreach ($items as $item) {
            $qty = (float)$item['qty'];
            [$before, $after] = adjustBranchInventory($pdo, (int)$transfer['to_branch_id'], (int)$item['ingredient_id'], $qty);
            insertInventoryMovement($pdo, (int)$transfer['to_branch_id'], (int)$item['ingredient_id'], $qty, 'transfer_in', $before, $after, "Diterima dari $fromName [{$transfer['transfer_code']}]", $userId, 'transfer', (string)$transferId);
        }
        updateStockTransferStatus($pdo, $transferId, 'confirmed', $userId);

        $pdo->commit();
        return ['success'=>true,'transfer_code'=>$transfer['transfer_code']];
    } catch (Throwable $e) {
        $pdo->rollBack();
        throw $e;
    }
}

function rpc_reject_stock_transfer(array $p): mixed {
    $pdo = getDB();
    $transferId = (int)($p['p_transfer_id'] ?? 0);
    $userId = (int)($p['p_user_id'] ?? 0);
    $reason = $p['p_reason'] ?? null;

    $pdo->beginTransaction();
    try {
        $stmt = $pdo->prepare("SELECT * FROM stock_transfers WHERE id=? FOR UPDATE");
        $stmt->execute([$transferId]);
        $transfer = $stmt->fetch();
        if (!$transfer) throw new Exception('Transfer tidak ditemukan');
        if ($transfer['status'] !== 'pending') throw new Exception('Hanya transfer pending yang dapat ditolak');

        $items = fetchStockTransferItems($pdo, [$transferId])[(string)$transferId] ?? [];
        foreach ($items as $item) {
            $qty = (float)$item['qty'];
            [$before, $after] = adjustBranchInventory($pdo, (int)$transfer['from_branch_id'], (int)$item['ingredient_id'], $qty);
            $note = "Stok kembali - transfer ditolak [{$transfer['transfer_code']}]" . ($reason ? ". Alasan: $reason" : '');
            insertInventoryMovement($pdo, (int)$transfer['from_branch_id'], (int)$item['ingredient_id'], $qty, 'transfer_in', $before, $after, $note, $userId, 'transfer', (string)$transferId);
        }
        updateStockTransferStatus($pdo, $transferId, 'rejected', $userId, $reason);

        $pdo->commit();
        return ['success'=>true,'transfer_code'=>$transfer['transfer_code']];
    } catch (Throwable $e) {
        $pdo->rollBack();
        throw $e;
    }
}

function rpc_cancel_stock_transfer(array $p): mixed {
    $pdo = getDB();
    $transferId = (int)($p['p_transfer_id'] ?? 0);
    $userId = (int)($p['p_user_id'] ?? 0);
    $reason = $p['p_reason'] ?? null;

    $pdo->beginTransaction();
    try {
        $stmt = $pdo->prepare("SELECT * FROM stock_transfers WHERE id=? FOR UPDATE");
        $stmt->execute([$transferId]);
        $transfer = $stmt->fetch();
        if (!$transfer) throw new Exception('Transfer tidak ditemukan');
        if ($transfer['status'] !== 'pending') throw new Exception('Hanya transfer pending yang dapat dibatalkan');

        $items = fetchStockTransferItems($pdo, [$transferId])[(string)$transferId] ?? [];
        foreach ($items as $item) {
            $qty = (float)$item['qty'];
            [$before, $after] = adjustBranchInventory($pdo, (int)$transfer['from_branch_id'], (int)$item['ingredient_id'], $qty);
            insertInventoryMovement($pdo, (int)$transfer['from_branch_id'], (int)$item['ingredient_id'], $qty, 'transfer_in', $before, $after, "Stok kembali - transfer dibatalkan [{$transfer['transfer_code']}]", $userId, 'transfer', (string)$transferId);
        }
        updateStockTransferStatus($pdo, $transferId, 'cancelled', $userId, $reason);

        $pdo->commit();
        return ['success'=>true,'transfer_code'=>$transfer['transfer_code']];
    } catch (Throwable $e) {
        $pdo->rollBack();
        throw $e;
    }
}

function rpc_get_pending_transfers(array $p): mixed {
    $pdo = getDB();
    $branchId = (int)($p['p_branch_id'] ?? 0);
    return stockTransferRows($pdo, "WHERE st.to_branch_id=? AND st.status='pending'", [$branchId], 100, 0);
}

function rpc_get_transfer_history(array $p): mixed {
    $pdo = getDB();
    $branchId = (int)($p['p_branch_id'] ?? 0);
    $limit = (int)($p['p_limit'] ?? 50);
    $offset = (int)($p['p_offset'] ?? 0);
    return stockTransferRows($pdo, "WHERE st.from_branch_id=? OR st.to_branch_id=?", [$branchId, $branchId], $limit, $offset);
}

function rpc_get_all_transfers_admin(array $p): mixed {
    $pdo = getDB();
    $limit = (int)($p['p_limit'] ?? 100);
    $offset = (int)($p['p_offset'] ?? 0);
    $status = $p['p_status'] ?? null;
    if ($status) {
        return stockTransferRows($pdo, "WHERE st.status=?", [$status], $limit, $offset);
    }
    return stockTransferRows($pdo, "", [], $limit, $offset);
}

function rpc_transfer_stock_atomic(array $p): mixed {
    $pdo = getDB();
    $fromBranch = (int)($p['p_from_branch'] ?? $p['p_from_branch_id'] ?? 0);
    $toBranch = (int)($p['p_to_branch'] ?? $p['p_to_branch_id'] ?? 0);
    $ingredientId = (int)($p['p_ingredient_id'] ?? 0);
    $qty = (float)($p['p_qty'] ?? $p['p_quantity'] ?? 0);
    $notes = $p['p_notes'] ?? $p['p_note'] ?? null;
    $userId = (int)($p['p_user_id'] ?? $p['p_created_by'] ?? 0);

    if ($fromBranch <= 0 || $toBranch <= 0 || $ingredientId <= 0 || $qty <= 0) throw new Exception('Parameter transfer stok tidak valid');
    if ($fromBranch === $toBranch) throw new Exception('Outlet asal dan tujuan tidak boleh sama');

    $pdo->beginTransaction();
    try {
        $stmt = $pdo->prepare("SELECT stock FROM branch_inventory WHERE branch_id=? AND ingredient_id=? FOR UPDATE");
        $stmt->execute([$fromBranch, $ingredientId]);
        $stock = (float)($stmt->fetch()['stock'] ?? 0);
        if ($stock < $qty) throw new Exception("Stok tidak cukup. Tersedia: $stock");

        [$srcBefore, $srcAfter] = adjustBranchInventory($pdo, $fromBranch, $ingredientId, -$qty);
        [$dstBefore, $dstAfter] = adjustBranchInventory($pdo, $toBranch, $ingredientId, $qty);
        insertInventoryMovement($pdo, $fromBranch, $ingredientId, -$qty, 'transfer_out', $srcBefore, $srcAfter, $notes ?: 'Transfer stok keluar', $userId, 'transfer_direct', null);
        insertInventoryMovement($pdo, $toBranch, $ingredientId, $qty, 'transfer_in', $dstBefore, $dstAfter, $notes ?: 'Transfer stok masuk', $userId, 'transfer_direct', null);

        $pdo->commit();
        return ['success'=>true,'source_stock_after'=>$srcAfter,'target_stock_after'=>$dstAfter];
    } catch (Throwable $e) {
        $pdo->rollBack();
        throw $e;
    }
}
function rpc_investor_get_product_performance(array $p): mixed {
    $pdo      = getDB();
    $userId   = (int)($p['p_user_id'] ?? 0);
    $branchId = (int)($p['p_branch_id'] ?? 0);
    $dateFrom = $p['p_date_from'] ?? date('Y-m-01');
    $dateTo   = $p['p_date_to']   ?? date('Y-m-d');

    if (!investorHasFeatureAccess($pdo, $userId, $branchId, 'products')) {
        return [];
    }

    $stmt = $pdo->prepare("
        SELECT
          COALESCE(ti.product_name, '-') AS product,
          ti.variant_name AS variant,
          CAST(COALESCE(SUM(ti.quantity),0) AS SIGNED) AS qty,
          COALESCE(SUM(ti.subtotal),0) AS revenue
        FROM transaction_items ti
        JOIN transactions tx ON tx.id = ti.transaction_id
        WHERE tx.branch_id = ?
          AND tx.status = 'completed'
          AND tx.created_at >= ?
          AND tx.created_at <= ?
        GROUP BY ti.product_name, ti.variant_name
        ORDER BY qty DESC, revenue DESC
    ");
    $stmt->execute([$branchId, witaDateToUtc($dateFrom), witaDateToUtc($dateTo, true)]);
    return $stmt->fetchAll();
}

function rpc_investor_get_inventory_summary(array $p): mixed {
    $pdo      = getDB();
    $userId   = (int)($p['p_user_id'] ?? 0);
    $branchId = (int)($p['p_branch_id'] ?? 0);
    $date     = $p['p_date'] ?? date('Y-m-d');

    if (!investorHasFeatureAccess($pdo, $userId, $branchId, 'inventory_stock')) {
        return [];
    }

    // Convert WITA calendar date to UTC range for correct DATETIME comparison
    $dateFrom = witaDateToUtc($date);
    $dateTo   = witaDateToUtc($date, true);

    $qtyCol = dbColumnExists($pdo, 'inventory_logs', 'qty') ? 'qty' : 'quantity';
    $stmt = $pdo->prepare("
        SELECT
          bi.ingredient_id,
          i.name AS ingredient_name,
          bi.stock,
          i.unit,
          COALESCE((
            SELECT SUM(ABS(il.`$qtyCol`))
            FROM inventory_logs il
            WHERE il.branch_id = ?
              AND il.ingredient_id = bi.ingredient_id
              AND il.type = 'out'
              AND il.created_at >= ? AND il.created_at <= ?
          ),0) AS used_today,
          (
            SELECT il2.created_at
            FROM inventory_logs il2
            WHERE il2.branch_id = ?
              AND il2.ingredient_id = bi.ingredient_id
            ORDER BY il2.created_at DESC
            LIMIT 1
          ) AS last_updated
        FROM branch_inventory bi
        JOIN ingredients i ON i.id = bi.ingredient_id
        WHERE bi.branch_id = ?
        ORDER BY i.name
    ");
    $stmt->execute([$branchId, $dateFrom, $dateTo, $branchId, $branchId]);
    return $stmt->fetchAll();
}

function rpc_investor_get_inventory_usage(array $p): mixed {
    $pdo      = getDB();
    $userId   = (int)($p['p_user_id'] ?? 0);
    $branchId = (int)($p['p_branch_id'] ?? 0);
    $dateFrom = $p['p_date_from'] ?? date('Y-m-01');
    $dateTo   = $p['p_date_to']   ?? date('Y-m-d');

    if (!investorHasFeatureAccess($pdo, $userId, $branchId, 'inventory_usage')) {
        return [];
    }

    $qtyCol = dbColumnExists($pdo, 'inventory_logs', 'qty') ? 'qty' : 'quantity';
    $referenceFilter = dbColumnExists($pdo, 'inventory_logs', 'reference_type') ? "AND il.reference_type = 'transaction'" : '';
    $stmt = $pdo->prepare("
        SELECT
          i.name AS ingredient_name,
          i.unit,
          COALESCE(SUM(ABS(il.`$qtyCol`)),0) AS total_used
        FROM inventory_logs il
        JOIN ingredients i ON i.id = il.ingredient_id
        WHERE il.branch_id = ?
          AND il.type = 'out'
          $referenceFilter
          AND il.created_at >= ?
          AND il.created_at <= ?
        GROUP BY i.name, i.unit
        ORDER BY total_used DESC
    ");
    $stmt->execute([$branchId, witaDateToUtc($dateFrom), witaDateToUtc($dateTo, true)]);
    return $stmt->fetchAll();
}
function rpc_get_staff_cash_balance(array $p): mixed { return ['current_balance'=>0,'pending_deposit'=>0]; }
function rpc_get_admin_staff_cash_balances(array $p): mixed { return []; }
function rpc_admin_set_staff_cash_balance(array $p): mixed { return ['success'=>true]; }
function rpc_open_cash_session_from_balance(array $p): mixed { return rpc_open_cash_session_from_branch_balance($p); }
function rpc_close_cash_session_apply_balance(array $p): mixed { return rpc_close_cash_session_apply_branch_balance($p); }

// ══════════════════════════════════════════════════════════════════════════════
// PO STOCK INTEGRATION RPC FUNCTIONS
// ══════════════════════════════════════════════════════════════════════════════

// ── Helper: cari mapping bahan (branch-specific lebih prioritas dari global) ──
function poFindMaterialMapping(PDO $pdo, string $materialId, int $branchId): ?array {
    // Coba mapping khusus cabang dulu
    $stmt = $pdo->prepare("
        SELECT * FROM po_material_pos_mappings
        WHERE po_material_id = ? AND pos_branch_id = ? AND is_active = 1
        LIMIT 1
    ");
    $stmt->execute([$materialId, $branchId]);
    $row = $stmt->fetch();
    if ($row) return $row;

    // Fallback ke mapping global (pos_branch_id IS NULL)
    $stmt = $pdo->prepare("
        SELECT * FROM po_material_pos_mappings
        WHERE po_material_id = ? AND pos_branch_id IS NULL AND is_active = 1
        LIMIT 1
    ");
    $stmt->execute([$materialId]);
    return $stmt->fetch() ?: null;
}

// ── Helper: auto-map bahan PO ke ingredient POS berdasarkan kesamaan nama ─────
// Dipakai sebagai fallback ketika tidak ada mapping manual di po_material_pos_mappings.
// Jika nama material PO sama persis (case-insensitive) dengan nama ingredient POS,
// simpan mapping otomatis dengan conversion_factor dari po_package_qty PO.
function poAutoMapByExactName(PDO $pdo, string $materialId, string $materialName, float $packageQty): ?array {
    if (trim($materialName) === '') return null;

    $stmt = $pdo->prepare("
        SELECT id, name FROM ingredients
        WHERE LOWER(TRIM(name)) = LOWER(TRIM(?))
        LIMIT 1
    ");
    $stmt->execute([$materialName]);
    $ingredient = $stmt->fetch();
    if (!$ingredient) return null;

    $ingredientId   = (int)$ingredient['id'];
    $ingredientName = (string)$ingredient['name'];
    $convNote = $packageQty != 1.0
        ? "Auto: 1 unit PO = {$packageQty} unit POS (dari package_qty)"
        : 'Auto: nama sama persis';

    // Simpan mapping global jika belum ada (hindari duplikat)
    try {
        $pdo->prepare("
            INSERT INTO po_material_pos_mappings
                (po_material_id, po_material_name, pos_ingredient_id, pos_ingredient_name,
                 pos_branch_id, conversion_factor, conversion_note, match_type, is_active)
            SELECT ?, ?, ?, ?, NULL, ?, ?, 'auto_name', 1
            FROM DUAL
            WHERE NOT EXISTS (
                SELECT 1 FROM po_material_pos_mappings
                WHERE po_material_id = ? AND pos_branch_id IS NULL
            )
        ")->execute([$materialId, $materialName, $ingredientId, $ingredientName, $packageQty, $convNote, $materialId]);
    } catch (\Exception $e) {
        // Tetap lanjutkan meski penyimpanan mapping gagal
    }

    return [
        'pos_ingredient_id'   => $ingredientId,
        'pos_ingredient_name' => $ingredientName,
        'conversion_factor'   => $packageQty,
        'match_type'          => 'auto_name',
    ];
}

// ── Helper: cek apakah bahan PO di-ignore global ─────────────────────────────
function poIsMaterialGloballyIgnored(PDO $pdo, string $materialId, string $materialName = ''): bool {
    $stmt = $pdo->prepare("
        SELECT 1 FROM po_ignored_materials
        WHERE pos_branch_id IS NULL AND is_active = 1
          AND (po_material_id = ?
               OR (? != '' AND LOWER(TRIM(po_material_name)) = LOWER(TRIM(?))))
        LIMIT 1
    ");
    $stmt->execute([$materialId, $materialName, $materialName]);
    return (bool)$stmt->fetch();
}

// ── Helper: cek apakah bahan PO di-ignore untuk cabang ini ───────────────────
function poIsMaterialIgnored(PDO $pdo, string $materialId, int $branchId, string $materialName = ''): bool {
    // Cek global dulu
    if (poIsMaterialGloballyIgnored($pdo, $materialId, $materialName)) return true;

    // Cek khusus cabang
    $stmt = $pdo->prepare("
        SELECT 1 FROM po_ignored_materials
        WHERE (po_material_id = ?
               OR (? != '' AND LOWER(TRIM(po_material_name)) = LOWER(TRIM(?))))
          AND pos_branch_id = ? AND is_active = 1
        LIMIT 1
    ");
    $stmt->execute([$materialId, $materialName, $materialName, $branchId]);
    return (bool)$stmt->fetch();
}

function poApplyIgnoredMaterialStatuses(PDO $pdo): void {
    // Cocokkan via UUID (primary) ATAU via nama bahan (fallback untuk kasus mismatch UUID)
    $pdo->exec("
        UPDATE po_stock_sync_items psi
        JOIN po_ignored_materials pim
          ON (pim.po_material_id = psi.po_material_id
              OR (TRIM(pim.po_material_name) != ''
                  AND LOWER(TRIM(pim.po_material_name)) = LOWER(TRIM(psi.po_material_name))))
         AND pim.is_active = 1
         AND (pim.pos_branch_id IS NULL OR pim.pos_branch_id = psi.pos_branch_id)
        SET psi.sync_status = 'diabaikan_dari_stok_pos',
            psi.error_message = NULL,
            psi.updated_at = NOW()
        WHERE psi.sync_status IN ('butuh_mapping_admin','butuh_alokasi_cabang','belum_disinkronkan')
    ");
}

// ── Helper: resolve outlet_id → branch POS id ────────────────────────────────
function poResolveBranch(PDO $pdo, string $outletId): ?array {
    $stmt = $pdo->prepare("
        SELECT pos_branch_id, pos_branch_name FROM po_outlet_branch_mappings
        WHERE po_outlet_id = ? AND is_active = 1
        LIMIT 1
    ");
    $stmt->execute([$outletId]);
    return $stmt->fetch() ?: null;
}

function poGetPreviouslySyncedBranches(PDO $pdo, string $poId, string $poItemId): array {
    $stmt = $pdo->prepare("
        SELECT DISTINCT psi.pos_branch_id AS branch_id, b.name AS branch_name
        FROM po_stock_sync_items psi
        LEFT JOIN branches b ON b.id = psi.pos_branch_id
        WHERE psi.po_id = ?
          AND psi.po_item_id = ?
          AND psi.pos_branch_id IS NOT NULL
          AND COALESCE(psi.target_sync_qty, 0) <> 0
    ");
    $stmt->execute([$poId, $poItemId]);
    return $stmt->fetchAll();
}

function poNormalizeTargetBranches(array $targetBranches, float $qtyReceived, bool $isCancelled): array {
    if (!$targetBranches) return [];

    if ($isCancelled || $qtyReceived <= 0) {
        foreach ($targetBranches as &$tb) $tb['qty'] = 0.0;
        unset($tb);
        return $targetBranches;
    }

    foreach ($targetBranches as &$tb) {
        $tb['qty'] = max(0.0, (float)($tb['qty'] ?? 0));
    }
    unset($tb);

    $positiveBranches = array_values(array_filter(
        $targetBranches,
        fn($tb) => ((float)($tb['qty'] ?? 0)) > 0
    ));

    if (count($positiveBranches) === 1) {
        $branchId = (int)$positiveBranches[0]['branch_id'];
        foreach ($targetBranches as &$tb) {
            $tb['qty'] = ((int)$tb['branch_id'] === $branchId) ? $qtyReceived : 0.0;
        }
        unset($tb);
    }

    return $targetBranches;
}

function poLockSyncItem(
    PDO $pdo,
    int $syncRunId,
    string $poId,
    string $poItemId,
    string $materialId,
    string $materialName,
    string $poStatus,
    string $itemSource,
    float $qtyReceived,
    int $branchId,
    ?int $ingredientId,
    ?string $ingredientName
): array {
    $idempotencyKey = "purchase_order:{$poId}:{$poItemId}:{$branchId}";
    $stmt = $pdo->prepare("
        INSERT INTO po_stock_sync_items
          (sync_run_id, po_id, po_item_id, po_material_id, po_material_name,
           po_status, po_item_source, po_qty_received,
           pos_branch_id, pos_ingredient_id, pos_ingredient_name,
           target_sync_qty, previous_synced_qty, delta_qty, sync_status, idempotency_key)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,0,0,0,'belum_disinkronkan',?)
        ON DUPLICATE KEY UPDATE
          id = LAST_INSERT_ID(id),
          sync_run_id = VALUES(sync_run_id),
          po_material_id = VALUES(po_material_id),
          po_material_name = VALUES(po_material_name),
          po_status = VALUES(po_status),
          po_item_source = VALUES(po_item_source),
          po_qty_received = VALUES(po_qty_received),
          pos_ingredient_id = COALESCE(VALUES(pos_ingredient_id), pos_ingredient_id),
          pos_ingredient_name = COALESCE(VALUES(pos_ingredient_name), pos_ingredient_name),
          idempotency_key = VALUES(idempotency_key),
          updated_at = NOW()
    ");
    $stmt->execute([
        $syncRunId, $poId, $poItemId, $materialId, $materialName,
        $poStatus, $itemSource, $qtyReceived,
        $branchId, $ingredientId, $ingredientName,
        $idempotencyKey,
    ]);

    $rowId = (int)$pdo->lastInsertId();
    $lock = $pdo->prepare("SELECT * FROM po_stock_sync_items WHERE id=? FOR UPDATE");
    $lock->execute([$rowId]);
    $row = $lock->fetch();
    if (!$row) throw new Exception('Gagal mengunci item sync PO');
    return $row;
}

function poFetchRemovedSyncedItems(PDO $pdo, string $poId, array $currentPoItemIds): array {
    $params = [$poId];
    $notInSql = '';
    $currentPoItemIds = array_values(array_unique(array_filter($currentPoItemIds)));
    if ($currentPoItemIds) {
        $placeholders = implode(',', array_fill(0, count($currentPoItemIds), '?'));
        $notInSql = "AND po_item_id NOT IN ($placeholders)";
        $params = array_merge($params, $currentPoItemIds);
    }

    $stmt = $pdo->prepare("
        SELECT *
        FROM po_stock_sync_items
        WHERE po_id = ?
          $notInSql
          AND pos_branch_id IS NOT NULL
          AND pos_ingredient_id IS NOT NULL
          AND ABS(COALESCE(previous_synced_qty, 0) + COALESCE(delta_qty, 0)) >= 0.0001
    ");
    $stmt->execute($params);
    return $stmt->fetchAll();
}

// ── Helper: tulis log inventory + update stok dalam satu transaksi ────────────
function poApplyStockDelta(
    PDO $pdo,
    int $branchId,
    int $ingredientId,
    float $delta,
    string $poId,
    string $poItemId,
    string $noteText,
    ?int $triggeredBy,
    string $actionType
): int {
    // Kunci baris stok untuk UPDATE
    $cur = $pdo->prepare("SELECT stock FROM branch_inventory WHERE branch_id=? AND ingredient_id=? FOR UPDATE");
    $cur->execute([$branchId, $ingredientId]);
    $row = $cur->fetch();
    $before = $row ? (float)$row['stock'] : 0.0;
    $after  = $before + $delta;

    if ($row) {
        $pdo->prepare("UPDATE branch_inventory SET stock=? WHERE branch_id=? AND ingredient_id=?")
            ->execute([$after, $branchId, $ingredientId]);
    } else {
        $pdo->prepare("INSERT INTO branch_inventory (branch_id,ingredient_id,stock) VALUES (?,?,?)")
            ->execute([$branchId, $ingredientId, max(0.0, $after)]);
    }

    $logRow = [
        'branch_id'      => $branchId,
        'ingredient_id'  => $ingredientId,
        'type'           => $delta >= 0 ? 'in' : 'out',
        'quantity'       => $delta,
        'stock_before'   => $before,
        'stock_after'    => $after,
        'reference_type' => 'purchase_order',
        'reference_id'   => $poId,
        'notes'          => $noteText,
        'created_by'     => $triggeredBy,
        'action_type'    => $actionType,
        'source_system'  => 'purchase_order',
        'source_po_id'   => $poId,
        'source_po_item_id' => $poItemId,
        'actor_role'     => 'system',
        'sync_status'    => 'sudah_disinkronkan',
    ];
    $logRow = array_filter($logRow, fn($v, $k) => dbColumnExists($pdo, 'inventory_logs', $k), ARRAY_FILTER_USE_BOTH);
    insertDynamic($pdo, 'inventory_logs', $logRow);
    return (int)$pdo->lastInsertId();
}

// ── Fungsi utama: sync PO ke stok POS ────────────────────────────────────────
// Dipanggil oleh server purchase_order menggunakan API key (system RPC).
//
// p_po_id           : UUID PO dari Supabase
// p_po_status       : status PO saat ini (received / received_partial / cancelled dll)
// p_trigger_type    : po_received | po_revised | po_cancelled | manual_retry
// p_triggered_by    : POS user id yang trigger (opsional)
// p_items           : JSON array — setiap item berisi informasi lengkap dari Supabase
//
// Format p_items tiap elemen:
// {
//   "po_item_id"      : "uuid",
//   "po_material_id"  : "uuid",
//   "po_material_name": "Roti Tawar",
//   "po_item_source"  : "ordered" | "adjustment",
//   "qty_received"    : 10.0,       // 0 atau null = tidak ada penerimaan
//   "outlet_id"       : "uuid",     // outlet utama PO (dipakai jika tdk ada distribusi)
//   "outlet_name"     : "Pusat",
//   "branch_distributions": [       // opsional — distribusi per cabang
//     {"outlet_id": "uuid", "outlet_name": "Cabang A", "qty": 6.0},
//     {"outlet_id": "uuid", "outlet_name": "Cabang B", "qty": 4.0}
//   ]
// }
function rpc_sync_purchase_order_to_inventory(array $p): mixed {
    $pdo         = getDB();
    $poId        = trim((string)($p['p_po_id']       ?? ''));
    $poStatus    = trim((string)($p['p_po_status']    ?? ''));
    $triggerType = trim((string)($p['p_trigger_type'] ?? 'po_received'));
    $triggeredBy = !empty($p['p_triggered_by']) ? (int)$p['p_triggered_by'] : null;
    $itemsRaw    = $p['p_items'] ?? [];

    if (!$poId) throw new Exception('p_po_id wajib diisi');
    if (empty($itemsRaw)) throw new Exception('p_items wajib berisi minimal satu item');

    $items = is_string($itemsRaw) ? json_decode($itemsRaw, true) : $itemsRaw;
    if (!is_array($items)) throw new Exception('p_items harus berupa array JSON');

    // Validasi status PO
    $isCancelled = in_array($triggerType, ['po_cancelled'], true);
    if (!$isCancelled && !in_array($poStatus, ['received', 'received_partial'], true)) {
        throw new Exception("Sync tidak diizinkan untuk PO dengan status '$poStatus'. Hanya status received atau received_partial.");
    }

    // Buat sync run
    $pdo->prepare("
        INSERT INTO po_stock_sync_runs (po_id, trigger_type, status, triggered_by, triggered_by_role)
        VALUES (?, ?, 'pending', ?, 'system')
    ")->execute([$poId, $triggerType, $triggeredBy]);
    $syncRunId = (int)$pdo->lastInsertId();

    $successCount = 0;
    $skippedCount = 0;
    $errorCount   = 0;
    $results      = [];
    $currentPoItemIds = [];

    foreach ($items as $item) {
        $poItemId       = (string)($item['po_item_id']       ?? '');
        $materialId     = (string)($item['po_material_id']   ?? '');
        $materialName   = (string)($item['po_material_name'] ?? '');
        $itemSource     = (string)($item['po_item_source']   ?? 'ordered');
        $qtyReceived    = (float)($item['qty_received']      ?? 0);
        $poPackageQty   = max(1.0, (float)($item['po_package_qty'] ?? 1));
        $outletId       = (string)($item['outlet_id']        ?? '');
        $distributions  = is_array($item['branch_distributions'] ?? null) ? $item['branch_distributions'] : [];

        if (!$poItemId || !$materialId) {
            $results[] = ['po_item_id' => $poItemId, 'status' => 'gagal_sinkron', 'error' => 'po_item_id dan po_material_id wajib diisi'];
            $errorCount++;
            continue;
        }
        $currentPoItemIds[] = $poItemId;

        // Bahan yang di-ignore global tidak perlu mapping bahan maupun alokasi cabang.
        if (poIsMaterialGloballyIgnored($pdo, $materialId, $materialName)) {
            $results[] = ['po_item_id' => $poItemId, 'status' => 'diabaikan_dari_stok_pos'];
            $skippedCount++;
            poUpsertSyncItem($pdo, $syncRunId, $poId, $poItemId, $materialId, $materialName, $poStatus, $itemSource, $qtyReceived, null, null, null, 0, 0, null, 'diabaikan_dari_stok_pos', null);
            continue;
        }

        // Untuk cancel: target qty = 0
        if ($isCancelled) $qtyReceived = 0.0;

        // Tentukan target distribusi per cabang
        $targetBranches = [];
        $previousBranches = poGetPreviouslySyncedBranches($pdo, $poId, $poItemId);
        $isRevisionLike = in_array($triggerType, ['po_revised', 'po_cancelled', 'manual_retry'], true);
        if (!empty($distributions)) {
            foreach ($distributions as $dist) {
                $distOutletId = (string)($dist['outlet_id'] ?? '');
                $distQty      = (float)($dist['qty']        ?? 0);
                if (!$distOutletId) continue;
                $branchRow = poResolveBranch($pdo, $distOutletId);
                if (!$branchRow) {
                    $results[] = ['po_item_id' => $poItemId, 'outlet_id' => $distOutletId, 'status' => 'butuh_alokasi_cabang', 'error' => "Outlet '$distOutletId' belum dipetakan ke branch POS"];
                    $skippedCount++;
                    // Upsert sync item sebagai butuh alokasi
                    poUpsertSyncItem($pdo, $syncRunId, $poId, $poItemId, $materialId, $materialName, $poStatus, $itemSource, $qtyReceived * (empty($distributions) ? 1 : 1), null, null, null, 0, 0, null, 'butuh_alokasi_cabang', "Outlet '$distOutletId' belum dipetakan");
                    continue;
                }
                if ($isCancelled) $distQty = 0.0; // akan di-handle oleh delta logic
                $targetBranches[] = ['branch_id' => (int)$branchRow['pos_branch_id'], 'branch_name' => $branchRow['pos_branch_name'], 'outlet_id' => $distOutletId, 'qty' => $distQty];
            }
        } elseif ($outletId) {
            $branchRow = poResolveBranch($pdo, $outletId);
            if (!$branchRow) {
                $results[] = ['po_item_id' => $poItemId, 'status' => 'butuh_alokasi_cabang', 'error' => "Outlet '$outletId' belum dipetakan ke branch POS"];
                $skippedCount++;
                poUpsertSyncItem($pdo, $syncRunId, $poId, $poItemId, $materialId, $materialName, $poStatus, $itemSource, $qtyReceived, null, null, null, 0, 0, null, 'butuh_alokasi_cabang', "Outlet '$outletId' belum dipetakan");
                continue;
            }
            $targetBranches[] = ['branch_id' => (int)$branchRow['pos_branch_id'], 'branch_name' => $branchRow['pos_branch_name'], 'outlet_id' => $outletId, 'qty' => $qtyReceived];
        } else {
            if ($isRevisionLike && !empty($previousBranches)) {
                foreach ($previousBranches as $prevBranch) {
                    $targetBranches[] = [
                        'branch_id' => (int)$prevBranch['branch_id'],
                        'branch_name' => $prevBranch['branch_name'] ?? '',
                        'outlet_id' => '',
                        'qty' => 0.0,
                    ];
                }
            } else {
                $results[] = ['po_item_id' => $poItemId, 'status' => 'butuh_alokasi_cabang', 'error' => 'Tidak ada informasi outlet/cabang untuk item ini'];
                $skippedCount++;
                poUpsertSyncItem($pdo, $syncRunId, $poId, $poItemId, $materialId, $materialName, $poStatus, $itemSource, $qtyReceived, null, null, null, 0, 0, null, 'butuh_alokasi_cabang', 'Tidak ada outlet');
                continue;
            }
        }

        if ($isRevisionLike && !empty($previousBranches)) {
            $currentBranchIds = [];
            foreach ($targetBranches as $tb) $currentBranchIds[(int)$tb['branch_id']] = true;
            foreach ($previousBranches as $prevBranch) {
                $prevBranchId = (int)$prevBranch['branch_id'];
                if (!$prevBranchId || isset($currentBranchIds[$prevBranchId])) continue;
                $targetBranches[] = [
                    'branch_id' => $prevBranchId,
                    'branch_name' => $prevBranch['branch_name'] ?? '',
                    'outlet_id' => '',
                    'qty' => 0.0,
                ];
            }
        }

        $targetBranches = poNormalizeTargetBranches($targetBranches, $qtyReceived, $isCancelled);

        // Proses setiap target cabang
        foreach ($targetBranches as $tb) {
            $branchId   = (int)$tb['branch_id'];
            $branchQty  = (float)$tb['qty'];

            // Cek ignored
            if (poIsMaterialIgnored($pdo, $materialId, $branchId, $materialName)) {
                $results[] = ['po_item_id' => $poItemId, 'branch_id' => $branchId, 'status' => 'diabaikan_dari_stok_pos'];
                $skippedCount++;
                poUpsertSyncItem($pdo, $syncRunId, $poId, $poItemId, $materialId, $materialName, $poStatus, $itemSource, $branchQty, $branchId, null, null, 0, 0, null, 'diabaikan_dari_stok_pos', null);
                continue;
            }

            // Cari mapping bahan — coba manual dulu, lalu auto-map berdasarkan nama
            $mapping = poFindMaterialMapping($pdo, $materialId, $branchId);
            if (!$mapping) {
                $mapping = poAutoMapByExactName($pdo, $materialId, $materialName, $poPackageQty);
            }
            if (!$mapping) {
                $results[] = ['po_item_id' => $poItemId, 'branch_id' => $branchId, 'status' => 'butuh_mapping_admin', 'error' => "Bahan '$materialName' belum dipetakan ke bahan POS"];
                $skippedCount++;
                poUpsertSyncItem($pdo, $syncRunId, $poId, $poItemId, $materialId, $materialName, $poStatus, $itemSource, $branchQty, $branchId, null, null, 0, 0, null, 'butuh_mapping_admin', "Bahan '$materialName' belum dipetakan");
                continue;
            }

            $ingredientId    = (int)$mapping['pos_ingredient_id'];
            $ingredientName  = (string)$mapping['pos_ingredient_name'];
            $convFactor      = (float)$mapping['conversion_factor'];
            if ($convFactor <= 0) $convFactor = 1.0;

            // Hitung target qty di POS setelah konversi satuan
            $targetSyncQty = round($branchQty * $convFactor, 4);

            $prevSyncedQty = 0.0;
            $deltaQty = 0.0;
            $pdo->beginTransaction();
            try {
                $lockedSync = poLockSyncItem(
                    $pdo,
                    $syncRunId,
                    $poId,
                    $poItemId,
                    $materialId,
                    $materialName,
                    $poStatus,
                    $itemSource,
                    $branchQty,
                    $branchId,
                    $ingredientId,
                    $ingredientName
                );
                $prevSyncedQty = (float)$lockedSync['previous_synced_qty'] + (float)($lockedSync['delta_qty'] ?? 0);
                $deltaQty = round($targetSyncQty - $prevSyncedQty, 4);

                if (abs($deltaQty) < 0.0001) {
                    poUpsertSyncItem($pdo, $syncRunId, $poId, $poItemId, $materialId, $materialName, $poStatus, $itemSource, $branchQty, $branchId, $ingredientId, $ingredientName, $targetSyncQty, $prevSyncedQty, null, 'sudah_disinkronkan', null);
                    $pdo->commit();
                    $results[] = ['po_item_id' => $poItemId, 'branch_id' => $branchId, 'status' => 'sudah_disinkronkan', 'delta' => 0];
                    $successCount++;
                    continue;
                }

                // Untuk cancel: cek stok cukup jika perlu rollback
                if ($isCancelled && $deltaQty < 0) {
                    $stockCheck = $pdo->prepare("SELECT COALESCE(stock,0) FROM branch_inventory WHERE branch_id=? AND ingredient_id=?");
                    $stockCheck->execute([$branchId, $ingredientId]);
                    $currentStock = (float)($stockCheck->fetchColumn() ?? 0);
                    if ($currentStock + $deltaQty < 0) {
                        poUpsertSyncItem($pdo, $syncRunId, $poId, $poItemId, $materialId, $materialName, $poStatus, $itemSource, $branchQty, $branchId, $ingredientId, $ingredientName, $targetSyncQty, $prevSyncedQty, null, 'rollback_butuh_review_admin', "Stok tidak cukup: stok=$currentStock, perlu=" . abs($deltaQty));
                        insertDynamic($pdo, 'po_stock_sync_errors', [
                            'sync_run_id' => $syncRunId, 'po_id' => $poId, 'po_item_id' => $poItemId,
                            'error_code' => 'ROLLBACK_INSUFFICIENT_STOCK',
                            'error_message' => "Stok tidak cukup untuk rollback PO. Stok saat ini: $currentStock, perlu dikurangi: " . abs($deltaQty),
                        ]);
                        $pdo->commit();
                        $results[] = ['po_item_id' => $poItemId, 'branch_id' => $branchId, 'status' => 'rollback_butuh_review_admin', 'error' => "Stok tidak cukup untuk rollback: stok=$currentStock, perlu dikurangi=" . abs($deltaQty)];
                        $skippedCount++;
                        continue;
                    }
                }

                $actionType  = match($triggerType) {
                    'po_cancelled' => 'po_cancelled',
                    'po_revised'   => 'po_revised',
                    default        => 'po_received',
                };
                $noteText = match($triggerType) {
                    'po_cancelled' => "Rollback PO #{$poId}",
                    'po_revised'   => "Revisi PO #{$poId}",
                    default        => "PO #{$poId} diterima",
                };
                $logId = poApplyStockDelta($pdo, $branchId, $ingredientId, $deltaQty, $poId, $poItemId, $noteText, $triggeredBy, $actionType);
                poUpsertSyncItem($pdo, $syncRunId, $poId, $poItemId, $materialId, $materialName, $poStatus, $itemSource, $branchQty, $branchId, $ingredientId, $ingredientName, $targetSyncQty, $prevSyncedQty, $logId, 'sudah_disinkronkan', null);
                $pdo->commit();
                $results[] = ['po_item_id' => $poItemId, 'branch_id' => $branchId, 'status' => 'sudah_disinkronkan', 'delta' => $deltaQty];
                $successCount++;
            } catch (Throwable $e) {
                if ($pdo->inTransaction()) $pdo->rollBack();
                $results[] = ['po_item_id' => $poItemId, 'branch_id' => $branchId, 'status' => 'gagal_sinkron', 'error' => $e->getMessage()];
                $errorCount++;
                try {
                    insertDynamic($pdo, 'po_stock_sync_errors', [
                        'sync_run_id' => $syncRunId, 'po_id' => $poId, 'po_item_id' => $poItemId,
                        'error_code' => 'SYNC_ERROR', 'error_message' => $e->getMessage(),
                    ]);
                    poUpsertSyncItem($pdo, $syncRunId, $poId, $poItemId, $materialId, $materialName, $poStatus, $itemSource, $branchQty, $branchId, $ingredientId, $ingredientName, $targetSyncQty, $prevSyncedQty, null, 'gagal_sinkron', $e->getMessage());
                } catch (Throwable) {}
            }
        }
    }

    if (in_array($triggerType, ['po_revised', 'po_cancelled'], true)) {
        foreach (poFetchRemovedSyncedItems($pdo, $poId, $currentPoItemIds) as $removed) {
            $poItemId = (string)$removed['po_item_id'];
            $branchId = (int)$removed['pos_branch_id'];
            $ingredientId = (int)$removed['pos_ingredient_id'];
            $ingredientName = (string)($removed['pos_ingredient_name'] ?? '');
            $materialId = (string)($removed['po_material_id'] ?? '');
            $materialName = (string)($removed['po_material_name'] ?? '');
            $itemSource = (string)($removed['po_item_source'] ?? 'ordered');
            $prevSyncedQty = 0.0;
            $deltaQty = 0.0;

            if ($branchId <= 0 || $ingredientId <= 0) continue;

            $pdo->beginTransaction();
            try {
                $lockedSync = poLockSyncItem(
                    $pdo,
                    $syncRunId,
                    $poId,
                    $poItemId,
                    $materialId,
                    $materialName,
                    $poStatus,
                    $itemSource,
                    0.0,
                    $branchId,
                    $ingredientId,
                    $ingredientName
                );
                $prevSyncedQty = (float)$lockedSync['previous_synced_qty'] + (float)($lockedSync['delta_qty'] ?? 0);
                $deltaQty = round(0.0 - $prevSyncedQty, 4);

                if (abs($deltaQty) < 0.0001) {
                    poUpsertSyncItem($pdo, $syncRunId, $poId, $poItemId, $materialId, $materialName, $poStatus, $itemSource, 0.0, $branchId, $ingredientId, $ingredientName, 0.0, $prevSyncedQty, null, 'sudah_disinkronkan', null);
                    $pdo->commit();
                    continue;
                }

                $actionType = $triggerType === 'po_cancelled' ? 'po_cancelled' : 'po_revised';
                $noteText = $triggerType === 'po_cancelled'
                    ? "Rollback PO #{$poId}"
                    : "Item dihapus dari penerimaan PO #{$poId}";
                $logId = poApplyStockDelta($pdo, $branchId, $ingredientId, $deltaQty, $poId, $poItemId, $noteText, $triggeredBy, $actionType);
                poUpsertSyncItem($pdo, $syncRunId, $poId, $poItemId, $materialId, $materialName, $poStatus, $itemSource, 0.0, $branchId, $ingredientId, $ingredientName, 0.0, $prevSyncedQty, $logId, 'sudah_disinkronkan', null);
                $pdo->commit();
                $results[] = ['po_item_id' => $poItemId, 'branch_id' => $branchId, 'status' => 'sudah_disinkronkan', 'delta' => $deltaQty, 'removed' => true];
                $successCount++;
            } catch (Throwable $e) {
                if ($pdo->inTransaction()) $pdo->rollBack();
                $results[] = ['po_item_id' => $poItemId, 'branch_id' => $branchId, 'status' => 'gagal_sinkron', 'error' => $e->getMessage(), 'removed' => true];
                $errorCount++;
                try {
                    insertDynamic($pdo, 'po_stock_sync_errors', [
                        'sync_run_id' => $syncRunId, 'po_id' => $poId, 'po_item_id' => $poItemId,
                        'error_code' => 'REMOVED_ITEM_SYNC_ERROR', 'error_message' => $e->getMessage(),
                    ]);
                    poUpsertSyncItem($pdo, $syncRunId, $poId, $poItemId, $materialId, $materialName, $poStatus, $itemSource, 0.0, $branchId, $ingredientId, $ingredientName, 0.0, $prevSyncedQty, null, 'gagal_sinkron', $e->getMessage());
                } catch (Throwable) {}
            }
        }
    }

    // Update status sync run
    $finalStatus = match(true) {
        $errorCount > 0 && $successCount === 0 => 'failed',
        $errorCount > 0 || $skippedCount > 0   => 'partial_success',
        default                                 => 'success',
    };
    $summary = json_encode(['success' => $successCount, 'skipped' => $skippedCount, 'errors' => $errorCount], JSON_UNESCAPED_UNICODE);
    $pdo->prepare("UPDATE po_stock_sync_runs SET status=?, finished_at=NOW(), summary=? WHERE id=?")
        ->execute([$finalStatus, $summary, $syncRunId]);

    return ['sync_run_id' => $syncRunId, 'status' => $finalStatus, 'summary' => ['success' => $successCount, 'skipped' => $skippedCount, 'errors' => $errorCount], 'results' => $results];
}

// ── Helper: upsert po_stock_sync_items ────────────────────────────────────────
function poUpsertSyncItem(
    PDO $pdo,
    int $syncRunId,
    string $poId,
    string $poItemId,
    string $materialId,
    string $materialName,
    string $poStatus,
    string $itemSource,
    float $qtyReceived,
    ?int $branchId,
    ?int $ingredientId,
    ?string $ingredientName,
    float $targetSyncQty,
    float $prevSyncedQty,
    ?int $logId,
    string $syncStatus,
    ?string $errorMessage
): void {
    $idempotencyKey = "purchase_order:{$poId}:{$poItemId}:" . ($branchId ?? 'null');
    $deltaQty = round($targetSyncQty - $prevSyncedQty, 4);

    // Cek apakah record sudah ada
    $existing = $pdo->prepare("SELECT id FROM po_stock_sync_items WHERE po_id=? AND po_item_id=? AND pos_branch_id<=>? LIMIT 1");
    $existing->execute([$poId, $poItemId, $branchId]);
    $existingRow = $existing->fetch();

    if ($existingRow) {
        $pdo->prepare("
            UPDATE po_stock_sync_items SET
              sync_run_id=?, po_material_id=?, po_material_name=?, po_status=?, po_item_source=?,
              po_qty_received=?, pos_ingredient_id=?, pos_ingredient_name=?,
              target_sync_qty=?, previous_synced_qty=?, delta_qty=?,
              inventory_log_id=?, sync_status=?, error_message=?, idempotency_key=?, updated_at=NOW()
            WHERE id=?
        ")->execute([
            $syncRunId, $materialId, $materialName, $poStatus, $itemSource,
            $qtyReceived, $ingredientId, $ingredientName,
            $targetSyncQty, $prevSyncedQty, $deltaQty,
            $logId, $syncStatus, $errorMessage, $idempotencyKey,
            $existingRow['id']
        ]);
    } else {
        $pdo->prepare("
            INSERT INTO po_stock_sync_items
              (sync_run_id, po_id, po_item_id, po_material_id, po_material_name,
               po_status, po_item_source, po_qty_received,
               pos_branch_id, pos_ingredient_id, pos_ingredient_name,
               target_sync_qty, previous_synced_qty, delta_qty,
               inventory_log_id, sync_status, error_message, idempotency_key)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
        ")->execute([
            $syncRunId, $poId, $poItemId, $materialId, $materialName,
            $poStatus, $itemSource, $qtyReceived,
            $branchId, $ingredientId, $ingredientName,
            $targetSyncQty, $prevSyncedQty, $deltaQty,
            $logId, $syncStatus, $errorMessage, $idempotencyKey
        ]);
    }
}

// ── Admin: simpan mapping outlet PO → branch POS ─────────────────────────────
function rpc_po_sync_save_outlet_mapping(array $p): mixed {
    $pdo          = getDB();
    $poOutletId   = trim((string)($p['p_po_outlet_id']   ?? ''));
    $poOutletName = trim((string)($p['p_po_outlet_name'] ?? ''));
    $posBranchId  = (int)($p['p_pos_branch_id']          ?? 0);
    $authUser     = $p['_auth_user'] ?? null;

    if (!$poOutletId || !$posBranchId) throw new Exception('p_po_outlet_id dan p_pos_branch_id wajib diisi');

    // Ambil nama branch
    $branchStmt = $pdo->prepare("SELECT name FROM branches WHERE id=? LIMIT 1");
    $branchStmt->execute([$posBranchId]);
    $branchRow = $branchStmt->fetch();
    if (!$branchRow) throw new Exception('Branch POS tidak ditemukan');

    $createdBy = $authUser['id'] ?? null;

    $existing = $pdo->prepare("SELECT id FROM po_outlet_branch_mappings WHERE po_outlet_id=? LIMIT 1");
    $existing->execute([$poOutletId]);
    if ($existing->fetch()) {
        $pdo->prepare("
            UPDATE po_outlet_branch_mappings SET
              po_outlet_name=?, pos_branch_id=?, pos_branch_name=?, is_active=1, updated_at=NOW()
            WHERE po_outlet_id=?
        ")->execute([$poOutletName, $posBranchId, $branchRow['name'], $poOutletId]);
    } else {
        $pdo->prepare("
            INSERT INTO po_outlet_branch_mappings
              (po_outlet_id, po_outlet_name, pos_branch_id, pos_branch_name, created_by)
            VALUES (?,?,?,?,?)
        ")->execute([$poOutletId, $poOutletName, $posBranchId, $branchRow['name'], $createdBy]);
    }
    return ['success' => true];
}

// ── Admin: simpan mapping material PO → ingredient POS ───────────────────────
function rpc_po_sync_save_material_mapping(array $p): mixed {
    $pdo              = getDB();
    $poMaterialId     = trim((string)($p['p_po_material_id']    ?? ''));
    $poMaterialName   = trim((string)($p['p_po_material_name']  ?? ''));
    $posIngredientId  = (int)($p['p_pos_ingredient_id']          ?? 0);
    $posBranchId      = !empty($p['p_pos_branch_id']) ? (int)$p['p_pos_branch_id'] : null;
    $conversionFactor = (float)($p['p_conversion_factor']         ?? 1.0);
    $conversionNote   = trim((string)($p['p_conversion_note']    ?? ''));
    $authUser         = $p['_auth_user'] ?? null;

    if (!$poMaterialId || !$posIngredientId) throw new Exception('p_po_material_id dan p_pos_ingredient_id wajib diisi');
    if ($conversionFactor <= 0) throw new Exception('conversion_factor harus lebih dari 0');

    // Ambil nama ingredient
    $ingStmt = $pdo->prepare("SELECT name FROM ingredients WHERE id=? LIMIT 1");
    $ingStmt->execute([$posIngredientId]);
    $ingRow = $ingStmt->fetch();
    if (!$ingRow) throw new Exception('Ingredient POS tidak ditemukan');

    $createdBy = $authUser['id'] ?? null;

    // Nonaktifkan mapping lama dengan material+branch yang sama (jika ada)
    $pdo->prepare("
        UPDATE po_material_pos_mappings SET is_active=0, updated_by=?
        WHERE po_material_id=? AND pos_branch_id<=>? AND is_active=1
    ")->execute([$createdBy, $poMaterialId, $posBranchId]);

    $pdo->prepare("
        INSERT INTO po_material_pos_mappings
          (po_material_id, po_material_name, pos_ingredient_id, pos_ingredient_name,
           pos_branch_id, conversion_factor, conversion_note, match_type, is_active, created_by, updated_by)
        VALUES (?,?,?,?,?,?,?,'manual',1,?,?)
    ")->execute([
        $poMaterialId, $poMaterialName, $posIngredientId, $ingRow['name'],
        $posBranchId, $conversionFactor, $conversionNote ?: null,
        $createdBy, $createdBy
    ]);

    // Tandai sync items yang butuh mapping agar bisa di-retry
    $pdo->prepare("
        UPDATE po_stock_sync_items SET sync_status='belum_disinkronkan', updated_at=NOW()
        WHERE po_material_id=? AND sync_status='butuh_mapping_admin'
          AND (pos_branch_id=? OR ? IS NULL)
    ")->execute([$poMaterialId, $posBranchId, $posBranchId]);

    return ['success' => true];
}

// ── Admin: tandai bahan PO sebagai diabaikan dari stok POS ───────────────────
function rpc_po_sync_save_ignored_material(array $p): mixed {
    $pdo            = getDB();
    $poMaterialId   = trim((string)($p['p_po_material_id']   ?? ''));
    $poMaterialName = trim((string)($p['p_po_material_name'] ?? ''));
    $posBranchId    = !empty($p['p_pos_branch_id']) ? (int)$p['p_pos_branch_id'] : null;
    $reason         = trim((string)($p['p_reason']           ?? ''));
    $isActive       = isset($p['p_is_active']) ? (int)$p['p_is_active'] : 1;
    $authUser       = $p['_auth_user'] ?? null;

    if (!$poMaterialId) throw new Exception('p_po_material_id wajib diisi');
    $createdBy = $authUser['id'] ?? null;

    $existing = $pdo->prepare("SELECT id FROM po_ignored_materials WHERE po_material_id=? AND pos_branch_id<=>? LIMIT 1");
    $existing->execute([$poMaterialId, $posBranchId]);
    if ($existing->fetch()) {
        $pdo->prepare("UPDATE po_ignored_materials SET is_active=?, reason=? WHERE po_material_id=? AND pos_branch_id<=>?")
            ->execute([$isActive, $reason ?: null, $poMaterialId, $posBranchId]);
    } else {
        $pdo->prepare("
            INSERT INTO po_ignored_materials (po_material_id, po_material_name, pos_branch_id, reason, is_active, created_by)
            VALUES (?,?,?,?,?,?)
        ")->execute([$poMaterialId, $poMaterialName, $posBranchId, $reason ?: null, $isActive, $createdBy]);
    }

    // Update sync items yang butuh mapping ke diabaikan
    if ($isActive) {
        $pdo->prepare("
            UPDATE po_stock_sync_items SET sync_status='diabaikan_dari_stok_pos', updated_at=NOW()
            WHERE po_material_id=? AND sync_status IN ('butuh_mapping_admin','butuh_alokasi_cabang','belum_disinkronkan')
              AND (pos_branch_id=? OR ? IS NULL)
        ")->execute([$poMaterialId, $posBranchId, $posBranchId]);
    }
    return ['success' => true];
}

// ── Admin: retry sync run yang gagal ─────────────────────────────────────────
function rpc_po_sync_retry(array $p): mixed {
    // Ambil sync items yang masih butuh proses untuk PO ini, lalu re-trigger
    // Pada implementasi ini, admin perlu mengirim ulang data PO dari FE
    $pdo        = getDB();
    $poId       = trim((string)($p['p_po_id'] ?? ''));
    $authUser   = $p['_auth_user'] ?? null;
    if (!$poId) throw new Exception('p_po_id wajib diisi');

    // Update sync items butuh mapping yang sudah di-mapping jadi belum_disinkronkan
    $pdo->prepare("
        UPDATE po_stock_sync_items SET sync_status='belum_disinkronkan', updated_at=NOW()
        WHERE po_id=? AND sync_status='butuh_mapping_admin'
    ")->execute([$poId]);

    return ['success' => true, 'message' => 'Item yang sudah di-mapping siap disinkronkan ulang. Jalankan sync dari halaman Purchase Order.'];
}

// ── Admin: daftar item yang butuh mapping / diabaikan / error ─────────────────
function rpc_po_sync_get_pending_mappings(array $p): mixed {
    $pdo    = getDB();
    poApplyIgnoredMaterialStatuses($pdo);

    $poId   = !empty($p['p_po_id']) ? trim($p['p_po_id']) : null;
    $status = !empty($p['p_status']) ? trim($p['p_status']) : 'butuh_mapping_admin';
    $limit  = (int)($p['p_limit'] ?? 50);
    $offset = (int)($p['p_offset'] ?? 0);

    $where = ['psi.sync_status = ?'];
    $vals  = [$status];
    if ($poId) { $where[] = 'psi.po_id = ?'; $vals[] = $poId; }

    $sql = "
        SELECT psi.*, b.name AS branch_name, i.name AS ingredient_name_pos, i.unit AS ingredient_unit
        FROM po_stock_sync_items psi
        LEFT JOIN branches b ON b.id = psi.pos_branch_id
        LEFT JOIN ingredients i ON i.id = psi.pos_ingredient_id
        WHERE " . implode(' AND ', $where) . "
        ORDER BY psi.updated_at DESC
        LIMIT ? OFFSET ?
    ";
    $vals[] = $limit;
    $vals[] = $offset;
    $stmt = $pdo->prepare($sql);
    $stmt->execute($vals);
    return $stmt->fetchAll();
}

// ── Admin: riwayat sync run ───────────────────────────────────────────────────
function rpc_po_sync_get_runs(array $p): mixed {
    $pdo    = getDB();
    poApplyIgnoredMaterialStatuses($pdo);

    $poId   = !empty($p['p_po_id']) ? trim($p['p_po_id']) : null;
    $limit  = (int)($p['p_limit'] ?? 20);
    $offset = (int)($p['p_offset'] ?? 0);

    $where = $poId ? 'WHERE r.po_id = ?' : '';
    $vals  = $poId ? [$poId] : [];
    $vals[] = $limit;
    $vals[] = $offset;

    $stmt = $pdo->prepare("
        SELECT r.*, u.name AS triggered_by_name
        FROM po_stock_sync_runs r
        LEFT JOIN users u ON u.id = r.triggered_by
        $where
        ORDER BY r.started_at DESC
        LIMIT ? OFFSET ?
    ");
    $stmt->execute($vals);
    $runs = $stmt->fetchAll();

    // Tambah item summary per run
    foreach ($runs as &$run) {
        $itemStmt = $pdo->prepare("
            SELECT sync_status, COUNT(*) AS cnt FROM po_stock_sync_items
            WHERE sync_run_id = ? GROUP BY sync_status
        ");
        $itemStmt->execute([$run['id']]);
        $run['item_summary'] = $itemStmt->fetchAll();

        $detailStmt = $pdo->prepare("
            SELECT
              psi.id, psi.po_item_id, psi.po_material_id, psi.po_material_name,
              psi.po_item_source, psi.po_qty_received,
              psi.pos_branch_id, b.name AS branch_name,
              psi.pos_ingredient_id, psi.pos_ingredient_name, i.unit AS ingredient_unit,
              psi.target_sync_qty, psi.previous_synced_qty, psi.delta_qty,
              psi.sync_status, psi.error_message, psi.inventory_log_id, psi.updated_at
            FROM po_stock_sync_items psi
            LEFT JOIN branches b ON b.id = psi.pos_branch_id
            LEFT JOIN ingredients i ON i.id = psi.pos_ingredient_id
            WHERE psi.sync_run_id = ?
            ORDER BY b.name, psi.po_material_name
        ");
        $detailStmt->execute([$run['id']]);
        $run['items'] = $detailStmt->fetchAll();
    }
    return $runs;
}
function rpc_get_staff_cash_ledger(array $p): mixed { return []; }
function rpc_rbn_require_admin_session(array $p): mixed { return null; }
function rpc_sync_investor_payment_methods(array $p): mixed { return ['success'=>true]; }

// ── Helper: insert branch_cash_ledger ─────────────────────────────────────────
function rpcInsertBranchCashLedger(
    PDO $pdo, int $branchId, ?int $staffId, ?int $adminId,
    ?int $sessionId, ?string $transferId,
    string $movementType, string $direction, float $amount,
    float $before, float $after,
    ?string $reason, ?string $srcTable, ?string $srcId
): void {
    try {
        $pdo->prepare("
            INSERT IGNORE INTO branch_cash_ledger
              (branch_id,staff_id,admin_id,cash_session_id,transfer_id,
               movement_type,direction,amount,balance_before,balance_after,
               reason,source_table,source_id)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
        ")->execute([
            $branchId,$staffId,$adminId,$sessionId,$transferId,
            $movementType,$direction,$amount,$before,$after,
            $reason,$srcTable,$srcId
        ]);
    } catch (Throwable) { /* ignore duplicate */ }
}

// ── po_sync_get_suggestions ───────────────────────────────────────────────────
// Menghasilkan saran mapping otomatis berdasarkan kemiripan nama bahan PO
// dengan bahan POS. Admin masih harus approve sebelum mapping disimpan.
//
// Sumber bahan PO: po_stock_sync_items (butuh_mapping_admin) UNION po_ignored_materials
// + bahan dari manual input (p_extra_materials JSON opsional).
function rpc_po_sync_get_suggestions(array $p): mixed {
    $pdo           = getDB();
    poApplyIgnoredMaterialStatuses($pdo);

    $extraRaw      = $p['p_extra_materials'] ?? null;
    $extraMaterials = [];
    if ($extraRaw) {
        $decoded = is_string($extraRaw) ? json_decode($extraRaw, true) : $extraRaw;
        if (is_array($decoded)) $extraMaterials = $decoded;
    }

    // 1. Ambil semua bahan PO yang butuh mapping (dari sync items)
    $matStmt = $pdo->query("
        SELECT DISTINCT po_material_id, po_material_name
        FROM po_stock_sync_items
        WHERE sync_status = 'butuh_mapping_admin'
          AND po_material_id IS NOT NULL
          AND po_material_name IS NOT NULL
        ORDER BY po_material_name
    ");
    $materials = $matStmt->fetchAll();

    // Tambah bahan dari extra input (jika ada, tanpa duplikat)
    $existingIds = array_column($materials, 'po_material_id');
    foreach ($extraMaterials as $em) {
        if (!empty($em['po_material_id']) && !in_array($em['po_material_id'], $existingIds, true)) {
            $materials[] = [
                'po_material_id'   => $em['po_material_id'],
                'po_material_name' => $em['po_material_name'] ?? $em['po_material_id'],
            ];
            $existingIds[] = $em['po_material_id'];
        }
    }

    // 2. Ambil semua ingredient aktif di POS
    $ingStmt = $pdo->query("SELECT id, name, unit FROM ingredients WHERE COALESCE(is_active,1)=1 ORDER BY name");
    $ingredients = $ingStmt->fetchAll();

    // 3. Ambil mapping yang sudah ada (agar tidak disarankan ulang)
    $mappedIds = [];
    $mappedStmt = $pdo->query("SELECT po_material_id FROM po_material_pos_mappings WHERE is_active=1");
    foreach ($mappedStmt->fetchAll() as $row) $mappedIds[] = $row['po_material_id'];

    // 4. Hitung skor kemiripan per material
    $results = [];
    foreach ($materials as $mat) {
        // Skip yang sudah punya mapping aktif
        if (in_array($mat['po_material_id'], $mappedIds, true)) continue;

        $matNameNorm = poNormalizeName($mat['po_material_name']);
        $top = [];

        foreach ($ingredients as $ing) {
            $ingNameNorm = poNormalizeName($ing['name']);
            $score = poCalcSimilarity($matNameNorm, $ingNameNorm);
            if ($score > 0) {
                $top[] = ['id' => $ing['id'], 'name' => $ing['name'], 'unit' => $ing['unit'], 'score' => $score];
            }
        }

        // Sort by score desc, ambil top 3
        usort($top, fn($a, $b) => $b['score'] - $a['score']);
        $top = array_slice($top, 0, 3);

        $results[] = [
            'po_material_id'      => $mat['po_material_id'],
            'po_material_name'    => $mat['po_material_name'],
            'best_match'          => $top[0] ?? null,
            'alternatives'        => array_slice($top, 1),
            'already_mapped'      => false,
        ];
    }

    return [
        'suggestions'  => $results,
        'ingredients'  => $ingredients,  // untuk dropdown pilih manual
        'total_unmapped' => count($results),
    ];
}

// Normalisasi nama: lowercase, trim, hapus karakter non-alfanumerik
function poNormalizeName(string $name): string {
    $name = strtolower(trim($name));
    $name = preg_replace('/[^a-z0-9\s]/', ' ', $name);
    $name = preg_replace('/\s+/', ' ', $name);
    return trim($name);
}

// Hitung skor kemiripan 0-100 antara dua nama ternormalisasi
function poCalcSimilarity(string $a, string $b): int {
    if ($a === '' || $b === '') return 0;

    // Exact match
    if ($a === $b) return 100;

    // Satu mengandung yang lain
    if (str_contains($a, $b) || str_contains($b, $a)) return 85;

    // Overlap kata
    $aWords = array_filter(explode(' ', $a));
    $bWords = array_filter(explode(' ', $b));
    $overlap = count(array_intersect($aWords, $bWords));
    if ($overlap > 0) {
        $ratio = $overlap / max(count($aWords), count($bWords));
        return (int)round($ratio * 70);
    }

    // similar_text PHP built-in sebagai fallback
    similar_text($a, $b, $pct);
    return $pct >= 50 ? (int)round($pct * 0.5) : 0;
}

// ══════════════════════════════════════════════════════════════════════════════
// MEMBER & LOYALTY POINT MODULE (migration 064) — Fase 1 MVP
// Lihat docs/PRD_Member_Loyalty_Point.md
// ══════════════════════════════════════════════════════════════════════════════

// ── Daftar RPC member berdasarkan jenis auth ──────────────────────────────────
function memberPublicRpcNames(): array {
    return ['member_register', 'member_login', 'member_forgot_password'];
}
function memberSessionRpcNames(): array {
    return [
        'member_logout', 'member_me', 'member_update_profile', 'member_change_password',
        'member_get_balance', 'member_get_point_history', 'member_get_transaction_history',
        'member_list_rewards', 'member_claim_reward', 'member_cancel_claim', 'member_my_claims',
    ];
}
function memberAdminRpcNames(): array {
    return [
        'member_admin_search', 'member_admin_get_detail', 'member_admin_set_active',
        'member_admin_set_staff_link', 'member_admin_manual_adjust', 'member_admin_lock_points',
        'member_admin_unlock_points', 'member_admin_reset_password', 'member_admin_void_claim',
        'member_admin_approve_claim', 'member_admin_create', 'member_dashboard_stats',
        'member_fraud_dashboard', 'member_fraud_resolve',
    ];
}
// Staff/admin RPC (lewat X-Session-Token biasa): member_lookup, member_validate_qr,
// member_preview_points, member_redeem_at_cashier, member_unattach_from_transaction.

// ── Settings ──────────────────────────────────────────────────────────────────
function memberGetSettings(PDO $pdo): array {
    static $cache = null;
    if ($cache !== null) return $cache;
    $cache = [];
    try {
        foreach ($pdo->query("SELECT setting_key,setting_value,value_type FROM member_settings")->fetchAll() as $r) {
            $v = $r['setting_value'];
            switch ($r['value_type']) {
                case 'int':     $v = (int)$v; break;
                case 'decimal': $v = (float)$v; break;
                case 'bool':    $v = ($v === '1' || $v === 'true' || $v === 1 || $v === true); break;
                case 'json':    $d = json_decode((string)$v, true); $v = is_array($d) ? $d : []; break;
            }
            $cache[$r['setting_key']] = $v;
        }
    } catch (Throwable) { $cache = []; }
    return $cache;
}
function memberLoyaltyEnabled(PDO $pdo): bool {
    if (!dbColumnExists($pdo, 'members', 'id')) return false; // tabel belum dimigrasi
    return !empty(memberGetSettings($pdo)['enable_loyalty_module']);
}

// ── Utilitas ──────────────────────────────────────────────────────────────────
function maskPhone(string $phone): string {
    $phone = trim($phone);
    if (strlen($phone) <= 6) return $phone;
    return substr($phone, 0, 4) . str_repeat('*', max(1, strlen($phone) - 8)) . substr($phone, -4);
}
function memberGenCode(PDO $pdo): string {
    $prefix = 'RBN-' . date('ym') . '-';
    $alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    for ($i = 0; $i < 25; $i++) {
        $s = '';
        for ($j = 0; $j < 5; $j++) $s .= $alphabet[random_int(0, strlen($alphabet) - 1)];
        $code = $prefix . $s;
        $chk = $pdo->prepare("SELECT 1 FROM members WHERE member_code=? LIMIT 1");
        $chk->execute([$code]);
        if (!$chk->fetch()) return $code;
    }
    return $prefix . strtoupper(bin2hex(random_bytes(3)));
}
function memberGenRedemptionCode(PDO $pdo): string {
    $alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // tanpa O,0,I,1
    for ($i = 0; $i < 25; $i++) {
        $s = '';
        for ($j = 0; $j < 8; $j++) $s .= $alphabet[random_int(0, strlen($alphabet) - 1)];
        $chk = $pdo->prepare("SELECT 1 FROM member_reward_claims WHERE redemption_code=? LIMIT 1");
        $chk->execute([$s]);
        if (!$chk->fetch()) return $s;
    }
    return strtoupper(bin2hex(random_bytes(4)));
}
function memberStaticQrToken(array $member): string {
    $id  = (int)$member['id'];
    $sig = substr(hash_hmac('sha256', 'MBR' . $id, (string)$member['qr_secret']), 0, 20);
    return 'MBR.' . $id . '.' . $sig;
}
function memberValidateQrToken(PDO $pdo, string $token): ?array {
    if (!str_starts_with($token, 'MBR.')) return null;
    $parts = explode('.', $token);
    if (count($parts) !== 3) return null;
    $id = (int)$parts[1];
    if ($id <= 0) return null;
    $m = $pdo->prepare("SELECT * FROM members WHERE id=? AND is_active=1 AND deleted_at IS NULL LIMIT 1");
    $m->execute([$id]);
    $member = $m->fetch();
    if (!$member) return null;
    $expected = substr(hash_hmac('sha256', 'MBR' . $id, (string)$member['qr_secret']), 0, 20);
    return hash_equals($expected, $parts[2]) ? $member : null;
}
function memberPublicView(array $m, bool $includeContact = false): array {
    $out = [
        'id'                       => (int)$m['id'],
        'member_code'              => $m['member_code'],
        'name'                     => $m['name'],
        'phone_masked'             => maskPhone((string)($m['phone'] ?? '')),
        'gender'                   => $m['gender'] ?? null,
        'birth_date'               => $m['birth_date'] ?? null,
        'is_active'                => (int)($m['is_active'] ?? 1),
        'lifetime_points_earned'   => (int)($m['lifetime_points_earned'] ?? 0),
        'lifetime_points_redeemed' => (int)($m['lifetime_points_redeemed'] ?? 0),
        'created_at'               => $m['created_at'] ?? null,
        'qr_token'                 => isset($m['qr_secret']) ? memberStaticQrToken($m) : null,
    ];
    if ($includeContact) {
        $out['phone'] = $m['phone'] ?? null;
        $out['email'] = $m['email'] ?? null;
    }
    return $out;
}

// ── Validasi input ────────────────────────────────────────────────────────────
function memberValidatePhone(string $p): string {
    $p = trim($p);
    if (!preg_match('/^08[0-9]{8,12}$/', $p)) throw new ApiHttpException(400, 'Nomor HP tidak valid (format 08xxxxxxxxxx)', 'VALIDATION_FAILED');
    return $p;
}
function memberValidatePassword(string $pw): void {
    if (strlen($pw) < 8 || !preg_match('/[A-Za-z]/', $pw) || !preg_match('/[0-9]/', $pw)) {
        throw new ApiHttpException(400, 'Password minimal 8 karakter dan mengandung huruf & angka', 'VALIDATION_FAILED');
    }
}
function memberSanitizeName(string $n): string {
    $n = trim(strip_tags($n));
    if (mb_strlen($n) < 2 || mb_strlen($n) > 80) throw new ApiHttpException(400, 'Nama harus 2-80 karakter', 'VALIDATION_FAILED');
    return $n;
}

// ── Session member ────────────────────────────────────────────────────────────
function currentMemberSession(): ?array {
    static $cache = null; static $done = false;
    if ($done) return $cache;
    $done = true;
    $token = trim((string)($_SERVER['HTTP_X_MEMBER_SESSION_TOKEN'] ?? ''));
    if ($token === '' || strlen($token) < 32 || strlen($token) > 256) return $cache = null;
    $pdo = getDB();
    $hash = hash('sha256', $token);
    $stmt = $pdo->prepare("
        SELECT m.*, s.expires_at AS _session_expires
        FROM member_sessions s JOIN members m ON m.id = s.member_id
        WHERE s.token_hash = ? AND s.expires_at > NOW() AND m.is_active = 1 AND m.deleted_at IS NULL
        LIMIT 1
    ");
    $stmt->execute([$hash]);
    $row = $stmt->fetch();
    if (!$row) return $cache = null;
    try { $pdo->prepare("UPDATE member_sessions SET last_seen_at=NOW() WHERE token_hash=?")->execute([$hash]); } catch (Throwable) {}
    return $cache = $row;
}
function requireMemberSession(): array {
    $m = currentMemberSession();
    if (!$m) denyHttp(401, 'Sesi member tidak valid atau sudah kedaluwarsa', 'MEMBER_SESSION_INVALID');
    return $m;
}
function memberCreateSession(PDO $pdo, int $memberId): array {
    $token   = bin2hex(random_bytes(32));
    $hash    = hash('sha256', $token);
    $expires = date('Y-m-d H:i:s', strtotime('+30 days'));
    $pdo->prepare("INSERT INTO member_sessions (token_hash,member_id,expires_at,ip_address,user_agent) VALUES (?,?,?,?,?)")
        ->execute([$hash, $memberId, $expires, requestIp(), substr((string)($_SERVER['HTTP_USER_AGENT'] ?? ''), 0, 255)]);
    if (mt_rand(1, 20) === 1) { try { $pdo->exec("DELETE FROM member_sessions WHERE expires_at <= NOW() LIMIT 500"); } catch (Throwable) {} }
    return ['session_token' => $token, 'expires_at' => date('c', strtotime($expires))];
}

// ── Ledger & saldo ────────────────────────────────────────────────────────────
function memberMovementEffect(string $m): array {
    // [direction, activeSign, pendingSign]
    return match ($m) {
        'earn_pending'      => ['in',   0, +1],
        'earn_purchase'     => ['in',  +1,  0],
        'pending_to_active' => ['none',+1, -1],
        'redeem_reserve'    => ['out', -1,  0],
        'redeem_commit'     => ['none', 0,  0],
        'redeem_refund'     => ['in',  +1,  0],
        'refund_reversal'   => ['out', -1,  0],
        'manual_adjust_in'  => ['in',  +1,  0],
        'manual_adjust_out' => ['out', -1,  0],
        'expire'            => ['out', -1,  0],
        'fraud_lock'        => ['out', -1,  0],
        'fraud_unlock'      => ['in',  +1,  0],
        default             => ['none', 0,  0],
    };
}
function memberBalances(PDO $pdo, int $memberId): array {
    $s = $pdo->prepare("SELECT balance_active_after,balance_pending_after FROM member_point_ledger WHERE member_id=? ORDER BY id DESC LIMIT 1");
    $s->execute([$memberId]);
    $r = $s->fetch();
    return ['active' => $r ? (int)$r['balance_active_after'] : 0, 'pending' => $r ? (int)$r['balance_pending_after'] : 0];
}
function memberReservedPoints(PDO $pdo, int $memberId): int {
    $s = $pdo->prepare("SELECT COALESCE(SUM(cost_point),0) FROM member_reward_claims WHERE member_id=? AND status IN('redeemable','pending_approval') AND expires_at>NOW()");
    $s->execute([$memberId]);
    return (int)$s->fetchColumn();
}
// Catatan: pemanggil WAJIB sudah berada dalam transaksi DB (beginTransaction).
function memberInsertLedger(PDO $pdo, array $a): array {
    $memberId = (int)$a['member_id'];
    $movement = (string)$a['movement_type'];
    $points   = max(0, (int)$a['points']);

    $pdo->prepare("SELECT id FROM members WHERE id=? FOR UPDATE")->execute([$memberId]);
    $last = $pdo->prepare("SELECT balance_active_after,balance_pending_after FROM member_point_ledger WHERE member_id=? ORDER BY id DESC LIMIT 1");
    $last->execute([$memberId]);
    $row     = $last->fetch();
    $active  = $row ? (int)$row['balance_active_after']  : 0;
    $pending = $row ? (int)$row['balance_pending_after'] : 0;

    [$direction, $da, $dp] = memberMovementEffect($movement);
    if (!empty($a['affect_pending'])) { $dp = $da; $da = 0; } // alihkan delta ke bucket pending

    // Cegah overdraw akibat race (TOCTOU): movement "belanja" milik member tidak boleh
    // membuat saldo aktif minus. Pengecekan ini berada DI DALAM lock FOR UPDATE sehingga
    // atomic terhadap klaim/penukaran paralel. Movement lain tetap memakai clamp di bawah.
    if (in_array($movement, ['redeem_reserve', 'manual_adjust_out'], true) && ($active + $da * $points) < 0) {
        throw new ApiHttpException(400, 'Point tidak cukup', 'INSUFFICIENT_POINTS');
    }

    $newActive  = max(0, $active  + $da * $points);
    $newPending = max(0, $pending + $dp * $points);

    $pdo->prepare("
        INSERT INTO member_point_ledger
          (member_id,branch_id,transaction_id,reward_claim_id,movement_type,direction,points,
           balance_active_before,balance_active_after,balance_pending_before,balance_pending_after,
           expires_at,reason,source_table,source_id,created_by_user_id,metadata)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    ")->execute([
        $memberId,
        $a['branch_id'] ?? null,
        $a['transaction_id'] ?? null,
        $a['reward_claim_id'] ?? null,
        $movement, $direction, $points,
        $active, $newActive, $pending, $newPending,
        $a['expires_at'] ?? null,
        $a['reason'] ?? null,
        $a['source_table'] ?? null,
        $a['source_id'] ?? null,
        $a['created_by_user_id'] ?? null,
        isset($a['metadata']) ? json_encode($a['metadata'], JSON_UNESCAPED_UNICODE) : null,
    ]);
    return ['id' => (int)$pdo->lastInsertId(), 'active' => $newActive, 'pending' => $newPending];
}

// Aktivasi point "pending" yang sudah melewati window jadi "active" (lazy/self-healing,
// tanpa cron). Mengubah tiap lot `earn_pending` matang menjadi `pending_to_active`.
// Idempoten: dijaga oleh uq_ledger_source (source_table+source_id+movement_type) DAN
// klausa NOT EXISTS. Aman dipanggil dari endpoint read (kelola transaksi sendiri) maupun
// dari dalam transaksi pemanggil (mis. claim_reward).
function memberActivateMaturedPending(PDO $pdo, int $memberId): void {
    if ($memberId <= 0) return;
    $hours = (int)(memberGetSettings($pdo)['point_pending_window_hours'] ?? 24);
    if ($hours <= 0) return; // point langsung aktif saat earn — tidak ada yang perlu dikonversi

    $ownTx = !$pdo->inTransaction();
    if ($ownTx) $pdo->beginTransaction();
    try {
        $pdo->prepare("SELECT id FROM members WHERE id=? FOR UPDATE")->execute([$memberId]);
        $lots = $pdo->prepare("
            SELECT l.id, l.transaction_id, l.points, l.branch_id, l.expires_at
            FROM member_point_ledger l
            WHERE l.member_id = ?
              AND l.movement_type = 'earn_pending'
              AND l.created_at <= (NOW() - INTERVAL $hours HOUR)
              AND NOT EXISTS (
                  SELECT 1 FROM member_point_ledger c
                  WHERE c.movement_type = 'pending_to_active'
                    AND c.source_table = 'member_point_ledger'
                    AND c.source_id    = CAST(l.id AS CHAR)
              )
            ORDER BY l.id ASC
        ");
        $lots->execute([$memberId]);
        foreach ($lots->fetchAll() as $lot) {
            // Clamp ke saldo pending saat ini agar lot yang sebagian sudah di-refund
            // (affect_pending) tidak meng-over-aktivasi saldo.
            $pending = memberBalances($pdo, $memberId)['pending'];
            if ($pending <= 0) break;
            $convert = min((int)$lot['points'], $pending);
            if ($convert <= 0) continue;
            memberInsertLedger($pdo, [
                'member_id'      => $memberId,
                'branch_id'      => $lot['branch_id'] ?? null,
                'transaction_id' => $lot['transaction_id'] ?? null,
                'movement_type'  => 'pending_to_active',
                'points'         => $convert,
                'expires_at'     => $lot['expires_at'] ?? null,
                'reason'         => 'Aktivasi point pending (window ' . $hours . ' jam)',
                'source_table'   => 'member_point_ledger',
                'source_id'      => (string)$lot['id'],
            ]);
        }
        if ($ownTx) $pdo->commit();
    } catch (Throwable $e) {
        if ($ownTx) { $pdo->rollBack(); return; } // best-effort saat berdiri sendiri
        throw $e; // di dalam transaksi pemanggil → biarkan rollback menangani
    }
}

// ── Anti-fraud ────────────────────────────────────────────────────────────────
function memberInsertFraudFlag(PDO $pdo, array $a): void {
    try {
        $pdo->prepare("
            INSERT INTO member_fraud_flags (member_id,staff_user_id,transaction_id,flag_type,severity,risk_score,evidence,status)
            VALUES (?,?,?,?,?,?,?, 'open')
        ")->execute([
            $a['member_id'] ?? null, $a['staff_user_id'] ?? null, $a['transaction_id'] ?? null,
            substr((string)($a['flag_type'] ?? 'unknown'), 0, 80),
            $a['severity'] ?? 'medium', (int)($a['risk_score'] ?? 50),
            isset($a['evidence']) ? json_encode($a['evidence'], JSON_UNESCAPED_UNICODE) : null,
        ]);
    } catch (Throwable) {}
}
function memberDetectSelfTransaction(PDO $pdo, array $member, int $staffId): ?array {
    if ($staffId > 0 && (int)($member['staff_link_user_id'] ?? 0) === $staffId)
        return ['type' => 'direct_link', 'severity' => 'critical', 'score' => 95];
    if (dbColumnExists($pdo, 'users', 'personal_phone')) {
        $u = $pdo->prepare("SELECT personal_phone FROM users WHERE id=? LIMIT 1");
        $u->execute([$staffId]);
        $pp = trim((string)($u->fetchColumn() ?: ''));
        if ($pp !== '' && $pp === trim((string)($member['phone'] ?? '')))
            return ['type' => 'phone_match', 'severity' => 'high', 'score' => 80];
    }
    $c = $pdo->prepare("SELECT COUNT(*) FROM transactions WHERE member_id=? AND staff_id=? AND status='completed' AND created_at>=DATE_SUB(NOW(),INTERVAL 7 DAY)");
    $c->execute([(int)$member['id'], $staffId]);
    if ((int)$c->fetchColumn() > 20) return ['type' => 'cashier_member_repeat', 'severity' => 'high', 'score' => 75];
    return null;
}

// ── Hitung point ──────────────────────────────────────────────────────────────
function memberComputePreviewPoints(PDO $pdo, float $subtotal, array $cart): array {
    $S        = memberGetSettings($pdo);
    $ratio    = max(1, (int)($S['point_ratio_rupiah_per_point'] ?? 10000));
    $rounding = $S['point_rounding_mode'] ?? 'floor';
    $minTx    = (float)($S['min_transaction_for_point'] ?? 0);
    $maxPerTx = (int)($S['max_point_per_transaction'] ?? 1000);
    $exProd   = array_map('intval', is_array($S['excluded_product_ids'] ?? null) ? $S['excluded_product_ids'] : []);

    $eligible = $subtotal;
    if ($exProd) {
        foreach ($cart as $it) {
            $pid = (int)($it['product_id'] ?? 0);
            if ($pid && in_array($pid, $exProd, true)) {
                $eligible -= (float)($it['price'] ?? 0) * (float)($it['quantity'] ?? 0);
            }
        }
    }
    if ($eligible < 0) $eligible = 0;
    if ($eligible < $minTx) return ['points' => 0, 'eligible' => $eligible, 'reason' => 'Transaksi di bawah minimum untuk point'];
    $raw = $eligible / $ratio;
    $pts = match ($rounding) { 'round' => (int)round($raw), 'ceil' => (int)ceil($raw), default => (int)floor($raw) };
    if ($maxPerTx > 0) $pts = min($pts, $maxPerTx);
    return ['points' => $pts, 'eligible' => $eligible, 'reason' => $pts > 0 ? null : 'Nominal belum cukup untuk 1 point'];
}

// ── Redeem reward saat checkout (dipanggil di dalam rpc_process_transaction) ───
// Hitung nilai diskon reward secara OTORITATIF di server (jangan percaya frontend).
function memberComputeRewardDiscount(array $reward, float $subtotal, array $cart): float {
    $type = (string)($reward['reward_type'] ?? 'other');
    $val  = $reward['discount_value'] !== null ? (float)$reward['discount_value'] : 0.0;
    $disc = 0.0;
    switch ($type) {
        case 'discount_amount':  $disc = $val; break;
        case 'discount_percent': $disc = round($subtotal * $val / 100); break;
        case 'free_product':
            $pid = !empty($reward['reward_product_id']) ? (int)$reward['reward_product_id'] : 0;
            $vid = !empty($reward['reward_variant_id']) ? (int)$reward['reward_variant_id'] : 0;
            foreach ($cart as $it) {
                $ipid = (int)($it['product_id'] ?? 0);
                $ivid = (int)($it['variant_id'] ?? 0);
                if (($vid && $ivid === $vid) || (!$vid && $pid && $ipid === $pid)) {
                    $disc = (float)($it['price'] ?? 0); // satu unit gratis (harga dasar)
                    break;
                }
            }
            break;
        default: $disc = 0.0; // 'other' → tanpa diskon otomatis
    }
    if ($disc < 0)         $disc = 0.0;
    if ($disc > $subtotal) $disc = $subtotal;
    return $disc;
}

// Validasi + lock klaim reward untuk checkout. Throw bila tidak valid. Mengembalikan
// claim + reward (_reward) + nilai diskon server (_reward_discount).
function memberValidateClaimForCheckout(PDO $pdo, string $code, ?int $memberId, float $subtotal, array $cart, float $discountAmount): array {
    $c = $pdo->prepare("SELECT * FROM member_reward_claims WHERE redemption_code=? FOR UPDATE");
    $c->execute([$code]);
    $claim = $c->fetch();
    if (!$claim) throw new ApiHttpException(404, 'Kode reward tidak ditemukan', 'CLAIM_NOT_FOUND');
    if ($claim['status'] === 'redeemed')         throw new ApiHttpException(409, 'Kode reward sudah dipakai', 'CLAIM_ALREADY_REDEEMED');
    if ($claim['status'] === 'pending_approval') throw new ApiHttpException(400, 'Klaim reward menunggu persetujuan admin', 'CLAIM_PENDING_APPROVAL');
    if ($claim['status'] !== 'redeemable')       throw new ApiHttpException(400, 'Kode reward tidak bisa dipakai', 'CLAIM_NOT_REDEEMABLE');
    if ($claim['expires_at'] < date('Y-m-d H:i:s')) throw new ApiHttpException(400, 'Kode reward kedaluwarsa', 'CLAIM_EXPIRED');
    if ($memberId && (int)$claim['member_id'] !== $memberId)
        throw new ApiHttpException(400, 'Kode reward bukan milik member ini', 'CLAIM_MEMBER_MISMATCH');

    $rw = $pdo->prepare("SELECT * FROM member_rewards WHERE id=?");
    $rw->execute([(int)$claim['reward_id']]);
    $reward = $rw->fetch();
    if (!$reward) throw new ApiHttpException(404, 'Reward tidak ditemukan', 'REWARD_NOT_FOUND');

    $rewardDisc = memberComputeRewardDiscount($reward, $subtotal, $cart);
    if ((string)$reward['reward_type'] === 'free_product' && $rewardDisc <= 0)
        throw new ApiHttpException(400, 'Produk reward belum ada di keranjang', 'REWARD_PRODUCT_NOT_IN_CART');
    // Diskon transaksi WAJIB sudah mencakup nilai reward (frontend menambahkannya sebelum
    // bayar) agar member benar-benar menerima manfaatnya. Toleransi 1 rupiah utk pembulatan.
    if ($rewardDisc > 0 && ($discountAmount + 1) < $rewardDisc) {
        throw new ApiHttpException(400, 'Diskon transaksi belum mencakup nilai reward. Muat ulang halaman kasir.', 'REWARD_DISCOUNT_NOT_APPLIED');
    }
    $claim['_reward']          = $reward;
    $claim['_reward_discount'] = $rewardDisc;
    return $claim;
}

// Konsumsi klaim: tandai redeemed + ledger redeem_commit + link ke transaksi. Atomic
// (dipanggil di dalam transaksi DB rpc_process_transaction).
function memberCommitClaimAtCheckout(PDO $pdo, array $claim, int $txId, int $branchId, ?int $staffId, ?array $authUser): void {
    $claimId = (int)$claim['id'];
    $by      = $staffId ?: ($authUser['id'] ?? null);
    $pdo->prepare("UPDATE member_reward_claims SET status='redeemed', redeemed_at=NOW(), redeemed_by_user_id=?, redeemed_at_branch_id=?, transaction_id=? WHERE id=?")
        ->execute([$by, $branchId ?: null, $txId, $claimId]);
    // redeem_commit tidak mengubah saldo (point sudah dipotong saat redeem_reserve di klaim).
    memberInsertLedger($pdo, [
        'member_id'          => (int)$claim['member_id'],
        'branch_id'          => $branchId ?: null,
        'reward_claim_id'    => $claimId,
        'transaction_id'     => $txId,
        'movement_type'      => 'redeem_commit',
        'points'             => (int)$claim['cost_point'],
        'reason'             => 'Redeem reward saat checkout',
        'source_table'       => 'member_reward_claims',
        'source_id'          => $claimId . ':commit',
        'created_by_user_id' => $by,
    ]);
    $pdo->prepare("UPDATE members SET lifetime_points_redeemed=lifetime_points_redeemed+? WHERE id=?")
        ->execute([(int)$claim['cost_point'], (int)$claim['member_id']]);
    $pdo->prepare("UPDATE transactions SET reward_claim_id=? WHERE id=?")->execute([$claimId, $txId]);
}

// Dipanggil di dalam rpc_process_transaction (sudah dalam transaksi DB).
function memberAwardPointsForTransaction(PDO $pdo, array $a): array {
    $memberId = (int)$a['member_id'];
    $staffId  = (int)$a['staff_id'];
    $branchId = (int)$a['branch_id'];
    $txId     = (int)$a['tx_id'];
    $subtotal = (float)$a['subtotal'];
    $cart     = $a['cart'] ?? [];

    $m = $pdo->prepare("SELECT * FROM members WHERE id=? AND is_active=1 AND deleted_at IS NULL LIMIT 1");
    $m->execute([$memberId]);
    $member = $m->fetch();
    if (!$member) return ['points_awarded' => 0, 'balance' => null, 'note' => 'Member tidak ditemukan / nonaktif'];

    $S       = memberGetSettings($pdo);
    $preview = memberComputePreviewPoints($pdo, $subtotal, $cart);
    $points  = (int)$preview['points'];
    $note    = null;

    // Self-transaction → block point
    $self = memberDetectSelfTransaction($pdo, $member, $staffId);
    if ($self && in_array($self['type'], ['direct_link', 'phone_match'], true)) {
        memberInsertFraudFlag($pdo, [
            'member_id' => $memberId, 'staff_user_id' => $staffId, 'transaction_id' => $txId,
            'flag_type' => 'self_transaction', 'severity' => $self['severity'], 'risk_score' => $self['score'],
            'evidence' => ['detector' => $self['type'], 'tx' => $txId],
        ]);
        $pdo->prepare("UPDATE transactions SET member_id=?, member_attached_at=NOW(), points_awarded=0 WHERE id=?")->execute([$memberId, $txId]);
        $pdo->prepare("UPDATE members SET last_transaction_at=NOW() WHERE id=?")->execute([$memberId]);
        return ['points_awarded' => 0, 'balance' => memberBalances($pdo, $memberId), 'note' => 'Transaksi masuk review anti-fraud (kasir = member). Point tidak diberikan.'];
    }

    // Batas harian
    $maxDaily = (int)($S['max_point_per_member_per_day'] ?? 50);
    if ($maxDaily > 0 && $points > 0) {
        $today = $pdo->prepare("SELECT COALESCE(SUM(points),0) FROM member_point_ledger WHERE member_id=? AND direction='in' AND movement_type IN('earn_purchase','earn_pending','manual_adjust_in') AND DATE(created_at)=CURDATE()");
        $today->execute([$memberId]);
        $remaining = max(0, $maxDaily - (int)$today->fetchColumn());
        if ($points > $remaining) {
            $points = $remaining;
            $note   = 'Sebagian point tidak diberikan: batas harian tercapai';
            memberInsertFraudFlag($pdo, ['member_id' => $memberId, 'staff_user_id' => $staffId, 'transaction_id' => $txId, 'flag_type' => 'daily_cap_reached', 'severity' => 'low', 'risk_score' => 30, 'evidence' => ['max_daily' => $maxDaily]]);
        }
    }

    if ($points > 0) {
        $pendingHours = (int)($S['point_pending_window_hours'] ?? 24);
        $validityDays = (int)($S['point_validity_days'] ?? 365);
        $expiresAt    = $validityDays > 0 ? date('Y-m-d H:i:s', strtotime("+{$validityDays} days")) : null;
        $movement     = $pendingHours > 0 ? 'earn_pending' : 'earn_purchase';
        memberInsertLedger($pdo, [
            'member_id' => $memberId, 'branch_id' => $branchId, 'transaction_id' => $txId,
            'movement_type' => $movement, 'points' => $points, 'expires_at' => $expiresAt,
            'reason' => 'Earn dari transaksi #' . $txId,
            'source_table' => 'transactions', 'source_id' => (string)$txId,
            'created_by_user_id' => $staffId,
            'metadata' => ['subtotal' => $subtotal, 'eligible' => $preview['eligible']],
        ]);
        $pdo->prepare("UPDATE members SET lifetime_points_earned=lifetime_points_earned+?, last_transaction_at=NOW() WHERE id=?")->execute([$points, $memberId]);
    } else {
        $pdo->prepare("UPDATE members SET last_transaction_at=NOW() WHERE id=?")->execute([$memberId]);
        if (!$note) $note = $preview['reason'] ?? 'Tidak ada point untuk transaksi ini';
    }

    if ($self && in_array($self['type'], ['cashier_member_repeat', 'exclusive_cashier'], true)) {
        memberInsertFraudFlag($pdo, ['member_id' => $memberId, 'staff_user_id' => $staffId, 'transaction_id' => $txId, 'flag_type' => $self['type'], 'severity' => $self['severity'], 'risk_score' => $self['score'], 'evidence' => ['tx' => $txId]]);
    }

    $pdo->prepare("UPDATE transactions SET member_id=?, member_attached_at=NOW(), points_awarded=? WHERE id=?")->execute([$memberId, $points, $txId]);
    return ['points_awarded' => $points, 'balance' => memberBalances($pdo, $memberId), 'note' => $note];
}

// Reversal point saat void/refund. Dipanggil di dalam transaksi DB.
function memberReverseTransactionPoints(PDO $pdo, array $t, ?float $refundAmount, ?int $by, string $reason): void {
    $txId     = (int)$t['id'];
    $memberId = !empty($t['member_id']) ? (int)$t['member_id'] : 0;
    $awarded  = (int)($t['points_awarded'] ?? 0);

    if ($memberId && $awarded > 0) {
        $total   = (float)$t['total'];
        $reverse = $awarded;
        if ($refundAmount !== null && $total > 0 && $refundAmount < $total) {
            $reverse = (int)floor($awarded * ($refundAmount / $total));
        }
        if ($reverse > 0) {
            $conv = $pdo->prepare("SELECT COUNT(*) FROM member_point_ledger WHERE transaction_id=? AND movement_type='pending_to_active'");
            $conv->execute([$txId]);
            $wasConverted = ((int)$conv->fetchColumn()) > 0;
            $earnStmt = $pdo->prepare("SELECT movement_type FROM member_point_ledger WHERE transaction_id=? AND movement_type IN('earn_pending','earn_purchase') ORDER BY id ASC LIMIT 1");
            $earnStmt->execute([$txId]);
            $earnType = (string)$earnStmt->fetchColumn();
            $affectPending = ($earnType === 'earn_pending' && !$wasConverted);
            memberInsertLedger($pdo, [
                'member_id' => $memberId, 'branch_id' => (int)$t['branch_id'], 'transaction_id' => $txId,
                'movement_type' => 'refund_reversal', 'points' => $reverse, 'reason' => $reason,
                'source_table' => 'transactions', 'source_id' => $txId . ':rev:' . ($refundAmount !== null ? (int)$refundAmount : 'full'),
                'created_by_user_id' => $by, 'affect_pending' => $affectPending,
            ]);
            $pdo->prepare("UPDATE members SET lifetime_points_earned=GREATEST(0,lifetime_points_earned-?) WHERE id=?")->execute([$reverse, $memberId]);
            $pdo->prepare("UPDATE transactions SET points_awarded=GREATEST(0,points_awarded-?) WHERE id=?")->execute([$reverse, $txId]);
        }
    }

    if (!empty($t['reward_claim_id'])) {
        $claimId = (int)$t['reward_claim_id'];
        $cl = $pdo->prepare("SELECT * FROM member_reward_claims WHERE id=? FOR UPDATE");
        $cl->execute([$claimId]);
        $claim = $cl->fetch();
        if ($claim && $claim['status'] === 'redeemed') {
            $pdo->prepare("UPDATE member_reward_claims SET status='cancelled', cancelled_at=NOW(), cancel_reason=? WHERE id=?")->execute([$reason, $claimId]);
            memberInsertLedger($pdo, [
                'member_id' => (int)$claim['member_id'], 'reward_claim_id' => $claimId,
                'movement_type' => 'redeem_refund', 'points' => (int)$claim['cost_point'],
                'reason' => 'Refund klaim karena ' . $reason,
                'source_table' => 'member_reward_claims', 'source_id' => $claimId . ':refund_tx' . $txId,
                'created_by_user_id' => $by,
            ]);
            $pdo->prepare("UPDATE members SET lifetime_points_redeemed=GREATEST(0,lifetime_points_redeemed-?) WHERE id=?")->execute([(int)$claim['cost_point'], (int)$claim['member_id']]);
            $pdo->prepare("UPDATE member_rewards SET quota_used=GREATEST(0,quota_used-1) WHERE id=?")->execute([(int)$claim['reward_id']]);
        }
    }
}

// ══════════════════════════════════════════════════════════════════════════════
// RPC: Member auth (public)
// ══════════════════════════════════════════════════════════════════════════════
function rpc_member_register(array $p): mixed {
    $pdo   = getDB();
    $phone = memberValidatePhone((string)($p['phone'] ?? ''));
    $name  = memberSanitizeName((string)($p['name'] ?? ''));
    $pw    = (string)($p['password'] ?? '');
    memberValidatePassword($pw);
    $email = trim((string)($p['email'] ?? ''));
    if ($email !== '' && !filter_var($email, FILTER_VALIDATE_EMAIL)) throw new ApiHttpException(400, 'Email tidak valid', 'VALIDATION_FAILED');
    $birth = trim((string)($p['birth_date'] ?? ''));
    if ($birth !== '' && !preg_match('/^\d{4}-\d{2}-\d{2}$/', $birth)) $birth = '';
    $gender   = in_array($p['gender'] ?? '', ['M', 'F', 'other'], true) ? $p['gender'] : null;
    $branchId = !empty($p['signup_branch_id']) ? (int)$p['signup_branch_id'] : null;

    $chk = $pdo->prepare("SELECT id FROM members WHERE phone=? LIMIT 1");
    $chk->execute([$phone]);
    if ($chk->fetch()) throw new ApiHttpException(409, 'Nomor HP sudah terdaftar. Silakan login.', 'PHONE_ALREADY_EXISTS');
    if ($email !== '') {
        $e = $pdo->prepare("SELECT id FROM members WHERE email=? LIMIT 1");
        $e->execute([$email]);
        if ($e->fetch()) throw new ApiHttpException(409, 'Email sudah terdaftar', 'EMAIL_ALREADY_EXISTS');
    }

    $code   = memberGenCode($pdo);
    $secret = bin2hex(random_bytes(32));
    $hash   = password_hash($pw, PASSWORD_BCRYPT);
    $pdo->prepare("INSERT INTO members (member_code,name,phone,email,password,birth_date,gender,qr_secret,signup_branch_id) VALUES (?,?,?,?,?,?,?,?,?)")
        ->execute([$code, $name, $phone, $email ?: null, $hash, $birth ?: null, $gender, $secret, $branchId]);
    $id = (int)$pdo->lastInsertId();
    auditLog(null, 'member_register', 'members', null, ['id' => $id, 'member_code' => $code, 'phone' => maskPhone($phone)], $branchId);
    $sess = memberCreateSession($pdo, $id);
    $m = $pdo->prepare("SELECT * FROM members WHERE id=?");
    $m->execute([$id]);
    return ['member' => memberPublicView($m->fetch(), true), 'session_token' => $sess['session_token'], 'expires_at' => $sess['expires_at']];
}

function rpc_member_login(array $p): mixed {
    $pdo = getDB();
    $identifier = trim((string)($p['identifier'] ?? $p['phone'] ?? $p['email'] ?? ''));
    $pw = (string)($p['password'] ?? '');
    if ($identifier === '' || $pw === '') throw new ApiHttpException(400, 'Identifier & password wajib diisi', 'VALIDATION_FAILED');
    rateLimitAction('member_login_id', 10, 300, 'member:' . strtolower($identifier));

    $stmt = $pdo->prepare("SELECT * FROM members WHERE (phone=? OR email=?) AND deleted_at IS NULL LIMIT 1");
    $stmt->execute([$identifier, $identifier]);
    $m = $stmt->fetch();
    if (!$m || !password_verify($pw, (string)$m['password'])) {
        if ($m) auditLog(null, 'member_login_failed', 'members', null, ['id' => (int)$m['id']], null);
        throw new ApiHttpException(401, 'Nomor HP/email atau password salah', 'MEMBER_LOGIN_FAILED');
    }
    if ((int)$m['is_active'] !== 1) throw new ApiHttpException(403, 'Akun member nonaktif. Hubungi admin.', 'MEMBER_INACTIVE');
    $sess = memberCreateSession($pdo, (int)$m['id']);
    auditLog(null, 'member_login', 'members', null, ['id' => (int)$m['id']], null);
    return ['member' => memberPublicView($m, true), 'session_token' => $sess['session_token'], 'expires_at' => $sess['expires_at']];
}

function rpc_member_forgot_password(array $p): mixed {
    // Fase 1: catat permintaan untuk admin. Tidak membocorkan apakah nomor terdaftar.
    $phone = trim((string)($p['phone'] ?? ''));
    if ($phone !== '') auditLog(null, 'member_forgot_password', 'members', null, ['phone' => maskPhone($phone)], null);
    return ['ok' => true, 'message' => 'Jika nomor terdaftar, admin akan membantu reset password.'];
}

// ══════════════════════════════════════════════════════════════════════════════
// RPC: Member self (butuh X-Member-Session-Token)
// ══════════════════════════════════════════════════════════════════════════════
function rpc_member_logout(array $p): mixed {
    $token = trim((string)($_SERVER['HTTP_X_MEMBER_SESSION_TOKEN'] ?? ''));
    if ($token !== '') getDB()->prepare("DELETE FROM member_sessions WHERE token_hash=?")->execute([hash('sha256', $token)]);
    return ['ok' => true];
}

function rpc_member_me(array $p): mixed {
    $m   = $p['_member'];
    $pdo = getDB();
    $id  = (int)$m['id'];
    memberActivateMaturedPending($pdo, $id);
    $bal = memberBalances($pdo, $id);
    $exp = $pdo->prepare("SELECT COALESCE(SUM(points),0) FROM member_point_ledger WHERE member_id=? AND direction='in' AND movement_type IN('earn_purchase','pending_to_active') AND expires_at IS NOT NULL AND expires_at BETWEEN NOW() AND DATE_ADD(NOW(),INTERVAL 30 DAY)");
    $exp->execute([$id]);
    return [
        'member'  => memberPublicView($m, true),
        'balance' => ['active' => $bal['active'], 'pending' => $bal['pending'], 'reserved' => memberReservedPoints($pdo, $id)],
        'expiring_soon_points' => (int)$exp->fetchColumn(),
    ];
}

function rpc_member_get_balance(array $p): mixed {
    $m   = $p['_member'];
    $pdo = getDB();
    memberActivateMaturedPending($pdo, (int)$m['id']);
    $bal = memberBalances($pdo, (int)$m['id']);
    return [
        'active'            => $bal['active'],
        'pending'          => $bal['pending'],
        'reserved'         => memberReservedPoints($pdo, (int)$m['id']),
        'lifetime_earned'  => (int)($m['lifetime_points_earned'] ?? 0),
        'lifetime_redeemed' => (int)($m['lifetime_points_redeemed'] ?? 0),
    ];
}

function rpc_member_update_profile(array $p): mixed {
    $m   = $p['_member'];
    $pdo = getDB();
    $id  = (int)$m['id'];
    if (!password_verify((string)($p['current_password'] ?? ''), (string)$m['password']))
        throw new ApiHttpException(403, 'Password saat ini salah', 'INVALID_PASSWORD');

    $fields = [];
    $args   = [];
    if (isset($p['name']))       { $fields[] = 'name=?';       $args[] = memberSanitizeName((string)$p['name']); }
    if (array_key_exists('gender', $p)) { $g = in_array($p['gender'], ['M', 'F', 'other'], true) ? $p['gender'] : null; $fields[] = 'gender=?'; $args[] = $g; }
    if (isset($p['birth_date'])) { $b = trim((string)$p['birth_date']); if ($b !== '' && !preg_match('/^\d{4}-\d{2}-\d{2}$/', $b)) $b = null; $fields[] = 'birth_date=?'; $args[] = $b ?: null; }
    if (isset($p['email'])) {
        $email = trim((string)$p['email']);
        if ($email !== '' && !filter_var($email, FILTER_VALIDATE_EMAIL)) throw new ApiHttpException(400, 'Email tidak valid', 'VALIDATION_FAILED');
        if ($email !== '') {
            $e = $pdo->prepare("SELECT id FROM members WHERE email=? AND id<>? LIMIT 1");
            $e->execute([$email, $id]);
            if ($e->fetch()) throw new ApiHttpException(409, 'Email sudah dipakai member lain', 'EMAIL_ALREADY_EXISTS');
        }
        $fields[] = 'email=?'; $args[] = $email ?: null;
    }
    if (!$fields) throw new ApiHttpException(400, 'Tidak ada perubahan', 'VALIDATION_FAILED');
    $args[] = $id;
    $pdo->prepare("UPDATE members SET " . implode(',', $fields) . " WHERE id=?")->execute($args);
    auditLog(null, 'member_update_profile', 'members', null, ['id' => $id], null);
    $r = $pdo->prepare("SELECT * FROM members WHERE id=?");
    $r->execute([$id]);
    return ['ok' => true, 'member' => memberPublicView($r->fetch(), true)];
}

function rpc_member_change_password(array $p): mixed {
    $m   = $p['_member'];
    $pdo = getDB();
    if (!password_verify((string)($p['old_password'] ?? ''), (string)$m['password']))
        throw new ApiHttpException(403, 'Password lama salah', 'INVALID_PASSWORD');
    $new = (string)($p['new_password'] ?? '');
    memberValidatePassword($new);
    $pdo->prepare("UPDATE members SET password=? WHERE id=?")->execute([password_hash($new, PASSWORD_BCRYPT), (int)$m['id']]);
    // invalidasi sesi lain
    $token = trim((string)($_SERVER['HTTP_X_MEMBER_SESSION_TOKEN'] ?? ''));
    $pdo->prepare("DELETE FROM member_sessions WHERE member_id=? AND token_hash<>?")->execute([(int)$m['id'], $token !== '' ? hash('sha256', $token) : '']);
    auditLog(null, 'member_change_password', 'members', null, ['id' => (int)$m['id']], null);
    return ['ok' => true];
}

function rpc_member_get_point_history(array $p): mixed {
    $m      = $p['_member'];
    $pdo    = getDB();
    $limit  = min(100, max(1, (int)($p['limit'] ?? 30)));
    $offset = max(0, (int)($p['offset'] ?? 0));
    $st = $pdo->prepare("SELECT id,movement_type,direction,points,balance_active_after,balance_pending_after,reason,transaction_id,reward_claim_id,created_at FROM member_point_ledger WHERE member_id=? ORDER BY id DESC LIMIT $limit OFFSET $offset");
    $st->execute([(int)$m['id']]);
    return $st->fetchAll();
}

function rpc_member_get_transaction_history(array $p): mixed {
    $m      = $p['_member'];
    $pdo    = getDB();
    $limit  = min(100, max(1, (int)($p['limit'] ?? 20)));
    $offset = max(0, (int)($p['offset'] ?? 0));
    $st = $pdo->prepare("SELECT id,branch_id,total,subtotal,discount_amount,points_awarded,status,payment_method,created_at FROM transactions WHERE member_id=? ORDER BY id DESC LIMIT $limit OFFSET $offset");
    $st->execute([(int)$m['id']]);
    $txs = $st->fetchAll();
    if ($txs) {
        $ids = array_column($txs, 'id');
        $in  = implode(',', array_fill(0, count($ids), '?'));
        $it  = $pdo->prepare("SELECT transaction_id,product_name,variant_name,quantity,price,subtotal FROM transaction_items WHERE transaction_id IN ($in)");
        $it->execute($ids);
        $byTx = [];
        foreach ($it->fetchAll() as $row) $byTx[(int)$row['transaction_id']][] = $row;
        foreach ($txs as &$t) $t['items'] = $byTx[(int)$t['id']] ?? [];
    }
    return $txs;
}

function rpc_member_list_rewards(array $p): mixed {
    $m   = $p['_member'];
    $pdo = getDB();
    memberActivateMaturedPending($pdo, (int)$m['id']);
    $bal = memberBalances($pdo, (int)$m['id']);
    $now = date('Y-m-d H:i:s');
    $st  = $pdo->query("SELECT * FROM member_rewards WHERE is_active=1 AND deleted_at IS NULL ORDER BY cost_point ASC");
    $out = [];
    foreach ($st->fetchAll() as $r) {
        $reason = null;
        $canClaim = true;
        if (!empty($r['valid_from']) && $r['valid_from'] > $now)   { $canClaim = false; $reason = 'Belum berlaku'; }
        if (!empty($r['valid_until']) && $r['valid_until'] < $now) { $canClaim = false; $reason = 'Sudah berakhir'; }
        if ($r['quota_total'] !== null && (int)$r['quota_used'] >= (int)$r['quota_total']) { $canClaim = false; $reason = 'Kuota habis'; }
        if ($bal['active'] < (int)$r['cost_point']) { $canClaim = false; $reason = 'Point belum cukup'; }
        $out[] = [
            'id' => (int)$r['id'], 'name' => $r['name'], 'description' => $r['description'],
            'image_url' => $r['image_url'], 'cost_point' => (int)$r['cost_point'],
            'reward_type' => $r['reward_type'], 'discount_value' => $r['discount_value'] !== null ? (float)$r['discount_value'] : null,
            'quota_total' => $r['quota_total'] !== null ? (int)$r['quota_total'] : null,
            'quota_used' => (int)$r['quota_used'], 'valid_until' => $r['valid_until'],
            'terms_and_conditions' => $r['terms_and_conditions'],
            'requires_admin_approval' => (int)$r['requires_admin_approval'],
            'can_claim' => $canClaim, 'reason_if_not' => $reason,
        ];
    }
    return $out;
}

function rpc_member_claim_reward(array $p): mixed {
    $pdo      = getDB();
    $m        = $p['_member'];
    $memberId = (int)$m['id'];
    $rewardId = (int)($p['reward_id'] ?? 0);
    if (!$rewardId) throw new ApiHttpException(400, 'reward_id wajib', 'VALIDATION_FAILED');
    $pdo->beginTransaction();
    try {
        memberActivateMaturedPending($pdo, $memberId); // pastikan point matang ikut terhitung
        $r = $pdo->prepare("SELECT * FROM member_rewards WHERE id=? AND deleted_at IS NULL FOR UPDATE");
        $r->execute([$rewardId]);
        $reward = $r->fetch();
        if (!$reward || (int)$reward['is_active'] !== 1) throw new ApiHttpException(404, 'Reward tidak tersedia', 'REWARD_NOT_FOUND');
        $now = date('Y-m-d H:i:s');
        if (!empty($reward['valid_from']) && $reward['valid_from'] > $now)   throw new ApiHttpException(400, 'Reward belum berlaku', 'REWARD_EXPIRED');
        if (!empty($reward['valid_until']) && $reward['valid_until'] < $now) throw new ApiHttpException(400, 'Reward sudah berakhir', 'REWARD_EXPIRED');
        if ($reward['quota_total'] !== null && (int)$reward['quota_used'] >= (int)$reward['quota_total']) throw new ApiHttpException(409, 'Kuota reward habis', 'REWARD_OUT_OF_STOCK');
        if ($reward['quota_per_member'] !== null) {
            $c = $pdo->prepare("SELECT COUNT(*) FROM member_reward_claims WHERE member_id=? AND reward_id=? AND status IN('redeemable','redeemed','pending_approval')");
            $c->execute([$memberId, $rewardId]);
            if ((int)$c->fetchColumn() >= (int)$reward['quota_per_member']) throw new ApiHttpException(409, 'Anda sudah mencapai batas klaim reward ini', 'QUOTA_PER_MEMBER');
        }
        $cost = (int)$reward['cost_point'];
        $bal  = memberBalances($pdo, $memberId);
        if ($bal['active'] < $cost) throw new ApiHttpException(400, 'Point tidak cukup', 'INSUFFICIENT_POINTS');

        $status   = (int)$reward['requires_admin_approval'] === 1 ? 'pending_approval' : 'redeemable';
        $code     = memberGenRedemptionCode($pdo);
        $validDays = (int)(memberGetSettings($pdo)['claim_validity_days'] ?? 30);
        $expires  = date('Y-m-d H:i:s', strtotime("+{$validDays} days"));
        $pdo->prepare("INSERT INTO member_reward_claims (member_id,reward_id,redemption_code,redemption_qr_token,cost_point,status,expires_at) VALUES (?,?,?,?,?,?,?)")
            ->execute([$memberId, $rewardId, $code, 'MBR-CLAIM-pending', $cost, $status, $expires]);
        $claimId = (int)$pdo->lastInsertId();
        $qrToken = 'MBR-CLAIM-' . $claimId . '.' . substr(hash_hmac('sha256', $claimId . '.' . $expires, (string)$m['qr_secret']), 0, 16);
        $pdo->prepare("UPDATE member_reward_claims SET redemption_qr_token=? WHERE id=?")->execute([$qrToken, $claimId]);

        // Reserve: potong point dari saldo aktif sekarang
        memberInsertLedger($pdo, [
            'member_id' => $memberId, 'reward_claim_id' => $claimId, 'movement_type' => 'redeem_reserve',
            'points' => $cost, 'reason' => 'Klaim reward: ' . $reward['name'],
            'source_table' => 'member_reward_claims', 'source_id' => (string)$claimId,
        ]);
        $pdo->prepare("UPDATE member_rewards SET quota_used=quota_used+1 WHERE id=?")->execute([$rewardId]);
        $pdo->commit();
        auditLog(null, 'member_claim_reward', 'member_reward_claims', null, ['claim_id' => $claimId, 'member_id' => $memberId, 'reward_id' => $rewardId, 'cost' => $cost], null);
        return [
            'ok' => true,
            'claim' => ['id' => $claimId, 'redemption_code' => $code, 'qr_token' => $qrToken, 'status' => $status, 'expires_at' => $expires, 'cost_point' => $cost, 'reward_name' => $reward['name']],
            'balance' => memberBalances($pdo, $memberId),
        ];
    } catch (Throwable $e) { $pdo->rollBack(); throw $e; }
}

function rpc_member_cancel_claim(array $p): mixed {
    $pdo      = getDB();
    $m        = $p['_member'];
    $memberId = (int)$m['id'];
    $claimId  = (int)($p['claim_id'] ?? 0);
    if (!$claimId) throw new ApiHttpException(400, 'claim_id wajib', 'VALIDATION_FAILED');
    $pdo->beginTransaction();
    try {
        $c = $pdo->prepare("SELECT * FROM member_reward_claims WHERE id=? AND member_id=? FOR UPDATE");
        $c->execute([$claimId, $memberId]);
        $claim = $c->fetch();
        if (!$claim) throw new ApiHttpException(404, 'Klaim tidak ditemukan', 'CLAIM_NOT_FOUND');
        if (!in_array($claim['status'], ['redeemable', 'pending_approval'], true)) throw new ApiHttpException(400, 'Klaim tidak bisa dibatalkan', 'CLAIM_NOT_CANCELLABLE');
        $pdo->prepare("UPDATE member_reward_claims SET status='cancelled', cancelled_at=NOW(), cancel_reason='Dibatalkan member' WHERE id=?")->execute([$claimId]);
        memberInsertLedger($pdo, [
            'member_id' => $memberId, 'reward_claim_id' => $claimId, 'movement_type' => 'redeem_refund',
            'points' => (int)$claim['cost_point'], 'reason' => 'Pembatalan klaim oleh member',
            'source_table' => 'member_reward_claims', 'source_id' => $claimId . ':cancel',
        ]);
        $pdo->prepare("UPDATE member_rewards SET quota_used=GREATEST(0,quota_used-1) WHERE id=?")->execute([(int)$claim['reward_id']]);
        $pdo->commit();
        auditLog(null, 'member_cancel_claim', 'member_reward_claims', null, ['claim_id' => $claimId], null);
        return ['ok' => true, 'points_refunded' => (int)$claim['cost_point'], 'balance' => memberBalances($pdo, $memberId)];
    } catch (Throwable $e) { $pdo->rollBack(); throw $e; }
}

function rpc_member_my_claims(array $p): mixed {
    $pdo = getDB();
    $m   = $p['_member'];
    $st  = $pdo->prepare("
        SELECT c.id,c.reward_id,c.redemption_code,c.redemption_qr_token,c.cost_point,c.status,
               c.claimed_at,c.expires_at,c.redeemed_at,r.name AS reward_name,r.reward_type,r.image_url
        FROM member_reward_claims c JOIN member_rewards r ON r.id=c.reward_id
        WHERE c.member_id=? ORDER BY c.id DESC LIMIT 100
    ");
    $st->execute([(int)$m['id']]);
    return $st->fetchAll();
}

// ══════════════════════════════════════════════════════════════════════════════
// RPC: Cashier workflow (staff/admin via X-Session-Token)
// ══════════════════════════════════════════════════════════════════════════════
function rpc_member_lookup(array $p): mixed {
    $pdo = getDB();
    if (!memberLoyaltyEnabled($pdo)) throw new ApiHttpException(400, 'Modul loyalty nonaktif', 'MODULE_DISABLED');
    $query = trim((string)($p['query'] ?? ''));
    if ($query === '') throw new ApiHttpException(400, 'Query wajib diisi', 'VALIDATION_FAILED');
    $st = $pdo->prepare("SELECT * FROM members WHERE (phone=? OR member_code=?) AND deleted_at IS NULL LIMIT 1");
    $st->execute([$query, strtoupper($query)]);
    $m = $st->fetch();
    if (!$m) throw new ApiHttpException(404, 'Member tidak ditemukan', 'MEMBER_NOT_FOUND');
    if ((int)$m['is_active'] !== 1) throw new ApiHttpException(403, 'Member nonaktif', 'MEMBER_INACTIVE');
    memberActivateMaturedPending($pdo, (int)$m['id']);
    $bal = memberBalances($pdo, (int)$m['id']);
    return ['member' => [
        'id' => (int)$m['id'], 'name' => $m['name'], 'member_code' => $m['member_code'],
        'phone_masked' => maskPhone((string)$m['phone']), 'balance_active' => $bal['active'], 'balance_pending' => $bal['pending'],
    ]];
}

function rpc_member_validate_qr(array $p): mixed {
    $pdo = getDB();
    if (!memberLoyaltyEnabled($pdo)) throw new ApiHttpException(400, 'Modul loyalty nonaktif', 'MODULE_DISABLED');
    $token = trim((string)($p['qr_token'] ?? ''));
    $member = $token !== '' ? memberValidateQrToken($pdo, $token) : null;
    if (!$member) throw new ApiHttpException(400, 'QR tidak valid atau member nonaktif', 'INVALID_QR_SIGNATURE');
    memberActivateMaturedPending($pdo, (int)$member['id']);
    $bal = memberBalances($pdo, (int)$member['id']);
    return ['ok' => true, 'member' => [
        'id' => (int)$member['id'], 'name' => $member['name'], 'member_code' => $member['member_code'],
        'phone_masked' => maskPhone((string)$member['phone']), 'balance_active' => $bal['active'], 'balance_pending' => $bal['pending'],
    ]];
}

function rpc_member_preview_points(array $p): mixed {
    $pdo      = getDB();
    $subtotal = (float)($p['subtotal'] ?? 0);
    $cart     = is_array($p['items'] ?? null) ? $p['items'] : (is_array($p['cart'] ?? null) ? $p['cart'] : []);
    $res = memberComputePreviewPoints($pdo, $subtotal, $cart);
    return ['points_to_earn' => $res['points'], 'eligible_subtotal' => $res['eligible'], 'reason_if_zero' => $res['points'] > 0 ? null : $res['reason']];
}

function rpc_member_redeem_at_cashier(array $p): mixed {
    $pdo      = getDB();
    $authUser = $p['_auth_user'] ?? null;
    if (!memberLoyaltyEnabled($pdo)) throw new ApiHttpException(400, 'Modul loyalty nonaktif', 'MODULE_DISABLED');
    $code     = strtoupper(trim((string)($p['redemption_code'] ?? '')));
    $qr       = trim((string)($p['qr_token'] ?? ''));
    $branchId = (int)($p['branch_id'] ?? ($authUser['branch_id'] ?? 0));
    $txId     = !empty($p['transaction_id']) ? (int)$p['transaction_id'] : null;
    if ($code === '' && $qr === '') throw new ApiHttpException(400, 'Kode redeem wajib diisi', 'VALIDATION_FAILED');
    if ($branchId) requireBranchAccess($authUser, $branchId);

    $pdo->beginTransaction();
    try {
        if ($code !== '') {
            $c = $pdo->prepare("SELECT * FROM member_reward_claims WHERE redemption_code=? FOR UPDATE");
            $c->execute([$code]);
        } else {
            $c = $pdo->prepare("SELECT * FROM member_reward_claims WHERE redemption_qr_token=? FOR UPDATE");
            $c->execute([$qr]);
        }
        $claim = $c->fetch();
        if (!$claim) throw new ApiHttpException(404, 'Kode klaim tidak ditemukan', 'CLAIM_NOT_FOUND');
        if ($claim['status'] === 'redeemed')  throw new ApiHttpException(409, 'Kode sudah dipakai', 'CLAIM_ALREADY_REDEEMED');
        if ($claim['status'] === 'pending_approval') throw new ApiHttpException(400, 'Klaim menunggu persetujuan admin', 'CLAIM_PENDING_APPROVAL');
        if ($claim['status'] !== 'redeemable') throw new ApiHttpException(400, 'Klaim tidak bisa di-redeem', 'CLAIM_NOT_REDEEMABLE');
        if ($claim['expires_at'] < date('Y-m-d H:i:s')) throw new ApiHttpException(400, 'Kode klaim kedaluwarsa', 'CLAIM_EXPIRED');

        $rw = $pdo->prepare("SELECT * FROM member_rewards WHERE id=?");
        $rw->execute([(int)$claim['reward_id']]);
        $reward = $rw->fetch();

        $pdo->prepare("UPDATE member_reward_claims SET status='redeemed', redeemed_at=NOW(), redeemed_by_user_id=?, redeemed_at_branch_id=?, transaction_id=? WHERE id=?")
            ->execute([$authUser['id'] ?? null, $branchId ?: null, $txId, (int)$claim['id']]);
        memberInsertLedger($pdo, [
            'member_id' => (int)$claim['member_id'], 'branch_id' => $branchId ?: null, 'reward_claim_id' => (int)$claim['id'],
            'transaction_id' => $txId, 'movement_type' => 'redeem_commit', 'points' => (int)$claim['cost_point'],
            'reason' => 'Redeem di kasir', 'source_table' => 'member_reward_claims', 'source_id' => $claim['id'] . ':commit',
            'created_by_user_id' => $authUser['id'] ?? null,
        ]);
        $pdo->prepare("UPDATE members SET lifetime_points_redeemed=lifetime_points_redeemed+? WHERE id=?")->execute([(int)$claim['cost_point'], (int)$claim['member_id']]);
        if ($txId) $pdo->prepare("UPDATE transactions SET reward_claim_id=? WHERE id=?")->execute([(int)$claim['id'], $txId]);
        $pdo->commit();
        auditLog($authUser, 'member_redeem', 'member_reward_claims', $claim, ['redeemed_by' => $authUser['id'] ?? null, 'tx' => $txId], $branchId ?: null);
        return [
            'ok' => true,
            'claim' => ['id' => (int)$claim['id'], 'status' => 'redeemed', 'cost_point' => (int)$claim['cost_point']],
            'reward' => [
                'id' => (int)$reward['id'], 'name' => $reward['name'], 'reward_type' => $reward['reward_type'],
                'reward_product_id' => $reward['reward_product_id'] ? (int)$reward['reward_product_id'] : null,
                'reward_variant_id' => $reward['reward_variant_id'] ? (int)$reward['reward_variant_id'] : null,
                'discount_value' => $reward['discount_value'] !== null ? (float)$reward['discount_value'] : null,
            ],
        ];
    } catch (Throwable $e) { $pdo->rollBack(); throw $e; }
}

function rpc_member_unattach_from_transaction(array $p): mixed {
    $pdo      = getDB();
    $authUser = $p['_auth_user'] ?? null;
    $txId     = (int)($p['transaction_id'] ?? 0);
    $reason   = trim((string)($p['reason'] ?? ''));
    if (!$txId) throw new ApiHttpException(400, 'transaction_id wajib', 'VALIDATION_FAILED');
    if (mb_strlen($reason) < 5) throw new ApiHttpException(400, 'Alasan minimal 5 karakter', 'VALIDATION_FAILED');
    $S = memberGetSettings($pdo);
    $windowMin = (int)($S['member_late_attach_window_minutes'] ?? 5);
    $pdo->beginTransaction();
    try {
        $tx = $pdo->prepare("SELECT * FROM transactions WHERE id=? FOR UPDATE");
        $tx->execute([$txId]);
        $t = $tx->fetch();
        if (!$t || empty($t['member_id'])) throw new ApiHttpException(404, 'Transaksi tanpa member', 'NOT_FOUND');
        if ($authUser) requireBranchAccess($authUser, (int)$t['branch_id']);
        if (!isAdminUser($authUser ?? []) && strtotime((string)$t['created_at']) < time() - $windowMin * 60)
            throw new ApiHttpException(400, 'Window lepas member sudah lewat. Hubungi admin.', 'LATE_ATTACH_WINDOW_EXPIRED');
        memberReverseTransactionPoints($pdo, $t, null, $authUser['id'] ?? null, 'unattach: ' . $reason);
        $pdo->prepare("UPDATE transactions SET member_id=NULL, member_attached_at=NULL, points_awarded=0 WHERE id=?")->execute([$txId]);
        memberInsertFraudFlag($pdo, ['member_id' => (int)$t['member_id'], 'staff_user_id' => $authUser['id'] ?? null, 'transaction_id' => $txId, 'flag_type' => 'late_attach', 'severity' => 'medium', 'risk_score' => 50, 'evidence' => ['reason' => $reason]]);
        $pdo->commit();
        auditLog($authUser, 'member_unattach_tx', 'transactions', $t, ['reason' => $reason], (int)$t['branch_id']);
        return ['ok' => true];
    } catch (Throwable $e) { $pdo->rollBack(); throw $e; }
}

// ══════════════════════════════════════════════════════════════════════════════
// RPC: Admin management (admin/owner)
// ══════════════════════════════════════════════════════════════════════════════
function rpc_member_admin_search(array $p): mixed {
    $pdo    = getDB();
    $q      = trim((string)($p['query'] ?? ''));
    $limit  = min(200, max(1, (int)($p['limit'] ?? 50)));
    $offset = max(0, (int)($p['offset'] ?? 0));
    $where  = ['m.deleted_at IS NULL'];
    $args   = [];
    if ($q !== '') {
        $where[] = '(m.name LIKE ? OR m.phone LIKE ? OR m.member_code LIKE ? OR m.email LIKE ?)';
        $like = "%$q%";
        array_push($args, $like, $like, $like, $like);
    }
    if (isset($p['is_active']) && $p['is_active'] !== '' && $p['is_active'] !== null) {
        $where[] = 'm.is_active=?';
        $args[]  = ((int)$p['is_active'] ? 1 : 0);
    }
    $sort = in_array($p['sort'] ?? '', ['created_at', 'name', 'last_transaction_at', 'lifetime_points_earned'], true) ? $p['sort'] : 'created_at';
    $wsql = implode(' AND ', $where);
    $sql  = "SELECT m.id,m.member_code,m.name,m.phone,m.email,m.is_active,m.last_transaction_at,m.created_at,
                    m.lifetime_points_earned,m.lifetime_points_redeemed,m.staff_link_user_id,
                    (SELECT balance_active_after FROM member_point_ledger l WHERE l.member_id=m.id ORDER BY l.id DESC LIMIT 1) AS point_active
             FROM members m WHERE $wsql ORDER BY m.$sort DESC LIMIT $limit OFFSET $offset";
    $st = $pdo->prepare($sql);
    $st->execute($args);
    $rows = $st->fetchAll();
    foreach ($rows as &$r) { $r['point_active'] = (int)($r['point_active'] ?? 0); }
    return $rows;
}

function rpc_member_admin_get_detail(array $p): mixed {
    $pdo = getDB();
    $id  = (int)($p['member_id'] ?? 0);
    if (!$id) throw new ApiHttpException(400, 'member_id wajib', 'VALIDATION_FAILED');
    $m = $pdo->prepare("SELECT * FROM members WHERE id=?");
    $m->execute([$id]);
    $member = $m->fetch();
    if (!$member) throw new ApiHttpException(404, 'Member tidak ditemukan', 'MEMBER_NOT_FOUND');
    $bal = memberBalances($pdo, $id);
    $tx  = $pdo->prepare("SELECT id,branch_id,total,points_awarded,status,created_at FROM transactions WHERE member_id=? ORDER BY id DESC LIMIT 20");
    $tx->execute([$id]);
    $led = $pdo->prepare("SELECT id,movement_type,direction,points,balance_active_after,reason,transaction_id,created_at FROM member_point_ledger WHERE member_id=? ORDER BY id DESC LIMIT 30");
    $led->execute([$id]);
    $fl = $pdo->prepare("SELECT id,flag_type,severity,risk_score,status,detected_at FROM member_fraud_flags WHERE member_id=? ORDER BY id DESC LIMIT 20");
    $fl->execute([$id]);
    $cl = $pdo->prepare("SELECT c.id,c.cost_point,c.status,c.claimed_at,c.redeemed_at,r.name AS reward_name FROM member_reward_claims c JOIN member_rewards r ON r.id=c.reward_id WHERE c.member_id=? ORDER BY c.id DESC LIMIT 20");
    $cl->execute([$id]);
    unset($member['password'], $member['qr_secret']);
    $member['balance'] = ['active' => $bal['active'], 'pending' => $bal['pending'], 'reserved' => memberReservedPoints($pdo, $id)];
    return [
        'member' => $member, 'recent_tx' => $tx->fetchAll(), 'recent_ledger' => $led->fetchAll(),
        'flags' => $fl->fetchAll(), 'claims' => $cl->fetchAll(),
    ];
}

function rpc_member_admin_set_active(array $p): mixed {
    $pdo    = getDB();
    $admin  = $p['_auth_user'];
    $id     = (int)($p['member_id'] ?? 0);
    $active = (int)((int)($p['is_active'] ?? 0) ? 1 : 0);
    $reason = trim((string)($p['reason'] ?? ''));
    if (!$id) throw new ApiHttpException(400, 'member_id wajib', 'VALIDATION_FAILED');
    $pdo->prepare("UPDATE members SET is_active=? WHERE id=?")->execute([$active, $id]);
    if (!$active) $pdo->prepare("DELETE FROM member_sessions WHERE member_id=?")->execute([$id]);
    auditLog($admin, 'member_set_active', 'members', null, ['member_id' => $id, 'is_active' => $active, 'reason' => $reason], null);
    return ['ok' => true];
}

function rpc_member_admin_set_staff_link(array $p): mixed {
    $pdo   = getDB();
    $admin = $p['_auth_user'];
    $id    = (int)($p['member_id'] ?? 0);
    $staff = !empty($p['staff_user_id']) ? (int)$p['staff_user_id'] : null;
    if (!$id) throw new ApiHttpException(400, 'member_id wajib', 'VALIDATION_FAILED');
    $pdo->prepare("UPDATE members SET staff_link_user_id=? WHERE id=?")->execute([$staff, $id]);
    auditLog($admin, 'member_set_staff_link', 'members', null, ['member_id' => $id, 'staff_user_id' => $staff], null);
    return ['ok' => true];
}

function rpc_member_admin_manual_adjust(array $p): mixed {
    $pdo    = getDB();
    $admin  = $p['_auth_user'];
    $id     = (int)($p['member_id'] ?? 0);
    $dir    = $p['direction'] ?? '';
    $points = (int)($p['points'] ?? 0);
    $reason = trim((string)($p['reason'] ?? ''));
    if (!$id || !in_array($dir, ['in', 'out'], true) || $points <= 0) throw new ApiHttpException(400, 'Parameter adjust tidak valid', 'VALIDATION_FAILED');
    if (mb_strlen($reason) < 10) throw new ApiHttpException(400, 'Alasan wajib diisi minimal 10 karakter', 'VALIDATION_FAILED');
    $pdo->beginTransaction();
    try {
        if ($dir === 'out') {
            $bal = memberBalances($pdo, $id);
            if ($bal['active'] < $points) throw new ApiHttpException(400, 'Saldo tidak cukup untuk pengurangan', 'INSUFFICIENT_POINTS');
        }
        $mv  = $dir === 'in' ? 'manual_adjust_in' : 'manual_adjust_out';
        $led = memberInsertLedger($pdo, ['member_id' => $id, 'movement_type' => $mv, 'points' => $points, 'reason' => $reason, 'created_by_user_id' => (int)$admin['id']]);
        if ($dir === 'in') $pdo->prepare("UPDATE members SET lifetime_points_earned=lifetime_points_earned+? WHERE id=?")->execute([$points, $id]);
        $pdo->commit();
        auditLog($admin, 'member_manual_adjust', 'member_point_ledger', null, ['member_id' => $id, 'direction' => $dir, 'points' => $points, 'reason' => $reason], null);
        if ($points > 100) memberInsertFraudFlag($pdo, ['member_id' => $id, 'staff_user_id' => (int)$admin['id'], 'flag_type' => 'large_manual_adjust', 'severity' => 'high', 'risk_score' => 72, 'evidence' => ['points' => $points, 'direction' => $dir]]);
        return ['ok' => true, 'ledger_entry' => $led];
    } catch (Throwable $e) { $pdo->rollBack(); throw $e; }
}

function rpc_member_admin_lock_points(array $p): mixed {
    $pdo    = getDB();
    $admin  = $p['_auth_user'];
    $id     = (int)($p['member_id'] ?? 0);
    $points = (int)($p['points'] ?? 0);
    $reason = trim((string)($p['reason'] ?? ''));
    if (!$id || $points <= 0 || mb_strlen($reason) < 5) throw new ApiHttpException(400, 'Parameter lock tidak valid', 'VALIDATION_FAILED');
    $pdo->beginTransaction();
    try {
        $bal = memberBalances($pdo, $id);
        $points = min($points, $bal['active']);
        if ($points <= 0) throw new ApiHttpException(400, 'Tidak ada saldo aktif untuk dikunci', 'INSUFFICIENT_POINTS');
        $led = memberInsertLedger($pdo, ['member_id' => $id, 'movement_type' => 'fraud_lock', 'points' => $points, 'reason' => $reason, 'created_by_user_id' => (int)$admin['id']]);
        $pdo->commit();
        auditLog($admin, 'member_lock_points', 'member_point_ledger', null, ['member_id' => $id, 'points' => $points, 'reason' => $reason], null);
        return ['ok' => true, 'ledger_entry' => $led];
    } catch (Throwable $e) { $pdo->rollBack(); throw $e; }
}

function rpc_member_admin_unlock_points(array $p): mixed {
    $pdo    = getDB();
    $admin  = $p['_auth_user'];
    $id     = (int)($p['member_id'] ?? 0);
    $points = (int)($p['points'] ?? 0);
    $reason = trim((string)($p['reason'] ?? ''));
    if (!$id || $points <= 0 || mb_strlen($reason) < 5) throw new ApiHttpException(400, 'Parameter unlock tidak valid', 'VALIDATION_FAILED');
    $pdo->beginTransaction();
    try {
        $led = memberInsertLedger($pdo, ['member_id' => $id, 'movement_type' => 'fraud_unlock', 'points' => $points, 'reason' => $reason, 'created_by_user_id' => (int)$admin['id']]);
        $pdo->commit();
        auditLog($admin, 'member_unlock_points', 'member_point_ledger', null, ['member_id' => $id, 'points' => $points, 'reason' => $reason], null);
        return ['ok' => true, 'ledger_entry' => $led];
    } catch (Throwable $e) { $pdo->rollBack(); throw $e; }
}

function rpc_member_admin_reset_password(array $p): mixed {
    $pdo   = getDB();
    $admin = $p['_auth_user'];
    $id    = (int)($p['member_id'] ?? 0);
    if (!$id) throw new ApiHttpException(400, 'member_id wajib', 'VALIDATION_FAILED');
    $temp  = 'RBN' . random_int(1000, 9999) . substr(strtoupper(bin2hex(random_bytes(2))), 0, 3);
    $pdo->prepare("UPDATE members SET password=? WHERE id=?")->execute([password_hash($temp, PASSWORD_BCRYPT), $id]);
    $pdo->prepare("DELETE FROM member_sessions WHERE member_id=?")->execute([$id]);
    auditLog($admin, 'member_reset_password', 'members', null, ['member_id' => $id], null);
    return ['ok' => true, 'temp_password' => $temp];
}

function rpc_member_admin_void_claim(array $p): mixed {
    $pdo    = getDB();
    $admin  = $p['_auth_user'];
    $cid    = (int)($p['claim_id'] ?? 0);
    $reason = trim((string)($p['reason'] ?? ''));
    if (!$cid || mb_strlen($reason) < 5) throw new ApiHttpException(400, 'Parameter void tidak valid', 'VALIDATION_FAILED');
    $pdo->beginTransaction();
    try {
        $c = $pdo->prepare("SELECT * FROM member_reward_claims WHERE id=? FOR UPDATE");
        $c->execute([$cid]);
        $claim = $c->fetch();
        if (!$claim) throw new ApiHttpException(404, 'Klaim tidak ditemukan', 'CLAIM_NOT_FOUND');
        if (!in_array($claim['status'], ['redeemable', 'pending_approval'], true)) throw new ApiHttpException(400, 'Klaim tidak bisa di-void', 'CLAIM_NOT_VOIDABLE');
        $pdo->prepare("UPDATE member_reward_claims SET status='cancelled', cancelled_at=NOW(), cancel_reason=? WHERE id=?")->execute([$reason, $cid]);
        memberInsertLedger($pdo, ['member_id' => (int)$claim['member_id'], 'reward_claim_id' => $cid, 'movement_type' => 'redeem_refund', 'points' => (int)$claim['cost_point'], 'reason' => 'Void klaim oleh admin: ' . $reason, 'source_table' => 'member_reward_claims', 'source_id' => $cid . ':void', 'created_by_user_id' => (int)$admin['id']]);
        $pdo->prepare("UPDATE member_rewards SET quota_used=GREATEST(0,quota_used-1) WHERE id=?")->execute([(int)$claim['reward_id']]);
        $pdo->commit();
        auditLog($admin, 'member_void_claim', 'member_reward_claims', $claim, ['reason' => $reason], null);
        return ['ok' => true];
    } catch (Throwable $e) { $pdo->rollBack(); throw $e; }
}

function rpc_member_admin_approve_claim(array $p): mixed {
    $pdo   = getDB();
    $admin = $p['_auth_user'];
    $cid   = (int)($p['claim_id'] ?? 0);
    if (!$cid) throw new ApiHttpException(400, 'claim_id wajib', 'VALIDATION_FAILED');
    $c = $pdo->prepare("SELECT * FROM member_reward_claims WHERE id=? LIMIT 1");
    $c->execute([$cid]);
    $claim = $c->fetch();
    if (!$claim) throw new ApiHttpException(404, 'Klaim tidak ditemukan', 'CLAIM_NOT_FOUND');
    if ($claim['status'] !== 'pending_approval') throw new ApiHttpException(400, 'Klaim tidak menunggu approval', 'CLAIM_NOT_PENDING');
    $pdo->prepare("UPDATE member_reward_claims SET status='redeemable', approved_at=NOW(), approved_by_user_id=? WHERE id=?")->execute([(int)$admin['id'], $cid]);
    auditLog($admin, 'member_approve_claim', 'member_reward_claims', null, ['claim_id' => $cid], null);
    return ['ok' => true];
}

function rpc_member_admin_create(array $p): mixed {
    // Admin daftarkan member walk-in. Password default = HP (member ganti nanti).
    $pdo   = getDB();
    $admin = $p['_auth_user'];
    $phone = memberValidatePhone((string)($p['phone'] ?? ''));
    $name  = memberSanitizeName((string)($p['name'] ?? ''));
    $email = trim((string)($p['email'] ?? ''));
    if ($email !== '' && !filter_var($email, FILTER_VALIDATE_EMAIL)) throw new ApiHttpException(400, 'Email tidak valid', 'VALIDATION_FAILED');
    $chk = $pdo->prepare("SELECT id FROM members WHERE phone=? LIMIT 1");
    $chk->execute([$phone]);
    if ($chk->fetch()) throw new ApiHttpException(409, 'Nomor HP sudah terdaftar', 'PHONE_ALREADY_EXISTS');
    $temp   = (string)($p['password'] ?? $phone);
    if (strlen($temp) < 8) $temp = $phone; // HP indonesia >= 10 digit
    $code   = memberGenCode($pdo);
    $secret = bin2hex(random_bytes(32));
    $branchId = !empty($p['signup_branch_id']) ? (int)$p['signup_branch_id'] : ($admin['branch_id'] ?? null);
    $pdo->prepare("INSERT INTO members (member_code,name,phone,email,password,qr_secret,signup_branch_id) VALUES (?,?,?,?,?,?,?)")
        ->execute([$code, $name, $phone, $email ?: null, password_hash($temp, PASSWORD_BCRYPT), $secret, $branchId]);
    $id = (int)$pdo->lastInsertId();
    auditLog($admin, 'member_admin_create', 'members', null, ['id' => $id, 'member_code' => $code], $branchId);
    return ['ok' => true, 'member_id' => $id, 'member_code' => $code, 'temp_password' => $temp];
}

function rpc_member_dashboard_stats(array $p): mixed {
    $pdo = getDB();
    $totalMembers = (int)$pdo->query("SELECT COUNT(*) FROM members WHERE deleted_at IS NULL")->fetchColumn();
    $activeMonth  = (int)$pdo->query("SELECT COUNT(*) FROM members WHERE deleted_at IS NULL AND last_transaction_at >= DATE_FORMAT(NOW(),'%Y-%m-01')")->fetchColumn();
    $pointsOut    = (int)$pdo->query("SELECT COALESCE(SUM(balance_active_after),0) FROM (SELECT member_id, MAX(id) AS mid FROM member_point_ledger GROUP BY member_id) t JOIN member_point_ledger l ON l.id=t.mid")->fetchColumn();
    $redeemedMonth = (int)$pdo->query("SELECT COALESCE(SUM(points),0) FROM member_point_ledger WHERE movement_type='redeem_commit' AND created_at >= DATE_FORMAT(NOW(),'%Y-%m-01')")->fetchColumn();
    $newWeek = $pdo->query("SELECT DATE(created_at) AS d, COUNT(*) AS c FROM members WHERE created_at >= DATE_SUB(NOW(),INTERVAL 8 WEEK) GROUP BY DATE(created_at) ORDER BY d")->fetchAll();
    $topMembers = $pdo->query("SELECT m.id,m.name,m.member_code,(SELECT balance_active_after FROM member_point_ledger l WHERE l.member_id=m.id ORDER BY l.id DESC LIMIT 1) AS point_active FROM members m WHERE m.deleted_at IS NULL ORDER BY point_active DESC LIMIT 10")->fetchAll();
    $topRewards = $pdo->query("SELECT r.id,r.name,COUNT(c.id) AS claims FROM member_reward_claims c JOIN member_rewards r ON r.id=c.reward_id WHERE c.status='redeemed' GROUP BY r.id ORDER BY claims DESC LIMIT 5")->fetchAll();
    foreach ($topMembers as &$tm) $tm['point_active'] = (int)($tm['point_active'] ?? 0);
    return [
        'total_members' => $totalMembers, 'active_this_month' => $activeMonth,
        'total_points_outstanding' => $pointsOut, 'points_redeemed_this_month' => $redeemedMonth,
        'new_members_weekly' => $newWeek, 'top_members' => $topMembers, 'top_rewards' => $topRewards,
    ];
}

function rpc_member_fraud_dashboard(array $p): mixed {
    $pdo      = getDB();
    $where    = ['1=1'];
    $args     = [];
    if (!empty($p['severity'])) { $where[] = 'severity=?'; $args[] = $p['severity']; }
    if (!empty($p['status']))   { $where[] = 'status=?';   $args[] = $p['status']; }
    $wsql = implode(' AND ', $where);
    $st = $pdo->prepare("
        SELECT f.*, m.name AS member_name, m.member_code, u.name AS staff_name
        FROM member_fraud_flags f
        LEFT JOIN members m ON m.id=f.member_id
        LEFT JOIN users u ON u.id=f.staff_user_id
        WHERE $wsql ORDER BY f.detected_at DESC LIMIT 200
    ");
    $st->execute($args);
    $summary = $pdo->query("SELECT
        SUM(status='open') AS open_count,
        SUM(severity='critical' AND status='open') AS critical_open,
        SUM(severity='high' AND status='open') AS high_open,
        COUNT(*) AS total
        FROM member_fraud_flags")->fetch();
    return ['summary' => $summary, 'flags' => $st->fetchAll()];
}

function rpc_member_fraud_resolve(array $p): mixed {
    $pdo    = getDB();
    $admin  = $p['_auth_user'];
    $fid    = (int)($p['flag_id'] ?? 0);
    $status = $p['status'] ?? '';
    $note   = trim((string)($p['resolution_note'] ?? ''));
    if (!$fid || !in_array($status, ['acknowledged', 'dismissed', 'action_taken'], true)) throw new ApiHttpException(400, 'Parameter resolve tidak valid', 'VALIDATION_FAILED');
    $pdo->prepare("UPDATE member_fraud_flags SET status=?, reviewed_by_user_id=?, reviewed_at=NOW(), resolution_note=? WHERE id=?")
        ->execute([$status, (int)$admin['id'], $note, $fid]);
    auditLog($admin, 'member_fraud_resolve', 'member_fraud_flags', null, ['flag_id' => $fid, 'status' => $status], null);
    return ['ok' => true];
}
