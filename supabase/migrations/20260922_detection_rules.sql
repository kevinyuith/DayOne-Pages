-- ============================================================================
-- DayOne Pages — regras de detecção de bots e usuários suspeitos
--
-- Tabela para armazenar regras que definem quem é bot ou suspeito.
-- Cada regra pode corresponder a padrões de User-Agent, IP, país, etc.
-- ============================================================================

CREATE TABLE IF NOT EXISTS pages.detection_rules (
  id            uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  type          text        NOT NULL,   -- user_agent|ip_pattern|country|rate_limit|keyword
  name          text        NOT NULL,   -- nome descritivo da regra
  pattern       text        NOT NULL,   -- padrão a corresponder (regex, IP CIDR, país ISO, etc)
  classification text       NOT NULL,   -- bot|suspicious
  is_active     boolean     NOT NULL DEFAULT true,
  priority      int         NOT NULL DEFAULT 100,
  notes         text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ck_detection_rules_type CHECK (type IN ('user_agent', 'ip_pattern', 'country', 'rate_limit', 'keyword')),
  CONSTRAINT ck_detection_rules_classification CHECK (classification IN ('bot', 'suspicious'))
);

COMMENT ON TABLE pages.detection_rules IS 'Regras para detectar bots e usuários suspeitos baseado em padrões (UA, IP, país, etc).';
COMMENT ON COLUMN pages.detection_rules.type IS 'Tipo de regra: user_agent (regex), ip_pattern (CIDR), country (ISO-2), rate_limit (requests/sec), keyword (em path/UA)';
COMMENT ON COLUMN pages.detection_rules.pattern IS 'Padrão específico: regex para UA, CIDR para IP, ISO-2 para país, número para rate, string para keyword';
COMMENT ON COLUMN pages.detection_rules.classification IS 'Classificação quando corresponde: bot ou suspicious';
COMMENT ON COLUMN pages.detection_rules.priority IS 'Prioridade de avaliação (menor = avalia primeiro). Default 100.';

CREATE INDEX IF NOT EXISTS idx_detection_rules_active ON pages.detection_rules (is_active, priority);
CREATE INDEX IF NOT EXISTS idx_detection_rules_type   ON pages.detection_rules (type);

ALTER TABLE pages.detection_rules ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON pages.detection_rules FROM anon, authenticated;
GRANT SELECT ON pages.detection_rules TO service_role;
GRANT ALL ON pages.detection_rules TO service_role;
