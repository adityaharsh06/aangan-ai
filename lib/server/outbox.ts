import "server-only";
import { serviceDb } from "@/lib/supabase/server";
import { sendTelegram, telegramConfigured } from "@/lib/providers/telegram";
import { getCrm, getScheduling, type BookingRequest, type BookingResult, type CrmLead, type ProviderResult } from "@/lib/providers/integrations";
import { bookingMessage } from "@/lib/handoff";
import { audit } from "./audit";

export interface OutboxItem {
  enquiryId: string;
  channel: "telegram" | "crm" | "scheduling";
  kind: string;
  idempotencyKey: string;
  payload: Record<string, unknown>;
}

const MAX_ATTEMPTS = 6;

/** Insert-once: the unique idempotency key means a replayed event can't create a second message. */
export async function enqueue(items: OutboxItem[]) {
  if (!items.length) return;
  const { error } = await serviceDb()
    .from("aangan_outbox")
    .upsert(
      items.map((i) => ({ enquiry_id: i.enquiryId, channel: i.channel, kind: i.kind, idempotency_key: i.idempotencyKey, payload: i.payload })),
      { onConflict: "idempotency_key", ignoreDuplicates: true },
    );
  if (error) {
    await audit({ enquiryId: items[0].enquiryId, event: "outbox.enqueue_failed", status: "error", error: error.message });
    throw new Error(`Could not queue notifications: ${error.message}`);
  }
}

type Row = { id: string; enquiry_id: string; channel: string; kind: string; payload: Record<string, unknown>; attempts: number; status: string; idempotency_key: string };

async function deliver(row: Row): Promise<ProviderResult> {
  if (row.channel === "telegram") {
    const target = row.kind === "designer_handoff" || row.kind === "booking_update" ? "designer" : "alerts";
    const r = await sendTelegram(target, String(row.payload.html ?? ""));
    if (r.ok) return { ok: true, externalId: r.externalId };
    return { ok: false, notConfigured: "notConfigured" in r && r.notConfigured, error: r.error, retryable: "retryable" in r ? r.retryable : false };
  }
  if (row.channel === "crm") return getCrm().upsertLead(row.payload as unknown as CrmLead);
  if (row.channel === "scheduling") {
    const p = row.payload as Partial<BookingRequest> & { enquiryId: string; phone: string };
    const r = await getScheduling().book({ name: null, email: null, slots: [], siteVisit: false, site: null, ...p });
    if (r.ok) await afterBooking(row.enquiry_id, p, r);
    return r;
  }
  return { ok: false, error: `unknown channel ${row.channel}` };
}

/** Record the booking on the enquiry and tell the designers (Telegram, via the outbox). */
async function afterBooking(enquiryId: string, p: { phone: string; name?: string | null }, r: BookingResult) {
  await serviceDb()
    .from("aangan_enquiries")
    .update({ scheduling_status: r.outcome === "booked" ? `booked: ${r.startLabel} IST` : "booking_link_ready", updated_at: new Date().toISOString() })
    .eq("id", enquiryId);
  await audit({ enquiryId, event: r.outcome === "booked" ? "scheduling.booked" : "scheduling.link_created", externalId: r.externalId ?? null, metadata: { ...r } });
  await enqueue([
    {
      enquiryId,
      channel: "telegram",
      kind: "booking_update",
      idempotencyKey: `booking:${enquiryId}:${r.externalId ?? r.outcome}`,
      payload: { html: bookingMessage({ enquiryId, phone: p.phone, name: p.name ?? null, result: r, appUrl: process.env.APP_BASE_URL?.replace(/\/$/, "") || null }) },
    },
  ]);
  followUp.add(enquiryId);
}

/** Enquiries that gained a new outbox item during this dispatch (delivered in a second pass). */
const followUp = new Set<string>();

/**
 * Deliver due outbox rows (for one enquiry, or all). Failures are kept with backoff; nothing is
 * deleted. "not_configured" rows are re-tried whenever `includeNotConfigured` is set (e.g. after
 * Telegram credentials are added), so no lead is lost while an integration is missing.
 */
export async function dispatch(opts: { enquiryId?: string; includeNotConfigured?: boolean } = {}) {
  const db = serviceDb();
  const statuses = opts.includeNotConfigured ? ["pending", "failed", "not_configured"] : ["pending", "failed"];
  let q = db.from("aangan_outbox").select("id, enquiry_id, channel, kind, payload, attempts, status, idempotency_key").in("status", statuses).lt("attempts", MAX_ATTEMPTS).order("created_at").limit(25);
  if (opts.enquiryId) q = q.eq("enquiry_id", opts.enquiryId);
  else q = q.lte("next_attempt_at", new Date().toISOString());
  const { data, error } = await q;
  if (error) throw new Error(`Outbox read failed: ${error.message}`);

  const results: { id: string; status: string }[] = [];
  for (const row of (data ?? []) as Row[]) {
    let r: ProviderResult;
    try {
      r = await deliver(row);
    } catch (e) {
      r = { ok: false, error: (e as Error).message, retryable: true };
    }
    const attempts = row.attempts + (r.notConfigured ? 0 : 1);
    const status = r.ok ? "sent" : r.notConfigured ? "not_configured" : "failed";
    const backoffMin = Math.min(60, 2 ** attempts);
    await db
      .from("aangan_outbox")
      .update({
        status,
        attempts,
        last_error: r.ok ? null : r.error ?? null,
        external_id: r.externalId ?? null,
        sent_at: r.ok ? new Date().toISOString() : null,
        next_attempt_at: new Date(Date.now() + backoffMin * 60_000).toISOString(),
      })
      .eq("id", row.id);

    if (row.kind === "designer_handoff") {
      const hs = r.ok ? "sent" : r.notConfigured ? "not_configured" : "failed";
      await db.from("aangan_enquiries").update({ handoff_status: hs, handoff_sent_at: r.ok ? new Date().toISOString() : null, updated_at: new Date().toISOString() }).eq("id", row.enquiry_id);
    }
    if (row.channel === "crm") await db.from("aangan_enquiries").update({ crm_status: r.ok ? "synced" : r.notConfigured ? "pending_integration" : "failed" }).eq("id", row.enquiry_id);
    if (row.channel === "scheduling" && !r.ok) await db.from("aangan_enquiries").update({ scheduling_status: r.notConfigured ? "slots_captured_pending_calendar" : "failed" }).eq("id", row.enquiry_id);

    await audit({
      enquiryId: row.enquiry_id,
      event: `${row.channel}.${row.kind}.${status}`,
      status: r.ok ? "ok" : r.notConfigured ? "warning" : "error",
      externalId: r.externalId ?? null,
      error: r.ok ? null : r.error ?? null,
      metadata: { attempts, idempotency_key: row.idempotency_key },
    });
    results.push({ id: row.id, status });
  }
  // Second pass: deliver messages created by this pass (e.g. the booking note after a booking).
  const more = [...followUp].filter((id) => !opts.enquiryId || id === opts.enquiryId);
  followUp.clear();
  for (const id of more) results.push(...(await dispatch({ enquiryId: id })));
  return results;
}

export function integrationStatus() {
  return { telegram: telegramConfigured("designer"), crm: getCrm().name, scheduling: getScheduling().name };
}
