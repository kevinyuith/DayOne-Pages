-- ============================================================================
-- DayOne Pages — funnel library and A/B test of each funnel step
--
-- 1. Funnels are templates with kind = 'FUNNEL'. They live in their own
--    dashboard screen (Funil), with their own folder tree: folders.scope says
--    which screen a folder belongs to ('TEMPLATE' or 'FUNNEL'); a subfolder
--    always has the scope of its parent. A domain gets a copy of a funnel the
--    same way it gets a copy of a template (domain_page_copy).
--
-- 2. A step (Pre Lander, Lander, Backredirect) can have several versions
--    ("samples"): sibling <section data-dop-page> with the same kind, each
--    with a data-dop-weight. The delivery server picks one version per step
--    for each visitor (sticky cookie) and serves only that one.
--
-- 3. pages.funnel_events: what the visitor's browser reports for a version:
--    'view' (the version was shown) and 'click' (a click from it to the next
--    step or out of the page, e.g. to the offer). One row per visitor, step
--    version and event (the first time): counts are unique visitors.
--    log_funnel_event is called by the delivery server (server key, like
--    log_load); funnel_stats aggregates it for the dashboard (service_role).
-- ============================================================================

-- ── 1. Funnel kind and folder scope ─────────────────────────────────────────

ALTER TABLE pages.pages DROP CONSTRAINT IF EXISTS pages_kind_check;
ALTER TABLE pages.pages ADD CONSTRAINT pages_kind_check
  CHECK (kind = ANY (ARRAY['PRESELL', 'ADVERTORIAL', 'VSL', 'CHECKOUT', 'SAFE', 'OTHER', 'FUNNEL']));
COMMENT ON COLUMN pages.pages.kind IS 'Page kind. FUNNEL = a funnel (shown in the Funil screen instead of Templates).';

ALTER TABLE pages.folders ADD COLUMN IF NOT EXISTS scope text NOT NULL DEFAULT 'TEMPLATE';
ALTER TABLE pages.folders DROP CONSTRAINT IF EXISTS ck_folders_scope;
ALTER TABLE pages.folders ADD CONSTRAINT ck_folders_scope CHECK (scope IN ('TEMPLATE', 'FUNNEL'));
COMMENT ON COLUMN pages.folders.scope IS 'Which dashboard screen the folder belongs to: TEMPLATE (Templates) or FUNNEL (Funil).';
CREATE INDEX IF NOT EXISTS idx_pages_folders_scope ON pages.folders (scope);

-- A subfolder has the scope of its parent.
CREATE OR REPLACE FUNCTION pages.folders_same_scope()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  IF NEW.parent_id IS NOT NULL AND EXISTS (
    SELECT 1 FROM pages.folders p WHERE p.id = NEW.parent_id AND p.scope <> NEW.scope
  ) THEN
    RAISE EXCEPTION 'folders: a subfolder must have the scope of its parent' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS folders_same_scope ON pages.folders;
CREATE TRIGGER folders_same_scope
  BEFORE INSERT OR UPDATE OF parent_id, scope ON pages.folders
  FOR EACH ROW EXECUTE FUNCTION pages.folders_same_scope();

-- ── 2/3. Funnel events ──────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS pages.funnel_events (
  id         bigint      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  created_at timestamptz NOT NULL DEFAULT now(),
  domain_id  uuid        NOT NULL REFERENCES pages.domains(id) ON DELETE CASCADE,
  path       text        NOT NULL,
  step_id    text        NOT NULL,
  kind       text        NOT NULL,
  event      text        NOT NULL,
  visitor    text        NOT NULL,
  CONSTRAINT ck_funnel_events_path    CHECK (path ~ '^/' AND length(path) <= 512),
  CONSTRAINT ck_funnel_events_step    CHECK (step_id ~ '^p_[a-z0-9]{1,16}$'),
  CONSTRAINT ck_funnel_events_kind    CHECK (kind IN ('presell', 'main', 'backredirect')),
  CONSTRAINT ck_funnel_events_event   CHECK (event IN ('view', 'click')),
  CONSTRAINT ck_funnel_events_visitor CHECK (visitor ~ '^[0-9a-f]{16}$')
);
COMMENT ON TABLE pages.funnel_events IS 'First view / click of each visitor on each funnel step version (A/B test). Written by the delivery server (log_funnel_event); read through funnel_stats.';
COMMENT ON COLUMN pages.funnel_events.step_id IS 'The version: data-dop-page id of the <section> that was shown or clicked.';
COMMENT ON COLUMN pages.funnel_events.event   IS 'view = the version was shown; click = a click from it to the next step or out of the page.';
COMMENT ON COLUMN pages.funnel_events.visitor IS 'Random visitor id from the dop_ab cookie (not personal data).';

CREATE UNIQUE INDEX IF NOT EXISTS uq_funnel_events_once
  ON pages.funnel_events (domain_id, path, step_id, event, visitor);
CREATE INDEX IF NOT EXISTS idx_funnel_events_domain_time
  ON pages.funnel_events (domain_id, created_at);

ALTER TABLE pages.funnel_events ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON pages.funnel_events FROM public, anon, authenticated;
GRANT SELECT, INSERT, DELETE ON pages.funnel_events TO service_role;

-- Called by the delivery server after the response is gone. Invalid input is
-- ignored (the endpoint is public); a bad server key raises, like log_load.
CREATE OR REPLACE FUNCTION pages.log_funnel_event(
  p_key text, p_host text, p_path text, p_step text, p_kind text, p_event text, p_visitor text
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_domain uuid;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pages.server_keys k
    WHERE k.key_hash = encode(sha256(convert_to(coalesce(p_key, ''), 'UTF8')), 'hex')
      AND k.revoked_at IS NULL
  ) THEN
    RAISE EXCEPTION 'pages.log_funnel_event: invalid key' USING ERRCODE = '28000';
  END IF;

  IF coalesce(p_path, '') !~ '^/' OR length(p_path) > 512
     OR coalesce(p_step, '') !~ '^p_[a-z0-9]{1,16}$'
     OR coalesce(p_kind, '') NOT IN ('presell', 'main', 'backredirect')
     OR coalesce(p_event, '') NOT IN ('view', 'click')
     OR coalesce(p_visitor, '') !~ '^[0-9a-f]{16}$' THEN
    RETURN;
  END IF;

  SELECT d.id INTO v_domain FROM pages.domains d WHERE d.domain = lower(p_host) AND d.status = 'ACTIVE';
  IF v_domain IS NULL THEN
    RETURN;
  END IF;

  INSERT INTO pages.funnel_events (domain_id, path, step_id, kind, event, visitor)
  VALUES (v_domain, p_path, p_step, p_kind, p_event, p_visitor)
  ON CONFLICT (domain_id, path, step_id, event, visitor) DO NOTHING;
END $$;

-- Unique visitors who saw / clicked each version since p_since.
-- p_domain_ids NULL = all domains.
CREATE OR REPLACE FUNCTION pages.funnel_stats(p_domain_ids uuid[], p_since timestamptz)
RETURNS TABLE (domain_id uuid, path text, step_id text, kind text, views bigint, clicks bigint)
LANGUAGE sql
STABLE
SET search_path = ''
AS $$
  SELECT e.domain_id, e.path, e.step_id, min(e.kind),
         count(*) FILTER (WHERE e.event = 'view'),
         count(*) FILTER (WHERE e.event = 'click')
  FROM pages.funnel_events e
  WHERE (p_domain_ids IS NULL OR e.domain_id = ANY (p_domain_ids))
    AND e.created_at >= p_since
  GROUP BY e.domain_id, e.path, e.step_id
$$;

REVOKE ALL ON FUNCTION pages.log_funnel_event(text, text, text, text, text, text, text) FROM public, authenticated;
GRANT EXECUTE ON FUNCTION pages.log_funnel_event(text, text, text, text, text, text, text) TO anon, service_role;
REVOKE ALL ON FUNCTION pages.funnel_stats(uuid[], timestamptz) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION pages.funnel_stats(uuid[], timestamptz) TO service_role;
REVOKE ALL ON FUNCTION pages.folders_same_scope() FROM public, anon, authenticated;

NOTIFY pgrst, 'reload schema';
