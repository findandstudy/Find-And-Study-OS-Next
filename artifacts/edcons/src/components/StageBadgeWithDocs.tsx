import { useState } from "react";
import { Paperclip, Download, Loader2, AlertTriangle } from "lucide-react";
import { Popover, PopoverAnchor, PopoverContent } from "@/components/ui/popover";
import { HoverCard, HoverCardContent, HoverCardTrigger } from "@/components/ui/hover-card";
import { useI18n } from "@/hooks/use-i18n";

interface StageDoc {
  id: number;
  fileName: string;
  isMissingDocNote: boolean;
}

interface MissingDocRequest {
  id: number;
  fileName: string;
  isCustom?: boolean;
  fulfilledAt?: string | null;
}

interface StageBadgeWithDocsProps {
  app: { id: number; stage: string; currentStageDocCount?: number | null };
  stageLabel: string;
  stageColor: string;
  baseUrl: string;
}

function triggerDownload(url: string) {
  const a = document.createElement("a");
  a.href = url;
  a.target = "_blank";
  a.rel = "noopener noreferrer";
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
}

export function StageBadgeWithDocs({
  app,
  stageLabel,
  stageColor,
  baseUrl,
}: StageBadgeWithDocsProps) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const [docs, setDocs] = useState<StageDoc[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [missingRequests, setMissingRequests] = useState<MissingDocRequest[] | null>(null);
  const [missingLoading, setMissingLoading] = useState(false);

  const hasDocIndicator = (app.currentStageDocCount ?? 0) > 0;
  const isMissingStage = app.stage === "missing_docs";

  const downloadUrl = (docId: number) =>
    `${baseUrl}/api/applications/${app.id}/stage-documents/${docId}/download`;

  async function handleClick(e: React.MouseEvent) {
    e.stopPropagation();
    if (!hasDocIndicator) return;

    if (open) {
      setOpen(false);
      return;
    }

    let realDocs = docs;
    if (realDocs === null) {
      setLoading(true);
      try {
        const r = await fetch(
          `${baseUrl}/api/applications/${app.id}/stage-documents?stage=${encodeURIComponent(app.stage)}`,
          { credentials: "include" },
        );
        const result = r.ok ? await r.json() : [];
        realDocs = (Array.isArray(result) ? result : []).filter(
          (d: any) => !d.isMissingDocNote,
        );
        setDocs(realDocs);
      } catch {
        realDocs = [];
        setDocs([]);
      } finally {
        setLoading(false);
      }
    }

    if (!realDocs || realDocs.length === 0) return;
    if (realDocs.length === 1) {
      triggerDownload(downloadUrl(realDocs[0].id));
    } else {
      setOpen(true);
    }
  }

  function localizeDocType(key: string) {
    const localized = t(`docTypes.${key}`);
    if (localized && localized !== `docTypes.${key}`) return localized;
    return key.replace(/_/g, " ").replace(/\b\w/g, (char) => char.toUpperCase());
  }

  async function loadMissingRequests() {
    if (!isMissingStage || missingRequests !== null || missingLoading) return;
    setMissingLoading(true);
    try {
      const response = await fetch(
        `${baseUrl}/api/applications/${app.id}/missing-doc-notes?stage=missing_docs`,
        { credentials: "include" },
      );
      const result = response.ok ? await response.json() : [];
      setMissingRequests(
        (Array.isArray(result) ? result : []).filter((request: MissingDocRequest) => !request.fulfilledAt),
      );
    } catch {
      setMissingRequests([]);
    } finally {
      setMissingLoading(false);
    }
  }

  const plainBadge = (
    <span className={`inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded-full border font-medium ${stageColor}`}>
      {stageLabel}
      {isMissingStage && <AlertTriangle className="w-3 h-3 opacity-70 shrink-0" />}
    </span>
  );

  const badge = hasDocIndicator ? (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverAnchor asChild>
        <button
          type="button"
          className={`inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded-full border font-medium transition-opacity hover:opacity-80 cursor-pointer ${stageColor}`}
          onClick={handleClick}
        >
          {stageLabel}
          {loading ? (
            <Loader2 className="w-3 h-3 opacity-70 animate-spin shrink-0" />
          ) : (
            <Paperclip className="w-3 h-3 opacity-70 shrink-0" />
          )}
        </button>
      </PopoverAnchor>
      <PopoverContent className="w-60 p-2" align="start">
        {docs && docs.length > 0 ? (
          docs.map((doc) => (
            <a
              key={doc.id}
              href={downloadUrl(doc.id)}
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center gap-2 px-2 py-1.5 rounded-md hover:bg-muted text-xs transition-colors"
              onClick={(event) => event.stopPropagation()}
            >
              <Download className="w-3.5 h-3.5 text-muted-foreground shrink-0" />
              <span className="truncate min-w-0">{doc.fileName}</span>
            </a>
          ))
        ) : (
          <p className="text-xs text-muted-foreground px-2 py-1">No documents</p>
        )}
      </PopoverContent>
    </Popover>
  ) : plainBadge;

  if (!isMissingStage) return badge;

  return (
    <HoverCard openDelay={150} closeDelay={100} onOpenChange={(isOpen) => { if (isOpen) void loadMissingRequests(); }}>
      <HoverCardTrigger asChild>
        <span className="inline-flex pointer-events-auto" onMouseEnter={() => void loadMissingRequests()} onFocus={() => void loadMissingRequests()}>
          {badge}
        </span>
      </HoverCardTrigger>
      <HoverCardContent side="right" align="start" sideOffset={8} collisionPadding={12} className="w-72 border-amber-200 bg-background p-3.5 shadow-xl">
          <div className="mb-2 flex items-center gap-2 border-b border-border/70 pb-2">
            <span className="flex h-6 w-6 items-center justify-center rounded-full bg-amber-100 text-amber-700">
              <AlertTriangle className="h-3.5 w-3.5" />
            </span>
            <p className="font-semibold text-sm">{t("stageDocs.missingTitle")}</p>
          </div>
          {missingLoading || missingRequests === null ? (
            <Loader2 className="w-3.5 h-3.5 animate-spin" />
          ) : missingRequests.length > 0 ? (
            <ul className="space-y-1.5">
              {missingRequests.map((request) => (
                <li key={request.id} className="flex items-start gap-2 rounded-md bg-amber-50/70 px-2.5 py-2 text-sm dark:bg-amber-950/20">
                  <span className="mt-1.5 h-1.5 w-1.5 rounded-full bg-amber-500 shrink-0" />
                  <span className="leading-5">{request.isCustom ? request.fileName : localizeDocType(request.fileName)}</span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-xs text-muted-foreground">{t("stageDocs.missingEmpty")}</p>
          )}
      </HoverCardContent>
    </HoverCard>
  );
}
