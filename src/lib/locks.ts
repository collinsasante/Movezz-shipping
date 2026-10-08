// Serialises work per key inside ONE server process/isolate (e.g. two clicks on "create invoice", two
// simultaneous payments for the same order). It does NOT protect against requests handled by different
// isolates or instances - Airtable has no transactions or compare-and-set. The PostgreSQL phase replaces
// this with row locks / unique constraints; until then it only narrows the window.
const tails = new Map<string, Promise<unknown>>();

export async function withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = tails.get(key) ?? Promise.resolve();
  const run = prev.then(fn, fn);
  const tail = run.catch(() => undefined);
  tails.set(key, tail);
  try {
    return await run;
  } finally {
    if (tails.get(key) === tail) tails.delete(key);
  }
}
