<?php
/**
 * Avaliação de `conditions` de uma rota contra a request.
 *
 * O contrato (o mesmo de src/lib/pages/conditions.ts no dashboard):
 *
 *   countries       ["BR","US"]                 CF-IPCountry ∈ lista
 *   countries_mode  "block"                     inverte: casa quem NÃO está na lista
 *   devices         ["mobile","tablet","desktop"] dispositivo pelo User-Agent ∈ lista
 *   languages       ["en","es"]                 Accept-Language do navegador ∩ lista
 *   languages_mode  "block"                     inverte: casa quem NÃO tem os idiomas
 *   query           {"utm_source": "present" | "absent" | {"equals": "x"}}
 *   referrer        "texto"                     Referer contém (case-insensitive)
 *   bot             true                        User-Agent de crawler/scraper.
 *                                               Só vale em rotas BLOCK; respond.php
 *                                               ignora rotas que o usem noutra ação.
 *
 * `{}` = sempre casa. Chave desconhecida = NÃO casa (e vai para o log):
 * uma rota que o servidor não entende não pode decidir nada.
 *
 * Modo "block" e país/idioma ausente: em allow, ausência NÃO casa (não dá para
 * confirmar que é permitido); em block, ausência CASA (não está no que se barra).
 */
declare(strict_types=1);

defined('DAYONE_ENTRY') || (http_response_code(404) && exit);

const KNOWN_CONDITIONS = ['countries', 'countries_mode', 'devices', 'languages', 'languages_mode', 'query', 'referrer', 'bot'];

function conditions_match(array $cond, Request $req): bool
{
    foreach (array_keys($cond) as $key) {
        if (!in_array($key, KNOWN_CONDITIONS, true)) {
            error_log("[dayone-pages] condição desconhecida ignorada (rota não casa): $key");
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
 * Subtags primárias do Accept-Language, minúsculas e sem duplicar.
 * "pt-BR,pt;q=0.9,en;q=0.8" → ["pt","en"]. `q` e região são descartados; o
 * casamento é por idioma (a lista do filtro guarda códigos ISO 639-1).
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

/** mobile | tablet | desktop, pelo User-Agent. Heurística simples e suficiente. */
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

/** Crawler/scraper conhecido, ou cliente sem User-Agent. Usado só para BLOQUEAR. */
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
