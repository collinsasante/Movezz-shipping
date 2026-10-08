// One explicit data-backend selection. The live system is Airtable and stays the default; PostgreSQL is used only when
// MOVEZZ_DATA_BACKEND=postgres is set. An unknown value throws (no silent fallback, no mixed sources: a route is served entirely
// by one backend, and a PostgreSQL deployment needs DATABASE_URL and ACTOR_CONTEXT_KEY or every request fails closed).
import { readEnv } from "./env";
export type DataBackend = "airtable" | "postgres";

export function dataBackend(): DataBackend {
  const v = (readEnv("MOVEZZ_DATA_BACKEND") ?? "").trim().toLowerCase();
  if (v === "" || v === "airtable") return "airtable";
  if (v === "postgres") return "postgres";
  throw new Error("MOVEZZ_DATA_BACKEND must be 'airtable' or 'postgres'");
}

export const isPostgresBackend = (): boolean => dataBackend() === "postgres";
