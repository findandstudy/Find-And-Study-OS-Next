/**
 * Contract variable bridging unit test suite.
 *
 * Locks down the precedence rules in `buildAgentContext` (and the prefill
 * defaults in `agentIntakeDefaults`) that map an agent's camelCase intake
 * answers onto the canonical snake_case contract template variables. These
 * rules were only verified by hand at runtime; without a test they could
 * silently regress and start rendering the wrong agency name / tax number /
 * signer on signed contracts.
 *
 * Pure unit checks against artifacts/api-server/src/lib/contractRenderer.ts —
 * no DB, no network.
 *
 * Run with:
 *   pnpm --filter @workspace/api-server exec tsx ./scripts/test-contract-context.ts
 */
import { buildAgentContext, agentIntakeDefaults, renderTemplate } from "../src/lib/contractRenderer";

let pass = 0;
let fail = 0;

function check(label: string, actual: string, expected: string) {
  if (actual === expected) {
    pass++;
    console.log(`  ok   ${label} -> ${JSON.stringify(actual)}`);
  } else {
    fail++;
    console.error(`  FAIL ${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

// Render a single template variable through the same path the signing UI uses.
function v(ctx: Record<string, any>, key: string): string {
  return renderTemplate(`{{${key}}}`, ctx);
}

const adminAgent = {
  firstName: "Admin",
  lastName: "Entered",
  businessName: "Admin Trade Co",
  companyName: "Admin Legal LLC",
  email: "admin@agency.com",
  country: "TR",
  city: "Istanbul",
  address: "Admin Street 1",
  taxNumber: "ADMIN-TAX-000",
  agencyCode: "AG-001",
};

console.log("contract context unit tests\n");

// (1) camelCase intake overrides the admin agent record — in BOTH the unsigned
//     preview (no signerName) and the final signed render.
console.log("(1) camelCase intake overrides admin record (preview + final)");
{
  const intake = {
    companyName: "Signer Trade Co",
    taxNumber: "SIGNER-TAX-999",
    fullName: "Signer Person",
  };

  const preview = buildAgentContext(adminAgent, intake, {});
  check("preview agency_name", v(preview, "agency_name"), "Signer Trade Co");
  check("preview agency_legal_name", v(preview, "agency_legal_name"), "Signer Trade Co");
  check("preview tax_number", v(preview, "tax_number"), "SIGNER-TAX-999");
  check("preview contact_person_name", v(preview, "contact_person_name"), "Signer Person");

  const final = buildAgentContext(adminAgent, intake, {
    signerName: "Signer Person",
    signerEmail: "signer@agency.com",
    number: "C-2026-1",
    date: "2026-06-05",
  });
  check("final agency_name", v(final, "agency_name"), "Signer Trade Co");
  check("final agency_legal_name", v(final, "agency_legal_name"), "Signer Trade Co");
  check("final tax_number", v(final, "tax_number"), "SIGNER-TAX-999");
}

// (2) signer_name comes from the signature step, never from intake.
console.log("\n(2) signer_name comes from the signature step, not intake");
{
  const intake = {
    signerName: "Intake Signer",
    fullName: "Intake Full Name",
  };
  const ctx = buildAgentContext(adminAgent, intake, { signerName: "Signature Step Name" });
  check("signer_name", v(ctx, "signer_name"), "Signature Step Name");
  // The intake name still flows into contact_person_name, proving the two are
  // independent (signer_name is not just echoing the intake value).
  check("contact_person_name (independent)", v(ctx, "contact_person_name"), "Intake Full Name");

  // With no signature-step name, signer_name stays empty rather than borrowing
  // the intake camelCase signerName.
  const noSigner = buildAgentContext(adminAgent, intake, {});
  check("signer_name empty without sig step", v(noSigner, "signer_name"), "");
}

// (3) Distinct explicit snake_case agency_name vs agency_legal_name are preserved.
console.log("\n(3) distinct agency_name vs agency_legal_name preserved");
{
  const intake = {
    agency_name: "Daily Trade Name",
    agency_legal_name: "Full Legal Name LLC",
  };
  const ctx = buildAgentContext(adminAgent, intake, {});
  check("agency_name", v(ctx, "agency_name"), "Daily Trade Name");
  check("agency_legal_name", v(ctx, "agency_legal_name"), "Full Legal Name LLC");
}

// (4) Explicit snake_case key wins over the camelCase bridge.
console.log("\n(4) explicit snake_case key overrides camelCase");
{
  const intake = {
    agency_name: "Snake Wins",
    companyName: "Camel Loses",
    tax_number: "SNAKE-TAX",
    taxNumber: "CAMEL-TAX",
  };
  const ctx = buildAgentContext(adminAgent, intake, {});
  check("agency_name", v(ctx, "agency_name"), "Snake Wins");
  check("tax_number", v(ctx, "tax_number"), "SNAKE-TAX");
}

// (5) Empty / missing intake falls back to the admin agent record.
console.log("\n(5) empty intake falls back to agent record");
{
  const nullCtx = buildAgentContext(adminAgent, null, {});
  check("null intake agency_name", v(nullCtx, "agency_name"), "Admin Trade Co");
  check("null intake agency_legal_name", v(nullCtx, "agency_legal_name"), "Admin Legal LLC");
  check("null intake tax_number", v(nullCtx, "tax_number"), "ADMIN-TAX-000");
  check("null intake contact_person_name", v(nullCtx, "contact_person_name"), "Admin Entered");

  const emptyCtx = buildAgentContext(adminAgent, {}, {});
  check("empty intake agency_name", v(emptyCtx, "agency_name"), "Admin Trade Co");
  check("empty intake tax_number", v(emptyCtx, "tax_number"), "ADMIN-TAX-000");

  // Blank-string intake answers must not clobber the agent record either.
  const blankCtx = buildAgentContext(adminAgent, { companyName: "  ", taxNumber: "" }, {});
  check("blank intake agency_name", v(blankCtx, "agency_name"), "Admin Trade Co");
  check("blank intake tax_number", v(blankCtx, "tax_number"), "ADMIN-TAX-000");
}

// agentIntakeDefaults: prefill from the agent record + saved-answer priority.
console.log("\n(6) agentIntakeDefaults prefill + saved-answer priority");
{
  const defaults = agentIntakeDefaults(adminAgent);
  check("prefill fullName", defaults.fullName, "Admin Entered");
  check("prefill signerName", defaults.signerName, "Admin Entered");
  check("prefill companyName", defaults.companyName, "Admin Trade Co");
  check("prefill agencyName", defaults.agencyName, "Admin Trade Co");
  check("prefill taxNumber", defaults.taxNumber, "ADMIN-TAX-000");
  check("prefill address", defaults.address, "Admin Street 1");

  // Empty agent fields are omitted (never clobber a saved answer on the client).
  const sparse = agentIntakeDefaults({ firstName: "Solo" });
  check("sparse fullName", sparse.fullName, "Solo");
  check("sparse companyName omitted", String("companyName" in sparse), "false");
  check("sparse taxNumber omitted", String("taxNumber" in sparse), "false");
  check("sparse address omitted", String("address" in sparse), "false");

  // null agent -> no defaults.
  check("null agent defaults empty", String(Object.keys(agentIntakeDefaults(null)).length), "0");

  // Saved-answer priority: a saved intake answer wins over the prefill default
  // when the context is built (the prefill only seeds an empty form).
  const savedIntake = { companyName: "Saved Answer Co" };
  const ctx = buildAgentContext(adminAgent, savedIntake, {});
  check("saved answer beats prefill default", v(ctx, "agency_name"), "Saved Answer Co");
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
