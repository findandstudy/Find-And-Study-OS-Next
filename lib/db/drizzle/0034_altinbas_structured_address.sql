-- 0034: Structured address fields required by the Altınbaş application form.
-- Additive and idempotent. Existing free-text `address` remains unchanged.

ALTER TABLE students ADD COLUMN IF NOT EXISTS city_of_birth TEXT;
ALTER TABLE students ADD COLUMN IF NOT EXISTS address_city TEXT;
ALTER TABLE students ADD COLUMN IF NOT EXISTS postal_code TEXT;
ALTER TABLE students ADD COLUMN IF NOT EXISTS needs_visa_support BOOLEAN;
