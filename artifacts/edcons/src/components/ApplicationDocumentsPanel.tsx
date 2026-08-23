import { useState, useRef } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { customFetch } from "@workspace/api-client-react";
import { usePipelineStages } from "@/hooks/use-pipeline-stages";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import {
  Upload, FileText, Trash2, Download,
  ChevronDown, ChevronRight, Calendar,
} from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { useI18n } from "@/hooks/use-i18n";
import { validateApplicationDocumentFileObj as validateFile, sanitizeFileName, APPLICATION_DOCUMENT_ACCEPT_ATTRIBUTE, APPLICATION_DOCUMENT_HELP_TEXT } from "@/lib/fileUploadValidation";

const BASE_URL = import.meta.env.BASE_URL?.replace(/\/$/, "") || "";

// Backwards-compatible export consumed by student/Applications.tsx.
// The set of doc-bearing stages is now driven entirely by pipeline_stages
// (uploadPermissionLevel != 'none'); this constant remains as a safe fallback
// for legacy default installations. The student page also derives the
// runtime exclude list dynamically from the pipeline (any stage with an
// upload permission level other than 'none') so custom doc-enabled
// stages don't render in BOTH panels.
export const APPLICATION_DOC_STAGES = [
  "app_fee_paid", "deposit_paid", "upload_payment",
  "offer_received", "acceptance_letter", "final_acceptance",
  "student_card", "visa_approved", "visa_reject",
];

const FALLBACK_LABELS: Record<string, string> = {
  app_fee_paid: "Application Fee Receipt",
  deposit_paid: "Deposit Paid Receipt",
  offer_received: "Offer Letter",
  acceptance_letter: "Acceptance Letter",
  final_acceptance: "Final Acceptance Letter",
  student_card: "Student Card Upload",
  visa_approved: "Visa OK",
  visa_reject: "Visa Reject",
};

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

interface ApplicationDocumentsPanelProps {
  applicationId: number;
  userRole: string;
  userId?: number;
  /** Current pipeline stage key for this application — used to hide
   *  future-stage upload zones from students/agents. */
  currentStage?: string;
}

export function ApplicationDocumentsPanel({ applicationId, userRole, userId, currentStage }: ApplicationDocumentsPanelProps) {
  const { t } = useI18n();

  const { data: allDocs = [] } = useQuery({
    queryKey: [`app-stage-docs-${applicationId}`],
    queryFn: () => customFetch(`${BASE_URL}/api/applications/${applicationId}/stage-documents`),
    staleTime: 15_000,
  });

  const isAdmin = ADMIN_ROLES.includes(userRole);
  const isStaff = STAFF_ROLES.includes(userRole);
  const isAgent = AGENT_ROLES.includes(userRole);
  const restrictFuture = !isStaff;

  // Determine future-stage gating using pipeline ordering.
  const { stages: pipelineStages } = usePipelineStages("application");
  const stageOrder = new Map<string, number>();
  pipelineStages.forEach((s, i) => stageOrder.set(s.key, s.sortOrder ?? i));
  const stageByKey = new Map(pipelineStages.map(s => [s.key, s]));
  const currentOrder = currentStage && stageOrder.has(currentStage)
    ? (stageOrder.get(currentStage) as number)
    : Number.POSITIVE_INFINITY;
  function isFutureCategory(category: string): boolean {
    if (!stageOrder.has(category)) return false;
    return (stageOrder.get(category) as number) > currentOrder;
  }

  // Categories shown are pipeline stages where uploadPermissionLevel != 'none'
  // (excluding the missing_docs note-only stage), preserving pipeline order.
  const docCategories = pipelineStages
    .filter(s => (s.uploadPermissionLevel ?? "none") !== "none" && s.key !== "missing_docs" && s.key !== "upload_payment")
    .map(s => s.key);

  function getCategoryLabel(category: string): string {
    const translated = t(`apply.appDocLabel_${category}`);
    if (translated !== `apply.appDocLabel_${category}`) return translated;
    return FALLBACK_LABELS[category] || category;
  }

  return (
    <div className="bg-card rounded-2xl border shadow-sm p-6 space-y-4">
      <h2 className="font-semibold text-foreground flex items-center gap-2">
        <FileText className="w-4 h-4 text-muted-foreground" />
        {t("apply.applicationDocuments")}
      </h2>

      <div className="space-y-3">
        {docCategories.map(category => {
          const docs = (allDocs as any[]).filter(
            (d: any) => (d.stage === category || (category === "deposit_paid" && d.stage === "upload_payment")) && !d.isMissingDocNote
          );
          // Students/agents must not see future-stage upload zones.
          // Existing uploads stay visible at any stage.
          const isFuture = restrictFuture && isFutureCategory(category);
          if (isFuture && docs.length === 0) return null;
          const stageMeta = stageByKey.get(category);
          const uploadLevel = (stageMeta?.uploadPermissionLevel ?? "everyone") as string;
          return (
            <CategorySection
              isAgent={isAgent}
              key={category}
              applicationId={applicationId}
              category={category}
              label={getCategoryLabel(category)}
              uploadPermissionLevel={uploadLevel}
              tracksOfferExpiry={stageMeta?.tracksOfferExpiry === true}
              requiresValidUntilFlag={stageMeta?.requiresValidUntil === true}
              advanceOnUpload={isFutureCategory(category)}
              docs={docs}
              userId={userId}
              isAdmin={isAdmin}
              isStaff={isStaff}
              hideUpload={isFuture}
            />
          );
        })}
      </div>
    </div>
  );
}

function CategorySection({
  applicationId, category, label, uploadPermissionLevel, tracksOfferExpiry, requiresValidUntilFlag, advanceOnUpload, docs, userId, isAdmin, isStaff, isAgent, hideUpload,
}: {
  applicationId: number;
  category: string;
  label: string;
  uploadPermissionLevel: string;
  tracksOfferExpiry: boolean;
  requiresValidUntilFlag: boolean;
  advanceOnUpload: boolean;
  docs: any[];
  userId?: number;
  isAdmin: boolean;
  isStaff: boolean;
  isAgent: boolean;
  hideUpload?: boolean;
}) {
  const { t } = useI18n();
  const [expanded, setExpanded] = useState(docs.length > 0);
  const { toast } = useToast();
  const qc = useQueryClient();
  const fileRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  const [pendingValidUntil, setPendingValidUntil] = useState<string>("");

  const requiresValidUntil = requiresValidUntilFlag;
  const supportsValidUntil = tracksOfferExpiry || requiresValidUntilFlag;

  // Permission matrix (Task #134):
  //   admin_only         → admin / manager only (legacy default for offer stages)
  //   staff_only         → all staff (admin + staff/consultant/editor/...)
  //   staff_and_agent    → staff + agents (no students)
  //   everyone           → staff + agents + students
  const isAdminOnly = uploadPermissionLevel === "admin_only";
  const isStaffOnly = uploadPermissionLevel === "staff_only";
  const canUpload = (() => {
    if (hideUpload) return false;
    if (uploadPermissionLevel === "none") return false;
    if (isAdminOnly) return isAdmin;
    if (isStaffOnly) return isStaff;
    if (uploadPermissionLevel === "staff_and_agent") return isStaff || isAgent;
    if (uploadPermissionLevel === "everyone") return true;
    return false;
  })();

  const uploadMutation = useMutation({
    mutationFn: async (file: File) => {
      const base64 = await fileToBase64(file);
      const body: any = {
        stage: category,
        fileName: file.name,
        fileData: base64,
        mimeType: file.type,
        sizeBytes: file.size,
      };
      if (supportsValidUntil && pendingValidUntil) body.validUntil = pendingValidUntil;
      return customFetch(`${BASE_URL}/api/applications/${applicationId}/stage-documents`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
    },
    onSuccess: async () => {
      qc.invalidateQueries({ queryKey: [`app-stage-docs-${applicationId}`] });
      setPendingValidUntil("");
      // Mirror the kanban "Document Required" flow: uploading a document for a
      // stage that is ahead of the application's current stage auto-advances
      // the application to that stage. Forward-only (advanceOnUpload is only
      // true for future categories, which only staff can upload into).
      if (advanceOnUpload) {
        try {
          await customFetch(`${BASE_URL}/api/applications/${applicationId}`, {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ stage: category }),
          });
          qc.invalidateQueries({
            predicate: (q) => typeof q.queryKey[0] === "string" && (q.queryKey[0] as string).startsWith("/api/applications"),
          });
          toast({ title: t("stageDocUpload.toastUploadedAndMoved", { stage: label }) });
          return;
        } catch {
          // Upload saved but the stage move failed (e.g. permission) — fall
          // through to the plain upload-success toast.
        }
      }
      toast({ title: t("appDocsPanel.documentUploaded") });
    },
    onError: (err: any) => {
      toast({ title: t("appDocsPanel.uploadFailed"), description: err?.message || t("appDocsPanel.errorOccurred"), variant: "destructive" });
    },
  });

  const deleteMutation = useMutation({
    mutationFn: (docId: number) =>
      customFetch(`${BASE_URL}/api/applications/${applicationId}/stage-documents/${docId}`, { method: "DELETE" }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: [`app-stage-docs-${applicationId}`] });
      toast({ title: t("appDocsPanel.documentDeleted") });
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
      toast({ title: t("appDocsPanel.fileError"), description: validation.message, variant: "destructive" });
      return;
    }
    setUploading(true);
    const safeFile = new File([file], sanitizeFileName(file.name), { type: file.type });
    await uploadMutation.mutateAsync(safeFile);
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

  return (
    <div className="border rounded-xl overflow-hidden">
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-center justify-between p-3 hover:bg-secondary/50 transition-colors text-left"
      >
        <div className="flex items-center gap-2">
          {expanded ? <ChevronDown className="w-4 h-4 text-muted-foreground" /> : <ChevronRight className="w-4 h-4 text-muted-foreground" />}
          <span className="text-sm font-medium">{label}</span>
          {docs.length > 0 && (
            <Badge variant="secondary" className="text-xs px-1.5 py-0">{docs.length}</Badge>
          )}
          {isAdminOnly && (
            <Badge variant="outline" className="text-xs px-1.5 py-0 text-rose-600 border-rose-300">{t("stageDocs.adminUpload")}</Badge>
          )}
          {isStaffOnly && (
            <Badge variant="outline" className="text-xs px-1.5 py-0 text-amber-600 border-amber-300">{t("stageDocs.staffUpload")}</Badge>
          )}
        </div>
      </button>

      {expanded && (
        <div className="px-3 pb-3 space-y-2">
          {docs.length > 0 ? (
            <div className="space-y-1.5">
              {docs.map((doc: any) => (
                <div key={doc.id} className="flex items-center gap-2 p-2 rounded-lg bg-secondary/30 text-sm group">
                  <FileText className="w-4 h-4 text-muted-foreground shrink-0" />
                  <div className="flex-1 min-w-0">
                    <p className="truncate font-medium text-foreground">{doc.fileName}</p>
                    <p className="text-xs text-muted-foreground">
                      {doc.uploadedByName || t("appDocsPanel.unknown")} · {(() => { const d = new Date(doc.createdAt); return isNaN(d.getTime()) ? "—" : `${String(d.getDate()).padStart(2,"0")}.${String(d.getMonth()+1).padStart(2,"0")}.${d.getFullYear()}`; })()}
                      {doc.sizeBytes && ` · ${(doc.sizeBytes / 1024).toFixed(0)}KB`}
                    </p>
                  </div>
                  <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-7 w-7"
                      onClick={() => handleDownload(doc)}
                      title={t("appDocsPanel.download")}
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
                        title={t("common.delete")}
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </Button>
                    )}
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <p className="text-xs text-muted-foreground py-1">{t("appDocsPanel.noDocuments")}</p>
          )}

          {canUpload && (
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
              <Button
                variant="outline"
                size="sm"
                className="gap-1.5 text-xs w-full"
                onClick={() => fileRef.current?.click()}
                disabled={uploading}
              >
                <Upload className="w-3.5 h-3.5" />
                {uploading ? t("appDocsPanel.uploading") : t("appDocsPanel.uploadDocument")}
              </Button>
              <p className="text-[10px] text-muted-foreground text-center">{APPLICATION_DOCUMENT_HELP_TEXT}</p>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
