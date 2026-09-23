-- ============================================================================
-- DayOne Pages — "a página carregou de verdade" (aviso de carregamento)
--
-- O servidor grava o hit ao RECEBER a request: ping, curl, prefetch e robô de
-- prévia de link também viram "served". Para separar, cada página HTML servida
-- ganha um id de visita (cookie dop_v, 32 hex) e um script mínimo que, no
-- evento load do navegador, faz sendBeacon para /_dop/l. O servidor lê o
-- cookie e chama pages.log_load, que grava em pages.hit_loads.
--
-- Tabela à parte (e não UPDATE em hits) porque o aviso costuma chegar ANTES do
-- hit: o hit é gravado depois da resposta, com reverse DNS e ASN no meio. A
-- tela de Logs junta hits.visit_id com hit_loads.visit_id.
--
-- p_visit_id tem DEFAULT NULL: o PHP anterior continua funcionando.
-- DROP + CREATE de log_hit pela mesma razão de 20260922e.
-- ============================================================================

ALTER TABLE pages.hits ADD COLUMN IF NOT EXISTS visit_id text;

COMMENT ON COLUMN pages.hits.visit_id IS 'Id da visita (cookie dop_v) quando a resposta foi uma página HTML com o aviso de carregamento. Liga com pages.hit_loads.';

CREATE TABLE IF NOT EXISTS pages.hit_loads (
  visit_id  text        PRIMARY KEY CHECK (visit_id ~ '^[0-9a-f]{32}$'),
  loaded_at timestamptz NOT NULL DEFAULT now(),
  load_ms   int         CHECK (load_ms BETWEEN 0 AND 600000)
);

COMMENT ON TABLE pages.hit_loads IS 'Aviso do navegador de que a página carregou (evento load). load_ms = ms desde o início da navegação.';

ALTER TABLE pages.hit_loads ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON pages.hit_loads FROM anon, authenticated;
GRANT SELECT, INSERT, DELETE ON pages.hit_loads TO service_role;

DROP FUNCTION IF EXISTS pages.log_hit(text, uuid, text, text, text, int, text, text, boolean, text, text, text, text, int, text, text, text, uuid, uuid, text, text, text, text);

CREATE FUNCTION pages.log_hit(
  p_key           text,
  p_domain        uuid,
  p_host          text,
  p_path          text,
  p_outcome       text,
  p_status        int,
  p_country       text,
  p_device        text,
  p_is_bot        boolean,
  p_referrer_host text,
  p_ip            text,
  p_user_agent    text,
  p_hostname      text DEFAULT NULL,
  p_asn           int  DEFAULT NULL,
  p_as_name       text DEFAULT NULL,
  p_cookies       text DEFAULT NULL,
  p_region        text DEFAULT NULL,
  p_route_id      uuid DEFAULT NULL,
  p_page_id       uuid DEFAULT NULL,
  p_slug          text DEFAULT NULL,
  p_decision      text DEFAULT NULL,
  p_query         text DEFAULT NULL,
  p_redirect_url  text DEFAULT NULL,
  p_visit_id      text DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pages.server_keys k
    WHERE k.key_hash = encode(sha256(convert_to(coalesce(p_key, ''), 'UTF8')), 'hex')
      AND k.revoked_at IS NULL
  ) THEN
    RAISE EXCEPTION 'pages.log_hit: invalid key' USING ERRCODE = '28000';
  END IF;

  IF coalesce(p_path, '') !~* '(\.(html|php)|/[^/.]*)$' THEN
    RETURN;
  END IF;

  INSERT INTO pages.hits (domain_id, host, path, outcome, status_code, country, device, is_bot, referrer_host, ip, user_agent,
                          hostname, asn, as_name, cookies, region, route_id, page_id, slug, decision, query, redirect_url, visit_id)
  VALUES (
    p_domain,
    left(coalesce(p_host, ''), 253),
    left(coalesce(p_path, ''), 2048),
    CASE WHEN p_outcome IN ('served','redirect','blocked','bot','notfound','error') THEN p_outcome ELSE 'other' END,
    p_status::smallint,
    nullif(upper(coalesce(p_country, '')), ''),
    nullif(p_device, ''),
    coalesce(p_is_bot, false),
    nullif(left(coalesce(p_referrer_host, ''), 253), ''),
    nullif(p_ip, ''),
    nullif(left(coalesce(p_user_agent, ''), 1024), ''),
    nullif(left(coalesce(p_hostname, ''), 253), ''),
    CASE WHEN p_asn > 0 THEN p_asn END,
    nullif(left(coalesce(p_as_name, ''), 256), ''),
    nullif(left(coalesce(p_cookies, ''), 4096), ''),
    CASE WHEN upper(coalesce(p_country, '')) = 'US' THEN nullif(left(trim(coalesce(p_region, '')), 100), '') END,
    p_route_id,
    p_page_id,
    nullif(left(coalesce(p_slug, ''), 512), ''),
    nullif(left(coalesce(p_decision, ''), 64), ''),
    nullif(left(coalesce(p_query, ''), 2048), ''),
    nullif(left(coalesce(p_redirect_url, ''), 2048), ''),
    CASE WHEN p_visit_id ~ '^[0-9a-f]{32}$' THEN p_visit_id END
  );
END $$;

REVOKE ALL ON FUNCTION pages.log_hit(text, uuid, text, text, text, int, text, text, boolean, text, text, text, text, int, text, text, text, uuid, uuid, text, text, text, text, text) FROM public, authenticated;
GRANT EXECUTE ON FUNCTION pages.log_hit(text, uuid, text, text, text, int, text, text, boolean, text, text, text, text, int, text, text, text, uuid, uuid, text, text, text, text, text) TO anon, service_role;

CREATE OR REPLACE FUNCTION pages.log_load(p_key text, p_visit_id text, p_load_ms int DEFAULT NULL)
RETURNS void
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pages.server_keys k
    WHERE k.key_hash = encode(sha256(convert_to(coalesce(p_key, ''), 'UTF8')), 'hex')
      AND k.revoked_at IS NULL
  ) THEN
    RAISE EXCEPTION 'pages.log_load: invalid key' USING ERRCODE = '28000';
  END IF;

  IF coalesce(p_visit_id, '') !~ '^[0-9a-f]{32}$' THEN
    RETURN;
  END IF;

  INSERT INTO pages.hit_loads (visit_id, load_ms)
  VALUES (p_visit_id, CASE WHEN p_load_ms BETWEEN 0 AND 600000 THEN p_load_ms END)
  ON CONFLICT (visit_id) DO NOTHING;
END $$;

REVOKE ALL ON FUNCTION pages.log_load(text, text, int) FROM public, authenticated;
GRANT EXECUTE ON FUNCTION pages.log_load(text, text, int) TO anon, service_role;
