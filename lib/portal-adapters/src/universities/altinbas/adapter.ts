// ---------------------------------------------------------------------------
// Altınbaş University — Salesforce Screen Flow REPLAY adapter
//
// Portal: https://apply.altinbas.edu.tr/partner/s/
// Technology: Salesforce Experience Cloud (Screen Flow)
//
// SCOPE: Associate + Bachelor + Master + PhD.
// Unknown levels are rejected before any portal mutation.
//
// MİMARİ (Faz-4, canlı yakalanan kontrat 2026-07-10):
//   Wizard bir Salesforce Screen Flow. Her ekran geçişi
//   POST /partner/s/sfsites/aura → FlowRuntimeConnectController.navigateFlow:
//     { action: NEXT | CONTINUE_AFTER_COMMIT | FINISH,
//       serializedState: <~90KB ŞİFRELİ, server-chained — ASLA elle kurulmaz>,
//       fields: [ {field, value, isVisible}, ... ] }  // DÜZ METİN — biz yazarız
//
//   serializedState şifreli + zincirli olduğu için adaptör CANLI login'li
//   tarayıcıda çalışır: login → applicant → "Create New Application" flow'u
//   boot eder (serializedState applicant context'i kazanır), interceptor her
//   yanıttan EN GÜNCEL serializedState'i tutar, ekranlar Next'e TIKLAMADAN
//   page.evaluate(fetch) ile replay edilir. Kapalı-shadow DOM ve koordinat YOK.
//
//   Creation half: Term(NEXT) → Degree(NEXT) → Program(NEXT) →
//         CONTINUE_AFTER_COMMIT(×N, fields:[]).
//
//   Completion half: the real Lightning UI is driven from its exact current
//   SLDS stage (Personal → Educational → Questionnaire → Documents → Submit).
//   Required uploads and the final row transition are positively read back.
//
// Duplicate-passport guard (FIX-14): CheckDuplicateValidation "already exists"
// mesajı self-referans DEĞİLDİR — önceki başarısız run'ın Salesforce'ta taslak
// halinde bıraktığı Application__c kaydına karşı ateşlenir. Bu sinyal artık
// alreadyExists=true (worker retry etmez) olarak ele alınır.
// Gerçek yeni-öğrenci duplicate'i → Program adımında AlreadyApplicationError.
//
// Dry-run: target wizard may be opened for inspection, but no form fill,
// Next/Save/upload/Submit or Aura mutation is allowed. The separate canary
// flag permits only the explicitly approved Personal fill + one Next boundary.
// ---------------------------------------------------------------------------

import { createHash } from "node:crypto";
import { appendFileSync, chmodSync, rmSync } from "node:fs";
import { basename } from "node:path";

import { and, eq, isNull } from "drizzle-orm";
import { db, portalSubmissionsTable } from "@workspace/db";

import type {
  UniversityAdapter,
  AdapterSession,
  SubmitProfile,
  SubmitFiles,
  SubmitResult,
  LoginOpts,
  ProgramOption,
  PortalProgramOption,
} from "../../types.js";
import { launchPortal, logger } from "../../browser.js";
import { portalCreds } from "../../portalCreds.js";
import { fold, parseTrack } from "../../programMatch.js";
import {
  type FlowField,
  type FlowIds,
  type EduRecord,
  buildTermFields,
  buildDegreeFields,
  buildProgramFields,
  buildPersonalFields,
  buildEducationalFields,
  buildQuestionnaireFields,
  buildDocumentsFields,
  checkMissingEduRecord,
  classifyProfileLevel,
  formatDateDmy,
  mapCountry,
} from "./flow-fields.js";
import {
  altinbasBasicFieldLabel,
  altinbasUiDateEntryCandidates,
  altinbasApplicationCoreProgram,
  altinbasMutationCanaryGate,
  altinbasPhoneDigits,
  altinbasGpaTypeLabel,
  decideAltinbasSignedUpLookup,
  chooseAltinbasApplicantGridRow,
  chooseAltinbasLabeledCombobox,
  chooseAltinbasApplicationRow,
  decideAltinbasApplicationRow,
  decideAltinbasExistingApplication,
  decideAltinbasEducationAddCandidate,
  decideAltinbasUploadRefresh,
  classifyAltinbasHiddenFlowValidation,
  classifyAltinbasWizardTransition,
  explicitCityOfBirth,
  extractAltinbasFlowUploadedDocumentSlots,
  isAltinbasExistingUploadProved,
  isAltinbasLightningUploadProved,
  isAltinbasPostNextDuplicate,
  isAltinbasUiDateCommitted,
  missingAltinbasPersonalFields,
  normalizeAltinbasPassportNumber,
  parseAltinbasCanaryStage,
  redactAltinbasLog,
  resolveAltinbasLegacyEducation,
  resolveAltinbasResumeFieldAction,
  resolveAltinbasVisaResumeAction,
  resolveAltinbasWizardState,
  selectAltinbasRollbackIds,
  shouldUseAltinbasUiPath,
  type AltinbasDocumentSlot,
  type AltinbasEducationAddCandidate,
  type AltinbasWizardSnapshot,
  type AltinbasWizardState,
} from "./altinbasWizard.js";
import {
  isAltinbasKnownLiveBachelorProgram,
  selectAltinbasProgram,
} from "./altinbasProgram.js";
import {
  classifyAltinbasLoginFailure,
  type AltinbasLoginFailureKind,
} from "./altinbasLogin.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const ADAPTER_KEY   = "altinbas";
const PORTAL_URL    = "https://apply.altinbas.edu.tr/partner/s/";
const APP_FORM_URL  = PORTAL_URL + "application-form";

const SESSION_STATE = "/tmp/altinbas-portal-state.json";

/** Levels this adapter accepts. Everything else → skipped. */
const ACCEPTED_LEVELS = new Set([
  // Graduate
  "master", "phd", "doctorate", "doktora", "yüksek lisans", "yuksek lisans",
  // Undergraduate (portal opening imminent — adapter ready, IDs captured live)
  "bachelor", "lisans",
  // Sub-degree associate (portal opening imminent — adapter ready, IDs captured live)
  "associate", "önlisans", "onlisans", "ön lisans",
]);

// Salesforce LWC hydration is slow — never use networkidle on SF pages.
const SF_HYDRATION_MS = 8000;

// Process-scoped login circuit breaker. Invalid stored credentials get a
// longer pause than a transient CAPTCHA/rate-limit response. A credential
// change produces a new one-way fingerprint and bypasses the old cooldown
// immediately; neither the credential nor the fingerprint is logged.
const ALTINBAS_LOGIN_COOLDOWN_MS: Record<AltinbasLoginFailureKind, number> = {
  invalid_credentials: 60 * 60_000,
  captcha_or_rate_limit: 15 * 60_000,
  unknown: 10 * 60_000,
};
let altinbasLoginCooldownUntil = 0;
let altinbasLoginCooldownFingerprint = "";
let altinbasLoginCooldownKind: AltinbasLoginFailureKind | null = null;

// Capture is local-only, explicitly acknowledged, short-lived and redacted.
// Production can never enable it, even if stale environment flags remain.
const CAPTURE_MAX_MS = 60 * 60_000;
const captureExpiresAt = Date.parse(process.env.ALTINBAS_CAPTURE_EXPIRES_AT ?? "");
const captureDuration = captureExpiresAt - Date.now();
const CAPTURE =
  process.env.NODE_ENV !== "production" &&
  process.env.ALTINBAS_CAPTURE === "1" &&
  process.env.ALTINBAS_CAPTURE_ACK === "LOCAL_REDACTED_CAPTURE_ONLY" &&
  Number.isFinite(captureExpiresAt) &&
  captureDuration > 0 &&
  captureDuration <= CAPTURE_MAX_MS;
const CAPTURE_FILE = "/tmp/altinbas-capture.json";

if (CAPTURE) {
  const expiryTimer = setTimeout(() => {
    try { rmSync(CAPTURE_FILE, { force: true }); } catch { /* best effort */ }
  }, captureDuration);
  expiryTimer.unref?.();
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Normalise a level string for the guard check. */
function normLevel(level: string): string {
  return level.trim().toLowerCase();
}

/** True when this level is accepted by Altınbaş adapter. */
function isAcceptedLevel(level: string): boolean {
  return ACCEPTED_LEVELS.has(normLevel(level));
}

function altinbasCredentialFingerprint(user: string, password: string): string {
  return createHash("sha256").update(user).update("\0").update(password).digest("hex");
}

function altinbasLoginFailureMessage(kind: AltinbasLoginFailureKind): string {
  if (kind === "invalid_credentials") {
    return "[altinbas] login failed — stored portal credentials rejected by Altınbaş; update the portal credential";
  }
  if (kind === "captcha_or_rate_limit") {
    return "[altinbas] login failed — CAPTCHA or rate limit detected; automatic login is temporarily paused";
  }
  return "[altinbas] login failed — authenticated portal state could not be verified; automatic login is temporarily paused";
}

function activateAltinbasLoginCooldown(
  kind: AltinbasLoginFailureKind,
  credentialFingerprint: string,
): void {
  altinbasLoginCooldownKind = kind;
  altinbasLoginCooldownFingerprint = credentialFingerprint;
  altinbasLoginCooldownUntil = Date.now() + ALTINBAS_LOGIN_COOLDOWN_MS[kind];
}

function assertAltinbasLoginCooldown(credentialFingerprint: string): void {
  if (credentialFingerprint !== altinbasLoginCooldownFingerprint) {
    altinbasLoginCooldownUntil = 0;
    altinbasLoginCooldownFingerprint = credentialFingerprint;
    altinbasLoginCooldownKind = null;
    return;
  }
  if (Date.now() >= altinbasLoginCooldownUntil || !altinbasLoginCooldownKind) return;
  throw new Error(
    `${altinbasLoginFailureMessage(altinbasLoginCooldownKind)} (cooldown active)`,
  );
}

/**
 * Mark a terminal Altınbaş outcome only after the portal supplied a durable,
 * positively-read-back proof. The structured marker is consumed by adapter
 * auto-graduation; `submitted=true` on its own deliberately does not graduate
 * an experimental adapter.
 */
function markAltinbasVerifiedSuccess(
  result: SubmitResult,
  kind: "exact_application_row" | "external_reference" | "aura_finish",
): void {
  result.submitted = true;
  result.meta = {
    ...result.meta,
    successProof: {
      verified: true,
      kind,
      schemaVersion: 1,
    },
  };
}

/** Snapshot the current screen. Returns the /tmp path or null. */
async function captureScreen(
  page: any,
  tag: string,
): Promise<string | null> {
  try {
    const path = `/tmp/altinbas-capture-${tag}-${Date.now()}.png`;
    await page.screenshot({ path, fullPage: false });
    return path;
  } catch {
    return null;
  }
}

/** Click the Next / Continue button (yalnız Step-1 Basic Info'da kullanılır). */
async function clickNext(page: any): Promise<boolean> {
  const btn = page.getByRole("button", {
    name: /^\s*(next|continue|ileri|sonraki|devam)\s*$/i,
  }).first();
  if (await btn.count()) {
    await btn.click({ timeout: 30000 }).catch(() => {});
    return true;
  }
  return false;
}

/**
 * Salesforce Experience Cloud occasionally shows a "Sorry to interrupt" /
 * "CSS Error" dialog (static-resource hiccup). Dismiss it without ever
 * blocking the flow: prefer "Refresh" (reloads application-form?nocache=…),
 * else "Cancel and close". Always wrapped so callers can fire-and-forget.
 */
async function dismissSfError(page: any): Promise<void> {
  try {
    const dialog = page.getByRole("dialog").filter({
      hasText: /sorry to interrupt|css error/i,
    });
    if (!(await dialog.count().catch(() => 0))) return;

    logger.info("[altinbas] dismissSfError: Salesforce error dialog detected");
    const refreshBtn = dialog.getByRole("button", { name: /refresh/i }).first();
    if (await refreshBtn.count().catch(() => 0)) {
      await refreshBtn.click({ timeout: 5000 }).catch(() => {});
      await page.waitForTimeout(3000);
      return;
    }

    const closeBtn = dialog
      .getByRole("button", { name: /cancel and close|close/i })
      .first();
    if (await closeBtn.count().catch(() => 0)) {
      await closeBtn.click({ timeout: 5000 }).catch(() => {});
      await page.waitForTimeout(1000);
    }
  } catch {
    /* never block the flow on this */
  }
}

/**
 * Fill a Salesforce Experience Cloud combobox/typeahead field by visible
 * label, then pick the best-matching option from the resulting listbox.
 * Used for Citizenship on the Basic Info step.
 */
async function pickCombobox(
  page: any,
  labelPattern: RegExp,
  searchTerm: string,
): Promise<boolean> {
  if (!searchTerm) return false;
  try {
    const box = await uniqueLabeledCombobox(page, labelPattern);
    if (!box) {
      logger.warn(`[altinbas] pickCombobox: no input found for ${labelPattern}`);
      return false;
    }

    await box.click({ timeout: 8000 }).catch(() => {});
    await box.fill("").catch(() => {});
    await box.fill(searchTerm).catch(() => {});
    await page.waitForTimeout(1500);

    const optSel = "[role=option], lightning-base-combobox-item, .slds-listbox__option, li[role=option]";
    await page.waitForSelector(optSel, { timeout: 8000 }).catch(() => {});
    const opts = page.locator(optSel);
    const optCount = await opts.count().catch(() => 0);
    if (!optCount) {
      logger.warn(`[altinbas] pickCombobox: no options appeared for "${searchTerm}"`);
      return false;
    }

    const searchFold = fold(searchTerm);
    for (let i = 0; i < optCount; i++) {
      const txt = ((await opts.nth(i).innerText().catch(() => "")) || "").trim();
      const optFold = fold(txt);
      if (optFold === searchFold) {
        await opts.nth(i).click({ timeout: 5000 }).catch(() => {});
        await page.waitForTimeout(500);
        const proof = await box.evaluate((element: Element) => {
          const input = element as HTMLInputElement;
          return {
            value: (input.value || "").trim(),
            ariaInvalid: input.getAttribute("aria-invalid") === "true",
            valid: input.validity ? input.validity.valid : true,
          };
        }).catch(() => null);
        if (
          proof &&
          fold(proof.value) === searchFold &&
          proof.valid &&
          !proof.ariaInvalid
        ) {
          logger.info("[altinbas] pickCombobox: exact option selected");
          return true;
        }
        logger.warn("[altinbas] pickCombobox: option click readback mismatch");
        return false;
      }
    }

    logger.warn(`[altinbas] pickCombobox: no matching option for "${searchTerm}" (options seen: ${optCount})`);
    return false;
  } catch (e) {
    logger.warn(`[altinbas] pickCombobox error for "${searchTerm}":`, e);
    return false;
  }
}

/**
 * Live Altınbaş LWC labels both the input and its owned listbox. Resolve the
 * single visible, writable input combobox and reject every ambiguous shape.
 */
async function uniqueLabeledCombobox(
  page: any,
  labelPattern: RegExp,
  options: { allowReadOnly?: boolean } = {},
): Promise<any | null> {
  const candidates = page.getByLabel(labelPattern);
  const count = await candidates.count().catch(() => 0);
  if (!count) return null;
  const metadata = await Promise.all(
    Array.from({ length: count }, async (_, index) => {
      const candidate = candidates.nth(index);
      const attributes = await candidate.evaluate((element: Element) => {
        const control = element as HTMLInputElement;
        return {
          tagName: element.tagName,
          role: element.getAttribute("role") || "",
          disabled: Boolean(control.disabled),
          readOnly: Boolean(control.readOnly),
        };
      }).catch(() => ({
        tagName: "",
        role: "",
        disabled: true,
        readOnly: true,
      }));
      return {
        ...attributes,
        visible: await candidate.isVisible().catch(() => false),
      };
    }),
  );
  const index = chooseAltinbasLabeledCombobox(metadata, options);
  return index >= 0 ? candidates.nth(index) : null;
}

/**
 * SLDS faux radio: plain check()/click() silently no-ops. Force-check with
 * change dispatch + faux-label fallback. (Student-grid row selection.)
 */
async function forceCheckRadio(page: any, locator: any): Promise<boolean> {
  await locator.check({ force: true, timeout: 5000 }).catch(async () => {
    await locator.click({ force: true, timeout: 5000 }).catch(() => {});
  });
  await locator.dispatchEvent("change").catch(() => {});
  let checked = await locator.isChecked().catch(() => false);
  if (!checked) {
    const faux = locator.locator(
      "xpath=ancestor::*[self::td or self::div or self::label][1]//*[contains(@class,'slds-radio_faux') or contains(@class,'slds-radio__label')]",
    ).first();
    if (await faux.count().catch(() => 0)) {
      await faux.click({ force: true, timeout: 4000 }).catch(() => {});
      checked = await locator.isChecked().catch(() => false);
    }
  }
  return checked;
}

// ---------------------------------------------------------------------------
// FLOW REPLAY — interceptor + navigateFlow driver
// ---------------------------------------------------------------------------

interface FlowTemplate {
  origin: string;
  context: string;
  token: string;
  pageURI: string;
}

interface FlowRuntime {
  template: FlowTemplate | null;
  /** En güncel serializedState — HER yanıttan güncellenir, ASLA elle kurulmaz. */
  state: string | null;
  lastRaw: string;
  /** Yanıtlardan toplanan Id'li kayıtlar (Term/Degree/Program adayları), Id → record. */
  records: Map<string, Record<string, unknown>>;
  ids: FlowIds;
  reqCounter: number;
  /**
   * FIX-6: EXPLICIT "applicationId" ANAHTARIYLA görülen Id'ler (bu run'da
   * oluşturulan başvurular). a02 PREFIX fallback'i availability kayıtlarını
   * da yakaladığı için güvenilmez — self-duplicate ayrımı BU set üzerinden.
   */
  explicitAppIds: Set<string>;
  /**
   * FIX-8: dört binding anahtarının EXPLICIT anahtar adıyla görülen SON değeri.
   * rt.ids prefix-fallback'le kirlenebilir (ilk görülen 003/001/a02) — Educational
   * binding'lerinde explicit değer varsa o kazanır (deterministik kaynak seçimi).
   */
  explicitIds: FlowIds;
  /**
   * FIX-9: explicitIds'teki her değerin kaynağı — "flow" (FlowRuntimeConnect-
   * Controller yanıtı, güvenilir) | "aura" (flow-dışı trafik, seçim-sonrası
   * kabul edilir ama flow-explicit'i ASLA ezemez). Provenance loguna yansır.
   */
  explicitIdSource: Partial<Record<keyof FlowIds, "flow" | "aura">>;
  /**
   * FIX-9: TÜM ham gövdelerde (flow + flow-dışı aura) regex ile görülen a02
   * Id evreni — commit'te İLK KEZ beliren başvuru Id'sini JSON parse edilemese
   * de yakalamak için (2199 kanıtı: walk hiç çalışmadı, 4 Id de YOK kaldı).
   */
  seenA02: Set<string>;
  /**
   * FIX-9: ham taramadan görülen 003/001 (Contact/Account) — son çare
   * fallback. SADECE applicant seçiminden SONRA dolar (applicantSelected):
   * seçim öncesi trafik portal/oturum bağlamı taşır (yanlış Contact riski);
   * seçim SONRASI ilk trafik = applicant-detay yüklemesi = seçilen öğrenci.
   */
  scanIds: FlowIds;
  /** FIX-9: applicant grid'inde öğrenci seçildi mi — scanIds doldurma kapısı. */
  applicantSelected: boolean;
  /**
   * FIX-12: commit ÖNCESİ görülen a02 Id'leri (program availability kayıtları).
   * Educational guard'ında fallback adayı filtrelemek için kullanılır — bu
   * set'te olan bir a02 availability kaydıdır, application DEĞİLDİR.
   */
  knownAvailabilityIds: Set<string>;
  /**
   * Required document slots proved by the authoritative recordsCV payload of
   * Altınbaş's live eduhubMultipleFileUpload Flow component.
   */
  uploadedDocumentSlots: Set<AltinbasDocumentSlot>;
  /**
   * Monotonic Flow-response sequence plus the sequence of the most recent
   * server-side duplicate-passport validation. UI Next compares these values
   * so a stale response from an earlier screen can never classify the current
   * transition.
   */
  flowResponseVersion: number;
  duplicatePassportVersion: number;
}

function newFlowRuntime(): FlowRuntime {
  return {
    template: null,
    state: null,
    lastRaw: "",
    records: new Map(),
    ids: {},
    reqCounter: 100,
    explicitAppIds: new Set(),
    explicitIds: {},
    explicitIdSource: {},
    seenA02: new Set(),
    scanIds: {},
    applicantSelected: false,
    knownAvailabilityIds: new Set(),
    uploadedDocumentSlots: new Set(),
    flowResponseVersion: 0,
    duplicatePassportVersion: 0,
  };
}

/**
 * FIX-9: ham gövdeden Id topla — JSON parse edilemese de çalışır (escaped
 * varyantlar dahil). walk'a bağımlılığı kaldırır: 2199 run'ında yanıtlar parse
 * edilemeyince 4 Educational Id'si de boş gitmişti.
 *  - Explicit anahtarlar (applicantId/applicationId/accountId/contactId +
 *    Salesforce büyük-harf AccountId/ContactId) → rt.explicitIds/rt.ids.
 *    applicationId explicit'i SADECE flow-controller yanıtlarından (source=
 *    "flow") toplanır — flow-dışı trafik (applicant-detay'daki ESKİ taslaklar)
 *    explicitAppIds/provenAppId'yi kirletemez.
 *  - a02 evreni → rt.seenA02 (commit baseline kaynağı; her kaynaktan).
 *  - 003/001 → rt.scanIds (son çare fallback) — YALNIZ applicant seçiminden
 *    sonra (rt.applicantSelected), seçim-sonrası ilk görülen kazanır
 *    (= applicant-detay yüklemesi = seçilen öğrenci).
 */
/**
 * FIX-10: makul Salesforce record Id kontrolü. 2199 kanıtı: gevşek regex
 * (`a02[a-zA-Z0-9]{12,15}`) ham gövdedeki bir token PARÇASINI yakaladı
 * (a02Q3107ut6nun1 — "00000" padding'i yok) ve Educational'a bağlanıp
 * validation'ı düşürdü. Gerçek Id'ler 15 veya 18 karakter ve reserved
 * sıfır-padding içerir (a02Q300000ODWYwIAP, 003Q300000ao3HJIAY, ...).
 */
function isSfIdShape(id: string): boolean {
  return id.length === 15 || id.length === 18;
}

/**
 * FIX-10 (review sertleştirmesi): "0000" reserved padding Salesforce garantisi
 * DEĞİL — sert red yerine YUMUŞAK sıralama sinyali. Padding'li adaylar önce
 * gelir; padding'siz aday yalnız başka seçenek yoksa (WARN ile) kullanılır.
 */
function hasSfPadding(id: string): boolean {
  return /0{4}/.test(id);
}

function scanIdsFromRaw(rt: FlowRuntime, raw: string, source: "flow" | "aura"): void {
  // FIX-10: değer uzunluğu TAM 15 veya 18 (16-17 char junk explicit bile olsa red).
  const keyRe =
    /\\?"(applicantId|applicationId|accountId|contactId|AccountId|ContactId|Application__c)\\?"\s*:\s*\\?"([a-zA-Z0-9]{15}(?:[a-zA-Z0-9]{3})?)\\?"/g;
  let m: RegExpExecArray | null;
  while ((m = keyRe.exec(raw)) !== null) {
    // FIX-11: Application__c is a Salesforce lookup field in commit responses
    // carrying the real application record Id (a02). It never appears in
    // availability payloads, so adding it to explicitAppIds is safe. Only
    // accept from flow-controller responses (source="flow").
    if (m[1] === "Application__c") {
      if (source !== "flow") continue;
      const id = m[2];
      if (!hasSfPadding(id)) {
        logger.warn(`[altinbas] Application__c=${id} 0000-padding'siz (şüpheli format) — yine de kabul`);
      }
      logger.info(`[altinbas] FIX-11: Application__c=${id} → explicitAppIds (from-Application__c)`);
      rt.explicitAppIds.add(id);
      continue;
    }
    const k = (m[1].charAt(0).toLowerCase() + m[1].slice(1)) as keyof FlowIds;
    if (source !== "flow") {
      // Flow-dışı trafikten: applicationId ASLA (eski taslak kirliliği);
      // diğerleri YALNIZ applicant seçiminden sonra (oturum/portal bağlamındaki
      // yanlış Contact/Account explicit'leri seçim öncesi kabul edilmez) ve
      // flow-explicit bir değeri ASLA ezemez.
      if (k === "applicationId") continue;
      if (!rt.applicantSelected) continue;
      if (rt.explicitIdSource[k] === "flow") continue;
    }
    // FIX-10: anahtar bağlamı güçlü kanıt — kabul, ama padding'siz format
    // şüpheli olduğundan görünür kılınır (sert red YOK, gerçek Id kaybetmeyelim).
    if (!hasSfPadding(m[2])) {
      logger.warn(`[altinbas] explicit ${k}=${m[2]} 0000-padding'siz (şüpheli format) — yine de kabul`);
    }
    rt.explicitIds[k] = m[2];
    rt.explicitIdSource[k] = source;
    rt.ids[k] = m[2];
    if (k === "applicationId") rt.explicitAppIds.add(m[2]);
  }
  // FIX-10: tam 15 veya 18 karakter (token parçası eleme). seenA02 BASELINE
  // olduğundan padding'siz a02'ler de eklenir (geniş baseline = daha güvenli
  // commit-diff, junk yanlışlıkla "run-created" sayılamaz). scanIds (son çare)
  // için padding tercih sinyali: padding'li aday padding'siz olanı yükseltir.
  const idRe = /\b(?:a02|003|001)[a-zA-Z0-9]{12}(?:[a-zA-Z0-9]{3})?\b/g;
  const setScan = (k: keyof FlowIds, id: string): void => {
    const cur = rt.scanIds[k];
    if (!cur) rt.scanIds[k] = id;
    else if (!hasSfPadding(cur) && hasSfPadding(id)) rt.scanIds[k] = id;
  };
  while ((m = idRe.exec(raw)) !== null) {
    const id = m[0];
    if (id.startsWith("a02")) {
      rt.seenA02.add(id);
    } else if (rt.applicantSelected) {
      if (id.startsWith("003")) {
        setScan("contactId", id);
        setScan("applicantId", id);
      } else {
        setScan("accountId", id);
      }
    }
  }
}

/** Explicit local capture: redacted, permission-restricted and time-bounded. */
function captureDump(kind: string, url: string, body: string): void {
  if (!CAPTURE) return;
  const safeUrl = redactAltinbasLog(url);
  const safeBody = redactAltinbasLog(body);
  try {
    appendFileSync(
      CAPTURE_FILE,
      JSON.stringify({
        ts: new Date().toISOString(),
        kind,
        url: safeUrl,
        bodyLength: body.length,
        bodySha256: createHash("sha256").update(body).digest("hex"),
      }) + "\n",
      { mode: 0o600 },
    );
    chmodSync(CAPTURE_FILE, 0o600);
  } catch {
    /* capture asla akışı kırmaz */
  }
  logger.info(
    `[altinbas][capture] ${kind} ${safeUrl.slice(0, 140)}` +
    ` :: ${safeBody.slice(0, 1200)}`,
  );
}

/**
 * Bir aura yanıtını sindir: en güncel serializedState, Id'li kayıtlar
 * (Term/Degree/Program adayları) ve applicant/application/account/contact
 * Id'leri çıkar.
 */
function ingestFlowResponse(rt: FlowRuntime, raw: string): void {
  if (!raw) return;
  rt.flowResponseVersion += 1;
  rt.lastRaw = raw;
  if (classifyAltinbasHiddenFlowValidation(raw) === "duplicate_passport") {
    rt.duplicatePassportVersion = rt.flowResponseVersion;
  }

  const states: string[] = [];

  const walk = (n: unknown): void => {
    if (Array.isArray(n)) {
      for (const x of n) walk(x);
      return;
    }
    if (n && typeof n === "object") {
      const o = n as Record<string, unknown>;
      // FIX-4: yanıtlar yeni state'i "serializedEncodedState" anahtarıyla döndürür
      // ("serializedState" REQUEST tarafının anahtarı). İkisini de kabul et —
      // aksi halde state 3048'lik boot-request state'inde takılı kalır ve flow
      // ikinci NEXT'te interviewStatus:"Error" verir (response-chaining şart).
      const enc = o["serializedEncodedState"];
      if (typeof enc === "string" && enc.length > 200) {
        states.push(enc);
      } else {
        const ss = o["serializedState"];
        if (typeof ss === "string" && ss.length > 200) states.push(ss);
      }

      const id = o["Id"];
      // FIX-10: records havuzu prefix-fallback'i beslediğinden şekil vetlenir
      // (tam 15 veya 18 — 16/17 char junk havuza giremez).
      if (typeof id === "string" && /^[a-zA-Z0-9]{15}(?:[a-zA-Z0-9]{3})?$/.test(id)) {
        rt.records.set(id, o);
      }

      for (const key of ["applicantId", "applicationId", "accountId", "contactId"] as const) {
        const v = o[key];
        // FIX-10: parse yolunda da tam 15/18 şekil şartı (padding sert red değil).
        if (typeof v === "string" && /^[a-zA-Z0-9]{15}(?:[a-zA-Z0-9]{3})?$/.test(v)) {
          rt.ids[key] = v;
          rt.explicitIds[key] = v; // FIX-8: explicit anahtar > prefix fallback
          rt.explicitIdSource[key] = "flow";
          if (key === "applicationId") rt.explicitAppIds.add(v); // FIX-6: bizim oluşturduğumuz
        }
      }
      // FIX-11: Application__c lookup field — Salesforce commit responses carry
      // the real application record Id here (a02). Walk confirms it via JSON
      // parse; regex path (scanIdsFromRaw) covers parse-failure fallback.
      const appCVal = o["Application__c"];
      if (typeof appCVal === "string" && /^[a-zA-Z0-9]{15}(?:[a-zA-Z0-9]{3})?$/.test(appCVal)) {
        logger.info(`[altinbas] FIX-11: Application__c=${appCVal} (walk) → explicitAppIds`);
        rt.explicitAppIds.add(appCVal);
        // Also promote to explicitIds.applicationId if not yet set by a stronger source.
        if (!rt.explicitIds.applicationId) {
          rt.explicitIds.applicationId = appCVal;
          rt.explicitIdSource.applicationId = "flow";
        }
        if (!rt.ids.applicationId) rt.ids.applicationId = appCVal;
      }

      for (const v of Object.values(o)) walk(v);
    }
  };

  // FIX-9: Id taraması walk'tan BAĞIMSIZ her gövdede çalışır (parse edilemese de).
  scanIdsFromRaw(rt, raw, "flow");

  const start = raw.indexOf("{");
  if (start >= 0) {
    try {
      const parsed = JSON.parse(raw.slice(start));
      walk(parsed);
      const documentProof =
        extractAltinbasFlowUploadedDocumentSlots(parsed);
      if (documentProof.componentFound) {
        // A malformed or ambiguous matching component clears this run-local
        // proof and therefore fails closed. Unrelated Flow responses do not
        // alter a valid Documents proof.
        rt.uploadedDocumentSlots = new Set(documentProof.slots);
        logger.info(
          `[altinbas][ui] Documents Flow state` +
          ` (proof=recordsCV, uploaded=${documentProof.slots.length},` +
          ` slots=${documentProof.slots.length ? documentProof.slots.join(",") : "none"})`,
        );
      }
    } catch {
      /* JSON parse edilemedi — regex fallback aşağıda */
    }
  }

  if (!states.length) {
    // Regex fallback: JSON parse edilemeyen / string içine gömülü (escaped)
    // gövdeden serialized(Encoded)State çek — `\"...\":\"...\"` varyantı dahil.
    const re = /\\?"serialized(?:Encoded)?State\\?"\s*:\s*\\?"((?:[^"\\]|\\.){200,}?)\\?"/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(raw)) !== null) {
      try {
        states.push(JSON.parse(`"${m[1]}"`) as string);
      } catch {
        states.push(m[1]);
      }
    }
  }

  // Id prefix'lerinden applicant/application çıkarımı (003=Contact, 001=Account, a02=Application__c).
  // FIX-10: padding'li Id'ler önce (yumuşak sıralama) — havuz zaten şekil-vetli.
  const recIds = [...rt.records.keys()];
  for (const pass of [recIds.filter(hasSfPadding), recIds]) {
    for (const id of pass) {
      if (id.startsWith("003") && !rt.ids.contactId) { rt.ids.contactId = id; rt.ids.applicantId = rt.ids.applicantId ?? id; }
      if (id.startsWith("001") && !rt.ids.accountId) rt.ids.accountId = id;
      if (id.startsWith("a02") && !rt.ids.applicationId) rt.ids.applicationId = id;
    }
  }

  if (states.length) {
    // Son (en güncel) state kazanır.
    rt.state = states[states.length - 1];
  }
}

/**
 * Interceptor: TÜM /sfsites/aura trafiğini dinle.
 *  - request: aura.context / aura.token / aura.pageURI template'ini yakala
 *    (SIT token-replay deseni — sonraki replay'lerde aynen kullanılır).
 *  - response: en güncel serializedState + kayıtlar + Id'ler.
 * "Create New Application" tıklanmadan ÖNCE kurulmalı ki flow-boot yanıtı
 * (ilk serializedState) kaçmasın.
 */
function setupFlowInterceptor(page: any, rt: FlowRuntime): void {
  page.on("request", (req: any) => {
    try {
      const url: string = req.url();
      if (!url.includes("/sfsites/aura")) return;
      const post: string = (req.postData() as string | null) || "";
      if (!post.includes("aura.token")) return;
      // Capture dump = TÜM aura trafiği (kontrat gereği); template/state ise
      // SADECE FlowRuntimeConnectController trafiğinden — arka plan Aura
      // çağrıları zincirlenmiş state'i/template'i bozamasın.
      captureDump("browser-request", url, post);
      if (!post.includes("FlowRuntimeConnectController") && !url.includes("FlowRuntimeConnect")) return;
      const p = new URLSearchParams(post);
      const context = p.get("aura.context") || "";
      const token = p.get("aura.token") || "";
      const pageURI = p.get("aura.pageURI") || "/partner/s/application-form";
      if (context && token) {
        rt.template = { origin: new URL(url).origin, context, token, pageURI };
      }
      // FIX-1: initial serializedState navigateFlow REQUEST gövdesinde gelir
      // (message=<urlenc JSON> → actions[0].params.request.serializedState).
      // Yanıt-state'i her zaman daha günceldir; request-state SADECE seed olarak
      // (rt.state boşken) kullanılır.
      if (!rt.state) {
        const msgStr = p.get("message") || "";
        if (msgStr.includes("serializedState")) {
          try {
            const msg = JSON.parse(msgStr) as {
              actions?: Array<{ params?: { request?: { serializedState?: unknown } } }>;
            };
            for (const a of msg.actions ?? []) {
              const ss = a?.params?.request?.serializedState;
              if (typeof ss === "string" && ss.length > 200) {
                rt.state = ss;
                logger.info(
                  `[altinbas] flow boot yakalandı (REQUEST gövdesinden) serializedState len=${ss.length}`,
                );
                break;
              }
            }
          } catch {
            /* message parse edilemedi — yanıt tarafı yakalayabilir */
          }
        }
      }
    } catch {
      /* interceptor asla akışı kırmaz */
    }
  });

  page.on("response", (res: any) => {
    void (async () => {
      try {
        const url: string = res.url();
        if (!url.includes("/sfsites/aura")) return;
        const reqPost: string = (res.request()?.postData?.() as string | null) || "";
        const raw: string = await res.text().catch(() => "");
        if (!raw) return;
        captureDump("browser-response", url, raw);
        // Yalnız flow-controller yanıtları state'e sindirilir.
        if (!reqPost.includes("FlowRuntimeConnectController") && !url.includes("FlowRuntimeConnect")) {
          // FIX-9: flow-dışı aura yanıtlarından SADECE Id taranır (state'e
          // ASLA dokunulmaz — zincir bozulmaz). Applicant-detay sayfası
          // Contact(003)/Account(001) Id'lerini burada taşır.
          scanIdsFromRaw(rt, raw, "aura");
          return;
        }
        ingestFlowResponse(rt, raw);
      } catch {
        /* interceptor asla akışı kırmaz */
      }
    })();
  });
}

/** Yanıttaki (son) currentStage değerini oku — ekran doğrulama/log için. */
function readStageFromRaw(raw: string): string | null {
  let stage: string | null = null;
  const re = /"currentStage"\s*:\s*"([^"]+)"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(raw)) !== null) stage = m[1];
  return stage;
}

/**
 * Gövde gerçekten bir aura action yanıtı mı? (HTML login sayfası, edge 403
 * HTML'i vb. değil.) JSON parse + actions[] varlığı aranır.
 */
function isAuraResponse(raw: string): boolean {
  const start = raw.indexOf("{");
  if (start < 0) return false;
  try {
    const o = JSON.parse(raw.slice(start)) as Record<string, unknown>;
    return Array.isArray(o["actions"]) || typeof o["events"] === "object";
  } catch {
    return false;
  }
}

/** Aura/flow hata sinyali (state:ERROR, exceptionEvent, errors[]). */
function flowHasError(raw: string): boolean {
  return /"state"\s*:\s*"ERROR"|"exceptionEvent"\s*:\s*true|"errors"\s*:\s*\[\s*\{|\\?"interviewStatus\\?"\s*:\s*\\?"Error\\?"/.test(raw);
}

/** Aura action state:SUCCESS içeriyor mu? (FINISH başarı kanıtının parçası.) */
function auraActionSucceeded(raw: string): boolean {
  return /"state"\s*:\s*"SUCCESS"/.test(raw);
}

/**
 * Ekran sırası rank'i: Term=0 → Degree=1 → Program=2 → Personal=3 →
 * Educational=4 → Questionnaire=5 → Documents=6. Okunamayan stage = -1
 * (bilinmiyor — adım atlama YAPILMAZ, baştan başlanır).
 */
function stageRank(stage: string | null): number {
  if (!stage) return -1;
  const s = stage.toLowerCase();
  if (/document|upload/.test(s)) return 6;
  if (/question/.test(s)) return 5;
  if (/educat/.test(s)) return 4;
  if (/personal/.test(s)) return 3;
  if (/program/.test(s)) return 2;
  if (/degree/.test(s)) return 1;
  if (/term/.test(s)) return 0;
  return -1;
}

/**
 * CheckDuplicateValidation passport mesajı — FIX-14: bu mesaj commit/Personal'da
 * önceki başarısız run'ın Salesforce'ta taslak halinde bıraktığı Application__c
 * kaydına karşı ateşlenir. Self-referans DEĞİLDİR (FIX-7 varsayımı yanlıştı —
 * canlı kanıt 71 başarısız denemede her seferinde bu sinyali üretti).
 * guard() içinde alreadyExists=true → temiz dönüş (worker sonsuz retry yapmaz).
 * Gerçek ilk-başvuru duplicate'i → Program adımında AlreadyApplicationError ile
 * kayıt OLUŞTURULMADAN ÖNCE yakalanır (isAlreadyAppliedProgram).
 */
function isDuplicatePassport(raw: string): boolean {
  return /an application with this passport number already exists|you cannot submit a new application using the same passport/i.test(raw);
}

/**
 * FIX-7: GERÇEK duplicate kontrolü = SADECE Program adımı.
 * Öğrenci bu programa daha önce başvurduysa Program NEXT yanıtında
 * AlreadyApplicationError.message DOLAR (oluşturmadan önce çalışan kontrol).
 * Escaped-JSON toleranslı: AlreadyApplicationError'ı izleyen ±300 karakter
 * içinde DOLU bir message alanı arar; null/"" eşleşmez.
 */
function isAlreadyAppliedProgram(raw: string): boolean {
  if (/already applied for this program/i.test(raw)) return true;
  const re = /AlreadyApplicationError[\s\S]{0,300}?\\?"message\\?"\s*:\s*\\?"((?:[^"\\]|\\.){4,}?)\\?"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(raw)) !== null) {
    if (m[1].trim().length > 0) return true;
  }
  return false;
}

/**
 * navigateFlow REPLAY: Next'e tıklamadan, canlı sayfa context'inde fetch ile
 * POST at. serializedState = SON yanıttan (rt.state); aura.context/token/
 * pageURI = yakalanan template'ten. Yanıt sindirilir (yeni state).
 */
async function postNavigateFlow(
  page: any,
  rt: FlowRuntime,
  action: "NEXT" | "CONTINUE_AFTER_COMMIT" | "FINISH",
  fields: FlowField[],
  tag: string,
): Promise<string> {
  if (!rt.template) throw new Error("[altinbas] flow template yok — hiç aura request yakalanmadı");
  if (!rt.state) throw new Error("[altinbas] serializedState yok — flow boot yanıtı yakalanamadı");
  // FIX-4 sanity: gerçek interview state ~onbinlerce karakter; çok küçük state
  // muhtemelen boot-REQUEST'in erken state'i (yanıt zinciri kopmuş demektir).
  if (rt.state.length < 5000) {
    logger.warn(
      `[altinbas] navigateFlow[${tag}] stateLen=${rt.state.length} ŞÜPHELİ KÜÇÜK (<5000) — yanıt zinciri (serializedEncodedState) yakalanamamış olabilir`,
    );
  }

  rt.reqCounter += 1;
  const message = JSON.stringify({
    actions: [
      {
        id: `${rt.reqCounter};a`,
        descriptor: "aura://FlowRuntimeConnectController/ACTION$navigateFlow",
        callingDescriptor: "UNKNOWN",
        params: { request: { action, serializedState: rt.state, fields } },
      },
    ],
  });

  const params = new URLSearchParams();
  params.set("message", message);
  params.set("aura.context", rt.template.context);
  params.set("aura.pageURI", rt.template.pageURI);
  params.set("aura.token", rt.template.token);

  // Canlı yakalanan gerçek endpoint formatı: ...aura?r=<n>&aura.FlowRuntimeConnect.navigateFlow=1
  const url = `${rt.template.origin}/partner/s/sfsites/aura?r=${rt.reqCounter}&aura.FlowRuntimeConnect.navigateFlow=1`;
  captureDump("replay-request", url, params.toString());

  const resp: { status: number; text: string } = await page.evaluate(
    async (a: { url: string; body: string }) => {
      const res = await fetch(a.url, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8" },
        body: a.body,
      });
      return { status: res.status, text: await res.text() };
    },
    { url, body: params.toString() },
  );

  const raw = resp.text;
  captureDump("replay-response", url, raw);

  if (resp.status < 200 || resp.status >= 300) {
    throw new Error(
      `[altinbas] navigateFlow[${tag}] HTTP ${resp.status}: ${redactAltinbasLog(raw).replace(/\s+/g, " ").slice(0, 300)}`,
    );
  }
  if (!isAuraResponse(raw)) {
    // HTML login sayfası / edge hatası vb. — aura yanıtı DEĞİL, state'e sindirme.
    throw new Error(
      `[altinbas] navigateFlow[${tag}] yanıt aura JSON değil (session düşmüş olabilir): ${redactAltinbasLog(raw).replace(/\s+/g, " ").slice(0, 300)}`,
    );
  }

  ingestFlowResponse(rt, raw);
  dumpRecords(rt, tag);

  const stage = readStageFromRaw(raw);
  logger.info(
    `[altinbas] navigateFlow[${tag}] action=${action} nf=${fields.length} → status=${resp.status} stage=${stage ?? "?"} err=${flowHasError(raw)} ${tag === "program" ? `alreadyApplied=${isAlreadyAppliedProgram(raw)}` : `dupPassport=${isDuplicatePassport(raw)}`} len=${raw.length} newStateLen=${rt.state.length}`,
  );
  return raw;
}

// ---------------------------------------------------------------------------
// Flow kayıtlarından Term / Degree / Program seçimi
// ---------------------------------------------------------------------------

/**
 * FIX-2 captured FALLBACK'ler: dinamik record parse boş kalırsa canlı yakalanmış
 * cycle ID'leri kullanılır (Fall 2026-2027 cycle'ı). Fallback kullanımı WARN loglanır.
 * PhD degree Id'si HENÜZ bilinmiyor — ilk PhD dry-run'ında ALTINBAS_CAPTURE=1 ile
 * yakalanıp eklenecek (TODO).
 */
const FALLBACK_TERM = { label: "Fall 2026 - 2027", id: "a0CQ30000AVvpaEMQR" };
/** ALTINBAS_CAPTURE=1 iken flow record havuzunu dök — option eşleme teşhisi. */
function dumpRecords(rt: FlowRuntime, tag: string): void {
  if (!CAPTURE) return;
  try {
    const entries = [...rt.records.entries()].map(([id, r]) => ({ id, r }));
    logger.info(
      `[altinbas][capture] records@${tag} n=${entries.length} :: ${JSON.stringify(entries).slice(0, 4000)}`,
    );
  } catch {
    /* diagnostic asla akışı kırmaz */
  }
}

/**
 * FIX-3: Term'de CAPTURED CONSTANT ÖNCELİKLİ (bu cycle stabil).
 * FIX-2'nin gevşek dinamik parse'ı YANLIŞ record tipini seçti: "2026-2027"
 * etiketli a02 (application/availability) kayıtlarını Term sandı → flow
 * interviewStatus:"Error" ile Term'i reddetti. Salesforce Id prefix haritası
 * (yakalanan): a0C=Term/Degree seçenekleri, a02=başvuru/availability,
 * a0A=Program Availability, a0B=Program.
 * Dinamik term parse artık yalnız fallback/teşhis amaçlı ve record-tipi
 * filtreli: Id a0C zorunlu + label pattern'i zorunlu.
 */

/** ALTINBAS_CAPTURE=1 iken aday record'un TAM şeklini dök (filtre teşhisi). */
function dumpCandidate(rt: FlowRuntime, id: string, what: string): void {
  if (!CAPTURE) return;
  try {
    const r = rt.records.get(id);
    logger.info(`[altinbas][capture] ${what} aday ${id} :: ${JSON.stringify(r).slice(0, 1500)}`);
  } catch {
    /* diagnostic asla akışı kırmaz */
  }
}

/**
 * Term seçimi: captured constant ÖNCE (FALLBACK_TERM). Dinamik parse yalnız
 * teşhis + constant'sız gelecekteki cycle'lar için: Id a0C ZORUNLU ve label
 * sezon kelimesi içermeli (year-only "2026-2027" a02 kayıtları Term DEĞİL).
 */
function pickTermOption(rt: FlowRuntime): { label: string; id: string } {
  const TERM_LABEL = /(fall|spring|summer|güz|bahar|yaz)[^,]*\d{4}\s*-\s*\d{4}/i;
  const cands: Array<{ label: string; id: string; year: number }> = [];
  for (const [id, r] of rt.records) {
    if (!id.startsWith("a0C")) continue;
    for (const v of Object.values(r)) {
      if (typeof v === "string" && TERM_LABEL.test(v)) {
        const years = v.match(/\d{4}/g) || [];
        cands.push({ label: v.trim(), id, year: Math.max(...years.map(Number), 0) });
        dumpCandidate(rt, id, "term");
        break;
      }
    }
  }
  if (cands.length) {
    cands.sort((a, b) => b.year - a.year);
    logger.info(
      `[altinbas] term dinamik adaylar (a0C+sezon filtreli): ${cands.map((c) => `${c.label}(${c.id})`).join(", ")}`,
    );
  }
  // Captured constant öncelikli — dinamik liste sadece constant yoksa devreye girer.
  if (FALLBACK_TERM.id) {
    logger.info(`[altinbas] Term captured constant kullanılıyor: "${FALLBACK_TERM.label}" (${FALLBACK_TERM.id})`);
    return FALLBACK_TERM;
  }
  return cands.length ? { label: cands[0].label, id: cands[0].id } : FALLBACK_TERM;
}

/**
 * Degree seçimi: dört desteklenen seviye için canlı yakalanmış sabit portal
 * Id'leri kullanılır. Sınıflandırılamayan seviye null dönerek fail-closed olur.
 */
const DEGREE_OPTIONS: Record<"associate" | "bachelor" | "master" | "phd", { label: string; id: string }> = {
  associate: { label: "Associate", id: "a0CQ30000AimBgbMQE" },
  bachelor: { label: "Bachelor", id: "a0CQ30000Aim5PsMQI" },
  master: { label: "Master", id: "a0CQ30000AVvqKTMQZ" },
  phd: { label: "PhD", id: "a0CQ30000AVvf4SMQR" },
};

function pickDegreeOption(rt: FlowRuntime, level: string): { label: string; id: string } | null {
  void rt;
  const cls = classifyProfileLevel(level);
  if (cls === "unknown") {
    logger.warn(
      `[altinbas] Degree seviyesi siniflandirilamadi (level="${level}") - DEGREE_OPTIONS eslesme yok`,
    );
    return null;
  }
  const opt = DEGREE_OPTIONS[cls];
  logger.info(`[altinbas] ${opt.label} degree sabit id kullaniliyor: "${opt.label}" (${opt.id})`);
  return opt;
}

/**
 * Program seçimi: canlı Program Availability (a0A) kayıtlarını, ortak güvenli
 * program matcher ile CRM adına eşler. Availability kaydındaki açık
 * `eduhub__Quota_Full__c=true` sonucu commit öncesinde durdurur. Bulunamazsa
 * aday listesi de döner (programMissing + availablePrograms).
 */
function pickProgramRecord(
  rt: FlowRuntime,
  profile: SubmitProfile,
): {
  record: Record<string, unknown> | null;
  selected: PortalProgramOption | null;
  candidates: PortalProgramOption[];
} {
  const selection = selectAltinbasProgram(
    [...rt.records.entries()],
    profile.programName || "",
  );
  if (!selection.option) {
    logger.warn(
      `[altinbas] program BULUNAMADI: "${profile.programName}" — adaylar: ${selection.candidates
        .map((candidate) => candidate.name)
        .slice(0, 30)
        .join("; ")}`,
    );
    return {
      record: null,
      selected: null,
      candidates: selection.candidates,
    };
  }

  logger.info(
    `[altinbas] program eşleşti: "${selection.option.name}"` +
      ` (Id=${selection.option.value}, confidence=${selection.confidence ?? "?"},` +
      ` quotaFull=${!selection.option.enabled})`,
  );
  return {
    record: selection.record,
    selected: selection.option,
    candidates: selection.candidates,
  };
}

// ---------------------------------------------------------------------------
// Flow replay sürücüsü — Term → Degree → Program → commit → Personal →
// Educational → Questionnaire → Documents → FINISH
// ---------------------------------------------------------------------------
// ===== BEGIN UI-DRIVEN COMPLETION (injected) =====
// ===========================================================================
// UI-DRIVEN COMPLETION (ALTINBAS_UI_COMPLETE=1)
// ---------------------------------------------------------------------------
// Replaces the fragile navigateFlow API-replay for the completion half
// (Personal → Educational → Questionnaire → Documents → Submit). Drives the
// real Salesforce Lightning wizard the same way a human agent does, and —
// critically — UPLOADS the four required documents via Playwright setInputFiles
// (the API-replay never uploaded documents: buildDocumentsFields() was empty).
//
// Self-contained: it finds the target application in "My Applications" itself
// (by program name, preferring a "Signed Up" row), so it is robust to whichever
// path triggered it (fresh create, commit-duplicate, or personal-duplicate).
// ===========================================================================

const UI_COMPLETE = process.env.ALTINBAS_UI_COMPLETE === "1";
const MUTATION_CANARY = process.env.ALTINBAS_MUTATION_CANARY === "1";
const DOCUMENTS_CAPTURE_PROBE =
  process.env.ALTINBAS_DOCUMENTS_CAPTURE_PROBE === "1";
const MUTATION_CANARY_STAGE = parseAltinbasCanaryStage(
  process.env.ALTINBAS_MUTATION_CANARY_STAGE,
);
const LEGACY_ADDRESS_CITY_FALLBACK = "Not Provided";
const LEGACY_ADDRESS_ZIP_FALLBACK = "00000";
const LEGACY_VISA_SUPPORT_DEFAULT_NO = true;
const MY_APPS_URL = PORTAL_URL + "my-applications";

interface UiFieldResult {
  ok: boolean;
  field: string;
  reason: string;
}

/**
 * Fill one live-discovered Salesforce field by its stable `name`, then prove
 * the value survived blur and native/LWC validity. Never falls back to a
 * different control and never treats an exception as success.
 */
async function fillNamedField(
  page: any,
  field: string,
  value: string,
): Promise<UiFieldResult> {
  const expected = value.trim();
  if (!expected) return { ok: false, field, reason: "data_missing" };
  const controls = page.locator(`[name="${field}"]:visible`);
  const count = await controls.count().catch(() => 0);
  if (count !== 1) {
    return { ok: false, field, reason: `control_count_${count}` };
  }
  const control = controls.first();
  try {
    const current = ((await control.inputValue()) || "").trim();
    if (current !== expected) {
      await control.click({ timeout: 6_000 });
      await control.fill(expected, { timeout: 6_000 });
      await control.press("Tab").catch(() => {});
      await page.waitForTimeout(150);
    }
    const proof = await control.evaluate((element: Element) => {
      const input = element as HTMLInputElement;
      return {
        value: (input.value || "").trim(),
        ariaInvalid: input.getAttribute("aria-invalid") === "true",
        valid: input.validity ? input.validity.valid : true,
      };
    });
    return {
      ok: proof.value === expected && !proof.ariaInvalid && proof.valid,
      field,
      reason:
        proof.value !== expected ? "readback_mismatch" :
        proof.ariaInvalid || !proof.valid ? "invalid" :
        "ok",
    };
  } catch (error) {
    return {
      ok: false,
      field,
      reason: error instanceof Error ? error.name : "fill_error",
    };
  }
}

/**
 * The API Flow and the Lightning wizard have different date contracts.  The
 * replay payload deliberately uses `d MMM yyyy`, but the live Lightning input
 * only accepts a numeric locale date (or ISO for a native date input).  Do not
 * feed the replay representation into this control: Salesforce clears it and
 * only reports the problem after Next is pressed.
 */
async function readAltinbasUiDateProof(
  page: any,
  field: string,
  expectedIso: string,
) {
  const currentControls = page.locator(`[name="${field}"]:visible`);
  if ((await currentControls.count().catch(() => 0)) !== 1) return null;
  return currentControls.first().evaluate(
    (element: Element, iso: string) => {
      const input = element as HTMLInputElement;
      let node: Element | null = element;
      let lightningInputValuePresent = false;
      let lightningInputMatchesExpected = false;
      let lightningInputValid = false;
      let datepickerMatchesExpected = false;
      let flowScreenValuePresent = false;
      for (let depth = 0; depth < 12 && node; depth++) {
        const candidateNode = node as Element & {
          value?: unknown;
          validity?: { valid?: boolean };
        };
        const tag = candidateNode.tagName.toLowerCase();
        const valuePresent =
          typeof candidateNode.value === "string" &&
          candidateNode.value.trim().length > 0;
        if (tag === "lightning-input") {
          lightningInputValuePresent = valuePresent;
          lightningInputMatchesExpected = candidateNode.value === iso;
          lightningInputValid = candidateNode.validity?.valid === true;
        }
        if (tag === "lightning-datepicker") {
          datepickerMatchesExpected = candidateNode.value === iso;
        }
        if (tag === "flowruntime-flow-screen-input") {
          flowScreenValuePresent = valuePresent;
        }
        const root = node.getRootNode() as ShadowRoot | Document;
        node = node.parentElement || ("host" in root ? root.host : null);
      }
      return {
        ariaInvalid: input.getAttribute("aria-invalid") === "true",
        valid: input.validity ? input.validity.valid : true,
        nativeDateInput: (input.type || "").toLowerCase() === "date",
        nativeValueMatchesExpected: (input.value || "").trim() === iso,
        lightningInputValuePresent,
        lightningInputMatchesExpected,
        lightningInputValid,
        datepickerMatchesExpected,
        flowScreenValuePresent,
      };
    },
    expectedIso,
  ).catch(() => null);
}

/** Fill a UI date input and prove semantic (ISO) readback, not presentation. */
async function fillAltinbasUiDateField(
  page: any,
  field: string,
  iso: string | undefined,
): Promise<UiFieldResult> {
  const controls = page.locator(`[name="${field}"]:visible`);
  const count = await controls.count().catch(() => 0);
  if (count !== 1) return { ok: false, field, reason: `control_count_${count}` };
  const control = controls.first();
  try {
    if (iso) {
      const existingProof = await readAltinbasUiDateProof(page, field, iso);
      if (isAltinbasUiDateCommitted(existingProof)) {
        logger.info(
          `[altinbas][ui] date control reused exact saved value` +
          ` (field=${field})`,
        );
        return { ok: true, field, reason: "existing_portal_value_proved" };
      }
    }
    const metadata = await control.evaluate((element: Element) => {
      const input = element as HTMLInputElement;
      return { type: input.type || "", placeholder: input.placeholder || "" };
    });
    const candidates = altinbasUiDateEntryCandidates(iso, metadata);
    if (!candidates.length) return { ok: false, field, reason: "data_missing" };
    for (const candidate of candidates) {
      await control.click({ timeout: 6_000 });
      // LWC's datepicker is a controlled text input. A Playwright fill can
      // leave the native DOM value looking correct while the Flow component's
      // internal value remains empty. Use real keyboard events so the same
      // controller path as a human entry runs.
      await control.press("ControlOrMeta+A").catch(async () => {
        await control.press("Control+A").catch(() => {});
      });
      await control.press("Backspace").catch(() => {});
      await control.pressSequentially(candidate, { delay: 35, timeout: 6_000 });
      // This exact one-shot sequence is the live-proved Lightning contract.
      // Retyping after a failed commit leaves the controlled host stale.
      await control.press("Enter").catch(() => {});
      await control.dispatchEvent("change").catch(() => {});
      await control.dispatchEvent("blur").catch(() => {});
      await control.press("Tab").catch(() => {});
      await page.waitForTimeout(300);
      // Re-resolve after Tab because Lightning may replace the native input
      // while committing the controlled host value.
      const proof = iso
        ? await readAltinbasUiDateProof(page, field, iso)
        : null;
      if (isAltinbasUiDateCommitted(proof)) {
        logger.info(
          `[altinbas][ui] date control committed` +
          ` (field=${field}, type=${metadata.type || "text"},` +
          ` placeholder=${JSON.stringify(metadata.placeholder || "")})`,
        );
        return { ok: true, field, reason: "ok" };
      }
      logger.warn(
        `[altinbas][ui] date control proof failed` +
        ` (field=${field}, ariaInvalid=${proof?.ariaInvalid ?? "missing"},` +
        ` nativeValid=${proof?.valid ?? "missing"},` +
        ` nativeDate=${proof?.nativeDateInput ?? "missing"},` +
        ` nativeMatch=${proof?.nativeValueMatchesExpected ?? "missing"},` +
        ` lightningPresent=${proof?.lightningInputValuePresent ?? "missing"},` +
        ` lightningMatch=${proof?.lightningInputMatchesExpected ?? "missing"},` +
        ` lightningValid=${proof?.lightningInputValid ?? "missing"},` +
        ` datepickerMatch=${proof?.datepickerMatchesExpected ?? "missing"},` +
        ` flowPresent=${proof?.flowScreenValuePresent ?? "missing"})`,
      );
    }
    return { ok: false, field, reason: "date_readback_mismatch" };
  } catch (error) {
    return {
      ok: false,
      field,
      reason: error instanceof Error ? error.name : "date_fill_error",
    };
  }
}

/**
 * Resume-safe text/date fill. A real CRM value is written and read back. When
 * CRM is empty, an already-saved valid portal value is accepted in place and
 * never copied into logs/result_json. Blank or invalid controls fail closed.
 */
async function fillOrProveNamedField(
  page: any,
  field: string,
  crmValue: string | undefined,
  options: { legacyFallback?: string } = {},
): Promise<UiFieldResult> {
  const expected = crmValue?.trim() || "";
  if (expected) return fillNamedField(page, field, expected);

  const controls = page.locator(`[name="${field}"]:visible`);
  const count = await controls.count().catch(() => 0);
  if (count !== 1) {
    return { ok: false, field, reason: `control_count_${count}` };
  }
  try {
    const proof = await controls.first().evaluate((element: Element) => {
      const input = element as HTMLInputElement;
      return {
        value: (input.value || "").trim(),
        ariaInvalid: input.getAttribute("aria-invalid") === "true",
        valid: input.validity ? input.validity.valid : true,
      };
    });
    const action = resolveAltinbasResumeFieldAction({
      crmValue: expected,
      portalValue: proof.value,
      portalValid: proof.valid && !proof.ariaInvalid,
      legacyFallback: options.legacyFallback,
    });
    if (action === "write_legacy_fallback") {
      const fallbackResult = await fillNamedField(
        page,
        field,
        options.legacyFallback || "",
      );
      return {
        ...fallbackResult,
        reason: fallbackResult.ok
          ? "legacy_fallback_applied"
          : fallbackResult.reason,
      };
    }
    return {
      ok: action === "accept_existing_portal_value",
      field,
      reason:
        action === "accept_existing_portal_value"
          ? "existing_portal_value_proved"
          : "data_missing",
    };
  } catch (error) {
    return {
      ok: false,
      field,
      reason: error instanceof Error ? error.name : "readback_error",
    };
  }
}

async function selectNamedField(
  page: any,
  field: string,
  value: string,
): Promise<UiFieldResult> {
  const controls = page.locator(`select[name="${field}"]:visible`);
  const count = await controls.count().catch(() => 0);
  if (count !== 1) {
    return { ok: false, field, reason: `control_count_${count}` };
  }
  const control = controls.first();
  try {
    await control.selectOption({ label: value }).catch(async () => {
      await control.selectOption(value);
    });
    const proof = await control.evaluate((element: Element) => {
      const select = element as HTMLSelectElement;
      return {
        value: (select.value || "").trim(),
        text: (select.selectedOptions.item(0)?.textContent || "").trim(),
        ariaInvalid: select.getAttribute("aria-invalid") === "true",
        valid: select.validity ? select.validity.valid : true,
      };
    });
    const wanted = value.toLowerCase();
    const matched =
      proof.value.toLowerCase() === wanted ||
      proof.text.toLowerCase() === wanted;
    return {
      ok: matched && !proof.ariaInvalid && proof.valid,
      field,
      reason: matched ? (proof.valid && !proof.ariaInvalid ? "ok" : "invalid") : "readback_mismatch",
    };
  } catch (error) {
    return {
      ok: false,
      field,
      reason: error instanceof Error ? error.name : "select_error",
    };
  }
}

async function uniqueVisibleEditableControl(
  locator: any,
  expectedTags: string[],
): Promise<{
  control: any | null;
  total: number;
  eligible: number;
}> {
  const total = await locator.count().catch(() => 0);
  const eligibleIndexes: number[] = [];
  for (let index = 0; index < total; index++) {
    const candidate = locator.nth(index);
    const [visible, enabled, editable, tag] = await Promise.all([
      candidate.isVisible().catch(() => false),
      candidate.isEnabled().catch(() => false),
      candidate.isEditable().catch(() => false),
      candidate
        .evaluate((element: Element) => element.tagName.toLowerCase())
        .catch(() => ""),
    ]);
    if (
      visible &&
      enabled &&
      editable &&
      expectedTags.includes(String(tag).toLowerCase())
    ) {
      eligibleIndexes.push(index);
    }
  }
  return {
    control:
      eligibleIndexes.length === 1
        ? locator.nth(eligibleIndexes[0])
        : null,
    total,
    eligible: eligibleIndexes.length,
  };
}

/**
 * Salesforce's custom education modal does not consistently wire visible
 * labels through `for`/`aria-labelledby`, so getByLabel can return zero even
 * though one editable field is present. Resolve only inside the active modal,
 * using exact field-contract aliases from the control and its nearest labels.
 */
async function uniqueEducationModalControl(
  page: any,
  selector: string,
  targetRe: RegExp,
  excludeRe: RegExp,
  expectedTags: string[],
): Promise<{
  control: any | null;
  total: number;
  eligible: number;
}> {
  const locator = page.locator(selector);
  const total = await locator.count().catch(() => 0);
  const eligibleIndexes: number[] = [];
  for (let index = 0; index < total; index++) {
    const candidate = locator.nth(index);
    const [visible, enabled, editable, metadata] = await Promise.all([
      candidate.isVisible().catch(() => false),
      candidate.isEnabled().catch(() => false),
      candidate.isEditable().catch(() => false),
      candidate.evaluate(
        (
          element: Element,
          patterns: { target: string; exclude: string },
        ) => {
          const parts: string[] = [];
          let insideDialog = false;
          let node: Element | null = element;
          for (let depth = 0; depth < 20 && node; depth++) {
            if (
              node.matches(
                "[role='dialog'],[aria-modal='true'],.slds-modal,.modal-container",
              )
            ) {
              insideDialog = true;
            }
            for (const attribute of [
              "name",
              "id",
              "aria-label",
              "aria-labelledby",
              "placeholder",
              "data-field",
              "data-field-name",
              "data-name",
              "data-id",
            ]) {
              const value = node.getAttribute(attribute);
              if (value) parts.push(value);
            }
            if (depth < 4) {
              const labels = node.querySelectorAll(
                ":scope > label,:scope > .slds-form-element__label," +
                ":scope > [part='label']",
              );
              for (const label of labels) {
                const text = (label.textContent || "").trim();
                if (text) parts.push(text);
              }
            }
            const labelledBy = node.getAttribute("aria-labelledby");
            if (labelledBy) {
              const root = node.getRootNode() as Document | ShadowRoot;
              for (const id of labelledBy.split(/\s+/)) {
                const label =
                  "getElementById" in root ? root.getElementById(id) : null;
                const text = (label?.textContent || "").trim();
                if (text) parts.push(text);
              }
            }
            const root = node.getRootNode() as Document | ShadowRoot;
            node = node.parentElement || ("host" in root ? root.host : null);
          }
          const descriptor = parts.join(" ").replace(/\s+/g, " ").toLowerCase();
          return {
            tag: element.tagName.toLowerCase(),
            type: (element.getAttribute("type") || "").toLowerCase(),
            insideDialog,
            target: new RegExp(patterns.target, "i").test(descriptor),
            excluded: new RegExp(patterns.exclude, "i").test(descriptor),
          };
        },
        { target: targetRe.source, exclude: excludeRe.source },
      ).catch(() => ({
        tag: "",
        type: "",
        insideDialog: false,
        target: false,
        excluded: true,
      })),
    ]);
    if (
      visible &&
      enabled &&
      editable &&
      metadata.insideDialog &&
      metadata.target &&
      !metadata.excluded &&
      metadata.type !== "hidden" &&
      expectedTags.includes(metadata.tag)
    ) {
      eligibleIndexes.push(index);
    }
  }
  return {
    control:
      eligibleIndexes.length === 1
        ? locator.nth(eligibleIndexes[0])
        : null,
    total,
    eligible: eligibleIndexes.length,
  };
}

async function educationModalControlContract(page: any) {
  const controls = page.locator(
    "input:visible,textarea:visible,select:visible,[role='combobox']:visible",
  );
  const count = Math.min(await controls.count().catch(() => 0), 20);
  const contract: Array<Record<string, unknown>> = [];
  for (let index = 0; index < count; index++) {
    const control = controls.nth(index);
    const [visible, enabled, editable, metadata] = await Promise.all([
      control.isVisible().catch(() => false),
      control.isEnabled().catch(() => false),
      control.isEditable().catch(() => false),
      control.evaluate((element: Element) => {
        const chain: Array<Record<string, string>> = [];
        let node: Element | null = element;
        for (let depth = 0; depth < 12 && node; depth++) {
          chain.push({
            tag: node.tagName.toLowerCase(),
            role: node.getAttribute("role") || "",
            name: node.getAttribute("name") || "",
            ariaLabel: node.getAttribute("aria-label") || "",
            ariaLabelledby: node.getAttribute("aria-labelledby") || "",
            className: (node.getAttribute("class") || "").slice(0, 120),
          });
          const root = node.getRootNode() as ShadowRoot | Document;
          node = node.parentElement || ("host" in root ? root.host : null);
        }
        const input = element as HTMLInputElement;
        return {
          tag: element.tagName.toLowerCase(),
          type: (element.getAttribute("type") || "").toLowerCase(),
          name: element.getAttribute("name") || "",
          role: element.getAttribute("role") || "",
          ariaLabel: element.getAttribute("aria-label") || "",
          ariaLabelledby: element.getAttribute("aria-labelledby") || "",
          readOnly: Boolean(input.readOnly),
          disabled: Boolean(input.disabled),
          chain,
        };
      }).catch(() => null),
    ]);
    contract.push({ index, visible, enabled, editable, metadata });
  }
  return contract;
}

/** Select an exact native option and prove selected text/value after change. */
async function selectNative(
  page: any,
  labelRe: RegExp,
  value: string,
  descriptorRe: RegExp,
  exactName: string,
): Promise<boolean> {
  if (!value) return false;
  try {
    let selected = await uniqueVisibleEditableControl(
      page.locator(`select[name="${exactName}" i]:visible`),
      ["select"],
    );
    if (!selected.control) {
      selected = await uniqueVisibleEditableControl(
        page.getByLabel(labelRe),
        ["select"],
      );
    }
    if (!selected.control) {
      selected = await uniqueEducationModalControl(
        page,
        "select:visible",
        descriptorRe,
        /search|filter|programme|program|term|application/i,
        ["select"],
      );
    }
    if (!selected.control) {
      logger.warn(
        `[altinbas][ui] native select tekil görünür değil` +
        ` (label=${labelRe.source}, total=${selected.total}, eligible=${selected.eligible})`,
      );
      return false;
    }
    const sel = selected.control;
    await sel.selectOption({ label: value }).catch(async () => {
      await sel.selectOption(value);
    });
    const proof = await sel.evaluate((element: Element) => {
      const select = element as HTMLSelectElement;
      return {
        value: (select.value || "").trim(),
        text: (select.selectedOptions.item(0)?.textContent || "").trim(),
        valid: select.validity ? select.validity.valid : true,
        ariaInvalid: select.getAttribute("aria-invalid") === "true",
      };
    });
    return (
      (fold(proof.value) === fold(value) || fold(proof.text) === fold(value)) &&
      proof.valid &&
      !proof.ariaInvalid
    );
  } catch {
    return false;
  }
}

/** Composed-tree text for readback only; callers must never log the result. */
async function readComposedPageText(page: any): Promise<string> {
  return page.evaluate(() => {
    const roots: Array<Document | ShadowRoot> = [document];
    const parts: string[] = [];
    for (let rootIndex = 0; rootIndex < roots.length; rootIndex++) {
      roots[rootIndex].querySelectorAll("*").forEach((element: Element) => {
        if ((element as HTMLElement).shadowRoot) {
          roots.push((element as HTMLElement).shadowRoot!);
        }
        if (element.children.length === 0 && element.textContent) {
          const text = element.textContent.replace(/\s+/g, " ").trim();
          if (text) parts.push(text);
        }
      });
    }
    return parts.join(" ");
  }).catch(() => "");
}

async function composedPageHasExactFileName(
  page: any,
  expectedFileName: string,
): Promise<boolean> {
  return page.evaluate((expected: string) => {
    const normalize = (value: unknown) =>
      String(value || "")
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "");
    const target = normalize(expected);
    if (!target) return false;
    const roots: Array<Document | ShadowRoot> = [document];
    for (let rootIndex = 0; rootIndex < roots.length; rootIndex++) {
      const elements = roots[rootIndex].querySelectorAll("*");
      for (const element of elements) {
        if ((element as HTMLElement).shadowRoot) {
          roots.push((element as HTMLElement).shadowRoot!);
        }
        const values: unknown[] = [];
        if (element.children.length === 0) values.push(element.textContent);
        for (const attribute of [
          "title",
          "aria-label",
          "data-file-name",
          "data-filename",
          "data-name",
          "href",
        ]) {
          values.push(element.getAttribute(attribute));
        }
        const fileElement = element as Element & {
          fileName?: unknown;
          filename?: unknown;
          files?: FileList | null;
        };
        values.push(fileElement.fileName, fileElement.filename);
        if (fileElement.files) {
          for (let index = 0; index < fileElement.files.length; index++) {
            values.push(fileElement.files.item(index)?.name);
          }
        }
        if (values.some((value) => normalize(value).includes(target))) {
          return true;
        }
      }
    }
    return false;
  }, expectedFileName).catch(() => false);
}

async function fileInputAttachmentProof(
  fileInput: any,
  expectedFileName: string,
): Promise<{
  exactFilenameSeen: boolean;
  contentReferenceCount: number;
}> {
  return fileInput.evaluate((element: Element, expected: string) => {
    const normalize = (value: unknown) =>
      String(value || "")
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "");
    const target = normalize(expected);
    let exactFilenameSeen = false;
    const contentReferences = new Set<string>();
    const seen = new WeakSet<object>();
    let inspected = 0;
    const inspect = (value: unknown, depth: number) => {
      if (inspected++ > 600 || value == null) return;
      if (typeof value === "string") {
        if (target && normalize(value).includes(target)) {
          exactFilenameSeen = true;
        }
        for (const match of value.matchAll(
          /\b(?:069|068|05T)[a-zA-Z0-9]{12}(?:[a-zA-Z0-9]{3})?\b/g,
        )) {
          contentReferences.add(match[0]);
        }
        return;
      }
      if (depth <= 0 || typeof value !== "object" || seen.has(value)) return;
      seen.add(value);
      if (value instanceof FileList) {
        for (let index = 0; index < value.length; index++) {
          inspect(value.item(index)?.name, depth - 1);
        }
        return;
      }
      if (Array.isArray(value)) {
        value.slice(0, 30).forEach((item) => inspect(item, depth - 1));
        return;
      }
      for (const key of Object.keys(value).slice(0, 80)) {
        if (
          /file|document|content|upload|record|version|id|name|href|url/i.test(
            key,
          )
        ) {
          try {
            inspect((value as Record<string, unknown>)[key], depth - 1);
          } catch {/* inaccessible LWC property */}
        }
      }
    };

    let node: Element | null = element;
    for (let depth = 0; depth < 18 && node; depth++) {
      for (const attribute of node.getAttributeNames()) {
        inspect(node.getAttribute(attribute), 1);
      }
      // Lightning's Flow file-upload wrappers keep their committed upload
      // result behind prototype getters/non-enumerable host properties. A
      // generic Object.keys() walk therefore misses the very state that proves
      // a resumed slot already owns ContentVersion/ContentDocument records.
      // Read only the known upload-state contract on this input's composed
      // ancestor chain; never scan sibling slots or the whole page.
      const uploadStateHost = node as Element & Record<string, unknown>;
      for (const property of [
        "contentVersionIds",
        "contentDocumentIds",
        "uploadedFiles",
        "uploadedFileNames",
        "fileNames",
        "fileList",
        "files",
        "fileName",
        "filename",
        "outputValue",
        "value",
        "recordId",
      ]) {
        try {
          inspect(uploadStateHost[property], 3);
        } catch {/* inaccessible Lightning getter */}
      }
      inspect(node, 3);
      const root = node.getRootNode() as ShadowRoot | Document;
      node = node.parentElement || ("host" in root ? root.host : null);
    }
    return {
      exactFilenameSeen,
      contentReferenceCount: contentReferences.size,
    };
  }, expectedFileName).catch(() => ({
    exactFilenameSeen: false,
    contentReferenceCount: 0,
  }));
}

/** Fill a Lightning typeahead (country pickers) only when empty. */
async function pickTypeaheadIfEmpty(
  page: any,
  labelRe: RegExp,
  value: string,
): Promise<boolean> {
  if (!value) return false;
  try {
    const box = await uniqueLabeledCombobox(page, labelRe, {
      allowReadOnly: true,
    });
    if (!box) return false;
    const proof = await box.evaluate((element: Element) => {
      const input = element as HTMLInputElement;
      return {
        value: (input.value || "").trim(),
        ariaInvalid: input.getAttribute("aria-invalid") === "true",
        valid: input.validity ? input.validity.valid : true,
      };
    });
    if (
      fold(proof.value) === fold(value) &&
      !proof.ariaInvalid &&
      proof.valid
    ) return true;
  } catch {/* fall through to pickCombobox */}
  return pickCombobox(page, labelRe, value).catch(() => false);
}

/** Click a wizard button (Next / Submit) by accessible name, tolerant. */
async function clickWizardBtn(page: any, nameRe: RegExp): Promise<boolean> {
  try {
    const buttons = page.getByRole("button", { name: nameRe });
    const count = await buttons.count().catch(() => 0);
    if (count !== 1) {
      logger.warn(`[altinbas][ui] wizard butonu tekil değil: pattern=${nameRe} count=${count}`);
      return false;
    }
    const btn = buttons.first();
    await btn.scrollIntoViewIfNeeded().catch(() => {});
    await btn.click({ timeout: 15000 });
    return true;
  } catch { return false; }
}

/**
 * Read only the CURRENT wizard step from the live-discovered SLDS Path. The
 * modal does not change URL and the path lives under nested shadow roots.
 */
async function readWizardState(page: any): Promise<AltinbasWizardState> {
  const empty: AltinbasWizardState = {
    step: "",
    fileInputCount: 0,
    documentScreen: false,
    reason: "stage_missing",
  };
  try {
    const snapshot = await page.evaluate((): AltinbasWizardSnapshot => {
    const roots: Array<Document | ShadowRoot> = [document];
    const elements: Element[] = [];
    for (let i = 0; i < roots.length; i++) {
      roots[i].querySelectorAll("*").forEach((el: Element) => {
        elements.push(el);
        if ((el as HTMLElement).shadowRoot) roots.push((el as HTMLElement).shadowRoot!);
      });
    }
    const stageNames = elements
      .filter((el) => el.matches(".slds-path__stage-name"))
      .map((el) => el.getAttribute("data-label") || el.textContent || "");
    const currentTitles = elements
      .filter((el) => el.matches("li.slds-path__item.slds-is-current"))
      .map((el) => el.querySelector(".slds-path__title")?.textContent || "");
    const fileInputCount = elements.filter((el) =>
      el.tagName === "INPUT" && (el as HTMLInputElement).type === "file",
    ).length;
      return { stageNames, currentTitles, fileInputCount };
    });
    return resolveAltinbasWizardState(snapshot);
  } catch {
    return empty;
  }
}

/** Return PII-redacted visible browser validation messages and invalid labels. */
async function readWizardValidation(page: any): Promise<string[]> {
  const output: string[] = [];
  const messages = page.locator(
    '[role="alert"],[aria-live="assertive"],.slds-form-element__help,.slds-has-error,.error-message',
  );
  const count = Math.min(await messages.count().catch(() => 0), 40);
  for (let index = 0; index < count; index++) {
    const message = messages.nth(index);
    if (!(await message.isVisible().catch(() => false))) continue;
    const text = ((await message.innerText().catch(() => "")) || "")
      .replace(/\s+/g, " ")
      .trim()
      .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, "<redacted-email>")
      .replace(/\b\+?\d[\d\s().-]{6,}\d\b/g, "<redacted-number>")
      .slice(0, 160);
    if (text) output.push(text);
  }
  const issues = await readVisibleControlIssues(page);
  for (const issue of issues) {
    output.push(
      `${issue.label} (${issue.validationMessage || "invalid"})`,
    );
  }
  return [...new Set(output)].slice(0, 20);
}

/** PII-free native/LWC invalid and required-empty control inventory. */
async function readVisibleControlIssues(page: any): Promise<Array<{
  label: string;
  required: boolean;
  ariaInvalid: boolean;
  valueMissing: boolean;
  empty: boolean;
  validationMessage: string;
}>> {
  const issues: Array<{
    label: string;
    required: boolean;
    ariaInvalid: boolean;
    valueMissing: boolean;
    empty: boolean;
    validationMessage: string;
  }> = [];
  const controls = page.locator("input, select, textarea");
  const count = Math.min(await controls.count().catch(() => 0), 120);
  for (let index = 0; index < count; index++) {
    const control = controls.nth(index);
    if (!(await control.isVisible().catch(() => false))) continue;
    const meta = await control.evaluate((element: Element) => {
      const input = element as HTMLInputElement;
      const required =
        input.required ||
        input.hasAttribute("required") ||
        input.getAttribute("aria-required") === "true";
      const ariaInvalid = input.getAttribute("aria-invalid") === "true";
      const valueMissing = input.validity ? input.validity.valueMissing : false;
      const empty = !(input.value || "").trim();
      let label =
        input.getAttribute("aria-label") ||
        input.labels?.item(0)?.textContent ||
        "";
      let node: Element | null = input;
      for (let depth = 0; depth < 8 && !label && node; depth++) {
        label =
          node.getAttribute("label") ||
          node.getAttribute("data-label") ||
          node.getAttribute("title") ||
          "";
        const root = node.getRootNode() as ShadowRoot | Document;
        node =
          node.parentElement ||
          ("host" in root ? root.host : null);
      }
      return {
        label: (label || input.getAttribute("name") || input.tagName.toLowerCase())
          .replace(/\s+/g, " ")
          .trim()
          .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, "<redacted-email>")
          .replace(/\b\+?\d[\d\s().-]{6,}\d\b/g, "<redacted-number>")
          .slice(0, 160),
        required,
        ariaInvalid,
        valueMissing,
        empty,
        validationMessage: (input.validationMessage || "")
          .replace(/\s+/g, " ")
          .trim()
          .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, "<redacted-email>")
          .replace(/\b\+?\d[\d\s().-]{6,}\d\b/g, "<redacted-number>")
          .slice(0, 160),
      };
    }).catch(() => null);
    if (
      meta &&
      (meta.ariaInvalid || meta.valueMissing || (meta.required && meta.empty))
    ) {
      issues.push(meta);
    }
  }
  return issues.slice(0, 30);
}

// ---------------------------------------------------------------------------
// Stage fillers
// ---------------------------------------------------------------------------
async function fillPersonalUI(
  page: any,
  profile: SubmitProfile,
): Promise<{ ok: boolean; failures: UiFieldResult[] }> {
  const results: UiFieldResult[] = [];
  const explicitGender = /^(male|female|m|f)$/i.test(profile.gender?.trim() || "")
    ? (/^f/i.test(profile.gender.trim()) ? "Female" : "Male")
    : "";
  if (explicitGender) {
    results.push(await selectNamedField(page, "Gender", explicitGender));
  } else {
    const controls = page.locator('select[name="Gender"]:visible');
    const count = await controls.count().catch(() => 0);
    if (count !== 1) {
      results.push({ ok: false, field: "Gender", reason: `control_count_${count}` });
    } else {
      const proof = await controls.first().evaluate((element: Element) => {
        const select = element as HTMLSelectElement;
        return {
          value: (select.value || "").trim(),
          text: (select.selectedOptions.item(0)?.textContent || "").trim(),
          ariaInvalid: select.getAttribute("aria-invalid") === "true",
          valid: select.validity ? select.validity.valid : true,
        };
      }).catch(() => null);
      const savedGender = proof &&
        [proof.value, proof.text].find((value) => /^(male|female)$/i.test(value));
      results.push({
        ok: !!savedGender && !!proof?.valid && !proof?.ariaInvalid,
        field: "Gender",
        reason: savedGender ? "existing_portal_value_proved" : "data_missing",
      });
    }
  }
  results.push(
    await fillAltinbasUiDateField(
      page,
      "Date_of_Birth",
      profile.dateOfBirth,
    ),
  );
  results.push(
    await fillAltinbasUiDateField(
      page,
      "Passport_Date_of_Issue",
      profile.passportIssueDate,
    ),
  );
  results.push(
    await fillAltinbasUiDateField(
      page,
      "Passport_Date_of_Expiry",
      profile.passportExpiryDate,
    ),
  );
  results.push(
    await fillOrProveNamedField(page, "Address_Street", profile.addressStreet),
  );
  results.push(
    await fillOrProveNamedField(page, "Address_City", profile.addressCity, {
      legacyFallback: LEGACY_ADDRESS_CITY_FALLBACK,
    }),
  );
  results.push(
    await fillOrProveNamedField(page, "Address_Zip_Code", profile.addressZip, {
      legacyFallback: LEGACY_ADDRESS_ZIP_FALLBACK,
    }),
  );

  const birthCity = explicitCityOfBirth(profile.cityOfBirth);
  if (birthCity) {
    results.push(await fillNamedField(page, "City_of_Birth", birthCity));
  }
  if (profile.fatherName?.trim() && profile.fatherName.trim() !== "-") {
    results.push(await fillNamedField(page, "Father_Name", profile.fatherName));
  }
  if (profile.motherName?.trim() && profile.motherName.trim() !== "-") {
    results.push(await fillNamedField(page, "Mother_Name", profile.motherName));
  }
  results.push(
    await fillOrProveNamedField(
      page,
      "phone",
      altinbasPhoneDigits(profile.phone) || undefined,
    ),
  );

  const country = mapCountry(profile.nationality);
  if (!country) {
    results.push({
      ok: false,
      field: "nationality",
      reason: "country_mapping_missing",
    });
  }
  const countryProofs: Array<[string, boolean]> = [
    [
      "Country_of_Birth",
      country
        ? await pickTypeaheadIfEmpty(page, /^Country of Birth$/i, country)
        : false,
    ],
    [
      "Passport_Issuing_Country",
      country
        ? await pickTypeaheadIfEmpty(page, /^Passport Issuing Country$/i, country)
        : false,
    ],
    [
      "Address_Country",
      country
        ? await pickTypeaheadIfEmpty(page, /^Address:\s*Country$/i, country)
        : false,
    ],
  ];
  for (const [field, ok] of countryProofs) {
    results.push({ ok, field, reason: ok ? "ok" : "readback_failed" });
  }

  const legacyFallbackFields = results
    .filter((item) => item.ok && item.reason === "legacy_fallback_applied")
    .map((item) => item.field);
  if (legacyFallbackFields.length) {
    logger.warn(
      `[altinbas][ui] legacy address fallback applied` +
      ` (fields=${legacyFallbackFields.join(",")})`,
    );
  }
  const failures = results.filter((result) => !result.ok);
  return { ok: failures.length === 0, failures };
}

/** Diagnostic boundary: one explicitly selected stage + one Next, then stop. */
async function runSingleStepMutationCanary(
  page: any,
  profile: SubmitProfile,
  result: SubmitResult,
): Promise<void> {
  const before = await readWizardState(page);
  if (
    !MUTATION_CANARY_STAGE ||
    before.step !== MUTATION_CANARY_STAGE ||
    before.reason !== "ok"
  ) {
    result.detail =
      `Altınbaş[canary]: blocked_before_write` +
      ` (requested="${MUTATION_CANARY_STAGE || "invalid"}",` +
      ` aktif="${before.step || "bilinmiyor"}", detector=${before.reason})`;
    return;
  }
  if (before.step === "Personal Information") {
    const filled = await fillPersonalUI(page, profile);
    if (!filled.ok) {
      result.detail =
        `Altınbaş[canary]: data_missing_or_unproved` +
        ` (${filled.failures.map((item) => `${item.field}:${item.reason}`).join(",")})`;
      return;
    }
  } else if (before.step === "Educational Information") {
    const education = await ensureEducationUI(page, profile);
    if (!education.ok) {
      result.detail = `Altınbaş[canary]: Educational ${education.reason}`;
      return;
    }
  } else if (before.step === "Questionnaire") {
    const questionnaire = await fillQuestionnaireUI(page, profile);
    if (!questionnaire.ok) {
      result.detail = `Altınbaş[canary]: Questionnaire ${questionnaire.reason}`;
      return;
    }
  }
  if (!(await clickWizardBtn(page, /^\s*Next\s*$/i))) {
    result.detail = "Altınbaş[canary]: blocked — tekil/tıklanabilir Next bulunamadı";
    return;
  }
  await page.waitForTimeout(SF_HYDRATION_MS);
  const after = await readWizardState(page);
  const issues = await readVisibleControlIssues(page);
  result.detail =
    `Altınbaş[canary]: STOPPED_AFTER_EXACTLY_ONE_NEXT` +
    ` (before="${before.step}", after="${after.step || "bilinmiyor"}",` +
    ` transition=${classifyAltinbasWizardTransition(before.step, after.step)},` +
    ` detector=${after.reason})` +
    ` — controlIssues=${issues.length ? JSON.stringify(issues) : "yok"}`;
}

/** Ensure every prior-education record required by the target level exists. */
async function ensureEducationUI(
  page: any,
  profile: SubmitProfile,
): Promise<{ ok: boolean; reason: string }> {
  const classification = classifyProfileLevel(profile.level);
  const requiredLevels =
    classification === "phd"
      ? ["bachelor", "master"]
      : classification === "master"
        ? ["bachelor"]
        : ["high_school"];
  const fallbackCountry = mapCountry(profile.nationality) || profile.nationality;
  const legacySchools = {
    high_school: profile.legacyEducation?.highSchool,
    bachelor: profile.legacyEducation?.bachelorSchool,
    master: profile.legacyEducation?.masterSchool,
  };
  const records = requiredLevels.map((level) => {
    const source = profile.educationRecords?.find(
      (record) => record.level === level,
    );
    const resolved = resolveAltinbasLegacyEducation({
      record: source,
      level: level as "high_school" | "bachelor" | "master",
      applicationLevel: classification as
        | "associate"
        | "bachelor"
        | "master"
        | "phd",
      legacySchoolName: legacySchools[level as keyof typeof legacySchools],
      fallbackCountry,
      legacyGraduationYear: profile.graduationYear,
      legacyGpa: profile.legacyEducation?.rawGpa ?? profile.gpa,
      dateOfBirth: profile.dateOfBirth,
    });
    if (resolved.fallbackFields.length) {
      logger.warn(
        `[altinbas][ui] legacy education fallback applied` +
        ` (level=${level}, fields=${resolved.fallbackFields.join(",")},` +
        ` gpaPolicy=${resolved.gpaProvenance})`,
      );
    }
    return {
      ...source,
      level,
      schoolName: resolved.schoolName,
      country: resolved.country,
      endYear: resolved.endYear,
      gpa: resolved.gpa,
      gpaType: resolved.gpaType,
    } satisfies EduRecord;
  });
  const missing = records.flatMap((record, index) => {
    const level = requiredLevels[index];
    return [
      !record?.schoolName?.trim() && `${level}.schoolName`,
    ].filter((value): value is string => !!value);
  });
  if (missing.length) {
    return { ok: false, reason: `data_missing:${missing.join(",")}` };
  }
  for (const record of records) {
    const ensured = await ensureEducationRecordUI(page, record);
    if (!ensured.ok) return ensured;
  }
  return { ok: true, reason: "all_required_records_proved" };
}

async function ensureEducationRecordUI(
  page: any,
  primary: EduRecord,
): Promise<{ ok: boolean; reason: string }> {
  const beforeText = await readComposedPageText(page);
  if (fold(beforeText).includes(fold(primary.schoolName!))) {
    logger.info("[altinbas][ui] Educational: exact CRM school readback bulundu");
    return { ok: true, reason: "existing_record_proved" };
  }
  const missingForCreate = [
    !primary.country?.trim() && "country",
    !primary.endYear && "graduationYear",
    !primary.gpa?.trim() && "gpa",
    !altinbasGpaTypeLabel(primary.gpaType) && "gpaType",
  ].filter((value): value is string => !!value);
  if (missingForCreate.length) {
    return {
      ok: false,
      reason: `data_missing:${primary.level}.${missingForCreate.join(`,${primary.level}.`)}`,
    };
  }
  // Open the education add (+) modal. The live portal does not consistently
  // render a literal "EDUCATION" leaf heading, so an exact Add/utility:add
  // signal may prove the target without that optional proximity anchor.
  const addScan = await page.evaluate(() => {
    const roots: Array<Document | ShadowRoot> = [document];
    const els: Element[] = [];
    for (let rootIndex = 0; rootIndex < roots.length; rootIndex++) {
      roots[rootIndex].querySelectorAll("*").forEach((element: Element) => {
        els.push(element);
        if ((element as HTMLElement).shadowRoot) {
          roots.push((element as HTMLElement).shadowRoot!);
        }
      });
    }
    const composed = {
      parent(element: Element): Element | null {
        if (element.parentElement) return element.parentElement;
        const root = element.getRootNode() as ShadowRoot | Document;
        return "host" in root ? root.host : null;
      },
      chain(element: Element): Element[] {
        const result: Element[] = [];
        let current: Element | null = element;
        for (let depth = 0; depth < 20 && current; depth++) {
          result.push(current);
          current = composed.parent(current);
        }
        return result;
      },
    };
    const headings = els.filter(
      (element) =>
        /^\s*EDUCATION(?:AL)?(?:\s+INFORMATION(?:S)?)?\s*$/i.test(
          (element.textContent || "").trim(),
        ) &&
        element.children.length === 0,
    );
    const headingChain =
      headings.length === 1 ? composed.chain(headings[0]) : [];
    const rawSignals = els.filter((element) =>
      element.matches(
        "button,a,lightning-button,lightning-button-icon,lightning-icon," +
        "lightning-primitive-icon,lightning-base-icon,svg,use,[icon-name]," +
        "[data-key],[role='button'],[onclick],[tabindex='0'],.slds-button," +
        ".slds-button_icon,.slds-icon,.slds-icon_container",
      ),
    );
    const activationGroups = new Map<Element, Element[]>();
    rawSignals.forEach((signal) => {
      const signalChain = composed.chain(signal);
      const clickable = signalChain.find((candidate) =>
          candidate.matches(
            "button,a,lightning-button,lightning-button-icon,[role='button']," +
            "[onclick],[tabindex='0'],.slds-button,.slds-button_icon",
          ),
        );
      const iconHost = signalChain.find((candidate) =>
        candidate.matches(
          "lightning-icon,lightning-primitive-icon,lightning-base-icon," +
          "[icon-name],.slds-icon_container",
        ),
      );
      const activation = clickable || iconHost || signal;
      const signals = activationGroups.get(activation) || [];
      signals.push(signal);
      activationGroups.set(activation, signals);
    });
    const candidates = [...activationGroups.entries()].flatMap(
      ([activation, signals], actionIndex) => {
      const rect = activation.getBoundingClientRect();
      const signalVisible = signals.some((signal) => {
        const signalRect = signal.getBoundingClientRect();
        return signalRect.width > 0 && signalRect.height > 0;
      });
      const style = getComputedStyle(activation);
      if (
        ((rect.width <= 0 || rect.height <= 0) && !signalVisible) ||
        style.display === "none" ||
        style.visibility === "hidden"
      ) return [];
      const actionChain = composed.chain(activation);
      const interactive = activation.matches(
        "button,a,lightning-button,lightning-button-icon,[role='button']," +
        "[onclick],[tabindex='0'],.slds-button,.slds-button_icon",
      );
      const actionCommonIndex = headingChain.length
        ? actionChain.findIndex((candidate) => headingChain.includes(candidate))
        : -1;
      const headingCommonIndex =
        actionCommonIndex >= 0
          ? headingChain.indexOf(actionChain[actionCommonIndex])
          : -1;
      const tag = activation.tagName.toLowerCase();
      const directDescriptor = [
        ...signals.flatMap((signal) => [
          signal.getAttribute("title"),
          signal.getAttribute("aria-label"),
          signal.getAttribute("name"),
          signal.getAttribute("icon-name"),
          signal.getAttribute("data-element-id"),
          signal.getAttribute("data-key"),
          signal.getAttribute("href"),
          signal.getAttribute("xlink:href"),
          signal.getAttribute("class"),
          String((signal as Element & { iconName?: unknown }).iconName || ""),
          signal.textContent,
        ]),
        activation.getAttribute("title"),
        activation.getAttribute("aria-label"),
        activation.getAttribute("name"),
        activation.getAttribute("icon-name"),
        activation.getAttribute("data-element-id"),
        String((activation as Element & { iconName?: unknown }).iconName || ""),
        activation.textContent,
      ]
        .filter(Boolean)
        .join(" ")
        .replace(/\s+/g, " ")
        .toLowerCase();
      const descriptor = actionChain
        .slice(0, 4)
        .flatMap((candidate, chainDepth) => [
          candidate.tagName,
          candidate.getAttribute("class"),
          candidate.getAttribute("title"),
          candidate.getAttribute("aria-label"),
          candidate.getAttribute("name"),
          candidate.getAttribute("icon-name"),
          candidate.getAttribute("data-element-id"),
          String((candidate as Element & { iconName?: unknown }).iconName || ""),
          // Never use broad ancestor text (especially BODY): it contains the
          // whole wizard and turned Salesforce's skip link into a false
          // "education + add" candidate. Visible text is trusted only on the
          // activation itself and its immediate wrapper.
          chainDepth <= 1 ? candidate.textContent : "",
        ])
        .filter(Boolean)
        .join(" ")
        .replace(/\s+/g, " ")
        .toLowerCase();
      const excluded =
        /select a date|calendar|slds-input__icon|flow-button|(?:^|\s)(?:back|next|previous|logout)(?:\s|$)|slds-path/.test(
          directDescriptor,
        );
      const exactAddIcon =
        /(?:^|\s)utility\s*[:_-]\s*add(?:\s|$)/.test(directDescriptor) ||
        /(?:^|\s)(?:add|new|create|\+)(?:\s|$)/.test(directDescriptor);
      const hasAddVerb =
        /(?:^|\s)(?:add|new|create|\+)(?:\s|$)/.test(descriptor);
      const hasEducationNoun =
        /(?:^|\s)(?:education(?:al)?|school|record)(?:\s|$)/.test(
          descriptor,
        );
      const hasExamNoun =
        /(?:^|\s)(?:exam|proficiency|language\s+test|test\s+score)(?:\s|$)/.test(
          descriptor,
        );
      const targetContext =
        (
          /educationalinformationlist|educational_information/.test(
            descriptor,
          ) ||
          hasEducationNoun
        ) &&
        !hasExamNoun;
      const contextualAdd = targetContext && hasAddVerb;
      const genericIcon =
        signals.some((signal) =>
          ["lightning-icon", "lightning-button-icon"].includes(
            signal.tagName.toLowerCase(),
          ),
        ) ||
        tag === "lightning-button-icon" ||
        /slds-button_icon/.test(descriptor);
      const id = String(actionIndex);
      activation.setAttribute("data-fas-edu-add-candidate", id);
      const targetMeta = actionChain.slice(0, 10).map((candidate) => ({
        tag: candidate.tagName.toLowerCase(),
        role: candidate.getAttribute("role") || "",
        name: candidate.getAttribute("name") || "",
        title: candidate.getAttribute("title") || "",
        ariaLabel: candidate.getAttribute("aria-label") || "",
        iconName:
          candidate.getAttribute("icon-name") ||
          String((candidate as Element & { iconName?: unknown }).iconName || ""),
        dataElementId: candidate.getAttribute("data-element-id") || "",
        dataKey: candidate.getAttribute("data-key") || "",
        className: (candidate.getAttribute("class") || "").slice(0, 180),
      }));
      const signalMeta = signals.slice(0, 12).map((signal) => ({
        tag: signal.tagName.toLowerCase(),
        role: signal.getAttribute("role") || "",
        title: signal.getAttribute("title") || "",
        ariaLabel: signal.getAttribute("aria-label") || "",
        iconName:
          signal.getAttribute("icon-name") ||
          String((signal as Element & { iconName?: unknown }).iconName || ""),
        href:
          signal.getAttribute("href") ||
          signal.getAttribute("xlink:href") ||
          "",
        className: (signal.getAttribute("class") || "").slice(0, 180),
      }));
      return [{
        id,
        // A direct Add signal is sufficient because this function is invoked
        // only after the verified Educational Information stage is active.
        // Generic icons remain eligible only when related to one heading.
        distance:
          exactAddIcon || contextualAdd
            ? 0
            : actionCommonIndex >= 0 && headingCommonIndex >= 0
              ? actionCommonIndex + headingCommonIndex
              : 99,
        semantic: exactAddIcon || contextualAdd,
        genericIcon,
        excluded,
        targetContext,
        interactive,
        targetMeta,
        signalMeta,
        insideDialog: actionChain.some((candidate) =>
          candidate.matches(
            "[role='dialog'],[aria-modal='true'],.slds-modal",
          ),
        ),
        top: Math.round(
          rect.height > 0
            ? rect.top
            : Math.min(
                ...signals
                  .map((signal) => signal.getBoundingClientRect())
                  .filter((signalRect) => signalRect.height > 0)
                  .map((signalRect) => signalRect.top),
              ),
        ),
      }];
    });
    return {
      headingCount: headings.length,
      rawSignalCount: rawSignals.length,
      activationCount: activationGroups.size,
      candidates,
    };
  }).catch((error: unknown) => ({
    headingCount: 0,
    rawSignalCount: 0,
    activationCount: 0,
    candidates: [],
    scanError:
      error instanceof Error
        ? `${error.name}:${error.message}`
        : String(error || "evaluate_error"),
  }));
  const addCandidates = addScan.candidates as Array<
    AltinbasEducationAddCandidate & {
      targetMeta?: Array<Record<string, unknown>>;
      signalMeta?: Array<Record<string, unknown>>;
    }
  >;
  const addDecision = decideAltinbasEducationAddCandidate(addCandidates);
  const modalControls = page.locator(
    "input:visible,textarea:visible,select:visible,[role='combobox']:visible",
  );
  const beforeModalControls = await modalControls.count().catch(() => 0);
  let addClicked = false;
  if (addDecision.id) {
    const markedTarget = page.locator(
      `[data-fas-edu-add-candidate="${addDecision.id}"]`,
    );
    const markedCount = await markedTarget.count().catch(() => 0);
    if (markedCount === 1) {
      try {
        await markedTarget.click({ timeout: 8_000 });
        addClicked = true;
      } catch {
        try {
          await markedTarget.click({ force: true, timeout: 5_000 });
          addClicked = true;
        } catch {/* fail closed below */}
      }
    }
  }
  await page.evaluate(() => {
    const roots: Array<Document | ShadowRoot> = [document];
    for (let rootIndex = 0; rootIndex < roots.length; rootIndex++) {
      roots[rootIndex].querySelectorAll("*").forEach((element: Element) => {
        if ((element as HTMLElement).shadowRoot) {
          roots.push((element as HTMLElement).shadowRoot!);
        }
        element.removeAttribute("data-fas-edu-add-candidate");
      });
    }
  }).catch(() => {});
  if (!addClicked) {
    logger.warn(
      `[altinbas][ui] Educational: + (add) butonu bulunamadı` +
      ` (headingCount=${addScan.headingCount},` +
      ` rawSignals=${addScan.rawSignalCount},` +
      ` activations=${addScan.activationCount},` +
      ` candidates=${addCandidates.length},` +
      ` semantic=${addCandidates.filter((candidate) => candidate.semantic).length},` +
      ` targeted=${addCandidates.filter((candidate) => candidate.semantic && candidate.targetContext).length},` +
      ` targetedExcluded=${addCandidates.filter((candidate) => candidate.semantic && candidate.targetContext && candidate.excluded).length},` +
      ` dialog=${addCandidates.filter((candidate) => candidate.semantic && candidate.insideDialog).length},` +
      ` tops=${addCandidates.filter((candidate) => candidate.semantic && candidate.insideDialog).map((candidate) => candidate.top ?? 0).sort((a, b) => a - b).join(":") || "none"},` +
      ` semanticTops=${addCandidates.filter((candidate) => candidate.semantic && !candidate.excluded).map((candidate) => candidate.top ?? 0).sort((a, b) => a - b).join(":") || "none"},` +
      ` icons=${addCandidates.filter((candidate) => candidate.genericIcon && !candidate.excluded).length},` +
      ` decision=${addDecision.reason},` +
      ` scanError=${redactAltinbasLog(
        "scanError" in addScan ? addScan.scanError : "none",
      ).slice(0, 180)})`,
    );
    return { ok: false, reason: "add_button_missing" };
  }
  let afterModalControls = beforeModalControls;
  let visibleDialogs = 0;
  for (let poll = 0; poll < 12; poll++) {
    afterModalControls = await modalControls.count().catch(() => 0);
    visibleDialogs = await page.locator(
      "[role='dialog']:visible,[aria-modal='true']:visible,.slds-modal:visible",
    ).count().catch(() => 0);
    if (afterModalControls > beforeModalControls && afterModalControls > 0) {
      break;
    }
    await page.waitForTimeout(500);
  }
  if (
    afterModalControls <= beforeModalControls ||
    afterModalControls === 0
  ) {
    const selectedCandidate = addCandidates.find(
      (candidate) => candidate.id === addDecision.id,
    );
    logger.warn(
      `[altinbas][ui] Educational: Add tıklandı fakat modal doğrulanamadı` +
      ` (beforeControls=${beforeModalControls}, afterControls=${afterModalControls},` +
      ` visibleDialogs=${visibleDialogs}, proof=${addDecision.proof},` +
      ` target=${redactAltinbasLog(JSON.stringify({
        chain: selectedCandidate?.targetMeta || [],
        signals: selectedCandidate?.signalMeta || [],
      })).slice(0, 1800)})`,
    );
    return { ok: false, reason: "add_modal_not_opened" };
  }
  logger.info(
    `[altinbas][ui] Educational: add control opened` +
    ` (proof=${addDecision.proof}, controls=${afterModalControls},` +
    ` dialogs=${visibleDialogs})`,
  );
  // Salesforce animates the modal and may briefly expose controls before
  // their editable state/labels are connected.
  await page.waitForTimeout(700);
  // Modal fields.
  const degreeLabel =
    primary.level === "bachelor" ? "Bachelor" :
    primary.level === "master" ? "Master" :
    "Secondary School";
  const gpaTypeLabel = altinbasGpaTypeLabel(primary.gpaType);
  if (!gpaTypeLabel) {
    return { ok: false, reason: "data_missing:education.gpaType" };
  }
  let schoolMatch = {
    control: null as any,
    total: 0,
    eligible: 0,
  };
  for (let attempt = 0; attempt < 4 && !schoolMatch.control; attempt++) {
    schoolMatch = await uniqueVisibleEditableControl(
      page.locator(
        'input[name="school" i]:visible,textarea[name="school" i]:visible',
      ),
      ["input", "textarea"],
    );
    if (!schoolMatch.control) {
      schoolMatch = await uniqueVisibleEditableControl(
        page.getByLabel(/^\s*Name of School\s*\*?\s*$/i),
        ["input", "textarea"],
      );
    }
    if (!schoolMatch.control) {
      schoolMatch = await uniqueEducationModalControl(
        page,
        "input:visible,textarea:visible",
        /(?:^|[\s_-])school(?:$|[\s_-])|name[\s_-]*of[\s_-]*school|school[\s_-]*name|school__c|institution/i,
        /search|filter|gpa|city|field[\s_-]*of[\s_-]*study/i,
        ["input", "textarea"],
      );
    }
    if (!schoolMatch.control && attempt < 3) {
      await page.waitForTimeout(350);
    }
  }
  if (!schoolMatch.control) {
    const contract = await educationModalControlContract(page);
    logger.warn(
      `[altinbas][ui] Educational: school control tekil görünür değil` +
      ` (total=${schoolMatch.total}, eligible=${schoolMatch.eligible},` +
      ` contract=${redactAltinbasLog(JSON.stringify(contract)).slice(0, 5000)})`,
    );
    return { ok: false, reason: "school_control_not_unique" };
  }
  const schoolControl = schoolMatch.control;
  await schoolControl.fill(primary.schoolName!.trim());
  const schoolReadback =
    ((await schoolControl.inputValue().catch(() => "")) || "").trim() ===
    primary.schoolName!.trim();
  const selectProofs = await Promise.all([
    selectNative(
      page,
      /^\s*Country/i,
      primary.country!.trim(),
      /country__c|country/i,
      "country",
    ),
    selectNative(
      page,
      /^\s*Degree/i,
      degreeLabel,
      /degree__c|degree/i,
      "degree",
    ),
    selectNative(
      page,
      /Graduation Year/i,
      String(primary.endYear),
      /end[\s_-]*year__c|graduation[\s_-]*year|end[\s_-]*year/i,
      "endyear",
    ),
    selectNative(
      page,
      /GPA Type/i,
      gpaTypeLabel,
      /gpa[\s_-]*type__c|gpa[\s_-]*type/i,
      "gpatype",
    ),
  ]);
  let gpaMatch = {
    control: null as any,
    total: 0,
    eligible: 0,
  };
  for (let attempt = 0; attempt < 4 && !gpaMatch.control; attempt++) {
    gpaMatch = await uniqueVisibleEditableControl(
      page.locator('input[name="gpa" i]:visible'),
      ["input"],
    );
    if (!gpaMatch.control) {
      gpaMatch = await uniqueVisibleEditableControl(
        page.getByLabel(/^\s*GPA\s*\*?\s*$/i),
        ["input"],
      );
    }
    if (!gpaMatch.control) {
      gpaMatch = await uniqueEducationModalControl(
        page,
        "input:visible",
        /(?:^|[\s_-])gpa(?:__c)?(?:$|[\s_-])/i,
        /gpa[\s_-]*type|search|filter/i,
        ["input"],
      );
    }
    if (!gpaMatch.control && attempt < 3) {
      await page.waitForTimeout(350);
    }
  }
  if (!gpaMatch.control) {
    logger.warn(
      `[altinbas][ui] Educational: GPA control tekil görünür değil` +
      ` (total=${gpaMatch.total}, eligible=${gpaMatch.eligible})`,
    );
    return { ok: false, reason: "gpa_control_not_unique" };
  }
  const gpaControl = gpaMatch.control;
  await gpaControl.fill(primary.gpa!.trim());
  const gpaReadback =
    ((await gpaControl.inputValue().catch(() => "")) || "").trim() ===
    primary.gpa!.trim();
  if (!schoolReadback || !gpaReadback || selectProofs.some((proof) => !proof)) {
    return { ok: false, reason: "education_readback_failed" };
  }
  await page.waitForTimeout(500);
  if (!(await clickWizardBtn(page, /^\s*Save\s*$/i))) {
    return { ok: false, reason: "save_button_missing" };
  }
  await page.waitForTimeout(3500);
  const validation = await readWizardValidation(page);
  if (validation.length) {
    return { ok: false, reason: `validation:${validation.join("|")}` };
  }
  const state = await readWizardState(page);
  const afterText = await readComposedPageText(page);
  const recordProved =
    state.step === "Educational Information" &&
    state.reason === "ok" &&
    fold(afterText).includes(fold(primary.schoolName!));
  return recordProved
    ? { ok: true, reason: "created_and_read_back" }
    : { ok: false, reason: "education_row_readback_failed" };
}

async function fillQuestionnaireUI(
  page: any,
  profile: SubmitProfile,
): Promise<{ ok: boolean; reason: string }> {
  const combos = page.getByRole("combobox");
  if ((await combos.count().catch(() => 0)) !== 1) {
    return { ok: false, reason: "visa_combobox_not_unique" };
  }
  const combo = combos.first();
  const existingProof = await combo.evaluate((element: Element) => {
    const control = element as HTMLInputElement;
    return {
      value: (control.value || "").trim(),
      text: (control.textContent || "").trim(),
      ariaValue: (control.getAttribute("aria-valuetext") || "").trim(),
      ariaInvalid: control.getAttribute("aria-invalid") === "true",
      valid: control.validity ? control.validity.valid : true,
    };
  }).catch(() => null);
  const existingChoice = existingProof && existingProof.valid && !existingProof.ariaInvalid
    ? [existingProof.value, existingProof.text, existingProof.ariaValue]
      .find((value) => /^(yes|no)$/i.test(value)) || ""
    : "";
  const resumeAction = resolveAltinbasVisaResumeAction({
    crmValue: profile.visaSupport,
    portalValue: existingChoice,
    legacyDefaultNo: LEGACY_VISA_SUPPORT_DEFAULT_NO,
  });
  if (resumeAction === "questionnaire_followup_unmapped") {
    // Live evidence shows an additional consulate/embassy answer after Yes.
    // The CRM has no dedicated source for it yet; never fabricate one.
    return { ok: false, reason: "data_missing:questionnaire_followup" };
  }
  if (resumeAction === "data_missing") {
    return { ok: false, reason: "data_missing:needsVisaSupport" };
  }
  if (resumeAction === "accept_existing_no") {
    return { ok: true, reason: "existing_portal_value_proved" };
  }
  if (resumeAction === "select_no_from_policy") {
    logger.info(
      "[altinbas][ui] legacy questionnaire fallback applied" +
      " (field=needsVisaSupport, value=No, policy=historical_default)",
    );
  }

  // Explicit CRM or approved historical fallback "No": select the exact
  // Lightning option and prove readback.
  const need = "No";
  await combo.click({ timeout: 6_000 }).catch(() => {});
  await page.waitForTimeout(800);
  const options = page.getByRole("option", {
    name: new RegExp(`^\\s*${need}\\s*$`, "i"),
  });
  if ((await options.count().catch(() => 0)) !== 1) {
    return { ok: false, reason: "visa_option_not_unique" };
  }
  await options.first().click({ timeout: 5_000 }).catch(() => {});
  await page.waitForTimeout(1500);
  const proof = await combo.evaluate((element: Element) => {
    const control = element as HTMLInputElement;
    return {
      value: (control.value || "").trim(),
      text: (control.textContent || "").trim(),
      ariaValue: (control.getAttribute("aria-valuetext") || "").trim(),
      ariaInvalid: control.getAttribute("aria-invalid") === "true",
    };
  }).catch(() => null);
  const selected = proof && [proof.value, proof.text, proof.ariaValue]
    .some((value) => fold(value) === fold(need));
  return selected && !proof!.ariaInvalid
    ? { ok: true, reason: "selected_and_read_back" }
    : { ok: false, reason: "visa_readback_failed" };
}

async function uploadDocumentsUI(
  page: any,
  files: SubmitFiles,
  serverUploadedSlots: ReadonlySet<AltinbasDocumentSlot>,
): Promise<string[]> {
  const state = await readWizardState(page);
  if (state.step !== "Documents" || !state.documentScreen || state.reason !== "ok") {
    logger.warn(
      `[altinbas][ui] Documents upload blocked` +
      ` (aktif="${state.step || "bilinmiyor"}", detector=${state.reason})`,
    );
    return [];
  }
  const wanted: Array<[RegExp, string | undefined, string]> = [
    [/Passport/i, files.passport, "passport"],
    [/Diploma/i, files.diploma, "diploma"],
    [/Transcript/i, files.transcript, "transcript"],
    [/Picture|Photo/i, files.photo, "photo"],
  ];
  const uploaded: string[] = [];

  const fileInputs = page.locator('input[type="file"]');
  const labels: string[] = await fileInputs.evaluateAll(
    (inputs: HTMLInputElement[]) =>
      inputs.map((input) => {
        let node: Element | null = input;
        for (let depth = 0; depth < 10 && node; depth++) {
          const text = (node.textContent || "").replace(/\s+/g, " ").trim();
          if (/Required|Passport|Diploma|Transcript|Photo|Picture|Document/i.test(text)) {
            return text.slice(0, 120);
          }
          const root = node.getRootNode() as ShadowRoot | Document;
          node =
            node.parentElement ||
            ("host" in root ? root.host : null);
        }
        return "";
      }),
  ).catch(() => [] as string[]);
  logger.info(
    `[altinbas][ui] Documents: fileInputCount=${labels.length}` +
    ` labelled=${labels.filter(Boolean).length}`,
  );

  for (const [re, path, tag] of wanted) {
    if (!path) continue;
    if (serverUploadedSlots.has(tag as AltinbasDocumentSlot)) {
      uploaded.push(tag);
      logger.info(
        `[altinbas][ui] Documents: ${tag} zaten mevcut` +
        ` (proof=flow_recordsCV)`,
      );
      continue;
    }
    const indices = labels
      .map((label, index) => (re.test(label) ? index : -1))
      .filter((index) => index >= 0);
    if (indices.length !== 1) {
      logger.warn(
        `[altinbas][ui] Documents: ${tag} input tekil değil (count=${indices.length})`,
      );
      continue;
    }
    const fileName = basename(path);
    const fileInput = fileInputs.nth(indices[0]);
    const existingSlotProof = await fileInputAttachmentProof(
      fileInput,
      fileName,
    );
    if (
      isAltinbasExistingUploadProved(existingSlotProof) ||
      await composedPageHasExactFileName(page, fileName)
    ) {
      uploaded.push(tag);
      logger.info(
        `[altinbas][ui] Documents: ${tag} zaten mevcut` +
        ` (proof=${existingSlotProof.contentReferenceCount > 0 ? "content_reference" : "exact_filename"})`,
      );
      continue;
    }
    try {
      await fileInput.setInputFiles(path);
    } catch (e) {
      logger.warn(`[altinbas][ui] Documents: ${tag} setInputFiles hatası: ${(e as Error).message?.slice(0, 120)}`);
      continue;
    }
    const localReadback = await fileInput.evaluate(
      (input: Element) => {
        const fileInput = input as HTMLInputElement;
        return fileInput.files?.item(0)?.name || "";
      },
    ).catch(() => "");
    if (localReadback !== fileName) {
      logger.warn(`[altinbas][ui] Documents: ${tag} local file readback başarısız`);
      continue;
    }
    // Upload modal → wait for Done, click it.
    await page.waitForTimeout(1500);
    let doneClicked = false;
    for (let t = 0; t < 20; t++) {
      const done = page.getByRole("button", { name: /^\s*Done\s*$/i });
      if ((await done.count().catch(() => 0)) === 1) {
        await page.waitForTimeout(1200);
        doneClicked = await done.click({ timeout: 6000 }).then(
          () => true,
          () => false,
        );
        break;
      }
      await page.waitForTimeout(1000);
    }
    if (!doneClicked) {
      logger.warn(`[altinbas][ui] Documents: ${tag} Done doğrulanamadı`);
      continue;
    }
    let doneDismissed = false;
    for (let poll = 0; poll < 12; poll++) {
      const remainingDone = await page.getByRole("button", {
        name: /^\s*Done\s*$/i,
      }).count().catch(() => 0);
      if (remainingDone === 0) {
        doneDismissed = true;
        break;
      }
      await page.waitForTimeout(250);
    }
    await page.waitForTimeout(500);
    const after = await readWizardState(page);
    const documentsStage =
      after.step === "Documents" && after.reason === "ok";
    const portalFilenameSeen = await composedPageHasExactFileName(
      page,
      fileName,
    );
    const uploadedSlotProof = await fileInputAttachmentProof(
      fileInput,
      fileName,
    );
    if (!isAltinbasLightningUploadProved({
      exactLocalFile: localReadback === fileName,
      doneClicked,
      doneDismissed,
      documentsStage,
      portalFilenameSeen:
        portalFilenameSeen ||
        isAltinbasExistingUploadProved(uploadedSlotProof),
    })) {
      logger.warn(
        `[altinbas][ui] Documents: ${tag} upload proof başarısız` +
        ` (doneDismissed=${doneDismissed}, documentsStage=${documentsStage},` +
        ` portalFilenameSeen=${portalFilenameSeen},` +
        ` contentReferences=${uploadedSlotProof.contentReferenceCount})`,
      );
      continue;
    }
    uploaded.push(tag);
    logger.info(
      `[altinbas][ui] Documents: ${tag} upload tamamlandı` +
      ` (proof=${
        uploadedSlotProof.contentReferenceCount > 0
          ? "content_reference"
          : portalFilenameSeen
            ? "exact_filename"
            : "lightning_done_stage"
      })`,
    );
  }
  return uploaded;
}

// ---------------------------------------------------------------------------
// Orchestrator
// ---------------------------------------------------------------------------
async function readAltinbasApplicationRows(page: any): Promise<string[]> {
  const rowHosts = page.locator("c-application-table-row-component");
  return rowHosts.evaluateAll((hosts: Element[]) =>
    hosts.map((host) => {
      const parts: string[] = [];
      const seen = new Set<Node>();
      const stack: Node[] = [host];
      while (stack.length > 0) {
        const current = stack.pop();
        if (!current || seen.has(current)) continue;
        seen.add(current);
        if (current.nodeType === 3) {
          const text = (current.textContent || "").replace(/\s+/g, " ").trim();
          if (text) parts.push(text);
          continue;
        }
        if (current.nodeType === 1) {
          const shadowRoot = (current as Element).shadowRoot;
          if (shadowRoot) stack.push(shadowRoot);
        }
        for (
          let childIndex = current.childNodes.length - 1;
          childIndex >= 0;
          childIndex--
        ) {
          const child = current.childNodes.item(childIndex);
          if (child) stack.push(child);
        }
      }
      return parts.join(" ").replace(/\s+/g, " ").trim();
    }),
  ).catch(() => [] as string[]);
}

// Returns TRUE if it found an existing Signed-Up (half-finished) application and
// handled it (completed / uploaded / already-done / attempted). Returns FALSE if
// NO existing application row was found — the caller should then fall through to
// the normal create + flow-replay path (fresh student). This makes the flag safe
// to enable globally: existing half-finished apps get finished (with documents);
// brand-new students keep the existing create path unchanged.
async function completeApplicationUI(
  page: any,
  rt: FlowRuntime,
  profile: SubmitProfile,
  files: SubmitFiles,
  dryRun: boolean,
  result: SubmitResult,
  screenshots: string[],
  options: {
    afterProgramCommit?: boolean;
    uploadRefreshAttempted?: boolean;
    portalProgramName?: string;
  } = {},
): Promise<boolean> {
  // Push captures into submit()'s own screenshots array so its
  // `if (screenshots.length) result.screenshots = screenshots;` picks them up.
  const shots: string[] = screenshots;
  const targetProgramName =
    options.portalProgramName || profile.programName || "";
  const progFold = fold(targetProgramName);
  // "Core" program (strip Bachelor/Master/of/in/English…) → robust row match,
  // e.g. profile "Bachelor of Electrical and Electronics Engineering (English)"
  // matches a portal row labelled "Electrical and Electronics Engineering (in English)".
  const coreProg = altinbasApplicationCoreProgram(targetProgramName);

  // A brand-new Program commit can take time to surface in My Applications.
  // Before a commit, one probe is enough: no row means the normal create path
  // should continue. After a commit, refresh and re-filter a bounded number of
  // times; only an absent row is retried, never an ambiguous visible row.
  const maxLookupAttempts = options.afterProgramCommit ? 4 : 1;
  const expectedNames = [
    fold(`${profile.firstName} ${profile.lastName}`),
    fold(`${profile.lastName} ${profile.firstName}`),
  ];
  const expectedPrograms = [coreProg, progFold];
  const expectedTrack = parseTrack(targetProgramName);
  let completeBtns: any = null;
  let nBtns = 0;
  let chosenIdx = -1;
  let rowTexts: string[] = [];
  let allApplicationRows: string[] = [];
  let existingApplication = decideAltinbasExistingApplication(
    [],
    expectedNames,
    expectedPrograms,
    expectedTrack,
  );
  let lookupDecision: ReturnType<typeof decideAltinbasSignedUpLookup> = "missing";
  for (let attempt = 0; attempt < maxLookupAttempts; attempt++) {
    await page.goto(MY_APPS_URL, { waitUntil: "domcontentloaded", timeout: 60000 }).catch(() => {});
    await page.waitForTimeout(SF_HYDRATION_MS);
    try {
      const search = page.getByPlaceholder(/search by applicant/i).first();
      if (await search.count().catch(() => 0)) {
        await search.click().catch(() => {});
        await search.fill("").catch(() => {});
        await search.pressSequentially(profile.lastName || profile.firstName || "", { delay: 50 }).catch(() => {});
        await page.waitForTimeout(3500);
      }
    } catch {/* tolerate */}

    allApplicationRows = await readAltinbasApplicationRows(page);
    existingApplication = decideAltinbasExistingApplication(
      allApplicationRows.map(fold),
      expectedNames,
      expectedPrograms,
      expectedTrack,
    );
    if (existingApplication.outcome === "submitted") {
      markAltinbasVerifiedSuccess(result, "exact_application_row");
      result.detail =
        "Altınbaş[ui]: hedef başvuru portalda Evaluation durumunda doğrulandı";
      logger.info(`[altinbas][ui] ${result.detail}`);
      result.screenshots = shots;
      return true;
    }
    if (
      existingApplication.outcome === "ambiguous" ||
      existingApplication.outcome === "unknown_status"
    ) {
      result.detail =
        `Altınbaş[ui]: hedef program satırı var fakat durumu güvenle sınıflandırılamadı` +
        ` (decision=${existingApplication.outcome}, applicationRowCount=${allApplicationRows.length})`;
      logger.warn(`[altinbas][ui] ${result.detail}`);
      result.screenshots = shots;
      return true;
    }

    // Playwright getByRole pierces Salesforce shadow DOM; raw row text remains
    // in memory and is never logged.
    completeBtns = page.getByRole("button", { name: /^\s*Complete Application\s*$/i });
    nBtns = await completeBtns.count().catch(() => 0);
    // Preserve the pre-existing resume-path hydration allowance. Post-commit
    // lookup instead uses a full reload + re-filter on each bounded attempt.
    if (!nBtns && !options.afterProgramCommit) {
      await page.waitForTimeout(SF_HYDRATION_MS);
      nBtns = await completeBtns.count().catch(() => 0);
    }
    rowTexts = [];
    for (let i = 0; i < nBtns; i++) {
      try {
        rowTexts.push(await completeBtns.nth(i).evaluate((button: Element) => {
        let node: Element | null = button;
        let boundary: Element | null = null;
        for (let depth = 0; depth < 20 && node; depth++) {
          if (
            node.tagName === "C-APPLICATION-TABLE-ROW-COMPONENT" ||
            node.matches("tr,[role='row']")
          ) {
            boundary = node;
            break;
          }
          const root = node.getRootNode() as ShadowRoot | Document;
          node =
            node.parentElement ||
            ("host" in root ? root.host : null);
        }
        if (!boundary) return "";
        const parts: string[] = [];
        const seen = new Set<Node>();
        const stack: Node[] = [boundary];
        let totalLength = 0;
        while (stack.length > 0 && totalLength < 20_000) {
          const current = stack.pop();
          if (!current || seen.has(current)) continue;
          seen.add(current);
          if (current.nodeType === 3) {
            const text = (current.textContent || "").replace(/\s+/g, " ").trim();
            if (text) {
              parts.push(text);
              totalLength += text.length + 1;
            }
            continue;
          }
          if (current.nodeType === 1) {
            const shadowRoot = (current as Element).shadowRoot;
            if (shadowRoot) stack.push(shadowRoot);
          }
          for (
            let childIndex = current.childNodes.length - 1;
            childIndex >= 0;
            childIndex--
          ) {
            const child = current.childNodes.item(childIndex);
            if (child) stack.push(child);
          }
        }
        return parts.join(" ").replace(/\s+/g, " ").trim();
        }));
      } catch {
        rowTexts.push("");
      }
    }
    const rowDecision = decideAltinbasApplicationRow(
      rowTexts.map(fold),
      expectedNames,
      expectedPrograms,
      expectedTrack,
    );
    chosenIdx = rowDecision.index;
    if (
      rowDecision.reason === "missing" &&
      nBtns > 1
    ) {
      lookupDecision =
        options.afterProgramCommit && attempt + 1 < maxLookupAttempts
          ? "retry"
          : "missing";
      logger.info(
        `[altinbas][ui] Signed-Up lookup` +
        ` (afterCommit=${options.afterProgramCommit === true}, attempt=${attempt + 1}/${maxLookupAttempts},` +
        ` completeButtonCount=${nBtns}, readableRows=${rowTexts.filter(Boolean).length},` +
        ` targetMatches=0, decision=${lookupDecision})`,
      );
      if (lookupDecision !== "retry") break;
      await page.waitForTimeout(4000);
      continue;
    }
    lookupDecision = decideAltinbasSignedUpLookup({
      completeButtonCount: nBtns,
      chosenIndex: chosenIdx,
      attempt,
      maxAttempts: maxLookupAttempts,
    });
    logger.info(
      `[altinbas][ui] Signed-Up lookup` +
      ` (afterCommit=${options.afterProgramCommit === true}, attempt=${attempt + 1}/${maxLookupAttempts},` +
      ` completeButtonCount=${nBtns}, readableRows=${rowTexts.filter(Boolean).length},` +
      ` decision=${lookupDecision})`,
    );
    if (lookupDecision !== "retry") break;
    await page.waitForTimeout(4000);
  }

  if (lookupDecision === "missing") {
    if (existingApplication.outcome === "draft") {
      result.detail =
        "Altınbaş[ui]: hedef Signed-Up satırı doğrulandı fakat Complete Application eylemi bulunamadı";
      logger.warn(`[altinbas][ui] ${result.detail}`);
      result.screenshots = shots;
      return true;
    }
    result.detail = options.afterProgramCommit
      ? "Altınbaş[ui]: Program commit sonrası Signed-Up satırı bounded refresh ile görünmedi"
      : `Altınbaş[ui]: My Applications'ta hedef 'Complete Application' (Signed Up) başvuru yok`;
    logger.warn(`[altinbas][ui] ${result.detail}`);
    if (MUTATION_CANARY) {
      result.detail = "Altınbaş[canary]: blocked — hedef Complete Application satırı bulunamadı";
      result.screenshots = shots;
      return true;
    }
    const s = await captureScreen(page, "ui-no-complete-btn"); if (s) shots.push(s);
    return false;
  }
  if (lookupDecision === "ambiguous") {
    result.detail =
      `Altınbaş[ui]: hedef başvuru tekil ad+program kanıtıyla seçilemedi` +
      ` (completeButtonCount=${nBtns}, readableRows=${rowTexts.filter(Boolean).length})`;
    logger.warn(`[altinbas][ui] ${result.detail}`);
    result.screenshots = shots;
    return true;
  }
  logger.info(
    `[altinbas][ui] portal hedefi doğrulandı` +
    ` (proof=${nBtns === 1 ? "single_complete_button" : "unique_name_program"},` +
    ` completeButtonCount=${nBtns})`,
  );

  await completeBtns.nth(chosenIdx).scrollIntoViewIfNeeded().catch(() => {});
  let clicked = false;
  try {
    await completeBtns.nth(chosenIdx).click({ timeout: 15000 });
    clicked = true;
  } catch {
    try { await completeBtns.nth(chosenIdx).click({ force: true, timeout: 8000 }); clicked = true; } catch {/* fall through */}
  }
  if (!clicked) {
    result.detail = "Altınbaş[ui]: 'Complete Application' butonu tıklanamadı";
    logger.warn(`[altinbas][ui] ${result.detail}`);
    const s = await captureScreen(page, "ui-click-fail"); if (s) shots.push(s);
    // Row exists but couldn't open it — do NOT create a duplicate; report failure.
    return true;
  }
  await page.waitForTimeout(SF_HYDRATION_MS);
  const sOpened = await captureScreen(page, "ui-wizard-opened"); if (sOpened) shots.push(sOpened);
  logger.info("[altinbas][ui] Complete Application açıldı — wizard sürülüyor");

  if (MUTATION_CANARY) {
    await runSingleStepMutationCanary(page, profile, result);
    logger.warn(`[altinbas][canary] ${result.detail}`);
    result.screenshots = shots;
    return true;
  }

  // A normal dry-run is read-only. It may open the target wizard for discovery
  // but never fills, advances, saves, uploads or submits.
  if (dryRun) {
    const initial = await readWizardState(page);
    const missing = missingAltinbasPersonalFields(profile);
    result.detail =
      `Altınbaş[ui]: read_only_dry_run` +
      ` (aktif="${initial.step || "bilinmiyor"}", detector=${initial.reason},` +
      ` missing=${missing.length ? missing.join(",") : "none"})`;
    logger.info(`[altinbas][ui] ${result.detail}`);
    result.screenshots = shots;
    return true;
  }

  // 3) Drive the wizard STEP-BY-STEP until the Documents screen (identified by
  //    the exact SLDS Path stage marker. On a resumed application most fields
  //    are already prefilled; every transition is still proved before continuing.

  let reachedDocuments = false;
  let wizardFailure = "";
  wizardLoop: for (let step = 0; step < 7; step++) {
    const before = await readWizardState(page);
    logger.info(
      `[altinbas][ui] wizard adım#${step}: aktif="${before.step || "bilinmiyor"}"` +
      ` detector=${before.reason} fileInputs=${before.fileInputCount}`,
    );
    if (before.documentScreen) {
      reachedDocuments = true;
      break;
    }
    if (!before.step) {
      const validation = await readWizardValidation(page);
      wizardFailure =
        `Altınbaş[ui]: aktif wizard adımı okunamadı (detector=${before.reason})` +
        ` — validation=${validation.length ? JSON.stringify(validation) : "mesaj bulunamadı"}`;
      logger.warn(`[altinbas][ui] ${wizardFailure}`);
      break;
    }
    // Fill the specific step we're on before advancing.
    if (before.step === "Personal Information") {
      const personal = await fillPersonalUI(page, profile).catch((error) => ({
        ok: false,
        failures: [{
          ok: false,
          field: "personal",
          reason: error instanceof Error ? error.name : "unexpected_error",
        }],
      }));
      if (!personal.ok) {
        wizardFailure =
          `Altınbaş[ui]: Personal data_missing_or_unproved` +
          ` (${personal.failures.map((item) => `${item.field}:${item.reason}`).join(",")})`;
        logger.warn(`[altinbas][ui] ${wizardFailure}`);
        break;
      }
    }
    if (before.step === "Educational Information") {
      const education = await ensureEducationUI(page, profile).catch((error) => ({
        ok: false,
        reason: error instanceof Error ? error.name : "unexpected_error",
      }));
      if (!education.ok) {
        wizardFailure = `Altınbaş[ui]: Educational ${education.reason}`;
        logger.warn(`[altinbas][ui] ${wizardFailure}`);
        break;
      }
    }
    if (before.step === "Questionnaire") {
      const questionnaire = await fillQuestionnaireUI(page, profile).catch((error) => ({
        ok: false,
        reason: error instanceof Error ? error.name : "unexpected_error",
      }));
      if (!questionnaire.ok) {
        wizardFailure = `Altınbaş[ui]: Questionnaire ${questionnaire.reason}`;
        logger.warn(`[altinbas][ui] ${wizardFailure}`);
        break;
      }
    }
    if (before.step === "Completed") {
      wizardFailure = "Altınbaş[ui]: beklenmeyen Completed adımı; yeni submit kanıtlanmadı";
      logger.warn(`[altinbas][ui] ${wizardFailure}`);
      break;
    }
    await page.waitForTimeout(500);
    const flowVersionBeforeNext = rt.flowResponseVersion;
    const advanced = await clickWizardBtn(page, /^\s*Next\s*$/i);
    if (!advanced) {
      wizardFailure = `Altınbaş[ui]: adım#${step} için tekil/tıklanabilir 'Next' bulunamadı`;
      logger.warn(`[altinbas][ui] ${wizardFailure}`);
      break;
    }
    await page.waitForTimeout(SF_HYDRATION_MS);
    if (isAltinbasPostNextDuplicate({
      flowVersionBeforeNext,
      duplicatePassportVersion: rt.duplicatePassportVersion,
    })) {
      result.alreadyExists = true;
      result.detail =
        "Altınbaş: SKIPPED_DUPLICATE — portal aynı pasaport numarasıyla mevcut başvuru bulunduğunu doğruladı " +
        `(CheckDuplicateValidation, aktif="${before.step}")`;
      logger.info(
        `[altinbas][ui] duplicate-passport Flow validation` +
        ` (aktif="${before.step}", proof=post_next_flow_response)`,
      );
      result.screenshots = shots;
      return true;
    }
    const after = await readWizardState(page);
    if (after.documentScreen) {
      reachedDocuments = true;
      break;
    }
    const transition = classifyAltinbasWizardTransition(before.step, after.step);
    if (transition !== "advanced") {
      const validation = await readWizardValidation(page);
      wizardFailure =
        `Altınbaş[ui]: adım#${step} Next geçişi doğrulanamadı` +
        ` (before="${before.step}", after="${after.step || "bilinmiyor"}", verdict=${transition}, detector=${after.reason})` +
        ` — validation=${validation.length ? JSON.stringify(validation) : "mesaj bulunamadı"}`;
      logger.warn(`[altinbas][ui] ${wizardFailure}`);
      break wizardLoop;
    }
  }

  const sDocs = await captureScreen(page, reachedDocuments ? "ui-documents" : "ui-stuck");
  if (sDocs) shots.push(sDocs);
  if (!reachedDocuments) {
    result.detail = wizardFailure ||
      "Altınbaş[ui]: Documents ekranına ulaşılamadı (wizard adımları beklenenden farklı)";
    logger.warn(`[altinbas][ui] ${result.detail}`);
    result.screenshots = shots;
    return true;
  }
  // Targeted diagnostics boundary: exercise the already-approved resume path
  // only through Questionnaire → Documents so ALTINBAS_CAPTURE can record the
  // server-provided file-upload component state. Never select a local file,
  // click Done, advance Documents, or submit while this flag is active.
  if (DOCUMENTS_CAPTURE_PROBE) {
    result.detail = CAPTURE
      ? "Altınbaş[ui]: documents_capture_probe_complete — upload/submit yapılmadı"
      : "Altınbaş[ui]: documents_capture_probe_blocked — ALTINBAS_CAPTURE=1 gerekli";
    logger.info(`[altinbas][ui] ${result.detail}`);
    result.screenshots = shots;
    return true;
  }
  // The response interceptor normally finishes before the hydrated Documents
  // stage is visible. This bounded grace period also covers a final slow
  // response-body read without relying on DOM upload remnants.
  if (rt.uploadedDocumentSlots.size === 0) {
    await page.waitForTimeout(750);
  }
  const up = await uploadDocumentsUI(
    page,
    files,
    rt.uploadedDocumentSlots,
  );
  const missing = (["passport", "diploma", "transcript", "photo"] as const).filter((t) => !up.includes(t));
  if (missing.length) {
    result.missingDocuments = [...(result.missingDocuments ?? []), ...missing];
    result.detail =
      `Altınbaş[ui]: required document upload doğrulanamadı — ${missing.join(",")}`;
    logger.warn(`[altinbas][ui] ${result.detail}`);
    result.screenshots = shots;
    return true;
  }
  const refreshDecision = decideAltinbasUploadRefresh({
    serverUploadedSlots: [...rt.uploadedDocumentSlots],
    refreshAttempted: options.uploadRefreshAttempted === true,
  });
  if (refreshDecision === "reopen_once") {
    logger.info(
      `[altinbas][ui] Documents: local upload tamamlandı;` +
      ` recordsCV sunucu kanıtı için wizard bir kez yeniden açılıyor`,
    );
    await page.waitForTimeout(2_500);
    return completeApplicationUI(
      page,
      rt,
      profile,
      files,
      dryRun,
      result,
      screenshots,
      { ...options, uploadRefreshAttempted: true },
    );
  }
  if (refreshDecision === "fail_closed") {
    const serverMissing = (
      ["passport", "diploma", "transcript", "photo"] as const
    ).filter((slot) => !rt.uploadedDocumentSlots.has(slot));
    result.detail =
      `Altınbaş[ui]: upload sonrası recordsCV sunucu kanıtı eksik` +
      ` — ${serverMissing.join(",")}`;
    logger.warn(`[altinbas][ui] ${result.detail}`);
    result.screenshots = shots;
    return true;
  }

  if (dryRun) {
    result.detail = "Altınbaş[ui]: dry-run — Documents'a kadar dolduruldu, Submit GÖNDERİLMEDİ";
    logger.info(`[altinbas][ui] ${result.detail}`);
    const s = await captureScreen(page, "ui-dryrun-docs"); if (s) shots.push(s);
    result.screenshots = shots;
    return true;
  }

  // 4) Submit Application + success detection.
  if (!(await clickWizardBtn(page, /^\s*Submit Application\s*$/i))) {
    result.detail = "Altınbaş[ui]: tekil/tıklanabilir Submit Application bulunamadı";
    return true;
  }
  await page.waitForTimeout(SF_HYDRATION_MS);
  const successMessageSeen = await page.evaluate(() => {
    const roots: Array<Document | ShadowRoot> = [document];
    const parts: string[] = [];
    for (let index = 0; index < roots.length; index++) {
      roots[index].querySelectorAll("*").forEach((element: Element) => {
        if ((element as HTMLElement).shadowRoot) {
          roots.push((element as HTMLElement).shadowRoot!);
        }
        if (element.children.length === 0 && element.textContent) {
          parts.push(element.textContent);
        }
      });
    }
    return /created successfully|submitted successfully|application is created/i.test(
      parts.join(" "),
    );
  }).catch(() => false);
  const s2 = await captureScreen(page, successMessageSeen ? "ui-submit-message" : "ui-submit-unclear");
  if (s2) shots.push(s2);
  result.screenshots = shots;

  // Final proof is the exact applicant+programme row moving off Signed Up.
  await page.goto(MY_APPS_URL, { waitUntil: "domcontentloaded", timeout: 60000 }).catch(() => {});
  await page.waitForTimeout(SF_HYDRATION_MS);
  const search = page.getByPlaceholder(/search by applicant/i).first();
  if (await search.count().catch(() => 0)) {
    await search.fill(profile.lastName || profile.firstName || "").catch(() => {});
    await page.waitForTimeout(3_500);
  }
  const rows = await readAltinbasApplicationRows(page);
  const movedIdx = chooseAltinbasApplicationRow(
    rows.map(fold),
    [
      fold(`${profile.firstName} ${profile.lastName}`),
      fold(`${profile.lastName} ${profile.firstName}`),
    ],
    [coreProg, progFold],
    parseTrack(targetProgramName),
    false,
  );
  const moved =
    movedIdx >= 0 &&
    /Evaluation|Offer|Accepted|View Application/i.test(rows[movedIdx]) &&
    !/Signed Up|Complete Application/i.test(rows[movedIdx]);
  if (moved) {
    markAltinbasVerifiedSuccess(result, "exact_application_row");
    result.detail =
      "Altınbaş[ui]: Submit sonrası tekil ad+program satırı Signed Up dışına geçti (doğrulandı)";
    logger.info(`[altinbas][ui] ${result.detail}`);
  } else {
    result.detail =
      `Altınbaş[ui]: Submit sonrası başarı doğrulanamadı` +
      ` (successMessage=${successMessageSeen}, targetRow=${movedIdx >= 0})`;
    logger.warn(`[altinbas][ui] ${result.detail}`);
  }
  // Attempted completion on an existing row — handled (don't create a duplicate).
  return true;
}
// ===== END UI-DRIVEN COMPLETION =====

async function runFlowReplay(
  page: any,
  rt: FlowRuntime,
  profile: SubmitProfile,
  files: SubmitFiles,
  dryRun: boolean,
  result: SubmitResult,
  screenshots: string[],
): Promise<void> {
  // 1) Flow boot'unu bekle: serializedState ya startFlow/navigateFlow yanıtından
  //    ya da ilk navigateFlow REQUEST gövdesinden (FIX-1) yakalanır.
  for (let t = 0; t < 12 && (!rt.state || !rt.template); t++) {
    await page.waitForTimeout(1000);
  }

  // FIX-1 boot seed: Create New Application sonrası Term ekranı render olur ama
  // sayfa kendiliğinden navigateFlow atmayabilir. Term ekranında Next'e BİR KEZ
  // UI'dan tıkla → ilk gerçek navigateFlow tetiklenir → request interceptor
  // template + initial serializedState'i yakalar; sonrası tamamen replay.
  if (!rt.state || !rt.template) {
    logger.info(
      "[altinbas] flow boot henüz yakalanmadı — Term ekranında UI Next ile ilk navigateFlow tetikleniyor (boot seed)",
    );
    try {
      // Yalnız GÖRÜNÜR ve tam "Next" metinli footer butonu (SLDS varyantlarına
      // karşı dar filtre); kaç aday bulunduğu teşhis için loglanır.
      const nextBtns = page
        .locator("button:visible")
        .filter({ hasText: /^\s*Next\s*$/i });
      const n = await nextBtns.count().catch(() => 0);
      logger.info(`[altinbas] boot-seed: görünür "Next" buton adayı=${n}`);
      if (n > 0) await nextBtns.last().click({ force: true, timeout: 8000 });
    } catch (e) {
      logger.warn(`[altinbas] boot-seed Next tıklanamadı: ${(e as Error).message?.slice(0, 200)}`);
    }
    for (let t = 0; t < 20 && (!rt.state || !rt.template); t++) {
      await page.waitForTimeout(1000);
    }
  }

  if (!rt.state || !rt.template) {
    result.detail =
      "Altınbaş: flow boot yakalanamadı — serializedState/template yok (Create New Application flow'u başlatmadı mı?)";
    logger.warn(`[altinbas] ${result.detail}`);
    const shot = await captureScreen(page, "flow-boot-missing");
    if (shot) screenshots.push(shot);
    return;
  }
  logger.info(
    `[altinbas] flow boot OK: stateLen=${rt.state.length} records=${rt.records.size} bootStage=${readStageFromRaw(rt.lastRaw) ?? "?"}`,
  );
  dumpRecords(rt, "boot");

  /**
   * Yanıtı denetle: ERROR veya isDuplicatePassport → DUR (true döndür).
   * FIX-14: CheckDuplicateValidation "already exists" sinyali self-referans
   * DEĞİLDİR — önceki başarısız run'ın SF'te bıraktığı dangling Application__c
   * kaydına karşı ateşlenir. alreadyExists=true → worker retry etmez.
   * Gerçek ilk-başvuru duplicate'i → Program adımında isAlreadyAppliedProgram.
   */
  // FIX-6 teşhis: bu run'da oluşturulduğu kanıtlı başvuru Id'leri — explicit
  // "applicationId" anahtarı + commit yanıtlarında İLK KEZ görülen a02 kayıtları
  // (çift-create şüphesi uyarısı için).
  const runCreatedAppIds = new Set<string>();
  // FIX-10 (round 2): SALT ham-regex kaynaklı a02'ler bağlanamaz — ayrı zayıf
  // (teşhis) kümede tutulur; ancak explicit anahtar bağlamıyla doğrulanırsa
  // commit-trusted'a yükselir. runCreatedAppIds artık YALNIZ parse-edilmiş
  // rt.records diff'inden dolar (güvenilir katman).
  const rawCommitA02 = new Set<string>();
  const ownAppIds = (): Set<string> => new Set([...rt.explicitAppIds, ...runCreatedAppIds]);

  // FIX-14: post-commit guard herhangi bir adımda bloklarsa, bu run'da
  // oluşturulan Application__c ID'leri SF'te dangling kalabilir.
  // rollbackIfNeeded tüm post-commit adım guard'larında (commit döngüsü,
  // Personal, Educational, Questionnaire, Documents, FINISH) çağrılır.
  const rollbackIfNeeded = async (tag: string): Promise<void> =>
    rollbackDanglingApps(page, rt, result, tag, runCreatedAppIds);

  // Duplicate-passport can mean an existing Signed-Up draft. The caller may
  // route it only through completeApplicationUI's exact row proof.
  let _duplicateSignal = false;

  const guard = (raw: string, tag: string): boolean => {
    if (isDuplicatePassport(raw)) {
      _duplicateSignal = true;
      logger.warn(
        `[altinbas] isDuplicatePassport @${tag} — verified UI resume required`,
      );
      return true;
    }
    if (flowHasError(raw)) {
      result.detail =
        `Altınbaş flow ERROR @${tag}: ` +
        redactAltinbasLog(raw).replace(/\s+/g, " ").slice(0, 500);
      logger.warn(`[altinbas] ${result.detail}`);
      return true;
    }
    return false;
  };

  // Stage-aware başlangıç: boot-seed UI Next tıklaması ekranı ilerletmiş
  // olabilir (örn. Term default'la Degree'ye geçti). Okunabilen boot stage'e
  // göre geçilmiş adımlar ATLANIR; stage okunamıyorsa (-1) Term'den başlanır.
  let curRank = stageRank(readStageFromRaw(rt.lastRaw));
  if (curRank > 0) {
    logger.info(`[altinbas] boot stage rank=${curRank} — önceki adımlar atlanacak`);
  } else if (curRank === -1) {
    logger.info("[altinbas] boot stage OKUNAMADI — replay Term'den başlıyor (ilk yanıt stage'i hizalar)");
  }

  /**
   * Stage geri gittiyse (desync) fail-visible. Aynı rank tolere edilir
   * (commit döngüsü stage'i değiştirmeyebilir); okunamayan stage tolere edilir.
   */
  const noteStage = (r: string, tag: string): boolean => {
    const nr = stageRank(readStageFromRaw(r));
    if (nr >= 0 && curRank >= 0 && nr < curRank) {
      result.detail = `Altınbaş: flow DESYNC @${tag} — stage geri gitti (rank ${curRank}→${nr}, stage="${readStageFromRaw(r)}")`;
      logger.warn(`[altinbas] ${result.detail}`);
      return true;
    }
    if (nr >= 0) curRank = nr;
    return false;
  };

  let raw = rt.lastRaw;
  let committedPortalProgramName: string | undefined;

  // 2) TERM (NEXT) — nf=0 YASAK; captured constant öncelikli (FIX-3).
  if (curRank <= 0) {
    const term = pickTermOption(rt);
    logger.info(`[altinbas] Term: "${term.label}" (${term.id})`);
    raw = await postNavigateFlow(page, rt, "NEXT", buildTermFields(term), "term");
    if (flowHasError(raw)) {
      logger.warn(`[altinbas] Term REDDEDİLDİ — sent term=${term.id} label="${term.label}"`);
    }
    if (guard(raw, "Term") || noteStage(raw, "Term")) return;
  } else {
    logger.info("[altinbas] Term adımı atlandı (boot stage ilerisinde)");
  }

  // 3) DEGREE (NEXT)
  if (curRank <= 1) {
    const degree = pickDegreeOption(rt, profile.level || "");
    if (!degree) {
      result.detail = `Altınbaş: Degree seçeneği bulunamadı (level="${profile.level}") — PhD Id'si dinamik bulunamadı ve captured fallback henüz yok (ilk PhD ALTINBAS_CAPTURE run'ında yakalanacak)`;
      logger.warn(`[altinbas] ${result.detail}`);
      return;
    }
    logger.info(`[altinbas] Degree: "${degree.label}" (${degree.id})`);
    raw = await postNavigateFlow(page, rt, "NEXT", buildDegreeFields(degree), "degree");
    if (flowHasError(raw)) {
      logger.warn(`[altinbas] Degree REDDEDİLDİ — sent degree=${degree.id} label="${degree.label}"`);
    }
    if (guard(raw, "Degree") || noteStage(raw, "Degree")) return;
  } else {
    logger.info("[altinbas] Degree adımı atlandı (boot stage ilerisinde)");
  }

  // 4) PROGRAM (NEXT) — eligible listeden eşle
  // 5) CONTINUE_AFTER_COMMIT (×N, fields:[]) — başvuru kaydı burada OLUŞUR.
  if (curRank <= 2) {
    const { record: prog, selected, candidates } = pickProgramRecord(rt, profile);
    if (!prog || !selected) {
      if (
        classifyProfileLevel(profile.level || "") === "bachelor" &&
        isAltinbasKnownLiveBachelorProgram(profile.programName || "")
      ) {
        result.alreadyExists = true;
        result.detail =
          "Altınbaş: SKIPPED_DUPLICATE — güncel Bachelor programı bu öğrenciye özel eligible listeden çıkarılmış";
        logger.info(`[altinbas] ${result.detail}`);
        return;
      }
      result.programMissing = true;
      result.detail = `Altınbaş: program eligible listede bulunamadı: "${profile.programName}"`;
      if (candidates.length) {
        result.resolution = "not_in_dropdown";
        result.availablePrograms = candidates;
        result.requestedProgram = { name: profile.programName };
      }
      return;
    }
    if (!selected.enabled) {
      result.programFull = true;
      result.requestedProgram = {
        value: selected.value,
        name: selected.name,
      };
      result.openPrograms = candidates;
      result.detail =
        `Altınbaş: QUOTA_FULL — "${selected.name}" programının kontenjanı dolu`;
      logger.info(`[altinbas] ${result.detail}`);
      return;
    }
    committedPortalProgramName = selected.name;
    raw = await postNavigateFlow(page, rt, "NEXT", buildProgramFields(prog), "program");
    // Gerçek ilk-başvuru duplicate'i: Program NEXT yanıtında AlreadyApplicationError
    // kayıt OLUŞTURULMADAN ÖNCE dolar (öğrenci bu programa gerçekten başvurmuş).
    // isDuplicatePassport (dangling SF kaydı) ise guard() içinde yakalanır.
    if (isAlreadyAppliedProgram(raw)) {
      result.alreadyExists = true;
      result.detail =
        "Altınbaş: SKIPPED_DUPLICATE — öğrenci bu programa daha önce başvurmuş (Program adımı AlreadyApplicationError)";
      logger.info(`[altinbas] ${result.detail}`);
      return;
    }
    if (guard(raw, "Program") || noteStage(raw, "Program")) return;

    // FIX-6: commit ÖNCESİ görülen a02 kayıtları (boot/program availability'leri)
    // baseline — commit yanıtlarında İLK KEZ beliren a02'ler bu run'da OLUŞAN
    // başvuru kayıtlarıdır (self-duplicate ayrımının kanıt kaynağı).
    // FIX-9: baseline rt.records'a EK olarak ham-tarama a02 evrenini (seenA02)
    // da kapsar — yanıt JSON parse edilemese bile commit'te İLK KEZ beliren
    // başvuru Id'si yakalanır (2199'da walk hiç çalışmamış, Id'ler boş gitmişti).
    const a02Before = new Set([
      ...[...rt.records.keys()].filter((id) => id.startsWith("a02")),
      ...rt.seenA02,
    ]);
    // FIX-12: availability baseline'ı rt'ye kaydet — Educational guard'ında
    // fallback adayını filtrelemek için (pre-commit a02 = availability, not application).
    for (const id of a02Before) rt.knownAvailabilityIds.add(id);

    for (let i = 0; i < 4 && !/Personal Information/i.test(raw); i++) {
      const ownBefore = ownAppIds();
      raw = await postNavigateFlow(page, rt, "CONTINUE_AFTER_COMMIT", [], `commit${i + 1}`);
      for (const id of rt.records.keys()) {
        if (id.startsWith("a02") && !a02Before.has(id)) runCreatedAppIds.add(id);
      }
      // FIX-9: JSON parse edilemese de commit YANITININ KENDİ gövdesinde ilk
      // kez görülen a02'ler run-created sayılır (global seenA02 diff'i DEĞİL —
      // eşzamanlı flow-dışı trafikteki a02'ler yanlış atfedilmesin).
      // FIX-10 (round 2): ham-regex a02'ler tam 15/18 char (13-17 token parçası
      // eleme — 2199'da a02Q3107ut6nun1 böyle doğmuştu) ama artık DOĞRUDAN
      // bağlanabilir kümeye GİRMEZ: rawCommitA02 salt teşhis; bağlanma yalnız
      // parse-edilmiş records diff'i (üstteki döngü) veya explicit anahtar
      // bağlamıyla doğrulama üzerinden. Adaylar loglanır (capture diff'i).
      const a02Candidates = [
        ...new Set(raw.match(/\ba02[a-zA-Z0-9]{12}(?:[a-zA-Z0-9]{3})?\b/g) ?? []),
      ];
      logger.info(
        `[altinbas] commit${i + 1} yanıtı a02 adayları: padding'li=[${a02Candidates.filter(hasSfPadding).join(",") || "-"}] padding'siz=[${a02Candidates.filter((id) => !hasSfPadding(id)).join(",") || "-"}]`,
      );
      for (const id of a02Candidates) {
        if (!a02Before.has(id)) rawCommitA02.add(id);
      }
      // FIX-6 teşhis (hipotez 1: çift-create): bu commit YENİ bir başvuru Id'si
      // yarattıysa ve öncesinde zaten bir tane vardıysa yüksek sesle uyar.
      const newIds = [...ownAppIds()].filter((id) => !ownBefore.has(id));
      if (newIds.length > 0 && ownBefore.size > 0) {
        logger.warn(
          `[altinbas] ÇİFT-CREATE ŞÜPHESİ @commit${i + 1} — yeni applicationId ${newIds.join(",")} (önceki: ${[...ownBefore].join(",")}); insan akışında commit sayısını ALTINBAS_CAPTURE ile karşılaştırın`,
        );
      }
      if (guard(raw, `commit${i + 1}`) || noteStage(raw, `commit${i + 1}`)) {
        if (_duplicateSignal) {
          _duplicateSignal = false;
          if (UI_COMPLETE) {
            break; // exact row proof is handled by completeApplicationUI below
          }
          result.alreadyExists = true;
          result.detail =
            `Altınbaş: CheckDuplicateValidation @commit${i + 1}; ` +
            `verified UI completion disabled, unsafe legacy resume blocked`;
          logger.warn(`[altinbas] ${result.detail}`);
        }
        await rollbackIfNeeded(`commit${i + 1}`);
        return;
      }
    }
    if (!/Personal Information/i.test(raw)) {
      logger.warn(
        `[altinbas] commit sonrası Personal Information görünmedi (stage=${readStageFromRaw(raw) ?? "?"}) — yine de devam ediliyor`,
      );
    }
    if (rt.ids.applicationId) {
      logger.info(`[altinbas] applicationId=${rt.ids.applicationId} applicantId=${rt.ids.applicantId ?? "?"}`);
    }
  } else {
    logger.info("[altinbas] Program+commit adımları atlandı (boot stage ilerisinde)");
  }

  // Once the Program commit has created the Signed-Up row, switch to the real
  // Lightning UI for the remainder. This keeps Personal/Education/Documents
  // on the same verified state machine for both resumed and brand-new students.
  if (UI_COMPLETE) {
    const handled = await completeApplicationUI(
      page,
      rt,
      profile,
      files,
      dryRun,
      result,
      screenshots,
      {
        afterProgramCommit: true,
        portalProgramName: committedPortalProgramName,
      },
    );
    if (!handled) {
      result.detail =
        "Altınbaş[ui]: Program commit sonrası Signed-Up satırı doğrulanamadı; duplicate riski nedeniyle durduruldu";
      await rollbackIfNeeded("ui-row-not-found");
    }
    return;
  }

  // The replay completion half cannot prove document uploads or the final UI
  // state. It is retained only as diagnostic history; production completion
  // must opt into the verified Lightning UI state machine.
  result.detail =
    "Altınbaş: verified UI completion disabled (ALTINBAS_UI_COMPLETE=1 gerekli); " +
    "uydurma/kanıtsız legacy Personal→FINISH akışı çalıştırılmadı";
  logger.warn(`[altinbas] ${result.detail}`);
  await rollbackIfNeeded("ui-complete-disabled");
  return;

  // 6) PERSONAL (NEXT) — 46 alan; ISO tarih + 3'lü ülke picklist + kod-prefix telefon
  if (curRank <= 3) {
    raw = await postNavigateFlow(page, rt, "NEXT", buildPersonalFields(profile), "personal");
    if (guard(raw, "Personal") || noteStage(raw, "Personal")) {
      if (_duplicateSignal) {
        _duplicateSignal = false;
        result.alreadyExists = true;
        result.detail =
          "Altınbaş: CheckDuplicateValidation @Personal; unsafe legacy resume blocked";
        logger.warn(`[altinbas] ${result.detail}`);
        await rollbackIfNeeded("personal");
        return;
      } else {
        await rollbackIfNeeded("personal");
        return;
      }
    }
  } else {
    logger.info("[altinbas] Personal adımı atlandı (boot stage ilerisinde)");
  }

  // 7) EDUCATIONAL (NEXT) — boş listeler + ID binding'leri
  if (curRank <= 4) {
    // FIX-8: liste binding'leri BU RUN'ın gerçek başvuru Id'sini taşımalı.
    // rt.ids.applicationId a02 prefix fallback'iyle boot/program availability
    // kaydına kirlenebilir (FIX-6 dersi) — bu run'da oluşturulduğu KANITLI Id
    // (explicit "applicationId" anahtarı > commit'te ilk görülen a02) varsa onu bağla.
    // FIX-9 (review sertleştirmesi): öncelik run-proven (commit-diff) > explicit.
    // explicitAppIds yalnız flow-controller yanıtlarından dolar ama yine de
    // ESKİ taslak Id'leri taşıyabilir; commit'te doğduğu KANITLI Id her zaman önce.
    // FIX-10 (round 2): GÜVEN KATMANLARI. Bağlanabilir adaylar yalnız:
    //  - commit-trusted: parse-edilmiş records diff'i (runCreatedAppIds) ∪
    //    explicit anahtar bağlamıyla doğrulanmış ham commit adayları
    //    (rawCommitA02 ∩ explicitAppIds — commit gövdesinde doğdu + key-context);
    //  - explicit: flow yanıtlarında "applicationId":"..." anahtarıyla görülen.
    // SALT ham-regex (zayıf) adaylar ASLA bağlanmaz (2199: a02Q3107ut6nun1
    // böyle bağlanıp validation düşürmüştü) — yalnız WARN + capture yönlendirmesi.
    // Padding yumuşak sıralama: padding'li commit > padding'li explicit >
    // padding'siz commit > padding'siz explicit (commit>explicit FIX-9 kararı:
    // explicit eski taslak taşıyabilir).
    const commitTrusted = [
      ...new Set([
        ...runCreatedAppIds,
        ...[...rawCommitA02].filter((id) => rt.explicitAppIds.has(id)),
      ]),
    ].filter(isSfIdShape);
    const explicitAll = [...rt.explicitAppIds].filter(isSfIdShape);
    const provenAppId =
      commitTrusted.filter(hasSfPadding).at(-1) ??
      explicitAll.filter(hasSfPadding).at(-1) ??
      commitTrusted.at(-1) ??
      explicitAll.at(-1);
    const weakOnly = [...rawCommitA02].filter(
      (id) => !runCreatedAppIds.has(id) && !rt.explicitAppIds.has(id),
    );
    if (weakOnly.length) {
      logger.warn(
        `[altinbas] SALT ham-taramada görülen a02 adayları BAĞLANMADI (zayıf kanıt): [${weakOnly.join(",")}] — gerçek Id için ALTINBAS_CAPTURE=1 commit dump'ına bakın`,
      );
    }
    if (!provenAppId) {
      logger.warn(
        `[altinbas] Güvenilir applicationId adayı YOK (commitTrusted=[] explicit=[]) — prefix-fallback'e düşülecek; capture ile insan-payload diff önerilir`,
      );
    } else if (!hasSfPadding(provenAppId!)) {
      logger.warn(
        `[altinbas] applicationId adayı 0000-padding'siz: ${provenAppId} (şüpheli format — padding'li aday yoktu; commit=[${commitTrusted.join(",") || "-"}] explicit=[${explicitAll.join(",") || "-"}])`,
      );
    }
    if (provenAppId && rt.ids.applicationId !== provenAppId) {
      logger.info(
        `[altinbas] FIX-8: applicationId düzeltildi ${rt.ids.applicationId ?? "?"} → ${provenAppId} (bu run'da oluşturulan kayıt)`,
      );
      rt.ids.applicationId = provenAppId;
    }
    // FIX-11/FIX-12/FIX-13: commitTrusted ve explicit boşsa fallback'i değerlendir.
    // Öncelik:
    //  1. commitTrusted / explicit → provenAppId (yukarıda çözüldü)
    //  2. FIX-13: rt.ids.applicationId (commit sonrası prefix-fallback'te stored) —
    //     hasSfPadding geçiyorsa DOĞRUDAN GÜVEN; availability kontrolü YAPILMAZ.
    //     Gerekçe: application önceki bir run'dan rt.records'ta (a02Before) görünmüş
    //     olabilir → knownAvailabilityIds'e girmiş olabilir; bu onu availability
    //     yapmaz, FIX-12'nin availability filtresi bu durumda hatalıydı.
    //  3. FIX-12: rawCommitA02 havuzu; hasSfPadding + !knownAvailabilityIds ile filtrele
    //     (tek geçerli aday). rt.ids.applicationId yoksa veya padding'siz ise bu devreye girer.
    //  4. ABORT: hiçbiri geçmezse; teşhis logu ekle.
    if (!provenAppId) {
      const fallback = rt.ids.applicationId;
      const fallbackPadded = !!fallback && hasSfPadding(fallback!);
      if (fallbackPadded) {
        // FIX-13: commit-sonrası stored değer — hasSfPadding yeterli güvence.
        logger.info(
          `[altinbas] FIX-13: applicationId=${fallback} (from-post-commit-stored;` +
          ` inAvailability=${rt.knownAvailabilityIds.has(fallback!)})`,
        );
        // rt.ids.applicationId zaten doğru — değişiklik gerekmez.
      } else {
        // FIX-12: geniş aday havuzu, availability filtreli.
        const rawCandidates = [
          ...(fallback ? [fallback] : []),
          ...[...rawCommitA02],
        ];
        const trustworthy = [...new Set(rawCandidates)]
          .filter((id): id is string => typeof id === "string")
          .filter(isSfIdShape)
          .filter(hasSfPadding)
          .filter((id) => !rt.knownAvailabilityIds.has(id));
        if (trustworthy.length === 1) {
          rt.ids.applicationId = trustworthy[0];
          logger.info(
            `[altinbas] FIX-12: applicationId=${trustworthy[0]} (from-fallback-trusted, tek geçerli SF-a02;` +
            ` availability-filtresi: ${rt.knownAvailabilityIds.size} id; fallback=${fallback ?? "null"})`,
          );
        } else {
          logger.warn(
            `[altinbas] FIX-13 teşhis: runState.applicationId=${fallback ?? "null"}` +
            ` hasSfPadding=${fallbackPadded}` +
            ` inAvailability=${fallback ? rt.knownAvailabilityIds.has(fallback!) : false}` +
            ` trustworthy=[${trustworthy.join(",")}]` +
            ` commitTrusted=[${commitTrusted.join(",")}] explicit=[${explicitAll.join(",")}]`,
          );
          throw new Error(
            `altinbas Educational ABORT (FIX-11): applicationId Application__c/commit'ten çözülemedi` +
            ` (commitTrusted=[] explicit=[] fallback=${fallback ?? "null"}` +
            ` trustworthy=[${trustworthy.join(",")}])` +
            ` — ALTINBAS_CAPTURE=1 ile commit dump'ını inceleyip Application__c alanını doğrulayın`,
          );
        }
      }
    }
    // FIX-8: dört binding'in TAMAMI için deterministik kaynak seçimi —
    // explicit anahtar (yanıtlarda "contactId":"003..." gibi) > prefix fallback
    // (ilk görülen 003/001/a02, kirlenebilir). applicationId'de run-kanıtlı Id önce.
    const idKeys = ["applicantId", "applicationId", "accountId", "contactId"] as const;
    const effIds: FlowIds = {};
    const provenance: string[] = [];
    for (const k of idKeys) {
      const explicit = rt.explicitIds[k];
      // FIX-9: son çare = ham-tarama (flow-dışı aura trafiği dahil; applicant-
      // detay sayfası Contact/Account Id'lerini taşır). applicationId'de
      // raw-scan fallback YOK — a02 evreni availability kayıtlarıyla kirli,
      // yalnız run-kanıtlı (commit diff) veya explicit değer bağlanır.
      const rawScan = k === "applicationId" ? undefined : rt.scanIds[k];
      const v =
        k === "applicationId" ? (provenAppId ?? explicit ?? rt.ids[k]) : (explicit ?? rt.ids[k] ?? rawScan);
      effIds[k] = v;
      const src =
        k === "applicationId" && provenAppId
          ? commitTrusted.includes(provenAppId!)
            ? "commit-raw"
            : "run-proven"
          : explicit
            ? `explicit(${rt.explicitIdSource[k] ?? "flow"})`
            : rt.ids[k]
              ? "prefix-fallback"
              : rawScan
                ? "raw-scan"
                : "YOK";
      provenance.push(`${k}=${v ?? "?"}[${src}]`);
      // FIX-9: flow yanıtıyla doğrulanmamış (aura-explicit/raw-scan) binding'i
      // yine de bağlarız (elimizdeki en iyi veri) ama yüksek sesle işaretleriz.
      if (v && (src === "explicit(aura)" || src === "raw-scan")) {
        logger.warn(
          `[altinbas] Educational ${k}=${v} kaynağı ${src} — flow yanıtında doğrulanmadı (applicant-detay trafiğinden, seçim-sonrası)`,
        );
      }
    }
    // FIX-9: bariz yanlış-prefix'li Id'yi bağlama (spec uyarısı: 003... bir
    // Contact'tır, accountId'ye bağlanamaz) — düşür, WARN'la.
    const prefixOf: Record<(typeof idKeys)[number], string> = {
      applicantId: "003",
      applicationId: "a02",
      accountId: "001",
      contactId: "003",
    };
    for (const k of idKeys) {
      const v = effIds[k];
      if (v && !v!.startsWith(prefixOf[k])) {
        logger.warn(`[altinbas] Educational ${k}=${v} beklenen prefix '${prefixOf[k]}' değil — bağlanmadı`);
        effIds[k] = undefined;
      }
    }
    // FIX-9: contactId ve applicantId AYNI Contact'tır (spec) — biri doluysa
    // diğerini ondan tamamla.
    if (!effIds.contactId && effIds.applicantId) effIds.contactId = effIds.applicantId;
    if (!effIds.applicantId && effIds.contactId) effIds.applicantId = effIds.contactId;
    logger.info(`[altinbas] Educational ID provenance: ${provenance.join(" ")}`);
    const missingIds = idKeys.filter((k) => !effIds[k]);
    if (missingIds.length) {
      logger.warn(
        `[altinbas] Educational ID binding EKSİK: ${missingIds.join(",")} — validation hatası olası (kaynak: flow yanıtlarında bu anahtar/prefix hiç görülmedi)`,
      );
    }
    // FIX-15C: education_records'dan bachelor/master kaydı al ve gönder.
    // Master/PhD başvurularında bachelor kaydı yoksa missingDocuments'a ekle.
    const eduRecords = profile.educationRecords;
    const missingEduKey = checkMissingEduRecord(eduRecords, profile.level || "");
    if (missingEduKey) {
      logger.warn(`[altinbas] FIX-15C: ${missingEduKey} eksik — missingDocuments'a eklendi`);
      result.missingDocuments = [...(result.missingDocuments ?? []), missingEduKey!];
    }
    // Prefer bachelor record; fall back to master or high_school for the modal.
    const primaryEdu =
      eduRecords?.find((r) => r.level === "bachelor") ??
      eduRecords?.find((r) => r.level === "master") ??
      eduRecords?.find((r) => r.level === "high_school");
    const eduFields = buildEducationalFields(effIds, primaryEdu);
    logger.info(
      `[altinbas] Educational REQUEST prepared (nf=${eduFields.length}, values redacted)`,
    );
    raw = await postNavigateFlow(page, rt, "NEXT", eduFields, "educational");
    if (guard(raw, "Educational") || noteStage(raw, "Educational")) {
      await rollbackIfNeeded("educational");
      return;
    }
  } else {
    logger.info("[altinbas] Educational adımı atlandı (boot stage ilerisinde)");
  }

  // 8) QUESTIONNAIRE (NEXT) — FIX-15C: Visa Support sorusu gönderiliyor.
  if (curRank <= 5) {
    raw = await postNavigateFlow(page, rt, "NEXT", buildQuestionnaireFields(profile.visaSupport), "questionnaire");
    if (guard(raw, "Questionnaire") || noteStage(raw, "Questionnaire")) {
      await rollbackIfNeeded("questionnaire");
      return;
    }
  } else {
    logger.info("[altinbas] Questionnaire adımı atlandı (boot stage ilerisinde)");
  }

  // 9) DOCUMENTS (NEXT) — ContentVersion upload HENÜZ yakalanmadı; belgesiz geç.
  const wanted: Array<[string, string | undefined]> = [
    ["photo", files.photo],
    ["passport", files.passport],
    ["transcript", files.transcript],
    ["diploma", files.diploma],
  ];
  const missing = wanted.filter(([, p]) => !p).map(([t]) => t);
  logger.info(
    `[altinbas] Documents: ContentVersion upload henüz replay edilmiyor (ilk ALTINBAS_CAPTURE=1 run'ında yakalanacak); eldeki dosyalar: ${wanted
      .filter(([, p]) => p)
      .map(([t]) => t)
      .join(", ") || "yok"}`,
  );
  if (missing.length) result.missingDocuments = missing;
  raw = await postNavigateFlow(page, rt, "NEXT", buildDocumentsFields(), "documents");
  if (guard(raw, "Documents") || noteStage(raw, "Documents")) {
    await rollbackIfNeeded("documents");
    return;
  }

  // 10) FINISH — dry-run'da GÖNDERİLMEZ.
  if (dryRun) {
    result.detail = "Altınbaş: dry-run — flow Documents'a kadar replay edildi, FINISH GÖNDERİLMEDİ";
    logger.info(`[altinbas] ${result.detail}`);
    return;
  }
  raw = await postNavigateFlow(page, rt, "FINISH", [], "finish");
  if (guard(raw, "FINISH") || noteStage(raw, "FINISH")) {
    await rollbackIfNeeded("finish");
    return;
  }

  // FIX-15A: Salesforce LWS "EduhubNavigateToURL" nav-blocked hatası BAŞARI sinyalidir.
  // LWS cross-origin yönlendirmeyi engeller, ama Application__c kaydı çoktan işlendi.
  // "Cannot open: ...my-applications?id=<TOKEN>" URL'inden externalRef çıkarılır.
  {
    const lwsMatch = raw.match(
      /EduhubNavigateToURL[\s\S]{0,600}?Cannot open:\s*https?:\/\/apply\.altinbas\.edu\.tr\/partner\/s\/my-applications\?id=([^"'\s\\&]+)/i,
    );
    if (lwsMatch) {
      const externalRef = lwsMatch![1].replace(/\\/g, "");
      markAltinbasVerifiedSuccess(result, "external_reference");
      result.externalRef = externalRef || rt.ids.applicationId;
      result.detail =
        `Altınbaş: FINISH — EduhubNavigateToURL LWS nav-blocked başarı (FIX-15A); externalRef=${result.externalRef ?? "?"}`;
      logger.info(`[altinbas] ${result.detail}`);
      return;
    }
  }

  // FINISH başarı kanıtı: HTTP 2xx + aura JSON (postNavigateFlow garanti eder)
  // YETMEZ — aura action state:SUCCESS da şart. Aksi halde fail-visible.
  if (!auraActionSucceeded(raw)) {
    result.detail =
      `Altınbaş: FINISH yanıtında state:SUCCESS yok — başarı SAYILMADI: ` +
      redactAltinbasLog(raw).replace(/\s+/g, " ").slice(0, 500);
    logger.warn(`[altinbas] ${result.detail}`);
    await rollbackIfNeeded("finish-no-success");
    return;
  }

  markAltinbasVerifiedSuccess(result, "aura_finish");
  if (rt.ids.applicationId) result.externalRef = rt.ids.applicationId;
  result.detail = `Altınbaş: FINISH gönderildi, aura state:SUCCESS (flow replay)${rt.ids.applicationId ? ` — applicationId=${rt.ids.applicationId}` : ""}`;
  logger.info(`[altinbas] ${result.detail}`);
}

// ---------------------------------------------------------------------------
// Dangling Application__c rollback helper (FIX-14)
//
// Called whenever a post-commit step fails — either via guard()-detected flow
// errors (early return inside runFlowReplay) or thrown exceptions (submit catch).
// Attempts SF REST API DELETE only for Application__c IDs proven to have been
// created in this exact run. Older/ambiguous drafts are never deleted.
// ---------------------------------------------------------------------------
async function rollbackDanglingApps(
  page: any,
  rt: FlowRuntime,
  result: SubmitResult,
  triggerTag: string,
  runCreatedIds: Set<string>,
): Promise<void> {
  // Delete only Application__c ids whose creation was observed in this exact
  // run. `explicitAppIds` can contain an older Signed-Up draft from boot/resume
  // responses and is therefore diagnostic-only, never delete authority.
  const ids = selectAltinbasRollbackIds({
    runCreatedIds,
    explicitAppIds: rt.explicitAppIds,
  });
  if (ids.length === 0) {
    const message =
      `[altinbas] ROLLBACK SKIPPED @${triggerTag}: run-proven Application__c id yok`;
    logger.warn(message);
    result.detail = (result.detail ? result.detail + " | " : "") + message;
    return;
  }
  if (!rt.template) {
    const message =
      `[altinbas] ROLLBACK SKIPPED @${triggerTag}: authenticated Salesforce origin yok`;
    logger.warn(message);
    result.detail = (result.detail ? result.detail + " | " : "") + message;
    return;
  }
  const origin = rt.template.origin;
  for (const appId of ids) {
    let rolled = false;
    try {
      const delResp: { status: number } = await page.evaluate(
        async (a: { url: string }) => {
          const r = await fetch(a.url, {
            method: "DELETE",
            credentials: "include",
          });
          return { status: r.status };
        },
        { url: `${origin}/services/data/v59.0/sobjects/Application__c/${appId}` },
      );
      if (delResp.status >= 200 && delResp.status < 300) {
        logger.info(
          `[altinbas] ROLLBACK OK @${triggerTag}: Application__c ${appId} silindi (HTTP ${delResp.status})`,
        );
        rolled = true;
      } else {
        logger.warn(
          `[altinbas] ROLLBACK başarısız @${triggerTag}: Application__c ${appId} SF REST DELETE HTTP ${delResp.status}`,
        );
      }
    } catch (rollbackErr) {
      logger.warn(
        `[altinbas] ROLLBACK hata @${triggerTag}: Application__c ${appId}: ${(rollbackErr as Error).message?.slice(0, 200)}`,
      );
    }
    if (!rolled) {
      const danglingMsg = `[altinbas] DANGLING APPLICATION__C applicationId=${appId} — manuel Salesforce temizliği gerekiyor`;
      logger.warn(danglingMsg);
      result.detail = (result.detail ? result.detail + " | " : "") + danglingMsg;
    }
  }
}

// ---------------------------------------------------------------------------
// Application-form navigation helper
//
// Salesforce Experience Cloud SPA: a cold goto(application-form) is
// redirected by the route-guard back to Home — hard-goto to the deep route
// must NEVER be used. The only reliable path is a click-through SPA
// navigation: Home → "APPLY NOW" (client nav) → Basic Info form.
// ---------------------------------------------------------------------------

/** True once the Basic Info ("Application Form") screen has hydrated. */
async function onWizard(page: any): Promise<boolean> {
  try {
    // "Applicant Email" is unique to the Basic Info form — the most
    // reliable anchor for this Salesforce Experience Cloud screen.
    const emailBox = page.getByLabel(/applicant email/i);
    return (await emailBox.count().catch(() => 0)) > 0;
  } catch {
    return false;
  }
}

async function tryGoto(page: any): Promise<void> {
  // Boot on portal Home first.
  await page
    .goto(PORTAL_URL, { waitUntil: "domcontentloaded", timeout: 60000 })
    .catch(() => {});
  await page.waitForTimeout(SF_HYDRATION_MS);
  await dismissSfError(page);

  if (await onWizard(page)) return;

  // Click "APPLY NOW" (SPA nav) — try role=button, then role=link, then a
  // generic text-match fallback. Hard goto(APP_FORM_URL) is intentionally
  // NOT used here: it gets bounced back to Home by the route guard.
  const candidates = [
    page.getByRole("button", { name: /apply now/i }),
    page.getByRole("link", { name: /apply now/i }),
    page.locator("button, a, [role=button]").filter({ hasText: /apply now/i }),
  ];

  for (const cand of candidates) {
    const loc = cand.first();
    if (await loc.count().catch(() => 0)) {
      await loc.scrollIntoViewIfNeeded().catch(() => {});
      await loc.click({ timeout: 8000 }).catch(() => {});
      await page.waitForTimeout(4000);
      await dismissSfError(page);
      break;
    }
  }

  // Poll up to 30s for the Basic Info form to appear.
  for (let t = 0; t < 30 && !(await onWizard(page)); t++) {
    await page.waitForTimeout(1000);
  }
}

async function navigateToAppForm(page: any): Promise<void> {
  // With a valid session the wizard loads directly; APPLY NOW is absent on Home in automated sessions. direct goto to the wizard.
  for (let d = 0; d < 3 && !(await onWizard(page)); d++) {
    await page.goto(APP_FORM_URL, { waitUntil: "domcontentloaded", timeout: 60000 }).catch(() => {});
    await page.waitForTimeout(SF_HYDRATION_MS);
    await dismissSfError(page);
  }
  if (await onWizard(page)) return;
  for (let attempt = 0; attempt < 3 && !(await onWizard(page)); attempt++) {
    logger.info(`[altinbas] navigateToAppForm: attempt ${attempt + 1}/3`);
    await tryGoto(page);
  }
  logger.info(`[altinbas] navigateToAppForm: onWizard=${await onWizard(page)}`);
}

// ---------------------------------------------------------------------------
// Step 1: Basic Information (DOM ile doldurulan TEK ekran — flow'dan ÖNCE)
//
// Fields seen: First Name*, Last Name*, Citizenship* (lookup), Passport Number*, Applicant Email*
// ---------------------------------------------------------------------------
async function fillStep1(page: any, profile: SubmitProfile): Promise<boolean> {
  logger.info("[altinbas] Step 1 (Basic Info): filling label-based fields");
  await dismissSfError(page);

  // Wait for the Basic Info anchor field to hydrate.
  await page.getByLabel(/applicant email/i).first().waitFor({ timeout: 30000 }).catch(() => {});
  await page.waitForTimeout(1000);

  const fields: Array<[RegExp, string, string]> = [
    [altinbasBasicFieldLabel("firstName"), profile.firstName, "firstName"],
    [altinbasBasicFieldLabel("lastName"), profile.lastName, "lastName"],
    [altinbasBasicFieldLabel("passport"), profile.passportNumber, "passport"],
    [altinbasBasicFieldLabel("email"), profile.email, "email"],
  ];
  const fieldProofs: Record<string, boolean> = {};
  for (const [label, value, key] of fields) {
    const controls = page.getByLabel(label).filter({ visible: true });
    if ((await controls.count().catch(() => 0)) !== 1 || !value.trim()) {
      fieldProofs[key] = false;
      continue;
    }
    const control = controls.first();
    const filled = await control.fill(value).then(
      () => true,
      () => false,
    );
    const readback = ((await control.inputValue().catch(() => "")) || "").trim();
    fieldProofs[key] = filled && readback === value.trim();
  }

  // Citizenship combobox (Salesforce typeahead)
  const citizenship = mapCountry(profile.nationality);
  const citizenshipOk =
    !!citizenship &&
    await pickCombobox(page, /citizenship/i, citizenship);
  if (!citizenshipOk) {
    logger.warn("[altinbas] Step 1: Citizenship exact readback failed");
  }

  await page.waitForTimeout(800);
  logger.info(
    "[altinbas] Step1 filled: first/last/passport/email/citizenship",
    {
      firstName: fieldProofs.firstName,
      lastName: fieldProofs.lastName,
      passport: fieldProofs.passport,
      email: fieldProofs.email,
      citizenshipOk,
    },
  );
  if (
    Object.values(fieldProofs).some((proved) => !proved) ||
    !citizenshipOk
  ) {
    logger.warn("[altinbas] Step 1: required field readback failed — Next blocked");
    return false;
  }

  logger.info("[altinbas] Step 1: clicking Next");
  const nextButtons = page.getByRole("button", { name: /^next$/i });
  if ((await nextButtons.count().catch(() => 0)) !== 1) {
    logger.warn("[altinbas] Step 1: Next button is not unique");
    return false;
  }
  const clicked = await nextButtons.first().click({ timeout: 10000 }).then(
    () => true,
    () => false,
  );
  if (!clicked) return false;
  await page.waitForTimeout(3000);
  const passportAfterNext = page
    .getByLabel(altinbasBasicFieldLabel("passport"))
    .filter({ visible: true });
  if ((await passportAfterNext.count().catch(() => 0)) === 1) {
    const proof = await passportAfterNext.first().evaluate((element: Element) => {
      const control = element as HTMLInputElement;
      return {
        ariaInvalid: control.getAttribute("aria-invalid") === "true",
        valid: control.validity ? control.validity.valid : true,
      };
    }).catch(() => null);
    if (!proof || proof.ariaInvalid || !proof.valid) {
      logger.warn(
        "[altinbas] Step 1: Passport Number portal validation failed after Next",
      );
      return false;
    }
  }
  return true;
}

/**
 * Student summary screen (post Step-1 Next): click "Create New Application"
 * to enter the Screen Flow. Bu tıklama flow'u BOOT eder — serializedState
 * applicant context'ini buradan kazanır. Returns true on success.
 */
async function clickCreateNewApplication(
  page: any,
  rt: FlowRuntime,
  profile: SubmitProfile,
  exactSearchReadbackVerified: boolean,
): Promise<boolean> {
  await dismissSfError(page);

  // Faz-2.1 KANITLANDI (headed dry-run): after Basic Info → Next, the screen
  // is often a student-search GRID (columns Full Name/Email/Passport, footer
  // "Go To Applicant Detail Page") rather than the student summary directly.
  // The row radio is an SLDS faux-control — plain check()/click() silently
  // no-ops (checked stays false) and "Go To Applicant Detail Page" is then a
  // no-op too. Force-select the first row and force-click through.
  const gotoDetail = page.getByRole("button", { name: /go to applicant detail page/i }).first();
  if (await gotoDetail.count().catch(() => 0)) {
    const radios = page.locator('input[type="radio"]');
    const radioCount = await radios.count().catch(() => 0);
    const expectedEmail = fold(profile.email);
    const expectedPassport = fold(profile.passportNumber);
    const foldedRows: string[] = [];
    for (let index = 0; index < radioCount; index++) {
      const rowText = await radios.nth(index).evaluate((radio: Element) => {
        let node: Element | null = radio;
        let boundary: Element | null = null;
        for (let depth = 0; depth < 16 && node; depth++) {
          if (node.matches("tr,[role='row'],c-application-table-row-component")) {
            boundary = node;
            break;
          }
          const root = node.getRootNode() as ShadowRoot | Document;
          node = node.parentElement || ("host" in root ? root.host : null);
        }
        if (!boundary) return "";
        const parts: string[] = [];
        const seen = new Set<Node>();
        const stack: Node[] = [boundary];
        while (stack.length > 0) {
          const current = stack.pop();
          if (!current || seen.has(current)) continue;
          seen.add(current);
          if (current.nodeType === 3) {
            const text = (current.textContent || "").replace(/\s+/g, " ").trim();
            if (text) parts.push(text);
            continue;
          }
          if (current.nodeType === 1) {
            const shadowRoot = (current as Element).shadowRoot;
            if (shadowRoot) stack.push(shadowRoot);
          }
          for (
            let childIndex = current.childNodes.length - 1;
            childIndex >= 0;
            childIndex--
          ) {
            const child = current.childNodes.item(childIndex);
            if (child) stack.push(child);
          }
        }
        return parts.join(" ").replace(/\s+/g, " ").trim();
      }).catch(() => "");
      foldedRows.push(fold(rowText));
    }
    const foldedPageText = radioCount === 1
      ? fold(await readComposedPageText(page))
      : "";
    const selectedIndex = chooseAltinbasApplicantGridRow({
      foldedRows,
      foldedPageText,
      expectedFoldedEmail: expectedEmail,
      expectedFoldedPassport: expectedPassport,
      exactSearchReadbackVerified,
    });
    const pageIdentityProof = Boolean(
      expectedEmail &&
      expectedPassport &&
      foldedPageText.includes(expectedEmail) &&
      foldedPageText.includes(expectedPassport)
    );
    if (selectedIndex < 0) {
      const readableRows = foldedRows.filter(Boolean).length;
      logger.warn(
        `[altinbas] applicant grid target proof failed` +
        ` (radioCount=${radioCount}, readableRows=${readableRows},` +
        ` pageIdentityProof=${pageIdentityProof})`,
      );
      return false;
    }
    const proofSource = foldedRows[selectedIndex]?.includes(expectedEmail) &&
        foldedRows[selectedIndex]?.includes(expectedPassport)
      ? "row"
      : pageIdentityProof
        ? "single_candidate_page"
        : "single_candidate_exact_search";
    const checked = await forceCheckRadio(page, radios.nth(selectedIndex));
    logger.info(
      `[altinbas] applicant grid exact target selected=${checked}` +
      ` (proof=${proofSource})`,
    );
    if (!checked) return false;
    await page.waitForTimeout(800);
    // FIX-9: seçim yapıldı — bundan sonraki aura trafiği seçilen öğrencinin
    // detay yüklemesidir; scanIds (003/001 son-çare fallback) artık dolabilir.
    rt.applicantSelected = true;
    await gotoDetail.click({ force: true, timeout: 8000 }).catch(() => {});
    await page.waitForTimeout(SF_HYDRATION_MS);
    await dismissSfError(page);
    logger.info("[altinbas] clicked Go To Applicant Detail Page");
  }
  // Grid çıkmadıysa doğrudan detay sayfasındayız — seçim kapısını yine aç.
  rt.applicantSelected = true;

  // Create New Application can be below the fold on the detail page.
  await page.mouse.wheel(0, 4000).catch(() => {});
  await page.waitForTimeout(1200);

  const createBtn = page.getByRole("button", { name: /create new application/i }).first();
  if (!(await createBtn.count().catch(() => 0))) {
    const actionCounts = await page.getByRole("button").evaluateAll((buttons: Element[]) => {
      const actions = {
        createNewApplication: 0,
        newApplication: 0,
        startApplication: 0,
        goToApplicantDetail: 0,
      };
      for (const button of buttons) {
        const labels = [
          button.getAttribute("aria-label") || "",
          button.getAttribute("title") || "",
          button.textContent || "",
        ].map((label) => label.replace(/\s+/g, " ").trim()).filter(Boolean);
        if (labels.some((label) => /^create new application$/i.test(label))) actions.createNewApplication++;
        if (labels.some((label) => /^new application$/i.test(label))) actions.newApplication++;
        if (labels.some((label) => /^start application$/i.test(label))) actions.startApplication++;
        if (labels.some((label) => /go to applicant detail page/i.test(label))) actions.goToApplicantDetail++;
      }
      return actions;
    }).catch(() => null);
    logger.warn(
      "[altinbas] Create New Application button not found on student summary screen" +
      ` (knownActionCounts=${JSON.stringify(actionCounts)})`,
    );
    return false;
  }
  await createBtn.scrollIntoViewIfNeeded().catch(() => {});
  await createBtn.click({ force: true, timeout: 10000 }).catch(() => {});
  await page.waitForTimeout(3000);
  logger.info("[altinbas] clicked Create New Application — flow boot bekleniyor");
  return true;
}

// ---------------------------------------------------------------------------
// Duplicate detection (DOM — Step-1/grid ekranları için; flow içi duplicate
// isDuplicatePassport ile yanıt gövdesinden yakalanır)
// ---------------------------------------------------------------------------
async function checkAlreadyExists(page: any): Promise<boolean> {
  try {
    const txt: string = await page.evaluate(
      () => (document.body?.innerText || "").replace(/\s+/g, " "),
    );
    const DUP = /already an application for this (passport|email)|already exists|duplicate/i;
    const APP_NUM = /\b[A-Z]{2,3}\d{6,}\b/;
    if (DUP.test(txt)) return true;
    if (/application\s*number/i.test(txt) && APP_NUM.test(txt)) return true;
    return false;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Main adapter export
// ---------------------------------------------------------------------------
export const altinbasAdapter: UniversityAdapter = {
  key:   ADAPTER_KEY,
  label: "Altınbaş Üniversitesi",

  allowlist: ["altinbas", "altınbaş"],

  matches(name: string): boolean {
    const f = fold(name);
    return f.includes("altinbas") || f.includes("altinbas universitesi");
  },

  // -------------------------------------------------------------------------
  // login — Salesforce Experience Cloud partner community
  // -------------------------------------------------------------------------
  async login(opts?: LoginOpts): Promise<AdapterSession> {
    const { user, password } = opts?.credentials ?? portalCreds(ADAPTER_KEY);
    const credentialFingerprint = altinbasCredentialFingerprint(user, password);
    assertAltinbasLoginCooldown(credentialFingerprint);
    logger.info(`[altinbas] login → ${PORTAL_URL}`);

    const session = await launchPortal({
      headless: opts?.headless ?? true,
      storagePath: SESSION_STATE,
    });

    const page: any = session.page;
    page.setDefaultTimeout(30000);

    try {
      await page.goto(PORTAL_URL, { waitUntil: "domcontentloaded", timeout: 60000 });
      await page.waitForTimeout(4000);

      // Already logged in?
      const url: string = page.url();
      if (url.includes("/partner/s/") && !url.includes("/login") && !url.includes("/Login")) {
        await page
          .goto(PORTAL_URL, { waitUntil: "domcontentloaded", timeout: 60000 })
          .catch(() => {});
        await page.waitForTimeout(SF_HYDRATION_MS);
        const stale =
          page.url().toLowerCase().includes("login") ||
          (await page
            .locator("input[type=password]")
            .first()
            .isVisible()
            .catch(() => false));
        if (!stale) {
          logger.info("[altinbas] login: session reused (already authenticated)");
          return session;
        }
        logger.info("[altinbas] login: stored session stale - re-authenticating via form");
      }

      // Fill username/email. Do not guess an unrelated text input.
      let usernameFilled = false;
      for (const sel of [
        "input[type=email]",
        "input[name*=username i]",
        "input[id*=username i]",
        "input[name*=email i]",
        "input[id*=email i]",
        "input[type=text]",
      ]) {
        const el = page.locator(sel).first();
        if ((await el.count()) && (await el.isVisible().catch(() => false))) {
          await el.fill(user);
          usernameFilled = true;
          break;
        }
      }
      if (!usernameFilled) {
        activateAltinbasLoginCooldown("unknown", credentialFingerprint);
        throw new Error("[altinbas] login failed — username field not found");
      }

      // Fill password
      const passwordInput = page.locator("input[type=password]").first();
      if (!(await passwordInput.isVisible().catch(() => false))) {
        activateAltinbasLoginCooldown("unknown", credentialFingerprint);
        throw new Error("[altinbas] login failed — password field not found");
      }
      await passwordInput.fill(password);

      // Click login button
      const loginButton = page
        .getByRole("button", { name: /log\s*in|sign\s*in|giris|giriş/i })
        .first();
      if (!(await loginButton.isVisible().catch(() => false))) {
        activateAltinbasLoginCooldown("unknown", credentialFingerprint);
        throw new Error("[altinbas] login failed — login button not found");
      }
      await loginButton.click({ timeout: 10000 });

      // Wait up to 30s for redirect away from login
      for (let t = 0; t < 30; t++) {
        await page.waitForTimeout(1000);
        const u: string = page.url();
        if (!u.includes("/login") && !u.includes("/Login")) break;
      }

      const stillLogin = await passwordInput.isVisible().catch(() => false);
      const loginUrlVisible = /(?:agency-)?login/i.test(page.url());
      const captchaDetected =
        (await page
          .locator(
            "iframe[src*='captcha' i], iframe[title*='captcha' i], [id*='captcha' i], [class*='captcha' i], [data-sitekey]",
          )
          .count()
          .catch(() => 0)) > 0;
      const bodyText = await page.locator("body").innerText().catch(() => "");
      const failureKind = classifyAltinbasLoginFailure({
        bodyText,
        captchaDetected,
        passwordVisible: stillLogin,
        loginUrlVisible,
      });
      if (failureKind) {
        activateAltinbasLoginCooldown(failureKind, credentialFingerprint);
        throw new Error(altinbasLoginFailureMessage(failureKind));
      }

      logger.info(`[altinbas] login successful → ${page.url()}`);
      altinbasLoginCooldownUntil = 0;
      altinbasLoginCooldownKind = null;

      // Save session for reuse
      try {
        await page.context().storageState({ path: SESSION_STATE });
      } catch {/* non-fatal */}
    } catch (err) {
      await session.close().catch(() => {});
      throw err;
    }

    return session;
  },

  // -------------------------------------------------------------------------
  // submit — login'li tarayıcıda flow boot + navigateFlow REPLAY
  // -------------------------------------------------------------------------
  async submit(
    session: AdapterSession,
    profile: SubmitProfile,
    files: SubmitFiles,
    doSubmit: boolean = true,
  ): Promise<SubmitResult> {
    const page: any = session.page;
    page.setDefaultTimeout(30000);

    const dryRun =
      doSubmit === false ||
      process.env.PORTAL_DRYRUN === "1" ||
      process.env.ALTINBAS_DRYRUN === "1";

    logger.info("[altinbas] submit start (SCREEN FLOW REPLAY)", {
      applicantIdentity: profile.firstName && profile.lastName ? "present" : "missing",
      level:       profile.level,
      programName: profile.programName,
      dryRun,
      capture:     CAPTURE,
    });

    // ── Level guard ─────────────────────────────────────────────────────────
    if (!isAcceptedLevel(profile.level || "")) {
      const msg = `Altınbaş: level "${profile.level}" kapalı (Master/PhD/Bachelor/Associate)`;
      logger.info(`[altinbas] ${msg}`);
      return {
        alreadyExists:  false,
        submitted:      false,
        programMissing: false,
        detail:         msg,
      };
    }

    const normalizedPassport =
      normalizeAltinbasPassportNumber(profile.passportNumber);
    if (!normalizedPassport) {
      const msg =
        "Altınbaş: passportNumber portal formatına çevrilemedi " +
        "(1-20 uppercase Latin alphanumeric gerekli)";
      logger.warn(`[altinbas] ${msg}`);
      return {
        alreadyExists: false,
        submitted: false,
        programMissing: false,
        detail: msg,
      };
    }
    const portalProfile: SubmitProfile =
      normalizedPassport === profile.passportNumber
        ? profile
        : { ...profile, passportNumber: normalizedPassport };

    // ── Pre-flight: önceki run dangling SF kaydı bırakmış mı? (FIX-14) ──────
    // Aynı CRM applicationId için mode=real, status=failed satırları varsa
    // WARN logu yaz — önceki run(lar) Salesforce'ta taslak Application__c
    // bırakmış olabilir; manuel SF temizliği yapılmadan yeni run'da
    // CheckDuplicateValidation (isDuplicatePassport sinyali) tetiklenir.
    if (profile.applicationDbId) {
      try {
        const prevFailed = await db
          .select({ id: portalSubmissionsTable.id, createdAt: portalSubmissionsTable.createdAt })
          .from(portalSubmissionsTable)
          .where(
            and(
              eq(portalSubmissionsTable.applicationId, profile.applicationDbId),
              eq(portalSubmissionsTable.universityKey, ADAPTER_KEY),
              eq(portalSubmissionsTable.mode, "real"),
              eq(portalSubmissionsTable.status, "failed"),
              isNull(portalSubmissionsTable.deletedAt),
            ),
          );
        if (prevFailed.length > 0) {
          const summary = prevFailed
            .map((r) => `id=${r.id} at=${r.createdAt instanceof Date ? r.createdAt.toISOString() : String(r.createdAt)}`)
            .join("; ");
          logger.warn(
            `[altinbas] PRE-FLIGHT: applicationId=${profile.applicationDbId} için ${prevFailed.length} adet önceki mode=real status=failed submission var` +
            ` (${summary}) — önceki run(lar) Salesforce'ta dangling Application__c bırakmış olabilir.` +
            ` Manuel SF temizliği yapılmadan bu run'da CheckDuplicateValidation (already_exists) tetiklenebilir.`,
          );
        }
      } catch (preflightErr) {
        logger.warn(`[altinbas] pre-flight sorgusu başarısız (non-fatal): ${(preflightErr as Error).message?.slice(0, 200)}`);
      }
    }

    const result: SubmitResult = {
      alreadyExists:  false,
      submitted:      false,
      programMissing: false,
    };
    const screenshots: string[] = [];
    const canaryGate = altinbasMutationCanaryGate({
      requested: MUTATION_CANARY,
      uiComplete: UI_COMPLETE,
      dryRun,
    });
    if (canaryGate !== "inactive" && canaryGate !== "ready") {
      result.detail = `Altınbaş[canary]: blocked — gate=${canaryGate}`;
      logger.warn(`[altinbas][canary] ${result.detail}`);
      return result;
    }

    // ── Flow interceptor'ı EN BAŞTA kur (Create New Application'dan önce
    //    kurulu olmalı ki flow-boot yanıtındaki ilk serializedState kaçmasın;
    //    template'i Step-1 aura trafiğinden bile toplayabilir). ─────────────
    const rt = newFlowRuntime();
    setupFlowInterceptor(page, rt);
    if (CAPTURE) {
      logger.info(`[altinbas] ALTINBAS_CAPTURE=1 — tüm aura trafiği ${CAPTURE_FILE} dosyasına dökülüyor`);
    }

    // ── Navigate to application form ─────────────────────────────────────
    logger.info("[altinbas] navigating to application form");
    if (shouldUseAltinbasUiPath({ uiComplete: UI_COMPLETE, dryRun })) {
      // NEW: finish an EXISTING half-finished (Signed-Up) application via the
      // real Lightning wizard AND upload the 4 required documents. If no such
      // application exists yet, a real run may fall through to create. Every
      // dry-run is forced through this read-only path even when UI_COMPLETE is
      // not enabled, so it can never create/fill/advance/upload.
      const uiHandled = await completeApplicationUI(
        page,
        rt,
        portalProfile,
        files,
        dryRun,
        result,
        screenshots,
      );
      if (uiHandled) {
        if (screenshots.length) result.screenshots = screenshots;
        logger.info("[altinbas] submit complete (UI completion path)", result);
        return result;
      }
      if (dryRun) {
        result.detail =
          "Altınbaş[ui]: read_only_dry_run — mevcut Signed-Up başvuru bulunamadı; create akışına girilmedi";
        logger.info(`[altinbas][ui] ${result.detail}`);
        return result;
      }
      logger.info("[altinbas] UI_COMPLETE set but no existing Signed-Up app — falling through to create+replay");
    }
    await navigateToAppForm(page);
    await page.waitForTimeout(2000);

    // Early duplicate check (Students/Applications list page)
    if (await checkAlreadyExists(page)) {
      logger.info("[altinbas] duplicate detected before form");
      result.alreadyExists = true;
      return { ...result, screenshots };
    }

    // ── Initial screenshot (pre-Step 1) ──────────────────────────────────
    const initShot = await captureScreen(page, "pre-step1");
    if (initShot) screenshots.push(initShot);

    // ── Step 1: Basic Information (DOM) ───────────────────────────────────
    const step1Ready = await fillStep1(page, portalProfile);
    if (!step1Ready) {
      result.detail =
        "Altınbaş: Basic Information alanları tekil hedef + exact readback ile doğrulanamadı";
      logger.warn(`[altinbas] ${result.detail}`);
      return { ...result, screenshots };
    }
    await page.waitForTimeout(3000);

    if (await checkAlreadyExists(page)) {
      logger.info("[altinbas] duplicate detected after Step 1");
      result.alreadyExists = true;
      return { ...result, screenshots };
    }

    // ── Student summary → Create New Application (flow BOOT) ──────────────
    const createdApp = await clickCreateNewApplication(
      page,
      rt,
      portalProfile,
      step1Ready,
    );
    if (!createdApp) {
      logger.warn("[altinbas] could not click Create New Application — capturing student summary screen and aborting");
      const stuckShot = await captureScreen(page, "student-summary-stuck");
      if (stuckShot) screenshots.push(stuckShot);
      result.detail = "Altınbaş: Create New Application butonu bulunamadı (flow boot edilemedi)";
      return { ...result, screenshots };
    }

    // ── Screen Flow REPLAY: Term → Degree → Program → commit → Personal →
    //    Educational → Questionnaire → Documents → FINISH ───────────────────
    try {
      await runFlowReplay(
        page,
        rt,
        portalProfile,
        files,
        dryRun,
        result,
        screenshots,
      );
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      logger.warn(`[altinbas] flow replay hatası: ${msg}`);
      result.detail = result.detail || `Altınbaş flow replay hatası: ${msg}`;
      const failShot = await captureScreen(page, "flow-replay-failed");
      if (failShot) screenshots.push(failShot);

      // ── Dangling Application__c rollback (FIX-14) ────────────────────────
      // commit'ten sonra exception fırlatıldıysa Salesforce'ta taslak
      // Application__c kaydı kalmış olabilir. Guard()-detected hatalar zaten
      // runFlowReplay'in içinde rollbackIfNeeded ile yakalanır; bu dal yalnız
      // gerçek throw'lar için son güvencedir.
      // runCreatedAppIds is scoped to runFlowReplay; for exceptions that escape
      // the function, rely on rt.explicitAppIds (union happens inside rollbackDanglingApps).
      await rollbackDanglingApps(page, rt, result, "exception", new Set<string>());
    }

    if (screenshots.length) result.screenshots = screenshots;
    logger.info("[altinbas] submit complete", result);
    return result;
  },

  // -------------------------------------------------------------------------
  // listPrograms — Phase 2 placeholder
  // TODO: flow boot + Term/Degree replay sonrası eligible listeden doldurulabilir.
  // -------------------------------------------------------------------------
  async listPrograms(
    session: AdapterSession,
    level?: string,
  ): Promise<ProgramOption[]> {
    logger.warn("[altinbas] listPrograms: not yet implemented (Phase 2)");
    return [];
  },
};
