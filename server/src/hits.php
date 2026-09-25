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
 * and, if it was an HTML page, the visit id of the load notice (beacon.php).
 * Turned on/off by LOG_HITS (config).
 */
declare(strict_types=1);

defined('DAYONE_ENTRY') || (http_response_code(404) && exit);

function log_hit(Request $req, int $status, string $outcome, ?string $domainId, ?array $route = null, ?string $redirectUrl = null, ?string $visitId = null, string $rawQuery = ''): void
{
    if (!config()['log_hits'] || !is_logged_path($req->path)) {
        return;
    }

    $referrerHost = '';
    if ($req->referer !== '') {
        $referrerHost = (string) (parse_url($req->referer, PHP_URL_HOST) ?? '');
    }

    $asn = asn_lookup($req->ip);

    supabase_log_hit([
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
        'p_hostname'      => reverse_dns($req->ip),
        'p_asn'           => $asn['asn'] ?? null,
        'p_as_name'       => $asn['name'] ?? null,
        // Straight from $_SERVER: the Request doesn't keep these headers.
        'p_cookies'       => (string) ($_SERVER['HTTP_COOKIE'] ?? ''),
        // Cloudflare's "Add visitor location headers" Managed Transform; the database only stores it if country = US.
        'p_region'        => (string) ($_SERVER['HTTP_CF_REGION'] ?? ''),
        'p_user_agent'    => $req->userAgent,
        'p_route_id'      => $route['route_id'] ?? null,
        'p_page_id'       => $route['page_id'] ?? null,
        'p_slug'          => $route['slug'] ?? null,
        'p_decision'      => hit_decision($route),
        'p_redirect_url'  => $redirectUrl,
        'p_visit_id'      => $visitId,
        // The gate: the detection (label, rule, tags) and the funnel the clean click went to (tracker data).
        'p_rule_label'    => is_string($route['_rule_label'] ?? null) ? $route['_rule_label'] : null,
        'p_rule'          => is_string($route['_rule'] ?? null) ? $route['_rule'] : null,
        'p_rule_tags'     => is_array($route['_rule_tags'] ?? null) ? array_values($route['_rule_tags']) : null,
        'p_funnel'        => is_string($route['_funnel'] ?? null) ? $route['_funnel'] : null,
    ]);
}

/** "SERVE · FALLBACK", "BLOCK · BOTGATE", "REDIRECT · PREFIX"…; "NONE" when no route matched. */
function hit_decision(?array $route): string
{
    if ($route === null) {
        return 'NONE';
    }
    $parts = array_filter([(string) ($route['action'] ?? ''), (string) ($route['match_type'] ?? '')], fn (string $p) => $p !== '');
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
 * PTR of the IP, or null. gethostbyaddr takes no timeout: a PTR that doesn't
 * answer holds the FPM worker for a few seconds (the visitor doesn't wait, the
 * response is already gone).
 */
function reverse_dns(string $ip): ?string
{
    if (filter_var($ip, FILTER_VALIDATE_IP) === false) {
        return null;
    }
    $host = @gethostbyaddr($ip);
    return is_string($host) && $host !== $ip ? $host : null;
}

/**
 * ASN of the IP from Team Cymru, over DNS TXT (no key, no dependency):
 * origin(6).asn.cymru.com gives the number, AS<n>.asn.cymru.com gives the name.
 *
 * @return array{asn:int, name:?string}|null
 */
function asn_lookup(string $ip): ?array
{
    $zone = cymru_origin_name($ip);
    $asn = $zone === null ? null : parse_cymru_origin(dns_txt($zone));
    if ($asn === null) {
        return null;
    }
    return ['asn' => $asn, 'name' => parse_cymru_as_name(dns_txt("AS$asn.asn.cymru.com"))];
}

/** 8.8.8.8 → 8.8.8.8.origin.asn.cymru.com (reversed octets); IPv6 → reversed nibbles in origin6. Private/reserved IP → null. */
function cymru_origin_name(string $ip): ?string
{
    if (filter_var($ip, FILTER_VALIDATE_IP, FILTER_FLAG_NO_PRIV_RANGE | FILTER_FLAG_NO_RES_RANGE) === false) {
        return null;
    }
    if (filter_var($ip, FILTER_VALIDATE_IP, FILTER_FLAG_IPV4) !== false) {
        return implode('.', array_reverse(explode('.', $ip))) . '.origin.asn.cymru.com';
    }
    return implode('.', str_split(strrev(bin2hex((string) inet_pton($ip))))) . '.origin6.asn.cymru.com';
}

function dns_txt(string $name): ?string
{
    $records = @dns_get_record($name, DNS_TXT);
    return is_array($records) && isset($records[0]['txt']) ? (string) $records[0]['txt'] : null;
}

/** "15169 | 8.8.8.0/24 | US | arin | 2023-12-28" → 15169. Prefix with more than one ASN ("15169 36040") → the first. */
function parse_cymru_origin(?string $txt): ?int
{
    if ($txt === null || preg_match('/^\s*(\d+)/', $txt, $m) !== 1) {
        return null;
    }
    $asn = (int) $m[1];
    return $asn > 0 ? $asn : null;
}

/** "15169 | US | arin | 2000-03-30 | GOOGLE - Google LLC, US" → "GOOGLE - Google LLC, US". */
function parse_cymru_as_name(?string $txt): ?string
{
    $name = trim(explode('|', (string) $txt)[4] ?? '');
    return $name !== '' ? $name : null;
}
