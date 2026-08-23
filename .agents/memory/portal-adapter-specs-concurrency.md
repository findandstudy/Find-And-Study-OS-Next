---
name: portal_adapter_specs enabled-version invariant
description: How the "one enabled version per key" invariant is enforced for the DB-backed declarative adapter spec system, and why naive disable-all-then-enable-one is unsafe.
---

# portal_adapter_specs: single-enabled-version invariant

The versioned spec table (`portal_adapter_specs`, one row per `(key, version)`)
must have **at most one `enabled=true` row per key**, because the spec loader
resolves the active adapter by selecting all enabled rows and first-seen-wins.

**Rule:** enforce the invariant in THREE layers, not just app code:
1. Partial unique index `UNIQUE(key) WHERE enabled` — defined in the Drizzle
   schema (`uniqueIndex(...).on(key).where(sql\`enabled\`)`), migration 0024, AND
   the api-server boot DDL (the only prod migration path). All three must stay in
   lockstep.
2. A per-key transaction-scoped advisory lock
   (`pg_advisory_xact_lock(hashtext(key))`) wraps every enable/rollback AND the
   version-creation path, so they serialize per key.
3. Version-number assignment (`max(version)+1`) + insert + optional enable run
   inside ONE locked transaction, so concurrent uploads can't collide on the
   `(key, version)` unique index or leave two enabled rows.

**Why:** the original `setEnabledSpecVersion` did "disable all, then enable one"
in a transaction with no DB-enforced uniqueness. Two interleaving enable/rollback
transactions could both commit and leave two enabled rows → nondeterministic
adapter resolution. `maxSpecVersion()+1` outside a lock was likewise race-prone
(concurrent uploads → 500 on the version unique index).

**How to apply:** any new write path that flips `enabled` or inserts a version
MUST acquire `lockSpecKey(tx, key)` first and reuse `setEnabledSpecVersionTx`
inside the same transaction (do NOT call the self-transacting
`setEnabledSpecVersion` from inside another transaction). Invalidate the spec
adapter cache after the transaction commits.
