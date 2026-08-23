import { useState, useRef } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Upload, FileCheck, Loader2, AlertTriangle, X, Camera } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { useI18n } from "@/hooks/use-i18n";
import { usePipelineStages } from "@/hooks/use-pipeline-stages";
import { DocumentScanner } from "@/components/DocumentScanner";

const BASE_URL = import.meta.env.BASE_URL?.replace(/\/$/, "") || "";

// Safely render a translation template that may contain `<strong>...</strong>`
// markup. Splits the string into React nodes so interpolated values are never
// injected as raw HTML (no XSS surface).
function renderTemplate(template: string): React.ReactNode[] {
  const parts: React.ReactNode[] = [];
  const re = /<strong>([\s\S]*?)<\/strong>/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  let key = 0;
  while ((match = re.exec(template)) !== null) {
    if (match.index > lastIndex) {
      parts.push(template.slice(lastIndex, match.index));
    }
    parts.push(<strong key={`s${key++}`}>{match[1]}</strong>);
    lastIndex = re.lastIndex;
  }
  if (lastIndex < template.length) {
    parts.push(template.slice(lastIndex));
  }
  return parts;
}

function getCsrfToken(): string {
  const m = document.cookie.match(/(?:^|;\s*)csrf_token=([^;]*)/);
  return m ? decodeURIComponent(m[1]) : "";
}

interface StageDocUploadDialogProps {
  open: boolean;
  onClose: () => void;
  applicationId: number;
  targetStage: string;
  targetStageLabel: string;
  onUploaded: () => void;
  uploadStage?: string;
  documentNameOverride?: string | null;
  moveAfterUpload?: boolean;
  quickMode?: boolean;
}

export function StageDocUploadDialog({ open, onClose, applicationId, targetStage, targetStageLabel, onUploaded, uploadStage, documentNameOverride, moveAfterUpload = true, quickMode = false }: StageDocUploadDialogProps) {
  const { t } = useI18n();
  const docStage = uploadStage || targetStage;
  const [files, setFiles] = useState<File[]>([]);
  const [uploading, setUploading] = useState(false);
  const [validUntil, setValidUntil] = useState("");
  const [scannerOpen, setScannerOpen] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const { toast } = useToast();
  const { stages: pipelineStages } = usePipelineStages("application");
  const targetStageMeta = pipelineStages.find(s => s.key === docStage);
  const requiresValidUntil = !quickMode && targetStageMeta?.requiresValidUntil === true;
  const supportsValidUntil = !quickMode && (targetStageMeta?.tracksOfferExpiry === true || requiresValidUntil);

  function handleFileSelect(e: React.ChangeEvent<HTMLInputElement>) {
    if (e.target.files) {
      setFiles(prev => [...prev, ...Array.from(e.target.files!)]);
    }
    if (fileInputRef.current) fileInputRef.current.value = "";
  }

  function removeFile(idx: number) {
    setFiles(prev => prev.filter((_, i) => i !== idx));
  }

  async function handleUploadAndMove() {
    if (files.length === 0) {
      toast({ title: t("stageDocUpload.toastSelectAtLeastOne"), variant: "destructive" });
      return;
    }
    if (requiresValidUntil && !validUntil) {
      toast({ title: t("stageDocUpload.toastValidUntilRequired"), description: t("stageDocUpload.toastValidUntilRequiredDesc"), variant: "destructive" });
      return;
    }
    setUploading(true);
    try {
      for (let idx = 0; idx < files.length; idx++) {
        const file = files[idx];
        const reader = new FileReader();
        const base64 = await new Promise<string>((resolve, reject) => {
          reader.onload = () => {
            const result = reader.result as string;
            resolve(result.split(",")[1]);
          };
          reader.onerror = reject;
          reader.readAsDataURL(file);
        });

        const suffix = documentNameOverride && files.length > 1 ? ` (${idx + 1})` : "";
        const overrideForRequest = documentNameOverride
          ? `${documentNameOverride}${suffix}`
          : undefined;

        const res = await fetch(`${BASE_URL}/api/applications/${applicationId}/stage-documents`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-csrf-token": getCsrfToken(),
          },
          credentials: "include",
          body: JSON.stringify({
            stage: docStage,
            fileName: file.name,
            fileData: base64,
            mimeType: file.type,
            sizeBytes: file.size,
            ...(overrideForRequest ? { documentNameOverride: overrideForRequest } : {}),
            ...(supportsValidUntil && validUntil ? { validUntil } : {}),
          }),
        });
        if (!res.ok) {
          const err = await res.json().catch(() => ({ error: t("stageDocUpload.errUploadFailed") }));
          throw new Error(err.error || t("stageDocUpload.errUploadFailed"));
        }
      }

      if (moveAfterUpload) {
        const stageRes = await fetch(`${BASE_URL}/api/applications/${applicationId}`, {
          method: "PATCH",
          headers: {
            "Content-Type": "application/json",
            "x-csrf-token": getCsrfToken(),
          },
          credentials: "include",
          body: JSON.stringify({ stage: targetStage }),
        });

        if (!stageRes.ok) {
          const err = await stageRes.json().catch(() => ({ error: t("stageDocUpload.errStageUpdateFailed") }));
          throw new Error(err.error || t("stageDocUpload.errStageUpdateFailed"));
        }
        toast({ title: t("stageDocUpload.toastUploadedAndMoved", { stage: targetStageLabel }) });
      } else {
        toast({ title: t("stageDocUpload.toastUploaded") });
      }
      setFiles([]);
      setValidUntil("");
      onUploaded();
      onClose();
    } catch (err: any) {
      toast({ title: t("stageDocUpload.toastError"), description: err.message, variant: "destructive" });
    } finally {
      setUploading(false);
    }
  }

  function handleClose() {
    if (!uploading) {
      setFiles([]);
      setValidUntil("");
      onClose();
    }
  }

  return (
    <Dialog open={open} onOpenChange={v => { if (!v) handleClose(); }}>
      <DialogContent className="sm:max-w-md overflow-x-hidden">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            {quickMode ? (
              <Upload className="w-5 h-5 text-primary" />
            ) : (
              <AlertTriangle className="w-5 h-5 text-amber-500" />
            )}
            {quickMode
              ? (documentNameOverride ? t("stageDocUpload.quickTitleNamed", { name: documentNameOverride }) : t("stageDocUpload.quickTitle"))
              : t("stageDocUpload.requiredTitle")}
          </DialogTitle>
        </DialogHeader>
        <div className="space-y-4 py-2 min-w-0 w-full">
          {quickMode ? (
            <p className="text-sm text-muted-foreground">
              {renderTemplate(
                documentNameOverride
                  ? t("stageDocUpload.quickDescNamed", { name: documentNameOverride })
                  : t("stageDocUpload.quickDesc")
              )}
              {moveAfterUpload && (
                <> {renderTemplate(t("stageDocUpload.quickDescMove", { stage: targetStageLabel }))}</>
              )}
            </p>
          ) : (
            <p className="text-sm text-muted-foreground">
              {renderTemplate(t("stageDocUpload.requiredDesc", { stage: targetStageLabel }))}
            </p>
          )}

          <div className="space-y-2">
            <Label className="text-xs font-semibold">{t("stageDocUpload.uploadDocuments")}</Label>
            <div
              onClick={() => fileInputRef.current?.click()}
              className="border-2 border-dashed rounded-xl p-6 text-center cursor-pointer hover:border-primary/50 hover:bg-primary/5 transition-colors"
            >
              <Upload className="w-8 h-8 mx-auto text-muted-foreground mb-2" />
              <p className="text-sm text-muted-foreground">{t("stageDocUpload.clickToSelect")}</p>
              <p className="text-xs text-muted-foreground mt-1">{t("stageDocUpload.fileTypes")}</p>
            </div>
            <input
              ref={fileInputRef}
              type="file"
              multiple
              accept=".pdf,.doc,.docx,.jpg,.jpeg,.png,.webp"
              onChange={handleFileSelect}
              className="hidden"
            />
            <button
              type="button"
              onClick={() => setScannerOpen(true)}
              className="w-full inline-flex items-center justify-center gap-1.5 text-xs font-medium text-primary hover:text-primary/80 px-2.5 py-1.5 rounded-md hover:bg-primary/5 transition-colors border border-primary/20"
            >
              <Camera className="w-3.5 h-3.5" />
              {t("scanner.scanWithCamera")}
            </button>
            <DocumentScanner
              open={scannerOpen}
              onClose={() => setScannerOpen(false)}
              baseName={documentNameOverride || docStage || "scan"}
              onCapture={(f) => setFiles(prev => [...prev, f])}
            />
          </div>

          {supportsValidUntil && (
            <div className="space-y-1.5">
              <Label className="text-xs font-semibold">
                {t("stageDocUpload.validUntilLabel")} {requiresValidUntil && <span className="text-destructive">*</span>}
              </Label>
              <Input
                type="date"
                value={validUntil}
                onChange={e => setValidUntil(e.target.value)}
                disabled={uploading}
              />
              <p className="text-xs text-muted-foreground">
                {t("stageDocUpload.validUntilHint")}
              </p>
            </div>
          )}

          {files.length > 0 && (
            <div className="space-y-2">
              <Label className="text-xs font-semibold">{t("stageDocUpload.selectedFiles", { count: files.length })}</Label>
              <div className="space-y-1.5 max-h-40 overflow-y-auto">
                {files.map((f, i) => (
                  <div key={i} className="flex items-center gap-2 p-2 bg-secondary/50 rounded-lg text-xs">
                    <FileCheck className="w-4 h-4 text-emerald-500 shrink-0" />
                    <span className="truncate flex-1">{f.name}</span>
                    <span className="text-muted-foreground shrink-0">{(f.size / 1024).toFixed(0)} KB</span>
                    <button onClick={() => removeFile(i)} className="p-0.5 hover:bg-destructive/10 rounded" disabled={uploading}>
                      <X className="w-3 h-3 text-destructive" />
                    </button>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={handleClose} disabled={uploading}>{t("stageDocUpload.cancel")}</Button>
          <Button onClick={handleUploadAndMove} disabled={uploading || files.length === 0}>
            {uploading ? <><Loader2 className="w-4 h-4 mr-2 animate-spin" /> {t("stageDocUpload.uploadingBtn")}</> : t("stageDocUpload.uploadAndMove", { stage: targetStageLabel })}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
