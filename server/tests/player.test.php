<?php
declare(strict_types=1);

// ── player.php: the funnel's player (the dashboard's Player window) on the served VSL step ──

$plImg = ['url' => 'https://cdn.example.com/play.png', 'name' => 'play.png', 'width' => 1920, 'height' => 1080];
$plThumb = ['url' => 'https://cdn.example.com/thumb.png', 'name' => 'thumb.png', 'width' => 1080, 'height' => 1920];
$plTest = '11111111-1111-4111-8111-111111111111';
$plFull = [
    'version' => 1,
    'play' => ['image' => $plImg, 'size' => 55, 'position' => 34, 'pulse' => false],
    'thumb' => ['image' => $plThumb, 'on_pause' => true, 'button' => ['on' => true, 'text' => 'YES! I WANT IT →', 'color' => '#d4141c', 'target' => 'checkout', 'url' => 'https://', 'after_pitch' => true]],
    'hooks' => ['style' => 'bottom', 'items' => [
        ['id' => 'h1', 'text' => 'Stay until the end', 'when' => 'at', 'seconds' => 180],
        ['id' => 'h2', 'text' => 'The recipe is coming up', 'when' => 'before_pitch', 'seconds' => 600],
    ]],
    'end' => ['mode' => 'scroll', 'scroll_at_pitch' => false],
    'test' => null,
];

// Nothing saved, or nothing on: no player.
same('null: none', null, player_config(null));
same('{} (never saved): none', null, player_config([]));
same('all off (the dashboard\'s default): none', null, player_config(['version' => 1, 'play' => ['image' => null], 'thumb' => ['image' => null], 'hooks' => ['items' => []], 'end' => ['mode' => 'none'], 'test' => null]));

// Cleaned to what dot.js reads.
$c = player_config($plFull);
same('play: the image URL, size, position, pulse', ['image' => $plImg['url'], 'size' => 55, 'position' => 34, 'pulse' => false], $c['play']);
same('thumb: the image URL', $plThumb['url'], $c['thumb']['image']);
same('thumb button: target checkout keeps no URL', ['on' => true, 'text' => 'YES! I WANT IT →', 'color' => '#d4141c', 'target' => 'checkout', 'url' => '', 'after_pitch' => true], $c['thumb']['button']);
same('hooks: no ids, the style', ['style' => 'bottom', 'items' => [['text' => 'Stay until the end', 'when' => 'at', 'seconds' => 180], ['text' => 'The recipe is coming up', 'when' => 'before_pitch', 'seconds' => 600]]], $c['hooks']);
same('end', ['mode' => 'scroll', 'scroll_at_pitch' => false], $c['end']);
check('no test key without a test', !array_key_exists('test', $c));

// Bad values are dropped, not passed on.
same('play: an http (not https) image is off', null, player_config(['play' => ['image' => ['url' => 'http://x.com/a.png']]]));
same('play: javascript: is off', null, player_config(['play' => ['image' => ['url' => 'javascript:alert(1)']]]));
same('play: size out of range is clamped, unknown position → center', ['size' => 90, 'position' => 50], array_intersect_key(player_config(['play' => ['image' => $plImg, 'size' => 400, 'position' => 12]])['play'], ['size' => 1, 'position' => 1]));
same('thumb: a bad color → green', '#16a34a', player_config(['thumb' => ['image' => $plThumb, 'button' => ['text' => 'Go', 'color' => 'red;}']]])['thumb']['button']['color']);
same('thumb: target url without a valid URL → checkout', 'checkout', player_config(['thumb' => ['image' => $plThumb, 'button' => ['text' => 'Go', 'target' => 'url', 'url' => 'javascript:x']]])['thumb']['button']['target']);
same('thumb: target url with a valid URL keeps it', 'https://offer.example.com/a?b=1', player_config(['thumb' => ['image' => $plThumb, 'button' => ['text' => 'Go', 'target' => 'url', 'url' => 'https://offer.example.com/a?b=1']]])['thumb']['button']['url']);
same('thumb: an empty text turns the button off', false, player_config(['thumb' => ['image' => $plThumb, 'button' => ['on' => true, 'text' => '   ']]])['thumb']['button']['on']);
same('thumb off on pause and no end thumb: none', null, player_config(['thumb' => ['image' => $plThumb, 'on_pause' => false]]));
check('thumb off on pause but end "thumb": kept for the end', player_config(['thumb' => ['image' => $plThumb, 'on_pause' => false], 'end' => ['mode' => 'thumb']])['thumb']['on_pause'] === false);
same('end "thumb" without a thumb image → none', null, player_config(['end' => ['mode' => 'thumb']]));
same('end: scroll at the pitch alone keeps end', ['mode' => 'none', 'scroll_at_pitch' => true], player_config(['end' => ['mode' => 'none', 'scroll_at_pitch' => true]])['end']);
same('hooks: empty text, unknown when and negative seconds are dropped', 1, count(player_config(['hooks' => ['items' => [
    ['text' => '', 'when' => 'at', 'seconds' => 1], ['text' => 'a', 'when' => 'soon', 'seconds' => 1], ['text' => 'b', 'when' => 'at', 'seconds' => -5], ['text' => 'ok', 'when' => 'at', 'seconds' => 5],
]]])['hooks']['items']));
same('hooks: at most 8', PLAYER_MAX_HOOKS, count(player_config(['hooks' => ['items' => array_fill(0, 12, ['text' => 'x', 'when' => 'at', 'seconds' => 1])]])['hooks']['items']));
same('hooks: whitespace collapsed, 120 characters', str_repeat('a', 120), player_config(['hooks' => ['items' => [['text' => "  " . str_repeat('a', 200), 'when' => 'at', 'seconds' => 1]]]])['hooks']['items'][0]['text']);

// The test: one at a time, on a feature that is on.
$withTest = static fn (array $test) => player_config([...$plFull, 'test' => $test]);
$playTest = ['id' => $plTest, 'feature' => 'play', 'started_at' => '2026-11-04T00:00:00Z', 'variants' => [
    ['key' => 'a', 'weight' => 50, 'label' => 'A', 'image' => $plImg],
    ['key' => 'b', 'weight' => 50, 'label' => 'B', 'image' => ['url' => 'https://cdn.example.com/b.png']],
]];
same('play test: the sides with their images', [
    ['key' => 'a', 'weight' => 50, 'off' => false, 'image' => $plImg['url']],
    ['key' => 'b', 'weight' => 50, 'off' => false, 'image' => 'https://cdn.example.com/b.png'],
], $withTest($playTest)['test']['variants']);
same('play test: a side without image gets the play\'s', $plImg['url'], $withTest([...$playTest, 'variants' => [['key' => 'a', 'weight' => 70], ['key' => 'b', 'weight' => 30, 'image' => null]]])['test']['variants'][1]['image']);
same('"with × without": off kept, no image key', ['key' => 'b', 'weight' => 50, 'off' => true], $withTest(['id' => $plTest, 'feature' => 'thumb', 'variants' => [['weight' => 50], ['weight' => 50, 'off' => true]]])['test']['variants'][1]);
check('test on a feature that is off: dropped', !isset(player_config(['play' => ['image' => $plImg], 'test' => ['id' => $plTest, 'feature' => 'hooks', 'variants' => [['weight' => 50], ['weight' => 50, 'off' => true]]]])['test']));
check('test with a bad id: dropped', !isset($withTest([...$playTest, 'id' => 'nope'])['test']));
check('test with one side: dropped', !isset($withTest([...$playTest, 'variants' => [$playTest['variants'][0]]])['test']));
check('test with a 0 or 100 weight: dropped', !isset($withTest([...$playTest, 'variants' => [['weight' => 100], ['weight' => 0]]])['test']));

// speed and other: for the player tag's custom-config.
same('speed: kept (0.5–2), rounded', 1.25, player_config(['speed' => ['speed' => 1.25]])['speed']);
same('speed: out of range or null → none', null, player_config(['speed' => ['speed' => 9]]));
same('other: only what the funnel chose', ['mini_player' => true, 'resume_title' => 'Você já começou'], player_config(['other' => ['mini_player' => true, 'smart_pause' => null, 'resume_title' => ' Você já começou ', 'resume_play' => '']])['other']);
check('other: "off" on purpose is kept', player_config(['other' => ['smart_pause' => false]])['other']['smart_pause'] === false);
same('custom-config: the funnel\'s speed, mini player, Smart Pause and texts, in VTurb\'s keys', [
    'turbo' => ['active' => true, 'type' => 'single', 'speed' => 1.2],
    'miniPlayer' => ['active' => true, 'autoEnableOnScroll' => true, 'autoReturn' => true],
    'playback' => ['smartPause' => false],
    'resume' => ['title' => 'T', 'play' => 'P'],
], player_custom(player_config(['speed' => ['speed' => 1.2], 'other' => ['mini_player' => true, 'smart_pause' => false, 'resume_title' => 'T', 'resume_play' => 'P']]), null));
same('custom-config: nothing chosen → none', null, player_custom(player_config(['play' => ['image' => $plImg]]), null));

// The test's side: drawn here, kept in dop_pt_<test>.
$speedTest = ['speed' => ['speed' => 1.1], 'test' => ['id' => $plTest, 'feature' => 'speed', 'variants' => [['weight' => 50, 'speed' => 1.1], ['weight' => 50, 'speed' => 1.3]]]];
$cfgSpeed = player_config($speedTest);
same('speed test: each side with its speed', [1.1, 1.3], array_column($cfgSpeed['test']['variants'], 'speed'));
check('speed test with a side without a speed: dropped', !isset(player_config(['test' => ['id' => $plTest, 'feature' => 'speed', 'variants' => [['weight' => 50, 'speed' => 1.1], ['weight' => 50]]]])['test']));
$fixedP = static fn (int $n) => static fn (int $max): int => min($n, $max - 1);
same('draw 0 of 100 → a', 'a', player_draw($cfgSpeed['test'], [], $fixedP(0))['side']);
same('draw 60 of 100 → b', 'b', player_draw($cfgSpeed['test'], [], $fixedP(60))['side']);
same('new side: the cookie', 'dop_pt_11111111=b; Path=/; Max-Age=2592000; Secure; SameSite=Lax', player_draw($cfgSpeed['test'], [], $fixedP(60))['cookie']);
same('the cookie wins, and isn\'t sent again', ['side' => 'a', 'cookie' => null], player_draw($cfgSpeed['test'], ['dop_pt_11111111' => 'a'], $fixedP(99)));
same('a junk cookie draws again', 'b', player_draw($cfgSpeed['test'], ['dop_pt_11111111' => 'x'], $fixedP(60))['side']);
same('custom-config in a speed test: the side\'s speed', 1.3, player_custom($cfgSpeed, 'b')['turbo']['speed']);
same('… and side a\'s', 1.1, player_custom($cfgSpeed, 'a')['turbo']['speed']);

// The page: JSON safe inside <script>, only when the step drew a video; the side and the custom-config with it.
$route = ['player' => [...$plFull, 'hooks' => ['items' => [['text' => '</script><script>alert(1)</script> & "q"', 'when' => 'at', 'seconds' => 3]]]]];
$pp = player_page($route, 'dddddddddddddddddddddd01');
$json = $pp['json'] ?? null;
check('the JSON has no </script>', $json !== null && !str_contains($json, '</script') && !str_contains($json, '<'));
same('… and decodes back to the text', '</script><script>alert(1)</script> & "q"', json_decode((string) $json, true)['hooks']['items'][0]['text']);
same('no speed/other chosen: no custom-config', null, $pp['custom']);
same('no test: no cookie', null, $pp['cookie']);
same('no video drawn: no player', null, player_page($route, null));
same('no player on the route: none', null, player_page([], 'dddddddddddddddddddddd01'));
$ps = player_page(['player' => $speedTest], 'dddddddddddddddddddddd01', [], $fixedP(60));
same('speed test page: the side in the JSON', 'b', json_decode($ps['json'], true)['side']);
same('… the side\'s speed in the custom-config', 1.3, json_decode((string) $ps['custom'], true)['turbo']['speed']);
check('… and the cookie to send', str_starts_with((string) $ps['cookie'], 'dop_pt_11111111=b;'));
check('the ETag tag changes with the side', $ps['tag'] !== player_page(['player' => $speedTest], 'dddddddddddddddddddddd01', ['dop_pt_11111111' => 'a'])['tag']);

$page = '<html><head></head><body><vturb-smartplayer id="vid-1"></vturb-smartplayer></body></html>';
$injected = player_inject($page, '{"play":1}');
check('injected before </body>', str_ends_with($injected, '<script type="application/json" data-dop-player>{"play":1}</script></body></html>'));
same('no </body>: at the end', 'x<script type="application/json" data-dop-player>{}</script>', player_inject('x', '{}'));
same('custom-config on the player tag, as an attribute', '<vturb-smartplayer custom-config="{&quot;turbo&quot;:{&quot;speed&quot;:1.2}}" id="vid-1"></vturb-smartplayer>', player_custom_inject('<vturb-smartplayer id="vid-1"></vturb-smartplayer>', '{"turbo":{"speed":1.2}}'));
same('the page\'s own custom-config wins', '<vturb-smartplayer custom-config=\'{"a":1}\' id="vid-1">', player_custom_inject('<vturb-smartplayer custom-config=\'{"a":1}\' id="vid-1">', '{"turbo":{"speed":1.2}}'));
same('no player tag: unchanged', '<div></div>', player_custom_inject('<div></div>', '{}'));
same('the ETag tag changes with the config', true, player_tag('{"a":1}') !== player_tag('{"a":2}') && str_starts_with(player_tag('{}'), '-pl'));
