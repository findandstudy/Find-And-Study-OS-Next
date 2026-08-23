-- Phase 3: program-fallback orchestrator kill-switch.
-- Opt-in master switch (default false) gating the automatic supersession of a
-- full programme with a configured fallback rule. Idempotent.
ALTER TABLE "portal_automation_settings"
  ADD COLUMN IF NOT EXISTS "fallback_enabled" boolean NOT NULL DEFAULT false;
