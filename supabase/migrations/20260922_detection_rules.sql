-- ============================================================================
-- DayOne Pages — detection rules for bots and suspicious users
--
-- Table to store the rules that define who is a bot or suspicious.
-- Each rule can match User-Agent, IP, country, etc. patterns.
-- ============================================================================

CREATE TABLE IF NOT EXISTS pages.detection_rules (
  id            uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  type          text        NOT NULL,   -- user_agent|ip_pattern|country|rate_limit|keyword
  name          text        NOT NULL,   -- descriptive name of the rule
  pattern       text        NOT NULL,   -- pattern to match (regex, IP CIDR, ISO country, etc)
  classification text       NOT NULL,   -- bot|suspicious
  is_active     boolean     NOT NULL DEFAULT true,
  priority      int         NOT NULL DEFAULT 100,
  notes         text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ck_detection_rules_type CHECK (type IN ('user_agent', 'ip_pattern', 'country', 'rate_limit', 'keyword')),
  CONSTRAINT ck_detection_rules_classification CHECK (classification IN ('bot', 'suspicious'))
);

COMMENT ON TABLE pages.detection_rules IS 'Rules to detect bots and suspicious users based on patterns (UA, IP, country, etc).';
COMMENT ON COLUMN pages.detection_rules.type IS 'Rule type: user_agent (regex), ip_pattern (CIDR), country (ISO-2), rate_limit (requests/sec), keyword (in path/UA)';
COMMENT ON COLUMN pages.detection_rules.pattern IS 'Specific pattern: regex for UA, CIDR for IP, ISO-2 for country, number for rate, string for keyword';
COMMENT ON COLUMN pages.detection_rules.classification IS 'Classification when it matches: bot or suspicious';
COMMENT ON COLUMN pages.detection_rules.priority IS 'Evaluation priority (lower = evaluated first). Default 100.';

CREATE INDEX IF NOT EXISTS idx_detection_rules_active ON pages.detection_rules (is_active, priority);
CREATE INDEX IF NOT EXISTS idx_detection_rules_type   ON pages.detection_rules (type);

ALTER TABLE pages.detection_rules ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON pages.detection_rules FROM anon, authenticated;
GRANT SELECT ON pages.detection_rules TO service_role;
GRANT ALL ON pages.detection_rules TO service_role;
