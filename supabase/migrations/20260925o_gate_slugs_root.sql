-- ============================================================================
-- DayOne Pages — "/" becomes a gate_slug like any other (and the default)
--
-- Before, "/" was always allowed and gate_slugs only added the others. Now
-- the list is the whole set: taking "/" out of it stops clean clicks on the
-- root from going to the funnel. Existing domains keep their root allowed
-- ("/" is added where it is missing) and new domains start with ["/"].
-- The check now rejects duplicates and sets the canonical order ("/" first).
-- ============================================================================

ALTER TABLE pages.domains ALTER COLUMN gate_slugs SET DEFAULT '["/"]'::jsonb;

-- Every existing domain keeps "/" allowed (it was implicit before).
UPDATE pages.domains
SET gate_slugs = '["/"]'::jsonb || gate_slugs
WHERE NOT (gate_slugs @> '["/"]'::jsonb);

COMMENT ON COLUMN pages.domains.gate_slugs IS 'The slugs where a clean click goes to the funnel of its sub1 ("/" included when allowed): ["/", "/oferta", …]. Take "/" out to keep the root on the safe page. The funnel''s main page (its "/" slug) is served at every allowed slug.';

-- The check: a slug list without duplicates, canonicalized ("/" first, then
-- as typed). Same format as before; only the duplicates are new.
CREATE OR REPLACE FUNCTION pages.domains_gate_slugs_check()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  s record;
  v_seen text[] := '{}';
  v_out jsonb := '[]'::jsonb;
BEGIN
  IF coalesce(jsonb_typeof(NEW.gate_slugs), '') <> 'array' THEN
    RAISE EXCEPTION 'domains.gate_slugs must be an array' USING ERRCODE = 'check_violation';
  END IF;
  FOR s IN SELECT value FROM jsonb_array_elements_text(NEW.gate_slugs) LOOP
    IF s.value !~ '^/([a-z0-9._~-]+(/[a-z0-9._~-]+)*)?$' THEN
      RAISE EXCEPTION 'domains.gate_slugs: invalid slug %', s.value USING ERRCODE = 'check_violation';
    END IF;
    IF s.value = ANY (v_seen) THEN
      RAISE EXCEPTION 'domains.gate_slugs: repeated slug %', s.value USING ERRCODE = 'check_violation';
    END IF;
    v_seen := v_seen || s.value;
    v_out := v_out || to_jsonb(s.value);
  END LOOP;
  -- Canonical order: "/" first (it was always allowed before; keep it obvious).
  IF v_out @> '["/"]'::jsonb THEN
    NEW.gate_slugs := '["/"]'::jsonb || (SELECT coalesce(jsonb_agg(v), '[]'::jsonb) FROM jsonb_array_elements_text(v_out) v WHERE v <> '/');
  ELSE
    NEW.gate_slugs := v_out;
  END IF;
  RETURN NEW;
END $$;

NOTIFY pgrst, 'reload schema';
