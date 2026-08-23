import { Sparkles, Loader2, RefreshCw, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useI18n } from "@/hooks/use-i18n";
import type { ConversationAiSummary } from "@workspace/api-client-react";

interface AiSummaryCardProps {
  summary: ConversationAiSummary | null;
  hasLink: boolean;
  hasMessages: boolean;
  isSummarizing: boolean;
  onSummarize: () => void;
  onDismiss?: () => void;
}

function formatRelative(iso: string, locale: string): string {
  const target = new Date(iso).getTime();
  if (!Number.isFinite(target)) return "";
  const diffMs = target - Date.now();
  const absSec = Math.abs(diffMs) / 1000;
  const rtf = new Intl.RelativeTimeFormat(locale, { numeric: "auto" });
  const units: Array<[Intl.RelativeTimeFormatUnit, number]> = [
    ["year", 60 * 60 * 24 * 365],
    ["month", 60 * 60 * 24 * 30],
    ["day", 60 * 60 * 24],
    ["hour", 60 * 60],
    ["minute", 60],
  ];
  for (const [unit, secs] of units) {
    if (absSec >= secs) {
      return rtf.format(Math.round(diffMs / 1000 / secs), unit);
    }
  }
  return rtf.format(Math.round(diffMs / 1000), "second");
}

export function AiSummaryCard({
  summary,
  hasLink,
  hasMessages,
  isSummarizing,
  onSummarize,
  onDismiss,
}: AiSummaryCardProps) {
  const { t, lang } = useI18n();
  const disabled = !hasLink || !hasMessages || isSummarizing;

  if (!summary) {
    return (
      <div
        className="rounded-md border bg-background/60 p-2.5 flex items-center justify-between gap-2"
        data-testid="ai-summary-card-empty"
      >
        <div className="flex items-center gap-1.5 text-xs text-muted-foreground min-w-0">
          <Sparkles className="w-3.5 h-3.5 shrink-0" />
          <span className="truncate">{t("inbox.aiSummary.title")}</span>
        </div>
        <Button
          size="sm"
          variant="outline"
          className="h-7 text-xs px-2 gap-1 shrink-0"
          onClick={onSummarize}
          disabled={disabled}
          data-testid="ai-summary-generate"
        >
          {isSummarizing ? (
            <>
              <Loader2 className="w-3 h-3 animate-spin" />
              {t("inbox.aiSummary.generating")}
            </>
          ) : (
            t("inbox.aiSummary.generate")
          )}
        </Button>
      </div>
    );
  }

  return (
    <div
      className="rounded-md border bg-background/60 p-2.5 space-y-2"
      data-testid="ai-summary-card"
    >
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-1.5 text-xs font-medium min-w-0">
          <Sparkles className="w-3.5 h-3.5 shrink-0 text-primary" />
          <span className="truncate">{t("inbox.aiSummary.title")}</span>
        </div>
        <div className="flex items-center gap-0.5 shrink-0">
          <Button
            size="sm"
            variant="ghost"
            className="h-7 text-xs px-2 gap-1"
            onClick={onSummarize}
            disabled={disabled}
            data-testid="ai-summary-regenerate"
          >
            {isSummarizing ? (
              <Loader2 className="w-3 h-3 animate-spin" />
            ) : (
              <RefreshCw className="w-3 h-3" />
            )}
            {isSummarizing
              ? t("inbox.aiSummary.generating")
              : t("inbox.aiSummary.regenerate")}
          </Button>
          {onDismiss && (
            <Button
              size="sm"
              variant="ghost"
              className="h-7 w-7 p-0"
              onClick={onDismiss}
              aria-label={t("inbox.aiSummary.dismiss")}
              title={t("inbox.aiSummary.dismiss")}
              data-testid="ai-summary-dismiss"
            >
              <X className="w-3.5 h-3.5" />
            </Button>
          )}
        </div>
      </div>
      <p className="text-xs leading-snug whitespace-pre-wrap break-words">
        {summary.content}
      </p>
      <div className="text-[10px] text-muted-foreground">
        {t("inbox.aiSummary.lastUpdated", {
          when: formatRelative(summary.generatedAt, lang),
        })}
        {" · "}
        {t("inbox.aiSummary.messageCount", { count: summary.messageCount })}
      </div>
    </div>
  );
}
