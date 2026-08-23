-- Canonical portal lifecycle values formerly added by disabled boot-time DDL.
-- Additive and idempotent; existing enum values and rows are preserved.

ALTER TYPE "public"."portal_submission_status" ADD VALUE IF NOT EXISTS 'dry_run';
--> statement-breakpoint
ALTER TYPE "public"."portal_submission_status" ADD VALUE IF NOT EXISTS 'accepted';
--> statement-breakpoint
ALTER TYPE "public"."portal_submission_status" ADD VALUE IF NOT EXISTS 'rejected';
