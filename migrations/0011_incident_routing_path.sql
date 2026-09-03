-- Incident routing path. See ROADMAP.md → "Routing paths: internal vs external".
-- A fixed, hard-coded set of incident SHAPES (not a routing-rule builder). Chosen
-- at declare; determines which roles apply and whether on-call is engaged:
--   internal  = our own systems — full shape (Eng Lead + Support Lead, on-call). (default)
--   external  = an upstream/partner issue we mostly COMMUNICATE — Support Lead only,
--               no Engineering Lead offered, no on-call page.
-- Existing rows backfill to 'internal'.

ALTER TABLE incidents ADD COLUMN routing_path TEXT NOT NULL DEFAULT 'internal'
  CHECK (routing_path IN ('internal', 'external'));
