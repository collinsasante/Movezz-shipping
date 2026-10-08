// The in-memory Airtable is test infrastructure. These tests pin its behavior so
// that characterization results can be trusted.
import { describe, it, expect, beforeEach } from "vitest";
import { getDb } from "../helpers/fakeAirtable";
import Airtable from "../helpers/fakeAirtable";

const db = getDb();
beforeEach(() => db.reset());

async function query(table: string, formula?: string, sort?: { field: string; direction: "asc" | "desc" }[]) {
  const base = new Airtable().base("appX");
  const out: { id: string; fields: Record<string, unknown> }[] = [];
  await base(table).select({ filterByFormula: formula, sort }).eachPage((recs, next) => {
    out.push(...recs);
    next();
  });
  return out;
}

describe("fake Airtable: formula evaluation", () => {
  beforeEach(() => {
    db.insert("T", { Name: "Ada", Status: "Sorting", IsMissing: true, CartonNumber: "CTN-0001" }, "r1");
    db.insert("T", { Name: "Kofi", Status: "Completed" }, "r2");
    db.insert("T", { Name: "O'Brien", Status: "Sorting", Phone: "0244001111" }, "r3");
  });

  it("matches equality on text fields", async () => {
    expect((await query("T", "{Status} = 'Sorting'")).map((r) => r.id)).toEqual(["r1", "r3"]);
  });
  it("treats a checkbox as 1/0 and a blank checkbox as 0", async () => {
    expect((await query("T", "{IsMissing} = 1")).map((r) => r.id)).toEqual(["r1"]);
    expect((await query("T", "{IsMissing} = 0")).map((r) => r.id)).toEqual(["r2", "r3"]);
  });
  it("supports AND / OR / NOT", async () => {
    expect((await query("T", "AND({Status} = 'Sorting', {IsMissing} = 1)")).map((r) => r.id)).toEqual(["r1"]);
    expect((await query("T", "OR({Name} = 'Kofi', {Name} = 'Ada')")).map((r) => r.id)).toEqual(["r1", "r2"]);
    expect((await query("T", "NOT({CartonNumber} = '')")).map((r) => r.id)).toEqual(["r1"]);
  });
  it("supports SEARCH over LOWER(field) (case-insensitive substring)", async () => {
    expect((await query("T", "SEARCH('ad', LOWER({Name}))")).map((r) => r.id)).toEqual(["r1"]);
  });
  it("supports escaped quotes in string literals", async () => {
    expect((await query("T", "{Name} = 'O''Brien'")).map((r) => r.id)).toEqual(["r3"]);
  });
  it("supports RECORD_ID()", async () => {
    expect((await query("T", "RECORD_ID() = 'r2'")).map((r) => r.id)).toEqual(["r2"]);
  });
  it("supports FIND over ARRAYJOIN of a linked-record field", async () => {
    db.insert("L", { Link: ["recA", "recB"] }, "l1");
    db.insert("L", { Link: ["recC"] }, "l2");
    expect((await query("L", "FIND('recB', ARRAYJOIN({Link}))")).map((r) => r.id)).toEqual(["l1"]);
  });
  it("THROWS on unsupported functions so new query shapes fail loudly", async () => {
    await expect(query("T", "DATETIME_DIFF({Name}, {Name}, 'days') = 1")).rejects.toThrow(/unsupported formula function/);
  });
  it("sorts descending and ascending", async () => {
    expect((await query("T", undefined, [{ field: "Name", direction: "desc" }])).map((r) => r.id)).toEqual(["r3", "r2", "r1"]);
    expect((await query("T", undefined, [{ field: "Name", direction: "asc" }])).map((r) => r.id)).toEqual(["r1", "r2", "r3"]);
  });
});

describe("fake Airtable: write semantics", () => {
  it("omits empty values and clears a field when null/''/[] is written (like Airtable)", () => {
    const rec = db.create("T", { A: "x", B: "", C: [], D: false, E: 0 });
    expect(rec.fields).toEqual({ A: "x", E: 0 });
    const upd = db.update("T", rec.id, { A: null, E: 5 });
    expect(upd.fields).toEqual({ E: 5 });
  });
  it("throws a 404-style error for a missing record", () => {
    expect(() => db.find("T", "nope")).toThrow();
  });
  it("logs application calls but not test inspection or seeding", () => {
    db.insert("T", { A: 1 }, "r1");
    db.all("T");
    expect(db.calls).toHaveLength(0);
    db.find("T", "r1");
    expect(db.calls).toEqual([{ table: "T", op: "find", id: "r1" }]);
  });
});
