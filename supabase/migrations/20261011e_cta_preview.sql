-- ============================================================================
-- A CTA's test link (the owner, 11/10: CTAs in draft, seen on the real page before they go live):
-- ?dop_cta=<cta id> on a funnel page the gate served shows THAT CTA under the player at once —
-- a draft included —, outside the draw (no dop_cta cookie, no cta_id on dot's events). The delivery
-- server asks for its HTML with its key, and only a CTA of the funnel that lists the page answers.
-- ============================================================================

CREATE OR REPLACE FUNCTION pages.cta_preview_get(p_cta uuid, p_page uuid, p_key text)
RETURNS TABLE(cta_id uuid, content_hash text, html text, status text)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF NOT pages.server_key_ok(p_key) THEN
    RAISE EXCEPTION 'pages.cta_preview_get: invalid key' USING ERRCODE = '28000';
  END IF;
  RETURN QUERY
    SELECT c.id, c.content_hash, c.html, c.status
    FROM pages.cta c
    JOIN pages.funnels f ON f.id = c.funnel_id
    WHERE c.id = p_cta
      AND f.site ? p_page::text
      AND f.cta ? c.id::text
      AND btrim(c.html) <> '';
END $$;

COMMENT ON FUNCTION pages.cta_preview_get(uuid, uuid, text) IS
  'The test link of a CTA (?dop_cta=<id>): its HTML, draft or published, only when it belongs to the funnel that lists the page. Delivery server only (server key).';

REVOKE ALL ON FUNCTION pages.cta_preview_get(uuid, uuid, text) FROM public;
GRANT EXECUTE ON FUNCTION pages.cta_preview_get(uuid, uuid, text) TO anon, service_role;

NOTIFY pgrst, 'reload schema';
