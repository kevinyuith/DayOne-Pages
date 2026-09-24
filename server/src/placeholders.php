<?php
/**
 * Marcadores {{chave}} nas páginas, trocados pelos dados do domínio e da
 * visita na hora de servir.
 *
 * - `company.*` (llc = razão social, number, address, phone, email) vêm do
 *   resolve (coluna `placeholders` = pages.domains.placeholders + `domain`) e
 *   ficam no cache de rotas junto com a rota; `company.name` é a razão social
 *   sem o sufixo jurídico (company_name());
 * - automáticos, a cada visita: `url` (https://domínio + path, sem query),
 *   `slug` (path servido), `lang` e `language` (primeiro idioma do
 *   Accept-Language; sem ele, inglês), `date` (hoje em Nova York, por
 *   extenso nesse idioma) e `year`.
 *
 * A lista de campos do painel e o preview do editor ficam em
 * src/lib/pages/placeholders.ts. As regras e as tabelas (idiomas, meses) são
 * as mesmas dos dois lados — mudou uma, mude a outra:
 *
 * - só `{{chave}}` de chave conhecida (espaços dentro valem); `{{ outra }}`
 *   fica como está — página com Vue ou Alpine não é afetada;
 * - valor vazio vira texto vazio;
 * - HTML/XML: o valor entra escapado; text/plain: cru; outros tipos (css,
 *   js, json): nada muda.
 *
 * Rota sem `placeholders` (cache de antes, resolve antigo): nada é trocado e
 * o ETag fica igual. Com valores, o ETag ganha um sufixo com o hash deles: a
 * página muda por idioma e por dia, e mudou um dado do domínio, a cópia que o
 * navegador tem deixa de valer (a resposta já varia por Accept-Language).
 */
declare(strict_types=1);

defined('DAYONE_ENTRY') || (http_response_code(404) && exit);

const PLACEHOLDER_RE = '/\{\{\s*([a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)*)\s*\}\}/';
const PLACEHOLDER_TZ = 'America/New_York';

/** Nome de cada idioma nele mesmo. Sem entrada: o próprio código. */
const PLACEHOLDER_LANGUAGE_NAMES = [
    'en' => 'English', 'pt' => 'Português', 'es' => 'Español', 'fr' => 'Français', 'de' => 'Deutsch', 'it' => 'Italiano', 'nl' => 'Nederlands',
    'pl' => 'Polski', 'ru' => 'Русский', 'uk' => 'Українська', 'tr' => 'Türkçe', 'sv' => 'Svenska', 'da' => 'Dansk', 'no' => 'Norsk', 'nb' => 'Norsk',
    'fi' => 'Suomi', 'cs' => 'Čeština', 'ro' => 'Română', 'hu' => 'Magyar', 'el' => 'Ελληνικά', 'he' => 'עברית', 'ar' => 'العربية', 'hi' => 'हिन्दी',
    'ja' => '日本語', 'zh' => '中文', 'ko' => '한국어', 'id' => 'Bahasa Indonesia', 'ms' => 'Bahasa Melayu', 'vi' => 'Tiếng Việt', 'th' => 'ไทย', 'tl' => 'Filipino',
];

/** Meses e formato da data por extenso ({d}, {m}, {y}). Idioma sem entrada usa o inglês. */
const PLACEHOLDER_DATE_FORMATS = [
    'en' => [['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'], '{m} {d}, {y}'],
    'pt' => [['janeiro', 'fevereiro', 'março', 'abril', 'maio', 'junho', 'julho', 'agosto', 'setembro', 'outubro', 'novembro', 'dezembro'], '{d} de {m} de {y}'],
    'es' => [['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'], '{d} de {m} de {y}'],
    'fr' => [['janvier', 'février', 'mars', 'avril', 'mai', 'juin', 'juillet', 'août', 'septembre', 'octobre', 'novembre', 'décembre'], '{d} {m} {y}'],
    'de' => [['Januar', 'Februar', 'März', 'April', 'Mai', 'Juni', 'Juli', 'August', 'September', 'Oktober', 'November', 'Dezember'], '{d}. {m} {y}'],
    'it' => [['gennaio', 'febbraio', 'marzo', 'aprile', 'maggio', 'giugno', 'luglio', 'agosto', 'settembre', 'ottobre', 'novembre', 'dicembre'], '{d} {m} {y}'],
    'nl' => [['januari', 'februari', 'maart', 'april', 'mei', 'juni', 'juli', 'augustus', 'september', 'oktober', 'november', 'december'], '{d} {m} {y}'],
];

/**
 * Sufixos jurídicos que {{company.name}} tira do fim da razão social. A mesma
 * lista está em src/lib/pages/company-name.ts; os casos de teste dos dois
 * lados estão em server/tests/company-names.json.
 */
const COMPANY_SUFFIXES_ANY_CASE = [
    'UG (haftungsbeschränkt)', 'S.à r.l', 'S.a.r.l', 'Incorporated', 'Corporation', 'Company', 'Limited',
    'L.L.L.P', 'P.L.L.C', 'L.L.C', 'L.L.P', 'P.L.C', 'S.A.S', 'S.R.L', 'S.r.l', 'S.p.A', 'S.L.U', 'LLLP', 'PLLC',
    'EIRELI', 'gGmbH', 'GmbH', 'KGaA', 'SARL', 'LTDA', 'LLC', 'LLP', 'PLC', 'Inc', 'Corp', 'Ltd', 'Pty', 'Pte',
    'OHG', 'e.V', 'S.A', 'S/A', 'S/S', 'SRL', 'S.L', 'SLU', 'N.V', 'B.V', 'A/S', 'Oyj', 'ApS', 'K.K', 'Sdn', 'Bhd',
    'Tbk', 'LDA', 'EPP', 'L.P', 'P.C',
];
/** Só escritas assim (siglas que também são palavras: "Wang Mei", "Hotel Spa" ficam inteiros). */
const COMPANY_SUFFIXES_EXACT = ['Co', 'CO', 'AG', 'KG', 'UG', 'SE', 'SA', 'SAS', 'AB', 'AS', 'ASA', 'NV', 'BV', 'LP', 'PC', 'SL', 'SS', 'KK', 'ME', 'MEI', 'Oy', 'SpA'];

function company_suffix_re(array $list, string $flags): string
{
    usort($list, static fn (string $a, string $b): int => mb_strlen($b) <=> mb_strlen($a));
    $alternatives = implode('|', array_map(static fn (string $s): string => preg_quote($s, '/'), $list));
    // O sufixo vem depois de espaço, vírgula ou traço, e pode ter ponto final.
    return '/[\s,\-–—]+(?:' . $alternatives . ')\.?$/u' . $flags;
}

/** A razão social sem o sufixo jurídico do final ("Acme Health LLC" → "Acme Health"); nunca vazio. */
function company_name(string $legalName): string
{
    static $anyCase = null, $exact = null;
    $anyCase ??= company_suffix_re(COMPANY_SUFFIXES_ANY_CASE, 'i');
    $exact ??= company_suffix_re(COMPANY_SUFFIXES_EXACT, '');

    $original = trim($legalName);
    $name = $original;
    for ($i = 0; $i < 6; $i++) {
        if (preg_match($anyCase, $name, $m, PREG_OFFSET_CAPTURE) !== 1 && preg_match($exact, $name, $m, PREG_OFFSET_CAPTURE) !== 1) {
            break;
        }
        $pos = $m[0][1];
        if ($pos === 0) {
            break;
        }
        $rest = (string) preg_replace('/[\s,\-–—&]+$/u', '', substr($name, 0, $pos));
        if ($rest === '') {
            break;
        }
        $name = $rest;
    }
    return $name !== '' ? $name : $original;
}

/** "September 23, 2026" / "23 de setembro de 2026"… */
function placeholder_long_date(DateTimeImmutable $day, string $lang): string
{
    [$months, $format] = PLACEHOLDER_DATE_FORMATS[$lang] ?? PLACEHOLDER_DATE_FORMATS['en'];
    return strtr($format, ['{d}' => $day->format('j'), '{m}' => $months[(int) $day->format('n') - 1], '{y}' => $day->format('Y')]);
}

/**
 * Os valores desta visita: os do domínio (só texto) + os automáticos.
 * null = a rota não traz marcadores (não troca nada).
 *
 * @return array<string,string>|null
 */
function placeholder_values(array $route, Request $req, ?DateTimeImmutable $now = null): ?array
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

    $domain = $values['domain'] ?? $req->host;
    $lang = languages_from_header($req->acceptLanguage)[0] ?? 'en';
    $today = ($now ?? new DateTimeImmutable('now'))->setTimezone(new DateTimeZone(PLACEHOLDER_TZ));

    $values['company.name'] = company_name($values['company.llc'] ?? '');
    $values['domain'] = $domain;
    $values['url'] = 'https://' . $domain . $req->path;
    $values['slug'] = (string) ($route['slug'] ?? $req->path);
    $values['lang'] = $lang;
    $values['language'] = PLACEHOLDER_LANGUAGE_NAMES[$lang] ?? $lang;
    $values['date'] = placeholder_long_date($today, $lang);
    $values['year'] = $today->format('Y');
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
