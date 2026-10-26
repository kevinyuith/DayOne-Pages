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
 * served page's id (&page_id=), the VSL video the response drew
 * (&video_id=), if it drew one, and the CTA mode (&cta=, cta.php).
 */
function track_url(string $origin, ?string $pageId = null, ?string $videoId = null, ?int $cta = null, array $extra = []): string
{
    $q = ['v' => tracker_version(TRACKER_FILES[TRACKER_PATH]), 'origin' => $origin];
    if ($pageId !== null) {
        $q['page_id'] = $pageId;
    }
    if ($videoId !== null) {
        $q['video_id'] = $videoId;
    }
    // The funnel's CTA (cta.php): 1 = ask /_dop/cta at the pitch, 2 = at once (a returning visitor).
    if ($cta !== null) {
        $q['cta'] = $cta;
    }
    // A vendor upsell step (upsell.php): its offer's and downsells' codes (&o=, &ds=), to tell the answers apart.
    foreach ($extra as $k => $v) {
        $q[$k] = $v;
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
function track_inject(string $html, string $origin, ?string $pageId = null, ?string $videoId = null, ?int $cta = null, array $extra = []): string
{
    $script = '<script data-dop-track async src="' . htmlspecialchars(track_url($origin, $pageId, $videoId, $cta, $extra), ENT_QUOTES) . '"></script>';
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
 * Endpoint: https://api.directdayone.com/functions/v1/dot
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
 *   On a link, `{ext_click_id}` becomes it (else the dotid) at the visitor's touch
 *   or click — a network's own click-id field, e.g. Everflow's `?source_id={ext_click_id}`.
 *
 * PAGE_ID: every event carries the funnel page the server served (the A/B
 *   split's pick) — dot's page_id column. The server writes it in this script's
 *   own URL (?page_id=, filled when the page is served) and sets it in the
 *   `page_id` cookie in the same response; the URL wins.
 *
 * CTA_ID: on a VSL whose CTA is the server's (cta.php), this script's URL has
 *   &cta=1: CTA_LEAD seconds before the pitch (the player config's pitchTime) it
 *   asks /_dop/cta (same origin) for the CTA the server draws and puts it, HIDDEN,
 *   under the player ([data-dop-cta], or right after the <vturb-smartplayer>), so
 *   its jars, fonts and icons are already down when it shows; at the pitch it shows
 *   it — loaded or not — and sends the video_pitch WITH its cta_id, and every event
 *   after it too (video_watch, video_click, video_end, scroll_depth): nothing before
 *   the pitch carries it, so only who saw the CTA counts. A pitch with no config
 *   pitchTime (only VTurb's pitch:time), or a seek past the lead, asks at the pitch
 *   and waits for it up to CTA_TIMEOUT. &cta=2 = the visitor already got one of the funnel's CTAs:
 *   asked for at once, as VTurb shows its CTA to a returning viewer. Its links get
 *   the page's URL parameters, the dotid and the cta_id (appended as text: the
 *   checkout link's own nested u= stays as it is), and, on the visitor's touch or
 *   click, VTurb's conversion key (the player's conversionKey, v3_…: it has the
 *   time watched in it) as vturb_id and under every name of the player config's
 *   `conversion`. No answer in time → the
 *   page's reserve (<template data-dop-cta-reserve>), with no cta_id: it wasn't drawn.
 *   &cta=3 = the test link (?dop_cta=<cta id> on the page): that CTA of the funnel, a
 *   draft too, at once (&preview= to /_dop/cta), outside the draw: no cookie, no cta_id.
 *
 * VENDOR UPSELLS (DayOne Pages, upsell.php): a vendor page's upsell funnel serves its steps with
 *   this script as origin vendor_up1…vendor_up5 and vendor_thank_you — a page_view per step, at
 *   once. On an upsell step every click on an offer's accept button (PagAmerican's data-pag-yes /
 *   data-pag-offer, or data-dop-accept) or decline button (data-pag-no, data-dop-decline, or a
 *   button or link that reads "No thanks…") goes as a beacon: upsell_accept / upsell_decline on
 *   the step's offer, downsell_accept / downsell_decline on a downsell's (origin + _ds1, _ds2…),
 *   the offer code in product_option. The server writes the step's codes in this script's URL
 *   (&o= the offer, &ds= the downsells, in order) to tell them apart; a code it doesn't know is
 *   the step's own offer. Once per answer and code on the page. The answer's metadata says what
 *   the buyer was served ({upsell: {s step, g group, fl flow, p page version, ds slot}}, from &u=).
 *
 * VENDOR LANDING (DayOne Pages, upsell.php vendor_route_mark): the vendor page's landing (its
 *   folder's root: "/", "/bg"…) has this script as origin vendor_front — a page_view at once.
 *   On every vendor route (vendor_front, vendor_up1…, vendor_thank_you) whose product is linked to
 *   its core product, the server writes &product_id=<core product> and &step=<origin> in this
 *   script's URL: every event then carries product_id and step, top-level and in _metadata (dot
 *   keeps _metadata as the event's metadata; with it, the request headers dot would otherwise keep
 *   are left out — the cookies still go).
 *
 * Also preserved: UTM/click-ID capture (sessionStorage dot_attr), dotid cookie
 * (1 day), ?dotid= propagation on external links, send retries, pagehide beacon.
 *
 * NOTHING IS LOST — the outbox: every event is kept in localStorage until dot
 *   confirms it. dot answers 503 when its database write fails (PostgREST
 *   reloading its schema cache, the database out of connections: outages of up
 *   to 20 minutes were seen). An event dot didn't take goes again while the page
 *   is open (2s, 4s, 8s… then every minute, each ±50% at random so the visitors
 *   don't all come back at once, for 15 minutes) and from the next
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
  var ENDPOINT = 'https://api.directdayone.com/functions/v1/dot';
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
  // ---- vendor routes: the product's core id and the step, from this script's own URL (see the header) ----
  var vendorProduct = (function () {
    var p = mySrc.match(/[?&]product_id=([a-z0-9][a-z0-9_-]{0,99})(?:[&#]|$)/);
    var st = mySrc.match(/[?&]step=(vendor_[a-z0-9_]{1,30})(?:[&#]|$)/);
    return p && st ? { product_id: p[1], step: st[1] } : null;
  })();
  // ---- cta: the funnel's CTA under the VSL, drawn by the server at the pitch (see the header) ----
  var CTA_TIMEOUT = 2000;      // max wait (ms) for /_dop/cta before the reserve
  var CTA_LEAD = 3;            // seconds before the pitch the CTA is fetched and laid out hidden (its images load)
  var ctaMode = (function () {
    var m = mySrc.match(/[?&]cta=([123])(?:[&#]|$)/);
    return m ? +m[1] : 0;
  })();
  // &cta=3 = the test link (?dop_cta=<cta id> on the page): THAT CTA at once, outside the draw — the
  // server sets no cookie and the events carry no cta_id (a test isn't a view of the CTA).
  var ctaPreview = ctaMode === 3 && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(query.get('dop_cta') || '')
    ? query.get('dop_cta') : null;
  var ctaId = null;            // the drawn CTA, once it's shown: every event from then on carries it
  var ctaPending = null;       // the drawn CTA while it waits hidden for the pitch
  var ctaPromise = null;
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
  // CLICK ID ON A LINK (18/10/2026): `{ext_click_id}` on a link — written, or URL-encoded as decorateLinks leaves it
  // inside a checkout link's u= — becomes the visitor's click id, the platform's (ext_click_id, above) or else the
  // dotid, on the visitor's touch, click or long press, before the navigation (found on the composed path: the player's
  // call to action is in its shadow DOM). For a network that takes the click id in a field of its own and sends it back
  // in its postback — Everflow's source_id: `<tracking link>?source_id={ext_click_id}`, its postback
  // `ext_click_id={source_id}` to dot's conversions —, where the platform's own click id ties the sale to the ad like
  // any other. Only a link that has the token changes; no id yet (no click id in the URL, no dotid) leaves it as
  // written. The token was `{clickid}` until 20/10; it is `{ext_click_id}`, the field's own name, so `{clickid}` stays
  // free for other uses (no link used the old one).
  var CLICK_ID_TOKEN = /\{ext_click_id\}|%7Bext_click_id%7D/gi;
  function clickIdOnLink(href) {
    if (!href || href.search(CLICK_ID_TOKEN) < 0) return href;
    var id = attrs.ext_click_id || dotid;
    return id ? href.replace(CLICK_ID_TOKEN, encodeURIComponent(id)) : href;
  }
  function clickIdOnEvent(ev) {
    var path = ev.composedPath ? ev.composedPath() : [ev.target];
    for (var i = 0; i < path.length; i++) {
      var n = path[i];
      if (!n || n.tagName !== 'A' || !n.getAttribute) continue;
      var href = n.getAttribute('href') || '';
      var filled = clickIdOnLink(href);
      if (filled !== href) n.setAttribute('href', filled);
      return;
    }
  }
  ['pointerdown', 'touchstart', 'mousedown', 'click', 'auxclick', 'contextmenu'].forEach(function (t) {
    document.addEventListener(t, clickIdOnEvent, true);
  });
  // `meta` goes in the event's metadata (_metadata, as JSON); a vendor route's product and step too.
  function buildPayload(eventName, extra, meta) {
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
    if (ctaId) payload.cta_id = ctaId;
    for (var k in attrs) payload[k] = attrs[k];
    if (extra) { for (var k2 in extra) payload[k2] = extra[k2]; }
    if (vendorProduct) {
      payload.product_id = vendorProduct.product_id;
      payload.step = vendorProduct.step;
      meta = Object.assign({ product_id: vendorProduct.product_id, step: vendorProduct.step, cookies: document.cookie || null }, meta || {});
    }
    if (meta) payload._metadata = JSON.stringify(meta);
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
        // Jittered (50–150% of the step): when dot is down, every visitor's event
        // fails in the same seconds; without it they'd all come back together,
        // in waves that keep the database down (10/08: 3× the calls in 2 minutes).
        var wait = Math.min(60000, 2000 * Math.pow(2, attempt - 1));
        setTimeout(function () { post(item, attempt + 1); }, wait / 2 + Math.random() * wait);
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
      setTimeout(function () { post(item, 1); }, 1500 + i * 150 + Math.random() * 1000);
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
      if (sync) { sendSync(buildPayload('video_pitch', extra)); return; }
      // the server's CTA (&cta=): it shows now (already laid out when it was fetched CTA_LEAD before;
      // otherwise asked for now) and the video_pitch goes with its cta_id
      var cta = ctaFetch(false);
      if (cta) cta.then(function () { ctaReveal(); sendEvent('video_pitch', extra); }); else sendEvent('video_pitch', extra);
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
      // the server's CTA, CTA_LEAD before the pitch: fetched and laid out hidden, so its images are down when it shows
      if (ctaMode === 1 && p > 0 && t >= p - CTA_LEAD && t < p && !el.inSmartAutoPlay) ctaFetch(true);
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
  // The CTA's place: <div data-dop-cta> if the page has one, else a new one right after the player.
  function ctaSlot() {
    var s = document.querySelector('[data-dop-cta]');
    if (s) return s;
    var p = document.querySelector('vturb-smartplayer');
    if (!p || !p.parentNode) return null;
    s = document.createElement('div');
    s.setAttribute('data-dop-cta', '');
    p.parentNode.insertBefore(s, p.nextSibling);
    return s;
  }
  // A CTA link to another site gets what the VTurb CTA passes on: the page's URL parameters (but
  // ours, dop_*), the dotid and the cta_id. Appended as text, so the checkout link's own nested
  // u=https://…?aff=… is left exactly as it was.
  function ctaLink(href, id) {
    var hash = '';
    var at = href.indexOf('#');
    if (at >= 0) { hash = href.slice(at); href = href.slice(0, at); }
    var have = {};
    var q = href.indexOf('?');
    if (q >= 0) {
      href.slice(q + 1).split('&').forEach(function (kv) {
        var k = kv.split('=')[0];
        try { if (k) have[decodeURIComponent(k)] = 1; } catch (e) {}
      });
    }
    var add = [];
    query.forEach(function (v, k) {
      if (!have[k] && k.indexOf('dop_') !== 0) { have[k] = 1; add.push(encodeURIComponent(k) + '=' + encodeURIComponent(v)); }
    });
    if (dotid && !have.dotid) add.push('dotid=' + encodeURIComponent(dotid));
    if (id && !have.cta_id) add.push('cta_id=' + encodeURIComponent(id));
    return add.length ? href + (q >= 0 ? '&' : '?') + add.join('&') + hash : href + hash;
  }
  // Puts the CTA in its place (once) — hidden when it's early for the pitch: it's laid out and its
  // images load, but nobody sees it until ctaReveal. Its scripts run (innerHTML alone doesn't run them).
  function ctaShow(html, id, hidden) {
    var slot = ctaSlot();
    if (!slot || slot.getAttribute('data-dop-cta-shown')) return false;
    slot.setAttribute('data-dop-cta-shown', id || 'reserve');
    if (hidden) slot.style.display = 'none';
    slot.innerHTML = html;
    var scripts = slot.querySelectorAll('script');
    for (var i = 0; i < scripts.length; i++) {
      var old = scripts[i];
      var s = document.createElement('script');
      for (var j = 0; j < old.attributes.length; j++) s.setAttribute(old.attributes[j].name, old.attributes[j].value);
      s.text = old.text;
      old.parentNode.replaceChild(s, old);
    }
    var links = slot.querySelectorAll('a[href]');
    for (var k = 0; k < links.length; k++) {
      try {
        var u = new URL(links[k].getAttribute('href'), window.location.href);
        if (/^https?:$/.test(u.protocol) && u.hostname !== window.location.hostname) {
          links[k].setAttribute('href', ctaLink(links[k].getAttribute('href'), id));
        }
      } catch (e) {}
    }
    return true;
  }
  // The CTA shows: the slot becomes visible and, if the server drew it, its cta_id goes on every event from now on.
  function ctaReveal() {
    var slot = document.querySelector('[data-dop-cta]');
    if (slot) slot.style.display = '';
    if (ctaPending) ctaId = ctaPending;
  }
  // VTurb's conversion key (v3_<session>_<player>_<seconds sent>…, what VTurb matches a sale by): the player
  // computes it when it's read — the time watched is in it —, so a CTA link takes it on the visitor's own touch,
  // click or long press, as VTurb does with its own CTA. It goes under every name the player's config lists
  // (`conversion`: vturb_id on F8) and always as vturb_id (what the conversions postback reads first), on the
  // outer link (checkout.directdayone.com passes it on), as text like the rest.
  function conversionKey() {
    var els = [document.querySelector('vturb-smartplayer'), player];
    for (var i = 0; i < els.length; i++) {
      try {
        var k = els[i] && els[i].conversionKey;
        if (typeof k === 'string' && /^v3_[\w.-]{1,300}$/.test(k)) return k;
      } catch (e) {}
    }
    return '';
  }
  function conversionNames() {
    var names = ['vturb_id'];
    [document.querySelector('vturb-smartplayer'), player].forEach(function (el) {
      try {
        var c = el && (el.config || el.__config);
        ((c && c.conversion) || []).forEach(function (n) {
          if (typeof n === 'string' && /^[\w.-]{1,40}$/.test(n) && names.indexOf(n) < 0) names.push(n);
        });
      } catch (e) {}
    });
    return names;
  }
  // name=value on a link, as text: replaces the value it already has (the first), otherwise appends it.
  function linkParam(href, name, value) {
    var hash = '';
    var at = href.indexOf('#');
    if (at >= 0) { hash = href.slice(at); href = href.slice(0, at); }
    var pair = encodeURIComponent(name) + '=' + encodeURIComponent(value);
    var re = new RegExp('([?&])' + name.replace(/\./g, '\\.') + '=[^&]*');
    href = re.test(href) ? href.replace(re, function (m, sep) { return sep + pair; }) : href + (href.indexOf('?') >= 0 ? '&' : '?') + pair;
    return href + hash;
  }
  function ctaKeyOnLink(ev) {
    var a = ev.target && ev.target.closest ? ev.target.closest('[data-dop-cta] a[href]') : null;
    if (!a) return;
    var href = a.getAttribute('href');
    try {
      var u = new URL(href, window.location.href);
      if (!/^https?:$/.test(u.protocol) || u.hostname === window.location.hostname) return;
    } catch (e) { return; }
    var key = conversionKey();
    if (!key) return;
    conversionNames().forEach(function (n) { href = linkParam(href, n, key); });
    a.setAttribute('href', href);
  }
  if (ctaMode) {
    ['pointerdown', 'touchstart', 'mousedown', 'click', 'auxclick', 'contextmenu'].forEach(function (t) {
      document.addEventListener(t, ctaKeyOnLink, true);
    });
  }
  // Asks the server for the CTA, once (`hidden`: early for the pitch, laid out but not shown):
  // resolves when it's in place (or the reserve, after CTA_TIMEOUT or a failure). The server's CTA
  // waits in ctaPending; ctaReveal shows it.
  function ctaFetch(hidden) {
    if (!ctaMode) return null;
    if (ctaPromise) return ctaPromise;
    var url = '/_dop/cta?page=' + encodeURIComponent(pageId || '') + '&video=' + encodeURIComponent(videoId || '') +
      (ctaPreview ? '&preview=' + ctaPreview : '');
    var asked = fetch(url, { credentials: 'same-origin', signal: timeoutSignal(CTA_TIMEOUT) })
      .then(function (res) { return res.status === 200 ? res.json() : null; })
      .then(function (d) {
        return d && typeof d.html === 'string' && /^[0-9a-f-]{36}$/.test(d.cta_id || '') ? { id: d.cta_id, html: d.html } : null;
      })
      .catch(function () { return null; });
    var late = new Promise(function (done) { setTimeout(function () { done(null); }, CTA_TIMEOUT); });
    ctaPromise = Promise.race([asked, late]).then(function (c) {
      if (c && ctaShow(c.html, c.id, hidden)) {
        ctaPending = ctaPreview ? null : c.id;
      } else if (!c && !ctaPreview) {
        var t = document.querySelector('template[data-dop-cta-reserve]');
        if (t) ctaShow(t.innerHTML, null, hidden);
      }
      return c;
    });
    return ctaPromise;
  }
  // A returning visitor (&cta=2) or the test link (&cta=3): the CTA at once, as soon as the player is in the page.
  function ctaAtOnce() {
    var c = ctaFetch(false);
    if (c) c.then(ctaReveal);
  }
  if (ctaMode === 2 || ctaMode === 3) {
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', ctaAtOnce);
    else ctaAtOnce();
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
  // ---- vendor upsells: the buyer's answer to each offer (see the header) ----
  if (/^vendor_up[1-5]$/.test(origin)) {
    var srcQuery = (function () { try { return new URL(mySrc, window.location.href).searchParams; } catch (e) { return null; } })();
    var upOffer = (srcQuery && srcQuery.get('o')) || '';
    var upDownsells = srcQuery && srcQuery.get('ds') ? srcQuery.get('ds').split(',') : [];
    // what the server served this buyer: group|flow|page version — dot keeps it in the event's metadata
    var upServed = srcQuery && srcQuery.get('u') ? srcQuery.get('u').split('|') : [];
    var NO_THANKS = /\bno[\s,.!-]*thanks?\b|\bno thank you\b|\bi'?ll pass\b|\bnot interested\b/i;
    var answered = {};
    // The offer a button answers: its own data-pag-offer, else the nearest block (below <body>) that has one.
    var offerOf = function (el) {
      if (el.getAttribute('data-pag-offer')) return el.getAttribute('data-pag-offer');
      for (var n = el.parentNode; n && n !== document.body && n.querySelector; n = n.parentNode) {
        var o = n.querySelector('[data-pag-offer]');
        if (o) return o.getAttribute('data-pag-offer') || '';
      }
      return '';
    };
    var answer = function (kind, code) {
      if (answered[kind + '|' + code]) return;
      answered[kind + '|' + code] = true;
      var slot = code && code !== upOffer ? upDownsells.indexOf(code) : -1;
      var p = buildPayload((slot >= 0 ? 'downsell_' : 'upsell_') + kind, { product_option: code || null },
        upServed.length === 3 ? { upsell: { s: origin.slice(7), g: upServed[0], fl: upServed[1], p: upServed[2], ds: slot >= 0 ? slot + 1 : null } } : null);
      if (slot >= 0) p.origin = origin + '_ds' + (slot + 1);
      sendSync(p);
    };
    document.addEventListener('click', function (ev) {
      if (!ev.isTrusted) return;
      var path = ev.composedPath ? ev.composedPath() : [ev.target];
      for (var i = 0; i < path.length; i++) {
        var n = path[i];
        if (!n || n.nodeType !== 1 || !n.getAttribute) continue;
        if (n.hasAttribute('data-pag-no') || n.hasAttribute('data-dop-decline')
            || ((n.tagName === 'BUTTON' || n.tagName === 'A') && !n.hasAttribute('data-pag-yes') && NO_THANKS.test(n.textContent || ''))) {
          answer('decline', offerOf(n));
          return;
        }
        if (n.hasAttribute('data-pag-yes') || n.hasAttribute('data-dop-accept') || n.hasAttribute('data-pag-offer')) {
          answer('accept', offerOf(n));
          return;
        }
      }
    }, true);
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

/** The disable-devtool library (theajack/disable-devtool), served first-party. */
const TRACKER_DD_JS = <<<'JS'
!function(e,t){"object"==typeof exports&&"undefined"!=typeof module?module.exports=t():"function"==typeof define&&define.amd?define(t):(e="undefined"!=typeof globalThis?globalThis:e||self).DisableDevtool=t()}(this,function(){"use strict";function i(e){return(i="function"==typeof Symbol&&"symbol"==typeof Symbol.iterator?function(e){return typeof e}:function(e){return e&&"function"==typeof Symbol&&e.constructor===Symbol&&e!==Symbol.prototype?"symbol":typeof e})(e)}function o(e,t){if(!(e instanceof t))throw new TypeError("Cannot call a class as a function")}function r(e,t){for(var n=0;n<t.length;n++){var o=t[n];o.enumerable=o.enumerable||!1,o.configurable=!0,"value"in o&&(o.writable=!0),Object.defineProperty(e,o.key,o)}}function u(e,t,n){t&&r(e.prototype,t),n&&r(e,n),Object.defineProperty(e,"prototype",{writable:!1})}function e(e,t,n){t in e?Object.defineProperty(e,t,{value:n,enumerable:!0,configurable:!0,writable:!0}):e[t]=n}function c(e,t){if("function"!=typeof t&&null!==t)throw new TypeError("Super expression must either be null or a function");e.prototype=Object.create(t&&t.prototype,{constructor:{value:e,writable:!0,configurable:!0}}),Object.defineProperty(e,"prototype",{writable:!1}),t&&n(e,t)}function a(e){return(a=Object.setPrototypeOf?Object.getPrototypeOf.bind():function(e){return e.__proto__||Object.getPrototypeOf(e)})(e)}function n(e,t){return(n=Object.setPrototypeOf?Object.setPrototypeOf.bind():function(e,t){return e.__proto__=t,e})(e,t)}function U(e,t){if(t&&("object"==typeof t||"function"==typeof t))return t;if(void 0!==t)throw new TypeError("Derived constructors may only return object or undefined");t=e;if(void 0===t)throw new ReferenceError("this hasn't been initialised - super() hasn't been called");return t}function l(n){var o=function(){if("undefined"==typeof Reflect||!Reflect.construct)return!1;if(Reflect.construct.sham)return!1;if("function"==typeof Proxy)return!0;try{return Boolean.prototype.valueOf.call(Reflect.construct(Boolean,[],function(){})),!0}catch(e){return!1}}();return function(){var e,t=a(n);return U(this,o?(e=a(this).constructor,Reflect.construct(t,arguments,e)):t.apply(this,arguments))}}function f(e,t){(null==t||t>e.length)&&(t=e.length);for(var n=0,o=new Array(t);n<t;n++)o[n]=e[n];return o}function s(e,t){var n,o="undefined"!=typeof Symbol&&e[Symbol.iterator]||e["@@iterator"];if(!o){if(Array.isArray(e)||(o=function(e,t){if(e){if("string"==typeof e)return f(e,t);var n=Object.prototype.toString.call(e).slice(8,-1);return"Map"===(n="Object"===n&&e.constructor?e.constructor.name:n)||"Set"===n?Array.from(e):"Arguments"===n||/^(?:Ui|I)nt(?:8|16|32)(?:Clamped)?Array$/.test(n)?f(e,t):void 0}}(e))||t&&e&&"number"==typeof e.length)return o&&(e=o),n=0,{s:t=function(){},n:function(){return n>=e.length?{done:!0}:{done:!1,value:e[n++]}},e:function(e){throw e},f:t};throw new TypeError("Invalid attempt to iterate non-iterable instance.\nIn order to be iterable, non-array objects must have a [Symbol.iterator]() method.")}var i,r=!0,u=!1;return{s:function(){o=o.call(e)},n:function(){var e=o.next();return r=e.done,e},e:function(e){u=!0,i=e},f:function(){try{r||null==o.return||o.return()}finally{if(u)throw i}}}}function t(){if(d.url)window.location.href=d.url;else if(d.rewriteHTML)try{document.documentElement.innerHTML=d.rewriteHTML}catch(e){document.documentElement.innerText=d.rewriteHTML}else{try{window.opener=null,window.open("","_self"),window.close(),window.history.back()}catch(e){console.log(e)}setTimeout(function(){window.location.href=d.timeOutUrl||"https://theajack.github.io/disable-devtool/404.html?h=".concat(encodeURIComponent(location.host))},500)}}var d={md5:"",ondevtoolopen:t,ondevtoolclose:null,url:"",timeOutUrl:"",tkName:"ddtk",interval:500,disableMenu:!0,stopIntervalTime:5e3,clearIntervalWhenDevOpenTrigger:!1,detectors:[1,3,4,5,6,7],clearLog:!0,disableSelect:!1,disableInputSelect:!1,disableCopy:!1,disableCut:!1,disablePaste:!1,ignore:null,disableIframeParents:!0,seo:!0,rewriteHTML:""},H=["detectors","ondevtoolclose","ignore"];function q(e){var t,n=0<arguments.length&&void 0!==e?e:{};for(t in n.onDevtoolOpen&&(n.ondevtoolopen=n.onDevtoolOpen),n.onDevtoolClose&&(n.ondevtoolclose=n.onDevtoolClose),d){var o=t;void 0===n[o]||i(d[o])!==i(n[o])&&-1===H.indexOf(o)||(d[o]=n[o])}"function"==typeof d.ondevtoolclose&&!0===d.clearIntervalWhenDevOpenTrigger&&(d.clearIntervalWhenDevOpenTrigger=!1,console.warn("【DISABLE-DEVTOOL】clearIntervalWhenDevOpenTrigger 在使用 ondevtoolclose 时无效"))}function v(){return(new Date).getTime()}function h(e){var t=v();return e(),v()-t}function z(n,o){function e(t){return function(){n&&n();var e=t.apply(void 0,arguments);return o&&o(),e}}var t=window.alert,i=window.confirm,r=window.prompt;try{window.alert=e(t),window.confirm=e(i),window.prompt=e(r)}catch(e){}}var p,y,B,b={iframe:!1,pc:!1,qqBrowser:!1,firefox:!1,macos:!1,edge:!1,oldEdge:!1,ie:!1,iosChrome:!1,iosEdge:!1,chrome:!1,seoBot:!1,mobile:!1};function W(){function e(e){return-1!==t.indexOf(e)}var t=navigator.userAgent.toLowerCase(),n=function(){var e=navigator,t=e.platform,e=e.maxTouchPoints;if("number"==typeof e)return 1<e;if("string"==typeof t){e=t.toLowerCase();if(/(mac|win)/i.test(e))return!1;if(/(android|iphone|ipad|ipod|arch)/i.test(e))return!0}return/(iphone|ipad|ipod|ios|android)/i.test(navigator.userAgent.toLowerCase())}(),o=!!window.top&&window!==window.top,i=!n,r=e("qqbrowser"),u=e("firefox"),c=e("macintosh"),a=e("edge"),l=a&&!e("chrome"),f=l||e("trident")||e("msie"),s=e("crios"),d=e("edgios"),v=e("chrome")||s,h=!n&&/(googlebot|baiduspider|bingbot|applebot|petalbot|yandexbot|bytespider|chrome\-lighthouse|moto g power)/i.test(t);Object.assign(b,{iframe:o,pc:i,qqBrowser:r,firefox:u,macos:c,edge:a,oldEdge:l,ie:f,iosChrome:s,iosEdge:d,chrome:v,seoBot:h,mobile:n})}function M(){for(var e=function(){for(var e={},t=0;t<500;t++)e["".concat(t)]="".concat(t);return e}(),t=[],n=0;n<50;n++)t.push(e);return t}function g(){d.clearLog&&B()}var K="",V=!1;function N(){var e=d.ignore;if(e){if("function"==typeof e)return e();if(0!==e.length){var t=location.href;if(K===t)return V;K=t;var n,o=!1,i=s(e);try{for(i.s();!(n=i.n()).done;){var r=n.value;if("string"==typeof r){if(-1!==t.indexOf(r)){o=!0;break}}else if(r.test(t)){o=!0;break}}}catch(e){i.e(e)}finally{i.f()}return V=o}}}var X=function(){return!1};function w(n){var t,e,o=74,i=73,r=85,u=83,c=123,a=b.macos?function(e,t){return e.metaKey&&e.altKey&&(t===i||t===o)}:function(e,t){return e.ctrlKey&&e.shiftKey&&(t===i||t===o)},l=b.macos?function(e,t){return e.metaKey&&e.altKey&&t===r||e.metaKey&&t===u}:function(e,t){return e.ctrlKey&&(t===u||t===r)};n.addEventListener("keydown",function(e){var t=(e=e||n.event).keyCode||e.which;if(t===c||a(e,t)||l(e,t))return T(n,e)},!0),t=n,d.disableMenu&&t.addEventListener("contextmenu",function(e){if("touch"!==e.pointerType)return T(t,e)}),e=n,(d.disableSelect||d.disableInputSelect)&&m(e,"selectstart"),e=n,d.disableCopy&&m(e,"copy"),e=n,d.disableCut&&m(e,"cut"),e=n,d.disablePaste&&m(e,"paste")}function m(o,e){o.addEventListener(e,function(e){if(!(t=e.target)||"INPUT"!==t.tagName&&"TEXTAREA"!==t.tagName&&"true"!==(null==(n=t.getAttribute)?void 0:n.call(t,"contenteditable"))){if(d.disableSelect)return T(o,e)}else if(d.disableInputSelect)return T(o,e);var t,n})}function T(e,t){if(!N()&&!X())return(t=t||e.event).returnValue=!1,t.preventDefault(),!1}var O,D=!1,S={};function F(e){S[e]=!1}function $(){for(var e in S)if(S[e])return D=!0;return D=!1}(A=O=O||{})[A.Unknown=-1]="Unknown",A[A.RegToString=0]="RegToString",A[A.DefineId=1]="DefineId",A[A.Size=2]="Size",A[A.DateToString=3]="DateToString",A[A.FuncToString=4]="FuncToString",A[A.Debugger=5]="Debugger",A[A.Performance=6]="Performance",A[A.DebugLib=7]="DebugLib";var k=function(){function n(e){var t=e.type,e=e.enabled,e=void 0===e||e;o(this,n),this.type=O.Unknown,this.enabled=!0,this.type=t,this.enabled=e,this.enabled&&(t=this,Q.push(t),this.init())}return u(n,[{key:"onDevToolOpen",value:function(){var e;console.warn("You don't have permission to use DEVTOOL!【type = ".concat(this.type,"】")),d.clearIntervalWhenDevOpenTrigger&&te(),window.clearTimeout(J),d.ondevtoolopen(this.type,t),e=this.type,S[e]=!0}},{key:"init",value:function(){}}]),n}(),G=function(){c(t,k);var e=l(t);function t(){return o(this,t),e.call(this,{type:O.DebugLib})}return u(t,[{key:"init",value:function(){}},{key:"detect",value:function(){var e;(!0===(null==(e=null==(e=window.eruda)?void 0:e._devTools)?void 0:e._isShow)||window._vcOrigConsole&&window.document.querySelector("#__vconsole.vc-toggle"))&&this.onDevToolOpen()}}],[{key:"isUsing",value:function(){return!!window.eruda||!!window._vcOrigConsole}}]),t}(),Y=0,J=0,Q=[],Z=0;function ee(i){function e(){l=!0}function t(){l=!1}var n,o,r,u,c,a,l=!1;function f(){(a[u]===r?o:n)()}z(e,t),n=t,o=e,void 0!==(a=document).hidden?(r="hidden",c="visibilitychange",u="visibilityState"):void 0!==a.mozHidden?(r="mozHidden",c="mozvisibilitychange",u="mozVisibilityState"):void 0!==a.msHidden?(r="msHidden",c="msvisibilitychange",u="msVisibilityState"):void 0!==a.webkitHidden&&(r="webkitHidden",c="webkitvisibilitychange",u="webkitVisibilityState"),a.removeEventListener(c,f,!1),a.addEventListener(c,f,!1),Y=window.setInterval(function(){if(!(i.isSuspend||l||N())){var e,t,n=s(Q);try{for(n.s();!(e=n.n()).done;){var o=e.value;F(o.type),o.detect(Z++)}}catch(e){n.e(e)}finally{n.f()}g(),"function"==typeof d.ondevtoolclose&&(t=D,!$()&&t&&d.ondevtoolclose())}},d.interval),J=setTimeout(function(){b.pc||G.isUsing()||te()},d.stopIntervalTime)}function te(){window.clearInterval(Y)}var P=8;function ne(e){for(var t=function(e,t){e[t>>5]|=128<<t%32,e[14+(t+64>>>9<<4)]=t;for(var n=1732584193,o=-271733879,i=-1732584194,r=271733878,u=0;u<e.length;u+=16){var c=n,a=o,l=i,f=r;n=E(n,o,i,r,e[u+0],7,-680876936),r=E(r,n,o,i,e[u+1],12,-389564586),i=E(i,r,n,o,e[u+2],17,606105819),o=E(o,i,r,n,e[u+3],22,-1044525330),n=E(n,o,i,r,e[u+4],7,-176418897),r=E(r,n,o,i,e[u+5],12,1200080426),i=E(i,r,n,o,e[u+6],17,-1473231341),o=E(o,i,r,n,e[u+7],22,-45705983),n=E(n,o,i,r,e[u+8],7,1770035416),r=E(r,n,o,i,e[u+9],12,-1958414417),i=E(i,r,n,o,e[u+10],17,-42063),o=E(o,i,r,n,e[u+11],22,-1990404162),n=E(n,o,i,r,e[u+12],7,1804603682),r=E(r,n,o,i,e[u+13],12,-40341101),i=E(i,r,n,o,e[u+14],17,-1502002290),o=E(o,i,r,n,e[u+15],22,1236535329),n=I(n,o,i,r,e[u+1],5,-165796510),r=I(r,n,o,i,e[u+6],9,-1069501632),i=I(i,r,n,o,e[u+11],14,643717713),o=I(o,i,r,n,e[u+0],20,-373897302),n=I(n,o,i,r,e[u+5],5,-701558691),r=I(r,n,o,i,e[u+10],9,38016083),i=I(i,r,n,o,e[u+15],14,-660478335),o=I(o,i,r,n,e[u+4],20,-405537848),n=I(n,o,i,r,e[u+9],5,568446438),r=I(r,n,o,i,e[u+14],9,-1019803690),i=I(i,r,n,o,e[u+3],14,-187363961),o=I(o,i,r,n,e[u+8],20,1163531501),n=I(n,o,i,r,e[u+13],5,-1444681467),r=I(r,n,o,i,e[u+2],9,-51403784),i=I(i,r,n,o,e[u+7],14,1735328473),o=I(o,i,r,n,e[u+12],20,-1926607734),n=j(n,o,i,r,e[u+5],4,-378558),r=j(r,n,o,i,e[u+8],11,-2022574463),i=j(i,r,n,o,e[u+11],16,1839030562),o=j(o,i,r,n,e[u+14],23,-35309556),n=j(n,o,i,r,e[u+1],4,-1530992060),r=j(r,n,o,i,e[u+4],11,1272893353),i=j(i,r,n,o,e[u+7],16,-155497632),o=j(o,i,r,n,e[u+10],23,-1094730640),n=j(n,o,i,r,e[u+13],4,681279174),r=j(r,n,o,i,e[u+0],11,-358537222),i=j(i,r,n,o,e[u+3],16,-722521979),o=j(o,i,r,n,e[u+6],23,76029189),n=j(n,o,i,r,e[u+9],4,-640364487),r=j(r,n,o,i,e[u+12],11,-421815835),i=j(i,r,n,o,e[u+15],16,530742520),o=j(o,i,r,n,e[u+2],23,-995338651),n=L(n,o,i,r,e[u+0],6,-198630844),r=L(r,n,o,i,e[u+7],10,1126891415),i=L(i,r,n,o,e[u+14],15,-1416354905),o=L(o,i,r,n,e[u+5],21,-57434055),n=L(n,o,i,r,e[u+12],6,1700485571),r=L(r,n,o,i,e[u+3],10,-1894986606),i=L(i,r,n,o,e[u+10],15,-1051523),o=L(o,i,r,n,e[u+1],21,-2054922799),n=L(n,o,i,r,e[u+8],6,1873313359),r=L(r,n,o,i,e[u+15],10,-30611744),i=L(i,r,n,o,e[u+6],15,-1560198380),o=L(o,i,r,n,e[u+13],21,1309151649),n=L(n,o,i,r,e[u+4],6,-145523070),r=L(r,n,o,i,e[u+11],10,-1120210379),i=L(i,r,n,o,e[u+2],15,718787259),o=L(o,i,r,n,e[u+9],21,-343485551),n=C(n,c),o=C(o,a),i=C(i,l),r=C(r,f)}return Array(n,o,i,r)}(function(e){for(var t=Array(),n=(1<<P)-1,o=0;o<e.length*P;o+=P)t[o>>5]|=(e.charCodeAt(o/P)&n)<<o%32;return t}(e),e.length*P),n="0123456789abcdef",o="",i=0;i<4*t.length;i++)o+=n.charAt(t[i>>2]>>i%4*8+4&15)+n.charAt(t[i>>2]>>i%4*8&15);return o}function x(e,t,n,o,i,r){return C((t=C(C(t,e),C(o,r)))<<i|t>>>32-i,n)}function E(e,t,n,o,i,r,u){return x(t&n|~t&o,e,t,i,r,u)}function I(e,t,n,o,i,r,u){return x(t&o|n&~o,e,t,i,r,u)}function j(e,t,n,o,i,r,u){return x(t^n^o,e,t,i,r,u)}function L(e,t,n,o,i,r,u){return x(n^(t|~o),e,t,i,r,u)}function C(e,t){var n=(65535&e)+(65535&t);return(e>>16)+(t>>16)+(n>>16)<<16|65535&n}var A=function(){c(t,k);var e=l(t);function t(){return o(this,t),e.call(this,{type:O.RegToString,enabled:b.qqBrowser||b.firefox})}return u(t,[{key:"init",value:function(){var t=this;this.lastTime=0,this.reg=/./,p(this.reg),this.reg.toString=function(){var e;return b.qqBrowser?(e=(new Date).getTime(),t.lastTime&&e-t.lastTime<100?t.onDevToolOpen():t.lastTime=e):b.firefox&&t.onDevToolOpen(),""}}},{key:"detect",value:function(){p(this.reg)}}]),t}(),oe=function(){c(t,k);var e=l(t);function t(){return o(this,t),e.call(this,{type:O.DefineId})}return u(t,[{key:"init",value:function(){var e=this;this.div=document.createElement("div"),this.div.__defineGetter__("id",function(){e.onDevToolOpen()}),Object.defineProperty(this.div,"id",{get:function(){e.onDevToolOpen()}})}},{key:"detect",value:function(){p(this.div)}}]),t}(),ie=function(){c(t,k);var e=l(t);function t(){return o(this,t),e.call(this,{type:O.Size,enabled:!b.iframe&&!b.edge})}return u(t,[{key:"init",value:function(){var e=this;this.checkWindowSizeUneven(),window.addEventListener("resize",function(){setTimeout(function(){e.checkWindowSizeUneven()},100)},!0)}},{key:"detect",value:function(){}},{key:"checkWindowSizeUneven",value:function(){var e=function(){if(re(window.devicePixelRatio))return window.devicePixelRatio;var e=window.screen;return!!(re(e)&&e.deviceXDPI&&e.logicalXDPI)&&e.deviceXDPI/e.logicalXDPI}();if(!1!==e){var t=200<window.outerWidth-window.innerWidth*e,e=300<window.outerHeight-window.innerHeight*e;if(t||e)return this.onDevToolOpen(),!1;F(this.type)}return!0}}]),t}();function re(e){return null!=e}var _,ue=function(){c(t,k);var e=l(t);function t(){return o(this,t),e.call(this,{type:O.DateToString,enabled:!b.iosChrome&&!b.iosEdge})}return u(t,[{key:"init",value:function(){var e=this;this.count=0,this.date=new Date,this.date.toString=function(){return e.count++,""}}},{key:"detect",value:function(){this.count=0,p(this.date),g(),2<=this.count&&this.onDevToolOpen()}}]),t}(),ce=function(){c(t,k);var e=l(t);function t(){return o(this,t),e.call(this,{type:O.FuncToString,enabled:!b.iosChrome&&!b.iosEdge})}return u(t,[{key:"init",value:function(){var e=this;this.count=0,this.func=function(){},this.func.toString=function(){return e.count++,""}}},{key:"detect",value:function(){this.count=0,p(this.func),g(),2<=this.count&&this.onDevToolOpen()}}]),t}(),ae=function(){c(t,k);var e=l(t);function t(){return o(this,t),e.call(this,{type:O.Debugger,enabled:b.iosChrome||b.iosEdge})}return u(t,[{key:"detect",value:function(){var e=v();100<v()-e&&this.onDevToolOpen()}}]),t}(),le=function(){c(n,k);var t=l(n);function n(){var e;return o(this,n),(e=t.call(this,{type:O.Performance,enabled:b.chrome||!b.mobile})).count=0,e}return u(n,[{key:"init",value:function(){this.maxPrintTime=0,this.largeObjectArray=M()}},{key:"detect",value:function(){var e=this,t=h(function(){y(e.largeObjectArray)}),n=h(function(){p(e.largeObjectArray)});if(this.maxPrintTime=Math.max(this.maxPrintTime,n),g(),0===t||0===this.maxPrintTime)return!1;t>10*this.maxPrintTime&&(2<=this.count?this.onDevToolOpen():(this.count++,this.detect()))}}]),n}(),fe=(e(_={},O.RegToString,A),e(_,O.DefineId,oe),e(_,O.Size,ie),e(_,O.DateToString,ue),e(_,O.FuncToString,ce),e(_,O.Debugger,ae),e(_,O.Performance,le),e(_,O.DebugLib,G),_);var R=Object.assign(function(e){function t(){var e=0<arguments.length&&void 0!==arguments[0]?arguments[0]:"";return{success:!e,reason:e}}var n;if(R.isRunning)return t("already running");if(W(),n=window.console||{log:function(){},table:function(){},clear:function(){}},B=b.ie?(p=function(){return n.log.apply(n,arguments)},y=function(){return n.table.apply(n,arguments)},function(){return n.clear()}):(p=n.log,y=n.table,n.clear),q(e),d.md5&&ne(function(e){var t=window.location.search,n=window.location.hash;if(""!==(t=""===t&&""!==n?"?".concat(n.split("?")[1]):t)&&void 0!==t){n=new RegExp("(^|&)"+e+"=([^&]*)(&|$)","i"),e=t.substr(1).match(n);if(null!=e)return unescape(e[2])}return""}(d.tkName))===d.md5)return t("token passed");if(d.seo&&b.seoBot)return t("seobot");R.isRunning=!0,ee(R);var o=R,i=(X=function(){return o.isSuspend},window.top),r=window.parent;if(w(window),d.disableIframeParents&&i&&r&&i!==window){for(;r!==i;)w(r),r=r.parent;w(i)}return("all"===d.detectors?Object.keys(fe):d.detectors).forEach(function(e){new fe[e]}),t()},{isRunning:!1,isSuspend:!1,md5:ne,version:"0.3.9",DetectorType:O,isDevToolOpened:$});A=function(){if("undefined"==typeof window||!window.document)return null;var n=document.querySelector("[disable-devtool-auto]");if(!n)return null;var o=["disable-menu","disable-select","disable-copy","disable-cut","disable-paste","clear-log"],i=["interval"],r={};return["md5","url","tk-name","detectors"].concat(o,i).forEach(function(e){var t=n.getAttribute(e);null!==t&&(-1!==i.indexOf(e)?t=parseInt(t):-1!==o.indexOf(e)?t="false"!==t:"detector"===e&&"all"!==t&&(t=t.split(" ")),r[function(e){if(-1===e.indexOf("-"))return e;var t=!1;return e.split("").map(function(e){return"-"===e?(t=!0,""):t?(t=!1,e.toUpperCase()):e}).join("")}(e)]=t)}),r}();return A&&R(A),R});

JS;

/** Served path → source. */
const TRACKER_FILES = [
    TRACKER_PATH => TRACKER_DOT_JS,
    '/_dop/dd.js' => TRACKER_DD_JS,
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
