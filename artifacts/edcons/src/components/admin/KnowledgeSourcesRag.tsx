import { useState, useEffect, useCallback, useRef } from "react";
import { customFetch } from "@workspace/api-client-react";
import { apiFetch } from "@/lib/apiFetch";
import { useI18n } from "@/hooks/use-i18n";
import { useToast } from "@/hooks/use-toast";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription,
} from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  FileText,
  BedDouble,
  GraduationCap,
  Link as LinkIcon,
  Type,
  Plus,
  Trash2,
  RefreshCw,
  Sparkles,
} from "lucide-react";

const BASE_URL = import.meta.env.BASE_URL?.replace(/\/$/, "") || "";

type ManualRagSourceType = "file" | "url" | "text" | "dormbooking";
type RagSourceType = ManualRagSourceType | "academy";
type RagSourceStatus = "pending" | "processing" | "ready" | "error" | null;

interface RagSource {
  id: number;
  type: RagSourceType;
  name: string;
  isActive: boolean;
  status: RagSourceStatus;
  lastSyncedAt: string | null;
  createdAt: string;
  chunkCount: number;
  config: {
    error?: string;
    extractedChars?: number;
    fileName?: string;
    url?: string;
    dormCount?: number;
    roomCount?: number;
    fetchedAt?: string;
    lastSyncError?: string | null;
    lastSyncErrorAt?: string | null;
  };
}

const TYPE_ICON: Record<RagSourceType, typeof FileText> = {
  file: FileText,
  url: LinkIcon,
  text: Type,
  academy: GraduationCap,
  dormbooking: BedDouble,
};

function statusBadgeVariant(status: RagSourceStatus): "default" | "secondary" | "destructive" | "outline" {
  if (status === "ready") return "default";
  if (status === "error") return "destructive";
  if (status === "processing") return "outline";
  return "secondary";
}

function botScopedUrl(path: string, aiBotId: number) {
  const separator = path.includes("?") ? "&" : "?";
  return `${path}${separator}aiBotId=${encodeURIComponent(aiBotId)}`;
}

export default function KnowledgeSourcesRag({ aiBotId }: { aiBotId: number }) {
  const { t } = useI18n();
  const { toast } = useToast();

  const [sources, setSources] = useState<RagSource[]>([]);
  const [loading, setLoading] = useState(true);

  const [newType, setNewType] = useState<ManualRagSourceType>("file");
  const [newName, setNewName] = useState("");
  const [newUrl, setNewUrl] = useState("");
  const [newText, setNewText] = useState("");
  const [pendingFile, setPendingFile] = useState<File | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const { sources: list } = await customFetch<{ sources: RagSource[] }>(
        botScopedUrl("/api/inbox/knowledge-sources/rag", aiBotId),
      );
      setSources(list);
    } catch {
      toast({ title: t("aiAgentAdmin.ragSources.loadError"), variant: "destructive" });
    } finally {
      setLoading(false);
    }
  }, [aiBotId, t, toast]);

  useEffect(() => {
    load();
  }, [load]);

  // Poll while any source is pending/processing so the admin sees status
  // flip to ready/error without a manual refresh.
  useEffect(() => {
    const hasInFlight = sources.some((s) => s.status === "pending" || s.status === "processing");
    if (!hasInFlight) return;
    const interval = setInterval(load, 4000);
    return () => clearInterval(interval);
  }, [sources, load]);

  const resetForm = () => {
    setNewName("");
    setNewUrl("");
    setNewText("");
    setPendingFile(null);
    if (fileInputRef.current) fileInputRef.current.value = "";
  };

  const createSource = async () => {
    if (!newName.trim()) {
      toast({ title: t("aiAgentAdmin.ragSources.nameRequired"), variant: "destructive" });
      return;
    }
    setSubmitting(true);
    try {
      if (newType === "file") {
        if (!pendingFile) {
          toast({ title: t("aiAgentAdmin.ragSources.fileRequired"), variant: "destructive" });
          return;
        }
        const reqRes = await apiFetch(`${BASE_URL}/api/storage/uploads/request-url`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            name: pendingFile.name,
            size: pendingFile.size,
            contentType: pendingFile.type,
            prefix: "knowledge-sources",
          }),
        });
        if (!reqRes.ok) throw new Error("upload-url-failed");
        const { uploadURL, objectPath } = (await reqRes.json()) as {
          uploadURL: string;
          objectPath: string;
        };
        const putRes = await fetch(uploadURL, {
          method: "PUT",
          body: pendingFile,
          headers: { "Content-Type": pendingFile.type },
        });
        if (!putRes.ok) throw new Error("upload-failed");
        await customFetch(botScopedUrl("/api/inbox/knowledge-sources/rag", aiBotId), {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            type: "file",
            name: newName.trim(),
            objectPath,
            fileName: pendingFile.name,
            mimeType: pendingFile.type,
          }),
        });
      } else if (newType === "url") {
        if (!newUrl.trim()) {
          toast({ title: t("aiAgentAdmin.ragSources.urlRequired"), variant: "destructive" });
          setSubmitting(false);
          return;
        }
        await customFetch(botScopedUrl("/api/inbox/knowledge-sources/rag", aiBotId), {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ type: "url", name: newName.trim(), url: newUrl.trim() }),
        });
      } else if (newType === "text") {
        if (!newText.trim()) {
          toast({ title: t("aiAgentAdmin.ragSources.textRequired"), variant: "destructive" });
          setSubmitting(false);
          return;
        }
        await customFetch(botScopedUrl("/api/inbox/knowledge-sources/rag", aiBotId), {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ type: "text", name: newName.trim(), rawText: newText.trim() }),
        });
      } else {
        await customFetch(botScopedUrl("/api/inbox/knowledge-sources/rag", aiBotId), {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ type: "dormbooking", name: newName.trim() }),
        });
      }
      toast({ title: t("aiAgentAdmin.ragSources.createSuccess") });
      resetForm();
      await load();
    } catch {
      toast({ title: t("aiAgentAdmin.ragSources.createError"), variant: "destructive" });
    } finally {
      setSubmitting(false);
    }
  };

  const toggleActive = async (source: RagSource) => {
    setSources((prev) =>
      prev.map((s) => (s.id === source.id ? { ...s, isActive: !s.isActive } : s)),
    );
    try {
      await customFetch(botScopedUrl(`/api/inbox/knowledge-sources/rag/${source.id}`, aiBotId), {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ isActive: !source.isActive }),
      });
    } catch {
      toast({ title: t("aiAgentAdmin.ragSources.updateError"), variant: "destructive" });
      load();
    }
  };

  const reprocess = async (source: RagSource) => {
    try {
      await customFetch(
        botScopedUrl(`/api/inbox/knowledge-sources/rag/${source.id}/reprocess`, aiBotId),
        {
        method: "POST",
        },
      );
      toast({ title: t("aiAgentAdmin.ragSources.reprocessQueued") });
      load();
    } catch {
      toast({ title: t("aiAgentAdmin.ragSources.updateError"), variant: "destructive" });
    }
  };

  const remove = async (source: RagSource) => {
    if (!window.confirm(t("aiAgentAdmin.ragSources.deleteConfirm", { name: source.name }))) return;
    try {
      await customFetch(botScopedUrl(`/api/inbox/knowledge-sources/rag/${source.id}`, aiBotId), {
        method: "DELETE",
      });
      setSources((prev) => prev.filter((s) => s.id !== source.id));
      toast({ title: t("aiAgentAdmin.ragSources.deleteSuccess") });
    } catch {
      toast({ title: t("aiAgentAdmin.ragSources.deleteError"), variant: "destructive" });
    }
  };

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-center gap-2">
          <Sparkles className="h-4 w-4 text-primary" />
          <CardTitle className="text-base">{t("aiAgentAdmin.ragSources.title")}</CardTitle>
        </div>
        <CardDescription>{t("aiAgentAdmin.ragSources.hint")}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-5">
        {/* Add new source */}
        <div className="rounded-xl border p-3 space-y-3">
          <div className="grid grid-cols-1 sm:grid-cols-[160px_1fr] gap-3">
            <div className="space-y-1.5">
              <Label>{t("aiAgentAdmin.ragSources.typeLabel")}</Label>
              <Select value={newType} onValueChange={(v) => setNewType(v as ManualRagSourceType)}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="file">{t("aiAgentAdmin.ragSources.typeFile")}</SelectItem>
                  <SelectItem value="url">{t("aiAgentAdmin.ragSources.typeUrl")}</SelectItem>
                  <SelectItem value="text">{t("aiAgentAdmin.ragSources.typeText")}</SelectItem>
                  <SelectItem value="dormbooking">{t("aiAgentAdmin.ragSources.typeDormBooking")}</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label>{t("aiAgentAdmin.ragSources.nameLabel")}</Label>
              <Input
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                placeholder={t("aiAgentAdmin.ragSources.namePlaceholder")}
              />
            </div>
          </div>

          {newType === "file" && (
            <div className="space-y-1.5">
              <Label>{t("aiAgentAdmin.ragSources.fileLabel")}</Label>
              <Input
                ref={fileInputRef}
                type="file"
                accept=".pdf,.doc,.docx,.xls,.xlsx,.csv,.txt"
                onChange={(e) => setPendingFile(e.target.files?.[0] ?? null)}
              />
              <p className="text-xs text-muted-foreground">
                {t("aiAgentAdmin.ragSources.fileHint")}
              </p>
            </div>
          )}
          {newType === "url" && (
            <div className="space-y-1.5">
              <Label>{t("aiAgentAdmin.ragSources.urlLabel")}</Label>
              <Input
                value={newUrl}
                onChange={(e) => setNewUrl(e.target.value)}
                placeholder="https://example.com/kabul-kosullari"
              />
            </div>
          )}
          {newType === "text" && (
            <div className="space-y-1.5">
              <Label>{t("aiAgentAdmin.ragSources.textLabel")}</Label>
              <Textarea
                value={newText}
                onChange={(e) => setNewText(e.target.value)}
                rows={5}
                placeholder={t("aiAgentAdmin.ragSources.textPlaceholder")}
              />
            </div>
          )}

          <div className="flex justify-end">
            <Button onClick={createSource} disabled={submitting} size="sm">
              <Plus className="h-4 w-4 mr-2" />
              {submitting ? t("aiAgentAdmin.ragSources.adding") : t("aiAgentAdmin.ragSources.add")}
            </Button>
          </div>
        </div>

        {/* List */}
        {loading ? (
          <Skeleton className="h-24 w-full rounded-xl" />
        ) : sources.length === 0 ? (
          <p className="text-sm text-muted-foreground text-center py-4">
            {t("aiAgentAdmin.ragSources.empty")}
          </p>
        ) : (
          <div className="space-y-2">
            {sources.map((source) => {
              const Icon = TYPE_ICON[source.type];
              return (
                <div
                  key={source.id}
                  className="flex items-center justify-between gap-3 rounded-xl border p-3"
                >
                  <div className="flex items-center gap-3 min-w-0">
                    <Icon className="h-4 w-4 text-muted-foreground shrink-0" />
                    <div className="min-w-0">
                      <p className="font-medium text-sm truncate">{source.name}</p>
                      <p className="text-xs text-muted-foreground truncate">
                        {source.status === "ready" &&
                          t("aiAgentAdmin.ragSources.chunkCount", { count: source.chunkCount })}
                        {source.status === "error" &&
                          (source.config?.error || t("aiAgentAdmin.ragSources.statusError"))}
                        {source.status === "processing" && t("aiAgentAdmin.ragSources.statusProcessing")}
                        {source.status === "pending" && t("aiAgentAdmin.ragSources.statusPending")}
                      </p>
                      {source.type === "dormbooking" && source.status === "ready" && (
                        <div className="mt-1 space-y-0.5 text-xs text-muted-foreground">
                          {typeof source.config.dormCount === "number" && typeof source.config.roomCount === "number" && (
                            <p>
                              {t("aiAgentAdmin.ragSources.catalogCounts", {
                                dorms: source.config.dormCount,
                                rooms: source.config.roomCount,
                              })}
                            </p>
                          )}
                          {source.lastSyncedAt && (
                            <p>
                              {t("aiAgentAdmin.knowledgeSources.lastSyncedAt", {
                                date: new Intl.DateTimeFormat(document.documentElement.lang || "en", {
                                  dateStyle: "medium",
                                  timeStyle: "short",
                                }).format(new Date(source.lastSyncedAt)),
                              })}
                            </p>
                          )}
                          {source.config.lastSyncError && (
                            <p className="max-w-xl truncate text-destructive" title={source.config.lastSyncError}>
                              {t("aiAgentAdmin.ragSources.statusError")} {source.config.lastSyncError}
                            </p>
                          )}
                        </div>
                      )}
                    </div>
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    <Badge variant={statusBadgeVariant(source.status)}>
                      {t(`aiAgentAdmin.ragSources.status.${source.status ?? "pending"}`)}
                    </Badge>
                    <Switch checked={source.isActive} onCheckedChange={() => toggleActive(source)} />
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-8 w-8"
                      onClick={() => reprocess(source)}
                      title={t("aiAgentAdmin.ragSources.reprocess")}
                    >
                      <RefreshCw className="h-4 w-4" />
                    </Button>
                    {source.type !== "academy" && (
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-8 w-8 text-destructive"
                        onClick={() => remove(source)}
                        title={t("aiAgentAdmin.ragSources.delete")}
                      >
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
