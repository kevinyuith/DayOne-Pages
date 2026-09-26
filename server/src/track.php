<?php
/**
 * Per-step tracker scripts on a funnel page.
 *
 * A funnel page is ONE HTML document with the steps as sibling
 * <section data-dop-page data-dop-kind="presell|main|backredirect">; the
 * runtime (runtime.ts) shows one step at a time and, when it shows one,
 * dispatches `dop:pageshow` on the section (browser mode) — server mode
 * reloads with only that step. So there's no separate page load per step.
 *
 * When the delivery server serves a page that has steps, it injects a small
 * loader that loads the step's tracker when the step becomes visible, once:
 *
 *   Pre Lander (presell) → https://cdn.directdayone.com/js/pre_dot.js
 *   Lander (main)        → https://cdn.directdayone.com/js/dot.js?origin=lander&v=17
 *
 * The loader loads the initial step's tracker (the one that isn't `hidden`) and
 * listens for `dop:pageshow` for the following steps; the Backredirect has no
 * tracker. It's injected ONLY here, on the real delivery — never in the
 * dashboard preview (which serves the stored HTML without the server) — so it
 * can't fire tracking from a preview.
 *
 * A version (TRACK_ETAG) goes into the ETag so a browser holding a copy from
 * before the loader revalidates and gets the new body.
 */
declare(strict_types=1);

defined('DAYONE_ENTRY') || (http_response_code(404) && exit);

/** ETag suffix of a funnel page with the tracker loader. Changed the loader, bump the version. */
const TRACK_ETAG = '-k1';

/** The tracker of each step kind (the Backredirect has none). Change the URL here, in one place. */
const TRACK_SCRIPTS = [
    'presell' => 'https://cdn.directdayone.com/js/pre_dot.js',
    'main' => 'https://cdn.directdayone.com/js/dot.js?origin=lander&v=17',
];

/** Does the served page have funnel steps? Then it carries the per-step tracker loader. */
function track_applies(string $html): bool
{
    return funnel_has_sections($html);
}

/** The loader script (built from TRACK_SCRIPTS, so the URLs live in one place). */
function track_script(): string
{
    $map = json_encode(TRACK_SCRIPTS, JSON_UNESCAPED_SLASHES);
    return '<script data-dop-track>(function(){'
        . 'var S=' . $map . ',done={};'
        . 'function K(p){var k=p&&p.getAttribute("data-dop-kind");return k==="presell"||k==="backredirect"?k:"main"}'
        . 'function L(p){if(!p)return;var u=S[K(p)];if(!u||done[u])return;done[u]=1;var s=document.createElement("script");s.src=u;s.async=true;(document.body||document.documentElement).appendChild(s)}'
        . 'document.addEventListener("dop:pageshow",function(e){var t=e.target;L(t&&t.closest?t.closest("[data-dop-page]"):t)},true);'
        . 'function I(){L(document.querySelector("[data-dop-page]:not([hidden])"))}'
        . 'if(document.readyState==="loading")document.addEventListener("DOMContentLoaded",I);else I();'
        . '})();</script>';
}

/** The loader before the last </body> (without </body>, at the end) — like beacon_inject. */
function track_inject(string $html): string
{
    $pos = strripos($html, '</body>');
    $script = track_script();
    return $pos === false ? $html . $script : substr_replace($html, $script, $pos, 0);
}
