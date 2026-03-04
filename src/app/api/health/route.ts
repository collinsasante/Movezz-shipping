export async function GET() {
  console.log("[health] Worker is alive");
  console.log("[health] NODE_ENV:", process.env.NODE_ENV);
  console.log("[health] FIREBASE_PROJECT_ID:", process.env.FIREBASE_PROJECT_ID ? "✓ set" : "MISSING");
  console.log("[health] AIRTABLE_BASE_ID:", process.env.AIRTABLE_BASE_ID ? "✓ set" : "MISSING");
  return Response.json({ ok: true, time: Date.now() });
}
