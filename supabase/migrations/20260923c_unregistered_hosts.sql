-- ============================================================================
-- DayOne Pages — hosts seen in the logs that are not registered
--
-- pages.unregistered_hosts(p_since): hosts from pages.hits with no domain_id,
-- normalized like pages.domains (without www.), that look like a domain (same
-- regex as the CHECK on pages.domains) and are not registered yet. Feeds the
-- "Seen in the logs, not registered" list in /domains and the Register button in the
-- Logs' Domain column. p_since NULL = the whole history.
--
-- The EC2 public hostname (*.amazonaws.com) is left out: it is the server
-- itself being reached by its AWS name, never a customer domain.
--
-- pages.log_hit: the PHP takes the domain_id from the first resolved route; a
-- domain registered WITHOUT a default page has no route and the hit ended up with no domain (and
-- kept showing as "not registered"). Now, with p_domain NULL, the
-- domain is found by the normalized host. Same signature (CREATE OR
-- REPLACE); the body is the one from 20260923_hit_loads, with only that line changed.
-- Finally, a backfill: old hits with no domain whose host is already registered.
-- ============================================================================

CREATE OR REPLACE FUNCTION pages.unregistered_hosts(p_since timestamptz DEFAULT NULL)
RETURNS TABLE (domain text, hits bigint, bots bigint, last_seen timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  WITH seen AS (
    SELECT pages.normalize_host(h.host) AS domain, h.is_bot, h.created_at
    FROM pages.hits h
    WHERE h.domain_id IS NULL
      AND (p_since IS NULL OR h.created_at >= p_since)
  )
  SELECT s.domain, count(*), count(*) FILTER (WHERE s.is_bot), max(s.created_at)
  FROM seen s
  WHERE s.domain ~ '^[a-z0-9-]+(\.[a-z0-9-]+)*\.[a-z]{2,}$'
    AND length(s.domain) <= 253
    AND s.domain NOT LIKE '%.amazonaws.com'
    AND NOT EXISTS (SELECT 1 FROM pages.domains d WHERE d.domain = s.domain)
  GROUP BY s.domain
  ORDER BY max(s.created_at) DESC;
$$;

REVOKE ALL ON FUNCTION pages.unregistered_hosts(timestamptz) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION pages.unregistered_hosts(timestamptz) TO service_role;


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
    -- With no resolved route the PHP sends NULL (domain without a default page): find it by host.
    coalesce(p_domain, (SELECT d.id FROM pages.domains d WHERE d.domain = pages.normalize_host(p_host))),
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

UPDATE pages.hits h
SET domain_id = d.id
FROM pages.domains d
WHERE h.domain_id IS NULL
  AND d.domain = pages.normalize_host(h.host);
