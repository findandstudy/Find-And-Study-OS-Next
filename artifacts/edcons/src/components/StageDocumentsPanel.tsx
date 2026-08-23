import { useState, useRef } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { customFetch } from "@workspace/api-client-react";
import { formatDate } from "@workspace/i18n";
import { usePipelineStages } from "@/hooks/use-pipeline-stages";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import {
  Upload, FileText, Trash2, Download, Plus, X,
  AlertTriangle, ChevronDown, ChevronRight, Save, Calendar, Pencil, Camera,
} from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { useI18n } from "@/hooks/use-i18n";
import { validateApplicationDocumentFileObj as validateFile, sanitizeFileName, APPLICATION_DOCUMENT_ACCEPT_ATTRIBUTE, APPLICATION_DOCUMENT_HELP_TEXT } from "@/lib/fileUploadValidation";
import { DocumentScanner } from "@/components/DocumentScanner";

const BASE_URL = import.meta.env.BASE_URL?.replace(/\/$/, "") || "";

import { ADMIN_ROLES as _A, STAFF_ROLES as _S, AGENT_ROLES as _AG } from "@workspace/roles";
const ADMIN_ROLES = _A;
const STAFF_ROLES = _S;
const AGENT_ROLES = _AG;

async function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result as string;
      resolve(result.split(",")[1]);
    };
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

interface StageDocumentsPanelProps {
  applicationId: number;
  currentStage: string;
  userRole: string;
  userId?: number;
  excludeStages?: string[];
}

export function StageDocumentsPanel({ applicationId, currentStage, userRole, userId, excludeStages }: StageDocumentsPanelProps) {
  const { t } = useI18n();
  const { toast } = useToast();
  const qc = useQueryClient();

  const { data: allDocs = [] } = useQuery({
    queryKey: [`app-stage-docs-${applicationId}`],
    queryFn: () => customFetch(`${BASE_URL}/api/applications/${applicationId}/stage-documents`),
    staleTime: 15_000,
  });

  const { data: missingNotes = [] } = useQuery({
    queryKey: [`app-missing-notes-${applicationId}`],
    queryFn: () => customFetch(`${BASE_URL}/api/applications/${applicationId}/missing-doc-notes`),
    staleTime: 15_000,
  });

  const isAdmin = ADMIN_ROLES.includes(userRole);
  const isStaff = STAFF_ROLES.includes(userRole);
  const isAgent = AGENT_ROLES.includes(userRole);
  const restrictFuture = !isStaff;

  const { stages: pipelineStages } = usePipelineStages("application");
  const stageOrder = new Map<string, number>();
  pipelineStages.forEach((s, i) => stageOrder.set(s.key, s.sortOrder ?? i));
  const stageByKey = new Map(pipelineStages.map(s => [s.key, s]));
  const currentOrder = stageOrder.has(currentStage)
    ? (stageOrder.get(currentStage) as number)
    : Number.POSITIVE_INFINITY;
  function isFutureStage(stage: string): boolean {
    if (!stageOrder.has(stage)) return false;
    return (stageOrder.get(stage) as number) > currentOrder;
  }

  const docStages = pipelineStages
    .filter(s => (s.uploadPermissionLevel ?? "none") !== "none")
    .map(s => s.key);

  const notesByStage = new Map<string, any[]>();
  for (const n of (missingNotes as any[])) {
    const s = (n.stage as string) || "missing_docs";
    if (!notesByStage.has(s)) notesByStage.set(s, []);
    notesByStage.get(s)!.push(n);
  }

  const relevantStages = docStages.filter(stage => {
    if (excludeStages?.includes(stage)) return false;
    const docs = (allDocs as any[]).filter((d: any) => d.stage === stage && !d.isMissingDocNote);
    const notes = notesByStage.get(stage) ?? [];
    if (restrictFuture && isFutureStage(stage) && docs.length === 0 && notes.length === 0) {
      return false;
    }
    return docs.length > 0 || notes.length > 0 || stage === currentStage;
  });

  if (relevantStages.length === 0) return null;

  return (
    <div className="bg-card rounded-2xl border shadow-sm p-6 space-y-4">
      <h2 className="font-semibold text-foreground flex items-center gap-2">
        <FileText className="w-4 h-4 text-muted-foreground" />
        {t("stageDocs.title")}
      </h2>

      <div className="space-y-3">
        {relevantStages.map(stage => {
          const stageMeta = stageByKey.get(stage);
          return (
            <StageSection
              isAgent={isAgent}
              key={stage}
              applicationId={applicationId}
              stage={stage}
              stageLabel={stageMeta?.label || stage}
              uploadPermissionLevel={(stageMeta?.uploadPermissionLevel ?? "everyone") as string}
              tracksOfferExpiry={stageMeta?.tracksOfferExpiry === true}
              requiresValidUntilFlag={stageMeta?.requiresValidUntil === true}
              advanceOnUpload={isFutureStage(stage)}
              docs={(allDocs as any[]).filter((d: any) => d.stage === stage && !d.isMissingDocNote)}
              missingNotes={notesByStage.get(stage) ?? []}
              userRole={userRole}
              userId={userId}
              isAdmin={isAdmin}
              isStaff={isStaff}
              isCurrent={stage === currentStage}
              hideUpload={restrictFuture && isFutureStage(stage)}
            />
          );
        })}
      </div>
    </div>
  );
}

function StageSection({
  applicationId, stage, stageLabel, uploadPermissionLevel, tracksOfferExpiry, requiresValidUntilFlag, advanceOnUpload,
  docs, missingNotes, userRole, userId, isAdmin, isStaff, isAgent, isCurrent, hideUpload,
}: {
  applicationId: number;
  stage: string;
  stageLabel: string;
  uploadPermissionLevel: string;
  tracksOfferExpiry: boolean;
  requiresValidUntilFlag: boolean;
  advanceOnUpload: boolean;
  docs: any[];
  missingNotes: any[];
  userRole: string;
  userId?: number;
  isAdmin: boolean;
  isStaff: boolean;
  isAgent: boolean;
  isCurrent: boolean;
  hideUpload?: boolean;
}) {
  const { t, lang } = useI18n();
  const [expanded, setExpanded] = useState(isCurrent || docs.length > 0 || missingNotes.length > 0);
  const { toast } = useToast();
  const qc = useQueryClient();
  const fileRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  const [pendingValidUntil, setPendingValidUntil] = useState<string>("");
  const [editingDocId, setEditingDocId] = useState<number | null>(null);
  const [editValidUntil, setEditValidUntil] = useState<string>("");
  const [scannerOpen, setScannerOpen] = useState(false);

  const requiresValidUntil = requiresValidUntilFlag;
  const supportsValidUntil = tracksOfferExpiry || requiresValidUntilFlag;

  const canUpload = (() => {
    if (hideUpload) return false;
    if (uploadPermissionLevel === "none") return false;
    if (uploadPermissionLevel === "admin_only") return isAdmin;
    if (uploadPermissionLevel === "staff_only") return isStaff;
    if (uploadPermissionLevel === "staff_and_agent") return isStaff || isAgent;
    if (uploadPermissionLevel === "everyone") return true;
    return false;
  })();

  const uploadMutation = useMutation({
    mutationFn: async ({ file, documentNameOverride, respondingToNoteId }: {
      file: File;
      documentNameOverride?: string;
      respondingToNoteId?: number;
    }) => {
      const base64 = await fileToBase64(file);
      const body: any = {
        stage,
        fileName: file.name,
        fileData: base64,
        mimeType: file.type,
        sizeBytes: file.size,
      };
      if (documentNameOverride) body.documentNameOverride = documentNameOverride;
      if (respondingToNoteId) body.respondingToNoteId = respondingToNoteId;
      if (supportsValidUntil && pendingValidUntil) body.validUntil = pendingValidUntil;
      return customFetch(`${BASE_URL}/api/applications/${applicationId}/stage-documents`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
    },
    onSuccess: async () => {
      qc.invalidateQueries({ queryKey: [`app-stage-docs-${applicationId}`] });
      qc.invalidateQueries({ queryKey: [`app-missing-notes-${applicationId}`] });
      qc.invalidateQueries({
        predicate: (q) => typeof q.queryKey[0] === "string" && (q.queryKey[0] as string).startsWith("/api/applications"),
      });
      setPendingValidUntil("");
      // Mirror the kanban "Document Required" flow: uploading a document for a
      // stage ahead of the application's current stage auto-advances the
      // application to that stage. Forward-only (advanceOnUpload is only true
      // for future stages, which only staff can upload into).
      if (advanceOnUpload) {
        try {
          await customFetch(`${BASE_URL}/api/applications/${applicationId}`, {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ stage }),
          });
          qc.invalidateQueries({
            predicate: (q) => typeof q.queryKey[0] === "string" && (q.queryKey[0] as string).startsWith("/api/applications"),
          });
          toast({ title: t("stageDocUpload.toastUploadedAndMoved", { stage: stageLabel }) });
          return;
        } catch {
          // Upload saved but the stage move failed — fall through to the
          // plain upload-success toast.
        }
      }
      toast({ title: t("stageDocs.toastUploaded") });
    },
    onError: (err: any) => {
      toast({ title: t("stageDocs.toastUploadFailed"), description: err?.message || t("stageDocs.toastGenericError"), variant: "destructive" });
    },
  });

  const updateMutation = useMutation({
    mutationFn: async ({ docId, validUntil }: { docId: number; validUntil: string | null }) =>
      customFetch(`${BASE_URL}/api/applications/${applicationId}/stage-documents/${docId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ validUntil }),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: [`app-stage-docs-${applicationId}`] });
      setEditingDocId(null);
      setEditValidUntil("");
      toast({ title: t("stageDocs.toastValidUntilUpdated") });
    },
    onError: (err: any) => {
      toast({ title: t("stageDocs.toastValidUntilUpdateFailed"), description: err?.message, variant: "destructive" });
    },
  });

  const deleteMutation = useMutation({
    mutationFn: (docId: number) =>
      customFetch(`${BASE_URL}/api/applications/${applicationId}/stage-documents/${docId}`, { method: "DELETE" }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: [`app-stage-docs-${applicationId}`] });
      toast({ title: t("stageDocs.toastDeleted") });
    },
  });

  async function handleFileSelect(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    if (requiresValidUntil && !pendingValidUntil) {
      toast({ title: t("stageDocs.toastValidUntilRequired"), description: t("stageDocs.toastValidUntilRequiredDesc"), variant: "destructive" });
      if (fileRef.current) fileRef.current.value = "";
      return;
    }
    const validation = validateFile(file);
    if (!validation.valid) {
      toast({ title: t("stageDocs.toastFileError"), description: validation.message, variant: "destructive" });
      return;
    }
    setUploading(true);
    const safeFile = new File([file], sanitizeFileName(file.name), { type: file.type });
    await uploadMutation.mutateAsync({ file: safeFile });
    setUploading(false);
    if (fileRef.current) fileRef.current.value = "";
  }

  function handleDownload(doc: any) {
    const downloadUrl = `${BASE_URL}/api/applications/${applicationId}/stage-documents/${doc.id}/download`;
    const a = document.createElement("a");
    a.href = downloadUrl;
    a.download = doc.fileName;
    a.target = "_blank";
    a.click();
  }

  const isAdminOnlyStage = uploadPermissionLevel === "admin_only";
  const isStaffOnlyStage = uploadPermissionLevel === "staff_only";

  return (
    <div className="border rounded-xl overflow-hidden">
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-center justify-between p-3 hover:bg-secondary/50 transition-colors text-left"
      >
        <div className="flex items-center gap-2">
          {expanded ? <ChevronDown className="w-4 h-4 text-muted-foreground" /> : <ChevronRight className="w-4 h-4 text-muted-foreground" />}
          <span className="text-sm font-medium">{stageLabel}</span>
          {docs.length > 0 && (
            <Badge variant="secondary" className="text-xs px-1.5 py-0">{docs.length}</Badge>
          )}
          {isCurrent && (
            <Badge className="text-xs px-1.5 py-0 bg-primary/10 text-primary border-0">{t("stageDocs.current")}</Badge>
          )}
          {isAdminOnlyStage && (
            <Badge variant="outline" className="text-xs px-1.5 py-0 text-rose-600 border-rose-300">{t("stageDocs.adminUpload")}</Badge>
          )}
          {isStaffOnlyStage && (
            <Badge variant="outline" className="text-xs px-1.5 py-0 text-amber-600 border-amber-300">{t("stageDocs.staffUpload")}</Badge>
          )}
        </div>
      </button>

      {expanded && (
        <div className="px-3 pb-3 space-y-2">
          {missingNotes.length > 0 && (
            <MissingDocsSection
              applicationId={applicationId}
              notes={missingNotes}
              isAdmin={isAdmin}
              canUpload={canUpload}
              onUpload={async (file, note) => {
                const validation = validateFile(file);
                if (!validation.valid) {
                  toast({ title: t("stageDocs.toastFileError"), description: validation.message, variant: "destructive" });
                  return;
                }
                const safeFile = new File([file], sanitizeFileName(file.name), { type: file.type });
                await uploadMutation.mutateAsync({
                  file: safeFile,
                  documentNameOverride: note.fileName,
                  respondingToNoteId: note.id,
                });
              }}
            />
          )}

          {docs.length > 0 ? (
            <div className="space-y-1.5">
              {docs.map((doc: any) => {
                const validUntil = doc.validUntil ? new Date(doc.validUntil) : null;
                const daysLeft = validUntil
                  ? Math.ceil((validUntil.getTime() - Date.now()) / (1000 * 60 * 60 * 24))
                  : null;
                const isEditingThis = editingDocId === doc.id;
                return (
                <div key={doc.id} className="flex items-center gap-2 p-2 rounded-lg bg-secondary/30 text-sm group">
                  <FileText className="w-4 h-4 text-muted-foreground shrink-0" />
                  <div className="flex-1 min-w-0">
                    <p className="truncate font-medium text-foreground">{doc.fileName}</p>
                    <p className="text-xs text-muted-foreground">
                      {doc.uploadedByName || t("stageDocs.unknownUploader")} · {formatDate(doc.createdAt, lang)}
                      {doc.sizeBytes && ` · ${(doc.sizeBytes / 1024).toFixed(0)}KB`}
                    </p>
                    {validUntil && (
                      <div className="mt-1 flex items-center gap-1.5 flex-wrap">
                        <Badge variant="outline" className="text-[10px] px-1.5 py-0 gap-1">
                          <Calendar className="w-3 h-3" />
                          {t("stageDocs.validUntilLabel", { date: formatDate(validUntil, lang, "dateShort") })}
                        </Badge>
                        {daysLeft !== null && (
                          <Badge
                            className={`text-[10px] px-1.5 py-0 border-0 ${
                              daysLeft <= 0 ? "bg-red-100 text-red-700 dark:bg-red-950 dark:text-red-300"
                                : daysLeft <= 7 ? "bg-red-100 text-red-700 dark:bg-red-950 dark:text-red-300"
                                : daysLeft <= 14 ? "bg-amber-100 text-amber-700 dark:bg-amber-950 dark:text-amber-300"
                                : daysLeft <= 30 ? "bg-yellow-100 text-yellow-700 dark:bg-yellow-950 dark:text-yellow-300"
                                : "bg-emerald-100 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300"
                            }`}
                          >
                            {daysLeft <= 0 ? t("stageDocs.validUntilExpired") : t("stageDocs.validUntilDaysLeft", { n: daysLeft })}
                          </Badge>
                        )}
                      </div>
                    )}
                    {isEditingThis && (
                      <div className="mt-2 flex items-center gap-1.5">
                        <Input
                          type="date"
                          value={editValidUntil}
                          onChange={e => setEditValidUntil(e.target.value)}
                          className="h-7 text-xs w-40"
                        />
                        <Button
                          size="sm"
                          className="h-7 text-xs"
                          onClick={() => updateMutation.mutate({ docId: doc.id, validUntil: editValidUntil || null })}
                          disabled={updateMutation.isPending}
                        >
                          {t("stageDocs.save")}
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-7 text-xs"
                          onClick={() => { setEditingDocId(null); setEditValidUntil(""); }}
                        >
                          {t("stageDocs.cancel")}
                        </Button>
                      </div>
                    )}
                  </div>
                  <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                    {supportsValidUntil && isAdmin && !isEditingThis && (
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-7 w-7"
                        onClick={() => {
                          setEditingDocId(doc.id);
                          setEditValidUntil(validUntil ? validUntil.toISOString().slice(0, 10) : "");
                        }}
                        title={t("stageDocs.editValidUntil")}
                      >
                        <Pencil className="w-3.5 h-3.5" />
                      </Button>
                    )}
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-7 w-7"
                      onClick={() => handleDownload(doc)}
                      title={t("stageDocs.downloadTooltip")}
                    >
                      <Download className="w-3.5 h-3.5" />
                    </Button>
                    {(isAdmin || (userId && doc.uploadedBy === userId)) && (
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-7 w-7 text-destructive hover:text-destructive"
                        onClick={() => deleteMutation.mutate(doc.id)}
                        disabled={deleteMutation.isPending}
                        title={t("stageDocs.deleteTooltip")}
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </Button>
                    )}
                  </div>
                </div>
              );})}
            </div>
          ) : (
            stage !== "missing_docs" && (
              <p className="text-xs text-muted-foreground py-1">{t("stageDocs.noDocuments")}</p>
            )
          )}

          {canUpload && !(stage === "missing_docs" && missingNotes.some((note: any) => !note.fulfilledAt)) && (
            <div className="pt-1 space-y-1">
              {supportsValidUntil && (
                <div className="flex items-center gap-2">
                  <label className="text-xs text-muted-foreground shrink-0 flex items-center gap-1">
                    <Calendar className="w-3 h-3" />
                    {t("stageDocs.validUntilFieldLabel")}{requiresValidUntil ? " *" : ""}:
                  </label>
                  <Input
                    type="date"
                    value={pendingValidUntil}
                    onChange={e => setPendingValidUntil(e.target.value)}
                    className="h-7 text-xs flex-1"
                  />
                </div>
              )}
              <input
                ref={fileRef}
                type="file"
                className="hidden"
                onChange={handleFileSelect}
                accept={APPLICATION_DOCUMENT_ACCEPT_ATTRIBUTE}
              />
              <DocumentScanner
                open={scannerOpen}
                onClose={() => setScannerOpen(false)}
                baseName={stage || "scan"}
                onCapture={async (file) => {
                  if (requiresValidUntil && !pendingValidUntil) {
                    toast({ title: t("stageDocs.toastValidUntilRequired"), description: t("stageDocs.toastValidUntilRequiredDesc"), variant: "destructive" });
                    return;
                  }
                  const validation = validateFile(file);
                  if (!validation.valid) {
                    toast({ title: t("stageDocs.toastFileError"), description: validation.message, variant: "destructive" });
                    return;
                  }
                  setUploading(true);
                  try {
                    const safeFile = new File([file], sanitizeFileName(file.name), { type: file.type });
                    await uploadMutation.mutateAsync({ file: safeFile });
                  } catch (err: any) {
                    toast({ title: t("stageDocs.toastFileError"), description: err?.message || String(err), variant: "destructive" });
                  } finally {
                    setUploading(false);
                  }
                }}
              />
              <Button
                variant="outline"
                size="sm"
                className="gap-1.5 text-xs w-full"
                onClick={() => setScannerOpen(true)}
                disabled={uploading}
              >
                <Camera className="w-3.5 h-3.5" />
                {t("scanner.scanWithCamera")}
              </Button>
              <Button
                variant="outline"
                size="sm"
                className="gap-1.5 text-xs w-full"
                onClick={() => fileRef.current?.click()}
                disabled={uploading}
              >
                <Upload className="w-3.5 h-3.5" />
                {uploading ? t("stageDocs.uploading") : t("stageDocs.uploadDocument")}
              </Button>
              <p className="text-[10px] text-muted-foreground text-center">{APPLICATION_DOCUMENT_HELP_TEXT}</p>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function MissingDocsSection({
  applicationId, notes, isAdmin, canUpload, onUpload,
}: {
  applicationId: number;
  notes: any[];
  isAdmin: boolean;
  canUpload: boolean;
  onUpload: (file: File, note: any) => Promise<void>;
}) {
  const { t, lang } = useI18n();
  const { toast } = useToast();
  const qc = useQueryClient();

  // Resolve a catalog doc-type key to a localized label; fall back to a
  // humanized version of the slug when no translation exists.
  function localizeDocType(key: string) {
    const localized = t(`docTypes.${key}`);
    if (localized && localized !== `docTypes.${key}`) return localized;
    return key.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
  }

  async function toggleFulfilled(noteId: number, fulfilled: boolean) {
    try {
      await customFetch(`${BASE_URL}/api/applications/${applicationId}/missing-doc-notes/${noteId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ fulfilled }),
      });
      qc.invalidateQueries({ queryKey: [`app-missing-notes-${applicationId}`] });
      toast({ title: fulfilled ? t("stageDocs.toastClosed") : t("stageDocs.toastReopened") });
    } catch (err: any) {
      toast({ title: t("stageDocs.toastError"), description: err?.message, variant: "destructive" });
    }
  }

  async function removeNote(noteId: number) {
    if (!window.confirm(t("stageDocs.confirmDelete"))) return;
    try {
      await customFetch(`${BASE_URL}/api/applications/${applicationId}/missing-doc-notes/${noteId}`, {
        method: "DELETE",
      });
      qc.invalidateQueries({ queryKey: [`app-missing-notes-${applicationId}`] });
    } catch (err: any) {
      toast({ title: t("stageDocs.toastDeleteFailed"), description: err?.message, variant: "destructive" });
    }
  }

  if (notes.length === 0) {
    return (
      <div className="border rounded-lg p-2.5 bg-amber-50/50 dark:bg-amber-950/20">
        <div className="flex items-center gap-1.5">
          <AlertTriangle className="w-3.5 h-3.5 text-amber-600" />
          <span className="text-xs font-medium text-amber-700 dark:text-amber-400">{t("stageDocs.missingTitle")}</span>
        </div>
        <p className="text-xs text-muted-foreground mt-1">{t("stageDocs.missingEmpty")}</p>
      </div>
    );
  }

  return (
    <div className="border rounded-lg p-2.5 bg-amber-50/50 dark:bg-amber-950/20 space-y-2">
      <div className="flex items-center gap-1.5">
        <AlertTriangle className="w-3.5 h-3.5 text-amber-600" />
        <span className="text-xs font-medium text-amber-700 dark:text-amber-400">{t("stageDocs.missingTitle")}</span>
      </div>
      <ul className="space-y-1.5">
        {notes.map((note: any) => {
          const fulfilled = !!note.fulfilledAt;
          const responded = !!note.respondedAt;
          return (
            <li key={note.id} className="rounded-md border bg-background/60 px-2 py-1.5 text-xs">
              <div className="flex items-start gap-2">
                <span className={`w-1.5 h-1.5 rounded-full mt-1.5 shrink-0 ${fulfilled ? "bg-emerald-500" : responded ? "bg-blue-500" : "bg-amber-500"}`} />
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-1.5 flex-wrap">
                    <span className={`font-medium ${fulfilled ? "line-through text-muted-foreground" : ""}`}>
                      {note.isCustom ? note.fileName : localizeDocType(note.fileName)}
                    </span>
                    <Badge variant={note.isCustom ? "secondary" : "outline"} className="text-[9px] h-4 px-1">
                      {note.isCustom ? t("stageDocs.badgeCustom") : t("stageDocs.badgeCatalog")}
                    </Badge>
                    {fulfilled && (
                      <Badge variant="outline" className="text-[9px] h-4 px-1 border-emerald-400 text-emerald-700">
                        {t("stageDocs.badgeFulfilled")}
                      </Badge>
                    )}
                    {responded && !fulfilled && (
                      <Badge variant="outline" className="text-[9px] h-4 px-1 border-blue-400 text-blue-700">
                        {t("stageDocs.badgeUploadedAwaiting")}
                      </Badge>
                    )}
                  </div>
                  {note.note && (
                    <p className="text-[11px] text-muted-foreground mt-0.5">{note.note}</p>
                  )}
                  {note.isDerived ? (
                    <p className="text-[10px] text-muted-foreground mt-0.5">{t("stageDocs.derivedRequest")}</p>
                  ) : (
                    <p className="text-[10px] text-muted-foreground mt-0.5">
                      {t("stageDocs.requestDate", { date: note.createdAt ? formatDate(note.createdAt, lang) : "—" })}
                      {note.uploadedByName ? ` · ${t("stageDocs.requestedBy", { name: note.uploadedByName })}` : ""}
                      {fulfilled && note.fulfilledAt
                        ? ` · ${t("stageDocs.fulfilledOn", { date: formatDate(note.fulfilledAt, lang) })}`
                        : ""}
                    </p>
                  )}
                  {!fulfilled && canUpload && (
                    <MissingDocumentUploadActions note={note} onUpload={onUpload} />
                  )}
                </div>
                {isAdmin && !note.isDerived && (
                  <div className="flex gap-0.5 shrink-0">
                    <Button
                      variant="ghost" size="icon" className="h-6 w-6"
                      title={fulfilled ? t("stageDocs.actionReopen") : t("stageDocs.actionMarkFulfilled")}
                      onClick={() => toggleFulfilled(note.id, !fulfilled)}
                    >
                      <Save className={`w-3 h-3 ${fulfilled ? "text-emerald-600" : ""}`} />
                    </Button>
                    <Button variant="ghost" size="icon" className="h-6 w-6" title={t("stageDocs.actionDelete")} onClick={() => removeNote(note.id)}>
                      <Trash2 className="w-3 h-3 text-destructive" />
                    </Button>
                  </div>
                )}
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function MissingDocumentUploadActions({
  note,
  onUpload,
}: {
  note: any;
  onUpload: (file: File, note: any) => Promise<void>;
}) {
  const { t } = useI18n();
  const { toast } = useToast();
  const inputRef = useRef<HTMLInputElement>(null);
  const [scannerOpen, setScannerOpen] = useState(false);
  const [uploading, setUploading] = useState(false);

  async function submit(file: File) {
    setUploading(true);
    try {
      await onUpload(file, note);
    } catch (err: any) {
      toast({
        title: t("stageDocs.toastUploadFailed"),
        description: err?.message || t("stageDocs.toastGenericError"),
        variant: "destructive",
      });
    } finally {
      setUploading(false);
      if (inputRef.current) inputRef.current.value = "";
    }
  }

  return (
    <div className="mt-2 flex items-center gap-1.5">
      <input
        ref={inputRef}
        type="file"
        className="hidden"
        accept={APPLICATION_DOCUMENT_ACCEPT_ATTRIBUTE}
        onChange={(event) => {
          const file = event.target.files?.[0];
          if (file) void submit(file);
        }}
      />
      <DocumentScanner
        open={scannerOpen}
        onClose={() => setScannerOpen(false)}
        baseName={String(note.fileName || "missing-document")}
        onCapture={submit}
      />
      <Button
        type="button"
        size="sm"
        variant="outline"
        className="h-7 gap-1 px-2 text-[10px]"
        disabled={uploading}
        onClick={() => inputRef.current?.click()}
      >
        <Upload className="h-3 w-3" />
        {uploading ? t("stageDocs.uploading") : t("stageDocs.uploadDocument")}
      </Button>
      <Button
        type="button"
        size="sm"
        variant="outline"
        className="h-7 gap-1 px-2 text-[10px]"
        disabled={uploading}
        onClick={() => setScannerOpen(true)}
      >
        <Camera className="h-3 w-3" />
        {t("scanner.scanWithCamera")}
      </Button>
    </div>
  );
}
