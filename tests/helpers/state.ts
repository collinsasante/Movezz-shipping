// Shared mutable test state.
//
// Tests call vi.resetModules() so every test gets a fresh copy of the
// application modules (the application keeps module-level caches). Anything that
// must survive a module reset - and be visible both to the mocked SDK factories
// and to the test code - therefore lives on globalThis.

export interface Identity {
  uid: string;
  email: string;
}

interface TestState {
  /** Firebase ID token -> identity, consulted by the mocked verifyIdToken(). */
  tokens: Map<string, Identity>;
  /** Every payload passed to the mocked Resend SDK. */
  sentEmails: { from?: string; to: string[]; subject: string; html: string }[];
  /** Every request the mocked outbound-network guard rejected. */
  blockedNetworkCalls: string[];
}

const KEY = "__MOVEZZ_TEST_STATE__";

export function state(): TestState {
  const g = globalThis as unknown as Record<string, TestState | undefined>;
  if (!g[KEY]) {
    g[KEY] = { tokens: new Map(), sentEmails: [], blockedNetworkCalls: [] };
  }
  return g[KEY]!;
}

export function resetState() {
  const s = state();
  s.tokens.clear();
  s.sentEmails.length = 0;
  s.blockedNetworkCalls.length = 0;
}
