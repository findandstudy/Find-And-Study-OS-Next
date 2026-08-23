import { useEffect, useState, useCallback } from "react";
import { customFetch } from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/hooks/use-toast";
import { useI18n } from "@/hooks/use-i18n";
import { Settings2, RotateCcw, Pencil, Check, X } from "lucide-react";

type DefaultEntry = {
  key: string;
  value: unknown;
  hardcoded: unknown;
  isCustom: boolean;
  updatedAt: string | null;
};

type EditType = "text" | "lines" | "json";

export type DefaultFieldDef = {
  key: string;
  label: string;
  editType: EditType;
  description?: string;
};

type Props = {
  fields: DefaultFieldDef[];
  title: string;
  subtitle?: string;
};

function valueToString(value: unknown, editType: EditType): string {
  if (value == null) return "";
  if (editType === "text") {
    return typeof (value as any).text === "string" ? (value as any).text : "";
  }
  if (editType === "lines") {
    const arr = (value as any).globalRules;
    return Array.isArray(arr) ? arr.join("\n") : "";
  }
  if (editType === "json") {
    const fields = (value as any).fields;
    return JSON.stringify(fields ?? value, null, 2);
  }
  return String(value);
}

function stringToValue(str: string, editType: EditType): Record<string, unknown> {
  if (editType === "text") return { text: str };
  if (editType === "lines") return { globalRules: str.split("\n").filter((l) => l.trim().length > 0) };
  if (editType === "json") {
    try {
      const parsed = JSON.parse(str);
      return { fields: Array.isArray(parsed) ? parsed : [] };
    } catch {
      return { fields: [] };
    }
  }
  return { value: str };
}

function SingleDefault({ entry, fieldDef, onSaved, onReset }: {
  entry: DefaultEntry;
  fieldDef: DefaultFieldDef;
  onSaved: (key: string, newEntry: DefaultEntry) => void;
  onReset: (key: string) => void;
}) {
  const { t } = useI18n();
  const { toast } = useToast();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const [resetting, setResetting] = useState(false);

  const startEdit = () => {
    setDraft(valueToString(entry.value, fieldDef.editType));
    setEditing(true);
  };

  const cancelEdit = () => {
    setEditing(false);
    setDraft("");
  };

  const save = async () => {
    setSaving(true);
    try {
      const value = stringToValue(draft, fieldDef.editType);
      const result = await customFetch<DefaultEntry>(`/api/ai-defaults/${entry.key}`, {
        method: "PUT",
        body: JSON.stringify({ value }),
      });
      onSaved(entry.key, result);
      setEditing(false);
      toast({ title: t("aiDefault.toastSaved") });
    } catch (e) {
      toast({ title: t("aiDefault.toastError"), description: (e as Error).message, variant: "destructive" });
    } finally {
      setSaving(false);
    }
  };

  const reset = async () => {
    if (!confirm(t("aiDefault.confirmReset", { key: fieldDef.label }))) return;
    setResetting(true);
    try {
      await customFetch(`/api/ai-defaults/${entry.key}`, { method: "DELETE" });
      onReset(entry.key);
      setEditing(false);
      toast({ title: t("aiDefault.toastReset") });
    } catch (e) {
      toast({ title: t("aiDefault.toastError"), description: (e as Error).message, variant: "destructive" });
    } finally {
      setResetting(false);
    }
  };

  const previewStr = valueToString(entry.value, fieldDef.editType);
  const preview = previewStr.length > 200 ? previewStr.slice(0, 200) + "…" : previewStr;

  return (
    <div className="border rounded-lg p-4 space-y-2">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <div className="flex items-center gap-2">
          <span className="font-medium text-sm">{fieldDef.label}</span>
          {entry.isCustom ? (
            <Badge variant="secondary" className="text-xs">{t("aiDefault.badgeCustom")}</Badge>
          ) : (
            <Badge variant="outline" className="text-xs text-muted-foreground">{t("aiDefault.badgeBuiltin")}</Badge>
          )}
        </div>
        <div className="flex gap-1">
          {!editing && (
            <Button size="sm" variant="outline" onClick={startEdit}>
              <Pencil className="h-3 w-3 mr-1" /> {t("aiDefault.edit")}
            </Button>
          )}
          {entry.isCustom && !editing && (
            <Button size="sm" variant="ghost" onClick={reset} disabled={resetting}>
              <RotateCcw className="h-3 w-3 mr-1" />
              {resetting ? t("aiDefault.resetting") : t("aiDefault.reset")}
            </Button>
          )}
        </div>
      </div>

      {fieldDef.description && (
        <p className="text-xs text-muted-foreground">{fieldDef.description}</p>
      )}

      {editing ? (
        <div className="space-y-2">
          <Textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            rows={fieldDef.editType === "json" ? 12 : 6}
            className="font-mono text-xs"
            placeholder={t("aiDefault.editPlaceholder")}
          />
          <div className="flex gap-2">
            <Button size="sm" onClick={save} disabled={saving}>
              <Check className="h-3 w-3 mr-1" />
              {saving ? t("aiDefault.saving") : t("aiDefault.save")}
            </Button>
            <Button size="sm" variant="ghost" onClick={cancelEdit}>
              <X className="h-3 w-3 mr-1" /> {t("aiDefault.cancel")}
            </Button>
            {entry.isCustom && (
              <Button size="sm" variant="ghost" onClick={reset} disabled={resetting}>
                <RotateCcw className="h-3 w-3 mr-1" />
                {resetting ? t("aiDefault.resetting") : t("aiDefault.reset")}
              </Button>
            )}
          </div>
        </div>
      ) : (
        <pre className="text-xs text-muted-foreground bg-muted/40 rounded p-2 whitespace-pre-wrap break-all max-h-32 overflow-y-auto">
          {preview || <span className="italic">{t("aiDefault.badgeBuiltin")}</span>}
        </pre>
      )}
    </div>
  );
}

export default function AiBuiltinDefaults({ fields, title, subtitle }: Props) {
  const { t } = useI18n();
  const { toast } = useToast();
  const [entries, setEntries] = useState<Record<string, DefaultEntry>>({});
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    try {
      setLoading(true);
      const data = await customFetch<{ defaults: DefaultEntry[] }>("/api/ai-defaults");
      const byKey: Record<string, DefaultEntry> = {};
      for (const d of data.defaults) byKey[d.key] = d;
      setEntries(byKey);
    } catch (e) {
      toast({ title: t("aiDefault.toastError"), description: (e as Error).message, variant: "destructive" });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const handleSaved = (key: string, newEntry: DefaultEntry) => {
    setEntries((prev) => ({ ...prev, [key]: newEntry }));
  };

  const handleReset = (key: string) => {
    setEntries((prev) => {
      if (!prev[key]) return prev;
      const entry = prev[key];
      return {
        ...prev,
        [key]: { ...entry, value: entry.hardcoded, isCustom: false, updatedAt: null },
      };
    });
  };

  return (
    <Card className="mt-6">
      <CardHeader className="pb-3">
        <CardTitle className="text-base flex items-center gap-2">
          <Settings2 className="h-4 w-4 text-indigo-500" />
          {title}
        </CardTitle>
        {subtitle && (
          <p className="text-sm text-muted-foreground">{subtitle}</p>
        )}
      </CardHeader>
      <CardContent className="space-y-3">
        {loading && (
          <div className="text-sm text-muted-foreground">{t("aiDefault.loading")}</div>
        )}
        {!loading && fields.map((fieldDef) => {
          const entry = entries[fieldDef.key];
          if (!entry) return null;
          return (
            <SingleDefault
              key={fieldDef.key}
              entry={entry}
              fieldDef={fieldDef}
              onSaved={handleSaved}
              onReset={handleReset}
            />
          );
        })}
      </CardContent>
    </Card>
  );
}
