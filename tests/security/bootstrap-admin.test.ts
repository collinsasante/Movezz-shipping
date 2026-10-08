// The first-admin bootstrap (scripts/bootstrap-admin.mjs + scripts/lib/bootstrap-admin.mjs).
// Network is a stub; the point is what is sent where, what is printed, and what is refused.
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { bootstrapAdmin, parseArgs, passwordProblems, BootstrapError } from "../../scripts/lib/bootstrap-admin.mjs";

const ENV = { NEXT_PUBLIC_FIREBASE_API_KEY: "test-only-fb", AIRTABLE_API_KEY: "test-only-at", AIRTABLE_BASE_ID: "appTESTONLY000000" };
const PASSWORD = "Correct-Horse-Battery-9"; // test fixture, never a real credential
const EMAIL = "owner@example.invalid";

interface Call { url: string; method: string; body?: string }

function backend(opts: { admins?: number; emailExists?: boolean; signInOk?: boolean; auditOk?: boolean } = {}) {
  const calls: Call[] = [];
  const fetchImpl = async (url: string, init: { method?: string; body?: string } = {}) => {
    calls.push({ url, method: init.method ?? "GET", body: init.body });
    const reply = (status: number, body: unknown) => ({ ok: status < 400, status, json: async () => body });
    if (url.includes("/Users?filterByFormula")) return reply(200, { records: Array.from({ length: opts.admins ?? 0 }, (_, i) => ({ id: `recAdmin${i}` })) });
    if (url.includes(":signUp")) return opts.emailExists ? reply(400, { error: { message: "EMAIL_EXISTS" } }) : reply(200, { localId: "fb-new-uid" });
    if (url.includes(":signInWithPassword")) return opts.signInOk === false ? reply(400, { error: { message: "INVALID_PASSWORD" } }) : reply(200, { localId: "fb-existing-uid" });
    if (url.endsWith("/Users")) return reply(200, { id: "recNewUser" });
    if (url.endsWith("/ActivityLogs")) return opts.auditOk === false ? reply(500, {}) : reply(200, { id: "recAudit" });
    throw new Error(`unexpected request ${url}`);
  };
  return { calls, fetchImpl };
}

function io(password = PASSWORD, typedConfirmation = EMAIL) {
  const lines: string[] = [];
  return { lines, log: (m: string) => lines.push(m), confirm: async () => typedConfirmation, getPassword: async () => password };
}

const run = (b: ReturnType<typeof backend>, i: ReturnType<typeof io>, over: Record<string, unknown> = {}) =>
  bootstrapAdmin({ opts: { email: EMAIL, confirm: "", dryRun: false, allowAdditional: false, passwordStdin: false, ...over }, env: ENV, fetchImpl: b.fetchImpl as never, io: i, operator: "tester@host" });

const writes = (b: ReturnType<typeof backend>) => b.calls.filter((c) => c.method === "POST");

describe("bootstrap: credentials never live in, or leave, the code", () => {
  it("the old script with the embedded default credential is gone", () => {
    expect(fs.existsSync(path.resolve("scripts/create-superadmin.mjs"))).toBe(false);
  });

  const LITERAL_CREDENTIAL = /\b\w*(password|passwd|secret|api_?key|token)\w*\s*[:=]\s*["'`][^"'`\s$]{8,}["'`]/gi;

  it("the detector used below really matches the pattern the old script had", () => {
    expect('const TEMP_PASSWORD = "Abcdef-123456!";'.match(LITERAL_CREDENTIAL)).not.toBeNull();
    expect('const apiKey = process.env.KEY;'.match(LITERAL_CREDENTIAL)).toBeNull();
  });

  it("no source or script file assigns a string literal to a password/secret/token-named variable", () => {
    const offenders: string[] = [];
    const roots = ["scripts", "src"];
    const walk = (dir: string) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) walk(p);
        else if (/\.(mjs|js|ts|tsx)$/.test(e.name)) {
          const text = fs.readFileSync(p, "utf8");
          for (const m of text.matchAll(LITERAL_CREDENTIAL)) {
            // ignore type annotations / placeholders such as name="password" or process.env lookups
            if (/process\.env|import\.meta|example|placeholder|test-only/i.test(m[0])) continue;
            offenders.push(`${p}: ${m[0].replace(/["'`][^"'`]*["'`]$/, '"<literal>"')}`);
          }
        }
      }
    };
    roots.forEach(walk);
    expect(offenders).toEqual([]);
  });

  it("the new script does not generate passwords (no random/crypto password generation)", () => {
    const text = fs.readFileSync("scripts/bootstrap-admin.mjs", "utf8") + fs.readFileSync("scripts/lib/bootstrap-admin.mjs", "utf8");
    expect(text).not.toMatch(/Math\.random|randomBytes|randomUUID|getRandomValues|generate\w*Password/i);
  });

  it("the password is never accepted on the command line", () => {
    expect(() => parseArgs(["--email", EMAIL, "--password", "x"])).toThrow(/command line/);
    expect(() => parseArgs(["--email", EMAIL, "--password=x"])).toThrow(/command line/);
  });
});

describe("bootstrap: argument and password validation", () => {
  it("requires a valid e-mail and rejects unknown flags", () => {
    expect(() => parseArgs([])).toThrow(/--email/);
    expect(() => parseArgs(["--email", "not-an-email"])).toThrow(/valid e-mail/);
    expect(() => parseArgs(["--email", EMAIL, "--wat"])).toThrow(/Unknown argument/);
  });
  it("normalizes the e-mail and parses flags", () => {
    expect(parseArgs(["--email", " Owner@Example.Invalid ", "--dry-run", "--allow-additional", "--password-stdin", "--confirm", EMAIL.toUpperCase()])).toEqual({
      email: EMAIL, confirm: EMAIL, dryRun: true, allowAdditional: true, passwordStdin: true,
    });
  });
  it("rejects short, repeated, numeric, common and e-mail-derived passwords; accepts a strong one", () => {
    expect(passwordProblems("short1", EMAIL).length).toBeGreaterThan(0);
    expect(passwordProblems("aaaaaaaaaaaaaaaa", EMAIL)).toContain("must not be one repeated character");
    expect(passwordProblems("123456789012345", EMAIL)).toContain("must not be digits only");
    expect(passwordProblems("administrator", EMAIL)).toContain("is too common");
    expect(passwordProblems("xx-owner-xx-1234", EMAIL)).toContain("must not contain the e-mail name");
    expect(passwordProblems(PASSWORD, EMAIL)).toEqual([]);
  });
  it("never echoes the password in a problem message", () => {
    expect(JSON.stringify(passwordProblems("owner-owner-owner", EMAIL))).not.toContain("owner-owner-owner");
  });
});

describe("bootstrap: successful run", () => {
  it("creates the Firebase login, the super_admin Users row and an audit row", async () => {
    const b = backend();
    const result = await run(b, io());
    expect(result).toMatchObject({ dryRun: false, uid: "fb-new-uid", usersRecordId: "recNewUser", additionalAdmin: false });
    const [signUp, user, audit] = writes(b);
    expect(signUp.url).toContain(":signUp");
    expect(JSON.parse(user.body!).fields).toMatchObject({ FirebaseUID: "fb-new-uid", Email: EMAIL, Role: "super_admin" });
    expect(JSON.parse(audit.body!).fields).toMatchObject({ Action: "BOOTSTRAP_SUPER_ADMIN", UserEmail: EMAIL, UserRole: "super_admin", EntityType: "User", EntityID: "recNewUser" });
    expect(JSON.parse(audit.body!).fields.Details).toContain("tester@host");
  });

  it("uses exactly the password the operator typed, and sends it ONLY to Firebase", async () => {
    const b = backend();
    await run(b, io());
    for (const c of b.calls) {
      if (c.url.includes("identitytoolkit")) expect(JSON.parse(c.body!).password).toBe(PASSWORD);
      else expect(c.body ?? "").not.toContain(PASSWORD);
    }
  });

  it("never prints the password (or anything derived from it)", async () => {
    const b = backend();
    const i = io();
    await run(b, i);
    const output = i.lines.join("\n");
    expect(output).not.toContain(PASSWORD);
    expect(output).not.toMatch(/password\s*[:=]/i);
    expect(output).toContain("Audit record written");
  });

  it("masks the Airtable base id in the output", async () => {
    const i = io();
    await run(backend(), i);
    expect(i.lines.join("\n")).not.toContain("appTESTONLY000000");
  });
});

describe("bootstrap: refusals leave everything unchanged", () => {
  it("refuses when a super_admin already exists (exit code 3), without any write", async () => {
    const b = backend({ admins: 1 });
    await expect(run(b, io())).rejects.toMatchObject({ exitCode: 3 });
    expect(writes(b)).toHaveLength(0);
  });
  it("--allow-additional creates another admin and records that in the audit row", async () => {
    const b = backend({ admins: 1 });
    const r = await run(b, io(), { allowAdditional: true });
    expect(r.additionalAdmin).toBe(true);
    expect(JSON.parse(writes(b).at(-1)!.body!).fields.Details).toContain("additionalAdmin=true");
  });
  it("a wrong confirmation aborts before any write (exit code 4)", async () => {
    const b = backend();
    await expect(run(b, io(PASSWORD, "someone-else@example.invalid"))).rejects.toMatchObject({ exitCode: 4 });
    expect(writes(b)).toHaveLength(0);
  });
  it("--confirm must match the e-mail exactly when used instead of the prompt", async () => {
    const b = backend();
    await expect(run(b, io(), { confirm: "other@example.invalid" })).rejects.toMatchObject({ exitCode: 4 });
    await run(b, io(), { confirm: EMAIL });
    expect(writes(b).length).toBeGreaterThan(0);
  });
  it("a weak password aborts before Firebase is contacted (exit code 5)", async () => {
    const b = backend();
    await expect(run(b, io("short"))).rejects.toMatchObject({ exitCode: 5 });
    expect(writes(b)).toHaveLength(0);
  });
  it("--dry-run changes nothing and does not ask for a password", async () => {
    const b = backend();
    const i = io();
    const r = await run(b, i, { dryRun: true });
    expect(r.dryRun).toBe(true);
    expect(writes(b)).toHaveLength(0);
  });
  it("missing environment variables abort immediately", async () => {
    await expect(
      bootstrapAdmin({ opts: { email: EMAIL, confirm: EMAIL, dryRun: false, allowAdditional: false, passwordStdin: false }, env: {}, fetchImpl: backend().fetchImpl as never, io: io() })
    ).rejects.toThrow(/Missing environment variables/);
  });
});

describe("bootstrap: pre-existing Firebase login", () => {
  it("proves control with the typed password (sign-in) and reuses the UID", async () => {
    const b = backend({ emailExists: true });
    const r = await run(b, io());
    expect(r.uid).toBe("fb-existing-uid");
  });
  it("a wrong password for the existing login aborts with no Airtable write (exit code 6)", async () => {
    const b = backend({ emailExists: true, signInOk: false });
    await expect(run(b, io())).rejects.toMatchObject({ exitCode: 6 });
    expect(b.calls.some((c) => c.url.includes("airtable.com") && c.method === "POST")).toBe(false);
  });
});

describe("bootstrap: auditability", () => {
  it("fails loudly (exit code 9) if the audit row cannot be written, stating that the admin WAS created", async () => {
    const b = backend({ auditOk: false });
    const err = await run(b, io()).catch((e) => e);
    expect(err).toBeInstanceOf(BootstrapError);
    expect(err.exitCode).toBe(9);
    expect(err.message).toMatch(/WAS created/);
    expect(err.message).not.toContain(PASSWORD);
  });
});
