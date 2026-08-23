-- 0030_submission_status_exclusive_region.sql
-- Adds 'program_full' (idempotent re-assert) and 'exclusive_region' to the
-- portal_submission_status enum. ALTER TYPE ... ADD VALUE must run OUTSIDE a
-- transaction block; each statement here is autocommitted by the runner.
-- Additive + idempotent (hand-written; not journaled — see migrations 0018+).
ALTER TYPE "public"."portal_submission_status" ADD VALUE IF NOT EXISTS 'program_full';
ALTER TYPE "public"."portal_submission_status" ADD VALUE IF NOT EXISTS 'exclusive_region';
