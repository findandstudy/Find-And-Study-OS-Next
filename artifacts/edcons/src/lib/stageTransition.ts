// Task #269 — Shared stage-transition helpers used by every stage-change
// entry point (Applications list/kanban, ApplicationDetail dropdown). Centralizes
// the PATCH call + parsing of the document-gating 422 responses so the same
// document-request / incomplete-docs flow behaves identically everywhere.

const BASE_URL = import.meta.env.BASE_URL?.replace(/\/$/, "") || "";

function getCsrfToken(): string {
  const m = document.cookie.match(/(?:^|;\s*)csrf_token=([^;]*)/);
  return m ? decodeURIComponent(m[1]) : "";
}

export interface MissingDocEntry {
  id: number;
  documentType: string | null;
  customTitle: string | null;
  isCustom: boolean;
  note: string | null;
  respondedAt: string | null;
}

export type StageTransitionResult =
  | { kind: "ok" }
  | { kind: "doc_selection_required"; requiredStage: string; suggestedDocTypes: string[]; actionLabel: string | null }
  | { kind: "docs_incomplete"; currentStage: string; missing: MissingDocEntry[] }
  | { kind: "docs_required"; requiredStage: string }
  | { kind: "student_docs_required"; missingDocTypes: string[] }
  | { kind: "error"; message: string };

/**
 * Attempt to move an application to `targetStage`. Returns a discriminated
 * result the caller can branch on to open the right dialog.
 */
export async function requestStageChange(appId: number, targetStage: string): Promise<StageTransitionResult> {
  try {
    const res = await fetch(`${BASE_URL}/api/applications/${appId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", "x-csrf-token": getCsrfToken() },
      credentials: "include",
      body: JSON.stringify({ stage: targetStage }),
    });
    if (res.ok) return { kind: "ok" };
    const body: any = await res.json().catch(() => ({}));
    if (res.status === 422 && body.code === "DOC_SELECTION_REQUIRED") {
      return {
        kind: "doc_selection_required",
        requiredStage: body.requiredStage || targetStage,
        suggestedDocTypes: Array.isArray(body.suggestedDocTypes) ? body.suggestedDocTypes : [],
        actionLabel: typeof body.actionLabel === "string" ? body.actionLabel : null,
      };
    }
    if (res.status === 422 && body.code === "DOCS_INCOMPLETE") {
      return {
        kind: "docs_incomplete",
        currentStage: body.currentStage || "",
        missing: Array.isArray(body.missing) ? body.missing : [],
      };
    }
    if (res.status === 422 && body.code === "DOCS_REQUIRED") {
      return { kind: "docs_required", requiredStage: body.requiredStage || targetStage };
    }
    if (res.status === 422 && body.code === "STUDENT_DOCS_REQUIRED") {
      return { kind: "student_docs_required", missingDocTypes: Array.isArray(body.missingDocTypes) ? body.missingDocTypes : [] };
    }
    return { kind: "error", message: body.error || "Aşama güncellenemedi" };
  } catch {
    return { kind: "error", message: "Aşama güncellenemedi" };
  }
}

export interface StageDocRequestItem {
  documentType?: string;
  customTitle?: string;
  note?: string;
}

/**
 * Persist the per-application document requests for a stage. Replace semantics
 * on the server: this overwrites any existing requests for (app, stage).
 */
export async function saveStageDocRequests(appId: number, stage: string, items: StageDocRequestItem[]): Promise<void> {
  const res = await fetch(`${BASE_URL}/api/applications/${appId}/missing-doc-notes`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-csrf-token": getCsrfToken() },
    credentials: "include",
    body: JSON.stringify({ items, stage }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || "Belge talepleri kaydedilemedi");
  }
}

/**
 * Mark a single document request fulfilled (manual close, admin/staff only).
 */
export async function markDocRequestFulfilled(appId: number, noteId: number, fulfilled = true): Promise<void> {
  const res = await fetch(`${BASE_URL}/api/applications/${appId}/missing-doc-notes/${noteId}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", "x-csrf-token": getCsrfToken() },
    credentials: "include",
    body: JSON.stringify({ fulfilled }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || "Talep güncellenemedi");
  }
}
