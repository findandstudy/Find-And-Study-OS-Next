-- Task #112: University contracts module — admin-managed contracts with expiry warnings.
CREATE TABLE IF NOT EXISTS university_contracts (
  id SERIAL PRIMARY KEY,
  university_id INTEGER NOT NULL REFERENCES universities(id) ON DELETE CASCADE,
  destination_id INTEGER REFERENCES destinations(id) ON DELETE SET NULL,
  country TEXT NOT NULL,
  year INTEGER,
  effective_date TIMESTAMP WITH TIME ZONE,
  expiry_date TIMESTAMP WITH TIME ZONE,
  file_object_key TEXT,
  file_name TEXT,
  file_mime TEXT,
  file_size INTEGER,
  notes TEXT,
  last_warning_30_sent_at TIMESTAMP WITH TIME ZONE,
  last_warning_14_sent_at TIMESTAMP WITH TIME ZONE,
  last_warning_7_sent_at TIMESTAMP WITH TIME ZONE,
  last_warning_1_sent_at TIMESTAMP WITH TIME ZONE,
  expiry_notice_sent_at TIMESTAMP WITH TIME ZONE,
  uploaded_by_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  deleted_at TIMESTAMP WITH TIME ZONE,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS university_contracts_university_id_idx ON university_contracts(university_id);
CREATE INDEX IF NOT EXISTS university_contracts_country_idx ON university_contracts(country);
CREATE INDEX IF NOT EXISTS university_contracts_expiry_date_idx ON university_contracts(expiry_date);
CREATE INDEX IF NOT EXISTS university_contracts_deleted_at_idx ON university_contracts(deleted_at);
