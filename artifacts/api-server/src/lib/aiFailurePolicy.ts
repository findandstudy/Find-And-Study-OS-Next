export type AiFailureCategory =
  | "rate_limit"
  | "timeout"
  | "provider_unavailable"
  | "authentication"
  | "invalid_request"
  | "safety"
  | "unknown";

export type AiFailureClassification = {
  category: AiFailureCategory;
  retryable: boolean;
  retryAfterSeconds: number | null;
};

/**
 * Keep provider errors useful for operations without using brittle provider
 * classes throughout the application. Authentication, policy and malformed
 * request failures must never enter an automatic retry loop.
 */
export function classifyAiFailure(error: unknown): AiFailureClassification {
  const message = error instanceof Error ? error.message : String(error ?? "");
  if (/\b429\b|rate.?limit|too many requests|overloaded/i.test(message)) {
    return { category: "rate_limit", retryable: true, retryAfterSeconds: 60 };
  }
  if (/timeout|timed out|ETIMEDOUT|ECONNRESET|socket hang up/i.test(message)) {
    return { category: "timeout", retryable: true, retryAfterSeconds: 30 };
  }
  if (/\b50[234]\b|service unavailable|temporarily unavailable|connection refused/i.test(message)) {
    return { category: "provider_unavailable", retryable: true, retryAfterSeconds: 60 };
  }
  if (/\b401\b|\b403\b|api.?key|authentication|unauthorized|forbidden/i.test(message)) {
    return { category: "authentication", retryable: false, retryAfterSeconds: null };
  }
  if (/\b400\b|invalid request|validation|maximum context|too many tokens/i.test(message)) {
    return { category: "invalid_request", retryable: false, retryAfterSeconds: null };
  }
  if (/safety|content policy|moderation|blocked/i.test(message)) {
    return { category: "safety", retryable: false, retryAfterSeconds: null };
  }
  return { category: "unknown", retryable: false, retryAfterSeconds: null };
}

export function aiRetryDelaySeconds(attempt: number, baseSeconds: number): number {
  const boundedAttempt = Math.max(1, Math.min(attempt, 3));
  return Math.min(baseSeconds * 2 ** (boundedAttempt - 1), 300);
}
