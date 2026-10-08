// Mints the signed, single-use, per-transaction IMPORT actor assertion verified by movezz_sec.begin_actor (migration 0010).
// Mirrors src/lib/db/actor.ts (parity is tested). The importer is a service identity: it never acts as a user, never receives a role,
// and the key (ACTOR_CONTEXT_KEY, base64, >= 32 bytes) is never logged.
import { createHmac, randomBytes } from "node:crypto";
import { ImportError } from "./errors.mjs";

export function actorKeyFromEnv(env = process.env) {
  const raw = env.ACTOR_CONTEXT_KEY;
  if (!raw) throw new ImportError("ACTOR_KEY", "ACTOR_CONTEXT_KEY is not configured for the importer");
  const key = Buffer.from(raw, "base64");
  if (key.length < 32) throw new ImportError("ACTOR_KEY", "ACTOR_CONTEXT_KEY must decode to at least 32 bytes");
  return key;
}

export function mintImportAssertion(key, requestId, now = new Date()) {
  if (!/^[A-Za-z0-9._:-]{1,128}$/.test(requestId)) throw new ImportError("ACTOR_REQUEST", "invalid request id");
  const jti = randomBytes(16).toString("hex");
  const exp = Math.floor(now.getTime() / 1000) + 60;
  const sig = createHmac("sha256", key).update(`v1|import||${requestId}|${jti}|${exp}`, "utf8").digest("hex");
  return { type: "import", userId: null, requestId, jti, exp, sig };
}

export async function beginImportActor(client, key, requestId) {
  const a = mintImportAssertion(key, requestId);
  await client.query("SELECT movezz_sec.begin_actor($1, $2, $3, $4, $5, $6)", [a.type, a.userId, a.requestId, a.jti, a.exp, a.sig]);
}
