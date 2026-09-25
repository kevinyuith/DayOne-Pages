<?php
/**
 * DayOne Pages — delivery server.
 *
 * Bootstrap: loads the .env, builds the configuration and installs the error
 * handlers. After this, `src/app.php` handles the request.
 *
 * No framework and no composer on purpose: the server does one thing only
 * (find the HTML for a host+path and serve it with cache), and every
 * dependency would be one more thing to maintain on a machine that must stay
 * up even when Supabase is down.
 */
declare(strict_types=1);

defined('DAYONE_ENTRY') || (http_response_code(404) && exit);

const DAYONE_ROOT = __DIR__ . '/..';

/** Reads KEY=VALUE from the file, without overwriting what already came from the environment. */
function dayone_load_env(string $file): void
{
    if (!is_file($file)) {
        return;
    }
    $lines = file($file, FILE_IGNORE_NEW_LINES | FILE_SKIP_EMPTY_LINES) ?: [];
    foreach ($lines as $line) {
        $line = trim($line);
        if ($line === '' || $line[0] === '#') {
            continue;
        }
        $pos = strpos($line, '=');
        if ($pos === false) {
            continue;
        }
        $key = trim(substr($line, 0, $pos));
        $value = trim(substr($line, $pos + 1));
        $value = preg_replace('/^(["\'])(.*)\1$/', '$2', $value) ?? $value;
        if (getenv($key) === false) {
            putenv("$key=$value");
        }
    }
}

dayone_load_env(DAYONE_ROOT . '/.env');

/**
 * Alternative to .env: a `config.php` that returns a KEY => value array.
 *
 * It exists for the layout where the site folder IS the webroot (hosting with
 * a control panel). There a `.env` can be downloaded by anyone if nginx
 * doesn't block dotfiles; a `.php` is never delivered as text, and the
 * DAYONE_ENTRY guard at its top makes a direct request answer 404.
 */
function dayone_load_config_php(string $file): void
{
    if (!is_file($file)) {
        return;
    }
    $values = require $file;
    if (!is_array($values)) {
        return;
    }
    foreach ($values as $key => $value) {
        if (is_string($key) && is_scalar($value) && getenv($key) === false) {
            putenv($key . '=' . (is_bool($value) ? ($value ? '1' : '0') : (string) $value));
        }
    }
}

dayone_load_config_php(DAYONE_ROOT . '/config.php');

/** The configuration, in one place. Read once per process. */
function config(): array
{
    static $config = null;
    if ($config !== null) {
        return $config;
    }
    $get = static function (string $key, ?string $default = null): ?string {
        $v = getenv($key);
        return ($v === false || $v === '') ? $default : $v;
    };
    $int = static fn(string $key, int $default): int => (int) ($get($key) ?? $default);

    $config = [
        'supabase_url'      => rtrim((string) $get('SUPABASE_URL', ''), '/'),
        'supabase_anon_key' => (string) $get('SUPABASE_ANON_KEY', ''),
        'server_key'        => (string) $get('PAGES_SERVER_KEY', ''),
        'server_id'         => (string) $get('SERVER_ID', ''),
        'purge_token'       => (string) $get('PURGE_TOKEN', ''),
        'cache_dir'         => (string) $get('CACHE_DIR', DAYONE_ROOT . '/cache'),
        'cache_ttl'         => $int('CACHE_TTL', 30),
        'negative_ttl'      => $int('NEGATIVE_TTL', 30),
        'stale_max_age'     => $int('STALE_MAX_AGE', 604800),
        'swr'               => $int('SWR', 1) === 1,
        'max_path_len'      => $int('MAX_PATH_LEN', 200),
        'max_paths_per_host'=> $int('MAX_PATHS_PER_HOST', 2000),
        'supabase_timeout'  => $int('SUPABASE_TIMEOUT', 5),
        'debug_headers'     => $int('DEBUG_HEADERS', 1) === 1,
        'log_hits'          => $int('LOG_HITS', 1) === 1,
        'hits_timeout'      => $int('HITS_TIMEOUT', 5),
        'sub0_key'          => (string) $get('SUB0_KEY', 'DAYONE'),
    ];
    return $config;
}

ini_set('display_errors', '0');
ini_set('log_errors', '1');
header_remove('X-Powered-By');

set_error_handler(static function (int $severity, string $message, string $file, int $line): bool {
    if (!(error_reporting() & $severity)) {
        return false;
    }
    // A deprecation doesn't kill the request: it goes to the log and life goes
    // on. A function marked deprecated in a new PHP version must not turn into
    // a 500 on every site at once.
    if ($severity === E_DEPRECATED || $severity === E_USER_DEPRECATED) {
        error_log("[dayone-pages] deprecated: $message in $file:$line");
        return true;
    }
    throw new ErrorException($message, 0, $severity, $file, $line);
});

set_exception_handler(static function (Throwable $e): void {
    error_log('[dayone-pages] unhandled error: ' . $e->getMessage() . ' in ' . $e->getFile() . ':' . $e->getLine());
    if (!headers_sent()) {
        http_response_code(500);
        header('Content-Type: text/plain; charset=utf-8');
        header('Cache-Control: no-store');
    }
    echo "Internal error.\n";
});

require __DIR__ . '/http.php';
require __DIR__ . '/normalize.php';
require __DIR__ . '/cache.php';
require __DIR__ . '/netinfo.php';
require __DIR__ . '/supabase.php';
require __DIR__ . '/conditions.php';
require __DIR__ . '/funnel.php';
require __DIR__ . '/vsl.php';
require __DIR__ . '/rules.php';
require __DIR__ . '/resolver.php';
require __DIR__ . '/respond.php';
require __DIR__ . '/hits.php';
require __DIR__ . '/sub0.php';
require __DIR__ . '/beacon.php';
require __DIR__ . '/placeholders.php';
require __DIR__ . '/handlers.php';
require __DIR__ . '/app.php';
