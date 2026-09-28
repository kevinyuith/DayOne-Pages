/**
 * VTurb players in the editor. The canvas runs without scripts (the page stays
 * inert while it's edited) and VTurb's player is all script, so its
 * `<vturb-smartplayer>` is an empty element, 0px tall: the video isn't there.
 * The editor draws it the way VTurb does before the video loads — a 16:9 box
 * with the video's cover and a play button — with CSS of its own (the canvas'
 * editor style, dropped when saving; the Preview's, never saved): the page's
 * HTML doesn't change.
 *
 * The cover is VTurb's `cover.jpg` of the player's video, under the account in
 * the page's player script (scripts.converteai.net/<account>/players/…). A
 * player whose id has `{{video_id}}` — the server draws the video per visitor
 * from the funnel's VSLs tab — shows `standIn` (on a funnel page: the video with
 * the largest share); an A/B test player (ab-<id>) or one with no known video
 * gets the box without a cover.
 */

/** The video that stands in for `{{video_id}}`. */
export type VturbStandIn = { id: string; name: string };

const ACCOUNT_RE = /scripts\.converteai\.net\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/(?:players|ab-test)\//i;
const VIDEO_RE = /^[0-9a-f]{24}$/;
const PLACEHOLDER_RE = /\{\{\s*video_id\s*\}\}/;

const PLAY_ICON = `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24'%3E%3Cpath fill='white' d='M8 5v14l11-7z'/%3E%3C/svg%3E")`;

/** A CSS string literal. */
const cssString = (s: string) => `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\a ")}"`;

/** The VTurb account of the page's player scripts, or null. */
export function vturbAccount(html: string): string | null {
  return html.match(ACCOUNT_RE)?.[1].toLowerCase() ?? null;
}

export function vturbCoverUrl(account: string, video: string): string {
  return `https://images.converteai.net/${account}/players/${video}/cover.jpg`;
}

/** The box, play button and label, for the players `sel` matches. */
function baseCss(sel: string): string {
  return [
    `${sel}{display:block;position:relative;aspect-ratio:16/9;background:#111 center/cover no-repeat;overflow:hidden}`,
    `${sel}::before{content:"";position:absolute;top:50%;left:50%;width:72px;height:72px;transform:translate(-50%,-50%);border-radius:50%;` +
      `background:rgba(0,0,0,.55) ${PLAY_ICON} 56% 50%/32px no-repeat;box-shadow:0 0 0 3px rgba(255,255,255,.9)}`,
    `${sel}::after{content:attr(id);position:absolute;left:8px;bottom:8px;max-width:calc(100% - 16px);overflow:hidden;white-space:nowrap;` +
      `text-overflow:ellipsis;padding:2px 8px;border-radius:4px;background:rgba(0,0,0,.65);color:#fff;font:500 11px/1.5 system-ui,-apple-system,sans-serif}`,
  ].join("");
}

/** Cover and label of one player, by its id. */
function playerCss(id: string, account: string | null, standIn: VturbStandIn | null): string {
  const sel = `vturb-smartplayer[id=${cssString(id)}]`;
  const own = id.startsWith("vid-") ? id.slice(4) : "";
  let video: string | null = null;
  let label: string;
  if (VIDEO_RE.test(own)) {
    video = own;
    label = `VTurb · ${own}`;
  } else if (PLACEHOLDER_RE.test(id)) {
    video = standIn?.id ?? null;
    label = standIn ? `{{video_id}} · ${standIn.name || standIn.id}` : "{{video_id}}";
  } else {
    label = id.startsWith("ab-") ? `VTurb A/B test · ${id.slice(3)}` : `VTurb · ${id || "no id"}`;
  }
  const cover = video && account ? `background-image:url(${cssString(vturbCoverUrl(account, video))})` : "";
  return `${cover ? `${sel}{${cover}}` : ""}${sel}::after{content:${cssString(label)}}`;
}

/**
 * The canvas: every player in the document, drawn (it never plays there).
 * Goes into the canvas' editor style (injectCanvasChrome).
 */
export function vturbCanvasCss(doc: Document, standIn: VturbStandIn | null): string {
  const ids = Array.from(doc.querySelectorAll("vturb-smartplayer"), (el) => el.id);
  if (ids.length === 0) return "";
  const account = vturbAccount(doc.documentElement.outerHTML);
  return baseCss("vturb-smartplayer") + [...new Set(ids)].map((id) => playerCss(id, account, standIn)).join("");
}

/**
 * The Preview runs the page's scripts, so a player with a real video plays. One
 * whose video is `{{video_id}}` (the server fills it, the preview doesn't) —
 * or empty, if a preview replaced it with nothing — would stay 0px tall: it gets
 * the same drawing, in a style added before `</head>`.
 */
export function withVturbPreview(html: string, standIn: VturbStandIn | null): string {
  const ids = Array.from(html.matchAll(/<vturb-smartplayer\b[^>]*\bid\s*=\s*"([^"]*)"/gi), (m) => m[1]).filter(
    (id) => PLACEHOLDER_RE.test(id) || id === "vid-",
  );
  if (ids.length === 0) return html;
  const account = vturbAccount(html);
  const css = baseCss(`vturb-smartplayer:is(${[...new Set(ids)].map((id) => `[id=${cssString(id)}]`).join(",")})`) +
    [...new Set(ids)].map((id) => playerCss(id, account, standIn)).join("");
  const style = `<style>${css}</style>`;
  const at = html.search(/<\/head\s*>/i);
  return at >= 0 ? html.slice(0, at) + style + html.slice(at) : style + html;
}
