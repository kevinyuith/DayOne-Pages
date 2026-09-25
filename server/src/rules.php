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
 * decide() calls this before the domain's routes. The rules walk: the first
 * one whose conditions ALL match marks the click with the rule's LABEL and it
 * gets the domain's page at the requested slug. No match (clean traffic) and
 * the slug is allowed ("/" or a gate_slug) → the sub1's [F…] token names the
 * funnel, whose split decides the page (sticky dop_pg). Any other slug → the
 * domain's page at that slug (404 when no page has it). Nothing is detected
 * in code: bot/suspicious are the rules you write.
 *
 * The conditions are the hit log's fields (rule_conditions_match): the click's
 * sub ids (sub1, sub11), ANY URL parameter (param), country, device, language,
 * referrer, URL parameters (via conditions_match) and a regex on the User-Agent.
 */
declare(strict_types=1);

defined('DAYONE_ENTRY') || (http_response_code(404) && exit);

/** Match types for the traffic log (hit_decision). */
const GATE_MATCH = 'GATE';
const GATE_SAFE_MATCH = 'GATE-SAFE';

/** The rule-only condition keys (the base ones are conditions_match's). */
const RULE_OWN_CONDITIONS = ['sub1', 'sub11', 'param', 'user_agent', 'user_agent_mode'];

/**
 * Builds the SERVE route the gate decides on, or null when the click falls
 * through to the domain's normal flow (only when there are no routes/the host
 * isn't a domain — with routes, the gate always answers: the safe page is the
 * fallback). The route carries `_rule_label`/`_rule`/`_rule_tags`/`_funnel`
 * for the traffic log.
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

    // 1) The rules walk: the first match marks the click with the rule's label
    //    and it gets the domain's page at this slug. Nothing is detected in code.
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
            '_rule_tags' => is_array($rule['tags'] ?? null) ? array_values(array_filter($rule['tags'], 'is_string')) : [],
        ]);
    }

    // 2) Clean traffic. The funnel only takes over on an allowed slug ("/" or
    //    one of the domain's gate_slugs); any other slug gets the domain's page.
    if (!gate_slug_allowed($req->path, $gate['gate_slugs'] ?? null)) {
        return gate_flag_route($domainPage, GATE_SAFE_MATCH, []);
    }
    $params = [];
    parse_str($req->rawQuery, $params);
    $sub1 = is_scalar($params['sub1'] ?? null) ? (string) $params['sub1'] : '';
    $code = gate_funnel_code($sub1);
    $funnel = $code !== null && is_array($gate['funnels'] ?? null) ? ($gate['funnels'][$code] ?? null) : null;
    $split = is_array($funnel['split'] ?? null) ? array_values(array_filter($funnel['split'], 'is_array')) : [];
    if ($split === []) {
        // No token, or a funnel without a live split: the domain's page at "/".
        return gate_flag_route($domainPage, GATE_SAFE_MATCH, ['_funnel' => $code]);
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

/** Is this slug allowed to go to the funnel? "/" always is; the domain's gate_slugs add the others. */
function gate_slug_allowed(string $path, mixed $gateSlugs): bool
{
    if ($path === '/') {
        return true;
    }
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
