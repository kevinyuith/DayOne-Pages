-- ============================================================================
-- DayOne Pages — complemento ao schema `pages`
--
-- Aplicar SOBRE o schema criado por `20260916_pages_schema.sql` (o mesmo
-- projeto Supabase, ref cfiisyxaxttoexiyfdho). Este arquivo não cria o
-- schema nem as quatro tabelas base: ele acrescenta o que o dashboard e o
-- servidor de entrega precisam. Tudo aqui vive em `pages`; nada é criado em
-- `public` ou em qualquer outro schema. É idempotente: pode ser rodado de novo.
--
-- O que entra:
--   1. colunas de verificação de domínio em pages.domains
--   2. CHECK: a condição `bot` só é aceita em rotas de BLOQUEIO
--   3. pages.server_keys      — chaves do servidor de entrega (hash sha256)
--   4. pages.access_attempts  — limite de tentativas do login por IP
--   5. pages.resolve()        — rotas + conteúdo numa chamada, para o servidor
--   6. pages.swap_route_priority() — troca atômica de prioridade entre rotas
--   7. semântica de match_routes() documentada
-- ============================================================================


-- ┌──────────────────────────────────────────────────────────────────────────┐
-- │ 1. Verificação de domínio                                                 │
-- └──────────────────────────────────────────────────────────────────────────┘
--
-- Atrás do Cloudflare o registro A não é verificável (resolve para IPs do
-- Cloudflare). O dashboard verifica buscando `/_health` no domínio e conferindo
-- o marcador do nosso servidor; o resultado fica aqui, sem histórico.

ALTER TABLE pages.domains
  ADD COLUMN IF NOT EXISTS last_checked_at  timestamptz,
  ADD COLUMN IF NOT EXISTS last_check_ok    boolean,
  ADD COLUMN IF NOT EXISTS last_check_error text;

COMMENT ON COLUMN pages.domains.last_checked_at  IS 'Última verificação de /_health feita pelo dashboard.';
COMMENT ON COLUMN pages.domains.last_check_ok    IS 'A última verificação encontrou o nosso servidor atrás do domínio?';
COMMENT ON COLUMN pages.domains.last_check_error IS 'Motivo da última falha de verificação (texto curto, sem dado sensível).';


-- ┌──────────────────────────────────────────────────────────────────────────┐
-- │ 2. `bot` só serve para bloquear                                           │
-- └──────────────────────────────────────────────────────────────────────────┘
--
-- Detecção de bot existe para barrar scrapers e crawlers (403/404/410/451),
-- nunca para trocar o conteúdo servido. O dashboard também recusa; o CHECK é a
-- garantia que não depende da UI.

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'ck_domain_routes_bot_only_block'
      AND conrelid = 'pages.domain_routes'::regclass
  ) THEN
    ALTER TABLE pages.domain_routes
      ADD CONSTRAINT ck_domain_routes_bot_only_block
      CHECK (NOT (conditions ? 'bot') OR action = 'BLOCK');
  END IF;
END $$;


-- ┌──────────────────────────────────────────────────────────────────────────┐
-- │ 3. pages.server_keys — chaves do servidor de entrega                      │
-- └──────────────────────────────────────────────────────────────────────────┘
--
-- O servidor PHP NÃO recebe a service key. Ele chama pages.resolve() com a
-- chave publicável (anon) mais uma chave própria, cujo sha256 mora aqui. Vazou
-- a chave do servidor: revoga-se a linha (revoked_at) e emite-se outra.
--
-- Seed (rodar à mão, uma vez por servidor; a chave em claro vai só no server/.env):
--   INSERT INTO pages.server_keys (name, key_hash)
--   VALUES ('origin-1', encode(sha256(convert_to('<openssl rand -hex 32>', 'UTF8')), 'hex'));

CREATE TABLE IF NOT EXISTS pages.server_keys (
  id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text        NOT NULL,
  key_hash    text        NOT NULL UNIQUE,
  created_at  timestamptz NOT NULL DEFAULT now(),
  revoked_at  timestamptz
);

COMMENT ON TABLE  pages.server_keys          IS 'Chaves dos servidores de entrega. Só o hash; a chave em claro vive no .env do servidor.';
COMMENT ON COLUMN pages.server_keys.key_hash IS 'encode(sha256(convert_to(chave, ''UTF8'')), ''hex'').';

ALTER TABLE pages.server_keys ENABLE ROW LEVEL SECURITY;
-- Os default privileges do schema deram SELECT ao `authenticated`; aqui não.
REVOKE ALL ON pages.server_keys FROM authenticated;


-- ┌──────────────────────────────────────────────────────────────────────────┐
-- │ 4. pages.access_attempts — limite de tentativas do login                  │
-- └──────────────────────────────────────────────────────────────────────────┘
--
-- Contador em memória não serve: zera a cada deploy e não é compartilhado
-- entre instâncias. Só falhas entram; nunca a senha tentada.

CREATE TABLE IF NOT EXISTS pages.access_attempts (
  id           bigserial   PRIMARY KEY,
  ip           text        NOT NULL,
  occurred_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_pages_access_attempts_ip_time
  ON pages.access_attempts (ip, occurred_at DESC);

COMMENT ON TABLE pages.access_attempts IS 'Falhas de login do dashboard, por IP. Lida e escrita só pelo service_role.';

ALTER TABLE pages.access_attempts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON pages.access_attempts FROM authenticated;


-- ┌──────────────────────────────────────────────────────────────────────────┐
-- │ 5. pages.resolve(host, path, key) — o resolvedor do servidor de entrega   │
-- └──────────────────────────────────────────────────────────────────────────┘
--
-- match_routes() devolve as rotas candidatas mas não o HTML; o servidor
-- precisaria de uma segunda chamada por slug. Esta função junta os dois numa
-- ida só, e é a ÚNICA porta do `anon` neste schema:
--
--   • SECURITY DEFINER: roda como dono, então alcança match_routes() e
--     page_slugs mesmo com o `anon` sem privilégio em tabela alguma.
--   • Exige uma chave válida em server_keys; chave errada levanta 28000
--     (invalid_authorization_specification), que o PostgREST devolve como 403.
--     Sem chave, quem tem só a anon key não resolve nada.
--
-- Semântica de quem consome: percorre as linhas em ordem; a PRIMEIRA cuja
-- `conditions` casar decide. SERVE com slug_id NULL responde 404 — não pula
-- para a próxima, para que uma rota mal configurada apareça em vez de sumir.

CREATE OR REPLACE FUNCTION pages.resolve(p_host text, p_path text, p_key text)
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
  preserve_query  boolean,
  content         text
)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pages.server_keys k
    WHERE k.key_hash = encode(sha256(convert_to(coalesce(p_key, ''), 'UTF8')), 'hex')
      AND k.revoked_at IS NULL
  ) THEN
    RAISE EXCEPTION 'pages.resolve: invalid key' USING ERRCODE = '28000';
  END IF;

  RETURN QUERY
    SELECT m.route_id, m.domain_id, m.priority, m.match_type, m.path_pattern,
           m.conditions, m.action, m.page_id, m.slug, m.slug_id,
           m.content_type, m.content_hash, m.redirect_url, m.status_code,
           m.preserve_query,
           CASE WHEN m.slug_id IS NOT NULL THEN s.content END AS content
    FROM pages.match_routes(p_host, p_path) AS m
    LEFT JOIN pages.page_slugs AS s ON s.id = m.slug_id;
END $$;

COMMENT ON FUNCTION pages.resolve(text, text, text) IS
  'Rotas de match_routes(host, path) + conteúdo do slug, numa chamada. Exige chave de pages.server_keys. '
  'Chamada pelo servidor de entrega via POST /rest/v1/rpc/resolve com Content-Profile: pages.';

-- `anon` ganha USAGE no schema (sem isso não enxerga a função) e EXECUTE só
-- nela. Continua sem SELECT em tabela alguma e sem as outras funções.
GRANT USAGE ON SCHEMA pages TO anon;
REVOKE ALL ON ALL TABLES IN SCHEMA pages FROM anon;
REVOKE ALL ON FUNCTION pages.resolve(text, text, text) FROM public, authenticated;
GRANT EXECUTE ON FUNCTION pages.resolve(text, text, text) TO anon, service_role;


-- ┌──────────────────────────────────────────────────────────────────────────┐
-- │ 6. pages.swap_route_priority(a, b) — mover rota para cima/baixo           │
-- └──────────────────────────────────────────────────────────────────────────┘
--
-- UNIQUE (domain_id, priority) impede trocar em dois UPDATEs soltos. Aqui a
-- troca passa por um valor temporário abaixo do mínimo do domínio, tudo numa
-- transação só. Só o service_role (dashboard) chama.

CREATE OR REPLACE FUNCTION pages.swap_route_priority(p_a uuid, p_b uuid)
RETURNS void
LANGUAGE plpgsql SET search_path = '' AS $$
DECLARE
  v_pa   integer;
  v_pb   integer;
  v_da   uuid;
  v_db   uuid;
  v_tmp  integer;
BEGIN
  IF p_a = p_b THEN RETURN; END IF;

  SELECT r.priority, r.domain_id INTO v_pa, v_da FROM pages.domain_routes r WHERE r.id = p_a FOR UPDATE;
  SELECT r.priority, r.domain_id INTO v_pb, v_db FROM pages.domain_routes r WHERE r.id = p_b FOR UPDATE;

  IF v_pa IS NULL OR v_pb IS NULL THEN
    RAISE EXCEPTION 'swap_route_priority: rota não encontrada';
  END IF;
  IF v_da <> v_db THEN
    RAISE EXCEPTION 'swap_route_priority: as rotas são de domínios diferentes';
  END IF;

  SELECT min(r.priority) - 1 INTO v_tmp FROM pages.domain_routes r WHERE r.domain_id = v_da;

  UPDATE pages.domain_routes SET priority = v_tmp WHERE id = p_a;
  UPDATE pages.domain_routes SET priority = v_pa  WHERE id = p_b;
  UPDATE pages.domain_routes SET priority = v_pb  WHERE id = p_a;
END $$;

REVOKE ALL ON FUNCTION pages.swap_route_priority(uuid, uuid) FROM public, authenticated;
GRANT EXECUTE ON FUNCTION pages.swap_route_priority(uuid, uuid) TO service_role;


-- ┌──────────────────────────────────────────────────────────────────────────┐
-- │ 7. Semântica de match_routes(), agora decidida                            │
-- └──────────────────────────────────────────────────────────────────────────┘

COMMENT ON FUNCTION pages.match_routes(text, text) IS
  'Regras do domínio que casam (host, path), em ordem de prioridade, + fallback (default_page_id). '
  'Só casa o PATH; `conditions` volta para a camada de serving avaliar. '
  'Semântica de quem consome: a PRIMEIRA linha cujas conditions passam decide; '
  'SERVE com slug_id NULL responde 404 e NÃO cai para a próxima. '
  'Formato de conditions: {"countries":["BR"],"devices":["mobile","tablet","desktop"],'
  '"query":{"utm_source":"present"|"absent"|{"equals":"x"}},"referrer":"texto","bot":true}; '
  '`bot` só em action=BLOCK (ck_domain_routes_bot_only_block).';
