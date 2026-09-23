-- ============================================================================
-- DayOne Pages — filtros do dashboard (período, resultado, dispositivo, país, bots)
--
-- As três leituras do dashboard ganham os mesmos filtros opcionais:
--   p_outcomes   text[]   resultado (served, redirect, blocked, bot, notfound, error, other)
--   p_devices    text[]   mobile | tablet | desktop
--   p_countries  text[]   ISO-2
--   p_hide_bots  boolean  tira os hits com is_bot
-- NULL ou array vazio = sem filtro. Todos têm DEFAULT: a chamada antiga
-- (só p_since/p_domain) continua valendo.
--
-- hit_timeseries ganha p_origin: a série diária precisa de dias alinhados à
-- meia-noite local, não à de UTC ('epoch', que segue sendo o default).
-- recent_hits ganha p_since: os Access Logs seguem o período escolhido.
-- hit_countries (nova) lista os países do período, para o popover de filtros.
--
-- DROP + CREATE porque a lista de parâmetros muda (CREATE OR REPLACE criaria
-- uma sobrecarga e o PostgREST não saberia qual chamar).
-- ============================================================================

DROP FUNCTION IF EXISTS pages.hit_stats(timestamptz, uuid);
DROP FUNCTION IF EXISTS pages.hit_timeseries(timestamptz, interval, uuid);
DROP FUNCTION IF EXISTS pages.recent_hits(int, uuid);

CREATE OR REPLACE FUNCTION pages.hit_stats(
  p_since     timestamptz,
  p_domain    uuid    DEFAULT NULL,
  p_outcomes  text[]  DEFAULT NULL,
  p_devices   text[]  DEFAULT NULL,
  p_countries text[]  DEFAULT NULL,
  p_hide_bots boolean DEFAULT false
)
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
    AND (p_domain IS NULL OR domain_id = p_domain)
    AND (coalesce(cardinality(p_outcomes), 0)  = 0 OR outcome = ANY (p_outcomes))
    AND (coalesce(cardinality(p_devices), 0)   = 0 OR device  = ANY (p_devices))
    AND (coalesce(cardinality(p_countries), 0) = 0 OR country = ANY (p_countries))
    AND (NOT coalesce(p_hide_bots, false) OR NOT is_bot);
$$;

CREATE OR REPLACE FUNCTION pages.hit_timeseries(
  p_since     timestamptz,
  p_bucket    interval,
  p_domain    uuid        DEFAULT NULL,
  p_origin    timestamptz DEFAULT NULL,
  p_outcomes  text[]      DEFAULT NULL,
  p_devices   text[]      DEFAULT NULL,
  p_countries text[]      DEFAULT NULL,
  p_hide_bots boolean     DEFAULT false
)
RETURNS TABLE (bucket timestamptz, served bigint, blocked bigint, bots bigint)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  WITH o AS (
    SELECT coalesce(p_origin, 'epoch'::timestamptz) AS origin
  ),
  buckets AS (
    SELECT generate_series(date_bin(p_bucket, p_since, o.origin),
                           date_bin(p_bucket, now(),   o.origin),
                           p_bucket) AS bucket
    FROM o
  ),
  agg AS (
    SELECT date_bin(p_bucket, h.created_at, o.origin)            AS bucket,
           count(*) FILTER (WHERE h.outcome = 'served')           AS n_served,
           count(*) FILTER (WHERE h.outcome IN ('blocked','bot')) AS n_blocked,
           count(*) FILTER (WHERE h.is_bot)                       AS n_bots
    FROM pages.hits h, o
    WHERE h.created_at >= p_since
      AND (p_domain IS NULL OR h.domain_id = p_domain)
      AND (coalesce(cardinality(p_outcomes), 0)  = 0 OR h.outcome = ANY (p_outcomes))
      AND (coalesce(cardinality(p_devices), 0)   = 0 OR h.device  = ANY (p_devices))
      AND (coalesce(cardinality(p_countries), 0) = 0 OR h.country = ANY (p_countries))
      AND (NOT coalesce(p_hide_bots, false) OR NOT h.is_bot)
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

CREATE OR REPLACE FUNCTION pages.recent_hits(
  p_limit     int         DEFAULT 20,
  p_domain    uuid        DEFAULT NULL,
  p_since     timestamptz DEFAULT NULL,
  p_outcomes  text[]      DEFAULT NULL,
  p_devices   text[]      DEFAULT NULL,
  p_countries text[]      DEFAULT NULL,
  p_hide_bots boolean     DEFAULT false
)
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
  WHERE (p_since IS NULL OR created_at >= p_since)
    AND (p_domain IS NULL OR domain_id = p_domain)
    AND (coalesce(cardinality(p_outcomes), 0)  = 0 OR outcome = ANY (p_outcomes))
    AND (coalesce(cardinality(p_devices), 0)   = 0 OR device  = ANY (p_devices))
    AND (coalesce(cardinality(p_countries), 0) = 0 OR country = ANY (p_countries))
    AND (NOT coalesce(p_hide_bots, false) OR NOT is_bot)
  ORDER BY created_at DESC
  LIMIT greatest(1, least(coalesce(p_limit, 20), 200));
$$;

-- Países com hit no período (e domínio), do mais frequente ao menos.
CREATE OR REPLACE FUNCTION pages.hit_countries(p_since timestamptz, p_domain uuid DEFAULT NULL)
RETURNS TABLE (country text, hits bigint)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT country, count(*) AS hits
  FROM pages.hits
  WHERE created_at >= p_since
    AND country IS NOT NULL
    AND (p_domain IS NULL OR domain_id = p_domain)
  GROUP BY country
  ORDER BY hits DESC, country;
$$;

REVOKE ALL ON FUNCTION pages.hit_stats(timestamptz, uuid, text[], text[], text[], boolean)                               FROM public, anon, authenticated;
REVOKE ALL ON FUNCTION pages.hit_timeseries(timestamptz, interval, uuid, timestamptz, text[], text[], text[], boolean)   FROM public, anon, authenticated;
REVOKE ALL ON FUNCTION pages.recent_hits(int, uuid, timestamptz, text[], text[], text[], boolean)                        FROM public, anon, authenticated;
REVOKE ALL ON FUNCTION pages.hit_countries(timestamptz, uuid)                                                             FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION pages.hit_stats(timestamptz, uuid, text[], text[], text[], boolean)                             TO service_role;
GRANT EXECUTE ON FUNCTION pages.hit_timeseries(timestamptz, interval, uuid, timestamptz, text[], text[], text[], boolean) TO service_role;
GRANT EXECUTE ON FUNCTION pages.recent_hits(int, uuid, timestamptz, text[], text[], text[], boolean)                      TO service_role;
GRANT EXECUTE ON FUNCTION pages.hit_countries(timestamptz, uuid)                                                          TO service_role;
