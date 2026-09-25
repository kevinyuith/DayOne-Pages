-- ============================================================================
-- DayOne Pages — a template's folder is a path on the page (step 1 of 2)
--
-- pages.folders goes away: a template keeps its folder as a path in
-- pages.pages.folder ("Funnels/F23 - BAKING SODA/White"; NULL = the root). A
-- folder exists while a template is in it. Renaming, moving and deleting a
-- folder rewrite the paths of the templates inside it, in one statement:
--
--   pages.template_folder_move(p_from, p_to)   rename/move (subfolders too)
--   pages.template_folder_delete(p_path)       what was inside moves up a level
--
-- This step only ADDS (the dashboard live before the deploy still reads
-- folder_id and pages.folders): the column, filled from the folder tree, the
-- functions, and `folder` at the end of pages_summary. Step 2
-- (20260925f) fills again what the old dashboard moved meanwhile and drops
-- folder_id, pages.folders and pages.app_settings.
--
-- Changing only the folder doesn't touch updated_at any more: moving a
-- template doesn't make an open editor see a conflict.
-- ============================================================================

-- ── updated_at: not for a folder change ─────────────────────────────────────

DROP TRIGGER IF EXISTS trg_pages_pages_updated_at ON pages.pages;
CREATE TRIGGER trg_pages_pages_updated_at BEFORE UPDATE ON pages.pages
  FOR EACH ROW
  WHEN ((to_jsonb(OLD) - 'folder' - 'folder_id' - 'updated_at') IS DISTINCT FROM (to_jsonb(NEW) - 'folder' - 'folder_id' - 'updated_at'))
  EXECUTE FUNCTION pages.set_updated_at();

-- ── The column ──────────────────────────────────────────────────────────────

ALTER TABLE pages.pages ADD COLUMN IF NOT EXISTS folder text;
COMMENT ON COLUMN pages.pages.folder IS 'A template''s folder as a path ("Funnels/F23/White"); NULL = the root. Segments of 1 to 80 characters without "/" nor spaces at the ends, up to 10 levels. Templates only.';

-- Filled from the folder tree (names trimmed).
WITH RECURSIVE tree AS (
  SELECT f.id, btrim(f.name) AS path, 1 AS depth FROM pages.folders f WHERE f.parent_id IS NULL
  UNION ALL
  SELECT c.id, t.path || '/' || btrim(c.name), t.depth + 1 FROM pages.folders c JOIN tree t ON c.parent_id = t.id WHERE t.depth < 10
)
UPDATE pages.pages p SET folder = t.path FROM tree t WHERE p.folder_id = t.id AND p.scope = 'TEMPLATE';

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'pages_folder_path' AND conrelid = 'pages.pages'::regclass) THEN
    ALTER TABLE pages.pages ADD CONSTRAINT pages_folder_path CHECK (
      folder IS NULL OR (
        scope = 'TEMPLATE'
        AND length(folder) <= 820
        AND folder ~ '^[^/[:space:]]([^/]{0,78}[^/[:space:]])?(/[^/[:space:]]([^/]{0,78}[^/[:space:]])?){0,9}$'
      )
    );
  END IF;
END $$;

-- ── Folder operations ───────────────────────────────────────────────────────

-- Renames or moves a folder: every template in p_from or below gets p_to in
-- its place (subfolders go along). Into itself or a subfolder: refused.
-- Returns how many templates moved.
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
  SET folder = p_to || substr(p.folder, length(p_from) + 1), folder_id = NULL
  WHERE p.scope = 'TEMPLATE' AND (p.folder = p_from OR left(p.folder, length(p_from) + 1) = p_from || '/');
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END $$;

-- Deletes a folder without deleting anything: its templates and subfolders
-- move up one level (to the parent folder, or the root). Returns how many
-- templates moved.
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
  SET folder = nullif(concat_ws('/', v_parent, nullif(substr(p.folder, length(p_path) + 2), '')), ''), folder_id = NULL
  WHERE p.scope = 'TEMPLATE' AND (p.folder = p_path OR left(p.folder, length(p_path) + 1) = p_path || '/');
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END $$;

COMMENT ON FUNCTION pages.template_folder_move(text, text) IS 'Renames/moves a folder of templates: the paths of the templates in it (and below) get the new one.';
COMMENT ON FUNCTION pages.template_folder_delete(text) IS 'Deletes a folder of templates without deleting anything: what was inside moves up one level.';

-- ── pages_summary: + folder (folder_id stays until step 2) ──────────────────

DROP FUNCTION IF EXISTS pages.pages_summary(uuid[], text);

CREATE FUNCTION pages.pages_summary(p_ids uuid[] DEFAULT NULL, p_scope text DEFAULT NULL)
RETURNS TABLE(id uuid, scope text, name text, kind text, status text, notes text, folder_id uuid, template_id uuid, funnel_id uuid,
              funnel_page_id uuid, created_at text, updated_at text, slugs jsonb, folder text)
LANGUAGE sql
STABLE
SET search_path TO ''
AS $function$
  SELECT p.id, p.scope, p.name, p.kind, p.status, p.notes, p.folder_id, p.template_id, p.funnel_id, p.funnel_page_id,
         to_jsonb(p.created_at) #>> '{}', to_jsonb(p.updated_at) #>> '{}', pages.slugs_summary(p.slugs), p.folder
  FROM pages.pages p
  WHERE (p_ids IS NULL OR p.id = ANY (p_ids)) AND (p_scope IS NULL OR p.scope = p_scope)
  ORDER BY p.updated_at DESC
$function$;

-- ── Grants ──────────────────────────────────────────────────────────────────

DO $$
DECLARE
  fn text;
BEGIN
  FOREACH fn IN ARRAY ARRAY[
    'pages.template_folder_move(text, text)',
    'pages.template_folder_delete(text)',
    'pages.pages_summary(uuid[], text)'
  ] LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM public, anon, authenticated', fn);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role', fn);
  END LOOP;
END $$;

NOTIFY pgrst, 'reload schema';
