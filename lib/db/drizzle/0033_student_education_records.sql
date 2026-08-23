-- 0033: student_education_records + SIT toggles on students
-- Hand-written idempotent SQL (journal not maintained past 0017; prod runs boot DDL).
-- Additive only — no breaking changes. Flat academic columns on students remain (deprecated).

CREATE TABLE IF NOT EXISTS student_education_records (
  id SERIAL PRIMARY KEY,
  student_id INTEGER NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  level TEXT NOT NULL CHECK (level IN ('high_school', 'bachelor', 'master')),
  institution TEXT,
  program TEXT,
  graduation_year INTEGER,
  gpa TEXT,
  gpa_raw TEXT,
  gpa_scale INTEGER,
  language_score TEXT,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS student_education_records_student_id_idx
  ON student_education_records (student_id);

CREATE UNIQUE INDEX IF NOT EXISTS student_education_records_student_level_uniq
  ON student_education_records (student_id, level)
  WHERE deleted_at IS NULL;

ALTER TABLE students ADD COLUMN IF NOT EXISTS transfer_student BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE students ADD COLUMN IF NOT EXISTS has_tc_id BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE students ADD COLUMN IF NOT EXISTS has_blue_card BOOLEAN NOT NULL DEFAULT FALSE;

-- Idempotent backfill from flat students columns (NOT EXISTS guard per level).
INSERT INTO student_education_records (student_id, level, institution, graduation_year, gpa, language_score)
SELECT s.id, 'high_school', s.high_school,
       CASE WHEN s.university_bachelor IS NULL AND s.university_master IS NULL
                 AND s.graduation_year > 0 THEN s.graduation_year ELSE NULL END,
       CASE WHEN s.university_bachelor IS NULL AND s.university_master IS NULL THEN s.gpa ELSE NULL END,
       CASE WHEN s.university_bachelor IS NULL AND s.university_master IS NULL THEN s.language_score ELSE NULL END
FROM students s
WHERE s.high_school IS NOT NULL AND s.high_school <> ''
  AND NOT EXISTS (
    SELECT 1 FROM student_education_records r
    WHERE r.student_id = s.id AND r.level = 'high_school' AND r.deleted_at IS NULL
  );

INSERT INTO student_education_records (student_id, level, institution, graduation_year, gpa, language_score)
SELECT s.id, 'bachelor', s.university_bachelor,
       CASE WHEN s.university_master IS NULL AND s.graduation_year > 0 THEN s.graduation_year ELSE NULL END,
       CASE WHEN s.university_master IS NULL THEN s.gpa ELSE NULL END,
       CASE WHEN s.university_master IS NULL THEN s.language_score ELSE NULL END
FROM students s
WHERE s.university_bachelor IS NOT NULL AND s.university_bachelor <> ''
  AND NOT EXISTS (
    SELECT 1 FROM student_education_records r
    WHERE r.student_id = s.id AND r.level = 'bachelor' AND r.deleted_at IS NULL
  );

INSERT INTO student_education_records (student_id, level, institution, graduation_year, gpa, language_score)
SELECT s.id, 'master', s.university_master,
       CASE WHEN s.graduation_year > 0 THEN s.graduation_year ELSE NULL END,
       s.gpa, s.language_score
FROM students s
WHERE s.university_master IS NOT NULL AND s.university_master <> ''
  AND NOT EXISTS (
    SELECT 1 FROM student_education_records r
    WHERE r.student_id = s.id AND r.level = 'master' AND r.deleted_at IS NULL
  );
