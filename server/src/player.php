<?php
/**
 * The funnel's player (pages.funnels.player — the dashboard's "Player" window of
 * 04/11/2026, dayone-main src/lib/funnel-player/config.ts): what the page draws
 * over the VTurb player on the funnel's VSLs.
 *
 *   play   an image over the muted smart autoplay (the visitor's touch still goes
 *          to VTurb, which unmutes and restarts: the image lets it through)
 *   thumb  an image when the video is paused, with a button to the offer's checkout
 *   hooks  short lines for 6 s, at a second of the video or N seconds before the pitch
 *   end    when the video ends: scroll to the offer, the thumb, or a notice
 *   speed  the player's speed (VTurb's Turbo)
 *   other  mini player, Smart Pause and the "continue watching" texts
 *   test   one of them with 2 to 4 options (a…d): THIS server draws the visitor's
 *          option by the weights (cookie dop_pt_<test>, like the VSL and the CTA
 *          draws) and the page says which (dot.js sends it in a player_variant
 *          event). Since 05/11 each option can carry the feature's whole setting
 *          (`config`, like the dashboard's "+ Thumb" adds a CTA-like option): the
 *          drawn option's setting replaces the block's before it goes to the page.
 *
 * speed and other aren't drawn by us: they go in the player tag's
 * `custom-config` attribute (<vturb-smartplayer custom-config="{…}">), which
 * VTurb's own smartplayer.js merges over the player's config when it mounts —
 * tested on 04/11 with the real player (playbackRate, mini-player:entered,
 * smart-pause:paused/resumed and the resume texts). Nothing is written to VTurb;
 * null / empty = the VSL keeps its own setting there.
 *
 * pages.resolve gives the funnel's `player` (20261104a), the gate copies it to the
 * funnel route (rules.php), and the served step that drew a VSL video gets it,
 * cleaned to what dot.js reads, as <script type="application/json" data-dop-player>
 * before </body> — only with our tracker (a page with a tracker of its own would
 * carry a config nobody reads). The config goes into the ETag. dot.js (track.php)
 * draws the layer and sends the player_* events to dot.
 *
 * GROUPS (05/11/2026, the dashboard's Player stage became like the CTA stage: a
 * Default and groups of VSLs): the top level is the Default, and `groups` =
 * [{ id, name, vsls: [video ids], <feature>: {…} | null, test }]. The served
 * step's video picks its group (player_for_video) before anything else here.
 */
declare(strict_types=1);

defined('DAYONE_ENTRY') || (http_response_code(404) && exit);

/** Most hooks a funnel has (the dashboard's limit). */
const PLAYER_MAX_HOOKS = 8;
const PLAYER_UUID_RE = '/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/';
/** The side of the funnel's test the visitor got: dop_pt_<first 8 of the test id> = a|b. */
const PLAYER_COOKIE = 'dop_pt_';
/**
 * Where a piece goes (05/11, the dashboard's canvas "ganchos com imagem"): 0 = against the
 * top edge, 100 = against the bottom edge; the others are the piece's center in % of the
 * player's height. The play button uses 34/50/66, a hook 20/50/80.
 */
const PLAYER_PLAY_POSITIONS = [0, 34, 50, 66, 100];
const PLAYER_HOOK_POSITIONS = [0, 20, 50, 80, 100];
/** How a piece appears: none · fade · slide (from the nearest edge) · grow · bounce. */
const PLAYER_EFFECTS = ['none', 'fade', 'slide', 'grow', 'bounce'];

/** The features a group can have of its own (the rest it takes from the Default). */
const PLAYER_FEATURES = ['play', 'thumb', 'hooks', 'end', 'speed', 'other'];

/** A speed the player takes (0.5–2), or null. */
function player_speed(mixed $v): ?float
{
    return is_numeric($v) && (float) $v >= 0.5 && (float) $v <= 2 ? round((float) $v, 2) : null;
}

/** An https image URL from the dashboard's {url, …}; null otherwise. */
function player_image(mixed $img): ?string
{
    $url = is_array($img) ? ($img['url'] ?? null) : null;
    return is_string($url) && strlen($url) <= 2000 && preg_match('~^https://[^\s"\'<>\\\\]+$~', $url) === 1 ? $url : null;
}

/** A short text, single-line, at most $max characters. */
function player_text(mixed $s, int $max): string
{
    if (!is_string($s)) {
        return '';
    }
    $s = trim(preg_replace('/\s+/u', ' ', $s) ?? '');
    return mb_substr($s, 0, $max);
}

/**
 * The funnel's player for one VSL video: the Default (the top level) with the
 * features of the first group that lists the video, each one the group has of its
 * own (absent or null = the Default's). One test per visitor: the group's test
 * when it has one; else the Default's, only while it tests a feature the group
 * takes from the Default. No group lists the video: the Default. `groups` never
 * goes further.
 */
function player_for_video(mixed $player, string $video): mixed
{
    if (!is_array($player)) {
        return $player;
    }
    $groups = $player['groups'] ?? null;
    unset($player['groups']);
    foreach (is_array($groups) ? $groups : [] as $g) {
        $vsls = is_array($g) ? ($g['vsls'] ?? null) : null;
        if (!is_array($vsls) || !in_array($video, $vsls, true)) {
            continue;
        }
        $own = [];
        foreach (PLAYER_FEATURES as $f) {
            if (is_array($g[$f] ?? null)) {
                $player[$f] = $g[$f];
                $own[] = $f;
            }
        }
        $defaultTest = is_array($player['test'] ?? null) ? $player['test'] : null;
        if (is_array($g['test'] ?? null)) {
            $player['test'] = $g['test'];
        } elseif ($defaultTest !== null && in_array($defaultTest['feature'] ?? null, $own, true)) {
            $player['test'] = null;
        }
        break;
    }
    return $player;
}

/**
 * The route's player, cleaned to what dot.js reads (play/thumb/hooks/end/test);
 * null = nothing to draw.
 *
 * @return array<string, mixed>|null
 */
function player_config(mixed $player): ?array
{
    if (!is_array($player)) {
        return null;
    }
    $out = [];

    $play = is_array($player['play'] ?? null) ? $player['play'] : [];
    $playImage = player_image($play['image'] ?? null);
    if ($playImage !== null) {
        $size = is_numeric($play['size'] ?? null) ? (int) $play['size'] : 50;
        $pos = is_numeric($play['position'] ?? null) ? (int) $play['position'] : 50;
        $out['play'] = [
            'image' => $playImage,
            'size' => max(30, min(90, $size)),
            'position' => in_array($pos, PLAYER_PLAY_POSITIONS, true) ? $pos : 50,
            'pulse' => ($play['pulse'] ?? true) !== false,
            'effect' => in_array($play['effect'] ?? null, PLAYER_EFFECTS, true) ? $play['effect'] : 'none',
        ];
    }

    $end = is_array($player['end'] ?? null) ? $player['end'] : [];
    $endMode = in_array($end['mode'] ?? null, ['none', 'scroll', 'thumb', 'notice'], true) ? $end['mode'] : 'none';
    $atPitch = ($end['scroll_at_pitch'] ?? false) === true;

    $thumb = is_array($player['thumb'] ?? null) ? $player['thumb'] : [];
    $thumbImage = player_image($thumb['image'] ?? null);
    $onPause = ($thumb['on_pause'] ?? true) !== false;
    if ($thumbImage !== null && ($onPause || $endMode === 'thumb')) {
        $b = is_array($thumb['button'] ?? null) ? $thumb['button'] : [];
        $url = is_string($b['url'] ?? null) && preg_match('~^https?://[^\s"\'<>\\\\]+$~', $b['url']) === 1 ? $b['url'] : '';
        $target = ($b['target'] ?? 'checkout') === 'url' && $url !== '' ? 'url' : 'checkout';
        $out['thumb'] = [
            'image' => $thumbImage,
            'on_pause' => $onPause,
            // "after the pitch" (05/11): only the pauses after the VSL's pitch; before it, a pause just pauses
            'only_after_pitch' => ($thumb['only_after_pitch'] ?? false) === true,
            'button' => [
                'on' => ($b['on'] ?? true) !== false && player_text($b['text'] ?? '', 60) !== '',
                'text' => player_text($b['text'] ?? '', 60),
                'color' => is_string($b['color'] ?? null) && preg_match('/^#[0-9a-f]{6}$/i', $b['color']) === 1 ? $b['color'] : '#16a34a',
                'target' => $target,
                'url' => $target === 'url' ? $url : '',
                'after_pitch' => ($b['after_pitch'] ?? true) !== false,
            ],
        ];
    }
    if ($endMode === 'thumb' && !isset($out['thumb'])) {
        $endMode = 'none';
    }

    // Each hook (05/11): a line of text in a band or a bubble, or an image in its place; with its position, size
    // (% of the most: the player's width less 4% each side) and how it appears. A hook from before comes without
    // them: the old style puts it (top = band, upper; bottom = bubble, lower), at 90%, appearing at once.
    $hooks = is_array($player['hooks'] ?? null) ? $player['hooks'] : [];
    $oldStyle = ($hooks['style'] ?? 'top') === 'bottom' ? 'bottom' : 'top';
    $items = [];
    foreach (is_array($hooks['items'] ?? null) ? $hooks['items'] : [] as $h) {
        if (!is_array($h) || count($items) >= PLAYER_MAX_HOOKS) {
            continue;
        }
        $kind = ($h['kind'] ?? 'text') === 'image' ? 'image' : 'text';
        $text = player_text($h['text'] ?? '', 120);
        $img = $kind === 'image' ? player_image($h['image'] ?? null) : null;
        $when = in_array($h['when'] ?? null, ['at', 'before_pitch'], true) ? $h['when'] : null;
        $sec = is_numeric($h['seconds'] ?? null) ? (int) $h['seconds'] : -1;
        if (($kind === 'text' ? $text === '' : $img === null) || $when === null || $sec < 0 || $sec > 4 * 3600) {
            continue;
        }
        $pos = is_numeric($h['position'] ?? null) ? (int) $h['position'] : ($oldStyle === 'bottom' ? 80 : 20);
        $size = is_numeric($h['size'] ?? null) ? (int) $h['size'] : 90;
        $item = [
            'kind' => $kind,
            'when' => $when,
            'seconds' => $sec,
            'position' => in_array($pos, PLAYER_HOOK_POSITIONS, true) ? $pos : 50,
            'size' => max(30, min(100, $size)),
            'effect' => in_array($h['effect'] ?? null, PLAYER_EFFECTS, true) ? $h['effect'] : 'none',
        ];
        if ($kind === 'image') {
            $item['image'] = $img;
        } else {
            $item['text'] = $text;
            $item['look'] = in_array($h['look'] ?? null, ['band', 'bubble'], true) ? $h['look'] : ($oldStyle === 'bottom' ? 'bubble' : 'band');
        }
        $items[] = $item;
    }
    if ($items !== []) {
        $out['hooks'] = ['items' => $items];
    }

    if ($endMode !== 'none' || $atPitch) {
        $out['end'] = ['mode' => $endMode, 'scroll_at_pitch' => $atPitch];
    }

    // speed and other: for the player tag's custom-config (player_custom), not drawn by dot.js.
    $speed = player_speed(is_array($player['speed'] ?? null) ? ($player['speed']['speed'] ?? null) : null);
    if ($speed !== null) {
        $out['speed'] = $speed;
    }
    $other = is_array($player['other'] ?? null) ? $player['other'] : [];
    $o = [];
    foreach (['mini_player', 'smart_pause'] as $k) {
        if (is_bool($other[$k] ?? null)) {
            $o[$k] = $other[$k];
        }
    }
    foreach (['resume_title' => 120, 'resume_play' => 60, 'resume_replay' => 60] as $k => $max) {
        $t = player_text($other[$k] ?? '', $max);
        if ($t !== '') {
            $o[$k] = $t;
        }
    }
    if ($o !== []) {
        $out['other'] = $o;
    }

    // One test at a time: 2 to 4 options (a…d) on a feature that is on. An option off = "without" it;
    // with `config`, its own setting of the feature, cleaned like the block's (in the block's context:
    // the end's "thumb" needs the block's thumb). Older options bring just the play's image or the speed.
    $test = is_array($player['test'] ?? null) ? $player['test'] : null;
    $feature = $test['feature'] ?? null;
    $variants = is_array($test['variants'] ?? null) ? array_values($test['variants']) : [];
    if ($test !== null && is_string($test['id'] ?? null) && preg_match(PLAYER_UUID_RE, $test['id']) === 1
        && in_array($feature, ['play', 'thumb', 'hooks', 'end', 'speed'], true) && ($feature === 'speed' || isset($out[$feature]))
        && count($variants) >= 2 && count($variants) <= 4) {
        $sides = [];
        $keys = [];
        foreach ($variants as $i => $v) {
            $w = is_array($v) && is_numeric($v['weight'] ?? null) ? (int) $v['weight'] : 0;
            $key = is_array($v) && is_string($v['key'] ?? null) && preg_match('/^[a-d]$/', $v['key']) === 1 ? $v['key'] : chr(97 + $i);
            if ($w < 1 || $w > 99 || isset($keys[$key])) {
                $sides = [];
                break;
            }
            $keys[$key] = true;
            $side = ['key' => $key, 'weight' => $w, 'off' => ($v['off'] ?? false) === true];
            $own = null;
            if (!$side['off'] && is_array($v['config'] ?? null)) {
                $own = player_config([...$player, $feature => $v['config'], 'test' => null])[$feature] ?? null;
                if ($own === null) {
                    $sides = [];
                    break;
                }
                $side['config'] = $own;
            }
            if ($feature === 'play' && !$side['off']) {
                $side['image'] = $own['image'] ?? player_image($v['image'] ?? null) ?? $out['play']['image'];
            }
            if ($feature === 'speed' && !$side['off']) {
                $sp = $own ?? player_speed($v['speed'] ?? null);
                if ($sp === null) {
                    $sides = [];
                    break;
                }
                $side['speed'] = $sp;
            }
            $sides[] = $side;
        }
        if ($sides !== []) {
            $out['test'] = ['id' => $test['id'], 'feature' => $feature, 'variants' => $sides];
        }
    }

    return $out === [] ? null : $out;
}

/** The config as JSON that is safe inside a <script> (no "<", ">" or "&" as such). */
function player_json(array $config): string
{
    return (string) json_encode($config, JSON_HEX_TAG | JSON_HEX_AMP | JSON_HEX_APOS | JSON_HEX_QUOT | JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE);
}

/**
 * The visitor's option of the funnel's test: the one dop_pt_<test> holds (while
 * the test still has it), else drawn by the weights (ab_pick). `cookie` = the
 * Set-Cookie to send (null: it already had it).
 *
 * @return array{side: string, cookie: ?string}
 */
function player_draw(array $test, array $cookies, ?callable $rand = null): array
{
    $name = PLAYER_COOKIE . substr((string) $test['id'], 0, 8);
    $options = array_map(static fn (array $v): array => ['key' => (string) $v['key'], 'weight' => (int) $v['weight']], $test['variants']);
    $had = $cookies[$name] ?? null;
    if (is_string($had) && in_array($had, array_column($options, 'key'), true)) {
        return ['side' => $had, 'cookie' => null];
    }
    $side = ab_pick($options, $rand)['key'];
    return ['side' => $side, 'cookie' => "$name=$side; Path=/; Max-Age=2592000; Secure; SameSite=Lax"];
}

/** The test's option with that key, or null. */
function player_option(array $config, ?string $side): ?array
{
    foreach (is_array($config['test']['variants'] ?? null) ? $config['test']['variants'] : [] as $v) {
        if (($v['key'] ?? null) === $side) {
            return $v;
        }
    }
    return null;
}

/**
 * The player tag's custom-config (VTurb's keys): the funnel's speed (or the
 * drawn side's, in a speed test), mini player, Smart Pause and resume texts.
 * null = nothing to change in the player.
 *
 * @return array<string, mixed>|null
 */
function player_custom(array $config, ?string $side): ?array
{
    $custom = [];
    $speed = $config['speed'] ?? null;
    $test = $config['test'] ?? null;
    $option = player_option($config, $side);
    if ($option !== null && is_array($test) && ($test['feature'] ?? null) === 'speed') {
        // the "as on VTurb" option (off) leaves the player's own speed
        $speed = ($option['off'] ?? false) ? null : ($option['speed'] ?? $speed);
    }
    if ($speed !== null) {
        $custom['turbo'] = ['active' => true, 'type' => 'single', 'speed' => $speed];
    }
    $o = $config['other'] ?? [];
    if (isset($o['mini_player'])) {
        $custom['miniPlayer'] = ['active' => $o['mini_player'], 'autoEnableOnScroll' => $o['mini_player'], 'autoReturn' => true];
    }
    if (isset($o['smart_pause'])) {
        $custom['playback'] = ['smartPause' => $o['smart_pause']];
    }
    $resume = [];
    foreach (['title', 'play', 'replay'] as $k) {
        if (isset($o["resume_$k"])) {
            $resume[$k] = $o["resume_$k"];
        }
    }
    if ($resume !== []) {
        $custom['resume'] = $resume;
    }
    return $custom === [] ? null : $custom;
}

/**
 * The served step's player: the page's config for dot.js (with the drawn side),
 * the player tag's custom-config, the ETag part and the test's Set-Cookie — when
 * the step drew a VSL video and the route has a player. null = none.
 *
 * @return array{json: string, custom: ?string, tag: string, cookie: ?string}|null
 */
function player_page(array $route, ?string $video, array $cookies = [], ?callable $rand = null): ?array
{
    if ($video === null || $video === '') {
        return null;
    }
    $config = player_config(player_for_video($route['player'] ?? null, $video));
    if ($config === null) {
        return null;
    }
    $side = null;
    $cookie = null;
    if (isset($config['test'])) {
        ['side' => $side, 'cookie' => $cookie] = player_draw($config['test'], $cookies, $rand);
        $config['side'] = $side;
        // the drawn option's own setting is what the page draws; the page gets no option's setting
        $own = player_option($config, $side)['config'] ?? null;
        if ($own !== null) {
            $config[$config['test']['feature']] = $own;
        }
        foreach ($config['test']['variants'] as $i => $v) {
            unset($config['test']['variants'][$i]['config']);
        }
    }
    $custom = player_custom($config, $side);
    $json = player_json($config);
    $customJson = $custom === null ? null : player_json($custom);
    return ['json' => $json, 'custom' => $customJson, 'tag' => player_tag($json . '|' . (string) $customJson), 'cookie' => $cookie];
}

/** The custom-config on every <vturb-smartplayer> tag that doesn't have one (the page's own wins). */
function player_custom_inject(string $html, string $custom): string
{
    $attr = ' custom-config="' . htmlspecialchars($custom, ENT_QUOTES) . '"';
    return preg_replace_callback(
        '/<vturb-smartplayer\b[^>]*>/i',
        static fn (array $m): string => preg_match('/\scustom-config\s*=/i', $m[0]) === 1 ? $m[0] : substr_replace($m[0], $attr, strlen('<vturb-smartplayer'), 0),
        $html,
    ) ?? $html;
}

/** The ETag suffix of a page with the player: the config's hash. */
function player_tag(string $json): string
{
    return '-pl' . substr(md5($json), 0, 8);
}

/** The config before </body> (or at the end), where dot.js reads it. */
function player_inject(string $html, string $json): string
{
    $tag = '<script type="application/json" data-dop-player>' . $json . '</script>';
    $pos = strripos($html, '</body>');
    return $pos === false ? $html . $tag : substr_replace($html, $tag, $pos, 0);
}
