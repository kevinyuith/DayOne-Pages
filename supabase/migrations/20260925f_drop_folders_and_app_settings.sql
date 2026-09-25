-- ============================================================================
-- DayOne Pages — drop pages.folders, pages.pages.folder_id and pages.app_settings
-- (step 2 of 20260925e — apply AFTER the dashboard that reads `folder` is live)
--
--   * A template that the old dashboard put in a folder meanwhile (folder_id
--     set, folder still NULL) gets its path first.
--   * The folder functions, pages_summary and the updated_at trigger lose
--     folder_id; then the column, pages.folders and its functions go.
--   * pages.app_settings (only `ai.model`) goes: the model is fixed in the
--     code (AI_MODEL in src/lib/ai-settings.ts).
-- ============================================================================

-- ── Last fill from the folder tree ──────────────────────────────────────────

WITH RECURSIVE tree AS (
  SELECT f.id, btrim(f.name) AS path, 1 AS depth FROM pages.folders f WHERE f.parent_id IS NULL
  UNION ALL
  SELECT c.id, t.path || '/' || btrim(c.name), t.depth + 1 FROM pages.folders c JOIN tree t ON c.parent_id = t.id WHERE t.depth < 10
)
UPDATE pages.pages p SET folder = t.path FROM tree t WHERE p.folder_id = t.id AND p.scope = 'TEMPLATE' AND p.folder IS NULL;

-- ── Without folder_id ───────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION pages.template_folder_move(p_from text, p_to text)
RETURNS integer
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  n integer;
BEGIN
  IF coalesce(btrim(p_from), '') = '' OR coalesce(btrim(p_to), '') = '' THEN
    RAISE EXCEPTION 'template_folder_move: from and to are required' USING ERRCODE = '22023';
  END IF;
  IF p_to = p_from THEN
    RETURN 0;
  END IF;
  IF left(p_to, length(p_from) + 1) = p_from || '/' THEN
    RAISE EXCEPTION 'template_folder_move: a folder can''t go inside itself' USING ERRCODE = 'check_violation';
  END IF;
  UPDATE pages.pages p
  SET folder = p_to || substr(p.folder, length(p_from) + 1)
  WHERE p.scope = 'TEMPLATE' AND (p.folder = p_from OR left(p.folder, length(p_from) + 1) = p_from || '/');
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END $$;

CREATE OR REPLACE FUNCTION pages.template_folder_delete(p_path text)
RETURNS integer
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  v_parent text := nullif(regexp_replace(coalesce(p_path, ''), '/?[^/]+$', ''), '');
  n integer;
BEGIN
  IF coalesce(btrim(p_path), '') = '' THEN
    RAISE EXCEPTION 'template_folder_delete: the folder is required' USING ERRCODE = '22023';
  END IF;
  UPDATE pages.pages p
  SET folder = nullif(concat_ws('/', v_parent, nullif(substr(p.folder, length(p_path) + 2), '')), '')
  WHERE p.scope = 'TEMPLATE' AND (p.folder = p_path OR left(p.folder, length(p_path) + 1) = p_path || '/');
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END $$;

DROP FUNCTION IF EXISTS pages.pages_summary(uuid[], text);

CREATE FUNCTION pages.pages_summary(p_ids uuid[] DEFAULT NULL, p_scope text DEFAULT NULL)
RETURNS TABLE(id uuid, scope text, name text, kind text, status text, notes text, folder text, template_id uuid, funnel_id uuid,
              funnel_page_id uuid, created_at text, updated_at text, slugs jsonb)
LANGUAGE sql
STABLE
SET search_path TO ''
AS $function$
  SELECT p.id, p.scope, p.name, p.kind, p.status, p.notes, p.folder, p.template_id, p.funnel_id, p.funnel_page_id,
         to_jsonb(p.created_at) #>> '{}', to_jsonb(p.updated_at) #>> '{}', pages.slugs_summary(p.slugs)
  FROM pages.pages p
  WHERE (p_ids IS NULL OR p.id = ANY (p_ids)) AND (p_scope IS NULL OR p.scope = p_scope)
  ORDER BY p.updated_at DESC
$function$;

REVOKE ALL ON FUNCTION pages.pages_summary(uuid[], text) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION pages.pages_summary(uuid[], text) TO service_role;

DROP TRIGGER IF EXISTS trg_pages_pages_updated_at ON pages.pages;
ALTER TABLE pages.pages DROP COLUMN IF EXISTS folder_id;
CREATE TRIGGER trg_pages_pages_updated_at BEFORE UPDATE ON pages.pages
  FOR EACH ROW
  WHEN ((to_jsonb(OLD) - 'folder' - 'updated_at') IS DISTINCT FROM (to_jsonb(NEW) - 'folder' - 'updated_at'))
  EXECUTE FUNCTION pages.set_updated_at();

-- ── The tables ──────────────────────────────────────────────────────────────

DROP TABLE IF EXISTS pages.folders;
DROP FUNCTION IF EXISTS pages.folders_same_scope();
DROP FUNCTION IF EXISTS pages.folders_no_cycle();
DROP TABLE IF EXISTS pages.app_settings;

NOTIFY pgrst, 'reload schema';
