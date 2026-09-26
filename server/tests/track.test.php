<?php
declare(strict_types=1);

// ── track.php: the per-step tracker loader on a funnel page ──

// It applies only when the page has funnel steps.
check('applies: HTML with a step section', track_applies('<section data-dop-page="p_a" data-dop-kind="main">x</section>'));
check('does not apply: a plain page', !track_applies('<html><body><h1>hi</h1></body></html>'));

// The loader script: both trackers, the dop:pageshow listener, the initial step.
$s = track_script();
check('loader: the Pre Lander tracker', str_contains($s, 'https://cdn.directdayone.com/js/pre_dot.js'));
check('loader: the Lander tracker', str_contains($s, 'https://cdn.directdayone.com/js/dot.js?origin=lander&v=17'));
check('loader: keyed by the step kind (presell/main/backredirect)', str_contains($s, '"presell"') && str_contains($s, '"main"'));
check('loader: fires when a step becomes visible', str_contains($s, 'dop:pageshow'));
check('loader: loads the initial visible step too', str_contains($s, ':not([hidden])'));
check('loader: loads each tracker once', str_contains($s, 'done[u]'));

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
check('serve funnel: ETag has the tracker version', str_ends_with((string) $headers['ETag'], '-k1"'), (string) $headers['ETag']);
same('serve funnel: 304 keeps the version', 304, serve_slug(['slug_id' => $fSlug, 'content_hash' => 'facadea1', 'content_type' => 'text/html', 'funnel' => true], make_request(['HTTP_IF_NONE_MATCH' => $headers['ETag']]))[0]);

cache_put_content('facadea2', '<html><body><h1>Plain domain page</h1></body></html>');
[, $ph, $pbody] = serve_slug(['slug_id' => $fSlug, 'content_hash' => 'facadea2', 'content_type' => 'text/html', 'funnel' => false], make_request());
check('serve plain page: no loader', !str_contains((string) $pbody, 'data-dop-track'));
check('serve plain page: ETag without the tracker version', !str_contains((string) $ph['ETag'], '-k1'), (string) $ph['ETag']);

// A funnel served by the gate carries BOTH the load notice (beacon) and the tracker loader.
[, , $both] = serve_slug(['slug_id' => $fSlug, 'content_hash' => 'facadea1', 'content_type' => 'text/html', 'funnel' => true, 'match_type' => 'GATE'], make_request());
check('gate funnel: beacon notice and tracker loader together', str_contains((string) $both, 'data-dop-beacon') && str_contains((string) $both, 'data-dop-track'));
