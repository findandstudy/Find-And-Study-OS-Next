---
name: Bulk-import CSV parsing must be deterministic, not LLM
description: Why /ai/extract-bulk-csv parses rows deterministically and uses the LLM only for header mapping
---

Bulk-import endpoints that feed a CSV/Excel sheet through an LLM to "extract records" silently fail on large files and return **0 records** (empty preview), not a partial result.

**Why:** the old `/ai/extract-bulk-csv` did `csvData.slice(0, 10000)` (dropped all but ~80 rows) AND capped output at `max_tokens: 8192`. A 479-row / 57 KB file overflowed the output budget → the model's JSON array was truncated with no closing `]` → the `/\[[\s\S]*\]/` regex matched nothing → `records = []`. So the failure mode of LLM row-parsing is total (0), and it's invisible (no error).

**How to apply:** parse row data deterministically (SheetJS: `XLSX.read(csv, {type:"string"})` → `sheet_to_json({header:1})`), map headers to canonical fields via an **entity-aware synonym table** (lead vs student have different field lists; "school" = interestedUniversity for leads but highSchool for students, so filter synonym targets to the entity's valid field set, and always self-map `normHeader(canonicalField)→field`). Build records from ALL rows with an explicit cap. Use the LLM ONLY as a best-effort fallback for fuzzy header mapping (headers-only payload, tiny) when required name columns are unmapped — never for row data. Produced record keys must match exactly what `/api/leads/bulk` and `/api/students/bulk` consume.
