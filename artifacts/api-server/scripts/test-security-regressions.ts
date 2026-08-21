import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { isCredentialedCorsOriginAllowed } from "../src/lib/requestOrigin";
import { getDatabaseName, isSafeE2eDatabaseUrl } from "./e2e-database-safety";

const appSource = readFileSync(
  new URL("../src/app.ts", import.meta.url),
  "utf8",
);
const indexSource = readFileSync(
  new URL("../src/index.ts", import.meta.url),
  "utf8",
);
const lifecycleSource = readFileSync(
  new URL("../src/lib/portalLifecycleContract.ts", import.meta.url),
  "utf8",
);
const staffSettingsSource = readFileSync(
  new URL("../../edcons/src/pages/staff/Settings.tsx", import.meta.url),
  "utf8",
);
const agentAccountSource = readFileSync(
  new URL("../../edcons/src/pages/agent/Account.tsx", import.meta.url),
  "utf8",
);
const inboxRouteSource = readFileSync(
  new URL("../src/routes/inbox.ts", import.meta.url),
  "utf8",
);
const messagesUiSource = readFileSync(
  new URL("../../edcons/src/pages/staff/Messages.tsx", import.meta.url),
  "utf8",
);
const storageRouteSource = readFileSync(
  new URL("../src/routes/storage.ts", import.meta.url),
  "utf8",
);
const objectAuthzSource = readFileSync(
  new URL("../src/lib/objectAuthz.ts", import.meta.url),
  "utf8",
);
const objectStorageSource = readFileSync(
  new URL("../src/lib/objectStorage.ts", import.meta.url),
  "utf8",
);
const aiAgentConfigSource = readFileSync(
  new URL("../src/lib/inbox/aiAgentConfig.ts", import.meta.url),
  "utf8",
);
const botAutoReplySource = readFileSync(
  new URL("../src/lib/inbox/botAutoReply.ts", import.meta.url),
  "utf8",
);
const aiBotsRouteSource = readFileSync(
  new URL("../src/routes/aiBots.ts", import.meta.url),
  "utf8",
);
const usersRouteSource = readFileSync(
  new URL("../src/routes/users.ts", import.meta.url),
  "utf8",
);
const legacyUserManagementPolicySource = readFileSync(
  new URL("../src/lib/legacyUserManagementPolicy.ts", import.meta.url),
  "utf8",
);
const agentsRouteSource = readFileSync(
  new URL("../src/routes/agents.ts", import.meta.url),
  "utf8",
);
const rolesRouteSource = readFileSync(
  new URL("../src/routes/roles.ts", import.meta.url),
  "utf8",
);
const branchesRouteSource = readFileSync(
  new URL("../src/routes/branches.ts", import.meta.url),
  "utf8",
);
const settingsRouteSource = readFileSync(
  new URL("../src/routes/settings.ts", import.meta.url),
  "utf8",
);
const authGuardSource = readFileSync(
  new URL("../src/lib/auth.ts", import.meta.url),
  "utf8",
);
const permissionsSource = readFileSync(
  new URL("../src/lib/permissions.ts", import.meta.url),
  "utf8",
);
const authMiddlewareSource = readFileSync(
  new URL("../src/middlewares/authMiddleware.ts", import.meta.url),
  "utf8",
);
const frontendAuthSource = readFileSync(
  new URL("../../edcons/src/hooks/use-auth.ts", import.meta.url),
  "utf8",
);
const dormBookingFollowupSource = readFileSync(
  new URL("../src/lib/inbox/dormBookingFollowupWorker.ts", import.meta.url),
  "utf8",
);
const publicObjectResolverSource = objectStorageSource.slice(
  objectStorageSource.indexOf("async searchPublicObject"),
  objectStorageSource.indexOf("// ── downloadObject"),
);
const emailVerificationSource = readFileSync(
  new URL("../src/lib/emailVerificationToken.ts", import.meta.url),
  "utf8",
);
const mainAgencySignatureSource = readFileSync(
  new URL("../src/lib/mainAgencySignature.ts", import.meta.url),
  "utf8",
);

test("authenticated course-finder writes are not exempt from CSRF", () => {
  assert.doesNotMatch(
    appSource,
    /startsWith\(["']\/api\/course-finder["']\)/,
  );
  assert.match(appSource, /const CSRF_SAFE_METHODS/);
  assert.match(appSource, /cookieToken !== headerToken/);
});

test("the SPA fallback does not issue a second conflicting CSRF cookie", () => {
  assert.match(appSource, /csrfCookieIssued/);
  assert.match(indexSource, /cookies\?\.csrf_token/);
  assert.match(indexSource, /csrfCookieIssued\?: boolean/);
});

test("browser permissions keep sensitive sensors blocked", () => {
  // Scan and voice-note are intentional first-party features. They may use
  // same-origin camera/microphone only; geolocation stays unavailable.
  assert.match(appSource, /camera=\(self\)/);
  assert.match(appSource, /geolocation=\(\)/);
  assert.match(appSource, /microphone=\(self\)/);
});

test("database retries never classify a WITH statement as read-only", () => {
  const dbSource = readFileSync(
    new URL("../../../lib/db/src/index.ts", import.meta.url),
    "utf8",
  );
  assert.doesNotMatch(dbSource, /\(select\|with\|/i);
  assert.match(dbSource, /\(select\|show\|explain\|values\|table\|fetch\)/i);
});

test("generated widget JavaScript is parsed without dynamic Function compilation", () => {
  const embedSource = readFileSync(
    new URL("../src/routes/embed.ts", import.meta.url),
    "utf8",
  );
  assert.match(embedSource, /parseJavaScript/);
  assert.doesNotMatch(embedSource, /new Function\(/);
});

test("portal diagnostics do not log raw applicant fields or permit production capture", () => {
  const topkapiSource = readFileSync(
    new URL("../../../lib/portal-adapters/src/universities/topkapi/adapter.ts", import.meta.url),
    "utf8",
  );
  const altinbasSource = readFileSync(
    new URL("../../../lib/portal-adapters/src/universities/altinbas/adapter.ts", import.meta.url),
    "utf8",
  );
  assert.doesNotMatch(topkapiSource, /field values — email/);
  assert.doesNotMatch(topkapiSource, /request body:/);
  assert.match(altinbasSource, /process\.env\.NODE_ENV !== "production"/);
  assert.match(altinbasSource, /LOCAL_REDACTED_CAPTURE_ONLY/);
  assert.match(altinbasSource, /safeBody = redactAltinbasLog/);
  assert.match(altinbasSource, /bodySha256/);
  assert.doesNotMatch(altinbasSource, /url: safeUrl, body: safeBody/);
  assert.match(altinbasSource, /mode: 0o600/);
});

test("production frontend does not emit source maps into the public root", () => {
  const viteSource = readFileSync(
    new URL("../../edcons/vite.config.ts", import.meta.url),
    "utf8",
  );
  assert.match(viteSource, /sourcemap: !isProd/);
});

test("portal lifecycle planning can never authorize a portal mutation", () => {
  assert.match(lifecycleSource, /allowPortalMutation:\s*false/);
  assert.doesNotMatch(lifecycleSource, /allowPortalMutation:\s*true/);
});

test("credentialed CORS is fail-closed in production", () => {
  assert.match(appSource, /corsError\.status = 403/);
  const sameOrigin = "https://apply.findandstudy.com";
  assert.equal(
    isCredentialedCorsOriginAllowed(undefined, sameOrigin, [], "production"),
    true,
  );
  assert.equal(
    isCredentialedCorsOriginAllowed(sameOrigin, sameOrigin, [], "production"),
    true,
  );
  assert.equal(
    isCredentialedCorsOriginAllowed(
      "https://trusted.example",
      sameOrigin,
      ["https://trusted.example"],
      "production",
    ),
    true,
  );
  assert.equal(
    isCredentialedCorsOriginAllowed("https://evil.example", sameOrigin, [], "production"),
    false,
  );
  assert.equal(
    isCredentialedCorsOriginAllowed("http://localhost:25197", sameOrigin, [], "production"),
    false,
  );
  assert.equal(
    isCredentialedCorsOriginAllowed("http://localhost:25197", sameOrigin, [], "test"),
    true,
  );
});

test("generated form previews execute in sandboxed iframes", () => {
  for (const source of [staffSettingsSource, agentAccountSource]) {
    assert.doesNotMatch(source, /dangerouslySetInnerHTML=\{\{\s*__html:\s*formCode/);
    assert.match(source, /srcDoc=\{formCode\}/);
    assert.match(source, /sandbox=""/);
    assert.match(source, /referrerPolicy="no-referrer"/);
  }
});

test("permanent conversation deletion is admin-only and explicitly confirmed", () => {
  assert.match(inboxRouteSource, /\/inbox\/conversations\/bulk-archive/);
  assert.match(inboxRouteSource, /\/inbox\/conversations\/bulk-unarchive/);
  assert.match(inboxRouteSource, /\/inbox\/conversations\/bulk-delete/);
  assert.match(inboxRouteSource, /requireRole\("super_admin", "admin"\)/);
  assert.match(inboxRouteSource, /z\.literal\("DELETE_CONVERSATIONS"\)/);
  assert.match(inboxRouteSource, /delete_inbox_conversations/);
  assert.match(messagesUiSource, /button-bulk-delete/);
  assert.match(messagesUiSource, /button-internal-bulk-delete/);
  assert.match(messagesUiSource, /confirm: "DELETE_CONVERSATIONS"/);
  assert.match(messagesUiSource, /"delete-final"/);
});

test("E2E database mutations accept only explicit test database names", () => {
  assert.equal(
    isSafeE2eDatabaseUrl("postgresql://user:pass@localhost:5432/fasos_codex_e2e_20260730"),
    true,
  );
  assert.equal(
    isSafeE2eDatabaseUrl("postgresql://user:pass@localhost:5432/findandstudy_test"),
    true,
  );
  assert.equal(
    isSafeE2eDatabaseUrl("postgresql://user:pass@localhost:5432/findandstudy"),
    false,
  );
  assert.equal(
    isSafeE2eDatabaseUrl("postgresql://user:pass@localhost:5432/production"),
    false,
  );
  assert.equal(getDatabaseName("not-a-database-url"), null);
});

test("local uploads are owner-bound, fail closed, and bounded before buffering", () => {
  assert.match(storageRouteSource, /callerOwnsObject\(userId, relPath\)/);
  assert.match(storageRouteSource, /LOCAL_UPLOAD_ABSOLUTE_MAX_BYTES = 25 \* 1024 \* 1024/);
  assert.match(storageRouteSource, /receivedBytes \+= buffer\.length/);
  assert.match(storageRouteSource, /receivedBytes > LOCAL_UPLOAD_ABSOLUTE_MAX_BYTES/);
  assert.match(storageRouteSource, /const ownerRecorded = await recordObjectOwner/);
  assert.match(storageRouteSource, /if \(!ownerRecorded\)/);
  assert.doesNotMatch(storageRouteSource, /processUpload failed, storing original/);
  assert.match(objectAuthzSource, /recordObjectOwner[\s\S]*Promise<boolean>/);
  assert.match(objectAuthzSource, /failed to record object owner:[\s\S]*return false/);
});

test("local public-object lookup cannot fall through to the private namespace", () => {
  assert.match(
    publicObjectResolverSource,
    /resolveExistingLocalPath\(nodePath\.posix\.join\("public", filePath\)\)/,
  );
  assert.doesNotMatch(publicObjectResolverSource, /resolveExistingLocalPath\(filePath\)/);
  assert.match(objectStorageSource, /writeLocalObjectBuffer[\s\S]*mode: 0o700/);
  assert.match(objectStorageSource, /writeLocalObjectBuffer[\s\S]*mode: 0o600/);
  assert.match(storageRouteSource, /writeLocalObjectBuffer\(relPath, body, finalContentType\)/);
  assert.doesNotMatch(storageRouteSource, /fsPromises\.writeFile\(localPath/);
});

test("external AI delivery fails closed and activation requires Super Admin", () => {
  assert.match(aiAgentConfigSource, /externalAutoReplyEnabled: false/);
  assert.match(aiAgentConfigSource, /aiAgentPatchRequiresSuperAdmin/);
  assert.match(aiAgentConfigSource, /AI_EXTERNAL_AUTO_REPLY_KILL_SWITCH/);
  assert.match(botAutoReplySource, /isExternalAutoReplyEmergencyStopped/);
  assert.match(botAutoReplySource, /reason: "external_delivery_disabled"/);
  assert.match(botAutoReplySource, /getExternalAiDeliveryBlockReason/);
  assert.match(aiBotsRouteSource, /req\.user!\.role !== "super_admin"/);
  assert.match(aiBotsRouteSource, /externalAutoReplyEnabled: false/);
  assert.match(dormBookingFollowupSource, /!config\.externalAutoReplyEnabled/);
  assert.match(dormBookingFollowupSource, /isExternalAutoReplyEmergencyStopped/);
});

test("legacy impersonation is branch-scoped and nested sessions are denied", () => {
  assert.match(usersRouteSource, /evaluateLegacyUserImpersonation/);
  assert.match(usersRouteSource, /getVisibleBranchIds/);
  assert.match(usersRouteSource, /currentSession\.originalSid/);
  assert.match(usersRouteSource, /auth\.impersonate\.denied/);
  assert.match(agentsRouteSource, /currentSession\.originalSid/);
  assert.match(agentsRouteSource, /Cannot impersonate an inactive account/);
});

test("legacy generic user management is branch-scoped and privilege ordered", () => {
  assert.match(usersRouteSource, /inArray\(usersTable\.branchId, visibleBranchIds\)/);
  assert.match(usersRouteSource, /notInArray\(usersTable\.role/);
  assert.match(usersRouteSource, /evaluateLegacyUserManagement/);
  assert.match(usersRouteSource, /PERMISSION_OVERRIDE_REQUIRES_SUPER_ADMIN/);
  assert.match(usersRouteSource, /canLegacyActorAssignRole/);
  assert.match(legacyUserManagementPolicySource, /peer_or_higher_privilege/);
  assert.match(legacyUserManagementPolicySource, /agent_relationship_route_required/);
  assert.match(legacyUserManagementPolicySource, /Dynamic role permissions are mutable platform configuration/);
});

test("long-lived platform configuration writes require Super Admin and audit receipts", () => {
  assert.match(rolesRouteSource, /router\.post\("\/roles", requireAuth, requireRole\("super_admin"\)/);
  assert.match(rolesRouteSource, /router\.patch\("\/roles\/:id", requireAuth, requireRole\("super_admin"\)/);
  assert.match(rolesRouteSource, /router\.delete\("\/roles\/:id", requireAuth, requireRole\("super_admin"\)/);
  assert.doesNotMatch(rolesRouteSource, /seedDefaultRoles/);
  assert.match(settingsRouteSource, /router\.patch\("\/settings", requireAuth, requireRole\("super_admin"\)/);
  assert.match(settingsRouteSource, /platform_config\.settings\.update/);
  assert.match(settingsRouteSource, /"n8nWebhookUrl"/);
  const settingsRead = settingsRouteSource.slice(
    settingsRouteSource.indexOf('router.get("/settings"'),
    settingsRouteSource.indexOf('router.patch("/settings"'),
  );
  assert.doesNotMatch(settingsRead, /db\.insert\(settingsTable\)/);
  assert.match(branchesRouteSource, /platform_config\.branch\.create/);
  assert.match(branchesRouteSource, /platform_config\.branch\.update/);
  assert.match(branchesRouteSource, /platform_config\.branch\.archive/);
  assert.match(branchesRouteSource, /platform_config\.branch\.unarchive/);
});

test("permission-backed decisions use stored roles and only Super Admin bypasses them", () => {
  assert.match(authGuardSource, /getEffectivePermissionSet\(req\.user\)/);
  assert.doesNotMatch(authGuardSource, /new Set<string>\(\[\.\.\.fromDb, \.\.\.fromDefault\]\)/);
  assert.match(permissionsSource, /ALL_PERMISSION_ROLES = new Set\(\["super_admin"\]\)/);
  assert.match(authMiddlewareSource, /ADMINISH_ROLES = new Set\(\["super_admin"\]\)/);
  assert.match(frontendAuthSource, /if \(role === "super_admin"\) return true/);
  assert.doesNotMatch(frontendAuthSource, /role === "super_admin" \|\| role === "admin"/);
});

test("email verification links are random, hashed, expiring, and one-time", () => {
  assert.match(emailVerificationSource, /randomBytes\(32\)\.toString\("base64url"\)/);
  assert.match(emailVerificationSource, /createHash\("sha256"\)/);
  assert.match(emailVerificationSource, /EMAIL_VERIFICATION_LINK_TTL_MS = 24 \* 60 \* 60 \* 1000/);
  assert.match(emailVerificationSource, /eq\(emailVerificationCodesTable\.used, false\)/);
  assert.match(emailVerificationSource, /gt\(emailVerificationCodesTable\.expiresAt, new Date\(\)\)/);
  assert.match(emailVerificationSource, /\.set\(\{ used: true \}\)/);
});

test("the reusable main-agency signature is external to source and release artifacts", () => {
  assert.doesNotMatch(mainAgencySignatureSource, /data:image\/(?:png|jpeg);base64,/i);
  assert.match(mainAgencySignatureSource, /MAIN_AGENCY_SIGNATURE_FILE/);
  assert.match(mainAgencySignatureSource, /must be an absolute path/);
  assert.match(mainAgencySignatureSource, /must be outside the runtime release directory/);
  assert.match(mainAgencySignatureSource, /valid PNG or JPEG/);
});
