<?php
/**
 * Registro de tráfego: monta o payload de um hit e o envia ao Supabase.
 *
 * Chamada por app.php DEPOIS de a resposta ter ido embora
 * (fastcgi_finish_request), então o visitante nunca espera por isto. É
 * fire-and-forget: qualquer erro vai só para o log.
 *
 * O que grava (uma linha por request servido): host, path, outcome, status,
 * país (CF-IPCountry), dispositivo e bot (pelo User-Agent), host do referrer,
 * IP e User-Agent crus. Ligado/desligado por LOG_HITS (config).
 */
declare(strict_types=1);

defined('DAYONE_ENTRY') || (http_response_code(404) && exit);

function log_hit(Request $req, int $status, string $outcome, ?string $domainId): void
{
    if (!config()['log_hits']) {
        return;
    }

    $referrerHost = '';
    if ($req->referer !== '') {
        $referrerHost = (string) (parse_url($req->referer, PHP_URL_HOST) ?? '');
    }

    supabase_log_hit([
        'p_domain'        => $domainId,
        'p_host'          => $req->host !== '' ? $req->host : $req->rawHost,
        'p_path'          => $req->path,
        'p_outcome'       => $outcome,
        'p_status'        => $status,
        'p_country'       => $req->country,
        'p_device'        => device_from_ua($req->userAgent),
        'p_is_bot'        => is_bot_ua($req->userAgent),
        'p_referrer_host' => $referrerHost,
        'p_ip'            => $req->ip,
        'p_user_agent'    => $req->userAgent,
    ]);
}
