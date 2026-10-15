-- ============================================================================
-- DayOne Pages — the gate's tails (*/up1) are a vendor domain's only (the owner, 14/10/2026: "a
-- estrutura antiga funciona normalmente, só essas que estão em tipo vendor que são diferentes").
--
-- 20261013b let pages.domains.gate_slugs take "*" + a tail (every path ending with it) on any
-- domain. Now only a domain whose type is VENDOR may have one:
--   * an INSERT or UPDATE that gives a tail to a domain of any other type is refused (23514);
--   * a domain that stops being VENDOR (its gate_slugs not touched in the same UPDATE) loses its
--     tails, and "/" is NOT added back: what is left (maybe nothing) stays — a clean click never
--     reaches a funnel the domain didn't allow before.
-- The trigger now also runs on UPDATE OF type. Every other domain is unchanged.
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

  -- A domain that stops being VENDOR loses its tails (they are a vendor domain's only).
  IF TG_OP = 'UPDATE' AND OLD.type = 'VENDOR' AND NEW.type IS DISTINCT FROM 'VENDOR'
     AND NEW.gate_slugs IS NOT DISTINCT FROM OLD.gate_slugs AND jsonb_typeof(NEW.gate_slugs) = 'array' THEN
    NEW.gate_slugs := (
      SELECT coalesce(jsonb_agg(to_jsonb(v.value) ORDER BY v.n), '[]'::jsonb)
      FROM jsonb_array_elements_text(NEW.gate_slugs) WITH ORDINALITY AS v(value, n)
      WHERE v.value NOT LIKE '*%'
    );
  END IF;

  IF coalesce(jsonb_typeof(NEW.gate_slugs), '') <> 'array' THEN
    RAISE EXCEPTION 'domains.gate_slugs must be an array' USING ERRCODE = 'check_violation';
  END IF;
  FOR s IN SELECT value FROM jsonb_array_elements_text(NEW.gate_slugs) LOOP
    -- A slug (/oferta) or "*" + a tail every allowed path ends with (*/up1).
    IF s.value !~ '^/([a-z0-9._~-]+(/[a-z0-9._~-]+)*)?$' AND s.value !~ '^\*(/[a-z0-9._~-]+)+$' THEN
      RAISE EXCEPTION 'domains.gate_slugs: invalid slug %', s.value USING ERRCODE = 'check_violation';
    END IF;
    IF s.value LIKE '*%' AND NEW.type IS DISTINCT FROM 'VENDOR' THEN
      RAISE EXCEPTION 'domains.gate_slugs: % is a tail, only for a vendor domain', s.value USING ERRCODE = 'check_violation';
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

DROP TRIGGER IF EXISTS trg_pages_domains_gate_slugs_check ON pages.domains;
CREATE TRIGGER trg_pages_domains_gate_slugs_check BEFORE INSERT OR UPDATE OF gate_slugs, type ON pages.domains
  FOR EACH ROW EXECUTE FUNCTION pages.domains_gate_slugs_check();

REVOKE ALL ON FUNCTION pages.domains_gate_slugs_check() FROM public, anon, authenticated;

COMMENT ON COLUMN pages.domains.gate_slugs IS
  'The traffic gate''s allowed slugs: where a clean click goes to the funnel of its sub1. A slug (/oferta), or — on a VENDOR domain only — "*" + a tail every allowed path ends with (*/up1: /up1, /cp/up1). A domain born VENDOR gets */up1 … */up5 and */thank-you (no "/"); any other gets ["/"]. A domain that stops being VENDOR loses its tails ("/" is not added back).';
