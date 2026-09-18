-- ============================================================================
-- DayOne Pages — idiomas no filtro + bloqueio de bots por domínio
--
-- Aplicar SOBRE 20260918_domain_filter.sql. Incremental e idempotente.
--
-- O que entra:
--   1. pages.domains.block_bots — interruptor "bloquear bots/conexões suspeitas"
--   2. match_routes() — um candidato de BLOQUEIO (403) no TOPO quando block_bots
--
-- Idiomas e o sentido allow/block das listas (país/idioma) NÃO precisam de
-- coluna nem de CHECK: moram dentro do jsonb `filter` (chaves `languages`,
-- `languages_mode`, `countries_mode`), avaliadas pela camada de serving. O
-- CHECK ck_domains_filter_no_bot (de 20260918) continua valendo: o filtro nunca
-- carrega `bot` — bot só BLOQUEIA, e é isso que a coluna abaixo faz.
-- ============================================================================


-- ┌──────────────────────────────────────────────────────────────────────────┐
-- │ 1. block_bots                                                             │
-- └──────────────────────────────────────────────────────────────────────────┘

ALTER TABLE pages.domains
  ADD COLUMN IF NOT EXISTS block_bots boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN pages.domains.block_bots IS
  'Bloqueia crawlers/conexões automatizadas (responde 403) antes de qualquer rota. Não troca a página — só barra.';


-- ┌──────────────────────────────────────────────────────────────────────────┐
-- │ 2. match_routes() — bot gate no topo + filtro do domínio                  │
-- └──────────────────────────────────────────────────────────────────────────┘
--
-- Muda só o CTE `dom` (traz block_bots) e o CTE `candidates` (uma linha nova de
-- BLOQUEIO com prioridade -1, antes de tudo). O resto é igual à versão de
-- 20260918. A camada de serving avalia as `conditions` de cada linha e serve a
-- primeira que passar; o bot gate casa apenas User-Agent de bot.
--
-- Ordem de prioridade: bot gate (-1) → regras manuais (0..100000) →
-- filtro (2147483646) → fallback (2147483647).

CREATE OR REPLACE FUNCTION pages.match_routes(p_host text, p_path text)
RETURNS TABLE (
  route_id        uuid,
  domain_id       uuid,
  priority        integer,
  match_type      text,
  path_pattern    text,
  conditions      jsonb,
  action          text,
  page_id         uuid,
  slug            text,
  slug_id         uuid,
  content_type    text,
  content_hash    text,
  redirect_url    text,
  status_code     smallint,
  preserve_query  boolean
)
LANGUAGE sql STABLE SET search_path = '' AS $function$
  WITH req AS (
    SELECT pages.normalize_host(p_host) AS host, pages.normalize_path(p_path) AS path
  ),
  dom AS (
    SELECT d.id, d.default_page_id, d.filter, d.filter_pass_page_id, d.filter_fail_page_id, d.block_bots
    FROM pages.domains d, req
    WHERE d.status = 'ACTIVE' AND d.domain = req.host
  ),
  candidates AS (
    -- 0. Bloqueio de bots do domínio: se ligado, um BLOCK 403 que só casa bots,
    --    antes de qualquer rota. Não troca a página — barra a conexão.
    --    Sendo o PRIMEIRO SELECT do CTE, é ele quem nomeia as colunas: alias em todas.
    SELECT NULL::uuid AS route_id, dom.id AS domain_id, -1 AS priority, 'BOTGATE' AS match_type,
           NULL::text AS path_pattern, '{"bot": true}'::jsonb AS conditions, 'BLOCK' AS action,
           NULL::uuid AS page_id, NULL::text AS slug, NULL::text AS redirect_url,
           403::smallint AS status_code, false AS preserve_query
    FROM dom
    WHERE dom.block_bots

    UNION ALL
    -- 1. Regras manuais do domínio (prioridade explícita).
    SELECT r.id AS route_id, r.domain_id, r.priority, r.match_type, r.path_pattern, r.conditions, r.action,
           r.page_id,
           CASE WHEN r.action = 'SERVE' THEN coalesce(r.slug, req.path) END AS slug,
           r.redirect_url, r.status_code, r.preserve_query
    FROM pages.domain_routes r
    JOIN dom ON dom.id = r.domain_id, req
    WHERE r.is_active
      AND CASE r.match_type
            WHEN 'ANY'    THEN true
            WHEN 'EXACT'  THEN req.path = r.path_pattern
            WHEN 'PREFIX' THEN r.path_pattern = '/' OR req.path = r.path_pattern
                               OR starts_with(req.path, r.path_pattern || '/')
            WHEN 'REGEX'  THEN req.path ~ r.path_pattern
          END

    UNION ALL
    -- 2. Filtro do domínio: passou nas condições → página de aprovação.
    --    Entra logo antes do fallback; só existe quando há filtro e página.
    SELECT NULL, dom.id, 2147483646, 'FILTER', NULL, dom.filter, 'SERVE',
           dom.filter_pass_page_id, req.path, NULL, NULL, true
    FROM dom, req
    WHERE dom.filter IS NOT NULL AND dom.filter_pass_page_id IS NOT NULL

    UNION ALL
    -- 3. Fallback: página de reprovação do filtro, senão a página padrão.
    SELECT NULL, dom.id, 2147483647, 'FALLBACK', NULL, '{}'::jsonb, 'SERVE',
           coalesce(dom.filter_fail_page_id, dom.default_page_id), req.path, NULL, NULL, true
    FROM dom, req
    WHERE coalesce(dom.filter_fail_page_id, dom.default_page_id) IS NOT NULL
  )
  SELECT c.route_id, c.domain_id, c.priority, c.match_type, c.path_pattern, c.conditions, c.action,
         c.page_id, c.slug, s.id AS slug_id, s.content_type, s.content_hash,
         c.redirect_url, c.status_code, c.preserve_query
  FROM candidates c
  LEFT JOIN pages.pages p      ON p.id = c.page_id
  LEFT JOIN pages.page_slugs s ON s.page_id = c.page_id AND s.slug = c.slug AND s.is_active
  WHERE c.action <> 'SERVE' OR p.status = 'PUBLISHED'
  ORDER BY c.priority
$function$;

COMMENT ON FUNCTION pages.match_routes(text, text) IS
  'Bot gate (block_bots) + regras do domínio + filtro + fallback, em ordem de prioridade. Só casa o PATH; '
  'as `conditions` (bot gate, regras e filtro) são avaliadas na camada de serving. '
  'Ordem: bot gate (BLOCK 403 só p/ bots) → regras manuais → filtro (passou → filter_pass_page) → fallback (filter_fail_page ou default_page). '
  'conditions aceita ainda countries_mode/languages/languages_mode; primeira cujas conditions passam vence; SERVE com slug_id NULL → 404.';
