-- ============================================================================
-- DayOne Pages — three legacy tables nobody reads are dropped (24/10/2026, the owner's call).
--
--   public.funnel_offers          1 row   the CTA's first draft (dayone-main 20261008h), replaced by
--                                         pages.cta_content
--   public.product_offer_content  3 rows  its per-product sections, replaced by pages.cta_content.content
--   archive.funnels_before_pages  76 rows the frozen copy of public.funnels from 06/10 (20261006i)
--
-- Measured before: no code names them (dayone-pages; dayone-main origin/main a4bec7ac4, migrations and
-- the schema snapshot aside), and 7 days of API logs show one request to them — a scan (146.70.194.44,
-- 23/10 18:21 UTC, the publishable key, every answer 401/404/406).
--
-- Each one's columns, constraints, indexes, policies, comment and rows are kept in
-- archive.retired_20261024 first, and the drop only runs when the rows kept match the table's count.
-- Restore: CREATE TABLE from `columns` + `constraints`, the `indexes`, then
-- INSERT … SELECT * FROM jsonb_populate_recordset(NULL::<table>, rows). Drop the backup after 30 days.
--
-- Not here, still read: the view public.funnels (dayone-main's VTurb worker: vturb/pipeline-worker.js,
-- list-folders.js and run-vsl-pipeline.js ask /rest/v1/funnels without a profile, twice a day) and
-- pages.funnels_sync() (the Funnels screen calls it).
-- ============================================================================

CREATE TABLE archive.retired_20261024 (
  object      text PRIMARY KEY,
  columns     jsonb NOT NULL,
  constraints jsonb NOT NULL,
  indexes     jsonb NOT NULL,
  policies    jsonb NOT NULL,
  comment     text,
  row_count   integer NOT NULL,
  rows        jsonb NOT NULL,
  retired_at  timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE archive.retired_20261024 ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON archive.retired_20261024 FROM anon, authenticated;
COMMENT ON TABLE archive.retired_20261024 IS
  'Backup of the legacy tables dropped on 24/10/2026 (20261024a): definition and rows of each. Drop after 24/11/2026.';

DO $do$
DECLARE
  obj  text;
  rel  regclass;
  n    integer;
  kept jsonb;
BEGIN
  FOREACH obj IN ARRAY ARRAY['public.funnel_offers', 'public.product_offer_content', 'archive.funnels_before_pages'] LOOP
    rel := to_regclass(obj);
    IF rel IS NULL THEN
      RAISE EXCEPTION 'retire: % does not exist', obj;
    END IF;
    EXECUTE format('SELECT count(*)::int, coalesce(jsonb_agg(to_jsonb(t)), ''[]''::jsonb) FROM %s t', rel) INTO n, kept;
    IF jsonb_array_length(kept) <> n THEN
      RAISE EXCEPTION 'retire: % has % rows but % were kept', obj, n, jsonb_array_length(kept);
    END IF;

    INSERT INTO archive.retired_20261024 (object, columns, constraints, indexes, policies, comment, row_count, rows)
    VALUES (
      obj,
      (SELECT jsonb_agg(jsonb_build_object(
                'name', a.attname, 'type', format_type(a.atttypid, a.atttypmod),
                'not_null', a.attnotnull, 'default', pg_get_expr(d.adbin, d.adrelid)) ORDER BY a.attnum)
         FROM pg_attribute a
         LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
        WHERE a.attrelid = rel AND a.attnum > 0 AND NOT a.attisdropped),
      coalesce((SELECT jsonb_agg(jsonb_build_object('name', c.conname, 'def', pg_get_constraintdef(c.oid)))
                  FROM pg_constraint c WHERE c.conrelid = rel), '[]'::jsonb),
      coalesce((SELECT jsonb_agg(pg_get_indexdef(i.indexrelid)) FROM pg_index i WHERE i.indrelid = rel), '[]'::jsonb),
      coalesce((SELECT jsonb_agg(jsonb_build_object('name', p.policyname, 'cmd', p.cmd, 'roles', to_jsonb(p.roles),
                                                   'using', p.qual, 'check', p.with_check))
                  FROM pg_policies p WHERE format('%I.%I', p.schemaname, p.tablename)::regclass = rel), '[]'::jsonb),
      obj_description(rel, 'pg_class'),
      n,
      kept
    );

    -- No CASCADE: anything still depending on the table makes the whole migration fail instead.
    EXECUTE format('DROP TABLE %s', rel);
  END LOOP;
END
$do$;
