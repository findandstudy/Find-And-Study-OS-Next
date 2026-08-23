import { useState, useEffect, useMemo, useRef } from "react";
import { toLatinUpper, transliterateToLatin } from "@/lib/latin-utils";
import { useQuery } from "@tanstack/react-query";
import { customFetch } from "@workspace/api-client-react";
import { findMissingMandatoryTypes } from "@workspace/doc-equivalence";
import { useStudyLevels } from "@/hooks/useStudyLevels";
import { useI18n } from "@/hooks/use-i18n";
import { useToast } from "@/hooks/use-toast";
import type { InboxConversationDetailResponse } from "@workspace/api-client-react";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import {
  Loader2,
  FileText,
  GraduationCap,
  ScrollText,
  Shield,
  Camera,
  CheckCircle2,
  Circle,
  Paperclip,
  Trash2,
  Upload,
  ClipboardPaste,
  X as XIcon,
} from "lucide-react";
import { inboxDocumentLabel } from "./documentPresentation";
import {
  normalizeInboxGender,
  normalizeInboxGpaForForm,
} from "./inboxExtractionNormalization";
import { resolveInboxStudentContactPrefill } from "./studentDraftContact";
import { uploadDocumentFile } from "@/lib/uploadDocumentFile";

const BASE_URL = import.meta.env.BASE_URL?.replace(/\/$/, "") || "";

// ── Types ─────────────────────────────────────────────────────────────────────

export interface ChatAttachment {
  msgId: number;
  attachIdx: number;
  url: string;
  name: string;
  isImage: boolean;
}

interface DocReq {
  documentType: string;
  mandatory: boolean;
  sortOrder: number;
  label?: string;
  source?: string;
}

interface EffectiveDocReqsResponse {
  programId: number | null;
  level: string | null;
  programSpecific: boolean;
  requirements: DocReq[];
}

interface PersistedDocument {
  id: number;
  type: string;
  name?: string | null;
  fileName?: string | null;
  sourceAttachmentId?: string | null;
}

// ── Icon map ──────────────────────────────────────────────────────────────────

const DOC_ICONS: Record<string, typeof FileText> = {
  diploma: GraduationCap,
  transcript: ScrollText,
  passport: Shield,
  photograph: Camera,
};

function getDocIcon(key: string): typeof FileText {
  return DOC_ICONS[key.toLowerCase()] ?? FileText;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

const MIME_EXT_MAP: Record<string, string> = {
  "application/pdf": "pdf", "image/jpeg": "jpg", "image/png": "png",
  "image/webp": "webp", "video/mp4": "mp4", "audio/ogg": "ogg", "audio/mpeg": "mp3",
  "application/msword": "doc",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
};

// Same attachment name-resolution chain as the chat bubbles in Messages.tsx:
// explicit name/fileName → WhatsApp raw filename → URL basename → localized
// type label + mime extension. Never a bare "file".
function resolveAttachmentName(
  a: any,
  i: number,
  meta: Record<string, any>,
  url: string,
  t: (k: string) => string,
): string {
  const rawMeta = meta?.raw;
  const waRawType = rawMeta?.type;
  const waMedia = waRawType ? (rawMeta[waRawType] as any) : null;
  const nestedZernio = Array.isArray(rawMeta?.message?.attachments)
    ? rawMeta.message.attachments[i]
    : null;
  const nestedPayload = nestedZernio?.payload;
  const waFilename = i === 0 ? (waMedia?.filename ?? waMedia?.file_name ?? null) : null;
  const nameFromUrl = (() => {
    try {
      const seg = new URL(String(url)).pathname.split("/").pop() ?? "";
      return seg.includes(".") ? decodeURIComponent(seg) : null;
    } catch { return null; }
  })();
  const mm = String(
    a?.mimeType ??
    a?.mime_type ??
    a?.fileType ??
    nestedZernio?.mimeType ??
    nestedZernio?.mime_type ??
    nestedPayload?.mimeType ??
    nestedPayload?.mime_type ??
    "",
  ).split(";")[0].trim().toLowerCase();
  const mimeExt = MIME_EXT_MAP[mm] ?? null;
  const type = a?.type ?? a?.fileType ?? "file";
  const attTypeLabel = type === "image" ? t("inbox.attachment.photo")
    : type === "video" ? t("inbox.attachment.video")
    : type === "audio" ? t("inbox.attachment.audio")
    : t("inbox.attachment.document");
  const typedName = mimeExt ? `${attTypeLabel}.${mimeExt}` : attTypeLabel;
  const explicitName = [
    a?.name,
    a?.fileName,
    nestedZernio?.name,
    nestedZernio?.fileName,
    nestedZernio?.filename,
    nestedPayload?.fileName,
    nestedPayload?.filename,
    waFilename,
    nameFromUrl,
  ].find(
    (v) =>
      typeof v === "string" &&
      v.trim() &&
      !["file", "image", "document", "video", "audio"].includes(v.trim().toLowerCase()),
  ) as string | undefined;
  return explicitName ?? typedName;
}

function extractChatAttachments(messages: any[], t: (k: string) => string): ChatAttachment[] {
  const result: ChatAttachment[] = [];
  for (const msg of messages ?? []) {
    const meta = (msg?.metadata ?? {}) as Record<string, any>;
    const atts: any[] = [
      ...(meta.attachment && typeof meta.attachment === "object" ? [meta.attachment] : []),
      ...(Array.isArray(meta.attachments) ? meta.attachments : []),
    ];
    atts.forEach((a, idx) => {
      const url = String(a?.url ?? a?.fileUrl ?? "").trim();
      if (!url) return;
      const name = resolveAttachmentName(a, idx, meta, url, t);
      const mime = String(a?.mimeType ?? a?.mime_type ?? a?.type ?? "").toLowerCase();
      const isImage =
        mime.startsWith("image/") || /\.(jpg|jpeg|png|gif|webp)$/i.test(url);
      result.push({ msgId: msg.id, attachIdx: idx, url, name, isImage });
    });
  }
  return result;
}

function isMasterOrHigher(levelKey: string): boolean {
  const k = levelKey.toLowerCase();
  return (
    k.includes("master") ||
    k.includes("phd") ||
    k.includes("doctor") ||
    k.includes("mba")
  );
}

function isDoctorate(levelKey: string): boolean {
  const k = levelKey.toLowerCase();
  return k.includes("phd") || k.includes("doctor");
}

// ── Student form initial state ────────────────────────────────────────────────

const EMPTY_STUDENT_FORM = {
  firstName: "",
  lastName: "",
  email: "",
  phone: "",
  gender: "",
  motherName: "",
  fatherName: "",
  nationality: "",
  dateOfBirth: "",
  address: "",
  addressCity: "",
  postalCode: "",
  passportNumber: "",
  passportIssueDate: "",
  passportExpiry: "",
  school1: "",
  school2: "",
  educationProgram: "",
  educationCountry: "",
  graduationYear: "",
  gpa: "",
  gradingSystem: "4",
  languageScore: "",
  notes: "",
};

// ── SubmitReadyData ───────────────────────────────────────────────────────────

export interface SubmitReadyData {
  form: typeof EMPTY_STUDENT_FORM;
  staging: Record<string, ChatAttachment>;
  aiFields: Set<string>;
  selectedLevel: string;
  leadId: number | null;
  mandatoryDocumentTypes: string[];
  providedDocumentTypes: string[];
  persistedDocumentTypes: string[];
}

// ── Main component ────────────────────────────────────────────────────────────

interface InboxStudentTabProps {
  detail: InboxConversationDetailResponse;
  conversationId: number;
  programId?: number | null;
  programName?: string | null;
  initialLevel?: string | null;
  onLevelChange?: (level: string) => void;
  onUpdated?: () => void;
  onReadyToSubmit?: (data: SubmitReadyData) => void;
}

export function InboxStudentTab({
  detail,
  conversationId,
  programId,
  programName,
  initialLevel,
  onLevelChange,
  onUpdated,
  onReadyToSubmit,
}: InboxStudentTabProps) {
  const { t } = useI18n();
  const { toast } = useToast();
  const { levels, isLoading: levelsLoading } = useStudyLevels();

  // ── State ──────────────────────────────────────────────────────────────────
  const [selectedLevel, setSelectedLevel] = useState<string>(initialLevel ?? "");
  // staging: docType → ChatAttachment
  const [staging, setStaging] = useState<Record<string, ChatAttachment>>({});
  // dialog: pick doc type for an attachment
  const [addingAtt, setAddingAtt] = useState<ChatAttachment | null>(null);
  // dialog: conflict when slot already filled
  const [conflictState, setConflictState] = useState<{
    docType: string;
    incomingAtt: ChatAttachment;
  } | null>(null);
  const [documentToDelete, setDocumentToDelete] = useState<PersistedDocument | null>(null);
  const [deletingDocumentId, setDeletingDocumentId] = useState<number | null>(null);
  const [uploadingDocumentType, setUploadingDocumentType] = useState<string | null>(null);
  const [pasteTargetDocumentType, setPasteTargetDocumentType] = useState<string | null>(null);
  const [filePickerDocumentType, setFilePickerDocumentType] = useState<string | null>(null);
  const manualFileInputRef = useRef<HTMLInputElement | null>(null);
  // extracting state for analyze button
  const [extracting, setExtracting] = useState(false);

  // ── Backend docs — pre-populate staging for persistence across reloads ───────
  const leadId = (detail as any).lead?.id as number | undefined;
  const studentId = (detail as any).student?.id as number | undefined;
  // Student wins: if both exist, fetch the student's documents (the canonical
  // record after lead→student conversion) instead of the lead's documents.
  const ownerKey = studentId ? `student:${studentId}` : leadId ? `lead:${leadId}` : null;
  const docsEndpoint = studentId
    ? `${BASE_URL}/api/students/${studentId}/documents`
    : leadId
    ? `${BASE_URL}/api/leads/${leadId}/documents`
    : null;

  const { data: backendDocs = [], refetch: refetchBackendDocs } = useQuery<PersistedDocument[]>({
    queryKey: ["inbox-staging-docs", ownerKey],
    queryFn: () =>
      fetch(docsEndpoint!, { credentials: "include" }).then((r) =>
        r.ok ? r.json() : []
      ),
    enabled: !!docsEndpoint,
    staleTime: 30_000,
  });

  // Set of doc types already present in the student/lead profile (regardless of
  // how they were uploaded — includes docs with sourceAttachmentId: null).
  // Used to mark checklist rows "done" even when there is no matching chat attachment.
  const backendDocTypes = useMemo(
    () => new Set(backendDocs.map((d) => d.type).filter(Boolean)),
    [backendDocs]
  );

  const initializedOwnerRef = useRef<string | null>(null);

  useEffect(() => {
    if (!ownerKey || backendDocs.length === 0) return;
    if (initializedOwnerRef.current === ownerKey) return;
    initializedOwnerRef.current = ownerKey;

    const allAtts = extractChatAttachments((detail as any).messages ?? [], t);
    const attMap = new Map<string, ChatAttachment>();
    for (const att of allAtts) {
      attMap.set(`${att.msgId}:${att.attachIdx}`, att);
    }

    setStaging((prev) => {
      let changed = false;
      const next = { ...prev };
      for (const doc of backendDocs) {
        if (!doc.sourceAttachmentId || !doc.type) continue;
        if (next[doc.type]) continue;
        const att = attMap.get(doc.sourceAttachmentId);
        if (!att) continue;
        next[doc.type] = att;
        changed = true;
      }
      return changed ? next : prev;
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ownerKey, backendDocs]);

  // Keep the level chosen in the chat attachment modal and the Documents tab
  // in one shared state. Without this, Add→Master silently reopened Documents
  // on Bachelor and the saved Master document could never fill its slot.
  useEffect(() => {
    if (initialLevel && initialLevel !== selectedLevel) {
      setSelectedLevel(initialLevel);
    }
  }, [initialLevel, selectedLevel]);

  // ── Default level to Bachelor when levels load ─────────────────────────────
  useEffect(() => {
    if (levels.length > 0 && !selectedLevel) {
      const bach =
        levels.find((l) => l.key.toLowerCase().includes("bachelor")) ??
        levels[0];
      setSelectedLevel(bach.key);
      onLevelChange?.(bach.key);
    }
  }, [levels, selectedLevel, onLevelChange]);

  // ── Effective doc requirements (merged program + degree — the SAME set the
  // POST /applications mandatory-doc gate enforces). Falls back to level-only
  // when no program is selected yet.
  const {
    data: effReqs,
    isLoading: docReqsLoading,
    isError: docReqsError,
  } = useQuery<EffectiveDocReqsResponse>({
    queryKey: ["effective-doc-reqs", programId ?? null, selectedLevel],
    queryFn: () => {
      const params = new URLSearchParams();
      if (programId) params.set("programId", String(programId));
      if (selectedLevel) params.set("level", selectedLevel);
      return fetch(`${BASE_URL}/api/document-requirements/effective?${params.toString()}`, {
        credentials: "include",
      }).then((r) => {
        if (!r.ok) throw new Error(`Document requirements request failed (${r.status})`);
        return r.json();
      });
    },
    enabled: !!selectedLevel || !!programId,
    staleTime: 30_000,
  });
  const docReqs: DocReq[] = effReqs?.requirements ?? [];

  // ── Chat attachments from conversation messages ────────────────────────────
  const attachments = useMemo(
    () => extractChatAttachments((detail as any).messages ?? [], t),
    [detail, t]
  );

  useEffect(() => {
    const handlePaste = (event: ClipboardEvent) => {
      const target = event.target as HTMLElement | null;
      const targetAcceptsText =
        target?.tagName === "INPUT" ||
        target?.tagName === "TEXTAREA" ||
        target?.isContentEditable;
      if (!pasteTargetDocumentType || targetAcceptsText) return;

      const imageItem = Array.from(event.clipboardData?.items ?? []).find(
        (item) => item.kind === "file" && item.type.startsWith("image/"),
      );
      const blob = imageItem?.getAsFile();
      if (!blob) return;

      event.preventDefault();
      const extension = blob.type === "image/png" ? "png" : "jpg";
      const stamp = new Date().toISOString().replace(/[:.]/g, "-");
      const file = new File([blob], `screenshot-${stamp}.${extension}`, { type: blob.type });
      const documentType = pasteTargetDocumentType;
      setPasteTargetDocumentType(null);
      void handleManualDocumentUpload(file, documentType);
    };

    window.addEventListener("paste", handlePaste);
    return () => window.removeEventListener("paste", handlePaste);
  }, [pasteTargetDocumentType, uploadingDocumentType, ownerKey]);

  const sortedDocReqs = useMemo(
    () => [...docReqs].sort((a, b) => a.sortOrder - b.sortOrder),
    [docReqs]
  );

  const unmatchedBackendDocs = useMemo(
    () =>
      backendDocs.filter(
        (doc) =>
          !sortedDocReqs.some(
            (req) =>
              findMissingMandatoryTypes(
                [req.documentType],
                new Set([doc.type]),
              ).length === 0,
          ),
      ),
    [backendDocs, sortedDocReqs],
  );

  const stagedCount = Object.keys(staging).length;
  const mandatoryDocumentTypes = useMemo(
    () => sortedDocReqs.filter((req) => req.mandatory).map((req) => req.documentType),
    [sortedDocReqs],
  );
  const providedDocumentTypes = useMemo(
    () => Array.from(new Set([...backendDocTypes, ...Object.keys(staging)])),
    [backendDocTypes, staging],
  );
  const missingMandatoryDocumentTypes = useMemo(
    () => findMissingMandatoryTypes(
      mandatoryDocumentTypes,
      new Set(providedDocumentTypes),
    ),
    [mandatoryDocumentTypes, providedDocumentTypes],
  );

  // ── Handlers ───────────────────────────────────────────────────────────────

  function handleAddClick(att: ChatAttachment) {
    if (!selectedLevel) {
      toast({
        title: t("inbox.studentTab.selectLevelFirst"),
        variant: "destructive",
      });
      return;
    }
    if (sortedDocReqs.length === 0) {
      toast({
        title: t("inbox.studentTab.noDocReqs"),
        variant: "destructive",
      });
      return;
    }
    setAddingAtt(att);
  }

  function handleDocTypePick(docType: string) {
    if (!addingAtt) return;
    const incoming = addingAtt;
    setAddingAtt(null);
    if (staging[docType]) {
      setConflictState({ docType, incomingAtt: incoming });
      return;
    }
    setStaging((prev) => ({ ...prev, [docType]: incoming }));
  }

  function handleConflictReplace() {
    if (!conflictState) return;
    setStaging((prev) => ({
      ...prev,
      [conflictState.docType]: conflictState.incomingAtt,
    }));
    setConflictState(null);
  }

  function handleRemoveStaged(docType: string) {
    setStaging((prev) => {
      const next = { ...prev };
      delete next[docType];
      return next;
    });
  }

  async function handleDeletePersistedDocument() {
    if (!documentToDelete || deletingDocumentId !== null) return;
    const target = documentToDelete;
    setDeletingDocumentId(target.id);
    try {
      await customFetch(`/api/documents/${target.id}`, { method: "DELETE" });
      setStaging((prev) => {
        const staged = prev[target.type];
        if (
          !staged ||
          !target.sourceAttachmentId ||
          `${staged.msgId}:${staged.attachIdx}` !== target.sourceAttachmentId
        ) {
          return prev;
        }
        const next = { ...prev };
        delete next[target.type];
        return next;
      });
      await refetchBackendDocs();
      setDocumentToDelete(null);
      onUpdated?.();
      toast({ title: t("appDocsPanel.documentDeleted") });
    } catch (error) {
      toast({
        title: t("studentDetailPage.deleteTooltip"),
        description: error instanceof Error ? error.message : "Failed to delete document",
        variant: "destructive",
      });
    } finally {
      setDeletingDocumentId(null);
    }
  }

  async function handleManualDocumentUpload(file: File, documentType: string) {
    if (uploadingDocumentType || !ownerKey) return;
    const ownerType = studentId ? "student" : "lead";
    const ownerId = studentId ?? leadId;
    if (!ownerId) {
      toast({
        title: t("inbox.studentTab.manualUploadFailed"),
        description: t("inbox.studentTab.noLinkedOwner"),
        variant: "destructive",
      });
      return;
    }

    setUploadingDocumentType(documentType);
    try {
      const uploaded = await uploadDocumentFile(file);
      await customFetch(`/api/inbox/conversations/${conversationId}/manual-document`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ownerType,
          ownerId,
          documentType,
          fileKey: uploaded.fileKey,
          mimeType: uploaded.mimeType,
          sizeBytes: uploaded.sizeBytes,
          originalFileName: file.name,
        }),
      });
      await refetchBackendDocs();
      onUpdated?.();
      toast({ title: t("inbox.studentTab.manualUploadSuccess") });
    } catch (error) {
      toast({
        title: t("inbox.studentTab.manualUploadFailed"),
        description: error instanceof Error ? error.message : t("common.uploadFailed"),
        variant: "destructive",
      });
    } finally {
      setUploadingDocumentType(null);
    }
  }

  async function handleAnalyzeAndCreate() {
    if (docReqsLoading || docReqsError) {
      toast({
        title: t("inbox.studentTab.requiredDocs"),
        description: docReqsError
          ? "Document requirements could not be verified."
          : "Document requirements are still loading.",
        variant: "destructive",
      });
      return;
    }
    if (missingMandatoryDocumentTypes.length > 0) {
      toast({
        title: t("inbox.studentTab.fillRequired"),
        description: missingMandatoryDocumentTypes.map(docLabel).join(", "),
        variant: "destructive",
      });
      return;
    }
    if (stagedCount === 0) {
      toast({
        title: t("inbox.studentTab.noDocsToAnalyze"),
        variant: "destructive",
      });
      return;
    }
    setExtracting(true);

    const extracted: Record<string, any> = {};
    const extractedFieldsSet = new Set<string>();

    for (const [docType, att] of Object.entries(staging)) {
      try {
        const res = (await customFetch(
          `/api/inbox/conversations/${conversationId}/messages/${att.msgId}/attachments/${att.attachIdx}/extract-for-student`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ docType }),
          }
        )) as any;
        const data = (res?.extracted ?? {}) as Record<string, any>;
        const FIELDS = [
          "firstName",
          "lastName",
          "email",
          "phone",
          "gender",
          "nationality",
          "dateOfBirth",
          "address",
          "addressCity",
          "postalCode",
          "passportNumber",
          "passportIssueDate",
          "passportExpiry",
          "motherName",
          "fatherName",
          "highSchool",
          "institutionName",
          "schoolName",
          "fieldOfStudy",
          "educationCountry",
          "graduationYear",
          "gpa",
          "gpaScale",
          "languageScore",
        ];
        for (const fk of FIELDS) {
          const val = data[fk];
          if (val !== null && val !== undefined && val !== "") {
            extracted[fk] = String(val);
            extractedFieldsSet.add(fk);
          }
        }
      } catch {
        /* extraction failed for this doc — continue with others */
      }
    }

    const ext = (detail as any).externalContact ?? null;
    const conv = (detail as any).conversation ?? null;
    const displayName = (ext?.displayName || conv?.title || "").trim();
    const parts = displayName.split(/\s+/).filter(Boolean);

    const normalizedGpa = normalizeInboxGpaForForm(
      extracted.gpa,
      extracted.gpaScale,
    );
    const contactPrefill = resolveInboxStudentContactPrefill(detail, extracted);
    if (extracted.institutionName || extracted.schoolName || extracted.highSchool) {
      extractedFieldsSet.add("school1");
    }
    if (extracted.fieldOfStudy) extractedFieldsSet.add("educationProgram");
    if (extracted.educationCountry) extractedFieldsSet.add("educationCountry");

    setExtracting(false);
    onReadyToSubmit?.({
      form: {
        firstName: toLatinUpper(extracted.firstName || parts[0] || ""),
        lastName: toLatinUpper(extracted.lastName || parts.slice(1).join(" ") || ""),
        email: contactPrefill.email,
        phone: contactPrefill.phone,
        gender: normalizeInboxGender(extracted.gender),
        motherName: toLatinUpper(extracted.motherName || ""),
        fatherName: toLatinUpper(extracted.fatherName || ""),
        nationality: extracted.nationality || "",
        dateOfBirth: extracted.dateOfBirth || "",
        address: transliterateToLatin(extracted.address || "").toUpperCase(),
        addressCity: transliterateToLatin(extracted.addressCity || "").toUpperCase(),
        postalCode: extracted.postalCode || "",
        passportNumber: extracted.passportNumber || "",
        passportIssueDate: (extracted as any).passportIssueDate || "",
        passportExpiry: extracted.passportExpiry || "",
        school1: transliterateToLatin(
          extracted.institutionName || extracted.schoolName || extracted.highSchool || "",
        ).toUpperCase(),
        school2: "",
        educationProgram: transliterateToLatin(extracted.fieldOfStudy || "").toUpperCase(),
        educationCountry: extracted.educationCountry || "",
        graduationYear: (extracted as any).graduationYear != null
          ? String((extracted as any).graduationYear)
          : "",
        gpa: normalizedGpa.gpa,
        gradingSystem: normalizedGpa.gradingSystem,
        languageScore: extracted.languageScore || "",
        notes: "",
      },
      staging,
      aiFields: extractedFieldsSet,
      selectedLevel,
      leadId: leadId ?? null,
      mandatoryDocumentTypes,
      providedDocumentTypes,
      persistedDocumentTypes: Array.from(backendDocTypes),
    });
  }

  // ── Derived ────────────────────────────────────────────────────────────────
  const isHigherLevel = isMasterOrHigher(selectedLevel);
  const isPhd = isDoctorate(selectedLevel);

  const docLabel = (docType: string) => {
    const fromBackend = docReqs.find(
      (r) => r.documentType.toLowerCase() === docType.toLowerCase()
    )?.label;
    return inboxDocumentLabel(t, docType, fromBackend);
  };

  const persistedDocLabel = (docType: string) => {
    const fromRequirements = docReqs.find(
      (r) => r.documentType.toLowerCase() === docType.toLowerCase()
    )?.label;
    if (fromRequirements) return fromRequirements;
    return docType
      .replace(/[_-]+/g, " ")
      .replace(/\b\w/g, (character) => character.toUpperCase());
  };

  const school1Label = isHigherLevel
    ? t("inbox.studentTab.bachelorUni")
    : t("inbox.studentTab.highSchool");
  const school1Placeholder = isHigherLevel
    ? t("inbox.studentTab.bachelorUniPlaceholder")
    : t("inbox.studentTab.highSchoolPlaceholder");

  // ── Render ─────────────────────────────────────────────────────────────────

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {/* Level selector */}
      <div className="px-3 pt-3 pb-2.5 border-b shrink-0">
        <div className="text-[11px] text-muted-foreground uppercase tracking-wide mb-1.5">
          {t("inbox.studentTab.level")}
        </div>
        {levelsLoading ? (
          <div className="h-8 flex items-center gap-2">
            <Loader2 className="w-3.5 h-3.5 animate-spin text-muted-foreground" />
            <span className="text-xs text-muted-foreground">…</span>
          </div>
        ) : (
          <Select
            value={selectedLevel}
            onValueChange={(nextLevel) => {
              setSelectedLevel(nextLevel);
              onLevelChange?.(nextLevel);
            }}
          >
            <SelectTrigger className="h-8 text-sm">
              <SelectValue placeholder={t("inbox.studentTab.selectLevel")} />
            </SelectTrigger>
            <SelectContent>
              {levels.map((l) => (
                <SelectItem key={l.key} value={l.key}>
                  {l.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
      </div>

      {/* Scrollable middle */}
      <div className="flex-1 overflow-y-auto">
        {/* Required doc slots */}
        {selectedLevel ? (
          <div className="px-3 pt-3 pb-2 space-y-1">
            <div className="mb-2 flex items-center justify-between gap-2">
              <div className="text-[11px] text-muted-foreground uppercase tracking-wide">
                {t("inbox.studentTab.requiredDocs")}
              </div>
            </div>
            <input
              ref={manualFileInputRef}
              type="file"
              className="hidden"
              accept="application/pdf,image/jpeg,image/png"
              onChange={(event) => {
                const file = event.target.files?.[0] ?? null;
                const documentType = filePickerDocumentType;
                event.target.value = "";
                setFilePickerDocumentType(null);
                if (file && documentType) void handleManualDocumentUpload(file, documentType);
              }}
              data-testid="inbox-manual-document-input"
            />
            {programId && programName ? (
              <p className="text-[10px] text-primary/80 mb-1.5" data-testid="doc-reqs-program-note">
                {t("inbox.studentTab.programScopedNote", { name: programName })}
              </p>
            ) : (
              <p className="text-[10px] text-muted-foreground mb-1.5" data-testid="doc-reqs-pending-note">
                {t("inbox.studentTab.programPendingNote")}
              </p>
            )}
            {docReqsLoading ? (
              <div className="flex items-center gap-2 py-2 text-xs text-muted-foreground">
                <Loader2 className="w-3 h-3 animate-spin" />
                <span>…</span>
              </div>
            ) : sortedDocReqs.length === 0 ? (
              <p className="text-xs text-muted-foreground py-1">
                {t("inbox.studentTab.noDocReqs")}
              </p>
            ) : (
              sortedDocReqs.map((req) => {
                const Icon = getDocIcon(req.documentType);
                // staged: a ChatAttachment linked via this conversation (has a name + removable)
                const staged = staging[req.documentType];
                const persistedDocsForRequirement = backendDocs.filter(
                  (doc) =>
                    findMissingMandatoryTypes(
                      [req.documentType],
                      new Set([doc.type]),
                    ).length === 0,
                );
                const stagedSourceAttachmentId = staged
                  ? `${staged.msgId}:${staged.attachIdx}`
                  : null;
                const stagedAlreadyPersisted =
                  !!stagedSourceAttachmentId &&
                  persistedDocsForRequirement.some(
                    (doc) => doc.sourceAttachmentId === stagedSourceAttachmentId,
                  );
                // isDone: "tamamlandı" — either a chat attachment staged OR already in the
                // student/lead profile from any upload path (incl. sourceAttachmentId: null)
                const isDone =
                  !!staged ||
                  findMissingMandatoryTypes([req.documentType], backendDocTypes).length === 0;
                return (
                  <div
                    key={req.documentType}
                    className="group py-0.5"
                  >
                    <div className="flex items-center gap-2">
                      <Icon
                        className={`w-3.5 h-3.5 shrink-0 ${
                          isDone
                            ? "text-emerald-600"
                            : "text-muted-foreground/50"
                        }`}
                      />
                      <div className="flex-1 min-w-0">
                        <span
                          className={`text-xs ${
                            isDone
                              ? "text-foreground font-medium"
                              : req.mandatory
                                ? "text-rose-600 font-medium"
                                : "text-muted-foreground"
                          }`}
                        >
                          {docLabel(req.documentType)}
                        </span>
                        {req.mandatory && !isDone && (
                          <span className="ms-1.5 text-[10px] bg-rose-100 text-rose-600 px-1 py-0.5 rounded-full">
                            {t("inbox.studentTab.required")}
                          </span>
                        )}
                        {staged && !stagedAlreadyPersisted && (
                          <span className="ms-1.5 text-[10px] text-emerald-600 truncate">
                            {staged.name}
                          </span>
                        )}
                      </div>
                      {staged && !stagedAlreadyPersisted ? (
                        <button
                          type="button"
                          onClick={() => handleRemoveStaged(req.documentType)}
                          className="shrink-0 opacity-0 group-hover:opacity-100 transition-opacity"
                          aria-label="Remove"
                        >
                          <XIcon className="w-3 h-3 text-muted-foreground hover:text-destructive" />
                        </button>
                      ) : null}
                      {isDone ? (
                        <CheckCircle2 className="w-3.5 h-3.5 text-emerald-500 shrink-0" />
                      ) : (
                        <Circle className="w-3.5 h-3.5 text-muted-foreground/40 shrink-0" />
                      )}
                      <button
                        type="button"
                        className="shrink-0 rounded p-0.5 text-muted-foreground transition-colors hover:bg-primary/10 hover:text-primary disabled:opacity-40"
                        onClick={() => {
                          setPasteTargetDocumentType(null);
                          setFilePickerDocumentType(req.documentType);
                          manualFileInputRef.current?.click();
                        }}
                        disabled={!ownerKey || uploadingDocumentType !== null}
                        title={`${docLabel(req.documentType)} · ${t("inbox.studentTab.uploadFromDevice")}`}
                        aria-label={`${docLabel(req.documentType)} · ${t("inbox.studentTab.uploadFromDevice")}`}
                        data-testid={`upload-document-${req.documentType}`}
                      >
                        {uploadingDocumentType === req.documentType ? (
                          <Loader2 className="h-3.5 w-3.5 animate-spin" />
                        ) : (
                          <Upload className="h-3.5 w-3.5" />
                        )}
                      </button>
                      <button
                        type="button"
                        className={`shrink-0 rounded p-0.5 transition-colors disabled:opacity-40 ${
                          pasteTargetDocumentType === req.documentType
                            ? "bg-primary/10 text-primary"
                            : "text-muted-foreground hover:bg-primary/10 hover:text-primary"
                        }`}
                        onClick={() => {
                          setPasteTargetDocumentType(req.documentType);
                          toast({
                            title: t("inbox.studentTab.pasteReady"),
                            description: `${docLabel(req.documentType)} · ${t("inbox.studentTab.pasteInstruction")}`,
                          });
                        }}
                        disabled={!ownerKey || uploadingDocumentType !== null}
                        title={`${docLabel(req.documentType)} · ${t("inbox.studentTab.pasteScreenshot")}`}
                        aria-label={`${docLabel(req.documentType)} · ${t("inbox.studentTab.pasteScreenshot")}`}
                        data-testid={`paste-document-${req.documentType}`}
                      >
                        <ClipboardPaste className="h-3.5 w-3.5" />
                      </button>
                    </div>
                    {persistedDocsForRequirement.length > 0 && (
                      <div className="ms-5 mt-1 space-y-1">
                        {persistedDocsForRequirement.map((doc) => {
                          const fileName =
                            doc.fileName || doc.name || persistedDocLabel(doc.type);
                          return (
                            <div
                              key={doc.id}
                              className="flex min-w-0 items-center gap-1.5 rounded-md bg-muted/50 px-1.5 py-1"
                            >
                              <FileText className="h-3 w-3 shrink-0 text-emerald-600" />
                              <span
                                className="min-w-0 flex-1 truncate text-[10px] text-muted-foreground"
                                title={fileName}
                              >
                                {fileName}
                              </span>
                              <button
                                type="button"
                                className="shrink-0 rounded p-0.5 text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive focus-visible:text-destructive"
                                onClick={() => setDocumentToDelete(doc)}
                                title={t("studentDetailPage.deleteTooltip")}
                                aria-label={`${t("studentDetailPage.deleteTooltip")}: ${fileName}`}
                                data-testid={`delete-inbox-document-${doc.id}`}
                              >
                                <Trash2 className="h-3 w-3" />
                              </button>
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </div>
                );
              })
            )}
          </div>
        ) : (
          !levelsLoading && (
            <div className="px-3 py-6 text-center">
              <p className="text-sm text-muted-foreground">
                {t("inbox.studentTab.selectLevelFirst")}
              </p>
            </div>
          )
        )}

        {/* Persisted profile documents. Deleting here removes only the linked
            document record; the original conversation attachment remains. */}
        {unmatchedBackendDocs.length > 0 && (
          <div className="border-t px-3 py-3 space-y-2">
            <div className="text-[11px] text-muted-foreground uppercase tracking-wide">
              {t("studentDetailPage.documents")}
            </div>
            {unmatchedBackendDocs.map((doc) => {
              const fileName = doc.fileName || doc.name || persistedDocLabel(doc.type);
              return (
                <div key={doc.id} className="group flex min-w-0 items-center gap-2">
                  <FileText className="h-3.5 w-3.5 shrink-0 text-emerald-600" />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-xs font-medium" title={fileName}>
                      {fileName}
                    </p>
                    <p className="truncate text-[10px] text-muted-foreground">
                      {persistedDocLabel(doc.type)}
                    </p>
                  </div>
                  <button
                    type="button"
                    className="shrink-0 rounded-md p-1 text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive focus-visible:text-destructive"
                    onClick={() => setDocumentToDelete(doc)}
                    title={t("studentDetailPage.deleteTooltip")}
                    aria-label={`${t("studentDetailPage.deleteTooltip")}: ${fileName}`}
                    data-testid={`delete-inbox-document-${doc.id}`}
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </div>
              );
            })}
          </div>
        )}

        {/* Chat attachments */}
        <div className="px-3 pt-2 pb-3 border-t space-y-2 mt-1">
          <div className="text-[11px] text-muted-foreground uppercase tracking-wide">
            {t("inbox.studentTab.chatAttachments")}
          </div>
          {attachments.length === 0 ? (
            <p className="text-xs text-muted-foreground py-1">
              {t("inbox.studentTab.noAttachments")}
            </p>
          ) : (
            attachments.map((att) => {
              const alreadyUsedAs = Object.entries(staging).find(
                ([, v]) =>
                  v.msgId === att.msgId && v.attachIdx === att.attachIdx
              )?.[0];
              return (
                <div
                  key={`${att.msgId}-${att.attachIdx}`}
                  className="flex items-center gap-2"
                >
                  <Paperclip className="w-3 h-3 text-muted-foreground shrink-0" />
                  <span
                    className="text-xs flex-1 min-w-0 truncate"
                    title={att.name}
                  >
                    {att.name}
                  </span>
                  {alreadyUsedAs ? (
                    <span className="text-[10px] bg-emerald-100 text-emerald-700 px-1.5 py-0.5 rounded-full shrink-0 max-w-[80px] truncate">
                      {alreadyUsedAs}
                    </span>
                  ) : (
                    <Button
                      size="sm"
                      variant="outline"
                      className="h-5 text-[10px] px-2 shrink-0"
                      onClick={() => handleAddClick(att)}
                    >
                      {t("inbox.studentTab.addBtn")}
                    </Button>
                  )}
                </div>
              );
            })
          )}
        </div>
      </div>

      {/* AI button */}
      <div className="px-3 py-3 border-t shrink-0">
        <Button
          className="w-full h-8 text-xs gap-1.5"
          onClick={() => {
            void handleAnalyzeAndCreate();
          }}
          disabled={
            stagedCount === 0 ||
            extracting ||
            docReqsLoading ||
            docReqsError ||
            missingMandatoryDocumentTypes.length > 0
          }
        >
          {extracting ? (
            <Loader2 className="w-3.5 h-3.5 shrink-0 animate-spin" />
          ) : (
            <FileText className="w-3.5 h-3.5 shrink-0" />
          )}
          {extracting
            ? t("inbox.studentTab.extracting")
            : t("inbox.studentTab.analyzeBtn")}
        </Button>
        {stagedCount === 0 && !extracting && (
          <p className="text-center text-[10px] text-muted-foreground mt-1">
            {t("inbox.studentTab.noDocsToAnalyze")}
          </p>
        )}
        {stagedCount > 0 && missingMandatoryDocumentTypes.length > 0 && !extracting && (
          <p className="text-center text-[10px] text-rose-600 mt-1">
            {missingMandatoryDocumentTypes.map(docLabel).join(", ")}
          </p>
        )}
        {docReqsError && !extracting && (
          <p className="text-center text-[10px] text-rose-600 mt-1">
            Document requirements could not be verified.
          </p>
        )}
      </div>

      {/* ── Doc type picker dialog ──────────────────────────────────────────── */}
      <Dialog
        open={!!addingAtt}
        onOpenChange={(open) => {
          if (!open) setAddingAtt(null);
        }}
      >
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle className="text-sm">
              {t("inbox.studentTab.selectDocType")}
            </DialogTitle>
          </DialogHeader>
          <div className="py-1 space-y-3">
            {addingAtt && (
              <p className="text-xs text-muted-foreground truncate">
                {addingAtt.name}
              </p>
            )}
            {sortedDocReqs.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                {t("inbox.studentTab.noDocReqs")}
              </p>
            ) : (
              <div className="grid grid-cols-2 gap-2">
                {sortedDocReqs.map((req) => {
                  const Icon = getDocIcon(req.documentType);
                  const filled = !!staging[req.documentType] || backendDocTypes.has(req.documentType);
                  return (
                    <button
                      key={req.documentType}
                      type="button"
                      onClick={() => handleDocTypePick(req.documentType)}
                      className={`flex flex-col items-center gap-1.5 p-3 rounded-lg border text-center cursor-pointer transition-colors ${
                        filled
                          ? "border-emerald-300 bg-emerald-50 text-emerald-700"
                          : "border-border hover:border-primary hover:bg-primary/5"
                      }`}
                    >
                      <Icon className="w-5 h-5" />
                      <span className="text-xs font-medium">
                        {docLabel(req.documentType)}
                      </span>
                      {filled && (
                        <span className="text-[10px] text-emerald-600">
                          {t("inbox.studentTab.filled")}
                        </span>
                      )}
                    </button>
                  );
                })}
              </div>
            )}
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              size="sm"
              onClick={() => setAddingAtt(null)}
            >
              {t("inbox.studentTab.cancel")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ── Persisted document delete confirmation ────────────────────────── */}
      <Dialog
        open={documentToDelete !== null}
        onOpenChange={(open) => {
          if (!open && deletingDocumentId === null) setDocumentToDelete(null);
        }}
      >
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle className="text-sm">
              {t("studentDetailPage.deleteTooltip")}
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-2 py-1">
            <p className="text-sm text-muted-foreground">
              {t("studentDetailPage.deleteConfirm")}
            </p>
            {documentToDelete && (
              <p className="truncate text-sm font-medium" title={documentToDelete.fileName || documentToDelete.name || undefined}>
                {documentToDelete.fileName || documentToDelete.name || persistedDocLabel(documentToDelete.type)}
              </p>
            )}
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              size="sm"
              disabled={deletingDocumentId !== null}
              onClick={() => setDocumentToDelete(null)}
            >
              {t("inbox.studentTab.cancel")}
            </Button>
            <Button
              variant="destructive"
              size="sm"
              className="gap-1.5"
              disabled={deletingDocumentId !== null}
              onClick={() => void handleDeletePersistedDocument()}
              data-testid="confirm-delete-inbox-document"
            >
              {deletingDocumentId !== null && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
              {t("studentDetailPage.deleteTooltip")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ── Conflict dialog ─────────────────────────────────────────────────── */}
      <Dialog
        open={!!conflictState}
        onOpenChange={(open) => {
          if (!open) setConflictState(null);
        }}
      >
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle className="text-sm">
              {t("inbox.studentTab.conflictTitle")}
            </DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground py-2">
            {t("inbox.studentTab.conflictBody", {
              type: conflictState?.docType ?? "",
            })}
          </p>
          <DialogFooter>
            <Button
              variant="outline"
              size="sm"
              onClick={() => setConflictState(null)}
            >
              {t("inbox.studentTab.keepExisting")}
            </Button>
            <Button size="sm" onClick={handleConflictReplace}>
              {t("inbox.studentTab.replace")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
