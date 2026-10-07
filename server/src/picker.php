<?php
/**
 * The funnel picker of an UNLOCKED domain.
 *
 * An UNLOCKED domain ignores the rules and serves funnels only (rules.php):
 * a sub1 with an [F…] token goes straight to that funnel, as always (404 when
 * it has no live page). A page request whose sub1 names NO funnel goes to the
 * domain's default funnel when it has one (gate_default_funnel — then this
 * page never shows and dop_funnel means nothing); without one, it gets this
 * page instead of a 404: a select with the gate's live funnels (the resolve
 * only carries funnels with a live page), code and name, and an Open button —
 * a GET form back to the SAME URL that adds ?dop_funnel=<code>; the rest of
 * the query (sub ids, click ids) rides along as hidden fields, so it stays.
 * No script: it works in any browser. The gate then serves that funnel's
 * split as for a clean click, and a
 * funnel's step switch (a reload of the same URL) keeps the choice. A choice
 * that isn't live (anymore) gets the picker again, with a notice.
 *
 * Only an UNLOCKED domain reads dop_funnel: on any other status the parameter
 * means nothing, so it can't open a funnel past the rules.
 *
 * The page is uncacheable and noindex; the hit is "SERVE · PICK", with the
 * gate reason domain_unlocked (and the dop_funnel code that wasn't live, when
 * there was one). It carries no beacon and no tracker: it isn't a funnel page.
 */
declare(strict_types=1);

defined('DAYONE_ENTRY') || (http_response_code(404) && exit);

/** The URL parameter that carries the visitor's choice. */
const PICK_PARAM = 'dop_funnel';
/** The picker's match type (hit decision "SERVE · PICK"). */
const PICK_MATCH = 'PICK';

/** The funnel code the visitor picked (?dop_funnel=F23 → "F23"), or null. */
function picker_choice(array $params): ?string
{
    $value = is_scalar($params[PICK_PARAM] ?? null) ? trim((string) $params[PICK_PARAM]) : '';
    return preg_match('/^f\d+$/i', $value) === 1 ? strtoupper($value) : null;
}

/** Does this request get the picker (instead of a 404)? Pages only — robots.txt, assets and probes stay 404. */
function picker_applies(Request $req): bool
{
    return is_logged_path($req->path);
}

/**
 * The gate's live funnels for the picker, in code order (F1, F2, … F10):
 * [['code' => 'F23', 'name' => 'PINK SALT'], …]. A cache from before the
 * names (20261006a) gives an empty name.
 *
 * @return list<array{code: string, name: string}>
 */
function picker_funnels(array $gate): array
{
    $list = [];
    foreach (is_array($gate['funnels'] ?? null) ? $gate['funnels'] : [] as $code => $funnel) {
        if (!is_array($funnel) || !is_array($funnel['split'] ?? null) || $funnel['split'] === []) {
            continue;
        }
        $list[] = ['code' => (string) $code, 'name' => is_string($funnel['name'] ?? null) ? trim($funnel['name']) : ''];
    }
    usort($list, static fn (array $a, array $b): int => strnatcasecmp($a['code'], $b['code']));
    return $list;
}

/** The picker's route (gate_pick → decide_route): a SERVE that answers with the picker page. */
function picker_route(string $domainId, string $path, array $gate, ?string $code): array
{
    $route = [
        'route_id' => null,
        'domain_id' => $domainId,
        'priority' => -4,
        'match_type' => PICK_MATCH,
        'conditions' => [],
        'action' => 'SERVE',
        'page_id' => null,
        'slug' => $path,
        'slug_id' => null,
        'content_type' => 'text/html; charset=utf-8',
        'content_hash' => null,
        'preserve_query' => true,
        '_gate_reason' => 'domain_unlocked',
        '_pick' => picker_funnels($gate),
    ];
    if ($code !== null) {
        $route['_funnel'] = $code;
    }
    return $route;
}

/**
 * The query's parameters for the form's hidden fields, in order, decoded as a
 * form submit encodes them again ([name, value] pairs) — dop_funnel left out:
 * the select gives it.
 *
 * @return list<array{0: string, 1: string}>
 */
function picker_hidden_fields(string $rawQuery): array
{
    $fields = [];
    foreach (explode('&', query_without($rawQuery, PICK_PARAM)) as $pair) {
        if ($pair === '') {
            continue;
        }
        [$name, $value] = array_pad(explode('=', $pair, 2), 2, '');
        $name = urldecode($name);
        if ($name !== '') {
            $fields[] = [$name, urldecode($value)];
        }
    }
    return $fields;
}

/**
 * The picker page: [status, headers, body]. A GET form without an action
 * submits to this same path, its fields becoming the whole query: the hidden
 * fields keep the visit's parameters, the select adds dop_funnel last.
 *
 * @param list<array{code: string, name: string}> $funnels
 */
function picker_response(array $funnels, Request $req, ?string $missing = null): array
{
    $e = static fn (string $s): string => htmlspecialchars($s, ENT_QUOTES | ENT_SUBSTITUTE, 'UTF-8');
    $notice = $missing !== null ? '<p class="n">' . $e($missing) . ' has no live page.</p>' : '';
    if ($funnels === []) {
        $content = '<p class="n">No funnel is live.</p>';
    } else {
        $hidden = '';
        foreach (picker_hidden_fields($req->rawQuery) as [$name, $value]) {
            $hidden .= '<input type="hidden" name="' . $e($name) . '" value="' . $e($value) . '">';
        }
        $options = '<option value="" disabled selected>Choose a funnel</option>';
        foreach ($funnels as $f) {
            $options .= '<option value="' . $e($f['code']) . '">' . $e($f['code'] . ($f['name'] !== '' ? ' · ' . $f['name'] : '')) . '</option>';
        }
        $content = '<form method="get">' . $hidden
            . '<label for="f">Funnel</label>'
            . '<div class="r"><select id="f" name="' . PICK_PARAM . '" required>' . $options . '</select>'
            . '<button type="submit">Open</button></div></form>';
    }
    $html = '<!DOCTYPE html><html lang="en"><head><meta charset="utf-8">'
        . '<meta name="viewport" content="width=device-width, initial-scale=1">'
        . '<meta name="robots" content="noindex,nofollow">'
        . '<title>Choose a funnel</title>'
        . '<style>'
        . ':root{color-scheme:light dark;--bg:#f6f6f4;--fg:#1c1c1a;--muted:#6b6b66;--card:#fff;--line:#d6d6d0;--btn:#1c1c1a;--btn-fg:#fff}'
        . '@media (prefers-color-scheme:dark){:root{--bg:#141413;--fg:#ececea;--muted:#9a9a94;--card:#1d1d1b;--line:#3a3a36;--btn:#ececea;--btn-fg:#141413}}'
        . '*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.4 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}'
        . 'main{max-width:480px;margin:0 auto;padding:48px 16px}h1{font-size:20px;margin:0 0 16px}'
        . '.n{color:var(--muted);margin:0 0 16px}'
        . 'label{display:block;font-size:13px;color:var(--muted);margin:0 0 6px}'
        . '.r{display:flex;gap:8px}'
        . 'select,button{font:inherit;height:44px;border-radius:8px}'
        . 'select{flex:1;min-width:0;padding:0 12px;border:1px solid var(--line);background:var(--card);color:var(--fg)}'
        . 'button{padding:0 20px;border:0;background:var(--btn);color:var(--btn-fg);font-weight:600;cursor:pointer}'
        . '</style></head><body><main><h1>Choose a funnel</h1>' . $notice . $content . '</main></body></html>';
    return [200, [
        'Content-Type' => 'text/html; charset=utf-8',
        'Cache-Control' => 'no-store',
        'X-Robots-Tag' => 'noindex, nofollow',
    ], $html];
}

/** Is this the picker's route? */
function picker_route_is(?array $route): bool
{
    return $route !== null && ($route['match_type'] ?? null) === PICK_MATCH;
}
