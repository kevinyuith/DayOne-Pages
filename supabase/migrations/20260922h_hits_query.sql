-- ============================================================================
-- DayOne Pages — URL parameters (query string) in pages.hits
--
-- The path is still stored without the query (it is normalized); the raw query, as it came
-- (utm_*, fbclid, gclid…), goes in `query`, up to 2048 characters. It can hold click
-- IDs and, in badly built links, email/phone: it is PII like IP and UA.
-- p_query has DEFAULT NULL: the previous PHP keeps working.
--
-- DROP + CREATE for the same reason as 20260922e (changing the parameter list).
-- The body keeps the page filter, hostname, ASN, cookies, region and decision.
-- ============================================================================

ALTER TABLE pages.hits ADD COLUMN IF NOT EXISTS query text;

COMMENT ON COLUMN pages.hits.query IS 'Raw query string of the request (without the "?"), up to 2048 chars. PII.';

DROP FUNCTION IF EXISTS pages.log_hit(text, uuid, text, text, text, int, text, text, boolean, text, text, text, text, int, text, text, text, uuid, uuid, text, text);

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
  p_query         text DEFAULT NULL
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
                          hostname, asn, as_name, cookies, region, route_id, page_id, slug, decision, query)
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
    nullif(left(coalesce(p_query, ''), 2048), '')
  );
END $$;

REVOKE ALL ON FUNCTION pages.log_hit(text, uuid, text, text, text, int, text, text, boolean, text, text, text, text, int, text, text, text, uuid, uuid, text, text, text) FROM public, authenticated;
GRANT EXECUTE ON FUNCTION pages.log_hit(text, uuid, text, text, text, int, text, text, boolean, text, text, text, text, int, text, text, text, uuid, uuid, text, text, text) TO anon, service_role;
