/**
 * declarative/httpRunner.ts — executes http, graphql, capture, and setVar
 * steps for the declarative spec engine.
 *
 * All network calls go through `page.request` so the Playwright session cookie
 * jar (including any auth cookies acquired during login) is shared. This means
 * http/graphql steps can hit authenticated portal endpoints without re-logging
 * in separately.
 *
 * Security:
 *   - SSRF guard: every URL is checked against `allowedOrigins` (from
 *     spec.meta.allowedOrigins). A URL that does not match a listed origin
 *     throws a hard error — never a silent skip.
 *   - `mutation:true` steps are skipped in dry-run mode (logged at debug level).
 */

import type { InterpolateCtx } from "./interpolate.js";
import { interpolate } from "./interpolate.js";
import { logger } from "../browser.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** The Playwright APIRequestContext subset we need. */
export interface RequestContext {
  fetch(
    url: string,
    options?: {
      method?: string;
      headers?: Record<string, string>;
      data?: string;
    },
  ): Promise<{ text(): Promise<string> }>;
}

/** The Playwright Page subset needed for capture steps. */
export interface CapturePage {
  url(): string;
  evaluate<T>(fn: string | ((...args: unknown[]) => T), ...args: unknown[]): Promise<T>;
  textContent(selector: string): Promise<string | null>;
  request: RequestContext;
}

export interface HttpRunnerOpts {
  dryRun?: boolean;
  allowedOrigins: string[];
}

// ---------------------------------------------------------------------------
// Step type definitions (import-free subset of schema types)
// ---------------------------------------------------------------------------

export interface HttpStep {
  action: "http";
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  url: string;
  headers?: Record<string, string>;
  body?: string;
  json?: Record<string, unknown>;
  saveAs?: string;
  mutation?: boolean;
  optional?: boolean;
}

export interface GraphqlStep {
  action: "graphql";
  url: string;
  query: string;
  variables?: Record<string, unknown>;
  saveAs?: string;
  mutation?: boolean;
  optional?: boolean;
}

export interface CaptureStep {
  action: "capture";
  from: "lastResponse" | "cookie" | "localStorage" | "selectorText" | "url";
  path?: string;
  name: string;
}

export interface SetVarStep {
  action: "setVar";
  name: string;
  value: string;
}

export type HttpLikeStep = HttpStep | GraphqlStep | CaptureStep | SetVarStep;

// ---------------------------------------------------------------------------
// SSRF guard
// ---------------------------------------------------------------------------

/**
 * Validates that `url` has an origin that exactly matches one of the allowed
 * origins. Throws a hard error when the URL is invalid or not in the list.
 */
function assertAllowedOrigin(url: string, allowedOrigins: string[]): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`[httpRunner] invalid URL: "${url}"`);
  }
  const urlOrigin = parsed.origin;
  if (!allowedOrigins.some((o) => o === urlOrigin)) {
    throw new Error(
      `[httpRunner] SSRF guard: URL origin "${urlOrigin}" is not in allowedOrigins ` +
      `[${allowedOrigins.join(", ")}]`,
    );
  }
}

// ---------------------------------------------------------------------------
// Interpolate helpers
// ---------------------------------------------------------------------------

function iStr(s: string, ctx: InterpolateCtx): string {
  return interpolate(s, ctx);
}

function iRecord(
  rec: Record<string, string> | undefined,
  ctx: InterpolateCtx,
): Record<string, string> | undefined {
  if (!rec) return undefined;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(rec)) {
    out[k] = iStr(v, ctx);
  }
  return out;
}

function iJsonValues(
  rec: Record<string, unknown> | undefined,
  ctx: InterpolateCtx,
): Record<string, unknown> | undefined {
  if (!rec) return undefined;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(rec)) {
    out[k] = typeof v === "string" ? iStr(v, ctx) : v;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Main executor
// ---------------------------------------------------------------------------

/**
 * Executes a single http-like step (http / graphql / capture / setVar).
 * Mutates `ctx.captured` and `ctx.vars` in place as results are captured.
 * Returns null when the step was skipped (mutation+dryRun).
 */
export async function executeHttpLikeStep(
  step: HttpLikeStep,
  ctx: InterpolateCtx,
  page: CapturePage,
  opts: HttpRunnerOpts,
): Promise<null | string> {
  const { dryRun = false, allowedOrigins } = opts;

  switch (step.action) {
    // -----------------------------------------------------------------------
    case "http": {
      const url = iStr(step.url, ctx);
      assertAllowedOrigin(url, allowedOrigins);

      if (step.mutation && dryRun) {
        logger.info(`[httpRunner] DRY: skipping mutation http step → ${url}`);
        return null;
      }

      const headers = iRecord(step.headers, ctx) ?? {};
      let data: string | undefined;
      if (step.body !== undefined) {
        data = iStr(step.body, ctx);
      } else if (step.json !== undefined) {
        data = JSON.stringify(iJsonValues(step.json, ctx));
        if (!headers["Content-Type"] && !headers["content-type"]) {
          headers["Content-Type"] = "application/json";
        }
      }

      const resp = await page.request.fetch(url, {
        method: step.method,
        headers,
        data,
      });
      const text = await resp.text();
      ctx.captured["lastResponse"] = text;
      if (step.saveAs) ctx.captured[iStr(step.saveAs, ctx)] = text;
      return text;
    }

    // -----------------------------------------------------------------------
    case "graphql": {
      const url = iStr(step.url, ctx);
      assertAllowedOrigin(url, allowedOrigins);

      if (step.mutation && dryRun) {
        logger.info(`[httpRunner] DRY: skipping mutation graphql step → ${url}`);
        return null;
      }

      const body = JSON.stringify({
        query: iStr(step.query, ctx),
        variables: iJsonValues(step.variables, ctx),
      });

      const resp = await page.request.fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        data: body,
      });
      const text = await resp.text();
      ctx.captured["lastResponse"] = text;
      if (step.saveAs) ctx.captured[iStr(step.saveAs, ctx)] = text;
      return text;
    }

    // -----------------------------------------------------------------------
    case "capture": {
      // Interpolate path and name before use so {{vars.key}} can be used in
      // cookie/localStorage keys, JSON dotpaths, CSS selectors, and the target
      // captured variable name.
      const resolvedPath = step.path ? iStr(step.path, ctx) : undefined;
      const resolvedName = iStr(step.name, ctx);

      let value: string;
      switch (step.from) {
        case "url":
          value = page.url();
          break;

        case "lastResponse":
          value = String(ctx.captured["lastResponse"] ?? "");
          if (resolvedPath) {
            try {
              const parsed = JSON.parse(value) as unknown;
              const parts = resolvedPath.split(".");
              let cur: unknown = parsed;
              for (const p of parts) {
                if (cur == null || typeof cur !== "object") { cur = undefined; break; }
                cur = (cur as Record<string, unknown>)[p];
              }
              value = cur == null ? "" : String(cur);
            } catch {
              value = "";
            }
          }
          break;

        case "cookie": {
          const cookieName = resolvedPath ?? resolvedName;
          value = await page.evaluate(
            `(function(){ var m=document.cookie.match(new RegExp('(?:^|; )'+encodeURIComponent(${JSON.stringify(cookieName)})+'=([^;]*)')); return m ? decodeURIComponent(m[1]) : ''; })()`,
          ) as string;
          break;
        }

        case "localStorage": {
          const storageKey = resolvedPath ?? resolvedName;
          value = await page.evaluate(
            `(function(){ return window.localStorage.getItem(${JSON.stringify(storageKey)}) || ''; })()`,
          ) as string;
          break;
        }

        case "selectorText": {
          if (!resolvedPath) throw new Error("[httpRunner] capture selectorText requires path (the CSS selector)");
          const text = await page.textContent(resolvedPath);
          value = (text ?? "").trim();
          break;
        }

        default: {
          const _never: never = step.from;
          logger.warn(`[httpRunner] unknown capture.from: ${String(_never)}`);
          value = "";
        }
      }

      ctx.captured[resolvedName] = value;
      return value;
    }

    // -----------------------------------------------------------------------
    case "setVar": {
      const resolvedName = iStr(step.name, ctx);
      const resolved = iStr(step.value, ctx);
      ctx.vars[resolvedName] = resolved;
      return resolved;
    }

    // -----------------------------------------------------------------------
    default: {
      const _never: never = step;
      logger.warn(`[httpRunner] unhandled step: ${JSON.stringify(_never)}`);
      return null;
    }
  }
}
