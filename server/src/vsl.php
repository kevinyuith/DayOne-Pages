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
 */
declare(strict_types=1);

defined('DAYONE_ENTRY') || (http_response_code(404) && exit);

/** Cookie of the VSL draw: the videos (VTurb player ids) already drawn for the visitor, this funnel's first. */
const VSL_COOKIE = 'dop_vsl';
const VSL_MAX_IDS = 10;

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

    $out = preg_replace_callback(vsl_player_re(), static fn (array $m): string => vsl_player_tag($m[0], $m['q'], $pick), $html) ?? $html;

    $keep = array_values(array_filter($known, fn ($id) => !in_array($id, $ids, true)));
    $value = implode(',', array_slice([$pick, ...$keep], 0, VSL_MAX_IDS));
    return ['html' => $out, 'tag' => $pick, 'cookie' => $value === $raw ? null : $value];
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
