const UNSAFE_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

function readCsrfCookie(): string {
  const match = document.cookie.match(/(?:^|;\s*)csrf_token=([^;]+)/);
  return match ? match[1] : "";
}

function randomToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  let out = "";
  for (const b of bytes) out += b.toString(16).padStart(2, "0");
  return out;
}

// In production the SPA's HTML is served by the autoscale edge (static), which
// bypasses the Express CSRF middleware — so the csrf_token cookie is NOT set on
// page load, only on the first /api response. A client that fires an unsafe
// request before that first /api GET would have no cookie, send no x-csrf-token
// header, and get a silent 403. This is exactly what blocked agents on the
// contract-signing screen. Because the server's double-submit check only
// requires cookie === header (and the cookie is intentionally not httpOnly),
// the client can safely seed the pair itself. This removes the missing-cookie
// race regardless of how (or whether) the server sets the cookie.
function ensureCsrfToken(): string {
  let token = readCsrfCookie();
  if (!token) {
    token = randomToken();
    const secure = location.protocol === "https:" ? "; Secure" : "";
    document.cookie = `csrf_token=${token}; path=/; max-age=${7 * 24 * 60 * 60}; SameSite=Lax${secure}`;
  }
  return token;
}

// Seed immediately on module load so the cookie exists before any request fires.
ensureCsrfToken();

const originalFetch = window.fetch.bind(window);

window.fetch = function csrfFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const method = (init?.method || "GET").toUpperCase();

  if (UNSAFE_METHODS.has(method)) {
    const headers = new Headers(init?.headers);
    if (!headers.has("x-csrf-token")) {
      const token = ensureCsrfToken();
      if (token) headers.set("x-csrf-token", token);
    }
    return originalFetch(input, { ...init, headers });
  }

  return originalFetch(input, init);
};
