-- ============================================================================
-- CTA designs with placements, a library of designs, and a funnel's Default / Custom blocks (the
-- owner's plan of 11/10/2026: "o mesmo design funcionaria para vários produtos diferentes";
-- "separasse em dois grupos, Padrão e mais pra baixo Customizado").
--
-- * Placements: a CTA's HTML may carry {{cta.product}} and {{cta.kit<N>.<field>}} (N = the kit's
--   bottle count; fields: bottles, supply, image, price, total, full_total, save, checkout). The
--   delivery server fills them at the pitch from the OFFER of the VSL that is playing, so one design
--   serves every product. pages.cta.placements lists the keys a CTA uses (its trigger fills it); an
--   unknown cta.* key is refused.
-- * Offers: pages.vsl_offers, one per VTurb player: the product and its kits as the player's own
--   VTurb CTA shows them (source 'vturb', extracted) or as typed (source 'manual' — an import never
--   overwrites it). Values are kept as displayed ("6 BOTTLES", "$49") and HTML-escaped when filled.
-- * Jar styles: a design may ask for a jar style (pages.cta.jar_style); pages.cta_jar_photos keeps a
--   product's photos per style ({ "<N>": url }). A product without photos in that style shows the
--   offer's own photo.
-- * Library: a CTA with no funnel (pages.cta.funnel_id NULL) is a design any funnel may use. It is
--   used only while published, and it can't be unpublished or deleted while a funnel uses it.
-- * Blocks: pages.funnels.cta stays the DEFAULT block (it may now list library designs too);
--   pages.funnels.cta_groups are the CUSTOM blocks: [{ id, name, vsls: [player id], product,
--   cta: { "<cta id>": { "weight" } } }]. A VSL is listed by at most one group; a group may also
--   take every VSL of a product (`product`, the offer's, any case) — a listed VSL wins over a
--   product group. Each block's published designs add up to 100. A VSL that no group takes, or
--   whose group has nothing it can show, draws from the Default block.
-- * A design with placements is drawn for a VSL only when the VSL's offer has every key it uses.
--
-- pages.resolve doesn't change: the delivery server asks pages.cta_draw_get for the VSL's block
-- when it draws (and caches the answer). Nothing here changes what a visitor sees: only F8 has
-- cta_enabled, its three CTAs have no placements and no funnel has groups.
-- ============================================================================

-- The locks without queueing (see 20261006b): a pending ACCESS EXCLUSIVE request would stall every
-- reader of pages.funnels / pages.cta (the gate's resolve) behind it.
DO $do$
DECLARE i int := 0;
BEGIN
  LOOP
    BEGIN
      LOCK TABLE pages.funnels, pages.cta IN ACCESS EXCLUSIVE MODE NOWAIT;
      EXIT;
    EXCEPTION WHEN lock_not_available THEN
      i := i + 1;
      IF i >= 60 THEN
        RAISE EXCEPTION 'could not lock pages.funnels and pages.cta in 30 s';
      END IF;
      PERFORM pg_sleep(0.5);
    END;
  END LOOP;
END $do$;

ALTER TABLE pages.funnels
  ADD COLUMN IF NOT EXISTS cta_groups jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS cta_groups_updated_at timestamptz NOT NULL DEFAULT now();

COMMENT ON COLUMN pages.funnels.cta IS
  'The DEFAULT block of the funnel''s CTAs: { "<pages.cta id>": { "weight": 0-100 } } — its own CTAs and library designs. Only published ones hold a share; they add up to 100.';
COMMENT ON COLUMN pages.funnels.cta_groups IS
  'The CUSTOM blocks: [{ id, name, vsls: [VTurb player id], product, cta: { "<pages.cta id>": { "weight" } } }]. A VSL is in at most one group; a product group takes every VSL whose offer is that product.';
COMMENT ON COLUMN pages.funnels.cta_groups_updated_at IS 'The version of cta_groups (optimistic concurrency of the group writes).';

ALTER TABLE pages.cta
  ALTER COLUMN funnel_id DROP NOT NULL,
  ADD COLUMN IF NOT EXISTS jar_style text,
  ADD COLUMN IF NOT EXISTS placements text[] NOT NULL DEFAULT '{}';

COMMENT ON COLUMN pages.cta.funnel_id IS 'The funnel the CTA belongs to; NULL = a design of the library, any funnel may use it.';
COMMENT ON COLUMN pages.cta.jar_style IS 'The jar style the design shows (pages.cta_jar_photos); NULL = the offer''s own photos.';
COMMENT ON COLUMN pages.cta.placements IS 'The {{cta.*}} keys the HTML uses (filled by the trigger): the offer must have them all for the design to be drawn.';

-- ── Offers and jar photos ───────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS pages.vsl_offers (
  player_id   text PRIMARY KEY,
  product     text NOT NULL,
  kits        jsonb NOT NULL DEFAULT '{}'::jsonb,
  source      text NOT NULL DEFAULT 'manual' CHECK (source IN ('vturb', 'manual')),
  source_hash text,
  updated_by  text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE pages.vsl_offers IS
  'The offer of each VSL (VTurb player): the product and its kits, which fill a CTA design''s placements at the pitch.';
COMMENT ON COLUMN pages.vsl_offers.kits IS
  '{ "<bottles>": { bottles, supply, image, price, total, full_total, save, checkout } }: as displayed ("6 BOTTLES", "$49"); image and checkout are URLs.';
COMMENT ON COLUMN pages.vsl_offers.source IS '''vturb'' = extracted from the player''s VTurb CTA (an import refreshes it); ''manual'' = typed (an import leaves it alone).';
COMMENT ON COLUMN pages.vsl_offers.source_hash IS 'md5 of the VTurb CTA HTML it was extracted from.';

CREATE TABLE IF NOT EXISTS pages.cta_jar_photos (
  product    text NOT NULL,
  style      text NOT NULL,
  photos     jsonb NOT NULL,
  updated_by text,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (product, style)
);

COMMENT ON TABLE pages.cta_jar_photos IS
  'A product''s jar photos in a jar style: { "<bottles>": url }. product is the offer''s, upper case.';

ALTER TABLE pages.vsl_offers ENABLE ROW LEVEL SECURITY;
ALTER TABLE pages.cta_jar_photos ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON pages.vsl_offers, pages.cta_jar_photos FROM public, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON pages.vsl_offers, pages.cta_jar_photos TO service_role;

-- The fields of a kit.
CREATE OR REPLACE FUNCTION pages.cta_kit_fields()
RETURNS text[]
LANGUAGE sql
IMMUTABLE
SET search_path = ''
AS $$ SELECT ARRAY['bottles', 'supply', 'image', 'price', 'total', 'full_total', 'save', 'checkout'] $$;

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
         OR (f.key IN ('image', 'checkout') AND (f.value #>> '{}') !~ '^https?://') THEN
        RAISE EXCEPTION 'vsl_offers: invalid field % of kit %', f.key, k.key USING ERRCODE = 'check_violation';
      END IF;
    END LOOP;
  END LOOP;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_pages_vsl_offers_check ON pages.vsl_offers;
CREATE TRIGGER trg_pages_vsl_offers_check BEFORE INSERT OR UPDATE ON pages.vsl_offers
  FOR EACH ROW EXECUTE FUNCTION pages.vsl_offers_check();
DROP TRIGGER IF EXISTS trg_pages_vsl_offers_updated_at ON pages.vsl_offers;
CREATE TRIGGER trg_pages_vsl_offers_updated_at BEFORE UPDATE ON pages.vsl_offers
  FOR EACH ROW EXECUTE FUNCTION pages.set_updated_at();

CREATE OR REPLACE FUNCTION pages.cta_jar_photos_check()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  NEW.product := upper(btrim(coalesce(NEW.product, '')));
  IF length(NEW.product) NOT BETWEEN 1 AND 80 THEN
    RAISE EXCEPTION 'cta_jar_photos: the product must have 1 to 80 characters' USING ERRCODE = 'check_violation';
  END IF;
  IF coalesce(NEW.style, '') !~ '^[a-z0-9][a-z0-9_-]{0,39}$' THEN
    RAISE EXCEPTION 'cta_jar_photos: invalid jar style' USING ERRCODE = 'check_violation';
  END IF;
  IF coalesce(jsonb_typeof(NEW.photos), '') <> 'object' OR NEW.photos = '{}'::jsonb
     OR EXISTS (SELECT 1 FROM jsonb_each(NEW.photos) p
                WHERE p.key !~ '^[1-9][0-9]?$' OR jsonb_typeof(p.value) <> 'string' OR (p.value #>> '{}') !~ '^https?://'
                   OR length(p.value #>> '{}') > 1000) THEN
    RAISE EXCEPTION 'cta_jar_photos: photos must be { "<bottles>": url }' USING ERRCODE = 'check_violation';
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_pages_cta_jar_photos_check ON pages.cta_jar_photos;
CREATE TRIGGER trg_pages_cta_jar_photos_check BEFORE INSERT OR UPDATE ON pages.cta_jar_photos
  FOR EACH ROW EXECUTE FUNCTION pages.cta_jar_photos_check();

-- The placements an offer can fill: cta.product and cta.kit<N>.<field> for every non-empty field.
CREATE OR REPLACE FUNCTION pages.vsl_offer_placements(p_product text, p_kits jsonb)
RETURNS text[]
LANGUAGE sql
IMMUTABLE
SET search_path = ''
AS $$
  SELECT CASE WHEN coalesce(btrim(p_product), '') = '' THEN '{}'::text[] ELSE ARRAY['cta.product'] END
      || coalesce((SELECT array_agg('cta.kit' || k.key || '.' || f.key ORDER BY k.key, f.key)
                   FROM jsonb_each(CASE WHEN jsonb_typeof(p_kits) = 'object' THEN p_kits ELSE '{}'::jsonb END) k,
                        jsonb_each_text(CASE WHEN jsonb_typeof(k.value) = 'object' THEN k.value ELSE '{}'::jsonb END) f
                   WHERE btrim(f.value) <> ''), '{}'::text[])
$$;

-- ── pages.cta: placements, jar style, library ───────────────────────────────

-- The {{cta.*}} keys an HTML uses, sorted.
CREATE OR REPLACE FUNCTION pages.cta_placements_of(p_html text)
RETURNS text[]
LANGUAGE sql
IMMUTABLE
SET search_path = ''
AS $$
  SELECT coalesce(array_agg(DISTINCT m[1] ORDER BY m[1]), '{}'::text[])
  FROM regexp_matches(coalesce(p_html, ''), '\{\{\s*(cta\.[A-Za-z0-9_.]*)\s*\}\}', 'g') AS m
$$;

CREATE OR REPLACE FUNCTION pages.cta_check()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  bad text;
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.funnel_id IS DISTINCT FROM OLD.funnel_id THEN
    RAISE EXCEPTION 'cta: a CTA does not move to another funnel nor to the library' USING ERRCODE = 'check_violation';
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
  NEW.jar_style := nullif(lower(btrim(coalesce(NEW.jar_style, ''))), '');
  IF NEW.jar_style IS NOT NULL AND NEW.jar_style !~ '^[a-z0-9][a-z0-9_-]{0,39}$' THEN
    RAISE EXCEPTION 'cta: invalid jar style' USING ERRCODE = 'check_violation';
  END IF;
  NEW.placements := pages.cta_placements_of(NEW.html);
  SELECT k INTO bad FROM unnest(NEW.placements) k
  WHERE k !~ ('^cta\.(product|kit[1-9][0-9]?\.(' || array_to_string(pages.cta_kit_fields(), '|') || '))$') LIMIT 1;
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION 'cta: unknown placement {{%}}', bad USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.status = 'PUBLISHED' AND btrim(NEW.html) = '' THEN
    RAISE EXCEPTION 'cta: a published CTA needs its HTML' USING ERRCODE = 'check_violation';
  END IF;
  NEW.content_hash := pages.content_hash(NEW.html);
  RETURN NEW;
END $$;

-- Does any group of `p_groups` list CTA `p_cta`?
CREATE OR REPLACE FUNCTION pages.cta_groups_have(p_groups jsonb, p_cta text)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
SET search_path = ''
AS $$
  SELECT EXISTS (SELECT 1 FROM jsonb_array_elements(CASE WHEN jsonb_typeof(p_groups) = 'array' THEN p_groups ELSE '[]'::jsonb END) g
                 WHERE g -> 'cta' ? p_cta)
$$;

-- A CTA still used by a block (its funnel's, or — a library design — any funnel's) is taken out
-- through the functions first.
CREATE OR REPLACE FUNCTION pages.cta_delete_check()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM pages.funnels f
             WHERE (OLD.funnel_id IS NULL OR f.id = OLD.funnel_id)
               AND (f.cta ? OLD.id::text OR pages.cta_groups_have(f.cta_groups, OLD.id::text))) THEN
    RAISE EXCEPTION 'cta: CTA % is still used by a funnel', OLD.id USING ERRCODE = 'foreign_key_violation';
  END IF;
  RETURN OLD;
END $$;

-- ── Blocks ──────────────────────────────────────────────────────────────────

-- Validates one block's list ({ "<cta id>": { "weight" } }): every key a CTA of the funnel or a
-- published library design, weights 0-100, the published ones adding up to 100. Returns how many
-- are published. `p_where` names the block in the messages.
CREATE OR REPLACE FUNCTION pages.cta_block_check(p_funnel uuid, p_list jsonb, p_where text)
RETURNS int
LANGUAGE plpgsql
STABLE
SET search_path = ''
AS $$
DECLARE
  e     record;
  c     record;
  total int := 0;
  n_pub int := 0;
BEGIN
  IF coalesce(jsonb_typeof(p_list), '') <> 'object' THEN
    RAISE EXCEPTION '% must be an object', p_where USING ERRCODE = 'check_violation';
  END IF;
  FOR e IN SELECT key, value FROM jsonb_each(p_list) LOOP
    IF e.key !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
       OR coalesce(jsonb_typeof(e.value), '') <> 'object'
       OR coalesce(e.value ->> 'weight', '') !~ '^\d{1,3}$'
       OR (e.value ->> 'weight')::int > 100 THEN
      RAISE EXCEPTION '%: invalid entry %', p_where, e.key USING ERRCODE = 'check_violation';
    END IF;
    SELECT x.status, x.funnel_id INTO c FROM pages.cta x
    WHERE x.id = e.key::uuid AND (x.funnel_id = p_funnel OR x.funnel_id IS NULL);
    IF NOT FOUND THEN
      RAISE EXCEPTION '%: % is not a CTA of this funnel nor of the library', p_where, e.key USING ERRCODE = 'foreign_key_violation';
    END IF;
    IF c.funnel_id IS NULL AND c.status <> 'PUBLISHED' THEN
      RAISE EXCEPTION '%: the library design % is not published', p_where, e.key USING ERRCODE = 'check_violation';
    END IF;
    IF c.status = 'PUBLISHED' THEN
      n_pub := n_pub + 1;
      total := total + (e.value ->> 'weight')::int;
    END IF;
  END LOOP;
  IF n_pub > 0 AND total <> 100 THEN
    RAISE EXCEPTION '%: the published CTAs add up to %, not 100', p_where, total USING ERRCODE = 'check_violation';
  END IF;
  RETURN n_pub;
END $$;

-- Validates the Default block (pages.funnels.cta) and the groups (pages.funnels.cta_groups); a
-- funnel with a VSL on CTA mode "server" keeps cta_enabled and a published design in the Default
-- block (the fallback of every group). Bumps cta_groups_updated_at when the groups change.
CREATE OR REPLACE FUNCTION pages.funnels_cta_check()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  n_pub    int;
  g        record;
  gid      text;
  v        text;
  prod     text;
  bad      text;
  ids      text[] := '{}';
  vsls     text[] := '{}';
  products text[] := '{}';
BEGIN
  n_pub := pages.cta_block_check(NEW.id, NEW.cta, 'funnels.cta');
  IF coalesce(jsonb_typeof(NEW.cta_groups), '') <> 'array' OR jsonb_array_length(NEW.cta_groups) > 20 THEN
    RAISE EXCEPTION 'funnels.cta_groups must be a list of at most 20 groups' USING ERRCODE = 'check_violation';
  END IF;
  FOR g IN SELECT x.value, x.n FROM jsonb_array_elements(NEW.cta_groups) WITH ORDINALITY AS x(value, n) LOOP
    IF jsonb_typeof(g.value) <> 'object' OR NOT (g.value ?& ARRAY['id', 'name', 'vsls', 'cta']) THEN
      RAISE EXCEPTION 'funnels.cta_groups: group % needs id, name, vsls and cta', g.n USING ERRCODE = 'check_violation';
    END IF;
    SELECT k INTO bad FROM jsonb_object_keys(g.value) k WHERE k NOT IN ('id', 'name', 'vsls', 'product', 'cta') LIMIT 1;
    IF bad IS NOT NULL THEN
      RAISE EXCEPTION 'funnels.cta_groups: unknown key % in group %', bad, g.n USING ERRCODE = 'check_violation';
    END IF;
    gid := g.value ->> 'id';
    IF coalesce(gid, '') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' OR gid = ANY (ids) THEN
      RAISE EXCEPTION 'funnels.cta_groups: invalid or repeated id in group %', g.n USING ERRCODE = 'check_violation';
    END IF;
    ids := ids || gid;
    IF jsonb_typeof(g.value -> 'name') <> 'string' OR length(btrim(g.value ->> 'name')) NOT BETWEEN 1 AND 80 THEN
      RAISE EXCEPTION 'funnels.cta_groups: the name of group % must have 1 to 80 characters', g.n USING ERRCODE = 'check_violation';
    END IF;
    IF jsonb_typeof(g.value -> 'vsls') <> 'array' OR jsonb_array_length(g.value -> 'vsls') > 200
       OR EXISTS (SELECT 1 FROM jsonb_array_elements(g.value -> 'vsls') e
                  WHERE jsonb_typeof(e) <> 'string' OR (e #>> '{}') !~ '^[0-9a-f]{24}$') THEN
      RAISE EXCEPTION 'funnels.cta_groups: invalid VSLs in group "%"', g.value ->> 'name' USING ERRCODE = 'check_violation';
    END IF;
    FOR v IN SELECT jsonb_array_elements_text(g.value -> 'vsls') LOOP
      IF v = ANY (vsls) THEN
        RAISE EXCEPTION 'funnels.cta_groups: VSL % is in two groups', v USING ERRCODE = 'check_violation';
      END IF;
      vsls := vsls || v;
    END LOOP;
    IF coalesce(jsonb_typeof(g.value -> 'product'), 'null') NOT IN ('string', 'null') THEN
      RAISE EXCEPTION 'funnels.cta_groups: invalid product in group "%"', g.value ->> 'name' USING ERRCODE = 'check_violation';
    END IF;
    prod := upper(btrim(g.value ->> 'product'));
    IF prod IS NOT NULL THEN
      IF length(prod) NOT BETWEEN 1 AND 80 THEN
        RAISE EXCEPTION 'funnels.cta_groups: invalid product in group "%"', g.value ->> 'name' USING ERRCODE = 'check_violation';
      END IF;
      IF prod = ANY (products) THEN
        RAISE EXCEPTION 'funnels.cta_groups: product % is in two groups', g.value ->> 'product' USING ERRCODE = 'check_violation';
      END IF;
      products := products || prod;
    END IF;
    PERFORM pages.cta_block_check(NEW.id, g.value -> 'cta', format('funnels.cta_groups "%s"', btrim(g.value ->> 'name')));
  END LOOP;
  IF EXISTS (SELECT 1 FROM jsonb_each(NEW.vsl) x WHERE x.value ->> 'cta' = 'server')
     AND (NOT NEW.cta_enabled OR n_pub = 0) THEN
    RAISE EXCEPTION 'funnels.cta: the funnel has VSLs with the CTA from the server — switch them to VTurb first'
      USING ERRCODE = 'check_violation';
  END IF;
  -- clock_timestamp, not now(): two writes in one transaction still get different versions.
  IF TG_OP = 'UPDATE' AND NEW.cta_groups IS DISTINCT FROM OLD.cta_groups THEN
    NEW.cta_groups_updated_at := clock_timestamp();
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_pages_funnels_cta_check ON pages.funnels;
CREATE TRIGGER trg_pages_funnels_cta_check BEFORE INSERT OR UPDATE OF cta, cta_enabled, cta_groups ON pages.funnels
  FOR EACH ROW EXECUTE FUNCTION pages.funnels_cta_check();

-- True when the Default block `p_list` of funnel `p_funnel` has a published design.
CREATE OR REPLACE FUNCTION pages.funnel_cta_live(p_funnel uuid, p_list jsonb)
RETURNS boolean
LANGUAGE sql
STABLE
SET search_path = ''
AS $$
  SELECT EXISTS (
    SELECT 1 FROM pages.cta c
    WHERE (c.funnel_id = p_funnel OR c.funnel_id IS NULL) AND c.status = 'PUBLISHED' AND p_list ? c.id::text
  )
$$;

-- { cta id: weight } of the Default block's published designs, as the list holds them now.
CREATE OR REPLACE FUNCTION pages.funnel_cta_published(p_funnel uuid)
RETURNS jsonb
LANGUAGE sql
STABLE
SET search_path = ''
AS $$
  SELECT coalesce(jsonb_object_agg(c.id::text, coalesce((f.cta -> c.id::text ->> 'weight')::int, 0)), '{}'::jsonb)
  FROM pages.funnels f
  JOIN pages.cta c ON (c.funnel_id = f.id OR c.funnel_id IS NULL) AND f.cta ? c.id::text
  WHERE f.id = p_funnel AND c.status = 'PUBLISHED'
$$;

-- The published designs of a block's list, in the order they were created.
CREATE OR REPLACE FUNCTION pages.cta_block_published(p_funnel uuid, p_list jsonb)
RETURNS text[]
LANGUAGE sql
STABLE
SET search_path = ''
AS $$
  SELECT coalesce(array_agg(c.id::text ORDER BY c.created_at, c.id), '{}'::text[])
  FROM pages.cta c
  WHERE p_list ? c.id::text AND (c.funnel_id = p_funnel OR c.funnel_id IS NULL) AND c.status = 'PUBLISHED'
$$;

-- `p_list` with its published designs `p_pub` sharing 100: `p_join` (one of them) joins with 100/n
-- and the others shrink in proportion; without `p_join` they are rescaled to 100 in the proportion
-- they had (all 0 = equal parts). Entries not in `p_pub` keep their weight (a draft's is ignored).
CREATE OR REPLACE FUNCTION pages.cta_block_rebalance(p_list jsonb, p_pub text[], p_join text)
RETURNS jsonb
LANGUAGE sql
IMMUTABLE
SET search_path = ''
AS $$
  SELECT CASE
    WHEN coalesce(cardinality(p_pub), 0) = 0 THEN p_list
    WHEN p_join IS NOT NULL THEN pages.cta_list_with(p_list, pages.shares_set(
      (SELECT jsonb_object_agg(k, CASE WHEN k = p_join THEN 0 ELSE coalesce((p_list -> k ->> 'weight')::int, 0) END) FROM unnest(p_pub) k),
      p_join, round(100.0 / cardinality(p_pub))::int))
    ELSE pages.cta_list_with(p_list, pages.shares_spread(p_pub,
      (SELECT jsonb_object_agg(k, coalesce((p_list -> k ->> 'weight')::int, 0)) FROM unnest(p_pub) k), 100))
  END
$$;

-- The groups with CTA `p_cta`'s change applied to every group that lists it: it joins (just
-- published) or the rest is rescaled (just unpublished).
CREATE OR REPLACE FUNCTION pages.cta_groups_rebalance(p_funnel uuid, p_groups jsonb, p_cta text, p_join boolean)
RETURNS jsonb
LANGUAGE sql
STABLE
SET search_path = ''
AS $$
  SELECT coalesce(jsonb_agg(CASE WHEN g.value -> 'cta' ? p_cta
           THEN g.value || jsonb_build_object('cta', pages.cta_block_rebalance(g.value -> 'cta',
                  pages.cta_block_published(p_funnel, g.value -> 'cta'), CASE WHEN p_join THEN p_cta END))
           ELSE g.value END ORDER BY g.n), '[]'::jsonb)
  FROM jsonb_array_elements(p_groups) WITH ORDINALITY AS g(value, n)
$$;

-- The groups without CTA `p_cta` (`p_group` NULL = every group; otherwise that one), the rest of
-- each rescaled to 100.
CREATE OR REPLACE FUNCTION pages.cta_groups_without(p_funnel uuid, p_groups jsonb, p_cta text, p_group text DEFAULT NULL)
RETURNS jsonb
LANGUAGE sql
STABLE
SET search_path = ''
AS $$
  SELECT coalesce(jsonb_agg(CASE WHEN g.value -> 'cta' ? p_cta AND (p_group IS NULL OR g.value ->> 'id' = p_group)
           THEN g.value || jsonb_build_object('cta', pages.cta_block_rebalance((g.value -> 'cta') - p_cta,
                  array_remove(pages.cta_block_published(p_funnel, g.value -> 'cta'), p_cta), NULL))
           ELSE g.value END ORDER BY g.n), '[]'::jsonb)
  FROM jsonb_array_elements(p_groups) WITH ORDINALITY AS g(value, n)
$$;

-- ── Writes (the dashboards; service_role) ───────────────────────────────────

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
  WHERE k NOT IN ('name', 'visual', 'product_color', 'quiz', 'sections', 'cards_html', 'content', 'jar_style') LIMIT 1;
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION 'cta: unknown field %', bad USING ERRCODE = '22023';
  END IF;
  IF p_cta ? 'cards_html' AND jsonb_typeof(p_cta -> 'cards_html') <> 'string' THEN
    RAISE EXCEPTION 'cta: cards_html must be a string' USING ERRCODE = '22023';
  END IF;
  IF p_cta ? 'jar_style' AND jsonb_typeof(p_cta -> 'jar_style') NOT IN ('string', 'null') THEN
    RAISE EXCEPTION 'cta: jar_style must be a string or null' USING ERRCODE = '22023';
  END IF;
END $$;

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
  INSERT INTO pages.cta (funnel_id, name, visual, product_color, quiz, sections, cards_html, content, html, jar_style, created_by)
  VALUES (p_funnel,
          p_cta ->> 'name',
          coalesce(p_cta -> 'visual', '{}'::jsonb),
          coalesce((p_cta ->> 'product_color')::boolean, false),
          coalesce((p_cta ->> 'quiz')::boolean, false),
          coalesce(p_cta -> 'sections', '{"faq": false, "comments": false, "science": false, "logos": false}'::jsonb),
          coalesce(p_cta ->> 'cards_html', ''),
          coalesce(p_cta -> 'content', '{}'::jsonb),
          coalesce(p_html, ''),
          p_cta ->> 'jar_style',
          p_created_by)
  RETURNING id INTO v_id;
  UPDATE pages.funnels f SET cta = f.cta || jsonb_build_object(v_id::text, jsonb_build_object('weight', 0))
  WHERE f.id = p_funnel;
  RETURN v_id;
END $$;

-- A new design in the library, a draft. Returns its id.
CREATE OR REPLACE FUNCTION pages.cta_library_add(p_cta jsonb, p_html text DEFAULT '', p_created_by text DEFAULT NULL)
RETURNS uuid
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  v_id uuid;
BEGIN
  PERFORM pages.cta_fields_check(p_cta);
  INSERT INTO pages.cta (funnel_id, name, visual, product_color, quiz, sections, cards_html, content, html, jar_style, created_by)
  VALUES (NULL,
          p_cta ->> 'name',
          coalesce(p_cta -> 'visual', '{}'::jsonb),
          coalesce((p_cta ->> 'product_color')::boolean, false),
          coalesce((p_cta ->> 'quiz')::boolean, false),
          coalesce(p_cta -> 'sections', '{"faq": false, "comments": false, "science": false, "logos": false}'::jsonb),
          coalesce(p_cta ->> 'cards_html', ''),
          coalesce(p_cta -> 'content', '{}'::jsonb),
          coalesce(p_html, ''),
          p_cta ->> 'jar_style',
          p_created_by)
  RETURNING id INTO v_id;
  RETURN v_id;
END $$;

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
    cards_html    = coalesce(p_cta ->> 'cards_html', c.cards_html),
    content       = coalesce(p_cta -> 'content', c.content),
    jar_style     = CASE WHEN p_cta ? 'jar_style' THEN p_cta ->> 'jar_style' ELSE c.jar_style END,
    html          = coalesce(p_html, c.html)
  WHERE c.id = p_cta_id
  RETURNING c.updated_at INTO v_at;
  RETURN v_at;
END $$;

-- Publishes (joins its blocks with 100/n, the others shrink) or unpublishes (the rest of each block
-- is rescaled to 100) a CTA of a funnel, over the version the screen loaded. Returns the new
-- updated_at; NULL = it changed meanwhile.
CREATE OR REPLACE FUNCTION pages.funnel_cta_publish(p_cta_id uuid, p_published boolean, p_expected timestamptz)
RETURNS timestamptz
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  v_funnel uuid;
  v_at     timestamptz;
  v_status text;
BEGIN
  SELECT c.funnel_id INTO v_funnel FROM pages.cta c WHERE c.id = p_cta_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'funnel_cta_publish: CTA not found' USING ERRCODE = 'no_data_found';
  END IF;
  IF v_funnel IS NULL THEN
    RAISE EXCEPTION 'funnel_cta_publish: a library design is published with cta_library_publish' USING ERRCODE = '22023';
  END IF;
  PERFORM 1 FROM pages.funnels f WHERE f.id = v_funnel FOR UPDATE;
  SELECT c.updated_at, c.status INTO v_at, v_status FROM pages.cta c WHERE c.id = p_cta_id FOR UPDATE;
  IF v_at IS DISTINCT FROM p_expected THEN
    RETURN NULL;
  END IF;
  IF (v_status = 'PUBLISHED') = p_published THEN
    RETURN v_at;
  END IF;
  UPDATE pages.cta c SET status = CASE WHEN p_published THEN 'PUBLISHED' ELSE 'DRAFT' END
  WHERE c.id = p_cta_id
  RETURNING c.updated_at INTO v_at;
  UPDATE pages.funnels f SET
    cta = pages.cta_block_rebalance(f.cta, pages.cta_block_published(f.id, f.cta), CASE WHEN p_published THEN p_cta_id::text END),
    cta_groups = pages.cta_groups_rebalance(f.id, f.cta_groups, p_cta_id::text, p_published)
  WHERE f.id = v_funnel;
  RETURN v_at;
END $$;

-- The shares of a block's published designs ({ id: 0-100 }, adding up to 100): the Default block
-- (`p_group` NULL) or one group. False = the set of published designs (or the group) changed
-- meanwhile (reload).
DROP FUNCTION IF EXISTS pages.funnel_cta_weights_set(uuid, jsonb);
CREATE FUNCTION pages.funnel_cta_weights_set(p_funnel uuid, p_weights jsonb, p_group uuid DEFAULT NULL)
RETURNS boolean
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  v_list jsonb;
  v_pub  text[];
  total  int;
BEGIN
  IF coalesce(jsonb_typeof(p_weights), '') <> 'object'
     OR EXISTS (SELECT 1 FROM jsonb_each(p_weights) w
                WHERE jsonb_typeof(w.value) <> 'number' OR (w.value #>> '{}') !~ '^\d{1,3}$' OR (w.value #>> '{}')::int > 100) THEN
    RAISE EXCEPTION 'funnel_cta_weights_set: weights must be { "<cta id>": 0-100 }' USING ERRCODE = '22023';
  END IF;
  SELECT CASE WHEN p_group IS NULL THEN f.cta
              ELSE (SELECT g -> 'cta' FROM jsonb_array_elements(f.cta_groups) g WHERE g ->> 'id' = p_group::text) END
  INTO v_list
  FROM pages.funnels f WHERE f.id = p_funnel FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'funnel_cta_weights_set: funnel not found' USING ERRCODE = 'no_data_found';
  END IF;
  IF v_list IS NULL THEN
    RETURN false;
  END IF;
  v_pub := pages.cta_block_published(p_funnel, v_list);
  IF (SELECT coalesce(array_agg(k ORDER BY k), '{}'::text[]) FROM jsonb_object_keys(p_weights) k)
     IS DISTINCT FROM (SELECT coalesce(array_agg(k ORDER BY k), '{}'::text[]) FROM unnest(v_pub) k) THEN
    RETURN false;
  END IF;
  IF cardinality(v_pub) = 0 THEN
    RETURN true;
  END IF;
  SELECT sum((w.value #>> '{}')::int) INTO total FROM jsonb_each(p_weights) w;
  IF total <> 100 THEN
    RAISE EXCEPTION 'funnel_cta_weights_set: the shares add up to %, not 100', total USING ERRCODE = 'check_violation';
  END IF;
  IF p_group IS NULL THEN
    UPDATE pages.funnels f SET cta = pages.cta_list_with(f.cta, p_weights) WHERE f.id = p_funnel;
  ELSE
    UPDATE pages.funnels f SET cta_groups = (
      SELECT jsonb_agg(CASE WHEN g.value ->> 'id' = p_group::text
                            THEN g.value || jsonb_build_object('cta', pages.cta_list_with(g.value -> 'cta', p_weights))
                            ELSE g.value END ORDER BY g.n)
      FROM jsonb_array_elements(f.cta_groups) WITH ORDINALITY AS g(value, n))
    WHERE f.id = p_funnel;
  END IF;
  RETURN true;
END $$;

-- Removes a CTA of a funnel from the funnel (which deletes the row) and from its groups; the
-- published ones left in each block are rescaled to 100.
CREATE OR REPLACE FUNCTION pages.funnel_cta_remove(p_cta_id uuid)
RETURNS void
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  v_funnel uuid;
BEGIN
  SELECT c.funnel_id INTO v_funnel FROM pages.cta c WHERE c.id = p_cta_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'funnel_cta_remove: CTA not found' USING ERRCODE = 'no_data_found';
  END IF;
  IF v_funnel IS NULL THEN
    RAISE EXCEPTION 'funnel_cta_remove: a library design is taken out with funnel_cta_unuse and deleted with cta_library_delete'
      USING ERRCODE = '22023';
  END IF;
  PERFORM 1 FROM pages.funnels f WHERE f.id = v_funnel FOR UPDATE;
  UPDATE pages.funnels f SET
    cta_groups = pages.cta_groups_without(f.id, f.cta_groups, p_cta_id::text),
    cta = pages.cta_block_rebalance(f.cta - p_cta_id::text,
                                    array_remove(pages.cta_block_published(f.id, f.cta), p_cta_id::text), NULL)
  WHERE f.id = v_funnel;
END $$;

-- The funnels and blocks that use a CTA: [{ funnel_id, code, block: "default" | <group id>, group_name, weight }].
CREATE OR REPLACE FUNCTION pages.cta_used_by(p_cta uuid)
RETURNS jsonb
LANGUAGE sql
STABLE
SET search_path = ''
AS $$
  SELECT coalesce(jsonb_agg(u ORDER BY u ->> 'code', u ->> 'block'), '[]'::jsonb)
  FROM (
    SELECT jsonb_build_object('funnel_id', f.id, 'code', f.code, 'block', 'default',
                              'weight', coalesce((f.cta -> p_cta::text ->> 'weight')::int, 0)) AS u
    FROM pages.funnels f WHERE f.cta ? p_cta::text
    UNION ALL
    SELECT jsonb_build_object('funnel_id', f.id, 'code', f.code, 'block', g ->> 'id', 'group_name', g ->> 'name',
                              'weight', coalesce((g -> 'cta' -> p_cta::text ->> 'weight')::int, 0))
    FROM pages.funnels f, jsonb_array_elements(f.cta_groups) g
    WHERE g -> 'cta' ? p_cta::text
  ) x
$$;

-- Publishes or unpublishes a library design, over the version the screen loaded. A design in use
-- is not unpublished (take it out of the funnels first). Returns the new updated_at; NULL = it
-- changed meanwhile.
CREATE OR REPLACE FUNCTION pages.cta_library_publish(p_cta_id uuid, p_published boolean, p_expected timestamptz)
RETURNS timestamptz
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  v_funnel uuid;
  v_at     timestamptz;
  v_status text;
  v_used   text;
BEGIN
  SELECT c.funnel_id, c.updated_at, c.status INTO v_funnel, v_at, v_status FROM pages.cta c WHERE c.id = p_cta_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'cta_library_publish: CTA not found' USING ERRCODE = 'no_data_found';
  END IF;
  IF v_funnel IS NOT NULL THEN
    RAISE EXCEPTION 'cta_library_publish: a funnel''s CTA is published with funnel_cta_publish' USING ERRCODE = '22023';
  END IF;
  IF v_at IS DISTINCT FROM p_expected THEN
    RETURN NULL;
  END IF;
  IF (v_status = 'PUBLISHED') = p_published THEN
    RETURN v_at;
  END IF;
  IF NOT p_published THEN
    SELECT string_agg(DISTINCT u ->> 'code', ', ') INTO v_used FROM jsonb_array_elements(pages.cta_used_by(p_cta_id)) u;
    IF v_used IS NOT NULL THEN
      RAISE EXCEPTION 'cta: the design is used by % — take it out there first', v_used USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  UPDATE pages.cta c SET status = CASE WHEN p_published THEN 'PUBLISHED' ELSE 'DRAFT' END
  WHERE c.id = p_cta_id
  RETURNING c.updated_at INTO v_at;
  RETURN v_at;
END $$;

-- Deletes a library design that no funnel uses.
CREATE OR REPLACE FUNCTION pages.cta_library_delete(p_cta_id uuid)
RETURNS void
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  v_funnel uuid;
BEGIN
  SELECT c.funnel_id INTO v_funnel FROM pages.cta c WHERE c.id = p_cta_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'cta_library_delete: CTA not found' USING ERRCODE = 'no_data_found';
  END IF;
  IF v_funnel IS NOT NULL THEN
    RAISE EXCEPTION 'cta_library_delete: a funnel''s CTA is removed with funnel_cta_remove' USING ERRCODE = '22023';
  END IF;
  DELETE FROM pages.cta c WHERE c.id = p_cta_id;
END $$;

-- Puts a design in a block of the funnel: the Default block (`p_group` NULL) or a group. A library
-- design must be published; a published one joins the block with 100/n (the others shrink). A
-- CTA of the funnel is always in its Default block; it may also go in groups. Already there = no-op.
CREATE OR REPLACE FUNCTION pages.funnel_cta_use(p_funnel uuid, p_cta uuid, p_group uuid DEFAULT NULL)
RETURNS void
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  f      record;
  c      record;
  v_join text;
BEGIN
  SELECT x.id, x.cta, x.cta_groups INTO f FROM pages.funnels x WHERE x.id = p_funnel FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'funnel_cta_use: funnel not found' USING ERRCODE = 'no_data_found';
  END IF;
  -- FOR SHARE: a concurrent cta_library_publish(false) waits, then sees the design in use.
  SELECT x.funnel_id, x.status INTO c FROM pages.cta x WHERE x.id = p_cta FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'funnel_cta_use: CTA not found' USING ERRCODE = 'no_data_found';
  END IF;
  IF c.funnel_id IS NOT NULL AND c.funnel_id <> p_funnel THEN
    RAISE EXCEPTION 'funnel_cta_use: the CTA belongs to another funnel' USING ERRCODE = 'check_violation';
  END IF;
  IF c.funnel_id IS NULL AND c.status <> 'PUBLISHED' THEN
    RAISE EXCEPTION 'funnel_cta_use: publish the design in the library first' USING ERRCODE = 'check_violation';
  END IF;
  v_join := CASE WHEN c.status = 'PUBLISHED' THEN p_cta::text END;
  IF p_group IS NULL THEN
    IF f.cta ? p_cta::text THEN
      RETURN;
    END IF;
    UPDATE pages.funnels x SET cta = pages.cta_block_rebalance(
      x.cta || jsonb_build_object(p_cta::text, jsonb_build_object('weight', 0)),
      pages.cta_block_published(x.id, x.cta || jsonb_build_object(p_cta::text, jsonb_build_object('weight', 0))), v_join)
    WHERE x.id = p_funnel;
    RETURN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM jsonb_array_elements(f.cta_groups) g WHERE g ->> 'id' = p_group::text) THEN
    RAISE EXCEPTION 'funnel_cta_use: group not found' USING ERRCODE = 'no_data_found';
  END IF;
  UPDATE pages.funnels x SET cta_groups = (
    SELECT jsonb_agg(CASE WHEN g.value ->> 'id' = p_group::text AND NOT (g.value -> 'cta' ? p_cta::text)
                          THEN g.value || jsonb_build_object('cta', pages.cta_block_rebalance(
                                 (g.value -> 'cta') || jsonb_build_object(p_cta::text, jsonb_build_object('weight', 0)),
                                 pages.cta_block_published(x.id, (g.value -> 'cta') || jsonb_build_object(p_cta::text, jsonb_build_object('weight', 0))),
                                 v_join))
                          ELSE g.value END ORDER BY g.n)
    FROM jsonb_array_elements(x.cta_groups) WITH ORDINALITY AS g(value, n))
  WHERE x.id = p_funnel;
END $$;

-- Takes a design out of a block: a library design out of the Default block (`p_group` NULL), or
-- any design out of a group; the rest is rescaled to 100. (A CTA of the funnel leaves its Default
-- block only by funnel_cta_remove.) Not there = no-op.
CREATE OR REPLACE FUNCTION pages.funnel_cta_unuse(p_funnel uuid, p_cta uuid, p_group uuid DEFAULT NULL)
RETURNS void
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  f record;
BEGIN
  SELECT x.id, x.cta INTO f FROM pages.funnels x WHERE x.id = p_funnel FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'funnel_cta_unuse: funnel not found' USING ERRCODE = 'no_data_found';
  END IF;
  IF p_group IS NULL THEN
    IF NOT (f.cta ? p_cta::text) THEN
      RETURN;
    END IF;
    IF EXISTS (SELECT 1 FROM pages.cta c WHERE c.id = p_cta AND c.funnel_id = p_funnel) THEN
      RAISE EXCEPTION 'funnel_cta_unuse: a CTA of the funnel is removed with funnel_cta_remove' USING ERRCODE = '22023';
    END IF;
    UPDATE pages.funnels x SET cta = pages.cta_block_rebalance(x.cta - p_cta::text,
      array_remove(pages.cta_block_published(x.id, x.cta), p_cta::text), NULL)
    WHERE x.id = p_funnel;
    RETURN;
  END IF;
  UPDATE pages.funnels x SET cta_groups = pages.cta_groups_without(x.id, x.cta_groups, p_cta::text, p_group::text)
  WHERE x.id = p_funnel;
END $$;

-- Creates (no `id`) or changes a group, over the version of the groups the screen loaded:
-- { id?, name, vsls, product, cta } — the keys left out keep what the group had. Returns
-- { id, updated_at }; NULL = the groups changed meanwhile (reload). A VSL already in another group
-- is refused (take it out there first).
CREATE OR REPLACE FUNCTION pages.funnel_cta_group_save(p_funnel uuid, p_group jsonb, p_expected timestamptz)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  f     record;
  bad   text;
  v_id  text;
  v_old jsonb;
  v_new jsonb;
  v_at  timestamptz;
BEGIN
  IF coalesce(jsonb_typeof(p_group), '') <> 'object' THEN
    RAISE EXCEPTION 'funnel_cta_group_save: the group must be an object' USING ERRCODE = '22023';
  END IF;
  SELECT k INTO bad FROM jsonb_object_keys(p_group) k WHERE k NOT IN ('id', 'name', 'vsls', 'product', 'cta') LIMIT 1;
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION 'funnel_cta_group_save: unknown key %', bad USING ERRCODE = '22023';
  END IF;
  IF p_group ? 'vsls' AND jsonb_typeof(p_group -> 'vsls') <> 'array' THEN
    RAISE EXCEPTION 'funnel_cta_group_save: vsls must be a list' USING ERRCODE = '22023';
  END IF;
  SELECT x.id, x.cta_groups, x.cta_groups_updated_at INTO f FROM pages.funnels x WHERE x.id = p_funnel FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'funnel_cta_group_save: funnel not found' USING ERRCODE = 'no_data_found';
  END IF;
  IF f.cta_groups_updated_at IS DISTINCT FROM p_expected THEN
    RETURN NULL;
  END IF;
  v_id := p_group ->> 'id';
  IF v_id IS NOT NULL THEN
    SELECT g INTO v_old FROM jsonb_array_elements(f.cta_groups) g WHERE g ->> 'id' = v_id;
    IF v_old IS NULL THEN
      RETURN NULL;
    END IF;
  ELSE
    v_id := gen_random_uuid()::text;
    v_old := jsonb_build_object('vsls', '[]'::jsonb, 'product', NULL, 'cta', '{}'::jsonb);
  END IF;
  v_new := jsonb_build_object(
    'id', v_id,
    'name', btrim(coalesce(p_group ->> 'name', v_old ->> 'name', '')),
    'vsls', CASE WHEN p_group ? 'vsls'
                 THEN (SELECT coalesce(jsonb_agg(DISTINCT lower(btrim(x))), '[]'::jsonb) FROM jsonb_array_elements_text(p_group -> 'vsls') x)
                 ELSE v_old -> 'vsls' END,
    'product', CASE WHEN p_group ? 'product' THEN to_jsonb(nullif(btrim(p_group ->> 'product'), '')) ELSE coalesce(v_old -> 'product', 'null'::jsonb) END,
    'cta', coalesce(p_group -> 'cta', v_old -> 'cta', '{}'::jsonb));
  UPDATE pages.funnels x SET cta_groups = CASE
      WHEN p_group ? 'id' THEN (SELECT jsonb_agg(CASE WHEN g.value ->> 'id' = v_id THEN v_new ELSE g.value END ORDER BY g.n)
                                FROM jsonb_array_elements(x.cta_groups) WITH ORDINALITY AS g(value, n))
      ELSE x.cta_groups || jsonb_build_array(v_new) END
  WHERE x.id = p_funnel
  RETURNING x.cta_groups_updated_at INTO v_at;
  RETURN jsonb_build_object('id', v_id, 'updated_at', v_at);
END $$;

-- Deletes a group (its VSLs go back to the Default block), over the version the screen loaded.
-- Returns the new version; NULL = the groups changed meanwhile.
CREATE OR REPLACE FUNCTION pages.funnel_cta_group_delete(p_funnel uuid, p_group uuid, p_expected timestamptz)
RETURNS timestamptz
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  f    record;
  v_at timestamptz;
BEGIN
  SELECT x.id, x.cta_groups, x.cta_groups_updated_at INTO f FROM pages.funnels x WHERE x.id = p_funnel FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'funnel_cta_group_delete: funnel not found' USING ERRCODE = 'no_data_found';
  END IF;
  IF f.cta_groups_updated_at IS DISTINCT FROM p_expected THEN
    RETURN NULL;
  END IF;
  UPDATE pages.funnels x SET cta_groups = (
    SELECT coalesce(jsonb_agg(g.value ORDER BY g.n), '[]'::jsonb)
    FROM jsonb_array_elements(x.cta_groups) WITH ORDINALITY AS g(value, n)
    WHERE g.value ->> 'id' <> p_group::text)
  WHERE x.id = p_funnel
  RETURNING x.cta_groups_updated_at INTO v_at;
  RETURN v_at;
END $$;

-- An offer typed by hand (source 'manual': imports leave it alone). Returns its updated_at.
CREATE OR REPLACE FUNCTION pages.vsl_offer_set(p_player text, p_offer jsonb, p_by text DEFAULT NULL)
RETURNS timestamptz
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  v_at timestamptz;
BEGIN
  IF coalesce(jsonb_typeof(p_offer), '') <> 'object' OR EXISTS (SELECT 1 FROM jsonb_object_keys(p_offer) k WHERE k NOT IN ('product', 'kits')) THEN
    RAISE EXCEPTION 'vsl_offer_set: the offer must be { product, kits }' USING ERRCODE = '22023';
  END IF;
  INSERT INTO pages.vsl_offers AS o (player_id, product, kits, source, source_hash, updated_by)
  VALUES (p_player, p_offer ->> 'product', coalesce(p_offer -> 'kits', '{}'::jsonb), 'manual', NULL, p_by)
  ON CONFLICT (player_id) DO UPDATE SET product = EXCLUDED.product, kits = EXCLUDED.kits, source = 'manual',
                                        source_hash = NULL, updated_by = EXCLUDED.updated_by
  RETURNING o.updated_at INTO v_at;
  RETURN v_at;
END $$;

-- Offers extracted from the players' VTurb CTAs: [{ player_id, product, kits, source_hash }] (at most
-- 1000). A manual offer is left alone; an extracted one only changes when its source changed.
-- Returns how many rows were written.
CREATE OR REPLACE FUNCTION pages.vsl_offers_import(p_rows jsonb, p_by text DEFAULT NULL)
RETURNS int
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  n int;
BEGIN
  IF coalesce(jsonb_typeof(p_rows), '') <> 'array' OR jsonb_array_length(p_rows) > 1000 THEN
    RAISE EXCEPTION 'vsl_offers_import: rows must be a list of at most 1000' USING ERRCODE = '22023';
  END IF;
  INSERT INTO pages.vsl_offers AS o (player_id, product, kits, source, source_hash, updated_by)
  SELECT r ->> 'player_id', r ->> 'product', coalesce(r -> 'kits', '{}'::jsonb), 'vturb', r ->> 'source_hash', p_by
  FROM jsonb_array_elements(p_rows) r
  ON CONFLICT (player_id) DO UPDATE SET product = EXCLUDED.product, kits = EXCLUDED.kits,
                                        source_hash = EXCLUDED.source_hash, updated_by = EXCLUDED.updated_by
    WHERE o.source = 'vturb' AND o.source_hash IS DISTINCT FROM EXCLUDED.source_hash;
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END $$;

CREATE OR REPLACE FUNCTION pages.vsl_offer_delete(p_player text)
RETURNS void
LANGUAGE sql
SET search_path = ''
AS $$ DELETE FROM pages.vsl_offers o WHERE o.player_id = p_player $$;

-- A product's jar photos in a style ({ "<bottles>": url }); NULL or {} deletes them.
CREATE OR REPLACE FUNCTION pages.cta_jar_photos_set(p_product text, p_style text, p_photos jsonb, p_by text DEFAULT NULL)
RETURNS void
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  IF p_photos IS NULL OR p_photos = '{}'::jsonb THEN
    DELETE FROM pages.cta_jar_photos j WHERE j.product = upper(btrim(p_product)) AND j.style = lower(btrim(p_style));
    RETURN;
  END IF;
  INSERT INTO pages.cta_jar_photos AS j (product, style, photos, updated_by)
  VALUES (p_product, lower(btrim(p_style)), p_photos, p_by)
  ON CONFLICT (product, style) DO UPDATE SET photos = EXCLUDED.photos, updated_by = EXCLUDED.updated_by;
END $$;

-- ── Reads (the dashboards) ──────────────────────────────────────────────────

-- The Default block's CTAs of the funnels (the funnel's own and the library designs it lists),
-- without the HTML and the content.
DROP FUNCTION IF EXISTS pages.cta_summary(uuid[]);
CREATE FUNCTION pages.cta_summary(p_funnel_ids uuid[])
RETURNS TABLE(funnel_id uuid, cta_id uuid, name text, status text, weight integer, visual jsonb, product_color boolean,
              quiz boolean, sections jsonb, has_cards boolean, has_content boolean, content_hash text, created_by text,
              created_at timestamptz, updated_at timestamptz, library boolean, jar_style text, placements text[])
LANGUAGE sql
STABLE
SET search_path = ''
AS $$
  SELECT f.id, c.id, c.name, c.status, coalesce((f.cta -> c.id::text ->> 'weight')::int, 0),
         c.visual, c.product_color, c.quiz, c.sections, btrim(c.cards_html) <> '', c.content <> '{}'::jsonb,
         c.content_hash, c.created_by, c.created_at, c.updated_at, c.funnel_id IS NULL, c.jar_style, c.placements
  FROM pages.funnels f
  JOIN pages.cta c ON f.cta ? c.id::text AND (c.funnel_id = f.id OR c.funnel_id IS NULL)
  WHERE f.id = ANY (p_funnel_ids)
  ORDER BY f.id, c.created_at, c.id
$$;

-- One CTA with everything (the editor). funnel_id NULL = a library design.
DROP FUNCTION IF EXISTS pages.cta_get(uuid);
CREATE FUNCTION pages.cta_get(p_cta_id uuid)
RETURNS TABLE(funnel_id uuid, cta_id uuid, name text, status text, weight integer, visual jsonb, product_color boolean,
              quiz boolean, sections jsonb, cards_html text, content jsonb, html text, content_hash text, created_by text,
              created_at timestamptz, updated_at timestamptz, library boolean, jar_style text, placements text[])
LANGUAGE sql
STABLE
SET search_path = ''
AS $$
  SELECT c.funnel_id, c.id, c.name, c.status, coalesce((f.cta -> c.id::text ->> 'weight')::int, 0),
         c.visual, c.product_color, c.quiz, c.sections, c.cards_html, c.content, c.html, c.content_hash, c.created_by,
         c.created_at, c.updated_at, c.funnel_id IS NULL, c.jar_style, c.placements
  FROM pages.cta c
  LEFT JOIN pages.funnels f ON f.id = c.funnel_id
  WHERE c.id = p_cta_id
$$;

-- The library, without the HTML and the content, with who uses each design.
CREATE OR REPLACE FUNCTION pages.cta_library_summary()
RETURNS TABLE(cta_id uuid, name text, status text, visual jsonb, has_cards boolean, jar_style text, placements text[],
              content_hash text, created_by text, created_at timestamptz, updated_at timestamptz, used_by jsonb)
LANGUAGE sql
STABLE
SET search_path = ''
AS $$
  SELECT c.id, c.name, c.status, c.visual, btrim(c.cards_html) <> '', c.jar_style, c.placements, c.content_hash,
         c.created_by, c.created_at, c.updated_at, pages.cta_used_by(c.id)
  FROM pages.cta c
  WHERE c.funnel_id IS NULL
  ORDER BY c.created_at, c.id
$$;

-- A funnel's blocks for the CTA stage: the Default block, the groups and their version, and every
-- design they or the funnel have (no HTML).
CREATE OR REPLACE FUNCTION pages.funnel_cta_blocks(p_funnel uuid)
RETURNS jsonb
LANGUAGE sql
STABLE
SET search_path = ''
AS $$
  SELECT jsonb_build_object(
    'funnel_id', f.id,
    'cta_enabled', f.cta_enabled,
    'default', f.cta,
    'groups', f.cta_groups,
    'groups_updated_at', f.cta_groups_updated_at,
    'designs', coalesce((
      SELECT jsonb_agg(jsonb_build_object('cta_id', c.id, 'name', c.name, 'status', c.status, 'library', c.funnel_id IS NULL,
                                          'jar_style', c.jar_style, 'placements', to_jsonb(c.placements),
                                          'has_cards', btrim(c.cards_html) <> '', 'content_hash', c.content_hash,
                                          'updated_at', c.updated_at) ORDER BY c.created_at, c.id)
      FROM pages.cta c
      WHERE c.funnel_id = f.id
         OR (c.funnel_id IS NULL AND (f.cta ? c.id::text OR pages.cta_groups_have(f.cta_groups, c.id::text)))), '[]'::jsonb))
  FROM pages.funnels f
  WHERE f.id = p_funnel
$$;

CREATE OR REPLACE FUNCTION pages.vsl_offer_get(p_players text[])
RETURNS TABLE(player_id text, product text, kits jsonb, source text, updated_by text, updated_at timestamptz)
LANGUAGE sql
STABLE
SET search_path = ''
AS $$
  SELECT o.player_id, o.product, o.kits, o.source, o.updated_by, o.updated_at
  FROM pages.vsl_offers o
  WHERE o.player_id = ANY (p_players)
$$;

CREATE OR REPLACE FUNCTION pages.cta_jar_photos_get(p_products text[])
RETURNS TABLE(product text, style text, photos jsonb, updated_by text, updated_at timestamptz)
LANGUAGE sql
STABLE
SET search_path = ''
AS $$
  SELECT j.product, j.style, j.photos, j.updated_by, j.updated_at
  FROM pages.cta_jar_photos j
  WHERE j.product = ANY (ARRAY(SELECT upper(btrim(p)) FROM unnest(p_products) p))
  ORDER BY j.product, j.style
$$;

-- The VSLs tab: how many designs with a share the Default block has (the funnel's and the library's).
CREATE OR REPLACE FUNCTION pages.funnel_vsl_panel(p_main_funnel uuid)
 RETURNS jsonb
 LANGUAGE sql
 STABLE
 SET search_path TO ''
AS $function$
  WITH f AS (
    SELECT t.id, t.vsl, t.vsl_updated_at, t.cta, t.cta_enabled,
           ARRAY(SELECT jsonb_object_keys(t.vsl)) AS ids,
           ARRAY(SELECT k FROM (SELECT pages.vsl_title_key(x.v ->> 'name') AS k FROM jsonb_each(t.vsl) AS x(id, v)) n WHERE k <> '') AS names
    FROM pages.funnels t
    WHERE t.main_funnel_id = p_main_funnel
  )
  SELECT jsonb_build_object(
    'id', f.id,
    'updated_at', f.vsl_updated_at,
    'vsl', f.vsl,
    -- The funnel's CTAs at the pitch (cta.php): on, and how many published designs with a share
    -- in the Default block.
    'cta_enabled', f.cta_enabled,
    'ctas_live', (SELECT count(*) FROM pages.cta c
                  WHERE (c.funnel_id = f.id OR c.funnel_id IS NULL) AND c.status = 'PUBLISHED' AND f.cta ? c.id::text
                    AND coalesce((f.cta -> c.id::text ->> 'weight')::int, 0) > 0),
    'vsls', coalesce((
      SELECT jsonb_agg(jsonb_build_object('vsl_id', e.id, 'title', e.title, 'funnel_status', e.funnel_status::text, 'language', e.language,
                                          'pitch', e.pitch, 'copywriter', e.copywriter_name, 'editor', e.editor_name,
                                          'video_ids', e.video_id::text[], 'video_url', nullif(e.metadata ->> 'video_url', ''))
                       ORDER BY e.updated_at DESC NULLS LAST, e.id)
      FROM public.v_vsl_explorer e
      WHERE e.archived_at IS NULL
        AND (e.video_id::text[] && f.ids OR pages.vsl_title_key(e.title) = ANY (f.names))), '[]'::jsonb))
  FROM f
$function$;

-- ── The delivery server (server key) ────────────────────────────────────────

-- A block's designs that can be drawn for an offer with placements `p_avail`: published, a share
-- above 0, an HTML, and every placement they use available. [{ id, weight, content_hash, jar_style }].
CREATE OR REPLACE FUNCTION pages.cta_block_drawable(p_funnel uuid, p_list jsonb, p_avail text[])
RETURNS jsonb
LANGUAGE sql
STABLE
SET search_path = ''
AS $$
  SELECT coalesce(jsonb_agg(jsonb_build_object('id', c.id, 'weight', (e.value ->> 'weight')::int,
                                               'content_hash', c.content_hash, 'jar_style', c.jar_style)
                            ORDER BY c.created_at, c.id), '[]'::jsonb)
  FROM jsonb_each(CASE WHEN jsonb_typeof(p_list) = 'object' THEN p_list ELSE '{}'::jsonb END) e
  JOIN pages.cta c ON c.id = e.key::uuid
  WHERE (c.funnel_id = p_funnel OR c.funnel_id IS NULL)
    AND c.status = 'PUBLISHED'
    AND coalesce((e.value ->> 'weight')::int, 0) > 0
    AND btrim(c.html) <> ''
    AND c.placements <@ coalesce(p_avail, '{}'::text[])
$$;

-- What the server draws from when VSL `p_video` reaches the pitch on funnel page `p_page`: the
-- VSL's block (its group — listed, else by its offer's product — when that has something to show,
-- otherwise the Default block), its designs that the VSL's offer can fill, and the offer (with the
-- jar photos of the styles those designs use). NULL = the VSL isn't on CTA mode "server" in a
-- funnel with CTAs on.
CREATE OR REPLACE FUNCTION pages.cta_draw_get(p_page uuid, p_video text, p_key text)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  f       record;
  o       record;
  v_avail text[] := '{}';
  v_group jsonb;
  v_ctas  jsonb := '[]'::jsonb;
  v_block text := 'default';
  v_jars  jsonb;
BEGIN
  IF NOT pages.server_key_ok(p_key) THEN
    RAISE EXCEPTION 'pages.cta_draw_get: invalid key' USING ERRCODE = '28000';
  END IF;
  IF p_page IS NULL OR p_video IS NULL OR p_video !~ '^[0-9a-f]{24}$' THEN
    RETURN NULL;
  END IF;
  SELECT x.id, x.vsl, x.cta, x.cta_groups INTO f FROM pages.funnels x WHERE x.site ? p_page::text AND x.cta_enabled;
  IF NOT FOUND OR f.vsl -> p_video ->> 'cta' IS DISTINCT FROM 'server' THEN
    RETURN NULL;
  END IF;
  SELECT x.product, x.kits INTO o FROM pages.vsl_offers x WHERE x.player_id = p_video;
  IF o.product IS NOT NULL THEN
    v_avail := pages.vsl_offer_placements(o.product, o.kits);
  END IF;
  SELECT g INTO v_group FROM jsonb_array_elements(f.cta_groups) g WHERE g -> 'vsls' ? p_video LIMIT 1;
  IF v_group IS NULL AND o.product IS NOT NULL THEN
    SELECT g INTO v_group FROM jsonb_array_elements(f.cta_groups) g
    WHERE upper(btrim(g ->> 'product')) = upper(btrim(o.product)) LIMIT 1;
  END IF;
  IF v_group IS NOT NULL THEN
    v_ctas := pages.cta_block_drawable(f.id, v_group -> 'cta', v_avail);
    IF v_ctas <> '[]'::jsonb THEN
      v_block := v_group ->> 'id';
    END IF;
  END IF;
  IF v_block = 'default' THEN
    v_ctas := pages.cta_block_drawable(f.id, f.cta, v_avail);
  END IF;
  IF o.product IS NOT NULL THEN
    SELECT jsonb_object_agg(j.style, j.photos) INTO v_jars
    FROM pages.cta_jar_photos j
    WHERE j.product = upper(btrim(o.product))
      AND j.style IN (SELECT e ->> 'jar_style' FROM jsonb_array_elements(v_ctas) e);
  END IF;
  RETURN jsonb_build_object(
    'funnel_id', f.id,
    'block', v_block,
    'ctas', v_ctas,
    'offer', CASE WHEN o.product IS NULL THEN NULL
                  ELSE jsonb_build_object('product', o.product, 'kits', o.kits, 'jars', coalesce(v_jars, '{}'::jsonb)) END);
END $$;

COMMENT ON FUNCTION pages.cta_draw_get(uuid, text, text) IS
  'The block, drawable designs and offer of a VSL at the pitch (cta.php). Delivery server only (server key).';

-- The test link (?dop_cta=<id>) with the VSL's offer: the CTA's HTML — a draft too; a CTA of the
-- page's funnel or a library design — and the offer of `p_video` when it is a VSL of that funnel
-- (with the photos of the design's jar style). NULL = not available.
CREATE OR REPLACE FUNCTION pages.cta_preview_get(p_cta uuid, p_page uuid, p_video text, p_key text)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  f         record;
  c         record;
  v_product text;
  v_kits    jsonb;
  v_jars    jsonb;
BEGIN
  IF NOT pages.server_key_ok(p_key) THEN
    RAISE EXCEPTION 'pages.cta_preview_get: invalid key' USING ERRCODE = '28000';
  END IF;
  SELECT x.id, x.vsl, x.cta INTO f FROM pages.funnels x WHERE x.site ? p_page::text;
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;
  SELECT x.id, x.content_hash, x.html, x.status, x.jar_style INTO c
  FROM pages.cta x
  WHERE x.id = p_cta AND btrim(x.html) <> '' AND (x.funnel_id IS NULL OR (x.funnel_id = f.id AND f.cta ? x.id::text));
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;
  IF p_video ~ '^[0-9a-f]{24}$' AND f.vsl ? p_video THEN
    SELECT o.product, o.kits INTO v_product, v_kits FROM pages.vsl_offers o WHERE o.player_id = p_video;
    IF v_product IS NOT NULL AND c.jar_style IS NOT NULL THEN
      SELECT jsonb_build_object(j.style, j.photos) INTO v_jars
      FROM pages.cta_jar_photos j WHERE j.product = upper(btrim(v_product)) AND j.style = c.jar_style;
    END IF;
  END IF;
  RETURN jsonb_build_object(
    'cta_id', c.id, 'content_hash', c.content_hash, 'html', c.html, 'status', c.status, 'jar_style', c.jar_style,
    'offer', CASE WHEN v_product IS NULL THEN NULL
                  ELSE jsonb_build_object('product', v_product, 'kits', v_kits, 'jars', coalesce(v_jars, '{}'::jsonb)) END);
END $$;

COMMENT ON FUNCTION pages.cta_preview_get(uuid, uuid, text, text) IS
  'The test link of a CTA (?dop_cta=<id>) with the VSL''s offer: its HTML, draft or published (the page''s funnel''s or the library''s). Delivery server only (server key).';

-- ── Grants ──────────────────────────────────────────────────────────────────

DO $$
DECLARE
  fn text;
BEGIN
  FOREACH fn IN ARRAY ARRAY[
    'pages.cta_kit_fields()',
    'pages.vsl_offer_placements(text, jsonb)',
    'pages.cta_placements_of(text)',
    'pages.cta_groups_have(jsonb, text)',
    'pages.cta_block_check(uuid, jsonb, text)',
    'pages.cta_block_published(uuid, jsonb)',
    'pages.cta_block_rebalance(jsonb, text[], text)',
    'pages.cta_groups_rebalance(uuid, jsonb, text, boolean)',
    'pages.cta_groups_without(uuid, jsonb, text, text)',
    'pages.cta_block_drawable(uuid, jsonb, text[])',
    'pages.funnel_cta_live(uuid, jsonb)',
    'pages.funnel_cta_published(uuid)',
    'pages.cta_fields_check(jsonb)',
    'pages.funnel_cta_add(uuid, jsonb, text, text)',
    'pages.cta_library_add(jsonb, text, text)',
    'pages.cta_save(uuid, jsonb, text, timestamptz)',
    'pages.funnel_cta_publish(uuid, boolean, timestamptz)',
    'pages.funnel_cta_weights_set(uuid, jsonb, uuid)',
    'pages.funnel_cta_remove(uuid)',
    'pages.cta_used_by(uuid)',
    'pages.cta_library_publish(uuid, boolean, timestamptz)',
    'pages.cta_library_delete(uuid)',
    'pages.funnel_cta_use(uuid, uuid, uuid)',
    'pages.funnel_cta_unuse(uuid, uuid, uuid)',
    'pages.funnel_cta_group_save(uuid, jsonb, timestamptz)',
    'pages.funnel_cta_group_delete(uuid, uuid, timestamptz)',
    'pages.vsl_offer_set(text, jsonb, text)',
    'pages.vsl_offers_import(jsonb, text)',
    'pages.vsl_offer_delete(text)',
    'pages.cta_jar_photos_set(text, text, jsonb, text)',
    'pages.cta_summary(uuid[])',
    'pages.cta_get(uuid)',
    'pages.cta_library_summary()',
    'pages.funnel_cta_blocks(uuid)',
    'pages.vsl_offer_get(text[])',
    'pages.cta_jar_photos_get(text[])'
  ] LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM public, anon, authenticated', fn);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role', fn);
  END LOOP;
END $$;
REVOKE ALL ON FUNCTION pages.cta_check() FROM public, anon, authenticated;
REVOKE ALL ON FUNCTION pages.cta_delete_check() FROM public, anon, authenticated;
REVOKE ALL ON FUNCTION pages.funnels_cta_check() FROM public, anon, authenticated;
REVOKE ALL ON FUNCTION pages.vsl_offers_check() FROM public, anon, authenticated;
REVOKE ALL ON FUNCTION pages.cta_jar_photos_check() FROM public, anon, authenticated;
REVOKE ALL ON FUNCTION pages.cta_draw_get(uuid, text, text) FROM public, authenticated;
GRANT EXECUTE ON FUNCTION pages.cta_draw_get(uuid, text, text) TO anon, service_role;
REVOKE ALL ON FUNCTION pages.cta_preview_get(uuid, uuid, text, text) FROM public, authenticated;
GRANT EXECUTE ON FUNCTION pages.cta_preview_get(uuid, uuid, text, text) TO anon, service_role;

NOTIFY pgrst, 'reload schema';
