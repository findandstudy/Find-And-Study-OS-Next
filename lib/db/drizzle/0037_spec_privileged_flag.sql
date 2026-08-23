-- Migration 0037: spec_privileged_flag
--
-- Adds privileged_approved column to portal_adapter_specs.
-- A privileged spec (contains http, graphql, or jsHook steps) cannot be
-- enabled until a super_admin sets this flag.
--
-- SAFE TO RUN: purely additive (ADD COLUMN IF NOT EXISTS with DEFAULT false).
-- No existing data is modified.
-- AUTO-PUSH: NO — apply manually after review.

ALTER TABLE "portal_adapter_specs"
  ADD COLUMN IF NOT EXISTS "privileged_approved" boolean NOT NULL DEFAULT false;
