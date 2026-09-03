-- Incident severity. See ROADMAP.md.
-- Orthogonal to lifecycle status: status = how far the response has progressed,
-- severity = how bad the impact is. Single-tenant, so a fixed scale (not a
-- severity-builder). The Customer Support Lead owns severity (ticket-volume view).
--   sev1 = major / full outage
--   sev2 = partial / significant (default)
--   sev3 = minor
-- Existing rows backfill to sev2.

ALTER TABLE incidents ADD COLUMN severity TEXT NOT NULL DEFAULT 'sev2'
  CHECK (severity IN ('sev1', 'sev2', 'sev3'));
