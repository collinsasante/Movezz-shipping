// Authentication: token handling (requireAuth), /api/auth/*, the first-user bootstrap and password handling.
// Firebase is mocked at the verifyIdToken() boundary (tests/setup/setup.ts); tokens come from world.asUser().
import { describe, it, expect, vi } from "vitest";
import { freshWorld, standardWorld } from "../helpers/world";
import { state } from "../helpers/state";
import { readSource } from "../helpers/sourceFn";
import { KNOWN_BUG, PRESERVE, FIXED } from "../helpers/known";

describe("token handling (requireAuth / getAuthUser)", () => {
  it(PRESERVE("no token -> 401 'Authentication required'"), async () => {
    const { w } = await standardWorld();
    const res = await w.call("items", "GET");
    expect(res.status).toBe(401);
    expect(res.json).toEqual({ success: false, error: "Authentication required" });
  });
  it(PRESERVE("an invalid or expired token -> 401 (verification failures are indistinguishable)"), async () => {
    const { w } = await standardWorld();
    expect((await w.call("items", "GET", { token: "garbage" })).status).toBe(401);
    const { w: w2, admin } = await standardWorld();
    vi.mocked(w2.firebase.verifyIdToken).mockRejectedValueOnce(new Error("TOKEN_EXPIRED"));
    expect((await w2.call("items", "GET", { token: admin })).status).toBe(401);
  });
  it(PRESERVE("a valid Firebase user with no Users row is treated as unauthenticated (401)"), async () => {
    const { w } = await standardWorld();
    const orphan = w.asUser("customer", { withUsersRow: false });
    expect((await w.call("items", "GET", { token: orphan })).status).toBe(401);
  });
  it(PRESERVE("accepts the token from the Authorization header or the auth-token cookie; the header wins"), async () => {
    const { w, admin } = await standardWorld();
    expect((await w.call("items", "GET", { token: admin, viaCookie: true })).status).toBe(200);
    expect((await w.call("items", "GET", { token: admin })).status).toBe(200);
    const both = await w.call("items", "GET", { token: "garbage", headers: { cookie: `auth-token=${admin}` } });
    expect(both.status).toBe(401); // bad bearer + good cookie -> header takes precedence
  });
  it(PRESERVE("resolves the role and the customer association from the Users row"), async () => {
    const { w, admin, staff, custA } = await standardWorld();
    expect((await w.call("customers", "GET", { token: admin })).status).toBe(200);
    expect((await w.call("customers", "GET", { token: staff })).status).toBe(200);
    expect((await w.call("customers", "GET", { token: custA })).status).toBe(403);
    w.seed.item("recI1", "recCustA");
    w.seed.item("recI2", "recCustB");
    const mine = await w.call("items", "GET", { token: custA });
    expect(mine.json?.data.map((i: { id: string }) => i.id)).toEqual(["recI1"]);
  });
  it(FIXED("a customer whose customer record is inactive is denied (403 ACCOUNT_INACTIVE)"), async () => {
    // Phase 4 documented that an inactive customer kept full API access. Interpretation (to be confirmed by the
    // owner, see docs/SECURITY-BASELINE.md): "inactive" means an administrator deactivated the account.
    const { w, custA } = await standardWorld();
    w.db.update("Customers", "recCustA", { Status: "inactive" });
    const res = await w.call("items", "GET", { token: custA });
    expect(res.status).toBe(403);
    expect(res.json?.code).toBe("ACCOUNT_INACTIVE");
  });
  it(FIXED("a customer login with no customer record, or a dangling link, is denied (403 CUSTOMER_NOT_LINKED)"), async () => {
    const { w } = await standardWorld();
    const orphan = w.asUser("customer");
    const dangling = w.asUser("customer", { customerId: "recDeleted" });
    for (const t of [orphan, dangling]) {
      const res = await w.call("items", "GET", { token: t });
      expect(res.status).toBe(403);
      expect(res.json?.code).toBe("CUSTOMER_NOT_LINKED");
    }
  });
  it(PRESERVE("deactivation does not affect staff or admins (they have no customer record)"), async () => {
    const { w, admin, staff } = await standardWorld();
    expect((await w.call("items", "GET", { token: admin })).status).toBe(200);
    expect((await w.call("items", "GET", { token: staff })).status).toBe(200);
  });
});

describe(KNOWN_BUG("per-process auth cache keeps stale roles and deleted users alive for 5 minutes"), () => {
  // Future behavior (Phase 3 ADR-5/8): role and is_active read from PostgreSQL on every request. Documents current behavior only.
  it("documents that a demoted admin keeps admin access until the cache entry expires", async () => {
    const { w, admin } = await standardWorld();
    expect((await w.call("users", "GET", { token: admin })).status).toBe(200);
    const row = w.db.all("Users").find((r) => r.fields["Role"] === "super_admin")!;
    w.db.update("Users", row.id, { Role: "customer" });
    expect((await w.call("users", "GET", { token: admin })).status).toBe(200); // still cached
    vi.setSystemTime(new Date("2026-03-15T10:06:00.000Z"));
    expect((await w.call("users", "GET", { token: admin })).status).toBe(403); // TTL (5 min) elapsed
  });
  it("documents that a deleted user keeps access until the cache entry expires", async () => {
    const { w, admin } = await standardWorld();
    await w.call("users", "GET", { token: admin });
    const row = w.db.all("Users").find((r) => r.fields["Role"] === "super_admin")!;
    w.db.destroy("Users", row.id);
    expect((await w.call("users", "GET", { token: admin })).status).toBe(200);
    vi.setSystemTime(new Date("2026-03-15T10:06:00.000Z"));
    expect((await w.call("users", "GET", { token: admin })).status).toBe(401);
  });
  it("verifies a token with Firebase only once per cache window", async () => {
    const { w, admin } = await standardWorld();
    await w.call("users", "GET", { token: admin });
    await w.call("users", "GET", { token: admin });
    expect(w.firebase.verifyIdToken).toHaveBeenCalledTimes(1);
  });
});

describe("POST /api/auth/verify", () => {
  const verify = (w: Awaited<ReturnType<typeof freshWorld>>, token: string, headers: Record<string, string> = {}) =>
    w.call("auth/verify", "POST", { body: { idToken: token }, headers });

  it(PRESERVE("returns the user and sets an HttpOnly, Secure, SameSite=Strict, 1-hour cookie"), async () => {
    const { w, custA } = await standardWorld();
    w.db.update("Customers", "recCustA", { CustomerPackage: "business" });
    const res = await verify(w, custA);
    expect(res.status).toBe(200);
    expect(res.json?.data.user).toMatchObject({ role: "customer", customerId: "recCustA", shippingMark: "MOVEZZ-AM1111", package: "business" });
    const cookie = res.headers.get("set-cookie") ?? "";
    expect(cookie).toContain(`auth-token=${custA}`);
    for (const flag of ["HttpOnly", "Secure", "SameSite=Strict", "Max-Age=3600", "Path=/"]) expect(cookie).toContain(flag);
  });
  it(PRESERVE("rejects a missing idToken (400)"), async () => {
    const { w } = await standardWorld();
    expect((await w.call("auth/verify", "POST", { body: {} })).status).toBe(400);
  });
  it(FIXED("an invalid token no longer returns the verification error text"), async () => {
    const { w } = await standardWorld();
    const res = await verify(w, "garbage");
    expect(res.status).toBe(401);
    expect(res.json).toEqual({ success: false, error: "Invalid or expired token" });
  });
  it(PRESERVE("DELETE clears the cookie"), async () => {
    const { w } = await standardWorld();
    const res = await w.call("auth/verify", "DELETE");
    expect(res.headers.get("set-cookie")).toContain("Max-Age=0");
  });
  it(PRESERVE("a Firebase user with a VERIFIED e-mail matching an admin-created Customers row is registered as that customer"), async () => {
    const { w } = await standardWorld();
    w.seed.customer("recCustD", { Email: "dana@example.invalid" });
    const token = w.asUser("customer", { withUsersRow: false, email: "dana@example.invalid", emailVerified: true });
    const res = await verify(w, token);
    expect(res.status).toBe(200);
    expect(res.json?.data.user).toMatchObject({ role: "customer", customerId: "recCustD" });
    await vi.waitFor(() => expect(w.db.get("Customers", "recCustD")?.fields["FirebaseUID"]).toBeDefined());
  });
  it(PRESERVE("an unknown Firebase user is rejected with 404 NOT_REGISTERED once any user exists"), async () => {
    const { w } = await standardWorld();
    const stranger = w.asUser("customer", { withUsersRow: false, email: "stranger@example.invalid" });
    const res = await verify(w, stranger);
    expect(res.status).toBe(404);
    expect(res.json?.code).toBe("NOT_REGISTERED");
  });
});

describe(FIXED("first-user bootstrap: no login is ever promoted to super_admin automatically"), () => {
  // Phase 4 pinned the old behavior (first Firebase login on an empty Users table became super_admin).
  it("an empty Users table plus a valid Firebase login creates NOTHING and is refused (404 NOT_REGISTERED)", async () => {
    const w = await freshWorld();
    const anyone = w.asUser("customer", { withUsersRow: false, email: "random.visitor@example.invalid" });
    const res = await w.call("auth/verify", "POST", { body: { idToken: anyone } });
    expect(res.status).toBe(404);
    expect(res.json?.code).toBe("NOT_REGISTERED");
    expect(w.db.all("Users")).toHaveLength(0);
    expect(res.headers.get("set-cookie")).toBeNull();
  });
  it("simultaneous first logins create no users at all", async () => {
    const w = await freshWorld();
    const a = w.asUser("customer", { withUsersRow: false, email: "a@example.invalid" });
    const b = w.asUser("customer", { withUsersRow: false, email: "b@example.invalid" });
    const results = await Promise.all([w.call("auth/verify", "POST", { body: { idToken: a } }), w.call("auth/verify", "POST", { body: { idToken: b } })]);
    expect(results.map((r) => r.status)).toEqual([404, 404]);
    expect(w.db.all("Users")).toHaveLength(0);
  });
  it("a token with no e-mail on an empty table is refused as well", async () => {
    const w = await freshWorld();
    state().tokens.set("token-no-email", { uid: "uid-noemail", email: "" });
    const res = await w.call("auth/verify", "POST", { body: { idToken: "token-no-email" } });
    expect(res.status).toBe(404);
    expect(w.db.all("Users")).toHaveLength(0);
  });
  it("an unknown Firebase UID is refused even when other users exist", async () => {
    const { w } = await standardWorld();
    const stranger = w.asUser("super_admin", { withUsersRow: false, email: "stranger@example.invalid" });
    const res = await w.call("auth/verify", "POST", { body: { idToken: stranger } });
    expect(res.status).toBe(404);
    expect(w.db.all("Users").some((u) => u.fields["Email"] === "stranger@example.invalid")).toBe(false);
  });
  it("the role is never taken from the request: a forged role in the body or a header changes nothing", async () => {
    const w = await freshWorld();
    const t = w.asUser("customer", { withUsersRow: false, email: "forger@example.invalid" });
    const res = await w.call("auth/verify", "POST", { body: { idToken: t, role: "super_admin", Role: "super_admin" }, headers: { "x-role": "super_admin" } });
    expect(res.status).toBe(404);
    expect(w.db.all("Users")).toHaveLength(0);
  });
  it("the e-mail claim of an existing Customers row requires a verified e-mail (no account takeover by registering someone else's address)", async () => {
    const { w } = await standardWorld();
    w.seed.customer("recVictim", { Email: "victim@example.invalid" });
    const attacker = w.asUser("customer", { withUsersRow: false, email: "victim@example.invalid", emailVerified: false });
    const res = await w.call("auth/verify", "POST", { body: { idToken: attacker } });
    expect(res.status).toBe(404);
    expect(w.db.all("Users").some((u) => u.fields["Email"] === "victim@example.invalid")).toBe(false);
  });
  it("a customer row already owned by another login cannot be claimed by e-mail", async () => {
    const { w } = await standardWorld();
    w.seed.customer("recOwned", { Email: "owned@example.invalid", FirebaseUID: "someone-elses-uid" });
    const claimer = w.asUser("customer", { withUsersRow: false, email: "owned@example.invalid", emailVerified: true });
    expect((await w.call("auth/verify", "POST", { body: { idToken: claimer } })).status).toBe(404);
  });
  it("a deactivated customer cannot log in (403 ACCOUNT_INACTIVE) and receives no session cookie", async () => {
    const { w, custA } = await standardWorld();
    w.db.update("Customers", "recCustA", { Status: "inactive" });
    const res = await w.call("auth/verify", "POST", { body: { idToken: custA } });
    expect(res.status).toBe(403);
    expect(res.json?.code).toBe("ACCOUNT_INACTIVE");
    expect(res.headers.get("set-cookie")).toBeNull();
  });
  it("a customer login with no customer profile cannot log in (403 CUSTOMER_NOT_LINKED)", async () => {
    const { w } = await standardWorld();
    const orphan = w.asUser("customer");
    const res = await w.call("auth/verify", "POST", { body: { idToken: orphan } });
    expect(res.status).toBe(403);
    expect(res.json?.code).toBe("CUSTOMER_NOT_LINKED");
  });
  it("public registration can only ever create a CUSTOMER: signup and onboarding ignore a role in the body", async () => {
    const w = await freshWorld();
    const res = await w.call("onboard", "POST", { body: { name: "Mallory Evil", phone: "0244001234", email: "mallory@example.invalid", location: "Accra", role: "super_admin" } });
    expect(res.status).toBe(201);
    expect(w.db.all("Users").map((u) => u.fields["Role"])).toEqual(["customer"]);
    const signup = await w.call("auth/signup", "POST", { body: { flow: "email", name: "Eve Evil", phone: "0200000001", email: "eve@example.invalid", password: "a-long-enough-password", role: "super_admin" } });
    expect(signup.status).toBe(201);
    expect(w.db.all("Users").map((u) => u.fields["Role"])).toEqual(["customer", "customer"]);
  });
  it("staff cannot be created through any public endpoint; POST /api/users is admin-only and cannot create customers", async () => {
    const { w, admin, staff, custA } = await standardWorld();
    expect((await w.call("users", "POST", { token: staff, body: { email: "x@example.invalid", role: "super_admin" } })).status).toBe(403);
    expect((await w.call("users", "POST", { token: custA, body: { email: "x@example.invalid", role: "super_admin" } })).status).toBe(403);
    expect((await w.call("users", "POST", { token: admin, body: { email: "x@example.invalid", role: "customer" } })).status).toBe(400);
  });
});

describe(KNOWN_BUG("auth rate limiting is per process and keyed by a spoofable header"), () => {
  it("documents that 20 verifications/minute per 'IP' are allowed, then 429, and a different X-Forwarded-For resets the budget", async () => {
    const { w } = await standardWorld();
    const hit = (ip: string) => w.call("auth/verify", "POST", { body: { idToken: "garbage" }, headers: { "x-forwarded-for": ip } });
    for (let i = 0; i < 20; i++) expect((await hit("1.1.1.1")).status).toBe(401);
    expect((await hit("1.1.1.1")).status).toBe(429);
    expect((await hit("2.2.2.2")).status).toBe(401); // attacker simply changes the header
  });
});

describe("GET /api/auth/verify-cookie", () => {
  it(PRESERVE("returns the enriched user for a valid cookie and 401 otherwise"), async () => {
    const { w, custA } = await standardWorld();
    const ok = await w.call("auth/verify-cookie", "GET", { token: custA, viaCookie: true });
    expect(ok.status).toBe(200);
    expect(ok.json?.data).toMatchObject({ role: "customer", shippingMark: "MOVEZZ-AM1111" });
    expect((await w.call("auth/verify-cookie", "GET")).status).toBe(401);
    expect((await w.call("auth/verify-cookie", "GET", { token: "garbage", viaCookie: true })).status).toBe(401);
  });
});

describe(FIXED("initial passwords are unguessable, never returned, and never typed by anyone"), () => {
  // The Firebase account needs SOME credential at creation; people set their own through the emailed reset link.
  const strong = /^[A-Za-z0-9_-]{43}aA1!$/;
  it("creating a staff account uses a CSPRNG password and does NOT return it", async () => {
    const { w, admin } = await standardWorld();
    const res = await w.call("users", "POST", { token: admin, body: { email: "new.staff@example.invalid", role: "warehouse_staff" } });
    expect(res.status).toBe(201);
    const used = vi.mocked(w.firebase.createFirebaseUser).mock.calls[0][1] as string;
    expect(used).toMatch(strong);
    expect(JSON.stringify(res.json)).not.toContain(used);
    expect(res.json?.data.tempPassword).toBeUndefined();
    expect(res.json?.data.emailSent).toBe(true); // a setup link is sent instead
  });
  it("two accounts never get the same initial password", async () => {
    const { w, admin } = await standardWorld();
    await w.call("users", "POST", { token: admin, body: { email: "a@example.invalid", role: "warehouse_staff" } });
    await w.call("users", "POST", { token: admin, body: { email: "b@example.invalid", role: "warehouse_staff" } });
    const [a, b] = vi.mocked(w.firebase.createFirebaseUser).mock.calls.map((c) => c[1]);
    expect(a).not.toBe(b);
  });
  it("public /api/onboard uses the same generator and returns nothing secret", async () => {
    const w = await freshWorld();
    const res = await w.call("onboard", "POST", { body: { name: "Ada Mensah", phone: "0244001234", email: "ada@example.invalid", location: "Accra" } });
    expect(res.status).toBe(201);
    const used = vi.mocked(w.firebase.createFirebaseUser).mock.calls[0][1] as string;
    expect(used).toMatch(strong);
    expect(JSON.stringify(res.json)).not.toContain(used);
  });
  it("admin-created customers use it too", async () => {
    const { w, admin } = await standardWorld();
    const res = await w.call("customers", "POST", { token: admin, body: { name: "Esi Owusu", phone: "0200009999", email: "esi@example.invalid" } });
    expect(res.status).toBe(201);
    expect(vi.mocked(w.firebase.createFirebaseUser).mock.calls[0][1]).toMatch(strong);
    expect(JSON.stringify(res.json)).not.toContain(String(vi.mocked(w.firebase.createFirebaseUser).mock.calls[0][1]));
  });
  it("source anchor: no Math.random password generation remains in the account-creation routes", () => {
    for (const f of ["src/app/api/users/route.ts", "src/app/api/customers/route.ts", "src/app/api/onboard/route.ts"]) {
      expect(readSource(f)).not.toContain("Math.random");
      expect(readSource(f)).not.toContain("PAKK-");
    }
  });
});

describe("public registration endpoints", () => {
  it(PRESERVE("/api/onboard creates customer + login + welcome email + reset link, with NO email verification or approval"), async () => {
    const w = await freshWorld();
    const res = await w.call("onboard", "POST", { body: { name: "Ada Mensah", phone: "0244001234", email: "ada@example.invalid", location: "Accra" } });
    expect(res.status).toBe(201);
    expect(w.db.all("Customers")).toHaveLength(1);
    expect(w.db.all("Users")[0].fields).toMatchObject({ Role: "customer", Email: "ada@example.invalid" });
    expect(w.email.sendWelcomeEmail).toHaveBeenCalled();
    expect(w.email.sendPasswordResetEmail).toHaveBeenCalled();
  });
  it(PRESERVE("/api/onboard rejects a duplicate phone number (400)"), async () => {
    const w = await freshWorld();
    w.seed.customer("recX", { Phone: "0244001234" });
    const res = await w.call("onboard", "POST", { body: { name: "Ada Mensah", phone: "0244001234", email: "ada@example.invalid", location: "Accra" } });
    expect(res.status).toBe(400);
  });
  it(KNOWN_BUG("public endpoints reveal whether an email or phone is already registered"), async () => {
    const w = await freshWorld();
    w.seed.customer("recX", { Phone: "0244001234", Email: "taken@example.invalid" });
    const res = await w.call("auth/signup", "POST", { body: { flow: "email", name: "Ada Mensah", phone: "0200000000", email: "taken@example.invalid", password: "a-long-enough-password" } });
    expect(res.status).toBe(400);
    expect(res.json?.error).toBe("An account with this email already exists");
  });
  it(PRESERVE("email signup lets the CLIENT choose the password (>= 8 characters) and creates customer + user rows"), async () => {
    const w = await freshWorld();
    const res = await w.call("auth/signup", "POST", { body: { flow: "email", name: "Ada Mensah", phone: "0244001234", email: "ada@example.invalid", password: "client-chosen-pw" } });
    expect(res.status).toBe(201);
    expect(vi.mocked(w.firebase.createFirebaseUser).mock.calls[0]).toEqual(["ada@example.invalid", "client-chosen-pw"]);
    expect(w.db.all("Users")).toHaveLength(1);
  });
  it(KNOWN_BUG("the signup/onboard rate limits are in-memory per process and keyed by a spoofable header"), async () => {
    const w = await freshWorld();
    const attempt = (n: number, ip: string) =>
      w.call("onboard", "POST", { body: { name: "Ada Mensah", phone: `02440011${String(n).padStart(2, "0")}`, email: `ada${n}@example.invalid`, location: "Accra" }, headers: { "x-forwarded-for": ip } });
    for (let i = 0; i < 5; i++) expect((await attempt(i, "9.9.9.9")).status).toBe(201);
    expect((await attempt(5, "9.9.9.9")).status).toBe(429);
    expect((await attempt(6, "8.8.8.8")).status).toBe(201); // new "IP", new budget
  });
});
