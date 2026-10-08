// Small, dependency-free helpers shared by every import stage: strict decimals (no floating point money), canonical JSON,
// fingerprints and safe own-property access. Source data is untrusted: nothing here evaluates, merges or spreads it.
import { createHash } from "node:crypto";

export const IMPORTER_VERSION = "7I.1";

export const hasOwn = (o, k) => o !== null && typeof o === "object" && Object.prototype.hasOwnProperty.call(o, k);
/** Reads an OWN property only (never the prototype chain). */
export const get = (o, k) => (hasOwn(o, k) ? o[k] : undefined);

export function sha256Hex(text) {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/** Deterministic JSON: object keys sorted, undefined dropped. Used for fingerprints, never for parsing. */
export function canonicalJson(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value === undefined ? null : value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const keys = Object.keys(value).filter((k) => value[k] !== undefined).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(",")}}`;
}
export const fingerprint = (value) => sha256Hex(canonicalJson(value));

// ---- decimals --------------------------------------------------------------------------------------------------------
/**
 * Strict decimal parser. Accepts a finite JS number or a plain decimal string; rejects exponents, thousands separators, NaN,
 * Infinity, negative values (unless allowed) and any value with MORE decimals than `scale` (no silent rounding of money).
 * Returns { ok: true, units: BigInt, text: "123.45" } with `scale` decimals, or { ok: false, reason }.
 */
export function parseDecimal(raw, { scale = 2, allowNegative = false, max = 999_999_999_999n } = {}) {
  let s;
  if (typeof raw === "number") {
    if (!Number.isFinite(raw)) return { ok: false, reason: "not a finite number" };
    // JSON numbers come from IEEE doubles: 0.1 + 0.2 arrives as 0.30000000000000004. Doubles carry 15 reliable significant digits, so the
    // binary-representation noise beyond that is removed - a genuine third decimal (12.345) survives and is still refused for a 2-decimal field.
    s = String(Number(raw.toPrecision(15)));
    if (/e/i.test(s)) return { ok: false, reason: "exponent notation is not accepted" };
  } else if (typeof raw === "string") s = raw.trim();
  else return { ok: false, reason: "not a number" };
  const m = /^(-)?(\d{1,15})(?:\.(\d{1,12}))?$/.exec(s);
  if (!m) return { ok: false, reason: "not a plain decimal number" };
  if (m[1] && !allowNegative) return { ok: false, reason: "negative values are not accepted" };
  const frac = m[3] ?? "";
  if (frac.length > scale && /[1-9]/.test(frac.slice(scale))) return { ok: false, reason: `more than ${scale} decimal places` };
  const padded = (frac + "0".repeat(scale)).slice(0, scale);
  let units = BigInt(m[2] + padded);
  if (m[1]) units = -units;
  if (units > max * 10n ** BigInt(scale) || units < -max * 10n ** BigInt(scale)) return { ok: false, reason: "out of range" };
  return { ok: true, units, text: unitsToText(units, scale) };
}
export function unitsToText(units, scale) {
  const neg = units < 0n; const abs = (neg ? -units : units).toString().padStart(scale + 1, "0");
  const int = abs.slice(0, abs.length - scale); const frac = abs.slice(abs.length - scale);
  return `${neg ? "-" : ""}${int}${scale ? "." + frac : ""}`;
}
/** round-half-up of (a * b) where a has scale sa and b has scale sb, to `scale` decimals. Non-negative operands. */
export function mulRound(aUnits, sa, bUnits, sb, scale) {
  const num = aUnits * bUnits; const drop = BigInt(sa + sb - scale);
  if (drop <= 0n) return num * 10n ** -drop;
  const div = 10n ** drop;
  return (num + div / 2n) / div;
}

// ---- dates -----------------------------------------------------------------------------------------------------------
/** Accepts YYYY-MM-DD or an ISO-8601 timestamp with an explicit offset/Z. Returns { ok, iso, date } (UTC). No local-time guessing. */
export function parseTimestamp(raw) {
  if (typeof raw !== "string") return { ok: false, reason: "not a string" };
  const s = raw.trim();
  let m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (m) {
    const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
    if (d.getUTCFullYear() !== +m[1] || d.getUTCMonth() !== +m[2] - 1 || d.getUTCDate() !== +m[3]) return { ok: false, reason: "not a real calendar date" };
    return { ok: true, iso: `${s}T00:00:00.000Z`, date: s, dateOnly: true };
  }
  m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?(Z|[+-]\d{2}:\d{2})$/.exec(s);
  if (!m) return { ok: false, reason: "not an ISO-8601 date or timestamp with an explicit offset" };
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return { ok: false, reason: "not a real timestamp" };
  const chk = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  if (chk.getUTCMonth() !== +m[2] - 1 || chk.getUTCDate() !== +m[3] || +m[4] > 23 || +m[5] > 59 || (m[6] && +m[6] > 59)) return { ok: false, reason: "not a real timestamp" };
  const y = d.getUTCFullYear();
  if (y < 1990 || y > 2100) return { ok: false, reason: "year out of the plausible range" };
  return { ok: true, iso: d.toISOString(), date: d.toISOString().slice(0, 10), dateOnly: false };
}

export const isNonBlankString = (v) => typeof v === "string" && /\S/.test(v);
/** Collapses to a trimmed string; returns { value, changed }. */
export function cleanText(v) {
  if (typeof v !== "string") return { value: undefined, changed: false };
  const t = v.trim();
  return { value: t, changed: t !== v };
}
export const sortById = (rows) => [...rows].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
