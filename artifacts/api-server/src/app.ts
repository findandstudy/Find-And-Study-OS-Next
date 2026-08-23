import crypto from "crypto";
import express, { type Express, type Request, type Response, type NextFunction } from "express";
import cors from "cors";
import helmet from "helmet";
import compression from "compression";
import cookieParser from "cookie-parser";
import { authMiddleware } from "./middlewares/authMiddleware";
import { getCsrfCookieOptions } from "./lib/cookieOptions";
import { getAllowedOrigins, isCredentialedCorsOriginAllowed } from "./lib/requestOrigin";
import router from "./routes";
import webhooksRouter from "./routes/webhooks";
import { requestPerformanceMiddleware } from "./lib/requestPerformance";

const app: Express = express();

// SECURITY (Rate-Limit IP Bypass): trust exactly one proxy hop — the Replit
// edge. This makes `req.ip` reflect the real client IP (rightmost
// X-Forwarded-For entry appended by the edge) rather than a client-injected
// fake. Rate limiters and audit logs key on `req.ip` via `getRateLimitIp()`
// in lib/clientIp.ts; all express-rate-limit instances bind an explicit
// `keyGenerator` to that helper so the key never silently falls back to a
// bypass-able header. If the deployment topology changes (e.g. two proxy hops
// between the internet and the server), update this value accordingly.
app.set("trust proxy", 1);

app.use((req, res, next) => {
  const supplied = req.get("x-request-id")?.trim();
  const requestId = supplied && /^[A-Za-z0-9._:-]{1,80}$/.test(supplied)
    ? supplied
    : crypto.randomUUID();
  res.locals.requestId = requestId;
  res.setHeader("X-Request-ID", requestId);
  const releaseId = process.env.RELEASE_ID;
  if (releaseId && /^[A-Za-z0-9._:-]{1,80}$/.test(releaseId)) {
    res.setHeader("X-Release-ID", releaseId);
  }
  next();
});

app.use(requestPerformanceMiddleware);

const cspDirectives = {
  defaultSrc: ["'self'"],
  // TODO: switch scriptSrc/styleSrc to nonce-based CSP once template/SSR pipeline emits per-request nonces.
  scriptSrc: ["'self'"],
  styleSrc: ["'self'"],
  imgSrc: ["'self'", "data:", "https:"],
  fontSrc: ["'self'", "data:"],
  connectSrc: ["'self'", "https:"],
  frameSrc: ["'self'"],
  frameAncestors: ["'self'"],
  objectSrc: ["'none'"],
  baseUri: ["'self'"],
  formAction: ["'self'"],
};

// The public contract-review preview is served as its own HTML document
// (text/html) that the signing SPA loads inside a sandboxed <iframe src>. A
// document loaded via a real URL uses its OWN response CSP instead of
// inheriting the parent page's, so this scoped policy must allow the contract
// templates' inline <style> blocks and inline style="" attributes to render
// (the global style-src 'self' would otherwise blank the whole document). It
// still forbids all scripts (script-src 'none') so the sandboxed preview can
// never execute template markup. Images come from our own storage ('self'),
// signature data URLs (data:) and any https: asset the template references.
const signPreviewCspDirectives = {
  defaultSrc: ["'none'"],
  styleSrc: ["'unsafe-inline'"],
  imgSrc: ["'self'", "data:", "https:"],
  fontSrc: ["'self'", "data:", "https:"],
  scriptSrc: ["'none'"],
  objectSrc: ["'none'"],
  baseUri: ["'none'"],
  formAction: ["'none'"],
  // Only same-origin pages (the signing SPA) may frame this preview.
  frameAncestors: ["'self'"],
};

app.use((req, res, next) => {
  const isEmbed = req.path.startsWith("/api/public/embed/");
  const isWidget = isEmbed && req.path.endsWith("/widget");
  const isSignPreviewHtml =
    req.path.startsWith("/api/public/sign/") && req.path.endsWith("/preview.html");

  if (isSignPreviewHtml) {
    helmet({
      contentSecurityPolicy: { directives: signPreviewCspDirectives },
      crossOriginEmbedderPolicy: false,
    })(req, res, next);
  } else if (isEmbed) {
    helmet({
      contentSecurityPolicy: isWidget ? false : { directives: cspDirectives },
      crossOriginEmbedderPolicy: false,
      crossOriginResourcePolicy: { policy: "cross-origin" },
      crossOriginOpenerPolicy: false,
      frameguard: isWidget ? false : undefined,
    })(req, res, next);
  } else {
    helmet({
      contentSecurityPolicy: { directives: cspDirectives },
      crossOriginEmbedderPolicy: false,
    })(req, res, next);
  }
});

app.use((req, res, next) => {
  if (req.path.startsWith("/api/public/embed/") || req.path.startsWith("/api/public/lead")) {
    cors({ origin: true, credentials: false })(req, res, next);
  } else {
    cors({
      credentials: true,
      origin: (origin, callback) => {
        const host = req.get("host");
        const requestOrigin = host ? `${req.protocol}://${host}` : null;
        if (
          isCredentialedCorsOriginAllowed(
            origin,
            requestOrigin,
            getAllowedOrigins(),
            process.env.NODE_ENV,
          )
        ) {
          return callback(null, true);
        }
        const corsError = new Error(`CORS: origin ${origin} not allowed`) as Error & {
          status: number;
        };
        corsError.status = 403;
        return callback(corsError);
      },
    })(req, res, next);
  }
});

app.use((_req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  // Document scanning and voice notes are intentional first-party features.
  // Camera/microphone stay restricted to this origin; embed.js separately
  // delegates camera access to the cross-origin widget iframe it creates.
  res.setHeader("Permissions-Policy", "camera=(self), microphone=(self), geolocation=()");
  next();
});

app.use(cookieParser());

// gzip/br compression for JSON / text responses. Skip Server-Sent Events
// streams (text/event-stream) so events are flushed immediately to the
// client instead of being buffered by the compressor.
app.use(
  compression({
    filter: (req, res) => {
      const ct = String(res.getHeader("Content-Type") || "");
      if (ct.includes("text/event-stream")) return false;
      if (req.headers["x-no-compression"]) return false;
      return compression.filter(req, res);
    },
  }),
);

// Production performance guardrail. Log only genuinely slow API responses and
// never include query strings or request bodies (which may contain PII). This
// makes the next regression visible in PM2 logs without adding noise to normal
// traffic or holding the response open.
app.use((req, res, next) => {
  if (!req.path.startsWith("/api/")) return next();
  const startedAt = process.hrtime.bigint();
  res.once("finish", () => {
    const contentType = String(res.getHeader("Content-Type") || "");
    if (contentType.includes("text/event-stream")) return;
    const durationMs = Number(process.hrtime.bigint() - startedAt) / 1_000_000;
    if (durationMs < 1_500) return;
    console.warn("[slow-request]", JSON.stringify({
      requestId: res.locals.requestId,
      releaseId: process.env.RELEASE_ID || "unknown",
      method: req.method,
      path: req.path,
      status: res.statusCode,
      durationMs: Math.round(durationMs),
    }));
  });
  next();
});

// Webhook routes are mounted BEFORE express.json so the raw body is available
// for HMAC signature verification. These endpoints do not require auth or CSRF.
app.use("/api", webhooksRouter);

// Default body limit is intentionally small to reduce DoS surface on
// unauthenticated public/embed/webhook routes. Bulk-import endpoints that
// genuinely need larger payloads (e.g. /api/programs/bulk with 7000+ rows ×
// 50+ columns) opt-in to a higher local limit by attaching their own
// express.json({ limit: "20mb" }) middleware at the route level — we must
// skip the global parser for those paths so the route-level parser is the
// one that actually reads the body.
const LARGE_BODY_PATHS = [
  "/api/countries/bulk",
  "/api/cities/bulk",
  "/api/universities/bulk",
  "/api/programs/bulk",
  "/api/public/apply",
  "/api/public/ai/extract-document",
  "/api/public/embed",
  "/api/ai/extract-document",
  "/api/ai/extract-bulk-csv",
  // Task #202: lossless export/import for embed widgets and website forms.
  // Route handlers install their own 2 MB parser; bypass the 1 MB global cap.
  "/api/embed/widgets/import",
  "/api/website/forms/import",
  // Contract signing carries the signer's signature as a base64 PNG (drawn or
  // uploaded). The global 1 MB cap rejected larger images with a generic 413
  // long before the route's own 2 MB validation could run. The primary
  // onboarding sign route installs its own 3 MB parser.
  "/api/contracts/me/sign",
  // Contract brand/template forms may carry a private base64 PNG/JPEG company
  // signature (max 2 MB). Their routers install a dedicated 3 MB parser.
  "/api/contract-brands",
  "/api/contract-templates",
  // Public token-based signing also sends a base64 PNG; the route installs its
  // own 3 MB parser. Match the prefix so all /public/sign/:token/* sub-paths
  // (verify-code, intake, sign) bypass the global 1 MB cap.
  "/api/public/sign",
];
// Stage-document uploads send the file as base64 inside a JSON body. A 1MB
// file balloons to ~1.4MB after base64 + JSON envelope, so the global 1MB
// cap rejects perfectly legitimate uploads. The route at
// /api/applications/:id/stage-documents installs its own 25MB parser.
const LARGE_BODY_PATH_REGEXES: RegExp[] = [
  /^\/api\/applications\/\d+\/stage-documents(\/|$)/,
  // Admin-driven (non-onboarding) contract signing also carries a base64
  // signature image; the route installs its own 3 MB parser.
  /^\/api\/contracts\/me\/session\/\d+\/sign$/,
];
function isLargeBodyPath(path: string): boolean {
  for (const p of LARGE_BODY_PATHS) {
    if (path === p || path.startsWith(p + "/")) return true;
  }
  for (const re of LARGE_BODY_PATH_REGEXES) {
    if (re.test(path)) return true;
  }
  return false;
}
const globalJson = express.json({ limit: "1mb" });
const globalUrlencoded = express.urlencoded({ extended: true, limit: "1mb" });
app.use((req, res, next) => {
  if (isLargeBodyPath(req.path)) return next();
  globalJson(req, res, next);
});
app.use((req, res, next) => {
  if (isLargeBodyPath(req.path)) return next();
  globalUrlencoded(req, res, next);
});
app.use(authMiddleware);

const CSRF_COOKIE = "csrf_token";
const CSRF_HEADER = "x-csrf-token";
const CSRF_SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

app.use((req: Request, res: Response, next: NextFunction) => {
  // Bearer API-token requests carry no auth cookie and are immune to CSRF, so
  // they bypass the double-submit cookie check entirely.
  if ((req as any).apiTokenAuth) return next();

  if (
    req.path.startsWith("/api/public/") ||
    req.path.startsWith("/api/webhooks/") ||
    // The agent onboarding verify-with-link endpoint is hit by users clicking
    // an email button before any session/CSRF cookie has been issued. It is
    // protected by per-IP rate limiting and a single-use, time-bounded
    // 6-digit code bound to the email.
    req.path === "/api/agents/onboarding/verify-with-link" ||
    req.path === "/api/agents/onboarding/resend-public"
  ) {
    return next();
  }

  if (!req.cookies[CSRF_COOKIE]) {
    const token = crypto.randomBytes(32).toString("hex");
    res.cookie(CSRF_COOKIE, token, getCsrfCookieOptions(req, 7 * 24 * 60 * 60 * 1000));
    // Express does not add a response cookie back into req.cookies. Mark this
    // request so the SPA fallback handler does not issue a second, conflicting
    // csrf_token for the same response.
    (req as Request & { csrfCookieIssued?: boolean }).csrfCookieIssued = true;
  }

  if (!CSRF_SAFE_METHODS.has(req.method)) {
    const cookieToken = req.cookies[CSRF_COOKIE];
    const headerToken = req.headers[CSRF_HEADER];
    if (!cookieToken || !headerToken || cookieToken !== headerToken) {
      // Production returns this 403 silently, which is why CSRF failures (e.g.
      // an agent whose browser had no csrf_token cookie at contract-signing
      // time) produced "no log". Emit a structured line so the exact cause —
      // missing cookie vs missing header vs mismatch — is visible in prod logs.
      console.warn(
        "[csrf] rejected " +
          JSON.stringify({
            method: req.method,
            path: req.path,
            cookiePresent: Boolean(cookieToken),
            headerPresent: Boolean(headerToken),
            match: Boolean(cookieToken && headerToken && cookieToken === headerToken),
            userId: (req as any).user?.id ?? null,
            role: (req as any).user?.role ?? null,
            ua: req.headers["user-agent"] || null,
          }),
      );
      res.status(403).json({ error: "CSRF token missing or invalid" });
      return;
    }
  }

  next();
});

app.use("/api", router);

app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
  const status = (err as any).status || (err as any).statusCode || 500;
  const isSafe = status < 500;
  const message = isSafe ? err.message : "Internal server error";
  console.error("[error]", err.message, err.stack?.split("\n")[1]);
  res.status(status).json({ error: message });
});

export default app;
