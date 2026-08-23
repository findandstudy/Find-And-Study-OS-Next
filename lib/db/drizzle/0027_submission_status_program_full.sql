-- 0027_submission_status_program_full.sql
--
-- Phase 2: structured "Kontenjan dolu" (quota-full) result.
--
-- Adds the 'program_full' value to the portal_submission_status enum so the
-- runner/worker can mark quota-full submissions STRUCTURALLY
-- (status='program_full' + portal_submissions.meta jsonb) instead of a generic
-- 'failed'. Additive (non-breaking) and idempotent — safe to re-run.
ALTER TYPE "public"."portal_submission_status" ADD VALUE IF NOT EXISTS 'program_full';
