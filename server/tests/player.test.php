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
same('play: the image URL, size, position, pulse, and appearing at once when it says nothing', ['image' => $plImg['url'], 'size' => 55, 'position' => 34, 'pulse' => false, 'effect' => 'none'], $c['play']);
same('thumb: the image URL', $plThumb['url'], $c['thumb']['image']);
same('thumb: on every pause unless it says "after the pitch"', false, $c['thumb']['only_after_pitch']);
same('thumb: "after the pitch"', true, player_config(['thumb' => ['image' => $plThumb, 'only_after_pitch' => true]])['thumb']['only_after_pitch']);
same('thumb: junk is not "after the pitch"', false, player_config(['thumb' => ['image' => $plThumb, 'only_after_pitch' => 'yes']])['thumb']['only_after_pitch']);
same('thumb button: target checkout keeps no URL', ['on' => true, 'text' => 'YES! I WANT IT →', 'color' => '#d4141c', 'target' => 'checkout', 'url' => '', 'after_pitch' => true], $c['thumb']['button']);
same('hooks from before (one style): no ids; the bubble, lower, 90%, at once', ['items' => [
    ['kind' => 'text', 'when' => 'at', 'seconds' => 180, 'position' => 80, 'size' => 90, 'effect' => 'none', 'text' => 'Stay until the end', 'look' => 'bubble'],
    ['kind' => 'text', 'when' => 'before_pitch', 'seconds' => 600, 'position' => 80, 'size' => 90, 'effect' => 'none', 'text' => 'The recipe is coming up', 'look' => 'bubble'],
]], $c['hooks']);
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

// Groups (05/11): the served video's group replaces the features it has of its own; one test per visitor.
$vA = 'dddddddddddddddddddddd01';
$vG = 'dddddddddddddddddddddd02';
$vH = 'dddddddddddddddddddddd03';
$plImgG = ['url' => 'https://cdn.example.com/play-group.png', 'name' => 'play-group.png', 'width' => 1080, 'height' => 1080];
$grpTest = '22222222-2222-4222-8222-222222222222';
$playTest = ['id' => $plTest, 'feature' => 'play', 'started_at' => '2026-11-05T00:00:00Z', 'variants' => [
    ['key' => 'a', 'weight' => 50, 'label' => 'A', 'image' => $plImg], ['key' => 'b', 'weight' => 50, 'label' => 'B', 'image' => $plThumb],
]];
$withGroups = [...$plFull, 'test' => $playTest, 'groups' => [
    ['id' => 'g1', 'name' => 'DTC', 'vsls' => [$vG], 'play' => ['image' => $plImgG, 'size' => 70, 'position' => 50, 'pulse' => true], 'thumb' => null, 'test' => null],
    ['id' => 'g2', 'name' => 'Hooks', 'vsls' => [$vH, $vG], 'hooks' => ['style' => 'top', 'items' => [['text' => 'Group hook', 'when' => 'at', 'seconds' => 9]]],
     'test' => ['id' => $grpTest, 'feature' => 'hooks', 'started_at' => '2026-11-05T00:00:00Z', 'variants' => [['key' => 'a', 'weight' => 50, 'label' => 'Com'], ['key' => 'b', 'weight' => 50, 'label' => 'Sem', 'off' => true]]]],
]];
$forA = player_for_video($withGroups, $vA);
check('a video no group lists: the Default, without `groups`', !array_key_exists('groups', $forA) && $forA['play'] === $plFull['play'] && $forA['test'] === $playTest);
$forG = player_for_video($withGroups, $vG);
same('the group\'s own play replaces the Default\'s', $plImgG, $forG['play']['image']);
same('… a null feature is the Default\'s', $plFull['thumb'], $forG['thumb']);
same('… and what it doesn\'t have, too', $plFull['hooks'], $forG['hooks']);
same('the Default\'s test on a feature the group has of its own: dropped', null, $forG['test']);
same('the first group that lists the video wins (not the 2nd)', $plFull['hooks'], player_for_video($withGroups, $vG)['hooks']);
$forH = player_for_video($withGroups, $vH);
same('the group\'s own test replaces the Default\'s', $grpTest, $forH['test']['id']);
same('… with its own hooks', 'Group hook', $forH['hooks']['items'][0]['text']);
$inherit = [...$withGroups, 'groups' => [['id' => 'g3', 'name' => 'Inherits', 'vsls' => [$vA], 'play' => null, 'test' => null]]];
same('the Default\'s test on a feature the group takes from the Default: kept', $plTest, player_for_video($inherit, $vA)['test']['id']);
same('no groups: unchanged', $plFull, player_for_video($plFull, $vA));
same('junk groups: the Default', $plFull['play'], player_for_video([...$plFull, 'groups' => 'x'], $vA)['play']);
same('a group with junk vsls: skipped', $plFull['play'], player_for_video([...$plFull, 'groups' => [['vsls' => 'x', 'play' => ['image' => $plImgG]]]], $vA)['play']);
same('null player: null', null, player_for_video(null, $vA));
$pg = json_decode((string) player_page(['player' => $withGroups], $vG)['json'], true);
same('the page of a group\'s video: the group\'s play image', $plImgG['url'], $pg['play']['image']);
check('… and no test (the Default\'s was on play)', !isset($pg['test']));
$ph = player_page(['player' => $withGroups], $vH, [], $fixedP(60));
same('the page of the hooks group: its test\'s side', 'b', json_decode($ph['json'], true)['side']);
check('… with the group test\'s cookie', str_starts_with((string) $ph['cookie'], 'dop_pt_22222222=b;'));
same('the Default\'s page: its play test', $plTest, json_decode((string) player_page(['player' => $withGroups], $vA, [], $fixedP(0))['json'], true)['test']['id']);

// Options like CTAs (05/11): 2 to 4 (a…d), each with the feature's whole setting; the drawn one's goes to the page.
$thumbB = ['url' => 'https://cdn.example.com/thumb-b.png', 'name' => 'thumb-b.png', 'width' => 1080, 'height' => 1920];
$thumbTest = '33333333-3333-4333-8333-333333333333';
$withOptions = [...$plFull, 'test' => ['id' => $thumbTest, 'feature' => 'thumb', 'started_at' => '2026-11-05T00:00:00Z', 'variants' => [
    ['key' => 'a', 'weight' => 40, 'label' => 'A', 'config' => $plFull['thumb']],
    ['key' => 'b', 'weight' => 40, 'label' => 'B', 'config' => [...$plFull['thumb'], 'image' => $thumbB, 'button' => [...$plFull['thumb']['button'], 'text' => 'GET IT']]],
    ['key' => 'c', 'weight' => 20, 'label' => 'Sem', 'off' => true],
]]];
$co = player_config($withOptions);
same('three options, by key', ['a', 'b', 'c'], array_column($co['test']['variants'], 'key'));
same('… each option\'s setting cleaned', $thumbB['url'], $co['test']['variants'][1]['config']['image']);
check('… the "without" option has none', !isset($co['test']['variants'][2]['config']));
same('draw 85 of 100 → c', 'c', player_draw($co['test'], [], $fixedP(85))['side']);
same('a cookie of an option the test still has: kept', 'b', player_draw($co['test'], ['dop_pt_33333333' => 'b'])['side']);
same('a cookie of an option the test no longer has: drawn again', 'a', player_draw($co['test'], ['dop_pt_33333333' => 'd'], $fixedP(0))['side']);
$pb = json_decode((string) player_page(['player' => $withOptions], $vA, [], $fixedP(50))['json'], true);
same('the page of option b: its thumb', $thumbB['url'], $pb['thumb']['image']);
same('… its button text', 'GET IT', $pb['thumb']['button']['text']);
check('… and no option carries its setting to the page', !array_filter($pb['test']['variants'], static fn ($v) => isset($v['config'])));
same('five options: no test', null, player_config([...$plFull, 'test' => [...$withOptions['test'], 'variants' => array_fill(0, 5, ['weight' => 20])]])['test'] ?? null);
same('two options with the same key: no test', null, player_config([...$plFull, 'test' => [...$withOptions['test'], 'variants' => [['key' => 'a', 'weight' => 50], ['key' => 'a', 'weight' => 50]]]])['test'] ?? null);
same('an option whose setting is off (no image): no test', null, player_config([...$plFull, 'test' => [...$withOptions['test'], 'variants' => [['key' => 'a', 'weight' => 50], ['key' => 'b', 'weight' => 50, 'config' => [...$plFull['thumb'], 'image' => null]]]]])['test'] ?? null);
$endTest = [...$plFull, 'test' => ['id' => $thumbTest, 'feature' => 'end', 'started_at' => '2026-11-05T00:00:00Z', 'variants' => [
    ['key' => 'a', 'weight' => 50, 'config' => ['mode' => 'scroll', 'scroll_at_pitch' => false]],
    ['key' => 'b', 'weight' => 50, 'config' => ['mode' => 'thumb', 'scroll_at_pitch' => false]],
]]];
same('an end option "thumb" uses the block\'s thumb', 'thumb', player_config($endTest)['test']['variants'][1]['config']['mode']);
$spOpt = [...$plFull, 'test' => ['id' => $thumbTest, 'feature' => 'speed', 'started_at' => '2026-11-05T00:00:00Z', 'variants' => [
    ['key' => 'a', 'weight' => 50, 'config' => ['speed' => 1.2]],
    ['key' => 'b', 'weight' => 50, 'label' => 'Como no VTurb', 'off' => true],
]]];
$spA = player_page(['player' => $spOpt], $vA, [], $fixedP(0));
same('speed option a: its speed in the custom-config', 1.2, json_decode((string) $spA['custom'], true)['turbo']['speed']);
same('speed option "as on VTurb" (off): no custom-config speed', null, player_page(['player' => $spOpt], $vA, [], $fixedP(60))['custom']);

// Image hooks, the 5 positions, the size and how it appears (05/11, the dashboard's canvas "ganchos com imagem").
$hookImg = ['url' => 'https://cdn.example.com/hook.png', 'name' => 'hook.png', 'width' => 1200, 'height' => 400];
$ch = player_config(['hooks' => ['style' => 'top', 'items' => [
    ['id' => 'a', 'kind' => 'image', 'image' => $hookImg, 'text' => '', 'position' => 0, 'size' => 100, 'effect' => 'bounce', 'when' => 'at', 'seconds' => 30],
    ['id' => 'b', 'kind' => 'text', 'text' => 'Wait', 'look' => 'bubble', 'position' => 100, 'size' => 60, 'effect' => 'slide', 'when' => 'at', 'seconds' => 40],
    ['id' => 'c', 'kind' => 'image', 'image' => null, 'text' => 'ignored', 'when' => 'at', 'seconds' => 50],
    ['id' => 'd', 'kind' => 'image', 'image' => ['url' => 'http://x.com/a.png'], 'when' => 'at', 'seconds' => 60],
    ['id' => 'e', 'kind' => 'text', 'text' => 'Odd', 'position' => 33, 'size' => 400, 'effect' => 'spin', 'look' => 'neon', 'when' => 'at', 'seconds' => 70],
]]])['hooks']['items'];
same('an image hook: the URL, Topo, 100%, bounce; no text, no look', ['kind' => 'image', 'when' => 'at', 'seconds' => 30, 'position' => 0, 'size' => 100, 'effect' => 'bounce', 'image' => $hookImg['url']], $ch[0]);
same('a text hook: its look, Fundo, its size and effect', ['kind' => 'text', 'when' => 'at', 'seconds' => 40, 'position' => 100, 'size' => 60, 'effect' => 'slide', 'text' => 'Wait', 'look' => 'bubble'], $ch[1]);
same('an image hook without an (https) image is left out', 3, count($ch));
same('junk position → middle, size clamped, unknown effect → at once, unknown look → the old style\'s', ['position' => 50, 'size' => 100, 'effect' => 'none', 'look' => 'band'], array_intersect_key($ch[2], ['position' => 1, 'size' => 1, 'effect' => 1, 'look' => 1]));
same('play at Fundo, sliding', ['position' => 100, 'effect' => 'slide'], array_intersect_key(player_config(['play' => ['image' => $plImg, 'position' => 100, 'effect' => 'slide']])['play'], ['position' => 1, 'effect' => 1]));
same('play: an unknown position → center', 50, player_config(['play' => ['image' => $plImg, 'position' => 20]])['play']['position']);
