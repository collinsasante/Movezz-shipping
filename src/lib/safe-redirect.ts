// Open-redirect protection for post-login redirects. Only same-site absolute PATHS are accepted.
// Rejected: anything not starting with a single "/", protocol-relative "//host", backslashes
// ("/\host" is treated as "//host" by browsers), control characters / whitespace tricks, and any
// value that parses to a different origin.
export function safeRedirectPath(value: string | null | undefined, fallback: string): string {
  if (!value) return fallback;
  if (!value.startsWith("/") || value.startsWith("//")) return fallback;
  if (/[\\\u0000-\u001f\u007f]/.test(value)) return fallback;
  try {
    const base = "http://redirect-check.invalid";
    const url = new URL(value, base);
    if (url.origin !== base) return fallback;
    return url.pathname + url.search + url.hash;
  } catch {
    return fallback;
  }
}
