import { useState, useCallback, useEffect, useRef } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { customFetch } from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetTrigger } from "@/components/ui/sheet";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import {
  Save, Upload, Eye, EyeOff, Plus, Trash2, Copy, ChevronUp, ChevronDown,
  Monitor, Tablet, Smartphone, History, ArrowLeft, RotateCcw, GripVertical, Sparkles, Settings2,
} from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { AiAssistantPanel } from "@/components/AiAssistantPanel";
import { useLocation } from "wouter";
import { BLOCK_TYPES, getBlockTypeDef, getDefaultContent, type PageBlock, type BlockFieldDef } from "@/lib/website/blockTypes";
import { SUPPORTED_LANGUAGES, LANGUAGE_META } from "@/lib/i18n";
import DOMPurify from "isomorphic-dompurify";

const ALLOWED_TAGS = ["p", "br", "b", "i", "u", "strong", "em", "a", "ul", "ol", "li", "h1", "h2", "h3", "h4", "h5", "h6", "blockquote", "code", "pre", "span", "div", "img", "hr"];
const ALLOWED_ATTRS = ["href", "target", "rel", "src", "alt", "class", "style"];

function sanitizeHtml(html: string): string {
  return DOMPurify.sanitize(html, {
    ALLOWED_TAGS,
    ALLOWED_ATTR: ALLOWED_ATTRS,
    ALLOWED_URI_REGEXP: /^(?:https?:|mailto:|tel:|\/|#)/i,
    FORBID_ATTR: ["onerror", "onload", "onclick", "onmouseover", "onfocus", "onblur"],
    ADD_ATTR: ["target"],
  });
}

interface WebsitePage {
  id: number;
  title: string;
  slug: string;
  status: string;
  template: string;
  locale: string;
  metaTitle: string | null;
  metaDescription: string | null;
  publishedAt: string | null;
  translationsJson: Record<string, Record<string, string>> | null;
}

interface PageVersion {
  id: number;
  pageId: number;
  versionNumber: number;
  blocksSnapshot: PageBlock[];
  metaSnapshot: Record<string, string> | null;
  publishedAt: string | null;
  createdBy: number | null;
  createdAt: string;
  authorFirstName: string | null;
  authorLastName: string | null;
  authorEmail: string | null;
}

type PreviewSize = "desktop" | "tablet" | "mobile";
const PREVIEW_WIDTHS: Record<PreviewSize, string> = { desktop: "100%", tablet: "768px", mobile: "375px" };

export default function PageEditor({ id }: { id: number }) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [, setLocation] = useLocation();
  const [blocks, setBlocks] = useState<PageBlock[]>([]);
  const [selectedBlockIdx, setSelectedBlockIdx] = useState<number | null>(null);
  const [previewSize, setPreviewSize] = useState<PreviewSize>("desktop");
  const [showAddBlock, setShowAddBlock] = useState(false);
  const [dirty, setDirty] = useState(false);
  const blocksInitialized = useRef(false);
  const [editLocale, setEditLocale] = useState("en");
  const defaultBlocksRef = useRef<PageBlock[]>([]);
  const translationsRef = useRef<Record<string, PageBlock[]>>({});
  const [seoOpen, setSeoOpen] = useState(false);
  const [seo, setSeo] = useState({
    metaTitle: "", metaDescription: "", canonicalUrl: "",
    robotsIndex: true, robotsFollow: true,
    ogTitle: "", ogDescription: "", ogImageUrl: "",
    twitterTitle: "", twitterDescription: "", twitterImageUrl: "",
    slug: "",
  });
  const seoInitialized = useRef(false);

  const { data: page, isLoading: pageLoading } = useQuery<WebsitePage>({
    queryKey: ["website-page", id],
    queryFn: () => customFetch(`/api/website/pages/${id}`),
  });

  const { data: savedBlocks = [], isFetched: blocksFetched } = useQuery<PageBlock[]>({
    queryKey: ["website-page-blocks", id],
    queryFn: () => customFetch(`/api/website/pages/${id}/blocks`),
    enabled: !!page,
  });

  const { data: versions = [] } = useQuery<PageVersion[]>({
    queryKey: ["website-page-versions", id],
    queryFn: () => customFetch(`/api/website/pages/${id}/versions`),
    enabled: !!page,
  });

  useEffect(() => {
    if (blocksInitialized.current) return;
    if (!blocksFetched) return;
    blocksInitialized.current = true;
    const parsed = savedBlocks.map((b, i) => ({
      id: b.id,
      blockType: b.blockType,
      content: (b.content || {}) as Record<string, unknown>,
      settings: (b.settings || {}) as Record<string, unknown>,
      sortOrder: b.sortOrder ?? i,
      isVisible: b.isVisible ?? true,
    }));
    setBlocks(parsed);
    defaultBlocksRef.current = JSON.parse(JSON.stringify(parsed));
    if (page?.translationsJson) {
      try {
        const tj = page.translationsJson as Record<string, unknown>;
        for (const [loc, data] of Object.entries(tj)) {
          if (Array.isArray(data)) {
            translationsRef.current[loc] = data as PageBlock[];
          } else if (data && typeof data === "object" && "blocks" in (data as Record<string, unknown>)) {
            translationsRef.current[loc] = (data as { blocks: PageBlock[] }).blocks;
          }
        }
      } catch {}
    }
  }, [blocksFetched, savedBlocks, page]);

  const { data: seoData } = useQuery<Record<string, unknown>>({
    queryKey: ["website-page-seo", id],
    queryFn: () => customFetch(`/api/website/pages/${id}/seo`),
    enabled: !!page,
  });

  const { data: globalSettings } = useQuery<Record<string, unknown>>({
    queryKey: ["global-settings"],
    queryFn: () => customFetch("/api/settings"),
    staleTime: 60_000,
  });
  const globalSeo = {
    metaTitle: (globalSettings?.seoMetaTitle as string) || "",
    metaDescription: (globalSettings?.seoMetaDescription as string) || "",
    ogImageUrl: (globalSettings?.ogImageUrl as string) || "",
    siteName: (globalSettings?.siteName as string) || "",
  };

  useEffect(() => {
    if (seoInitialized.current || !seoData) return;
    seoInitialized.current = true;
    setSeo({
      metaTitle: (seoData.metaTitle as string) || "",
      metaDescription: (seoData.metaDescription as string) || "",
      canonicalUrl: (seoData.canonicalUrl as string) || "",
      robotsIndex: seoData.robotsIndex !== false,
      robotsFollow: seoData.robotsFollow !== false,
      ogTitle: (seoData.ogTitle as string) || "",
      ogDescription: (seoData.ogDescription as string) || "",
      ogImageUrl: (seoData.ogImageUrl as string) || "",
      twitterTitle: (seoData.twitterTitle as string) || "",
      twitterDescription: (seoData.twitterDescription as string) || "",
      twitterImageUrl: (seoData.twitterImageUrl as string) || "",
      slug: (seoData.slug as string) || "",
    });
  }, [seoData]);

  const saveSeoMutation = useMutation({
    mutationFn: () =>
      customFetch(`/api/website/pages/${id}/seo`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(seo),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["website-page-seo", id] });
      toast({ title: "SEO settings saved" });
      setSeoOpen(false);
    },
    onError: () => toast({ title: "Error", description: "Failed to save SEO settings.", variant: "destructive" }),
  });

  function buildTranslationsPayload() {
    const existing = (page?.translationsJson as Record<string, unknown>) || {};
    const result: Record<string, unknown> = { ...existing };
    for (const [loc, blockArr] of Object.entries(translationsRef.current)) {
      const prev = (result[loc] && typeof result[loc] === "object") ? result[loc] as Record<string, unknown> : {};
      result[loc] = { ...prev, blocks: blockArr };
    }
    if (editLocale !== "en") {
      const prev = (result[editLocale] && typeof result[editLocale] === "object") ? result[editLocale] as Record<string, unknown> : {};
      result[editLocale] = { ...prev, blocks: blocks.map((b, i) => ({ ...b, sortOrder: i })) };
    }
    return Object.keys(result).length > 0 ? result : undefined;
  }

  const saveDraftMutation = useMutation({
    mutationFn: () => {
      const payload: Record<string, unknown> = {
        blocks: editLocale === "en" ? blocks.map((b, i) => ({ ...b, sortOrder: i })) : defaultBlocksRef.current.map((b, i) => ({ ...b, sortOrder: i })),
      };
      const tx = buildTranslationsPayload();
      if (tx) payload.translationsJson = tx;
      return customFetch(`/api/website/pages/${id}/save-draft`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["website-page", id] });
      queryClient.invalidateQueries({ queryKey: ["website-page-blocks", id] });
      queryClient.invalidateQueries({ queryKey: ["website-pages"] });
      setDirty(false);
      toast({ title: "Draft saved" });
    },
    onError: () => toast({ title: "Error", description: "Failed to save draft.", variant: "destructive" }),
  });

  const publishMutation = useMutation({
    mutationFn: async () => {
      const payload: Record<string, unknown> = {
        blocks: editLocale === "en" ? blocks.map((b, i) => ({ ...b, sortOrder: i })) : defaultBlocksRef.current.map((b, i) => ({ ...b, sortOrder: i })),
      };
      const tx = buildTranslationsPayload();
      if (tx) payload.translationsJson = tx;
      await customFetch(`/api/website/pages/${id}/save-draft`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      return customFetch(`/api/website/pages/${id}/publish`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["website-page", id] });
      queryClient.invalidateQueries({ queryKey: ["website-page-blocks", id] });
      queryClient.invalidateQueries({ queryKey: ["website-page-versions", id] });
      queryClient.invalidateQueries({ queryKey: ["website-pages"] });
      setDirty(false);
      toast({ title: "Published!", description: "Page is now live." });
    },
    onError: () => toast({ title: "Error", description: "Failed to publish.", variant: "destructive" }),
  });

  function handleLocaleSwitch(newLocale: string) {
    if (newLocale === editLocale) return;
    if (editLocale === "en") {
      defaultBlocksRef.current = JSON.parse(JSON.stringify(blocks));
    } else {
      translationsRef.current[editLocale] = JSON.parse(JSON.stringify(blocks));
    }
    if (newLocale === "en") {
      setBlocks(JSON.parse(JSON.stringify(defaultBlocksRef.current)));
    } else {
      const translated = translationsRef.current[newLocale];
      if (translated && translated.length > 0) {
        setBlocks(JSON.parse(JSON.stringify(translated)));
      } else {
        const copy = JSON.parse(JSON.stringify(defaultBlocksRef.current));
        setBlocks(copy);
        toast({ title: "No translation yet", description: "Showing default (English) content. Edit to create translation." });
      }
    }
    setEditLocale(newLocale);
    setSelectedBlockIdx(null);
    setDirty(true);
  }

  const restoreMutation = useMutation({
    mutationFn: (versionId: number) =>
      customFetch(`/api/website/pages/${id}/restore-version/${versionId}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
      }) as Promise<{ page: WebsitePage; blocks: PageBlock[] }>,
    onSuccess: (result) => {
      setBlocks(result.blocks.map((b, i) => ({
        id: b.id,
        blockType: b.blockType,
        content: (b.content || {}) as Record<string, unknown>,
        settings: (b.settings || {}) as Record<string, unknown>,
        sortOrder: b.sortOrder ?? i,
        isVisible: b.isVisible ?? true,
      })));
      setDirty(true);
      queryClient.invalidateQueries({ queryKey: ["website-page", id] });
      queryClient.invalidateQueries({ queryKey: ["website-page-blocks", id] });
      toast({ title: "Version restored", description: "Loaded as a new draft." });
    },
    onError: () => toast({ title: "Error", description: "Failed to restore version.", variant: "destructive" }),
  });

  const addBlock = useCallback((blockType: string) => {
    const newBlock: PageBlock = {
      blockType,
      content: getDefaultContent(blockType),
      settings: {},
      sortOrder: blocks.length,
      isVisible: true,
    };
    setBlocks(prev => [...prev, newBlock]);
    setSelectedBlockIdx(blocks.length);
    setShowAddBlock(false);
    setDirty(true);
  }, [blocks.length]);

  const removeBlock = useCallback((idx: number) => {
    setBlocks(prev => prev.filter((_, i) => i !== idx));
    if (selectedBlockIdx === idx) setSelectedBlockIdx(null);
    else if (selectedBlockIdx !== null && selectedBlockIdx > idx) setSelectedBlockIdx(selectedBlockIdx - 1);
    setDirty(true);
  }, [selectedBlockIdx]);

  const duplicateBlock = useCallback((idx: number) => {
    setBlocks(prev => {
      const copy = { ...prev[idx], content: { ...prev[idx].content }, settings: { ...prev[idx].settings }, id: undefined };
      const next = [...prev];
      next.splice(idx + 1, 0, copy);
      return next;
    });
    setDirty(true);
  }, []);

  const moveBlock = useCallback((idx: number, dir: -1 | 1) => {
    setBlocks(prev => {
      const next = [...prev];
      const target = idx + dir;
      if (target < 0 || target >= next.length) return prev;
      [next[idx], next[target]] = [next[target], next[idx]];
      return next;
    });
    if (selectedBlockIdx === idx) setSelectedBlockIdx(idx + dir);
    setDirty(true);
  }, [selectedBlockIdx]);

  const toggleVisibility = useCallback((idx: number) => {
    setBlocks(prev => prev.map((b, i) => i === idx ? { ...b, isVisible: !b.isVisible } : b));
    setDirty(true);
  }, []);

  const updateBlockContent = useCallback((idx: number, key: string, value: unknown) => {
    setBlocks(prev => prev.map((b, i) => i === idx ? { ...b, content: { ...b.content, [key]: value } } : b));
    setDirty(true);
  }, []);

  const selectedBlock = selectedBlockIdx !== null ? blocks[selectedBlockIdx] : null;
  const selectedTypeDef = selectedBlock ? getBlockTypeDef(selectedBlock.blockType) : null;

  if (pageLoading) {
    return (
        <div className="flex items-center justify-center py-20">
          <div className="animate-spin w-8 h-8 border-4 border-primary border-t-transparent rounded-full" />
        </div>
    );
  }

  if (!page) {
    return (
        <div className="flex flex-col items-center justify-center py-20">
          <p className="text-muted-foreground">Page not found.</p>
          <Button variant="link" onClick={() => setLocation("/admin/website/pages")}>
            Back to Pages
          </Button>
        </div>
    );
  }

  return (
      <div className="flex flex-col h-[calc(100vh-3.5rem)]">
        <div className="h-12 border-b bg-card flex items-center justify-between px-4 shrink-0">
          <div className="flex items-center gap-3">
            <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => setLocation("/admin/website/pages")}>
              <ArrowLeft className="w-4 h-4" />
            </Button>
            <Separator orientation="vertical" className="h-5" />
            <h2 className="font-semibold text-sm">{page.title}</h2>
            <Badge variant={page.status === "published" ? "default" : "secondary"} className="text-xs">
              {page.status}
            </Badge>
            {dirty && <Badge variant="outline" className="text-xs text-amber-600 border-amber-300">Unsaved</Badge>}
          </div>
          <div className="flex items-center gap-2">
            <Select value={editLocale} onValueChange={handleLocaleSwitch}>
              <SelectTrigger className="h-7 w-[100px] text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {SUPPORTED_LANGUAGES.map(code => (
                  <SelectItem key={code} value={code}>{LANGUAGE_META[code].flag} {LANGUAGE_META[code].nativeName}</SelectItem>
                ))}
              </SelectContent>
            </Select>
            <div className="flex gap-0.5">
              {SUPPORTED_LANGUAGES.filter(l => l !== "en").slice(0, 5).map(l => {
                const trBlocks = translationsRef.current[l];
                const has = trBlocks && trBlocks.length > 0;
                return <span key={l} className={`text-[9px] ${has ? "text-green-600" : "text-muted-foreground/40"}`} title={`${LANGUAGE_META[l].name}: ${has ? "translated" : "not translated"}`}>{has ? "●" : "○"}</span>;
              })}
            </div>
            <Separator orientation="vertical" className="h-5" />
            <div className="flex items-center border rounded-md">
              {(["desktop", "tablet", "mobile"] as PreviewSize[]).map(size => (
                <Button
                  key={size}
                  variant={previewSize === size ? "default" : "ghost"}
                  size="icon"
                  className="h-7 w-7 rounded-none first:rounded-l-md last:rounded-r-md"
                  onClick={() => setPreviewSize(size)}
                >
                  {size === "desktop" ? <Monitor className="w-3.5 h-3.5" /> : size === "tablet" ? <Tablet className="w-3.5 h-3.5" /> : <Smartphone className="w-3.5 h-3.5" />}
                </Button>
              ))}
            </div>
            <Separator orientation="vertical" className="h-5" />
            <Sheet open={seoOpen} onOpenChange={setSeoOpen}>
              <SheetTrigger asChild>
                <Button variant="outline" size="sm" className="h-7 text-xs gap-1">
                  <Settings2 className="w-3.5 h-3.5" /> SEO
                </Button>
              </SheetTrigger>
              <SheetContent>
                <SheetHeader>
                  <SheetTitle>Page SEO Settings</SheetTitle>
                </SheetHeader>
                <ScrollArea className="h-[calc(100vh-80px)] mt-4 pr-2">
                <div className="space-y-4 pb-6">
                  <div className="space-y-1.5">
                    <Label className="text-xs font-medium">URL Slug</Label>
                    <Input value={seo.slug} onChange={e => setSeo(s => ({ ...s, slug: e.target.value }))} placeholder="page-url-slug" className="h-8 text-sm" />
                  </div>
                  <div className="space-y-1.5">
                    <Label className="text-xs font-medium">Meta Title</Label>
                    <Input value={seo.metaTitle} onChange={e => setSeo(s => ({ ...s, metaTitle: e.target.value }))} placeholder="SEO page title" className="h-8 text-sm" />
                    <p className="text-[10px] text-muted-foreground">{seo.metaTitle.length}/60 characters</p>
                  </div>
                  <div className="space-y-1.5">
                    <Label className="text-xs font-medium">Meta Description</Label>
                    <Textarea value={seo.metaDescription} onChange={e => setSeo(s => ({ ...s, metaDescription: e.target.value }))} placeholder="SEO description" rows={3} className="text-sm" />
                    <p className="text-[10px] text-muted-foreground">{seo.metaDescription.length}/160 characters</p>
                  </div>
                  <div className="rounded border p-3 bg-muted/30">
                    <p className="text-[10px] text-muted-foreground mb-1">Google Search Preview</p>
                    <p className="text-sm text-blue-700 truncate">{seo.metaTitle || page?.title || globalSeo.metaTitle || "Page Title"}</p>
                    <p className="text-xs text-green-700 truncate">{globalSeo.siteName ? globalSeo.siteName.toLowerCase().replace(/\s+/g, '') + '.com' : 'findandstudy.com'}/{seo.slug || page?.slug || ""}</p>
                    <p className="text-xs text-muted-foreground line-clamp-2">{seo.metaDescription || globalSeo.metaDescription || "No description set"}</p>
                    {!seo.metaTitle && !seo.metaDescription && globalSeo.metaTitle && (
                      <p className="text-[10px] text-amber-600 mt-1">Using global SEO defaults from Settings.</p>
                    )}
                  </div>
                  <div className="space-y-1.5">
                    <Label className="text-xs font-medium">Canonical URL</Label>
                    <Input value={seo.canonicalUrl} onChange={e => setSeo(s => ({ ...s, canonicalUrl: e.target.value }))} placeholder="https://..." className="h-8 text-sm" />
                  </div>
                  <div className="flex items-center gap-4">
                    <div className="flex items-center gap-2">
                      <Switch checked={seo.robotsIndex} onCheckedChange={v => setSeo(s => ({ ...s, robotsIndex: v }))} />
                      <Label className="text-xs">Index</Label>
                    </div>
                    <div className="flex items-center gap-2">
                      <Switch checked={seo.robotsFollow} onCheckedChange={v => setSeo(s => ({ ...s, robotsFollow: v }))} />
                      <Label className="text-xs">Follow</Label>
                    </div>
                  </div>
                  <Separator />
                  <h4 className="text-xs font-bold uppercase text-muted-foreground">Open Graph</h4>
                  <div className="space-y-1.5">
                    <Label className="text-xs font-medium">OG Title</Label>
                    <Input value={seo.ogTitle} onChange={e => setSeo(s => ({ ...s, ogTitle: e.target.value }))} placeholder="Social share title" className="h-8 text-sm" />
                  </div>
                  <div className="space-y-1.5">
                    <Label className="text-xs font-medium">OG Description</Label>
                    <Textarea value={seo.ogDescription} onChange={e => setSeo(s => ({ ...s, ogDescription: e.target.value }))} placeholder="Social share description" rows={2} className="text-sm" />
                  </div>
                  <div className="space-y-1.5">
                    <Label className="text-xs font-medium">OG Image URL</Label>
                    <Input value={seo.ogImageUrl} onChange={e => setSeo(s => ({ ...s, ogImageUrl: e.target.value }))} placeholder="https://..." className="h-8 text-sm" />
                  </div>
                  {(seo.ogTitle || seo.ogDescription || seo.ogImageUrl || globalSeo.ogImageUrl) && (
                    <div className="rounded border p-3 bg-muted/30">
                      <p className="text-[10px] text-muted-foreground mb-1">Social Share Preview</p>
                      {(seo.ogImageUrl || globalSeo.ogImageUrl) && <div className="w-full h-24 bg-muted rounded mb-2 flex items-center justify-center text-xs text-muted-foreground overflow-hidden"><img src={seo.ogImageUrl || globalSeo.ogImageUrl} alt="OG" className="w-full h-full object-cover" onError={e => { (e.target as HTMLImageElement).style.display = "none" }} /></div>}
                      <p className="text-sm font-medium truncate">{seo.ogTitle || seo.metaTitle || page?.title || globalSeo.metaTitle || "Title"}</p>
                      <p className="text-xs text-muted-foreground line-clamp-2">{seo.ogDescription || seo.metaDescription || globalSeo.metaDescription || ""}</p>
                    </div>
                  )}
                  <Separator />
                  <h4 className="text-xs font-bold uppercase text-muted-foreground">Twitter Card</h4>
                  <div className="space-y-1.5">
                    <Label className="text-xs font-medium">Twitter Title</Label>
                    <Input value={seo.twitterTitle} onChange={e => setSeo(s => ({ ...s, twitterTitle: e.target.value }))} className="h-8 text-sm" />
                  </div>
                  <div className="space-y-1.5">
                    <Label className="text-xs font-medium">Twitter Description</Label>
                    <Textarea value={seo.twitterDescription} onChange={e => setSeo(s => ({ ...s, twitterDescription: e.target.value }))} rows={2} className="text-sm" />
                  </div>
                  <div className="space-y-1.5">
                    <Label className="text-xs font-medium">Twitter Image URL</Label>
                    <Input value={seo.twitterImageUrl} onChange={e => setSeo(s => ({ ...s, twitterImageUrl: e.target.value }))} placeholder="https://..." className="h-8 text-sm" />
                  </div>
                  <Button onClick={() => saveSeoMutation.mutate()} disabled={saveSeoMutation.isPending} className="w-full">
                    {saveSeoMutation.isPending ? "Saving..." : "Save SEO Settings"}
                  </Button>
                </div>
                </ScrollArea>
              </SheetContent>
            </Sheet>
            <Sheet>
              <SheetTrigger asChild>
                <Button variant="outline" size="sm" className="h-7 text-xs gap-1">
                  <History className="w-3.5 h-3.5" /> Versions ({versions.length})
                </Button>
              </SheetTrigger>
              <SheetContent>
                <SheetHeader>
                  <SheetTitle>Version History</SheetTitle>
                </SheetHeader>
                <div className="mt-4 space-y-3">
                  {versions.length === 0 ? (
                    <p className="text-sm text-muted-foreground">No published versions yet.</p>
                  ) : (
                    versions.map(v => {
                      const authorName = v.authorFirstName
                        ? `${v.authorFirstName} ${v.authorLastName || ""}`.trim()
                        : v.authorEmail || "Unknown";
                      return (
                      <Card key={v.id}>
                        <CardContent className="p-3 flex items-center justify-between">
                          <div>
                            <p className="text-sm font-medium">Version {v.versionNumber}</p>
                            <p className="text-xs text-muted-foreground">
                              {v.publishedAt ? new Date(v.publishedAt).toLocaleString() : new Date(v.createdAt).toLocaleString()}
                            </p>
                            <p className="text-xs text-muted-foreground">by {authorName}</p>
                          </div>
                          <Button
                            variant="outline"
                            size="sm"
                            className="h-7 text-xs gap-1"
                            onClick={() => restoreMutation.mutate(v.id)}
                            disabled={restoreMutation.isPending}
                          >
                            <RotateCcw className="w-3 h-3" /> Restore
                          </Button>
                        </CardContent>
                      </Card>
                      );
                    })
                  )}
                </div>
              </SheetContent>
            </Sheet>
            <Button variant="outline" size="sm" className="h-7 text-xs gap-1" onClick={() => saveDraftMutation.mutate()} disabled={saveDraftMutation.isPending}>
              <Save className="w-3.5 h-3.5" /> {saveDraftMutation.isPending ? "Saving..." : "Save Draft"}
            </Button>
            <Button size="sm" className="h-7 text-xs gap-1" onClick={() => publishMutation.mutate()} disabled={publishMutation.isPending}>
              <Upload className="w-3.5 h-3.5" /> {publishMutation.isPending ? "Publishing..." : "Publish"}
            </Button>
          </div>
        </div>

        <div className="flex flex-1 overflow-hidden">
          <div className="w-64 border-r bg-card flex flex-col shrink-0">
            <div className="p-3 border-b flex items-center justify-between">
              <h3 className="text-xs font-bold uppercase text-muted-foreground">Blocks</h3>
              <Dialog open={showAddBlock} onOpenChange={setShowAddBlock}>
                <DialogTrigger asChild>
                  <Button variant="outline" size="icon" className="h-6 w-6">
                    <Plus className="w-3.5 h-3.5" />
                  </Button>
                </DialogTrigger>
                <DialogContent className="max-w-lg">
                  <DialogHeader>
                    <DialogTitle>Add Block</DialogTitle>
                  </DialogHeader>
                  <div className="grid grid-cols-2 gap-2 mt-2 max-h-[60vh] overflow-y-auto">
                    {BLOCK_TYPES.map(bt => (
                      <button
                        key={bt.type}
                        onClick={() => addBlock(bt.type)}
                        className="flex items-center gap-2 p-3 rounded-lg border hover:border-primary hover:bg-primary/5 transition-colors text-left"
                      >
                        <span className="text-lg">{bt.icon}</span>
                        <div>
                          <p className="text-sm font-medium">{bt.label}</p>
                          <p className="text-[10px] text-muted-foreground capitalize">{bt.category}</p>
                        </div>
                      </button>
                    ))}
                  </div>
                </DialogContent>
              </Dialog>
            </div>
            <ScrollArea className="flex-1">
              <div className="p-2 space-y-1">
                {blocks.map((block, idx) => {
                  const def = getBlockTypeDef(block.blockType);
                  return (
                    <div
                      key={idx}
                      className={`group flex items-center gap-1 p-2 rounded-lg cursor-pointer transition-colors text-sm ${
                        selectedBlockIdx === idx ? "bg-primary/10 border border-primary/30" : "hover:bg-secondary"
                      } ${!block.isVisible ? "opacity-50" : ""}`}
                      onClick={() => setSelectedBlockIdx(idx)}
                    >
                      <GripVertical className="w-3 h-3 text-muted-foreground shrink-0" />
                      <span className="text-sm shrink-0">{def?.icon || "📦"}</span>
                      <span className="flex-1 truncate text-xs font-medium">{def?.label || block.blockType}</span>
                      <div className="hidden group-hover:flex items-center gap-0.5">
                        <button onClick={e => { e.stopPropagation(); moveBlock(idx, -1); }} className="p-0.5 hover:bg-secondary rounded" disabled={idx === 0}>
                          <ChevronUp className="w-3 h-3" />
                        </button>
                        <button onClick={e => { e.stopPropagation(); moveBlock(idx, 1); }} className="p-0.5 hover:bg-secondary rounded" disabled={idx === blocks.length - 1}>
                          <ChevronDown className="w-3 h-3" />
                        </button>
                        <button onClick={e => { e.stopPropagation(); toggleVisibility(idx); }} className="p-0.5 hover:bg-secondary rounded">
                          {block.isVisible ? <Eye className="w-3 h-3" /> : <EyeOff className="w-3 h-3" />}
                        </button>
                        <button onClick={e => { e.stopPropagation(); duplicateBlock(idx); }} className="p-0.5 hover:bg-secondary rounded">
                          <Copy className="w-3 h-3" />
                        </button>
                        <button onClick={e => { e.stopPropagation(); removeBlock(idx); }} className="p-0.5 hover:bg-red-100 dark:hover:bg-red-900/30 text-red-500 rounded">
                          <Trash2 className="w-3 h-3" />
                        </button>
                      </div>
                    </div>
                  );
                })}
                {blocks.length === 0 && (
                  <div className="text-center py-8 text-xs text-muted-foreground">
                    <p>No blocks yet.</p>
                    <p>Click + to add your first block.</p>
                  </div>
                )}
              </div>
            </ScrollArea>
          </div>

          <div className="w-80 border-r bg-background flex flex-col shrink-0">
            <div className="p-3 border-b">
              <h3 className="text-xs font-bold uppercase text-muted-foreground">
                {selectedBlock ? `Edit: ${selectedTypeDef?.label || selectedBlock.blockType}` : "Block Editor"}
              </h3>
            </div>
            {editLocale !== "en" && (
              <div className="mx-3 mt-2 p-2 rounded-lg bg-blue-50 border border-blue-200 text-xs">
                <p className="font-medium text-blue-800 flex items-center gap-1">
                  {LANGUAGE_META[editLocale as keyof typeof LANGUAGE_META]?.flag} Editing in {LANGUAGE_META[editLocale as keyof typeof LANGUAGE_META]?.name || editLocale}
                </p>
                <p className="text-blue-600 mt-0.5">Content entered here is for this locale's translation.</p>
                <Button type="button" variant="outline" size="sm" className="h-5 text-[10px] px-2 mt-1" onClick={() => {
                  const defaultBlocks = defaultBlocksRef.current;
                  setBlocks(defaultBlocks.map(b => ({ ...b })));
                  toast({ title: "Copied blocks from English" });
                }}>Copy blocks from English</Button>
              </div>
            )}
            <ScrollArea className="flex-1">
              <div className="p-4 space-y-4">
                {!selectedBlock ? (
                  <p className="text-sm text-muted-foreground text-center py-8">Select a block to edit its content.</p>
                ) : selectedBlock.blockType === "global_block" ? (
                  <GlobalBlockSelector
                    content={selectedBlock.content}
                    onChange={(key, value) => updateBlockContent(selectedBlockIdx!, key, value)}
                  />
                ) : (
                  <>
                    <BlockFieldEditor
                      fields={selectedTypeDef?.fields || []}
                      content={selectedBlock.content}
                      onChange={(key, value) => updateBlockContent(selectedBlockIdx!, key, value)}
                    />
                    <AiAssistantPanel
                      context={Object.values(selectedBlock.content).filter(v => typeof v === "string").join(" ").slice(0, 500)}
                      locale={editLocale}
                      onResult={(action, result) => {
                        const fieldMap: Record<string, string> = {
                          generateMetaTitle: "title",
                          generateMetaDescription: "subtitle",
                          generateHeroTitle: "heading",
                          generateCTAText: "buttonText",
                          generateOGText: "description",
                          improveTone: "body",
                          shortenText: "body",
                          expandText: "body",
                          generateExcerpt: "description",
                          generateAltText: "altText",
                        };
                        const targetField = fieldMap[action];
                        if (targetField && selectedBlockIdx !== null) {
                          updateBlockContent(selectedBlockIdx, targetField, result);
                        }
                      }}
                    />
                  </>
                )}
              </div>
            </ScrollArea>
          </div>

          <div className="flex-1 bg-secondary/30 flex flex-col items-center p-4 overflow-auto">
            <div
              className="bg-white dark:bg-card rounded-lg shadow-lg border overflow-hidden transition-all duration-300"
              style={{ width: PREVIEW_WIDTHS[previewSize], maxWidth: "100%", minHeight: "400px" }}
            >
              <BlockPreview blocks={blocks} />
            </div>
          </div>
        </div>
      </div>
  );
}

function BlockFieldEditor({
  fields,
  content,
  onChange,
}: {
  fields: BlockFieldDef[];
  content: Record<string, unknown>;
  onChange: (key: string, value: unknown) => void;
}) {
  return (
    <div className="space-y-4">
      {fields.map(field => (
        <div key={field.key} className="space-y-1.5">
          <Label className="text-xs font-medium">{field.label}</Label>
          {field.type === "text" && (
            <Input
              value={(content[field.key] as string) || ""}
              onChange={e => onChange(field.key, e.target.value)}
              placeholder={field.placeholder}
              className="h-8 text-sm"
            />
          )}
          {field.type === "textarea" && (
            <Textarea
              value={(content[field.key] as string) || ""}
              onChange={e => onChange(field.key, e.target.value)}
              placeholder={field.placeholder}
              rows={3}
              className="text-sm"
            />
          )}
          {field.type === "richtext" && (
            <Textarea
              value={(content[field.key] as string) || ""}
              onChange={e => onChange(field.key, e.target.value)}
              placeholder={field.placeholder}
              rows={6}
              className="text-sm font-mono"
            />
          )}
          {field.type === "url" && (
            <Input
              value={(content[field.key] as string) || ""}
              onChange={e => onChange(field.key, e.target.value)}
              placeholder={field.placeholder || "https://..."}
              className="h-8 text-sm"
            />
          )}
          {field.type === "image" && (
            <Input
              value={(content[field.key] as string) || ""}
              onChange={e => onChange(field.key, e.target.value)}
              placeholder="Image URL"
              className="h-8 text-sm"
            />
          )}
          {field.type === "number" && (
            <Input
              type="number"
              value={(content[field.key] as number) ?? field.defaultValue ?? ""}
              onChange={e => onChange(field.key, e.target.value ? Number(e.target.value) : "")}
              className="h-8 text-sm"
            />
          )}
          {field.type === "color" && (
            <div className="flex items-center gap-2">
              <div className="w-8 h-8 rounded border relative overflow-hidden" style={{ backgroundColor: (content[field.key] as string) || "#e5e7eb" }}>
                <input
                  type="color"
                  value={(content[field.key] as string) || "#e5e7eb"}
                  onChange={e => onChange(field.key, e.target.value)}
                  className="absolute inset-0 opacity-0 cursor-pointer"
                />
              </div>
              <Input
                value={(content[field.key] as string) || ""}
                onChange={e => onChange(field.key, e.target.value)}
                className="h-8 text-xs font-mono"
              />
            </div>
          )}
          {field.type === "toggle" && (
            <Switch
              checked={!!content[field.key]}
              onCheckedChange={val => onChange(field.key, val)}
            />
          )}
          {field.type === "select" && field.options && (
            <Select value={(content[field.key] as string) || ""} onValueChange={v => onChange(field.key, v)}>
              <SelectTrigger className="h-8 text-sm"><SelectValue placeholder="Select..." /></SelectTrigger>
              <SelectContent>
                {field.options.map(o => <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>)}
              </SelectContent>
            </Select>
          )}
          {field.type === "items" && field.itemFields && (
            <ItemsEditor
              items={(content[field.key] as Record<string, unknown>[]) || []}
              itemFields={field.itemFields}
              onChange={newItems => onChange(field.key, newItems)}
            />
          )}
        </div>
      ))}
    </div>
  );
}

function ItemsEditor({
  items,
  itemFields,
  onChange,
}: {
  items: Record<string, unknown>[];
  itemFields: BlockFieldDef[];
  onChange: (items: Record<string, unknown>[]) => void;
}) {
  const addItem = () => {
    const defaults: Record<string, unknown> = {};
    itemFields.forEach(f => { defaults[f.key] = f.defaultValue ?? ""; });
    onChange([...items, defaults]);
  };

  const removeItem = (idx: number) => {
    onChange(items.filter((_, i) => i !== idx));
  };

  const updateItem = (idx: number, key: string, value: unknown) => {
    onChange(items.map((item, i) => i === idx ? { ...item, [key]: value } : item));
  };

  return (
    <div className="space-y-2">
      {items.map((item, idx) => (
        <Card key={idx} className="bg-secondary/30">
          <CardContent className="p-3 space-y-2">
            <div className="flex items-center justify-between">
              <span className="text-xs font-medium text-muted-foreground">Item {idx + 1}</span>
              <Button variant="ghost" size="icon" className="h-5 w-5 text-red-500" onClick={() => removeItem(idx)}>
                <Trash2 className="w-3 h-3" />
              </Button>
            </div>
            {itemFields.map(f => (
              <div key={f.key} className="space-y-1">
                <Label className="text-[10px] text-muted-foreground">{f.label}</Label>
                {(f.type === "text" || f.type === "url" || f.type === "image") && (
                  <Input
                    value={(item[f.key] as string) || ""}
                    onChange={e => updateItem(idx, f.key, e.target.value)}
                    placeholder={f.placeholder}
                    className="h-7 text-xs"
                  />
                )}
                {f.type === "textarea" && (
                  <Textarea
                    value={(item[f.key] as string) || ""}
                    onChange={e => updateItem(idx, f.key, e.target.value)}
                    rows={2}
                    className="text-xs"
                  />
                )}
                {f.type === "number" && (
                  <Input
                    type="number"
                    value={(item[f.key] as number) ?? ""}
                    onChange={e => updateItem(idx, f.key, Number(e.target.value))}
                    className="h-7 text-xs"
                  />
                )}
              </div>
            ))}
          </CardContent>
        </Card>
      ))}
      <Button variant="outline" size="sm" className="w-full h-7 text-xs" onClick={addItem}>
        <Plus className="w-3 h-3 mr-1" /> Add Item
      </Button>
    </div>
  );
}

function GlobalBlockSelector({
  content,
  onChange,
}: {
  content: Record<string, unknown>;
  onChange: (key: string, value: unknown) => void;
}) {
  const { data: globalComponents = [] } = useQuery<{ id: number; name: string; slug: string; componentType: string; isActive: boolean }[]>({
    queryKey: ["website-global-components"],
    queryFn: () => customFetch("/api/website/global-components"),
  });

  const activeComponents = globalComponents.filter(c => c.isActive);
  const selectedId = content.globalComponentId as number | null;
  const selectedComp = activeComponents.find(c => c.id === selectedId);

  return (
    <div className="space-y-4">
      <div className="space-y-1.5">
        <Label className="text-xs font-medium">Global Component</Label>
        {activeComponents.length === 0 ? (
          <p className="text-xs text-muted-foreground py-2">
            No active global components. Create one in Website &gt; Global Components first.
          </p>
        ) : (
          <Select
            value={selectedId ? String(selectedId) : ""}
            onValueChange={v => {
              const comp = activeComponents.find(c => c.id === Number(v));
              if (comp) {
                onChange("globalComponentId", comp.id);
                onChange("globalComponentSlug", comp.slug);
              }
            }}
          >
            <SelectTrigger className="h-9">
              <SelectValue placeholder="Select a component..." />
            </SelectTrigger>
            <SelectContent>
              {activeComponents.map(c => (
                <SelectItem key={c.id} value={String(c.id)}>
                  {c.name} ({c.componentType.replace(/_/g, " ")})
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
      </div>
      {selectedComp && (
        <div className="p-3 rounded-lg bg-purple-50 dark:bg-purple-950/20 border border-purple-200 dark:border-purple-800">
          <p className="text-xs font-medium text-purple-700 dark:text-purple-300">{selectedComp.name}</p>
          <p className="text-[10px] text-purple-500 dark:text-purple-400 mt-0.5">
            Type: {selectedComp.componentType.replace(/_/g, " ")} | Slug: {selectedComp.slug}
          </p>
        </div>
      )}
    </div>
  );
}

function GlobalBlockPreview({ componentId, slug }: { componentId: number | null; slug: string }) {
  const { data: globalComponents } = useQuery<{ id: number; name: string; slug: string; componentType: string; content: Record<string, unknown>; isActive: boolean }[]>({
    queryKey: ["website-global-components"],
    queryFn: () => customFetch("/api/website/global-components"),
  });

  if (!componentId && !slug) {
    return (
      <div className="py-4 px-6 text-center bg-purple-50 dark:bg-purple-950/20 border-2 border-dashed border-purple-200 dark:border-purple-800">
        <p className="text-xs text-purple-500 font-medium">No global component selected</p>
      </div>
    );
  }

  const comp = globalComponents?.find(c => c.id === componentId || c.slug === slug);
  if (!comp) {
    return (
      <div className="py-4 px-6 text-center bg-amber-50 dark:bg-amber-950/20 border-2 border-dashed border-amber-300 dark:border-amber-700">
        <p className="text-xs text-amber-600 font-medium">Component not found: {slug || `ID ${componentId}`}</p>
      </div>
    );
  }

  if (!comp.isActive) {
    return (
      <div className="py-4 px-6 text-center bg-amber-50 dark:bg-amber-950/20 border-2 border-dashed border-amber-300 dark:border-amber-700">
        <p className="text-xs text-amber-600 font-medium">Inactive component: {comp.name}</p>
      </div>
    );
  }

  const raw = (comp.content || {}) as Record<string, unknown>;
  const s = (k: string) => (raw[k] as string) || "";

  switch (comp.componentType) {
    case "cta_banner":
      return (
        <div className="relative py-10 px-8 text-center text-white" style={{ backgroundColor: s("backgroundColor") || "#2563eb" }}>
          {s("backgroundImage") && (
            <div className="absolute inset-0 bg-cover bg-center opacity-30" style={{ backgroundImage: `url(${s("backgroundImage")})` }} />
          )}
          <div className="relative z-10">
            <h2 className="text-2xl font-bold mb-2">{s("heading") || "CTA Heading"}</h2>
            {s("body") && <p className="text-sm opacity-90 mb-4 max-w-lg mx-auto">{s("body")}</p>}
            {s("buttonText") && (
              <span className="inline-block px-5 py-2 bg-white text-blue-600 rounded-lg font-medium text-sm">
                {s("buttonText")}
              </span>
            )}
          </div>
        </div>
      );

    case "stats_strip": {
      const items = (raw.items as { value: string; label: string }[]) || [];
      return (
        <div className="py-6 px-4 bg-gray-50 dark:bg-gray-900">
          <div className="flex justify-center gap-8 flex-wrap">
            {items.map((item, i) => (
              <div key={i} className="text-center">
                <div className="text-2xl font-bold text-primary">{item.value || "—"}</div>
                <div className="text-xs text-muted-foreground mt-1">{item.label || "Label"}</div>
              </div>
            ))}
          </div>
        </div>
      );
    }

    case "testimonials": {
      const items = (raw.items as { quote: string; author: string; role: string; avatar?: string }[]) || [];
      return (
        <div className="py-6 px-6">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {items.slice(0, 4).map((item, i) => (
              <div key={i} className="p-4 bg-gray-50 dark:bg-gray-900 rounded-lg border">
                <p className="text-sm italic text-muted-foreground mb-3">"{item.quote || "Quote..."}"</p>
                <div className="flex items-center gap-2">
                  {item.avatar && <img src={item.avatar} alt="" className="w-8 h-8 rounded-full object-cover" />}
                  <div>
                    <p className="text-xs font-medium">{item.author || "Author"}</p>
                    {item.role && <p className="text-[10px] text-muted-foreground">{item.role}</p>}
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      );
    }

    case "contact_strip":
      return (
        <div className="py-6 px-6 bg-gray-50 dark:bg-gray-900">
          <div className="flex flex-wrap justify-center gap-6 text-sm">
            {s("phone") && <span>Tel: {s("phone")}</span>}
            {s("email") && <span>Email: {s("email")}</span>}
            {s("whatsapp") && <span>WhatsApp: {s("whatsapp")}</span>}
            {s("address") && <span>{s("address")}</span>}
          </div>
        </div>
      );

    case "logo_grid": {
      const items = (raw.items as { name: string; imageUrl: string }[]) || [];
      const cols = (raw.columns as number) || 4;
      return (
        <div className="py-6 px-6">
          <div className="grid gap-4" style={{ gridTemplateColumns: `repeat(${cols}, 1fr)` }}>
            {items.map((item, i) => (
              <div key={i} className="flex items-center justify-center p-3 border rounded-lg bg-white dark:bg-gray-900 min-h-[60px]">
                {item.imageUrl ? (
                  <img src={item.imageUrl} alt={item.name} className="max-h-10 max-w-full object-contain" />
                ) : (
                  <span className="text-xs text-muted-foreground">{item.name || "Logo"}</span>
                )}
              </div>
            ))}
          </div>
        </div>
      );
    }

    case "custom_html":
      return (
        <div className="py-4 px-6 bg-gray-50 dark:bg-gray-900 border-l-4 border-purple-400">
          <p className="text-[10px] text-purple-500 font-medium mb-1">Custom HTML: {comp.name}</p>
          <div className="text-xs text-muted-foreground truncate">{s("html").slice(0, 120) || "(empty)"}...</div>
        </div>
      );

    default:
      return (
        <div className="py-4 px-6 text-center bg-purple-50 dark:bg-purple-950/20 border-2 border-dashed border-purple-200 dark:border-purple-800">
          <p className="text-xs text-purple-600 font-medium">{comp.name} ({comp.componentType})</p>
        </div>
      );
  }
}

function BlockPreview({ blocks }: { blocks: PageBlock[] }) {
  const visibleBlocks = blocks.filter(b => b.isVisible);

  if (visibleBlocks.length === 0) {
    return (
      <div className="flex items-center justify-center h-96 text-muted-foreground text-sm">
        Add blocks to see a preview
      </div>
    );
  }

  return (
    <div className="divide-y">
      {visibleBlocks.map((block, idx) => (
        <div key={idx} className="relative">
          <div className="absolute top-1 right-1 z-10">
            <Badge variant="outline" className="text-[9px] bg-white/80 dark:bg-card/80">
              {getBlockTypeDef(block.blockType)?.label || block.blockType}
            </Badge>
          </div>
          <BlockPreviewItem block={block} />
        </div>
      ))}
    </div>
  );
}

function BlockPreviewItem({ block }: { block: PageBlock }) {
  const c = block.content as Record<string, string | number | boolean | Record<string, unknown>[] | null>;

  switch (block.blockType) {
    case "hero":
      return (
        <div className="relative py-16 px-6 text-center bg-gradient-to-br from-blue-50 to-indigo-50 dark:from-blue-950/30 dark:to-indigo-950/30">
          {c.badge && <span className="inline-block px-3 py-1 rounded-full bg-blue-100 dark:bg-blue-900 text-blue-700 dark:text-blue-300 text-xs font-medium mb-4">{c.badge as string}</span>}
          <h1 className="text-2xl font-bold mb-2">{(c.title as string) || "Hero Title"}</h1>
          {c.subtitle && <p className="text-sm text-gray-600 dark:text-gray-400 mb-4">{c.subtitle as string}</p>}
          <div className="flex gap-2 justify-center">
            {c.ctaLabel && <span className="inline-block px-4 py-2 bg-blue-600 text-white rounded-lg text-xs font-medium">{c.ctaLabel as string}</span>}
            {c.secondaryLabel && <span className="inline-block px-4 py-2 border rounded-lg text-xs font-medium">{c.secondaryLabel as string}</span>}
          </div>
        </div>
      );

    case "rich_text":
      return (
        <div className="p-6 prose prose-sm max-w-none dark:prose-invert" dangerouslySetInnerHTML={{ __html: sanitizeHtml((c.content as string) || "") }} />
      );

    case "stats_strip":
      return (
        <div className={`py-8 px-6 ${c.bgColor === "primary" ? "bg-blue-600 text-white" : "bg-gray-50 dark:bg-gray-900"}`}>
          <div className="grid grid-cols-4 gap-4 text-center">
            {((c.stats as { value: string; label: string }[]) || []).map((s, i) => (
              <div key={i}>
                <p className="text-xl font-bold">{s.value}</p>
                <p className={`text-xs ${c.bgColor === "primary" ? "text-white/70" : "text-gray-500"}`}>{s.label}</p>
              </div>
            ))}
          </div>
        </div>
      );

    case "feature_cards":
    case "icon_cards":
      return (
        <div className="py-8 px-6">
          {c.title && <h2 className="text-lg font-bold text-center mb-1">{c.title as string}</h2>}
          {c.subtitle && <p className="text-sm text-gray-500 text-center mb-4">{c.subtitle as string}</p>}
          <div className={`grid gap-3 ${c.columns === "2" ? "grid-cols-2" : c.columns === "4" ? "grid-cols-4" : "grid-cols-3"}`}>
            {((c.cards as { title: string; description: string }[]) || []).map((card, i) => (
              <div key={i} className="p-4 rounded-xl border bg-white dark:bg-card">
                <h3 className="text-sm font-semibold mb-1">{card.title}</h3>
                <p className="text-xs text-gray-500">{card.description}</p>
              </div>
            ))}
          </div>
        </div>
      );

    case "cta_banner":
      return (
        <div className={`py-10 px-6 text-center ${c.bgStyle === "gradient" ? "bg-gradient-to-r from-blue-600 to-indigo-600 text-white" : c.bgStyle === "solid" ? "bg-blue-600 text-white" : "bg-gray-100 dark:bg-gray-800"}`}>
          <h2 className="text-lg font-bold mb-2">{(c.title as string) || "CTA Title"}</h2>
          {c.subtitle && <p className={`text-sm mb-4 ${c.bgStyle !== "image" ? "text-white/80" : "text-gray-600"}`}>{c.subtitle as string}</p>}
          <div className="flex gap-2 justify-center">
            {c.ctaLabel && <span className="inline-block px-4 py-2 bg-white text-blue-600 rounded-lg text-xs font-medium">{c.ctaLabel as string}</span>}
          </div>
        </div>
      );

    case "faq":
      return (
        <div className="py-8 px-6">
          {c.title && <h2 className="text-lg font-bold text-center mb-4">{c.title as string}</h2>}
          <div className="space-y-2 max-w-xl mx-auto">
            {((c.items as { question: string; answer: string }[]) || []).map((item, i) => (
              <div key={i} className="p-3 rounded-lg border">
                <p className="text-sm font-medium">{item.question}</p>
                <p className="text-xs text-gray-500 mt-1">{item.answer}</p>
              </div>
            ))}
          </div>
        </div>
      );

    case "team_grid":
      return (
        <div className="py-8 px-6">
          {c.title && <h2 className="text-lg font-bold text-center mb-4">{c.title as string}</h2>}
          <div className="grid grid-cols-4 gap-3">
            {((c.members as { name: string; role: string }[]) || []).map((m, i) => (
              <div key={i} className="text-center p-3">
                <div className="w-12 h-12 rounded-full bg-blue-100 dark:bg-blue-900 mx-auto mb-2 flex items-center justify-center text-sm font-bold text-blue-600">{m.name?.[0]}</div>
                <p className="text-xs font-medium">{m.name}</p>
                <p className="text-[10px] text-gray-500">{m.role}</p>
              </div>
            ))}
            {((c.members as unknown[]) || []).length === 0 && <p className="col-span-4 text-center text-xs text-gray-400">Team members from collections</p>}
          </div>
        </div>
      );

    case "office_list":
      return (
        <div className="py-8 px-6">
          {c.title && <h2 className="text-lg font-bold text-center mb-4">{c.title as string}</h2>}
          <div className="grid grid-cols-2 gap-3">
            {((c.offices as { name: string; city: string; address: string }[]) || []).map((o, i) => (
              <div key={i} className="p-3 rounded-lg border">
                <p className="text-sm font-semibold">{o.name}</p>
                <p className="text-xs text-gray-500">{o.city}</p>
              </div>
            ))}
            {((c.offices as unknown[]) || []).length === 0 && <p className="col-span-2 text-center text-xs text-gray-400">Offices from collections</p>}
          </div>
        </div>
      );

    case "logo_grid":
      return (
        <div className="py-8 px-6">
          {c.title && <h2 className="text-lg font-bold text-center mb-4">{c.title as string}</h2>}
          <div className="flex flex-wrap gap-4 justify-center">
            {((c.logos as { name: string; imageUrl: string }[]) || []).map((l, i) => (
              <div key={i} className="w-20 h-12 rounded border flex items-center justify-center text-xs text-gray-400 bg-gray-50 dark:bg-gray-800">
                {l.imageUrl ? <img src={l.imageUrl} alt={l.name} className="max-h-10 max-w-16 object-contain" /> : l.name}
              </div>
            ))}
            {((c.logos as unknown[]) || []).length === 0 && <p className="text-xs text-gray-400">Add logos to display</p>}
          </div>
        </div>
      );

    case "testimonials":
      return (
        <div className="py-8 px-6">
          {c.title && <h2 className="text-lg font-bold text-center mb-4">{c.title as string}</h2>}
          <div className={c.layout === "grid" ? "grid grid-cols-2 gap-3" : "space-y-3"}>
            {((c.items as { name: string; content: string; role: string }[]) || []).map((t, i) => (
              <div key={i} className="p-3 rounded-lg border bg-white dark:bg-card">
                <p className="text-xs italic text-gray-600 dark:text-gray-400 mb-2">"{t.content}"</p>
                <p className="text-xs font-medium">{t.name}</p>
                {t.role && <p className="text-[10px] text-gray-500">{t.role}</p>}
              </div>
            ))}
            {((c.items as unknown[]) || []).length === 0 && <p className="text-center text-xs text-gray-400">Testimonials from collections</p>}
          </div>
        </div>
      );

    case "section_title": {
      const alignCls = c.alignment === "left" ? "text-left" : c.alignment === "right" ? "text-right" : "text-center";
      return (
        <div className={`py-6 px-6 ${alignCls}`}>
          <h2 className={`font-bold ${c.size === "lg" ? "text-2xl" : c.size === "sm" ? "text-base" : "text-lg"}`}>{(c.title as string) || "Section Title"}</h2>
          {c.subtitle && <p className="text-sm text-gray-500 mt-1">{c.subtitle as string}</p>}
        </div>
      );
    }

    case "spacer_divider":
      return (
        <div style={{ height: `${(c.height as number) || 48}px` }} className="flex items-center justify-center">
          {c.showDivider && <hr className="w-full border-t" style={{ borderColor: (c.dividerColor as string) || "#e5e7eb" }} />}
        </div>
      );

    case "global_block":
      return <GlobalBlockPreview componentId={c.globalComponentId as number | null} slug={c.globalComponentSlug as string} />;

    default:
      return (
        <div className="py-6 px-6 text-center text-sm text-gray-400">
          Unknown block type: {block.blockType}
        </div>
      );
  }
}
