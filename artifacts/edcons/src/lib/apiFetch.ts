function getCsrfToken(): string {
  const match = document.cookie.match(/(?:^|;\s*)csrf_token=([^;]+)/);
  return match ? match[1] : "";
}

const UNSAFE_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

export async function apiFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const method = (init?.method || "GET").toUpperCase();
  const headers = new Headers(init?.headers);

  if (UNSAFE_METHODS.has(method)) {
    headers.set("x-csrf-token", getCsrfToken());
  }

  if (!headers.has("credentials")) {
    return fetch(input, { ...init, headers, credentials: "include" });
  }

  return fetch(input, { ...init, headers });
}
