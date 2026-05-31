<?php
// ══════════════════════════════════════════════════════════════════════════════
// api.php — RBN POS REST API untuk cPanel/MySQL
// ══════════════════════════════════════════════════════════════════════════════
declare(strict_types=1);

// Tangkap semua output stray (PHP notices/warnings) agar tidak merusak JSON
ob_start();

require_once __DIR__ . '/config.php';

// Handler error global — semua PHP error → JSON
set_exception_handler(function(Throwable $e) {
    ob_clean();
    http_response_code(500);
    header('Content-Type: application/json; charset=utf-8');
    echo json_encode(['error' => ['message' => $e->getMessage(), 'code' => '500', 'file' => basename($e->getFile()), 'line' => $e->getLine()]]);
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
header('Access-Control-Allow-Headers: Content-Type, X-API-Key, Authorization');
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
$body    = json_decode(file_get_contents('php://input'), true) ?? [];
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
    'cash_session_adjustments','branch_ingredient_assignments',
];
if (!in_array($table, $allowedTables, true)) {
    respond(400, ['error' => ['message' => "Tabel '$table' tidak diizinkan"]]);
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
        respond(500, ['error' => ['message' => $e->getMessage(), 'code' => 'DB_ERROR']]);
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
        respond(500, ['error' => ['message' => $e->getMessage(), 'code' => 'DB_ERROR']]);
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
        respond(500, ['error' => ['message' => $e->getMessage(), 'code' => 'DB_ERROR']]);
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
        respond(500, ['error' => ['message' => $e->getMessage(), 'code' => 'DB_ERROR']]);
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
        respond(500, ['error' => ['message' => $e->getMessage(), 'code' => 'DB_ERROR']]);
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

function handleRpc(string $name, array $params): void {
    $fn = 'rpc_' . $name;
    if (!function_exists($fn)) {
        respond(404, ['error' => ['message' => "RPC '$name' tidak ditemukan", 'code' => 'PGRST202']]);
    }
    try {
        $result = $fn($params);
        respond(200, $result);
    } catch (Throwable $e) {
        respond(400, ['error' => ['message' => $e->getMessage(), 'code' => 'P0001']]);
    }
}

// ── pos_login ─────────────────────────────────────────────────────────────────
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
        $clientTxId    = $p['p_client_tx_id']   ?? null;

        if (!is_array($cart) || !$cart || !$branchId || !$staffId || !$paymentMethod)
            throw new Exception('Parameter transaksi tidak lengkap');
        if ($discountAmount < 0 || $taxAmount < 0 || $feeAmount < 0 || $paymentAmount < 0) {
            throw new Exception('Nominal transaksi tidak boleh negatif');
        }

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

        // Calculate totals and normalize cart keys from both frontend styles.
        $subtotal = 0;
        $normalizedCart = [];
        foreach ($cart as $item) {
            if (!is_array($item)) throw new Exception('Item transaksi tidak valid');
            $qty   = (int)($item['quantity'] ?? 1);
            $price = (float)($item['price'] ?? 0);
            if ($qty <= 0) throw new Exception('Qty item transaksi harus lebih dari 0');
            if ($price < 0) throw new Exception('Harga item transaksi tidak boleh negatif');

            $row = [
                'product_id'   => $item['product_id']   ?? $item['productId']   ?? null,
                'variant_id'   => $item['variant_id']   ?? $item['variantId']   ?? null,
                'product_name' => $item['product_name'] ?? $item['productName'] ?? null,
                'variant_name' => $item['variant_name'] ?? $item['variantName'] ?? null,
                'quantity'     => $qty,
                'price'        => $price,
            ];
            $normalizedCart[] = $row;
            $subtotal += $price * $qty;
        }
        $cart = $normalizedCart;
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

        // Insert transaction
        $stmt = $pdo->prepare("
            INSERT INTO transactions
              (branch_id,staff_id,session_id,payment_method,payment_amount,
               subtotal,discount_amount,tax_amount,fee_amount,total,change_amount,
               notes,status,client_tx_id)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?,'completed',?)
        ");
        $stmt->execute([
            $branchId,$staffId,$sessionId,$paymentMethod,$paymentAmount,
            $subtotal,$discountAmount,$taxAmount,$feeAmount,$total,$changeAmount,
            $notes,$clientTxId
        ]);
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

        $pdo->commit();
        return [
            'id'              => $txId,
            'subtotal'        => $subtotal,
            'discount_amount' => $discountAmount,
            'tax_amount'      => $taxAmount,
            'fee_amount'      => $feeAmount,
            'total'           => $total,
            'change_amount'   => $changeAmount,
            'status'          => 'completed',
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

// ── open_cash_session_from_branch_balance ─────────────────────────────────────
function rpc_open_cash_session_from_branch_balance(array $p): mixed {
    $pdo       = getDB();
    $branchId  = (int)($p['p_branch_id']     ?? 0);
    $staffId   = (int)($p['p_staff_id']      ?? 0);
    $physCash  = isset($p['p_physical_cash']) ? (float)$p['p_physical_cash'] : null;
    $varReason = $p['p_variance_reason'] ?? null;

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

    return array_map(function($row) use ($depsBySession, $hasAnyPending) {
        $sid = $row['id'];
        $dep = $depsBySession[$sid] ?? ['pending' => 0.0, 'confirmed' => 0.0, 'lastStatus' => null];
        $totalDep  = $dep['pending'] + $dep['confirmed'];
        $baseCash  = (float)$row['base_cash'];
        $depositable = max(0.0, $baseCash - $totalDep);

        $blockReason = null;
        if ($totalDep > 0 && $dep['lastStatus'] === 'pending') {
            $blockReason = 'Setoran sedang menunggu konfirmasi';
        } elseif ($totalDep > 0 && $dep['lastStatus'] === 'confirmed') {
            $blockReason = 'Setoran shift ini sudah selesai';
        } elseif ($hasAnyPending && $dep['pending'] == 0) {
            $blockReason = 'Masih ada setoran dari shift lain yang menunggu konfirmasi';
        }

        $row['depositable_cash']    = $depositable;
        $row['has_active_deposit']  = $totalDep > 0;
        $row['last_deposit_status'] = $dep['lastStatus'];
        $row['block_reason']        = $blockReason;
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
    if (!$reason) throw new Exception('Alasan void wajib diisi');

    $pdo->beginTransaction();
    try {
        $tx = $pdo->prepare("SELECT * FROM transactions WHERE id=? FOR UPDATE");
        $tx->execute([$txId]);
        $t = $tx->fetch();
        if (!$t || $t['status'] !== 'completed') throw new Exception('Transaksi tidak ditemukan atau sudah divoid');

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

        $pdo->commit();
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
