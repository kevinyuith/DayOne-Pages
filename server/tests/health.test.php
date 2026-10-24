<?php
declare(strict_types=1);

// ── handlers.php: /_dop/version and /_dop/health (24/10) ──

$dir = sys_get_temp_dir() . '/dayone-health-' . getmypid();
@mkdir($dir, 0700, true);
file_put_contents("$dir/a.php", "<?php // a\n");
file_put_contents("$dir/b.php", "<?php // b\n");

$sha = code_sha($dir);
check('code_sha: a sha256', preg_match('/^[0-9a-f]{64}$/', $sha) === 1, $sha);
same('code_sha: same files, same sha', $sha, code_sha($dir));

$v = version_info($dir);
same('version without VERSION: no commit', null, $v['commit']);
same('version without VERSION: nothing to compare', null, $v['changed_since_build']);
same('version without VERSION: no uncommitted list', [], $v['uncommitted']);

file_put_contents("$dir/" . VERSION_FILE, json_encode([
    'commit' => 'abc123', 'branch' => 'main', 'uncommitted' => ['server/src/fbclid.php'],
    'built_at' => '2026-10-24T17:00:00+00:00', 'code_sha' => $sha,
]));
$v = version_info($dir);
same('version: the commit', 'abc123', $v['commit']);
same('version: the branch', 'main', $v['branch']);
same('version: the uncommitted files', ['server/src/fbclid.php'], $v['uncommitted']);
same('version: unchanged since the build', false, $v['changed_since_build']);

file_put_contents("$dir/b.php", "<?php // b, edited by hand\n");
same('version: a file edited after the build shows', true, version_info($dir)['changed_since_build']);
file_put_contents("$dir/c.php", "<?php // c\n");
check('code_sha: a new file changes it', code_sha($dir) !== $sha);
same('version: the VERSION file itself is not code', code_sha($dir), version_info($dir)['code_sha']);

[$st, $headers, $body] = handle_version();
same('handle_version: 200', 200, $st);
same('handle_version: never cached', 'no-store', $headers['Cache-Control']);
check('handle_version: JSON with the code sha', is_string(json_decode($body, true)['code_sha'] ?? null), $body);

// The token
same('token: X-Health-Token', 'abc', health_token_from(['HTTP_X_HEALTH_TOKEN' => 'abc']));
same('token: Authorization Bearer', 'xyz', health_token_from(['HTTP_AUTHORIZATION' => 'Bearer xyz']));
same('token: the header wins over Bearer', 'abc', health_token_from(['HTTP_X_HEALTH_TOKEN' => 'abc', 'HTTP_AUTHORIZATION' => 'Bearer xyz']));
same('token: Basic is not a token', null, health_token_from(['HTTP_AUTHORIZATION' => 'Basic eHl6']));
same('token: none', null, health_token_from([]));

$fake = ['ok' => true, 'problems' => []];
same('health: no token configured → 404', 404, handle_dop_health('anything', '', $fake)[0]);
same('health: no token sent → 404', 404, handle_dop_health(null, 'secret', $fake)[0]);
same('health: a wrong token → 404', 404, handle_dop_health('nope', 'secret', $fake)[0]);
same('health: the token, all fine → 200', 200, handle_dop_health('secret', 'secret', $fake)[0]);
same('health: the token, a problem → 503', 503, handle_dop_health('secret', 'secret', ['ok' => false, 'problems' => ['disk' => 'x']])[0]);
check('health: a 404 says nothing', !str_contains(handle_dop_health('nope', 'secret', $fake)[2], 'problems'));

// Spools: size and the oldest item's age
$now = 1_800_000_000;
same('spool missing: empty', ['bytes' => 0, 'oldest_age_s' => null], health_spool("$dir/none.jsonl", $now));
file_put_contents("$dir/s.jsonl", json_encode(['at' => $now - 1200 + 0.25, 'x' => 1]) . "\n" . json_encode(['at' => $now - 5]) . "\n");
same('spool: the first item is the oldest', 1200, health_spool("$dir/s.jsonl", $now)['oldest_age_s']);
file_put_contents("$dir/s.jsonl", "not json\n");
same('spool: an unreadable first line → no age', null, health_spool("$dir/s.jsonl", $now)['oldest_age_s']);

// Local tables: their meta.json
@mkdir("$dir/fresh");
@mkdir("$dir/old");
file_put_contents("$dir/fresh/meta.json", json_encode(['built_at' => $now - 3600]));
file_put_contents("$dir/old/meta.json", json_encode(['built_at' => $now - 3 * 86400]));
same('table: built an hour ago', 3600, health_table_age("$dir/fresh", $now));
same('table: never built', null, health_table_age("$dir/none", $now));

$r = health_report(['netdb' => "$dir/fresh", 'rirdb' => "$dir/old", 'anondb' => "$dir/none"], $now);
check('report: a fresh table is no problem', !isset($r['problems']['netdb']), json_encode($r['problems']));
check('report: a table 3 days old is a problem', str_contains($r['problems']['rirdb'] ?? '', '72 h'), json_encode($r['problems']));
check('report: a table never built is a problem', isset($r['problems']['anondb']));
same('report: not ok with problems', false, $r['ok']);
same('report: the table ages', ['netdb' => 3600, 'rirdb' => 3 * 86400, 'anondb' => null], $r['tables_age_s']);
check('report: the cache is writable', $r['cache']['writable'] === true);
check('report: the server id', $r['server_id'] === 'test-server');
check('report: JSON-encodable', json_encode($r, JSON_INVALID_UTF8_SUBSTITUTE) !== false);

// The error log's tail
file_put_contents("$dir/err.log", implode("\n", array_map(static fn($i) => "line $i", range(1, 30))) . "\n");
$tail = health_log_tail("$dir/err.log", 3);
same('log tail: the last lines', ['line 28', 'line 29', 'line 30'], $tail);
same('log tail: no log', [], health_log_tail(''));
file_put_contents("$dir/err.log", str_repeat('x', 1000) . "\n");
check('log tail: a long line is cut', strlen(health_log_tail("$dir/err.log", 1)[0]) <= HEALTH_LOG_LINE_BYTES + 3);

foreach (glob("$dir/{,*/}*", GLOB_BRACE) ?: [] as $f) {
    is_file($f) && @unlink($f);
}
@rmdir("$dir/fresh");
@rmdir("$dir/old");
@rmdir($dir);
