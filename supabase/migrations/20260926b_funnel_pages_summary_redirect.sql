-- ============================================================================
-- DayOne Pages — the funnel board knows a redirect entry and its destination
--
-- funnel_pages_summary gains `redirect`: the "/" slug's content (the URL
-- template) when the entry is a redirect (content_type = 'text/x-redirect'),
-- NULL for a normal page. The Funnel screen uses it to draw the redirect row
-- and to fill the edit form. Return type changes, so DROP then CREATE.
-- ============================================================================

DROP FUNCTION IF EXISTS pages.funnel_pages_summary(uuid[]);

CREATE FUNCTION pages.funnel_pages_summary(p_funnel_ids uuid[] DEFAULT NULL::uuid[])
RETURNS TABLE(funnel_id uuid, main_funnel_id uuid, page_id uuid, name text, status text, weight integer,
              notes text, created_at text, updated_at text, slugs jsonb, redirect text)
LANGUAGE sql
STABLE
SET search_path TO ''
AS $function$
  SELECT f.id, f.main_funnel_id, p.id, p.name, p.status, (f.site -> p.id::text ->> 'weight')::int, p.notes,
         to_jsonb(p.created_at) #>> '{}', to_jsonb(p.updated_at) #>> '{}', pages.slugs_summary(p.slugs),
         CASE WHEN p.slugs -> '/' ->> 'content_type' = 'text/x-redirect' THEN p.slugs -> '/' ->> 'content' END
  FROM pages.funnels f
  CROSS JOIN LATERAL jsonb_object_keys(f.site) k
  JOIN pages.pages p ON p.id = k::uuid
  WHERE p_funnel_ids IS NULL OR f.id = ANY (p_funnel_ids)
  ORDER BY f.id, p.created_at, p.id
$function$;

NOTIFY pgrst, 'reload schema';
