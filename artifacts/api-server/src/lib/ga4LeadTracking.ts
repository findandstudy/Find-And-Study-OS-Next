export type Ga4AnalyticsContext = {
  clientId: string;
  sessionId?: string;
  capturedAt: string;
};

export type Ga4LeadStageEventName =
  | "working_lead"
  | "qualify_lead"
  | "close_convert_lead"
  | "disqualify_lead"
  | "lead_stage_changed";

type LeadStage = { key: string; variant?: string | null };

type TrackableLead = {
  source: string | null;
  status: string;
  educationData: unknown;
  estimatedValue: string | null;
  utmSource: string | null;
  utmMedium: string | null;
  utmCampaign: string | null;
};

const FTC_EMBED_SOURCES = new Set([
  "embed:ftc-study",
  "embed:ftc-accommodation",
  "embed:ftc-transfer",
]);

function clean(value: unknown, max: number): string | undefined {
  if (value == null) return undefined;
  const normalized = String(value).trim().slice(0, max);
  return normalized || undefined;
}

export function isFtcEmbedSource(source: unknown): boolean {
  return FTC_EMBED_SOURCES.has(String(source || "").toLowerCase());
}

export function sanitizeGa4AnalyticsContext(input: {
  gaClientId?: unknown;
  gaSessionId?: unknown;
  gaCapturedAt?: unknown;
}): Ga4AnalyticsContext | null {
  const clientId = clean(input.gaClientId, 128);
  if (!clientId || !/^[A-Za-z0-9._-]+$/.test(clientId)) return null;

  const rawSessionId = clean(input.gaSessionId, 32);
  const sessionId = rawSessionId && /^\d{1,32}$/.test(rawSessionId) ? rawSessionId : undefined;
  const rawCapturedAt = clean(input.gaCapturedAt, 40);
  if (!rawCapturedAt) return null;
  const parsedAt = new Date(rawCapturedAt);
  if (!Number.isFinite(parsedAt.getTime()) || parsedAt.getTime() > Date.now() + 5 * 60_000) return null;
  const capturedAt = parsedAt.toISOString();
  return { clientId, sessionId, capturedAt };
}

export function extractGa4AnalyticsContext(educationData: unknown): Ga4AnalyticsContext | null {
  if (!educationData || typeof educationData !== "object" || Array.isArray(educationData)) return null;
  const analytics = (educationData as Record<string, unknown>).analytics;
  if (!analytics || typeof analytics !== "object" || Array.isArray(analytics)) return null;
  const ga4 = (analytics as Record<string, unknown>).ga4;
  if (!ga4 || typeof ga4 !== "object" || Array.isArray(ga4)) return null;
  const record = ga4 as Record<string, unknown>;
  return sanitizeGa4AnalyticsContext({
    gaClientId: record.clientId,
    gaSessionId: record.sessionId,
    gaCapturedAt: record.capturedAt,
  });
}

export function mapLeadStageToGa4Event(stage: LeadStage): Ga4LeadStageEventName {
  const key = String(stage.key || "").toLowerCase();
  const variant = String(stage.variant || "").toLowerCase();
  if (variant === "won" || key === "converted") return "close_convert_lead";
  if (variant === "lost" || key === "lost") return "disqualify_lead";
  if (key === "contacted") return "working_lead";
  if (key === "interested" || key === "qualified") return "qualify_lead";
  return "lead_stage_changed";
}

export async function trackFtcLeadStageChange(params: {
  lead: TrackableLead;
  previousStage: string;
  nextStage: LeadStage;
}): Promise<{ sent: boolean; reason?: string; status?: number }> {
  if (!isFtcEmbedSource(params.lead.source)) return { sent: false, reason: "not_ftc_embed" };
  const context = extractGa4AnalyticsContext(params.lead.educationData);
  if (!context) return { sent: false, reason: "analytics_context_missing" };

  const measurementId = process.env.GA4_MEASUREMENT_ID?.trim();
  const apiSecret = process.env.GA4_API_SECRET?.trim();
  if (!measurementId || !apiSecret) return { sent: false, reason: "ga4_not_configured" };

  const eventName = mapLeadStageToGa4Event(params.nextStage);
  const capturedAtMs = new Date(context.capturedAt).getTime();
  const contextAgeMs = Date.now() - capturedAtMs;
  const hasFreshSession = Boolean(
    context.sessionId && contextAgeMs >= -5 * 60_000 && contextAgeMs <= 24 * 60 * 60_000,
  );
  const numericValue = Number(params.lead.estimatedValue);
  const includeValue = eventName === "close_convert_lead" && Number.isFinite(numericValue) && numericValue > 0;
  const eventParams: Record<string, string | number> = {
    engagement_time_msec: 1,
    lead_source: String(params.lead.source || "embed"),
    crm_previous_stage: clean(params.previousStage, 40) || "unknown",
    crm_stage: clean(params.nextStage.key, 40) || "unknown",
  };
  if (hasFreshSession) eventParams.session_id = context.sessionId!;
  const source = clean(params.lead.utmSource, 100);
  const medium = clean(params.lead.utmMedium, 100);
  const campaign = clean(params.lead.utmCampaign, 100);
  if (source) eventParams.utm_source = source;
  if (medium) eventParams.utm_medium = medium;
  if (campaign) eventParams.utm_campaign = campaign;
  if (includeValue) {
    eventParams.value = numericValue;
    eventParams.currency = process.env.GA4_DEFAULT_CURRENCY?.trim().toUpperCase() || "EUR";
  }

  const endpoint = new URL("https://region1.google-analytics.com/mp/collect");
  endpoint.searchParams.set("measurement_id", measurementId);
  endpoint.searchParams.set("api_secret", apiSecret);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5000);
  try {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        client_id: context.clientId,
        events: [{ name: eventName, params: eventParams }],
      }),
      signal: controller.signal,
    });
    return response.ok
      ? { sent: true, status: response.status }
      : { sent: false, reason: "ga4_http_error", status: response.status };
  } catch {
    return { sent: false, reason: "ga4_network_error" };
  } finally {
    clearTimeout(timeout);
  }
}
