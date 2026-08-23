-- Finance Sprint Phase 1: Add staff commission fields to commissions table
-- and create staff_commission_payouts table.
-- New columns default to 0/NULL so existing records' Net Income is unchanged.

ALTER TABLE commissions
  ADD COLUMN IF NOT EXISTS staff_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS staff_commission_amount NUMERIC(12, 2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS staff_commission_currency TEXT;

CREATE TABLE IF NOT EXISTS staff_commission_payouts (
  id SERIAL PRIMARY KEY,
  commission_id INTEGER REFERENCES commissions(id) ON DELETE SET NULL,
  staff_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  amount NUMERIC(12, 2) NOT NULL,
  currency TEXT NOT NULL DEFAULT 'USD',
  paid_at TIMESTAMP WITH TIME ZONE,
  reference TEXT,
  attachment_url TEXT,
  notes TEXT,
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  deleted_at TIMESTAMP WITH TIME ZONE,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS staff_commission_payouts_commission_id_idx ON staff_commission_payouts(commission_id);
CREATE INDEX IF NOT EXISTS staff_commission_payouts_staff_user_id_idx ON staff_commission_payouts(staff_user_id);
CREATE INDEX IF NOT EXISTS staff_commission_payouts_deleted_at_idx ON staff_commission_payouts(deleted_at) WHERE deleted_at IS NULL;
