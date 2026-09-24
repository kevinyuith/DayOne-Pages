-- ============================================================================
-- DayOne Pages — AI settings live in the system, not in env files
--
-- The copy-angle rewrite (template variations) uses Kimi (Moonshot AI). Its
-- API key is stored encrypted in Supabase Vault and its model in a small
-- settings table, both edited from the dashboard's Settings screen.
--
-- - pages.app_settings: non-secret settings (key → jsonb), e.g. ai.model.
-- - Vault secret 'dayone_pages.moonshot_api_key': the Kimi API key.
--   pages.ai_secret_set / ai_secret_status / ai_secret_get only accept names
--   from their own allow-list, so they never expose the project's other Vault
--   secrets (this Supabase project is shared). The key is never sent to the
--   browser: the screen gets ai_secret_status (set? last 4 characters).
--
-- All service_role only.
-- ============================================================================

CREATE TABLE IF NOT EXISTS pages.app_settings (
  key        text PRIMARY KEY,
  value      jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE pages.app_settings IS 'Non-secret dashboard settings (key → jsonb), e.g. ai.model. Secrets go to Vault (pages.ai_secret_*).';
ALTER TABLE pages.app_settings ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON pages.app_settings FROM public, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON pages.app_settings TO service_role;

CREATE OR REPLACE FUNCTION pages.ai_secret_allowed(p_name text)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
SET search_path = ''
AS $$
  SELECT p_name IN ('dayone_pages.moonshot_api_key')
$$;

-- Set (create or replace) a secret; NULL or blank removes it.
CREATE OR REPLACE FUNCTION pages.ai_secret_set(p_name text, p_secret text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_id uuid;
BEGIN
  IF NOT pages.ai_secret_allowed(p_name) THEN
    RAISE EXCEPTION 'ai_secret_set: unknown secret name' USING ERRCODE = 'check_violation';
  END IF;
  SELECT s.id INTO v_id FROM vault.secrets s WHERE s.name = p_name;
  IF p_secret IS NULL OR btrim(p_secret) = '' THEN
    IF v_id IS NOT NULL THEN
      DELETE FROM vault.secrets WHERE id = v_id;
    END IF;
    RETURN;
  END IF;
  IF v_id IS NULL THEN
    PERFORM vault.create_secret(btrim(p_secret), p_name, 'DayOne Pages: API key for the copy-angle rewrite of template variations');
  ELSE
    PERFORM vault.update_secret(v_id, btrim(p_secret));
  END IF;
END $$;

-- Whether a secret is set, its last 4 characters and when it changed. No rows = not set.
CREATE OR REPLACE FUNCTION pages.ai_secret_status(p_name text)
RETURNS TABLE (hint text, updated_at timestamptz)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT right(d.decrypted_secret, 4), d.updated_at
  FROM vault.decrypted_secrets d
  WHERE pages.ai_secret_allowed(p_name) AND d.name = p_name
$$;

-- The secret itself, for the dashboard server only (never sent to the browser).
CREATE OR REPLACE FUNCTION pages.ai_secret_get(p_name text)
RETURNS text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT d.decrypted_secret
  FROM vault.decrypted_secrets d
  WHERE pages.ai_secret_allowed(p_name) AND d.name = p_name
$$;

DO $$
DECLARE
  fn text;
BEGIN
  FOREACH fn IN ARRAY ARRAY[
    'pages.ai_secret_allowed(text)',
    'pages.ai_secret_set(text, text)',
    'pages.ai_secret_status(text)',
    'pages.ai_secret_get(text)'
  ] LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM public, anon, authenticated', fn);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role', fn);
  END LOOP;
END $$;

INSERT INTO pages.app_settings (key, value) VALUES ('ai.model', '"kimi-k3"') ON CONFLICT (key) DO NOTHING;

NOTIFY pgrst, 'reload schema';
