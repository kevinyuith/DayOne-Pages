# DayOne Pages — delivery server

A PHP front controller that answers for **any domain** pointed at this
machine: it asks Supabase (schema `pages`) what that host + path should
return, caches it on disk for 30 seconds and serves it. If Supabase goes down,
it serves the copy it has.

No framework, no composer. Requirements: PHP 8.2+ with `curl` and `json`.

## How it works

```
Cloudflare ──HTTP:80──► nginx (catch-all) ──► php-fpm ──► public/index.php
                                                              │
                                             cache/routes/<host>/<path>.php   (routes + content hash, TTL 30 s)
                                             cache/content/<hash>.php         (HTML by its sha256)
                                                              │ MISS
                                             POST {SUPABASE_URL}/rest/v1/rpc/resolve      (hashes only; Content-Profile: pages)
                                             POST {SUPABASE_URL}/rest/v1/rpc/content_get  (only the HTML missing on disk)
```

Content is addressed by hash (sha256 of the HTML, computed by the database in
`pages.pages.slugs`): a hash never changes content, so the file on disk never
needs to be invalidated. Every 30 s the server only rechecks the decision
(which pages, conditions, draw) — a few bytes, no HTML — and only downloads
HTML when a new hash shows up (edited page). With `SWR=1` (the default) and php-fpm, the recheck happens after the
response: the visitor gets the stored copy and never waits for Supabase.
Content that no route has used for `STALE_MAX_AGE` + 1 day goes in the cleanup.

| Situation | Response | `X-Cache` |
|---|---|---|
| fresh cache | serves | `HIT` |
| cache expired or missing, Supabase ok | queries, rewrites, serves | `MISS` |
| Supabase down, expired copy exists | serves the copy (up to `STALE_MAX_AGE`) | `STALE` |
| Supabase down, no copy | 503 + `Retry-After` | — |
| another worker refreshing | serves the expired copy | `UPDATING` |
| unknown domain | 404 (negative cache `NEGATIVE_TTL`) | `MISS`/`HIT` |

The domain's routes are evaluated in priority order; the first whose
conditions (country, device, language, URL parameters, referrer) match
decides: serve a slug, redirect or block. `bot` is only honored on block
routes.

### Server-mode funnel (`dop_step`)

A slug with sub-pages (presell → main → back redirect, see the root README)
can be saved with `<body data-dop-funnel="server">`. Then the slug's HTML goes
into the cache as is (all sections), but **in the response** the server
(`src/funnel.php`) delivers only the current step:

- step = the `dop_step=<id>` cookie if it points to an active section that exists;
  otherwise the Pre Lander if it is active, else the Lander (the fixed funnel rule);
- the other `<section data-dop-page>` are removed from the HTML; the served one
  loses `hidden`; the `<body>` gets `data-dop-cur/-next/-start/-main/-br/-br-trigger`
  so the page runtime knows where to go;
- the runtime moves forward by setting `dop_step` (`Path` = the slug's path, 1 day) and
  reloading the same URL. The URL never changes and the source of one step
  doesn't contain the others.

The `ETag` becomes `"<hash>-<step>"` and the response carries `Vary: Cookie`. The HTML
always comes from the origin (Cloudflare doesn't cache HTML by default); if HTML
caching is ever turned on, a server-mode funnel requires *Bypass* on that slug.
Without the attribute (browser mode), none of this runs and the whole HTML goes out.

The cut is done by counting `<section>` in a copy of the HTML with comments,
`<script>`, `<style>` and `<template>` blanked out (same length), so a
`</section>` inside them doesn't count. If even so the server recognizes
no step in a server-mode slug, it serves the whole HTML and
logs it (`server-mode funnel with no recognized step`) — the page keeps
working, in browser mode.

**Deploy order:** the PHP server before the dashboard, so a slug saved in
server mode is already cut by step from the first visit.

### Entry via `www.` (`sub0`)

A page that would be served on `www.x.com` becomes a **302** to the domain
without www, with the original parameters. If the URL carries a campaign — `sub1`,
`utm_campaign` or `campaign`, with a value — it also gets `sub0` = encrypted unix
timestamp (`src/sub0.php`):

```
GET https://www.x.com/offer?utm_campaign=c1
→ 302 Location: https://x.com/offer?utm_campaign=c1&sub0=<token>   (Cache-Control: no-store)
GET https://www.x.com/offer?utm_source=fb&sub1=a&sub2=b
→ 302 Location: https://x.com/offer?utm_source=fb&sub0=<token>&sub1=a&sub2=b   (sub0 right before sub1)
GET https://www.x.com/offer?utm_source=fb
→ 302 Location: https://x.com/offer?utm_source=fb                  (no campaign, no sub0)
```

- Only served pages (200/304). Block, bot, 404, route redirect and
  files (`.js`, `robots.txt`…) go on as normal on the www. itself.
- `sub0` goes right before the first `sub1`; without `sub1`, at the end of the query.
- With a campaign, a `sub0` already in the URL is replaced by the new one; without
  a campaign the query stays intact. The hop is recorded in the Logs as
  `redirect` with decision `REDIRECT · WWW`.
- The nginx vhost must NOT redirect `www` on its own (a
  `server_name ~^www\.…; return 301` block): that answers before PHP and the sub0
  never goes out.
- Token: `base64url(nonce 12 B ‖ ciphertext ‖ tag 16 B)`, AES-256-GCM, key
  `SHA-256(SUB0_KEY)` (default `DAYONE`); plaintext = seconds, e.g.
  `1790000000`. 51 characters. To decrypt in PHP: `sub0_decrypt($token, 'DAYONE')`;
  in Node:

```js
const b = Buffer.from(token, "base64url");
const d = crypto.createDecipheriv("aes-256-gcm", crypto.createHash("sha256").update("DAYONE").digest(), b.subarray(0, 12));
d.setAuthTag(b.subarray(-16));
const ts = Number(d.update(b.subarray(12, -16), undefined, "utf8") + d.final("utf8"));
```

### Load notice (`/_dop/l`)

The hit is stored when the request ARRIVES, so pings, `curl`, prefetch and
link-preview bots also show up as served. To know who actually loaded the
page (`src/beacon.php`):

- a served HTML page (200/304) gets the `dop_v=<32 hex>` cookie (HttpOnly,
  10 min) and, before the last `</body>`, a minimal script that on the `load` event
  calls `sendBeacon("/_dop/l", "t=<ms since navigation start>")`;
- `POST /_dop/l` answers 204 right away and, afterwards, stores the id in
  `pages.hit_loads` (RPC `log_load`); the hit carries the same id in `visit_id`;
- the Logs screen shows **Loaded** (✓ + time), "no" (the browser didn't
  report) or "—" (not applicable: redirect, 404, file, old record).

The script is the same in every response (the id goes in the cookie), so the HTML stays
cacheable and a 304 also carries a new id. The pages' ETag gets `-b2`
(`BEACON_ETAG`): changed the script, bump the version. An automated browser also
runs JavaScript — "loaded" proves a browser rendered the page, not that it was
a person.

### `{{key}}` placeholders (`src/placeholders.php`)

Each domain stores the company data in `pages.domains.placeholders`
(`company.llc` = legal name, `company.number`, `company.address`,
`company.phone`, `company.email`), and `resolve` returns these values (plus
`domain`) on every route. `company.name` is computed: the legal name without the
legal suffix ("Acme Health LLC" → "Acme Health"; list in
`company_name()`, cases in `tests/company-names.json`). On every visit the automatic ones come in: `url`
(`https://domain` + path, no query), `slug` (served path), `lang` and
`language` (first language of Accept-Language; without it, English), `date`
(today in New York, spelled out in that language: "September 23, 2026", "23 de
setembro de 2026"…) and `year`. When serving, `{{key}}` becomes the value.

- only a known key is replaced (inner spaces are fine: `{{ company.phone }}`);
  `{{ any_other }}` stays intact, so a page with Vue/Alpine doesn't break;
- an empty value becomes empty text;
- HTML/XML: value escaped; `text/plain`: raw; CSS/JS/JSON: nothing changes;
- the ETag gets `-p<8 hex>` (hash of the values): it changes per language, per day and
  when a domain field changes (the response already varies by Accept-Language). A route without `placeholders` (older cache,
  old `resolve`) replaces nothing and doesn't touch the ETag.

The panel's field list and the editor preview live in
`src/lib/pages/placeholders.ts`, with the same rules.

## Installation (Ubuntu/Debian)

> **Only for a clean, dedicated VPS.** The files in `deploy/` assume this
> machine hosts nothing else. **Don't apply them on a server with a control panel
> (CloudPanel, Plesk, cPanel) or on one that already answers for domains in production:**
>
> - `deploy/nginx/dayone-pages.conf` declares `default_server` on port 80. If one
>   already exists, nginx refuses to reload; if none exists, this one starts answering
>   for EVERY domain pointed at the IP, and those not registered in the
>   panel become 404.
> - `deploy/cloudflare-allowlist.sh` closes port 80 to everything that isn't
>   Cloudflare. A domain with an `A` record pointing straight at the IP goes offline.
> - The steps below delete `sites-enabled/default`.
>
> On a server with a control panel, create the site through the panel and adapt only its vhost.


```bash
apt install -y nginx php8.3-fpm php8.3-curl
mkdir -p /var/www/dayone-pages /var/cache/dayone-pages /var/log/php
cp -r server /var/www/dayone-pages/
chown -R www-data:www-data /var/cache/dayone-pages /var/log/php

cp server/.env.example /var/www/dayone-pages/server/.env   # fill it in
chown root:www-data /var/www/dayone-pages/server/.env && chmod 640 /var/www/dayone-pages/server/.env
cp server/deploy/php-fpm/dayone-pages.conf /etc/php/8.3/fpm/pool.d/
cp server/deploy/nginx/dayone-pages.conf /etc/nginx/sites-available/
ln -s /etc/nginx/sites-available/dayone-pages.conf /etc/nginx/sites-enabled/
rm -f /etc/nginx/sites-enabled/default

systemctl restart php8.3-fpm
bash server/deploy/cloudflare-allowlist.sh   # firewall for Cloudflare only + real_ip; reloads nginx
curl -si http://127.0.0.1/_health                # 200 + X-DayOne-Pages
```

**Before running `cloudflare-allowlist.sh`:** it enables `ufw`. The script allows
the SSH port (read from `sshd -T`) before enabling it, but keep a second
SSH session open and know where your provider's emergency console is.
After running it, open a NEW SSH session to confirm you can get in, and only then
close the old one. The script was tested against a simulated `ufw`, not on a real
Ubuntu: check the result with `ufw status` the first time.

Suggested cron (root):

```
0 4 * * 0  bash /var/www/dayone-pages/server/deploy/cloudflare-allowlist.sh
0 5 * * *  find /var/cache/dayone-pages -type f -mtime +7 -delete
```

## Server key

The server doesn't get the Supabase service key. It calls the function
`pages.resolve(host, path, key)` with the publishable key plus a key of its own.

```bash
openssl rand -hex 32        # → PAGES_SERVER_KEY in server/.env
```

And in the project's SQL Editor:

```sql
INSERT INTO pages.server_keys (name, key_hash)
VALUES ('origin-1', encode(sha256(convert_to('<the generated key>', 'UTF8')), 'hex'));
```

To revoke: `UPDATE pages.server_keys SET revoked_at = now() WHERE name = 'origin-1';`

## Cloudflare (per domain)

- DNS: `A @ → server IP` (proxy on) and `CNAME www → @` (proxy on).
- SSL/TLS: **Flexible** (the origin is HTTP only). *Always Use HTTPS* on.
- Speed: turn off *Auto Minify* and *Rocket Loader* (they rewrite the HTML and break the ETag).
- WAF/Bot Fight Mode: allow `/_health` (the dashboard queries it to verify the domain).

## Internal endpoints

- `GET /_health` → `{"ok":true,"server_id":...,"cache_writable":true}` with header `X-DayOne-Pages: <SERVER_ID>`. Doesn't depend on Supabase.
- `POST /_purge` with `X-Purge-Token: <PURGE_TOKEN>` and body `{"host":"example.com"}` or `{"all":true}`. Missing/wrong token → 404.

## Local testing

```bash
php server/tests/run.php                              # units: normalization, conditions, cache
cp server/.env.example server/.env                    # fill in SUPABASE_URL, SUPABASE_ANON_KEY, PAGES_SERVER_KEY, SERVER_ID
CACHE_DIR=/tmp/dayone-cache php -S 127.0.0.1:8080 -t server/public server/public/index.php

H='Host: example.com'
curl -si -H "$H" localhost:8080/ | grep -E 'HTTP|X-Cache|ETag'      # MISS
curl -si -H "$H" localhost:8080/ | grep X-Cache                      # HIT
curl -si -H 'Host: nope.example' localhost:8080/ | head -1           # 404
curl -si localhost:8080/_health | grep X-DayOne-Pages
```

`php -S` doesn't have `fastcgi_finish_request`; SWR only kicks in on php-fpm.
