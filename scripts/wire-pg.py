#!/usr/bin/env python3
# Inserts `if (isPostgresBackend()) return pg.<fn>(...)` at the top of Airtable route handlers (idempotent). Usage: wire-pg.py <module> route:METHOD:fn[:p] ...
import sys, re
mod = sys.argv[1]
for spec in sys.argv[2:]:
    route, method, fn, *p = spec.split(":")
    path = f"src/app/api/{route}/route.ts"
    s = open(path).read()
    if f"pg.{fn}(" in s: continue
    if "@/lib/backend" not in s:
        s = re.sub(r'(^import [^\n]*\n)', r'\1import { isPostgresBackend } from "@/lib/backend";\n', s, count=1, flags=re.M)
    imp = f'import * as pg from "@/lib/pg-routes/{mod}";\n'
    if imp not in s and f'/pg-routes/' not in s:
        s = s.replace('import { isPostgresBackend } from "@/lib/backend";\n', 'import { isPostgresBackend } from "@/lib/backend";\n' + imp, 1)
    elif f'/pg-routes/{mod}"' not in s:
        s = s.replace('import { isPostgresBackend } from "@/lib/backend";\n', 'import { isPostgresBackend } from "@/lib/backend";\n' + f'import * as pg_{mod.replace("-","_")} from "@/lib/pg-routes/{mod}";\n', 1)
    ref = "pg" if f'as pg from "@/lib/pg-routes/{mod}"' in s else "pg_" + mod.replace("-", "_")
    i = s.index(f"export async function {method}(")
    j = s.index(") {\n", i) + 4
    call = f"{ref}.{fn}(request, {{ params }})" if p else f"{ref}.{fn}(request)"
    s = s[:j] + f"  if (isPostgresBackend()) return {call};\n" + s[j:]
    open(path, "w").write(s)
