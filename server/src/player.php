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
 *   test   one of them in A × B: dot.js draws the side (cookie per test) and says
 *          which in a player_variant event
 *
 * pages.resolve gives the funnel's `player` (20261104a), the gate copies it to the
 * funnel route (rules.php), and the served step that drew a VSL video gets it,
 * cleaned to what dot.js reads, as <script type="application/json" data-dop-player>
 * before </body> — only with our tracker (a page with a tracker of its own would
 * carry a config nobody reads). The config goes into the ETag. dot.js (track.php)
 * draws the layer and sends the player_* events to dot.
 */
declare(strict_types=1);

defined('DAYONE_ENTRY') || (http_response_code(404) && exit);

/** Most hooks a funnel has (the dashboard's limit). */
const PLAYER_MAX_HOOKS = 8;
const PLAYER_UUID_RE = '/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/';

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
            'position' => in_array($pos, [34, 50, 66], true) ? $pos : 50,
            'pulse' => ($play['pulse'] ?? true) !== false,
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

    $hooks = is_array($player['hooks'] ?? null) ? $player['hooks'] : [];
    $items = [];
    foreach (is_array($hooks['items'] ?? null) ? $hooks['items'] : [] as $h) {
        if (!is_array($h) || count($items) >= PLAYER_MAX_HOOKS) {
            continue;
        }
        $text = player_text($h['text'] ?? '', 120);
        $when = in_array($h['when'] ?? null, ['at', 'before_pitch'], true) ? $h['when'] : null;
        $sec = is_numeric($h['seconds'] ?? null) ? (int) $h['seconds'] : -1;
        if ($text === '' || $when === null || $sec < 0 || $sec > 4 * 3600) {
            continue;
        }
        $items[] = ['text' => $text, 'when' => $when, 'seconds' => $sec];
    }
    if ($items !== []) {
        $out['hooks'] = ['style' => ($hooks['style'] ?? 'top') === 'bottom' ? 'bottom' : 'top', 'items' => $items];
    }

    if ($endMode !== 'none' || $atPitch) {
        $out['end'] = ['mode' => $endMode, 'scroll_at_pitch' => $atPitch];
    }

    // One test at a time: a valid A × B on a feature that is on (the play's side B brings its own image).
    $test = is_array($player['test'] ?? null) ? $player['test'] : null;
    $feature = $test['feature'] ?? null;
    $variants = is_array($test['variants'] ?? null) ? array_values($test['variants']) : [];
    if ($test !== null && is_string($test['id'] ?? null) && preg_match(PLAYER_UUID_RE, $test['id']) === 1
        && in_array($feature, ['play', 'thumb', 'hooks', 'end'], true) && isset($out[$feature]) && count($variants) === 2) {
        $sides = [];
        foreach ($variants as $i => $v) {
            $w = is_array($v) && is_numeric($v['weight'] ?? null) ? (int) $v['weight'] : 0;
            if ($w < 1 || $w > 99) {
                $sides = [];
                break;
            }
            $side = ['key' => $i === 0 ? 'a' : 'b', 'weight' => $w, 'off' => ($v['off'] ?? false) === true];
            if ($feature === 'play') {
                $side['image'] = player_image($v['image'] ?? null) ?? $out['play']['image'];
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

/** The page's player JSON for the served step: the route's config, when the step drew a VSL video. null = none. */
function player_page_json(array $route, ?string $video): ?string
{
    if ($video === null || $video === '') {
        return null;
    }
    $config = player_config($route['player'] ?? null);
    return $config === null ? null : player_json($config);
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
