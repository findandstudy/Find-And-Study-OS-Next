-- Multi-portal routing: mark a university as a multi-portal company and let
-- normal universities route their submissions through it.
ALTER TABLE "portal_universities" ADD COLUMN IF NOT EXISTS "is_multi_portal" boolean NOT NULL DEFAULT false;
ALTER TABLE "portal_universities" ADD COLUMN IF NOT EXISTS "routes_via" text;
CREATE INDEX IF NOT EXISTS "portal_uni_routes_via_idx" ON "portal_universities" ("routes_via");
