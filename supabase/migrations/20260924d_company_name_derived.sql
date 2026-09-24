-- ============================================================================
-- DayOne Pages — {{company.name}} is derived, not stored
--
-- {{company.name}} is now the legal name ({{company.llc}}) without the legal
-- suffix (LLC, Inc., Ltda, GmbH...), computed by the delivery server and by
-- the dashboard preview. The stored key goes away (it was empty everywhere).
-- ============================================================================

UPDATE pages.domains SET placeholders = placeholders - 'company.name' WHERE placeholders ? 'company.name';

COMMENT ON COLUMN pages.domains.placeholders IS 'Company data for the {{company.*}} placeholders in this domain''s pages: company.llc (legal name), company.number, company.address, company.phone, company.email. {{company.name}} (company.llc without the legal suffix), {{url}}, {{domain}}, {{slug}}, {{date}}, {{year}}, {{lang}} and {{language}} are computed by the delivery server. The field list lives in src/lib/pages/placeholders.ts.';
