<?php
/**
 * DayOne Pages — servidor de entrega.
 *
 * Bootstrap: carrega o .env, monta a configuração e liga os handlers de erro.
 * Depois disto, `src/app.php` cuida da request.
 *
 * Sem framework e sem composer de propósito: o servidor faz uma coisa só
 * (achar o HTML de um host+path e servi-lo com cache), e cada dependência
 * seria uma coisa a mais para manter numa máquina que precisa ficar de pé
 * mesmo quando o Supabase não está.
 */
declare(strict_types=1);

defined('DAYONE_ENTRY') || (http_response_code(404) && exit);

const DAYONE_ROOT = __DIR__ . '/..';

/** Lê KEY=VALUE do arquivo, sem sobrescrever o que já veio do ambiente. */
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
 * Alternativa ao .env: um `config.php` que devolve um array CHAVE => valor.
 *
 * Existe para o layout em que a pasta do site É o webroot (hospedagem com
 * painel). Ali um `.env` pode ser baixado por qualquer um se o nginx não
 * bloquear dotfiles; um `.php` nunca é entregue como texto, e a trava
 * DAYONE_ENTRY no topo dele faz o pedido direto responder 404.
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

/** A configuração, num lugar só. Lida uma vez por processo. */
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
        'cache_ttl'         => $int('CACHE_TTL', 60),
        'negative_ttl'      => $int('NEGATIVE_TTL', 60),
        'stale_max_age'     => $int('STALE_MAX_AGE', 604800),
        'swr'               => $int('SWR', 0) === 1,
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
    // Deprecation não derruba request: vai para o log e a vida segue. Uma
    // função marcada como deprecada numa versão nova do PHP não pode virar
    // 500 em todos os sites de uma vez.
    if ($severity === E_DEPRECATED || $severity === E_USER_DEPRECATED) {
        error_log("[dayone-pages] deprecated: $message em $file:$line");
        return true;
    }
    throw new ErrorException($message, 0, $severity, $file, $line);
});

set_exception_handler(static function (Throwable $e): void {
    error_log('[dayone-pages] erro não tratado: ' . $e->getMessage() . ' em ' . $e->getFile() . ':' . $e->getLine());
    if (!headers_sent()) {
        http_response_code(500);
        header('Content-Type: text/plain; charset=utf-8');
        header('Cache-Control: no-store');
    }
    echo "Erro interno.\n";
});

require __DIR__ . '/http.php';
require __DIR__ . '/normalize.php';
require __DIR__ . '/cache.php';
require __DIR__ . '/supabase.php';
require __DIR__ . '/conditions.php';
require __DIR__ . '/funnel.php';
require __DIR__ . '/resolver.php';
require __DIR__ . '/respond.php';
require __DIR__ . '/hits.php';
require __DIR__ . '/sub0.php';
require __DIR__ . '/handlers.php';
require __DIR__ . '/app.php';
