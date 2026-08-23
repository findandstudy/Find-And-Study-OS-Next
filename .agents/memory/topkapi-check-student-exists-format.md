---
name: Topkapi check-student-exists response format
description: Exact JSON format of application-check-student-exists.php + adapter Step 1 detection logic
---

## Rule
Parse the `application-check-student-exists.php` response body directly — do NOT rely on DOM `input[name=studentName]` visibility polling.

**Existing student:** `{"status":"exists","message":"Bu email \/ pasaport numarası için seçilen eğitim döneminde bir başvuru mevcut."}`

**New student:** `{"status":"new","message":"..."}` or empty / `{}` / `null` / `[]`

## How to apply
In adapter Step 1, after `await checkRespPromise`:
- `bodyLc.includes('"status":"exists"')` → return `alreadyExists: true` immediately
- `bodyLc.includes('"status":"new"')` OR empty body → proceed to `waitForSelector("input[name=studentName]", { timeout: 20000 })`
- Unknown format → treat as exists (safe fallback)

## Why
DOM polling with 8s timeout was always timing out — the `studentName` input only appears for truly NEW students. Every dev+prod student in the system was already manually entered in Topkapi, so the timeout path was always hit and falsely concluded `alreadyExists` without actually knowing the reason.

## Testing constraint
All current dev DB students return `{"status":"exists"}` because they were manually submitted to Topkapi before automation was built. To test the full 7-step wizard (Steps 2–7), a genuinely new student (never submitted to Topkapi, not in their portal for the current education period) is required.
