# DayOne Pages

The product's main purpose is to be a **page editor**: you build a page once,
publish it on as many domains as you like, and use the same dashboard to run
**A/B tests** between versions. Modeled on hidepages.com.

- **Dashboard** (this repo, Next.js 16): registers domains (Media Buyer or
  Vendor), creates pages with several slugs (visual editor and code editor
  with a preview) and defines, per domain, the default page, a filter (one
  page for who passes the rules by country, language, device, URL parameters
  and referrer, another for who doesn't) and the bot block.
- **Database**: Supabase, everything in the `pages` schema (`supabase/migrations/`).
- **Delivery server** (`server/`, PHP): answers for any domain pointed at it,
  checks the decision in the database every 30 s (only hashes, no HTML) and
  keeps the HTML on disk by hash, downloading it only when a page changes. If
  Supabase goes down, it serves the copy it has. See [server/README.md](server/README.md).

```
visitor ─► Cloudflare ─HTTP─► nginx + php-fpm (server/) ─► disk cache ─► Supabase (pages.resolve, pages.content_get)
team    ─► dashboard (Next.js, no login) ─► server actions ─service key─► Supabase (pages schema)
```

## Templates screen: cards and folders

`/templates` is a grid of cards modeled on hidepages: the **Create template**
card, the folders and the pages of the open folder. Folders can have subfolders
(no practical limit; the database blocks cycles and more than 20 levels), and
the open folder is kept in the URL (`/templates?folder=<id>`), with a breadcrumb.

- **Move**: drag a card (page or folder) onto a folder or onto a breadcrumb
  item; or "…" menu → *Move to…*. A folder cannot go into itself or into one
  of its subfolders.
- **"…" menu** of a page: open, rename, duplicate (a draft copy with all the
  slugs and the same HTML, with new ids for the funnel sub-pages; the domains'
  copies don't change), move, delete. Of a folder: rename, color, move,
  delete — deleting a folder deletes nothing: its content moves up to the
  parent folder.
- **Search** goes across all folders and shows where each result lives.

In the database: `pages.folders` (`parent_id`, `color`) and `pages.pages.folder_id`
(`supabase/migrations/20260921_folders.sql`). The delivery server does not know
folders exist — they only organize the dashboard.

## Editor: links, panels and funnel

The slug editor (`/templates/[id]/edit?slug=/path`) has an icon bar on the
left with five panels, modeled on hidepages:

- **Pages** — the page's slugs (each one is a URL with its own HTML).
- **Funnel** — this slug's sub-pages (see below): same URL, the switch
  happens in the browser or on the server (selector in the panel).
- **Widgets** — Text, Image, Video, Button, Container, HTML. A click inserts
  after the selected element (or at the end of the current sub-page).
- **Layers** — the current sub-page's tree; a click selects on the canvas.
- **Links** — every link on the page (`<a href>`, `<area>`, `<form action>`
  and the bound ones), grouped by destination, with each one's sub-page. A
  click selects on the canvas; **Change** replaces every occurrence of a
  destination; **Point all links to** sends every link on the page to a
  single destination.

On the canvas, each link gets a **marker** (chip `a` / `form` / `bound`);
clicking it selects the element. The "N links" button in the bottom bar turns
the markers on and off.

**Bind a link to any element.** In the inspector (Settings), the *Link* field
edits the `href` of an `<a>` (or of the `<a>` wrapping the element). For an
element that is not a link (button, image, block), the same field writes
`data-href` (+ `data-target="_blank"` with "Open in new tab"). The
*Destination* selector offers the funnel sub-pages (`#next-step`, `#page:<id>`),
the page's other slugs and a free-form URL.

**Funnel (sub-pages on the same URL).** A slug can hold several sub-pages —
presell → main → back redirect — without changing the URL. They live in the
slug's own HTML, as sibling sections in the body:

```html
<section data-dop-page="p_ab12" data-dop-name="Presell" data-dop-kind="presell" data-dop-start>…</section>
<section data-dop-page="p_cd34" data-dop-name="VSL" data-dop-kind="main" hidden>…</section>
<section data-dop-page="p_ef56" data-dop-name="Stay" data-dop-kind="backredirect" data-dop-trigger="back exit" hidden>…</section>
<script data-dop-runtime>…</script>
```

The **initial** one (`data-dop-start`) is the only one without `hidden` —
without JS, it is the one that shows. The order in the body is the funnel
order: `#next-step` moves to the next one that is not a back redirect. The
**back redirect** shows up when the visitor presses back (`back`) and/or
moves the mouse out of the tab (`exit`). Presells go before the initial one;
back redirects, at the end. When the slug is left with a single sub-page, the
editor unwraps it and it becomes a single page again. The `<head>` (CSS) is
shared — pages cloned from different sites may conflict; prefer prefixed
classes.

**Runtime.** The `<script data-dop-runtime>` at the end of the body only
exists while there is some `data-href` or more than one sub-page, and goes
away on its own when no longer needed. It delegates clicks: `data-href`
navigates (ctrl/cmd/shift or `data-target="_blank"` open a new tab);
`#next-step` / `#page:<id>` switch the sub-page without changing the URL. It
does not run on the canvas (iframe without scripts); it runs in the Preview
and on the server.

**Two switching modes** (the "Step switching" selector in the Funnel panel,
stored in `<body data-dop-funnel>`):

| | In the browser (default) | On the server |
|---|---|---|
| What the visitor gets | the whole HTML, with every step (`hidden`) | only the current step |
| How it switches | JS shows/hides + `history.pushState` | sets the `dop_step=<id>` cookie (Path = the slug) and reloads the same URL |
| Back button | walks through the steps; on the initial one it lands on the back redirect | lands on the back redirect; from there it goes back to the previous step; then leaves |
| Does the presell's source show the main one? | yes | no |
| What has to change | nothing (PHP serves it as is) | PHP cuts the sections in the response (`server/src/funnel.php`) |

In server mode the URL does not change either, and the server answers with a
per-step `ETag` and `Vary: Cookie`; the HTML always comes from the origin
(do not turn on HTML caching in Cloudflare for these slugs). Preview and
canvas show everything in both modes — the cut only happens on the delivery
server.

The Links, Layers and Funnel panels are derived from the current HTML
(`parseHtml`, with the same uids the canvas assigns), so they also work in
Code mode: the change is applied to the HTML and the editor reloads the
canvas.

## Run the dashboard

```bash
cp .env.example .env.local        # fill it in (see below)
npm install
npm run dev                       # http://localhost:3000
```

Variables (`.env.local`):

| Variable | What it is |
|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | Supabase project URL |
| `SUPABASE_SERVICE_KEY` | service key (server only; bypasses RLS) |
| `SERVER_ID` | `/_health` marker; same as `SERVER_ID` in `server/.env` |
| `ORIGIN_URL` | optional; direct URL of the server |
| `ANTHROPIC_API_KEY` | optional; alternative to Kimi for the copy rewrite (Claude), used when there is no Kimi key in Settings |

The Kimi key (copy rewrite in template variations) does **not** go in `.env`:
it lives in the system, under Settings → AI for template variations, stored
encrypted in the Supabase Vault.

**The dashboard has no login.** Anyone with the URL can edit pages and
domains. Protect the deployment at the network level: Cloudflare Access in
front of the host, or an IP allowlist on the reverse proxy.

## Database

Apply the migrations in `supabase/migrations/` in name order on top of the
`pages` schema that already exists in the project (SQL Editor); all of them are
idempotent. `20260921_folders.sql` is required for the templates screen
(without it, `/templates` fails to load the folders). Then register the
delivery server key in `pages.server_keys` (see `server/README.md`).

Never run `supabase db push` / `db reset` against the project: the database is
shared with other systems; this product only touches the `pages` schema.

## Verify

```bash
npm run lint && npm run typecheck && npm run build && npm run check:secrets
php server/tests/run.php
```

`check:secrets` looks for the values of the sensitive variables inside
`.next/static/` after the build and fails if it finds any.

## How the server decides what to serve

1. Normalizes host (`WWW.Example.COM:80` → `example.com`) and path (`//Promo/` → `/promo`).
2. Looks up the `routes/<host>/<path>` cache; if fresh (< 30 s) and with the HTML on disk, serves it. Expired: serves it anyway and refreshes after the response (SWR).
3. Otherwise calls `pages.resolve(host, path, key, p_with_content => false)`: the candidates in order (bot block, filter, default page) with each slug's hash; the HTML of hashes not on disk comes from `pages.content_get`.
4. The first candidate whose conditions match decides: bot block (403), the filter's pass page, or the default page (the fail page when there is a filter). None → 404.
5. Supabase down: serves the expired copy (`X-Cache: STALE`) for up to 7 days; no copy, 503.

Bot detection exists only to **block** (scrapers/crawlers), never to serve
different content.
