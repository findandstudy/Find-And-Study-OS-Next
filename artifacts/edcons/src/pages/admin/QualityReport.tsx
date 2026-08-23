// Sohbet Kalite Raporu — ranking, team trend, dimension breakdown,
// coaching queue, topic analysis, Excel export, settings (Faz 1).
import { useCallback, useEffect, useState } from "react";
import { Link } from "wouter";
import { customFetch } from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";
import { useI18n } from "@/hooks/use-i18n";
import { useAuth } from "@/hooks/use-auth";
import {
  ResponsiveContainer, LineChart, Line, XAxis, YAxis, Tooltip as RTooltip, CartesianGrid,
} from "recharts";
import { TrendingUp, TrendingDown, Minus, Download, PlayCircle, MessageSquare } from "lucide-react";

interface StaffSummaryRow {
  userId: number;
  firstName: string | null;
  lastName: string | null;
  email: string | null;
  role: string;
  conversationCount: number;
  avgOverall: number;
  dims: { accuracy: number; completeness: number; speed: number; tone: number; outcome: number };
  trend: "up" | "down" | "flat";
}

interface ScoredConversation {
  id: number;
  conversationId: number;
  conversationTitle: string | null;
  channel: string;
  userId: number;
  firstName: string | null;
  lastName: string | null;
  overall: number;
  accuracy: number;
  completeness: number;
  speed: number;
  tone: number;
  outcome: number;
  topic: string | null;
  language: string | null;
  rationales: Record<string, { score: number; rationale: string; evidence: string[] }> | null;
  scoredAt: string;
}

export const DIM_KEYS = ["accuracy", "completeness", "speed", "tone", "outcome"] as const;

export function overallColor(v: number): string {
  if (v >= 80) return "text-green-600";
  if (v >= 60) return "text-amber-600";
  return "text-red-600";
}

export function TrendIcon({ trend }: { trend: "up" | "down" | "flat" }) {
  if (trend === "up") return <TrendingUp className="w-4 h-4 text-green-600" aria-label="up" />;
  if (trend === "down") return <TrendingDown className="w-4 h-4 text-red-600" aria-label="down" />;
  return <Minus className="w-4 h-4 text-muted-foreground" aria-label="flat" />;
}

export default function QualityReportPage() {
  const { t } = useI18n();
  const { toast } = useToast();
  // Route-level ProtectedRoute is the source of truth for authorization;
  // useAuth(true) here only supplies the user for UI gating.
  const { user } = useAuth(true);
  const [days, setDays] = useState(30);
  const [staff, setStaff] = useState<StaffSummaryRow[]>([]);
  const [trend, setTrend] = useState<Array<{ day: string; count: number; avgOverall: number }>>([]);
  const [coaching, setCoaching] = useState<ScoredConversation[]>([]);
  const [topics, setTopics] = useState<Array<{ topic: string; count: number; avgOverall: number }>>([]);
  const [languages, setLanguages] = useState<string[]>([]);
  const [topicLang, setTopicLang] = useState<string>("all");
  const [settings, setSettings] = useState<{ enabled?: boolean; selfVisible?: boolean } | null>(null);
  const [loading, setLoading] = useState(true);
  const [running, setRunning] = useState(false);
  const [expanded, setExpanded] = useState<number | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const langQ = topicLang !== "all" ? `&language=${encodeURIComponent(topicLang)}` : "";
      const [sum, tr, coach, top, cfg] = await Promise.all([
        customFetch<{ staff: StaffSummaryRow[] }>(`/api/quality/staff-summary?days=${days}`),
        customFetch<{ trend: any[] }>(`/api/quality/team-trend?days=${days}`),
        customFetch<{ data: ScoredConversation[] }>(`/api/quality/conversations?days=${days}&order=asc&maxOverall=59&limit=20`),
        customFetch<{ topics: any[]; languages: string[] }>(`/api/quality/topics?days=${days}${langQ}`),
        customFetch<any>(`/api/quality/settings`),
      ]);
      setStaff(sum?.staff || []);
      setTrend(tr?.trend || []);
      setCoaching(coach?.data || []);
      setTopics(top?.topics || []);
      setLanguages(top?.languages || []);
      setSettings(cfg || null);
    } catch {
      toast({ title: t("quality.loadFailed"), variant: "destructive" });
    } finally {
      setLoading(false);
    }
  }, [days, topicLang, toast, t]);

  useEffect(() => { void load(); }, [load]);

  async function patchSettings(patch: Record<string, unknown>) {
    try {
      const updated = await customFetch<any>(`/api/quality/settings`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch),
      });
      setSettings(updated);
      toast({ title: t("quality.settingsSaved") });
    } catch {
      toast({ title: t("quality.settingsSaveFailed"), variant: "destructive" });
    }
  }

  async function runBatch() {
    setRunning(true);
    try {
      const r = await customFetch<any>(`/api/quality/run-batch`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      toast({ title: t("quality.batchDone", { scored: r?.scored ?? 0, scanned: r?.scanned ?? 0 }) });
      void load();
    } catch {
      toast({ title: t("quality.batchFailed"), variant: "destructive" });
    } finally {
      setRunning(false);
    }
  }

  function exportExcel() {
    window.open(`/api/quality/export.xlsx?days=${days}`, "_blank");
  }

  const isAdminScope = user && ["super_admin", "admin", "manager"].includes(user.role);

  return (
      <div className="p-6 space-y-6" data-testid="page-quality-report">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h1 className="text-2xl font-bold">{t("quality.title")}</h1>
            <p className="text-sm text-muted-foreground">{t("quality.subtitle")}</p>
          </div>
          <div className="flex items-center gap-2">
            <Select value={String(days)} onValueChange={(v) => setDays(Number(v))}>
              <SelectTrigger className="w-32" data-testid="select-quality-days"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="7">{t("quality.days7")}</SelectItem>
                <SelectItem value="30">{t("quality.days30")}</SelectItem>
                <SelectItem value="90">{t("quality.days90")}</SelectItem>
              </SelectContent>
            </Select>
            {isAdminScope && (
              <>
                <Button variant="outline" onClick={exportExcel} data-testid="button-quality-export">
                  <Download className="w-4 h-4 mr-1" /> {t("quality.exportExcel")}
                </Button>
                <Button onClick={runBatch} disabled={running} data-testid="button-quality-run-batch">
                  <PlayCircle className="w-4 h-4 mr-1" /> {running ? t("quality.running") : t("quality.runBatch")}
                </Button>
              </>
            )}
          </div>
        </div>

        {isAdminScope && settings && "enabled" in settings && (
          <Card>
            <CardContent className="pt-4 flex flex-wrap items-center gap-6">
              <label className="flex items-center gap-2 text-sm">
                <Switch
                  checked={Boolean(settings.enabled)}
                  onCheckedChange={(v) => patchSettings({ enabled: v })}
                  data-testid="switch-quality-enabled"
                />
                {t("quality.enabledToggle")}
              </label>
              <label className="flex items-center gap-2 text-sm">
                <Switch
                  checked={Boolean(settings.selfVisible)}
                  onCheckedChange={(v) => patchSettings({ selfVisible: v })}
                  data-testid="switch-quality-self-visible"
                />
                {t("quality.selfVisibleToggle")}
              </label>
            </CardContent>
          </Card>
        )}

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          <Card>
            <CardHeader><CardTitle className="text-base">{t("quality.teamTrend")}</CardTitle></CardHeader>
            <CardContent className="h-64">
              {trend.length === 0 ? (
                <p className="text-sm text-muted-foreground">{t("quality.noData")}</p>
              ) : (
                <ResponsiveContainer width="100%" height="100%">
                  <LineChart data={trend}>
                    <CartesianGrid strokeDasharray="3 3" />
                    <XAxis dataKey="day" tick={{ fontSize: 11 }} />
                    <YAxis domain={[0, 100]} tick={{ fontSize: 11 }} />
                    <RTooltip />
                    <Line type="monotone" dataKey="avgOverall" stroke="#2563eb" strokeWidth={2} dot={false} name={t("quality.avgScore")} />
                  </LineChart>
                </ResponsiveContainer>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="flex flex-row items-center justify-between space-y-0">
              <CardTitle className="text-base">{t("quality.topicAnalysis")}</CardTitle>
              <Select value={topicLang} onValueChange={setTopicLang}>
                <SelectTrigger className="w-28" data-testid="select-topic-language"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">{t("quality.allLanguages")}</SelectItem>
                  {languages.map((l) => <SelectItem key={l} value={l}>{l.toUpperCase()}</SelectItem>)}
                </SelectContent>
              </Select>
            </CardHeader>
            <CardContent className="max-h-64 overflow-y-auto">
              {topics.length === 0 ? (
                <p className="text-sm text-muted-foreground">{t("quality.noData")}</p>
              ) : (
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-left text-muted-foreground">
                      <th className="py-1">{t("quality.topic")}</th>
                      <th className="py-1 text-right">{t("quality.count")}</th>
                      <th className="py-1 text-right">{t("quality.avgScore")}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {topics.map((tp) => (
                      <tr key={tp.topic} className="border-t">
                        <td className="py-1.5">{tp.topic}</td>
                        <td className="py-1.5 text-right">{tp.count}</td>
                        <td className={`py-1.5 text-right font-medium ${overallColor(tp.avgOverall)}`}>{tp.avgOverall}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </CardContent>
          </Card>
        </div>

        <Card>
          <CardHeader><CardTitle className="text-base">{t("quality.ranking")}</CardTitle></CardHeader>
          <CardContent className="overflow-x-auto">
            {loading ? (
              <p className="text-sm text-muted-foreground">{t("common.loading")}</p>
            ) : staff.length === 0 ? (
              <p className="text-sm text-muted-foreground">{t("quality.noData")}</p>
            ) : (
              <table className="w-full text-sm" data-testid="table-quality-ranking">
                <thead>
                  <tr className="text-left text-muted-foreground">
                    <th className="py-2">#</th>
                    <th className="py-2">{t("quality.staffMember")}</th>
                    <th className="py-2 text-right">{t("quality.conversations")}</th>
                    <th className="py-2 text-right">{t("quality.overall")}</th>
                    <th className="py-2 text-center">{t("quality.trend")}</th>
                    {DIM_KEYS.map((d) => (
                      <th key={d} className="py-2 text-right">{t(`quality.dim.${d}`)}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {staff.map((s, i) => (
                    <tr key={s.userId} className="border-t" data-testid={`row-quality-staff-${s.userId}`}>
                      <td className="py-2">{i + 1}</td>
                      <td className="py-2">
                        <Link href={`/admin/staff-cards/${s.userId}`} className="hover:underline font-medium">
                          {[s.firstName, s.lastName].filter(Boolean).join(" ") || s.email}
                        </Link>
                      </td>
                      <td className="py-2 text-right">{s.conversationCount}</td>
                      <td className={`py-2 text-right font-bold ${overallColor(s.avgOverall)}`}>{s.avgOverall}</td>
                      <td className="py-2"><div className="flex justify-center"><TrendIcon trend={s.trend} /></div></td>
                      {DIM_KEYS.map((d) => (
                        <td key={d} className="py-2 text-right">{s.dims[d].toFixed(1)}</td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader><CardTitle className="text-base">{t("quality.coachingQueue")}</CardTitle></CardHeader>
          <CardContent>
            {coaching.length === 0 ? (
              <p className="text-sm text-muted-foreground">{t("quality.coachingEmpty")}</p>
            ) : (
              <div className="space-y-2">
                {coaching.map((c) => (
                  <div key={c.id} className="border rounded-md p-3" data-testid={`card-coaching-${c.id}`}>
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div className="flex items-center gap-2">
                        <span className={`text-lg font-bold ${overallColor(c.overall)}`}>{c.overall}</span>
                        <span className="font-medium">{[c.firstName, c.lastName].filter(Boolean).join(" ")}</span>
                        <Badge variant="outline">{c.channel}</Badge>
                        {c.topic && <Badge variant="secondary">{c.topic}</Badge>}
                      </div>
                      <div className="flex items-center gap-2">
                        <Button
                          variant="ghost" size="sm"
                          onClick={() => setExpanded(expanded === c.id ? null : c.id)}
                          data-testid={`button-coaching-detail-${c.id}`}
                        >
                          {expanded === c.id ? t("quality.hideDetail") : t("quality.showDetail")}
                        </Button>
                        <Link href={`/staff/messages?conversation=${c.conversationId}`}>
                          <Button variant="outline" size="sm" data-testid={`link-coaching-conversation-${c.id}`}>
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
