/**
 * One-shot backfill: synchronise assignedToId across the Lead → Student →
 * Application triplet for every student that exists in the database.
 *
 * Priority rule (highest wins):
 *   student.assignedToId > lead.assignedToId > first non-null application.assignedToId
 *
 * If the canonical value is null for an entire triplet, the triplet is skipped
 * (nothing to sync). Otherwise the canonical value is written to every record
 * in the triplet that currently differs from it.
 *
 * Idempotent: re-running after a fully-consistent DB is a no-op (no rows
 * differ from canonical, so no updates are issued).
 *
 * Dry-run: DRY_RUN=1 prints what would change without writing anything.
 * Live mode additionally requires ALLOW_ASSIGNMENT_BACKFILL=true.
 *
 * Optional filter: pass `studentIds` to restrict the backfill to a specific
 * subset of students (useful for targeted repairs and integration tests).
 */
import { db, leadsTable, studentsTable, applicationsTable } from "@workspace/db";
import { and, eq, inArray, isNull } from "drizzle-orm";
import { logAudit } from "../src/lib/auth";
import { fileURLToPath } from "url";

export interface BackfillResult {
  studentsScanned: number;
  studentsUpdated: number;
  leadsUpdated: number;
  appsUpdated: number;
}

/**
 * Run the assignment backfill, optionally restricted to specific students.
 *
 * @param opts.studentIds  When provided, only backfill these student IDs.
 * @param opts.dryRun      When true, count changes but do not write to DB.
 */
export async function runBackfill(opts?: {
  studentIds?: number[];
  dryRun?: boolean;
}): Promise<BackfillResult> {
  const dryRun = opts?.dryRun ?? false;

  const where =
    opts?.studentIds && opts.studentIds.length > 0
      ? and(isNull(studentsTable.deletedAt), inArray(studentsTable.id, opts.studentIds))
      : isNull(studentsTable.deletedAt);

  const students = await db
    .select({ id: studentsTable.id, assignedToId: studentsTable.assignedToId })
    .from(studentsTable)
    .where(where);

  let updatedStudents = 0;
  let updatedLeads = 0;
  let updatedApps = 0;

  for (const student of students) {
    const leads = await db
      .select({ id: leadsTable.id, assignedToId: leadsTable.assignedToId })
      .from(leadsTable)
      .where(and(eq(leadsTable.convertedStudentId, student.id), isNull(leadsTable.deletedAt)));

    const apps = await db
      .select({ id: applicationsTable.id, assignedToId: applicationsTable.assignedToId })
      .from(applicationsTable)
      .where(and(eq(applicationsTable.studentId, student.id), isNull(applicationsTable.deletedAt)));

    // Determine canonical assignee — student wins, then lead, then first app.
    let canonical: number | null = student.assignedToId ?? null;
    if (canonical === null) {
      for (const lead of leads) {
        if (lead.assignedToId !== null && lead.assignedToId !== undefined) {
          canonical = lead.assignedToId;
          break;
        }
      }
    }
    if (canonical === null) {
      for (const app of apps) {
        if (app.assignedToId !== null && app.assignedToId !== undefined) {
          canonical = app.assignedToId;
          break;
        }
      }
    }

    // Entire triplet is unassigned — nothing to sync.
    if (canonical === null) continue;

    if ((student.assignedToId ?? null) !== canonical) {
      if (dryRun) {
        console.log(`  [DRY] student id=${student.id}: ${student.assignedToId ?? "null"} → ${canonical}`);
      } else {
        await db.update(studentsTable)
          .set({ assignedToId: canonical })
          .where(eq(studentsTable.id, student.id));
        logAudit(null, "assignment.backfill", "student", student.id, { from: student.assignedToId ?? null, to: canonical });
      }
      updatedStudents++;
    }

    for (const lead of leads) {
      if ((lead.assignedToId ?? null) !== canonical) {
        if (dryRun) {
          console.log(`  [DRY] lead id=${lead.id}: ${lead.assignedToId ?? "null"} → ${canonical}`);
        } else {
          await db.update(leadsTable)
            .set({ assignedToId: canonical })
            .where(eq(leadsTable.id, lead.id));
          logAudit(null, "assignment.backfill", "lead", lead.id, { from: lead.assignedToId ?? null, to: canonical });
        }
        updatedLeads++;
      }
    }

    for (const app of apps) {
      if ((app.assignedToId ?? null) !== canonical) {
        if (dryRun) {
          console.log(`  [DRY] application id=${app.id}: ${app.assignedToId ?? "null"} → ${canonical}`);
        } else {
          await db.update(applicationsTable)
            .set({ assignedToId: canonical })
            .where(eq(applicationsTable.id, app.id));
          logAudit(null, "assignment.backfill", "application", app.id, { from: app.assignedToId ?? null, to: canonical });
        }
        updatedApps++;
      }
    }
  }

  return {
    studentsScanned: students.length,
    studentsUpdated: updatedStudents,
    leadsUpdated: updatedLeads,
    appsUpdated: updatedApps,
  };
}

// ── CLI entry point ──────────────────────────────────────────────────────────
// Guard: only run main() when this file is the Node.js entry point, not when
// it is imported as a module (e.g. by the test suite). We check both the
// resolved __filename (ESM) and a tsx source-map suffix so the guard works
// whether tsx transpiles on-the-fly or the file is compiled to .js first.

async function main() {
  const DRY_RUN = process.env.DRY_RUN === "1" || process.env.DRY_RUN === "true";
  if (!DRY_RUN && process.env.ALLOW_ASSIGNMENT_BACKFILL !== "true") {
    throw new Error("ALLOW_ASSIGNMENT_BACKFILL=true is required for live backfill");
  }
  console.log(`[sync-assignment-backfill] starting (DRY_RUN=${DRY_RUN})`);

  const result = await runBackfill({ dryRun: DRY_RUN });

  console.log(
    `[sync-assignment-backfill] done.` +
    ` students=${result.studentsUpdated} leads=${result.leadsUpdated} apps=${result.appsUpdated}` +
    (DRY_RUN ? " (DRY RUN — no writes)" : "")
  );

  await new Promise(r => setTimeout(r, 500));
}

const __filename = fileURLToPath(import.meta.url);
const entryArg = process.argv[1] ?? "";
const isDirectlyInvoked =
  entryArg === __filename ||
  entryArg.endsWith("sync-assignment-backfill.ts") ||
  entryArg.endsWith("sync-assignment-backfill.js");

if (isDirectlyInvoked) {
  main().catch(e => {
    console.error("[sync-assignment-backfill] FATAL:", e?.message || e);
    process.exit(1);
  });
}
