-- ============================================================================
-- DayOne Pages — filtro por domínio
--
-- Um domínio pode ter UM filtro: condições (país, dispositivo, parâmetros de
-- URL, referrer) e duas páginas — quem PASSA vê uma, quem NÃO passa vê a outra.
--
--   pages.domains.filter               jsonb com as condições (mesmo formato de
--                                       domain_routes.conditions, MENOS `bot`)
--   pages.domains.filter_pass_page_id  página servida quando as condições casam
--   pages.domains.filter_fail_page_id  página servida quando não casam
--
-- Como se encaixa no que já existe: as regras manuais (domain_routes) continuam
-- tendo prioridade. O filtro entra logo antes do fallback. A ordem de avaliação
-- na camada de serving (primeira cujas condições passam vence) fica:
--
--   regras manuais  →  filtro: passou? página de aprovação  →  fallback:
--   página de reprovação (ou, sem filtro, a página padrão do domínio)
--
-- `bot` NÃO é aceito no filtro (CHECK abaixo): detecção de bot serve para
-- BLOQUEAR (domain_routes), nunca para trocar a página servida.
-- ============================================================================


-- ┌──────────────────────────────────────────────────────────────────────────┐
-- │ Colunas                                                                   │
-- └──────────────────────────────────────────────────────────────────────────┘

ALTER TABLE pages.domains
  ADD COLUMN IF NOT EXISTS filter              jsonb,
  ADD COLUMN IF NOT EXISTS filter_pass_page_id uuid REFERENCES pages.pages(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS filter_fail_page_id uuid REFERENCES pages.pages(id) ON DELETE SET NULL;

COMMENT ON COLUMN pages.domains.filter              IS 'Condições do filtro do domínio (país, dispositivo, query, referrer). NULL = sem filtro. Não aceita a chave `bot`.';
COMMENT ON COLUMN pages.domains.filter_pass_page_id IS 'Página servida quando o visitante passa no filtro.';
COMMENT ON COLUMN pages.domains.filter_fail_page_id IS 'Página servida quando o visitante não passa no filtro.';

CREATE INDEX IF NOT EXISTS idx_pages_domains_filter_pass ON pages.domains (filter_pass_page_id) WHERE filter_pass_page_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_pages_domains_filter_fail ON pages.domains (filter_fail_page_id) WHERE filter_fail_page_id IS NOT NULL;

-- `bot` fora do filtro. A garantia que não depende da UI.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'ck_domains_filter_no_bot' AND conrelid = 'pages.domains'::regclass
  ) THEN
    ALTER TABLE pages.domains
      ADD CONSTRAINT ck_domains_filter_no_bot CHECK (filter IS NULL OR NOT (filter ? 'bot'));
  END IF;
END $$;


-- ┌──────────────────────────────────────────────────────────────────────────┐
-- │ match_routes() — agora com o filtro do domínio                            │
-- └──────────────────────────────────────────────────────────────────────────┘
--
-- Só muda o CTE `dom` (traz as colunas do filtro) e o CTE `candidates` (duas
-- linhas novas). O resto é igual ao original. A camada de serving avalia as
-- `conditions` de cada linha e serve a primeira que passar.

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
    SELECT d.id, d.default_page_id, d.filter, d.filter_pass_page_id, d.filter_fail_page_id
    FROM pages.domains d, req
    WHERE d.status = 'ACTIVE' AND d.domain = req.host
  ),
  candidates AS (
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
  'Regras do domínio + filtro + fallback, em ordem de prioridade. Só casa o PATH; '
  'as `conditions` (regras e filtro) são avaliadas na camada de serving. '
  'Ordem: regras manuais → filtro (passou → filter_pass_page) → fallback (filter_fail_page ou default_page). '
  'Primeira cujas conditions passam vence; SERVE com slug_id NULL → 404.';
