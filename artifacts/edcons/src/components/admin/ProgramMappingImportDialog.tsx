/**
 * ProgramMappingImportDialog.tsx
 *
 * Per-university bulk program-mapping import. Pairs with PortalProgramMappingTab.
 *   - "Şablon İndir": GET  /api/portal-automation/universities/:key/program-template.xlsx
 *   - "Excel Yükle":  POST /api/portal-automation/universities/:key/program-import
 *
 * The template ships one row per CRM program with an empty portal_value column.
 * Upload upserts non-empty rows into program_overrides (merge, never deletes);
 * invalid rows are reported, not written. Returns { applied, skipped, errors }.
 */

import { useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { customFetch } from "@workspace/api-client-react";
import { useToast } from "@/hooks/use-toast";
import { useI18n } from "@/hooks/use-i18n";
import { Upload, Loader2, FileSpreadsheet } from "lucide-react";

const MAX_IMPORT_BYTES = 2 * 1024 * 1024;
const XLSX_CONTENT_TYPE =
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

interface ImportResult {
  applied: number;
  skipped: number;
  errors: Array<{ row: number; reason: string }>;
}

function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

export interface ProgramMappingImportDialogProps {
  universityKey: string;
  /** Called after a successful import so the parent can reload overrides. */
  onImported?: () => void;
}

export function ProgramMappingImportDialog({
  universityKey,
  onImported,
}: ProgramMappingImportDialogProps) {
  const { t } = useI18n();
  const { toast } = useToast();
  const fileRef = useRef<HTMLInputElement>(null);

  const [open, setOpen] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const [fileBuffer, setFileBuffer] = useState<ArrayBuffer | null>(null);
  const [filename, setFilename] = useState<string>("");
  const [fileError, setFileError] = useState<string | null>(null);
  const [importing, setImporting] = useState(false);
  const [result, setResult] = useState<ImportResult | null>(null);

  function resetImport() {
    setFileBuffer(null);
    setFilename("");
    setFileError(null);
    setResult(null);
    if (fileRef.current) fileRef.current.value = "";
  }

  async function handleDownloadTemplate() {
    setDownloading(true);
    try {
      const blob = await customFetch<Blob>(
        `/api/portal-automation/universities/${universityKey}/program-template.xlsx`,
        { method: "GET", responseType: "blob" },
      );
      downloadBlob(blob, `${universityKey}-program-mapping-template.xlsx`);
      toast({ title: t("portalAutomation.mappingImport.templateReady") });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      toast({
        title: t("portalAutomation.mappingImport.templateFailed"),
        description: msg,
        variant: "destructive",
      });
    } finally {
      setDownloading(false);
    }
  }

  async function handleFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    setFileBuffer(null);
    setFilename("");
    setFileError(null);
    setResult(null);
    if (!file) return;
    if (file.size > MAX_IMPORT_BYTES) {
      setFileError(t("portalAutomation.mappingImport.errorTooLarge"));
      return;
    }
    if (!/\.xlsx$/i.test(file.name)) {
      setFileError(t("portalAutomation.mappingImport.errorNotXlsx"));
      return;
    }
    try {
      const ab = await file.arrayBuffer();
      setFileBuffer(ab);
      setFilename(file.name);
    } catch {
      setFileError(t("portalAutomation.mappingImport.errorReadFile"));
    }
  }

  async function handleImport() {
    if (!fileBuffer) return;
    setImporting(true);
    setResult(null);
    try {
      const res = await customFetch<ImportResult>(
        `/api/portal-automation/universities/${universityKey}/program-import`,
        {
          method: "POST",
          headers: { "Content-Type": XLSX_CONTENT_TYPE },
          body: fileBuffer,
        },
      );
      setResult(res);
      onImported?.();
      toast({
        title: t("portalAutomation.mappingImport.toast.imported", {
          applied: String(res.applied),
          skipped: String(res.skipped),
          errors: String(res.errors.length),
        }),
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      toast({
        title: t("portalAutomation.mappingImport.importFailed"),
        description: msg,
        variant: "destructive",
      });
    } finally {
      setImporting(false);
    }
  }

  return (
    <div className="flex gap-2 flex-wrap">
      <Button
        variant="outline"
        size="sm"
        onClick={handleDownloadTemplate}
        disabled={downloading}
        className="gap-1.5"
        data-testid="button-mapping-template"
      >
        {downloading ? (
          <Loader2 className="w-3.5 h-3.5 animate-spin" />
        ) : (
          <FileSpreadsheet className="w-3.5 h-3.5" />
        )}
        {t("portalAutomation.mappingImport.downloadTemplate")}
      </Button>

      <Dialog
        open={open}
        onOpenChange={(o) => {
          setOpen(o);
          if (!o) resetImport();
        }}
      >
        <DialogTrigger asChild>
          <Button
            variant="outline"
            size="sm"
            className="gap-1.5"
            data-testid="button-mapping-import"
          >
            <Upload className="w-3.5 h-3.5" />
            {t("portalAutomation.mappingImport.uploadExcel")}
          </Button>
        </DialogTrigger>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>{t("portalAutomation.mappingImport.uploadExcel")}</DialogTitle>
          </DialogHeader>

          <div className="space-y-4">
            <p className="text-xs text-muted-foreground">
              {t("portalAutomation.mappingImport.dropFile")}
            </p>

            <div>
              <Label className="text-xs">
                {t("portalAutomation.mappingImport.selectFile")}
              </Label>
              <input
                ref={fileRef}
                type="file"
                accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
                onChange={handleFile}
                className="block w-full mt-1 text-sm file:mr-3 file:py-1.5 file:px-3 file:rounded-md file:border-0 file:bg-muted file:text-sm file:cursor-pointer"
                data-testid="input-mapping-file"
              />
            </div>

            {fileError && (
              <div className="rounded-md border border-destructive/40 bg-destructive/10 p-3 text-xs text-destructive">
                {fileError}
              </div>
            )}

            {fileBuffer && !fileError && (
              <div className="rounded-md border bg-muted/40 p-3 text-xs">
                <strong>{filename}</strong> — {(fileBuffer.byteLength / 1024).toFixed(1)} KB
              </div>
            )}

            {result && (
              <div
                className="rounded-md border bg-muted/40 p-3 text-xs space-y-1"
                data-testid="mapping-import-result"
              >
                <div className="font-semibold">
                  {t("portalAutomation.mappingImport.result.title")}
                </div>
                <div>
                  {t("portalAutomation.mappingImport.result.applied", {
                    n: String(result.applied),
                  })}
                </div>
                <div>
                  {t("portalAutomation.mappingImport.result.skipped", {
                    n: String(result.skipped),
                  })}
                </div>
                <div>
                  {t("portalAutomation.mappingImport.result.errors", {
                    n: String(result.errors.length),
                  })}
                </div>
                {result.errors.length > 0 && (
                  <ul className="mt-2 list-disc list-inside text-destructive max-h-32 overflow-y-auto">
                    {result.errors.map((er) => (
                      <li key={er.row}>
                        {t("portalAutomation.mappingImport.result.rowError", {
                          row: String(er.row),
                          reason: t(
                            `portalAutomation.mappingImport.reason.${er.reason}`,
                          ),
                        })}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )}
          </div>

          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => {
                setOpen(false);
                resetImport();
              }}
            >
              {t("portalAutomation.mappingImport.close")}
            </Button>
            <Button
              onClick={handleImport}
              disabled={!fileBuffer || !!fileError || importing}
              data-testid="button-mapping-import-confirm"
            >
              {importing ? (
                <Loader2 className="w-4 h-4 mr-2 animate-spin" />
              ) : (
                <Upload className="w-4 h-4 mr-2" />
              )}
              {t("portalAutomation.mappingImport.runImport")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
