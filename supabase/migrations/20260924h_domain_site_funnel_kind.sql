-- ============================================================================
-- DayOne Pages — domain pages may be funnels
--
-- 20260924g added kind FUNNEL to pages.pages, but domains_site_check (the
-- trigger that validates pages.domains.site) still listed only the old kinds,
-- so copying a funnel to a domain (domain_page_copy copies the kind) failed
-- with check_violation. Same function, FUNNEL added to the list.
-- ============================================================================

CREATE OR REPLACE FUNCTION pages.domains_site_check()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO ''
AS $function$
DECLARE
  pg record;
  sl record;
BEGIN
  IF coalesce(jsonb_typeof(NEW.site), '') <> 'object' THEN
    RAISE EXCEPTION 'domains.site must be an object' USING ERRCODE = 'check_violation';
  END IF;

  FOR pg IN SELECT key, value FROM jsonb_each(NEW.site) LOOP
    IF pg.key !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
       OR coalesce(jsonb_typeof(pg.value), '') <> 'object'
       OR coalesce(jsonb_typeof(pg.value -> 'name'), '') <> 'string'
       OR length(btrim(pg.value ->> 'name')) NOT BETWEEN 1 AND 120
       OR coalesce(pg.value ->> 'kind', '') NOT IN ('PRESELL', 'ADVERTORIAL', 'VSL', 'CHECKOUT', 'SAFE', 'OTHER', 'FUNNEL')
       OR coalesce(pg.value ->> 'status', '') NOT IN ('DRAFT', 'PUBLISHED', 'ARCHIVED')
       OR coalesce(jsonb_typeof(pg.value -> 'slugs'), '') <> 'object' THEN
      RAISE EXCEPTION 'domains.site: invalid page %', pg.key USING ERRCODE = 'check_violation';
    END IF;

    FOR sl IN SELECT key, value FROM jsonb_each(pg.value -> 'slugs') LOOP
      IF sl.key !~ '^/([a-z0-9._~-]+(/[a-z0-9._~-]+)*)?$'
         OR coalesce(jsonb_typeof(sl.value -> 'content'), '') <> 'string'
         OR coalesce(jsonb_typeof(sl.value -> 'is_active'), '') <> 'boolean' THEN
        RAISE EXCEPTION 'domains.site: invalid slug % in page %', sl.key, pg.key USING ERRCODE = 'check_violation';
      END IF;
    END LOOP;
  END LOOP;

  IF (NEW.default_page_id IS NOT NULL AND NOT (NEW.site ? NEW.default_page_id::text))
     OR (NEW.filter_pass_page_id IS NOT NULL AND NOT (NEW.site ? NEW.filter_pass_page_id::text))
     OR (NEW.filter_fail_page_id IS NOT NULL AND NOT (NEW.site ? NEW.filter_fail_page_id::text)) THEN
    RAISE EXCEPTION 'domains: default and filter pages must be pages of this domain' USING ERRCODE = 'check_violation';
  END IF;

  IF TG_OP = 'UPDATE' AND EXISTS (
    SELECT 1 FROM pages.domain_routes r
    WHERE r.domain_id = NEW.id AND r.page_id IS NOT NULL AND NOT (NEW.site ? r.page_id::text)
  ) THEN
    RAISE EXCEPTION 'domains: a route still serves a page that is not in site' USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END $function$;
