<?php
/**
 * Evaluation of a route's `conditions` against the request.
 *
 * The contract (the same as src/lib/pages/conditions.ts in the dashboard):
 *
 *   countries       ["BR","US"]                 CF-IPCountry ∈ list
 *   countries_mode  "block"                     inverts: matches whoever is NOT in the list
 *   devices         ["mobile","tablet","desktop"] device from the User-Agent ∈ list
 *   languages       ["en","es"]                 browser Accept-Language ∩ list
 *   languages_mode  "block"                     inverts: matches whoever does NOT have the languages
 *   query           {"utm_source": "present" | "absent" | {"equals": "x"}}
 *   referrer        "text"                      Referer contains (case-insensitive)
 *   bot             true                        crawler/scraper User-Agent.
 *                                               Only valid on BLOCK routes; respond.php
 *                                               ignores routes that use it with another action.
 *
 * `{}` = always matches. Unknown key = does NOT match (and goes to the log):
 * a route the server doesn't understand can't decide anything.
 *
 * "block" mode and missing country/language: in allow, missing does NOT match
 * (it can't be confirmed as allowed); in block, missing MATCHES (it isn't in
 * what is barred).
 */
declare(strict_types=1);

defined('DAYONE_ENTRY') || (http_response_code(404) && exit);

const KNOWN_CONDITIONS = ['countries', 'countries_mode', 'devices', 'languages', 'languages_mode', 'query', 'referrer', 'bot'];

function conditions_match(array $cond, Request $req): bool
{
    foreach (array_keys($cond) as $key) {
        if (!in_array($key, KNOWN_CONDITIONS, true)) {
            error_log("[dayone-pages] unknown condition ignored (route does not match): $key");
            return false;
        }
    }

    if (isset($cond['countries'])) {
        $list = array_map('strtoupper', (array) $cond['countries']);
        $inList = $req->country !== '' && in_array($req->country, $list, true);
        $block = ($cond['countries_mode'] ?? 'allow') === 'block';
        if ($block ? $inList : !$inList) {
            return false;
        }
    }

    if (isset($cond['devices'])) {
        if (!in_array(device_from_ua($req->userAgent), (array) $cond['devices'], true)) {
            return false;
        }
    }

    if (isset($cond['languages'])) {
        $list = array_map('strtolower', (array) $cond['languages']);
        $inList = array_intersect(languages_from_header($req->acceptLanguage), $list) !== [];
        $block = ($cond['languages_mode'] ?? 'allow') === 'block';
        if ($block ? $inList : !$inList) {
            return false;
        }
    }

    if (isset($cond['query']) && is_array($cond['query'])) {
        $params = [];
        parse_str($req->rawQuery, $params);
        foreach ($cond['query'] as $name => $rule) {
            $present = array_key_exists($name, $params);
            if ($rule === 'present') {
                if (!$present) {
                    return false;
                }
            } elseif ($rule === 'absent') {
                if ($present) {
                    return false;
                }
            } elseif (is_array($rule) && array_key_exists('equals', $rule)) {
                if (!$present || !is_scalar($params[$name]) || (string) $params[$name] !== (string) $rule['equals']) {
                    return false;
                }
            } else {
                return false;
            }
        }
    }

    if (isset($cond['referrer'])) {
        if ($req->referer === '' || stripos($req->referer, (string) $cond['referrer']) === false) {
            return false;
        }
    }

    if (isset($cond['bot'])) {
        if ($cond['bot'] !== true || !is_bot_ua($req->userAgent)) {
            return false;
        }
    }

    return true;
}

/**
 * Primary subtags of Accept-Language, lowercase and without duplicates.
 * "pt-BR,pt;q=0.9,en;q=0.8" → ["pt","en"]. `q` and region are dropped;
 * matching is by language (the filter list stores ISO 639-1 codes).
 */
function languages_from_header(string $header): array
{
    if (trim($header) === '') {
        return [];
    }
    $out = [];
    foreach (explode(',', $header) as $part) {
        $tag = trim(explode(';', $part, 2)[0]);
        if ($tag === '' || $tag === '*') {
            continue;
        }
        $primary = strtolower(explode('-', $tag, 2)[0]);
        if (preg_match('/^[a-z]{2,3}$/', $primary) === 1) {
            $out[$primary] = true;
        }
    }
    return array_keys($out);
}

/** mobile | tablet | desktop, from the User-Agent. A simple heuristic that is good enough. */
function device_from_ua(string $ua): string
{
    if ($ua === '') {
        return 'desktop';
    }
    if (preg_match('/iPad|Tablet|PlayBook|Silk|Kindle|(Android(?!.*Mobile))/i', $ua) === 1) {
        return 'tablet';
    }
    if (preg_match('/Mobi|iPhone|iPod|Android.*Mobile|Windows Phone|BlackBerry|Opera Mini|IEMobile/i', $ua) === 1) {
        return 'mobile';
    }
    return 'desktop';
}

/** Known crawler/scraper, or a client with no User-Agent. Used only to BLOCK. */
function is_bot_ua(string $ua): bool
{
    if (trim($ua) === '') {
        return true;
    }
    return preg_match(
        '/bot|crawl|spider|slurp|scrapy|python-requests|python-urllib|go-http-client|java\/|libwww|httpclient|okhttp|'
        . 'curl|wget|headlesschrome|phantomjs|selenium|puppeteer|playwright|lighthouse|'
        . 'facebookexternalhit|facebot|ia_archiver|semrush|ahrefs|mj12bot|dotbot|petalbot|bytespider|'
        . 'applebot|discordbot|telegrambot|twitterbot|linkedinbot|pinterest|whatsapp|skypeuripreview/i',
        $ua,
    ) === 1;
}
