import Anthropic from "@anthropic-ai/sdk";

interface ClaudeConfig {
  apiKey: string;
  model?: string;
}

let cachedConfig: { config: ClaudeConfig | null; expiresAt: number } | null = null;
let cachedClient: { client: Anthropic; apiKey: string } | null = null;

const CACHE_TTL_MS = 60_000;

async function fetchClaudeFromDB(): Promise<{ found: boolean; config: ClaudeConfig | null }> {
  try {
    const { db, integrationsTable } = await import("@workspace/db");
    const { eq } = await import("drizzle-orm");

    const [integration] = await db
      .select()
      .from(integrationsTable)
      .where(eq(integrationsTable.key, "claude"));

    if (!integration) {
      return { found: false, config: null };
    }

    if (!integration.isEnabled) {
      return { found: true, config: null };
    }

    const cfg = integration.config as Record<string, any>;
    if (cfg.apiKey && typeof cfg.apiKey === "string" && cfg.apiKey.length > 0) {
      return { found: true, config: { apiKey: cfg.apiKey, model: cfg.model || undefined } };
    }

    return { found: true, config: null };
  } catch {
    return { found: false, config: null };
  }
}

export async function getClaudeConfig(): Promise<ClaudeConfig> {
  const now = Date.now();
  if (cachedConfig && now < cachedConfig.expiresAt) {
    if (cachedConfig.config) return cachedConfig.config;
    throw new Error("AI integration not configured. Please add your Anthropic API key in Settings → Integrations.");
  }

  const dbResult = await fetchClaudeFromDB();

  if (dbResult.found) {
    cachedConfig = { config: dbResult.config, expiresAt: now + CACHE_TTL_MS };
    if (dbResult.config) return dbResult.config;
    throw new Error("AI integration not configured. Please add your Anthropic API key in Settings → Integrations.");
  }

  if (process.env.ANTHROPIC_API_KEY) {
    const envConfig: ClaudeConfig = { apiKey: process.env.ANTHROPIC_API_KEY };
    cachedConfig = { config: envConfig, expiresAt: now + CACHE_TTL_MS };
    return envConfig;
  }

  throw new Error("AI integration not configured. Please add your Anthropic API key in Settings → Integrations.");
}

export async function getAnthropicClient(): Promise<Anthropic> {
  const config = await getClaudeConfig();

  if (cachedClient && cachedClient.apiKey === config.apiKey) {
    return cachedClient.client;
  }

  const client = new Anthropic({ apiKey: config.apiKey });
  cachedClient = { client, apiKey: config.apiKey };
  return client;
}

export function clearConfigCache(): void {
  cachedConfig = null;
  cachedClient = null;
}
