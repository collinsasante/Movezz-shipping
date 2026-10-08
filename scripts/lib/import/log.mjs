// Structured, redacting event log for the importer. One JSON object per event, with a stable correlation id (the batch id once it exists).
// Nothing secret can be logged by accident: values under secret-looking keys are replaced, long strings are cut, and the standard patterns
// (bearer tokens, JWTs, connection-string passwords, PEM keys) are scrubbed from every string. Customer data is never an event field:
// events carry table names, source ids, categories, counts and durations only.
const SECRET_KEY = /pass(word)?|secret|token|api[_-]?key|private|authorization|cookie|signature|credential|auth_uid|firebase|actor_context/i;
const SCRUBS = [
  [/\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, "Bearer [REDACTED]"],
  [/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}/g, "[REDACTED_JWT]"],
  [/(postgres(?:ql)?:\/\/[^:\s/@]+:)[^@\s]+@/gi, "$1[REDACTED]@"],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g, "[REDACTED_KEY]"],
];
export function redact(value, depth = 0) {
  if (value === null || value === undefined) return value;
  if (typeof value === "string") return SCRUBS.reduce((s, [re, to]) => s.replace(re, to), value).slice(0, 500);
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (value instanceof Error) return { name: value.name, message: redact(String(value.message)), code: value.code };
  if (depth > 4) return "[depth]";
  if (Array.isArray(value)) return value.slice(0, 50).map((v) => redact(v, depth + 1));
  if (typeof value === "object") return Object.fromEntries(Object.entries(value).slice(0, 50).map(([k, v]) => [k, SECRET_KEY.test(k) ? "[REDACTED]" : redact(v, depth + 1)]));
  return String(value);
}
/** @param {{ sink?: (line: string) => void, correlationId?: string, component?: string }} [o] */
export function createLogger({ sink, correlationId, component = "import" } = {}) {
  let cid = correlationId ?? null;
  const emit = (level, event, fields = {}) => { if (sink) sink(JSON.stringify({ level, component, event, correlationId: cid, ...redact(fields) })); };
  return { info: (e, f) => emit("info", e, f), warn: (e, f) => emit("warn", e, f), error: (e, f) => emit("error", e, f), setCorrelationId(id) { cid = id; } };
}
export const noopLogger = createLogger();
