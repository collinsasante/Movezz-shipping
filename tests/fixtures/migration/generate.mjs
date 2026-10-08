#!/usr/bin/env node
// Regenerates the committed SYNTHETIC snapshot files from synthetic.mjs:  node tests/fixtures/migration/generate.mjs
// (tests/db/import-cli.test.ts fails if the committed files drift from the generator.)
import { writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { buildCleanSnapshot, buildMessySnapshot } from "./synthetic.mjs";

const dir = fileURLToPath(new URL(".", import.meta.url));
export const files = { "synthetic-clean.json": buildCleanSnapshot, "synthetic-messy.json": buildMessySnapshot };
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  for (const [name, build] of Object.entries(files)) await writeFile(dir + name, JSON.stringify(build(), null, 1) + "\n");
  console.log("written:", Object.keys(files).join(", "));
}
