import { useEffect, useMemo, useState } from "react";
import { customFetch } from "@workspace/api-client-react";
import { AlertCircle, CheckCircle2, Loader2, MessageCircle, Send } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useI18n } from "@/hooks/use-i18n";

type CampaignEntityType = "lead" | "student" | "application";

interface ApprovedTemplate {
  id: number;
  name: string;
  content?: string | null;
  language?: string | null;
  category?: string | null;
  externalTemplateName?: string | null;
  approvalStatus?: string | null;
}

interface CampaignResult {
  data?: { id?: number; name?: string };
  summary?: { total: number; queued: number; skipped: number };
}

interface WhatsAppAccount {
  id: number;
  displayName: string;
  isDefault: boolean;
  metadata?: { brandLabel?: string | null; brandColor?: string | null } | null;
}

interface BulkMessageDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  entityType: CampaignEntityType;
  entityIds: number[];
  onCreated?: () => void;
}

function unwrapTemplates(response: any): ApprovedTemplate[] {
  const rows = response?.data ?? response ?? [];
  return Array.isArray(rows) ? rows : [];
}

export function BulkMessageDialog({
  open,
  onOpenChange,
  entityType,
  entityIds,
  onCreated,
}: BulkMessageDialogProps) {
  const { toast } = useToast();
  const { t } = useI18n();
  const tx = (key: string, vars?: Record<string, string | number>) => t(`bulkMessageDialog.${key}`, vars);
  const [templates, setTemplates] = useState<ApprovedTemplate[]>([]);
  const [accounts, setAccounts] = useState<WhatsAppAccount[]>([]);
  const [channelAccountId, setChannelAccountId] = useState<string>("");
  const [templateId, setTemplateId] = useState<number | null>(null);
  const [campaignName, setCampaignName] = useState("");
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(false);
  const [sending, setSending] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [result, setResult] = useState<CampaignResult | null>(null);

  useEffect(() => {
    if (!open) return;
    setLoading(true);
    setLoadError(null);
    setResult(null);
    void Promise.all([
      customFetch("/api/message-templates?channel=whatsapp&activeOnly=true"),
      customFetch("/api/inbox/whatsapp-accounts"),
    ])
      .then(([response, accountResponse]: any[]) => {
        const approved = unwrapTemplates(response).filter((template) => (
          Boolean(template.externalTemplateName)
          && String(template.approvalStatus || "").toLowerCase() === "approved"
        ));
        setTemplates(approved);
        setTemplateId((current) => (
          current && approved.some((template) => template.id === current)
            ? current
            : null
        ));
        const accountRows = Array.isArray(accountResponse?.accounts) ? accountResponse.accounts : [];
        setAccounts(accountRows);
        setChannelAccountId((current) => current || String(accountRows.find((account: WhatsAppAccount) => account.isDefault)?.id || accountRows[0]?.id || ""));
      })
      .catch((error: any) => {
        setLoadError(error?.message || tx("loadFailed"));
      })
      .finally(() => setLoading(false));
  }, [open]);

  const filteredTemplates = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return templates;
    return templates.filter((template) => (
      template.name.toLowerCase().includes(needle)
      || String(template.externalTemplateName || "").toLowerCase().includes(needle)
      || String(template.content || "").toLowerCase().includes(needle)
    ));
  }, [query, templates]);

  const selectedTemplate = templates.find((template) => template.id === templateId) || null;
  const uniqueEntityIds = useMemo(() => [...new Set(entityIds)], [entityIds]);

  const close = () => {
    if (sending) return;
    onOpenChange(false);
    setQuery("");
    setCampaignName("");
    setResult(null);
  };

  const createCampaign = async () => {
    if (!templateId || !channelAccountId || uniqueEntityIds.length === 0) return;
    setSending(true);
    try {
      const response = await customFetch("/api/message-campaigns", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: campaignName.trim() || undefined,
          entityType,
          entityIds: uniqueEntityIds,
          templateId,
          channelAccountId: Number(channelAccountId),
        }),
      }) as CampaignResult;
      setResult(response);
      const summary = response.summary;
      toast({
        title: tx("queuedToast", { count: summary?.queued ?? 0 }),
        description: summary?.skipped
          ? tx("skippedToast", { count: summary.skipped })
          : tx("workerNotice"),
      });
      onCreated?.();
    } catch (error: any) {
      toast({
        title: tx("createFailed"),
        description: error?.message || tx("notQueued"),
        variant: "destructive",
      });
    } finally {
      setSending(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(next) => { if (next) onOpenChange(true); else close(); }}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <MessageCircle className="h-5 w-5 text-emerald-600" />
            {tx("title")}
          </DialogTitle>
          <DialogDescription>
            {tx("description", { count: uniqueEntityIds.length, entity: t(`bulkMessageDialog.entities.${entityType}`) })}
          </DialogDescription>
        </DialogHeader>

        {result ? (
          <div className="space-y-4 py-2">
            <Alert className="border-emerald-200 bg-emerald-50 text-emerald-950">
              <CheckCircle2 className="h-4 w-4 text-emerald-600" />
              <AlertTitle>{tx("campaignQueued")}</AlertTitle>
              <AlertDescription>
                {tx("summary", { queued: result.summary?.queued ?? 0, skipped: result.summary?.skipped ?? 0, total: result.summary?.total ?? uniqueEntityIds.length })}
              </AlertDescription>
            </Alert>
            <p className="text-sm text-muted-foreground">
              {tx("historyNotice")}
            </p>
          </div>
        ) : (
          <div className="space-y-4 py-2">
            <Alert>
              <AlertCircle className="h-4 w-4" />
              <AlertTitle>{tx("selectedSenderTitle")}</AlertTitle>
              <AlertDescription>
                {tx("selectedSenderHelp")}
              </AlertDescription>
            </Alert>

            <div className="space-y-2">
              <Label>{tx("senderLine")}</Label>
              <Select value={channelAccountId} onValueChange={setChannelAccountId}>
                <SelectTrigger><SelectValue placeholder={tx("selectSenderLine")} /></SelectTrigger>
                <SelectContent>
                  {accounts.map((account) => (
                    <SelectItem key={account.id} value={String(account.id)}>
                      <span className="inline-flex items-center gap-2">
                        <span className="h-2 w-2 rounded-full" style={{ backgroundColor: account.metadata?.brandColor || "#143591" }} />
                        {account.metadata?.brandLabel || account.displayName}{account.isDefault ? ` · ${tx("systemDefault")}` : ""}
                      </span>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-2">
              <Label htmlFor="campaign-name">{tx("campaignName")}</Label>
              <Input
                id="campaign-name"
                value={campaignName}
                onChange={(event) => setCampaignName(event.target.value)}
                placeholder={`${selectedTemplate?.externalTemplateName || "WhatsApp campaign"} · ${uniqueEntityIds.length} selected`}
                maxLength={180}
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="template-search">{tx("approvedTemplate")}</Label>
              <Input
                id="template-search"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder={tx("searchTemplates")}
              />
              <div className="rounded-xl border">
                {loading ? (
                  <div className="flex h-40 items-center justify-center text-sm text-muted-foreground">
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" /> {tx("loadingTemplates")}
                  </div>
                ) : loadError ? (
                  <div className="p-4 text-sm text-destructive">{loadError}</div>
                ) : filteredTemplates.length === 0 ? (
                  <div className="p-4 text-sm text-muted-foreground">{tx("noTemplate")}</div>
                ) : (
                  <ScrollArea className="h-56">
                    <div className="divide-y">
                      {filteredTemplates.map((template) => {
                        const selected = template.id === templateId;
                        return (
                          <button
                            type="button"
                            key={template.id}
                            onClick={() => setTemplateId(template.id)}
                            className={`w-full p-3 text-left transition-colors ${selected ? "bg-primary/10 ring-1 ring-inset ring-primary" : "hover:bg-muted/50"}`}
                          >
                            <div className="flex items-center justify-between gap-3">
                              <span className="truncate text-sm font-semibold">
                                {template.externalTemplateName || template.name}
                              </span>
                              <div className="flex shrink-0 items-center gap-1.5">
                                <Badge variant="outline" className="text-[10px]">{template.language || "EN"}</Badge>
                                <Badge className="bg-emerald-100 text-emerald-700 hover:bg-emerald-100">{tx("approved")}</Badge>
                              </div>
                            </div>
                            <p className="mt-1 line-clamp-2 text-xs text-muted-foreground">{template.content || tx("noPreview")}</p>
                          </button>
                        );
                      })}
                    </div>
                  </ScrollArea>
                )}
              </div>
            </div>
          </div>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={close} disabled={sending}>
            {result ? tx("close") : tx("cancel")}
          </Button>
          {!result && (
            <Button onClick={createCampaign} disabled={!templateId || !channelAccountId || uniqueEntityIds.length === 0 || sending}>
              {sending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Send className="mr-2 h-4 w-4" />}
              {tx("queueRecipients", { count: uniqueEntityIds.length })}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
