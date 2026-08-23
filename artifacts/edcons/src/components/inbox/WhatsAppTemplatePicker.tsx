import { useState, useEffect } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { useToast } from "@/hooks/use-toast";
import { useI18n } from "@/hooks/use-i18n";
import { customFetch } from "@workspace/api-client-react";
import { cn } from "@/lib/utils";
import { Search, FileText, Send, Loader2 } from "lucide-react";

const TEMPLATE_VARIABLE_LABEL_KEYS: Record<string, string> = {
  studentName: "messagesPage.variableStudentName",
  firstName: "messagesPage.variableFirstName",
  lastName: "messagesPage.variableLastName",
  programName: "messagesPage.variableProgramName",
  universityName: "messagesPage.variableUniversityName",
  deadline: "messagesPage.variableDeadline",
  level: "messagesPage.variableLevel",
  intake: "messagesPage.variableIntake",
};

function initialTemplateParameters(template: any, count: number): string[] {
  const resolved = Array.isArray(template?.resolvedParameters)
    ? template.resolvedParameters.map((value: unknown) => String(value || ""))
    : [];
  return Array.from({ length: count }, (_, index) => resolved[index] || "");
}

interface WhatsAppTemplatePickerProps {
  open: boolean;
  onClose: () => void;
  /** Exact conversation line wins; otherwise the entity's latest/default line is resolved. */
  conversationId?: number | null;
  entityType?: "lead" | "student" | "application";
  entityId?: number | null;
  /** Optional approved template to preselect (used by the composer slash menu). */
  initialTemplateId?: number | null;
  /**
   * Called when the user clicks Send. The component handles loading state via
   * the `sending` prop — the caller should set it to true while the API call
   * is in flight, then call onClose() on success.
   */
  onSend: (templateId: number, parameters: string[]) => Promise<void>;
  sending?: boolean;
}

export function WhatsAppTemplatePicker({
  open,
  onClose,
  conversationId,
  entityType,
  entityId,
  initialTemplateId,
  onSend,
  sending,
}: WhatsAppTemplatePickerProps) {
  const { t } = useI18n();
  const { toast } = useToast();

  const [templates, setTemplates] = useState<any[]>([]);
  const [tplLoading, setTplLoading] = useState(false);
  const [tplId, setTplId] = useState<string>("");
  const [tplVars, setTplVars] = useState<string[]>([]);
  const [templateQuery, setTemplateQuery] = useState("");
  const [targetAccount, setTargetAccount] = useState<{ displayName: string; isDefault: boolean } | null>(null);

  async function loadTemplates() {
    setTplId("");
    setTplVars([]);
    setTemplateQuery("");
    setTplLoading(true);
    try {
      let endpoint = `/api/message-templates?channel=whatsapp&activeOnly=true`;
      if (conversationId) {
        endpoint = `/api/inbox/whatsapp-templates/available?conversationId=${conversationId}`;
      } else if (entityType && entityId) {
        endpoint = `/api/inbox/whatsapp-templates/available?entityType=${encodeURIComponent(entityType)}&entityId=${entityId}`;
      }
      const r = await customFetch(endpoint);
      const loaded = (r as any)?.data || [];
      setTemplates(loaded);
      setTargetAccount((r as any)?.channelAccount || null);
      if (initialTemplateId != null) {
        const initial = loaded.find((tpl: any) =>
          tpl.id === initialTemplateId &&
          tpl.externalTemplateName &&
          String(tpl.approvalStatus ?? tpl.status ?? "").toLowerCase() === "approved"
        );
        if (initial) {
          const body = initial.content ?? initial.bodyText ?? "";
          const count = Array.isArray(initial.variables)
            ? initial.variables.length
            : (initial.variableCount ?? (body.match(/\{\{\d+\}\}/g) || []).length);
          setTplId(String(initial.id));
          setTplVars(initialTemplateParameters(initial, count));
        }
      }
    } catch (err: any) {
      const detail = err?.data?.detail || err?.body?.detail || err?.data?.error || err?.body?.error;
      toast({
        title: t("messagesPage.failedToLoadTemplates"),
        description: typeof detail === "string" ? detail : undefined,
        variant: "destructive",
      });
    } finally {
      setTplLoading(false);
    }
  }

  // useEffect is the correct way to react to a controlled `open` prop change.
  // Dialog's onOpenChange is only fired when the Dialog itself initiates a close
  // (Escape, overlay click) — it is NOT called when the parent flips open false→true.
  useEffect(() => {
    if (open) {
      loadTemplates();
    } else {
      setTplId("");
      setTplVars([]);
      setTemplateQuery("");
      setTargetAccount(null);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, initialTemplateId, conversationId, entityType, entityId]);

  function handleOpenChange(isOpen: boolean) {
    // Only reached via Dialog's own close gestures (Escape / overlay click).
    if (!isOpen) {
      onClose();
    }
  }

  async function handleSend() {
    if (!tplId) return;
    const selectedTpl = templates.find(tpl => String(tpl.id) === tplId);
    if (!selectedTpl) return;
    try {
      await onSend(parseInt(tplId, 10), tplVars.map(v => v.trim()));
    } catch (err: any) {
      const realErr = err?.data?.detail || err?.body?.detail || err?.data?.error || err?.body?.error || err?.message;
      toast({
        title: t("messagesPage.failedToSendTemplate"),
        description: typeof realErr === "string" ? realErr : undefined,
        variant: "destructive",
      });
    }
  }

  const approved = templates.filter(tpl =>
    tpl.externalTemplateName &&
    (tpl.approvalStatus ?? tpl.status ?? "").toLowerCase() === "approved"
  );
  const q = templateQuery.toLowerCase();
  const filtered = approved.filter(tpl =>
    !q ||
    (tpl.externalTemplateName || tpl.name || "").toLowerCase().includes(q) ||
    (tpl.category || "").toLowerCase().includes(q) ||
    (tpl.language || "").toLowerCase().includes(q) ||
    (tpl.content ?? tpl.bodyText ?? "").toLowerCase().includes(q)
  );

  const selectedTpl = templates.find(tpl => String(tpl.id) === tplId);
  const selBody = selectedTpl ? (selectedTpl.content ?? selectedTpl.bodyText ?? "") : "";
  const varCount = selectedTpl
    ? (Array.isArray(selectedTpl.variables) ? selectedTpl.variables.length : (selectedTpl.variableCount ?? (selBody.match(/\{\{\d+\}\}/g) || []).length))
    : 0;

  const preview = selBody.replace(/\{\{(\d+)\}\}/g, (_: string, n: string) => {
    const val = tplVars[parseInt(n, 10) - 1];
    return val?.trim() ? val.trim() : `{{${n}}}`;
  });

  const sendDisabled =
    !tplId ||
    sending ||
    (varCount > 0 && tplVars.some(v => !v.trim()));

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <FileText className="w-4 h-4" />
            {t("messagesPage.whatsappTemplate")}
          </DialogTitle>
        </DialogHeader>

        <div className="space-y-4 py-2">
          <div className="relative">
            <Search className="absolute left-2.5 top-2.5 w-4 h-4 text-muted-foreground pointer-events-none" />
            <Input
              className="pl-8 h-9 rounded-lg"
              placeholder={t("messagesPage.searchTemplates")}
              value={templateQuery}
              onChange={(e) => setTemplateQuery(e.target.value)}
            />
          </div>

          {targetAccount?.displayName && (
            <div className="flex justify-end">
              <Badge variant="outline" className="max-w-full truncate" title={targetAccount.displayName}>
                {targetAccount.displayName}
              </Badge>
            </div>
          )}

          {tplLoading ? (
            <div className="flex items-center justify-center py-8">
              <Loader2 className="w-5 h-5 animate-spin text-muted-foreground" />
            </div>
          ) : (() => {
            if (approved.length === 0) {
              return <p className="text-sm text-muted-foreground text-center py-6">{t("messagesPage.noApprovedTemplates")}</p>;
            }
            if (filtered.length === 0) {
              return <p className="text-sm text-muted-foreground text-center py-6">{t("messagesPage.noTemplatesMatchSearch")}</p>;
            }
            return (
              <div className="max-h-56 overflow-y-auto space-y-1.5 pr-1">
                {filtered.map(tpl => {
                  const isSelected = tplId === String(tpl.id);
                  const rawStatus = (tpl.approvalStatus ?? tpl.status ?? "").toUpperCase();
                  const body = tpl.content ?? tpl.bodyText ?? "";
                  const vCount = Array.isArray(tpl.variables)
                    ? tpl.variables.length
                    : (tpl.variableCount ?? (body.match(/\{\{\d+\}\}/g) || []).length);
                  return (
                    <button
                      key={tpl.id}
                      type="button"
                      onClick={() => {
                        setTplId(String(tpl.id));
                        setTplVars(initialTemplateParameters(tpl, vCount));
                      }}
                      className={cn(
                        "w-full text-left rounded-lg border p-2.5 transition-colors hover:bg-muted/50",
                        isSelected ? "border-primary bg-primary/5 ring-1 ring-primary" : "border-border"
                      )}
                    >
                      <div className="flex items-center gap-1.5 flex-wrap">
                        <span className="font-medium text-sm flex-1 min-w-0 truncate">
                          {tpl.externalTemplateName || tpl.name}
                        </span>
                        {tpl.language && (
                          <Badge variant="secondary" className="text-[10px] px-1.5 h-4 shrink-0">
                            {tpl.language.toUpperCase()}
                          </Badge>
                        )}
                        {tpl.category && (
                          <Badge variant="outline" className="text-[10px] px-1.5 h-4 shrink-0">
                            {tpl.category}
                          </Badge>
                        )}
                        {rawStatus && (
                          <Badge
                            variant="outline"
                            className={cn(
                              "text-[10px] px-1.5 h-4 shrink-0",
                              rawStatus === "APPROVED" ? "bg-green-50 text-green-700 border-green-200" :
                              rawStatus === "PENDING" ? "bg-yellow-50 text-yellow-700 border-yellow-200" :
                              "bg-gray-50 text-gray-600"
                            )}
                          >
                            {rawStatus}
                          </Badge>
                        )}
                      </div>
                      {body && (
                        <p className="text-xs text-muted-foreground mt-1 line-clamp-2">{body}</p>
                      )}
                    </button>
                  );
                })}
              </div>
            );
          })()}

          {selectedTpl && varCount > 0 && (
            <div className="space-y-2">
              {Array.from({ length: varCount }, (_, i) => (
                <div key={i}>
                  <Label className="text-xs">
                    {t("messagesPage.templateVariable", { n: String(i + 1) })}
                    {selectedTpl.variables?.[i] && TEMPLATE_VARIABLE_LABEL_KEYS[selectedTpl.variables[i]]
                      ? ` — ${t(TEMPLATE_VARIABLE_LABEL_KEYS[selectedTpl.variables[i]])}`
                      : ""}
                  </Label>
                  <Input
                    className="h-9 rounded-lg mt-0.5"
                    placeholder={`{{${i + 1}}}`}
                    value={tplVars[i] ?? ""}
                    onChange={(e) => setTplVars(prev => {
                      const next = [...prev];
                      next[i] = e.target.value;
                      return next;
                    })}
                  />
                </div>
              ))}
            </div>
          )}

          {selBody && (
            <div>
              <Label className="text-xs">{t("messagesPage.preview")}</Label>
              <div className="mt-1 rounded-xl bg-green-50 border border-green-200 px-3 py-2.5">
                <p className="text-sm whitespace-pre-wrap text-green-900">{preview}</p>
              </div>
            </div>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={sending}>
            {t("messagesPage.cancel")}
          </Button>
          <Button onClick={handleSend} disabled={sendDisabled} className="gap-1">
            {sending
              ? <><Loader2 className="w-3 h-3 animate-spin" /> {t("messagesPage.sending")}</>
              : <><Send className="w-3 h-3" /> {t("messagesPage.send")}</>
            }
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
