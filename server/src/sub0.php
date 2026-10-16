<?php
/**
 * Entry via www.: 302 to the domain without www. If the URL carries a campaign
 * (sub1, utm_campaign or campaign with a value), it gets `sub0` = encrypted timestamp.
 *
 *   GET https://www.x.com/offer?utm_campaign=a
 *   → 302 Location: https://x.com/offer?utm_campaign=a&sub0=<token>
 *   GET https://www.x.com/offer?utm_source=fb&sub1=a&sub2=b
 *   → 302 Location: https://x.com/offer?utm_source=fb&sub0=<token>&sub1=a&sub2=b
 *   GET https://www.x.com/offer?utm_source=fb
 *   → 302 Location: https://x.com/offer?utm_source=fb            (no campaign, no sub0)
 *
 * Only when the request would be served as a page (outcome served, a route
 * that matched, path .html/.php/no extension). Block, 404, route redirect and
 * files (.css, .js, robots.txt) go on as always, on the www. itself. The sub0
 * goes right before sub1 (without sub1, at the end). With a campaign, a sub0
 * already in the URL is replaced by the new one; without a campaign the query
 * stays intact. The destination is always https: every domain has Cloudflare
 * in front.
 *
 * The 302 also sets `dop_www` on the bare domain and every subdomain
 * (`Domain=x.com`: a cookie set on www. without it would stay on www.), so the
 * bare hit tells an ad click from a shared link: its value is the sub0 that
 * went into the URL (`1` without a campaign). The hit keeps the Cookie header
 * (`pages.hits.cookies`): a bare hit whose sub0 is the cookie's came through
 * www. in this browser; one with a sub0 and no such cookie is the address bar's
 * URL opened elsewhere — shared, or another browser (in-app → Safari).
 *
 * Token: base64url(nonce 12 B ‖ ciphertext ‖ tag 16 B), AES-256-GCM with key
 * SHA-256(SUB0_KEY), which defaults to "DAYONE". The plaintext is the unix
 * timestamp in seconds ("1790000000"), so the token is 51 characters long.
 * GCM is authenticated: a tampered token or one from another key doesn't decrypt.
 */
declare(strict_types=1);

defined('DAYONE_ENTRY') || (http_response_code(404) && exit);

const SUB0_PARAM = 'sub0';
const SUB0_CIPHER = 'aes-256-gcm';
/** Campaign parameters that make sub0 be generated (one is enough, with a value). */
const SUB0_TRIGGERS = ['sub1', 'utm_campaign', 'campaign'];
/** The www entry's cookie, on the bare domain: the sub0 it got, or `1`. */
const WWW_COOKIE = 'dop_www';
const WWW_COOKIE_MAX_AGE = 30 * 86400;

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
    if (query_has_any($query, SUB0_TRIGGERS)) {
        $entry = sub0_encrypt(time(), config()['sub0_key']);
        $query = query_insert_before(query_without($query, SUB0_PARAM), SUB0_PARAM . '=' . $entry, 'sub1');
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

/** Puts `$pair` right before the first `$before` parameter (case-insensitive name); without it, at the end. */
function query_insert_before(string $query, string $pair, string $before): string
{
    $pairs = array_values(array_filter(explode('&', $query), fn (string $p) => $p !== ''));
    $at = count($pairs);
    foreach ($pairs as $i => $p) {
        if (strtolower(urldecode(explode('=', $p, 2)[0])) === $before) {
            $at = $i;
            break;
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
