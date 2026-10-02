-- Shadow evaluation of the Bot rules — pages.hits.rule_matches.
--
-- The gate bars "by layers": gate_pick walks the rules and stops at the FIRST
-- match (Bot stage first), so the hit's rule/rule_label columns only ever name
-- the one rule that won the walk. That hides which OTHER rules would also have
-- caught the click — the overlap you need to compare rules.
--
-- rule_matches records EVERY active Bot rule whose conditions match the
-- request, not just the first. It's filled by the delivery server
-- (server/src/rules.php gate_bot_rules_matched) AFTER the response, in the same
-- post-response update that fills the ASN/hostname (log_hit_net), so the two
-- hostname Bot rules reuse the cached PTR and nothing new goes to the network.
-- Each element is {name, label, reason, tags} — the same fields the single rule
-- columns hold. The serving decision is UNCHANGED: this is logging only.
--
-- Suspicious rules are deliberately left out: their device-signal conditions
-- only exist after the checkpoint (eval.php), so the server can't decide them
-- here. Only Bot rules (request-stage) are evaluated.

ALTER TABLE pages.hits ADD COLUMN IF NOT EXISTS rule_matches jsonb;

COMMENT ON COLUMN pages.hits.rule_matches IS
  'Every active Bot rule whose conditions matched this request (shadow evaluation, server/src/rules.php gate_bot_rules_matched), as a list of {name,label,reason,tags} — not only the rule that served (rule/rule_label). Evaluated for the log regardless of what served; NULL when no Bot rule matched. Suspicious rules excluded (their device signals need the checkpoint).';

-- log_hit_net gains p_rule_matches. The old 5-arg function is DROPped first:
-- the new parameter changes the signature, and keeping both overloads would
-- make a call without p_rule_matches ambiguous for PostgREST. After the drop
-- there's a single overload, so the running server (which doesn't send
-- p_rule_matches yet) keeps working — its call resolves here via the DEFAULT.
-- Deploy this migration BEFORE the server. (Idempotent: re-running drops
-- nothing and the CREATE OR REPLACE just re-creates the 6-arg function.)
DROP FUNCTION IF EXISTS pages.log_hit_net(text, bigint, integer, text, text);

CREATE OR REPLACE FUNCTION pages.log_hit_net(
  p_key text,
  p_id bigint,
  p_asn integer DEFAULT NULL::integer,
  p_as_name text DEFAULT NULL::text,
  p_hostname text DEFAULT NULL::text,
  p_rule_matches jsonb DEFAULT NULL::jsonb
)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
BEGIN
  IF NOT pages.server_key_ok(p_key) THEN
    RAISE EXCEPTION 'pages.log_hit_net: invalid key' USING ERRCODE = '28000';
  END IF;

  UPDATE pages.hits h
  SET asn = coalesce(h.asn, CASE WHEN p_asn > 0 THEN p_asn END),
      as_name = coalesce(h.as_name, nullif(left(coalesce(p_as_name, ''), 256), '')),
      hostname = coalesce(h.hostname, nullif(left(coalesce(p_hostname, ''), 253), '')),
      -- Only when a (valid array) value is given; the net fields keep their coalesce-on-null behavior.
      rule_matches = CASE WHEN jsonb_typeof(p_rule_matches) = 'array' THEN p_rule_matches ELSE h.rule_matches END
  WHERE h.id = p_id;
END $function$;

GRANT EXECUTE ON FUNCTION pages.log_hit_net(text, bigint, integer, text, text, jsonb) TO anon, service_role;
