-- ============================================================================
-- DayOne Pages — upsell pages (the owner, 14/10/2026: an upsell step's page versions are chosen from
-- pages.page_content with kind UPSELL; scope VENDOR; the picker lists the ones of the vendor page's
-- product and platform).
--
-- 1. kind UPSELL: only on a VENDOR page (ck_pages_kind_scope — never a template, a domain page or a
--    funnel page), and never listed by a domain (domains_page_check): an upsell page is served only
--    through its vendor page's upsell funnel, at the step's path. It is created like a vendor page
--    (a plain insert with slugs, product_id and platform); its served slug is "/" (else its first
--    active one). An archived one is not served.
-- 2. The routing is internal, not in slugs (the owner, 14/10: "vamos usar só o /up1 /up2 /up3"): a
--    step's path is fixed — /up1 … /up5 and /thank-you — and a page version in the upsell config is
--    { page_id, weight } (it was { slug, weight }: a slug of the same vendor page, like /up1/b).
--    The vendor page needs no slug at those paths. pages.upsell_funnels_check refuses, when the
--    config is written, a page_id that isn't an upsell page of the vendor page's product and
--    platform (one that changes later just stops being served: resolve leaves it out).
--    pages.upsell_config_pages lists them.
-- 3. pages.resolve's gate.upsell carries `pages` ({ "<upsell page id>": { slug, hash, type } })
--    instead of the vendor page's `slugs` (patched in place, like 20261014a).
-- 4. pages.hits.upsell.p is now the served upsell page's id (the vendor page's own slug at that
--    path when the group has no upsell page to serve and the vendor page has one; else 404);
--    upsell_funnel_stats / upsell_funnel_answers return it as `page`, and the answers also count
--    dot events whose page_id is one of those upsell pages.
-- Every other page, domain and funnel is unchanged (the owner, 14/10: only the vendor type differs).
-- ============================================================================

-- ── 1. kind UPSELL, a vendor page's only ────────────────────────────────────

ALTER TABLE pages.page_content DROP CONSTRAINT pages_kind_check;
ALTER TABLE pages.page_content ADD CONSTRAINT pages_kind_check
  CHECK (kind = ANY (ARRAY['PRESELL', 'ADVERTORIAL', 'VSL', 'CHECKOUT', 'SAFE', 'OTHER', 'FUNNEL', 'UPSELL']));
ALTER TABLE pages.page_content DROP CONSTRAINT ck_pages_kind_scope;
ALTER TABLE pages.page_content ADD CONSTRAINT ck_pages_kind_scope CHECK (
     (scope = 'TEMPLATE' AND kind NOT IN ('FUNNEL', 'UPSELL'))
  OR (scope = 'FUNNEL' AND kind = 'FUNNEL')
  OR (scope = 'DOMAIN' AND kind <> 'UPSELL')
  OR (scope = 'VENDOR' AND kind <> 'FUNNEL'));
COMMENT ON COLUMN pages.page_content.kind IS
  'Page kind. FUNNEL only for funnel pages and their copies on domains. UPSELL only for vendor pages (scope VENDOR) that an upsell funnel serves as a step''s page version — never listed by a domain.';

CREATE OR REPLACE FUNCTION pages.domains_page_check()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  pg record;
  v_scope text;
  v_kind text;
BEGIN
  IF coalesce(jsonb_typeof(NEW.page), '') <> 'object' THEN
    RAISE EXCEPTION 'domains.page must be an object' USING ERRCODE = 'check_violation';
  END IF;

  FOR pg IN SELECT key, value FROM jsonb_each(NEW.page) LOOP
    IF pg.key !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
       OR coalesce(jsonb_typeof(pg.value), '') <> 'object' THEN
      RAISE EXCEPTION 'domains.page: invalid entry %', pg.key USING ERRCODE = 'check_violation';
    END IF;
    SELECT p.scope, p.kind INTO v_scope, v_kind FROM pages.page_content p WHERE p.id = pg.key::uuid;
    IF v_scope IS NULL OR v_scope NOT IN ('DOMAIN', 'VENDOR') THEN
      RAISE EXCEPTION 'domains.page: % is not a domain page', pg.key USING ERRCODE = 'foreign_key_violation';
    END IF;
    -- An upsell page is served only through its vendor page's upsell funnel (20261014d).
    IF v_kind = 'UPSELL' THEN
      RAISE EXCEPTION 'domains.page: % is an upsell page; only an upsell funnel serves it', pg.key USING ERRCODE = 'check_violation';
    END IF;
    -- A vendor page is served only by a vendor domain (and a vendor domain keeps its type while it serves one).
    IF v_scope = 'VENDOR' AND NEW.type IS DISTINCT FROM 'VENDOR' THEN
      RAISE EXCEPTION 'domains.page: % is a vendor page; only a Vendor domain can serve it', pg.key USING ERRCODE = 'check_violation';
    END IF;
    IF EXISTS (SELECT 1 FROM pages.domains o WHERE o.id <> NEW.id AND o.page ? pg.key) THEN
      RAISE EXCEPTION 'domains.page: page % belongs to another domain', pg.key USING ERRCODE = 'unique_violation';
    END IF;
  END LOOP;

  RETURN NEW;
END $$;

-- ── 2. Page versions are upsell pages ───────────────────────────────────────

-- The upsell pages a config's page versions name (every step, group and flow).
CREATE OR REPLACE FUNCTION pages.upsell_config_pages(p jsonb)
RETURNS SETOF uuid
LANGUAGE sql
IMMUTABLE
SET search_path = ''
AS $$
  SELECT DISTINCT (v ->> 'page_id')::uuid
  FROM jsonb_array_elements(CASE WHEN jsonb_typeof(p -> 'steps') = 'array' THEN p -> 'steps' ELSE '[]'::jsonb END) st
  CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(st -> 'groups') = 'array' THEN st -> 'groups' ELSE '[]'::jsonb END) g
  CROSS JOIN LATERAL jsonb_each(CASE WHEN jsonb_typeof(g -> 'pages') = 'object' THEN g -> 'pages' ELSE '{}'::jsonb END) fl
  CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(fl.value) = 'array' THEN fl.value ELSE '[]'::jsonb END) v
  WHERE coalesce(v ->> 'page_id', '') ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
$$;

CREATE OR REPLACE FUNCTION pages.upsell_config_check(p jsonb)
RETURNS void
LANGUAGE plpgsql
IMMUTABLE
SET search_path = ''
AS $$
DECLARE
  f  jsonb;
  st jsonb;
  g  jsonb;
  k  record;
  v  jsonb;
  slot jsonb;
  v_flows text[] := '{}';
  v_steps text[] := '{}';
  v_groups text[];
  v_key  constant text := '^[a-z][a-z0-9_]{0,39}$';
  v_uuid constant text := '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
BEGIN
  IF coalesce(jsonb_typeof(p), '') <> 'object'
     OR EXISTS (SELECT 1 FROM jsonb_object_keys(p) x WHERE x NOT IN ('front_param', 'flows', 'steps')) THEN
    RAISE EXCEPTION 'upsell: the config must be { front_param, flows, steps }' USING ERRCODE = 'check_violation';
  END IF;
  IF p ? 'front_param' AND (jsonb_typeof(p -> 'front_param') <> 'string' OR p ->> 'front_param' !~ '^[A-Za-z0-9_.-]{1,40}$') THEN
    RAISE EXCEPTION 'upsell: invalid front parameter' USING ERRCODE = 'check_violation';
  END IF;

  IF coalesce(jsonb_typeof(p -> 'flows'), 'array') <> 'array' OR jsonb_array_length(coalesce(p -> 'flows', '[]')) > 10 THEN
    RAISE EXCEPTION 'upsell: flows must be a list of at most 10' USING ERRCODE = 'check_violation';
  END IF;
  FOR f IN SELECT value FROM jsonb_array_elements(coalesce(p -> 'flows', '[]')) LOOP
    IF jsonb_typeof(f) <> 'object' OR coalesce(f ->> 'id', '') !~ '^f[a-z0-9]{1,12}$' OR f ->> 'id' = ANY (v_flows)
       OR length(btrim(coalesce(f ->> 'name', ''))) NOT BETWEEN 1 AND 60
       OR coalesce(jsonb_typeof(f -> 'when'), '') <> 'object' THEN
      RAISE EXCEPTION 'upsell: invalid flow %', coalesce(f ->> 'id', '?') USING ERRCODE = 'check_violation';
    END IF;
    IF EXISTS (SELECT 1 FROM jsonb_object_keys(f -> 'when') x
               WHERE x NOT IN ('countries', 'countries_mode', 'devices', 'languages', 'languages_mode', 'query', 'referrer', 'referrer_absent', 'cookies')) THEN
      RAISE EXCEPTION 'upsell: unknown condition in flow %', f ->> 'id' USING ERRCODE = 'check_violation';
    END IF;
    v_flows := v_flows || (f ->> 'id');
  END LOOP;

  IF coalesce(jsonb_typeof(p -> 'steps'), 'array') <> 'array' OR jsonb_array_length(coalesce(p -> 'steps', '[]')) > 6 THEN
    RAISE EXCEPTION 'upsell: steps must be a list of at most 6' USING ERRCODE = 'check_violation';
  END IF;
  FOR st IN SELECT value FROM jsonb_array_elements(coalesce(p -> 'steps', '[]')) LOOP
    IF jsonb_typeof(st) <> 'object' OR coalesce(st ->> 'id', '') NOT IN ('up1', 'up2', 'up3', 'up4', 'up5', 'ty')
       OR st ->> 'id' = ANY (v_steps)
       -- A step's path is fixed (/up1 … /up5, /thank-you): which page it serves is decided inside (20261014d).
       OR st ->> 'slug' IS DISTINCT FROM (CASE st ->> 'id' WHEN 'ty' THEN '/thank-you' ELSE '/' || (st ->> 'id') END) THEN
      RAISE EXCEPTION 'upsell: invalid step %', coalesce(st ->> 'id', '?') USING ERRCODE = 'check_violation';
    END IF;
    v_steps := v_steps || (st ->> 'id');
    IF st ->> 'id' = 'ty' THEN
      CONTINUE;
    END IF;
    IF coalesce(jsonb_typeof(st -> 'groups'), '') <> 'array' OR jsonb_array_length(st -> 'groups') NOT BETWEEN 1 AND 6 THEN
      RAISE EXCEPTION 'upsell: step % needs 1 to 6 groups', st ->> 'id' USING ERRCODE = 'check_violation';
    END IF;
    v_groups := '{}';
    FOR g IN SELECT value FROM jsonb_array_elements(st -> 'groups') LOOP
      IF jsonb_typeof(g) <> 'object' OR coalesce(g ->> 'id', '') !~ '^g[a-z0-9]{1,12}$' OR g ->> 'id' = ANY (v_groups)
         OR length(btrim(coalesce(g ->> 'name', ''))) NOT BETWEEN 1 AND 60
         OR coalesce(jsonb_typeof(g -> 'fronts'), '') <> 'array'
         OR EXISTS (SELECT 1 FROM jsonb_array_elements(g -> 'fronts') x WHERE jsonb_typeof(x) <> 'string' OR x #>> '{}' !~ '^[A-Za-z0-9_.-]{1,40}$')
         OR coalesce(jsonb_typeof(g -> 'pages'), '') <> 'object' THEN
        RAISE EXCEPTION 'upsell: invalid group % in step %', coalesce(g ->> 'id', '?'), st ->> 'id' USING ERRCODE = 'check_violation';
      END IF;
      v_groups := v_groups || (g ->> 'id');
      FOR k IN SELECT key, value FROM jsonb_each(g -> 'pages') LOOP
        IF k.key <> 'default' AND NOT k.key = ANY (v_flows) OR jsonb_typeof(k.value) <> 'array' OR jsonb_array_length(k.value) > 10
           OR EXISTS (SELECT 1 FROM jsonb_array_elements(k.value) x
                      WHERE jsonb_typeof(x) <> 'object' OR coalesce(x ->> 'page_id', '') !~ v_uuid
                         OR jsonb_typeof(x -> 'weight') <> 'number' OR (x ->> 'weight')::numeric NOT BETWEEN 0 AND 100) THEN
          RAISE EXCEPTION 'upsell: invalid pages for flow % (step %)', k.key, st ->> 'id' USING ERRCODE = 'check_violation';
        END IF;
      END LOOP;
      FOREACH v IN ARRAY ARRAY[coalesce(g -> 'vsls', '[]'), coalesce(g -> 'offers', '[]')] LOOP
        IF jsonb_typeof(v) <> 'array' OR jsonb_array_length(v) > 10
           OR EXISTS (SELECT 1 FROM jsonb_array_elements(v) x
                      WHERE jsonb_typeof(x) <> 'object' OR jsonb_typeof(x -> 'weight') <> 'number' OR (x ->> 'weight')::numeric NOT BETWEEN 0 AND 100
                         OR NOT (coalesce(x ->> 'id', '') ~ '^[A-Za-z0-9]{1,40}$' OR coalesce(x ->> 'offer', '') ~ v_key)) THEN
          RAISE EXCEPTION 'upsell: invalid VSLs or CTA in group % (step %)', g ->> 'id', st ->> 'id' USING ERRCODE = 'check_violation';
        END IF;
      END LOOP;
      IF coalesce(jsonb_typeof(g -> 'downsells'), 'array') <> 'array' OR jsonb_array_length(coalesce(g -> 'downsells', '[]')) > 3 THEN
        RAISE EXCEPTION 'upsell: at most 3 downsells (group %, step %)', g ->> 'id', st ->> 'id' USING ERRCODE = 'check_violation';
      END IF;
      FOR slot IN SELECT value FROM jsonb_array_elements(coalesce(g -> 'downsells', '[]')) LOOP
        IF jsonb_typeof(slot) <> 'array' OR jsonb_array_length(slot) NOT BETWEEN 1 AND 10
           OR EXISTS (SELECT 1 FROM jsonb_array_elements(slot) x
                      WHERE jsonb_typeof(x) <> 'object' OR coalesce(x ->> 'offer', '') !~ v_key
                         OR jsonb_typeof(x -> 'weight') <> 'number' OR (x ->> 'weight')::numeric NOT BETWEEN 0 AND 100) THEN
          RAISE EXCEPTION 'upsell: invalid downsell (group %, step %)', g ->> 'id', st ->> 'id' USING ERRCODE = 'check_violation';
        END IF;
      END LOOP;
    END LOOP;
  END LOOP;
END $$;

CREATE OR REPLACE FUNCTION pages.upsell_funnels_check()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  vp record;
  v_live boolean;
  v_draft boolean;
  v_bad uuid;
BEGIN
  SELECT p.scope, p.kind, p.product_id, p.platform INTO vp FROM pages.page_content p WHERE p.id = NEW.page_id;
  -- The funnel's page is the vendor's site (its domain lists it), never an upsell page.
  IF NOT FOUND OR vp.scope <> 'VENDOR' OR vp.kind = 'UPSELL' THEN
    RAISE EXCEPTION 'upsell: % is not a vendor page', NEW.page_id USING ERRCODE = 'foreign_key_violation';
  END IF;
  -- A config is checked when it is written (a config written under older rules stays until replaced).
  IF TG_OP = 'INSERT' THEN
    v_live := true;
    v_draft := NEW.draft IS NOT NULL;
  ELSE
    v_live := NEW.live IS DISTINCT FROM OLD.live OR NEW.page_id IS DISTINCT FROM OLD.page_id;
    v_draft := NEW.draft IS NOT NULL AND (NEW.draft IS DISTINCT FROM OLD.draft OR NEW.page_id IS DISTINCT FROM OLD.page_id);
  END IF;
  IF v_live THEN
    PERFORM pages.upsell_config_check(NEW.live);
  END IF;
  IF v_draft THEN
    PERFORM pages.upsell_config_check(NEW.draft);
  END IF;

  -- The page versions: upsell pages (VENDOR + kind UPSELL) of the vendor page's product and
  -- platform. A page that changes later just stops being served (resolve leaves it out).
  SELECT c.id INTO v_bad
  FROM (
    SELECT pages.upsell_config_pages(NEW.live) AS id WHERE v_live
    UNION
    SELECT pages.upsell_config_pages(NEW.draft) WHERE v_draft
  ) c
  WHERE NOT EXISTS (
    SELECT 1 FROM pages.page_content up
    WHERE up.id = c.id AND up.scope = 'VENDOR' AND up.kind = 'UPSELL'
      AND up.product_id IS NOT DISTINCT FROM vp.product_id AND up.platform IS NOT DISTINCT FROM vp.platform)
  LIMIT 1;
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'upsell: % is not an upsell page of this product and platform', v_bad USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;

-- ── 3. resolve's gate.upsell: the upsell pages instead of the vendor page's slugs ──

DO $do$
DECLARE
  def  text := pg_get_functiondef('pages.resolve(text, text, text, boolean)'::regprocedure);
  next text;
BEGIN
  next := replace(def,
    $old$             -- The vendor pages' upsell funnels, live, by page id, with the hashes of the page's
             -- active slugs (server/src/upsell.php serves a version's slug at the step's path; 20261014a).
             'upsell', coalesce((
               SELECT jsonb_object_agg(uf.page_id::text, uf.live || jsonb_build_object(
                        'id', uf.id,
                        'slugs', coalesce((
                          SELECT jsonb_object_agg(s.key, jsonb_build_object(
                                   'hash', s.value ->> 'content_hash',
                                   'type', coalesce(s.value ->> 'content_type', 'text/html; charset=utf-8')))
                          FROM pages.page_content up
                          CROSS JOIN LATERAL jsonb_each(up.slugs) s
                          WHERE up.id = uf.page_id AND coalesce((s.value ->> 'is_active')::boolean, false)
                        ), '{}'::jsonb)))$old$,
    $new$             -- The vendor pages' upsell funnels, live, by page id, with the upsell pages their versions
             -- name (VENDOR + kind UPSELL, the vendor page's product and platform, not archived): each
             -- one's served slug ("/", else its first active one) and hash (server/src/upsell.php serves
             -- it at the step's path; 20261014a, 20261014d).
             'upsell', coalesce((
               SELECT jsonb_object_agg(uf.page_id::text, uf.live || jsonb_build_object(
                        'id', uf.id,
                        'pages', coalesce((
                          SELECT jsonb_object_agg(up.id::text, jsonb_build_object(
                                   'slug', sl.key,
                                   'hash', sl.value ->> 'content_hash',
                                   'type', coalesce(sl.value ->> 'content_type', 'text/html; charset=utf-8')))
                          FROM pages.page_content vp
                          JOIN pages.page_content up
                            ON up.id IN (SELECT pages.upsell_config_pages(uf.live))
                           AND up.scope = 'VENDOR' AND up.kind = 'UPSELL' AND up.status <> 'ARCHIVED'
                           AND up.product_id IS NOT DISTINCT FROM vp.product_id
                           AND up.platform IS NOT DISTINCT FROM vp.platform
                          CROSS JOIN LATERAL (
                            SELECT s.key, s.value FROM jsonb_each(up.slugs) s
                            WHERE coalesce((s.value ->> 'is_active')::boolean, false) AND s.value ->> 'content_hash' IS NOT NULL
                            ORDER BY s.key = '/' DESC, s.key LIMIT 1
                          ) sl
                          WHERE vp.id = uf.page_id
                        ), '{}'::jsonb)))$new$);
  IF next = def THEN
    RAISE EXCEPTION 'pages.resolve: the gate.upsell entry was not found';
  END IF;
  EXECUTE next;
END $do$;

-- ── 4. The numbers: the served page is an upsell page's id ──────────────────

DROP FUNCTION pages.upsell_funnel_stats(uuid, timestamptz);
CREATE FUNCTION pages.upsell_funnel_stats(p_funnel uuid, p_since timestamptz)
RETURNS TABLE(step text, grp text, flow text, page text, offer text, video text, hits bigint, visitors bigint)
LANGUAGE sql
STABLE
SET search_path = ''
AS $$
  SELECT h.upsell ->> 's', h.upsell ->> 'g', h.upsell ->> 'fl', h.upsell ->> 'p', h.upsell ->> 'o', h.upsell ->> 'v',
         count(*), count(DISTINCT h.ip)
  FROM pages.upsell_funnels uf
  JOIN pages.domains d ON d.page ? uf.page_id::text
  JOIN pages.hits h ON h.domain_id = d.id AND h.created_at >= p_since
  WHERE uf.id = p_funnel
    AND h.upsell ->> 'f' = p_funnel::text
    AND h.status_code = 200
  GROUP BY 1, 2, 3, 4, 5, 6
$$;
COMMENT ON FUNCTION pages.upsell_funnel_stats(uuid, timestamptz) IS
  'An upsell funnel''s served responses since p_since (200s, from pages.hits.upsell), per step, group, flow, page (the upsell page''s id, or the vendor page''s own slug), offer and video: hits and distinct IPs. The dashboard''s flow shares and the numbers on the pipeline''s arrows.';

DROP FUNCTION pages.upsell_funnel_answers(uuid, timestamptz);
CREATE FUNCTION pages.upsell_funnel_answers(p_funnel uuid, p_since timestamptz)
RETURNS TABLE(origin text, event text, offer text, grp text, flow text, page text, n bigint)
LANGUAGE sql
STABLE
SET search_path = ''
AS $$
  SELECT e.origin, e.event, e.product_option,
         e.metadata #>> '{upsell,g}', e.metadata #>> '{upsell,fl}', e.metadata #>> '{upsell,p}',
         count(*)
  FROM pages.upsell_funnels uf
  JOIN pages.page_content vp ON vp.id = uf.page_id
  JOIN tracking.dot_events e
    ON e.event IN ('upsell_accept', 'upsell_decline', 'downsell_accept', 'downsell_decline')
   AND e.event_at >= p_since
   -- The tracker's page_id: the served upsell page (or the vendor page itself, before 20261014d).
   AND (e.page_id = uf.page_id::text
        OR e.page_id IN (SELECT up.id::text FROM pages.page_content up
                         WHERE up.scope = 'VENDOR' AND up.kind = 'UPSELL'
                           AND up.product_id IS NOT DISTINCT FROM vp.product_id AND up.platform IS NOT DISTINCT FROM vp.platform))
  WHERE uf.id = p_funnel
  GROUP BY 1, 2, 3, 4, 5, 6
$$;
COMMENT ON FUNCTION pages.upsell_funnel_answers(uuid, timestamptz) IS
  'An upsell funnel''s buyer answers since p_since, from tracking.dot_events (upsell_/downsell_ accept/decline): per origin, event, offer code, group, flow and page (the upsell page''s id). dot''s page_id is the served upsell page, or the vendor page itself.';

REVOKE ALL ON FUNCTION pages.upsell_config_pages(jsonb) FROM public, anon, authenticated;
REVOKE ALL ON FUNCTION pages.upsell_funnel_stats(uuid, timestamptz) FROM public, anon, authenticated;
REVOKE ALL ON FUNCTION pages.upsell_funnel_answers(uuid, timestamptz) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION pages.upsell_config_pages(jsonb) TO service_role;
GRANT EXECUTE ON FUNCTION pages.upsell_funnel_stats(uuid, timestamptz) TO service_role;
GRANT EXECUTE ON FUNCTION pages.upsell_funnel_answers(uuid, timestamptz) TO service_role;
