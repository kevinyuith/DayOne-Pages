-- ============================================================================
-- DayOne Pages — add a domain page with its own content (template variation)
--
-- pages.domain_page_add(domain, template, name, contents) works like
-- domain_page_copy, but the slugs' HTML comes from `contents`
-- ({"/": "<!doctype html>...", "/obrigado": "..."}) instead of the template:
-- the dashboard generates a visual variation (and optionally a new copy
-- angle) and stores it as a new PUBLISHED page of the domain. Slugs missing
-- from `contents` keep the template's HTML; keys that are not template slugs
-- are ignored. A domain without a default page gets this one as default.
-- ============================================================================

CREATE OR REPLACE FUNCTION pages.domain_page_add(p_domain uuid, p_template uuid, p_name text, p_contents jsonb)
RETURNS uuid
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  v_page jsonb := pages.template_as_site_page(p_template);
  v_id   uuid  := gen_random_uuid();
  r      record;
BEGIN
  IF v_page IS NULL THEN
    RAISE EXCEPTION 'domain_page_add: template not found' USING ERRCODE = 'no_data_found';
  END IF;
  IF coalesce(jsonb_typeof(p_contents), '') <> 'object' THEN
    RAISE EXCEPTION 'domain_page_add: contents must be an object' USING ERRCODE = 'check_violation';
  END IF;

  FOR r IN SELECT key, value FROM jsonb_each_text(p_contents) LOOP
    IF (v_page -> 'slugs') ? r.key THEN
      v_page := jsonb_set(v_page, ARRAY['slugs', r.key, 'content'], to_jsonb(r.value));
    END IF;
  END LOOP;

  v_page := v_page || jsonb_build_object(
    'name', coalesce(nullif(btrim(p_name), ''), v_page ->> 'name'),
    'status', 'PUBLISHED', 'created_at', now(), 'updated_at', now());

  UPDATE pages.domains d
  SET site = d.site || jsonb_build_object(v_id::text, v_page),
      default_page_id = coalesce(d.default_page_id, v_id)
  WHERE d.id = p_domain;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'domain_page_add: domain not found' USING ERRCODE = 'no_data_found';
  END IF;
  RETURN v_id;
END $$;

REVOKE ALL ON FUNCTION pages.domain_page_add(uuid, uuid, text, jsonb) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION pages.domain_page_add(uuid, uuid, text, jsonb) TO service_role;

NOTIFY pgrst, 'reload schema';
