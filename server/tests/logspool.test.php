<?php
declare(strict_types=1);

// ── logspool.php: hits and notices Supabase didn't take, written later in batches ──

// Worth trying again: no answer, a 5xx, a 429. A refusal (4xx) or "not configured" never.
foreach ([0, 429, 500, 502, 503] as $s) {
    check("retryable: HTTP $s", log_spool_retryable($s));
}
foreach ([-1, 200, 204, 400, 401, 403, 404] as $s) {
    check("not retryable: HTTP $s", !log_spool_retryable($s));
}
// The last status is what the caller reads to decide (recorded by supabase_fire).
supabase_last_status(503);
check('last status: kept until the next call', supabase_last_status() === 503 && log_spool_retryable(supabase_last_status()));
supabase_last_status(-1);

// A notice as spool items: the notice, plus its signals when it carried them.
$v = str_repeat('a', 32);
same('notice: load', [['k' => 'load', 'v' => $v, 'ms' => 812]], log_spool_notice_items($v, ['kind' => 'load', 'ms' => 812]));
same('notice: click', [['k' => 'click', 'v' => $v]], log_spool_notice_items($v, ['kind' => 'click', 'ms' => null]));
same('notice: duration', [['k' => 'duration', 'v' => $v, 'ms' => 45000]], log_spool_notice_items($v, ['kind' => 'duration', 'ms' => 45000]));
same('notice: the first interaction', [['k' => 'interact', 'v' => $v, 'kind' => 'touch', 'ms' => 900]], log_spool_notice_items($v, ['kind' => 'touch', 'ms' => 900]));
same('notice with signals: two items', [['k' => 'duration', 'v' => $v, 'ms' => 5000], ['k' => 'signals', 'v' => $v, 'sg' => ['mm' => 0, 'sd' => 40]]],
    log_spool_notice_items($v, ['kind' => 'duration', 'ms' => 5000, 'sg' => ['mm' => 0, 'sd' => 40]]));

// The spool and its replay.
$lsReset = static function (): void {
    foreach ([LOG_SPOOL_FILE, LOG_SPOOL_WORK, LOG_SPOOL_WORK . '.tmp', 'log-spool.replay', 'log-spool.lock'] as $f) {
        @unlink(log_spool_path($f));
    }
};
$lsReset();
$t0 = 1_900_000_000.0;
same('nothing spooled: nothing to do', null, log_spool_replay(fn () => [200, ['ok' => 0]], $t0));
check('spool: keeps items with when they happened', log_spool(['k' => 'hit', 'p' => ['p_path' => '/a']], $t0 + 1.25)
    && log_spool(['k' => 'load', 'v' => $v, 'ms' => 700], $t0 + 2) && log_spool(['k' => 'hit', 'p' => ['p_path' => '/b']], $t0 + 3));
$lines = file(log_spool_path(), FILE_IGNORE_NEW_LINES);
same('spool: one JSON per line, stamped', ['k' => 'hit', 'p' => ['p_path' => '/a'], 'at' => 1_900_000_001.25], json_decode($lines[0], true));

// Supabase still down: nothing sent, everything kept, in order.
$calls = [];
$r = log_spool_replay(function (array $items) use (&$calls): array {
    $calls[] = $items;
    return [503, null];
}, $t0 + 60);
same('replay while down: one try, everything kept', [1, ['sent' => 0, 'kept' => 3, 'dropped' => 0]], [count($calls), $r]);
same('replay: the whole batch in one call, in order, with its times', [['hit', 1_900_000_001.25], ['load', 1_900_000_002.0], ['hit', 1_900_000_003.0]],
    array_map(fn ($i) => [$i['k'], (float) $i['at']], $calls[0]));
check('replay: the spool was set aside (new items go to a fresh spool)', !is_file(log_spool_path()) && is_file(log_spool_path(LOG_SPOOL_WORK)));
same('replay: not again within LOG_SPOOL_EVERY', null, log_spool_replay(fn () => [200, ['ok' => 0]], $t0 + 60 + LOG_SPOOL_EVERY - 1));

// A newer item spooled meanwhile waits for the older ones (oldest first).
log_spool(['k' => 'hit', 'p' => ['p_path' => '/c']], $t0 + 100);
$sent = [];
$ok = function (array $items) use (&$sent): array {
    array_push($sent, ...array_map(fn ($i) => $i['p']['p_path'] ?? $i['k'], $items));
    return [200, ['ok' => count($items), 'missing' => 0, 'failed' => 0]];
};
$r = log_spool_replay($ok, $t0 + 200);
same('back up: the set-aside file goes first, whole', [['/a', 'load', '/b'], ['sent' => 3, 'kept' => 0, 'dropped' => 0]], [$sent, $r]);
check('back up: the set-aside file is gone, the newer spool untouched', !is_file(log_spool_path(LOG_SPOOL_WORK)) && is_file(log_spool_path()));
$sent = [];
$r = log_spool_replay($ok, $t0 + 300);
same('next round: the newer item', [['/c'], ['sent' => 1, 'kept' => 0, 'dropped' => 0]], [$sent, $r]);
same('all written: nothing to do', null, log_spool_replay($ok, $t0 + 400));

// A batch refused (4xx: a WAF blocks one payload) goes one item at a time; only the refused one is dropped.
$lsReset();
foreach (['/x', '/attack', '/y'] as $i => $pth) {
    log_spool(['k' => 'hit', 'p' => ['p_path' => $pth]], $t0 + $i);
}
$sent = [];
$waf = function (array $items) use (&$sent): array {
    foreach ($items as $it) {
        if (($it['p']['p_path'] ?? '') === '/attack') {
            return [403, null];
        }
    }
    array_push($sent, ...array_map(fn ($i) => $i['p']['p_path'], $items));
    return [200, ['ok' => count($items)]];
};
$r = log_spool_replay($waf, $t0 + 60);
same('refused batch: one at a time, the refused one dropped, the rest written', [['/x', '/y'], ['sent' => 2, 'kept' => 0, 'dropped' => 1]], [$sent, $r]);

// Over a day old: given up, never sent.
$lsReset();
log_spool(['k' => 'hit', 'p' => ['p_path' => '/old']], $t0);
log_spool(['k' => 'hit', 'p' => ['p_path' => '/new']], $t0 + LOG_SPOOL_MAX_AGE);
$sent = [];
$r = log_spool_replay($ok, $t0 + LOG_SPOOL_MAX_AGE + 100);
same('over a day old: dropped; the recent one written', [['/new'], ['sent' => 1, 'kept' => 0, 'dropped' => 1]], [$sent, $r]);

// More than a batch: several calls of LOG_SPOOL_BATCH, in order.
$lsReset();
for ($i = 0; $i < LOG_SPOOL_BATCH + 5; $i++) {
    log_spool(['k' => 'hit', 'p' => ['p_path' => "/p$i"]], $t0 + $i);
}
$sizes = [];
$r = log_spool_replay(function (array $items) use (&$sizes): array {
    $sizes[] = count($items);
    return [200, ['ok' => count($items)]];
}, $t0 + LOG_SPOOL_BATCH + 60);
same('batches of LOG_SPOOL_BATCH', [[LOG_SPOOL_BATCH, 5], ['sent' => LOG_SPOOL_BATCH + 5, 'kept' => 0, 'dropped' => 0]], [$sizes, $r]);

// Down in the middle: what was sent stays sent, the rest is kept for the next round.
$lsReset();
for ($i = 0; $i < LOG_SPOOL_BATCH + 5; $i++) {
    log_spool(['k' => 'hit', 'p' => ['p_path' => "/q$i"]], $t0 + $i);
}
$n = 0;
$r = log_spool_replay(function (array $items) use (&$n): array {
    return ++$n === 1 ? [200, ['ok' => count($items)]] : [0, null];
}, $t0 + LOG_SPOOL_BATCH + 60);
same('down in the middle: the first batch sent, the rest kept', ['sent' => LOG_SPOOL_BATCH, 'kept' => 5, 'dropped' => 0], $r);
$kept = array_map(fn ($l) => json_decode($l, true)['p']['p_path'], file(log_spool_path(LOG_SPOOL_WORK), FILE_IGNORE_NEW_LINES));
same('down in the middle: the kept ones are the last five, in order', array_map(fn ($i) => '/q' . $i, range(LOG_SPOOL_BATCH, LOG_SPOOL_BATCH + 4)), $kept);
$lsReset();
