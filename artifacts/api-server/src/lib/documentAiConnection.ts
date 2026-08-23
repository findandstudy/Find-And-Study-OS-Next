import Anthropic from "@anthropic-ai/sdk";
import { db, integrationsTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { decryptConfig } from "./encryption";

export type DocumentAiConnection = {
  client: Anthropic;
  model?: string;
  resolvedConnectionKey: string;
  usedFallback: boolean;
};

type CachedConnection = {
  connection: Omit<DocumentAiConnection, "usedFallback">;
  expiresAt: number;
};

const CACHE_TTL_MS = 60_000;
const cache = new Map<string, CachedConnection>();

export function isAnthropicConnectionKey(value: string): boolean {
  return value === "claude" || /^(?:claude|anthropic):[a-z0-9][a-z0-9_-]{0,63}$/.test(value);
}

function normalizeConnectionKey(value: string): string {
  const key = value.trim().toLowerCase();
  if (!isAnthropicConnectionKey(key)) throw new Error("Invalid Anthropic connection key");
  return key;
}

async function loadExactConnection(connectionKey: string): Promise<Omit<DocumentAiConnection, "usedFallback">> {
  const key = normalizeConnectionKey(connectionKey);
  const cached = cache.get(key);
  if (cached && cached.expiresAt > Date.now()) return cached.connection;

  const [integration] = await db
    .select({ isEnabled: integrationsTable.isEnabled, config: integrationsTable.config })
    .from(integrationsTable)
    .where(eq(integrationsTable.key, key));

  let apiKey: string | undefined;
  let model: string | undefined;
  if (integration?.isEnabled) {
    const config = decryptConfig((integration.config as Record<string, unknown>) || {});
    apiKey = typeof config.apiKey === "string" ? config.apiKey.trim() : undefined;
    model = typeof config.model === "string" ? config.model.trim() || undefined : undefined;
  } else if (!integration && key === "claude") {
    apiKey = process.env.ANTHROPIC_API_KEY?.trim();
  }

  if (!apiKey) throw new Error(`Anthropic connection '${key}' is unavailable or disabled`);

  const connection = {
    client: new Anthropic({ apiKey, timeout: 45_000, maxRetries: 1 }),
    model,
    resolvedConnectionKey: key,
  };
  cache.set(key, { connection, expiresAt: Date.now() + CACHE_TTL_MS });
  return connection;
}

export async function getDocumentAiConnection(
  requestedConnectionKey: string,
  options: { fallbackToDefault?: boolean } = {},
): Promise<DocumentAiConnection> {
  const requestedKey = normalizeConnectionKey(requestedConnectionKey || "claude");
  try {
    return { ...(await loadExactConnection(requestedKey)), usedFallback: false };
  } catch (error) {
    if (options.fallbackToDefault === false || requestedKey === "claude") throw error;
    return { ...(await loadExactConnection("claude")), usedFallback: true };
  }
}

export function clearDocumentAiConnectionCache(): void {
  cache.clear();
}
