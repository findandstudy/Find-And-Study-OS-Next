/**
 * ManualSubmitDialog.tsx
 *
 * Admin tool to manually queue one or many applications to the portal without
 * waiting for the stage-driven auto-tour.
 *
 * Flow:
 *   1. Search + multi-select eligible applications
 *      (GET /api/portal-automation/eligible-applications).
 *   2. Pick mode (Dry / Live).
 *   3. Queue (POST /api/portal-automation/submit). Live mode shows an
 *      AlertDialog confirmation and sends confirm:true.
 *
 * The university/adapter is resolved server-side from each application's own
 * record — this dialog never sends a universityKey.
 */

import { useState, useEffect, useCallback, useRef } from "react";
import { customFetch } from "@workspace/api-client-react";
import { useI18n } from "@/hooks/use-i18n";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Badge } from "@/components/ui/badge";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter,
} from "@/components/ui/dialog";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Loader2, Search, FlaskConical, Send } from "lucide-react";

const BASE_URL = import.meta.env.BASE_URL?.replace(/\/$/, "") || "";

interface EligibleApplication {
  id: number;
  stage: string;
  universityName: string | null;
  studentFirstName: string;
  studentLastName: string;
  studentEmail: string | null;
  portalUniversityKey: string;
  portalUniversityName: string;
}

interface EligibleResponse {
  data: EligibleApplication[];
  total: number;
}

interface SubmitResult {
  queued: { applicationId: number; submissionId: number; universityKey: string }[];
  skipped: { applicationId: number; reason: string; submissionId?: number }[];
}

interface ManualSubmitDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Called after a successful queue so the board can reload. */
  onQueued: () => void;
}

export function ManualSubmitDialog({ open, onOpenChange, onQueued }: ManualSubmitDialogProps) {
  const { t } = useI18n();
  const { toast } = useToast();

  const [query, setQuery] = useState("");
  const [apps, setApps] = useState<EligibleApplication[]>([]);
  const [loading, setLoading] = useState(false);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [mode, setMode] = useState<"dry" | "real">("dry");
  const [submitting, setSubmitting] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);

  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const loadEligible = useCallback(async (q: string) => {
    setLoading(true);
    try {
      const params = new URLSearchParams({ limit: "50" });
      if (q.trim()) params.set("q", q.trim());
      const res = await customFetch<EligibleResponse>(
        `${BASE_URL}/api/portal-automation/eligible-applications?${params}`,
      );
      setApps(res.data ?? []);
    } catch {
      toast({ title: t("portalAutomation.manualSubmit.loadError"), variant: "destructive" });
    } finally {
      setLoading(false);
    }
  }, [t, toast]);

  // Reset state and load the first page whenever the dialog opens.
  useEffect(() => {
    if (!open) return;
    setQuery("");
    setSelected(new Set());
    setMode("dry");
    void loadEligible("");
  }, [open, loadEligible]);

  // Debounced search.
  useEffect(() => {
    if (!open) return;
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => { void loadEligible(query); }, 300);
    return () => { if (debounceRef.current) clearTimeout(debounceRef.current); };
  }, [query, open, loadEligible]);

  const toggle = (id: number) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  const doSubmit = useCallback(async () => {
    const ids = [...selected];
    if (ids.length === 0) return;
    setSubmitting(true);
    try {
      const res = await customFetch<SubmitResult>(
        `${BASE_URL}/api/portal-automation/submit`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            applicationIds: ids,
            mode,
            ...(mode === "real" ? { confirm: true } : {}),
          }),
        },
      );
      const queuedN = res.queued.length;
      const skippedN = res.skipped.length;
      toast({
        title: t("portalAutomation.manualSubmit.queuedToast", { count: String(queuedN) }),
        description: skippedN > 0
          ? t("portalAutomation.manualSubmit.skippedNote", { count: String(skippedN) })
          : undefined,
      });
      onQueued();
      onOpenChange(false);
    } catch (err: unknown) {
      const code = err && typeof err === "object" && "error" in err
        ? (err as { error: string }).error
        : null;
      if (code === "RATE_LIMITED") {
        toast({ title: t("portalAutomation.manualSubmit.rateLimited"), variant: "destructive" });
      } else {
        toast({ title: t("portalAutomation.manualSubmit.submitError"), variant: "destructive" });
      }
    } finally {
      setSubmitting(false);
    }
  }, [selected, mode, t, toast, onQueued, onOpenChange]);

  const handleQueueClick = () => {
    if (selected.size === 0) return;
    if (mode === "real") {
      setConfirmOpen(true);
    } else {
      void doSubmit();
    }
  };

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>{t("portalAutomation.manualSubmit.title")}</DialogTitle>
            <DialogDescription>{t("portalAutomation.manualSubmit.description")}</DialogDescription>
          </DialogHeader>

          {/* Search */}
          <div className="relative">
            <Search className="absolute left-2.5 top-2.5 w-4 h-4 text-muted-foreground" />
            <Input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={t("portalAutomation.manualSubmit.searchPlaceholder")}
              className="pl-8 h-9"
            />
          </div>

          {/* Eligible application list */}
          <ScrollArea className="h-64 rounded-md border">
            {loading ? (
              <div className="flex items-center justify-center py-12">
                <Loader2 className="w-5 h-5 animate-spin text-muted-foreground" />
              </div>
            ) : apps.length === 0 ? (
              <div className="text-center py-12 text-sm text-muted-foreground">
                {t("portalAutomation.manualSubmit.noResults")}
              </div>
            ) : (
              <ul className="divide-y">
                {apps.map((app) => (
                  <li key={app.id}>
                    <label className="flex items-start gap-3 px-3 py-2.5 cursor-pointer hover:bg-muted/50">
                      <Checkbox
                        checked={selected.has(app.id)}
                        onCheckedChange={() => toggle(app.id)}
                        className="mt-0.5"
                      />
                      <div className="min-w-0 flex-1">
                        <div className="text-sm font-medium truncate">
                          {app.studentFirstName} {app.studentLastName}
                          <span className="text-muted-foreground font-normal"> · #{app.id}</span>
                        </div>
                        <div className="text-xs text-muted-foreground truncate">
                          {app.portalUniversityName} · {app.stage}
                        </div>
                      </div>
                    </label>
                  </li>
                ))}
              </ul>
            )}
          </ScrollArea>

          {/* Mode selector */}
          <div className="flex items-center gap-2">
            <Button
              type="button"
              variant={mode === "dry" ? "default" : "outline"}
              size="sm"
              className="h-9 gap-1.5 flex-1"
              onClick={() => setMode("dry")}
            >
              <FlaskConical className="w-3.5 h-3.5" />
              {t("portalAutomation.manualSubmit.modeDry")}
            </Button>
            <Button
              type="button"
              variant={mode === "real" ? "default" : "outline"}
              size="sm"
              className="h-9 gap-1.5 flex-1"
              onClick={() => setMode("real")}
            >
              <Send className="w-3.5 h-3.5" />
              {t("portalAutomation.manualSubmit.modeLive")}
            </Button>
          </div>

          <DialogFooter className="flex items-center justify-between sm:justify-between gap-2">
            <Badge variant="secondary">
              {t("portalAutomation.manualSubmit.selectedCount", { count: String(selected.size) })}
            </Badge>
            <Button onClick={handleQueueClick} disabled={selected.size === 0 || submitting} className="gap-1.5">
              {submitting ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />}
              {t("portalAutomation.manualSubmit.queueButton")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Live confirmation */}
      <AlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("portalAutomation.manualSubmit.confirmTitle")}</AlertDialogTitle>
            <AlertDialogDescription>
              {t("portalAutomation.manualSubmit.confirmBody", { count: String(selected.size) })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("portalAutomation.manualSubmit.confirmCancel")}</AlertDialogCancel>
            <AlertDialogAction onClick={() => { setConfirmOpen(false); void doSubmit(); }}>
              {t("portalAutomation.manualSubmit.confirmAccept")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
