#!/usr/bin/env node
/**
 * Creates the FIRST super_admin. Run deliberately, on a trusted machine:
 *
 *   npm run admin:bootstrap -- --email you@yourdomain.com
 *
 * You are asked to retype the e-mail to confirm, then to type the password (hidden).
 * Non-interactive use (e.g. a secret manager):
 *
 *   printf %s "$ADMIN_PW" | npm run admin:bootstrap -- --email you@yourdomain.com --confirm you@yourdomain.com --password-stdin
 *
 * Options: --dry-run (show the target, change nothing), --allow-additional (another admin when one exists).
 * Environment (from the shell or .env.local): NEXT_PUBLIC_FIREBASE_API_KEY, AIRTABLE_API_KEY, AIRTABLE_BASE_ID.
 * The password is never accepted as a flag, never generated and never printed.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import os from "node:os";
import { bootstrapAdmin, parseArgs, BootstrapError } from "./lib/bootstrap-admin.mjs";

function loadDotEnvLocal(env) {
  try {
    for (const raw of readFileSync(resolve(process.cwd(), ".env.local"), "utf8").split("\n")) {
      const line = raw.trim();
      if (!line || line.startsWith("#")) continue;
      const eq = line.indexOf("=");
      if (eq < 0) continue;
      const key = line.slice(0, eq).trim();
      let value = line.slice(eq + 1).trim();
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
      if (env[key] === undefined) env[key] = value;
    }
  } catch {
    /* no .env.local: rely on the real environment */
  }
}

function readLine(prompt, { hidden }) {
  return new Promise((resolveLine, reject) => {
    const { stdin, stdout } = process;
    if (!stdin.isTTY) return reject(new BootstrapError("No terminal available. Use --password-stdin and --confirm for non-interactive runs."));
    stdout.write(prompt);
    let buf = "";
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding("utf8");
    const onData = (ch) => {
      for (const c of ch) {
        if (c === "\r" || c === "\n") {
          stdin.setRawMode(false);
          stdin.pause();
          stdin.off("data", onData);
          stdout.write("\n");
          return resolveLine(buf);
        }
        if (c === "\u0003") {
          stdin.setRawMode(false);
          stdout.write("\n");
          process.exit(130);
        }
        if (c === "\u007f" || c === "\b") buf = buf.slice(0, -1);
        else {
          buf += c;
          if (!hidden) stdout.write(c);
        }
      }
    };
    stdin.on("data", onData);
  });
}

async function readStdinLine() {
  let data = "";
  for await (const chunk of process.stdin) data += chunk;
  return data.replace(/\r?\n$/, "");
}

async function main() {
  const env = { ...process.env };
  loadDotEnvLocal(env);
  const opts = parseArgs(process.argv.slice(2));
  const io = {
    log: (m) => console.log(m),
    confirm: (prompt) => readLine(prompt, { hidden: false }),
    getPassword: async () => {
      if (opts.passwordStdin) return readStdinLine();
      const first = await readLine("Password (hidden): ", { hidden: true });
      const second = await readLine("Repeat password (hidden): ", { hidden: true });
      if (first !== second) throw new BootstrapError("Passwords did not match. Nothing was changed.", 5);
      return first;
    },
  };
  await bootstrapAdmin({ opts, env, fetchImpl: fetch, io, operator: `${os.userInfo().username}@${os.hostname()}` });
}

main().catch((err) => {
  if (err instanceof BootstrapError) {
    console.error(`\n${err.message}`);
    process.exit(err.exitCode);
  }
  console.error("\nUnexpected error:", err instanceof Error ? err.message : "unknown");
  process.exit(1);
});
