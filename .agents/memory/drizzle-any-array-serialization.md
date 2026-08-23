---
name: Drizzle raw sql ANY(array) broken
description: Using ANY(${jsArray}) in a Drizzle sql template does not serialize a JS number[] as a PostgreSQL array — use inArray subquery instead.
---

## Rule
Never pass a JS `number[]` (or any array) via `${...}` inside a raw Drizzle `sql` template when it feeds an SQL `ANY()` or `IN` clause. Drizzle serializes the array as a single scalar parameter, causing a PostgreSQL type error at runtime.

## Why
Drizzle's `sql` tagged template treats array values as scalar parameters (binding the whole array as a single `$N` value). PostgreSQL's `= ANY($N)` requires `$N` to be a PostgreSQL array type (`{1,2,3}` or `ARRAY[1,2,3]`), not a scalar. The result is a 500 with a message like `branch_id = ANY(($3))` with params `...,1760` — the array was flattened to a single number.

This manifested in `GET /agents/contract-alerts` where branch-limited managers always received 500. `super_admin` (where `visible = null`, so the branch condition is never added) was unaffected, hiding the bug.

## How to apply
Replace `sql\`col = ANY(${visible})\`` with an `inArray` subquery:

```typescript
// ❌ BROKEN — ANY() receives a scalar, not a PG array
conditions.push(sql`${agentsTable.id} IN (SELECT agent_id FROM agent_branches WHERE branch_id = ANY(${visible}))`);

// ✅ CORRECT — inArray generates proper parameterized SQL
conditions.push(
  inArray(
    agentsTable.id,
    db.select({ id: agentBranchesTable.agentId })
      .from(agentBranchesTable)
      .where(inArray(agentBranchesTable.branchId, visible)),
  ),
);
```

The pattern `sql\`false\`` (for empty visible array) is fine — it's a literal, not a parameter.

The same broken pattern also exists in `loadAgentCatalog` and the export/import handlers in `routes/agents.ts` (they use `sql\`... = ANY(${visible})\`` too). Those routes were not fixed in this task (scope was contract-alerts only) but should be addressed if branch-limited managers report 500s on export/import.
