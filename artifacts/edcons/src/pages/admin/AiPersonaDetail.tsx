import { useEffect, useState } from "react";
import { useLocation, useRoute } from "wouter";
import { customFetch } from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useToast } from "@/hooks/use-toast";
import { useI18n } from "@/hooks/use-i18n";
import { Play, Save, ArrowLeft } from "lucide-react";

type ScopeDef = { key: string; label: string; description: string };
type ToolDef = { key: string; label: string; description: string; sideEffect: boolean };

type PersonaForm = {
  name: string;
  slug: string;
  personaType: "advisor" | "operator";
  description: string;
  avatarUrl: string;
  provider: "anthropic" | "openai";
  model: string;
  systemPrompt: string;
  guidelines: string;
  negativePrompt: string;
  temperature: number;
  maxTokens: number;
  allowedDataScopes: string[];
  toolsEnabled: string[];
  triggerMode: "manual" | "scheduled" | "event_driven";
  scheduleCron: string;
  eventSubscriptions: string[];
  outputTargets: string[];
  monthlyCostCapUsd: string;
  isActive: boolean;
};

const empty: PersonaForm = {
  name: "",
  slug: "",
  personaType: "advisor",
  description: "",
  avatarUrl: "",
  provider: "anthropic",
  model: "claude-sonnet-4-5",
  systemPrompt: "",
  guidelines: "",
  negativePrompt: "",
  temperature: 0.7,
  maxTokens: 2048,
  allowedDataScopes: [],
  toolsEnabled: [],
  triggerMode: "manual",
  scheduleCron: "",
  eventSubscriptions: [],
  outputTargets: [],
  monthlyCostCapUsd: "",
  isActive: false,
};

const OUTPUT_TARGETS = [
  "notification",
  "report",
  "blog_draft",
  "internal_msg",
  "portal_diagnosis",
  "approval_queue",
];
const EVENT_SUBSCRIPTIONS = [
  {
    key: "portal_submission.failed",
    labelKey: "aiPersona.eventPortalSubmissionFailed",
  },
];

export default function AiPersonaDetail() {
  const { t } = useI18n();
  const [, paramsNew] = useRoute("/admin/ai-personas/new");
  const [matchEdit, paramsEdit] = useRoute("/admin/ai-personas/:id");
  const [, setLocation] = useLocation();
  const id = matchEdit && paramsEdit?.id !== "new" ? Number(paramsEdit?.id) : null;
  const { toast } = useToast();

  const [form, setForm] = useState<PersonaForm>(empty);
  const [scopes, setScopes] = useState<ScopeDef[]>([]);
  const [tools, setTools] = useState<ToolDef[]>([]);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [running, setRunning] = useState(false);
  const [runs, setRuns] = useState<any[]>([]);
  const [runInput, setRunInput] = useState("");

  const update = <K extends keyof PersonaForm>(k: K, v: PersonaForm[K]) =>
    setForm((p) => ({ ...p, [k]: v }));

  const toggleArr = (arr: string[], v: string) =>
    arr.includes(v) ? arr.filter((x) => x !== v) : [...arr, v];

  useEffect(() => {
    (async () => {
      try {
        const [s, tl] = await Promise.all([
          customFetch<{ scopes: ScopeDef[] }>("/api/ai-personas/registry/scopes"),
          customFetch<{ tools: ToolDef[] }>("/api/ai-personas/registry/tools"),
        ]);
        setScopes(s.scopes);
        setTools(tl.tools);
      } catch (e) {
        toast({ title: t("aiPersona.toastRegistryError"), description: (e as Error).message, variant: "destructive" });
      }
    })();
  }, []);

  useEffect(() => {
    if (!id) return;
    (async () => {
      try {
        setLoading(true);
        const { persona } = await customFetch<{ persona: any }>(`/api/ai-personas/${id}`);
        setForm({
          name: persona.name ?? "",
          slug: persona.slug ?? "",
          personaType: persona.personaType,
          description: persona.description ?? "",
          avatarUrl: persona.avatarUrl ?? "",
          provider: persona.provider,
          model: persona.model ?? "",
          systemPrompt: persona.systemPrompt ?? "",
          guidelines: persona.guidelines ?? "",
          negativePrompt: persona.negativePrompt ?? "",
          temperature: Number(persona.temperature ?? 0.7),
          maxTokens: persona.maxTokens ?? 2048,
          allowedDataScopes: persona.allowedDataScopes ?? [],
          toolsEnabled: persona.toolsEnabled ?? [],
          triggerMode: persona.triggerMode ?? "manual",
          scheduleCron: persona.scheduleCron ?? "",
          eventSubscriptions: persona.eventSubscriptions ?? [],
          outputTargets: persona.outputTargets ?? [],
          monthlyCostCapUsd:
            persona.monthlyCostCapUsd == null ? "" : String(persona.monthlyCostCapUsd),
          isActive: !!persona.isActive,
        });
        await loadRuns();
      } catch (e) {
        toast({ title: t("aiPersona.toastLoadError"), description: (e as Error).message, variant: "destructive" });
      } finally {
        setLoading(false);
      }
    })();
  }, [id]);

  const loadRuns = async () => {
    if (!id) return;
    try {
      const data = await customFetch<{ runs: any[] }>(`/api/ai-personas/${id}/runs`);
      setRuns(data.runs);
    } catch {}
  };

  const save = async () => {
    setSaving(true);
    try {
      const payload = {
        ...form,
        monthlyCostCapUsd:
          form.monthlyCostCapUsd.trim() === "" ? null : Number(form.monthlyCostCapUsd),
      };
      if (id) {
        await customFetch(`/api/ai-personas/${id}`, {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(payload),
        });
        toast({ title: t("aiPersona.toastSaved") });
      } else {
        const { persona } = await customFetch<{ persona: any }>("/api/ai-personas", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(payload),
        });
        toast({ title: t("aiPersona.toastCreated") });
        setLocation(`/admin/ai-personas/${persona.id}`);
      }
    } catch (e) {
      toast({ title: t("aiPersona.toastSaveError"), description: (e as Error).message, variant: "destructive" });
    } finally {
      setSaving(false);
    }
  };

  const runNow = async () => {
    if (!id) {
      toast({ title: t("aiPersona.toastSaveFirst"), variant: "destructive" });
      return;
    }
    setRunning(true);
    try {
      const res = await customFetch<any>(`/api/ai-personas/${id}/run`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ input: runInput || undefined }),
      });
      toast({
        title: t("aiPersona.toastRunResult", { status: res.status }),
        description: res.error || t("aiPersona.toastRunResultDesc", { id: res.runId }),
      });
      await loadRuns();
    } catch (e) {
      toast({ title: t("aiPersona.toastRunError"), description: (e as Error).message, variant: "destructive" });
    } finally {
      setRunning(false);
    }
  };

  return (
    <div className="p-6 space-y-6 max-w-5xl">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <Button variant="ghost" size="sm" onClick={() => setLocation("/admin/ai-personas")}>
            <ArrowLeft className="h-4 w-4 mr-1" /> {t("aiPersona.back")}
          </Button>
          <h1 className="text-xl font-semibold">
            {id ? t("aiPersona.personaNum", { id }) : t("aiPersona.newPersona")}
          </h1>
          {form.personaType && (
            <Badge variant={form.personaType === "operator" ? "destructive" : "secondary"}>
              {form.personaType}
            </Badge>
          )}
        </div>
        <Button onClick={save} disabled={saving || loading}>
          <Save className="h-4 w-4 mr-2" /> {saving ? t("aiPersona.saving") : t("aiPersona.save")}
        </Button>
      </div>

      <Tabs defaultValue="general" className="w-full">
        <TabsList className="flex-wrap">
          <TabsTrigger value="general">{t("aiPersona.tabGeneral")}</TabsTrigger>
          <TabsTrigger value="prompt">{t("aiPersona.tabPrompt")}</TabsTrigger>
          <TabsTrigger value="model">{t("aiPersona.tabModel")}</TabsTrigger>
          <TabsTrigger value="abilities">{t("aiPersona.tabAbilities")}</TabsTrigger>
          <TabsTrigger value="trigger">{t("aiPersona.tabTrigger")}</TabsTrigger>
          <TabsTrigger value="output">{t("aiPersona.tabOutput")}</TabsTrigger>
          <TabsTrigger value="budget">{t("aiPersona.tabBudget")}</TabsTrigger>
          <TabsTrigger value="history" disabled={!id}>{t("aiPersona.tabHistory")}</TabsTrigger>
        </TabsList>

        <TabsContent value="general" className="space-y-4 mt-4">
          <Card>
            <CardContent className="space-y-4 pt-6">
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <Label>{t("aiPersona.fName")}</Label>
                  <Input value={form.name} onChange={(e) => update("name", e.target.value)} />
                </div>
                <div>
                  <Label>{t("aiPersona.fSlug")}</Label>
                  <Input value={form.slug} onChange={(e) => update("slug", e.target.value)} placeholder={t("aiPersona.fSlugPlaceholder")} />
                </div>
                <div>
                  <Label>{t("aiPersona.fType")}</Label>
                  <Select value={form.personaType} onValueChange={(v) => update("personaType", v as any)}>
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="advisor">{t("aiPersona.typeAdvisor")}</SelectItem>
                      <SelectItem value="operator">{t("aiPersona.typeOperator")}</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div>
                  <Label>{t("aiPersona.fAvatarUrl")}</Label>
                  <Input value={form.avatarUrl} onChange={(e) => update("avatarUrl", e.target.value)} />
                </div>
              </div>
              <div>
                <Label>{t("aiPersona.fDescription")}</Label>
                <Textarea value={form.description} onChange={(e) => update("description", e.target.value)} rows={2} />
              </div>
              <div className="flex items-center gap-3">
                <Switch checked={form.isActive} onCheckedChange={(v) => update("isActive", v)} />
                <Label className="!m-0">{t("aiPersona.fActive")}</Label>
              </div>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="prompt" className="space-y-4 mt-4">
          <Card>
            <CardHeader><CardTitle className="text-base">{t("aiPersona.systemPrompt")}</CardTitle></CardHeader>
            <CardContent>
              <Textarea rows={6} value={form.systemPrompt} onChange={(e) => update("systemPrompt", e.target.value)} placeholder={t("aiPersona.systemPromptPlaceholder")} />
            </CardContent>
          </Card>
          <Card>
            <CardHeader><CardTitle className="text-base">{t("aiPersona.guidelines")}</CardTitle></CardHeader>
            <CardContent>
              <Textarea rows={5} value={form.guidelines} onChange={(e) => update("guidelines", e.target.value)} placeholder={t("aiPersona.guidelinesPlaceholder")} />
            </CardContent>
          </Card>
          <Card>
            <CardHeader><CardTitle className="text-base">{t("aiPersona.negativePrompt")}</CardTitle></CardHeader>
            <CardContent>
              <Textarea rows={4} value={form.negativePrompt} onChange={(e) => update("negativePrompt", e.target.value)} placeholder={t("aiPersona.negativePromptPlaceholder")} />
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="model" className="space-y-4 mt-4">
          <Card>
            <CardContent className="grid grid-cols-2 gap-4 pt-6">
              <div>
                <Label>{t("aiPersona.provider")}</Label>
                <Select value={form.provider} onValueChange={(v) => update("provider", v as any)}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="anthropic">{t("aiPersona.providerAnthropic")}</SelectItem>
                    <SelectItem value="openai">{t("aiPersona.providerOpenai")}</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div>
                <Label>{t("aiPersona.model")}</Label>
                <Input value={form.model} onChange={(e) => update("model", e.target.value)} placeholder="claude-sonnet-4-5" />
              </div>
              <div>
                <Label>{t("aiPersona.temperature", { value: form.temperature })}</Label>
                <Input type="number" step="0.1" min={0} max={2} value={form.temperature} onChange={(e) => update("temperature", Number(e.target.value))} />
              </div>
              <div>
                <Label>{t("aiPersona.maxTokens")}</Label>
                <Input type="number" value={form.maxTokens} onChange={(e) => update("maxTokens", Number(e.target.value))} />
              </div>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="abilities" className="space-y-4 mt-4">
          <Card>
            <CardHeader><CardTitle className="text-base">{t("aiPersona.scopesTitle")}</CardTitle></CardHeader>
            <CardContent className="space-y-2">
              {scopes.length === 0 && <div className="text-sm text-muted-foreground">{t("aiPersona.scopesLoading")}</div>}
              {scopes.map((s) => (
                <label key={s.key} className="flex items-start gap-3 cursor-pointer border rounded p-2 hover:bg-muted/50">
                  <input
                    type="checkbox"
                    className="mt-1"
                    checked={form.allowedDataScopes.includes(s.key)}
                    onChange={() => update("allowedDataScopes", toggleArr(form.allowedDataScopes, s.key))}
                  />
                  <div>
                    <div className="font-medium text-sm">{s.label} <span className="text-muted-foreground">({s.key})</span></div>
                    <div className="text-xs text-muted-foreground">{s.description}</div>
                  </div>
                </label>
              ))}
            </CardContent>
          </Card>
          <Card>
            <CardHeader><CardTitle className="text-base">{t("aiPersona.toolsTitle")}</CardTitle></CardHeader>
            <CardContent className="space-y-2">
              {tools.map((tl) => {
                const disabled = form.personaType === "advisor" && tl.sideEffect;
                return (
                  <label key={tl.key} className={`flex items-start gap-3 cursor-pointer border rounded p-2 ${disabled ? "opacity-50" : "hover:bg-muted/50"}`}>
                    <input
                      type="checkbox"
                      className="mt-1"
                      disabled={disabled}
                      checked={form.toolsEnabled.includes(tl.key)}
                      onChange={() => update("toolsEnabled", toggleArr(form.toolsEnabled, tl.key))}
                    />
                    <div className="flex-1">
                      <div className="font-medium text-sm flex items-center gap-2">
                        {tl.label} <span className="text-muted-foreground">({tl.key})</span>
                        {tl.sideEffect && <Badge variant="destructive" className="text-[10px]">{t("aiPersona.sideEffectBadge")}</Badge>}
                      </div>
                      <div className="text-xs text-muted-foreground">{tl.description}</div>
                      {disabled && <div className="text-xs text-amber-600 mt-1">{t("aiPersona.toolAdvisorBlocked")}</div>}
                    </div>
                  </label>
                );
              })}
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="trigger" className="space-y-4 mt-4">
          <Card>
            <CardContent className="space-y-4 pt-6">
              <div>
                <Label>{t("aiPersona.triggerMode")}</Label>
                <Select value={form.triggerMode} onValueChange={(v) => update("triggerMode", v as any)}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="manual">{t("aiPersona.triggerManual")}</SelectItem>
                    <SelectItem value="scheduled">{t("aiPersona.triggerScheduled")}</SelectItem>
                    <SelectItem value="event_driven">{t("aiPersona.triggerEvent")}</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              {form.triggerMode === "scheduled" && (
                <div>
                  <Label>{t("aiPersona.cron")}</Label>
                  <Input value={form.scheduleCron} onChange={(e) => update("scheduleCron", e.target.value)} placeholder={t("aiPersona.cronPlaceholder")} />
                </div>
              )}
              {form.triggerMode === "event_driven" && (
                <div className="space-y-2">
                  <Label>{t("aiPersona.eventSubscriptions")}</Label>
                  {form.slug === "portal-automation-guardian" ? EVENT_SUBSCRIPTIONS.map((event) => (
                    <label
                      key={event.key}
                      className="flex items-start gap-3 cursor-pointer border rounded p-3 hover:bg-muted/50"
                    >
                      <input
                        type="checkbox"
                        className="mt-1"
                        checked={form.eventSubscriptions.includes(event.key)}
                        onChange={() =>
                          update(
                            "eventSubscriptions",
                            toggleArr(form.eventSubscriptions, event.key),
                          )
                        }
                      />
                      <div>
                        <div className="text-sm font-medium">{t(event.labelKey)}</div>
                        <code className="text-xs text-muted-foreground">{event.key}</code>
                      </div>
                    </label>
                  )) : (
                    <p className="text-sm text-muted-foreground">
                      {t("aiPersona.eventGuardianOnly")}
                    </p>
                  )}
                  {form.slug === "portal-automation-guardian" && (
                    <p className="text-xs text-muted-foreground">
                      {t("aiPersona.eventSafetyNote")}
                    </p>
                  )}
                </div>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="output" className="space-y-4 mt-4">
          <Card>
            <CardHeader><CardTitle className="text-base">{t("aiPersona.outputTargets")}</CardTitle></CardHeader>
            <CardContent className="space-y-2">
              {OUTPUT_TARGETS.map((o) => (
                <label key={o} className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={form.outputTargets.includes(o)}
                    onChange={() => update("outputTargets", toggleArr(form.outputTargets, o))}
                  />
                  <span className="text-sm">{o}</span>
                </label>
              ))}
              <div className="text-xs text-muted-foreground pt-2">
                {t("aiPersona.outputDispatchNote")}
              </div>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="budget" className="space-y-4 mt-4">
          <Card>
            <CardContent className="pt-6 space-y-2">
              <Label>{t("aiPersona.budgetCapLabel")}</Label>
              <Input
                value={form.monthlyCostCapUsd}
                onChange={(e) => update("monthlyCostCapUsd", e.target.value)}
                placeholder={t("aiPersona.budgetCapPlaceholder")}
              />
              <div className="text-xs text-muted-foreground">
                {t("aiPersona.budgetCapNote")}
              </div>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="history" className="space-y-4 mt-4">
          <Card>
            <CardHeader>
              <div className="flex items-center justify-between">
                <CardTitle className="text-base">{t("aiPersona.lastRuns")}</CardTitle>
                <div className="flex gap-2">
                  <Input
                    className="w-72"
                    placeholder={t("aiPersona.runInputPlaceholder")}
                    value={runInput}
                    onChange={(e) => setRunInput(e.target.value)}
                  />
                  <Button
                    onClick={runNow}
                    disabled={
                      running ||
                      !form.isActive ||
                      form.slug === "portal-automation-guardian"
                    }
                    title={
                      form.slug === "portal-automation-guardian"
                        ? t("aiPersona.portalGuardianRunNote")
                        : !form.isActive
                          ? t("aiPersona.activateFirst")
                          : ""
                    }
                  >
                    <Play className="h-4 w-4 mr-1" /> {running ? t("aiPersona.running") : t("aiPersona.runNow")}
                  </Button>
                </div>
              </div>
            </CardHeader>
            <CardContent className="space-y-2">
              {runs.length === 0 && <div className="text-sm text-muted-foreground">{t("aiPersona.noRuns")}</div>}
              {runs.map((r) => (
                <div key={r.id} className="border rounded p-3 text-sm space-y-1">
                  <div className="flex items-center gap-2">
                    <Badge variant={r.status === "success" ? "secondary" : "destructive"}>{r.status}</Badge>
                    <span className="text-xs text-muted-foreground">
                      #{r.id} · {new Date(r.createdAt).toLocaleString()} · {r.latencyMs ?? "—"}ms · tokens {r.promptTokens ?? 0}/{r.completionTokens ?? 0}
                      {r.costUsd && ` · $${r.costUsd}`}
                    </span>
                  </div>
                  {r.errorMessage && <div className="text-red-600 text-xs">{r.errorMessage}</div>}
                  {r.outputPayload?.output && (
                    <pre className="bg-muted p-2 rounded text-xs whitespace-pre-wrap max-h-48 overflow-auto">{r.outputPayload.output}</pre>
                  )}
                  {r.outputPayload?.warnings?.length > 0 && (
                    <div className="text-amber-600 text-xs">⚠ {r.outputPayload.warnings.join(", ")}</div>
                  )}
                </div>
              ))}
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  );
}
