// Environment lookup that also works inside a Cloudflare Worker, where `process.env` is only populated after the first request (and with this
// project's compatibility date possibly never): Worker secrets/vars are read from the Cloudflare request context as a fallback.
// process.env always wins, so Node, tests and local development behave exactly as before.
export function readEnv(key: string): string | undefined {
  const fromProcess = typeof process !== "undefined" ? process.env?.[key] : undefined;
  if (fromProcess !== undefined && fromProcess !== "") return fromProcess;
  const ctx = (globalThis as Record<symbol, unknown>)[Symbol.for("__cloudflare-context__")] as { env?: Record<string, unknown> } | undefined;
  const v = ctx?.env?.[key];
  return typeof v === "string" && v !== "" ? v : undefined;
}

/** A Hyperdrive binding (named HYPERDRIVE) exposes a pooled connection string; used only when DATABASE_URL is not set. */
export function hyperdriveUrl(): string | undefined {
  const ctx = (globalThis as Record<symbol, unknown>)[Symbol.for("__cloudflare-context__")] as { env?: { HYPERDRIVE?: { connectionString?: unknown } } } | undefined;
  const v = ctx?.env?.HYPERDRIVE?.connectionString;
  return typeof v === "string" && v !== "" ? v : undefined;
}
