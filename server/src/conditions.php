<?php
/**
 * Avaliação de `conditions` de uma rota contra a request.
 *
 * O contrato (o mesmo de src/lib/pages/conditions.ts no dashboard):
 *
 *   countries  ["BR","US"]                 CF-IPCountry ∈ lista
 *   devices    ["mobile","tablet","desktop"] dispositivo pelo User-Agent ∈ lista
 *   query      {"utm_source": "present" | "absent" | {"equals": "x"}}
 *   referrer   "texto"                     Referer contém (case-insensitive)
 *   bot        true                        User-Agent de crawler/scraper.
 *                                          Só vale em rotas BLOCK; respond.php
 *                                          ignora rotas que o usem noutra ação.
 *
 * `{}` = sempre casa. Chave desconhecida = NÃO casa (e vai para o log):
 * uma rota que o servidor não entende não pode decidir nada.
 */
declare(strict_types=1);

const KNOWN_CONDITIONS = ['countries', 'devices', 'query', 'referrer', 'bot'];

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
        if ($req->country === '' || !in_array($req->country, $list, true)) {
            return false;
        }
    }

    if (isset($cond['devices'])) {
        if (!in_array(device_from_ua($req->userAgent), (array) $cond['devices'], true)) {
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
