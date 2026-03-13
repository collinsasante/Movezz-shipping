// ============================================================
// RATE LIMITING — module-level in-memory store
// Works per-isolate in Cloudflare Workers. For production,
// supplement with Cloudflare Dashboard → Security → Rate Limiting.
// ============================================================

interface Entry {
  count: number;
  resetAt: number;
}

const store = new Map<string, Entry>();

// Periodic cleanup — remove expired entries
try {
  setInterval(() => {
    const now = Date.now();
    for (const [key, val] of store.entries()) {
      if (val.resetAt < now) store.delete(key);
    }
  }, 60_000);
} catch {
  // setInterval may not be available in all runtimes
}

/**
 * Returns true if the request is allowed, false if rate-limited.
 * @param key     Unique key — typically `ip:endpoint` or `email:endpoint`
 * @param max     Max requests allowed within the window
 * @param windowMs  Window duration in milliseconds
 */
export function checkRateLimit(key: string, max: number, windowMs: number): boolean {
  const now = Date.now();
  const entry = store.get(key);

  if (!entry || entry.resetAt < now) {
    store.set(key, { count: 1, resetAt: now + windowMs });
    return true;
  }

  if (entry.count >= max) return false;

  entry.count++;
  return true;
}

/** Returns a 429 Too Many Requests response */
export function rateLimitedResponse(retryAfterSeconds = 60) {
  return Response.json(
    { success: false, error: "Too many requests. Please try again later." },
    {
      status: 429,
      headers: { "Retry-After": String(retryAfterSeconds) },
    }
  );
}

/** Extract the best available IP from a Next.js request */
export function getClientIp(request: Request): string {
  return (
    request.headers.get("cf-connecting-ip") ??
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
    request.headers.get("x-real-ip") ??
    "unknown"
  );
}

/**
 * Returns a 413 response if the Content-Length header exceeds maxBytes.
 * Use before parsing request bodies to prevent large-payload abuse.
 * @param request  The incoming request
 * @param maxBytes Max allowed body size in bytes (default 1 MB)
 */
export function checkBodySize(
  request: Request,
  maxBytes = 1_048_576
): Response | null {
  const contentLength = request.headers.get("content-length");
  if (contentLength && parseInt(contentLength, 10) > maxBytes) {
    return Response.json(
      { success: false, error: "Request body too large" },
      { status: 413 }
    );
  }
  return null;
}
