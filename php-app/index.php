<?php
/**
 * Front controller for Cerviz Back Office on shared hosting.
 *
 * .htaccess sends every request that is not an existing file here. /api/* is
 * dispatched below; anything else gets the single-page application shell. On
 * first run, before data/config.php exists, every page is the installer.
 */

declare(strict_types=1);

error_reporting(E_ALL);
ini_set('display_errors', '0'); // errors become JSON below, never HTML dumps

// Never serve the application's internals or the data directory, whatever the
// server. On Apache/LiteSpeed the .htaccess enforces the same rule; this is the
// second wall so a misconfigured host cannot expose the database.
$requestPath = parse_url($_SERVER['REQUEST_URI'] ?? '/', PHP_URL_PATH) ?? '/';
if (preg_match('#^/(data|app|migrations)(/|$)#', $requestPath)) {
    http_response_code(403);
    exit('Forbidden');
}

// PHP's built-in dev server: serve real files directly.
if (PHP_SAPI === 'cli-server') {
    $file = __DIR__ . $requestPath;
    if ($file !== __DIR__ . '/' && is_file($file)) return false;
}

require __DIR__ . '/app/helpers.php';
require __DIR__ . '/app/db.php';
require __DIR__ . '/app/audit.php';
require __DIR__ . '/app/crypto.php';
require __DIR__ . '/app/totp.php';
require __DIR__ . '/app/permissions.php';
require __DIR__ . '/app/accounts.php';
require __DIR__ . '/app/services/core.php';
require __DIR__ . '/app/services/ops.php';
require __DIR__ . '/app/services/money.php';
require __DIR__ . '/app/services/records.php';
require __DIR__ . '/app/services/render.php';
require __DIR__ . '/app/rpc.php';

const COOKIE_NAME = 'cerviz_session';
const CSRF_COOKIE = 'cerviz_csrf';

$DATA_DIR = getenv('CERVIZ_DATA_DIR') ?: __DIR__ . '/data';
$CONFIG_FILE = "$DATA_DIR/config.php";

$path = parse_url($_SERVER['REQUEST_URI'], PHP_URL_PATH) ?? '/';
$method = $_SERVER['REQUEST_METHOD'];
$isHttps = (!empty($_SERVER['HTTPS']) && $_SERVER['HTTPS'] !== 'off')
    || (($_SERVER['HTTP_X_FORWARDED_PROTO'] ?? '') === 'https');

// ---------------------------------------------------------------------------
// Responses and headers
// ---------------------------------------------------------------------------

function send_json(mixed $body, int $status = 200): never {
    http_response_code($status);
    header('Content-Type: application/json; charset=utf-8');
    echo json_encode($body, JSON_UNESCAPED_UNICODE | JSON_INVALID_UTF8_SUBSTITUTE);
    exit;
}

function ok(mixed $data): never { send_json(['ok' => true, 'data' => $data]); }
function fail(string $error, int $status = 400, array $extra = []): never {
    send_json(['ok' => false, 'error' => $error] + $extra, $status);
}

function read_json_body(): array {
    $raw = file_get_contents('php://input');
    if ($raw === '' || $raw === false) return [];
    $decoded = json_decode($raw, true);
    if (!is_array($decoded)) fail('The request body is not valid JSON.');
    return $decoded;
}

header('X-Content-Type-Options: nosniff');
header('X-Frame-Options: DENY');
header('Referrer-Policy: same-origin');
header('Permissions-Policy: geolocation=(), microphone=(), camera=()');
if ($isHttps) header('Strict-Transport-Security: max-age=31536000; includeSubDomains');
$isDocumentRoute = str_contains($path, '/document') || str_contains($path, '/enquiry-pack');
header('Content-Security-Policy: ' . ($isDocumentRoute
    ? "default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:"
    : "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; "
      . "img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'"));
if (!str_starts_with($path, '/assets/')) header('Cache-Control: no-store');

// ---------------------------------------------------------------------------
// First-run installer
// ---------------------------------------------------------------------------

if (!is_file($CONFIG_FILE)) {
    if ($path === '/api/setup' && $method === 'POST') {
        run_installer($DATA_DIR, $CONFIG_FILE);
    }
    if (str_starts_with($path, '/api/')) fail('The application has not been set up yet.', 503);
    render_installer_page();
}

require $CONFIG_FILE; // defines APP_SECRET and CERVIZ_DB_FILE

function run_installer(string $dataDir, string $configFile): never {
    $p = read_json_body();
    $email = strtolower(trim($p['email'] ?? ''));
    $name = trim($p['name'] ?? '');
    $password = (string) ($p['password'] ?? '');

    if (!preg_match('/^[^@\s]+@[^@\s]+\.[^@\s]+$/', $email)) fail('Enter a valid email address.');
    if ($name === '') fail('Enter your name.');
    if (mb_strlen($password) < 12) fail('Choose a password of at least 12 characters.');

    if (!is_dir($dataDir) && !mkdir($dataDir, 0750, true)) {
        fail('Cannot create the data directory. Check that PHP can write to the application folder.', 500);
    }

    // Belt and braces: deny web access to the data directory even though the
    // application-level .htaccess already refuses it, and give the database
    // file an unguessable name in case both somehow fail.
    file_put_contents("$dataDir/.htaccess",
        "Require all denied\n<IfModule !mod_authz_core.c>\nDeny from all\n</IfModule>\n");
    file_put_contents("$dataDir/index.html", '');

    $dbFile = "$dataDir/cerviz-" . bin2hex(random_bytes(8)) . '.sqlite';
    $secret = rtrim(strtr(base64_encode(random_bytes(48)), '+/', '-_'), '=');

    $config = "<?php\n"
        . "// Generated by the installer. Keep this file private and BACK IT UP:\n"
        . "// APP_SECRET encrypts every user's two-factor secret. Losing it means\n"
        . "// everyone re-enrols their authenticator app.\n"
        . "const APP_SECRET = '" . $secret . "';\n"
        . "const CERVIZ_DB_FILE = '" . str_replace("'", '', basename($dbFile)) . "';\n";
    if (file_put_contents($configFile, $config) === false) {
        fail('Cannot write the configuration file.', 500);
    }

    require $configFile;
    $db = open_database("$dataDir/" . CERVIZ_DB_FILE);
    create_user($db, ['email' => $email, 'name' => $name, 'role' => 'owner',
        'password' => $password, 'createdBy' => 'installer', 'mustChangePassword' => false]);

    ok(['installed' => true]);
}

function render_installer_page(): never {
    header('Content-Type: text/html; charset=utf-8');
    // Installer needs its inline script; relax CSP for this one page only.
    header("Content-Security-Policy: default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; form-action 'self'");
    echo <<<'HTML'
<!doctype html><html lang="en-GB"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Set up Cerviz Back Office</title>
<style>
  body { font: 15px/1.5 -apple-system, "Segoe UI", Roboto, sans-serif; margin: 0;
         min-height: 100vh; display: flex; align-items: center; justify-content: center;
         background: linear-gradient(160deg, #1e3a5f 0%, #16293f 100%); }
  .card { background: #fff; border-radius: 10px; padding: 30px; width: 100%; max-width: 420px;
          box-shadow: 0 20px 50px rgba(0,0,0,0.3); margin: 20px; }
  h1 { font-size: 19px; color: #1e3a5f; margin: 0 0 6px; }
  p { color: #667588; font-size: 13px; }
  label { display: block; font-size: 12px; font-weight: 600; color: #46586b; margin: 14px 0 4px; }
  input { width: 100%; padding: 9px 10px; border: 1px solid #dde3ea; border-radius: 6px;
          font: inherit; box-sizing: border-box; }
  button { margin-top: 20px; width: 100%; padding: 11px; background: #1e3a5f; color: #fff;
           border: none; border-radius: 6px; font: inherit; font-weight: 600; cursor: pointer; }
  .error { background: #fdeced; border-left: 4px solid #c62828; padding: 10px 12px;
           margin-top: 14px; font-size: 13px; display: none; }
</style></head><body>
<form class="card" id="f">
  <h1>Set up Cerviz Back Office</h1>
  <p>This runs once. It creates the database and your owner account. After signing in you will set up
     two-factor authentication with your phone.</p>
  <label>Your name</label><input name="name" required autocomplete="name">
  <label>Email address</label><input name="email" type="email" required autocomplete="email">
  <label>Password</label><input name="password" type="password" required minlength="12" autocomplete="new-password">
  <div style="font-size:11.5px;color:#667588;margin-top:4px">At least 12 characters. Length matters more than symbols.</div>
  <div class="error" id="err"></div>
  <button type="submit">Create my system</button>
</form>
<script>
document.getElementById('f').addEventListener('submit', async function (e) {
  e.preventDefault();
  var fd = new FormData(this);
  var res = await fetch('/api/setup', { method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: fd.get('name'), email: fd.get('email'), password: fd.get('password') }) });
  var body = await res.json();
  if (body.ok) { location.href = '/'; return; }
  var err = document.getElementById('err');
  err.textContent = body.error || 'Setup failed.';
  err.style.display = 'block';
});
</script></body></html>
HTML;
    exit;
}

// ---------------------------------------------------------------------------
// Database and session
// ---------------------------------------------------------------------------

$db = open_database("$DATA_DIR/" . CERVIZ_DB_FILE);
daily_backup_if_due($db, $DATA_DIR);

function set_session_cookies(string $token, bool $isHttps): void {
    $base = ['path' => '/', 'secure' => $isHttps, 'samesite' => 'Strict',
        'expires' => time() + SESSION_HOURS * 3600];
    setcookie(COOKIE_NAME, $token, $base + ['httponly' => true]);
    setcookie(CSRF_COOKIE, rtrim(strtr(base64_encode(random_bytes(24)), '+/', '-_'), '='),
        $base + ['httponly' => false]);
}

function clear_session_cookies(): void {
    setcookie(COOKIE_NAME, '', ['path' => '/', 'expires' => 1]);
    setcookie(CSRF_COOKIE, '', ['path' => '/', 'expires' => 1]);
}

$currentUser = null;

function require_user(PDO $db, string $method): array {
    global $currentUser;
    if ($currentUser) return $currentUser;

    $user = resolve_session($db, $_COOKIE[COOKIE_NAME] ?? null);
    if (!$user) {
        clear_session_cookies();
        fail('Your session has ended. Please sign in again.', 401);
    }

    // Double-submit CSRF for anything that changes state.
    if (!in_array($method, ['GET', 'HEAD'], true)) {
        $headerToken = $_SERVER['HTTP_X_CERVIZ_CSRF'] ?? '';
        $cookieToken = $_COOKIE[CSRF_COOKIE] ?? '';
        if ($headerToken === '' || $cookieToken === '' || !hash_equals($cookieToken, $headerToken)) {
            fail('Request rejected. Refresh the page and try again.', 403);
        }
    }

    return $currentUser = $user;
}

function require_capability(PDO $db, string $method, string $capability): array {
    $user = require_user($db, $method);
    if (!role_can($user['role'], $capability)) {
        fail('Your role does not have permission to do this.', 403);
    }
    return $user;
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

if ($path === '/api/health') {
    ok(['status' => 'up', 'time' => now_instant()]);
}

if ($path === '/api/auth/roles') {
    ok(array_map(fn($id) => ['id' => $id, 'label' => ROLE_LABELS[$id],
        'description' => ROLE_DESCRIPTIONS[$id]], array_keys(ROLE_LABELS)));
}

if ($path === '/api/auth/session') {
    $user = resolve_session($db, $_COOKIE[COOKIE_NAME] ?? null);
    ok($user ? $user + ['capabilities' => capabilities_for($user['role'])] : null);
}

if ($path === '/api/auth/login' && $method === 'POST') {
    $p = read_json_body();
    $result = account_login($db, [
        'email' => (string) ($p['email'] ?? ''),
        'password' => (string) ($p['password'] ?? ''),
        'totpCode' => isset($p['totpCode']) ? (string) $p['totpCode'] : null,
        'recoveryCode' => isset($p['recoveryCode']) ? (string) $p['recoveryCode'] : null,
        'ip' => $_SERVER['REMOTE_ADDR'] ?? null,
        'userAgent' => $_SERVER['HTTP_USER_AGENT'] ?? null,
    ]);

    if (!$result['ok']) {
        $status = in_array($result['reason'], ['totp_required', 'totp_invalid'], true) ? 200 : 401;
        send_json(['ok' => false, 'error' => $result['message'],
            'needsTotp' => !empty($result['needsTotp']), 'reason' => $result['reason']], $status);
    }
    set_session_cookies($result['token'], $isHttps);
    prune_expired($db);
    ok($result['user']);
}

if ($path === '/api/auth/logout' && $method === 'POST') {
    if (!empty($_COOKIE[COOKIE_NAME])) revoke_session_by_token($db, $_COOKIE[COOKIE_NAME]);
    clear_session_cookies();
    ok(true);
}

if ($path === '/api/rpc' && $method === 'POST') {
    $user = require_user($db, $method);
    $p = read_json_body();
    $channel = (string) ($p['channel'] ?? '');
    if ($channel === '') fail('No operation named.');

    try {
        ok(rpc_invoke($db, $user, $channel, is_array($p['payload'] ?? null) ? $p['payload'] : [],
            ['dataDir' => $GLOBALS['DATA_DIR']]));
    } catch (AuthorisationError $e) {
        fail($e->getMessage(), 403);
    } catch (DomainException $e) {
        fail($e->getMessage());
    } catch (PDOException $e) {
        // The immutability triggers speak through SQLite errors; surface their
        // message, which was written for humans.
        $msg = $e->getMessage();
        if (preg_match('/(?:ABORT|constraint failed):?\s*(.+)$/', $msg, $m)) $msg = $m[1];
        fail($msg);
    }
}

// --- Printable and downloadable documents ----------------------------------

if (preg_match('#^/api/invoices/([A-Za-z0-9_]+)/document$#', $path, $m)) {
    require_capability($db, $method, 'invoices.read');
    $format = $_GET['format'] ?? 'html';
    try {
        if ($format === 'doc') {
            // Word opens HTML happily when served as msword — an editable copy
            // with no dependency and no conversion step.
            $inv = row($db, 'SELECT number FROM invoices WHERE id = ?', [$m[1]]);
            header('Content-Type: application/msword');
            header('Content-Disposition: attachment; filename="' . ($inv['number'] ?? 'invoice') . '.doc"');
            echo render_invoice_html($db, $m[1], true);
        } elseif ($format === 'csv') {
            $inv = row($db, 'SELECT number FROM invoices WHERE id = ?', [$m[1]]);
            header('Content-Type: text/csv; charset=utf-8');
            header('Content-Disposition: attachment; filename="' . ($inv['number'] ?? 'invoice') . '.csv"');
            echo invoice_lines_csv($db, $m[1]);
        } else {
            header('Content-Type: text/html; charset=utf-8');
            echo render_invoice_html($db, $m[1]);
        }
    } catch (DomainException $e) {
        fail($e->getMessage(), 404);
    }
    exit;
}

if ($path === '/api/enquiry-pack') {
    $user = require_capability($db, $method, 'enquiry.generate');
    $from = $_GET['from'] ?? ''; $to = $_GET['to'] ?? '';
    if (!$from || !$to) fail('Give a date range.');
    $pack = build_enquiry_pack($db, $from, $to);
    record_audit($db, [
        'entityType' => 'enquiry_pack', 'entityId' => "{$from}_{$to}", 'action' => 'generated',
        'summary' => "Enquiry pack for $from to $to generated by {$user['name']} ("
            . count($pack['gaps']) . ' gap(s))',
        'actor' => $user['id'],
    ]);
    header('Content-Type: text/html; charset=utf-8');
    echo render_enquiry_pack_html($pack);
    exit;
}

function send_csv(string $csv, string $filename): never {
    header('Content-Type: text/csv; charset=utf-8');
    header("Content-Disposition: attachment; filename=\"$filename\"");
    echo $csv;
    exit;
}

if ($path === '/api/exports/sales.csv') {
    require_capability($db, $method, 'reports.read');
    send_csv(export_sales_csv($db, $_GET['from'] ?? today_iso(), $_GET['to'] ?? today_iso()),
        'sales-' . ($_GET['from'] ?? '') . '-to-' . ($_GET['to'] ?? '') . '.csv');
}
if ($path === '/api/exports/ledger.csv') {
    require_capability($db, $method, 'reports.read');
    send_csv(export_ledger_csv($db, $_GET['from'] ?? today_iso(), $_GET['to'] ?? today_iso()),
        'ledger-' . ($_GET['from'] ?? '') . '-to-' . ($_GET['to'] ?? '') . '.csv');
}
if ($path === '/api/exports/intermediaries.csv') {
    $user = require_capability($db, $method, 'statutory.read');
    $from = $_GET['from'] ?? today_iso(); $to = $_GET['to'] ?? today_iso();
    $csv = intermediary_report_csv(generate_intermediary_report($db, $from, $to));
    mark_intermediary_submitted($db, $from, $to, [], $user['id']);
    send_csv($csv, "intermediaries-$from-to-$to.csv");
}

// --- Evidence uploads and downloads ----------------------------------------

if ($path === '/api/documents' && $method === 'POST') {
    $user = require_capability($db, $method, 'documents.write');
    $entityType = (string) ($_POST['entityType'] ?? '');
    $entityId = (string) ($_POST['entityId'] ?? '');
    $category = (string) ($_POST['category'] ?? '');
    if ($entityType === '' || $entityId === '') fail('Say what the document belongs to.');
    if (!preg_match('/^[a-z_]+$/', $entityType) || !preg_match('/^[A-Za-z0-9_]+$/', $entityId)) {
        fail('Invalid attachment target.');
    }

    $files = $_FILES['file'] ?? null;
    if (!$files) fail('No file uploaded. The upload may exceed the hosting size limit.');
    // Normalise single-vs-multiple file upload shapes.
    $names = is_array($files['name']) ? $files['name'] : [$files['name']];
    $tmp = is_array($files['tmp_name']) ? $files['tmp_name'] : [$files['tmp_name']];
    $errs = is_array($files['error']) ? $files['error'] : [$files['error']];

    $created = [];
    foreach ($names as $i => $name) {
        if ($errs[$i] !== UPLOAD_ERR_OK) fail('Upload failed (code ' . $errs[$i] . ').');
        $created[] = in_txn($db, fn() => attach_document($db, $GLOBALS['DATA_DIR'] . '/documents', [
            'entityType' => $entityType, 'entityId' => $entityId,
            'category' => $category ?: null, 'sourcePath' => $tmp[$i],
            'filename' => basename((string) $name), 'uploadedBy' => $user['id'],
        ]));
    }
    ok($created);
}

if (preg_match('#^/api/documents/([A-Za-z0-9_]+)$#', $path, $m)) {
    require_capability($db, $method, 'documents.read');
    $doc = row($db, 'SELECT * FROM documents WHERE id = ?', [$m[1]]);
    if (!$doc || !is_file($doc['stored_path'])) fail('Document not found.', 404);
    header('Content-Type: ' . ($doc['mime_type'] ?? 'application/octet-stream'));
    header('Content-Disposition: inline; filename="' . str_replace('"', '', $doc['filename']) . '"');
    header('Content-Length: ' . filesize($doc['stored_path']));
    readfile($doc['stored_path']);
    exit;
}

if ($path === '/api/tide/import' && $method === 'POST') {
    require_capability($db, $method, 'purchases.write');
    $file = $_FILES['file'] ?? null;
    if (!$file || $file['error'] !== UPLOAD_ERR_OK) fail('No file uploaded.');
    ok(in_txn($db, fn() => import_tide_statement($db, (string) file_get_contents($file['tmp_name']))));
}

// ---------------------------------------------------------------------------
// The single-page application
// ---------------------------------------------------------------------------

if (str_starts_with($path, '/api/')) fail('Not found', 404);

$index = __DIR__ . '/index.html';
if (is_file($index)) {
    header('Content-Type: text/html; charset=utf-8');
    readfile($index);
    exit;
}
http_response_code(500);
echo 'The application bundle is missing. Re-upload the deployment zip.';
