import { useState, useEffect, useRef } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { customFetch } from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Palette, Save, RotateCcw } from "lucide-react";
import { useToast } from "@/hooks/use-toast";

interface ThemeToken {
  id?: number;
  tokenGroup: string;
  tokenKey: string;
  tokenValue: string;
  description?: string;
}

interface BrandingDefaults {
  themePrimary: string | null;
  themeButton: string | null;
  themeHover: string | null;
  themeSecondary?: string | null;
  themeAccent?: string | null;
}

const COLOR_TOKENS = [
  { group: "colors", key: "primary", label: "Primary", description: "Main brand color" },
  { group: "colors", key: "secondary", label: "Secondary", description: "Secondary brand color" },
  { group: "colors", key: "accent", label: "Accent", description: "Accent / highlight color" },
  { group: "colors", key: "background", label: "Background", description: "Page background" },
  { group: "colors", key: "card", label: "Card Background", description: "Card surface color" },
  { group: "colors", key: "border", label: "Border", description: "Default border color" },
  { group: "colors", key: "text", label: "Text", description: "Primary text color" },
  { group: "colors", key: "muted", label: "Muted Text", description: "Secondary text" },
];

const TYPOGRAPHY_TOKENS = [
  { group: "typography", key: "headingFont", label: "Heading Font", type: "font" as const },
  { group: "typography", key: "bodyFont", label: "Body Font", type: "font" as const },
  { group: "typography", key: "fontScale", label: "Font Scale", type: "scale" as const },
];

const BUTTON_TOKENS = [
  { group: "buttons", key: "borderRadius", label: "Border Radius", type: "radius" as const },
  { group: "buttons", key: "fontWeight", label: "Font Weight", type: "weight" as const },
  { group: "buttons", key: "primaryBg", label: "Primary Button BG", type: "color" as const },
  { group: "buttons", key: "primaryText", label: "Primary Button Text", type: "color" as const },
];

const SPACING_TOKENS = [
  { group: "spacing", key: "sectionPadding", label: "Section Padding", type: "px" as const },
  { group: "spacing", key: "cardPadding", label: "Card Padding", type: "px" as const },
  { group: "spacing", key: "containerMax", label: "Container Max Width", type: "px" as const },
  { group: "spacing", key: "gridGap", label: "Grid Gap", type: "px" as const },
];

const FONT_OPTIONS = [
  "Inter", "Poppins", "Roboto", "Open Sans", "Lato", "Montserrat", "Playfair Display",
  "Merriweather", "Nunito", "Raleway", "Source Sans Pro", "DM Sans",
];

const FONT_SCALE_OPTIONS = [
  { label: "Small (0.875)", value: "0.875" },
  { label: "Normal (1)", value: "1" },
  { label: "Large (1.125)", value: "1.125" },
  { label: "Extra Large (1.25)", value: "1.25" },
];

const WEIGHT_OPTIONS = [
  { label: "Normal (400)", value: "400" },
  { label: "Medium (500)", value: "500" },
  { label: "Semibold (600)", value: "600" },
  { label: "Bold (700)", value: "700" },
];

const RADIUS_OPTIONS = [
  { label: "None (0)", value: "0" },
  { label: "Small (4px)", value: "4" },
  { label: "Medium (8px)", value: "8" },
  { label: "Large (12px)", value: "12" },
  { label: "XL (16px)", value: "16" },
  { label: "Full (9999px)", value: "9999" },
];

export default function WebsiteThemeBuilder() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [localTokens, setLocalTokens] = useState<Record<string, string>>({});
  const [dirty, setDirty] = useState(false);

  const { data: branding } = useQuery<BrandingDefaults>({
    queryKey: ["settings-branding"],
    queryFn: () => customFetch("/api/settings/branding"),
  });

  const { data: savedTokens, isLoading: tokensLoading } = useQuery<ThemeToken[]>({
    queryKey: ["website-theme-tokens"],
    queryFn: () => customFetch("/api/website/theme-tokens"),
  });

  const tokensHydrated = useRef(false);
  useEffect(() => {
    if (tokensHydrated.current || tokensLoading || !savedTokens) return;
    const map: Record<string, string> = {};
    savedTokens.forEach(t => { map[`${t.tokenGroup}.${t.tokenKey}`] = t.tokenValue; });
    setLocalTokens(map);
    tokensHydrated.current = true;
  }, [savedTokens, tokensLoading]);

  const saveMutation = useMutation({
    mutationFn: async (tokens: { tokenGroup: string; tokenKey: string; tokenValue: string | null; description?: string }[]) => {
      return customFetch("/api/website/theme-tokens/batch", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tokens }),
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["website-theme-tokens"] });
      setDirty(false);
      toast({ title: "Theme saved", description: "Your theme tokens have been updated." });
    },
    onError: () => {
      toast({ title: "Error", description: "Failed to save theme tokens.", variant: "destructive" });
    },
  });

  function getVal(group: string, key: string): string {
    const k = `${group}.${key}`;
    if (localTokens[k] !== undefined) return localTokens[k];
    if (group === "colors") {
      const brandMap: Record<string, string | null | undefined> = {
        primary: branding?.themePrimary,
        secondary: branding?.themeSecondary,
        accent: branding?.themeAccent,
      };
      if (brandMap[key]) return brandMap[key]!;
    }
    if (group === "buttons") {
      const buttonMap: Record<string, string | null | undefined> = {
        primaryBg: branding?.themePrimary,
        primaryText: "#ffffff",
      };
      if (buttonMap[key]) return buttonMap[key]!;
    }
    return "";
  }

  function setVal(group: string, key: string, value: string) {
    setLocalTokens(prev => ({ ...prev, [`${group}.${key}`]: value }));
    setDirty(true);
  }

  function handleSave() {
    const allTokenKeys = [
      ...COLOR_TOKENS.map(t => ({ group: t.group, key: t.key })),
      ...TYPOGRAPHY_TOKENS.map(t => ({ group: t.group, key: t.key })),
      ...BUTTON_TOKENS.map(t => ({ group: t.group, key: t.key })),
      ...SPACING_TOKENS.map(t => ({ group: t.group, key: t.key })),
    ];
    const tokens = allTokenKeys.map(({ group, key }) => {
      const val = localTokens[`${group}.${key}`];
      return { tokenGroup: group, tokenKey: key, tokenValue: val || null };
    });
    saveMutation.mutate(tokens);
  }

  const resetMutation = useMutation({
    mutationFn: () =>
      customFetch("/api/website/theme-tokens/all", { method: "DELETE" }),
    onSuccess: () => {
      setLocalTokens({});
      setDirty(false);
      queryClient.setQueryData(["website-theme-tokens"], []);
      toast({ title: "Theme reset", description: "All overrides removed. Branding defaults will be used." });
    },
    onError: () => {
      toast({ title: "Error", description: "Failed to reset theme.", variant: "destructive" });
    },
  });

  function handleReset() {
    resetMutation.mutate();
  }

  function selectVal(group: string, key: string): string | undefined {
    const v = getVal(group, key);
    return v || undefined;
  }

  return (
      <div className="max-w-5xl mx-auto p-6 space-y-6">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <Palette className="w-6 h-6 text-primary" />
            <div>
              <h1 className="text-2xl font-bold">Theme Builder</h1>
              <p className="text-sm text-muted-foreground">
                Customize your website appearance. Inherits from Settings &gt; Branding as defaults.
              </p>
            </div>
          </div>
          <div className="flex gap-2">
            <Button variant="outline" size="sm" onClick={handleReset} disabled={resetMutation.isPending}>
              <RotateCcw className="w-4 h-4 mr-1" /> {resetMutation.isPending ? "Resetting..." : "Reset to Defaults"}
            </Button>
            <Button size="sm" onClick={handleSave} disabled={!dirty || saveMutation.isPending}>
              <Save className="w-4 h-4 mr-1" /> {saveMutation.isPending ? "Saving..." : "Save Theme"}
            </Button>
          </div>
        </div>

        {dirty && (
          <div className="bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-800 rounded-lg px-4 py-2 text-sm text-amber-700 dark:text-amber-300">
            You have unsaved changes.
          </div>
        )}

        <Card>
          <CardHeader>
            <CardTitle className="text-lg">Colors</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
              {COLOR_TOKENS.map(token => {
                const val = getVal(token.group, token.key);
                return (
                  <div key={token.key} className="space-y-2">
                    <Label className="text-xs font-medium">{token.label}</Label>
                    <div className="flex items-center gap-2">
                      <div
                        className="w-10 h-10 rounded-lg border-2 border-border shadow-sm shrink-0 cursor-pointer relative overflow-hidden"
                        style={{ backgroundColor: val || "#e5e7eb" }}
                      >
                        <input
                          type="color"
                          value={val || "#e5e7eb"}
                          onChange={e => setVal(token.group, token.key, e.target.value)}
                          className="absolute inset-0 opacity-0 cursor-pointer w-full h-full"
                        />
                      </div>
                      <Input
                        value={val}
                        onChange={e => setVal(token.group, token.key, e.target.value)}
                        placeholder={token.description}
                        className="h-8 text-xs font-mono"
                      />
                    </div>
                    {branding && (token.key === "primary" || token.key === "secondary" || token.key === "accent") && (
                      <p className="text-[10px] text-muted-foreground">
                        Branding default: {(branding as unknown as Record<string, string | null>)[`theme${token.key.charAt(0).toUpperCase() + token.key.slice(1)}`] || "—"}
                      </p>
                    )}
                  </div>
                );
              })}
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-lg">Typography</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
              {TYPOGRAPHY_TOKENS.map(token => (
                <div key={token.key} className="space-y-2">
                  <Label className="text-xs font-medium">{token.label}</Label>
                  {token.type === "font" ? (
                    <Select value={selectVal(token.group, token.key)} onValueChange={v => setVal(token.group, token.key, v)}>
                      <SelectTrigger className="h-9"><SelectValue placeholder="Select font..." /></SelectTrigger>
                      <SelectContent>
                        {FONT_OPTIONS.map(f => (
                          <SelectItem key={f} value={f}><span style={{ fontFamily: f }}>{f}</span></SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  ) : (
                    <Select value={selectVal(token.group, token.key)} onValueChange={v => setVal(token.group, token.key, v)}>
                      <SelectTrigger className="h-9"><SelectValue placeholder="Select scale..." /></SelectTrigger>
                      <SelectContent>
                        {FONT_SCALE_OPTIONS.map(o => (
                          <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  )}
                  {getVal(token.group, token.key) && token.type === "font" && (
                    <p className="text-sm" style={{ fontFamily: getVal(token.group, token.key) }}>
                      The quick brown fox jumps over the lazy dog.
                    </p>
                  )}
                </div>
              ))}
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-lg">Buttons</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-6">
              {BUTTON_TOKENS.map(token => (
                <div key={token.key} className="space-y-2">
                  <Label className="text-xs font-medium">{token.label}</Label>
                  {token.type === "color" ? (
                    <div className="flex items-center gap-2">
                      <div
                        className="w-8 h-8 rounded border-2 border-border shrink-0 relative overflow-hidden"
                        style={{ backgroundColor: getVal(token.group, token.key) || "#e5e7eb" }}
                      >
                        <input
                          type="color"
                          value={getVal(token.group, token.key) || "#3b82f6"}
                          onChange={e => setVal(token.group, token.key, e.target.value)}
                          className="absolute inset-0 opacity-0 cursor-pointer"
                        />
                      </div>
                      <Input value={getVal(token.group, token.key)} onChange={e => setVal(token.group, token.key, e.target.value)} className="h-8 text-xs font-mono" />
                    </div>
                  ) : token.type === "radius" ? (
                    <Select value={selectVal(token.group, token.key)} onValueChange={v => setVal(token.group, token.key, v)}>
                      <SelectTrigger className="h-9"><SelectValue placeholder="Select..." /></SelectTrigger>
                      <SelectContent>
                        {RADIUS_OPTIONS.map(o => (<SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>))}
                      </SelectContent>
                    </Select>
                  ) : (
                    <Select value={selectVal(token.group, token.key)} onValueChange={v => setVal(token.group, token.key, v)}>
                      <SelectTrigger className="h-9"><SelectValue placeholder="Select..." /></SelectTrigger>
                      <SelectContent>
                        {WEIGHT_OPTIONS.map(o => (<SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>))}
                      </SelectContent>
                    </Select>
                  )}
                </div>
              ))}
            </div>
            {(getVal("buttons", "borderRadius") || getVal("buttons", "primaryBg")) && (
              <div className="mt-4 flex gap-3">
                <Button
                  variant="ghost"
                  className="px-6 py-2 text-sm font-medium hover:opacity-90"
                  style={{
                    backgroundColor: getVal("buttons", "primaryBg") || "#3b82f6",
                    color: getVal("buttons", "primaryText") || "#ffffff",
                    borderRadius: `${getVal("buttons", "borderRadius") || 8}px`,
                    fontWeight: getVal("buttons", "fontWeight") || "600",
                  }}
                >
                  Preview Button
                </Button>
              </div>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-lg">Spacing</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-6">
              {SPACING_TOKENS.map(token => (
                <div key={token.key} className="space-y-2">
                  <Label className="text-xs font-medium">{token.label}</Label>
                  <div className="flex items-center gap-2">
                    <Input
                      type="number"
                      value={getVal(token.group, token.key)}
                      onChange={e => setVal(token.group, token.key, e.target.value)}
                      placeholder="px"
                      className="h-8 text-xs"
                    />
                    <span className="text-xs text-muted-foreground">px</span>
                  </div>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      </div>
  );
}
