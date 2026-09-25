-- ============================================================================
-- DayOne Pages — unique clicks
--
-- pages.hits.is_unique: true when there was no hit with the same IP and the
-- same User-Agent on the same domain (domain_id; the host when the domain
-- isn't registered) in the 30 days before; false = a repeat. Redirects (the
-- www → bare-domain 302 is the same click) are neither: NULL, and they don't
-- count as an earlier hit.
--
-- Set by a BEFORE INSERT trigger, so it holds for any server that logs
-- (log_hit unchanged); the old hits get it here.
-- ============================================================================

ALTER TABLE pages.hits ADD COLUMN IF NOT EXISTS is_unique boolean;
COMMENT ON COLUMN pages.hits.is_unique IS 'true = the first hit with this IP and User-Agent on this domain in 30 days; false = a repeat; NULL = a redirect or no IP.';

CREATE INDEX IF NOT EXISTS idx_pages_hits_ip_created ON pages.hits USING btree (ip, created_at DESC);

CREATE OR REPLACE FUNCTION pages.hits_set_unique()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO ''
AS $function$
BEGIN
  IF NEW.outcome = 'redirect' OR NEW.ip IS NULL THEN
    NEW.is_unique := NULL;
    RETURN NEW;
  END IF;
  NEW.is_unique := NOT EXISTS (
    SELECT 1 FROM pages.hits h
    WHERE h.ip = NEW.ip
      AND h.user_agent IS NOT DISTINCT FROM NEW.user_agent
      AND CASE WHEN NEW.domain_id IS NOT NULL THEN h.domain_id = NEW.domain_id ELSE h.domain_id IS NULL AND h.host = NEW.host END
      AND h.outcome <> 'redirect'
      AND h.created_at > NEW.created_at - interval '30 days'
  );
  RETURN NEW;
END $function$;

DROP TRIGGER IF EXISTS hits_set_unique ON pages.hits;
CREATE TRIGGER hits_set_unique BEFORE INSERT ON pages.hits FOR EACH ROW EXECUTE FUNCTION pages.hits_set_unique();

-- The hits already logged, by the same rule (the same instant: the lower id came first).
UPDATE pages.hits n
SET is_unique = NOT EXISTS (
  SELECT 1 FROM pages.hits h
  WHERE h.ip = n.ip
    AND h.user_agent IS NOT DISTINCT FROM n.user_agent
    AND CASE WHEN n.domain_id IS NOT NULL THEN h.domain_id = n.domain_id ELSE h.domain_id IS NULL AND h.host = n.host END
    AND h.outcome <> 'redirect'
    AND h.created_at > n.created_at - interval '30 days'
    AND (h.created_at < n.created_at OR (h.created_at = n.created_at AND h.id < n.id))
)
WHERE n.outcome <> 'redirect' AND n.ip IS NOT NULL;

NOTIFY pgrst, 'reload schema';
