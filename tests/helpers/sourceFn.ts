// Extracts a top-level function from an application source file and returns it as a
// callable, so the tests can run the REAL code that currently lives inside React page
// components (these formulas are not exported). If the function moves or changes
// shape, the extraction fails loudly and the characterization must be revisited.
import fs from "node:fs";
import path from "node:path";
import ts from "typescript";

export function readSource(relPath: string): string {
  return fs.readFileSync(path.resolve(process.cwd(), relPath), "utf8");
}

export function loadFunction<T extends (...args: never[]) => unknown>(relPath: string, name: string): T {
  const src = readSource(relPath);
  const start = src.search(new RegExp(`function\\s+${name}\\s*\\(`));
  if (start < 0) throw new Error(`function ${name} not found in ${relPath}`);

  // walk the parameter list (balanced parentheses), then the body (balanced braces)
  let i = src.indexOf("(", start);
  let depth = 0;
  for (; i < src.length; i++) {
    if (src[i] === "(") depth++;
    else if (src[i] === ")" && --depth === 0) break;
  }
  const bodyStart = src.indexOf("{", i);
  depth = 0;
  let end = bodyStart;
  for (; end < src.length; end++) {
    if (src[end] === "{") depth++;
    else if (src[end] === "}" && --depth === 0) break;
  }
  const fnSource = src.slice(start, end + 1);
  const js = ts.transpileModule(fnSource, {
    compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.None },
  }).outputText;
  return new Function(`${js}\nreturn ${name};`)() as T;
}
