<?php
/**
 * Entry via www.: 302 to the domain without www. If the URL carries an fbclid,
 * it gets `sub21` = the encrypted entry time, right after the URL's last subN.
 *
 *   GET https://www.x.com/offer?sub1=a&sub11=Facebook&fbclid=Iw…
 *   → 302 Location: https://x.com/offer?sub1=a&sub11=Facebook&sub21=<token>&fbclid=Iw…
 *   GET https://www.x.com/offer?utm_source=fb&fbclid=Iw…
 *   → 302 Location: https://x.com/offer?utm_source=fb&fbclid=Iw…&sub21=<token>   (no subN: at the end)
 *   GET https://www.x.com/offer?utm_campaign=a
 *   → 302 Location: https://x.com/offer?utm_campaign=a          (no fbclid, no sub21)
 *
 * Only when the request would be served as a page (outcome served, a route
 * that matched, path .html/.php/no extension). Block, 404, route redirect and
 * files (.css, .js, robots.txt) go on as always, on the www. itself. With an
 * fbclid, a sub21 already in the URL is replaced by the new one; without one
 * the query stays intact. The destination is always https: every domain has
 * Cloudflare in front. (Until 25/10/2026 the token was `sub0`, before sub1, on
 * any URL with a campaign.)
 *
 * The 302 also sets `dop_www` on the bare domain and every subdomain
 * (`Domain=x.com`: a cookie set on www. without it would stay on www.; 30
 * days, the most a rule may count), so the
 * bare hit tells an ad click from a shared link: its value is the sub21 that
 * went into the URL (`1` without an fbclid). The hit keeps the Cookie header
 * (`pages.hits.cookies`): a bare hit whose sub21 is the cookie's came through
 * www. in this browser; one with a sub21 and no such cookie is the address bar's
 * URL opened elsewhere — shared, or another browser (in-app → Safari).
 *
 * The rules validate it (`www_entry: {token_hours, cookie_days}`: the rule
 * matches when www_entry_valid is false; the owner's numbers, 25/10/2026: 2 and
 * 5). The entry is valid on the bare domain when the browser has a `dop_www`
 * whose token is at most cookie_days old — any click's, not only this URL's:
 * the same phone clicking a newer ad overwrites it — or, without one, when the
 * URL's own sub21 is at most token_hours old: the visitor moved to another
 * browser or device (the Facebook app → Chrome rewrites the fbclid, never the
 * sub21). A browser that comes in on a sub21 within the rules' longest
 * token_hours gets it as its `dop_www` (www_inherit_cookie): its pass counts
 * from the click, and an old URL never renews one. Measured on Facebook,
 * 17–25/10/2026: 68% of the moves happen within an hour.
 *
 * Token: base64url(nonce 12 B ‖ ciphertext ‖ tag 16 B), AES-256-GCM with key
 * SHA-256(SUB0_KEY), which defaults to "DAYONE". The plaintext is the unix
 * timestamp in seconds ("1790000000"), so the token is 51 characters long.
 * GCM is authenticated: a tampered token or one from another key doesn't decrypt.
 */
declare(strict_types=1);

defined('DAYONE_ENTRY') || (http_response_code(404) && exit);

/** The URL parameter that carries the entry token. */
const ENTRY_PARAM = 'sub21';
const SUB0_CIPHER = 'aes-256-gcm';
/** The parameter that makes the token be generated (with a value). */
const ENTRY_TRIGGER = 'fbclid';
/** The www entry's cookie, on the bare domain: the token it got, or `1`. */
const WWW_COOKIE = 'dop_www';
/** How long the browser keeps `dop_www`: the most cookie_days a rule may ask (the rule counts its own). */
const WWW_COOKIE_MAX_AGE = 30 * 86400;
/** A token's time may be this far ahead of the server's clock (another server's skew). */
const WWW_CLOCK_SKEW = 60;

/**
 * The 302 for the www entry, or null when the request goes on as normal.
 *
 * @return array{0: int, 1: array<string,string>, 2: string}|null
 */
function www_entry_redirect(Request $req, string $outcome, ?array $route): ?array
{
    if ($outcome !== 'served' || $route === null || !is_logged_path($req->path) || !str_starts_with(visited_host($req), 'www.')) {
        return null;
    }
    $query = $req->rawQuery;
    $entry = '1';
    if (query_has_any($query, [ENTRY_TRIGGER])) {
        $entry = sub0_encrypt(time(), config()['sub0_key']);
        $query = query_insert_after_subs(query_without($query, ENTRY_PARAM), ENTRY_PARAM . '=' . $entry);
    }
    $path = $req->rawPath !== '' ? $req->rawPath : '/';
    $location = "https://{$req->host}$path" . ($query !== '' ? "?$query" : '');
    return [302, ['Location' => $location, 'Cache-Control' => 'no-store', 'Set-Cookie' => [www_cookie($req->host, $entry)]], ''];
}

/** `dop_www` for the bare domain and its subdomains ($host is the one without www.). */
function www_cookie(string $host, string $entry): string
{
    return WWW_COOKIE . "=$entry; Domain=$host; Path=/; Max-Age=" . WWW_COOKIE_MAX_AGE . '; Secure; HttpOnly; SameSite=Lax';
}

/**
 * Did this request come through the www entry? Always true on www. itself (it
 * is the entry); on the bare domain, a `dop_www` token at most $cookieMaxAge
 * old, or else the URL's sub21 at most $tokenMaxAge old (seconds). `dop_www=1`
 * (an entry without an fbclid) has no time: it doesn't count.
 */
function www_entry_valid(Request $req, int $tokenMaxAge, int $cookieMaxAge, ?int $now = null): bool
{
    if (str_starts_with(visited_host($req), 'www.')) {
        return true;
    }
    $now ??= time();
    $cookie = $req->cookies[WWW_COOKIE] ?? null;
    if ($cookieMaxAge > 0 && is_string($cookie) && www_token_fresh($cookie, $cookieMaxAge, $now)) {
        return true;
    }
    $token = www_url_token($req);
    return $token !== null && www_token_fresh($token, $tokenMaxAge, $now);
}

/**
 * The Set-Cookie that hands the URL's sub21 to a browser that came in on it
 * within $tokenMaxAge (another browser or device) and has no `dop_www` from
 * that click or a later one, or null. Only on the bare domain. The cookie is
 * the URL's token, so the pass counts from the click, not from now.
 */
function www_inherit_cookie(Request $req, int $tokenMaxAge, ?int $now = null): ?string
{
    if (str_starts_with(visited_host($req), 'www.')) {
        return null;
    }
    $now ??= time();
    $token = www_url_token($req);
    if ($token === null || !www_token_fresh($token, $tokenMaxAge, $now)) {
        return null;
    }
    $key = config()['sub0_key'];
    $cookie = $req->cookies[WWW_COOKIE] ?? null;
    $had = is_string($cookie) ? sub0_decrypt($cookie, $key) : null;
    if ($had !== null && $had >= (int) sub0_decrypt($token, $key)) {
        return null;
    }
    return www_cookie($req->host, $token);
}

/**
 * The longest token_hours (in seconds) among the gate's rules that check the
 * www entry — active, Monitor or checkpoint ones —, or null when none does
 * (then no browser inherits a sub21: nothing would read it).
 */
function www_entry_window(?array $gate): ?int
{
    $longest = null;
    foreach (['rules', 'monitor_rules', 'eval_rules'] as $list) {
        foreach (is_array($gate[$list] ?? null) ? $gate[$list] : [] as $rule) {
            $hours = is_array($rule) ? ($rule['conditions']['www_entry']['token_hours'] ?? null) : null;
            if (is_int($hours) && $hours > 0) {
                $longest = max($longest ?? 0, $hours * 3600);
            }
        }
    }
    return $longest;
}

/** The URL's first sub21 (case-insensitive name), or null. */
function www_url_token(Request $req): ?string
{
    foreach (explode('&', $req->rawQuery) as $pair) {
        [$name, $value] = array_pad(explode('=', $pair, 2), 2, '');
        if (strcasecmp(urldecode($name), ENTRY_PARAM) === 0) {
            $value = urldecode($value);
            return $value !== '' ? $value : null;
        }
    }
    return null;
}

/** Does the token decrypt to a time at most $maxAge ago (and not ahead of the clock)? */
function www_token_fresh(string $token, int $maxAge, int $now): bool
{
    $at = sub0_decrypt($token, config()['sub0_key']);
    return $at !== null && $at <= $now + WWW_CLOCK_SKEW && $now - $at <= $maxAge;
}

/** Does the raw query have any of these parameters with a non-empty value? Case-insensitive name. */
function query_has_any(string $query, array $names): bool
{
    foreach (explode('&', $query) as $pair) {
        [$name, $value] = array_pad(explode('=', $pair, 2), 2, '');
        if (in_array(strtolower(urldecode($name)), $names, true) && trim(urldecode($value)) !== '') {
            return true;
        }
    }
    return false;
}

/** Puts `$pair` right after the last subN parameter (sub1, sub11…, any case); without one, at the end. */
function query_insert_after_subs(string $query, string $pair): string
{
    $pairs = array_values(array_filter(explode('&', $query), fn (string $p) => $p !== ''));
    $at = count($pairs);
    foreach ($pairs as $i => $p) {
        if (preg_match('/^sub\d+$/i', urldecode(explode('=', $p, 2)[0])) === 1) {
            $at = $i + 1;
        }
    }
    array_splice($pairs, $at, 0, [$pair]);
    return implode('&', $pairs);
}

/** Raw query without the `$name` parameter (every occurrence); the others stay as they came. */
function query_without(string $query, string $name): string
{
    $keep = array_filter(
        explode('&', $query),
        fn (string $pair) => $pair !== '' && urldecode(explode('=', $pair, 2)[0]) !== $name,
    );
    return implode('&', $keep);
}

function sub0_encrypt(int $timestamp, string $key): string
{
    $nonce = random_bytes(12);
    $tag = '';
    $cipher = openssl_encrypt((string) $timestamp, SUB0_CIPHER, hash('sha256', $key, true), OPENSSL_RAW_DATA, $nonce, $tag, '', 16);
    return rtrim(strtr(base64_encode($nonce . $cipher . $tag), '+/', '-_'), '=');
}

/** The timestamp inside the token, or null if it doesn't decrypt with this key. */
function sub0_decrypt(string $token, string $key): ?int
{
    if (preg_match('/^[A-Za-z0-9_-]+$/', $token) !== 1) {
        return null;
    }
    $raw = base64_decode(strtr($token, '-_', '+/'), true);
    if ($raw === false || strlen($raw) <= 28) {
        return null;
    }
    $plain = openssl_decrypt(substr($raw, 12, -16), SUB0_CIPHER, hash('sha256', $key, true), OPENSSL_RAW_DATA, substr($raw, 0, 12), substr($raw, -16));
    return is_string($plain) && ctype_digit($plain) ? (int) $plain : null;
}
