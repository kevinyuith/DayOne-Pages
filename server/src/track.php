<?php
/**
 * The funnel's tracker on a funnel page: ONE script, /_dop/dot.js, sent as
 * the step it's on (?origin=pre_lander|lander).
 *
 * A funnel page is ONE HTML document with the steps as sibling
 * <section data-dop-page data-dop-kind="presell|main|backredirect">; the
 * delivery server sends one step per response (funnel.php), so it knows the
 * step being served and puts that step's tracker straight in the <head> — the
 * earliest spot, so the page_view goes out and the player's events are bound
 * before the VSL is ready:
 *
 *   Pre Lander (presell) → <script async src="/_dop/dot.js?origin=pre_lander…">
 *   Lander (main)        → <script async src="/_dop/dot.js?origin=lander…">
 *   Backredirect         → none
 *
 * ONLY a funnel page the gate served gets it (respond.php, beacon): a page with
 * steps as the served step's kind, a funnel page WITHOUT steps as the Lander.
 * A page with steps served outside the gate (a domain/safe page) gets no tracker
 * — a real click on it is marked server-side instead when it's a pre-lander slug
 * (dot.php, origin pre_lander). A page that already has a dot.js
 * or pre_dot.js tag of its own (any host, relative included) gets nothing —
 * the tracker would run twice. It's injected ONLY here, on the real delivery —
 * never in the dashboard preview (which serves the stored HTML without the
 * server) — so it can't fire tracking from a preview.
 *
 * A version (TRACK_ETAG + the tracker's URLs) goes into the ETag so a browser
 * holding a copy from before revalidates and gets the new body.
 *
 * On a funnel page the gate served, the tracker's URL also carries the page's
 * id (&page_id=, the same the page_id cookie has): the tracker takes it from
 * its own URL first — as from `page_id={{page_id}}` in a tracker tag the page
 * has itself (beacon.php) — and from the cookie otherwise. When the response
 * drew a VSL video — the served step's own code has {{video_id}} (vsl.php) —
 * the tracker gets it too (&video_id=, as `video_id={{video_id}}` would), on
 * whichever step drew it; a step that drew nothing sends no video.
 */
declare(strict_types=1);

defined('DAYONE_ENTRY') || (http_response_code(404) && exit);

/** ETag prefix of a page with the tracker. Changed how it goes in, bump it (the tracker's URLs go in by themselves). */
const TRACK_ETAG = '-k4';

/**
 * The tracker: served by this server on the funnel's own domain (first party —
 * no third-party CDN), from TRACKER_FILES below. Its URL has ?v=<content hash>,
 * so a changed tracker is a new URL and the old one can be cached for good.
 */
const TRACKER_PATH = '/_dop/dot.js';

/** The origin the tracker reports for each step kind (the Backredirect has none; a page without steps is the Lander). */
const TRACK_ORIGINS = [
    'presell' => 'pre_lander',
    'main' => 'lander',
];

/** The origin for the served step's kind (null = a page without steps: the Lander); null = no tracker. */
function track_origin(?string $kind): ?string
{
    return TRACK_ORIGINS[$kind ?? 'main'] ?? null;
}

/**
 * The tracker's URL: the content version (?v=), the step (&origin=), the
 * served page's id (&page_id=) and the VSL video the response drew
 * (&video_id=), if it drew one.
 */
function track_url(string $origin, ?string $pageId = null, ?string $videoId = null): string
{
    $q = ['v' => tracker_version(TRACKER_FILES[TRACKER_PATH]), 'origin' => $origin];
    if ($pageId !== null) {
        $q['page_id'] = $pageId;
    }
    if ($videoId !== null) {
        $q['video_id'] = $videoId;
    }
    return TRACKER_PATH . '?' . http_build_query($q, '', '&');
}

/** The ETag suffix of a page with the tracker: how it goes in and the tracker's URLs. */
function track_etag(): string
{
    return TRACK_ETAG . substr(md5(implode('|', array_map('track_url', TRACK_ORIGINS))), 0, 6);
}

/** Does the page load a tracker of its own (a dot.js or pre_dot.js tag, on any host)? Then it gets none: it would run twice. */
function track_has_own_tag(string $html): bool
{
    return preg_match('~(?<![\w.-])(?:pre_)?dot\.js(?!\w)~i', $html) === 1;
}

/** The step's tracker, right after <head> (the earliest spot); without a <head>, before </body> or at the end. */
function track_inject(string $html, string $origin, ?string $pageId = null, ?string $videoId = null): string
{
    $script = '<script data-dop-track async src="' . htmlspecialchars(track_url($origin, $pageId, $videoId), ENT_QUOTES) . '"></script>';
    if (preg_match('/<head\b[^>]*>/i', $html, $m, PREG_OFFSET_CAPTURE) === 1) {
        $at = (int) $m[0][1] + strlen($m[0][0]);
        return substr_replace($html, $script, $at, 0);
    }
    $pos = strripos($html, '</body>');
    return $pos === false ? $html . $script : substr_replace($html, $script, $pos, 0);
}

// ── The tracker itself: /_dop/dot.js ─────────────────────────────────────────
// It sends to dayone-main's dot edge function (Supabase), like the CDN copies
// (dot.js and pre_dot.js) it replaces. It takes the VSL video from its own URL
// or the video_id cookie the server sets with the page (vsl.php), never from
// the player.

const TRACKER_DOT_JS = <<<'JS'
/**
 * dot.js — the funnel's tracker, served by DayOne Pages on the funnel's own domain (/_dop/dot.js)
 * Endpoint: https://cdn.dayone.click/functions/v1/dot
 *
 * ORIGIN: the step it's on, from this script's own URL (?origin=pre_lander or
 *   lander; lander without one). The same code for both steps — it replaces
 *   pre_dot.js.
 *
 * PAGE_VIEW:
 *   - lander: fires SYNCHRONOUSLY as soon as this script executes — the very
 *     first request the tracker makes, so the session (and the dotid the server
 *     mints for it) is registered immediately.
 *   - pre_lander: fires only when the page has finished loading (window "load";
 *     at once if it already has), as pre_dot.js did — it reports "loaded", not
 *     "script ran". Two nets: LOAD_TIMEOUT (10s) for a stuck asset, and
 *     "pagehide" for the visitor who leaves first. Exactly one page_view either way.
 *
 * VIDEO_ID: comes from the funnel's server, never from the player. DayOne Pages
 *   draws the VSL video for the visitor (the funnel's VSLs tab; the page writes
 *   {{video_id}} in the vTurb embed) and writes it in this script's own URL
 *   (?video_id=, filled when the page is served) and in the `video_id` cookie,
 *   both in the SAME response that carries this page, so it is already there
 *   when this script runs; the URL wins (a funnel page that drew no video
 *   deletes the cookie: it never speaks for another page). The page_view carries it — and so does the server's own
 *   click event — so there is no video_load event and no waiting for the player.
 *   Video events carry the same id, on whichever step drew the video; a page
 *   with no video_id has no video to report.
 *
 * VIDEO EVENTS — the same marks VTurb counts for the player, one per number:
 *   video_play   the video started (VTurb "started"; the muted smart autoplay
 *                counts, as in VTurb's play rate)
 *   video_watch  every 5s watched, and the last second on the way out (dot
 *                keeps the max per session)
 *   video_pitch  reached the pitch: VTurb's own `pitch:time` (only after a real
 *                play); without it, the config's pitchTime outside the muted
 *                smart autoplay
 *   video_click  a click on the player's call to action (VTurb's
 *                `analytics:exited-click`, VTurb "clicked"), or on a checkout link
 *   video_end    the video ended (VTurb's `video:ended`, VTurb "finished")
 *   They are bound to the player on player:ready — or at once, if the player
 *   was already ready when this script arrived.
 *
 * EXT_CLICK_ID: the platform's click id, picked from the URL in the same order
 *   the server's click event picks it (dot.php CLICK_ID_PARAMS), goes in every
 *   event, so dot ties the browser's events to that click (Taboola's tblci too).
 *
 * PAGE_ID: every event carries the funnel page the server served (the A/B
 *   split's pick) — dot's page_id column. The server writes it in this script's
 *   own URL (?page_id=, filled when the page is served) and sets it in the
 *   `page_id` cookie in the same response; the URL wins.
 *
 * Also preserved: UTM/click-ID capture (sessionStorage dot_attr), dotid cookie
 * (1 day), ?dotid= propagation on external links, send retries, pagehide beacon.
 *
 * NOTHING IS LOST — the outbox: every event is kept in localStorage until dot
 *   confirms it. dot answers 503 when its database write fails (PostgREST
 *   reloading its schema cache, the database out of connections: outages of up
 *   to 20 minutes were seen). An event dot didn't take goes again while the page
 *   is open (2s, 4s, 8s… then every minute, for 15 minutes) and from the next
 *   page of this domain (for a day), with `_delay_ms` (how long ago it happened,
 *   so dot dates it right without trusting this device's clock). dot keeps the
 *   first event of a kind per click and video_watch as the max, so an event
 *   sent twice is harmless. Only the latest pending video_watch is kept.
 *
 * RELIABILITY FIXES (see REQUEST_TIMEOUT / sendSync / video_click below):
 *   1. fetch now aborts at REQUEST_TIMEOUT. Without it, a stuck edge isolate left
 *      the promise pending until the gateway gave up (measured: 150s), and the
 *      retry ladder never started because it only runs from .catch().
 *   2. pagehide uses navigator.sendBeacon. Synchronous XHR is ignored during
 *      unload by current Chrome/Safari, so the exit video_watch/video_pitch was
 *      being dropped silently.
 *   3. video_click goes as a beacon and never holds the navigation back.
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
  var LOAD_TIMEOUT = 10000;    // pre_lander: hard cap (ms) waiting for window "load"
  // ---- origin: read from ?origin= on this script's own tag <script src="...dot.js?origin=..."> ----
  // currentScript is this very tag (the loader's or the page's own); without it, the first dot.js tag.
  var me = document.currentScript;
  var mySrc = me && me.src ? me.src : '';
  if (mySrc.indexOf('/dot.js') === -1) {
    var scripts = document.getElementsByTagName('script');
    for (var i = 0; i < scripts.length; i++) {
      var src = scripts[i].src || '';
      if (/\/dot\.js(?:[?#]|$)/.test(src)) { mySrc = src; break; } // not pre_dot.js
    }
  }
  var originMatch = mySrc.match(/[?&]origin=([^&#]+)/);
  var origin = originMatch ? decodeURIComponent(originMatch[1]) : 'lander';
  // ---- capture and persist attribution parameters ----
  var query = new URLSearchParams(window.location.search);
  var attrs = JSON.parse(sessionStorage.getItem('dot_attr') || '{}');
  ATTRIBUTION_PARAMS.forEach(function (p) {
    var v = query.get(p);
    if (v) attrs[p] = v;
  });
  // The platform's click id, in the server's order (dot.php CLICK_ID_PARAMS), names case-insensitive.
  var CLICK_ID_PARAMS = [
    'ext_click_id', 'gclid', 'wbraid', 'gbraid', 'dclid', 'fbclid', 'ttclid', 'tclid',
    'tbclid', 'tblci', 'snclid', 'sccid', 'msclkid', 'twclid', 'li_fat_id', 'epik', 'rdt_cid',
    'qclid', 'obclid', 'dicbo', 'yclid', 'nbclid', 'kwai_click_id', 'click_id', 'clickid', 'ref_id'
  ];
  (function () {
    var lower = {};
    query.forEach(function (v, k) {
      k = k.toLowerCase();
      v = (v || '').trim();
      if (v && !(k in lower)) lower[k] = v.slice(0, 1000);
    });
    for (var i = 0; i < CLICK_ID_PARAMS.length; i++) {
      if (lower[CLICK_ID_PARAMS[i]]) { attrs.ext_click_id = lower[CLICK_ID_PARAMS[i]]; break; }
    }
  })();
  sessionStorage.setItem('dot_attr', JSON.stringify(attrs));
  // ---- visitor identifier (URL > cookie) ----
  var dotid = query.get('dotid') ||
    document.cookie.replace(/(?:(?:^|.*;\s*)dotid\s*=\s*([^;]*).*$)|^.*$/, '$1') || null;
  // ---- page_id: the funnel page the server served (the A/B split's pick) ----
  // A uuid, from this script's own URL (?page_id=, filled by the server when it
  // served the page), otherwise from the `page_id` cookie set with the page.
  // Read once, now: a later page of the same domain (another tab) sets its own cookie.
  var pageId = (function () {
    var u = mySrc.match(/[?&]page_id=([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:[&#]|$)/);
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
  // ---- the outbox: an event is kept until dot confirms it (see the header) ----
  var OUTBOX_KEY = 'dot_outbox';
  var OUTBOX_MAX = 300;
  var OUTBOX_MAX_AGE = 86400000;   // a day: past it, dot can no longer tie the event to its click
  var RETRY_WINDOW = 900000;       // on this page, retry for 15 minutes; after that, the next page does
  var seq = 0;
  function outboxRead() {
    try {
      var a = JSON.parse(localStorage.getItem(OUTBOX_KEY) || '[]');
      return Array.isArray(a) ? a : [];
    } catch (e) { return []; }
  }
  function outboxWrite(a) {
    try {
      if (a.length) localStorage.setItem(OUTBOX_KEY, JSON.stringify(a.slice(-OUTBOX_MAX)));
      else localStorage.removeItem(OUTBOX_KEY);
    } catch (e) {}
  }
  function outboxAdd(item) {
    var p = item.p;
    // only the max of video_watch matters: a newer one replaces the pending ones of the same video
    // (and of scroll_depth: a newer one replaces the pending ones of the same page and step)
    var a = outboxRead().filter(function (x) {
      return !(p.event === 'video_watch' && x.p && x.p.event === 'video_watch' && x.p.video_id === p.video_id && x.p.dotid === p.dotid) &&
        !(p.event === 'scroll_depth' && x.p && x.p.event === 'scroll_depth' && x.p.url === p.url && x.p.origin === p.origin);
    });
    a.push(item);
    outboxWrite(a);
  }
  function outboxRemove(id) {
    outboxWrite(outboxRead().filter(function (x) { return x.id !== id; }));
  }
  function newItem(payload) {
    return { id: Date.now().toString(36) + '-' + (seq++) + '-' + Math.random().toString(36).slice(2, 8), t: Date.now(), p: payload };
  }
  // The body as sent: an event sent late says how long ago it happened.
  function bodyOf(item) {
    var p = item.p;
    var late = Date.now() - item.t;
    if (late > 3000) {
      p = JSON.parse(JSON.stringify(p));
      p._delay_ms = late;
    }
    return JSON.stringify(p);
  }
  function post(item, attempt) {
    return fetch(ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: bodyOf(item),
      keepalive: true,
      signal: timeoutSignal(REQUEST_TIMEOUT)
    }).then(function (res) {
      if (!res.ok) {
        // 5xx / 429: dot couldn't write it — worth another try; any other 4xx won't get better
        if (res.status >= 500 || res.status === 429) throw new Error(res.status);
        outboxRemove(item.id);
        return null;
      }
      outboxRemove(item.id);
      return res.json();
    }).then(function (data) {
      // first event of the session: the server returns the dotid
      if (data && data.dotid && !dotid) {
        dotid = data.dotid;
        setCookie('dotid', dotid, 1);
        decorateLinks();
      }
    }).catch(function () {
      if (Date.now() - item.t < RETRY_WINDOW) {
        setTimeout(function () { post(item, attempt + 1); }, Math.min(60000, 2000 * Math.pow(2, attempt - 1)));
      }
      // past the window it stays in the outbox: the next page of this domain sends it
    });
  }
  function sendEvent(eventName, extra) {
    var item = newItem(buildPayload(eventName, extra));
    outboxAdd(item);
    return post(item, 1);
  }
  // The events a previous page (or tab) of this domain left in the outbox: sent now, spaced out.
  function flushOutbox() {
    var now = Date.now();
    var a = outboxRead().filter(function (x) { return x && x.p && x.id && now - x.t < OUTBOX_MAX_AGE; });
    outboxWrite(a);
    a.forEach(function (item, i) {
      setTimeout(function () { post(item, 1); }, 1500 + i * 150);
    });
  }
  // Send for pagehide and for a click that leaves the page. sendBeacon is the
  // transport browsers are required to keep alive past unload — synchronous XHR
  // is ignored there by current Chrome and Safari, which was silently dropping
  // the exit video_watch/video_pitch. The event also goes to the outbox: the
  // beacon's answer can't be read, so the next page of this domain sends it
  // again (harmless: dot keeps one). The XHR path stays for browsers without sendBeacon.
  // The beacon goes as text/plain: dot parses the body whatever its type, and a JSON
  // type to another origin needs a preflight, which Chrome refuses for a beacon (it
  // throws — the click then fell back to a synchronous XHR that held the navigation).
  function sendSync(payload) {
    var item = newItem(payload);
    outboxAdd(item);
    var body = bodyOf(item);
    try {
      if (navigator.sendBeacon) {
        var blob = new Blob([body], { type: 'text/plain;charset=UTF-8' });
        if (navigator.sendBeacon(ENDPOINT, blob)) return;
      }
    } catch (e) {}
    try {
      var xhr = new XMLHttpRequest();
      xhr.open('POST', ENDPOINT, false);
      xhr.setRequestHeader('Content-Type', 'application/json');
      xhr.send(body);
      if (xhr.status >= 200 && xhr.status < 300) outboxRemove(item.id);
    } catch (e) {}
  }
  // ---- video_id: the VSL video the funnel's server drew for this page ----
  // 24 hex, from this script's own URL (?video_id=, filled by the server with the
  // draw), otherwise from the `video_id` cookie set in the same response.
  var videoId = (function () {
    var u = mySrc.match(/[?&]video_id=([0-9a-f]{24})(?:[&#]|$)/);
    if (u) return u[1];
    var m = document.cookie.match(/(?:^|;\s*)video_id=([0-9a-f]{24})(?:;|$)/);
    return m ? m[1] : null;
  })();
  // ---- video events (vTurb smartplayer): the marks VTurb counts (see the header) ----
  var player = null;           // the bound vturb-smartplayer
  var lastTime = 0;
  function currentTime() {
    try {
      if (player && player.playback && player.playback.currentTime >= 0) return Math.floor(player.playback.currentTime);
      if (player && player.smartplayer && player.smartplayer.currentTime >= 0) return Math.floor(player.smartplayer.currentTime);
    } catch (e) {}
    return lastTime;
  }
  function bindVideoEvents(el) {
    player = el;
    var pitchSent = false;
    var playSent = false;
    var endSent = false;
    var lastWatch = -1;
    function pitchTime() {
      var c = el.config || el.__config;
      return (c && c.pitchTime) || 0;
    }
    function firePlay() {
      if (playSent) return;
      playSent = true;
      sendEvent('video_play', { video_id: videoId });
      sendEvent('video_watch', { video_time: 0, video_id: videoId });
      lastWatch = 0;
    }
    function firePitch(t, sync) {
      if (pitchSent) return;
      pitchSent = true;
      var extra = { video_time: t, video_id: videoId };
      if (sync) sendSync(buildPayload('video_pitch', extra)); else sendEvent('video_pitch', extra);
    }
    // video was already playing when the tracker attached (e.g. resume, or a late tracker)
    if (currentTime() > 0) firePlay();
    el.addEventListener('video:play', firePlay);
    el.addEventListener('video:timeupdate', function (ev) {
      var t = Math.floor((ev.detail && ev.detail.time) || 0);
      lastTime = t;
      if (!playSent && t > 0) firePlay();
      // one video_watch for every 5s watched
      if (t >= lastWatch + 5) {
        lastWatch = t;
        sendEvent('video_watch', { video_time: t, video_id: videoId });
      }
      // no pitch:time from the player: the config's pitch, but never in the muted smart autoplay (VTurb's rule)
      var p = pitchTime();
      if (p > 0 && t >= p && !el.inSmartAutoPlay) firePitch(t);
    });
    // VTurb's own pitch mark: only after a real play
    el.addEventListener('pitch:time', function () { firePitch(currentTime()); });
    // the video ended: VTurb's "finished" — with the last second watched
    el.addEventListener('video:ended', function () {
      if (endSent) return;
      endSent = true;
      var t = currentTime();
      if (t > lastWatch) { lastWatch = t; sendEvent('video_watch', { video_time: t, video_id: videoId }); }
      sendEvent('video_end', { video_time: t, video_id: videoId });
    });
    // page exit: guarantees the final video_watch / video_pitch
    window.addEventListener('pagehide', function () {
      if (!playSent) return;
      var t = currentTime();
      if (t > lastWatch) {
        lastWatch = t;
        sendSync(buildPayload('video_watch', { video_time: t, video_id: videoId }));
      }
      var p = pitchTime();
      if (p > 0 && t >= p && !el.inSmartAutoPlay) firePitch(t, true);
    });
  }
  // The player, if it is already ready: VTurb's compat API lists the ready players; else the element itself.
  function readyPlayer() {
    try {
      var sp = window.smartplayer;
      if (sp && sp.instances && sp.instances.length && sp.instances[0].instance) return sp.instances[0].instance;
    } catch (e) {}
    var el = document.querySelector('vturb-smartplayer');
    return el && (el.playback || el.smartplayer) ? el : null;
  }
  // video_click: the player's call to action (VTurb "clicked") or a checkout link. Sent as a beacon —
  // it survives the navigation, so the click is never held back. Once per page.
  var clickSent = false;
  function fireClick() {
    if (clickSent) return;
    clickSent = true;
    sendSync(buildPayload('video_click', { video_time: currentTime(), video_id: videoId }));
  }
  if (dotid) setCookie('dotid', dotid, 1); // renew the cookie
  // If the page_view response arrives before the DOM finishes loading,
  // the external links don't exist yet — decorate again on DCL.
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', decorateLinks);
  }
  // =====================================================================
  // >>> PAGE_VIEW <<<
  // lander: IMMEDIATELY ON SCRIPT LOAD — no waiting for the player; this is
  // the first request made. pre_lander: once the page has LOADED (or at the
  // LOAD_TIMEOUT cap, or on pagehide if the visitor leaves first) — one send.
  // It carries the video_id the server drew (when this page has one).
  // =====================================================================
  var pageView = {
    site: window.location.hostname,
    lander: window.location.pathname
  };
  if (videoId) pageView.video_id = videoId;
  var pageViewSent = false;
  var loadTimer = null;
  function sendPageView() {
    if (pageViewSent) return;
    pageViewSent = true;
    if (loadTimer) { clearTimeout(loadTimer); loadTimer = null; }
    sendEvent('page_view', pageView);
  }
  flushOutbox();
  if (origin !== 'pre_lander' || document.readyState === 'complete') {
    sendPageView();
  } else {
    window.addEventListener('load', sendPageView, { once: true });
    loadTimer = setTimeout(sendPageView, LOAD_TIMEOUT); // stuck-asset safety cap
    window.addEventListener('pagehide', sendPageView, { once: true }); // left before "load"
  }
  // ---- scroll_depth: how far down this step the visitor read ----
  // The deepest the bottom of the screen got, % of the page's height (the first
  // screen counts without a scroll) — the same measure as the server's beacon
  // (beacon.php, pages.hits.signals.sd). The scroller is the window, or an element
  // as tall as most of the screen (builders that scroll the body or a wrapper); a
  // window that can't scroll measures nothing, so nothing is sent, never a guess.
  // Sent when the page is hidden or left, only when it grew. dot doesn't keep it
  // as a row: tracking.process_dot_queue raises the scroll_depth of this step's
  // page_view (same origin and click id; the max wins). As a beacon, it stays in
  // the outbox: the next page of the domain (the Lander, after the Pre Lander)
  // sends it again — harmless, the max is the max.
  var depthMax = -1, depthSent = -1, depthEl = null;
  function measureDepth(t) {
    try {
      var d = document.scrollingElement || document.documentElement;
      var e = t && t.nodeType === 1 && t.clientHeight >= window.innerHeight * 0.6 && t.scrollHeight > t.clientHeight + 2 ? t : null;
      var h, y;
      if (e) {
        depthEl = e;
        h = e.scrollHeight;
        y = e.scrollTop + e.clientHeight;
      } else {
        h = Math.max(d.scrollHeight, document.body ? document.body.scrollHeight : 0);
        if (h <= window.innerHeight + 2) return;
        y = (window.pageYOffset || d.scrollTop || 0) + window.innerHeight;
      }
      var p = Math.min(100, Math.round(y / h * 100));
      if (p > depthMax) depthMax = p;
    } catch (e) {}
  }
  function sendDepth() {
    measureDepth(depthEl);
    measureDepth(null);
    if (depthMax < 0 || depthMax <= depthSent) return;
    depthSent = depthMax;
    sendSync(buildPayload('scroll_depth', { scroll_depth: depthMax }));
  }
  window.addEventListener('scroll', function (ev) { if (ev.isTrusted) measureDepth(ev.target); }, { capture: true, passive: true });
  document.addEventListener('visibilitychange', function () { if (document.visibilityState === 'hidden') sendDepth(); });
  window.addEventListener('pagehide', sendDepth);
  // ---- player: binds the video events ----
  // On player:ready, registered RIGHT AWAY at script execution — and at once if the
  // player was already ready when this script arrived (a late tracker must not lose
  // the video), checked again on DOMContentLoaded and load.
  // The video is the server's (videoId above), on whichever step drew it: a page with no video_id has no video to report.
  if (videoId) {
    var videoBound = false;
    var bindOnce = function (el) {
      if (videoBound || !el) return;
      videoBound = true;
      bindVideoEvents(el);
    };
    document.addEventListener('player:ready', function (ev) {
      var d = (ev && ev.detail) || {};
      bindOnce(d.player || document.querySelector('vturb-smartplayer'));
    });
    bindOnce(readyPlayer());
    var lateCheck = function () { if (!videoBound) bindOnce(readyPlayer()); };
    document.addEventListener('DOMContentLoaded', lateCheck);
    window.addEventListener('load', lateCheck);
    // the player's call to action: VTurb dispatches it from inside the player (bubbles, composed),
    // and the player's own listener — CAPTURE, on the <vturb-smartplayer> — counts it as "clicked"
    // and stops it there (stopImmediatePropagation). Only a capture listener on the document runs
    // before that one; a bubbling listener never hears the click.
    document.addEventListener('analytics:exited-click', fireClick, true);
    // a checkout link on the page (any button: a new tab still counts), found on the event's path:
    // the player's call to action lives in its shadow DOM, where ev.target is only the player.
    document.addEventListener('click', function (ev) {
      var path = ev.composedPath ? ev.composedPath() : [ev.target];
      for (var i = 0; i < path.length; i++) {
        var n = path[i];
        if (n && n.tagName === 'A' && (n.getAttribute('href') || '').indexOf('checkout') >= 0) { fireClick(); return; }
      }
    }, true);
  }
})();
JS;

/** Served path → source. */
const TRACKER_FILES = [
    TRACKER_PATH => TRACKER_DOT_JS,
];

/** A tracker's version: its content hash (the loader's ?v= and the ETag). */
function tracker_version(string $js): string
{
    return substr(md5($js), 0, 10);
}

/**
 * GET/HEAD /_dop/dot.js on any domain. With the current
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
