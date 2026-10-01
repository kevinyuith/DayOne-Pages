<?php
/**
 * Click events for dayone-main's tracker, the "dot" edge function
 * (DOT_URL, https://cdn.dayone.click/functions/v1/dot).
 *
 * Every page request (.html, .php or no extension) whose URL carries a
 * platform click id (CLICK_ID_PARAMS: ref_id, ext_click_id, gclid, wbraid,
 * gbraid, fbclid, ttclid, tbclid, snclid, msclkid…) is sent, after the
 * response, as event "click" — the same fields the sites' own click events
 * have in tracking.dot_events: site (the host), lander (the path), url,
 * referrer, ip, user_agent, sub1…sub11 (dot maps them to campaign/adgroup/ad
 * names and ids, placement, platform, device, network), cid (the cmpid),
 * rtkcid, ext_click_id (the first click id found), wbraid/gbraid, the
 * visitor's dotid when there is one (the dot.js cookie or ?dotid=), and
 * _metadata: the request headers and cookies (like the sites send), every
 * click id found, and what this server did with the click (dayone_pages: the
 * hit id, the decision, the rule that caught it, the funnel, the page served,
 * why it didn't go to the funnel, country, ASN…).
 *
 * The www entry redirect isn't sent: the same click comes right back on the
 * bare domain and is sent then. Nor is a prefetch (request_is_prefetch): the
 * page loaded ahead of a click is not a click.
 *
 * A real click on a PRE-LANDER page (a slug outside PRE_LANDER_STANDARD_SLUGS —
 * the home and the legal pages —, served 200, clean, with a click id) carries
 * no dot.js, so the server sends its page_view itself: the SAME click fields as
 * event `page_view`, origin `pre_lander`. The click event is left exactly as it
 * was (no origin). Nothing is added to the HTML. A rule-caught click sends only
 * the click. A duplicate page_view is harmless — dot doesn't count the
 * server-side one in its funnel maths.
 *
 * Nobody waits: it runs after the response,
 * with a timeout above dot's own (DOT_TIMEOUT, 8 s: dot gives its database
 * write up to 4 s, and a slow answer is still a queued click); a click dot
 * didn't queue (no answer, or a 5xx) is sent again 1 s and 4 s later
 * (DOT_TRY_WAITS). One that still failed is not lost: it waits in the spool
 * (cache/dot-spool.jsonl, with its own timestamp, so dot records it at the
 * click's time) and goes again after a later response, at most once a minute
 * (dot_spool_replay) — dot's outages (PGRST002 while PostgREST reloads its
 * schema cache, connections exhausted) have lasted up to 20 minutes. Only a
 * click given up (over a day old, or refused for good) goes to the log. DOT_CLICKS=0
 * turns it off (tests and local runs must never feed the real tracker).
 */
declare(strict_types=1);

defined('DAYONE_ENTRY') || (http_response_code(404) && exit);

/**
 * URL parameters that are a platform's click id, in the order the first one
 * found becomes ext_click_id (dot's own order first: ext_click_id, gclid,
 * wbraid, gbraid, fbclid, ttclid, tclid … ref_id last). Matched case-insensitively.
 */
const CLICK_ID_PARAMS = [
    'ext_click_id',                    // generic (trackers)
    'gclid', 'wbraid', 'gbraid', 'dclid', // Google Ads
    'fbclid',                          // Meta
    'ttclid', 'tclid',                 // TikTok
    'tbclid', 'tblci',                 // Taboola
    'snclid', 'sccid',                 // Snapchat (ScCid)
    'msclkid',                         // Microsoft Ads
    'twclid',                          // X
    'li_fat_id',                       // LinkedIn
    'epik',                            // Pinterest
    'rdt_cid',                         // Reddit
    'qclid',                           // Quora
    'obclid', 'dicbo',                 // Outbrain
    'yclid',                           // Yandex
    'nbclid',                          // NewsBreak
    'kwai_click_id',                   // Kwai
    'click_id', 'clickid',             // generic (networks)
    'ref_id',                          // generic (dot's last fallback)
];

/** The click ids in the query: lowercase name → value (non-empty), in CLICK_ID_PARAMS order. */
function dot_click_ids(array $query): array
{
    $lower = [];
    foreach ($query as $k => $v) {
        if (is_string($k) && is_scalar($v) && trim((string) $v) !== '') {
            $lower[strtolower($k)] ??= mb_substr(trim((string) $v), 0, 1000);
        }
    }
    $ids = [];
    foreach (CLICK_ID_PARAMS as $name) {
        if (isset($lower[$name])) {
            $ids[$name] = $lower[$name];
        }
    }
    return $ids;
}

/**
 * The home and the legal pages: a click landing on one of these is NOT a
 * pre-lander. Every OTHER slug — served, clean, with a click id — is a
 * pre-lander page (an advertorial/presell the ad points to before the lander).
 */
const PRE_LANDER_STANDARD_SLUGS = ['/', '/contact', '/disclaimer', '/privacy-policy', '/refund-policy', '/shipping', '/terms-of-use'];

/**
 * 'pre_lander' when this request is a real click on a pre-lander page, else
 * null. A pre-lander is a slug outside PRE_LANDER_STANDARD_SLUGS, served 200 as
 * a plain page (not a funnel page the gate served — that one has dot.js), that
 * no rule caught. The caller has already required a click id and ruled out a
 * prefetch. When it is one, the server sends a page_view marked `origin:
 * pre_lander` — the page has no dot.js to send it, and nothing is added to the
 * HTML. The click event itself is left unchanged (no origin).
 */
function dot_pre_lander_origin(string $path, int $status, array $route): ?string
{
    if ($status !== 200) {
        return null; // only a page actually served (200) is a page view
    }
    if (($route['match_type'] ?? '') === GATE_MATCH) {
        return null; // a funnel page the gate served: it already has dot.js (origin lander)
    }
    if (in_array($path, PRE_LANDER_STANDARD_SLUGS, true)) {
        return null; // the home or a legal page: not a pre-lander
    }
    $label = $route['_rule_label'] ?? null;
    if (is_string($label) && $label !== '') {
        return null; // a rule caught it (datacenter, crawler, suspicious…): not a real click
    }
    return 'pre_lander';
}

/**
 * The dot payload for this request, or null when it isn't sent (no click id,
 * not a page, the www entry redirect, a prefetch). $ctx: what the server did —
 * hit_id, domain_id, outcome, status, route, visit_id, asn, as_name, hostname.
 * A real click on a pre-lander page is marked `origin: pre_lander` (dot_pre_lander_origin).
 */
function dot_click_payload(Request $req, array $ctx, array $server): ?array
{
    // A prefetch isn't a click (most are never clicked), and dot keeps the
    // first event of a click id: sent, it would stand for the real click that
    // may come after it.
    if (!is_logged_path($req->path) || $req->prefetch) {
        return null;
    }
    $route = is_array($ctx['route'] ?? null) ? $ctx['route'] : null;
    if (($route['match_type'] ?? '') === 'WWW') {
        return null;
    }
    $query = [];
    parse_str($req->rawQuery, $query);
    $ids = dot_click_ids($query);
    if ($ids === []) {
        return null;
    }
    $q = static function (string $key) use ($query): ?string {
        $v = $query[$key] ?? null;
        return is_scalar($v) && trim((string) $v) !== '' ? mb_substr(trim((string) $v), 0, 1000) : null;
    };

    $host = visited_host($req);
    $scheme = str_contains((string) ($server['HTTP_CF_VISITOR'] ?? ''), '"http"') ? 'http' : 'https';
    $url = $scheme . '://' . $host . $req->rawPath . ($req->rawQuery !== '' ? '?' . $req->rawQuery : '');

    // The request's headers, like the sites send them (the cookies go apart).
    $headers = [];
    foreach ($server as $k => $v) {
        if (is_string($k) && str_starts_with($k, 'HTTP_') && is_scalar($v) && $k !== 'HTTP_COOKIE' && $k !== 'HTTP_AUTHORIZATION') {
            $headers[strtolower(str_replace('_', '-', substr($k, 5)))] = mb_substr((string) $v, 0, 2000);
        }
    }
    ksort($headers);
    $cookieHeader = (string) ($server['HTTP_COOKIE'] ?? '');

    // The visitor's dotid (dot.js keeps it in a cookie of the site, or it comes as ?dotid=).
    $dotid = $q('dotid') ?? (is_string($req->cookies['dotid'] ?? null) ? $req->cookies['dotid'] : null);
    if ($dotid !== null && preg_match('/^[0-9a-f]{8}-[0-9a-f]{8}-[0-9a-f]{8}-\d{8}$/', $dotid) !== 1) {
        $dotid = null;
    }

    $str = static fn (mixed $v): ?string => is_string($v) && $v !== '' ? $v : null;
    $time = (float) ($server['REQUEST_TIME_FLOAT'] ?? microtime(true));

    $payload = [
        'event' => 'click',
        'site' => $host,
        'lander' => $req->path,
        'url' => mb_substr($url, 0, 4000),
        'referrer' => $req->referer !== '' ? mb_substr($req->referer, 0, 2000) : null,
        'ip' => $req->ip !== '' ? $req->ip : null,
        'user_agent' => $req->userAgent !== '' ? $req->userAgent : null,
        'timestamp' => gmdate('Y-m-d\TH:i:s', (int) $time) . sprintf('.%03dZ', (int) (($time - floor($time)) * 1000)),
        'cid' => $q('cmpid') ?? $q('cid'),
        'rtkcid' => $q('rtkcid'),
        'ext_click_id' => reset($ids),
        'wbraid' => $ids['wbraid'] ?? null,
        'gbraid' => $ids['gbraid'] ?? null,
        'dotid' => $dotid,
        // The funnel page the gate served (the split's pick) and the VSL video drawn for this response.
        'page_id' => ($route['match_type'] ?? '') === GATE_MATCH ? $str($route['page_id'] ?? null) : null,
        'video_id' => $str($route['_video'] ?? null),
    ];
    foreach (['sub1', 'sub2', 'sub3', 'sub4', 'sub5', 'sub6', 'sub7', 'sub8', 'sub9', 'sub10', 'sub11'] as $sub) {
        $payload[$sub] = $q($sub);
    }
    $payload['_metadata'] = (string) json_encode([
        'headers' => $headers,
        'cookies' => $cookieHeader !== '' ? mb_substr($cookieHeader, 0, 4000) : null,
        'click_ids' => $ids,
        'dayone_pages' => [
            'hit_id' => is_int($ctx['hit_id'] ?? null) ? $ctx['hit_id'] : null,
            'domain_id' => $str($ctx['domain_id'] ?? null),
            'outcome' => $str($ctx['outcome'] ?? null),
            'status' => is_int($ctx['status'] ?? null) ? $ctx['status'] : null,
            'decision' => hit_decision($route),
            'sent_to_funnel' => ($route['match_type'] ?? '') === GATE_MATCH,
            'funnel' => $str($route['_funnel'] ?? null),
            'page_id' => $str($route['page_id'] ?? null),
            'video_id' => $str($route['_video'] ?? null),
            'slug' => $str($route['slug'] ?? null),
            'gate_reason' => $str($route['_gate_reason'] ?? null),
            'rule_label' => $str($route['_rule_label'] ?? null),
            'rule' => $str($route['_rule'] ?? null),
            'rule_reason' => $str($route['_rule_reason'] ?? null),
            'rule_tags' => is_array($route['_rule_tags'] ?? null) ? array_values($route['_rule_tags']) : [],
            'visit_id' => $str($ctx['visit_id'] ?? null),
            'country' => $req->country !== '' ? $req->country : null,
            'region' => $str($server['HTTP_CF_REGION'] ?? null),
            'device' => device_from_ua($req->userAgent),
            'accept_language' => $req->acceptLanguage !== '' ? $req->acceptLanguage : null,
            'asn' => is_int($ctx['asn'] ?? null) ? $ctx['asn'] : null,
            'as_name' => $str($ctx['as_name'] ?? null),
            'hostname' => $str($ctx['hostname'] ?? null),
        ],
    ], JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE | JSON_INVALID_UTF8_SUBSTITUTE);

    return array_filter($payload, static fn ($v) => $v !== null);
}

/**
 * Seconds to wait before each try. A click dot didn't queue gets two more tries,
 * 1 s and then 4 s later: the database blips seen so far (PGRST002 while the
 * schema cache reloads) lasted up to 5 s.
 */
const DOT_TRY_WAITS = [0, 1, 4];

/**
 * What one try's answer means: ['ok' => dot queued the click, 'retry' => worth
 * another try, 'why' => for the log]. Worth another try: no answer (curl gave
 * up — the timeout, a connection error) or a 5xx (dot's 503: its own write to
 * the database failed, "Retry-After: 1"). A 4xx, or a 200 with success false
 * (dot couldn't read the body), won't get better by sending it again.
 */
function dot_outcome(int $status, string|false $raw, string $curlError = ''): array
{
    if ($raw !== false && $status === 200 && (json_decode($raw, true)['success'] ?? false) === true) {
        return ['ok' => true, 'retry' => false, 'why' => ''];
    }
    if ($raw === false || $status === 0) {
        return ['ok' => false, 'retry' => true, 'why' => 'HTTP 0: ' . ($curlError !== '' ? $curlError : 'no answer')];
    }
    return ['ok' => false, 'retry' => $status >= 500, 'why' => "HTTP $status: " . mb_substr(preg_replace('/\s+/', ' ', $raw) ?? '', 0, 200)];
}

/**
 * Sends the click with $try() (one POST → dot_outcome()), trying again after
 * DOT_TRY_WAITS while it's worth it. A try that timed out may still have been
 * queued, so a click can reach dot twice — harmless: dot keeps only the first
 * click event of a click id. Null once dot queued it, else ['tries', 'why',
 * 'retry'] of the last failure (retry: worth sending again later).
 */
function dot_deliver(callable $try, ?callable $sleep = null): ?array
{
    $sleep ??= static fn (int $seconds) => sleep($seconds);
    $tries = 0;
    foreach (DOT_TRY_WAITS as $wait) {
        if ($wait > 0) {
            $sleep($wait);
        }
        $tries++;
        $r = $try();
        if ($r['ok']) {
            return null;
        }
        if (!$r['retry']) {
            break;
        }
    }
    return ['tries' => $tries, 'why' => $r['why'], 'retry' => $r['retry']];
}

/** The page_view a pre-lander sends: the click's own fields, as event page_view, marked with the origin. */
function dot_page_view(array $click, string $origin): array
{
    $click['event'] = 'page_view';
    $click['origin'] = $origin;
    return $click;
}

/** Sends this request's events to dot (after the response): the click as always, plus a pre-lander's page_view. */
function dot_click(Request $req, array $ctx, ?array $server = null): void
{
    $cfg = config();
    if (!$cfg['dot_clicks'] || $cfg['dot_url'] === '') {
        return;
    }
    $payload = dot_click_payload($req, $ctx, $server ?? $_SERVER);
    if ($payload === null) {
        return;
    }
    dot_send($payload); // the click, unchanged
    // A real click on a pre-lander page (served 200, clean, a non-standard slug):
    // the page carries no dot.js, so the server sends its page_view too — nothing
    // is added to the HTML and the click is untouched. A duplicate is harmless:
    // dot doesn't count the server-side page_view in its funnel maths.
    $route = is_array($ctx['route'] ?? null) ? $ctx['route'] : [];
    $origin = dot_pre_lander_origin($req->path, (int) ($ctx['status'] ?? 0), $route);
    if ($origin !== null) {
        dot_send(dot_page_view($payload, $origin));
    }
}

/** Sends one event to dot (a click or a page_view), with the retries and, on failure, the spool. */
function dot_send(array $payload): void
{
    $body = json_encode($payload, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE | JSON_INVALID_UTF8_SUBSTITUTE);
    if ($body === false) {
        return;
    }
    // One handle for every try: a retry reuses the open connection.
    $ch = dot_curl($body);
    $failed = dot_deliver(static fn (): array => dot_curl_try($ch));
    if ($failed !== null) {
        if ($failed['retry'] && dot_spool($body)) {
            return; // not lost: it goes again from the spool
        }
        error_log('[dayone-pages] dot ' . ($payload['event'] ?? 'event') . ' failed after ' . $failed['tries'] . ' tries (' . $failed['why'] . ')');
    }
}

/** A POST of $body to dot, ready to send (and send again). */
function dot_curl(string $body): \CurlHandle
{
    $cfg = config();
    $ch = curl_init($cfg['dot_url']);
    curl_setopt_array($ch, [
        CURLOPT_POST => true,
        CURLOPT_POSTFIELDS => $body,
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_CONNECTTIMEOUT => 2,
        CURLOPT_TIMEOUT => max(2, (int) $cfg['dot_timeout']),
        CURLOPT_HTTPHEADER => ['Content-Type: application/json', 'User-Agent: dayone-pages/dot'],
    ]);
    return $ch;
}

/** One try of a prepared POST → dot_outcome(). */
function dot_curl_try(\CurlHandle $ch): array
{
    $raw = curl_exec($ch);
    return dot_outcome((int) curl_getinfo($ch, CURLINFO_RESPONSE_CODE), is_string($raw) ? $raw : false, curl_error($ch));
}

// ── The spool: clicks dot didn't take, sent again later ──────────────────────

/** One JSON per line: {"at": when it was spooled, "body": the click as sent}. */
const DOT_SPOOL_FILE = 'dot-spool.jsonl';
/** A click older than this is given up (dot ties a click's page events within a day). */
const DOT_SPOOL_MAX_AGE = 86400;
/** Send the spool again at most this often (seconds), and at most this many clicks at a time. */
const DOT_SPOOL_EVERY = 60;
const DOT_SPOOL_BATCH = 300;

function dot_spool_path(): string
{
    return cache_dir() . '/' . DOT_SPOOL_FILE;
}

/** Keeps a click dot didn't take for dot_spool_replay. False when it can't be kept (no writable cache). */
function dot_spool(string $body, ?int $now = null): bool
{
    if (!cache_writable()) {
        return false;
    }
    $line = json_encode(['at' => $now ?? time(), 'body' => $body], JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE | JSON_INVALID_UTF8_SUBSTITUTE);
    return $line !== false && @file_put_contents(dot_spool_path(), $line . "\n", FILE_APPEND | LOCK_EX) !== false;
}

/**
 * Sends the spooled clicks again (after a response; one process at a time, at
 * most every DOT_SPOOL_EVERY seconds). Stops at the first one dot still can't
 * take — it's still down, the rest wait for the next round — and gives up a
 * click over DOT_SPOOL_MAX_AGE, or one dot refuses for good (a 4xx). $send
 * (body → dot_outcome) is the tests' stand-in for the POST.
 *
 * @return array{sent: int, kept: int, dropped: int}|null  null = nothing to do now
 */
function dot_spool_replay(?callable $send = null, ?int $now = null): ?array
{
    $now ??= time();
    $path = dot_spool_path();
    $mark = cache_dir() . '/dot-spool.replay';
    clearstatcache(true, $path);
    if (!is_file($path) || (int) @filesize($path) === 0 || $now - (int) @filemtime($mark) < DOT_SPOOL_EVERY) {
        return null;
    }
    $fh = @fopen($path, 'c+');
    if ($fh === false) {
        return null;
    }
    if (!flock($fh, LOCK_EX | LOCK_NB)) {
        fclose($fh);
        return null;
    }
    @touch($mark, $now);
    $send ??= static fn (string $body): array => dot_curl_try(dot_curl($body));
    $keep = [];
    $sent = 0;
    $dropped = 0;
    $down = false;
    while (($line = fgets($fh)) !== false) {
        $item = json_decode($line, true);
        if (!is_array($item) || !is_string($item['body'] ?? null) || !is_int($item['at'] ?? null)) {
            continue;
        }
        if ($now - $item['at'] > DOT_SPOOL_MAX_AGE) {
            $dropped++;
            continue;
        }
        if ($down || $sent >= DOT_SPOOL_BATCH) {
            $keep[] = rtrim($line, "\n");
            continue;
        }
        $r = $send($item['body']);
        if ($r['ok']) {
            $sent++;
        } elseif ($r['retry']) {
            $down = true;
            $keep[] = rtrim($line, "\n");
        } else {
            $dropped++;
            error_log('[dayone-pages] dot refused a spooled click (' . $r['why'] . ')');
        }
    }
    ftruncate($fh, 0);
    rewind($fh);
    if ($keep !== []) {
        fwrite($fh, implode("\n", $keep) . "\n");
    }
    fflush($fh);
    flock($fh, LOCK_UN);
    fclose($fh);
    if ($dropped > 0) {
        error_log("[dayone-pages] dot spool: $dropped click(s) given up (over a day old, or refused)");
    }
    return ['sent' => $sent, 'kept' => count($keep), 'dropped' => $dropped];
}
