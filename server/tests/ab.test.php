<?php
declare(strict_types=1);

// ── A/B test: one sample per step, fixed per visitor (dop_ab cookie) ──

$abDoc = static fn (string $body) => "<!doctype html>\n<html><head><title>t</title></head><body>$body<script data-dop-runtime>(function(){})();</script></body></html>";
$ab = $abDoc(
    '<section data-dop-page="p_pa" data-dop-kind="presell" data-dop-weight="70" data-dop-start><h1>PRE-A</h1></section>'
    . '<section data-dop-page="p_pb" data-dop-kind="presell" data-dop-weight="30" hidden><h1>PRE-B</h1></section>'
    . '<section data-dop-page="p_la" data-dop-kind="main" hidden><h1>LAN-A</h1></section>'
    . '<section data-dop-page="p_bra" data-dop-kind="backredirect" data-dop-weight="50" hidden><h1>BR-A</h1></section>'
    . '<section data-dop-page="p_brb" data-dop-kind="backredirect" data-dop-weight="50" hidden> <!-- empty --> </section>'
);
$fixed = static fn (int $n) => static fn (int $max): int => min($n, $max - 1);
$uid = '0123456789abcdef';

check('no sections: null', ab_apply('<html><body><h1>x</h1></body></html>', []) === null);

$r = ab_apply($ab, [], $fixed(0));
same('draw 0 of 100 → Pre Lander A (weight 70)', 'p_pa', $r['tag']);
check('the step\'s other sample is removed from the HTML', !str_contains($r['html'], 'PRE-B') && str_contains($r['html'], 'PRE-A'));
check('a step with one active sample is not a test (Lander and Backredirect stay)', str_contains($r['html'], 'LAN-A') && str_contains($r['html'], 'BR-A'));
check('an empty (inactive) sample is left out of the draw', !str_contains($r['tag'], 'p_brb'));
check('body untouched (no counting attribute)', str_contains($r['html'], '<body>'));
check('new cookie: visitor + drawn sample', preg_match('/^[0-9a-f]{16}:p_pa$/', (string) $r['cookie']) === 1, (string) $r['cookie']);

$r = ab_apply($ab, [], $fixed(85));
same('draw 85 of 100 → Pre Lander B (weight 30)', 'p_pb', $r['tag']);
check('B drawn in the initial step is visible without JS (no hidden)', preg_match('/<section data-dop-page="p_pb"[^>]*>/', $r['html'], $m) === 1 && !str_contains($m[0], 'hidden'), $m[0] ?? '');

$r = ab_apply($ab, ['dop_ab' => "$uid:p_pb"], $fixed(0));
same('cookie wins: a visitor who got B stays on B', 'p_pb', $r['tag']);
same('same cookie: not sent again', null, $r['cookie']);

$r = ab_apply($ab, ['dop_ab' => "$uid:p_zz,p_pb"], $fixed(0));
same('ids from other pages stay in the cookie, this page\'s first', "$uid:p_pb,p_zz", $r['cookie']);
same('malformed cookie: new visitor', 1, preg_match('/^[0-9a-f]{16}:p_pa$/', (string) ab_apply($ab, ['dop_ab' => '<x>'], $fixed(0))['cookie']));

$paused = str_replace('data-dop-weight="30"', 'data-dop-weight="0"', $ab);
same('weight 0 = paused: not even visitors who had it stay on it', 'p_pa', ab_apply($paused, ['dop_ab' => "$uid:p_pb"], $fixed(99))['tag']);
$zeros = str_replace(['data-dop-weight="70"', 'data-dop-weight="30"'], 'data-dop-weight="0"', $ab);
same('all 0: equal shares (draw 1 of 2 → B)', 'p_pb', ab_apply($zeros, [], $fixed(1))['tag']);
$noWeight = str_replace(['data-dop-weight="70"', 'data-dop-weight="30"'], '', $ab);
same('no weight = 50 each (draw 60 of 100 → B)', 'p_pb', ab_apply($noWeight, [], $fixed(60))['tag']);

// Distribution: 10k real draws land close to 70/30.
$a = 0;
for ($i = 0; $i < 10000; $i++) {
    if (ab_apply($ab, [])['tag'] === 'p_pa') {
        $a++;
    }
}
check('10k draws: ~70% on A', $a > 6700 && $a < 7300, "A=$a");

same('parse: visitor and ids', [$uid, ['p_a', 'p_b']], ab_parse_cookie("$uid:p_a,p_b"));
same('parse: visitor only', [$uid, []], ab_parse_cookie($uid));
same('parse: garbage', [null, []], ab_parse_cookie("$uid:../x"));
same('cookie header', "dop_ab=$uid:p_a; Path=/; Max-Age=2592000; HttpOnly; Secure; SameSite=Lax", ab_cookie("$uid:p_a"));

// ── serve_slug: sample in the ETag, Vary: Cookie and Set-Cookie ──
$abSlug = '33333333-3333-3333-3333-333333333333';
cache_put_content('ab01', $ab);
$abRoute = ['slug_id' => $abSlug, 'content_hash' => 'ab01', 'content_type' => 'text/html', 'funnel' => true];
[$status, $headers, $body] = serve_slug($abRoute, make_request(['HTTP_COOKIE' => "dop_ab=$uid:p_pb"]));
same('serve: 200', 200, $status);
same('serve: ETag with the sample', '"ab01-p_pb-b3"', $headers['ETag']);
check('serve: Vary with Cookie', str_contains($headers['Vary'], 'Cookie'));
check('serve: no Set-Cookie when the cookie is already right', !isset($headers['Set-Cookie']));
check('serve: body with sample B only', str_contains((string) $body, 'PRE-B') && !str_contains((string) $body, 'PRE-A'));
same('serve: 304 with the same sample', 304, serve_slug($abRoute, make_request(['HTTP_COOKIE' => "dop_ab=$uid:p_pb", 'HTTP_IF_NONE_MATCH' => '"ab01-p_pb-b3"']))[0]);
[$status, $headers] = serve_slug($abRoute, make_request());
check('serve: new visitor gets Set-Cookie dop_ab', is_array($headers['Set-Cookie'] ?? null) && str_starts_with($headers['Set-Cookie'][0], 'dop_ab='), json_encode($headers['Set-Cookie'] ?? null));

// Page with steps but no test: ETag without a sample, no Vary Cookie, no cookie.
$plainFunnel = $abDoc('<section data-dop-page="p_x" data-dop-kind="presell" data-dop-start><h1>P</h1></section><section data-dop-page="p_y" hidden><h1>L</h1></section>');
cache_put_content('ab02', $plainFunnel);
[$status, $headers, $body] = serve_slug(['slug_id' => $abSlug, 'content_hash' => 'ab02', 'content_type' => 'text/html', 'funnel' => true], make_request());
same('no test: ETag is just the hash', '"ab02-b3"', $headers['ETag']);
check('no test: Vary without Cookie', !str_contains($headers['Vary'], 'Cookie'));
check('no test: no dop_ab cookie', !isset($headers['Set-Cookie']));

// Server mode + A/B: the sample first, then the step.
$both = str_replace('<body>', '<body data-dop-funnel="server">', $ab);
cache_put_content('ab03', $both);
[$status, $headers, $body] = serve_slug(['slug_id' => $abSlug, 'content_hash' => 'ab03', 'content_type' => 'text/html', 'funnel' => true], make_request(['HTTP_COOKIE' => "dop_ab=$uid:p_pb; dop_step=p_la"]));
same('server + A/B: ETag sample + step', '"ab03-p_pb-p_la-b3"', $headers['ETag']);
check('server + A/B: only the Lander in the body', str_contains((string) $body, 'LAN-A') && !str_contains((string) $body, 'PRE-'));
check('server + A/B: data-dop-cur on body', str_contains((string) $body, 'data-dop-cur="p_la"'));

// resolver: a slug with sections cannot take the 304 shortcut without reading the content.
check('funnel_has_sections: yes', funnel_has_sections($plainFunnel));
check('funnel_has_sections: no', !funnel_has_sections('<html><body><section class="x">a</section></body></html>'));

