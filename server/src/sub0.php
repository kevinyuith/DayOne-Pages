<?php
/**
 * Entrada por www.: 302 para o domínio sem www. Se a URL traz campanha
 * (sub1, utm_campaign ou campaign com valor), ganha `sub0` = timestamp cifrado.
 *
 *   GET https://www.x.com/oferta?utm_campaign=a
 *   → 302 Location: https://x.com/oferta?utm_campaign=a&sub0=<token>
 *   GET https://www.x.com/oferta?utm_source=fb&sub1=a&sub2=b
 *   → 302 Location: https://x.com/oferta?utm_source=fb&sub0=<token>&sub1=a&sub2=b
 *   GET https://www.x.com/oferta?utm_source=fb
 *   → 302 Location: https://x.com/oferta?utm_source=fb            (sem campanha, sem sub0)
 *
 * Só quando a request seria servida como página (outcome served, rota que
 * casou, path .html/.php/sem extensão). Bloqueio, 404, redirect de rota e
 * arquivos (.css, .js, robots.txt) seguem como sempre, no próprio www. O
 * sub0 entra logo antes do sub1 (sem sub1, no fim). Com campanha, um sub0 que
 * já venha na URL é trocado pelo novo; sem campanha a query segue intacta. O destino é sempre https: todo domínio tem o
 * Cloudflare na frente.
 *
 * Token: base64url(nonce 12 B ‖ cifrado ‖ tag 16 B), AES-256-GCM com chave
 * SHA-256(SUB0_KEY), que por padrão é "DAYONE". O texto claro é o unix
 * timestamp em segundos ("1790000000"), então o token tem 51 caracteres.
 * GCM é autenticado: token adulterado ou de outra chave não decifra.
 */
declare(strict_types=1);

defined('DAYONE_ENTRY') || (http_response_code(404) && exit);

const SUB0_PARAM = 'sub0';
const SUB0_CIPHER = 'aes-256-gcm';
/** Parâmetros de campanha que fazem o sub0 ser gerado (basta um, com valor). */
const SUB0_TRIGGERS = ['sub1', 'utm_campaign', 'campaign'];

/**
 * O 302 da entrada por www, ou null quando a request segue normal.
 *
 * @return array{0: int, 1: array<string,string>, 2: string}|null
 */
function www_entry_redirect(Request $req, string $outcome, ?array $route): ?array
{
    if ($outcome !== 'served' || $route === null || !is_logged_path($req->path) || !str_starts_with(visited_host($req), 'www.')) {
        return null;
    }
    $query = $req->rawQuery;
    if (query_has_any($query, SUB0_TRIGGERS)) {
        $sub0 = SUB0_PARAM . '=' . sub0_encrypt(time(), config()['sub0_key']);
        $query = query_insert_before(query_without($query, SUB0_PARAM), $sub0, 'sub1');
    }
    $path = $req->rawPath !== '' ? $req->rawPath : '/';
    $location = "https://{$req->host}$path" . ($query !== '' ? "?$query" : '');
    return [302, ['Location' => $location, 'Cache-Control' => 'no-store'], ''];
}

/** A query crua tem algum destes parâmetros com valor não vazio? Nome sem diferenciar maiúsculas. */
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

/** Põe `$pair` logo antes do primeiro parâmetro `$before` (nome sem diferenciar maiúsculas); sem ele, no fim. */
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

/** Query crua sem o parâmetro `$name` (em qualquer ocorrência); os demais ficam como vieram. */
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

/** O timestamp dentro do token, ou null se não decifrar com esta chave. */
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
