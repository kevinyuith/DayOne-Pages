-- ============================================================================
-- DayOne Pages — page folders (organization of the /templates screen)
--
-- Incremental and idempotent. Everything in the `pages` schema. Only the dashboard (service
-- key) reads and writes; the delivery server does not know folders exist.
--
--   pages.folders           folder tree (parent_id NULL = root), with a color
--   pages.pages.folder_id   which folder the page is in (NULL = root)
--
-- Rules the database guarantees (the UI does too, but the UI is not the only door):
--   - a folder cannot be moved into itself / into a descendant
--     (trigger pages.folders_no_cycle). Best effort: the trigger looks at the chain
--     of parents of the changed row, without a lock; two simultaneous moves in opposite
--     directions could still cross. The screen tolerates a cycle (it does not hang, it only
--     cuts the path), so the risk is cosmetic.
--   - maximum depth 20 counted up to the moved folder (its subtree does not
--     count; it is a sanity ceiling, not an exact guarantee)
--   - deleting a folder does NOT delete pages: they and the subfolders move up to the
--     parent folder (the dashboard does this before the DELETE); if anything slips through,
--     ON DELETE SET NULL sends it to the root instead of failing.
-- ============================================================================


-- ┌──────────────────────────────────────────────────────────────────────────┐
-- │ Table                                                                    │
-- └──────────────────────────────────────────────────────────────────────────┘

CREATE TABLE IF NOT EXISTS pages.folders (
  id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text        NOT NULL,
  parent_id   uuid        REFERENCES pages.folders(id) ON DELETE SET NULL,
  color       text,                       -- UI color key (e.g. 'blue'); NULL = default
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ck_folders_name  CHECK (length(btrim(name)) BETWEEN 1 AND 80),
  CONSTRAINT ck_folders_color CHECK (color IS NULL OR color ~ '^[a-z]{3,20}$')
);

COMMENT ON TABLE  pages.folders           IS '(Nested) folders that organize the dashboard''s pages screen.';
COMMENT ON COLUMN pages.folders.parent_id IS 'Parent folder; NULL = root.';
COMMENT ON COLUMN pages.folders.color     IS 'Key of the color chosen in the UI; NULL = default color.';

CREATE INDEX IF NOT EXISTS idx_pages_folders_parent ON pages.folders (parent_id);

ALTER TABLE pages.folders ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON pages.folders FROM anon, authenticated;

ALTER TABLE pages.pages
  ADD COLUMN IF NOT EXISTS folder_id uuid REFERENCES pages.folders(id) ON DELETE SET NULL;

COMMENT ON COLUMN pages.pages.folder_id IS 'The page''s folder on the dashboard screen; NULL = root.';

CREATE INDEX IF NOT EXISTS idx_pages_pages_folder ON pages.pages (folder_id);


-- ┌──────────────────────────────────────────────────────────────────────────┐
-- │ updated_at                                                                │
-- └──────────────────────────────────────────────────────────────────────────┘

CREATE OR REPLACE FUNCTION pages.folders_touch_updated_at()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_folders_touch_updated_at ON pages.folders;
CREATE TRIGGER trg_folders_touch_updated_at
  BEFORE UPDATE ON pages.folders
  FOR EACH ROW EXECUTE FUNCTION pages.folders_touch_updated_at();


-- ┌──────────────────────────────────────────────────────────────────────────┐
-- │ No cycles, no absurd depth                                               │
-- └──────────────────────────────────────────────────────────────────────────┘

CREATE OR REPLACE FUNCTION pages.folders_no_cycle()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  cur   uuid := NEW.parent_id;
  depth int  := 0;
BEGIN
  IF NEW.parent_id IS NULL THEN
    RETURN NEW;
  END IF;
  IF NEW.parent_id = NEW.id THEN
    RAISE EXCEPTION 'a folder cannot be inside itself' USING ERRCODE = 'check_violation';
  END IF;
  WHILE cur IS NOT NULL LOOP
    depth := depth + 1;
    IF cur = NEW.id THEN
      RAISE EXCEPTION 'a folder cannot be inside one of its own subfolders' USING ERRCODE = 'check_violation';
    END IF;
    IF depth > 20 THEN
      RAISE EXCEPTION 'folders nested too deep (maximum 20 levels)' USING ERRCODE = 'check_violation';
    END IF;
    SELECT parent_id INTO cur FROM pages.folders WHERE id = cur;
  END LOOP;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_folders_no_cycle ON pages.folders;
CREATE TRIGGER trg_folders_no_cycle
  BEFORE INSERT OR UPDATE OF parent_id ON pages.folders
  FOR EACH ROW EXECUTE FUNCTION pages.folders_no_cycle();
