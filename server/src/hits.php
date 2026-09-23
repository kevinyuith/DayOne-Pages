<?php
/**
 * Registro de tráfego: monta o payload de um hit e o envia ao Supabase.
 *
 * Chamada por app.php DEPOIS de a resposta ter ido embora
 * (fastcgi_finish_request), então o visitante nunca espera por isto. É
 * fire-and-forget: qualquer erro vai só para o log.
 *
 * O que grava (uma linha por request a página: .html, .php ou sem extensão):
 * host, path e query crua, outcome, status, país (CF-IPCountry), estado se US (cf-region),
 * dispositivo e bot (pelo User-Agent), host do referrer, IP, hostname (reverse
 * DNS do IP), ASN, User-Agent e header Cookie crus, a rota que decidiu
 * (rota, página, slug, decisão) e, se foi redirect, a URL final (Location).
 * Ligado/desligado por LOG_HITS (config).
 */
declare(strict_types=1);

defined('DAYONE_ENTRY') || (http_response_code(404) && exit);

function log_hit(Request $req, int $status, string $outcome, ?string $domainId, ?array $route = null, ?string $redirectUrl = null): void
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
        'p_is_bot'        => is_bot_ua($req->userAgent),
        'p_referrer_host' => $referrerHost,
        'p_ip'            => $req->ip,
        'p_hostname'      => reverse_dns($req->ip),
        'p_asn'           => $asn['asn'] ?? null,
        'p_as_name'       => $asn['name'] ?? null,
        // Direto do $_SERVER: o Request não guarda estes headers.
        'p_cookies'       => (string) ($_SERVER['HTTP_COOKIE'] ?? ''),
        // Managed Transform "Add visitor location headers" do Cloudflare; o banco só grava se país = US.
        'p_region'        => (string) ($_SERVER['HTTP_CF_REGION'] ?? ''),
        'p_user_agent'    => $req->userAgent,
        'p_route_id'      => $route['route_id'] ?? null,
        'p_page_id'       => $route['page_id'] ?? null,
        'p_slug'          => $route['slug'] ?? null,
        'p_decision'      => hit_decision($route),
        'p_redirect_url'  => $redirectUrl,
    ]);
}

/** "SERVE · FALLBACK", "BLOCK · BOTGATE", "REDIRECT · PREFIX"…; "NONE" quando nenhuma rota casou. */
function hit_decision(?array $route): string
{
    if ($route === null) {
        return 'NONE';
    }
    $parts = array_filter([(string) ($route['action'] ?? ''), (string) ($route['match_type'] ?? '')], fn (string $p) => $p !== '');
    return implode(' · ', $parts);
}

/**
 * Host como o visitante acessou ("www.x.com" continua com www), sem porta nem
 * ponto final. $req->host é o normalizado (sem www), que serve para achar o domínio.
 */
function visited_host(Request $req): string
{
    $host = rtrim(strtolower(trim(explode(':', $req->rawHost, 2)[0])), '.');
    return $host !== '' ? $host : $req->host;
}

/** Só páginas: .html, .php ou último segmento sem ponto ("/", "/oferta"). Arquivos e sondas (.js, .env, .json…) ficam de fora. */
function is_logged_path(string $path): bool
{
    return preg_match('~(\.(html|php)|/[^/.]*)$~i', $path) === 1;
}

/**
 * PTR do IP, ou null. gethostbyaddr não aceita timeout: um PTR que não
 * responde prende o worker do FPM por alguns segundos (o visitante não espera,
 * a resposta já foi).
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
 * ASN do IP pela Team Cymru, por DNS TXT (sem chave, sem dependência):
 * origin(6).asn.cymru.com dá o número, AS<n>.asn.cymru.com dá o nome.
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

/** 8.8.8.8 → 8.8.8.8.origin.asn.cymru.com (octetos invertidos); IPv6 → nibbles invertidos em origin6. IP privado/reservado → null. */
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

/** "15169 | 8.8.8.0/24 | US | arin | 2023-12-28" → 15169. Prefixo com mais de um ASN ("15169 36040") → o primeiro. */
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
