/**
 * PortalAdaptersTab.tsx — SUB-STEP F + H (Declarative Builder)
 *
 * Section 1: Registry adapters (read-only) — GET /api/portal-adapters → registry
 * Section 2: DB-stored declarative adapters (CRUD) — GET/POST/PATCH/DELETE /api/portal-adapters
 *            Edit dialog includes configJson textarea = Declarative Builder (SUB-STEP H)
 */

import { useState, useEffect, useCallback, useMemo, useRef, type ChangeEvent } from "react";
import { customFetch } from "@workspace/api-client-react";
import { ADMIN_ROLES } from "@workspace/roles";
import { useI18n } from "@/hooks/use-i18n";
import { PortalSortControl, type PortalSortDir } from "@/components/admin/PortalSortControl";
import { useToast } from "@/hooks/use-toast";
import { useAuth } from "@/hooks/use-auth";
import {
  Card, CardContent, CardHeader, CardTitle, CardDescription,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from "@/components/ui/dialog";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel,
  AlertDialogContent, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import {
  Tooltip, TooltipContent, TooltipProvider, TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  Plus, Edit2, Trash2, CheckCircle2, XCircle, Loader2,
  Code2, Braces, KeySquare, Upload, FlaskConical,
} from "lucide-react";
import {
  PortalEmptyState, PortalErrorState,
} from "@/components/admin/PortalTabStates";
import AdapterSpecsSection from "./AdapterSpecsSection";
import { cn } from "@/lib/utils";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface RegistryAdapter {
  key: string;
  label: string;
  kind: "code" | "declarative";
  /** Dynamic: static experimental family AND not yet graduated. */
  experimental?: boolean;
  /** Static family flag (true even after graduation). */
  staticExperimental?: boolean;
  successCount?: number | null;
  graduationThreshold?: number | null;
  graduated?: boolean | null;
  hasCredentials: boolean;
}

interface DbAdapter {
  id: number;
  key: string;
  label: string;
  baseUrl: string;
  matchNames: string;
  kind: "code" | "declarative";
  configJson: Record<string, unknown> | null;
  isActive: boolean;
  createdAt: string;
}

interface AdaptersResponse {
  registry: RegistryAdapter[];
  db: DbAdapter[];
}

// ---------------------------------------------------------------------------
// AdapterFormDialog (Create + Edit)
// ---------------------------------------------------------------------------

interface FormDialogProps {
  open: boolean;
  editing: DbAdapter | null;
  onClose: () => void;
  onSaved: (adapter: DbAdapter) => void;
}

const EMPTY_FORM = {
  key: "", label: "", baseUrl: "", matchNames: "",
  kind: "declarative" as "code" | "declarative",
  configJson: "", isActive: true,
};

function AdapterFormDialog({ open, editing, onClose, onSaved }: FormDialogProps) {
  const { t } = useI18n();
  const { toast } = useToast();
  const [form, setForm] = useState({ ...EMPTY_FORM });
  const [saving, setSaving] = useState(false);
  const [jsonError, setJsonError] = useState("");

  useEffect(() => {
    if (open) {
      if (editing) {
        setForm({
          key: editing.key,
          label: editing.label,
          baseUrl: editing.baseUrl,
          matchNames: editing.matchNames,
          kind: editing.kind,
          configJson: editing.configJson
            ? JSON.stringify(editing.configJson, null, 2)
            : "",
          isActive: editing.isActive,
        });
      } else {
        setForm({ ...EMPTY_FORM });
      }
      setJsonError("");
    }
  }, [open, editing]);

  const set = (field: keyof typeof EMPTY_FORM, val: unknown) =>
    setForm((prev) => ({ ...prev, [field]: val }));

  const validateJson = (raw: string): Record<string, unknown> | null => {
    if (!raw.trim()) return null;
    try {
      return JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return undefined as unknown as null;
    }
  };

  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleJsonFileUpload = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    // Reset so re-selecting the same file fires onChange again.
    e.target.value = "";
    if (!file) return;
    try {
      const text = await file.text();
      JSON.parse(text); // validate; throws on malformed JSON
      set("configJson", text);
      setJsonError("");
    } catch {
      // Leave the existing textarea content untouched on invalid files.
      setJsonError(t("portalAutomation.adapters.addDialog.invalidJson"));
      toast({
        title: t("portalAutomation.adapters.addDialog.invalidJson"),
        variant: "destructive",
      });
    }
  };

  const submit = async () => {
    let configJson: Record<string, unknown> | null = null;
    if (form.configJson.trim()) {
      const parsed = validateJson(form.configJson);
      if (parsed === undefined) {
        setJsonError(t("portalAutomation.adapters.addDialog.invalidJson"));
        return;
      }
      configJson = parsed;
    }
    setJsonError("");
    setSaving(true);
    try {
      const payload: Record<string, unknown> = {
        label: form.label.trim(),
        baseUrl: form.baseUrl.trim(),
        matchNames: form.matchNames.trim(),
        kind: form.kind,
        configJson,
        isActive: form.isActive,
      };
      let saved: DbAdapter;
      if (editing) {
        saved = await customFetch<DbAdapter>(`/api/portal-adapters/${editing.id}`, {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(payload),
        });
        toast({ title: t("portalAutomation.adapters.editDialog.saveSuccess") });
      } else {
        saved = await customFetch<DbAdapter>("/api/portal-adapters", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ ...payload, key: form.key.trim() }),
        });
        toast({ title: t("portalAutomation.adapters.addDialog.saveSuccess") });
      }
      onSaved(saved);
      onClose();
    } catch (err: unknown) {
      const body = (err as any)?.body;
      if (body?.error === "DUPLICATE_KEY") {
        toast({ title: t("portalAutomation.adapters.addDialog.duplicateKey"), variant: "destructive" });
      } else {
        const errKey = editing
          ? "portalAutomation.adapters.editDialog.saveError"
          : "portalAutomation.adapters.addDialog.saveError";
        toast({ title: t(errKey), variant: "destructive" });
      }
    } finally {
      setSaving(false);
    }
  };

  const isNew = !editing;
  const canSubmit = form.label.trim() && form.baseUrl.trim() && form.matchNames.trim()
    && (!isNew || form.key.trim()) && !saving;

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>
            {isNew
              ? t("portalAutomation.adapters.addDialog.title")
              : t("portalAutomation.adapters.editDialog.title")}
          </DialogTitle>
        </DialogHeader>

        <div className="space-y-4 py-1">
          {/* Key (create only) */}
          {isNew && (
            <div className="space-y-1.5">
              <Label htmlFor="adp-key">{t("portalAutomation.adapters.addDialog.keyLabel")}</Label>
              <Input
                id="adp-key"
                value={form.key}
                onChange={(e) => set("key", e.target.value)}
                placeholder="my_portal"
                className="font-mono text-sm"
                autoFocus
              />
              <p className="text-xs text-muted-foreground">
                {t("portalAutomation.adapters.addDialog.keyHint")}
              </p>
            </div>
          )}

          {/* Label */}
          <div className="space-y-1.5">
            <Label htmlFor="adp-label">{t("portalAutomation.adapters.addDialog.labelLabel")}</Label>
            <Input
              id="adp-label"
              value={form.label}
              onChange={(e) => set("label", e.target.value)}
              placeholder="My University Portal"
              autoFocus={!isNew}
            />
          </div>

          {/* Base URL */}
          <div className="space-y-1.5">
            <Label htmlFor="adp-url">{t("portalAutomation.adapters.addDialog.baseUrlLabel")}</Label>
            <Input
              id="adp-url"
              value={form.baseUrl}
              onChange={(e) => set("baseUrl", e.target.value)}
              placeholder={t("portalAutomation.adapters.addDialog.baseUrlPlaceholder")}
            />
          </div>

          {/* Match names */}
          <div className="space-y-1.5">
            <Label htmlFor="adp-match">{t("portalAutomation.adapters.addDialog.matchNamesLabel")}</Label>
            <Input
              id="adp-match"
              value={form.matchNames}
              onChange={(e) => set("matchNames", e.target.value)}
              placeholder="my university, myuni"
            />
            <p className="text-xs text-muted-foreground">
              {t("portalAutomation.adapters.addDialog.matchNamesHint")}
            </p>
          </div>

          {/* Kind */}
          <div className="space-y-1.5">
            <Label>{t("portalAutomation.adapters.kindDeclarative") + " / " + t("portalAutomation.adapters.kindCode")}</Label>
            <Select value={form.kind} onValueChange={(v) => set("kind", v)}>
              <SelectTrigger className="w-44">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="declarative">
                  {t("portalAutomation.adapters.kindDeclarative")}
                </SelectItem>
                <SelectItem value="code">
                  {t("portalAutomation.adapters.kindCode")}
                </SelectItem>
              </SelectContent>
            </Select>
          </div>

          {/* Config JSON (Declarative Builder) */}
          <div className="space-y-1.5">
            <div className="flex items-center justify-between gap-2">
              <Label htmlFor="adp-json">{t("portalAutomation.adapters.addDialog.configJsonLabel")}</Label>
              {form.kind === "declarative" && (
                <>
                  <input
                    ref={fileInputRef}
                    type="file"
                    accept=".json,application/json"
                    className="hidden"
                    onChange={handleJsonFileUpload}
                  />
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className="h-7 gap-1.5 px-2 text-xs"
                    onClick={() => fileInputRef.current?.click()}
                    aria-label="Upload JSON file"
                  >
                    <Upload className="h-3.5 w-3.5" />
                  </Button>
                </>
              )}
            </div>
            <Textarea
              id="adp-json"
              value={form.configJson}
              onChange={(e) => { set("configJson", e.target.value); setJsonError(""); }}
              placeholder={t("portalAutomation.adapters.addDialog.configJsonPlaceholder")}
              className="font-mono text-xs min-h-[180px] resize-y"
              spellCheck={false}
            />
            <p className="text-xs text-muted-foreground">
              {t("portalAutomation.adapters.addDialog.configJsonHint")}
            </p>
            {jsonError && (
              <p className="text-xs text-destructive">{jsonError}</p>
            )}
          </div>

          {/* isActive */}
          <div className="flex items-center gap-3">
            <Switch
              id="adp-active"
              checked={form.isActive}
              onCheckedChange={(v) => set("isActive", v)}
            />
            <Label htmlFor="adp-active">{t("portalAutomation.adapters.isActiveLabel")}</Label>
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={saving}>
            {t("common.cancel")}
          </Button>
          <Button onClick={submit} disabled={!canSubmit}>
            {saving && <Loader2 className="w-4 h-4 mr-2 animate-spin" />}
            {saving
              ? (isNew ? t("portalAutomation.adapters.addDialog.saving") : t("portalAutomation.adapters.editDialog.saving"))
              : (isNew ? t("portalAutomation.adapters.addDialog.saveButton") : t("portalAutomation.adapters.editDialog.saveButton"))}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

type RegistrySortField = "label" | "key";
type DbSortField = "label" | "key" | "createdAt";
type SortDir = PortalSortDir;

export default function PortalAdaptersTab() {
  const { t } = useI18n();
  const { toast } = useToast();
  const { user } = useAuth();
  const isAdmin = !!user && (ADMIN_ROLES as readonly string[]).includes(user.role);

  const [registry, setRegistry] = useState<RegistryAdapter[]>([]);
  const [dbAdapters, setDbAdapters] = useState<DbAdapter[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);

  const [registrySortField, setRegistrySortField] = useState<RegistrySortField>("label");
  const [registrySortDir, setRegistrySortDir] = useState<SortDir>("asc");
  const [dbSortField, setDbSortField] = useState<DbSortField>("createdAt");
  const [dbSortDir, setDbSortDir] = useState<SortDir>("desc");

  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<DbAdapter | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<DbAdapter | null>(null);
  const [deleting, setDeleting] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(false);
    try {
      const res = await customFetch<AdaptersResponse>("/api/portal-adapters");
      setRegistry(res.registry ?? []);
      setDbAdapters(res.db ?? []);
    } catch {
      setLoadError(true);
      toast({ title: t("portalAutomation.adapters.loadError"), variant: "destructive" });
    } finally {
      setLoading(false);
    }
  }, [t, toast]);

  useEffect(() => { load(); }, [load]);

  const sortedRegistry = useMemo(() => {
    const dir = registrySortDir === "asc" ? 1 : -1;
    return [...registry].sort(
      (a, b) => dir * a[registrySortField].localeCompare(b[registrySortField]),
    );
  }, [registry, registrySortField, registrySortDir]);

  const sortedDbAdapters = useMemo(() => {
    const dir = dbSortDir === "asc" ? 1 : -1;
    return [...dbAdapters].sort((a, b) => {
      if (dbSortField === "createdAt") {
        return dir * (new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
      }
      return dir * a[dbSortField].localeCompare(b[dbSortField]);
    });
  }, [dbAdapters, dbSortField, dbSortDir]);

  const handleSaved = (adapter: DbAdapter) => {
    setDbAdapters((prev) => {
      const idx = prev.findIndex((a) => a.id === adapter.id);
      if (idx >= 0) {
        const next = [...prev];
        next[idx] = adapter;
        return next;
      }
      return [adapter, ...prev];
    });
  };

  const handleDelete = async () => {
    if (!deleteTarget) return;
    setDeleting(true);
    try {
      await customFetch(`/api/portal-adapters/${deleteTarget.id}`, { method: "DELETE" });
      setDbAdapters((prev) => prev.filter((a) => a.id !== deleteTarget.id));
      toast({ title: t("portalAutomation.adapters.deleteSuccess") });
    } catch {
      toast({ title: t("portalAutomation.adapters.deleteError"), variant: "destructive" });
    } finally {
      setDeleting(false);
      setDeleteTarget(null);
    }
  };

  const kindBadge = (kind: "code" | "declarative") => (
    <Badge
      variant={kind === "code" ? "default" : "secondary"}
      className="gap-1 text-[11px] py-0 h-4"
    >
      {kind === "code"
        ? <Code2 className="w-2.5 h-2.5" />
        : <Braces className="w-2.5 h-2.5" />}
      {kind === "code"
        ? t("portalAutomation.adapters.kindCode")
        : t("portalAutomation.adapters.kindDeclarative")}
    </Badge>
  );

  const credBadge = (ok: boolean) => ok ? (
    <Badge className="gap-1 bg-emerald-100 text-emerald-700 border-emerald-200 dark:bg-emerald-900/30 dark:text-emerald-400 text-[11px] py-0 h-4">
      <CheckCircle2 className="w-2.5 h-2.5" />
      {t("portalAutomation.adapters.credentialsOk")}
    </Badge>
  ) : (
    <Badge className="gap-1 bg-red-100 text-red-700 border-red-200 dark:bg-red-900/30 dark:text-red-400 text-[11px] py-0 h-4">
      <XCircle className="w-2.5 h-2.5" />
      {t("portalAutomation.adapters.credentialsMissing")}
    </Badge>
  );

  if (loadError) {
    return (
      <div className="py-6">
        <PortalErrorState onRetry={load} retrying={loading} />
      </div>
    );
  }

  return (
    <div className="space-y-6 py-2">
      {/* === Registry (read-only) === */}
      <Card className="rounded-xl">
        <CardHeader className="pb-3">
          <div className="flex items-start justify-between gap-3 flex-wrap">
            <div>
              <CardTitle className="text-base">{t("portalAutomation.adapters.registrySection")}</CardTitle>
              <CardDescription className="mt-1">{t("portalAutomation.adapters.registryDescription")}</CardDescription>
            </div>
            {registry.length > 1 && (
              <PortalSortControl<RegistrySortField>
                field={registrySortField}
                dir={registrySortDir}
                onFieldChange={setRegistrySortField}
                onToggleDir={() => setRegistrySortDir((d) => d === "asc" ? "desc" : "asc")}
                options={[
                  { value: "label", label: t("portalAutomation.adapters.sortByLabel") },
                  { value: "key", label: t("portalAutomation.adapters.sortByKey") },
                ]}
              />
            )}
          </div>
        </CardHeader>
        <CardContent>
          {loading ? (
            <div className="space-y-2">
              {[...Array(4)].map((_, i) => <Skeleton key={i} className="h-10 w-full rounded-lg" />)}
            </div>
          ) : registry.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t("portalAutomation.adapters.noDbAdapters")}</p>
          ) : (
            <div className="divide-y divide-border rounded-lg border overflow-hidden">
              {sortedRegistry.map((a) => (
                <div key={a.key} className="flex items-center gap-3 px-4 py-3 bg-card flex-wrap">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="font-medium text-sm">{a.label}</span>
                      {kindBadge(a.kind)}
                      {a.experimental && (
                        <Badge className="gap-1 bg-amber-100 text-amber-700 border-amber-200 dark:bg-amber-900/30 dark:text-amber-400 text-[11px] py-0 h-4">
                          <FlaskConical className="w-2.5 h-2.5" />
                          {t("portalAutomation.adapters.experimental")}
                        </Badge>
                      )}
                      {a.staticExperimental && a.graduated && (
                        <Badge className="gap-1 bg-emerald-100 text-emerald-700 border-emerald-200 dark:bg-emerald-900/30 dark:text-emerald-400 text-[11px] py-0 h-4">
                          {t("portalAutomation.adapters.graduated")}
                        </Badge>
                      )}
                      {a.experimental && a.graduationThreshold != null && (
                        <span className="text-[11px] text-muted-foreground">
                          {t("portalAutomation.adapters.graduationProgress", {
                            count: a.successCount ?? 0,
                            threshold: a.graduationThreshold,
                          })}
                        </span>
                      )}
                      {credBadge(a.hasCredentials)}
                    </div>
                    <code className="text-[11px] text-muted-foreground">{a.key}</code>
                  </div>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {/* === DB Adapters (CRUD) === */}
      <Card className="rounded-xl">
        <CardHeader className="pb-3">
          <div className="flex items-start justify-between gap-3 flex-wrap">
            <div>
              <CardTitle className="text-base">{t("portalAutomation.adapters.dbSection")}</CardTitle>
              <CardDescription className="mt-1">{t("portalAutomation.adapters.dbDescription")}</CardDescription>
            </div>
            <div className="flex items-center gap-2 flex-wrap">
              {dbAdapters.length > 1 && (
                <PortalSortControl<DbSortField>
                  field={dbSortField}
                  dir={dbSortDir}
                  onFieldChange={setDbSortField}
                  onToggleDir={() => setDbSortDir((d) => d === "asc" ? "desc" : "asc")}
                  options={[
                    { value: "createdAt", label: t("portalAutomation.adapters.sortByCreatedAt") },
                    { value: "label", label: t("portalAutomation.adapters.sortByLabel") },
                    { value: "key", label: t("portalAutomation.adapters.sortByKey") },
                  ]}
                />
              )}
              <Button
                size="sm"
                className="gap-1.5 shrink-0"
                onClick={() => { setEditing(null); setFormOpen(true); }}
              >
                <Plus className="w-3.5 h-3.5" />
                {t("portalAutomation.adapters.addButton")}
              </Button>
            </div>
          </div>
        </CardHeader>
        <CardContent>
          {loading ? (
            <div className="space-y-2">
              {[...Array(2)].map((_, i) => <Skeleton key={i} className="h-14 w-full rounded-lg" />)}
            </div>
          ) : dbAdapters.length === 0 ? (
            <PortalEmptyState
              icon={Braces}
              title={t("portalAutomation.adapters.emptyTitle")}
              description={t("portalAutomation.adapters.noDbAdapters")}
              action={
                <Button
                  size="sm"
                  className="gap-1.5"
                  onClick={() => { setEditing(null); setFormOpen(true); }}
                >
                  <Plus className="w-3.5 h-3.5" />
                  {t("portalAutomation.adapters.addButton")}
                </Button>
              }
            />
          ) : (
            <div className="divide-y divide-border rounded-lg border overflow-hidden">
              {sortedDbAdapters.map((a) => (
                <div key={a.id} className="flex items-center gap-3 px-4 py-3 bg-card flex-wrap">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="font-medium text-sm">{a.label}</span>
                      {kindBadge(a.kind)}
                      {!a.isActive && (
                        <Badge variant="outline" className="text-[11px] py-0 h-4 text-muted-foreground">
                          {t("portalAutomation.adapters.inactiveBadge")}
                        </Badge>
                      )}
                    </div>
                    <div className="flex items-center gap-2 mt-0.5">
                      <code className="text-[11px] text-muted-foreground">{a.key}</code>
                      <span className="text-[11px] text-muted-foreground">·</span>
                      <span className="text-[11px] text-muted-foreground truncate max-w-[200px]">
                        {a.baseUrl}
                      </span>
                      {a.configJson && (
                        <>
                          <span className="text-[11px] text-muted-foreground">·</span>
                          <TooltipProvider>
                            <Tooltip>
                              <TooltipTrigger>
                                <Braces className="w-3 h-3 text-muted-foreground" />
                              </TooltipTrigger>
                              <TooltipContent>
                                <pre className="text-[11px] max-w-xs overflow-auto">
                                  {JSON.stringify(a.configJson, null, 2)}
                                </pre>
                              </TooltipContent>
                            </Tooltip>
                          </TooltipProvider>
                        </>
                      )}
                    </div>
                  </div>
                  <div className="flex items-center gap-1">
                    <Button
                      variant="ghost" size="icon" className="w-8 h-8"
                      onClick={() => { setEditing(a); setFormOpen(true); }}
                      aria-label="Edit"
                    >
                      <Edit2 className="w-3.5 h-3.5" />
                    </Button>
                    <Button
                      variant="ghost" size="icon"
                      className="w-8 h-8 text-destructive hover:text-destructive"
                      onClick={() => setDeleteTarget(a)}
                      aria-label="Delete"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {/* === Declarative adapter SPECs (opt-in versioned engine) === */}
      {/* Admin-only: backend GET /adapter-specs is ADMIN_ROLES-gated while this
          tab is reachable by broader STAFF_ROLES; rendering it unconditionally
          caused a 403 → "Failed to load adapter specs" toast for staff users. */}
      {isAdmin && <AdapterSpecsSection />}

      {/* Form dialog */}
      <AdapterFormDialog
        open={formOpen}
        editing={editing}
        onClose={() => { setFormOpen(false); setEditing(null); }}
        onSaved={handleSaved}
      />

      {/* Delete confirm */}
      <AlertDialog open={!!deleteTarget} onOpenChange={(o) => { if (!o) setDeleteTarget(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t("portalAutomation.adapters.deleteConfirm")}
              {deleteTarget && (
                <span className="font-normal text-muted-foreground ml-2">
                  ({deleteTarget.label})
                </span>
              )}
            </AlertDialogTitle>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleting}>{t("common.cancel")}</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleDelete}
              disabled={deleting}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {deleting && <Loader2 className="w-4 h-4 mr-2 animate-spin" />}
              {t("common.delete")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
