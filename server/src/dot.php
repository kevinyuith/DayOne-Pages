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
 * bare domain and is sent then. Nobody waits: it runs after the response,
 * with a short timeout, and a failure only goes to the log. DOT_CLICKS=0
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
 * The dot payload for this request, or null when it isn't sent (no click id,
 * not a page, the www entry redirect). $ctx: what the server did — hit_id,
 * domain_id, outcome, status, route, visit_id, asn, as_name, hostname.
 */
function dot_click_payload(Request $req, array $ctx, array $server): ?array
{
    if (!is_logged_path($req->path)) {
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

/** Sends this request's click to dot (after the response). Only the log hears about a failure. */
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
    $body = json_encode($payload, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE | JSON_INVALID_UTF8_SUBSTITUTE);
    if ($body === false) {
        return;
    }
    $ch = curl_init($cfg['dot_url']);
    curl_setopt_array($ch, [
        CURLOPT_POST => true,
        CURLOPT_POSTFIELDS => $body,
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_CONNECTTIMEOUT => 2,
        CURLOPT_TIMEOUT => max(2, (int) $cfg['dot_timeout']),
        CURLOPT_HTTPHEADER => ['Content-Type: application/json', 'User-Agent: dayone-pages/dot'],
    ]);
    $raw = curl_exec($ch);
    $status = (int) curl_getinfo($ch, CURLINFO_RESPONSE_CODE);
    $ok = $raw !== false && $status === 200 && (json_decode((string) $raw, true)['success'] ?? false) === true;
    if (!$ok) {
        error_log('[dayone-pages] dot click failed (HTTP ' . $status . '): ' . mb_substr(preg_replace('/\s+/', ' ', (string) $raw) ?? '', 0, 200));
    }
}
