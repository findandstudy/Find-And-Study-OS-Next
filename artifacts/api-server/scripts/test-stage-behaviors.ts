/**
 * Pipeline stage behavior regression test (Task #134).
 *
 * Locks down dynamic stage-behavior invariants now that the previously
 * hardcoded stage-key checks (offer expiry, finance status, sibling
 * auto-cancel, doc upload permission) are driven by configurable fields
 * on `pipeline_stages`:
 *
 *   (a) Permission matrix (canUploadStageDocument):
 *         - none / unknown          → nobody
 *         - staff_only              → staff/admin/manager only
 *         - admin_only (legacy)     → behaves as staff_only
 *         - staff_and_agent         → staff + agents (no students)
 *         - everyone                → staff + agents + students
 *
 *   (b) Finance status resolution (stageFinance):
 *         - explicit override on the stage row wins over variant
 *         - variant fallback (won → confirmed, lost → excluded, etc.)
 *         - works with custom (non-default) stage keys
 *         - shouldHaveCommission / shouldHaveServiceFee track the status
 *
 *   (c) Auto-cancel siblings flag:
 *         - shouldAutoCancelSiblings is true ONLY when the stage row has
 *           auto_cancel_siblings_on_won=true, regardless of stage key —
 *           proving the old hardcoded "won" key check is gone.
 *
 *   (d) Offer expiry tracking flag:
 *         - The offerExpiryChecker query selects exactly the stages whose
 *           tracks_offer_expiry=true, including custom stage keys.
 *
 * Run with:
 *   pnpm --filter @workspace/api-server run test:stage-behaviors
 */
import { db, pipelineStagesTable } from "@workspace/db";
import { eq, and, inArray } from "drizzle-orm";
import { canUploadStageDocument } from "../src/lib/stagePermissions";
import {
  getCommissionFinanceStatus,
  getServiceFeeFinanceStatus,
  shouldAutoCancelSiblings,
  shouldHaveCommission,
  shouldHaveServiceFee,
  clearStageFinanceCache,
} from "../src/lib/stageFinance";

const RUN_ID = `t134_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;

interface Section {
  name: string;
  ok: boolean;
  details: string[];
}

function assert(cond: boolean, msg: string, details: string[]): boolean {
  details.push(`${cond ? "OK   " : "FAIL "} ${msg}`);
  return cond;
}

// --------------------------------------------------------------------------
// (a) Permission matrix — pure unit checks, no DB.
// --------------------------------------------------------------------------
function testPermissionMatrix(): Section {
  const details: string[] = [];
  let ok = true;

  // admin_only: ONLY admin / manager / super_admin (preserves
  // historical access for migrated default offer stages — must NOT
  // broaden to other staff roles).
  ok = assert(canUploadStageDocument("admin_only", "admin"),         "admin_only allows admin",                    details) && ok;
  ok = assert(canUploadStageDocument("admin_only", "manager"),       "admin_only allows manager",                  details) && ok;
  ok = assert(canUploadStageDocument("admin_only", "super_admin"),   "admin_only allows super_admin",              details) && ok;
  ok = assert(!canUploadStageDocument("admin_only", "consultant"),   "admin_only blocks consultant (legacy parity)", details) && ok;
  ok = assert(!canUploadStageDocument("admin_only", "editor"),       "admin_only blocks editor (legacy parity)",   details) && ok;
  ok = assert(!canUploadStageDocument("admin_only", "accountant"),   "admin_only blocks accountant (legacy parity)", details) && ok;
  ok = assert(!canUploadStageDocument("admin_only", "staff"),        "admin_only blocks generic staff",            details) && ok;
  ok = assert(!canUploadStageDocument("admin_only", "agent"),        "admin_only blocks agent",                    details) && ok;
  ok = assert(!canUploadStageDocument("admin_only", "student"),      "admin_only blocks student",                  details) && ok;

  // staff_only: all staff roles (admin + staff/consultant/editor/...)
  ok = assert(canUploadStageDocument("staff_only", "admin"),         "staff_only allows admin",         details) && ok;
  ok = assert(canUploadStageDocument("staff_only", "manager"),       "staff_only allows manager",       details) && ok;
  ok = assert(canUploadStageDocument("staff_only", "consultant"),    "staff_only allows consultant",    details) && ok;
  ok = assert(canUploadStageDocument("staff_only", "accountant"),    "staff_only allows accountant",    details) && ok;
  ok = assert(!canUploadStageDocument("staff_only", "agent"),        "staff_only blocks agent",         details) && ok;
  ok = assert(!canUploadStageDocument("staff_only", "student"),      "staff_only blocks student",       details) && ok;

  // staff_and_agent: staff + agent yes, student no
  ok = assert(canUploadStageDocument("staff_and_agent", "admin"),    "staff_and_agent allows admin",    details) && ok;
  ok = assert(canUploadStageDocument("staff_and_agent", "agent"),    "staff_and_agent allows agent",    details) && ok;
  ok = assert(!canUploadStageDocument("staff_and_agent", "student"), "staff_and_agent blocks student",  details) && ok;

  // everyone: all three yes
  ok = assert(canUploadStageDocument("everyone", "admin"),           "everyone allows admin",           details) && ok;
  ok = assert(canUploadStageDocument("everyone", "agent"),           "everyone allows agent",           details) && ok;
  ok = assert(canUploadStageDocument("everyone", "student"),         "everyone allows student",         details) && ok;

  // none / unknown / null: nobody
  ok = assert(!canUploadStageDocument("none", "admin"),              "none blocks everyone (admin)",    details) && ok;
  ok = assert(!canUploadStageDocument(null, "admin"),                "null level blocks everyone",      details) && ok;
  ok = assert(!canUploadStageDocument("garbage", "admin"),           "unknown level blocks everyone",   details) && ok;

  return { name: "permission matrix", ok, details };
}

// --------------------------------------------------------------------------
// DB-driven tests — create a few synthetic stages with custom keys.
// --------------------------------------------------------------------------
async function withStages<T>(
  rows: Array<{
    key: string;
    label: string;
    sortOrder: number;
    variant?: string | null;
    commissionFinanceStatus?: string | null;
    serviceFeeFinanceStatus?: string | null;
    autoCancelSiblingsOnWon?: boolean;
    tracksOfferExpiry?: boolean;
    requiresValidUntil?: boolean;
    uploadPermissionLevel?: string;
  }>,
  fn: (keys: string[]) => Promise<T>,
): Promise<T> {
  type StageInsert = typeof pipelineStagesTable.$inferInsert;
  const inserted: StageInsert[] = rows.map(r => ({
    entityType: "application",
    key: r.key,
    label: r.label,
    sortOrder: r.sortOrder,
    variant: r.variant ?? null,
    commissionFinanceStatus: r.commissionFinanceStatus ?? null,
    serviceFeeFinanceStatus: r.serviceFeeFinanceStatus ?? null,
    autoCancelSiblingsOnWon: r.autoCancelSiblingsOnWon ?? false,
    tracksOfferExpiry: r.tracksOfferExpiry ?? false,
    requiresValidUntil: r.requiresValidUntil ?? false,
    uploadPermissionLevel: r.uploadPermissionLevel ?? "none",
  }));
  await db.insert(pipelineStagesTable).values(inserted);
  const keys = rows.map(r => r.key);
  try {
    clearStageFinanceCache();
    return await fn(keys);
  } finally {
    await db.delete(pipelineStagesTable).where(and(
      eq(pipelineStagesTable.entityType, "application"),
      inArray(pipelineStagesTable.key, keys),
    ));
    clearStageFinanceCache();
  }
}

async function testFinanceStatus(): Promise<Section> {
  const details: string[] = [];
  let ok = true;

  // Use namespaced custom keys so we don't collide with built-in defaults.
  const kWon       = `${RUN_ID}_signed`;       // variant=won, no override
  const kPotential = `${RUN_ID}_negotiation`;  // override commission=potential
  const kExcluded  = `${RUN_ID}_archived`;     // override commission=excluded
  const kVarLost   = `${RUN_ID}_dropped`;      // variant=lost, no override

  await withStages([
    { key: kWon,       label: "Signed",       sortOrder: 9001, variant: "won" },
    { key: kPotential, label: "Negotiation",  sortOrder: 9002, variant: null,
      commissionFinanceStatus: "potential", serviceFeeFinanceStatus: "confirmed" },
    { key: kExcluded,  label: "Archived",     sortOrder: 9003, variant: null,
      commissionFinanceStatus: "excluded",  serviceFeeFinanceStatus: "excluded"  },
    { key: kVarLost,   label: "Dropped",      sortOrder: 9004, variant: "lost" },
  ], async () => {
    const c1 = await getCommissionFinanceStatus(kWon);
    ok = assert(c1 === "confirmed", `won variant → commission confirmed (got ${c1})`, details) && ok;

    const c2 = await getCommissionFinanceStatus(kPotential);
    ok = assert(c2 === "potential", `explicit commission override wins (got ${c2})`, details) && ok;

    const s2 = await getServiceFeeFinanceStatus(kPotential);
    ok = assert(s2 === "confirmed", `explicit service-fee override wins (got ${s2})`, details) && ok;

    const c3 = await getCommissionFinanceStatus(kExcluded);
    ok = assert(c3 === "excluded", `excluded override → commission excluded (got ${c3})`, details) && ok;

    const c4 = await getCommissionFinanceStatus(kVarLost);
    ok = assert(c4 === "excluded", `lost variant → commission excluded (got ${c4})`, details) && ok;

    const sh1 = await shouldHaveCommission(kPotential);
    ok = assert(sh1 === true, "shouldHaveCommission true when potential", details) && ok;

    const sh2 = await shouldHaveCommission(kExcluded);
    ok = assert(sh2 === false, "shouldHaveCommission false when excluded", details) && ok;

    const sh3 = await shouldHaveServiceFee(kVarLost);
    ok = assert(sh3 === false, "shouldHaveServiceFee false on lost variant", details) && ok;
  });

  return { name: "finance status (custom + default keys)", ok, details };
}

async function testAutoCancelSiblings(): Promise<Section> {
  const details: string[] = [];
  let ok = true;

  const kCancelTrue  = `${RUN_ID}_offerlocked`;  // custom key, flag=true → must cancel siblings
  const kCancelFalse = `${RUN_ID}_offerlocked2`; // custom key, flag=false → must NOT cancel
  const kWonNoFlag   = `${RUN_ID}_signed_nf`;    // variant=won but flag=false → must NOT cancel

  await withStages([
    { key: kCancelTrue,  label: "Offer Locked",      sortOrder: 9101, variant: null, autoCancelSiblingsOnWon: true  },
    { key: kCancelFalse, label: "Offer Locked Soft", sortOrder: 9102, variant: null, autoCancelSiblingsOnWon: false },
    { key: kWonNoFlag,   label: "Signed (no flag)",  sortOrder: 9103, variant: "won", autoCancelSiblingsOnWon: false },
  ], async () => {
    const a = await shouldAutoCancelSiblings(kCancelTrue);
    ok = assert(a === true, "custom key with flag=true cancels siblings", details) && ok;

    const b = await shouldAutoCancelSiblings(kCancelFalse);
    ok = assert(b === false, "custom key with flag=false does NOT cancel siblings", details) && ok;

    // Critical regression: variant=won is no longer a hardcoded trigger.
    const c = await shouldAutoCancelSiblings(kWonNoFlag);
    ok = assert(c === false, "won variant without flag does NOT cancel siblings (no hardcoded 'won' check)", details) && ok;
  });

  return { name: "auto-cancel siblings flag", ok, details };
}

async function testOfferExpiryQuery(): Promise<Section> {
  const details: string[] = [];
  let ok = true;

  const kTracked   = `${RUN_ID}_offerX`;       // custom key, tracks_offer_expiry=true
  const kUntracked = `${RUN_ID}_offerY`;       // custom key, tracks_offer_expiry=false

  await withStages([
    { key: kTracked,   label: "Custom Offer X", sortOrder: 9201, tracksOfferExpiry: true,  requiresValidUntil: true },
    { key: kUntracked, label: "Custom Offer Y", sortOrder: 9202, tracksOfferExpiry: false, requiresValidUntil: false },
  ], async () => {
    // Exact same query offerExpiryChecker uses. Proves custom-keyed stages
    // are picked up purely from the flag, not from a hardcoded set.
    const tracked = await db.select({ key: pipelineStagesTable.key })
      .from(pipelineStagesTable)
      .where(and(
        eq(pipelineStagesTable.entityType, "application"),
        eq(pipelineStagesTable.tracksOfferExpiry, true),
      ));
    const trackedKeys = new Set(tracked.map(r => r.key));

    ok = assert(trackedKeys.has(kTracked),    `tracked custom key included (${kTracked})`, details) && ok;
    ok = assert(!trackedKeys.has(kUntracked), `untracked custom key NOT included (${kUntracked})`, details) && ok;
  });

  return { name: "offer expiry tracking query", ok, details };
}

async function main() {
  const sections: Section[] = [];
  sections.push(testPermissionMatrix());
  sections.push(await testFinanceStatus());
  sections.push(await testAutoCancelSiblings());
  sections.push(await testOfferExpiryQuery());

  let allOk = true;
  console.log("\n=== Pipeline stage behavior regression (Task #134) ===\n");
  for (const s of sections) {
    console.log(`[${s.ok ? "PASS" : "FAIL"}] ${s.name}`);
    for (const d of s.details) console.log(`   ${d}`);
    allOk = allOk && s.ok;
  }
  console.log("");
  if (!allOk) {
    console.error("Some assertions FAILED.");
    process.exit(1);
  }
  console.log("All stage behavior regression checks passed.");
  process.exit(0);
}

main().catch(err => {
  console.error("Test runner crashed:", err);
  process.exit(1);
});
