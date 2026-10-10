import { NextResponse, type NextRequest } from "next/server";
import { serviceDb } from "@/lib/supabase/server";
import { parseCall, parseEnvelope, vaaniConfigured, verifyVaaniRequest, VAANI_CALL_EVENTS } from "@/lib/providers/vaani";
import { ingestVaaniCall } from "@/lib/server/vaani";
import { audit } from "@/lib/server/audit";

export const maxDuration = 60;

/**
 * Vaani outbound webhook. Register this URL in the Vaani dashboard (Developers → Webhooks) with the
 * same secret as VAANI_WEBHOOK_SECRET. Events are de-duplicated on their id (`<event>:<call_id>` for
 * dashboard webhooks), which stays the same across retries. Any 2xx acknowledges; a 5xx makes Vaani retry.
 */
export async function POST(req: NextRequest) {
  if (!vaaniConfigured()) return NextResponse.json({ error: "Vaani webhook secret not configured" }, { status: 503 });
  const raw = await req.text();
  const signed = verifyVaaniRequest(raw, {
    vaani: req.headers.get("x-vaani-signature"),
    timestamp: req.headers.get("x-vaani-timestamp"),
    vaanivoice: req.headers.get("x-vaanivoice-signature"),
  });
  if (!signed) {
    // Header names only (never values), so a signing mismatch with Vaani can be diagnosed.
    await audit({ event: "vaani.signature_rejected", status: "warning", metadata: { headers: [...req.headers.keys()].filter((k) => k.startsWith("x-") || k === "authorization").slice(0, 30), bytes: raw.length } });
    return NextResponse.json({ error: "invalid signature" }, { status: 401 });
  }

  let env;
  try {
    env = parseEnvelope(JSON.parse(raw), raw);
  } catch {
    // Signed by Vaani but not a call event (e.g. the dashboard's "Test Connectivity"): acknowledge and keep a sample.
    await audit({ event: "vaani.unrecognised", status: "info", metadata: { sample: raw.slice(0, 2000) } });
    return NextResponse.json({ ok: true, ignored: "unrecognised payload" });
  }

  const db = serviceDb();
  const seen = await db.from("aangan_webhook_events").insert({ provider: "vaani", event_id: env.id });
  if (seen.error?.code === "23505") {
    // Same event again: done unless the earlier attempt failed (then this retry processes it).
    const prev = await db.from("aangan_webhook_events").select("response").eq("provider", "vaani").eq("event_id", env.id).maybeSingle();
    if (!(prev.data?.response as { failed?: boolean } | null)?.failed) return NextResponse.json({ ok: true, duplicate: true });
  } else if (seen.error) {
    return NextResponse.json({ error: "could not record event" }, { status: 500 });
  }

  // Keep what Vaani actually sent (field names + a sample), so the mapping can be tightened from real data.
  await audit({ event: `vaani.${env.type}`, status: "info", externalId: env.id, metadata: { delivery: req.headers.get("x-vaanivoice-delivery"), data_keys: Object.keys(env.data), data_sample: JSON.stringify(env.data).slice(0, 4000) } });

  try {
    let result: unknown = { ignored: env.type };
    if (VAANI_CALL_EVENTS.has(env.type)) result = await ingestVaaniCall(parseCall(env));
    await db.from("aangan_webhook_events").update({ response: result as object }).eq("provider", "vaani").eq("event_id", env.id);
    return NextResponse.json({ ok: true, result });
  } catch (e) {
    // Mark it failed so Vaani's retry of the same event id is processed again.
    await db.from("aangan_webhook_events").update({ response: { failed: true } }).eq("provider", "vaani").eq("event_id", env.id);
    await audit({ event: "vaani.ingest_failed", status: "error", externalId: env.id, error: (e as Error).message });
    return NextResponse.json({ error: "processing failed; will be retried" }, { status: 500 });
  }
}
