<?php
/**
 * A request como este servidor a enxerga, e o envio da resposta.
 *
 * Tudo que vem do visitante passa por aqui uma vez e vira campos tipados.
 * Os headers do Cloudflare (CF-IPCountry, CF-Ray) só são confiáveis se o
 * firewall da máquina aceitar conexões apenas dos IPs do Cloudflare — ver
 * deploy/cloudflare-allowlist.sh.
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
        public readonly ?string $ifNoneMatch,
        public readonly ?string $purgeToken,
        public readonly bool $viaCloudflare,
        /** Host e path normalizados; preenchidos por app.php. */
        public string $host = '',
        public string $path = '/',
    ) {
    }

    public function isHead(): bool
    {
        return $this->method === 'HEAD';
    }
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
        country: strtoupper((string) ($server['HTTP_CF_IPCOUNTRY'] ?? '')),
        ifNoneMatch: isset($server['HTTP_IF_NONE_MATCH']) ? (string) $server['HTTP_IF_NONE_MATCH'] : null,
        purgeToken: isset($server['HTTP_X_PURGE_TOKEN']) ? (string) $server['HTTP_X_PURGE_TOKEN'] : null,
        viaCloudflare: isset($server['HTTP_CF_RAY']),
    );
}

/**
 * Envia a resposta e encerra o corpo. Em HEAD, só os headers.
 * Content-Length vai sempre que há corpo, para o keep-alive funcionar.
 */
function send_response(int $status, array $headers, ?string $body, bool $head): void
{
    http_response_code($status);
    foreach ($headers as $name => $value) {
        header("$name: $value");
    }
    if ($body !== null) {
        header('Content-Length: ' . strlen($body));
        if (!$head) {
            echo $body;
        }
    }
}

/** Uma página mínima para 404/503/bloqueio. Sem detalhe que identifique o servidor. */
function plain_page(string $title, string $text): string
{
    $t = htmlspecialchars($title, ENT_QUOTES, 'UTF-8');
    $x = htmlspecialchars($text, ENT_QUOTES, 'UTF-8');
    return "<!doctype html><html lang=\"pt-BR\"><head><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width, initial-scale=1\"><title>$t</title>"
        . "<style>body{margin:0;font-family:system-ui,sans-serif;display:grid;place-items:center;min-height:100dvh;color:#333;background:#fafafa}main{text-align:center;padding:24px}h1{font-size:1.4rem;margin:0 0 8px}p{margin:0;color:#666}</style>"
        . "</head><body><main><h1>$t</h1><p>$x</p></main></body></html>";
}
