// Staff card "Quality" tab — 30-day average with trend arrow, dimension
// breakdown, and the list of scored conversations (clickable → inbox).
import { useCallback, useEffect, useState } from "react";
import { Link } from "wouter";
import { customFetch } from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useI18n } from "@/hooks/use-i18n";
import { TrendingUp, TrendingDown, Minus, MessageSquare } from "lucide-react";

const DIM_KEYS = ["accuracy", "completeness", "speed", "tone", "outcome"] as const;

function overallColor(v: number): string {
  if (v >= 80) return "text-green-600";
  if (v >= 60) return "text-amber-600";
  return "text-red-600";
}

function TrendIcon({ trend }: { trend: "up" | "down" | "flat" }) {
  if (trend === "up") return <TrendingUp className="w-5 h-5 text-green-600" aria-label="up" />;
  if (trend === "down") return <TrendingDown className="w-5 h-5 text-red-600" aria-label="down" />;
  return <Minus className="w-5 h-5 text-muted-foreground" aria-label="flat" />;
}

interface Summary {
  conversationCount: number;
  avgOverall: number;
  dims: Record<(typeof DIM_KEYS)[number], number>;
  trend: "up" | "down" | "flat";
}

interface ScoredConv {
  id: number;
  conversationId: number;
  conversationTitle: string | null;
  channel: string;
  overall: number;
  topic: string | null;
  language: string | null;
  rationales: Record<string, { score: number; rationale: string; evidence: string[] }> | null;
  scoredAt: string;
}

export default function StaffQualityTab({ userId }: { userId: number }) {
  const { t } = useI18n();
  const [days, setDays] = useState(30);
  const [summary, setSummary] = useState<Summary | null>(null);
  const [convs, setConvs] = useState<ScoredConv[]>([]);
  const [loading, setLoading] = useState(true);
  const [forbidden, setForbidden] = useState(false);
  const [expanded, setExpanded] = useState<number | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setForbidden(false);
    try {
      const [sum, list] = await Promise.all([
        customFetch<{ staff: any[] }>(`/api/quality/staff-summary?days=${days}`),
        customFetch<{ data: ScoredConv[] }>(`/api/quality/conversations?days=${days}&userId=${userId}&limit=50`),
      ]);
      const row = (sum?.staff || []).find((s: any) => s.userId === userId);
      setSummary(row ? { conversationCount: row.conversationCount, avgOverall: row.avgOverall, dims: row.dims, trend: row.trend } : null);
      setConvs(list?.data || []);
    } catch (err: any) {
      if (err?.status === 403 || err?.body?.error === "QUALITY_NOT_VISIBLE") setForbidden(true);
      setSummary(null);
      setConvs([]);
    } finally {
      setLoading(false);
    }
  }, [days, userId]);

  useEffect(() => { void load(); }, [load]);

  if (loading) return <p className="text-sm text-muted-foreground p-4">{t("common.loading")}</p>;
  if (forbidden) return <p className="text-sm text-muted-foreground p-4">{t("quality.notVisible")}</p>;

  return (
    <div className="space-y-4" data-testid="tab-staff-quality">
      <div className="flex items-center justify-between">
        <h3 className="font-semibold">{t("quality.staffSectionTitle")}</h3>
        <Select value={String(days)} onValueChange={(v) => setDays(Number(v))}>
          <SelectTrigger className="w-32" data-testid="select-staff-quality-days"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="7">{t("quality.days7")}</SelectItem>
            <SelectItem value="30">{t("quality.days30")}</SelectItem>
            <SelectItem value="90">{t("quality.days90")}</SelectItem>
          </SelectContent>
        </Select>
      </div>

      {!summary ? (
        <p className="text-sm text-muted-foreground">{t("quality.noData")}</p>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <Card>
            <CardHeader><CardTitle className="text-sm">{t("quality.avgScore")}</CardTitle></CardHeader>
            <CardContent className="flex items-center gap-3">
              <span className={`text-4xl font-bold ${overallColor(summary.avgOverall)}`} data-testid="text-staff-quality-overall">
                {summary.avgOverall}
              </span>
              <TrendIcon trend={summary.trend} />
              <span className="text-sm text-muted-foreground">
                {t("quality.scoredConversations", { count: summary.conversationCount })}
              </span>
            </CardContent>
          </Card>
          <Card>
            <CardHeader><CardTitle className="text-sm">{t("quality.dimBreakdown")}</CardTitle></CardHeader>
            <CardContent className="space-y-1.5">
              {DIM_KEYS.map((d) => (
                <div key={d} className="flex items-center gap-2 text-sm">
                  <span className="w-28 shrink-0">{t(`quality.dim.${d}`)}</span>
                  <div className="flex-1 h-2 rounded bg-muted overflow-hidden">
                    <div className="h-full bg-primary" style={{ width: `${(summary.dims[d] / 5) * 100}%` }} />
                  </div>
                  <span className="w-8 text-right font-medium">{summary.dims[d].toFixed(1)}</span>
                </div>
              ))}
            </CardContent>
          </Card>
        </div>
      )}

      <Card>
        <CardHeader><CardTitle className="text-sm">{t("quality.sourceConversations")}</CardTitle></CardHeader>
        <CardContent>
          {convs.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t("quality.noData")}</p>
          ) : (
            <div className="space-y-2">
              {convs.map((c) => (
                <div key={c.id} className="border rounded-md p-3" data-testid={`card-staff-quality-conv-${c.id}`}>
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="flex items-center gap-2">
                      <span className={`font-bold ${overallColor(c.overall)}`}>{c.overall}</span>
                      <Badge variant="outline">{c.channel}</Badge>
                      {c.topic && <Badge variant="secondary">{c.topic}</Badge>}
                      <span className="text-xs text-muted-foreground">{new Date(c.scoredAt).toLocaleDateString()}</span>
                    </div>
                    <div className="flex items-center gap-2">
                      <Button variant="ghost" size="sm" onClick={() => setExpanded(expanded === c.id ? null : c.id)}>
                        {expanded === c.id ? t("quality.hideDetail") : t("quality.showDetail")}
                      </Button>
                      <Link href={`/staff/messages?conversation=${c.conversationId}`}>
                        <Button variant="outline" size="sm" data-testid={`link-staff-quality-conv-${c.id}`}>
                          <MessageSquare className="w-4 h-4 mr-1" /> {t("quality.openConversation")}
                        </Button>
                      </Link>
                    </div>
                  </div>
                  {expanded === c.id && c.rationales && (
                    <div className="mt-3 space-y-2 text-sm">
                      {DIM_KEYS.map((d) => {
                        const r = c.rationales?.[d];
                        if (!r) return null;
                        return (
                          <div key={d} className="border-l-2 pl-3">
                            <span className="font-medium">{t(`quality.dim.${d}`)}: {r.score}/5</span>
                            {r.rationale && <p className="text-muted-foreground">{r.rationale}</p>}
                            {r.evidence?.map((e, i) => (
                              <p key={i} className="italic text-xs text-muted-foreground">“{e}”</p>
                            ))}
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
