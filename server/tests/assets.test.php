<?php
declare(strict_types=1);

// ── assets.php: the pages' files on this server, the bucket stylesheets inline ──

$B = 'https://testref.supabase.co/storage/v1/object/public/';
$put = static function (string $bucket, string $name, string $data): void {
    $file = assets_file($bucket, $name);
    @mkdir(dirname($file), 0750, true);
    file_put_contents($file, $data);
};
$put('page-assets', 'imported/aa11.css', "\xEF\xBB\xBF@charset \"utf-8\";\n@font-face{font-family:X;src:url(\"{$B}page-assets/imported/ff01.woff2\") format('woff2')}\n/* not </style> */ body{color:red}");
$put('page-assets', 'imported/bb22.css', '.b{background:url(' . $B . 'page-media/2026/09/bg.png)}');
$put('page-assets', 'imported/cc33.css', '@import url("https://fonts.googleapis.com/css?family=Inter");.c{x:1}');

// Which URLs are the buckets'.
check('mentions: a bucket URL', assets_mentions('<img src="' . $B . 'page-media/a.jpg">'));
check('mentions: another project or host is not', !assets_mentions('<img src="https://other.supabase.co/storage/v1/object/public/page-media/a.jpg">'));
same('refs: each file once, both buckets, with or without the scheme; other buckets and unserved types are not',
    [['page-media', '2026/09/a.jpg'], ['page-assets', 'imported/aa11.css']],
    assets_refs('<img src="' . $B . 'page-media/2026/09/a.jpg"><img srcset="//testref.supabase.co/storage/v1/object/public/page-media/2026/09/a.jpg 2x"><link href="' . $B . 'page-assets/imported/aa11.css"><a href="' . $B . 'other/x.jpg"></a><a href="' . $B . 'page-media/x.html"></a>'));
check('name: the buckets\' names', assets_valid_name('generated/64444014-556c/esboco-hero-1791373731923.jpg') && assets_valid_name('weight/1024kb.mp4'));
check('name: no dot segments, no unserved types, no hidden files',
    !assets_valid_name('a/../b.png') && !assets_valid_name('../b.png') && !assets_valid_name('x.php') && !assets_valid_name('x.html') && !assets_valid_name('.dl-123') && !assets_valid_name('a//b.png'));
same('parse url: the file, query ignored', ['page-assets', 'imported/aa11.css'], assets_parse_url($B . 'page-assets/imported/aa11.css?v=2'));
same('parse url: not a bucket URL', null, assets_parse_url('https://fonts.googleapis.com/css?family=Inter'));

// The URLs go local; <meta> keeps them (og:image must be absolute).
same('rewrite: src, srcset, style url() and a script string go to /_dop/a/; <meta> and unserved names keep theirs',
    '<meta property="og:image" content="' . $B . 'page-media/og.jpg"><img src="/_dop/a/page-media/a.jpg" srcset="/_dop/a/page-media/a.jpg 1x, /_dop/a/page-media/b.webp 2x"><div style="background:url(/_dop/a/page-media/c.png)"></div><script>var u="/_dop/a/page-media/weight/1024kb.mp4"</script><a href="' . $B . 'page-media/x.html">',
    assets_rewrite_urls('<meta property="og:image" content="' . $B . 'page-media/og.jpg"><img src="' . $B . 'page-media/a.jpg" srcset="' . $B . 'page-media/a.jpg 1x, //testref.supabase.co/storage/v1/object/public/page-media/b.webp 2x"><div style="background:url(' . $B . 'page-media/c.png)"></div><script>var u="' . $B . 'page-media/weight/1024kb.mp4"</script><a href="' . $B . 'page-media/x.html">'));
same('rewrite: a page without bucket URLs is left as it is', '<p>x</p>', assets_rewrite_urls('<p>x</p>'));

// Stylesheets inline.
$aaInline = "\n@font-face{font-family:X;src:url(\"/_dop/a/page-assets/imported/ff01.woff2\") format('woff2')}\n/* not <\\/style> */ body{color:red}";
[$h, $miss] = assets_build('<head><link href="' . $B . 'page-assets/imported/aa11.css" rel="stylesheet"></head>');
same('inline: the <link> becomes a <style> with the stylesheet, its fonts on this server, without BOM/@charset, "</style" escaped', '<head><style data-dop-asset>' . $aaInline . '</style></head>', $h);
same('inline: nothing missing', [], $miss);
[$h] = assets_build('<link rel="stylesheet" id="font-css" href="' . $B . 'page-assets/imported/bb22.css" media="print" onload="this.media=\'all\'">');
same('inline: the async pattern (media=print + onload) ends up for every medium; the id stays', '<style data-dop-asset id="font-css">.b{background:url(/_dop/a/page-media/2026/09/bg.png)}</style>', $h);
[$h] = assets_build("<link rel='stylesheet' href='{$B}page-assets/imported/bb22.css' media='screen and (max-width: 600px)'>");
check('inline: a real medium stays', str_starts_with($h, '<style data-dop-asset media="screen and (max-width: 600px)">'), $h);
[$h] = assets_build('<noscript><link rel="stylesheet" href="' . $B . 'page-assets/imported/bb22.css"></noscript><script>var t=\'<link rel="stylesheet" href="' . $B . 'page-assets/imported/bb22.css">\'</script><!-- <link rel="stylesheet" href="' . $B . 'page-assets/imported/bb22.css"> -->');
check('inline: never inside <noscript>, <script> or a comment (only the URL)', !str_contains($h, '<style') && substr_count($h, '/_dop/a/page-assets/imported/bb22.css') === 3, $h);
[$h] = assets_build('<link rel="alternate stylesheet" href="' . $B . 'page-assets/imported/bb22.css"><link rel="stylesheet" disabled href="' . $B . 'page-assets/imported/bb22.css"><link rel="preload" as="style" href="' . $B . 'page-assets/imported/bb22.css">');
check('inline: not an alternate, disabled or preload stylesheet', !str_contains($h, '<style') && substr_count($h, '/_dop/a/') === 3, $h);
[$h, $miss] = assets_build('<link href="' . $B . 'page-assets/imported/dd44.css" rel="stylesheet"><link href="https://fonts.googleapis.com/css2?family=Inter" rel="stylesheet">');
same('inline: a stylesheet not on disk stays a <link>, now to this server; another host\'s is untouched',
    '<link href="/_dop/a/page-assets/imported/dd44.css" rel="stylesheet"><link href="https://fonts.googleapis.com/css2?family=Inter" rel="stylesheet">', $h);
same('inline: … and is reported missing', [['page-assets', 'imported/dd44.css']], $miss);

// A leading @import inside a <style>.
[$h] = assets_build('<style data-x>@import url("' . $B . 'page-assets/imported/bb22.css");' . "\n" . '.p{y:2}</style>');
same('import: a leading @import of a bucket stylesheet goes inline', '<style data-x>.b{background:url(/_dop/a/page-media/2026/09/bg.png)}' . "\n" . '.p{y:2}</style>', $h);
[$h] = assets_build('<style>html{margin:0} @import url("' . $B . 'page-assets/imported/bb22.css");</style>');
same('import: after a rule it is ignored by browsers, so it stays (URL local)', '<style>html{margin:0} @import url("/_dop/a/page-assets/imported/bb22.css");</style>', $h);
[$h] = assets_build('<style>@import url("' . $B . 'page-assets/imported/bb22.css") screen;</style>');
check('import: one with a medium stays', str_contains($h, '@import url("/_dop/a/page-assets/imported/bb22.css") screen;'), $h);
[$h] = assets_build('<style>@import url(https://fonts.googleapis.com/css?family=A);@import "' . $B . 'page-assets/imported/bb22.css";.q{}</style>');
check('import: a run with another host\'s @import stays whole', !str_contains($h, '.b{background') && str_contains($h, '@import "/_dop/a/page-assets/imported/bb22.css"'), $h);
[$h] = assets_build('<style>@import url("' . $B . 'page-assets/imported/cc33.css");</style>');
check('import: a stylesheet with an @import of its own stays an @import', str_contains($h, '@import url("/_dop/a/page-assets/imported/cc33.css")'), $h);

// The budget: a stylesheet over it stays a <link>.
$put('page-assets', 'imported/big1.css', str_repeat('.z{color:red}', (int) (ASSETS_INLINE_MAX / 13) + 10));
[$h] = assets_build('<link href="' . $B . 'page-assets/imported/bb22.css" rel="stylesheet"><link href="' . $B . 'page-assets/imported/big1.css" rel="stylesheet">');
check('budget: the one over it stays a <link>', str_contains($h, '<style data-dop-asset>.b{') && str_contains($h, '<link href="/_dop/a/page-assets/imported/big1.css"'), substr($h, 0, 200));

// What a page needs: the HTML's files plus what its stylesheets on disk reference.
same('needed: the stylesheet\'s font comes along', [['page-assets', 'imported/aa11.css'], ['page-media', 'p.jpg'], ['page-assets', 'imported/ff01.woff2']],
    assets_needed('<link href="' . $B . 'page-assets/imported/aa11.css" rel="stylesheet"><img src="' . $B . 'page-media/p.jpg">'));

// The delivery version: written once every file is on disk (or the bucket said it doesn't exist).
$put('page-assets', 'imported/ff01.woff2', 'wOF2');
$put('page-media', 'p.jpg', 'JPG');
$raw = '<html><head><link href="' . $B . 'page-assets/imported/aa11.css" rel="stylesheet"></head><body><img src="' . $B . 'page-media/p.jpg"><img src="' . $B . 'page-media/gone.jpg"></body></html>';
cache_put_content('a55e7001', $raw);
assets_mark('missing', 'page-media/gone.jpg');
check('prepare: every file on disk or missing in the bucket → the delivery version is written', assets_prepare('a55e7001') && is_file(content_built_file('a55e7001')));
same('prepare: the raw HTML stays as it was', $raw, cache_read_content('a55e7001'));
$served = assets_content_html('a55e7001');
check('content: the delivery version is what is served', str_contains((string) $served, '<style data-dop-asset>') && str_contains((string) $served, '<img src="/_dop/a/page-media/p.jpg">') && !str_contains((string) $served, 'testref.supabase.co'), (string) $served);
cache_put_content('a55e7002', '<html><body><img src="' . $B . 'page-media/later.jpg"></body></html>');
same('content: without its delivery version, built now from the disk', '<html><body><img src="/_dop/a/page-media/later.jpg"></body></html>', assets_content_html('a55e7002'));
check('content: … and queued for after the response', in_array('a55e7002', assets_queue(), true));
check('content: … but not written while a file is missing', !is_file(content_built_file('a55e7002')));
cache_put_content('a55e7003', '<p>no files</p>');
check('prepare: a page without bucket files gets its (identical) delivery version', assets_prepare('a55e7003') && assets_content_html('a55e7003') === '<p>no files</p>');
same('content: not on disk', null, assets_content_html('a55e7999'));
cache_touch_content('a55e7002');
check('touch: never creates a delivery version', !is_file(content_built_file('a55e7002')));

// serve_slug: an HTML page goes out in its delivery version, with the revision in the ETag; other types go as they are.
$aSlug = '88888888-8888-4888-8888-888888888888';
[$st, $ah, $ab] = serve_slug(['slug_id' => $aSlug, 'content_hash' => 'a55e7001', 'content_type' => 'text/html; charset=utf-8', 'funnel' => false], make_request());
check('serve: 200 with the files on this server and the stylesheet inline', $st === 200 && str_contains((string) $ab, '<style data-dop-asset>') && !str_contains((string) $ab, 'testref.supabase.co'), (string) $ab);
same('serve: the ETag has the revision', '"a55e7001' . ASSETS_ETAG . '"', $ah['ETag']);
same('serve: 304 with it (no content read)', 304, serve_slug(['slug_id' => $aSlug, 'content_hash' => 'a55e7001', 'content_type' => 'text/html; charset=utf-8', 'funnel' => false], make_request(['HTTP_IF_NONE_MATCH' => $ah['ETag']]))[0]);
cache_put_content('a55e7004', 'Sitemap: ' . $B . 'page-media/s.png');
[, $th, $tb] = serve_slug(['slug_id' => $aSlug, 'content_hash' => 'a55e7004', 'content_type' => 'text/plain', 'funnel' => false], make_request());
check('serve: a text slug goes as it is, ETag without the revision', $tb === 'Sitemap: ' . $B . 'page-media/s.png' && $th['ETag'] === '"a55e7004"', (string) $th['ETag']);

// The route: /_dop/a/<bucket>/<name>.
$put('page-media', 'v/clip.mp4', '0123456789');
$areq = static fn (string $path, array $over = []): Request => make_request(['REQUEST_URI' => $path] + $over);
[$st, $hd, $bd, $file, $off, $len] = assets_response($areq('/_dop/a/page-media/v/clip.mp4'), null);
check('route: 200 from disk, a year immutable, its type, the whole file', $st === 200 && $hd['Cache-Control'] === 'public, max-age=31536000, immutable' && $hd['Content-Type'] === 'video/mp4' && $file === assets_file('page-media', 'v/clip.mp4') && $off === 0 && $len === 10 && $hd['Content-Length'] === '10');
check('route: no cookie, nosniff, ranges accepted', !isset($hd['Set-Cookie']) && $hd['X-Content-Type-Options'] === 'nosniff' && $hd['Accept-Ranges'] === 'bytes');
same('route: 304 with its ETag', 304, assets_response($areq('/_dop/a/page-media/v/clip.mp4', ['HTTP_IF_NONE_MATCH' => $hd['ETag']]), null)[0]);
$r = assets_response($areq('/_dop/a/page-media/v/clip.mp4'), 'bytes=2-5');
same('route: a range → 206 with those bytes', [206, 'bytes 2-5/10', 2, 4], [$r[0], $r[1]['Content-Range'], $r[4], $r[5]]);
$r = assets_response($areq('/_dop/a/page-media/v/clip.mp4'), 'bytes=-3');
same('route: the last N bytes', [206, 'bytes 7-9/10'], [$r[0], $r[1]['Content-Range']]);
$r = assets_response($areq('/_dop/a/page-media/v/clip.mp4'), 'bytes=4-');
same('route: from N to the end', [206, 'bytes 4-9/10', 6], [$r[0], $r[1]['Content-Range'], $r[5]]);
$r = assets_response($areq('/_dop/a/page-media/v/clip.mp4'), 'bytes=20-');
same('route: a range past the end → 416', [416, 'bytes */10'], [$r[0], $r[1]['Content-Range']]);
same('route: several ranges → the whole file', 200, assets_response($areq('/_dop/a/page-media/v/clip.mp4'), 'bytes=0-1,4-5')[0]);
foreach (['/_dop/a/other/x.png', '/_dop/a/page-media/../page-assets/imported/aa11.css', '/_dop/a/page-media/x.php', '/_dop/a/page-media/', '/_dop/a/page-media/.dl-1'] as $bad) {
    same("route: $bad → 404", 404, assets_response($areq($bad), null)[0]);
}
assets_mark('missing', 'page-media/nope.jpg');
$r = assets_response($areq('/_dop/a/page-media/nope.jpg'), null);
same('route: the bucket doesn\'t have it → 404, cached briefly', [404, 'public, max-age=60'], [$r[0], $r[1]['Cache-Control']]);
assets_mark('failed', 'page-media/down.jpg');
$r = assets_response($areq('/_dop/a/page-media/down.jpg'), null);
same('route: couldn\'t fetch it now (Supabase down) → 503, never cached', [503, 'no-store'], [$r[0], $r[1]['Cache-Control']]);
$put('page-assets', 'imported/i.svg', '<svg xmlns="http://www.w3.org/2000/svg"></svg>');
check('route: an SVG can\'t run scripts', str_contains((string) (assets_response($areq('/_dop/a/page-assets/imported/i.svg'), null)[1]['Content-Security-Policy'] ?? ''), "default-src 'none'"));
same('route: only GET/HEAD', 405, assets_response($areq('/_dop/a/page-media/v/clip.mp4', ['REQUEST_METHOD' => 'POST']), null)[0]);

// The deploy's warm-up: every content on disk. A file that just failed isn't tried again (no network here).
assets_mark('failed', 'page-media/later.jpg');
assets_mark('failed', 'page-media/s.png');
$w = assets_warm();
check('warm: every content counted, the one with a file missing not written', $w['contents'] >= 4 && $w['built'] >= 3 && $w['failed'] >= 1 && $w['files'] >= 6 && !is_file(content_built_file('a55e7002')), json_encode($w));
