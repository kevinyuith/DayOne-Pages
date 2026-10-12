-- ============================================================================
-- An offer's checkout (and image) may be a path on the page's own domain ("/checkout2?u=…"): two
-- VTurb CTAs link that way today, and the server-drawn CTA sits in the same page, so it resolves the
-- same. A protocol-relative "//host" is still refused.
-- ============================================================================

CREATE OR REPLACE FUNCTION pages.vsl_offers_check()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  k   record;
  f   record;
BEGIN
  IF NEW.player_id IS NULL OR NEW.player_id !~ '^[0-9a-f]{24}$' THEN
    RAISE EXCEPTION 'vsl_offers: invalid player id' USING ERRCODE = 'check_violation';
  END IF;
  NEW.product := btrim(coalesce(NEW.product, ''));
  IF length(NEW.product) NOT BETWEEN 1 AND 80 THEN
    RAISE EXCEPTION 'vsl_offers: the product must have 1 to 80 characters' USING ERRCODE = 'check_violation';
  END IF;
  IF coalesce(jsonb_typeof(NEW.kits), '') <> 'object' OR (SELECT count(*) FROM jsonb_object_keys(NEW.kits)) > 8 THEN
    RAISE EXCEPTION 'vsl_offers: kits must be an object with at most 8 kits' USING ERRCODE = 'check_violation';
  END IF;
  FOR k IN SELECT key, value FROM jsonb_each(NEW.kits) LOOP
    IF k.key !~ '^[1-9][0-9]?$' OR jsonb_typeof(k.value) <> 'object' THEN
      RAISE EXCEPTION 'vsl_offers: invalid kit %', k.key USING ERRCODE = 'check_violation';
    END IF;
    FOR f IN SELECT key, value FROM jsonb_each(k.value) LOOP
      IF NOT (f.key = ANY (pages.cta_kit_fields())) OR jsonb_typeof(f.value) <> 'string'
         OR length(f.value #>> '{}') > 1000
         OR (f.key IN ('image', 'checkout') AND (f.value #>> '{}') !~ '^(https?://|/(?!/))') THEN
        RAISE EXCEPTION 'vsl_offers: invalid field % of kit %', f.key, k.key USING ERRCODE = 'check_violation';
      END IF;
    END LOOP;
  END LOOP;
  RETURN NEW;
END $$;

REVOKE ALL ON FUNCTION pages.vsl_offers_check() FROM public, anon, authenticated;
