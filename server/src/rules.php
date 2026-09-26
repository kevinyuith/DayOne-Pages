<?php
/**
 * The traffic gate, on every path: the rules DETECT bad traffic, and a clean
 * click on an allowed slug goes to the funnel of its sub1.
 *
 * The resolve fused the gate's data in its `gate` column: the active rules in
 * walk order, the domain's gate_slugs and every funnel's code + A/B split — no
 * HTML, only content hashes, so the decision is made here, per request,
 * without going back to Supabase.
 *
 * decide() calls this before the domain's routes. The domain's status
 * (pages.domains.status, in the gate data) comes first: DISABLED answers 404
 * to every slug (the domain serves nothing; the rules don't run); LOCKED
 * runs the rules but no slug is allowed — a clean click always gets the
 * domain's page, never the funnel; UNLOCKED ignores the rules and the
 * gate_slugs — every slug goes straight to the sub1's [F…] funnel (404 when
 * the token is missing or the funnel has no live page). ACTIVE is the
 * behavior below.
 *
 * The rules walk: the first one whose conditions ALL match marks the click
 * with the rule's LABEL and it gets the domain's page at the requested slug.
 * No match (clean traffic) and the slug is allowed ("/" or a gate_slug) → the
 * sub1's [F…] token names the funnel, whose split decides the page (sticky
 * dop_pg). Any other slug → the domain's page at that slug (404 when no page
 * has it). "/" is just a gate_slug like the others: take it out of the list
 * and the root stays on the safe page. Nothing is detected in code:
 * bot/suspicious are the rules you write.
 *
 * The conditions are the hit log's fields (rule_conditions_match): the click's
 * sub ids (sub1, sub11), ANY URL parameter (param), country, device, language,
 * referrer, URL parameters (via conditions_match), a regex on the User-Agent,
 * the IP (IPs/CIDR ranges), and — network lookups, checked last and only when
 * everything else matched — the ASN and a regex on the hostname (netinfo.php:
 * a short timeout, cached per IP; a lookup that fails never flags a click).
 */
declare(strict_types=1);

defined('DAYONE_ENTRY') || (http_response_code(404) && exit);

/** Match types for the traffic log (hit_decision). */
const GATE_MATCH = 'GATE';
const GATE_SAFE_MATCH = 'GATE-SAFE';

/** Why a click didn't go to a funnel (pages.hits.gate_reason): by the slug/sub1, or by the domain's status. */
const GATE_REASONS = ['slug_not_allowed', 'no_funnel_token', 'funnel_not_live', 'domain_disabled', 'domain_locked', 'domain_unlocked'];

/** The rule-only condition keys (the base ones are conditions_match's). */
const RULE_OWN_CONDITIONS = ['sub1', 'sub11', 'param', 'user_agent', 'user_agent_mode', 'ips', 'ips_mode', 'asns', 'asns_mode', 'hostname', 'hostname_mode'];

/**
 * Builds the SERVE route the gate decides on, or null when the click falls
 * through to the domain's normal flow (only when there are no routes/the host
 * isn't a domain — with routes, the gate always answers: the safe page is the
 * fallback). The route carries `_rule_label`/`_rule`/`_rule_reason`/`_rule_tags`/`_funnel`
 * for the traffic log, and `_gate_reason` when the click didn't go to the
 * funnel: slug_not_allowed, no_funnel_token, funnel_not_live, or the domain's
 * status (domain_disabled, domain_locked, domain_unlocked) — GATE_REASONS.
 */
function gate_pick(array $routes, array $gate, Request $req): ?array
{
    if ($routes === [] || !is_string($routes[0]['domain_id'] ?? null)) {
        return null;
    }
    $domainId = $routes[0]['domain_id'];
    // The domain's page at the requested slug (the first one that has it — the
    // safe page for this URL; null when no page has the slug → the gate's
    // non-funnel answers 404 via decide()).
    $domainPage = gate_domain_page($routes);
    $status = gate_domain_status($gate);

    // DISABLED: the domain serves nothing — 404 for every slug, no rules walk.
    if ($status === 'DISABLED') {
        return gate_always_404($domainId, $req->path, 'domain_disabled');
    }

    // 1) The rules walk: the first match marks the click with the rule's label
    //    and it gets the domain's page at this slug. Nothing is detected in code.
    //    An UNLOCKED domain skips the walk: every click is funnel-bound.
    if ($status !== 'UNLOCKED') {
        $rules = is_array($gate['rules'] ?? null) ? $gate['rules'] : [];
        foreach ($rules as $rule) {
            if (!is_array($rule)) {
                continue;
            }
            $cond = is_array($rule['conditions'] ?? null) ? $rule['conditions'] : [];
            if (!rule_conditions_match($cond, $req)) {
                continue;
            }
            return gate_flag_route($domainPage, GATE_SAFE_MATCH, [
                '_rule_label' => (string) ($rule['label'] ?? ''),
                '_rule' => (string) ($rule['name'] ?? ''),
                '_rule_reason' => (string) ($rule['reason'] ?? ''),
                '_rule_tags' => is_array($rule['tags'] ?? null) ? array_values(array_filter($rule['tags'], 'is_string')) : [],
            ]);
        }
    }

    // LOCKED: the rules still mark the log, but no slug is allowed — a clean
    // click always gets the domain's page at the requested slug, never the funnel.
    if ($status === 'LOCKED') {
        return gate_flag_route($domainPage, GATE_SAFE_MATCH, ['_gate_reason' => 'domain_locked']);
    }

    // 2) Clean traffic. The funnel only takes over on an allowed slug (one of
    //    the domain's gate_slugs — "/" included when it's there); any other
    //    slug gets the domain's page. An UNLOCKED domain allows every slug.
    if ($status !== 'UNLOCKED' && !gate_slug_allowed($req->path, $gate['gate_slugs'] ?? null)) {
        return gate_flag_route($domainPage, GATE_SAFE_MATCH, ['_gate_reason' => 'slug_not_allowed']);
    }
    $params = [];
    parse_str($req->rawQuery, $params);
    $sub1 = is_scalar($params['sub1'] ?? null) ? (string) $params['sub1'] : '';
    $code = gate_funnel_code($sub1);
    $funnel = $code !== null && is_array($gate['funnels'] ?? null) ? ($gate['funnels'][$code] ?? null) : null;
    $split = is_array($funnel['split'] ?? null) ? array_values(array_filter($funnel['split'], 'is_array')) : [];
    if ($split === []) {
        // An UNLOCKED domain serves funnels only: no token, or a funnel without
        // a live split (the data only has funnels with a live page) → 404.
        if ($status === 'UNLOCKED') {
            return gate_always_404($domainId, $req->path, 'domain_unlocked', $code);
        }
        // No token, or a funnel without a live split: the domain's page at "/".
        return gate_flag_route($domainPage, GATE_SAFE_MATCH, ['_funnel' => $code, '_gate_reason' => $code === null ? 'no_funnel_token' : 'funnel_not_live']);
    }

    $first = $split[0];
    $route = [
        'route_id' => null,
        'domain_id' => $domainId,
        'priority' => -3,
        'match_type' => GATE_MATCH,
        'conditions' => [],
        'action' => 'SERVE',
        'page_id' => (string) ($first['page_id'] ?? ''),
        'slug' => '/',
        'slug_id' => (string) ($first['page_id'] ?? ''),
        'content_type' => (string) ($first['content_type'] ?? 'text/html; charset=utf-8'),
        'content_hash' => (string) ($first['content_hash'] ?? ''),
        'preserve_query' => true,
        'split' => array_map(
            fn (array $c): array => [
                'page_id' => (string) ($c['page_id'] ?? ''),
                'slug_id' => (string) ($c['page_id'] ?? ''),
                'content_type' => (string) ($c['content_type'] ?? 'text/html; charset=utf-8'),
                'content_hash' => (string) ($c['content_hash'] ?? ''),
                'weight' => (int) ($c['weight'] ?? 0),
            ],
            $split,
        ),
        '_funnel' => $code,
    ];
    if (is_array($funnel['vsl'] ?? null)) {
        $route['vsl'] = array_values(array_filter($funnel['vsl'], 'is_array'));
    }
    return $route;
}

/** The first route that is a SERVE of a domain page (they all are, at the requested slug). */
function gate_domain_page(array $routes): ?array
{
    foreach ($routes as $route) {
        if (($route['action'] ?? '') === 'SERVE' && !empty($route['slug_id'])) {
            return $route;
        }
    }
    return null;
}

/** The domain's serving status (pages.domains.status), from the gate data; unknown or missing = ACTIVE (an old cache). */
function gate_domain_status(array $gate): string
{
    $status = strtoupper((string) ($gate['status'] ?? 'ACTIVE'));
    // The 20260925n rename: a cache from before it can still say BLOCKED/ALLOWED.
    $status = ['BLOCKED' => 'LOCKED', 'ALLOWED' => 'UNLOCKED'][$status] ?? $status;
    return in_array($status, ['ACTIVE', 'DISABLED', 'LOCKED', 'UNLOCKED'], true) ? $status : 'ACTIVE';
}

/**
 * A route that always 404s (a SERVE without a slug): a DISABLED domain serves
 * nothing, and an UNLOCKED one serves funnels only. The status goes to the log
 * as the gate reason (and the [F…] code, when there was one, as the funnel).
 */
function gate_always_404(string $domainId, string $path, string $reason, ?string $code = null): array
{
    $route = [
        'route_id' => null,
        'domain_id' => $domainId,
        'priority' => -4,
        'match_type' => GATE_SAFE_MATCH,
        'conditions' => [],
        'action' => 'SERVE',
        'page_id' => null,
        'slug' => $path,
        'slug_id' => null,
        'content_type' => null,
        'content_hash' => null,
        'preserve_query' => true,
        '_gate_reason' => $reason,
    ];
    if ($code !== null) {
        $route['_funnel'] = $code;
    }
    return $route;
}

/** Is this slug allowed to go to the funnel? The gate_slugs are the whole set — "/" included when it's there. */
function gate_slug_allowed(string $path, mixed $gateSlugs): bool
{
    foreach (is_array($gateSlugs) ? $gateSlugs : [] as $slug) {
        if (is_string($slug) && strcasecmp($slug, $path) === 0) {
            return true;
        }
    }
    return false;
}

/**
 * The funnel code in a sub1: the first token between brackets that is F + one
 * or more digits, case-insensitive ([F23], [f7]…). Returned uppercase, without
 * the brackets; null when the sub1 has no such token.
 */
function gate_funnel_code(string $sub1): ?string
{
    if ($sub1 === '' || preg_match('/\[\s*(f\d+)\s*\]/i', $sub1, $m) !== 1) {
        return null;
    }
    return strtoupper($m[1]);
}

/**
 * A rule's conditions against the request: the base dimensions via
 * conditions_match, plus the click's sub ids (exact, case-insensitive), a
 * generic URL parameter and the User-Agent regex (case-insensitive;
 * `user_agent_mode: block` inverts). The base evaluator would reject the
 * rule-only keys as unknown, so they're stripped before calling it.
 */
function rule_conditions_match(array $cond, Request $req): bool
{
    $base = $cond;
    foreach (RULE_OWN_CONDITIONS as $k) {
        unset($base[$k]);
    }
    if (!conditions_match($base, $req)) {
        return false;
    }

    $params = [];
    parse_str($req->rawQuery, $params);
    $read = static function (string $key) use ($params): ?string {
        $v = $params[$key] ?? null;
        return is_scalar($v) ? (string) $v : null;
    };

    foreach (['sub1', 'sub11'] as $key) {
        if (!isset($cond[$key])) {
            continue;
        }
        $v = $read($key);
        if ($v === null || strcasecmp($v, (string) $cond[$key]) !== 0) {
            return false;
        }
    }

    if (isset($cond['param']) && is_array($cond['param'])) {
        $p = $cond['param'];
        $name = (string) ($p['name'] ?? '');
        $v = $name !== '' ? $read($name) : null;
        if (array_key_exists('equals', $p)) {
            if ($v === null || strcasecmp($v, (string) $p['equals']) !== 0) {
                return false;
            }
        } elseif (array_key_exists('not_equals', $p)) {
            // The parameter is there but not this value (an unreplaced macro: "_CLICKID_").
            if ($v === null || strcasecmp($v, (string) $p['not_equals']) === 0) {
                return false;
            }
        } elseif (array_key_exists('absent_or_equals', $p)) {
            // Missing, or exactly this value (a macro never replaced: "_PLACEMENT_").
            if ($v !== null && strcasecmp($v, (string) $p['absent_or_equals']) !== 0) {
                return false;
            }
        } elseif (array_key_exists('contains', $p)) {
            if ($v === null || stripos($v, (string) $p['contains']) === false) {
                return false;
            }
        } elseif (array_key_exists('present', $p)) {
            if ($v === null) {
                return false;
            }
        } else {
            return false;
        }
    }

    if (isset($cond['user_agent'])) {
        $pattern = (string) $cond['user_agent'];
        $matched = @preg_match('/' . str_replace('/', '\/', $pattern) . '/i', $req->userAgent) === 1;
        $block = ($cond['user_agent_mode'] ?? 'allow') === 'block';
        if ($block ? $matched : !$matched) {
            return false;
        }
    }

    // The click's IP against IPs and CIDR ranges. An invalid IP can't be told: no match.
    if (isset($cond['ips'])) {
        $in = ip_in_ranges($req->ip, is_array($cond['ips']) ? $cond['ips'] : []);
        if ($in === null || $in === (($cond['ips_mode'] ?? 'allow') === 'block')) {
            return false;
        }
    }

    // ASN and hostname are network lookups (netinfo.php): last, so they only
    // run when everything else matched. Unknown (lookup failed) or none (no
    // ASN) can't be told: the condition doesn't match — never flag on a guess.
    if (isset($cond['asns'])) {
        $asn = netinfo_asn($req->ip, netinfo_rule_timeout());
        if (!$asn) {
            return false;
        }
        $in = in_array($asn, array_map('intval', is_array($cond['asns']) ? $cond['asns'] : []), true);
        if ($in === (($cond['asns_mode'] ?? 'allow') === 'block')) {
            return false;
        }
    }
    if (isset($cond['hostname'])) {
        // '' = the IP has no hostname: it matches nothing ("doesn't match" is true).
        $host = netinfo_hostname($req->ip, netinfo_rule_timeout());
        if ($host === null) {
            return false;
        }
        $matched = @preg_match('/' . str_replace('/', '\/', (string) $cond['hostname']) . '/i', $host) === 1;
        if ($matched === (($cond['hostname_mode'] ?? 'allow') === 'block')) {
            return false;
        }
    }

    return true;
}

/** A route (the domain's page at the requested slug) re-marked for the log with the gate's decision data. */
function gate_flag_route(?array $route, string $matchType, array $flags): ?array
{
    if (!is_array($route)) {
        return null;
    }
    $route['match_type'] = $matchType;
    return array_merge($route, $flags);
}

/**
 * The content hashes the gate may serve (each funnel's split), for the
 * resolver's "is everything on disk?" check and the content_get.
 *
 * @return list<string>
 */
function gate_content_ids(array $rulesData): array
{
    $ids = [];
    foreach ((array) ($rulesData['funnels'] ?? []) as $funnel) {
        foreach ((array) ($funnel['split'] ?? []) as $c) {
            if (is_array($c) && ($h = (string) ($c['content_hash'] ?? '')) !== '') {
                $ids[] = $h;
            }
        }
    }
    return array_values(array_unique($ids));
}

/** The {page_id, slug} pairs behind the gate (the slug is always "/"), for content_get. */
function gate_content_refs(array $rulesData): array
{
    $refs = [];
    foreach ((array) ($rulesData['funnels'] ?? []) as $funnel) {
        foreach ((array) ($funnel['split'] ?? []) as $c) {
            if (is_array($c) && ($p = (string) ($c['page_id'] ?? '')) !== '') {
                $refs[$p] = ['page_id' => $p, 'slug' => '/'];
            }
        }
    }
    return array_values($refs);
}

/** The rules_data the current refresh just fetched (resolve_routes returns it on a MISS, when the entry isn't in the cache yet). */
function gate_last_refresh_data(?array $set = null): ?array
{
    static $data = null;
    if ($set !== null) {
        $data = $set;
    }
    return $data;
}

/** The hash a gate content ref points at (the page's "/" in a funnel's split). */
function gate_ref_hash(array $rulesData, string $pageId): string
{
    foreach ((array) ($rulesData['funnels'] ?? []) as $funnel) {
        foreach ((array) ($funnel['split'] ?? []) as $c) {
            if (is_array($c) && (string) ($c['page_id'] ?? '') === $pageId) {
                return (string) ($c['content_hash'] ?? '');
            }
        }
    }
    return '';
}
