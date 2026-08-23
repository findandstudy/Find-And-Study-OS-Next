import { useEffect, useState } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { AlertTriangle, Check, Clock, Loader2 } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { useI18n } from "@/hooks/use-i18n";
import { markDocRequestFulfilled, type MissingDocEntry } from "@/lib/stageTransition";

function prettify(key: string): string {
  return key.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

interface StageDocsIncompleteDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  applicationId: number;
  currentStageLabel: string;
  missing: MissingDocEntry[];
  isAdmin: boolean;
  /** Called when the user asks to retry the move after resolving items. */
  onRetry: () => void;
}

/**
 * Task #269 — Shown when a forward stage move is blocked because the current
 * stage still has unfulfilled document requests. Clearly lists what is missing.
 * Admin/staff can mark individual requests fulfilled inline (e.g. for custom
 * requests that were uploaded but await manual confirmation), then retry.
 */
export function StageDocsIncompleteDialog({
  open, onOpenChange, applicationId, currentStageLabel, missing, isAdmin, onRetry,
}: StageDocsIncompleteDialogProps) {
  const { t } = useI18n();
  const { toast } = useToast();
  const [items, setItems] = useState<MissingDocEntry[]>(missing);
  const [busyId, setBusyId] = useState<number | null>(null);

  useEffect(() => { if (open) setItems(missing); }, [open, missing]);

  async function handleMarkFulfilled(id: number) {
    setBusyId(id);
    try {
      await markDocRequestFulfilled(applicationId, id, true);
      setItems(prev => prev.filter(i => i.id !== id));
      toast({ title: t("stageDocsIncomplete.marked") });
    } catch (err: any) {
      toast({ title: t("stageDocsIncomplete.markFailed"), description: err?.message, variant: "destructive" });
    } finally {
      setBusyId(null);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <AlertTriangle className="w-5 h-5 text-amber-500" />
            {t("stageDocsIncomplete.title")}
          </DialogTitle>
          <DialogDescription>
            {t("stageDocsIncomplete.subtitle", { stage: currentStageLabel })}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-2 py-1 max-h-[360px] overflow-y-auto pr-1">
          {items.length === 0 ? (
            <p className="text-sm text-emerald-600 py-3 text-center">{t("stageDocsIncomplete.allResolved")}</p>
          ) : items.map((m) => {
            const name = m.isCustom ? (m.customTitle || "") : prettify(m.documentType || "");
            return (
              <div key={m.id} className="flex items-start gap-2 rounded-lg border p-2.5 bg-muted/20">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="text-sm font-medium">{name}</span>
                    <Badge variant={m.isCustom ? "secondary" : "outline"} className="text-[10px]">
                      {m.isCustom ? t("stageDocRequest.customBadge") : t("stageDocRequest.catalogBadge")}
                    </Badge>
                    {m.respondedAt && (
                      <Badge className="text-[10px] gap-1 bg-amber-100 text-amber-700 border-0 dark:bg-amber-900/40 dark:text-amber-300">
                        <Clock className="w-3 h-3" /> {t("stageDocsIncomplete.awaitingReview")}
                      </Badge>
                    )}
                  </div>
                  {m.note && <p className="text-xs text-muted-foreground mt-0.5">{m.note}</p>}
                </div>
                {isAdmin && (
                  <Button
                    variant="outline" size="sm" className="h-7 gap-1 text-xs shrink-0"
                    onClick={() => handleMarkFulfilled(m.id)}
                    disabled={busyId === m.id}
                  >
                    {busyId === m.id ? <Loader2 className="w-3 h-3 animate-spin" /> : <Check className="w-3 h-3" />}
                    {t("stageDocsIncomplete.markReceived")}
                  </Button>
                )}
              </div>
            );
          })}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {t("common.close")}
          </Button>
          <Button onClick={onRetry} disabled={items.length > 0}>
            {t("stageDocsIncomplete.retry")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
