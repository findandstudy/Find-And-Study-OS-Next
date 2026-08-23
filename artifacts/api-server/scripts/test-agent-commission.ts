/**
 * Agent commission resolver test suite.
 *
 * Locks down the invariants for the sub-agent commission chain hardening:
 *
 *   (a) Pure unit-style checks calling resolveAgentCommission directly:
 *         - null/zero inputs return empty
 *         - standalone agent with rate=R returns R% of universityCommission
 *         - parent + sub-agent two-tier chain calculates correctly
 *
 *   (b) Defensive guards (the actual hardening):
 *         - Self-reference: agent.parentAgentId === agent.id is treated as
 *           standalone (no infinite recursion in any future walker, no zeroed
 *           commission today).
 *         - Orphan parent: agent.parentAgentId points at a row that no longer
 *           exists is treated as standalone — the agent's own commissionRate
 *           is honored. This is a behavior change from the prior version
 *           which returned empty (zero commission) and silently lost revenue
 *           when a parent agent was deleted.
 *
 *   (c) Math regression guard: existing two-tier math is unchanged.
 *
 * Run with:
 *   pnpm --filter @workspace/api-server run test:agent-commission
 *   # or:
 *   pnpm --filter @workspace/api-server exec tsx ./scripts/test-agent-commission.ts
 */
import { db, agentsTable } from "@workspace/db";
import { eq, inArray } from "drizzle-orm";
import { resolveAgentCommission } from "../src/lib/agentCommission";

const RUN_ID = `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;

interface Section {
  name: string;
  ok: boolean;
  details: string[];
}

function assert(cond: boolean, msg: string, details: string[]): boolean {
  details.push(`${cond ? "OK   " : "FAIL "} ${msg}`);
  return cond;
}

function approxEqual(a: string | null, expected: number | null): boolean {
  if (expected === null) return a === null;
  if (a === null) return false;
  const n = Number(a);
  if (!Number.isFinite(n)) return false;
  return Math.abs(n - expected) < 0.005;
}

async function createAgent(opts: {
  firstName: string;
  commissionRate: number | null;
  parentAgentId?: number | null;
}): Promise<number> {
  const [row] = await db
    .insert(agentsTable)
    .values({
      firstName: opts.firstName,
      lastName: `Test_${RUN_ID}`,
      commissionRate: opts.commissionRate,
      parentAgentId: opts.parentAgentId ?? null,
      status: "active",
    })
    .returning({ id: agentsTable.id });
  return row.id;
}

async function setParent(id: number, parentId: number): Promise<void> {
  await db.update(agentsTable).set({ parentAgentId: parentId }).where(eq(agentsTable.id, id));
}

async function deleteAgent(id: number): Promise<void> {
  await db.delete(agentsTable).where(eq(agentsTable.id, id));
}

// ---------------------------------------------------------------------------
// (a) Basic unit checks
// ---------------------------------------------------------------------------

async function testBasic(): Promise<Section> {
  const details: string[] = [];
  let ok = true;

  // null agentId
  const r1 = await resolveAgentCommission(null, 1000);
  ok = assert(r1.agentId === null, "null agentId returns null agentId", details) && ok;
  ok = assert(r1.agentCommissionRate === null, "null agentId: rate is null", details) && ok;
  ok = assert(r1.agentCommissionAmount === null, "null agentId: amount is null", details) && ok;

  // undefined agentId
  const r2 = await resolveAgentCommission(undefined, 1000);
  ok = assert(r2.agentCommissionAmount === null, "undefined agentId: amount is null", details) && ok;

  // universityCommissionAmount = 0
  const someAgent = await createAgent({ firstName: `BasicZero_${RUN_ID}`, commissionRate: 10 });
  try {
    const r3 = await resolveAgentCommission(someAgent, 0);
    ok = assert(r3.agentCommissionAmount === null, "uComm=0: amount is null", details) && ok;
    const r4 = await resolveAgentCommission(someAgent, -50);
    ok = assert(r4.agentCommissionAmount === null, "uComm<0: amount is null", details) && ok;
  } finally {
    await deleteAgent(someAgent);
  }

  // non-existent agentId
  const r5 = await resolveAgentCommission(99999999, 1000);
  ok = assert(r5.agentCommissionAmount === null, "non-existent agentId: amount is null", details) && ok;
  ok = assert(r5.agentId === 99999999, "non-existent agentId: input id echoed back", details) && ok;

  return { name: "(a) Basic input handling", ok, details };
}

// ---------------------------------------------------------------------------
// (b) Standalone agent (no parent)
// ---------------------------------------------------------------------------

async function testStandalone(): Promise<Section> {
  const details: string[] = [];
  let ok = true;

  const standalone = await createAgent({
    firstName: `Standalone_${RUN_ID}`,
    commissionRate: 10,
  });

  try {
    const r = await resolveAgentCommission(standalone, 1000);
    ok = assert(r.agentId === standalone, "standalone: agentId === input", details) && ok;
    ok = assert(approxEqual(r.agentCommissionRate, 10), `standalone: rate=10 (got ${r.agentCommissionRate})`, details) && ok;
    ok = assert(approxEqual(r.agentCommissionAmount, 100), `standalone: amount=100 (got ${r.agentCommissionAmount})`, details) && ok;
    ok = assert(r.subAgentId === null, "standalone: subAgentId is null", details) && ok;
    ok = assert(r.subAgentCommissionRate === null, "standalone: subRate is null", details) && ok;
    ok = assert(r.subAgentCommissionAmount === null, "standalone: subAmount is null", details) && ok;

    // Zero rate standalone
    const zeroRate = await createAgent({
      firstName: `ZeroRate_${RUN_ID}`,
      commissionRate: 0,
    });
    try {
      const r2 = await resolveAgentCommission(zeroRate, 1000);
      ok = assert(r2.agentCommissionAmount === null, "standalone rate=0: amount is null", details) && ok;
    } finally {
      await deleteAgent(zeroRate);
    }

    // Null rate
    const nullRate = await createAgent({
      firstName: `NullRate_${RUN_ID}`,
      commissionRate: null,
    });
    try {
      const r3 = await resolveAgentCommission(nullRate, 1000);
      ok = assert(r3.agentCommissionAmount === null, "standalone rate=null: amount is null", details) && ok;
    } finally {
      await deleteAgent(nullRate);
    }
  } finally {
    await deleteAgent(standalone);
  }

  return { name: "(b) Standalone agent", ok, details };
}

// ---------------------------------------------------------------------------
// (c) Two-tier chain (parent + sub-agent) — math regression guard
// ---------------------------------------------------------------------------

async function testTwoTier(): Promise<Section> {
  const details: string[] = [];
  let ok = true;

  const parent = await createAgent({
    firstName: `Parent_${RUN_ID}`,
    commissionRate: 20,
  });
  const sub = await createAgent({
    firstName: `Sub_${RUN_ID}`,
    commissionRate: 15,
    parentAgentId: parent,
  });

  try {
    // uComm = 1000, parent rate=20%, sub rate=15% of parent amount
    // → parentAmount = 200, subAmount = 30
    const r = await resolveAgentCommission(sub, 1000);
    ok = assert(r.agentId === parent, `two-tier: agentId === parent (got ${r.agentId})`, details) && ok;
    ok = assert(approxEqual(r.agentCommissionRate, 20), `two-tier: parent rate=20 (got ${r.agentCommissionRate})`, details) && ok;
    ok = assert(approxEqual(r.agentCommissionAmount, 200), `two-tier: parent amount=200 (got ${r.agentCommissionAmount})`, details) && ok;
    ok = assert(r.subAgentId === sub, `two-tier: subAgentId === sub (got ${r.subAgentId})`, details) && ok;
    ok = assert(approxEqual(r.subAgentCommissionRate, 15), `two-tier: sub rate=15 (got ${r.subAgentCommissionRate})`, details) && ok;
    ok = assert(approxEqual(r.subAgentCommissionAmount, 30), `two-tier: sub amount=30 (got ${r.subAgentCommissionAmount})`, details) && ok;

    // Sub rate = 0 → parent amount kept, sub amount null
    const subZero = await createAgent({
      firstName: `SubZero_${RUN_ID}`,
      commissionRate: 0,
      parentAgentId: parent,
    });
    try {
      const r2 = await resolveAgentCommission(subZero, 1000);
      ok = assert(approxEqual(r2.agentCommissionAmount, 200), "two-tier subRate=0: parent amount preserved", details) && ok;
      ok = assert(r2.subAgentCommissionAmount === null, "two-tier subRate=0: sub amount null", details) && ok;
    } finally {
      await deleteAgent(subZero);
    }
  } finally {
    await deleteAgent(sub);
    await deleteAgent(parent);
  }

  return { name: "(c) Two-tier chain (math regression guard)", ok, details };
}

// ---------------------------------------------------------------------------
// (d) Self-reference guard
// ---------------------------------------------------------------------------

async function testSelfReference(): Promise<Section> {
  const details: string[] = [];
  let ok = true;

  // Insert with parent=null first, then UPDATE to point at self.
  const selfRef = await createAgent({
    firstName: `SelfRef_${RUN_ID}`,
    commissionRate: 8,
  });

  try {
    await setParent(selfRef, selfRef);

    const r = await resolveAgentCommission(selfRef, 1000);
    // Expected: treated as standalone — no crash, no infinite loop, agent's
    // own rate honored.
    ok = assert(r.agentId === selfRef, `self-ref: agentId === self (got ${r.agentId})`, details) && ok;
    ok = assert(approxEqual(r.agentCommissionRate, 8), `self-ref: rate=8 honored (got ${r.agentCommissionRate})`, details) && ok;
    ok = assert(approxEqual(r.agentCommissionAmount, 80), `self-ref: amount=80 (got ${r.agentCommissionAmount})`, details) && ok;
    ok = assert(r.subAgentId === null, "self-ref: subAgentId is null (no chain)", details) && ok;
    ok = assert(r.subAgentCommissionAmount === null, "self-ref: subAmount is null", details) && ok;
  } finally {
    await deleteAgent(selfRef);
  }

  return { name: "(d) Self-reference guard", ok, details };
}

// ---------------------------------------------------------------------------
// (e) Orphan parent — behavior change: standalone fallback (was: empty)
// ---------------------------------------------------------------------------

async function testOrphanParent(): Promise<Section> {
  const details: string[] = [];
  let ok = true;

  // Create parent + child, then delete the parent so child has a dangling
  // parent_agent_id (FK is not enforced at the schema level).
  const ghost = await createAgent({
    firstName: `Ghost_${RUN_ID}`,
    commissionRate: 25,
  });
  const orphan = await createAgent({
    firstName: `Orphan_${RUN_ID}`,
    commissionRate: 12,
    parentAgentId: ghost,
  });

  try {
    await deleteAgent(ghost); // ghost is now gone; orphan.parentAgentId is dangling

    const r = await resolveAgentCommission(orphan, 1000);
    // Expected (NEW behavior): treat as standalone, honor orphan.commissionRate.
    // Old behavior would have returned empty (regression: lost commission).
    ok = assert(r.agentId === orphan, `orphan: agentId === orphan (got ${r.agentId})`, details) && ok;
    ok = assert(approxEqual(r.agentCommissionRate, 12), `orphan: rate=12 honored (got ${r.agentCommissionRate})`, details) && ok;
    ok = assert(approxEqual(r.agentCommissionAmount, 120), `orphan: amount=120 (was 0 in prior version) (got ${r.agentCommissionAmount})`, details) && ok;
    ok = assert(r.subAgentId === null, "orphan: subAgentId is null (no chain)", details) && ok;
    ok = assert(r.subAgentCommissionAmount === null, "orphan: subAmount is null", details) && ok;

    // Orphan with rate=0 still yields no commission (consistent with standalone).
    const orphanZero = await createAgent({
      firstName: `OrphanZero_${RUN_ID}`,
      commissionRate: 0,
      parentAgentId: 99999998, // never existed
    });
    try {
      const r2 = await resolveAgentCommission(orphanZero, 1000);
      ok = assert(r2.agentCommissionAmount === null, "orphan rate=0: amount is null", details) && ok;
    } finally {
      await deleteAgent(orphanZero);
    }

    // Orphan pointing at id that never existed (not deleted, just bogus).
    const orphanBogus = await createAgent({
      firstName: `OrphanBogus_${RUN_ID}`,
      commissionRate: 7,
      parentAgentId: 99999997,
    });
    try {
      const r3 = await resolveAgentCommission(orphanBogus, 1000);
      ok = assert(approxEqual(r3.agentCommissionAmount, 70), `orphan-bogus: standalone amount=70 (got ${r3.agentCommissionAmount})`, details) && ok;
    } finally {
      await deleteAgent(orphanBogus);
    }
  } finally {
    await deleteAgent(orphan);
  }

  return { name: "(e) Orphan parent fallback (NEW behavior)", ok, details };
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  console.log(`[agent-commission] starting run ${RUN_ID}`);
  const sections: Section[] = [];
  let cleanupIds: number[] = [];

  try {
    sections.push(await testBasic());
    sections.push(await testStandalone());
    sections.push(await testTwoTier());
    sections.push(await testSelfReference());
    sections.push(await testOrphanParent());
  } catch (err) {
    console.error(`[agent-commission] FATAL:`, err);
    // Best-effort cleanup of any leftover RUN_ID-tagged agents
    try {
      const rows = await db
        .select({ id: agentsTable.id })
        .from(agentsTable)
        .where(eq(agentsTable.lastName, `Test_${RUN_ID}`));
      cleanupIds = rows.map((r) => r.id);
      if (cleanupIds.length > 0) {
        await db.delete(agentsTable).where(inArray(agentsTable.id, cleanupIds));
        console.error(`[agent-commission] emergency cleanup: removed ${cleanupIds.length} agents`);
      }
    } catch (cleanupErr) {
      console.error(`[agent-commission] cleanup also failed:`, cleanupErr);
    }
    process.exit(2);
  }

  // Final safety-net cleanup (in case any test forgot)
  try {
    const rows = await db
      .select({ id: agentsTable.id })
      .from(agentsTable)
      .where(eq(agentsTable.lastName, `Test_${RUN_ID}`));
    if (rows.length > 0) {
      await db.delete(agentsTable).where(inArray(agentsTable.id, rows.map((r) => r.id)));
      console.log(`[agent-commission] safety-net cleanup: removed ${rows.length} leftover agents`);
    }
  } catch (cleanupErr) {
    console.error(`[agent-commission] safety-net cleanup failed:`, cleanupErr);
  }

  let allOk = true;
  for (const s of sections) {
    console.log(`\n=== ${s.name} ${s.ok ? "PASS" : "FAIL"} ===`);
    for (const d of s.details) console.log(`  ${d}`);
    if (!s.ok) allOk = false;
  }

  console.log(`\n[agent-commission] ${allOk ? "PASS" : "FAIL"} (run ${RUN_ID})`);
  process.exit(allOk ? 0 : 1);
}

main().catch((err) => {
  console.error("[agent-commission] unhandled:", err);
  process.exit(2);
});
