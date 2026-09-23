<?php
/**
 * Marcadores {{chave}} nas páginas, trocados pelos dados do domínio na hora
 * de servir.
 *
 * Os valores vêm do resolve (coluna `placeholders` = pages.domains.placeholders
 * + `domain`) e ficam no cache de rotas junto com a rota; `{{year}}` é o ano
 * corrente (UTC). A lista de campos que o painel oferece está em
 * src/lib/pages/placeholders.ts, e as regras são as mesmas dos dois lados:
 *
 * - só `{{chave}}` de chave conhecida (espaços dentro das chaves valem);
 *   `{{ outra }}` fica como está — página com Vue ou Alpine não é afetada;
 * - valor vazio vira texto vazio;
 * - HTML/XML: o valor entra escapado; text/plain: cru; outros tipos (css,
 *   js, json): nada muda.
 *
 * Rota sem `placeholders` (cache de antes, resolve antigo): nada é trocado e
 * o ETag fica igual. Com valores, o ETag ganha um sufixo com o hash deles:
 * mudou um dado do domínio, a cópia que o navegador tem deixa de valer.
 */
declare(strict_types=1);

defined('DAYONE_ENTRY') || (http_response_code(404) && exit);

const PLACEHOLDER_RE = '/\{\{\s*([a-z][a-z0-9_]*)\s*\}\}/';

/**
 * Os valores da rota, só texto, mais `year`. null = a rota não traz
 * marcadores (não troca nada).
 *
 * @return array<string,string>|null
 */
function placeholder_values(array $route): ?array
{
    $raw = $route['placeholders'] ?? null;
    if (!is_array($raw)) {
        return null;
    }
    $values = [];
    foreach ($raw as $key => $value) {
        if (is_string($key) && (is_string($value) || is_int($value) || is_float($value))) {
            $values[$key] = (string) $value;
        }
    }
    $values['year'] = gmdate('Y');
    ksort($values);
    return $values;
}

/** Sufixo do ETag para os valores ('' quando a rota não traz marcadores). */
function placeholders_etag(?array $values): string
{
    return $values === null ? '' : '-p' . substr(md5((string) json_encode($values)), 0, 8);
}

/** Troca os marcadores conhecidos no corpo, conforme o tipo do conteúdo. */
function placeholders_apply(string $body, ?array $values, string $contentType): string
{
    if ($values === null || !str_contains($body, '{{')) {
        return $body;
    }
    $type = strtolower(trim(explode(';', $contentType)[0]));
    if (in_array($type, ['', 'text/html', 'application/xhtml+xml', 'text/xml', 'application/xml'], true)) {
        $escape = true;
    } elseif ($type === 'text/plain') {
        $escape = false;
    } else {
        return $body;
    }

    return (string) preg_replace_callback(PLACEHOLDER_RE, static function (array $m) use ($values, $escape): string {
        if (!array_key_exists($m[1], $values)) {
            return $m[0];
        }
        return $escape ? htmlspecialchars($values[$m[1]], ENT_QUOTES | ENT_SUBSTITUTE, 'UTF-8') : $values[$m[1]];
    }, $body);
}
