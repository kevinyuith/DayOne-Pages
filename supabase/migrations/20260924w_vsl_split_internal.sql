-- ============================================================================
-- DayOne Pages — the funnel's VSL split is ours, not VTurb's
--
-- pages.funnels.vsl stops being a replica of a VTurb A/B test: it IS the
-- split. The dashboard saves it here only (nothing is sent to VTurb), and the
-- delivery server draws one video per visitor by these shares (server/src/
-- vsl.php), putting it in the page's A/B VTurb player. VTurb only plays it.
--
--   * vsl_synced_at → vsl_updated_at (the split's version, for concurrency);
--     vturb_group_id is dropped (no VTurb test behind the split any more).
--   * The shares of a split add up to 100 (checked by the trigger).
--   * funnel_vsl_save → funnel_vsl_set(p_funnel, p_vsl, p_expected): saves
--     only if nobody saved in between (40001 otherwise).
--   * pages.resolve gains `vsl`: the served page's funnel videos with a share
--     above 0, [{ id, weight }] (old servers ignore the extra column).
--   * pages.vturb_player_find(): a VTurb video's name from dayone-main's copy
--     of the library (read-only), to add a pasted video id — the VTurb API and
--     pages.vturb_token() are no longer used.
-- ============================================================================

-- ── Columns ─────────────────────────────────────────────────────────────────

DROP FUNCTION IF EXISTS pages.funnel_vsl_save(uuid, text, jsonb);
DROP FUNCTION IF EXISTS pages.funnel_vsl_panel(uuid);

ALTER TABLE pages.funnels RENAME COLUMN vsl_synced_at TO vsl_updated_at;
ALTER TABLE pages.funnels DROP COLUMN vturb_group_id;

COMMENT ON COLUMN pages.funnels.vsl IS '{ "<VTurb player id>": { "weight": 0-100, "name": "…" } }: the funnel''s VSL split. The delivery server draws one video per visitor by these shares (0 = paused); they add up to 100.';
COMMENT ON COLUMN pages.funnels.vsl_updated_at IS 'When vsl was last saved (the split''s version: funnel_vsl_set saves only over the version it read).';

-- ── The split adds up to 100 ────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION pages.funnels_vsl_check()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  v record;
  total numeric := 0;
BEGIN
  IF coalesce(jsonb_typeof(NEW.vsl), '') <> 'object' THEN
    RAISE EXCEPTION 'funnels.vsl must be an object' USING ERRCODE = 'check_violation';
  END IF;
  FOR v IN SELECT key, value FROM jsonb_each(NEW.vsl) LOOP
    IF v.key !~ '^[0-9a-f]{24}$'
       OR coalesce(jsonb_typeof(v.value), '') <> 'object'
       OR coalesce(jsonb_typeof(v.value -> 'weight'), '') <> 'number'
       OR (v.value ->> 'weight')::numeric NOT BETWEEN 0 AND 100
       OR coalesce(jsonb_typeof(v.value -> 'name'), 'string') NOT IN ('string', 'null') THEN
      RAISE EXCEPTION 'funnels.vsl: invalid video %', v.key USING ERRCODE = 'check_violation';
    END IF;
    total := total + (v.value ->> 'weight')::numeric;
  END LOOP;
  IF NEW.vsl <> '{}'::jsonb AND abs(total - 100) > 0.001 THEN
    RAISE EXCEPTION 'funnels.vsl: the shares add up to %, not 100', total USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;

-- ── Saving the split ────────────────────────────────────────────────────────

-- Saves the funnel's split if its version is still p_expected (the
-- vsl_updated_at the screen loaded; NULL = never saved). Returns the new
-- version. Someone saved in between: 40001, nothing written.
CREATE OR REPLACE FUNCTION pages.funnel_vsl_set(p_funnel uuid, p_vsl jsonb, p_expected timestamptz)
RETURNS timestamptz
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  v_at timestamptz;
BEGIN
  UPDATE pages.funnels f
  SET vsl = coalesce(p_vsl, '{}'::jsonb), vsl_updated_at = clock_timestamp()
  WHERE f.id = p_funnel AND f.vsl_updated_at IS NOT DISTINCT FROM p_expected
  RETURNING f.vsl_updated_at INTO v_at;
  IF FOUND THEN
    RETURN v_at;
  END IF;
  IF EXISTS (SELECT 1 FROM pages.funnels f WHERE f.id = p_funnel) THEN
    RAISE EXCEPTION 'funnel_vsl_set: the split changed since it was loaded' USING ERRCODE = 'serialization_failure';
  END IF;
  RAISE EXCEPTION 'funnel_vsl_set: funnel not found' USING ERRCODE = 'no_data_found';
END $$;

-- ── The VSLs tab ────────────────────────────────────────────────────────────

-- A funnel's VSLs tab (by dayone-main funnel id): its pages.funnels row, its
-- split and the dayone-main VSLs (not archived) that can match its videos (by
-- a VTurb player id the VSL pipeline recorded, or by title = video name
-- without ".mp4"). NULL = no row.
CREATE FUNCTION pages.funnel_vsl_panel(p_main_funnel uuid)
RETURNS jsonb
LANGUAGE sql
STABLE
SET search_path = ''
AS $$
  WITH f AS (
    SELECT t.id, t.vsl, t.vsl_updated_at,
           ARRAY(SELECT jsonb_object_keys(t.vsl)) AS ids,
           ARRAY(SELECT k FROM (SELECT pages.vsl_title_key(x.v ->> 'name') AS k FROM jsonb_each(t.vsl) AS x(id, v)) n WHERE k <> '') AS names
    FROM pages.funnels t
    WHERE t.main_funnel_id = p_main_funnel
  )
  SELECT jsonb_build_object(
    'id', f.id,
    'updated_at', f.vsl_updated_at,
    'vsl', f.vsl,
    'vsls', coalesce((
      SELECT jsonb_agg(jsonb_build_object('vsl_id', e.id, 'title', e.title, 'funnel_status', e.funnel_status::text, 'language', e.language,
                                          'pitch', e.pitch, 'copywriter', e.copywriter_name, 'editor', e.editor_name,
                                          'video_ids', e.video_id::text[], 'video_url', nullif(e.metadata ->> 'video_url', ''))
                       ORDER BY e.updated_at DESC NULLS LAST, e.id)
      FROM public.v_vsl_explorer e
      WHERE e.archived_at IS NULL
        AND (e.video_id::text[] && f.ids OR pages.vsl_title_key(e.title) = ANY (f.names))), '[]'::jsonb))
  FROM f
$$;

COMMENT ON FUNCTION pages.funnel_vsl_panel(uuid) IS 'A funnel''s VSLs tab: its split (pages.funnels.vsl) and the dayone-main VSLs matching its videos. Read-only on dayone-main.';

-- ── A pasted VTurb video id ─────────────────────────────────────────────────

-- The name of a VTurb video (player) from dayone-main's copy of the VTurb
-- library (read-only); no row = not in the library (yet).
CREATE OR REPLACE FUNCTION pages.vturb_player_find(p_player text)
RETURNS TABLE (id text, name text)
LANGUAGE sql
STABLE
SET search_path = ''
AS $$
  SELECT p.player_id, p.name
  FROM (
    SELECT player_id, name, 1 AS o FROM vturb.folder_players WHERE player_id = p_player
    UNION ALL SELECT player_id, name, 2 FROM vturb.active_players WHERE player_id = p_player
    UNION ALL SELECT player_id, name, 3 FROM vturb.group_players WHERE player_id = p_player
  ) p
  ORDER BY p.o, p.name NULLS LAST
  LIMIT 1
$$;

COMMENT ON FUNCTION pages.vturb_player_find(text) IS 'A VTurb video''s name from dayone-main''s copy of the VTurb library (read-only), to add a pasted video id to a funnel''s split.';

DROP FUNCTION IF EXISTS pages.vturb_token();

-- ── resolve: the funnel's VSL split goes with the route ─────────────────────

DROP FUNCTION pages.resolve(text, text, text, boolean);

CREATE FUNCTION pages.resolve(p_host text, p_path text, p_key text, p_with_content boolean DEFAULT true)
RETURNS TABLE(route_id uuid, domain_id uuid, priority integer, match_type text, path_pattern text, conditions jsonb,
              action text, page_id uuid, slug text, slug_id uuid, content_type text, content_hash text, redirect_url text,
              status_code smallint, preserve_query boolean, content text, placeholders jsonb, split jsonb, vsl jsonb)
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO ''
AS $function$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pages.server_keys k
    WHERE k.key_hash = encode(sha256(convert_to(coalesce(p_key, ''), 'UTF8')), 'hex')
      AND k.revoked_at IS NULL
  ) THEN
    RAISE EXCEPTION 'pages.resolve: invalid key' USING ERRCODE = '28000';
  END IF;

  RETURN QUERY
    SELECT m.route_id, m.domain_id, m.priority, m.match_type, m.path_pattern,
           m.conditions, m.action, m.page_id, m.slug, m.slug_id,
           m.content_type, m.content_hash, m.redirect_url, m.status_code,
           m.preserve_query,
           CASE WHEN p_with_content AND m.slug_id IS NOT NULL
                THEN (SELECT p.slugs -> m.slug ->> 'content' FROM pages.pages p WHERE p.id = m.page_id) END AS content,
           d.placeholders || jsonb_build_object('domain', d.domain) AS placeholders,
           sp.split,
           vs.vsl
    FROM pages.match_routes(p_host, p_path) AS m
    LEFT JOIN pages.domains AS d ON d.id = m.domain_id
    -- The funnel of the resolved page (a copy of a funnel page), if any.
    LEFT JOIN LATERAL (
      SELECT rp.funnel_id FROM pages.pages rp
      WHERE m.slug_id IS NOT NULL AND rp.id = m.page_id AND rp.funnel_id IS NOT NULL
    ) f ON true
    -- Every published copy of a page of that funnel on this domain with an
    -- active slug at this path; the weight comes live from funnels.site
    -- (a page removed from the funnel = 0).
    LEFT JOIN LATERAL (
      SELECT jsonb_agg(jsonb_build_object(
               'page_id', p.id,
               'slug_id', md5(d.id::text || ':' || p.id::text || ':' || m.slug)::uuid,
               'content_type', coalesce(sl.s ->> 'content_type', 'text/html; charset=utf-8'),
               'content_hash', sl.s ->> 'content_hash',
               'content', CASE WHEN p_with_content THEN sl.s ->> 'content' END,
               'weight', coalesce((fu.site -> p.funnel_page_id::text ->> 'weight')::int, 0))
             ORDER BY p.created_at, p.id) AS split
      FROM jsonb_object_keys(d.site) k
      JOIN pages.pages p ON p.id = k::uuid
      LEFT JOIN pages.funnels fu ON fu.id = p.funnel_id
      CROSS JOIN LATERAL (SELECT p.slugs -> m.slug AS s) sl
      WHERE f.funnel_id IS NOT NULL
        AND p.funnel_id = f.funnel_id
        AND p.status = 'PUBLISHED'
        AND coalesce((sl.s ->> 'is_active')::boolean, false)
      HAVING count(*) > 1
    ) sp ON true
    -- The funnel's VSL split, live: its videos with a share above 0 (the
    -- server draws one per visitor for the page's A/B VTurb player).
    LEFT JOIN LATERAL (
      SELECT jsonb_agg(jsonb_build_object('id', x.key, 'weight', (x.value ->> 'weight')::numeric) ORDER BY x.key) AS vsl
      FROM pages.funnels fu
      CROSS JOIN LATERAL jsonb_each(fu.vsl) x
      WHERE f.funnel_id IS NOT NULL AND fu.id = f.funnel_id AND (x.value ->> 'weight')::numeric > 0
    ) vs ON true;
END $function$;

COMMENT ON FUNCTION pages.resolve(text, text, text, boolean) IS 'The delivery server''s decision for host + path (server key required): candidate routes, content hashes (and HTML with p_with_content), the A/B split between funnel pages and the funnel''s VSL split.';

-- ── Grants ──────────────────────────────────────────────────────────────────

REVOKE ALL ON FUNCTION pages.resolve(text, text, text, boolean) FROM public, authenticated;
GRANT EXECUTE ON FUNCTION pages.resolve(text, text, text, boolean) TO anon, service_role;

DO $$
DECLARE
  fn text;
BEGIN
  FOREACH fn IN ARRAY ARRAY[
    'pages.funnel_vsl_set(uuid, jsonb, timestamptz)',
    'pages.funnel_vsl_panel(uuid)',
    'pages.vturb_player_find(text)'
  ] LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM public, anon, authenticated', fn);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role', fn);
  END LOOP;
END $$;
REVOKE ALL ON FUNCTION pages.funnels_vsl_check() FROM public, anon, authenticated;

NOTIFY pgrst, 'reload schema';
