import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { customFetch } from "@workspace/api-client-react";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useToast } from "@/hooks/use-toast";
import { useI18n } from "@/hooks/use-i18n";
import {
  Languages, Globe, Check, Loader2, Copy, FileText, BookOpen,
  CheckCircle2, Circle, AlertCircle,
} from "lucide-react";

import { SUPPORTED_LANGUAGES, LANGUAGE_META } from "@/lib/i18n";

interface TranslationItem {
  id: number;
  title: string;
  slug: string;
  locale: string;
  translationsJson: Record<string, Record<string, string> | { fields?: Record<string, string>; blocks?: unknown[] }> | null;
}

interface TranslationStatus {
  locales: string[];
  pages: TranslationItem[];
  posts: TranslationItem[];
}

const TRANSLATABLE_PAGE_FIELDS = ["title", "metaTitle", "metaDescription", "ogTitle", "ogDescription"];
const TRANSLATABLE_POST_FIELDS = ["title", "excerpt", "metaTitle", "metaDescription"];

function getLocaleFields(item: TranslationItem, locale: string): Record<string, string> {
  const translations = item.translationsJson || {};
  const localeData = translations[locale];
  if (!localeData) return {};
  if (typeof localeData === "object" && "fields" in localeData && localeData.fields) return localeData.fields as Record<string, string>;
  if (typeof localeData === "object" && !Array.isArray(localeData)) return localeData as Record<string, string>;
  return {};
}

function setLocaleFields(item: TranslationItem, locale: string, fields: Record<string, string>): Record<string, unknown> {
  const translations = { ...(item.translationsJson || {}) };
  const existing = translations[locale];
  if (existing && typeof existing === "object" && "blocks" in existing) {
    translations[locale] = { ...existing, fields } as never;
  } else {
    translations[locale] = fields as never;
  }
  return translations;
}

function getCompleteness(item: TranslationItem, locale: string, fields: string[]): { done: number; total: number; pct: number } {
  const localeData = getLocaleFields(item, locale);
  const done = fields.filter(f => localeData[f] && localeData[f].trim().length > 0).length;
  return { done, total: fields.length, pct: fields.length > 0 ? Math.round((done / fields.length) * 100) : 0 };
}

function LocaleIndicator({ item, locales, fields }: { item: TranslationItem; locales: string[]; fields: string[] }) {
  return (
    <>
    <div className="flex gap-1.5 flex-wrap">
      {locales.map(locale => {
        if (locale === item.locale) {
          return <Badge key={locale} variant="default" className="text-[10px] gap-1"><CheckCircle2 className="w-2.5 h-2.5" /> {locale.toUpperCase()}</Badge>;
        }
        const { pct } = getCompleteness(item, locale, fields);
        if (pct === 100) return <Badge key={locale} variant="outline" className="text-[10px] gap-1 border-green-300 text-green-700"><CheckCircle2 className="w-2.5 h-2.5" /> {locale.toUpperCase()}</Badge>;
        if (pct > 0) return <Badge key={locale} variant="outline" className="text-[10px] gap-1 border-yellow-300 text-yellow-700"><AlertCircle className="w-2.5 h-2.5" /> {locale.toUpperCase()} {pct}%</Badge>;
        return <Badge key={locale} variant="outline" className="text-[10px] gap-1 text-muted-foreground"><Circle className="w-2.5 h-2.5" /> {locale.toUpperCase()}</Badge>;
      })}
    </div>
    </>
  );
}

export default function WebsiteTranslations() {
  const { toast } = useToast();
  const { t } = useI18n();
  const qc = useQueryClient();
  const [editItem, setEditItem] = useState<{ item: TranslationItem; type: "page" | "post" } | null>(null);
  const [editLocale, setEditLocale] = useState("tr");
  const [editValues, setEditValues] = useState<Record<string, string>>({});

  const { data: status, isLoading } = useQuery<TranslationStatus>({
    queryKey: ["/api/website/translations/status"],
    queryFn: () => customFetch("/api/website/translations/status"),
  });

  const saveMutation = useMutation({
    mutationFn: (payload: { id: number; type: "page" | "post"; translations: Record<string, unknown> }) => {
      const endpoint = payload.type === "page"
        ? `/api/website/pages/${payload.id}/translations`
        : `/api/website/blog-posts/${payload.id}/translations`;
      return customFetch(endpoint, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ translations: payload.translations }),
      });
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["/api/website/translations/status"] });
      toast({ title: t("websiteTranslations.saved") });
    },
    onError: (e: Error) => toast({ title: t("websiteTranslations.error"), description: e.message, variant: "destructive" }),
  });

  const locales = status?.locales || ["en"];
  const pages = status?.pages || [];
  const posts = status?.posts || [];
  const allNonDefault = SUPPORTED_LANGUAGES.filter(l => l !== "en");
  const nonDefaultLocales = allNonDefault.length > 0 ? allNonDefault : locales.filter(l => l !== "en");

  function openEditor(item: TranslationItem, type: "page" | "post") {
    setEditItem({ item, type });
    const firstNonDefault = nonDefaultLocales[0] || "tr";
    setEditLocale(firstNonDefault);
    const existing = getLocaleFields(item, firstNonDefault);
    setEditValues(existing);
  }

  function switchLocale(locale: string) {
    if (!editItem) return;
    setEditLocale(locale);
    const existing = getLocaleFields(editItem.item, locale);
    setEditValues(existing);
  }

  function handleSave() {
    if (!editItem) return;
    const translations = setLocaleFields(editItem.item, editLocale, editValues);
    const updatedItem = { ...editItem.item, translationsJson: translations };
    setEditItem({ ...editItem, item: updatedItem as typeof editItem.item });
    saveMutation.mutate({ id: editItem.item.id, type: editItem.type, translations });
  }

  function copyFromDefault() {
    if (!editItem) return;
    const fields = editItem.type === "page" ? TRANSLATABLE_PAGE_FIELDS : TRANSLATABLE_POST_FIELDS;
    const defaults: Record<string, string> = {};
    const itemAny = editItem.item as unknown as Record<string, unknown>;
    for (const f of fields) {
      defaults[f] = (itemAny[f] as string) || "";
    }
    setEditValues(defaults);
    toast({ title: t("websiteTranslations.copiedFromDefault") });
  }

  const translatableFields = editItem?.type === "page" ? TRANSLATABLE_PAGE_FIELDS : TRANSLATABLE_POST_FIELDS;

  return (
    <>
      <div className="p-6 max-w-6xl mx-auto space-y-6">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2"><Languages className="w-6 h-6 text-primary" /> {t("websiteTranslations.title")}</h1>
          <p className="text-sm text-muted-foreground mt-1">{t("websiteTranslations.subtitle")}</p>
        </div>

        <Card className="p-4 bg-blue-50 border-blue-200">
          <div className="flex items-start gap-3">
            <Globe className="w-5 h-5 text-blue-600 mt-0.5 shrink-0" />
            <div className="text-sm text-blue-800">
              <p className="font-medium">{t("websiteTranslations.supportedLocales", { locales: locales.map(l => l.toUpperCase()).join(", ") })}</p>
              <p className="mt-1">{t("websiteTranslations.defaultLocaleNoteBefore")}<strong>EN</strong>{t("websiteTranslations.defaultLocaleNoteAfter")}</p>
            </div>
          </div>
        </Card>

        {isLoading ? (
          <div className="flex items-center justify-center py-20"><Loader2 className="w-6 h-6 animate-spin text-muted-foreground" /></div>
        ) : (
          <Tabs defaultValue="pages">
            <TabsList>
              <TabsTrigger value="pages" className="gap-1"><FileText className="w-3 h-3" /> {t("websiteTranslations.pagesTab", { n: pages.length })}</TabsTrigger>
              <TabsTrigger value="posts" className="gap-1"><BookOpen className="w-3 h-3" /> {t("websiteTranslations.postsTab", { n: posts.length })}</TabsTrigger>
            </TabsList>

            <TabsContent value="pages" className="mt-4 space-y-3">
              {pages.length === 0 ? (
                <Card className="p-8 text-center"><p className="text-muted-foreground text-sm">{t("websiteTranslations.noPages")}</p></Card>
              ) : pages.map(page => (
                <Card key={page.id} className="p-4 hover:shadow-md transition-shadow cursor-pointer" onClick={() => openEditor(page, "page")}>
                  <div className="flex items-center justify-between">
                    <div>
                      <p className="font-semibold text-sm">{page.title}</p>
                      <p className="text-xs text-muted-foreground">/{page.slug}</p>
                    </div>
                    <LocaleIndicator item={page} locales={locales} fields={TRANSLATABLE_PAGE_FIELDS} />
                  </div>
                </Card>
              ))}
            </TabsContent>

            <TabsContent value="posts" className="mt-4 space-y-3">
              {posts.length === 0 ? (
                <Card className="p-8 text-center"><p className="text-muted-foreground text-sm">{t("websiteTranslations.noPosts")}</p></Card>
              ) : posts.map(post => (
                <Card key={post.id} className="p-4 hover:shadow-md transition-shadow cursor-pointer" onClick={() => openEditor(post, "post")}>
                  <div className="flex items-center justify-between">
                    <div>
                      <p className="font-semibold text-sm">{post.title}</p>
                      <p className="text-xs text-muted-foreground">/{post.slug}</p>
                    </div>
                    <LocaleIndicator item={post} locales={locales} fields={TRANSLATABLE_POST_FIELDS} />
                  </div>
                </Card>
              ))}
            </TabsContent>
          </Tabs>
        )}
      </div>

      <Dialog open={!!editItem} onOpenChange={open => { if (!open) setEditItem(null); }}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Languages className="w-5 h-5" /> {t("websiteTranslations.translateTitle", { title: editItem?.item.title || "" })}
            </DialogTitle>
          </DialogHeader>

          <div className="space-y-4">
            <div className="flex items-center gap-3">
              <Label className="text-xs shrink-0">{t("websiteTranslations.localeLabel")}</Label>
              <Select value={editLocale} onValueChange={switchLocale}>
                <SelectTrigger className="w-40"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {nonDefaultLocales.map(l => (
                    <SelectItem key={l} value={l}>{LANGUAGE_META[l as keyof typeof LANGUAGE_META]?.flag} {LANGUAGE_META[l as keyof typeof LANGUAGE_META]?.name || l.toUpperCase()}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Button variant="outline" size="sm" onClick={copyFromDefault} className="gap-1 ml-auto">
                <Copy className="w-3 h-3" /> {t("websiteTranslations.copyFromEn")}
              </Button>
            </div>

            {editItem && (
              <div className="space-y-4">
                {translatableFields.map(field => {
                  const defaultVal = (editItem.item as unknown as Record<string, unknown>)[field] as string || "";
                  return (
                    <div key={field} className="space-y-1.5">
                      <Label className="text-xs font-semibold capitalize">{t(`websiteTranslations.fieldLabels.${field}`)}</Label>
                      {defaultVal && <p className="text-xs text-muted-foreground bg-muted/30 rounded px-2 py-1">{t("websiteTranslations.enValue", { val: defaultVal })}</p>}
                      {field === "metaDescription" || field === "ogDescription" || field === "excerpt" ? (
                        <Textarea value={editValues[field] || ""} onChange={e => setEditValues(v => ({ ...v, [field]: e.target.value }))}
                          placeholder={defaultVal ? t("websiteTranslations.translatePlaceholder", { val: defaultVal }) : t("websiteTranslations.notTranslated")} rows={2} />
                      ) : (
                        <Input value={editValues[field] || ""} onChange={e => setEditValues(v => ({ ...v, [field]: e.target.value }))}
                          placeholder={defaultVal ? t("websiteTranslations.translatePlaceholder", { val: defaultVal }) : t("websiteTranslations.notTranslated")} />
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          <div className="flex justify-end gap-3 mt-4 pt-4 border-t">
            <Button variant="outline" onClick={() => setEditItem(null)}>{t("common.cancel")}</Button>
            <Button onClick={handleSave} disabled={saveMutation.isPending}>
              {saveMutation.isPending ? <Loader2 className="w-4 h-4 animate-spin mr-2" /> : <Check className="w-4 h-4 mr-2" />}
              {t("websiteTranslations.saveTranslation")}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
