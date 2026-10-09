<?php
/**
 * The log spool: hits and visit notices Supabase didn't take, written later.
 *
 * The live path is unchanged — each hit (hits.php) and each notice
 * (beacon.php) goes to its own RPC right after the response. When that call
 * gets no answer (a timeout: the Meta crawler's floods) or a 5xx (the
 * database out of connections, PostgREST reloading its schema cache), the
 * item isn't lost: it's appended to cache/log-spool.jsonl with the moment it
 * happened, and a later response replays the spool in batches through
 * pages.log_replay, which writes each item with the live function and moves
 * its timestamps back to that moment. A 4xx is never spooled: it's a refusal
 * (Cloudflare's WAF in front of supabase.co blocks an exploit scanner's hit
 * by its payload), and it would be refused again forever.
 *
 * One process replays at a time, at most every LOG_SPOOL_EVERY seconds. It
 * renames the spool to log-spool.replaying first, so the workers that spool
 * meanwhile never wait for it, and replays that file to the end before
 * taking the next spool (oldest first: a hit before its notices). It stops at
 * the first batch Supabase still can't take — the rest waits for the next
 * round. A batch refused with a 4xx goes one item at a time, dropping only
 * the refused ones. Items over LOG_SPOOL_MAX_AGE are given up, and the spool
 * stops growing past LOG_SPOOL_MAX_BYTES (a long outage at full traffic).
 */
declare(strict_types=1);

defined('DAYONE_ENTRY') || (http_response_code(404) && exit);

/** One JSON per line: an item for pages.log_replay ({"k", "at", …}). */
const LOG_SPOOL_FILE = 'log-spool.jsonl';
const LOG_SPOOL_WORK = 'log-spool.replaying';
/** An item older than this is given up (log_replay clamps to the last day). */
const LOG_SPOOL_MAX_AGE = 86400;
/** Replay at most this often (seconds), this many items per call, for at most this long per round. */
const LOG_SPOOL_EVERY = 15;
const LOG_SPOOL_BATCH = 300;
const LOG_SPOOL_ROUND_SECONDS = 20;
/** The spool stops taking items past this size (~100k hits). */
const LOG_SPOOL_MAX_BYTES = 200 * 1024 * 1024;

/** A failed call worth trying again: no answer, a 5xx or a 429 — never a refusal (4xx) or "not configured" (-1). */
function log_spool_retryable(int $status): bool
{
    return $status === 0 || $status === 429 || $status >= 500;
}

function log_spool_path(string $file = LOG_SPOOL_FILE): string
{
    return cache_dir() . '/' . $file;
}

/**
 * Keeps an item for the replay, stamped with when it happened ($at, unix
 * seconds; default now). False when it can't be kept (no writable cache, or
 * the spool is full).
 */
function log_spool(array $item, ?float $at = null): bool
{
    if (!cache_writable()) {
        return false;
    }
    $path = log_spool_path();
    clearstatcache(true, $path);
    if ((int) @filesize($path) > LOG_SPOOL_MAX_BYTES) {
        static $warned = false;
        if (!$warned) {
            $warned = true;
            error_log('[dayone-pages] log spool full: items dropped until it drains');
        }
        return false;
    }
    $item['at'] = round($at ?? microtime(true), 3);
    $line = json_encode($item, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE | JSON_INVALID_UTF8_SUBSTITUTE);
    return $line !== false && @file_put_contents($path, $line . "\n", FILE_APPEND | LOCK_EX) !== false;
}

/**
 * A visit notice (beacon.php's [visit id, notice]) as spool items: the
 * notice itself, plus its signals when it carried them. Replaying an item
 * that was half applied is harmless (the notice functions are idempotent).
 *
 * @return list<array<string, mixed>>
 */
function log_spool_notice_items(string $visitId, array $notice): array
{
    $kind = (string) ($notice['kind'] ?? '');
    $ms = $notice['ms'] ?? null;
    $items = [match ($kind) {
        'load' => ['k' => 'load', 'v' => $visitId, 'ms' => $ms],
        'click' => ['k' => 'click', 'v' => $visitId],
        'duration' => ['k' => 'duration', 'v' => $visitId, 'ms' => $ms],
        default => ['k' => 'interact', 'v' => $visitId, 'kind' => $kind, 'ms' => $ms],
    }];
    $sg = $notice['sg'] ?? null;
    if (is_array($sg) && $sg !== []) {
        $items[] = ['k' => 'signals', 'v' => $visitId, 'sg' => $sg];
    }
    return $items;
}

/**
 * Replays the spool (after a response). $send (items → [status, result]) is
 * the tests' stand-in for pages.log_replay.
 *
 * @return array{sent: int, kept: int, dropped: int}|null  null = nothing to do now
 */
function log_spool_replay(?callable $send = null, ?float $now = null): ?array
{
    $now ??= microtime(true);
    $path = log_spool_path();
    $work = log_spool_path(LOG_SPOOL_WORK);
    $mark = cache_dir() . '/log-spool.replay';
    clearstatcache();
    $hasWork = is_file($work);
    if (!$hasWork && (!is_file($path) || (int) @filesize($path) === 0)) {
        return null;
    }
    if ($now - (int) @filemtime($mark) < LOG_SPOOL_EVERY) {
        return null;
    }
    $lock = @fopen(cache_dir() . '/log-spool.lock', 'c');
    if ($lock === false) {
        return null;
    }
    if (!flock($lock, LOCK_EX | LOCK_NB)) {
        fclose($lock);
        return null;
    }
    @touch($mark, (int) $now);
    // The next spool only once the previous round's file is done: oldest first.
    if (!$hasWork && !@rename($path, $work)) {
        flock($lock, LOCK_UN);
        fclose($lock);
        return null;
    }
    $send ??= static function (array $items): array {
        $r = supabase_log_replay($items);
        return [supabase_last_status(), $r];
    };

    // What isn't sent this round is written straight to the next version of
    // the file, line by line: a long outage never sits in memory.
    $tmp = $work . '.tmp';
    $in = @fopen($work, 'r');
    $out = @fopen($tmp, 'w');
    if ($in === false || $out === false) {
        flock($lock, LOCK_UN);
        fclose($lock);
        return null;
    }
    $started = microtime(true);
    $sent = 0;
    $kept = 0;
    $dropped = 0;
    $down = false;
    $batch = [];
    $keep = static function (string $line) use ($out, &$kept): void {
        fwrite($out, $line . "\n");
        $kept++;
    };
    $flush = static function () use (&$batch, &$down, &$sent, &$dropped, $send, $keep): void {
        if ($batch === []) {
            return;
        }
        [$status, $r] = $send(array_column($batch, 'item'));
        if (is_array($r)) {
            $sent += count($batch);
            if ((int) ($r['failed'] ?? 0) > 0) {
                error_log('[dayone-pages] log spool: ' . (int) $r['failed'] . ' item(s) failed in the database');
            }
        } elseif (log_spool_retryable($status)) {
            $down = true;
            foreach ($batch as $one) {
                $keep($one['line']);
            }
        } else {
            // Refused (a 4xx): one at a time, dropping only the ones refused again.
            foreach ($batch as $one) {
                if ($down) {
                    $keep($one['line']);
                    continue;
                }
                [$s1, $r1] = $send([$one['item']]);
                if (is_array($r1)) {
                    $sent++;
                } elseif (log_spool_retryable($s1)) {
                    $down = true;
                    $keep($one['line']);
                } else {
                    $dropped++;
                }
            }
        }
        $batch = [];
    };
    while (($line = fgets($in)) !== false) {
        $line = rtrim($line, "\n");
        if ($down || microtime(true) - $started > LOG_SPOOL_ROUND_SECONDS) {
            if ($line !== '') {
                $keep($line);
            }
            continue;
        }
        $item = json_decode($line, true);
        if (!is_array($item) || !is_string($item['k'] ?? null) || !is_numeric($item['at'] ?? null)) {
            continue;
        }
        if ($now - (float) $item['at'] > LOG_SPOOL_MAX_AGE) {
            $dropped++;
            continue;
        }
        $batch[] = ['item' => $item, 'line' => $line];
        if (count($batch) >= LOG_SPOOL_BATCH) {
            $flush();
        }
    }
    $flush();
    fclose($in);
    fclose($out);

    if ($kept === 0) {
        @unlink($tmp);
        @unlink($work);
    } else {
        @rename($tmp, $work);
    }
    flock($lock, LOCK_UN);
    fclose($lock);
    if ($dropped > 0) {
        error_log("[dayone-pages] log spool: $dropped item(s) given up (over a day old, or refused)");
    }
    return ['sent' => $sent, 'kept' => $kept, 'dropped' => $dropped];
}
