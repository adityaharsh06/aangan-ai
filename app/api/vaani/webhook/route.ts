import { NextResponse, type NextRequest } from "next/server";
import { serviceDb } from "@/lib/supabase/server";
import { parseCall, parseEnvelope, vaaniConfigured, verifyVaaniSignature } from "@/lib/providers/vaani";
import { ingestVaaniCall } from "@/lib/server/vaani";
import { audit } from "@/lib/server/audit";

export const maxDuration = 60;

/**
 * Vaani Labs outbound webhook. Register this URL in the Vaani dashboard; Vaani signs every event
 * with the webhook secret (VAANI_WEBHOOK_SECRET). Events are de-duplicated on their `evt_` id,
 * which Vaani reuses across retries. Any 2xx acknowledges; a 5xx makes Vaani retry with backoff.
 */
export async function POST(req: NextRequest) {
  if (!vaaniConfigured()) return NextResponse.json({ error: "Vaani webhook secret not configured" }, { status: 503 });
  const raw = await req.text();
  if (!verifyVaaniSignature(raw, req.headers.get("x-vaanivoice-signature"))) return NextResponse.json({ error: "invalid signature" }, { status: 401 });

  let env;
  try {
    env = parseEnvelope(JSON.parse(raw));
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 400 });
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
    if (env.type === "call.completed" || env.type === "lead.created") result = await ingestVaaniCall(parseCall(env));
    await db.from("aangan_webhook_events").update({ response: result as object }).eq("provider", "vaani").eq("event_id", env.id);
    return NextResponse.json({ ok: true, result });
  } catch (e) {
    // Mark it failed so Vaani's retry of the same event id is processed again.
    await db.from("aangan_webhook_events").update({ response: { failed: true } }).eq("provider", "vaani").eq("event_id", env.id);
    await audit({ event: "vaani.ingest_failed", status: "error", externalId: env.id, error: (e as Error).message });
    return NextResponse.json({ error: "processing failed; will be retried" }, { status: 500 });
  }
}
