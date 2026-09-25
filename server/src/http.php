<?php
/**
 * The request as this server sees it, and sending the response.
 *
 * Everything that comes from the visitor passes through here once and becomes
 * typed fields. The Cloudflare headers (CF-IPCountry, CF-Ray) are only
 * trustworthy if the machine's firewall accepts connections only from
 * Cloudflare IPs — see deploy/cloudflare-allowlist.sh.
 */
declare(strict_types=1);

defined('DAYONE_ENTRY') || (http_response_code(404) && exit);

final class Request
{
    public function __construct(
        public readonly string $method,
        public readonly string $rawHost,
        public readonly string $rawPath,
        public readonly string $rawQuery,
        public readonly string $userAgent,
        public readonly string $referer,
        public readonly string $country,
        public readonly string $acceptLanguage,
        public readonly string $ip,
        public readonly ?string $ifNoneMatch,
        public readonly ?string $purgeToken,
        public readonly bool $viaCloudflare,
        /** Request cookies, name → value (already decoded). */
        public readonly array $cookies,
        /** Normalized host and path; filled in by app.php. */
        public string $host = '',
        public string $path = '/',
    ) {
    }

    public function isHead(): bool
    {
        return $this->method === 'HEAD';
    }
}

/**
 * The visitor's country: Cloudflare's CF-IPCountry (geolocation, free with the
 * request); without it (a domain not behind Cloudflare), the country of the
 * IP's network from the local table (netdb.php) — less precise, but something.
 * '' = unknown.
 */
function client_country(array $server): string
{
    $cf = strtoupper(trim((string) ($server['HTTP_CF_IPCOUNTRY'] ?? '')));
    if ($cf !== '') {
        return $cf;
    }
    return (string) (netdb_lookup(client_ip($server))['cc'] ?? '');
}

function parse_request(array $server): Request
{
    $uri = (string) ($server['REQUEST_URI'] ?? '/');
    $path = (string) (parse_url($uri, PHP_URL_PATH) ?? '/');
    $query = (string) ($server['QUERY_STRING'] ?? (parse_url($uri, PHP_URL_QUERY) ?? ''));

    return new Request(
        method: strtoupper((string) ($server['REQUEST_METHOD'] ?? 'GET')),
        rawHost: (string) ($server['HTTP_HOST'] ?? ''),
        rawPath: $path,
        rawQuery: $query,
        userAgent: (string) ($server['HTTP_USER_AGENT'] ?? ''),
        referer: (string) ($server['HTTP_REFERER'] ?? ''),
        country: client_country($server),
        acceptLanguage: (string) ($server['HTTP_ACCEPT_LANGUAGE'] ?? ''),
        ip: client_ip($server),
        ifNoneMatch: isset($server['HTTP_IF_NONE_MATCH']) ? (string) $server['HTTP_IF_NONE_MATCH'] : null,
        purgeToken: isset($server['HTTP_X_PURGE_TOKEN']) ? (string) $server['HTTP_X_PURGE_TOKEN'] : null,
        viaCloudflare: isset($server['HTTP_CF_RAY']),
        cookies: parse_cookie_header((string) ($server['HTTP_COOKIE'] ?? '')),
    );
}

/**
 * "a=1; b=x%20y" → ['a' => '1', 'b' => 'x y']. Read from the header (not
 * from $_COOKIE) so the request can be rebuilt in the tests. Repeated name:
 * the first one wins, since the browser sends the most specific first.
 */
function parse_cookie_header(string $header): array
{
    $out = [];
    foreach (explode(';', $header) as $pair) {
        $pair = trim($pair);
        if ($pair === '') {
            continue;
        }
        [$name, $value] = array_pad(explode('=', $pair, 2), 2, '');
        $name = trim($name);
        if ($name === '' || array_key_exists($name, $out)) {
            continue;
        }
        $out[$name] = rawurldecode(trim($value));
    }
    return $out;
}

/**
 * The visitor's real IP. Behind Cloudflare it comes in CF-Connecting-IP; the
 * firewall only accepts Cloudflare IPs (deploy/cloudflare-allowlist.sh), so
 * that header is trustworthy. Fallbacks: first X-Forwarded-For, then
 * REMOTE_ADDR (direct connection in dev).
 */
function client_ip(array $server): string
{
    $cf = trim((string) ($server['HTTP_CF_CONNECTING_IP'] ?? ''));
    if ($cf !== '') {
        return $cf;
    }
    $xff = (string) ($server['HTTP_X_FORWARDED_FOR'] ?? '');
    if ($xff !== '') {
        return trim(explode(',', $xff)[0]);
    }
    return (string) ($server['REMOTE_ADDR'] ?? '');
}

/**
 * Sends the response and ends the body. On HEAD, headers only.
 * Content-Length is always sent when there is a body, so keep-alive works.
 */
function send_response(int $status, array $headers, ?string $body, bool $head): void
{
    http_response_code($status);
    foreach ($headers as $name => $value) {
        // List (e.g. two Set-Cookie): one header per item.
        if (is_array($value)) {
            foreach ($value as $one) {
                header("$name: $one", false);
            }
        } else {
            header("$name: $value");
        }
    }
    if ($body !== null) {
        header('Content-Length: ' . strlen($body));
        if (!$head) {
            echo $body;
        }
    }
}

/** A minimal page for 404/503/block. No detail that identifies the server. */
function plain_page(string $title, string $text): string
{
    $t = htmlspecialchars($title, ENT_QUOTES, 'UTF-8');
    $x = htmlspecialchars($text, ENT_QUOTES, 'UTF-8');
    return "<!doctype html><html lang=\"en\"><head><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width, initial-scale=1\"><title>$t</title>"
        . "<style>body{margin:0;font-family:system-ui,sans-serif;display:grid;place-items:center;min-height:100dvh;color:#333;background:#fafafa}main{text-align:center;padding:24px}h1{font-size:1.4rem;margin:0 0 8px}p{margin:0;color:#666}</style>"
        . "</head><body><main><h1>$t</h1><p>$x</p></main></body></html>";
}

/**
 * The 404 of every domain (path with no page, unknown or paused domain, block
 * with status 404): the generic web-server "404 Not Found", in English and
 * unbranded, so it says nothing about what runs here.
 */
function not_found_page(): string
{
    return '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>404 Not Found</title>'
        . '<style>html,body{height:100%}body{margin:0;display:flex;align-items:center;justify-content:center;background:#fff;color:#444;'
        . 'font-family:"Helvetica Neue",Helvetica,Arial,sans-serif;text-align:center}main{padding:24px}'
        . 'h1{margin:0;font-size:clamp(96px,30vw,160px);line-height:1;font-weight:700}'
        . 'h2{margin:24px 0 28px;font-size:34px;font-weight:700}p{margin:0;font-size:16px;color:#333}</style>'
        . '</head><body><main><h1>404</h1><h2>Not Found</h2><p>The resource requested could not be found on this server!</p></main></body></html>';
}
