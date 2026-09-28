<?php
/**
 * Per-step tracker scripts on a funnel page.
 *
 * A funnel page is ONE HTML document with the steps as sibling
 * <section data-dop-page data-dop-kind="presell|main|backredirect">; the
 * delivery server sends one step per response (funnel.php) and moving on
 * reloads the same URL with the next one; without the server (static HTML),
 * the runtime (runtime.ts) shows one step at a time and dispatches
 * `dop:pageshow` on the section it shows.
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
 *
 * On a funnel page the gate served, the trackers' URLs also carry the page's
 * id (&page_id=, the same the page_id cookie has): the trackers take it from
 * their own URL first — as from `page_id={{page_id}}` in a tracker tag the
 * page has itself (beacon.php) — and from the cookie otherwise.
 */
declare(strict_types=1);

defined('DAYONE_ENTRY') || (http_response_code(404) && exit);

/** ETag prefix of a funnel page with the tracker loader. Changed the loader, bump it (the trackers' versions go in by themselves). */
const TRACK_ETAG = '-k3';

/**
 * The tracker of each step kind (the Backredirect has none): served by this
 * server on the funnel's own domain (first party — no third-party CDN), from
 * TRACKER_FILES below. The loader asks for them with ?v=<content hash>, so a
 * changed tracker is a new URL and the old one can be cached for good.
 */
const TRACK_SCRIPTS = [
    'presell' => '/_dop/pre_dot.js',
    'main' => '/_dop/dot.js',
];

/** Does the served page have funnel steps? Then it carries the per-step tracker loader. */
function track_applies(string $html): bool
{
    return funnel_has_sections($html);
}

/** The trackers' URLs with their content version (?v=) and the served page's id (&page_id=): what the loader loads. */
function track_urls(?string $pageId = null): array
{
    $page = $pageId !== null ? '&page_id=' . rawurlencode($pageId) : '';
    return array_map(static fn (string $path): string => $path . '?v=' . tracker_version(TRACKER_FILES[$path]) . $page, TRACK_SCRIPTS);
}

/** The ETag suffix of a page with the loader: the loader's version and the trackers' (their URLs are in the page). */
function track_etag(): string
{
    return TRACK_ETAG . substr(md5(implode('|', track_urls())), 0, 6);
}

/** The loader script (built from TRACK_SCRIPTS, so the URLs live in one place). */
function track_script(?string $pageId = null): string
{
    $map = json_encode(track_urls($pageId), JSON_UNESCAPED_SLASHES);
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
function track_inject(string $html, ?string $pageId = null): string
{
    $pos = strripos($html, '</body>');
    $script = track_script($pageId);
    return $pos === false ? $html . $script : substr_replace($html, $script, $pos, 0);
}

// ── The trackers themselves: /_dop/pre_dot.js and /_dop/dot.js ──────────────
// They send to dayone-main's dot edge function (Supabase), like the CDN copies
// they replace. dot.js takes the VSL video from the video_id cookie the server
// sets with the page (vsl.php), never from the player.

const TRACKER_DOT_JS = <<<'JS'
/**
 * dot.js — VSL funnel tracker, served by DayOne Pages on the funnel's own domain (/_dop/dot.js)
 * Endpoint: https://cdn.dayone.click/functions/v1/dot
 *
 * PAGE_VIEW: fires SYNCHRONOUSLY as soon as this script executes — the very
 *   first request the tracker makes, so the session (and the dotid the server
 *   mints for it) is registered immediately.
 *
 * VIDEO_ID: comes from the funnel's server, never from the player. DayOne Pages
 *   draws the VSL video for the visitor (the funnel's VSLs tab; the page writes
 *   {{video_id}} in the vTurb embed) and sets the `video_id` cookie in the SAME
 *   response that carries this page, so it is already there when this script
 *   runs (a funnel page that drew no video deletes it: it never speaks for
 *   another page). The page_view carries it — and so does the server's own
 *   click event — so there is no video_load event and no waiting for the player.
 *   Video events (video_play, video_watch, video_pitch, video_click) are bound on
 *   player:ready and carry the same id; a page with no video_id cookie has no
 *   video to report.
 *
 * PAGE_ID: every event carries the funnel page the server served (the A/B
 *   split's pick) — dot's page_id column. The server writes it in this script's
 *   own URL (?page_id=, filled when the page is served) and sets it in the
 *   `page_id` cookie in the same response; the URL wins. pre_dot.js does the
 *   same on the Pre Lander.
 *
 * Also preserved: UTM/click-ID capture (sessionStorage dot_attr), dotid cookie
 * (1 day), ?dotid= propagation on external links, send retries, pagehide beacon.
 *
 * RELIABILITY FIXES (see REQUEST_TIMEOUT / sendSync / checkout click below):
 *   1. fetch now aborts at REQUEST_TIMEOUT. Without it, a stuck edge isolate left
 *      the promise pending until the gateway gave up (measured: 150s), and the
 *      retry ladder never started because it only runs from .catch().
 *   2. pagehide uses navigator.sendBeacon. Synchronous XHR is ignored during
 *      unload by current Chrome/Safari, so the exit video_watch/video_pitch was
 *      being dropped silently.
 *   3. the checkout click handler no longer hijacks ctrl/cmd/middle click.
 */
(function () {
  'use strict';
  var ENDPOINT = 'https://cdn.dayone.click/functions/v1/dot';
  var REQUEST_TIMEOUT = 5000;  // max wait (ms) for a single send before aborting
  // Attribution parameters captured from the URL and persisted for the session
  var ATTRIBUTION_PARAMS = [
    'rtkcid', 'sub1', 'sub2', 'sub3', 'sub4', 'sub5', 'sub6', 'sub7',
    'sub9', 'sub10', 'sub11', 'gclid', 'fbclid', 'tclid', 'ttclid',
    'wbraid', 'gbraid', 'ref_id'
  ];
  // ---- origin: read from ?origin= on this script's own tag <script src="...dot.js?origin=..."> ----
  var origin = 'lander';
  var scripts = document.getElementsByTagName('script');
  for (var i = 0; i < scripts.length; i++) {
    var src = scripts[i].src || '';
    if (src.indexOf('/dot.js') !== -1) { // not pre_dot.js
      var m = src.match(/[?&]origin=([^&]+)/);
      if (m) origin = decodeURIComponent(m[1]);
      break;
    }
  }
  // ---- capture and persist attribution parameters ----
  var query = new URLSearchParams(window.location.search);
  var attrs = JSON.parse(sessionStorage.getItem('dot_attr') || '{}');
  ATTRIBUTION_PARAMS.forEach(function (p) {
    var v = query.get(p);
    if (v) attrs[p] = v;
  });
  sessionStorage.setItem('dot_attr', JSON.stringify(attrs));
  // ---- visitor identifier (URL > cookie) ----
  var dotid = query.get('dotid') ||
    document.cookie.replace(/(?:(?:^|.*;\s*)dotid\s*=\s*([^;]*).*$)|^.*$/, '$1') || null;
  // ---- page_id: the funnel page the server served (the A/B split's pick) ----
  // A uuid, from this script's own URL (?page_id=, filled by the server when it
  // served the page), otherwise from the `page_id` cookie set with the page.
  // Read once, now: a later page of the same domain (another tab) sets its own cookie.
  var pageId = (function () {
    var me = document.currentScript;
    var u = me && me.src ? me.src.match(/[?&]page_id=([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:[&#]|$)/) : null;
    if (u) return u[1];
    var m = document.cookie.match(/(?:^|;\s*)page_id=([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:;|$)/);
    return m ? m[1] : null;
  })();
  function setCookie(name, value, days) {
    var d = new Date();
    d.setTime(d.getTime() + days * 86400000);
    document.cookie = name + '=' + value + ';path=/;expires=' + d.toUTCString() + ';SameSite=Lax';
  }
  // Propagates ?dotid= on every link pointing to other domains
  function decorateLinks() {
    if (!dotid) return;
    document.querySelectorAll('a[href]').forEach(function (a) {
      try {
        var u = new URL(a.href, window.location.origin);
        if (u.hostname !== window.location.hostname && !u.searchParams.has('dotid')) {
          u.searchParams.set('dotid', dotid);
          a.href = u.toString();
        }
      } catch (e) {}
    });
  }
  function buildPayload(eventName, extra) {
    var payload = {
      event: eventName,
      origin: origin,
      url: window.location.href,
      referrer: document.referrer || null,
      _cookies: document.cookie || null,
      _tz: Intl.DateTimeFormat().resolvedOptions().timeZone || null
    };
    if (dotid) payload.dotid = dotid;
    if (pageId) payload.page_id = pageId;
    for (var k in attrs) payload[k] = attrs[k];
    if (extra) { for (var k2 in extra) payload[k2] = extra[k2]; }
    return payload;
  }
  // Aborts a send that hangs. Without this a stuck isolate keeps the promise
  // pending forever: the visitor waits on the gateway timeout and the retry
  // below never fires, because it only runs from .catch().
  // AbortSignal.timeout does not exist on older browsers, so it is optional —
  // without it the behaviour falls back to what it was, it never breaks the send.
  function timeoutSignal(ms) {
    try {
      if (typeof AbortSignal !== 'undefined' && AbortSignal.timeout) return AbortSignal.timeout(ms);
    } catch (e) {}
    return undefined;
  }
  function sendEvent(eventName, extra, attempt) {
    attempt = attempt || 1;
    var payload = buildPayload(eventName, extra);
    return fetch(ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      keepalive: true,
      signal: timeoutSignal(REQUEST_TIMEOUT)
    }).then(function (res) {
      if (!res.ok) throw new Error(res.status);
      return res.json();
    }).then(function (data) {
      // first event of the session: the server returns the dotid
      if (data.dotid && !dotid) {
        dotid = data.dotid;
        setCookie('dotid', dotid, 1);
        decorateLinks();
      }
    }).catch(function () {
      if (attempt < 3) {
        setTimeout(function () {
          sendEvent(eventName, extra, attempt + 1);
        }, attempt * 2000);
      }
    });
  }
  // Send for pagehide. sendBeacon is the only transport browsers are required to
  // keep alive past unload — synchronous XHR is ignored there by current Chrome
  // and Safari, which was silently dropping the exit video_watch/video_pitch.
  // The XHR path stays as a fallback for browsers without sendBeacon.
  function sendSync(payload) {
    var body = JSON.stringify(payload);
    try {
      if (navigator.sendBeacon) {
        var blob = new Blob([body], { type: 'application/json' });
        if (navigator.sendBeacon(ENDPOINT, blob)) return;
      }
    } catch (e) {}
    try {
      var xhr = new XMLHttpRequest();
      xhr.open('POST', ENDPOINT, false);
      xhr.setRequestHeader('Content-Type', 'application/json');
      xhr.send(body);
    } catch (e) {}
  }
  // ---- video_id: the VSL video the funnel's server drew for this page ----
  // Set by the server in the same response as this page (cookie `video_id`, 24 hex).
  var videoId = (function () {
    var m = document.cookie.match(/(?:^|;\s*)video_id=([0-9a-f]{24})(?:;|$)/);
    return m ? m[1] : null;
  })();
  // ---- video events (vTurb smartplayer) ----
  function bindVideoEvents(player, videoId) {
    var pitchTime = (player.__config && player.__config.pitchTime) || 0;
    var pitchSent = false;
    var playSent = false;
    var lastWatch = -1;
    var lastTime = 0;
    function firePlay() {
      if (playSent) return;
      playSent = true;
      sendEvent('video_play', { video_id: videoId });
      sendEvent('video_watch', { video_time: 0, video_id: videoId });
      lastWatch = 0;
    }
    // video was already playing when the tracker attached (e.g. resume)
    if (player.smartplayer && player.smartplayer.currentTime > 0) firePlay();
    player.addEventListener('video:play', function () {
      firePlay();
    });
    player.addEventListener('video:timeupdate', function (ev) {
      var t = Math.floor((ev.detail && ev.detail.time) || 0);
      lastTime = t;
      if (!playSent && t > 0) firePlay();
      if (!pitchTime && player.__config && player.__config.pitchTime) {
        pitchTime = player.__config.pitchTime;
      }
      // one video_watch for every 5s watched
      if (t >= lastWatch + 5) {
        lastWatch = t;
        sendEvent('video_watch', { video_time: t, video_id: videoId });
      }
      // reached the pitch moment
      if (!pitchSent && pitchTime > 0 && t >= pitchTime) {
        pitchSent = true;
        sendEvent('video_pitch', { video_time: t, video_id: videoId });
      }
    });
    // click on a checkout link: track it, then navigate
    document.addEventListener('click', function (ev) {
      // Only hijack a plain left click. Without this guard cmd/ctrl/middle click —
      // "open the checkout in a new tab" — was cancelled and forced into the same
      // tab 150ms later, against what the visitor asked for.
      if (ev.button !== 0 || ev.metaKey || ev.ctrlKey || ev.shiftKey || ev.altKey) return;
      var link = ev.target.closest("a[href*='checkout']");
      if (!link) return;
      ev.preventDefault();
      var t = Math.floor((player.smartplayer && player.smartplayer.currentTime) || 0);
      sendEvent('video_click', { video_time: t, video_id: videoId });
      setTimeout(function () {
        window.location.href = link.href;
      }, 150);
    });
    // page exit: guarantees the final video_watch / video_pitch
    window.addEventListener('pagehide', function () {
      if (!playSent) return;
      var t = Math.floor((player.smartplayer && player.smartplayer.currentTime) || lastTime);
      if (t > lastWatch) {
        sendSync(buildPayload('video_watch', { video_time: t, video_id: videoId }));
      }
      if (!pitchSent && pitchTime > 0 && t >= pitchTime) {
        pitchSent = true;
        sendSync(buildPayload('video_pitch', { video_time: t, video_id: videoId }));
      }
    });
  }
  if (dotid) setCookie('dotid', dotid, 1); // renew the cookie
  // If the page_view response arrives before the DOM finishes loading,
  // the external links don't exist yet — decorate again on DCL.
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', decorateLinks);
  }
  // =====================================================================
  // >>> PAGE_VIEW IMMEDIATELY ON SCRIPT LOAD <<<
  // No waiting for the player. This is the first request made; it carries
  // the video_id the server drew (when this page has one).
  // =====================================================================
  var pageView = {
    site: window.location.hostname,
    lander: window.location.pathname
  };
  if (videoId) pageView.video_id = videoId;
  sendEvent('page_view', pageView);
  // ---- player: binds the video events on player:ready ----
  // Registered RIGHT AWAY at script execution (the original only registered it
  // on DOMContentLoaded and lost the event if the player got ready earlier).
  // The video is the server's (videoId above): a page with no video_id cookie has no video to report.
  if (origin === 'lander' && videoId) {
    var videoBound = false;
    document.addEventListener('player:ready', function (ev) {
      var d = (ev && ev.detail) || {};
      var el = d.player || document.querySelector('vturb-smartplayer');
      if (videoBound || !el) return;
      videoBound = true;
      bindVideoEvents(el, videoId);
    });
  }
})();
JS;

const TRACKER_PRE_DOT_JS = <<<'JS'
/**
 * pre_dot.js — pre-lander tracker, served by DayOne Pages on the funnel's own domain (/_dop/pre_dot.js)
 * Endpoint: https://cdn.dayone.click/functions/v1/dot
 * Event:    page_view   |   origin: pre_lander
 *
 * WHAT CHANGED
 * ------------
 * BEFORE: the page_view was fired the instant the script executed — i.e. it
 *         reported "script ran", not "page loaded". On a page whose assets were
 *         still streaming in, the event was already counted.
 *
 * NOW:    the page_view fires ONLY when the page has actually finished loading:
 *           • if document.readyState is already "complete" when the script runs
 *             (script injected late / cached page), it fires immediately;
 *           • otherwise it waits for the window "load" event.
 *
 *         Two safety nets keep a slow or abandoned page from losing the session:
 *           • LOAD_TIMEOUT (10s) — if a single stuck third-party asset never
 *             lets "load" fire, the event goes out anyway;
 *           • "pagehide" — if the visitor leaves before the page finishes
 *             loading, the event is flushed on the way out (fetch keepalive).
 *         Every path goes through the same `sent` guard, so exactly ONE
 *         page_view is ever sent.
 *
 * TRADE-OFF worth knowing: waiting for "load" means a visitor who bounces in
 * the first instants is now recorded by the pagehide net, but their outbound
 * links were never decorated with ?dotid= (the response hadn't come back yet),
 * so that particular click won't stitch to the lander. That is the inherent
 * cost of measuring "loaded" instead of "script ran".
 *
 * PRESERVED, unchanged: UTM / click-ID capture from the query string, the
 * dotid cookie (1 day, minted by the server on the first event) and the
 * ?dotid= propagation on every link pointing to another domain.
 */
(function () {
  'use strict';

  var ENDPOINT = 'https://cdn.dayone.click/functions/v1/dot';
  var ORIGIN = 'pre_lander';
  var LOAD_TIMEOUT = 10000; // ms — hard cap waiting for window "load"

  // Attribution parameters read from the URL of THIS page view
  var ATTRIBUTION_PARAMS = [
    'rtkcid', 'sub1', 'sub2', 'sub3', 'sub4', 'sub5', 'sub6', 'sub7',
    'sub9', 'sub10', 'sub11', 'gclid', 'fbclid', 'tclid', 'ttclid',
    'wbraid', 'gbraid', 'ref_id'
  ];

  var query = new URLSearchParams(location.search);

  // ---- visitor identifier (URL > cookie) ----
  var cookieMatch = document.cookie.match(/(?:^|;\s*)dotid=([^;]+)/);
  var dotid = query.get('dotid') || (cookieMatch && cookieMatch[1]) || null;

  // ---- the funnel page the server served: this script's own URL (?page_id=, filled
  // by the server), otherwise the `page_id` cookie set with this page (a uuid) ----
  // Read now, not at "load": by then another tab of the same domain may have set its own.
  var me = document.currentScript;
  var pageMatch = (me && me.src ? me.src.match(/[?&]page_id=([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:[&#]|$)/) : null) ||
    document.cookie.match(/(?:^|;\s*)page_id=([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:;|$)/);
  var pageId = pageMatch ? pageMatch[1] : null;

  function buildPayload() {
    var payload = {
      event: 'page_view',
      origin: ORIGIN,
      url: location.href,
      referrer: document.referrer || null,
      site: location.hostname,
      lander: location.pathname
    };
    if (dotid) payload.dotid = dotid;
    if (pageId) payload.page_id = pageId;
    ATTRIBUTION_PARAMS.forEach(function (p) {
      var v = query.get(p);
      if (v) payload[p] = v;
    });
    return payload;
  }

  // Server minted a dotid on this first event: persist it and carry it forward
  function adoptDotid(data) {
    if (!data || !data.dotid || dotid) return;
    dotid = data.dotid;

    var exp = new Date();
    exp.setTime(exp.getTime() + 86400000); // 1 day
    document.cookie = 'dotid=' + dotid + ';path=/;expires=' + exp.toUTCString() + ';SameSite=Lax';

    document.querySelectorAll('a[href]').forEach(function (a) {
      try {
        var u = new URL(a.href, location.origin);
        if (u.hostname !== location.hostname && !u.searchParams.has('dotid')) {
          u.searchParams.set('dotid', dotid);
          a.href = u.toString();
        }
      } catch (e) {}
    });
  }

  // ---- the single send, guarded so it can only ever happen once ----
  var sent = false;
  var timer = null;

  function sendPageView() {
    if (sent) return;
    sent = true;
    if (timer) { clearTimeout(timer); timer = null; }

    fetch(ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(buildPayload()),
      keepalive: true // survives the pagehide path
    })
      .then(function (res) { return res.ok ? res.json() : null; })
      .then(adoptDotid)
      .catch(function () {});
  }

  // =====================================================================
  // >>> FIRE ONLY WHEN THE PAGE HAS LOADED <<<
  // =====================================================================
  if (document.readyState === 'complete') {
    // page was already fully loaded before this script executed
    sendPageView();
  } else {
    window.addEventListener('load', sendPageView, { once: true });
    timer = setTimeout(sendPageView, LOAD_TIMEOUT); // stuck-asset safety cap
  }

  // Net for the visitor who leaves before "load" ever fires
  window.addEventListener('pagehide', sendPageView, { once: true });
})();
JS;

/** Served path → source. */
const TRACKER_FILES = [
    '/_dop/pre_dot.js' => TRACKER_PRE_DOT_JS,
    '/_dop/dot.js' => TRACKER_DOT_JS,
];

/** A tracker's version: its content hash (the loader's ?v= and the ETag). */
function tracker_version(string $js): string
{
    return substr(md5($js), 0, 10);
}

/**
 * GET/HEAD /_dop/pre_dot.js or /_dop/dot.js on any domain. With the current
 * ?v= it's cacheable for good (a new version is a new URL); without it (or an
 * old one), 5 minutes. null = not a tracker path.
 *
 * @return array{0: int, 1: array<string,string>, 2: ?string}|null
 */
function handle_tracker(Request $req): ?array
{
    $js = TRACKER_FILES[$req->rawPath] ?? null;
    if ($js === null) {
        return null;
    }
    if ($req->method !== 'GET' && $req->method !== 'HEAD') {
        return [405, ['Allow' => 'GET, HEAD', 'Content-Type' => 'text/plain; charset=utf-8', 'Cache-Control' => 'no-store'], "Method not allowed\n"];
    }
    $version = tracker_version($js);
    parse_str($req->rawQuery, $q);
    $headers = [
        'Content-Type' => 'application/javascript; charset=utf-8',
        'Cache-Control' => ($q['v'] ?? null) === $version ? 'public, max-age=31536000, immutable' : 'public, max-age=300',
        'ETag' => '"' . $version . '"',
        'X-Content-Type-Options' => 'nosniff',
    ];
    if ($req->ifNoneMatch !== null && etag_matches($req->ifNoneMatch, $headers['ETag'])) {
        return [304, $headers, null];
    }
    return [200, $headers, $js];
}
