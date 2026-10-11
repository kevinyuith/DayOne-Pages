-- ============================================================================
-- A CTA's bundles are free HTML (the owner, 11/10: "HTML livre por CTA"): each CTA keeps the HTML of
-- its bundles block as it is typed or pasted — like the VTurb player's CTA today — instead of a
-- structured list of bundles. pages.cta.bundles (20261011a; empty on every row) gives way to
-- pages.cta.cards_html. The visual, the sections (their content generated per CTA) and the quiz still
-- go on top of it: dayone-main's montarCta renders cards_html + all that into pages.cta.html, the
-- block the delivery server serves. A published CTA needs only its rendered HTML now.
-- ============================================================================

ALTER TABLE pages.cta ADD COLUMN IF NOT EXISTS cards_html text NOT NULL DEFAULT '';
ALTER TABLE pages.cta DROP COLUMN IF EXISTS bundles;

COMMENT ON COLUMN pages.cta.cards_html IS
  'The bundles block as typed or pasted (free HTML: jars, prices, checkout links). montarCta renders it with the visual, the sections and the quiz into html.';
COMMENT ON COLUMN pages.cta.html IS
  'The rendered block (dayone-main''s montarCta: cards_html with the visual, the sections and the quiz), saved with the CTA. What the delivery server serves.';

CREATE OR REPLACE FUNCTION pages.cta_check()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  bad text;
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.funnel_id <> OLD.funnel_id THEN
    RAISE EXCEPTION 'cta: a CTA does not move to another funnel' USING ERRCODE = 'check_violation';
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
  IF NEW.status = 'PUBLISHED' AND btrim(NEW.html) = '' THEN
    RAISE EXCEPTION 'cta: a published CTA needs its HTML' USING ERRCODE = 'check_violation';
  END IF;
  NEW.content_hash := pages.content_hash(NEW.html);
  RETURN NEW;
END $$;

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
  WHERE k NOT IN ('name', 'visual', 'product_color', 'quiz', 'sections', 'cards_html', 'content') LIMIT 1;
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION 'cta: unknown field %', bad USING ERRCODE = '22023';
  END IF;
  IF p_cta ? 'cards_html' AND jsonb_typeof(p_cta -> 'cards_html') <> 'string' THEN
    RAISE EXCEPTION 'cta: cards_html must be a string' USING ERRCODE = '22023';
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
  INSERT INTO pages.cta (funnel_id, name, visual, product_color, quiz, sections, cards_html, content, html, created_by)
  VALUES (p_funnel,
          p_cta ->> 'name',
          coalesce(p_cta -> 'visual', '{}'::jsonb),
          coalesce((p_cta ->> 'product_color')::boolean, false),
          coalesce((p_cta ->> 'quiz')::boolean, false),
          coalesce(p_cta -> 'sections', '{"faq": false, "comments": false, "science": false, "logos": false}'::jsonb),
          coalesce(p_cta ->> 'cards_html', ''),
          coalesce(p_cta -> 'content', '{}'::jsonb),
          coalesce(p_html, ''),
          p_created_by)
  RETURNING id INTO v_id;
  UPDATE pages.funnels f SET cta = f.cta || jsonb_build_object(v_id::text, jsonb_build_object('weight', 0))
  WHERE f.id = p_funnel;
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
    html          = coalesce(p_html, c.html)
  WHERE c.id = p_cta_id
  RETURNING c.updated_at INTO v_at;
  RETURN v_at;
END $$;

-- The return types change (bundles out, cards_html in): drop and create.
DROP FUNCTION IF EXISTS pages.cta_summary(uuid[]);
DROP FUNCTION IF EXISTS pages.cta_get(uuid);

-- The CTAs of the funnels, without the HTML and the content (the screen's list).
CREATE FUNCTION pages.cta_summary(p_funnel_ids uuid[])
RETURNS TABLE(funnel_id uuid, cta_id uuid, name text, status text, weight integer, visual jsonb, product_color boolean,
              quiz boolean, sections jsonb, has_cards boolean, has_content boolean, content_hash text, created_by text,
              created_at timestamptz, updated_at timestamptz)
LANGUAGE sql
STABLE
SET search_path = ''
AS $$
  SELECT c.funnel_id, c.id, c.name, c.status, coalesce((f.cta -> c.id::text ->> 'weight')::int, 0),
         c.visual, c.product_color, c.quiz, c.sections, btrim(c.cards_html) <> '', c.content <> '{}'::jsonb,
         c.content_hash, c.created_by, c.created_at, c.updated_at
  FROM pages.cta c
  JOIN pages.funnels f ON f.id = c.funnel_id AND f.cta ? c.id::text
  WHERE c.funnel_id = ANY (p_funnel_ids)
  ORDER BY c.funnel_id, c.created_at, c.id
$$;

-- One CTA with everything (the editor).
CREATE FUNCTION pages.cta_get(p_cta_id uuid)
RETURNS TABLE(funnel_id uuid, cta_id uuid, name text, status text, weight integer, visual jsonb, product_color boolean,
              quiz boolean, sections jsonb, cards_html text, content jsonb, html text, content_hash text, created_by text,
              created_at timestamptz, updated_at timestamptz)
LANGUAGE sql
STABLE
SET search_path = ''
AS $$
  SELECT c.funnel_id, c.id, c.name, c.status, coalesce((f.cta -> c.id::text ->> 'weight')::int, 0),
         c.visual, c.product_color, c.quiz, c.sections, c.cards_html, c.content, c.html, c.content_hash, c.created_by,
         c.created_at, c.updated_at
  FROM pages.cta c
  JOIN pages.funnels f ON f.id = c.funnel_id
  WHERE c.id = p_cta_id
$$;

REVOKE ALL ON FUNCTION pages.cta_summary(uuid[]) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION pages.cta_summary(uuid[]) TO service_role;
REVOKE ALL ON FUNCTION pages.cta_get(uuid) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION pages.cta_get(uuid) TO service_role;

NOTIFY pgrst, 'reload schema';
