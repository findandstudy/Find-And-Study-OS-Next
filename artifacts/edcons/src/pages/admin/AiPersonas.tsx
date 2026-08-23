import { useEffect, useMemo, useState } from "react";
import { useLocation } from "wouter";
import { customFetch } from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { useToast } from "@/hooks/use-toast";
import { useI18n } from "@/hooks/use-i18n";
import { Sparkles, Plus, Trash2, Settings as SettingsIcon } from "lucide-react";
import AiBuiltinDefaults, { type DefaultFieldDef } from "./AiBuiltinDefaults";

type Persona = {
  id: number;
  name: string;
  slug: string;
  personaType: "advisor" | "operator";
  description: string | null;
  provider: "anthropic" | "openai";
  model: string;
  isActive: boolean;
  allowedDataScopes: string[];
  toolsEnabled: string[];
  triggerMode: string;
  createdAt: string;
};

const PERSONA_DEFAULT_FIELDS: DefaultFieldDef[] = [
  {
    key: "persona.builtin.systemPrompt",
    label: "Default System Prompt",
    editType: "text",
    description: "Template pre-filled in the system prompt field when creating a new persona.",
  },
  {
    key: "persona.builtin.guidelines",
    label: "Default Guidelines",
    editType: "text",
    description: "Template pre-filled in the guidelines field when creating a new persona.",
  },
];

export default function AiPersonas() {
  const { t } = useI18n();
  const [, setLocation] = useLocation();
  const [personas, setPersonas] = useState<Persona[]>([]);
  const [loading, setLoading] = useState(true);
  const { toast } = useToast();

  const load = async () => {
    try {
      setLoading(true);
      const data = await customFetch<{ personas: Persona[] }>("/api/ai-personas");
      setPersonas(data.personas);
    } catch (e) {
      toast({ title: t("aiPersona.toastError"), description: (e as Error).message, variant: "destructive" });
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
  }, []);

  const toggleActive = async (p: Persona, isActive: boolean) => {
    try {
      await customFetch(`/api/ai-personas/${p.id}`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ isActive }),
      });
      setPersonas((prev) => prev.map((x) => (x.id === p.id ? { ...x, isActive } : x)));
      toast({ title: isActive ? t("aiPersona.toastActivated") : t("aiPersona.toastDeactivated") });
    } catch (e) {
      toast({ title: t("aiPersona.toastError"), description: (e as Error).message, variant: "destructive" });
    }
  };

  const remove = async (p: Persona) => {
    if (!confirm(t("aiPersona.confirmDelete", { name: p.name }))) return;
    try {
      await customFetch(`/api/ai-personas/${p.id}`, { method: "DELETE" });
      setPersonas((prev) => prev.filter((x) => x.id !== p.id));
      toast({ title: t("aiPersona.toastDeleted") });
    } catch (e) {
      toast({ title: t("aiPersona.toastError"), description: (e as Error).message, variant: "destructive" });
    }
  };

  const empty = useMemo(() => !loading && personas.length === 0, [loading, personas.length]);

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold flex items-center gap-2">
            <Sparkles className="h-6 w-6 text-indigo-500" /> {t("aiPersona.title")}
          </h1>
          <p className="text-sm text-muted-foreground mt-1">
            {t("aiPersona.subtitle")}
          </p>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" onClick={() => setLocation("/admin/ai-action-queue")}>
            {t("aiPersona.approvalQueue")}
          </Button>
          <Button onClick={() => setLocation("/admin/ai-personas/new")}>
            <Plus className="h-4 w-4 mr-2" /> {t("aiPersona.newPersona")}
          </Button>
        </div>
      </div>

      {loading && <div className="text-sm text-muted-foreground">{t("aiPersona.loading")}</div>}

      {empty && (
        <Card>
          <CardContent className="py-12 text-center text-muted-foreground">
            {t("aiPersona.empty")}
          </CardContent>
        </Card>
      )}

      <AiBuiltinDefaults
        fields={PERSONA_DEFAULT_FIELDS}
        title={t("aiDefault.personaTitle")}
        subtitle={t("aiDefault.sectionSubtitle")}
      />

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        {personas.map((p) => (
          <Card key={p.id} className="hover:shadow-md transition-shadow">
            <CardHeader className="pb-2">
              <div className="flex items-start justify-between">
                <CardTitle className="text-base">{p.name}</CardTitle>
                <Badge variant={p.personaType === "operator" ? "destructive" : "secondary"}>
                  {p.personaType}
                </Badge>
              </div>
              <div className="text-xs text-muted-foreground">{p.slug} · {p.provider}/{p.model}</div>
            </CardHeader>
            <CardContent className="space-y-3">
              {p.description && <div className="text-sm">{p.description}</div>}
              <div className="flex flex-wrap gap-1">
                {(p.allowedDataScopes || []).map((s) => (
                  <Badge key={s} variant="outline" className="text-xs">scope:{s}</Badge>
                ))}
                {(p.toolsEnabled || []).map((tl) => (
                  <Badge key={tl} variant="outline" className="text-xs">tool:{tl}</Badge>
                ))}
              </div>
              <div className="flex items-center justify-between pt-2 border-t">
                <div className="flex items-center gap-2 text-sm">
                  <Switch checked={p.isActive} onCheckedChange={(v) => toggleActive(p, v)} />
                  <span className={p.isActive ? "text-emerald-600" : "text-muted-foreground"}>
                    {p.isActive ? t("aiPersona.active") : t("aiPersona.inactive")}
                  </span>
                </div>
                <div className="flex gap-1">
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => setLocation(`/admin/ai-personas/${p.id}`)}
                  >
                    <SettingsIcon className="h-4 w-4" />
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => remove(p)}>
                    <Trash2 className="h-4 w-4 text-red-500" />
                  </Button>
                </div>
              </div>
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  );
}
