<?php
/**
 * The pages' files — images, fonts, stylesheets, scripts, video — served by
 * this server, on the page's own domain.
 *
 * The dashboard keeps them in Supabase Storage's public buckets (page-assets:
 * what the import rehosted, named by the content's sha1; page-media: uploads
 * and generated images, never overwritten — `upsert: false`) and the pages'
 * HTML points at the bucket's public URL. Served from there, a Supabase outage
 * took every image, font and stylesheet with it, even with the HTML on disk.
 * So:
 *
 *   - Every file a page uses is copied to ASSETS_DIR, as <bucket>/<name> (the
 *     bucket's own names) — outside the cache folder (purge_all and the content
 *     cleanup never touch it) and outside the webroot. A file never changes (a
 *     new upload is a new name), so a copy never goes stale and is never
 *     deleted. The bucket stays the original: the dashboard writes there, and a
 *     lost disk is refilled from it.
 *   - The HTML gets a delivery version (content/<h2>/<hash>.a<rev>.php, next to
 *     the raw one, same cleanup): the bucket URLs become /_dop/a/<bucket>/<name>
 *     on the same domain, and each stylesheet from the bucket goes INLINE, in a
 *     <style> where its <link> (or a leading @import) was — its fonts and
 *     backgrounds point to /_dop/a/ too. The database and the dashboard don't
 *     change: the editor keeps the bucket's URLs. <meta> tags are left alone
 *     (og:image/twitter:image must stay absolute URLs; only link previews read them).
 *   - /_dop/a/<bucket>/<name> serves the copy (a year, immutable: Cloudflare
 *     keeps it at the edge). A file not on disk is fetched from the bucket once
 *     and kept; with Supabase down, only that file fails (503, never cached).
 *
 * When the files arrive: a content refreshed or served without its delivery
 * version is queued, and AFTER the response its files are downloaded (in
 * parallel) and the delivery version is written — only once every file it
 * references is on disk (or the bucket said it doesn't exist). Until then each
 * response builds it on the fly from what is on disk (a stylesheet not there
 * yet stays a <link> to /_dop/a/, which fetches it).
 */
declare(strict_types=1);

defined('DAYONE_ENTRY') || (http_response_code(404) && exit);

const ASSETS_PATH = '/_dop/a/';
const ASSETS_BUCKETS = ['page-assets', 'page-media'];

/** The delivery version's revision: a change to assets_build is a new revision (new files, new ETags). */
const ASSETS_REV = 1;
const ASSETS_ETAG = '-a' . ASSETS_REV;

/** Extension → Content-Type: what may be stored and served (the buckets' types). Nothing that runs here or opens as a page. */
const ASSETS_TYPES = [
    'css' => 'text/css; charset=utf-8',
    'js' => 'text/javascript; charset=utf-8',
    'woff2' => 'font/woff2',
    'woff' => 'font/woff',
    'ttf' => 'font/ttf',
    'otf' => 'font/otf',
    'eot' => 'application/vnd.ms-fontobject',
    'jpg' => 'image/jpeg',
    'jpeg' => 'image/jpeg',
    'png' => 'image/png',
    'webp' => 'image/webp',
    'avif' => 'image/avif',
    'gif' => 'image/gif',
    'svg' => 'image/svg+xml',
    'ico' => 'image/x-icon',
    'bmp' => 'image/bmp',
    'mp4' => 'video/mp4',
    'webm' => 'video/webm',
    'mov' => 'video/quicktime',
    'mp3' => 'audio/mpeg',
    'ogg' => 'audio/ogg',
    'wav' => 'audio/wav',
    'm4a' => 'audio/mp4',
    'vtt' => 'text/vtt; charset=utf-8',
];

/** The buckets' ceiling (100 MB). */
const ASSETS_MAX_BYTES = 104857600;
/** Stylesheets inlined per page; beyond that, a stylesheet stays a <link>. */
const ASSETS_INLINE_MAX = 1048576;
/** A download that failed (network, 5xx) is not tried again before this. */
const ASSETS_RETRY_AFTER = 60;
/** The bucket said the file doesn't exist: not asked again before this. */
const ASSETS_MISSING_TTL = 600;
/** Timeouts: a visitor waiting on /_dop/a/, and the downloads after a response. */
const ASSETS_LAZY_TIMEOUT = 30;
const ASSETS_FETCH_TIMEOUT = 120;
/** Contents prepared per request (after the response). */
const ASSETS_PREPARE_PER_REQUEST = 4;

function assets_dir(): string
{
    return rtrim(config()['assets_dir'], '/');
}

function assets_file(string $bucket, string $name): string
{
    return assets_dir() . '/' . $bucket . '/' . $name;
}

/** The bucket's public URL of a file. */
function assets_source_url(string $bucket, string $name): string
{
    return config()['supabase_url'] . '/storage/v1/object/public/' . $bucket . '/' . $name;
}

/** The Supabase host the pages' URLs carry ('' = not configured: nothing is rewritten). */
function assets_source_host(): string
{
    return strtolower((string) (parse_url(config()['supabase_url'], PHP_URL_HOST) ?? ''));
}

/** A bucket URL, as the pages write it (with or without the scheme); groups: bucket, name. */
function assets_url_pattern(): string
{
    $buckets = implode('|', array_map(static fn(string $b): string => preg_quote($b, '~'), ASSETS_BUCKETS));
    return '(?:https?:)?//' . preg_quote(assets_source_host(), '~') . '/storage/v1/object/public/(' . $buckets . ')/([A-Za-z0-9._/-]+)';
}

function assets_ext(string $name): string
{
    return strtolower(pathinfo($name, PATHINFO_EXTENSION));
}

/** A file name this server stores: the buckets' characters, no dot segments, a type from the list. */
function assets_valid_name(string $name): bool
{
    return strlen($name) <= 300
        && preg_match('~^[A-Za-z0-9][A-Za-z0-9._-]*(?:/[A-Za-z0-9][A-Za-z0-9._-]*)*$~', $name) === 1
        && isset(ASSETS_TYPES[assets_ext($name)]);
}

/** Does the text point at the buckets at all? (the cheap test before any regex) */
function assets_mentions(string $text): bool
{
    $host = assets_source_host();
    return $host !== '' && stripos($text, '//' . $host . '/storage/v1/object/public/') !== false;
}

/**
 * Every bucket file the text references, once each.
 *
 * @return list<array{0: string, 1: string}> [bucket, name]
 */
function assets_refs(string $text): array
{
    if (!assets_mentions($text)) {
        return [];
    }
    preg_match_all('~' . assets_url_pattern() . '~i', $text, $m, PREG_SET_ORDER);
    $out = [];
    foreach ($m as $x) {
        $bucket = strtolower($x[1]);
        if (assets_valid_name($x[2])) {
            $out["$bucket/$x[2]"] = [$bucket, $x[2]];
        }
    }
    return array_values($out);
}

/** A bucket file from its URL (query and fragment ignored); null when it isn't one this server serves. */
function assets_parse_url(string $url): ?array
{
    if (assets_source_host() === '' || preg_match('~^\s*' . assets_url_pattern() . '(?:[?#][^\s]*)?\s*$~i', $url, $m) !== 1) {
        return null;
    }
    return assets_valid_name($m[2]) ? [strtolower($m[1]), $m[2]] : null;
}

/**
 * The bucket URLs in the HTML pointing to this server: /_dop/a/<bucket>/<name>.
 * <meta> tags keep theirs (og:image must be absolute); a name this server
 * doesn't serve keeps the bucket's URL.
 */
function assets_rewrite_urls(string $html): string
{
    if (!assets_mentions($html)) {
        return $html;
    }
    $out = preg_replace_callback('~<meta\b[^>]*>|' . assets_url_pattern() . '~i', static function (array $m): string {
        if (!isset($m[1]) || !assets_valid_name($m[2])) {
            return $m[0];
        }
        return ASSETS_PATH . strtolower($m[1]) . '/' . $m[2];
    }, $html);
    return $out ?? $html;
}

/** A tag's attributes, name (lowercase) → value (entities decoded); the first of a repeated name wins, as in browsers. */
function assets_tag_attrs(string $tag): array
{
    $inner = (string) preg_replace('~^<[A-Za-z][^\s/>]*|/?>$~', '', $tag);
    preg_match_all('~([^\s"\'<>/=]+)(?:\s*=\s*(?:"([^"]*)"|\'([^\']*)\'|([^\s"\'=<>`]+)))?~', $inner, $m, PREG_SET_ORDER);
    $out = [];
    foreach ($m as $x) {
        $name = strtolower($x[1]);
        if (!array_key_exists($name, $out)) {
            $out[$name] = html_entity_decode(($x[2] ?? '') . ($x[3] ?? '') . ($x[4] ?? ''), ENT_QUOTES | ENT_HTML5, 'UTF-8');
        }
    }
    return $out;
}

/** A bucket stylesheet's text for a <style>, from disk; null when it isn't there. */
function assets_css_text(string $bucket, string $name): ?string
{
    $css = @file_get_contents(assets_file($bucket, $name));
    if ($css === false) {
        return null;
    }
    if (str_starts_with($css, "\xEF\xBB\xBF")) {
        $css = substr($css, 3);
    }
    // @charset means nothing inside a <style>; "</style" would end it early.
    $css = (string) preg_replace('~^\s*@charset\s+(["\'])[^"\']*\1\s*;~i', '', $css, 1);
    return (string) preg_replace('~</(style)~i', '<\\\\/$1', $css);
}

/**
 * A <link> tag: the bucket stylesheet inline, as a <style> in its place, or
 * the tag unchanged (not a bucket stylesheet, not on disk — then it goes in
 * $missing — or over the budget).
 */
function assets_inline_link(string $tag, int &$budget, array &$missing): string
{
    $a = assets_tag_attrs($tag);
    $rel = ' ' . strtolower((string) preg_replace('~\s+~', ' ', $a['rel'] ?? '')) . ' ';
    if (!str_contains($rel, ' stylesheet ') || str_contains($rel, ' alternate ') || array_key_exists('disabled', $a)) {
        return $tag;
    }
    $ref = assets_parse_url($a['href'] ?? '');
    if ($ref === null || assets_ext($ref[1]) !== 'css') {
        return $tag;
    }
    $css = assets_css_text($ref[0], $ref[1]);
    if ($css === null) {
        $missing[] = $ref;
        return $tag;
    }
    if (strlen($css) > $budget) {
        return $tag;
    }
    $budget -= strlen($css);

    // The async pattern — media="print" onload="this.media='all'" — ends up as the onload's medium.
    $media = trim($a['media'] ?? '');
    if (preg_match('~\bmedia\s*=\s*([\'"])([^\'"]*)\1~i', $a['onload'] ?? '', $om) === 1) {
        $media = trim($om[2]);
    }
    $attrs = ' data-dop-asset';
    if (($a['id'] ?? '') !== '') {
        $attrs .= ' id="' . htmlspecialchars($a['id'], ENT_QUOTES, 'UTF-8') . '"';
    }
    if ($media !== '' && strtolower($media) !== 'all') {
        $attrs .= ' media="' . htmlspecialchars($media, ENT_QUOTES, 'UTF-8') . '"';
    }
    return "<style$attrs>" . $css . '</style>';
}

/**
 * A <style>'s CSS with its leading @import of bucket stylesheets inline, or
 * null to leave it as it is. Only a run of @import at the top counts (one
 * after a rule is ignored by browsers, so it stays ignored), and only when
 * EVERY @import in the run is a bucket stylesheet on disk, without media or
 * other conditions and without an @import of its own (it would land after rules).
 */
function assets_inline_imports(string $css, int &$budget, array &$missing): ?string
{
    if (stripos($css, '@import') === false) {
        return null;
    }
    $pos = 0;
    $parts = [];
    while (true) {
        preg_match('~\G(?:\s+|/\*.*?\*/)*~s', $css, $m, 0, $pos);
        $pos += strlen($m[0]);
        if (preg_match('~\G@charset\s+(["\'])[^"\']*\1\s*;~i', $css, $m, 0, $pos) === 1) {
            $pos += strlen($m[0]);
            continue;
        }
        if (preg_match('~\G@import\s+(?:url\(\s*(["\']?)([^"\')\s]+)\1\s*\)|(["\'])([^"\']+)\3)([^;]*);~i', $css, $m, 0, $pos) !== 1) {
            break;
        }
        $ref = assets_parse_url($m[2] !== '' ? $m[2] : $m[4]);
        if ($ref === null || assets_ext($ref[1]) !== 'css' || trim($m[5]) !== '') {
            return null;
        }
        $text = assets_css_text($ref[0], $ref[1]);
        if ($text === null) {
            $missing[] = $ref;
            return null;
        }
        if (stripos($text, '@import') !== false) {
            return null;
        }
        $parts[] = $text;
        $pos += strlen($m[0]);
    }
    $size = array_sum(array_map('strlen', $parts));
    if ($parts === [] || $size > $budget) {
        return null;
    }
    $budget -= $size;
    return implode("\n", $parts) . "\n" . substr($css, $pos);
}

/**
 * A page's delivery version, from what is on disk: [html, missing] — missing
 * = the bucket stylesheets it would inline that aren't on disk (they stay
 * <link>s, now to /_dop/a/). <script>, <noscript>, <textarea> and comments
 * only get their URLs rewritten: a <style> inside them would break them, or
 * duplicate what the page already has.
 *
 * @return array{0: string, 1: list<array{0: string, 1: string}>}
 */
function assets_build(string $html): array
{
    if (!assets_mentions($html)) {
        return [$html, []];
    }
    $budget = ASSETS_INLINE_MAX;
    $missing = [];
    $out = preg_replace_callback(
        '~<script\b[^>]*>.*?</script\s*>|<!--.*?-->|<noscript\b[^>]*>.*?</noscript\s*>|<textarea\b[^>]*>.*?</textarea\s*>|<link\b[^>]*>|(<style\b[^>]*>)(.*?)(</style\s*>)~is',
        static function (array $m) use (&$budget, &$missing): string {
            if (strncasecmp($m[0], '<link', 5) === 0) {
                return assets_inline_link($m[0], $budget, $missing);
            }
            if (($m[1] ?? '') !== '') {
                $css = assets_inline_imports($m[2], $budget, $missing);
                return $css === null ? $m[0] : $m[1] . $css . $m[3];
            }
            return $m[0];
        },
        $html,
    );
    if ($out === null) {
        // A PCRE limit on a huge page: nothing inline, but the URLs still go local.
        error_log('[dayone-pages] assets: inline skipped (' . preg_last_error_msg() . ')');
        $out = $html;
    }
    return [assets_rewrite_urls($out), array_values(array_unique($missing, SORT_REGULAR))];
}

/**
 * Every bucket file a page needs that is known now: the HTML's, plus what the
 * stylesheets on disk reference (fonts, backgrounds, an @import), a few levels deep.
 *
 * @return list<array{0: string, 1: string}>
 */
function assets_needed(string $html): array
{
    $all = [];
    $queue = assets_refs($html);
    for ($depth = 0; $queue !== [] && $depth < 4; $depth++) {
        $next = [];
        foreach ($queue as [$bucket, $name]) {
            if (isset($all["$bucket/$name"])) {
                continue;
            }
            $all["$bucket/$name"] = [$bucket, $name];
            if (assets_ext($name) === 'css') {
                $css = @file_get_contents(assets_file($bucket, $name));
                if ($css !== false) {
                    array_push($next, ...assets_refs($css));
                }
            }
        }
        $queue = $next;
    }
    return array_values($all);
}

function assets_marker(string $kind, string $key): string
{
    return cache_dir() . '/assets/' . $kind . '/' . sha1($key);
}

function assets_marker_fresh(string $kind, string $key, int $ttl): bool
{
    $t = @filemtime(assets_marker($kind, $key));
    return $t !== false && time() - $t < $ttl;
}

function assets_mark(string $kind, string $key): void
{
    $file = assets_marker($kind, $key);
    if (!is_dir(dirname($file))) {
        @mkdir(dirname($file), 0750, true);
    }
    @touch($file);
}

/**
 * Downloads bucket files to ASSETS_DIR, in parallel (atomic: a reader never
 * sees half a file). Per "bucket/name": true = on disk, 'missing' = the bucket
 * doesn't have it (not asked again for ASSETS_MISSING_TTL), false = failed
 * (network, 5xx: not tried again for ASSETS_RETRY_AFTER).
 *
 * @param list<array{0: string, 1: string}> $refs
 * @return array<string, true|false|'missing'>
 */
function assets_download(array $refs, int $timeout): array
{
    $result = [];
    $jobs = [];
    $mh = curl_multi_init();
    curl_multi_setopt($mh, CURLMOPT_MAX_HOST_CONNECTIONS, 8);
    foreach ($refs as [$bucket, $name]) {
        $key = "$bucket/$name";
        $file = assets_file($bucket, $name);
        $dir = dirname($file);
        $tmp = (is_dir($dir) || @mkdir($dir, 0750, true) || is_dir($dir)) ? @tempnam($dir, '.dl-') : false;
        $fh = $tmp !== false ? @fopen($tmp, 'wb') : false;
        if ($fh === false) {
            if ($tmp !== false) {
                @unlink($tmp);
            }
            error_log("[dayone-pages] assets: can't write $file");
            $result[$key] = false;
            continue;
        }
        $ch = curl_init(assets_source_url($bucket, $name));
        curl_setopt_array($ch, [
            CURLOPT_FILE => $fh,
            CURLOPT_CONNECTTIMEOUT => 3,
            CURLOPT_TIMEOUT => $timeout,
            CURLOPT_MAXFILESIZE_LARGE => ASSETS_MAX_BYTES,
            CURLOPT_USERAGENT => 'dayone-pages/assets',
        ]);
        curl_multi_add_handle($mh, $ch);
        $jobs[] = [$ch, $fh, $tmp, $file, $key];
    }
    do {
        $status = curl_multi_exec($mh, $running);
        if ($running > 0 && curl_multi_select($mh, 1.0) === -1) {
            usleep(10_000);
        }
    } while ($running > 0 && $status === CURLM_OK);

    foreach ($jobs as [$ch, $fh, $tmp, $file, $key]) {
        fclose($fh);
        $code = (int) curl_getinfo($ch, CURLINFO_RESPONSE_CODE);
        $ok = curl_errno($ch) === 0 && $code === 200;
        curl_multi_remove_handle($mh, $ch);
        if ($ok) {
            @chmod($tmp, 0640);
            $ok = @rename($tmp, $file);
        }
        if ($ok) {
            $result[$key] = true;
            continue;
        }
        @unlink($tmp);
        // Storage answers a missing object with 400 (older) or 404.
        if ($code === 400 || $code === 404) {
            assets_mark('missing', $key);
            $result[$key] = 'missing';
        } else {
            assets_mark('failed', $key);
            error_log("[dayone-pages] assets: download failed for $key (HTTP $code)");
            $result[$key] = false;
        }
    }
    return $result;
}

/**
 * Brings a content's files to disk and, once they're all there (or the bucket
 * said one doesn't exist), writes its delivery version. true = written.
 */
function assets_prepare(string $hash): bool
{
    $built = content_built_file($hash);
    if (is_file($built)) {
        return true;
    }
    $raw = cache_read_content($hash);
    if ($raw === null) {
        return false;
    }
    // The stylesheets come down first, then what they reference (fonts, backgrounds).
    for ($round = 0; $round < 4; $round++) {
        $todo = [];
        foreach (assets_needed($raw) as [$bucket, $name]) {
            $key = "$bucket/$name";
            if (is_file(assets_file($bucket, $name)) || assets_marker_fresh('missing', $key, ASSETS_MISSING_TTL)) {
                continue;
            }
            if (assets_marker_fresh('failed', $key, ASSETS_RETRY_AFTER)) {
                return false; // it just failed (Supabase down?): the next try comes later
            }
            $todo[] = [$bucket, $name];
        }
        if ($todo === []) {
            [$html] = assets_build($raw);
            return atomic_write($built, cache_wrap($html));
        }
        if (in_array(false, assets_download($todo, ASSETS_FETCH_TIMEOUT), true)) {
            return false;
        }
    }
    return false;
}

/** Queues a content for assets_prepare_pending; returns the queue (one request's). */
function assets_queue(?string $hash = null): array
{
    static $queue = [];
    if ($hash !== null && $hash !== '') {
        $queue[$hash] = true;
    }
    return array_keys($queue);
}

/** After the response: the queued contents without a delivery version get one (assets_prepare). */
function assets_prepare_pending(): void
{
    $done = 0;
    foreach (assets_queue() as $hash) {
        if (is_file(content_built_file($hash)) || assets_marker_fresh('tried', $hash, ASSETS_RETRY_AFTER)) {
            continue;
        }
        if (++$done > ASSETS_PREPARE_PER_REQUEST) {
            return;
        }
        $lock = try_lock("assets|$hash");
        if ($lock === null) {
            continue;
        }
        try {
            assets_mark('tried', $hash);
            @set_time_limit(600);
            if (assets_prepare($hash)) {
                @unlink(assets_marker('tried', $hash));
            }
        } finally {
            unlock($lock);
        }
    }
}

/**
 * The HTML to serve for a content: its delivery version, or — while it isn't
 * written — one built now from what is on disk (and the content queued). null
 * = the content isn't on disk.
 */
function assets_content_html(string $hash): ?string
{
    $built = @file_get_contents(content_built_file($hash));
    if ($built !== false && ($html = cache_unwrap($built)) !== null) {
        return $html;
    }
    $raw = cache_read_content($hash);
    if ($raw === null) {
        return null;
    }
    assets_queue($hash);
    return assets_build($raw)[0];
}

/**
 * Every content on disk gets its files and its delivery version now (the
 * deploy's warm-up: `php -r` with the site's bootstrap). Returns the counts.
 *
 * @return array{contents: int, built: int, failed: int, files: int}
 */
function assets_warm(): array
{
    $stats = ['contents' => 0, 'built' => 0, 'failed' => 0, 'files' => 0];
    $dir = cache_dir() . '/content';
    if (!is_dir($dir)) {
        return $stats;
    }
    @set_time_limit(0);
    foreach (new RecursiveIteratorIterator(new RecursiveDirectoryIterator($dir, FilesystemIterator::SKIP_DOTS)) as $item) {
        $hash = $item->getBasename('.php');
        if (!$item->isFile() || preg_match('~^[a-f0-9]+$~', $hash) !== 1) {
            continue; // a delivery version or a temporary file
        }
        $stats['contents']++;
        $stats[assets_prepare($hash) ? 'built' : 'failed']++;
    }
    foreach (ASSETS_BUCKETS as $bucket) {
        if (is_dir(assets_dir() . "/$bucket")) {
            foreach (new RecursiveIteratorIterator(new RecursiveDirectoryIterator(assets_dir() . "/$bucket", FilesystemIterator::SKIP_DOTS)) as $f) {
                $stats['files'] += $f->isFile() && !str_starts_with($f->getFilename(), '.') ? 1 : 0;
            }
        }
    }
    return $stats;
}

/**
 * A file for /_dop/a/: on disk, or fetched from the bucket now (once, by one
 * worker; the others wait for it). true = on disk, 'missing' = the bucket
 * doesn't have it, false = couldn't fetch it now.
 */
function assets_fetch_one(string $bucket, string $name): bool|string
{
    $key = "$bucket/$name";
    $file = assets_file($bucket, $name);
    if (assets_marker_fresh('missing', $key, ASSETS_MISSING_TTL)) {
        return 'missing';
    }
    if (assets_marker_fresh('failed', $key, ASSETS_RETRY_AFTER)) {
        return false;
    }
    $lock = try_lock("asset|$key");
    if ($lock === null) {
        for ($i = 0; $i < 100; $i++) {
            usleep(100_000);
            clearstatcache();
            if (is_file($file)) {
                return true;
            }
            if (assets_marker_fresh('missing', $key, ASSETS_MISSING_TTL)) {
                return 'missing';
            }
            if (assets_marker_fresh('failed', $key, ASSETS_RETRY_AFTER)) {
                return false;
            }
        }
        return false;
    }
    try {
        return is_file($file) ? true : (assets_download([[$bucket, $name]], ASSETS_LAZY_TIMEOUT)[$key] ?? false);
    } finally {
        unlock($lock);
    }
}

/**
 * GET/HEAD /_dop/a/<bucket>/<name>, on any domain: [status, headers, body,
 * file to stream, offset, length]. Small answers come in the body; the file
 * is streamed by assets_send (a video can be 100 MB). One byte range is
 * honored (video players ask for them); several get the whole file.
 *
 * @return array{0: int, 1: array<string,string>, 2: ?string, 3: ?string, 4: int, 5: int}
 */
function assets_response(Request $req, ?string $range): array
{
    if ($req->method !== 'GET' && $req->method !== 'HEAD') {
        return [405, ['Allow' => 'GET, HEAD', 'Content-Type' => 'text/plain; charset=utf-8', 'Cache-Control' => 'no-store'], "Method not allowed\n", null, 0, 0];
    }
    [$bucket, $name] = explode('/', substr($req->rawPath, strlen(ASSETS_PATH)), 2) + [1 => ''];
    if (!in_array($bucket, ASSETS_BUCKETS, true) || !assets_valid_name($name)) {
        return assets_not_found();
    }
    $file = assets_file($bucket, $name);
    if (!is_file($file)) {
        $got = assets_fetch_one($bucket, $name);
        if ($got === 'missing') {
            return assets_not_found();
        }
        if ($got !== true) {
            return [503, ['Content-Type' => 'text/plain; charset=utf-8', 'Cache-Control' => 'no-store', 'Retry-After' => '30'], "Unavailable\n", null, 0, 0];
        }
    }
    $size = (int) filesize($file);
    $ext = assets_ext($name);
    $headers = [
        'Content-Type' => ASSETS_TYPES[$ext],
        'Cache-Control' => 'public, max-age=31536000, immutable',
        'ETag' => '"' . substr(sha1("$bucket/$name|$size"), 0, 20) . '"',
        'Accept-Ranges' => 'bytes',
        'X-Content-Type-Options' => 'nosniff',
    ];
    if ($ext === 'svg') {
        // Opened on its own, an SVG is a document on the page's domain: no scripts.
        $headers['Content-Security-Policy'] = "default-src 'none'; img-src data: 'self'; style-src 'unsafe-inline'; font-src data: 'self'";
    }
    if ($req->ifNoneMatch !== null && etag_matches($req->ifNoneMatch, $headers['ETag'])) {
        return [304, $headers, null, null, 0, 0];
    }
    if ($range !== null && preg_match('~^\s*bytes\s*=\s*(\d*)\s*-\s*(\d*)\s*$~i', $range, $r) === 1 && ($r[1] !== '' || $r[2] !== '')) {
        if ($r[1] === '') {
            $start = max(0, $size - (int) $r[2]); // the last N bytes
            $end = $size - 1;
        } else {
            $start = (int) $r[1];
            $end = $r[2] === '' ? $size - 1 : min((int) $r[2], $size - 1);
        }
        if ($size === 0 || $start >= $size || $start > $end) {
            return [416, ['Content-Range' => "bytes */$size", 'Content-Type' => 'text/plain; charset=utf-8', 'Cache-Control' => 'no-store'], '', null, 0, 0];
        }
        $length = $end - $start + 1;
        return [206, $headers + ['Content-Range' => "bytes $start-$end/$size", 'Content-Length' => (string) $length], null, $file, $start, $length];
    }
    return [200, $headers + ['Content-Length' => (string) $size], null, $file, 0, $size];
}

/** A 404 for /_dop/a/: the generic page, cached briefly (a file is never deleted, but one may not be uploaded yet). */
function assets_not_found(): array
{
    [$status, $headers, $body] = not_found();
    $headers['Cache-Control'] = 'public, max-age=60';
    return [$status, $headers, $body, null, 0, 0];
}

/** Sends assets_response's answer: headers, then the body or the file's bytes (none on HEAD). */
function assets_send(Request $req, ?string $range): void
{
    [$status, $headers, $body, $file, $offset, $length] = assets_response($req, $range);
    if ($file === null) {
        send_response($status, $headers, $body, $req->isHead());
        return;
    }
    send_response($status, $headers, null, true);
    if ($req->isHead()) {
        return;
    }
    $fh = @fopen($file, 'rb');
    if ($fh === false) {
        return;
    }
    $out = fopen('php://output', 'wb');
    stream_copy_to_stream($fh, $out, $length, $offset);
    fclose($fh);
}
