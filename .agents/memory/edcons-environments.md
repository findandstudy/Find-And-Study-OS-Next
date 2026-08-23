---
name: edcons dev/prod environments
description: How EduConsult OS dev and production environments relate (database, secrets, encryption).
---

- Dev and production use SEPARATE Replit-managed Postgres databases. Rows inserted in dev do NOT appear in prod, and Publish migrates SCHEMA only — it never copies DATA rows. To change prod data you must write through the deployed app (admin UI) or have the data already present in the prod DB.
- `executeSql({environment:"production"})` is READ-ONLY (SELECT) against the prod replica; the agent has no direct prod write path.
- `SESSION_SECRET` is a GLOBAL Replit secret (identical in dev and prod). Integration config encryption (`encryptConfig`/`decryptConfig`, AES-256-GCM key = sha256(ENCRYPTION_KEY||SESSION_SECRET), prefix `enc::v1::`) therefore decrypts the same in both environments — so a value encrypted in dev IS decryptable in prod. ENCRYPTION_KEY is unset.
- Practical implication: a config row can look "present in prod" via executeSql yet hold DIFFERENT values than the dev row, because they are independent databases.
