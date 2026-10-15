-- ============================================================================
-- DayOne Pages — upsell funnels of a vendor page (the owner, 13–14/10/2026: the "Upsells" menu —
-- Upsell 1 › … › Upsell 5 › Thank you, downsells on the same page, A/B by flow).
--
-- pages.upsell_funnels: one per vendor page (scope VENDOR), the steps of its site after the
-- checkout. Its config (jsonb, the same shape in `live` and `draft`):
--   front_param  the URL parameter that says what the buyer bought at the front (?front=6);
--                configurable until the checkout's own parameter is confirmed
--   flows        ordered [{ id, name, when }]: `when` = the base conditions of the rules
--                (countries, devices, languages, query, referrer, referrer_absent) + `cookies`
--                ({ "<name>": present|absent|empty|{equals} }). The first flow that matches wins;
--                no match = the "default" flow
--   steps        [{ id up1…up5|ty, slug, groups? }]; an upsell step's groups split its buyers by
--                front ({ id, name, fronts: ["2","3"] — [] = any other front }) and each group has,
--                per flow id or "default", its page versions ({ slug, weight }: slugs of the same
--                vendor page), its VSL videos ({ id, weight }), its CTA = the offer versions
--                ({ offer: a checkout key, weight }) and its downsells (slots of { offer, weight })
-- `draft` holds the unpublished changes (NULL = none): the dashboard edits the draft, Publish
-- copies it to `live` and keeps the published config in pages.upsell_funnel_history (restore =
-- that config back into the draft). The delivery server only ever reads `live`, through
-- pages.resolve's gate (`upsell`, with the hashes of the vendor page's slugs).
--
-- pages.hits.upsell: what an upsell response served — { f funnel, s step, g group, fl flow,
-- p page version slug, o offer, ds downsell offers } — written by log_hit's new p_upsell (and
-- log_replay passes it). pages.upsell_funnel_stats counts them for the dashboard.
--
-- pages.log_hit, pages.log_replay and pages.resolve are patched in place (resolve carries
-- dayone-main's default_funnel; none of them is ever rewritten from a file here).
-- ============================================================================

-- ── The config's shape ──────────────────────────────────────────────────────

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
  v_slug constant text := '^/([a-z0-9._~-]+(/[a-z0-9._~-]+)*)?$';
  v_key  constant text := '^[a-z][a-z0-9_]{0,39}$';
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
       OR st ->> 'id' = ANY (v_steps) OR coalesce(st ->> 'slug', '') !~ v_slug THEN
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
                      WHERE jsonb_typeof(x) <> 'object' OR coalesce(x ->> 'slug', '') !~ v_slug
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

-- ── The funnels and their published history ─────────────────────────────────

CREATE TABLE pages.upsell_funnels (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  page_id     uuid NOT NULL UNIQUE REFERENCES pages.page_content(id) ON DELETE CASCADE,
  name        text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 120),
  live        jsonb NOT NULL DEFAULT '{"flows": [], "steps": []}'::jsonb,
  draft       jsonb,
  live_at     timestamptz,
  live_by     text,
  created_by  text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE pages.upsell_funnels IS
  'The upsell funnel of a vendor page (Upsells menu): its steps after the checkout (Upsell 1–5, Thank you), the buyers'' groups by front, the flows (rules, in order) and, per group and flow, the page versions, VSLs, CTA offers and downsells with their shares. `live` is what the delivery server serves (pages.resolve gate.upsell); `draft` the unpublished changes (NULL = none). Written only by the upsell_funnel_* functions.';

CREATE TABLE pages.upsell_funnel_history (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  funnel_id     uuid NOT NULL REFERENCES pages.upsell_funnels(id) ON DELETE CASCADE,
  config        jsonb NOT NULL,
  summary       text,
  published_by  text,
  published_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_pages_upsell_history_funnel ON pages.upsell_funnel_history (funnel_id, published_at DESC);
COMMENT ON TABLE pages.upsell_funnel_history IS
  'Every published config of an upsell funnel, with what changed (summary) and who published it. Restore puts one back in the draft.';

ALTER TABLE pages.upsell_funnels ENABLE ROW LEVEL SECURITY;
ALTER TABLE pages.upsell_funnel_history ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON pages.upsell_funnels, pages.upsell_funnel_history FROM public, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON pages.upsell_funnels, pages.upsell_funnel_history TO service_role;

CREATE OR REPLACE FUNCTION pages.upsell_funnels_check()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pages.page_content p WHERE p.id = NEW.page_id AND p.scope = 'VENDOR') THEN
    RAISE EXCEPTION 'upsell: % is not a vendor page', NEW.page_id USING ERRCODE = 'foreign_key_violation';
  END IF;
  PERFORM pages.upsell_config_check(NEW.live);
  IF NEW.draft IS NOT NULL THEN
    PERFORM pages.upsell_config_check(NEW.draft);
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER trg_pages_upsell_funnels_check
  BEFORE INSERT OR UPDATE OF page_id, live, draft ON pages.upsell_funnels
  FOR EACH ROW EXECUTE FUNCTION pages.upsell_funnels_check();

-- ── Writes (NULL back = the funnel changed meanwhile, or doesn't exist) ──────

CREATE OR REPLACE FUNCTION pages.upsell_funnel_create(p_page uuid, p_name text, p_draft jsonb, p_by text)
RETURNS uuid
LANGUAGE sql
SET search_path = ''
AS $$
  INSERT INTO pages.upsell_funnels (page_id, name, draft, created_by)
  VALUES (p_page, btrim(p_name), p_draft, p_by)
  RETURNING id
$$;

CREATE OR REPLACE FUNCTION pages.upsell_funnel_draft_save(p_id uuid, p_draft jsonb, p_name text, p_expected timestamptz)
RETURNS timestamptz
LANGUAGE sql
SET search_path = ''
AS $$
  UPDATE pages.upsell_funnels
  SET draft = p_draft, name = coalesce(nullif(btrim(p_name), ''), name), updated_at = clock_timestamp()
  WHERE id = p_id AND updated_at = p_expected
  RETURNING updated_at
$$;

CREATE OR REPLACE FUNCTION pages.upsell_funnel_draft_discard(p_id uuid, p_expected timestamptz)
RETURNS timestamptz
LANGUAGE sql
SET search_path = ''
AS $$
  UPDATE pages.upsell_funnels SET draft = NULL, updated_at = clock_timestamp()
  WHERE id = p_id AND updated_at = p_expected
  RETURNING updated_at
$$;

CREATE OR REPLACE FUNCTION pages.upsell_funnel_publish(p_id uuid, p_expected timestamptz, p_summary text, p_by text)
RETURNS timestamptz
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  v_at timestamptz;
  v_config jsonb;
BEGIN
  UPDATE pages.upsell_funnels
  SET live = draft, draft = NULL, live_at = clock_timestamp(), live_by = p_by, updated_at = clock_timestamp()
  WHERE id = p_id AND updated_at = p_expected AND draft IS NOT NULL
  RETURNING updated_at, live INTO v_at, v_config;
  IF v_at IS NOT NULL THEN
    INSERT INTO pages.upsell_funnel_history (funnel_id, config, summary, published_by)
    VALUES (p_id, v_config, nullif(left(btrim(coalesce(p_summary, '')), 2000), ''), p_by);
  END IF;
  RETURN v_at;
END $$;

CREATE OR REPLACE FUNCTION pages.upsell_funnel_restore(p_id uuid, p_history bigint, p_expected timestamptz)
RETURNS timestamptz
LANGUAGE sql
SET search_path = ''
AS $$
  UPDATE pages.upsell_funnels f
  SET draft = h.config, updated_at = clock_timestamp()
  FROM pages.upsell_funnel_history h
  WHERE f.id = p_id AND f.updated_at = p_expected AND h.id = p_history AND h.funnel_id = f.id
  RETURNING f.updated_at
$$;

-- ── Logging and numbers ─────────────────────────────────────────────────────

DO $do$
DECLARE i int := 0;
BEGIN
  LOOP
    BEGIN
      LOCK TABLE pages.hits IN ACCESS EXCLUSIVE MODE NOWAIT;
      EXIT;
    EXCEPTION WHEN lock_not_available THEN
      i := i + 1;
      IF i >= 60 THEN
        RAISE EXCEPTION 'could not lock pages.hits in 30 s';
      END IF;
      PERFORM pg_sleep(0.5);
    END;
  END LOOP;
END $do$;

ALTER TABLE pages.hits ADD COLUMN upsell jsonb;
COMMENT ON COLUMN pages.hits.upsell IS
  'An upsell funnel''s response (server/src/upsell.php): { f funnel id, s step, g group, fl flow ("default" = none matched), p page version slug, o offer key, ds downsell offer keys }. NULL on any other hit.';

-- log_hit gains p_upsell (NULL by default: an older server keeps working); log_replay passes it.
DO $do$
DECLARE
  v_sig  constant text := 'pages.log_hit(text,uuid,text,text,text,integer,text,text,boolean,text,text,text,text,integer,text,text,text,uuid,uuid,text,text,text,text,text,text,text,jsonb,text,text,text,text,jsonb,jsonb,boolean,text,text)';
  def    text := pg_get_functiondef(v_sig::regprocedure);
  next   text;
  rdef   text := pg_get_functiondef('pages.log_replay(text, jsonb)'::regprocedure);
  rnext  text;
  v_from text;
BEGIN
  next := replace(def, 'p_vpn_name text DEFAULT NULL::text)', 'p_vpn_name text DEFAULT NULL::text, p_upsell jsonb DEFAULT NULL::jsonb)');
  IF next = def THEN RAISE EXCEPTION 'log_hit: parameter list not found'; END IF;
  def := next;
  next := replace(def, 'is_vpn, vpn_kind, vpn_name)', 'is_vpn, vpn_kind, vpn_name, upsell)');
  IF next = def THEN RAISE EXCEPTION 'log_hit: column list not found'; END IF;
  def := next;
  v_from := $s$nullif(left(btrim(coalesce(p_vpn_name, '')), 120), '')
  )$s$;
  next := replace(def, v_from, $s$nullif(left(btrim(coalesce(p_vpn_name, '')), 120), ''),
    CASE WHEN jsonb_typeof(p_upsell) = 'object' THEN p_upsell END
  )$s$);
  IF next = def THEN RAISE EXCEPTION 'log_hit: values list not found'; END IF;
  def := next;

  v_from := $s$p_vpn_name           => p ->> 'p_vpn_name'$s$;
  IF (length(rdef) - length(replace(rdef, v_from, ''))) / length(v_from) <> 1 THEN
    RAISE EXCEPTION 'log_replay: the log_hit call was not found exactly once';
  END IF;
  rnext := replace(rdef, v_from, v_from || $s$,
          p_upsell             => p -> 'p_upsell'$s$);

  EXECUTE 'DROP FUNCTION ' || v_sig;
  EXECUTE def;
  EXECUTE rnext;
END $do$;
GRANT EXECUTE ON FUNCTION pages.log_hit(text,uuid,text,text,text,integer,text,text,boolean,text,text,text,text,integer,text,text,text,uuid,uuid,text,text,text,text,text,text,text,jsonb,text,text,text,text,jsonb,jsonb,boolean,text,text,jsonb) TO service_role;

CREATE OR REPLACE FUNCTION pages.upsell_funnel_stats(p_funnel uuid, p_since timestamptz)
RETURNS TABLE(step text, grp text, flow text, slug text, offer text, video text, hits bigint, visitors bigint)
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
  'An upsell funnel''s served responses since p_since (200s, from pages.hits.upsell), per step, group, flow, page version, offer and video: hits and distinct IPs. The dashboard''s flow shares and the numbers on the pipeline''s arrows.';

-- ── Delivery: the live funnels in resolve's gate ────────────────────────────

DO $do$
DECLARE
  def  text := pg_get_functiondef('pages.resolve(text, text, text, boolean)'::regprocedure);
  next text;
BEGIN
  next := replace(def,
    $old$'gate_slugs', coalesce(d.gate_slugs, '[]'::jsonb),$old$,
    $new$'gate_slugs', coalesce(d.gate_slugs, '[]'::jsonb),
             -- The vendor pages' upsell funnels, live, by page id, with the hashes of the page's
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
                        ), '{}'::jsonb)))
               FROM pages.upsell_funnels uf
               WHERE d.page ? uf.page_id::text
                 AND jsonb_array_length(coalesce(uf.live -> 'steps', '[]'::jsonb)) > 0
             ), '{}'::jsonb),$new$);
  IF next = def THEN
    RAISE EXCEPTION 'pages.resolve: the gate_slugs entry was not found';
  END IF;
  EXECUTE next;
END $do$;

REVOKE ALL ON FUNCTION pages.upsell_config_check(jsonb) FROM public, anon, authenticated;
REVOKE ALL ON FUNCTION pages.upsell_funnels_check() FROM public, anon, authenticated;
REVOKE ALL ON FUNCTION pages.upsell_funnel_create(uuid, text, jsonb, text) FROM public, anon, authenticated;
REVOKE ALL ON FUNCTION pages.upsell_funnel_draft_save(uuid, jsonb, text, timestamptz) FROM public, anon, authenticated;
REVOKE ALL ON FUNCTION pages.upsell_funnel_draft_discard(uuid, timestamptz) FROM public, anon, authenticated;
REVOKE ALL ON FUNCTION pages.upsell_funnel_publish(uuid, timestamptz, text, text) FROM public, anon, authenticated;
REVOKE ALL ON FUNCTION pages.upsell_funnel_restore(uuid, bigint, timestamptz) FROM public, anon, authenticated;
REVOKE ALL ON FUNCTION pages.upsell_funnel_stats(uuid, timestamptz) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION pages.upsell_config_check(jsonb) TO service_role;
GRANT EXECUTE ON FUNCTION pages.upsell_funnel_create(uuid, text, jsonb, text) TO service_role;
GRANT EXECUTE ON FUNCTION pages.upsell_funnel_draft_save(uuid, jsonb, text, timestamptz) TO service_role;
GRANT EXECUTE ON FUNCTION pages.upsell_funnel_draft_discard(uuid, timestamptz) TO service_role;
GRANT EXECUTE ON FUNCTION pages.upsell_funnel_publish(uuid, timestamptz, text, text) TO service_role;
GRANT EXECUTE ON FUNCTION pages.upsell_funnel_restore(uuid, bigint, timestamptz) TO service_role;
GRANT EXECUTE ON FUNCTION pages.upsell_funnel_stats(uuid, timestamptz) TO service_role;
