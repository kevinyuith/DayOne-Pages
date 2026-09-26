<?php
declare(strict_types=1);

// ── VSL split: the page's A/B VTurb player gets the video drawn (dop_vsl cookie) ──

$vA = 'aaaaaaaaaaaaaaaaaaaaaaaa';
$vB = 'bbbbbbbbbbbbbbbbbbbbbbbb';
$vOld = '6aa9beeba4cec573019656b4';
$other = 'cccccccccccccccccccccccc';
$split = [['id' => $vA, 'weight' => 70], ['id' => $vB, 'weight' => 30]];
$fixed = static fn (int $n) => static fn (int $max): int => min($n, $max - 1);

$player = '<div data-editor-type="custom-video" data-video-id="d115" data-video-provider="vturb" data-vturb-id="' . $vOld . '" data-account-id="acc" id="icq0sp" data-vturb-kind="ab-test" data-vturb-variants="[{&quot;id&quot;:&quot;x&quot;}]"></div>';
$fixedPlayer = '<div data-editor-type="custom-video" data-video-id="e222" data-video-provider="vturb" data-vturb-id="' . $other . '" data-account-id="acc" data-vturb-kind=""></div>';
$plain = "<!doctype html><html><body><h1>t</h1>$player$fixedPlayer</body></html>";
// The page builder keeps the HTML inside a JSON string: quotes as \" and "<" as <.
$json = '<script type="module">var __d={"pages":{"p":{"html":"' . str_replace(['"', '<'], ['\\"', '\\u003c'], $player . $fixedPlayer) . '"}}};</script>';
$escaped = "<!doctype html><html><body>$json</body></html>";

check('no split: null', vsl_apply($plain, null, []) === null && vsl_apply($plain, [], []) === null);
check('split without an A/B player: null', vsl_apply("<html><body>$fixedPlayer</body></html>", $split, []) === null);
check('only paused videos (weight 0): null', vsl_apply($plain, [['id' => $vA, 'weight' => 0]], []) === null);
check('invalid ids are ignored', vsl_apply($plain, [['id' => 'x"><script>', 'weight' => 100]], []) === null);

$r = vsl_apply($plain, $split, [], $fixed(0));
same('draw 0 of 10000 → A (70%)', $vA, $r['tag']);
check('the A/B player now loads A directly', str_contains($r['html'], 'data-vturb-id="' . $vA . '" data-account-id="acc" id="icq0sp" data-vturb-kind=""'), $r['html']);
check('the old test is gone from the player', !str_contains($r['html'], 'data-vturb-id="' . $vOld . '"'));
check('a player with a fixed video is left alone', str_contains($r['html'], $fixedPlayer));
same('new cookie: the drawn video', $vA, $r['cookie']);
same('draw 7000 of 10000 → B (30%)', $vB, vsl_apply($plain, $split, [], $fixed(7000))['tag']);

$r = vsl_apply($escaped, $split, [], $fixed(7000));
same('JSON-escaped player: B drawn', $vB, $r['tag']);
check('JSON-escaped player keeps the \\" quotes', str_contains($r['html'], 'data-vturb-id=\\"' . $vB . '\\"') && str_contains($r['html'], 'data-vturb-kind=\\"\\"'), $r['html']);
check('JSON-escaped: the fixed player is left alone', str_contains($r['html'], 'data-vturb-id=\\"' . $other . '\\"'));
check('JSON-escaped: still valid JSON', json_decode(substr($r['html'], strpos($r['html'], '{'), strrpos($r['html'], '}') - strpos($r['html'], '{') + 1)) !== null);

$r = vsl_apply($plain, $split, ['dop_vsl' => $vB], $fixed(0));
same('cookie wins: a visitor who got B stays on B', $vB, $r['tag']);
same('same cookie: not sent again', null, $r['cookie']);
same('ids from other funnels stay in the cookie, this one first', "$vB,$other", vsl_apply($plain, $split, ['dop_vsl' => "$other,$vB"], $fixed(0))['cookie']);
same('malformed cookie: draws again', $vA, vsl_apply($plain, $split, ['dop_vsl' => '<x>'], $fixed(0))['tag']);
same('paused video (not in the list): the visitor who had it draws again', $vA, vsl_apply($plain, [['id' => $vA, 'weight' => 100], ['id' => $vB, 'weight' => 0]], ['dop_vsl' => $vB], $fixed(9999))['tag']);
$thirds = [['id' => $vA, 'weight' => 33.33], ['id' => $vB, 'weight' => 33.33], ['id' => $other, 'weight' => 33.34]];
same('decimals: 33.33 / 33.33 / 33.34 (draw 6665 → the second, 6666 → the third)', [$vB, $other], [vsl_apply($plain, $thirds, [], $fixed(6665))['tag'], vsl_apply($plain, $thirds, [], $fixed(6666))['tag']]);

$noId = str_replace(' data-vturb-id="' . $vOld . '"', '', $plain);
check('player without data-vturb-id: it gets one', str_contains(vsl_apply($noId, $split, [], $fixed(0))['html'], 'data-vturb-kind="" data-vturb-variants="[{&quot;id&quot;:&quot;x&quot;}]" data-vturb-id="' . $vA . '">'));

// Distribution: 10k real draws land close to 70/30.
$a = 0;
for ($i = 0; $i < 10000; $i++) {
    if (vsl_apply($plain, $split, [])['tag'] === $vA) {
        $a++;
    }
}
check('10k draws: ~70% on A', $a > 6700 && $a < 7300, "A=$a");
same('cookie header', "dop_vsl=$vA; Path=/; Max-Age=2592000; HttpOnly; Secure; SameSite=Lax", vsl_cookie($vA));

// ── serve_slug: video in the ETag, Vary: Cookie, Set-Cookie; the 304 shortcut is skipped ──
$vslSlug = '55555555-5555-4555-8555-555555555555';
cache_put_content('vsl01', $plain);
$vslRoute = ['slug_id' => $vslSlug, 'content_hash' => 'vsl01', 'content_type' => 'text/html', 'funnel' => false, 'match_type' => 'GATE', 'vsl' => $split];
[$status, $headers, $body] = serve_slug($vslRoute, make_request(['HTTP_COOKIE' => "dop_vsl=$vB"]));
same('serve: 200', 200, $status);
same('serve: ETag with the video', "\"vsl01-v$vB-b5\"", $headers['ETag']);
check('serve: Vary with Cookie', str_contains($headers['Vary'], 'Cookie'));
check('serve: no Set-Cookie when the cookie is already right', !isset($headers['Set-Cookie']));
check('serve: body plays B', str_contains((string) $body, 'data-vturb-id="' . $vB . '"'));
same('serve: 304 with the same video', 304, serve_slug($vslRoute, make_request(['HTTP_COOKIE' => "dop_vsl=$vB", 'HTTP_IF_NONE_MATCH' => "\"vsl01-v$vB-b5\""]))[0]);
same('serve: no 304 shortcut on the bare hash (the video may change)', 200, serve_slug($vslRoute, make_request(['HTTP_COOKIE' => "dop_vsl=$vB", 'HTTP_IF_NONE_MATCH' => '"vsl01-b5"']))[0]);
[$status, $headers] = serve_slug($vslRoute, make_request());
check('serve: new visitor gets Set-Cookie dop_vsl', is_array($headers['Set-Cookie'] ?? null) && str_starts_with(end($headers['Set-Cookie']), 'dop_vsl='), json_encode($headers['Set-Cookie'] ?? null));

// Page of a funnel without a split: exactly as before.
[$status, $headers, $body] = serve_slug(['slug_id' => $vslSlug, 'content_hash' => 'vsl01', 'content_type' => 'text/html', 'funnel' => false, 'match_type' => 'GATE'], make_request());
same('no split: ETag is just the hash', '"vsl01-b5"', $headers['ETag']);
check('no split: Vary without Cookie, no cookie, player untouched', !str_contains($headers['Vary'], 'Cookie') && !isset($headers['Set-Cookie']) && str_contains((string) $body, 'data-vturb-id="' . $vOld . '"'));
