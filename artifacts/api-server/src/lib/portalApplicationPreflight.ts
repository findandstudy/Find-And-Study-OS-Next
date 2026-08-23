import {
  evaluatePortalPreflight,
  type PortalPreflightResult,
} from "@workspace/portal-adapters";
import { buildApplicationPreflightSnapshot } from "@workspace/portal-runner";
import { runEducationExtraction } from "./educationAutoExtract.js";
import { autoFillMissingAddressCity } from "./portalAddressAutoExtract.js";
import { autoFillMissingBirthCityFromDocuments } from "./portalBirthCityAutoExtract.js";
import {
  autoFillMissingProfileFromPassport,
  autoRepairInvalidProfileDatesFromPassport,
  autoSyncProfileIdentityFromPassport,
  verifyStudentIdentityAgainstPassport,
  type PortalPassportIdentitySyncResult,
} from "./portalProfileAutoExtract.js";
import { logAudit } from "./auth.js";

export interface PreparedPortalPreflight extends PortalPreflightResult {
  applicationId: number;
  studentId: number;
  autoFilledFields: string[];
  enrichmentWarnings: string[];
}

const ACADEMIC_FIELDS = new Set([
  "schoolName",
  "gpa",
  "graduationYear",
]);

export async function prepareApplicationPortalPreflight(opts: {
  applicationId: number;
  adapterKey: string;
  actorUserId: number | null;
  ip?: string;
  autoEnrich?: boolean;
}): Promise<PreparedPortalPreflight> {
  let snapshot = await buildApplicationPreflightSnapshot(
    opts.applicationId,
    { adapterKey: opts.adapterKey },
  );
  let result = evaluatePortalPreflight({
    adapterKey: opts.adapterKey,
    profile: snapshot.profile,
    documentTypes: snapshot.documentTypes,
  });
  const autoFilledFields: string[] = [];
  const enrichmentWarnings: string[] = [];
  let passportAutoFillAiUnavailable = false;
  let passportIdentityLockedFields = new Set<string>();
  let passportIdentitySyncStatus: PortalPassportIdentitySyncResult["status"] | null = null;

  if (opts.autoEnrich !== false && result.supported && !result.ready) {
    const identity = await autoFillMissingProfileFromPassport({
      studentId: snapshot.studentId,
      actorUserId: opts.actorUserId,
      ip: opts.ip,
      requiredFields: result.missingFields,
    });
    autoFilledFields.push(...identity.fields);
    passportAutoFillAiUnavailable = identity.status === "ai_unavailable";
    if (
      identity.status === "low_confidence" ||
      identity.status === "ai_unavailable"
    ) {
      enrichmentWarnings.push(`identity:${identity.status}`);
    }

    if (result.missingFields.includes("addressCity")) {
      const addressCity = await autoFillMissingAddressCity({
        studentId: snapshot.studentId,
        actorUserId: opts.actorUserId,
        ip: opts.ip,
        requiredFields: result.missingFields,
      });
      autoFilledFields.push(...addressCity.fields);
      if (
        addressCity.status === "low_confidence" ||
        addressCity.status === "unreadable" ||
        addressCity.status === "ai_unavailable"
      ) {
        enrichmentWarnings.push(`addressCity:${addressCity.status}`);
      }
    }

    if (result.missingFields.includes("cityOfBirth")) {
      const birthCity = await autoFillMissingBirthCityFromDocuments({
        studentId: snapshot.studentId,
        actorUserId: opts.actorUserId,
        ip: opts.ip,
        requiredFields: result.missingFields,
        allowAi: !passportAutoFillAiUnavailable,
      });
      autoFilledFields.push(...birthCity.fields);
      if (
        birthCity.status === "low_confidence" ||
        birthCity.status === "unreadable" ||
        birthCity.status === "ai_unavailable"
      ) {
        enrichmentWarnings.push(`cityOfBirth:${birthCity.status}`);
      }
    }

    if (result.missingFields.some((field) => ACADEMIC_FIELDS.has(field))) {
      const education = await runEducationExtraction({
        studentId: snapshot.studentId,
        actorUserId: opts.actorUserId,
        ip: opts.ip,
        skipIfFilled: false,
        mergeMissingOnly: true,
        auditAction: "portal_preflight_auto_fill_education",
      });
      if (education.status === "ok") {
        if (education.upserted > 0) {
          autoFilledFields.push("educationRecords");
        }
        enrichmentWarnings.push(...education.warnings);
      } else if (
        education.status === "ai_failed" ||
        education.status === "ai_unavailable"
      ) {
        enrichmentWarnings.push(`education:${education.status}`);
      }
    }

    if (autoFilledFields.length > 0) {
      snapshot = await buildApplicationPreflightSnapshot(
        opts.applicationId,
        { adapterKey: opts.adapterKey },
      );
      result = evaluatePortalPreflight({
        adapterKey: opts.adapterKey,
        profile: snapshot.profile,
        documentTypes: snapshot.documentTypes,
      });
    }
  }

  // Every university portal identity is passport-backed. Before creating or
  // reusing a portal student, synchronize the CRM name and passport number
  // from a complete high-confidence passport. A staff/admin correction made
  // after an earlier AI synchronization remains locked and authoritative.
  if (result.supported) {
    const identitySync = await autoSyncProfileIdentityFromPassport({
      studentId: snapshot.studentId,
      actorUserId: opts.actorUserId,
      ip: opts.ip,
    });
    passportIdentitySyncStatus = identitySync.status;
    passportIdentityLockedFields = new Set(identitySync.lockedFields);
    if (identitySync.status === "updated") {
      autoFilledFields.push(...identitySync.fields);
      snapshot = await buildApplicationPreflightSnapshot(
        opts.applicationId,
        { adapterKey: opts.adapterKey },
      );
      result = evaluatePortalPreflight({
        adapterKey: opts.adapterKey,
        profile: snapshot.profile,
        documentTypes: snapshot.documentTypes,
      });
    } else if (identitySync.status !== "already_matches") {
      enrichmentWarnings.push(`passportIdentitySync:${identitySync.status}`);
    }
  }

  const invalidPassportDates = result.incompatibleFields
    .map((issue) => issue.field)
    .filter((field) =>
      field === "dateOfBirth" ||
      field === "passportIssueDate" ||
      field === "passportExpiryDate");
  // Keep the first rollout scoped to SIT: this repair relies on SIT's
  // independently verified passport-identity contract.
  if (result.adapterKey === "sit" && invalidPassportDates.length > 0) {
    const repair = await autoRepairInvalidProfileDatesFromPassport({
      studentId: snapshot.studentId,
      actorUserId: opts.actorUserId,
      ip: opts.ip,
      invalidFields: invalidPassportDates,
    });
    if (repair.status === "updated") {
      autoFilledFields.push(...repair.fields);
      snapshot = await buildApplicationPreflightSnapshot(
        opts.applicationId,
        { adapterKey: opts.adapterKey },
      );
      result = evaluatePortalPreflight({
        adapterKey: opts.adapterKey,
        profile: snapshot.profile,
        documentTypes: snapshot.documentTypes,
      });
    } else if (
      repair.status === "identity_mismatch" ||
      repair.status === "low_confidence" ||
      repair.status === "unreadable" ||
      repair.status === "ai_unavailable"
    ) {
      enrichmentWarnings.push(`passportDateRepair:${repair.status}`);
    }
  }

  // Syntax-valid CRM text is not enough: every real portal submission must
  // have independent, high-confidence proof from the latest passport,
  // including profiles whose fields are already populated.
  if (result.supported) {
    // The synchronization step reads the same latest passport with the same
    // confidence contract. Reuse its fail-closed result instead of making an
    // immediate duplicate AI request when the provider is unavailable or the
    // document cannot produce proof. A later RUN starts a fresh preflight and
    // may retry normally.
    const reusableIdentityFailure =
      passportIdentitySyncStatus === "no_passport_document" ||
      passportIdentitySyncStatus === "low_confidence" ||
      passportIdentitySyncStatus === "unreadable" ||
      passportIdentitySyncStatus === "ai_unavailable"
        ? passportIdentitySyncStatus
        : null;
    const identityProof = reusableIdentityFailure
      ? { status: reusableIdentityFailure, fields: [] }
      : await verifyStudentIdentityAgainstPassport({
          studentId: snapshot.studentId,
          actorUserId: opts.actorUserId,
          ip: opts.ip,
        });
    const blockingIdentityFields = identityProof.status === "mismatch"
      ? identityProof.fields.filter(
          (field) => !passportIdentityLockedFields.has(field),
        )
      : identityProof.fields;
    const isFullyHumanOverriddenMismatch =
      identityProof.status === "mismatch" &&
      identityProof.fields.length > 0 &&
      blockingIdentityFields.length === 0;

    if (passportIdentitySyncStatus === "passport_conflict") {
      enrichmentWarnings.push("passportIdentity:passport_conflict");
      const incompatibleFields = [...result.incompatibleFields];
      if (!incompatibleFields.some((issue) => issue.field === "passportNumber")) {
        incompatibleFields.push({ field: "passportNumber", reason: "invalid" });
      }
      result = { ...result, ready: false, incompatibleFields };
    } else if (isFullyHumanOverriddenMismatch) {
      // A staff/admin correction recorded after the last AI passport sync is
      // intentionally authoritative. Keep the non-sensitive warning for audit
      // visibility, but do not let the read-only verifier undo that decision.
      enrichmentWarnings.push("passportIdentity:manual_override");
    } else if (identityProof.status === "ai_unavailable") {
      // The deterministic preflight above has already validated the CRM
      // identity fields and confirmed the required passport document exists.
      // A temporary provider outage must not turn otherwise valid, previously
      // working applications into an "invalid passport" failure across every
      // portal lane. Keep the outage visible in the audit trail, but let the
      // worker's independent identity validation remain the final fail-closed
      // guard for malformed values (including OCR quotes/apostrophes).
      enrichmentWarnings.push("passportIdentity:verification_unavailable");
    } else if (identityProof.status !== "verified") {
      enrichmentWarnings.push(`passportIdentity:${identityProof.status}`);
      const fields = blockingIdentityFields.length > 0
        ? blockingIdentityFields
        : ["passportIdentityProof"];
      const incompatibleFields = [...result.incompatibleFields];
      const existing = new Set(incompatibleFields.map((issue) => issue.field));
      for (const field of fields) {
        if (!existing.has(field)) {
          incompatibleFields.push({
            field,
            reason: "invalid",
          });
          existing.add(field);
        }
      }
      result = { ...result, ready: false, incompatibleFields };
    }
  }

  const prepared: PreparedPortalPreflight = {
    ...result,
    applicationId: opts.applicationId,
    studentId: snapshot.studentId,
    autoFilledFields: [...new Set(autoFilledFields)],
    enrichmentWarnings: [...new Set(enrichmentWarnings)],
  };

  await logAudit(
    opts.actorUserId,
    "portal_application_preflight",
    "application",
    opts.applicationId,
    {
      adapterKey: opts.adapterKey,
      ready: prepared.ready,
      supported: prepared.supported,
      missingFields: prepared.missingFields,
      incompatibleFields: prepared.incompatibleFields,
      missingDocuments: prepared.missingDocuments,
      autoFilledFields: prepared.autoFilledFields,
      enrichmentWarnings: prepared.enrichmentWarnings,
    },
    opts.ip,
  );
  return prepared;
}
