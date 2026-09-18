<?php
/**
 * Testes do servidor, em PHP puro. `php server/tests/run.php`
 *
 * Cada arquivo *.test.php recebe as funções abaixo e registra casos. Sem
 * framework: o que se testa é normalização, condições e cache — as três
 * coisas que precisam bater com o banco e com o dashboard.
 */
declare(strict_types=1);

$tmp = sys_get_temp_dir() . '/dayone-pages-test-' . getmypid();
putenv("CACHE_DIR=$tmp");
putenv('CACHE_TTL=2');
putenv('NEGATIVE_TTL=1');
putenv('STALE_MAX_AGE=10');
putenv('SERVER_ID=test-server');
putenv('DEBUG_HEADERS=1');

define('DAYONE_ENTRY', true);

require __DIR__ . '/../src/bootstrap.php';

$passed = 0;
$failed = 0;

function check(string $name, bool $ok, string $detail = ''): void
{
    global $passed, $failed;
    if ($ok) {
        $passed++;
        echo "  ok   $name\n";
    } else {
        $failed++;
        echo "  FAIL $name" . ($detail !== '' ? " — $detail" : '') . "\n";
    }
}

function same(string $name, mixed $expected, mixed $actual): void
{
    check($name, $expected === $actual, 'esperado ' . var_export($expected, true) . ', veio ' . var_export($actual, true));
}

function make_request(array $over = []): Request
{
    $server = array_merge([
        'REQUEST_METHOD' => 'GET',
        'HTTP_HOST' => 'example.com',
        'REQUEST_URI' => '/',
        'QUERY_STRING' => '',
        'HTTP_USER_AGENT' => 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/120 Safari/537.36',
    ], $over);
    if (isset($over['REQUEST_URI']) && !isset($over['QUERY_STRING'])) {
        $server['QUERY_STRING'] = (string) (parse_url($over['REQUEST_URI'], PHP_URL_QUERY) ?? '');
    }
    $req = parse_request($server);
    $req->host = normalize_host($req->rawHost);
    $req->path = normalize_path($req->rawPath);
    return $req;
}

foreach (glob(__DIR__ . '/*.test.php') ?: [] as $file) {
    echo basename($file) . "\n";
    require $file;
}

remove_tree($tmp);

echo "\n$passed ok, $failed falhas\n";
exit($failed === 0 ? 0 : 1);
