// Structured, redacting operational log for the PostgreSQL layer (Phase 7J). Off unless a sink is installed (setLogSink) or MOVEZZ_LOG=json,
// so importing it changes no behaviour. One JSON object per event with a stable correlation id: the request id of the trusted actor
// (the same value stored on audit rows) or the batch/lease id of a worker run.
//
// What may be logged: event names, SQLSTATEs, constraint names, error CODES, table names, ids, counts, durations, attempt numbers.
// What may not: passwords, Firebase tokens, signing keys, connection strings, Authorization headers, customer names/e-mails/phones, payload
// bodies. Values under secret-looking keys are replaced; known secret patterns are scrubbed from every string; messages from the database are
// cut (a constraint violation message can echo a row value, so only the SQLSTATE and constraint name are kept).
import { DomainError } from "./errors";

type Level = "info" | "warn" | "error";
export type LogSink = (line: string) => void;
let sink: LogSink | null = null;
export function setLogSink(s: LogSink | null): void { sink = s; }
const active = (): LogSink | null => sink ?? (process.env.MOVEZZ_LOG === "json" ? (l) => process.stderr.write(l + "\n") : null);

const SECRET_KEY = /pass(word)?|secret|token|api[_-]?key|private|authorization|cookie|signature|credential|auth_uid|firebase|actor_context|e-?mail|phone|recipient|payload|name$/i;
const SCRUBS: [RegExp, string][] = [
  [/\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, "Bearer [REDACTED]"],
  [/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}/g, "[REDACTED_JWT]"],
  [/(postgres(?:ql)?:\/\/[^:\s/@]+:)[^@\s]+@/gi, "$1[REDACTED]@"],
  [/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, "[REDACTED_EMAIL]"],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g, "[REDACTED_KEY]"],
];
export function redact(value: unknown, depth = 0): unknown {
  if (value === null || value === undefined || typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value === "string") return SCRUBS.reduce((s, [re, to]) => s.replace(re, to), value).slice(0, 300);
  if (depth > 4) return "[depth]";
  if (Array.isArray(value)) return value.slice(0, 50).map((v) => redact(v, depth + 1));
  if (typeof value === "object") return Object.fromEntries(Object.entries(value as Record<string, unknown>).slice(0, 50).map(([k, v]) => [k, SECRET_KEY.test(k) ? "[REDACTED]" : redact(v, depth + 1)]));
  return String(value);
}

export function logEvent(level: Level, event: string, fields: Record<string, unknown> = {}, correlationId?: string | null): void {
  const s = active(); if (!s) return;
  try { s(JSON.stringify({ level, event, correlationId: correlationId ?? null, ...(redact(fields) as object) })); } catch { /* logging never breaks the operation */ }
}

/** Describes a failure WITHOUT its message text: code, SQLSTATE, constraint, table. Safe by construction. */
export function describeError(err: unknown): Record<string, unknown> {
  if (err instanceof DomainError) return { errorCode: err.code };
  const e = err as { code?: string; constraint?: string; table?: string; severity?: string; name?: string };
  return { errorName: e?.name, sqlstate: e?.code, constraint: e?.constraint, table: e?.table };
}
