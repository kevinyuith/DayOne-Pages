-- ============================================================================
-- DayOne Pages — hit logging (traffic) + aggregations for the dashboard
--
-- Incremental and idempotent. Everything in the `pages` schema.
--
--   pages.hits            one row per request served by the delivery server
--   pages.log_hit(...)    write: called by the PHP server (anon + server key),
--                         same scheme as pages.resolve (SECURITY DEFINER)
--   pages.hit_stats       counters for the period (for the cards)
--   pages.hit_timeseries  series per bucket (for the chart), with no gaps
--   pages.recent_hits     last N (for the Access Logs)
--
-- PRIVACY: by the user's decision (09/18), we store raw IP and User-Agent
-- (PII). A retention policy is recommended (e.g. delete hits older than 90 days) — not
-- created here so as not to assume the period. `unique visitors` = distinct IPs.
-- ============================================================================


-- ┌──────────────────────────────────────────────────────────────────────────┐
-- │ Table                                                                    │
-- └──────────────────────────────────────────────────────────────────────────┘

CREATE TABLE IF NOT EXISTS pages.hits (
  id            bigint      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  created_at    timestamptz NOT NULL DEFAULT now(),
  domain_id     uuid        REFERENCES pages.domains(id) ON DELETE SET NULL,
  host          text        NOT NULL,
  path          text        NOT NULL,
  outcome       text        NOT NULL,   -- served|redirect|blocked|bot|notfound|error|other
  status_code   smallint,
  country       text,                   -- ISO-2 (CF-IPCountry) or NULL
  device        text,                   -- mobile|tablet|desktop
  is_bot        boolean     NOT NULL DEFAULT false,
  referrer_host text,
  ip            text,                   -- raw IP (PII, by the user's decision)
  user_agent    text,
  CONSTRAINT ck_hits_outcome CHECK (outcome IN ('served','redirect','blocked','bot','notfound','error','other'))
);

COMMENT ON TABLE pages.hits IS 'One record per request served by the delivery server. Feeds the dashboard cards/chart/logs. Contains raw IP/UA (PII).';

CREATE INDEX IF NOT EXISTS idx_pages_hits_created         ON pages.hits (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_pages_hits_domain_created  ON pages.hits (domain_id, created_at DESC);

ALTER TABLE pages.hits ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON pages.hits FROM anon, authenticated;


-- ┌──────────────────────────────────────────────────────────────────────────┐
-- │ Write: pages.log_hit — called by the PHP server                          │
-- └──────────────────────────────────────────────────────────────────────────┘
--
-- Same `anon` door as pages.resolve: requires a valid key from
-- pages.server_keys. SECURITY DEFINER to insert without the server having the service
-- key. Wrong key → 28000 (403 in PostgREST). Fire-and-forget on the PHP side.

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
-- │ Read (dashboard): stats, time series, recent                             │
-- └──────────────────────────────────────────────────────────────────────────┘
--
-- SECURITY DEFINER + grant only to service_role (the dashboard). The panel has no
-- login; what protects it is the network in front.

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
