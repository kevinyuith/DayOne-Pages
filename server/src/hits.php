<?php
/**
 * Traffic log: builds a hit's payload and sends it to Supabase.
 *
 * Called by app.php AFTER the response has gone out
 * (fastcgi_finish_request), so the visitor never waits for this. It's
 * fire-and-forget: any error only goes to the log.
 *
 * What it stores (one row per page request: .html, .php or no extension):
 * host, path and raw query, outcome, status, country (CF-IPCountry), state if US (cf-region),
 * device and bot (from the User-Agent), referrer host, IP, hostname (reverse
 * DNS of the IP), ASN, raw User-Agent and Cookie header, the route that decided
 * (route, page, slug, decision), the final URL (Location) if it was a redirect
 * and, if it was an HTML page, the visit id of the load notice (beacon.php),
 * the registry delegation of the IP's block (ip_block, rirdb.php) and whether
 * the IP is a known VPN/Tor/ISP proxy, relay or hosting network (anondb.php).
 * When the device checkpoint is on (eval.php), the decision gains its mark:
 * " · EVAL" (the interstitial page itself) or " · EVAL-PREFETCH" (a prefetch
 * skipped it and stayed on the domain's page).
 * Turned on/off by LOG_HITS (config).
 */
declare(strict_types=1);

defined('DAYONE_ENTRY') || (http_response_code(404) && exit);

/**
 * Returns what it learned, for the click event that goes after it (dot.php):
 * the hit's id and the network lookups (asn, as_name, hostname); [] when
 * nothing was logged.
 *
 * @return array{hit_id?: ?int, asn?: ?int, as_name?: ?string, hostname?: ?string}
 */
function log_hit(Request $req, int $status, string $outcome, ?string $domainId, ?array $route = null, ?string $redirectUrl = null, ?string $visitId = null, string $rawQuery = '', ?array $gate = null): array
{
    if (!config()['log_hits'] || !is_logged_path($req->path)) {
        return [];
    }

    $referrerHost = '';
    if ($req->referer !== '') {
        $referrerHost = (string) (parse_url($req->referer, PHP_URL_HOST) ?? '');
    }

    // The hit is written right away (a load notice can come right behind it) with
    // what the per-IP cache already knows (a rule may have looked it up); the
    // ASN/hostname lookups come after, into the same hit (log_hit_net).
    $known = netinfo_known($req->ip);
    // Local tables, no network: who owns the IP's block (rirdb.php) and whether it's a known anonymizer (anondb.php).
    $block = ip_block($req->ip, $known['asn']);
    $anon = anon_classify($req->ip, $known['asn'], $block);

    $id = supabase_log_hit([
        'p_domain'        => $domainId,
        'p_host'          => visited_host($req),
        'p_path'          => $req->path,
        'p_query'         => $req->rawQuery,
        'p_outcome'       => $outcome,
        'p_status'        => $status,
        'p_country'       => $req->country,
        'p_device'        => device_from_ua($req->userAgent),
        // Nothing is detected in code: a click is "bot" only when a rule labeled Bot caught it.
        'p_is_bot'        => strcasecmp((string) ($route['_rule_label'] ?? ''), 'Bot') === 0,
        'p_referrer_host' => $referrerHost,
        'p_ip'            => $req->ip,
        'p_hostname'      => $known['hostname'],
        'p_asn'           => $known['asn'],
        'p_as_name'       => $known['as_name'],
        // Straight from $_SERVER: the Request doesn't keep these headers.
        'p_cookies'       => (string) ($_SERVER['HTTP_COOKIE'] ?? ''),
        // Cloudflare's "Add visitor location headers" Managed Transform; the database only stores it if country = US.
        'p_region'        => (string) ($_SERVER['HTTP_CF_REGION'] ?? ''),
        'p_user_agent'    => $req->userAgent,
        'p_accept_language' => $req->acceptLanguage !== '' ? $req->acceptLanguage : null,
        'p_route_id'      => $route['route_id'] ?? null,
        // The checkpoint's interstitial (eval.php) carries the split's FIRST page only as a placeholder: no page was served or drawn yet.
        'p_page_id'       => ($route['_eval'] ?? null) === 'checkpoint' ? null : ($route['page_id'] ?? null),
        'p_slug'          => $route['slug'] ?? null,
        'p_decision'      => hit_decision($route),
        'p_redirect_url'  => $redirectUrl,
        'p_visit_id'      => $visitId,
        // The gate: the detection (label, rule, reason, tags) and the funnel the clean click went to (tracker data).
        'p_rule_label'    => is_string($route['_rule_label'] ?? null) ? $route['_rule_label'] : null,
        'p_rule'          => is_string($route['_rule'] ?? null) ? $route['_rule'] : null,
        'p_rule_reason'   => is_string($route['_rule_reason'] ?? null) && $route['_rule_reason'] !== '' ? $route['_rule_reason'] : null,
        'p_rule_tags'     => is_array($route['_rule_tags'] ?? null) ? array_values($route['_rule_tags']) : null,
        'p_funnel'        => is_string($route['_funnel'] ?? null) ? $route['_funnel'] : null,
        // Why a clean click got the domain's page instead of the funnel (rules.php, GATE_REASONS).
        'p_gate_reason'   => in_array($route['_gate_reason'] ?? null, GATE_REASONS, true) ? $route['_gate_reason'] : null,
        // The device fingerprint (eval.php): the checkpoint POST's signals, structured. Only the POST's hit has it.
        'p_device_fingerprint' => is_array($req->deviceFingerprint ?? null) ? $req->deviceFingerprint : null,
        // Who the IP's block was delegated to, and how that owner relates to the AS that routes it (rirdb.php, local table).
        'p_ip_block'      => $block,
        // A known VPN, Tor exit or ISP proxy (is_vpn), or a relay/hosting network, and whose (anondb.php). null = no table.
        'p_is_vpn'        => $anon['is_vpn'] ?? null,
        'p_vpn_kind'      => $anon['kind'] ?? null,
        'p_vpn_name'      => $anon['name'] ?? null,
    ]);

    $learned = ['hit_id' => $id, 'asn' => $known['asn'], 'as_name' => $known['as_name'], 'hostname' => $known['hostname']];
    if ($id === null) {
        return $learned;
    }

    // The ASN/hostname, resolved now (after the response) when the per-IP cache
    // didn't already have them. The ASN is a local-table lookup; the hostname a
    // reverse DNS, cached per IP.
    $asn = $known['asn'];
    $asName = $known['as_name'];
    $hostname = $known['hostname'];
    if (!$known['complete']) {
        $look = asn_lookup($req->ip);
        $asn = $look['asn'] ?? null;
        $asName = $look['name'] ?? null;
        $hostname = reverse_dns($req->ip);
    }

    // Shadow evaluation: EVERY Bot rule whose conditions match this click, not
    // just the one gate_pick served on. Run here, with the network lookups
    // already done, so the two hostname Bot rules reuse the cached PTR and
    // nothing new goes to the network. Stored as rule_matches, to see which
    // clicks each rule would catch instead of only the one that won the walk.
    $matches = $gate !== null ? gate_bot_rules_matched($gate, $req) : [];

    $netChanged = $asn !== $known['asn'] || $asName !== $known['as_name'] || $hostname !== $known['hostname'];
    if ($netChanged || $matches !== []) {
        supabase_log_hit_net($id, $asn, $asName, $hostname, $matches !== [] ? $matches : null);
    }
    return ['hit_id' => $id, 'asn' => $asn, 'as_name' => $asName, 'hostname' => $hostname];
}

/**
 * "SERVE · FALLBACK", "BLOCK · BOTGATE", "REDIRECT · PREFIX"…; "NONE" when no
 * route matched. A funnel's step switch (the reload that carries `dop_step`,
 * see funnel.php) ends in " · STEP": the same visit, not a new one — the
 * Funnel screen doesn't count it as another view. The device checkpoint
 * (eval.php) adds " · EVAL" (the interstitial was served) or
 * " · EVAL-PREFETCH" (a prefetch skipped it, on the domain's page).
 */
function hit_decision(?array $route): string
{
    if ($route === null) {
        return 'NONE';
    }
    $parts = array_filter([
        (string) ($route['action'] ?? ''),
        (string) ($route['match_type'] ?? ''),
        !empty($route['_step']) ? 'STEP' : '',
        ($route['_eval'] ?? null) === 'checkpoint' ? 'EVAL' : (($route['_eval'] ?? null) === 'prefetch' ? 'EVAL-PREFETCH' : ''),
    ], fn (string $p) => $p !== '');
    return implode(' · ', $parts);
}

/**
 * Host as the visitor accessed it ("www.x.com" keeps the www), without port or
 * trailing dot. $req->host is the normalized one (no www), used to find the domain.
 */
function visited_host(Request $req): string
{
    $host = rtrim(strtolower(trim(explode(':', $req->rawHost, 2)[0])), '.');
    return $host !== '' ? $host : $req->host;
}

/** Pages only: .html, .php or a last segment without a dot ("/", "/offer"). Files and probes (.js, .env, .json…) are left out. */
function is_logged_path(string $path): bool
{
    return preg_match('~(\.(html|php)|/[^/.]*)$~i', $path) === 1;
}

/**
 * PTR of the IP, or null (netinfo.php: a DNS query with a timeout, cached per
 * IP — a rule may have looked it up already, before the response).
 */
function reverse_dns(string $ip): ?string
{
    $host = netinfo_hostname($ip, NETINFO_LOG_TIMEOUT_MS);
    return $host !== null && $host !== '' ? $host : null;
}

/**
 * ASN of the IP from Team Cymru, over DNS TXT (netinfo.php, cached per IP):
 * origin(6).asn.cymru.com gives the number, AS<n>.asn.cymru.com gives the name.
 *
 * @return array{asn:int, name:?string}|null
 */
function asn_lookup(string $ip): ?array
{
    $asn = netinfo_asn($ip, NETINFO_LOG_TIMEOUT_MS);
    return $asn ? ['asn' => $asn, 'name' => netinfo_as_name($ip, NETINFO_LOG_TIMEOUT_MS)] : null;
}
