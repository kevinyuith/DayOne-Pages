<?php
declare(strict_types=1);

// ── track.php: the funnel's tracker (one dot.js, sent as the step), in the <head> ──

$dotV = tracker_version(TRACKER_DOT_JS);
$dotUrl = fn (string $origin, string $more = ''): string => "/_dop/dot.js?v=$dotV&origin=$origin$more";
$dotTag = fn (string $origin, string $more = ''): string => '<script data-dop-track async src="' . htmlspecialchars($dotUrl($origin, $more)) . '"></script>';
$tPid = '33333333-aaaa-4aaa-8aaa-0000000000c1';
$tVid = '6ab84a785f99ef73c2497740';

// Which tracker each step gets.
same('origin: Pre Lander → pre_lander, Lander → lander, a page without steps → lander, Backredirect → none', ['pre_lander', 'lander', 'lander', null], [track_origin('presell'), track_origin('main'), track_origin(null), track_origin('backredirect')]);
same('url: the version and the step', $dotUrl('lander'), track_url('lander'));
same('url: the served page\'s id and the drawn video', $dotUrl('pre_lander', "&page_id=$tPid&video_id=$tVid"), track_url('pre_lander', $tPid, $tVid));
check('url: no pre_dot.js and no third-party CDN', !str_contains(track_url('pre_lander'), 'pre_dot') && !str_contains(track_url('lander'), 'cdn.'));

// A page with a tracker of its own gets none.
check('own tag: none on a plain page', !track_has_own_tag('<html><body><h1>Advertorial</h1></body></html>'));
check('own tag: its own first-party dot.js tag', track_has_own_tag('<body><script src="/_dop/dot.js?origin=lander&page_id={{page_id}}"></script></body>'));
check('own tag: the old CDN dot.js tag', track_has_own_tag('<body><script src="https://cdn.directdayone.com/js/dot.js?origin=lander&amp;v=17"></script></body>'));
check('own tag: a pre_dot.js tag', track_has_own_tag('<body><script src="https://cdn.directdayone.com/js/pre_dot.js"></script></body>'));
check('own tag: a relative dot.js tag', track_has_own_tag('<head><script src="dot.js"></script></head>'));
check('own tag: another script with dot.js in its name is not a tracker', !track_has_own_tag('<body><script src="/js/polka-dot.js"></script><script src="/js/mydot.jsx"></script></body>'));

// Injected right after <head> (the earliest spot); without a <head>, before </body> or at the end.
same('inject: right after <head>', '<html><head lang="x">' . $dotTag('lander', "&page_id=$tPid&video_id=$tVid") . '<title>t</title></head><body>x</body></html>', track_inject('<html><head lang="x"><title>t</title></head><body>x</body></html>', 'lander', $tPid, $tVid));
same('inject: no <head> → before </body>', '<body>x' . $dotTag('pre_lander') . '</body>', track_inject('<body>x</body>', 'pre_lander'));
same('inject: neither → at the end', '<p>x</p>' . $dotTag('lander'), track_inject('<p>x</p>', 'lander'));

// serve_slug: ONLY a funnel page the gate served (beacon) gets the tracker. Served by the gate, a page with steps gets the served step's dot.js in the <head>, with the page id; the version is in the ETag.
$fSlug = '77777777-7777-4777-8777-777777777777';
cache_put_content('facadea1', '<html><head><title>F</title></head><body><section data-dop-page="p_pre" data-dop-kind="presell">Pre</section><section data-dop-page="p_main" data-dop-kind="main" hidden>Lander</section><section data-dop-page="p_br" data-dop-kind="backredirect" data-dop-trigger="back" hidden>Back</section></body></html>');
$stepRoute = ['slug_id' => $fSlug, 'content_hash' => 'facadea1', 'content_type' => 'text/html', 'funnel' => true, 'match_type' => 'GATE', 'page_id' => $tPid];
[$status, $headers, $body] = serve_slug($stepRoute, make_request());
same('serve gate steps: 200', 200, $status);
check('serve gate steps, Pre Lander: dot.js as pre_lander right after <head>, with the page id', str_contains((string) $body, '<head>' . $dotTag('pre_lander', "&page_id=$tPid") . '<title>'), (string) $body);
check('… one tracker, no loader', substr_count((string) $body, 'data-dop-track') === 1 && !str_contains((string) $body, 'dop:pageshow'));
check('… the ETag has the tracker version', str_ends_with((string) $headers['ETag'], track_etag() . '"'), (string) $headers['ETag']);
same('… 304 keeps it', 304, serve_slug($stepRoute, make_request(['HTTP_IF_NONE_MATCH' => $headers['ETag']]))[0]);
[, , $body] = serve_slug($stepRoute, make_request(['HTTP_COOKIE' => 'dop_step=p_main']));
check('serve gate steps, Lander: dot.js as lander', str_contains((string) $body, $dotTag('lander', "&page_id=$tPid")) && str_contains((string) $body, 'Lander') && !str_contains((string) $body, 'pre_lander'), (string) $body);
[, , $body] = serve_slug($stepRoute, make_request(['HTTP_COOKIE' => 'dop_step=p_br']));
check('serve gate steps, Backredirect: no tracker', str_contains((string) $body, 'Back') && !str_contains((string) $body, 'data-dop-track'), (string) $body);

// The SAME page with steps served OUTSIDE the gate (a domain/safe page that happens to be a funnel): the step is served, but no tracker and no page id.
$offGate = ['slug_id' => $fSlug, 'content_hash' => 'facadea1', 'content_type' => 'text/html', 'funnel' => true];
[, $oh, $obody] = serve_slug($offGate, make_request());
check('steps outside the gate: the step is served but no tracker', str_contains((string) $obody, 'Pre') && !str_contains((string) $obody, 'data-dop-track'), (string) $obody);
check('steps outside the gate: ETag without the tracker version, no page id', !str_contains((string) $oh['ETag'], TRACK_ETAG) && !str_contains((string) $obody, 'page_id'), (string) $oh['ETag']);

cache_put_content('facadea2', '<html><body><h1>Plain domain page</h1></body></html>');
[, $ph, $pbody] = serve_slug(['slug_id' => $fSlug, 'content_hash' => 'facadea2', 'content_type' => 'text/html', 'funnel' => false], make_request());
check('serve plain page: no tracker', !str_contains((string) $pbody, 'data-dop-track'));
check('serve plain page: ETag without the tracker version', !str_contains((string) $ph['ETag'], TRACK_ETAG), (string) $ph['ETag']);

// A funnel served by the gate carries BOTH the load notice (beacon) and the tracker, with the page id.
[, $bh, $both] = serve_slug($stepRoute, make_request());
check('gate funnel: beacon notice and tracker together', str_contains((string) $both, 'data-dop-beacon') && str_contains((string) $both, $dotTag('pre_lander', "&page_id=$tPid")), (string) $both);
check('gate funnel: the ETag has the page id', str_contains((string) $bh['ETag'], '-i' . substr($tPid, 0, 8)), (string) $bh['ETag']);

// A funnel page whose Lander drew a VSL video: dot.js's URL carries it (the same video the player got).
$tv1 = 'aaaaaaaaaaaaaaaaaaaaaaa1';
$tvPlayer = '<div id="p1" data-video-provider="vturb" data-vturb-id="bbbbbbbbbbbbbbbbbbbbbbb2" data-vturb-kind="ab-test"></div>';
cache_put_content('facadea3', '<html><head></head><body><section data-dop-page="p_main" data-dop-kind="main">' . $tvPlayer . '</section></body></html>');
[, $vh, $vbody] = serve_slug(['content_hash' => 'facadea3', 'match_type' => 'GATE', 'page_id' => $tPid, 'vsl' => [['id' => $tv1, 'weight' => 100]]] + $stepRoute, make_request());
check('gate funnel with a drawn video: the player and dot.js get the same video', str_contains((string) $vbody, "data-vturb-id=\"$tv1\"") && str_contains((string) $vbody, $dotTag('lander', "&page_id=$tPid&video_id=$tv1")), (string) $vbody);
check('… and the video is in the ETag', str_contains((string) $vh['ETag'], "-v$tv1"), (string) $vh['ETag']);

// ── A funnel page without steps is all Lander: dot.js when the gate serves it, unless it has a tracker of its own ──
cache_put_content('facadea4', '<html><head><title>A</title></head><body><h1>Advertorial</h1></body></html>');
$lRoute = ['slug_id' => $fSlug, 'content_hash' => 'facadea4', 'content_type' => 'text/html', 'funnel' => false, 'match_type' => 'GATE', 'page_id' => $tPid];
[$ls, $lh, $lbody] = serve_slug($lRoute, make_request());
same('gate page without steps: 200', 200, $ls);
check('gate page without steps: dot.js as lander in the <head>, with the page id', str_contains((string) $lbody, '<head>' . $dotTag('lander', "&page_id=$tPid") . '<title>'), (string) $lbody);
check('… no pre_lander', !str_contains((string) $lbody, 'pre_lander'));
check('… the ETag has the tracker version', str_ends_with((string) $lh['ETag'], track_etag() . '"'), (string) $lh['ETag']);
same('… 304 keeps it (the shortcut for pages without steps has the same ETag)', [304, $lh['ETag']], (function () use ($lRoute, $lh) {
    [$st, $hd] = serve_slug($lRoute, make_request(['HTTP_IF_NONE_MATCH' => $lh['ETag']]));
    return [$st, $hd['ETag']];
})());
same('… an ETag from before (no tracker version) → 200 with dot.js', 200, serve_slug($lRoute, make_request(['HTTP_IF_NONE_MATCH' => str_replace(track_etag(), '', (string) $lh['ETag'])]))[0]);

// With a drawn VSL video ({{video_id}} in the page), dot.js gets it too.
cache_put_content('facadea5', '<html><head></head><body><vturb-smartplayer id="vid-{{video_id}}"></vturb-smartplayer></body></html>');
[, , $lvbody] = serve_slug(['content_hash' => 'facadea5', 'vsl' => [['id' => $tv1, 'weight' => 100]]] + $lRoute, make_request());
check('gate page without steps, drawn video: the player and dot.js get it', str_contains((string) $lvbody, "id=\"vid-$tv1\"") && str_contains((string) $lvbody, $dotTag('lander', "&page_id=$tPid&video_id=$tv1")), (string) $lvbody);

// A page that already has its own tracker tag keeps just that one (with steps too).
cache_put_content('facadea6', '<html><body><h1>VSL</h1><script src="/_dop/dot.js?origin=lander&page_id={{page_id}}"></script></body></html>');
[, , $obody] = serve_slug(['content_hash' => 'facadea6'] + $lRoute, make_request());
same('gate page with its own dot.js tag: no second one', 1, substr_count((string) $obody, '/_dop/dot.js'));
check('… and its own tag gets the page id', str_contains((string) $obody, "/_dop/dot.js?origin=lander&page_id=$tPid"), (string) $obody);
cache_put_content('facadea7', '<html><head><script src="https://cdn.directdayone.com/js/dot.js?origin=lander"></script></head><body><section data-dop-page="p_pre" data-dop-kind="presell">Pre</section><section data-dop-page="p_main" data-dop-kind="main" hidden>L</section></body></html>');
[, , $obody] = serve_slug(['content_hash' => 'facadea7', 'funnel' => true] + $lRoute, make_request());
check('page with steps and its own tag: no second tracker', !str_contains((string) $obody, 'data-dop-track'), (string) $obody);

// The safe page (GATE-SAFE): no tracker.
[, $sh, $sbody] = serve_slug(['match_type' => 'GATE-SAFE'] + $lRoute, make_request());
check('safe page: no dot.js, no tracker version in the ETag', !str_contains((string) $sbody, 'dot.js') && !str_contains((string) $sh['ETag'], TRACK_ETAG), (string) $sh['ETag']);

// ── The tracker itself, served on the funnel's domain ──
[$st, $hd, $bd] = handle_tracker(make_request(['REQUEST_URI' => "/_dop/dot.js?v=$dotV"]));
same('GET /_dop/dot.js?v=<current>: 200, the tracker', [200, TRACKER_DOT_JS], [$st, $bd]);
same('… as JavaScript, cached for good (a new version is a new URL)', ['application/javascript; charset=utf-8', 'public, max-age=31536000, immutable', "\"$dotV\""], [$hd['Content-Type'], $hd['Cache-Control'], $hd['ETag']]);
same('without ?v= (or an old one): 5 minutes', 'public, max-age=300', handle_tracker(make_request(['REQUEST_URI' => '/_dop/dot.js?v=old']))[1]['Cache-Control']);
same('If-None-Match with the version: 304', 304, handle_tracker(make_request(['REQUEST_URI' => '/_dop/dot.js', 'HTTP_IF_NONE_MATCH' => "\"$dotV\""]))[0]);
same('POST: 405', 405, handle_tracker(make_request(['REQUEST_URI' => '/_dop/dot.js', 'REQUEST_METHOD' => 'POST']))[0]);
check('other paths: not a tracker — /_dop/pre_dot.js is gone (dot.js does both steps)', handle_tracker(make_request(['REQUEST_URI' => '/_dop/pre_dot.js'])) === null && handle_tracker(make_request(['REQUEST_URI' => '/_dop/x.js'])) === null && handle_tracker(make_request(['REQUEST_URI' => '/dot.js'])) === null);
check('dot.js sends to the dot edge function and takes video_id from the cookie, not the player', str_contains(TRACKER_DOT_JS, "var ENDPOINT = 'https://cdn.dayone.click/functions/v1/dot'") && str_contains(TRACKER_DOT_JS, 'video_id=([0-9a-f]{24})') && !str_contains(TRACKER_DOT_JS, "sendEvent('video_load'") && !str_contains(TRACKER_DOT_JS, 'MutationObserver'));
check('dot.js reads its own tag (currentScript) for origin, page_id and video_id', str_contains(TRACKER_DOT_JS, 'var me = document.currentScript;') && str_contains(TRACKER_DOT_JS, 'mySrc.match(/[?&]origin=([^&#]+)/)'));
check('dot.js takes video_id from its own URL first (?video_id=, 24 hex), then the cookie', str_contains(TRACKER_DOT_JS, "mySrc.match(/[?&]video_id=([0-9a-f]{24})(?:[&#]|$)/)"));
check('dot.js takes page_id from its own URL first (?page_id=, a uuid), then the cookie', str_contains(TRACKER_DOT_JS, "mySrc.match(/[?&]page_id=([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:[&#]|$)/)") && str_contains(TRACKER_DOT_JS, 'if (pageId) payload.page_id = pageId;'));
check('dot.js: lander page_view at once; pre_lander page_view on load (10 s cap, pagehide net), one send', str_contains(TRACKER_DOT_JS, "if (origin !== 'pre_lander' || document.readyState === 'complete')") && str_contains(TRACKER_DOT_JS, "window.addEventListener('load', sendPageView, { once: true });") && str_contains(TRACKER_DOT_JS, 'setTimeout(sendPageView, LOAD_TIMEOUT)') && str_contains(TRACKER_DOT_JS, "window.addEventListener('pagehide', sendPageView, { once: true });") && str_contains(TRACKER_DOT_JS, 'if (pageViewSent) return;'));
check('dot.js: video events on whichever step drew the video', str_contains(TRACKER_DOT_JS, "  if (videoId) {\n    var videoBound = false;") && !str_contains(TRACKER_DOT_JS, "origin === 'lander' && videoId"));
// The VSL marks VTurb counts, one per number.
check('dot.js: video_click from the player\'s call to action (VTurb analytics:exited-click) and checkout links, as a beacon, never holding the navigation', str_contains(TRACKER_DOT_JS, "document.addEventListener('analytics:exited-click', fireClick, true);") && str_contains(TRACKER_DOT_JS, "sendSync(buildPayload('video_click'") && !str_contains(TRACKER_DOT_JS, 'preventDefault'));
check('dot.js: the checkout link is found on the composed path (the player\'s call to action is in its shadow DOM)', str_contains(TRACKER_DOT_JS, 'ev.composedPath') && !str_contains(TRACKER_DOT_JS, "closest(\"a[href*='checkout']\")"));
check('dot.js: the beacon goes as text/plain (a JSON beacon to another origin needs a preflight; Chrome throws)', str_contains(TRACKER_DOT_JS, "new Blob([body], { type: 'text/plain;charset=UTF-8' })") && !str_contains(TRACKER_DOT_JS, "new Blob([body], { type: 'application/json' })"));
check('dot.js: video_end on VTurb\'s video:ended, with the last second watched', str_contains(TRACKER_DOT_JS, "el.addEventListener('video:ended'") && str_contains(TRACKER_DOT_JS, "sendEvent('video_end'"));
check('dot.js: video_pitch from VTurb\'s pitch:time; the config fallback never in the muted smart autoplay', str_contains(TRACKER_DOT_JS, "el.addEventListener('pitch:time'") && str_contains(TRACKER_DOT_JS, '!el.inSmartAutoPlay'));
check('dot.js: binds a player that was already ready (VTurb\'s window.smartplayer.instances, or the element)', str_contains(TRACKER_DOT_JS, 'bindOnce(readyPlayer());') && str_contains(TRACKER_DOT_JS, 'sp.instances[0].instance'));
// ext_click_id: the same list and order as the server's click event.
preg_match("/var CLICK_ID_PARAMS = \\[(.*?)\\];/s", TRACKER_DOT_JS, $cm);
same('dot.js: CLICK_ID_PARAMS is the server\'s list, in the same order (dot.php)', CLICK_ID_PARAMS, array_map(fn ($x) => trim($x, " '\n"), explode(',', $cm[1] ?? '')));
check('dot.js: the click id goes in every event as ext_click_id', str_contains(TRACKER_DOT_JS, 'attrs.ext_click_id = lower[CLICK_ID_PARAMS[i]];'));
// Nothing is lost: the outbox keeps every event until dot confirms it.
check('dot.js outbox: every event is kept in localStorage until dot confirms it', str_contains(TRACKER_DOT_JS, "var OUTBOX_KEY = 'dot_outbox';") && str_contains(TRACKER_DOT_JS, 'outboxAdd(item);') && str_contains(TRACKER_DOT_JS, 'outboxRemove(item.id);'));
check('dot.js outbox: 5xx/429 and no answer retry (2s, 4s… every minute, 15 minutes); another 4xx is dropped', str_contains(TRACKER_DOT_JS, 'if (res.status >= 500 || res.status === 429) throw new Error(res.status);') && str_contains(TRACKER_DOT_JS, 'Math.min(60000, 2000 * Math.pow(2, attempt - 1))') && str_contains(TRACKER_DOT_JS, 'var RETRY_WINDOW = 900000;'));
check('dot.js outbox: the next page sends what is left (for a day), late events with _delay_ms', str_contains(TRACKER_DOT_JS, 'flushOutbox();') && str_contains(TRACKER_DOT_JS, 'var OUTBOX_MAX_AGE = 86400000;') && str_contains(TRACKER_DOT_JS, 'p._delay_ms = late;'));
check('dot.js outbox: only the latest pending video_watch of a video is kept', str_contains(TRACKER_DOT_JS, "p.event === 'video_watch' && x.p && x.p.event === 'video_watch'"));
