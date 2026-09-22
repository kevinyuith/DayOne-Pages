-- ============================================================================
-- DayOne Pages — header Cookie do visitante em pages.hits
--
-- O header cru, como chegou (até 4096 caracteres). É PII como IP e UA: pode ter
-- IDs de rastreio (_fbp, _ga) e de sessão. p_cookies tem DEFAULT NULL: o PHP
-- anterior continua funcionando. Aplicar ANTES de subir o PHP novo.
--
-- DROP + CREATE pela mesma razão de 20260922e (mudar a lista de parâmetros).
-- O corpo mantém o filtro de páginas, hostname e ASN.
-- ============================================================================

ALTER TABLE pages.hits ADD COLUMN IF NOT EXISTS cookies text;

COMMENT ON COLUMN pages.hits.cookies IS 'Header Cookie cru da request (até 4096 chars). PII.';

DROP FUNCTION IF EXISTS pages.log_hit(text, uuid, text, text, text, int, text, text, boolean, text, text, text, text, int, text);

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
  p_cookies       text DEFAULT NULL
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

  INSERT INTO pages.hits (domain_id, host, path, outcome, status_code, country, device, is_bot, referrer_host, ip, user_agent, hostname, asn, as_name, cookies)
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
    nullif(left(coalesce(p_cookies, ''), 4096), '')
  );
END $$;

REVOKE ALL ON FUNCTION pages.log_hit(text, uuid, text, text, text, int, text, text, boolean, text, text, text, text, int, text, text) FROM public, authenticated;
GRANT EXECUTE ON FUNCTION pages.log_hit(text, uuid, text, text, text, int, text, text, boolean, text, text, text, text, int, text, text) TO anon, service_role;
