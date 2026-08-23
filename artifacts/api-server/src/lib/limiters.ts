import rateLimit from "express-rate-limit";
import { PgRateLimitStore } from "./pgRateLimiter";
import { getRateLimitIp } from "./clientIp";

const WINDOW_MS = 15 * 60 * 1000;

export const publicLeadLimiter = rateLimit({
  windowMs: WINDOW_MS,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many submissions. Please try again later." },
  store: new PgRateLimitStore(WINDOW_MS, "lead"),
  // SECURITY: use the rightmost XFF entry (real client IP) so clients cannot
  // bypass the limit by injecting a fake IP in X-Forwarded-For.
  keyGenerator: (req) => getRateLimitIp(req),
});

// Per-IP throttle for unauthenticated public website form submissions.
// Limits each IP to 10 submissions per 15-minute window — the same policy
// applied to POST /api/public/lead. Using a separate store key so website-form
// counters are tracked independently from CRM lead intake.
export const publicFormLimiter = rateLimit({
  windowMs: WINDOW_MS,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many submissions. Please try again later." },
  store: new PgRateLimitStore(WINDOW_MS, "website-form"),
  keyGenerator: (req) => getRateLimitIp(req),
});
