-- ============================================================================
-- DayOne Pages — company placeholders under company.*
--
-- The domain data used by {{placeholders}} moves to dotted keys:
-- company.name, company.llc, company.number, company.address,
-- company.phone, company.email. city/state/zip_code/country are dropped
-- (nobody had filled them). Values already saved under the old keys carry
-- over. {{url}}, {{domain}}, {{slug}}, {{date}}, {{year}}, {{lang}} and
-- {{language}} are automatic and are not stored.
--
-- Idempotent: a row already in the new shape keeps its values.
-- ============================================================================

UPDATE pages.domains
SET placeholders = jsonb_build_object(
  'company.name',    coalesce(placeholders ->> 'company.name',    placeholders ->> 'company_name', ''),
  'company.llc',     coalesce(placeholders ->> 'company.llc',     ''),
  'company.number',  coalesce(placeholders ->> 'company.number',  ''),
  'company.address', coalesce(placeholders ->> 'company.address', placeholders ->> 'address', ''),
  'company.phone',   coalesce(placeholders ->> 'company.phone',   placeholders ->> 'phone', ''),
  'company.email',   coalesce(placeholders ->> 'company.email',   placeholders ->> 'email', '')
);

COMMENT ON COLUMN pages.domains.placeholders IS 'Company data for the {{company.*}} placeholders in this domain''s pages: company.name, company.llc, company.number, company.address, company.phone, company.email. {{url}}, {{domain}}, {{slug}}, {{date}}, {{year}}, {{lang}} and {{language}} are filled per visit by the delivery server. The field list lives in src/lib/pages/placeholders.ts.';
