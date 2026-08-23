---
name: Assignment cascade across Lead → Student → Application
description: How assigned-staff carries across the pipeline and the opt-in cascade-on-reassignment rule.
---

# Assignment cascade (Lead → Student → Application)

Two distinct behaviors keep assigned-staff ownership flowing down the pipeline:

- **Create/convert carry-over is fill-only:** when a downstream record is born
  (student from lead convert, application from a student), inherit the source's
  assigned owner ONLY when the downstream field is empty. Never overwrite an
  existing downstream owner on creation.
- **Reassignment cascade is overwrite:** changing a Lead's owner propagates to its
  converted student and that student's applications, overwriting their owners, with
  an `assignment.cascade` audit row per change.

## Rule: the reassignment cascade is OPT-IN, gated on `records.cascade_assignment`
That permission key is deliberately excluded from the default-role grants and from
the stage/assignment one-shot backfill, so no role gets it automatically; only
super_admin/admin have it (via the always-all short-circuit).

**Why:** Cascade overwrites already-assigned downstream records. Granting it by
default would silently clobber manual student/application assignments on every
lead reassignment. Admins must explicitly enable it per role/user.

**How to apply:** To make cascade default-on for a role later, add the key to the
default grants AND a system_flags-gated one-shot backfill (per role-permissions.md)
— do not union it at runtime, or admin toggle-offs won't stick.
