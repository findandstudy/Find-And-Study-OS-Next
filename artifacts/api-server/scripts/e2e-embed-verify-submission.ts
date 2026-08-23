/**
 * Tiny verification helper for the e2e apply-flow test.
 *
 * Usage:
 *   tsx artifacts/api-server/scripts/e2e-embed-verify-submission.ts \
 *     --slug e2e-embed-test --email "<test-email>"
 *
 * Looks up the widget by slug, then finds the most recent
 * `embed_submissions` row for that widget where `email = <email>`
 * (case-insensitive). On success, prints a JSON object with the row's
 * id/widgetId/email/firstName/lastName/leadId/programId/programName/
 * universityName/sourcePageUrl to stdout and exits 0. On miss, exits
 * with a non-zero code so the caller can surface it as a failed test.
 *
 * The script exists so the Playwright test can directly assert the DB
 * row was written, without needing to plumb admin auth into the test or
 * stand up a dev-only HTTP endpoint.
 */
import {
  db,
  embedWidgetsTable,
  embedSubmissionsTable,
  leadsTable,
} from "@workspace/db";
import { and, desc, eq, sql } from "drizzle-orm";

interface ParsedArgs {
  slug: string;
  email: string;
}

function parseArgs(argv: string[]): ParsedArgs {
  let slug: string | null = null;
  let email: string | null = null;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--slug" && i + 1 < argv.length) {
      slug = argv[++i];
    } else if (a === "--email" && i + 1 < argv.length) {
      email = argv[++i];
    }
  }
  if (!slug || !email) {
    console.error(
      "Usage: tsx e2e-embed-verify-submission.ts --slug <slug> --email <email>",
    );
    process.exit(64);
  }
  return { slug, email };
}

async function main() {
  const { slug, email } = parseArgs(process.argv.slice(2));

  const [widget] = await db
    .select()
    .from(embedWidgetsTable)
    .where(eq(embedWidgetsTable.slug, slug));

  if (!widget) {
    console.error(`[e2e-embed-verify] widget not found for slug=${slug}`);
    process.exit(2);
  }

  // Case-insensitive email match — the route just `s(email, 255)`s the
  // input but we still don't want a typo (e.g. uppercase domain) to
  // false-fail the assertion.
  const [submission] = await db
    .select()
    .from(embedSubmissionsTable)
    .where(
      and(
        eq(embedSubmissionsTable.widgetId, widget.id),
        sql`lower(${embedSubmissionsTable.email}) = lower(${email})`,
      ),
    )
    .orderBy(desc(embedSubmissionsTable.createdAt))
    .limit(1);

  if (!submission) {
    console.error(
      `[e2e-embed-verify] no submission for widget=${slug} (id=${widget.id}) email=${email}`,
    );
    process.exit(3);
  }

  // Also fetch the linked lead row so the test can assert that the
  // apply route's transactional lead+submission insert (routes/embed.ts
  // ~L370) wired the FK and populated the expected fields. Missing lead
  // would surface as `lead: null` in the JSON output, letting the test
  // fail loudly instead of trusting the FK in isolation.
  let lead: {
    id: number;
    firstName: string;
    lastName: string;
    email: string | null;
    source: string | null;
    status: string;
  } | null = null;
  if (submission.leadId) {
    const [row] = await db
      .select()
      .from(leadsTable)
      .where(eq(leadsTable.id, submission.leadId));
    if (row) {
      lead = {
        id: row.id,
        firstName: row.firstName,
        lastName: row.lastName,
        email: row.email,
        source: row.source,
        status: row.status,
      };
    }
  }

  process.stdout.write(
    JSON.stringify({
      id: submission.id,
      widgetId: submission.widgetId,
      email: submission.email,
      firstName: submission.firstName,
      lastName: submission.lastName,
      leadId: submission.leadId,
      programId: submission.programId,
      programName: submission.programName,
      universityName: submission.universityName,
      sourcePageUrl: submission.sourcePageUrl,
      status: submission.status,
      lead,
    }),
  );
  process.exit(0);
}

main().catch((err) => {
  console.error("[e2e-embed-verify] error:", err);
  process.exit(1);
});
