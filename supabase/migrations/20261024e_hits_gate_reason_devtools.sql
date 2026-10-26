-- The DevTools block (server/src/beacon.php + rules.php): a browser that opens
-- DevTools on a funnel page is marked (the dop_dv cookie) and never reaches the
-- funnel again — the gate serves the safe page (a normal domain) or a 404 (an
-- UNLOCKED one, which serves funnels only). The hit records why with
-- gate_reason = 'devtools'. This adds the value to the column's CHECK and to
-- the log_hit CASE (both used to drop it to NULL).
--
-- IMPORTANT: log_hit's live signature carries p_upsell (20261014a). The first
-- version of this migration recreated the 37-parameter overload (20261007b's),
-- which left TWO ambiguous overloads and broke PostgREST's pick. This fixes it:
-- it drops the 37-parameter one and patches the 38-parameter one in place (the
-- same string-replace approach as 20261014a, so the p_upsell wiring is kept).

SET lock_timeout = '5s';

ALTER TABLE pages.hits DROP CONSTRAINT IF EXISTS hits_gate_reason_check;
ALTER TABLE pages.hits ADD CONSTRAINT hits_gate_reason_check
  CHECK (gate_reason IN ('slug_not_allowed', 'no_funnel_token', 'funnel_not_live', 'domain_disabled', 'domain_locked', 'domain_unlocked', 'devtools'));

-- Drop the wrong 37-parameter overload this migration's first version created.
DROP FUNCTION IF EXISTS pages.log_hit(text, uuid, text, text, text, integer, text, text, boolean, text, text, text, text, integer, text, text, text, uuid, uuid, text, text, text, text, text, text, text, jsonb, text, text, text, text, jsonb, jsonb, boolean, text, text);

-- Patch the live (38-parameter) log_hit: the gate_reason CASE gains 'devtools'.
DO $do$
DECLARE
  v_sig  constant text := 'pages.log_hit(text,uuid,text,text,text,integer,text,text,boolean,text,text,text,text,integer,text,text,text,uuid,uuid,text,text,text,text,text,text,text,jsonb,text,text,text,text,jsonb,jsonb,boolean,text,text,jsonb)';
  def    text := pg_get_functiondef(v_sig::regprocedure);
  next   text;
  v_from text;
BEGIN
  v_from := $s$CASE WHEN p_gate_reason IN ('slug_not_allowed', 'no_funnel_token', 'funnel_not_live', 'domain_disabled', 'domain_locked', 'domain_unlocked') THEN p_gate_reason END$s$;
  IF (length(def) - length(replace(def, v_from, ''))) / length(v_from) <> 1 THEN
    RAISE EXCEPTION 'log_hit: the gate_reason CASE was not found exactly once';
  END IF;
  next := replace(def, v_from, $s$CASE WHEN p_gate_reason IN ('slug_not_allowed', 'no_funnel_token', 'funnel_not_live', 'domain_disabled', 'domain_locked', 'domain_unlocked', 'devtools') THEN p_gate_reason END$s$);

  EXECUTE 'DROP FUNCTION ' || v_sig;
  EXECUTE next;
END $do$;
GRANT EXECUTE ON FUNCTION pages.log_hit(text,uuid,text,text,text,integer,text,text,boolean,text,text,text,text,integer,text,text,text,uuid,uuid,text,text,text,text,text,text,text,jsonb,text,text,text,text,jsonb,jsonb,boolean,text,text,jsonb) TO service_role;
