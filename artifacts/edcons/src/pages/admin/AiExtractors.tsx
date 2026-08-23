import { useEffect, useState } from "react";
import { useLocation } from "wouter";
import { customFetch } from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { useToast } from "@/hooks/use-toast";
import { useI18n } from "@/hooks/use-i18n";
import { FileSearch, Plus, Trash2, Star } from "lucide-react";
import AiBuiltinDefaults, { type DefaultFieldDef } from "./AiBuiltinDefaults";

type Extractor = {
  id: number;
  name: string;
  slug: string;
  description: string | null;
  provider: string;
  model: string;
  isActive: boolean;
  isDefault: boolean;
  scopes: string[];
  fields: any[];
  usage?: { runs: number; lastRunAt: string | null };
  updatedAt: string;
};

const EXTRACTOR_DEFAULT_FIELDS: DefaultFieldDef[] = [
  {
    key: "extractor.builtin.systemPrompt",
    label: "System Prompt",
    editType: "text",
    description: "Role / tone intro sent before the field schema. Leave empty to use the auto-generated intro.",
  },
  {
    key: "extractor.builtin.rules",
    label: "Extraction Rules",
    editType: "lines",
    description: "One rule per line. These are appended as a bullet list after the field schema.",
  },
  {
    key: "extractor.builtin.fields",
    label: "Extracted Fields (JSON)",
    editType: "json",
    description: "JSON array of field definitions used when no custom extractor covers a scope.",
  },
];

export default function AiExtractors() {
  const { t } = useI18n();
  const [, setLocation] = useLocation();
  const [items, setItems] = useState<Extractor[]>([]);
  const [loading, setLoading] = useState(true);
  const { toast } = useToast();

  const load = async () => {
    try {
      setLoading(true);
      const data = await customFetch<{ extractors: Extractor[] }>("/api/ai-extractors");
      setItems(data.extractors);
    } catch (e) {
      toast({ title: t("aiExtractor.toastError"), description: (e as Error).message, variant: "destructive" });
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
  }, []);

  const toggleActive = async (e: Extractor, isActive: boolean) => {
    try {
      await customFetch(`/api/ai-extractors/${e.id}`, {
        method: "PUT",
        body: JSON.stringify({ isActive }),
      });
      toast({ title: isActive ? t("aiExtractor.toastActivated") : t("aiExtractor.toastDeactivated") });
      load();
    } catch (err) {
      toast({ title: t("aiExtractor.toastError"), description: (err as Error).message, variant: "destructive" });
    }
  };

  const remove = async (e: Extractor) => {
    if (!confirm(t("aiExtractor.confirmDelete", { name: e.name }))) return;
    try {
      await customFetch(`/api/ai-extractors/${e.id}`, { method: "DELETE" });
      toast({ title: t("aiExtractor.toastDeleted") });
      load();
    } catch (err) {
      toast({ title: t("aiExtractor.toastError"), description: (err as Error).message, variant: "destructive" });
    }
  };

  return (
    <div className="p-6 space-y-6 max-w-6xl">
      <div className="flex items-start justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-semibold flex items-center gap-2">
            <FileSearch className="h-6 w-6 text-indigo-500" /> {t("aiExtractor.title")}
          </h1>
          <p className="text-sm text-muted-foreground mt-1 max-w-2xl">
            {t("aiExtractor.subtitle")}
          </p>
        </div>
        <Button onClick={() => setLocation("/admin/ai-extractors/new")}>
          <Plus className="h-4 w-4 mr-2" /> {t("aiExtractor.newExtractor")}
        </Button>
      </div>

      {loading && <div className="text-sm text-muted-foreground">{t("aiExtractor.loading")}</div>}

      {!loading && items.length === 0 && (
        <Card>
          <CardContent className="py-8 text-center text-muted-foreground text-sm">
            {t("aiExtractor.empty")}
          </CardContent>
        </Card>
      )}

      <div className="grid gap-3">
        {items.map((e) => (
          <Card key={e.id} className="hover:shadow-sm transition cursor-pointer" onClick={() => setLocation(`/admin/ai-extractors/${e.id}`)}>
            <CardHeader className="pb-2">
              <CardTitle className="text-base flex items-center justify-between gap-2">
                <span className="flex items-center gap-2">
                  {e.isDefault && <Star className="h-4 w-4 text-amber-500 fill-amber-500" />}
                  {e.name}
                  <Badge variant="outline" className="text-xs font-normal">{e.slug}</Badge>
                </span>
                <span className="flex items-center gap-2" onClick={(ev) => ev.stopPropagation()}>
                  <Switch checked={e.isActive} onCheckedChange={(v) => toggleActive(e, v)} />
                  <Button size="icon" variant="ghost" onClick={() => remove(e)} title={t("aiExtractor.delete")}>
                    <Trash2 className="h-4 w-4 text-rose-500" />
                  </Button>
                </span>
              </CardTitle>
            </CardHeader>
            <CardContent className="text-sm text-muted-foreground space-y-1">
              {e.description && <div>{e.description}</div>}
              <div className="flex flex-wrap gap-2 items-center text-xs">
                <Badge variant="secondary">{e.provider}</Badge>
                <Badge variant="secondary">{e.model}</Badge>
                <span>· {t("aiExtractor.fieldCount", { count: (e.fields || []).length })}</span>
                <span>· {t("aiExtractor.scopes")}: {(e.scopes || []).join(", ") || "—"}</span>
                {e.usage && <span>· {t("aiExtractor.runsCount", { count: e.usage.runs })}</span>}
              </div>
            </CardContent>
          </Card>
        ))}
      </div>

      <AiBuiltinDefaults
        fields={EXTRACTOR_DEFAULT_FIELDS}
        title={t("aiDefault.extractorTitle")}
        subtitle={t("aiDefault.sectionSubtitle")}
      />
    </div>
  );
}
