<?php
/**
 * The funnel's VSL split (pages.funnels.vsl, the dashboard's "VSLs" tab):
 * which VTurb video each visitor watches. The draw is ours; VTurb only plays
 * the video.
 *
 * pages.resolve sends, for a page that is a copy of a funnel page, the
 * funnel's videos with a share above 0 (`vsl`: [{ id, weight }], weight in %
 * with up to 2 decimals). The page's VTurb player marked as an A/B test
 * (data-vturb-kind="ab-test" — the slot where VTurb used to draw) gets ONE of
 * them: the one the dop_vsl cookie already has for this visitor, otherwise
 * one drawn by the weights. The player then loads that video directly
 * (data-vturb-kind emptied, data-vturb-id = the video). Players with a fixed
 * video (any other kind) are left alone.
 *
 * The page builder keeps its HTML inside a JSON string (quotes as \", "<" as
 * <), so the player's tag is found in both forms: plain and JSON-escaped.
 *
 * {{video_id}} (vsl_placeholder_apply): any page can take the draw by writing
 * the placeholder where a VTurb video id goes — e.g. in VTurb's single-video
 * embed, `<vturb-smartplayer id="vid-{{video_id}}">` and
 * `…/players/{{video_id}}/v4/player.js`. It becomes the same video the A/B
 * player would get (same dop_vsl draw); with no video in the split, empty.
 * The draw is the served step's: only a {{video_id}} in its own code (the
 * <body> after funnel.php cut the other steps; a page without steps is all
 * Lander) draws — the <head> is every step's, so a {{video_id}} there alone
 * draws nothing and becomes empty. A Pre Lander → VSL page draws when the
 * visitor reaches the VSL, even with the player's preload in the <head>.
 * A response that drew a video says which one: the step's tracker URL
 * (track.php, &video_id=), the `video_id` cookie (not
 * HttpOnly, for the page's own trackers — dot.js reads it) and, through the
 * route, the server's click event to dot (dot.php). A funnel page that drew no
 * video deletes an older video_id cookie, so it always speaks for the page it
 * came with. Nothing else in the page changes.
 */
declare(strict_types=1);

defined('DAYONE_ENTRY') || (http_response_code(404) && exit);

/** Cookie of the VSL draw: the videos (VTurb player ids) already drawn for the visitor, this funnel's first. */
const VSL_COOKIE = 'dop_vsl';
const VSL_MAX_IDS = 10;
/** The placeholder that becomes the drawn video's id. */
const VSL_PLACEHOLDER_RE = '/\{\{\s*video_id\s*\}\}/';
/** The cookie that carries the drawn video. */
const VIDEO_ID_NAME = 'video_id';

/**
 * Swaps the video of the page's A/B players for the one drawn for this
 * visitor. `tag` (the video) goes into the ETag; `cookie` is the new dop_vsl
 * value, or null if it didn't change. `$rand(max)` returns an integer in
 * [0, max) — the tests pass a fixed one.
 *
 * @return array{html: string, tag: string, cookie: ?string}|null  null = nothing to swap (no split, or no A/B player)
 */
function vsl_apply(string $html, mixed $vsl, array $cookies, ?callable $rand = null): ?array
{
    $videos = vsl_videos($vsl);
    if ($videos === [] || !str_contains($html, 'ab-test') || preg_match(vsl_player_re(), $html) !== 1) {
        return null;
    }
    ['pick' => $pick, 'cookie' => $cookie] = vsl_draw($videos, $cookies, $rand);
    $out = preg_replace_callback(vsl_player_re(), static fn (array $m): string => vsl_player_tag($m[0], $m['q'], $pick), $html) ?? $html;
    return ['html' => $out, 'tag' => $pick, 'cookie' => $cookie];
}

/**
 * The visitor's video: the one dop_vsl already has for this funnel, otherwise
 * one drawn by the weights. `cookie` is the new dop_vsl value, or null if it
 * didn't change.
 *
 * @param list<array{id: string, weight: int}> $videos  non-empty (vsl_videos)
 * @return array{pick: string, cookie: ?string}
 */
function vsl_draw(array $videos, array $cookies, ?callable $rand = null): array
{
    // Weight 0 = paused: it isn't in the list, so not even visitors who had it stay on it.
    $raw = (string) ($cookies[VSL_COOKIE] ?? '');
    $known = preg_match('/^[0-9a-f]{24}(,[0-9a-f]{24})*$/', $raw) === 1 ? explode(',', $raw) : [];
    $ids = array_column($videos, 'id');
    $pick = null;
    foreach ($known as $id) {
        if (in_array($id, $ids, true)) {
            $pick = $id;
            break;
        }
    }
    $pick ??= ab_pick($videos, $rand)['id'];
    $keep = array_values(array_filter($known, fn ($id) => !in_array($id, $ids, true)));
    $value = implode(',', array_slice([$pick, ...$keep], 0, VSL_MAX_IDS));
    return ['pick' => $pick, 'cookie' => $value === $raw ? null : $value];
}

/**
 * {{video_id}} in the served step's own code (vsl_step_code) → every
 * {{video_id}} of the response (the <head>'s too) becomes the visitor's video
 * (vsl_draw); only in the <head>, or no video in the funnel's split, empty
 * text. null = no placeholder in the HTML (nothing drawn). `tag` is the video
 * ('' when empty).
 *
 * @return array{html: string, tag: string, cookie: ?string}|null
 */
function vsl_placeholder_apply(string $html, mixed $vsl, array $cookies, ?callable $rand = null): ?array
{
    if (!str_contains($html, '{{') || preg_match(VSL_PLACEHOLDER_RE, $html) !== 1) {
        return null;
    }
    $videos = vsl_videos($vsl);
    if ($videos === [] || preg_match(VSL_PLACEHOLDER_RE, vsl_step_code($html)) !== 1) {
        return ['html' => (string) preg_replace(VSL_PLACEHOLDER_RE, '', $html), 'tag' => '', 'cookie' => null];
    }
    ['pick' => $pick, 'cookie' => $cookie] = vsl_draw($videos, $cookies, $rand);
    return ['html' => (string) preg_replace(VSL_PLACEHOLDER_RE, $pick, $html), 'tag' => $pick, 'cookie' => $cookie];
}

/** The served step's own code: from <body> on (the <head> is every step's); without a <body>, all of it. */
function vsl_step_code(string $html): string
{
    return preg_match('/<body\b/i', $html, $m, PREG_OFFSET_CAPTURE) === 1 ? substr($html, (int) $m[0][1]) : $html;
}

/** The video_id cookie (not HttpOnly: the page's trackers read it). */
function video_id_cookie(string $video): string
{
    return VIDEO_ID_NAME . "=$video; Path=/; Max-Age=2592000; Secure; SameSite=Lax";
}

/** Deletes it: a funnel page that drew no video (see serve_slug). */
function video_id_cookie_clear(): string
{
    return VIDEO_ID_NAME . "=; Path=/; Max-Age=0; Secure; SameSite=Lax";
}

/**
 * The route's videos that can be drawn: valid ids with a share above 0, the
 * weight in hundredths of a percent (integers, for ab_pick).
 *
 * @return list<array{id: string, weight: int}>
 */
function vsl_videos(mixed $vsl): array
{
    $out = [];
    foreach (is_array($vsl) ? $vsl : [] as $v) {
        $id = is_array($v) ? ($v['id'] ?? null) : null;
        $w = is_array($v) && is_numeric($v['weight'] ?? null) ? (int) round(((float) $v['weight']) * 100) : 0;
        if (is_string($id) && preg_match('/^[0-9a-f]{24}$/', $id) === 1 && $w > 0) {
            $out[] = ['id' => $id, 'weight' => min($w, 10000)];
        }
    }
    return $out;
}

/**
 * The opening tag of a VTurb player marked as an A/B test, plain
 * (<div … data-vturb-kind="ab-test">) or JSON-escaped
 * (<div … data-vturb-kind=\"ab-test\">). `q` is the quote used.
 */
function vsl_player_re(): string
{
    // Between attributes: whitespace, or a line break written as \n inside the JSON.
    $sp = '(?:\s|\\\\[nrt])';
    return '/(?:<|\\\\u003c)[a-z][a-z0-9-]*' . $sp
        . '(?=[^<>]*?' . $sp . 'data-vturb-kind=(?<q>\\\\?")ab-test\k<q>)'
        . '(?=[^<>]*?' . $sp . 'data-video-provider=\k<q>vturb\k<q>)'
        . '[^<>]*>/i';
}

/** The player's tag loading `$video` directly: data-vturb-id = the video, data-vturb-kind emptied. */
function vsl_player_tag(string $tag, string $q, string $video): string
{
    $qq = preg_quote($q, '/');
    // Callbacks, not replacement strings: the quote may be \" and a backslash in a replacement is special.
    $tag = preg_replace_callback('/(data-vturb-kind=)' . $qq . 'ab-test' . $qq . '/i', static fn ($m) => $m[1] . $q . $q, $tag, 1) ?? $tag;
    $swapped = preg_replace_callback('/(data-vturb-id=)' . $qq . '[^"\\\\]*' . $qq . '/i', static fn ($m) => $m[1] . $q . $video . $q, $tag, 1, $count) ?? $tag;
    // No data-vturb-id at all: it goes in before the tag closes.
    return $count > 0 ? $swapped : substr($tag, 0, -1) . " data-vturb-id=$q$video$q>";
}

function vsl_cookie(string $value): string
{
    return VSL_COOKIE . "=$value; Path=/; Max-Age=2592000; HttpOnly; Secure; SameSite=Lax";
}
