// Destination rules for a real export: it contains customer data, so it may only be written to an existing directory OUTSIDE the repository and
// outside any git work tree, named explicitly a second time by the operator, as new files (never overwriting), readable by the owner only.
import { existsSync, realpathSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { ExportError } from "./export.mjs";

export function assertDestination(dir, confirm, repoRoot) {
  if (!dir || !confirm) throw new ExportError("DESTINATION", "--out-dir and --confirm-destination are both required");
  if (!path.isAbsolute(dir)) throw new ExportError("DESTINATION", "--out-dir must be an absolute path");
  if (path.resolve(dir) !== path.resolve(confirm)) throw new ExportError("DESTINATION", "--confirm-destination must equal --out-dir exactly");
  if (!existsSync(dir) || !statSync(dir).isDirectory()) throw new ExportError("DESTINATION", "the destination directory does not exist (create it first; it is never created implicitly)");
  const real = realpathSync(dir); const repo = realpathSync(repoRoot);
  if (real === repo || real.startsWith(repo + path.sep)) throw new ExportError("DESTINATION", "the destination must be outside the repository");
  for (let d = real; ; d = path.dirname(d)) { if (existsSync(path.join(d, ".git"))) throw new ExportError("DESTINATION", "the destination is inside a git work tree; exports must never be committable"); if (path.dirname(d) === d) break; }
  return real;
}
export function writeNew(file, text) { writeFileSync(file, text, { flag: "wx", mode: 0o600 }); }
