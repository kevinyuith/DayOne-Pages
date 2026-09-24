/**
 * The served page's runtime: a small <script>, saved at the end of the body,
 * that exists only while the page needs it. It does two things:
 *
 *  1. ATTACHED LINKS — any element with `data-href` navigates on click
 *     (`data-target="_blank"`, ctrl/cmd/shift open in a new tab). A real <a>
 *     inside it still takes precedence.
 *  2. SUB-PAGES — switches step on a click on `#next-step` / `#page:<id>`
 *     WITHOUT changing the URL, and handles back-redirect (back button) and exit intent.
 *     In two modes, decided by what came from the server:
 *
 *     - BROWSER MODE (default; also preview and static HTML): every section
 *       is in the HTML. Shows the initial one — the Pre Lander if active, otherwise
 *       the Lander; a step with no code is skipped (same rules as `subpages.ts`) —,
 *       hides the others and switches with `hidden` + history.pushState.
 *     - SERVER MODE (`<body data-dop-funnel="server">`, trimmed by the PHP):
 *       ONLY the current step came, and the <body> carries `data-dop-cur`, `-next`,
 *       `-start`, `-main`, `-br`, `-br-trigger`. Switching step = setting the
 *       cookie `dop_step=<id>` (Path = this path) and reloading the same URL; the
 *       server delivers the new step. The source never contains the other steps.
 *
 * It doesn't run in the editor canvas (iframe without allow-scripts); in the preview and on
 * the server, it does. Without JS, the `hidden` saved on the non-initial sub-pages already
 * leaves only the initial one visible (browser mode) — and in server mode the current
 * step comes alone.
 */

import {
  FUNNEL_COOKIE,
  HREF_ATTR,
  PAGE_ATTR,
  PAGE_KIND_ATTR,
  PAGE_TRIGGER_ATTR,
  RUNTIME_ATTR,
  TARGET_ATTR,
} from "./html-editing";

export const NEXT_STEP = "#next-step";
export const PAGE_HREF_PREFIX = "#page:";

export const RUNTIME_JS = [
  "(function(){",
  `var A="${HREF_ATTR}",T="${TARGET_ATTR}",P="${PAGE_ATTR}",K="${PAGE_KIND_ATTR}",G="${PAGE_TRIGGER_ATTR}",NX="${NEXT_STEP}",PP="${PAGE_HREF_PREFIX}",CK="${FUNNEL_COOKIE}";`,
  // history may refuse in odd contexts (srcdoc iframe with no origin); it never takes the rest down.
  'function hs(f,st){try{history[f](st,"")}catch(e){}}',
  "var B=document.body,cur0=B.getAttribute(\"data-dop-cur\"),resolve,open;",
  // Kind (unknown = Lander).
  'function kd(p){var k=p.getAttribute(K);return k==="presell"||k==="backredirect"?k:"main"}',
  "if(cur0){",
  // ---- SERVER MODE: one step per response; switching = cookie + reload.
  'var nx=B.getAttribute("data-dop-next"),brId=B.getAttribute("data-dop-br"),brT=B.getAttribute("data-dop-br-trigger")||"",onBr=cur0===brId,hasBack=!!brId&&brT.indexOf("back")>=0;',
  // np = "don't push history after this reload" (going back from the back redirect to the previous step).
  'var np=false;try{np=sessionStorage.getItem("dop_np")==="1";sessionStorage.removeItem("dop_np")}catch(e){}',
  "function go(id,noPush){if(!id||id===cur0)return;",
  'try{if(noPush)sessionStorage.setItem("dop_np","1")}catch(e){}',
  'document.cookie=CK+"="+id+"; Path="+location.pathname+"; Max-Age=86400; SameSite=Lax";location.reload()}',
  "resolve=function(h){if(!h)return null;if(h===NX)return nx;if(h.indexOf(PP)===0)return h.slice(PP.length);return null};",
  "open=function(id){go(id)};",
  'hs("replaceState",{dop:cur0,root:true});',
  // On the back redirect no entry is pushed: going back from there leaves the funnel, as in browser mode.
  'if(hasBack&&!onBr&&!np)hs("pushState",{dop:cur0});',
  'window.addEventListener("popstate",function(e){var s=e.state||{};',
  "if(s.root&&hasBack&&!onBr){go(brId);return}",
  "if(s.dop&&s.dop!==cur0)go(s.dop,true)});",
  'if(brId&&brT.indexOf("exit")>=0&&!onBr){var fired=false;document.addEventListener("mouseout",function(e){',
  "if(fired||e.relatedTarget||e.clientY>0)return;fired=true;go(brId)})}",
  "}else{",
  // ---- BROWSER MODE: every section came; switches with hidden + history.
  'var pages=[].slice.call(document.querySelectorAll("["+P+"]")),cur=null;',
  "function pid(el){return el.getAttribute(P)}",
  "function byId(i){for(var k=0;k<pages.length;k++)if(pid(pages[k])===i)return pages[k];return null}",
  // Does the step have code? Without code it's inactive and skipped.
  "function on(p){for(var n=p.firstChild;n;n=n.nextSibling)if(n.nodeType===1||(n.nodeType===3&&/\\S/.test(n.nodeValue)))return true;return false}",
  "function first(k){for(var i=0;i<pages.length;i++)if(kd(pages[i])===k&&on(pages[i]))return pages[i];return null}",
  // Initial: 1) active Pre Lander; 2) active Lander. With several variants (preview only: the server serves one), the first one wins.
  'var pre=first("presell"),lan=first("main"),br=first("backredirect"),start=pre||lan,trig=(br&&br.getAttribute(G))||"";',
  "function show(el,push){if(!el||el===cur)return;pages.forEach(function(p){p.hidden=p!==el});cur=el;",
  'if(push)hs("pushState",{dop:pid(el)});window.scrollTo(0,0);',
  'try{el.dispatchEvent(new CustomEvent("dop:pageshow",{bubbles:true}))}catch(e){}}',
  // "Next": from the Pre Lander, the Lander; from the Lander, none; from the Backredirect, the Lander (or the initial one).
  "function nextOf(el){return el===pre?lan:el===lan?null:lan||start}",
  "resolve=function(h){if(!h)return null;if(h===NX)return nextOf(cur);if(h.indexOf(PP)===0){var el=byId(h.slice(PP.length));return el&&on(el)?el:null}return null};",
  "open=function(el){show(el,true)};",
  "if(start){",
  'hs("replaceState",{dop:pid(start),root:true});show(start,false);',
  'if(br&&trig.indexOf("back")>=0)hs("pushState",{dop:pid(start)});',
  'window.addEventListener("popstate",function(e){var s=e.state||{};',
  'if(s.root&&br&&trig.indexOf("back")>=0&&cur!==br){show(br,false);hs("pushState",{dop:pid(br)});return}',
  "if(s.dop){var el=byId(s.dop);if(el)show(el,false)}});",
  'if(br&&trig.indexOf("exit")>=0){var fired=false;document.addEventListener("mouseout",function(e){',
  "if(fired||cur===br||e.relatedTarget||e.clientY>0)return;fired=true;show(br,true)})}",
  "}",
  "}",
  // ---- Shared: attached links and clicks that switch step.
  'function mark(){var l=document.querySelectorAll("["+A+"]");for(var i=0;i<l.length;i++){l[i].style.cursor="pointer";if(!l[i].hasAttribute("role"))l[i].setAttribute("role","link")}}',
  'document.addEventListener("click",function(e){',
  "if(e.defaultPrevented||e.button!==0)return;var t=e.target;if(!t||!t.closest)return;",
  'var a=t.closest("a[href]"),el=t.closest("["+A+"]");',
  "var h0=el&&a?(el.contains(a)&&a!==el?a:el):(el||a);if(!h0)return;",
  'var attached=h0.hasAttribute(A),h=attached?h0.getAttribute(A):h0.getAttribute("href");if(!h)return;',
  'var pg=resolve(h);if(pg){e.preventDefault();open(pg);return}',
  "if(!attached)return;e.preventDefault();",
  'if(e.metaKey||e.ctrlKey||e.shiftKey||h0.getAttribute(T)==="_blank")window.open(h,"_blank","noopener");else window.location.href=h',
  "},true);",
  'if(document.readyState==="loading")document.addEventListener("DOMContentLoaded",mark);else mark();',
  "})();",
].join("");

/** Does the page need the runtime? Any attached link, or more than one sub-page. */
export function needsRuntime(doc: Document): boolean {
  const body = doc.body;
  if (!body) return false;
  return body.querySelector(`[${HREF_ATTR}]`) != null || body.querySelectorAll(`[${PAGE_ATTR}]`).length > 1;
}

/** Ensures the script is at the end of the body iff needed (and always last). */
export function syncRuntime(doc: Document): void {
  const body = doc.body;
  if (!body) return;
  const existing = doc.querySelector(`script[${RUNTIME_ATTR}]`);
  if (!needsRuntime(doc)) {
    existing?.remove();
    return;
  }
  const s = existing ?? doc.createElement("script");
  s.setAttribute(RUNTIME_ATTR, "");
  if (s.textContent !== RUNTIME_JS) s.textContent = RUNTIME_JS;
  if (body.lastElementChild !== s) body.appendChild(s);
}
