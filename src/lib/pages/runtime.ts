/**
 * O runtime da página servida: um <script> pequeno, gravado no fim do body,
 * que existe só enquanto a página precisar dele. Faz duas coisas:
 *
 *  1. LINKS ATRELADOS — qualquer elemento com `data-href` navega ao clique
 *     (`data-target="_blank"`, ctrl/cmd/shift abrem em nova aba). Um <a> real
 *     dentro dele continua mandando.
 *  2. SUB-PÁGINAS — troca de etapa no clique de `#next-step` / `#page:<id>`
 *     SEM mudar a URL, e trata back-redirect (botão voltar) e exit intent.
 *     Em dois modos, decididos pelo que veio do servidor:
 *
 *     - MODO NAVEGADOR (padrão; também preview e HTML estático): todas as
 *       seções estão no HTML. Mostra a inicial — o Pre Lander se ativo, senão
 *       o Lander; etapa sem código é pulada (mesmas regras de `subpages.ts`) —,
 *       esconde as outras e troca com `hidden` + history.pushState.
 *     - MODO SERVIDOR (`<body data-dop-funnel="server">`, cortado pelo PHP):
 *       veio SÓ a etapa atual, e o <body> traz `data-dop-cur`, `-next`,
 *       `-start`, `-main`, `-br`, `-br-trigger`. Trocar de etapa = gravar o
 *       cookie `dop_step=<id>` (Path = este path) e recarregar a mesma URL; o
 *       servidor entrega a etapa nova. O fonte nunca contém as outras etapas.
 *
 *  3. AVISO DE VISITA/CLIQUE por amostra (teste A/B): com `data-dop-ev` no
 *     <body> — que SÓ o servidor de entrega põe —, manda `view` quando uma
 *     etapa aparece e `click` quando o visitante sai dela (próxima etapa ou
 *     um link que navega) para `/_dop/e`. Preview e canvas não contam.
 *
 * Na canvas do editor ele não roda (iframe sem allow-scripts); no preview e no
 * servidor, roda. Sem JS, o `hidden` gravado nas sub-páginas não-iniciais já
 * deixa só a inicial visível (modo navegador) — e no modo servidor a etapa
 * atual vem sozinha.
 */

import {
  FUNNEL_COOKIE,
  FUNNEL_EVENTS_ATTR,
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
  // history pode recusar em contextos estranhos (iframe srcdoc sem origem); nunca derruba o resto.
  'function hs(f,st){try{history[f](st,"")}catch(e){}}',
  "var B=document.body,cur0=B.getAttribute(\"data-dop-cur\"),resolve,open;",
  // Tipo (desconhecido = Lander).
  'function kd(p){var k=p.getAttribute(K);return k==="presell"||k==="backredirect"?k:"main"}',
  // Aviso de visita (v) / clique (c) de uma amostra; só quando o servidor ligou (data-dop-ev).
  `var EV=B.hasAttribute("${FUNNEL_EVENTS_ATTR}");`,
  'function ev(t,el){if(!EV||!el)return;try{navigator.sendBeacon("/_dop/e","e="+t+"&p="+encodeURIComponent(el.getAttribute(P))+"&k="+kd(el)+"&s="+encodeURIComponent(location.pathname))}catch(e){}}',
  "if(cur0){",
  // ---- MODO SERVIDOR: uma etapa por resposta; trocar = cookie + reload.
  'var nx=B.getAttribute("data-dop-next"),brId=B.getAttribute("data-dop-br"),brT=B.getAttribute("data-dop-br-trigger")||"",onBr=cur0===brId,hasBack=!!brId&&brT.indexOf("back")>=0;',
  // np = "não empurrar history depois deste reload" (voltar da back redirect para a etapa anterior).
  'var np=false;try{np=sessionStorage.getItem("dop_np")==="1";sessionStorage.removeItem("dop_np")}catch(e){}',
  "function go(id,noPush){if(!id||id===cur0)return;",
  'try{if(noPush)sessionStorage.setItem("dop_np","1")}catch(e){}',
  'document.cookie=CK+"="+id+"; Path="+location.pathname+"; Max-Age=86400; SameSite=Lax";location.reload()}',
  "resolve=function(h){if(!h)return null;if(h===NX)return nx;if(h.indexOf(PP)===0)return h.slice(PP.length);return null};",
  "open=function(id){go(id)};",
  'hs("replaceState",{dop:cur0,root:true});',
  // Na back redirect não se empurra entrada: voltar dali sai do funil, como no modo navegador.
  'if(hasBack&&!onBr&&!np)hs("pushState",{dop:cur0});',
  'window.addEventListener("popstate",function(e){var s=e.state||{};',
  "if(s.root&&hasBack&&!onBr){go(brId);return}",
  "if(s.dop&&s.dop!==cur0)go(s.dop,true)});",
  'if(brId&&brT.indexOf("exit")>=0&&!onBr){var fired=false;document.addEventListener("mouseout",function(e){',
  "if(fired||e.relatedTarget||e.clientY>0)return;fired=true;go(brId)})}",
  'ev("v",document.querySelector("["+P+"]"));',
  "}else{",
  // ---- MODO NAVEGADOR: todas as seções vieram; troca com hidden + history.
  'var pages=[].slice.call(document.querySelectorAll("["+P+"]")),cur=null;',
  "function pid(el){return el.getAttribute(P)}",
  "function byId(i){for(var k=0;k<pages.length;k++)if(pid(pages[k])===i)return pages[k];return null}",
  // A etapa tem código? Sem código fica inativa e é pulada.
  "function on(p){for(var n=p.firstChild;n;n=n.nextSibling)if(n.nodeType===1||(n.nodeType===3&&/\\S/.test(n.nodeValue)))return true;return false}",
  "function first(k){for(var i=0;i<pages.length;i++)if(kd(pages[i])===k&&on(pages[i]))return pages[i];return null}",
  // Inicial: 1) Pre Lander ativo; 2) Lander ativo. Com várias amostras (só no preview: o servidor serve uma), vale a primeira.
  'var pre=first("presell"),lan=first("main"),br=first("backredirect"),start=pre||lan,trig=(br&&br.getAttribute(G))||"";',
  "function show(el,push){if(!el||el===cur)return;pages.forEach(function(p){p.hidden=p!==el});cur=el;ev(\"v\",el);",
  'if(push)hs("pushState",{dop:pid(el)});window.scrollTo(0,0);',
  'try{el.dispatchEvent(new CustomEvent("dop:pageshow",{bubbles:true}))}catch(e){}}',
  // "Próxima": do Pre Lander, o Lander; do Lander, nenhuma; da Backredirect, o Lander (ou a inicial).
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
  // ---- Comum: links atrelados e cliques que trocam de etapa.
  'function mark(){var l=document.querySelectorAll("["+A+"]");for(var i=0;i<l.length;i++){l[i].style.cursor="pointer";if(!l[i].hasAttribute("role"))l[i].setAttribute("role","link")}}',
  'document.addEventListener("click",function(e){',
  "if(e.defaultPrevented||e.button!==0)return;var t=e.target;if(!t||!t.closest)return;",
  'var a=t.closest("a[href]"),el=t.closest("["+A+"]");',
  "var h0=el&&a?(el.contains(a)&&a!==el?a:el):(el||a);if(!h0)return;",
  'var attached=h0.hasAttribute(A),h=attached?h0.getAttribute(A):h0.getAttribute("href");if(!h)return;',
  // Clique que sai da etapa (próxima etapa, ou link que navega): conta para a amostra onde ele está.
  'var sec=h0.closest("["+P+"]"),pg=resolve(h);if(pg){ev("c",sec);e.preventDefault();open(pg);return}',
  'if(h.charAt(0)!=="#"&&h.indexOf("javascript:")!==0)ev("c",sec);',
  "if(!attached)return;e.preventDefault();",
  'if(e.metaKey||e.ctrlKey||e.shiftKey||h0.getAttribute(T)==="_blank")window.open(h,"_blank","noopener");else window.location.href=h',
  "},true);",
  'if(document.readyState==="loading")document.addEventListener("DOMContentLoaded",mark);else mark();',
  "})();",
].join("");

/** A página precisa do runtime? Algum link atrelado, ou mais de uma sub-página. */
export function needsRuntime(doc: Document): boolean {
  const body = doc.body;
  if (!body) return false;
  return body.querySelector(`[${HREF_ATTR}]`) != null || body.querySelectorAll(`[${PAGE_ATTR}]`).length > 1;
}

/** Garante o script no fim do body sse necessário (e sempre por último). */
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
