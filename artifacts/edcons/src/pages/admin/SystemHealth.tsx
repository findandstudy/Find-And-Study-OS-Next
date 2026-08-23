import { useEffect, useState } from "react";
import { customFetch } from "@workspace/api-client-react";
import { AlertTriangle, CheckCircle2, RefreshCw, ShieldAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

type HealthIssue = {
  key: string;
  severity: "warning" | "critical";
  message: string;
  count: number;
};

type HealthResponse = {
  status: "healthy" | "warning" | "critical";
  checkedAt: string;
  latencyMs: number;
  releaseId?: string;
  metrics?: {
    apiTokens?: { no_expiry?: number; expired?: number; expiring_soon?: number };
    aiRuns24h?: { failed?: number; rate_limited?: number };
    webhook24h?: { auth_failures?: number; verification_probes?: number; delivery_failures?: number; by_resource?: Record<string, number> };
    portalSubmissions?: { queued?: number; running?: number; stale_running?: number; failed_24h?: number };
    storage?: { available?: boolean; totalBytes?: number | null; freeBytes?: number | null; freePercent?: number | null };
    backups?: { available?: boolean; count?: number | null; latestAt?: string | null; latestSizeBytes?: number | null; latestAgeHours?: number | null };
  };
  issues: HealthIssue[];
};

function count(value: unknown): number {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

export default function SystemHealthPage() {
  const [data, setData] = useState<HealthResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);

  async function load() {
    setLoading(true);
    setError(false);
    try {
      setData(await customFetch<HealthResponse>("/api/admin/system-health"));
    } catch {
      setError(true);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { void load(); }, []);

  const metricCards = data ? [
    {
      title: "Webhook delivery failures (24h)",
      value: count(data.metrics?.webhook24h?.delivery_failures),
      detail: `${count(data.metrics?.webhook24h?.verification_probes)} rejected verification probes`,
    },
    {
      title: "AI failures (24h)",
      value: count(data.metrics?.aiRuns24h?.failed) + count(data.metrics?.aiRuns24h?.rate_limited),
      detail: `${count(data.metrics?.aiRuns24h?.rate_limited)} rate limited`,
    },
    {
      title: "Portal queue",
      value: count(data.metrics?.portalSubmissions?.queued),
      detail: `${count(data.metrics?.portalSubmissions?.running)} running · ${count(data.metrics?.portalSubmissions?.stale_running)} stale`,
    },
    {
      title: "API token attention",
      value: count(data.metrics?.apiTokens?.no_expiry) + count(data.metrics?.apiTokens?.expired) + count(data.metrics?.apiTokens?.expiring_soon),
      detail: "No expiry, expired or expiring soon",
    },
    {
      title: "Server disk",
      value: data.metrics?.storage?.freePercent == null ? "—" : `${data.metrics.storage.freePercent}%`,
      detail: "Free filesystem capacity",
    },
    {
      title: "Database backups",
      value: data.metrics?.backups?.count ?? "—",
      detail: data.metrics?.backups?.latestAt
        ? `Latest ${new Date(data.metrics.backups.latestAt).toLocaleString()}`
        : "Latest backup not readable",
    },
  ] : [];

  return (
    <div className="p-6 space-y-6" data-testid="page-system-health">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold">System Health</h1>
          <p className="text-sm text-muted-foreground">Read-only operational signals. No secrets or personal data are displayed.</p>
        </div>
        <Button variant="outline" onClick={() => void load()} disabled={loading}>
          <RefreshCw className={`mr-2 h-4 w-4 ${loading ? "animate-spin" : ""}`} /> Refresh
        </Button>
      </div>

      {error && (
        <Card className="border-destructive/40">
          <CardContent className="flex items-center gap-2 pt-6 text-destructive">
            <ShieldAlert className="h-5 w-5" /> Health data could not be loaded.
          </CardContent>
        </Card>
      )}

      {data && (
        <>
          <Card className={data.status === "critical" ? "border-destructive/50" : data.status === "warning" ? "border-amber-500/50" : "border-emerald-500/50"}>
            <CardContent className="flex flex-wrap items-center justify-between gap-3 pt-6">
              <div className="flex items-center gap-3">
                {data.status === "healthy" ? <CheckCircle2 className="h-7 w-7 text-emerald-600" /> : <AlertTriangle className={`h-7 w-7 ${data.status === "critical" ? "text-destructive" : "text-amber-600"}`} />}
                <div>
                  <div className="font-semibold capitalize">{data.status}</div>
                  <div className="text-sm text-muted-foreground">Checked {new Date(data.checkedAt).toLocaleString()} · DB queries {data.latencyMs} ms</div>
                </div>
              </div>
              <Badge variant={data.status === "critical" ? "destructive" : "secondary"}>Release {data.releaseId || "unknown"}</Badge>
            </CardContent>
          </Card>

          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
            {metricCards.map((metric) => (
              <Card key={metric.title}>
                <CardHeader className="pb-2"><CardTitle className="text-sm font-medium text-muted-foreground">{metric.title}</CardTitle></CardHeader>
                <CardContent><div className="text-3xl font-bold">{metric.value}</div><p className="mt-1 text-xs text-muted-foreground">{metric.detail}</p></CardContent>
              </Card>
            ))}
          </div>

          <Card>
            <CardHeader><CardTitle>Attention required</CardTitle></CardHeader>
            <CardContent className="space-y-3">
              {data.issues.length === 0 ? (
                <div className="flex items-center gap-2 text-sm text-emerald-600"><CheckCircle2 className="h-4 w-4" /> No active health findings.</div>
              ) : data.issues.map((issue) => (
                <div key={issue.key} className="flex items-start justify-between gap-4 rounded-lg border p-3">
                  <div>
                    <div className="font-medium">{issue.message}</div>
                    <div className="text-xs text-muted-foreground">{issue.key}</div>
                  </div>
                  <Badge variant={issue.severity === "critical" ? "destructive" : "secondary"}>{issue.count} · {issue.severity}</Badge>
                </div>
              ))}
            </CardContent>
          </Card>
        </>
      )}
    </div>
  );
}
