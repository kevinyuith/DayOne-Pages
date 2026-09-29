<?php
declare(strict_types=1);

// ── track.php: the per-step tracker loader on a funnel page ──

// It applies only when the page has funnel steps.
check('applies: HTML with a step section', track_applies('<section data-dop-page="p_a" data-dop-kind="main">x</section>'));
check('does not apply: a plain page', !track_applies('<html><body><h1>hi</h1></body></html>'));

// The loader script: both trackers, the dop:pageshow listener, the initial step.
$s = track_script();
check('loader: the Pre Lander tracker, on the domain itself, versioned', str_contains($s, '"presell":"/_dop/pre_dot.js?v=' . tracker_version(TRACKER_PRE_DOT_JS) . '"'));
check('loader: the Lander tracker, on the domain itself, versioned', str_contains($s, '"main":"/_dop/dot.js?v=' . tracker_version(TRACKER_DOT_JS) . '"'));
check('loader: no third-party CDN', !str_contains($s, 'cdn.directdayone.com'));
check('loader: keyed by the step kind (presell/main/backredirect)', str_contains($s, '"presell"') && str_contains($s, '"main"'));
check('loader: fires when a step becomes visible', str_contains($s, 'dop:pageshow'));
check('loader: loads the initial visible step too', str_contains($s, ':not([hidden])'));
check('loader: loads each tracker once', str_contains($s, 'done[u]'));

// On a funnel page the gate served, the trackers' URLs carry the page's id.
$tPid = '33333333-aaaa-4aaa-8aaa-0000000000c1';
$sp = track_script($tPid);
check('loader: the trackers\' URLs carry the served page\'s id', str_contains($sp, '"presell":"/_dop/pre_dot.js?v=' . tracker_version(TRACKER_PRE_DOT_JS) . "&page_id=$tPid\"") && str_contains($sp, '"main":"/_dop/dot.js?v=' . tracker_version(TRACKER_DOT_JS) . "&page_id=$tPid\""), $sp);
check('loader: without an id, no page_id', !str_contains($s, 'page_id'));
// The VSL video the response drew goes to the Lander's tracker (dot.js) only.
$tVid = '6ab84a785f99ef73c2497740';
$sv = track_script($tPid, $tVid);
check('loader: dot.js gets the drawn video', str_contains($sv, '"main":"/_dop/dot.js?v=' . tracker_version(TRACKER_DOT_JS) . "&page_id=$tPid&video_id=$tVid\""), $sv);
check('loader: pre_dot.js never gets a video', str_contains($sv, '"presell":"/_dop/pre_dot.js?v=' . tracker_version(TRACKER_PRE_DOT_JS) . "&page_id=$tPid\""), $sv);
check('loader: no video drawn, no video_id', !str_contains($sp, 'video_id'));

// Injected before the last </body>, or at the end without one.
$html = '<html><body><section data-dop-page="p_a" data-dop-kind="main">x</section></body></html>';
$out = track_inject($html);
check('inject: the loader is in the page', str_contains($out, '<script data-dop-track>'));
check('inject: before </body>', strpos($out, '<script data-dop-track>') < strpos($out, '</body>'));
same('inject: no </body> → at the end', '<p>x</p>' . track_script(), track_inject('<p>x</p>'));

// serve_slug end to end: a funnel page gets the loader and the ETag version; a plain page gets neither.
$fSlug = '77777777-7777-4777-8777-777777777777';
cache_put_content('facadea1', '<html><body><section data-dop-page="p_pre" data-dop-kind="presell">Pre</section><section data-dop-page="p_main" data-dop-kind="main" hidden>Lander</section></body></html>');
[$status, $headers, $body] = serve_slug(['slug_id' => $fSlug, 'content_hash' => 'facadea1', 'content_type' => 'text/html', 'funnel' => true], make_request());
same('serve funnel: 200', 200, $status);
check('serve funnel: body carries the loader', str_contains((string) $body, '<script data-dop-track>'));
check('serve funnel: ETag has the loader and trackers version', str_ends_with((string) $headers['ETag'], track_etag() . '"'), (string) $headers['ETag']);
same('serve funnel: 304 keeps the version', 304, serve_slug(['slug_id' => $fSlug, 'content_hash' => 'facadea1', 'content_type' => 'text/html', 'funnel' => true], make_request(['HTTP_IF_NONE_MATCH' => $headers['ETag']]))[0]);

cache_put_content('facadea2', '<html><body><h1>Plain domain page</h1></body></html>');
[, $ph, $pbody] = serve_slug(['slug_id' => $fSlug, 'content_hash' => 'facadea2', 'content_type' => 'text/html', 'funnel' => false], make_request());
check('serve plain page: no loader', !str_contains((string) $pbody, 'data-dop-track'));
check('serve plain page: ETag without the tracker version', !str_contains((string) $ph['ETag'], TRACK_ETAG), (string) $ph['ETag']);

// A funnel served by the gate carries BOTH the load notice (beacon) and the tracker loader.
[, $bh, $both] = serve_slug(['slug_id' => $fSlug, 'content_hash' => 'facadea1', 'content_type' => 'text/html', 'funnel' => true, 'match_type' => 'GATE', 'page_id' => $tPid], make_request());
check('gate funnel: beacon notice and tracker loader together', str_contains((string) $both, 'data-dop-beacon') && str_contains((string) $both, 'data-dop-track'));
check('gate funnel: the loader carries the page id, and so does the ETag', str_contains((string) $both, "&page_id=$tPid") && str_contains((string) $bh['ETag'], '-i' . substr($tPid, 0, 8)), (string) $bh['ETag']);
check('funnel page outside the gate: no id', !str_contains((string) $body, 'page_id'));

// A funnel page whose Lander step drew a VSL video: dot.js's URL carries it (the same video the player got).
$tv1 = 'aaaaaaaaaaaaaaaaaaaaaaa1';
$tvPlayer = '<div id="p1" data-video-provider="vturb" data-vturb-id="bbbbbbbbbbbbbbbbbbbbbbb2" data-vturb-kind="ab-test"></div>';
cache_put_content('facadea3', '<html><body><section data-dop-page="p_main" data-dop-kind="main">' . $tvPlayer . '</section></body></html>');
[, $vh, $vbody] = serve_slug(['slug_id' => $fSlug, 'content_hash' => 'facadea3', 'content_type' => 'text/html', 'funnel' => true, 'match_type' => 'GATE', 'page_id' => $tPid, 'vsl' => [['id' => $tv1, 'weight' => 100]]], make_request());
check('gate funnel with a drawn video: the player and dot.js get the same video', str_contains((string) $vbody, "data-vturb-id=\"$tv1\"") && str_contains((string) $vbody, "/_dop/dot.js?v=" . tracker_version(TRACKER_DOT_JS) . "&page_id=$tPid&video_id=$tv1"), (string) $vbody);
check('… pre_dot.js without it', str_contains((string) $vbody, "/_dop/pre_dot.js?v=" . tracker_version(TRACKER_PRE_DOT_JS) . "&page_id=$tPid\""));
check('… and the video is in the ETag', str_contains((string) $vh['ETag'], "-v$tv1"), (string) $vh['ETag']);

// ── A funnel page without steps is all Lander: dot.js, unless it has a tracker of its own ──
check('lander: a page without steps needs dot.js', track_needs_lander('<html><body><h1>Advertorial</h1></body></html>'));
check('lander: not a page with steps (the loader does it)', !track_needs_lander('<section data-dop-page="p_a" data-dop-kind="main">x</section>'));
check('lander: not with its own first-party dot.js tag', !track_needs_lander('<body><script src="/_dop/dot.js?origin=lander&page_id={{page_id}}"></script></body>'));
check('lander: not with the old CDN dot.js tag', !track_needs_lander('<body><script src="https://cdn.directdayone.com/js/dot.js?origin=lander&amp;v=17"></script></body>'));
check('lander: not with its own pre_dot.js tag', !track_needs_lander('<body><script src="https://cdn.directdayone.com/js/pre_dot.js"></script></body>'));
check('lander: not with a relative dot.js tag', !track_needs_lander('<head><script src="dot.js"></script></head>'));
check('lander: another script with dot.js in its name is not a tracker', track_needs_lander('<body><script src="/js/polka-dot.js"></script><script src="/js/mydot.jsx"></script></body>'));
$lTag = '<script data-dop-track async src="/_dop/dot.js?v=' . tracker_version(TRACKER_DOT_JS) . "&amp;page_id=$tPid&amp;video_id=$tVid\"></script>";
same('lander inject: dot.js with the page id and the video, before </body>', "<body><h1>x</h1>$lTag</body>", track_inject_lander('<body><h1>x</h1></body>', $tPid, $tVid));
same('lander inject: no </body> → at the end', '<p>x</p><script data-dop-track async src="/_dop/dot.js?v=' . tracker_version(TRACKER_DOT_JS) . '"></script>', track_inject_lander('<p>x</p>'));

// serve_slug: the gate's funnel page without steps gets dot.js (never pre_dot.js, no loader); the version is in the ETag.
cache_put_content('facadea4', '<html><body><h1>Advertorial</h1></body></html>');
$lRoute = ['slug_id' => $fSlug, 'content_hash' => 'facadea4', 'content_type' => 'text/html', 'funnel' => false, 'match_type' => 'GATE', 'page_id' => $tPid];
[$ls, $lh, $lbody] = serve_slug($lRoute, make_request());
same('gate page without steps: 200', 200, $ls);
check('gate page without steps: dot.js with the page id', str_contains((string) $lbody, '<script data-dop-track async src="/_dop/dot.js?v=' . tracker_version(TRACKER_DOT_JS) . "&amp;page_id=$tPid\"></script></body>"), (string) $lbody);
check('… no pre_dot.js and no loader', !str_contains((string) $lbody, 'pre_dot.js') && !str_contains((string) $lbody, 'dop:pageshow'));
check('… the ETag has the trackers version', str_ends_with((string) $lh['ETag'], track_etag() . '"'), (string) $lh['ETag']);
same('… 304 keeps it (the shortcut for pages without steps has the same ETag)', [304, $lh['ETag']], (function () use ($lRoute, $lh) {
    [$st, $hd] = serve_slug($lRoute, make_request(['HTTP_IF_NONE_MATCH' => $lh['ETag']]));
    return [$st, $hd['ETag']];
})());
same('… an ETag from before (no trackers version) → 200 with dot.js', 200, serve_slug($lRoute, make_request(['HTTP_IF_NONE_MATCH' => str_replace(track_etag(), '', (string) $lh['ETag'])]))[0]);

// With a drawn VSL video ({{video_id}} in the page), dot.js gets it too.
cache_put_content('facadea5', '<html><body><vturb-smartplayer id="vid-{{video_id}}"></vturb-smartplayer></body></html>');
[, , $lvbody] = serve_slug(['content_hash' => 'facadea5', 'vsl' => [['id' => $tv1, 'weight' => 100]]] + $lRoute, make_request());
check('gate page without steps, drawn video: the player and dot.js get it', str_contains((string) $lvbody, "id=\"vid-$tv1\"") && str_contains((string) $lvbody, "&amp;page_id=$tPid&amp;video_id=$tv1\"></script>"), (string) $lvbody);

// A page that already has its own tracker tag keeps just that one.
cache_put_content('facadea6', '<html><body><h1>VSL</h1><script src="/_dop/dot.js?origin=lander&page_id={{page_id}}"></script></body></html>');
[, , $obody] = serve_slug(['content_hash' => 'facadea6'] + $lRoute, make_request());
same('gate page with its own dot.js tag: no second one', 1, substr_count((string) $obody, '/_dop/dot.js'));
check('… and its own tag gets the page id', str_contains((string) $obody, "/_dop/dot.js?origin=lander&page_id=$tPid"), (string) $obody);

// The safe page (GATE-SAFE) and a page outside the gate: no tracker.
[, $sh, $sbody] = serve_slug(['match_type' => 'GATE-SAFE'] + $lRoute, make_request());
check('safe page: no dot.js, no trackers version in the ETag', !str_contains((string) $sbody, 'dot.js') && !str_contains((string) $sh['ETag'], TRACK_ETAG), (string) $sh['ETag']);

// ── The trackers themselves, served on the funnel's domain ──
$dotV = tracker_version(TRACKER_DOT_JS);
[$st, $hd, $bd] = handle_tracker(make_request(['REQUEST_URI' => "/_dop/dot.js?v=$dotV"]));
same('GET /_dop/dot.js?v=<current>: 200, the tracker', [200, TRACKER_DOT_JS], [$st, $bd]);
same('… as JavaScript, cached for good (a new version is a new URL)', ['application/javascript; charset=utf-8', 'public, max-age=31536000, immutable', "\"$dotV\""], [$hd['Content-Type'], $hd['Cache-Control'], $hd['ETag']]);
same('without ?v= (or an old one): 5 minutes', 'public, max-age=300', handle_tracker(make_request(['REQUEST_URI' => '/_dop/dot.js?v=old']))[1]['Cache-Control']);
same('If-None-Match with the version: 304', 304, handle_tracker(make_request(['REQUEST_URI' => '/_dop/dot.js', 'HTTP_IF_NONE_MATCH' => "\"$dotV\""]))[0]);
[$st, , $bd] = handle_tracker(make_request(['REQUEST_URI' => '/_dop/pre_dot.js']));
same('GET /_dop/pre_dot.js: the pre-lander tracker', [200, TRACKER_PRE_DOT_JS], [$st, $bd]);
same('POST: 405', 405, handle_tracker(make_request(['REQUEST_URI' => '/_dop/dot.js', 'REQUEST_METHOD' => 'POST']))[0]);
check('other paths: not a tracker', handle_tracker(make_request(['REQUEST_URI' => '/_dop/x.js'])) === null && handle_tracker(make_request(['REQUEST_URI' => '/dot.js'])) === null);
check('dot.js sends to the dot edge function and takes video_id from the cookie, not the player', str_contains(TRACKER_DOT_JS, "var ENDPOINT = 'https://cdn.dayone.click/functions/v1/dot'") && str_contains(TRACKER_DOT_JS, 'video_id=([0-9a-f]{24})') && !str_contains(TRACKER_DOT_JS, "sendEvent('video_load'") && !str_contains(TRACKER_DOT_JS, 'MutationObserver'));
check('dot.js takes video_id from its own URL first (?video_id=, 24 hex), then the cookie', str_contains(TRACKER_DOT_JS, "me.src.match(/[?&]video_id=([0-9a-f]{24})(?:[&#]|$)/)"));
check('pre_dot.js has no video_id', !str_contains(TRACKER_PRE_DOT_JS, 'video_id'));
check('pre_dot.js sends a pre_lander page_view to the dot edge function', str_contains(TRACKER_PRE_DOT_JS, "var ORIGIN = 'pre_lander'") && str_contains(TRACKER_PRE_DOT_JS, 'functions/v1/dot'));
foreach (['dot.js' => TRACKER_DOT_JS, 'pre_dot.js' => TRACKER_PRE_DOT_JS] as $name => $js) {
    check("$name sends page_id from the cookie (a uuid only)", str_contains($js, 'page_id=([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})') && str_contains($js, 'if (pageId) payload.page_id = pageId;'));
    check("$name takes page_id from its own URL first (?page_id=, a uuid)", str_contains($js, 'document.currentScript') && str_contains($js, "me.src.match(/[?&]page_id=([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:[&#]|$)/)"));
}

