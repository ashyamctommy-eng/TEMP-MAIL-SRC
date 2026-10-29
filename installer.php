<?php
/**
 * GoldenMail installer — web wizard + CLI, for cPanel / DirectAdmin / VPS.
 *
 * Web:  upload the project, open /installer.php in a browser, fill in the form.
 * CLI:  php installer.php --domain=example.com --admin-pass='strong-password'
 *
 * It writes .env, installs Node dependencies, creates the SQLite database and
 * the first admin, then locks itself. Delete this file when you are done.
 */

declare(strict_types=1);

error_reporting(E_ALL);
ini_set('display_errors', '1');
set_time_limit(0);
ignore_user_abort(true);

const APP_ROOT = __DIR__;
const LOCK_FILE = APP_ROOT . '/data/installed.lock';
const ENV_FILE = APP_ROOT . '/.env';
const MIN_NODE = '22.5.0';
const MIN_PHP = '8.0.0';

/* ------------------------------------------------------------------ helpers */

function h($value): string
{
    return htmlspecialchars((string) $value, ENT_QUOTES, 'UTF-8');
}

function post(string $key, string $default = ''): string
{
    return isset($_POST[$key]) ? trim((string) $_POST[$key]) : $default;
}

function csrf_token(): string
{
    if (empty($_SESSION['csrf'])) {
        $_SESSION['csrf'] = bin2hex(random_bytes(16));
    }
    return $_SESSION['csrf'];
}

function csrf_ok(): bool
{
    return isset($_POST['csrf'], $_SESSION['csrf'])
        && hash_equals($_SESSION['csrf'], (string) $_POST['csrf']);
}

function exec_available(): bool
{
    if (!function_exists('exec') || !function_exists('proc_open')) {
        return false;
    }
    $disabled = array_map('trim', explode(',', (string) ini_get('disable_functions')));
    return !in_array('exec', $disabled, true) && !in_array('proc_open', $disabled, true);
}

/** Locate a usable node binary. Returns [path, version] or [null, null]. */
function find_node(string $hint = ''): array
{
    $candidates = [];
    if ($hint !== '') {
        $candidates[] = $hint;
    }
    foreach (['node', '/usr/local/bin/node', '/usr/bin/node', '/opt/node/bin/node'] as $c) {
        $candidates[] = $c;
    }
    $home = (string) getenv('HOME');
    if ($home !== '') {
        foreach ((array) glob($home . '/nodevenv/*/*/bin/node') as $g) {
            $candidates[] = $g;
        }
        foreach ((array) glob($home . '/.nvm/versions/node/*/bin/node') as $g) {
            $candidates[] = $g;
        }
    }
    foreach ($candidates as $candidate) {
        if ($candidate === '') {
            continue;
        }
        if (strpos($candidate, '/') !== false && !is_file($candidate)) {
            continue;
        }
        $out = [];
        $code = 1;
        @exec(escapeshellarg($candidate) . ' -v 2>/dev/null', $out, $code);
        if ($code === 0 && !empty($out[0])) {
            return [$candidate, trim($out[0])];
        }
    }
    return [null, null];
}

function find_npm(string $nodePath): ?string
{
    $dir = dirname($nodePath);
    foreach ([$dir . '/npm', $dir . '/../lib/node_modules/npm/bin/npm-cli.js'] as $candidate) {
        if (is_file($candidate)) {
            return $candidate;
        }
    }
    $out = [];
    $code = 1;
    @exec('command -v npm 2>/dev/null', $out, $code);
    if ($code === 0 && !empty($out[0])) {
        return trim($out[0]);
    }
    return null;
}

/**
 * Run a command without a shell. Returns [exitCode, output].
 */
function run_cmd(array $argv, string $cwd, array $extraEnv = [], int $timeout = 900): array
{
    $env = getenv();
    if (!is_array($env)) {
        $env = [];
    }
    $env['PATH'] = $env['PATH'] ?? (string) getenv('PATH');
    $env['HOME'] = $env['HOME'] ?? (string) getenv('HOME');
    $env['LANG'] = $env['LANG'] ?? 'C.UTF-8';
    $env['NODE_ENV'] = 'production';
    foreach ($extraEnv as $k => $v) {
        $env[$k] = (string) $v;
    }

    $descriptors = [1 => ['pipe', 'w'], 2 => ['pipe', 'w']];
    $process = @proc_open($argv, $descriptors, $pipes, $cwd, $env);
    if (!is_resource($process)) {
        return [127, 'Could not start process. proc_open may be disabled.'];
    }

    stream_set_blocking($pipes[1], false);
    stream_set_blocking($pipes[2], false);

    $output = '';
    $start = time();
    while (true) {
        $output .= (string) stream_get_contents($pipes[1]);
        $output .= (string) stream_get_contents($pipes[2]);
        $status = proc_get_status($process);
        if (!$status['running']) {
            break;
        }
        if (time() - $start > $timeout) {
            proc_terminate($process, 9);
            $output .= "\n[installer] Command timed out after {$timeout}s.";
            break;
        }
        usleep(150000);
    }
    $output .= (string) stream_get_contents($pipes[1]);
    $output .= (string) stream_get_contents($pipes[2]);
    fclose($pipes[1]);
    fclose($pipes[2]);
    $exit = proc_close($process);
    return [$exit, trim($output)];
}

function env_quote(string $value): string
{
    if ($value !== '' && preg_match('/^[A-Za-z0-9_.:\/@+-]+$/', $value)) {
        return $value;
    }
    return "'" . str_replace("'", "'\\''", $value) . "'";
}

function write_env_file(string $path, array $values): bool
{
    $lines = ['# Generated by installer.php on ' . gmdate('c'), ''];
    foreach ($values as $key => $value) {
        $lines[] = $key . '=' . env_quote((string) $value);
    }
    $lines[] = '';
    $ok = @file_put_contents($path, implode("\n", $lines)) !== false;
    if ($ok) {
        @chmod($path, 0600);
    }
    return $ok;
}

function random_password(int $bytes = 9): string
{
    return rtrim(strtr(base64_encode(random_bytes($bytes)), '+/', 'ab'), '=');
}

function site_url_guess(): string
{
    $https = (!empty($_SERVER['HTTPS']) && $_SERVER['HTTPS'] !== 'off')
        || (($_SERVER['HTTP_X_FORWARDED_PROTO'] ?? '') === 'https');
    $host = $_SERVER['HTTP_HOST'] ?? 'localhost';
    return ($https ? 'https://' : 'http://') . $host;
}

function is_installed(): bool
{
    return file_exists(LOCK_FILE);
}

/* ---------------------------------------------------------------- validation */

function validate_config(array $cfg, bool $nodeOk, bool $dataWritable): array
{
    $errors = [];
    if (!preg_match('#^https?://#i', (string) $cfg['siteUrl'])) {
        $errors[] = 'Site URL must start with http:// or https://';
    }
    $hostRe = '/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/i';
    if (!preg_match($hostRe, (string) $cfg['mailHost'])) {
        $errors[] = 'Mail hostname must be a valid hostname, e.g. mail.example.com';
    }
    if ($cfg['domain'] !== '' && !preg_match($hostRe, (string) $cfg['domain'])) {
        $errors[] = 'Default domain is not a valid domain name.';
    }
    if (!preg_match('/^[a-zA-Z0-9._-]{3,40}$/', (string) $cfg['adminUser'])) {
        $errors[] = 'Admin username must be 3-40 characters (letters, numbers, . _ -).';
    }
    if (strlen((string) $cfg['adminPass']) < 8) {
        $errors[] = 'Admin password must be at least 8 characters.';
    }
    if (!$nodeOk) {
        $errors[] = 'Node.js 22.5+ was not found. Set the correct Node binary path.';
    }
    if (!$dataWritable) {
        $errors[] = 'The data/ directory is not writable. Set permissions to 755 (or 775).';
    }
    return $errors;
}

/* ------------------------------------------------------------ install engine */

/**
 * @return array{username:string,password:?string,domain:string,ingest:string,siteUrl:string,warnings:array,manual:bool}
 * @throws RuntimeException
 */
function perform_install(array $cfg): array
{
    $envValues = [
        'PORT' => '3000',
        'HOST' => '0.0.0.0',
        'SITE_URL' => $cfg['siteUrl'],
        'TRUST_PROXY' => '1',
        'SECURE_COOKIES' => strpos((string) $cfg['siteUrl'], 'https://') === 0 ? '1' : '0',
        'DATA_DIR' => './data',
        'SMTP_ENABLED' => $cfg['smtpEnabled'] ? '1' : '0',
        'SMTP_PORT' => '25',
        'SMTP_HOST' => '0.0.0.0',
        'SMTP_MAX_MB' => '25',
        'MAX_ATTACHMENT_MB' => '10',
        'ADMIN_USER' => $cfg['adminUser'],
        // ADMIN_PASSWORD is passed to the setup process, never written to disk.
        'SESSION_HOURS' => '12',
        'MAIL_HOSTNAME' => $cfg['mailHost'],
        'DEFAULT_DOMAIN' => $cfg['domain'],
        'INGEST_SECRET' => bin2hex(random_bytes(24)),
    ];

    if (!write_env_file(ENV_FILE, $envValues)) {
        throw new RuntimeException('Could not write .env. Check that the project directory is writable.');
    }

    $base = [
        'username' => $cfg['adminUser'],
        'password' => $cfg['adminPass'],
        'domain' => $cfg['domain'],
        'ingest' => $envValues['INGEST_SECRET'],
        'siteUrl' => $cfg['siteUrl'],
        'warnings' => [],
        'manual' => false,
    ];

    if (!$cfg['execOk']) {
        $base['manual'] = true;
        return $base;
    }

    $npmPath = find_npm((string) $cfg['nodePath']);
    $npmCmd = $npmPath !== null ? [$npmPath] : ['npm'];
    if ($npmPath !== null && substr($npmPath, -4) === '.js') {
        array_unshift($npmCmd, (string) $cfg['nodePath']);
    }

    [$code, $output] = run_cmd(
        array_merge($npmCmd, ['install', '--omit=dev', '--no-audit', '--no-fund']),
        APP_ROOT,
        [],
        900
    );
    if ($code !== 0) {
        throw new RuntimeException('npm install failed (exit ' . $code . ").\n" . $output);
    }

    [$code, $output] = run_cmd(
        [(string) $cfg['nodePath'], 'server/install-setup.js'],
        APP_ROOT,
        [
            'ADMIN_USER' => $cfg['adminUser'],
            'ADMIN_PASSWORD' => $cfg['adminPass'],
            'SITE_NAME' => $cfg['siteName'],
            'SITE_URL' => $cfg['siteUrl'],
            'MAIL_HOSTNAME' => $cfg['mailHost'],
            'DEFAULT_DOMAIN' => $cfg['domain'],
        ],
        300
    );

    $result = null;
    foreach (array_reverse(explode("\n", $output)) as $line) {
        $line = trim($line);
        if ($line !== '' && $line[0] === '{') {
            $result = json_decode($line, true);
            break;
        }
    }
    if ($code !== 0 || !is_array($result) || empty($result['ok'])) {
        throw new RuntimeException('Setup failed (exit ' . $code . ").\n" . $output);
    }

    $base['username'] = (string) ($result['username'] ?? $cfg['adminUser']);
    $base['password'] = !empty($result['createdAdmin'])
        ? (string) ($result['password'] ?? $cfg['adminPass'])
        : null;
    $base['domain'] = (string) ($result['domain'] ?? $cfg['domain']);
    $base['ingest'] = (string) ($result['ingestSecret'] ?? $envValues['INGEST_SECRET']);
    $base['warnings'] = is_array($result['warnings'] ?? null) ? $result['warnings'] : [];

    @file_put_contents(
        LOCK_FILE,
        'Installed ' . gmdate('c') . "\nDelete this file to re-run the installer.\n"
    );

    return $base;
}

/* --------------------------------------------------------------------- CLI */

function cli_prompt(string $question, string $default = ''): string
{
    $suffix = $default !== '' ? " [{$default}]" : '';
    fwrite(STDOUT, $question . $suffix . ': ');
    $line = fgets(STDIN);
    if ($line === false) {
        return $default;
    }
    $line = trim($line);
    return $line === '' ? $default : $line;
}

function cli_main(array $argv): void
{
    $opts = [];
    foreach (array_slice($argv, 1) as $arg) {
        if ($arg === '--help' || $arg === '-h') {
            fwrite(STDOUT, <<<TXT
GoldenMail CLI installer

  php installer.php --domain=example.com --site-url=https://mail.example.com \
      --mail-hostname=mail.example.com --admin-user=admin \
      --admin-pass='strong-password' [--smtp=0|1] [--node=/path/to/node] [--force]

Omit --admin-pass to be prompted (or to generate one). Omit values to be prompted.
TXT
            . "\n");
            exit(0);
        }
        if (preg_match('/^--([a-z-]+)=(.*)$/', $arg, $m)) {
            $opts[$m[1]] = $m[2];
        }
    }

    $interactive = function_exists('stream_isatty') && @stream_isatty(STDIN);

    $siteUrl = $opts['site-url'] ?? ($interactive ? cli_prompt('Public site URL', 'http://localhost:3000') : 'http://localhost:3000');
    $mailHost = $opts['mail-hostname'] ?? ($interactive ? cli_prompt('Mail hostname (MX target)', 'mail.localhost') : 'mail.localhost');
    $domain = $opts['domain'] ?? ($interactive ? cli_prompt('Default domain (optional)', '') : '');
    $adminUser = $opts['admin-user'] ?? ($interactive ? cli_prompt('Admin username', 'admin') : 'admin');
    $adminPass = $opts['admin-pass'] ?? '';
    if ($adminPass === '') {
        $adminPass = $interactive ? cli_prompt('Admin password (blank = generate)') : '';
    }
    if ($adminPass === '') {
        $adminPass = random_password();
    }
    $siteName = $opts['site-name'] ?? 'GoldenMail';
    $smtpEnabled = ($opts['smtp'] ?? '0') === '1';
    $nodeHint = $opts['node'] ?? '';
    $force = isset($opts['force']);

    if (is_installed() && !$force) {
        fwrite(STDERR, "This copy is already installed (data/installed.lock exists).\n");
        fwrite(STDERR, "Use --force to re-run, or reset the password with:\n");
        fwrite(STDERR, "  node server/create-admin.js admin 'new-password'\n");
        exit(1);
    }
    if ($force) {
        @unlink(LOCK_FILE);
    }

    if (!is_dir(APP_ROOT . '/data')) {
        @mkdir(APP_ROOT . '/data', 0755, true);
    }
    $dataWritable = is_writable(APP_ROOT . '/data');
    $execOk = exec_available();
    [$nodePath, $nodeVersion] = $execOk ? find_node($nodeHint) : [null, null];
    $nodeOk = $nodePath !== null
        && version_compare(ltrim((string) $nodeVersion, 'vV'), MIN_NODE, '>=');

    $cfg = [
        'siteName' => $siteName,
        'siteUrl' => rtrim($siteUrl, '/'),
        'mailHost' => $mailHost,
        'domain' => strtolower($domain),
        'adminUser' => $adminUser,
        'adminPass' => $adminPass,
        'smtpEnabled' => $smtpEnabled,
        'nodePath' => $nodePath,
        'execOk' => $execOk,
    ];

    $errors = validate_config($cfg, $nodeOk, $dataWritable);
    if ($errors) {
        foreach ($errors as $error) {
            fwrite(STDERR, "! {$error}\n");
        }
        exit(1);
    }

    try {
        $result = perform_install($cfg);
    } catch (RuntimeException $e) {
        fwrite(STDERR, '! ' . $e->getMessage() . "\n");
        exit(1);
    }

    fwrite(STDOUT, "\nGoldenMail installed\n--------------------\n");
    fwrite(STDOUT, "Admin URL : {$result['siteUrl']}/admin\n");
    fwrite(STDOUT, "Username  : {$result['username']}\n");
    if (!empty($result['password'])) {
        fwrite(STDOUT, "Password  : {$result['password']}  (save this now)\n");
    }
    fwrite(STDOUT, "Domain    : " . ($result['domain'] ?: '(none — add one in the admin panel)') . "\n");

    if (!empty($result['manual'])) {
        fwrite(STDOUT, "\nexec() is disabled, so finish manually:\n");
        fwrite(STDOUT, "  cd " . APP_ROOT . "\n");
        fwrite(STDOUT, "  npm install --omit=dev\n");
        fwrite(STDOUT, "  ADMIN_USER={$result['username']} ADMIN_PASSWORD='{$result['password']}' "
            . "DEFAULT_DOMAIN='{$result['domain']}' node server/install-setup.js\n");
    }

    fwrite(STDOUT, "\nNext: point MX for your domain at {$mailHost} and open {$result['siteUrl']}/admin\n");
    fwrite(STDOUT, "On cPanel: Setup Node.js App -> root " . APP_ROOT . ", startup server/index.js, Node 22.5+\n");
}

/* ---------------------------------------------------------------- dispatch */

if (PHP_SAPI === 'cli') {
    cli_main($argv);
    exit(0);
}

ini_set('session.cookie_httponly', '1');
ini_set('session.cookie_samesite', 'Lax');
session_start();

/* --------------------------------------------------------------- web checks */

$phpOk = version_compare(PHP_VERSION, MIN_PHP, '>=');
$execOk = exec_available();
$nodeHint = post('node_path');
[$nodePath, $nodeVersion] = $execOk ? find_node($nodeHint) : [null, null];
$nodeOk = $nodePath !== null && version_compare(ltrim((string) $nodeVersion, 'vV'), MIN_NODE, '>=');
$rootWritable = is_writable(APP_ROOT);
$dataDir = APP_ROOT . '/data';
if (!is_dir($dataDir)) {
    @mkdir($dataDir, 0755, true);
}
$dataWritable = is_dir($dataDir) && is_writable($dataDir);
$serverFile = is_file(APP_ROOT . '/server/index.js');

$errors = [];

if (($_GET['action'] ?? '') === 'delete_self' && $_SERVER['REQUEST_METHOD'] === 'POST' && csrf_ok()) {
    @unlink(__FILE__);
    header('Location: /admin/login');
    exit;
}

if ($_SERVER['REQUEST_METHOD'] === 'POST' && ($_POST['action'] ?? '') === 'install' && !is_installed()) {
    if (!csrf_ok()) {
        $errors[] = 'Security token expired. Reload the page and try again.';
    }

    $siteName = post('site_name', 'GoldenMail');
    $siteUrl = rtrim(post('site_url', site_url_guess()), '/');
    $mailHost = post('mail_hostname');
    $domain = strtolower(post('domain'));
    $adminUser = post('admin_user', 'admin');
    $adminPass = (string) ($_POST['admin_pass'] ?? '');
    $smtpEnabled = isset($_POST['smtp_enabled']);

    if ($adminPass === '') {
        $adminPass = random_password();
    }

    $cfg = [
        'siteName' => $siteName,
        'siteUrl' => $siteUrl,
        'mailHost' => $mailHost,
        'domain' => $domain,
        'adminUser' => $adminUser,
        'adminPass' => $adminPass,
        'smtpEnabled' => $smtpEnabled,
        'nodePath' => $nodePath,
        'execOk' => $execOk,
    ];

    $errors = array_merge($errors, validate_config($cfg, $nodeOk, $dataWritable));

    if (!$errors) {
        try {
            $result = perform_install($cfg);
            $_SESSION['install_result'] = $result;
            $_SESSION['install_node'] = $nodePath;
            header('Location: ?done=1');
            exit;
        } catch (RuntimeException $e) {
            $errors[] = $e->getMessage();
        }
    }
}

$done = isset($_GET['done']) && isset($_SESSION['install_result']);
$result = $done ? $_SESSION['install_result'] : null;
if ($done) {
    unset($_SESSION['install_result']);
}

$installed = is_installed() && !$done;

/* ------------------------------------------------------------------ markup */

function page_head(string $title): void
{
    ?><!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta name="robots" content="noindex,nofollow">
<title><?= h($title) ?> — GoldenMail installer</title>
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&display=swap" rel="stylesheet">
<style>
  :root{--bg:#0d0703;--card:#1a0e05;--card2:#221206;--inset:#100902;--border:rgba(240,199,120,.15);
        --accent:#e8b45a;--accent-hot:#f6d894;--text:#f7ecd8;--muted:#c9a06a;--faint:#8a6b45;
        --red:#e07a5a;--green:#6fcf97}
  *{box-sizing:border-box;margin:0;padding:0}
  body{font-family:Inter,system-ui,sans-serif;background:var(--bg);color:var(--text);font-size:13px;
       line-height:1.55;min-height:100vh;padding:28px 16px 60px;
       background-image:radial-gradient(700px 360px at 50% -120px,rgba(200,150,60,.22),transparent 70%)}
  .wrap{max-width:760px;margin:0 auto}
  .brand{display:flex;align-items:center;gap:11px;justify-content:center;margin-bottom:6px}
  .logo{width:40px;height:40px;border-radius:12px;display:flex;align-items:center;justify-content:center;
        background:linear-gradient(135deg,#f6d894,#d9a441 55%,#9a6a24);
        box-shadow:0 8px 22px rgba(217,164,65,.45),inset 0 1px 0 rgba(255,255,255,.45)}
  .brand h1{font-size:19px;font-weight:800;letter-spacing:2px;
        background:linear-gradient(135deg,#f6d894,#d9a441);-webkit-background-clip:text;background-clip:text;color:transparent}
  .sub{text-align:center;color:var(--faint);font-size:11.5px;margin-bottom:22px}
  .card{background:linear-gradient(180deg,rgba(246,216,148,.045),transparent 32%),linear-gradient(180deg,#201106,var(--card));
        border:1px solid var(--border);border-radius:16px;padding:20px;margin-bottom:14px;
        box-shadow:0 18px 44px rgba(0,0,0,.42)}
  .card h2{font-size:12px;letter-spacing:1.1px;text-transform:uppercase;color:var(--muted);margin-bottom:14px}
  .step{display:flex;gap:8px;justify-content:center;margin-bottom:18px;flex-wrap:wrap}
  .step span{font-size:10px;letter-spacing:.6px;text-transform:uppercase;color:var(--faint);
        padding:5px 10px;border-radius:999px;border:1px solid transparent}
  .step span.on{color:var(--accent-hot);border-color:rgba(240,199,120,.28);background:rgba(246,216,148,.07)}
  label{display:block;font-size:10px;letter-spacing:.9px;text-transform:uppercase;color:var(--muted);
        font-weight:700;margin-bottom:5px}
  .field{margin-bottom:13px}
  .grid{display:grid;grid-template-columns:1fr 1fr;gap:12px}
  @media(max-width:620px){.grid{grid-template-columns:1fr}}
  input[type=text],input[type=password],input[type=url]{width:100%;height:40px;border-radius:9px;
        border:1px solid var(--border);background:var(--inset);color:#fff;padding:0 12px;font-size:13px;
        font-family:inherit;outline:none;transition:.15s}
  input:focus{border-color:var(--accent);box-shadow:0 0 0 3px rgba(232,180,90,.1)}
  .hint{font-size:10.5px;color:var(--faint);margin-top:4px}
  .switch{display:flex;align-items:center;gap:9px;font-size:12px;color:var(--muted);cursor:pointer}
  .switch input{-webkit-appearance:none;appearance:none;width:38px;height:22px;border-radius:999px;
        background:#2a1a0c;border:1px solid rgba(240,199,120,.25);position:relative;cursor:pointer;transition:.2s;flex-shrink:0}
  .switch input::after{content:"";position:absolute;top:2px;left:2px;width:16px;height:16px;border-radius:50%;
        background:#6b5335;transition:.18s}
  .switch input:checked{background:rgba(232,180,90,.4);border-color:var(--accent)}
  .switch input:checked::after{left:18px;background:var(--accent-hot)}
  .btn{display:inline-flex;align-items:center;justify-content:center;gap:7px;height:42px;padding:0 18px;
        border-radius:10px;border:1px solid var(--border);background:rgba(255,255,255,.03);color:var(--text);
        font-family:inherit;font-size:12.5px;font-weight:700;cursor:pointer;text-decoration:none;transition:.15s}
  .btn:hover{background:rgba(246,216,148,.08)}
  .btn.primary{border:none;color:#2a1604;background:linear-gradient(135deg,#f8dea8,#e8b45a 55%,#cf9a3f);
        box-shadow:0 8px 20px rgba(217,164,65,.3),inset 0 1px 0 rgba(255,255,255,.5)}
  .btn.primary:hover{filter:brightness(1.05)}
  .btn.danger{color:#f0a68f;border-color:rgba(224,122,90,.35);background:rgba(224,122,90,.08)}
  .actions{display:flex;gap:9px;justify-content:flex-end;margin-top:16px;flex-wrap:wrap}
  .check{display:flex;gap:10px;align-items:flex-start;padding:9px 0;border-bottom:1px solid rgba(240,199,120,.06)}
  .check:last-child{border-bottom:none}
  .check .ico{width:18px;height:18px;border-radius:50%;flex-shrink:0;display:flex;align-items:center;
        justify-content:center;font-size:11px;font-weight:800;margin-top:1px}
  .check.ok .ico{background:rgba(111,207,151,.15);color:var(--green)}
  .check.bad .ico{background:rgba(224,122,90,.15);color:var(--red)}
  .check .t{font-size:12px;font-weight:600}
  .check .d{font-size:10.5px;color:var(--faint);word-break:break-word}
  .alert{padding:11px 13px;border-radius:9px;font-size:12px;margin-bottom:12px;
        background:rgba(224,122,90,.1);border:1px solid rgba(224,122,90,.35);color:#f0a68f;white-space:pre-wrap}
  .alert.ok{background:rgba(111,207,151,.1);border-color:rgba(111,207,151,.3);color:#a7e6c3}
  .alert.warn{background:rgba(240,199,120,.08);border-color:rgba(240,199,120,.28);color:#e8cf9f}
  .kv{display:flex;justify-content:space-between;gap:12px;padding:8px 0;border-bottom:1px solid rgba(240,199,120,.06);font-size:12px}
  .kv:last-child{border-bottom:none}
  .kv b{font-weight:700;color:var(--accent-hot);text-align:right;word-break:break-word}
  .mono{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11px}
  .code{background:var(--inset);border:1px solid var(--border);border-radius:8px;padding:10px 12px;
        font-family:ui-monospace,Menlo,monospace;font-size:10.5px;color:var(--muted);white-space:pre-wrap;
        word-break:break-all;margin:8px 0}
  .muted{color:var(--faint)}
  a{color:var(--accent)}
  .foot{text-align:center;font-size:10.5px;color:var(--faint);margin-top:18px}
</style>
</head>
<body>
<div class="wrap">
  <div class="brand">
    <div class="logo">
      <svg width="21" height="21" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2.3" stroke-linecap="round" stroke-linejoin="round"><path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z"></path><polyline points="22,6 12,13 2,6"></polyline></svg>
    </div>
    <h1>GOLDENMAIL</h1>
  </div>
  <p class="sub">Installation wizard</p>
<?php
}

function page_foot(): void
{
    ?>
  <p class="foot">Delete <span class="mono">installer.php</span> after installation.</p>
</div>
</body>
</html>
<?php
}

/* -------------------------------------------------------------------- views */

page_head('Install');
?>

<?php if ($installed): ?>

  <div class="card">
    <h2>Already installed</h2>
    <div class="alert warn">
      This copy is already configured. The installer is locked to prevent
      overwriting your admin account.
    </div>
    <p class="muted" style="font-size:12px">
      To run the installer again, delete <span class="mono">data/installed.lock</span>
      and reload this page. To reset the admin password instead, run:
    </p>
    <div class="code">node server/create-admin.js admin 'new-strong-password'</div>
    <div class="actions">
      <a class="btn" href="/">Open site</a>
      <a class="btn primary" href="/admin/login">Admin login</a>
    </div>
  </div>

<?php elseif ($done && $result): ?>

  <div class="step"><span>1 Requirements</span><span>2 Configuration</span><span class="on">3 Done</span></div>

  <div class="card">
    <h2>Installation complete</h2>
    <div class="alert ok">GoldenMail is configured and the database is ready.</div>

    <div class="kv"><span>Admin URL</span><b><a href="/admin/login"><?= h($result['siteUrl']) ?>/admin</a></b></div>
    <div class="kv"><span>Username</span><b><?= h($result['username']) ?></b></div>
    <?php if (!empty($result['password'])): ?>
      <div class="kv"><span>Password</span><b class="mono"><?= h($result['password']) ?></b></div>
    <?php else: ?>
      <div class="kv"><span>Password</span><b>unchanged</b></div>
    <?php endif; ?>
    <div class="kv"><span>Domain</span><b><?= h($result['domain'] ?: '— none yet —') ?></b></div>

    <?php if (!empty($result['password'])): ?>
      <div class="alert warn" style="margin-top:14px">
        Copy the password now. It is shown only once and is not stored in plain text.
      </div>
    <?php endif; ?>

    <?php foreach (($result['warnings'] ?? []) as $warning): ?>
      <div class="alert warn"><?= h($warning) ?></div>
    <?php endforeach; ?>

    <?php if (!empty($result['manual'])): ?>
      <h2 style="margin-top:20px">Finish in cPanel Terminal</h2>
      <p class="muted" style="font-size:12px">
        PHP’s <span class="mono">exec()</span> is disabled on this host, so run these two commands
        once (cPanel → Terminal, or SSH):
      </p>
      <div class="code">cd <?= h(APP_ROOT) ?>

npm install --omit=dev

ADMIN_USER=<?= h($result['username']) ?> \
ADMIN_PASSWORD='<?= h((string) $result['password']) ?>' \
DEFAULT_DOMAIN='<?= h((string) $result['domain']) ?>' \
node server/install-setup.js</div>
      <p class="hint">Then restart the Node.js app from cPanel → Setup Node.js App.</p>
    <?php endif; ?>
  </div>

  <div class="card">
    <h2>Next: run the Node.js app</h2>
    <p class="muted" style="font-size:12px;margin-bottom:10px">
      cPanel → <b>Setup Node.js App</b> → <b>Create Application</b>, using these values:
    </p>
    <div class="kv"><span>Application root</span><b class="mono"><?= h(APP_ROOT) ?></b></div>
    <div class="kv"><span>Application URL</span><b class="mono"><?= h(parse_url($result['siteUrl'], PHP_URL_HOST) ?: 'your domain') ?></b></div>
    <div class="kv"><span>Application startup file</span><b class="mono">server/index.js</b></div>
    <div class="kv"><span>Node.js version</span><b class="mono">22.5 or newer</b></div>
    <p class="hint" style="margin-top:10px">
      Press <b>Run NPM Install</b> and then <b>Restart</b>. The app reads <span class="mono">.env</span>
      on its own — no extra environment variables are needed in the cPanel UI.
    </p>
  </div>

  <div class="card">
    <h2>Next: receive mail</h2>
    <?php if (strpos($result['siteUrl'], 'https://') !== 0): ?>
      <div class="alert warn">
        Inbound mail needs HTTPS for Cloudflare Email Routing. Put the app behind SSL
        (cPanel → SSL/TLS Status → AutoSSL) before using the HTTP ingest URL.
      </div>
    <?php endif; ?>
    <p class="muted" style="font-size:12px">
      Shared cPanel hosting cannot bind port 25 (Exim already owns it), so use the
      HTTP ingest endpoint. With Cloudflare Email Routing, deploy this Worker:
    </p>
    <div class="code">export default {
  async email(message, env) {
    const raw = await new Response(message.raw).arrayBuffer();
    const url = `${env.INGEST_URL}?to=${encodeURIComponent(message.to)}`;
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "message/rfc822",
        "X-Ingest-Secret": env.INGEST_SECRET
      },
      body: raw
    });
    if (!res.ok) message.setReject("Mailbox unavailable");
  }
};</div>
    <p class="hint">
      Set <span class="mono">INGEST_URL</span> to
      <span class="mono"><?= h($result['siteUrl']) ?>/api/ingest</span> and
      <span class="mono">INGEST_SECRET</span> to the value shown in
      Admin → Settings. Then point the domain’s MX at Cloudflare Email Routing.
    </p>
  </div>

  <div class="card">
    <h2>Security</h2>
    <p class="muted" style="font-size:12px">
      The installer has served its purpose. Delete it now — the button below removes
      <span class="mono">installer.php</span> from the server.
    </p>
    <form method="post" action="?action=delete_self" style="margin-top:14px">
      <input type="hidden" name="csrf" value="<?= h(csrf_token()) ?>">
      <div class="actions">
        <a class="btn primary" href="/admin/login">Open admin panel</a>
        <button class="btn danger" type="submit">Delete installer.php</button>
      </div>
    </form>
  </div>

<?php else: ?>

  <div class="step"><span class="on">1 Requirements</span><span>2 Configuration</span><span>3 Done</span></div>

  <?php foreach ($errors as $error): ?>
    <div class="alert"><?= h($error) ?></div>
  <?php endforeach; ?>

  <div class="card">
    <h2>Server requirements</h2>
    <div class="check <?= $phpOk ? 'ok' : 'bad' ?>">
      <div class="ico"><?= $phpOk ? '✓' : '!' ?></div>
      <div><div class="t">PHP <?= h(PHP_VERSION) ?></div>
        <div class="d"><?= $phpOk ? 'Requirement met (8.0+)' : 'PHP 8.0 or newer is required' ?></div></div>
    </div>
    <div class="check <?= $nodeOk ? 'ok' : 'bad' ?>">
      <div class="ico"><?= $nodeOk ? '✓' : '!' ?></div>
      <div><div class="t">Node.js <?= h($nodeVersion ?: 'not found') ?></div>
        <div class="d"><?= $nodeOk
            ? 'Requirement met (22.5+)'
            : 'Node 22.5+ is required. In cPanel create the Node.js app first, then paste its node binary path below.' ?></div></div>
    </div>
    <div class="check <?= $execOk ? 'ok' : 'bad' ?>">
      <div class="ico"><?= $execOk ? '✓' : '!' ?></div>
      <div><div class="t">Shell execution</div>
        <div class="d"><?= $execOk
            ? 'Available — dependencies and database will be set up automatically'
            : 'exec() is disabled — the installer will write .env and print the two commands to run in Terminal' ?></div></div>
    </div>
    <div class="check <?= $dataWritable ? 'ok' : 'bad' ?>">
      <div class="ico"><?= $dataWritable ? '✓' : '!' ?></div>
      <div><div class="t">data/ directory writable</div>
        <div class="d"><?= $dataWritable ? h($dataDir) : 'Set permissions: chmod 755 ' . h($dataDir) ?></div></div>
    </div>
    <div class="check <?= $serverFile ? 'ok' : 'bad' ?>">
      <div class="ico"><?= $serverFile ? '✓' : '!' ?></div>
      <div><div class="t">Application files</div>
        <div class="d"><?= $serverFile ? 'server/index.js found' : 'server/index.js is missing — upload the full project' ?></div></div>
    </div>

    <?php if (!$nodeOk): ?>
      <form method="post" style="margin-top:14px">
        <input type="hidden" name="csrf" value="<?= h(csrf_token()) ?>">
        <div class="field">
          <label>Node.js binary path</label>
          <input type="text" name="node_path" value="<?= h($nodeHint) ?>"
                 placeholder="/home/USER/nodevenv/goldenmail/22/bin/node">
          <div class="hint">cPanel → Setup Node.js App shows the path; usually <span class="mono">~/nodevenv/&lt;app&gt;/&lt;version&gt;/bin/node</span>.</div>
        </div>
        <div class="actions"><button class="btn" type="submit">Re-check</button></div>
      </form>
    <?php endif; ?>
  </div>

  <form method="post" id="installForm">
    <input type="hidden" name="action" value="install">
    <input type="hidden" name="csrf" value="<?= h(csrf_token()) ?>">
    <input type="hidden" name="node_path" value="<?= h($nodePath ?? '') ?>">

    <div class="card">
      <h2>Site configuration</h2>
      <div class="grid">
        <div class="field">
          <label>Site name</label>
          <input type="text" name="site_name" value="<?= h(post('site_name', 'GoldenMail')) ?>" required>
        </div>
        <div class="field">
          <label>Public site URL</label>
          <input type="url" name="site_url" value="<?= h(post('site_url', site_url_guess())) ?>" required>
          <div class="hint">Use the final HTTPS URL if you have SSL.</div>
        </div>
        <div class="field">
          <label>Mail hostname (MX target)</label>
          <input type="text" name="mail_hostname" value="<?= h(post('mail_hostname', 'mail.' . (parse_url(site_url_guess(), PHP_URL_HOST) ?: 'example.com'))) ?>" required>
          <div class="hint">The A record your MX will point to.</div>
        </div>
        <div class="field">
          <label>Default domain (optional)</label>
          <input type="text" name="domain" value="<?= h(post('domain')) ?>" placeholder="example.com">
          <div class="hint">Can be added later in the admin panel.</div>
        </div>
      </div>
    </div>

    <div class="card">
      <h2>Admin account</h2>
      <div class="grid">
        <div class="field">
          <label>Username</label>
          <input type="text" name="admin_user" value="<?= h(post('admin_user', 'admin')) ?>" required>
        </div>
        <div class="field">
          <label>Password</label>
          <input type="password" name="admin_pass" id="adminPass" placeholder="leave blank to generate" autocomplete="new-password">
          <div class="hint">Minimum 8 characters. Blank = strong random password.</div>
        </div>
      </div>
      <label class="switch" style="margin-top:6px">
        <input type="checkbox" name="smtp_enabled" value="1" <?= post('smtp_enabled') ? 'checked' : '' ?>>
        Start the built-in SMTP server (port 25) — only on a VPS, not on cPanel
      </label>
    </div>

    <div class="card">
      <h2>Install</h2>
      <p class="muted" style="font-size:12px">
        The installer writes <span class="mono">.env</span>, runs <span class="mono">npm install</span>,
        creates the SQLite database and your admin account. Existing files are not overwritten.
      </p>
      <div class="actions">
        <button class="btn primary" type="submit" <?= ($nodeOk && $dataWritable && $serverFile) ? '' : 'disabled' ?>>
          Install GoldenMail
        </button>
      </div>
      <?php if (!($nodeOk && $dataWritable && $serverFile)): ?>
        <p class="hint" style="margin-top:8px">Fix the failed requirements above to continue.</p>
      <?php endif; ?>
    </div>
  </form>

<?php endif; ?>

<?php page_foot(); ?>
