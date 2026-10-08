# Tests

Run `npm test`. Background and the list of known bugs: [`docs/CHARACTERIZATION-BASELINE.md`](../docs/CHARACTERIZATION-BASELINE.md).

```
tests/
  setup/setup.ts        global setup: blocks the network, mocks every external SDK / integration module
  helpers/
    fakeAirtable.ts     in-memory stand-in for the `airtable` package (strict formula subset)
    world.ts            freshWorld() / standardWorld(): a new app instance, seeders, auth tokens, call()
    sourceFn.ts         runs a function straight from an application source file
    known.ts            KNOWN_BUG(...) / PRESERVE(...) / FIXED(...) title helpers
    state.ts            state shared across module resets (tokens, sent emails)
  unit/                 pure functions + the fake itself
  characterization/     routes + real data layer: what the app does today
  integration/          real Keepup client and email templates against stubbed I/O
  security/             authentication, authorization matrix, IDOR/BOLA, client-influence
```

## Writing a test

```ts
import { standardWorld } from "../helpers/world";

it("lets staff move an item forward", async () => {
  const { w, staff } = await standardWorld();   // customers A and B, one admin, one staff, one user per customer
  w.seed.item("recI1", "recCustA", { Status: "Sorting" });
  const res = await w.call("items/[id]/status", "PATCH", { token: staff, params: { id: "recI1" }, body: { status: "Ready for Pickup" } });
  expect(res.status).toBe(200);
});
```

- `w.db` is the fake Airtable (`w.db.get("Items", id)`, `w.db.all("Orders")`, `w.db.calls`, `w.db.beforeWrite` for failure injection).
- `w.keepup`, `w.email`, `w.firebase` are the mocked modules (`vi.mocked(w.keepup.createKeepupSale)`).
- Use `KNOWN_BUG("...")` for a describe/it that records **wrong** current behavior, and say which phase should fix it. Use `FIXED("...")` for a regression test of a defect that has been corrected.
- Never read `process.env` secrets or call `fetch` for real; the setup blocks it.
- The fake does **not** sync inverse linked records (real Airtable does) - seed both sides when a test needs them.
