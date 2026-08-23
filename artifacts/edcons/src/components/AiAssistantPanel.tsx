import { useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { customFetch } from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/hooks/use-toast";
import { useI18n } from "@/hooks/use-i18n";
import {
  Sparkles, Loader2, Wand2, Type, FileText, MessageSquare,
  Maximize2, Minimize2, ArrowRight, HelpCircle,
} from "lucide-react";

interface AiAction {
  key: string;
  labelKey: string;
  icon: typeof Type;
  needsContext?: boolean;
}

const AI_ACTIONS: AiAction[] = [
  { key: "generateMetaTitle", labelKey: "aiAssistant.actionMetaTitle", icon: Type },
  { key: "generateMetaDescription", labelKey: "aiAssistant.actionMetaDescription", icon: FileText },
  { key: "generateExcerpt", labelKey: "aiAssistant.actionExcerpt", icon: MessageSquare },
  { key: "generateHeroTitle", labelKey: "aiAssistant.actionHeroTitle", icon: Wand2, needsContext: true },
  { key: "generateCTAText", labelKey: "aiAssistant.actionCtaText", icon: ArrowRight, needsContext: true },
  { key: "generateOGText", labelKey: "aiAssistant.actionOgText", icon: FileText, needsContext: true },
  { key: "generateBlogOutline", labelKey: "aiAssistant.actionBlogOutline", icon: FileText, needsContext: true },
  { key: "generateAltText", labelKey: "aiAssistant.actionAltText", icon: Type, needsContext: true },
  { key: "improveTone", labelKey: "aiAssistant.actionImproveTone", icon: Sparkles, needsContext: true },
  { key: "shortenText", labelKey: "aiAssistant.actionShorten", icon: Minimize2, needsContext: true },
  { key: "expandText", labelKey: "aiAssistant.actionExpand", icon: Maximize2, needsContext: true },
  { key: "generateFAQItems", labelKey: "aiAssistant.actionGenerateFaq", icon: HelpCircle, needsContext: true },
];

interface AiAssistantPanelProps {
  context?: string;
  locale?: string;
  onResult?: (action: string, result: string) => void;
  compact?: boolean;
}

export function AiAssistantPanel({ context: defaultContext, locale, onResult, compact }: AiAssistantPanelProps) {
  const { toast } = useToast();
  const { t } = useI18n();
  const [contextInput, setContextInput] = useState(defaultContext || "");
  const [result, setResult] = useState("");
  const [lastAction, setLastAction] = useState("");

  const { data: aiStatus } = useQuery<{ configured: boolean; provider: string | null }>({
    queryKey: ["/api/website/ai/status"],
    queryFn: () => customFetch("/api/website/ai/status"),
    staleTime: 60000,
  });

  const generateMutation = useMutation({
    mutationFn: (payload: { action: string; context: string; locale?: string }) =>
      customFetch("/api/website/ai/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      }),
    onSuccess: (data: unknown) => {
      const d = data as { result: string; action: string };
      setResult(d.result);
      setLastAction(d.action);
    },
    onError: (e: Error) => toast({ title: t("aiAssistant.aiError"), description: e.message, variant: "destructive" }),
  });

  const configured = aiStatus?.configured ?? false;

  function handleAction(action: AiAction) {
    const ctx = action.needsContext ? contextInput : (contextInput || defaultContext || "website content");
    if (action.needsContext && !ctx.trim()) {
      toast({ title: t("aiAssistant.provideContextTitle"), description: t("aiAssistant.provideContextDesc"), variant: "destructive" });
      return;
    }
    generateMutation.mutate({ action: action.key, context: ctx, locale });
  }

  function handleApply() {
    if (result && onResult && lastAction) {
      onResult(lastAction, result);
      toast({ title: t("aiAssistant.applied") });
    }
  }

  if (compact) {
    return (
      <div className="flex items-center gap-2">
        <Badge variant={configured ? "default" : "secondary"} className="text-[10px] gap-1">
          <Sparkles className="w-3 h-3" /> {configured ? t("aiAssistant.aiReady") : t("aiAssistant.aiNotConfigured")}
        </Badge>
        {!configured && (
          <span className="text-[10px] text-muted-foreground">{t("aiAssistant.configureAiHint")}</span>
        )}
      </div>
    );
  }

  return (
    <div className="border rounded-xl p-4 space-y-3 bg-gradient-to-b from-violet-50/50 to-background">
      <div className="flex items-center justify-between">
        <h4 className="text-sm font-semibold flex items-center gap-1.5">
          <Sparkles className="w-4 h-4 text-violet-600" /> {t("aiAssistant.title")}
        </h4>
        <Badge variant={configured ? "default" : "secondary"} className="text-[10px]">
          {configured ? t("aiAssistant.connected", { provider: aiStatus?.provider || "AI" }) : t("aiAssistant.notConfigured")}
        </Badge>
      </div>

      {!configured && (
        <div className="text-sm text-muted-foreground bg-muted/50 rounded-lg p-3">
          <p className="font-medium">{t("aiAssistant.notConfiguredTitle")}</p>
          <p className="text-xs mt-1">{t("aiAssistant.notConfiguredHint")}</p>
        </div>
      )}

          <div>
            <Textarea
              value={contextInput}
              onChange={e => setContextInput(e.target.value)}
              placeholder={t("aiAssistant.contextPlaceholder")}
              rows={2}
              className="text-xs"
              disabled={!configured}
            />
          </div>

          <div className="flex flex-wrap gap-1.5">
            {AI_ACTIONS.map(action => (
              <Button
                key={action.key}
                variant="outline"
                size="sm"
                className="text-[11px] h-7 gap-1"
                disabled={!configured || generateMutation.isPending}
                onClick={() => handleAction(action)}
              >
                <action.icon className="w-3 h-3" /> {t(action.labelKey)}
              </Button>
            ))}
          </div>

          {generateMutation.isPending && (
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <Loader2 className="w-3 h-3 animate-spin" /> {t("aiAssistant.generating")}
            </div>
          )}

          {result && (
            <div className="space-y-2">
              <div className="bg-white border rounded-lg p-3">
                <p className="text-xs text-muted-foreground mb-1">{t("aiAssistant.result")}</p>
                <p className="text-sm whitespace-pre-wrap">{result}</p>
              </div>
              {onResult && (
                <Button size="sm" className="text-xs gap-1" onClick={handleApply}>
                  <Wand2 className="w-3 h-3" /> {t("aiAssistant.applyToField")}
                </Button>
              )}
            </div>
          )}
    </div>
  );
}

interface AiFieldButtonProps {
  action: string;
  context: string;
  locale?: string;
  onResult: (result: string) => void;
  label?: string;
}

export function AiFieldButton({ action, context, locale, onResult, label }: AiFieldButtonProps) {
  const { toast } = useToast();
  const { t } = useI18n();

  const { data: aiStatus } = useQuery<{ configured: boolean }>({
    queryKey: ["/api/website/ai/status"],
    queryFn: () => customFetch("/api/website/ai/status"),
    staleTime: 60000,
  });

  const generateMutation = useMutation({
    mutationFn: () =>
      customFetch("/api/website/ai/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, context, locale }),
      }),
    onSuccess: (data: unknown) => {
      const d = data as { result: string };
      onResult(d.result);
    },
    onError: (e: Error) => toast({ title: t("aiAssistant.aiError"), description: e.message, variant: "destructive" }),
  });

  const configured = aiStatus?.configured ?? false;

  return (
    <Button
      variant="ghost"
      size="sm"
      className="text-[10px] h-6 gap-1 text-violet-600 hover:text-violet-700"
      disabled={!configured || generateMutation.isPending}
      onClick={() => generateMutation.mutate()}
      title={configured ? t("aiAssistant.aiLabelTooltip", { label: label || action }) : t("aiAssistant.configureAiHint")}
    >
      {generateMutation.isPending ? <Loader2 className="w-3 h-3 animate-spin" /> : <Sparkles className="w-3 h-3" />}
      {label || t("aiAssistant.ai")}
    </Button>
  );
}
