import { useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { customFetch } from "@workspace/api-client-react";
import { useToast } from "@/hooks/use-toast";
import { useI18n } from "@/hooks/use-i18n";
import { Download, Upload, Loader2, FileSpreadsheet } from "lucide-react";

type ImportItemResult = {
  index: number;
  slug: string | null;
  status: "created" | "updated" | "renamed" | "skipped" | "error";
  finalSlug?: string;
  error?: string;
};

type ImportSummary = {
  total: number;
  created: number;
  updated: number;
  renamed: number;
  skipped: number;
  errors: number;
  results: ImportItemResult[];
};

export interface ExportImportToolbarProps {
  exportPath: string;     // POST endpoint, e.g. "/api/embed/widgets/export"
  importPath: string;     // POST endpoint, accepts raw .xlsx body
  templatePath: string;   // GET endpoint, returns a pre-filled .xlsx template
  downloadName: string;   // base filename, ".xlsx" appended
  selectedIds?: number[];
  onImported?: () => void;
}

const MAX_IMPORT_BYTES = 2 * 1024 * 1024;
const XLSX_CONTENT_TYPE =
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

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

export function ExportImportToolbar({
  exportPath,
  importPath,
  templatePath,
  downloadName,
  selectedIds = [],
  onImported,
}: ExportImportToolbarProps) {
  const { t } = useI18n();
  const { toast } = useToast();
  const fileRef = useRef<HTMLInputElement>(null);
  const [exporting, setExporting] = useState(false);
  const [downloadingTemplate, setDownloadingTemplate] = useState(false);
  const [importDialog, setImportDialog] = useState(false);
  const [conflict, setConflict] = useState<"skip" | "overwrite" | "rename">("skip");
  const [fileBuffer, setFileBuffer] = useState<ArrayBuffer | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);
  const [filename, setFilename] = useState<string>("");
  const [importing, setImporting] = useState(false);
  const [summary, setSummary] = useState<ImportSummary | null>(null);

  async function handleExport() {
    setExporting(true);
    try {
      const blob = await customFetch<Blob>(exportPath, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ids: selectedIds.length > 0 ? selectedIds : undefined }),
        responseType: "blob",
      });
      downloadBlob(blob, `${downloadName}-${new Date().toISOString().slice(0, 10)}.xlsx`);
      toast({ title: t("exportImport.exportSuccess") });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      toast({ title: t("exportImport.exportFailed"), description: msg, variant: "destructive" });
    } finally {
      setExporting(false);
    }
  }

  async function handleDownloadTemplate() {
    setDownloadingTemplate(true);
    try {
      const blob = await customFetch<Blob>(templatePath, {
        method: "GET",
        responseType: "blob",
      });
      downloadBlob(blob, `${downloadName}-template.xlsx`);
      toast({ title: t("exportImport.templateReady") });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      toast({ title: t("exportImport.templateFailed"), description: msg, variant: "destructive" });
    } finally {
      setDownloadingTemplate(false);
    }
  }

  function resetImport() {
    setFileBuffer(null);
    setFileError(null);
    setFilename("");
    setSummary(null);
    if (fileRef.current) fileRef.current.value = "";
  }

  async function handleFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    setFileBuffer(null);
    setFileError(null);
    setFilename("");
    setSummary(null);
    if (!file) return;
    if (file.size > MAX_IMPORT_BYTES) {
      setFileError(t("exportImport.errorTooLarge"));
      return;
    }
    if (!/\.xlsx$/i.test(file.name)) {
      setFileError(t("exportImport.errorNotXlsx"));
      return;
    }
    try {
      const ab = await file.arrayBuffer();
      setFileBuffer(ab);
      setFilename(file.name);
    } catch {
      setFileError(t("exportImport.errorReadFile"));
    }
  }

  async function handleImport() {
    if (!fileBuffer) return;
    setImporting(true);
    setSummary(null);
    try {
      const result = await customFetch<ImportSummary>(`${importPath}?conflict=${conflict}`, {
        method: "POST",
        headers: { "Content-Type": XLSX_CONTENT_TYPE },
        body: fileBuffer,
      });
      setSummary(result);
      onImported?.();
      toast({
        title: t("exportImport.importSuccess"),
        description: t("exportImport.importSummary", {
          created: String(result.created),
          updated: String(result.updated),
          renamed: String(result.renamed),
          skipped: String(result.skipped),
          errors: String(result.errors),
        }),
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      toast({ title: t("exportImport.importFailed"), description: msg, variant: "destructive" });
    } finally {
      setImporting(false);
    }
  }

  return (
    <>
      <div className="flex gap-2 flex-wrap">
        <Button
          variant="outline"
          size="sm"
          onClick={handleDownloadTemplate}
          disabled={downloadingTemplate}
          data-testid="button-download-template"
        >
          {downloadingTemplate ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <FileSpreadsheet className="w-4 h-4 mr-2" />}
          {t("exportImport.downloadTemplate")}
        </Button>
        <Button variant="outline" size="sm" onClick={handleExport} disabled={exporting} data-testid="button-export">
          {exporting ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <Download className="w-4 h-4 mr-2" />}
          {selectedIds.length > 0
            ? t("exportImport.exportSelected", { count: String(selectedIds.length) })
            : t("exportImport.exportAll")}
        </Button>
        <Button variant="outline" size="sm" onClick={() => { resetImport(); setImportDialog(true); }} data-testid="button-import">
          <Upload className="w-4 h-4 mr-2" />
          {t("exportImport.import")}
        </Button>
      </div>

      <Dialog open={importDialog} onOpenChange={(o) => { setImportDialog(o); if (!o) resetImport(); }}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>{t("exportImport.importTitle")}</DialogTitle>
          </DialogHeader>

          <div className="space-y-4">
            <div>
              <Label className="text-xs">{t("exportImport.selectFile")}</Label>
              <input
                ref={fileRef}
                type="file"
                accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
                onChange={handleFile}
                className="block w-full mt-1 text-sm file:mr-3 file:py-1.5 file:px-3 file:rounded-md file:border-0 file:bg-muted file:text-sm file:cursor-pointer"
                data-testid="input-import-file"
              />
              <p className="text-[10px] text-muted-foreground mt-1">{t("exportImport.fileHint")}</p>
            </div>

            {fileError && (
              <div className="rounded-md border border-destructive/40 bg-destructive/10 p-3 text-xs text-destructive">
                {fileError}
              </div>
            )}

            {fileBuffer && !fileError && (
              <div className="rounded-md border bg-muted/40 p-3 text-xs space-y-1">
                <div><strong>{filename}</strong> — {(fileBuffer.byteLength / 1024).toFixed(1)} KB</div>
              </div>
            )}

            <div>
              <Label className="text-xs">{t("exportImport.conflictStrategy")}</Label>
              <div className="mt-2 space-y-1.5">
                {(["skip", "overwrite", "rename"] as const).map((v) => (
                  <label key={v} className="flex items-start gap-2 text-xs cursor-pointer">
                    <input
                      type="radio"
                      name="conflict"
                      value={v}
                      checked={conflict === v}
                      onChange={() => setConflict(v)}
                      className="mt-0.5"
                      data-testid={`radio-conflict-${v}`}
                    />
                    <span>
                      <strong>{t(`exportImport.conflict_${v}`)}</strong>
                      <span className="text-muted-foreground"> — {t(`exportImport.conflict_${v}_desc`)}</span>
                    </span>
                  </label>
                ))}
              </div>
            </div>

            {summary && (
              <div className="rounded-md border bg-muted/40 p-3 text-xs space-y-1" data-testid="import-summary">
                <div className="font-semibold">{t("exportImport.resultsTitle")}</div>
                <div>{t("exportImport.summaryCreated", { n: String(summary.created) })}</div>
                <div>{t("exportImport.summaryUpdated", { n: String(summary.updated) })}</div>
                <div>{t("exportImport.summaryRenamed", { n: String(summary.renamed) })}</div>
                <div>{t("exportImport.summarySkipped", { n: String(summary.skipped) })}</div>
                <div>{t("exportImport.summaryErrors", { n: String(summary.errors) })}</div>
                {summary.results.some((r) => r.status === "error") && (
                  <ul className="mt-2 list-disc list-inside text-destructive max-h-32 overflow-y-auto">
                    {summary.results.filter((r) => r.status === "error").map((r) => (
                      <li key={r.index}>{r.slug || `#${r.index}`}: {r.error}</li>
                    ))}
                  </ul>
                )}
              </div>
            )}
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => { setImportDialog(false); resetImport(); }}>
              {t("exportImport.close")}
            </Button>
            <Button onClick={handleImport} disabled={!fileBuffer || !!fileError || importing} data-testid="button-import-confirm">
              {importing ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <Upload className="w-4 h-4 mr-2" />}
              {t("exportImport.runImport")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
