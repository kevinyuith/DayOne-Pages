-- ============================================================================
-- DayOne Pages — a vendor domain's traffic gate (the owner, 13/10/2026: "quando o domínio nasce
-- como vendor ele poderá ir no gate por tudo que termina por /up1 /up2 /up3 /up4 /up5 /thank-you,
-- e não mais por /").
--
-- pages.domains.gate_slugs takes a second kind of entry: "*" followed by /<tail> (e.g. */up1) —
-- every path that is <tail> or ends with it is allowed (/up1, /cp/up1, /bg/up1). The delivery
-- server matches it in gate_slug_allowed (server/src/rules.php); an older server never matches it
-- (the path then just gets the domain's page).
--
-- A domain inserted with type VENDOR and the column's default (["/"]) is born with
-- ["*/up1", "*/up2", "*/up3", "*/up4", "*/up5", "*/thank-you"] instead: no "/" — a clean click on
-- the vendor's landing always gets the domain's page. Only at birth: changing a domain's type
-- later leaves its gate_slugs alone.
-- ============================================================================

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
  -- A vendor domain is born with the upsell and thank-you tails, not "/".
  IF TG_OP = 'INSERT' AND NEW.type = 'VENDOR' AND NEW.gate_slugs = '["/"]'::jsonb THEN
    NEW.gate_slugs := '["*/up1", "*/up2", "*/up3", "*/up4", "*/up5", "*/thank-you"]'::jsonb;
  END IF;

  IF coalesce(jsonb_typeof(NEW.gate_slugs), '') <> 'array' THEN
    RAISE EXCEPTION 'domains.gate_slugs must be an array' USING ERRCODE = 'check_violation';
  END IF;
  FOR s IN SELECT value FROM jsonb_array_elements_text(NEW.gate_slugs) LOOP
    -- A slug (/oferta) or "*" + a tail every allowed path ends with (*/up1).
    IF s.value !~ '^/([a-z0-9._~-]+(/[a-z0-9._~-]+)*)?$' AND s.value !~ '^\*(/[a-z0-9._~-]+)+$' THEN
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

COMMENT ON COLUMN pages.domains.gate_slugs IS
  'The traffic gate''s allowed slugs: where a clean click goes to the funnel of its sub1. A slug (/oferta) or "*" + a tail every allowed path ends with (*/up1: /up1, /cp/up1). A domain born VENDOR gets */up1 … */up5 and */thank-you (no "/"); any other gets ["/"].';
