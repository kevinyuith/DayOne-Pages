-- ============================================================================
-- DayOne Pages — registro de hits (tráfego) + agregações para o dashboard
--
-- Incremental e idempotente. Tudo no schema `pages`.
--
--   pages.hits            uma linha por request servido pelo servidor de entrega
--   pages.log_hit(...)    escrita: chamada pelo servidor PHP (anon + server key),
--                         mesmo esquema de pages.resolve (SECURITY DEFINER)
--   pages.hit_stats       contadores do período (para os cards)
--   pages.hit_timeseries  série por bucket (para o gráfico), sem buracos
--   pages.recent_hits     últimos N (para os Access Logs)
--
-- PRIVACIDADE: por decisão do usuário (18/09), guardamos IP e User-Agent crus
-- (PII). Recomenda-se uma retenção (ex.: apagar hits com mais de 90 dias) — não
-- criada aqui para não assumir o prazo. `visitantes únicos` = IPs distintos.
-- ============================================================================


-- ┌──────────────────────────────────────────────────────────────────────────┐
-- │ Tabela                                                                    │
-- └──────────────────────────────────────────────────────────────────────────┘

CREATE TABLE IF NOT EXISTS pages.hits (
  id            bigint      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  created_at    timestamptz NOT NULL DEFAULT now(),
  domain_id     uuid        REFERENCES pages.domains(id) ON DELETE SET NULL,
  host          text        NOT NULL,
  path          text        NOT NULL,
  outcome       text        NOT NULL,   -- served|redirect|blocked|bot|notfound|error|other
  status_code   smallint,
  country       text,                   -- ISO-2 (CF-IPCountry) ou NULL
  device        text,                   -- mobile|tablet|desktop
  is_bot        boolean     NOT NULL DEFAULT false,
  referrer_host text,
  ip            text,                   -- IP cru (PII, por decisão do usuário)
  user_agent    text,
  CONSTRAINT ck_hits_outcome CHECK (outcome IN ('served','redirect','blocked','bot','notfound','error','other'))
);

COMMENT ON TABLE pages.hits IS 'Um registro por request servido pelo servidor de entrega. Alimenta os cards/gráfico/logs do dashboard. Contém IP/UA crus (PII).';

CREATE INDEX IF NOT EXISTS idx_pages_hits_created         ON pages.hits (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_pages_hits_domain_created  ON pages.hits (domain_id, created_at DESC);

ALTER TABLE pages.hits ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON pages.hits FROM anon, authenticated;


-- ┌──────────────────────────────────────────────────────────────────────────┐
-- │ Escrita: pages.log_hit — chamada pelo servidor PHP                        │
-- └──────────────────────────────────────────────────────────────────────────┘
--
-- Mesma porta do `anon` que pages.resolve: exige uma chave válida de
-- pages.server_keys. SECURITY DEFINER para inserir sem o servidor ter a service
-- key. Chave errada → 28000 (403 no PostgREST). Fire-and-forget do lado do PHP.

CREATE OR REPLACE FUNCTION pages.log_hit(
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
  p_user_agent    text
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

  INSERT INTO pages.hits (domain_id, host, path, outcome, status_code, country, device, is_bot, referrer_host, ip, user_agent)
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
    nullif(left(coalesce(p_user_agent, ''), 1024), '')
  );
END $$;

REVOKE ALL ON FUNCTION pages.log_hit(text, uuid, text, text, text, int, text, text, boolean, text, text, text) FROM public, authenticated;
GRANT EXECUTE ON FUNCTION pages.log_hit(text, uuid, text, text, text, int, text, text, boolean, text, text, text) TO anon, service_role;


-- ┌──────────────────────────────────────────────────────────────────────────┐
-- │ Leitura (dashboard): stats, série temporal, recentes                      │
-- └──────────────────────────────────────────────────────────────────────────┘
--
-- SECURITY DEFINER + grant só ao service_role (o dashboard). O painel não tem
-- login; quem o protege é a rede na frente.

CREATE OR REPLACE FUNCTION pages.hit_stats(p_since timestamptz, p_domain uuid DEFAULT NULL)
RETURNS TABLE (total bigint, served bigint, blocked bigint, bots bigint, uniques bigint)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT
    count(*)                                                        AS total,
    count(*) FILTER (WHERE outcome = 'served')                      AS served,
    count(*) FILTER (WHERE outcome IN ('blocked','bot'))            AS blocked,
    count(*) FILTER (WHERE is_bot)                                  AS bots,
    count(DISTINCT ip)                                              AS uniques
  FROM pages.hits
  WHERE created_at >= p_since
    AND (p_domain IS NULL OR domain_id = p_domain);
$$;

CREATE OR REPLACE FUNCTION pages.hit_timeseries(p_since timestamptz, p_bucket interval, p_domain uuid DEFAULT NULL)
RETURNS TABLE (bucket timestamptz, served bigint, blocked bigint, bots bigint)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  WITH buckets AS (
    SELECT generate_series(date_bin(p_bucket, p_since, 'epoch'::timestamptz),
                           date_bin(p_bucket, now(),   'epoch'::timestamptz),
                           p_bucket) AS bucket
  ),
  agg AS (
    SELECT date_bin(p_bucket, created_at, 'epoch'::timestamptz) AS bucket,
           count(*) FILTER (WHERE outcome = 'served')           AS n_served,
           count(*) FILTER (WHERE outcome IN ('blocked','bot')) AS n_blocked,
           count(*) FILTER (WHERE is_bot)                       AS n_bots
    FROM pages.hits
    WHERE created_at >= p_since
      AND (p_domain IS NULL OR domain_id = p_domain)
    GROUP BY 1
  )
  SELECT b.bucket,
         coalesce(a.n_served, 0),
         coalesce(a.n_blocked, 0),
         coalesce(a.n_bots, 0)
  FROM buckets b
  LEFT JOIN agg a ON a.bucket = b.bucket
  ORDER BY b.bucket;
$$;

CREATE OR REPLACE FUNCTION pages.recent_hits(p_limit int DEFAULT 20, p_domain uuid DEFAULT NULL)
RETURNS TABLE (
  created_at    timestamptz,
  host          text,
  path          text,
  outcome       text,
  status_code   smallint,
  country       text,
  device        text,
  is_bot        boolean,
  referrer_host text,
  ip            text
)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT created_at, host, path, outcome, status_code, country, device, is_bot, referrer_host, ip
  FROM pages.hits
  WHERE (p_domain IS NULL OR domain_id = p_domain)
  ORDER BY created_at DESC
  LIMIT greatest(1, least(coalesce(p_limit, 20), 200));
$$;

REVOKE ALL ON FUNCTION pages.hit_stats(timestamptz, uuid)               FROM public, anon, authenticated;
REVOKE ALL ON FUNCTION pages.hit_timeseries(timestamptz, interval, uuid) FROM public, anon, authenticated;
REVOKE ALL ON FUNCTION pages.recent_hits(int, uuid)                      FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION pages.hit_stats(timestamptz, uuid)               TO service_role;
GRANT EXECUTE ON FUNCTION pages.hit_timeseries(timestamptz, interval, uuid) TO service_role;
GRANT EXECUTE ON FUNCTION pages.recent_hits(int, uuid)                      TO service_role;
