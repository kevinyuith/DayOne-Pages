-- ============================================================================
-- CTAs of a funnel: the block of bundles that shows under the VSL at the pitch, drawn by the
-- delivery server among the funnel's published CTAs (the owner's plan of 11/10/2026).
--
-- The same shape as a funnel's pages:
--   * pages.cta is the row of each CTA (like pages.pages): name, status, the visual of the
--     Offer Layout (dayone-main's object), sections, quiz, the bundles (quantity, the jar's
--     image, price, checkout link), the sections' content and the rendered HTML, whose
--     content_hash a trigger fills (sha256, pages.content_hash).
--   * pages.funnels.cta is only the funnel's list, { "<cta id>": { "weight": 50 } } (like
--     pages.funnels.site). A CTA belongs to exactly one funnel (pages.cta.funnel_id); removing
--     it from the list deletes the row; deleting the funnel deletes its CTAs.
--   * Only a PUBLISHED CTA gets traffic, so only the published ones hold a share, and they add
--     up to 100. Publishing joins with 100/n (the others shrink in proportion), unpublishing or
--     removing rescales the rest — the math of src/lib/pages/traffic.ts, here in SQL because the
--     screen that edits CTAs is dayone-main's.
--   * A CTA is the funnel's, not a product's: nothing here reads public.products / public.vsl.
--
-- The VSL's CTA mode lives in its entry of pages.funnels.vsl: { weight, name, cta: "server" }
-- (absent = the VTurb player's own CTA, as today). Writers that don't know the key (both
-- dashboards save the whole split) keep it: the vsl trigger carries it over; "vturb" removes it.
-- "server" needs pages.funnels.cta_enabled and at least one published CTA — and while a VSL is
-- on "server", the funnel can't be left without a published CTA (the page would have no CTA).
--
-- pages.funnels.cta_enabled: only F8 for now (the owner, 11/10: "só deixa ligado no funil F8
-- por enquanto"). pages.resolve doesn't read any of this yet (20261011b).
--
-- Also copies the only CTA dayone-main created in public.funnel_offers (Teeste1, F23, a draft)
-- with the content of SodaHoneyBoost (the product with the largest VSL share in F23), its keys
-- in English. public.funnel_offers / public.product_offer_content are dropped by dayone-main
-- once its screen reads and writes here.
-- ============================================================================

-- The lock on pages.funnels without queueing (see 20261006b): a pending ACCESS EXCLUSIVE
-- request would stall every reader of pages.funnels (the gate's resolve) behind it.
DO $do$
DECLARE i int := 0;
BEGIN
  LOOP
    BEGIN
      LOCK TABLE pages.funnels IN ACCESS EXCLUSIVE MODE NOWAIT;
      EXIT;
    EXCEPTION WHEN lock_not_available THEN
      i := i + 1;
      IF i >= 60 THEN
        RAISE EXCEPTION 'could not lock pages.funnels in 30 s';
      END IF;
      PERFORM pg_sleep(0.5);
    END;
  END LOOP;
END $do$;

ALTER TABLE pages.funnels
  ADD COLUMN IF NOT EXISTS cta jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS cta_enabled boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN pages.funnels.cta IS
  'The funnel''s CTAs and their share: { "<pages.cta id>": { "weight": 0-100 } }. Only published CTAs hold a share; they add up to 100.';
COMMENT ON COLUMN pages.funnels.cta_enabled IS
  'The delivery server may serve this funnel''s CTAs (a VSL can only be on CTA mode "server" when true).';

-- ── pages.cta ───────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS pages.cta (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  funnel_id     uuid NOT NULL REFERENCES pages.funnels (id) ON DELETE CASCADE,
  name          text NOT NULL,
  status        text NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT', 'PUBLISHED')),
  visual        jsonb NOT NULL DEFAULT '{}'::jsonb,
  product_color boolean NOT NULL DEFAULT false,
  quiz          boolean NOT NULL DEFAULT false,
  sections      jsonb NOT NULL DEFAULT '{"faq": false, "comments": false, "science": false, "logos": false}'::jsonb,
  bundles       jsonb NOT NULL DEFAULT '[]'::jsonb,
  content       jsonb NOT NULL DEFAULT '{}'::jsonb,
  html          text NOT NULL DEFAULT '',
  content_hash  text NOT NULL DEFAULT '',
  created_by    text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS cta_funnel_id_idx ON pages.cta (funnel_id);

COMMENT ON TABLE pages.cta IS
  'A funnel''s CTA: the bundles block shown under the VSL at the pitch. Listed by its funnel in pages.funnels.cta. Carries its HTML: never select *, read through pages.cta_summary / pages.cta_get.';
COMMENT ON COLUMN pages.cta.visual IS 'The Offer Layout''s visual (dayone-main''s VisualOferta), as the screen saves it.';
COMMENT ON COLUMN pages.cta.product_color IS 'The palette comes from the colour of this CTA''s jar photo; visual.paleta is the fallback.';
COMMENT ON COLUMN pages.cta.sections IS '{ faq, comments, science, logos }: each section on or off.';
COMMENT ON COLUMN pages.cta.bundles IS '[{ quantity, image, price, checkout_url, ... }]: the bundles, in display order.';
COMMENT ON COLUMN pages.cta.content IS '{ language, titles, faq, comments, studies, logos, quiz }: the sections'' content.';
COMMENT ON COLUMN pages.cta.html IS 'The rendered block (dayone-main''s montarCta), saved with the CTA.';
COMMENT ON COLUMN pages.cta.content_hash IS 'sha256 of html (pages.content_hash), filled by a trigger. The delivery server caches the HTML by it.';

ALTER TABLE pages.cta ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON pages.cta FROM public, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON pages.cta TO service_role;

-- Validates a row and fills content_hash.
CREATE OR REPLACE FUNCTION pages.cta_check()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  b   record;
  bad text;
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.funnel_id <> OLD.funnel_id THEN
    RAISE EXCEPTION 'cta: a CTA does not move to another funnel' USING ERRCODE = 'check_violation';
  END IF;
  NEW.name := btrim(coalesce(NEW.name, ''));
  IF length(NEW.name) NOT BETWEEN 1 AND 80 THEN
    RAISE EXCEPTION 'cta: the name must have 1 to 80 characters' USING ERRCODE = 'check_violation';
  END IF;
  IF jsonb_typeof(NEW.visual) <> 'object' THEN
    RAISE EXCEPTION 'cta: visual must be an object' USING ERRCODE = 'check_violation';
  END IF;
  IF jsonb_typeof(NEW.sections) <> 'object' THEN
    RAISE EXCEPTION 'cta: sections must be an object' USING ERRCODE = 'check_violation';
  END IF;
  SELECT s.key INTO bad FROM jsonb_each(NEW.sections) s
  WHERE s.key NOT IN ('faq', 'comments', 'science', 'logos') OR jsonb_typeof(s.value) <> 'boolean' LIMIT 1;
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION 'cta: invalid section %', bad USING ERRCODE = 'check_violation';
  END IF;
  IF jsonb_typeof(NEW.content) <> 'object' THEN
    RAISE EXCEPTION 'cta: content must be an object' USING ERRCODE = 'check_violation';
  END IF;
  SELECT k INTO bad FROM jsonb_object_keys(NEW.content) k
  WHERE k NOT IN ('language', 'titles', 'faq', 'comments', 'studies', 'logos', 'quiz') LIMIT 1;
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION 'cta: unknown content key %', bad USING ERRCODE = 'check_violation';
  END IF;
  IF jsonb_typeof(NEW.bundles) <> 'array' THEN
    RAISE EXCEPTION 'cta: bundles must be an array' USING ERRCODE = 'check_violation';
  END IF;
  FOR b IN SELECT e.value, e.n FROM jsonb_array_elements(NEW.bundles) WITH ORDINALITY AS e(value, n) LOOP
    IF jsonb_typeof(b.value) <> 'object'
       OR coalesce(jsonb_typeof(b.value -> 'quantity'), '') <> 'number' OR (b.value ->> 'quantity') !~ '^[1-9][0-9]?$'
       OR coalesce(jsonb_typeof(b.value -> 'image'), '') <> 'string' OR (b.value ->> 'image') !~ '^https?://'
       OR coalesce(jsonb_typeof(b.value -> 'price'), '') <> 'number' OR (b.value ->> 'price')::numeric < 0
       OR coalesce(jsonb_typeof(b.value -> 'checkout_url'), '') <> 'string' OR (b.value ->> 'checkout_url') !~ '^https?://' THEN
      RAISE EXCEPTION 'cta: invalid bundle %', b.n USING ERRCODE = 'check_violation';
    END IF;
  END LOOP;
  IF NEW.status = 'PUBLISHED' AND (btrim(NEW.html) = '' OR jsonb_array_length(NEW.bundles) = 0) THEN
    RAISE EXCEPTION 'cta: a published CTA needs its HTML and at least one bundle' USING ERRCODE = 'check_violation';
  END IF;
  NEW.content_hash := pages.content_hash(NEW.html);
  RETURN NEW;
END $$;

-- A CTA still listed by its funnel is removed through the list (pages.funnel_cta_remove).
CREATE OR REPLACE FUNCTION pages.cta_delete_check()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM pages.funnels f WHERE f.id = OLD.funnel_id AND f.cta ? OLD.id::text) THEN
    RAISE EXCEPTION 'cta: CTA % is still listed by its funnel', OLD.id USING ERRCODE = 'foreign_key_violation';
  END IF;
  RETURN OLD;
END $$;

DROP TRIGGER IF EXISTS trg_pages_cta_check ON pages.cta;
CREATE TRIGGER trg_pages_cta_check BEFORE INSERT OR UPDATE ON pages.cta
  FOR EACH ROW EXECUTE FUNCTION pages.cta_check();
DROP TRIGGER IF EXISTS trg_pages_cta_updated_at ON pages.cta;
CREATE TRIGGER trg_pages_cta_updated_at BEFORE UPDATE ON pages.cta
  FOR EACH ROW EXECUTE FUNCTION pages.set_updated_at();
DROP TRIGGER IF EXISTS trg_pages_cta_delete_check ON pages.cta;
CREATE TRIGGER trg_pages_cta_delete_check BEFORE DELETE ON pages.cta
  FOR EACH ROW EXECUTE FUNCTION pages.cta_delete_check();

-- ── The share math (src/lib/pages/traffic.ts), in SQL ───────────────────────

-- `p_total` split among `p_ids` in proportion to `p_weights` ({ id: number }; all 0 = equal
-- parts), as integers that add up to `p_total`. The rounding leftover goes to the largest
-- remainders (tie: whoever comes first). traffic.ts spread().
CREATE OR REPLACE FUNCTION pages.shares_spread(p_ids text[], p_weights jsonb, p_total int)
RETURNS jsonb
LANGUAGE sql
IMMUTABLE
SET search_path = ''
AS $$
  WITH ids AS (
    SELECT u.id, u.ord, greatest(0, coalesce((p_weights ->> u.id)::numeric, 0)) AS w
    FROM unnest(p_ids) WITH ORDINALITY AS u(id, ord)
  ), tot AS (
    SELECT sum(w) AS s, count(*) AS n FROM ids
  ), raw AS (
    SELECT i.id, i.ord, CASE WHEN t.s = 0 THEN p_total::numeric / t.n ELSE i.w * p_total / t.s END AS v
    FROM ids i CROSS JOIN tot t
  ), ranked AS (
    SELECT r.id, floor(r.v)::int AS base,
           row_number() OVER (ORDER BY r.v - floor(r.v) DESC, r.ord) AS rn,
           p_total - sum(floor(r.v)::int) OVER () AS rest
    FROM raw r
  )
  SELECT coalesce(jsonb_object_agg(id, base + CASE WHEN rn <= rest THEN 1 ELSE 0 END), '{}'::jsonb) FROM ranked
$$;

-- `p_id` gets `p_value`%, the others split the rest in the proportion they had; alone: 100.
-- traffic.ts setShare().
CREATE OR REPLACE FUNCTION pages.shares_set(p_weights jsonb, p_id text, p_value int)
RETURNS jsonb
LANGUAGE sql
IMMUTABLE
SET search_path = ''
AS $$
  SELECT CASE
    WHEN NOT EXISTS (SELECT 1 FROM jsonb_object_keys(p_weights) k WHERE k <> p_id) THEN jsonb_build_object(p_id, 100)
    ELSE pages.shares_spread(ARRAY(SELECT k FROM jsonb_object_keys(p_weights) k WHERE k <> p_id),
                             p_weights, 100 - greatest(0, least(100, p_value)))
         || jsonb_build_object(p_id, greatest(0, least(100, p_value)))
  END
$$;

-- `p_list` (pages.funnels.cta) with the weights of `p_weights` ({ id: number }) written in.
CREATE OR REPLACE FUNCTION pages.cta_list_with(p_list jsonb, p_weights jsonb)
RETURNS jsonb
LANGUAGE sql
IMMUTABLE
SET search_path = ''
AS $$
  SELECT p_list || coalesce((
    SELECT jsonb_object_agg(w.key, coalesce(p_list -> w.key, '{}'::jsonb) || jsonb_build_object('weight', (w.value #>> '{}')::int))
    FROM jsonb_each(p_weights) w
  ), '{}'::jsonb)
$$;

-- { cta id: weight } of the funnel's published CTAs, as the list holds them now.
CREATE OR REPLACE FUNCTION pages.funnel_cta_published(p_funnel uuid)
RETURNS jsonb
LANGUAGE sql
STABLE
SET search_path = ''
AS $$
  SELECT coalesce(jsonb_object_agg(c.id::text, coalesce((f.cta -> c.id::text ->> 'weight')::int, 0)), '{}'::jsonb)
  FROM pages.funnels f
  JOIN pages.cta c ON c.funnel_id = f.id AND f.cta ? c.id::text
  WHERE f.id = p_funnel AND c.status = 'PUBLISHED'
$$;

-- ── The list (pages.funnels.cta) and the VSL's CTA mode ─────────────────────

-- Validates the list: every key a CTA of this funnel, weights 0-100, the published ones add up
-- to 100; and a funnel with a VSL on CTA mode "server" keeps cta_enabled and a published CTA.
CREATE OR REPLACE FUNCTION pages.funnels_cta_check()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  e     record;
  st    text;
  total int := 0;
  n_pub int := 0;
BEGIN
  IF coalesce(jsonb_typeof(NEW.cta), '') <> 'object' THEN
    RAISE EXCEPTION 'funnels.cta must be an object' USING ERRCODE = 'check_violation';
  END IF;
  FOR e IN SELECT key, value FROM jsonb_each(NEW.cta) LOOP
    IF e.key !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
       OR coalesce(jsonb_typeof(e.value), '') <> 'object'
       OR coalesce(e.value ->> 'weight', '') !~ '^\d{1,3}$'
       OR (e.value ->> 'weight')::int > 100 THEN
      RAISE EXCEPTION 'funnels.cta: invalid entry %', e.key USING ERRCODE = 'check_violation';
    END IF;
    SELECT c.status INTO st FROM pages.cta c WHERE c.id = e.key::uuid AND c.funnel_id = NEW.id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'funnels.cta: % is not a CTA of this funnel', e.key USING ERRCODE = 'foreign_key_violation';
    END IF;
    IF st = 'PUBLISHED' THEN
      n_pub := n_pub + 1;
      total := total + (e.value ->> 'weight')::int;
    END IF;
  END LOOP;
  IF n_pub > 0 AND total <> 100 THEN
    RAISE EXCEPTION 'funnels.cta: the published CTAs add up to %, not 100', total USING ERRCODE = 'check_violation';
  END IF;
  IF EXISTS (SELECT 1 FROM jsonb_each(NEW.vsl) v WHERE v.value ->> 'cta' = 'server')
     AND (NOT NEW.cta_enabled OR n_pub = 0) THEN
    RAISE EXCEPTION 'funnels.cta: the funnel has VSLs with the CTA from the server — switch them to VTurb first'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;

-- Removing a CTA from the list deletes its row.
CREATE OR REPLACE FUNCTION pages.funnels_cta_removed()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  DELETE FROM pages.cta c
  WHERE c.funnel_id = NEW.id AND OLD.cta ? c.id::text AND NOT (NEW.cta ? c.id::text);
  RETURN NULL;
END $$;

DROP TRIGGER IF EXISTS trg_pages_funnels_cta_check ON pages.funnels;
CREATE TRIGGER trg_pages_funnels_cta_check BEFORE INSERT OR UPDATE OF cta, cta_enabled ON pages.funnels
  FOR EACH ROW EXECUTE FUNCTION pages.funnels_cta_check();
DROP TRIGGER IF EXISTS trg_pages_funnels_cta_removed ON pages.funnels;
CREATE TRIGGER trg_pages_funnels_cta_removed AFTER UPDATE OF cta ON pages.funnels
  FOR EACH ROW EXECUTE FUNCTION pages.funnels_cta_removed();

-- The VSL split (unchanged rules) plus the VSL's CTA mode: `cta` absent = VTurb, "server" = the
-- delivery server's CTAs. An entry written without `cta` keeps the one it had (writers that save
-- the whole split don't know the key); "vturb" removes it. "server" needs cta_enabled and a
-- published CTA.
CREATE OR REPLACE FUNCTION pages.funnels_vsl_check()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  v      record;
  total  numeric := 0;
  out    jsonb := '{}'::jsonb;
  entry  jsonb;
  server boolean := false;
BEGIN
  IF coalesce(jsonb_typeof(NEW.vsl), '') <> 'object' THEN
    RAISE EXCEPTION 'funnels.vsl must be an object' USING ERRCODE = 'check_violation';
  END IF;
  FOR v IN SELECT key, value FROM jsonb_each(NEW.vsl) LOOP
    IF v.key !~ '^[0-9a-f]{24}$'
       OR coalesce(jsonb_typeof(v.value), '') <> 'object'
       OR coalesce(jsonb_typeof(v.value -> 'weight'), '') <> 'number'
       OR (v.value ->> 'weight')::numeric NOT BETWEEN 0 AND 100
       OR coalesce(jsonb_typeof(v.value -> 'name'), 'string') NOT IN ('string', 'null')
       OR coalesce(v.value ->> 'cta', 'vturb') NOT IN ('vturb', 'server') THEN
      RAISE EXCEPTION 'funnels.vsl: invalid video %', v.key USING ERRCODE = 'check_violation';
    END IF;
    total := total + (v.value ->> 'weight')::numeric;
    entry := v.value;
    IF NOT (entry ? 'cta') AND TG_OP = 'UPDATE' AND OLD.vsl -> v.key ? 'cta' THEN
      entry := entry || jsonb_build_object('cta', OLD.vsl -> v.key -> 'cta');
    END IF;
    IF entry ->> 'cta' = 'vturb' THEN
      entry := entry - 'cta';
    END IF;
    server := server OR entry ->> 'cta' = 'server';
    out := out || jsonb_build_object(v.key, entry);
  END LOOP;
  IF NEW.vsl <> '{}'::jsonb AND abs(total - 100) > 0.001 THEN
    RAISE EXCEPTION 'funnels.vsl: the shares add up to %, not 100', total USING ERRCODE = 'check_violation';
  END IF;
  IF server AND NOT (NEW.cta_enabled AND pages.funnel_cta_live(NEW.id, NEW.cta)) THEN
    RAISE EXCEPTION 'funnels.vsl: the CTA from the server needs the funnel''s CTAs on and a published CTA'
      USING ERRCODE = 'check_violation';
  END IF;
  NEW.vsl := out;
  RETURN NEW;
END $$;

-- True when the list `p_list` of funnel `p_funnel` has a published CTA.
CREATE OR REPLACE FUNCTION pages.funnel_cta_live(p_funnel uuid, p_list jsonb)
RETURNS boolean
LANGUAGE sql
STABLE
SET search_path = ''
AS $$
  SELECT EXISTS (
    SELECT 1 FROM pages.cta c
    WHERE c.funnel_id = p_funnel AND c.status = 'PUBLISHED' AND p_list ? c.id::text
  )
$$;

-- ── Writes (the dashboards; service_role) ───────────────────────────────────

-- The fields a write may carry (status has its own function).
CREATE OR REPLACE FUNCTION pages.cta_fields_check(p_cta jsonb)
RETURNS void
LANGUAGE plpgsql
IMMUTABLE
SET search_path = ''
AS $$
DECLARE
  bad text;
BEGIN
  IF coalesce(jsonb_typeof(p_cta), '') <> 'object' THEN
    RAISE EXCEPTION 'cta: the CTA must be an object' USING ERRCODE = '22023';
  END IF;
  SELECT k INTO bad FROM jsonb_object_keys(p_cta) k
  WHERE k NOT IN ('name', 'visual', 'product_color', 'quiz', 'sections', 'bundles', 'content') LIMIT 1;
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION 'cta: unknown field %', bad USING ERRCODE = '22023';
  END IF;
END $$;

-- A new CTA in the funnel: a draft, listed with no share. Returns its id.
CREATE OR REPLACE FUNCTION pages.funnel_cta_add(p_funnel uuid, p_cta jsonb, p_html text DEFAULT '', p_created_by text DEFAULT NULL)
RETURNS uuid
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  v_id uuid;
BEGIN
  PERFORM pages.cta_fields_check(p_cta);
  PERFORM 1 FROM pages.funnels f WHERE f.id = p_funnel FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'funnel_cta_add: funnel not found' USING ERRCODE = 'no_data_found';
  END IF;
  INSERT INTO pages.cta (funnel_id, name, visual, product_color, quiz, sections, bundles, content, html, created_by)
  VALUES (p_funnel,
          p_cta ->> 'name',
          coalesce(p_cta -> 'visual', '{}'::jsonb),
          coalesce((p_cta ->> 'product_color')::boolean, false),
          coalesce((p_cta ->> 'quiz')::boolean, false),
          coalesce(p_cta -> 'sections', '{"faq": false, "comments": false, "science": false, "logos": false}'::jsonb),
          coalesce(p_cta -> 'bundles', '[]'::jsonb),
          coalesce(p_cta -> 'content', '{}'::jsonb),
          coalesce(p_html, ''),
          p_created_by)
  RETURNING id INTO v_id;
  UPDATE pages.funnels f SET cta = f.cta || jsonb_build_object(v_id::text, jsonb_build_object('weight', 0))
  WHERE f.id = p_funnel;
  RETURN v_id;
END $$;

-- Saves a CTA's fields (only the ones in p_cta) and its HTML (NULL = unchanged), over the
-- version the screen loaded. Returns the new updated_at; NULL = it changed meanwhile (reload).
CREATE OR REPLACE FUNCTION pages.cta_save(p_cta_id uuid, p_cta jsonb, p_html text, p_expected timestamptz)
RETURNS timestamptz
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  v_at timestamptz;
BEGIN
  PERFORM pages.cta_fields_check(coalesce(p_cta, '{}'::jsonb));
  SELECT c.updated_at INTO v_at FROM pages.cta c WHERE c.id = p_cta_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'cta_save: CTA not found' USING ERRCODE = 'no_data_found';
  END IF;
  IF v_at IS DISTINCT FROM p_expected THEN
    RETURN NULL;
  END IF;
  UPDATE pages.cta c SET
    name          = coalesce(p_cta ->> 'name', c.name),
    visual        = coalesce(p_cta -> 'visual', c.visual),
    product_color = coalesce((p_cta ->> 'product_color')::boolean, c.product_color),
    quiz          = coalesce((p_cta ->> 'quiz')::boolean, c.quiz),
    sections      = coalesce(p_cta -> 'sections', c.sections),
    bundles       = coalesce(p_cta -> 'bundles', c.bundles),
    content       = coalesce(p_cta -> 'content', c.content),
    html          = coalesce(p_html, c.html)
  WHERE c.id = p_cta_id
  RETURNING c.updated_at INTO v_at;
  RETURN v_at;
END $$;

-- Publishes (joins the split with 100/n, the others shrink) or unpublishes (the rest is
-- rescaled to 100) a CTA, over the version the screen loaded. Returns the new updated_at;
-- NULL = it changed meanwhile.
CREATE OR REPLACE FUNCTION pages.funnel_cta_publish(p_cta_id uuid, p_published boolean, p_expected timestamptz)
RETURNS timestamptz
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  v_funnel uuid;
  v_at     timestamptz;
  v_status text;
  v_others jsonb;
  v_next   jsonb;
BEGIN
  SELECT c.funnel_id INTO v_funnel FROM pages.cta c WHERE c.id = p_cta_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'funnel_cta_publish: CTA not found' USING ERRCODE = 'no_data_found';
  END IF;
  PERFORM 1 FROM pages.funnels f WHERE f.id = v_funnel FOR UPDATE;
  SELECT c.updated_at, c.status INTO v_at, v_status FROM pages.cta c WHERE c.id = p_cta_id FOR UPDATE;
  IF v_at IS DISTINCT FROM p_expected THEN
    RETURN NULL;
  END IF;
  IF (v_status = 'PUBLISHED') = p_published THEN
    RETURN v_at;
  END IF;
  v_others := pages.funnel_cta_published(v_funnel) - p_cta_id::text;
  UPDATE pages.cta c SET status = CASE WHEN p_published THEN 'PUBLISHED' ELSE 'DRAFT' END
  WHERE c.id = p_cta_id
  RETURNING c.updated_at INTO v_at;
  IF p_published THEN
    v_next := pages.shares_set(v_others || jsonb_build_object(p_cta_id::text, 0), p_cta_id::text,
                               round(100.0 / ((SELECT count(*) FROM jsonb_object_keys(v_others)) + 1))::int);
  ELSE
    v_next := pages.shares_spread(ARRAY(SELECT jsonb_object_keys(v_others)), v_others, 100);
  END IF;
  UPDATE pages.funnels f SET cta = pages.cta_list_with(f.cta, v_next) WHERE f.id = v_funnel;
  RETURN v_at;
END $$;

-- The shares of the funnel's published CTAs ({ id: 0-100 }, adding up to 100) — the Traffic
-- column's Save. False = the set of published CTAs changed meanwhile (reload).
CREATE OR REPLACE FUNCTION pages.funnel_cta_weights_set(p_funnel uuid, p_weights jsonb)
RETURNS boolean
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  v_pub jsonb;
  total int;
BEGIN
  IF coalesce(jsonb_typeof(p_weights), '') <> 'object'
     OR EXISTS (SELECT 1 FROM jsonb_each(p_weights) w
                WHERE jsonb_typeof(w.value) <> 'number' OR (w.value #>> '{}') !~ '^\d{1,3}$' OR (w.value #>> '{}')::int > 100) THEN
    RAISE EXCEPTION 'funnel_cta_weights_set: weights must be { "<cta id>": 0-100 }' USING ERRCODE = '22023';
  END IF;
  PERFORM 1 FROM pages.funnels f WHERE f.id = p_funnel FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'funnel_cta_weights_set: funnel not found' USING ERRCODE = 'no_data_found';
  END IF;
  v_pub := pages.funnel_cta_published(p_funnel);
  IF (SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(p_weights) k)
     IS DISTINCT FROM (SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(v_pub) k) THEN
    RETURN false;
  END IF;
  IF v_pub = '{}'::jsonb THEN
    RETURN true;
  END IF;
  SELECT sum((w.value #>> '{}')::int) INTO total FROM jsonb_each(p_weights) w;
  IF total <> 100 THEN
    RAISE EXCEPTION 'funnel_cta_weights_set: the shares add up to %, not 100', total USING ERRCODE = 'check_violation';
  END IF;
  UPDATE pages.funnels f SET cta = pages.cta_list_with(f.cta, p_weights) WHERE f.id = p_funnel;
  RETURN true;
END $$;

-- Removes a CTA from its funnel (which deletes the row); the published ones left are rescaled to 100.
CREATE OR REPLACE FUNCTION pages.funnel_cta_remove(p_cta_id uuid)
RETURNS void
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  v_funnel uuid;
  v_others jsonb;
BEGIN
  SELECT c.funnel_id INTO v_funnel FROM pages.cta c WHERE c.id = p_cta_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'funnel_cta_remove: CTA not found' USING ERRCODE = 'no_data_found';
  END IF;
  PERFORM 1 FROM pages.funnels f WHERE f.id = v_funnel FOR UPDATE;
  v_others := pages.funnel_cta_published(v_funnel) - p_cta_id::text;
  UPDATE pages.funnels f
  SET cta = pages.cta_list_with(f.cta - p_cta_id::text, pages.shares_spread(ARRAY(SELECT jsonb_object_keys(v_others)), v_others, 100))
  WHERE f.id = v_funnel;
END $$;

-- ── Reads ───────────────────────────────────────────────────────────────────

-- The CTAs of the funnels, without the HTML and the content (the screen's list).
CREATE OR REPLACE FUNCTION pages.cta_summary(p_funnel_ids uuid[])
RETURNS TABLE(funnel_id uuid, cta_id uuid, name text, status text, weight integer, visual jsonb, product_color boolean,
              quiz boolean, sections jsonb, bundles jsonb, content_hash text, created_by text,
              created_at timestamptz, updated_at timestamptz)
LANGUAGE sql
STABLE
SET search_path = ''
AS $$
  SELECT c.funnel_id, c.id, c.name, c.status, coalesce((f.cta -> c.id::text ->> 'weight')::int, 0),
         c.visual, c.product_color, c.quiz, c.sections, c.bundles, c.content_hash, c.created_by, c.created_at, c.updated_at
  FROM pages.cta c
  JOIN pages.funnels f ON f.id = c.funnel_id AND f.cta ? c.id::text
  WHERE c.funnel_id = ANY (p_funnel_ids)
  ORDER BY c.funnel_id, c.created_at, c.id
$$;

-- One CTA with everything (the editor).
CREATE OR REPLACE FUNCTION pages.cta_get(p_cta_id uuid)
RETURNS TABLE(funnel_id uuid, cta_id uuid, name text, status text, weight integer, visual jsonb, product_color boolean,
              quiz boolean, sections jsonb, bundles jsonb, content jsonb, html text, content_hash text, created_by text,
              created_at timestamptz, updated_at timestamptz)
LANGUAGE sql
STABLE
SET search_path = ''
AS $$
  SELECT c.funnel_id, c.id, c.name, c.status, coalesce((f.cta -> c.id::text ->> 'weight')::int, 0),
         c.visual, c.product_color, c.quiz, c.sections, c.bundles, c.content, c.html, c.content_hash, c.created_by,
         c.created_at, c.updated_at
  FROM pages.cta c
  JOIN pages.funnels f ON f.id = c.funnel_id
  WHERE c.id = p_cta_id
$$;

-- The HTML of the CTAs asked for, for the delivery server (like pages.content_get): it asks only
-- for the hashes it doesn't have on disk.
CREATE OR REPLACE FUNCTION pages.cta_content_get(p_ids uuid[], p_key text)
RETURNS TABLE(cta_id uuid, content_hash text, html text)
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF NOT pages.server_key_ok(p_key) THEN
    RAISE EXCEPTION 'pages.cta_content_get: invalid key' USING ERRCODE = '28000';
  END IF;
  IF coalesce(cardinality(p_ids), 0) > 50 THEN
    RAISE EXCEPTION 'pages.cta_content_get: at most 50 ids' USING ERRCODE = '22023';
  END IF;
  RETURN QUERY SELECT c.id, c.content_hash, c.html FROM pages.cta c WHERE c.id = ANY (p_ids);
END $$;

-- ── Teeste1, from public.funnel_offers ──────────────────────────────────────

INSERT INTO pages.cta (id, funnel_id, name, status, visual, product_color, quiz, sections, content, created_by, created_at, updated_at)
SELECT o.id, o.funnel_id, o.name, 'DRAFT', o.visual, o.product_color, o.quiz,
       jsonb_build_object('faq', coalesce((o.sections ->> 'faq')::boolean, false),
                          'comments', coalesce((o.sections ->> 'comments')::boolean, false),
                          'science', coalesce((o.sections ->> 'science')::boolean, false),
                          'logos', coalesce((o.sections ->> 'logos')::boolean, false)),
       coalesce((
         SELECT jsonb_strip_nulls(jsonb_build_object(
           'language', pc.content -> 'idioma',
           'titles', pc.content -> 'titulos',
           'faq', (SELECT jsonb_agg(jsonb_build_object('question', q -> 'pergunta', 'answer', q -> 'resposta') ORDER BY n)
                   FROM jsonb_array_elements(pc.content -> 'faq') WITH ORDINALITY AS x(q, n)),
           'comments', (SELECT jsonb_agg(jsonb_build_object('name', q -> 'nome', 'text', q -> 'texto', 'likes', q -> 'curtidas',
                                                            'time', q -> 'tempo')
                                         || CASE WHEN q ? 'foto' THEN jsonb_build_object('photo', q -> 'foto') ELSE '{}'::jsonb END
                                         ORDER BY n)
                        FROM jsonb_array_elements(pc.content -> 'comentarios') WITH ORDINALITY AS x(q, n)),
           'studies', (SELECT jsonb_agg(jsonb_build_object('pmid', q -> 'pmid', 'authors', q -> 'autores', 'year', q -> 'ano',
                                                           'title', q -> 'titulo', 'journal', q -> 'revista', 'type', q -> 'tipo',
                                                           'ingredient', q -> 'ingrediente') ORDER BY n)
                       FROM jsonb_array_elements(pc.content -> 'estudos') WITH ORDINALITY AS x(q, n)),
           'logos', (SELECT jsonb_agg(jsonb_build_object('name', q -> 'nome', 'image', coalesce(q -> 'imagem', 'null'::jsonb)) ORDER BY n)
                     FROM jsonb_array_elements(pc.content -> 'logos') WITH ORDINALITY AS x(q, n)),
           'quiz', CASE WHEN jsonb_typeof(pc.content -> 'quiz') = 'object' THEN jsonb_build_object(
                     'title', pc.content -> 'quiz' -> 'titulo',
                     'subtitle', pc.content -> 'quiz' -> 'subtitulo',
                     'steps', (SELECT jsonb_agg(jsonb_build_object('question', q -> 'pergunta', 'options', q -> 'opcoes') ORDER BY n)
                               FROM jsonb_array_elements(pc.content -> 'quiz' -> 'etapas') WITH ORDINALITY AS x(q, n)),
                     'analyzing', pc.content -> 'quiz' -> 'analisando',
                     'ready', pc.content -> 'quiz' -> 'pronto',
                     'final_button', pc.content -> 'quiz' -> 'botaoFinal',
                     'reminder', pc.content -> 'quiz' -> 'lembrete') END
         ))
         FROM public.product_offer_content pc
         WHERE pc.product_id = 'be2fb1f5-c773-40fa-a051-c80e646fe620'  -- SodaHoneyBoost
       ), '{}'::jsonb),
       o.created_by, o.created_at, o.updated_at
FROM public.funnel_offers o
JOIN pages.funnels f ON f.id = o.funnel_id
WHERE o.id = '1cd202aa-291e-4259-b5bb-ed39edf580dc'
ON CONFLICT (id) DO NOTHING;

UPDATE pages.funnels f
SET cta = f.cta || jsonb_build_object('1cd202aa-291e-4259-b5bb-ed39edf580dc', jsonb_build_object('weight', 100))
WHERE f.id = (SELECT c.funnel_id FROM pages.cta c WHERE c.id = '1cd202aa-291e-4259-b5bb-ed39edf580dc')
  AND NOT (f.cta ? '1cd202aa-291e-4259-b5bb-ed39edf580dc');

-- Only F8 for now.
UPDATE pages.funnels SET cta_enabled = true WHERE upper(code) = 'F8';

-- ── Grants ──────────────────────────────────────────────────────────────────

DO $$
DECLARE
  fn text;
BEGIN
  FOREACH fn IN ARRAY ARRAY[
    'pages.funnel_cta_add(uuid, jsonb, text, text)',
    'pages.cta_save(uuid, jsonb, text, timestamptz)',
    'pages.funnel_cta_publish(uuid, boolean, timestamptz)',
    'pages.funnel_cta_weights_set(uuid, jsonb)',
    'pages.funnel_cta_remove(uuid)',
    'pages.cta_summary(uuid[])',
    'pages.cta_get(uuid)',
    'pages.funnel_cta_published(uuid)',
    'pages.funnel_cta_live(uuid, jsonb)',
    'pages.cta_fields_check(jsonb)',
    'pages.shares_spread(text[], jsonb, int)',
    'pages.shares_set(jsonb, text, int)',
    'pages.cta_list_with(jsonb, jsonb)'
  ] LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM public, anon, authenticated', fn);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role', fn);
  END LOOP;
END $$;
REVOKE ALL ON FUNCTION pages.cta_check() FROM public, anon, authenticated;
REVOKE ALL ON FUNCTION pages.cta_delete_check() FROM public, anon, authenticated;
REVOKE ALL ON FUNCTION pages.funnels_cta_check() FROM public, anon, authenticated;
REVOKE ALL ON FUNCTION pages.funnels_cta_removed() FROM public, anon, authenticated;
REVOKE ALL ON FUNCTION pages.funnels_vsl_check() FROM public, anon, authenticated;
REVOKE ALL ON FUNCTION pages.cta_content_get(uuid[], text) FROM public, authenticated;
GRANT EXECUTE ON FUNCTION pages.cta_content_get(uuid[], text) TO anon, service_role;

NOTIFY pgrst, 'reload schema';
