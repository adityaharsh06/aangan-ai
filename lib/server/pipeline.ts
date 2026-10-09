import "server-only";
/**
 * The phone enquiry pipeline. Every inbound voice event flows through `handleVoiceEvent`:
 *
 *   call.started → contact (dedup by phone) → enquiry (or resume a dropped one) → greet (SLA clock stops)
 *   caller.utterance → extract facts → rules decide → approved reply (pricing-guarded)
 *   call.ended / closing reply → finalise: outcome, summary, outbox (Telegram, CRM, scheduling)
 *
 * The database is written before anything external is attempted, so a Telegram / Gemini / CRM
 * failure never loses a lead.
 */
import { serviceDb } from "@/lib/supabase/server";
import { callerTurn, startCall, type CallSession } from "@/lib/agent/conversation";
import { isAfterHours } from "@/lib/agent/policy";
import { summarise, templateSummary } from "@/lib/agent/summary";
import { evaluate } from "@/lib/qualification/engine";
import { BUSINESS } from "@/lib/knowledge/rules";
import { KNOWLEDGE_VERSION } from "@/lib/knowledge/source.generated";
import { normalisePhone, type VoiceEvent, type VoiceReply } from "@/lib/providers/voice";
import { alertMessage, designerHandoffMessage } from "@/lib/handoff";
import { audit, recordGeminiCost, recordVoiceCost } from "./audit";
import { dispatch, enqueue, type OutboxItem } from "./outbox";

const RESUME_WINDOW_MIN = 60;

type CallRow = {
  id: string;
  enquiry_id: string;
  provider: string;
  provider_call_id: string;
  from_number: string | null;
  started_at: string;
  status: string;
  session: CallSession;
};

function must<T>(r: { data: T | null; error: { message: string } | null }, what: string): NonNullable<T> {
  if (r.error || r.data === null || r.data === undefined) throw new Error(`${what}: ${r.error?.message ?? "no data"}`);
  return r.data as NonNullable<T>;
}

const appUrl = () => process.env.APP_BASE_URL?.replace(/\/$/, "") || null;

// ------------------------------------------------------------------------------------ entry

export interface HandleOptions {
  /** Simulator only: the call's clock was set by the tester, so measure answer time as processing time from that clock. */
  simulatedClock?: boolean;
}

export async function handleVoiceEvent(provider: string, evt: VoiceEvent, opts: HandleOptions = {}): Promise<VoiceReply> {
  const db = serviceDb();
  const t0 = Date.now();
  // Idempotency: a retried webhook returns the reply we already produced.
  const ins = await db.from("aangan_webhook_events").insert({ provider, event_id: evt.eventId });
  if (ins.error) {
    if (ins.error.code === "23505") {
      const prev = await db.from("aangan_webhook_events").select("response").eq("provider", provider).eq("event_id", evt.eventId).maybeSingle();
      return (prev.data?.response as VoiceReply | null) ?? { say: null, endCall: false };
    }
    throw new Error(`webhook log failed: ${ins.error.message}`);
  }
  let reply: VoiceReply;
  switch (evt.type) {
    case "call.started":
      reply = await onCallStarted(provider, evt, opts.simulatedClock ? t0 : null);
      break;
    case "caller.utterance":
      reply = await onUtterance(provider, evt);
      break;
    case "call.ended":
      reply = await onCallEnded(provider, evt);
      break;
    case "call.missed":
      reply = await onMissed(provider, evt);
      break;
  }
  await db.from("aangan_webhook_events").update({ response: reply }).eq("provider", provider).eq("event_id", evt.eventId);
  return reply;
}

// ------------------------------------------------------------------------------------ contacts

async function upsertContact(phone: string): Promise<string> {
  const db = serviceDb();
  const existing = await db.from("aangan_contacts").select("id").eq("phone", phone).maybeSingle();
  if (existing.data) return existing.data.id as string;
  const created = await db.from("aangan_contacts").insert({ phone }).select("id").single();
  if (created.error?.code === "23505") {
    const again = await db.from("aangan_contacts").select("id").eq("phone", phone).single();
    return must(again, "contact lookup").id as string;
  }
  return must(created, "contact insert").id as string;
}

// ------------------------------------------------------------------------------------ call.started

async function onCallStarted(provider: string, evt: Extract<VoiceEvent, { type: "call.started" }>, simulatedFrom: number | null): Promise<VoiceReply> {
  const db = serviceDb();
  const receivedAt = new Date(evt.at);
  const phone = normalisePhone(evt.from);
  const contactId = await upsertContact(phone);

  // T17: caller cut off and rang straight back → resume the same enquiry instead of starting over.
  const since = new Date(receivedAt.getTime() - RESUME_WINDOW_MIN * 60_000).toISOString();
  const recent = await db
    .from("aangan_enquiries")
    .select("id, status")
    .eq("contact_id", contactId)
    .in("status", ["incomplete", "in_progress"])
    .gte("received_at", since)
    .order("received_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  let enquiryId: string;
  let session: CallSession;
  let say: string;
  if (recent.data) {
    enquiryId = recent.data.id as string;
    const lastCall = await db.from("aangan_calls").select("session").eq("enquiry_id", enquiryId).order("started_at", { ascending: false }).limit(1).maybeSingle();
    const prevSession = lastCall.data?.session as CallSession | undefined;
    const fresh = startCall(receivedAt);
    session = prevSession ? { ...prevSession, dialogue: { ...prevSession.dialogue, phase: "open", closeReason: null, confusion: 0 } } : fresh.session;
    const lastQuestion = [...(prevSession?.turns ?? [])].reverse().find((t) => t.role === "agent" && t.text.trim().endsWith("?"));
    say = `Hello again, this is Aangan Studio's virtual assistant. It looks like we got cut off, but I still have what you told me.${lastQuestion && lastQuestion.text !== fresh.reply ? ` ${lastQuestion.text}` : " How can I help?"}`;
    session.turns = [...session.turns, { role: "agent", text: say, at: new Date().toISOString() }];
    await db.from("aangan_enquiries").update({ status: "in_progress", updated_at: new Date().toISOString() }).eq("id", enquiryId);
    await audit({ enquiryId, event: "call.resumed", status: "info", metadata: { provider_call_id: evt.callId } });
  } else {
    const created = await db
      .from("aangan_enquiries")
      .insert({ contact_id: contactId, source: "phone", status: "in_progress", received_at: receivedAt.toISOString(), after_hours: isAfterHours(receivedAt), knowledge_version: KNOWLEDGE_VERSION })
      .select("id")
      .single();
    enquiryId = must(created, "enquiry insert").id as string;
    const s = startCall(receivedAt);
    session = s.session;
    say = s.reply;
  }

  const answeredAt = simulatedFrom === null ? new Date() : new Date(receivedAt.getTime() + (Date.now() - simulatedFrom));
  const call = await db
    .from("aangan_calls")
    .insert({ provider, provider_call_id: evt.callId, enquiry_id: enquiryId, from_number: phone, started_at: receivedAt.toISOString(), answered_at: answeredAt.toISOString(), session })
    .select("id")
    .single();
  const callId = must(call, "call insert").id as string;

  // The five-minute SLA (case brief): first response measured from when the enquiry arrived.
  const enq = await db.from("aangan_enquiries").select("first_response_at, received_at").eq("id", enquiryId).single();
  if (!enq.data?.first_response_at) {
    const secs = Math.max(0, (answeredAt.getTime() - new Date(enq.data!.received_at as string).getTime()) / 1000);
    await db
      .from("aangan_enquiries")
      .update({ first_response_at: answeredAt.toISOString(), response_seconds: Math.round(secs * 10) / 10, within_sla: secs <= BUSINESS.responseSlaSeconds.value })
      .eq("id", enquiryId);
  }
  await audit({ enquiryId, callId, event: "call.answered", metadata: { provider, from: phone, after_hours: isAfterHours(receivedAt) } });
  return { say, endCall: false };
}

// ------------------------------------------------------------------------------------ utterance

async function loadCall(provider: string, providerCallId: string): Promise<CallRow | null> {
  const r = await serviceDb().from("aangan_calls").select("id, enquiry_id, provider, provider_call_id, from_number, started_at, status, session").eq("provider", provider).eq("provider_call_id", providerCallId).maybeSingle();
  if (r.error) throw new Error(`call lookup failed: ${r.error.message}`);
  return (r.data as CallRow | null) ?? null;
}

async function onUtterance(provider: string, evt: Extract<VoiceEvent, { type: "caller.utterance" }>): Promise<VoiceReply> {
  const db = serviceDb();
  const call = await loadCall(provider, evt.callId);
  if (!call) throw new Error("utterance for unknown call");
  if (call.status !== "in_progress") return { say: null, endCall: true };

  const out = await callerTurn(call.session, evt.text, new Date(evt.at), new Date(call.started_at));
  await db.from("aangan_calls").update({ session: out.session, updated_at: new Date().toISOString() }).eq("id", call.id);
  await db
    .from("aangan_enquiries")
    .update({
      facts: out.session.facts,
      call_type: out.session.facts.call_type,
      pricing_asked: out.session.facts.pricing_asked,
      criteria: out.evaluation.criteria,
      extraction_mode: out.extraction.mode,
      updated_at: new Date().toISOString(),
    })
    .eq("id", call.enquiry_id);

  await recordGeminiCost(call.enquiry_id, call.id, out.extraction.usage, "extraction");
  await audit({
    enquiryId: call.enquiry_id,
    callId: call.id,
    event: "turn.processed",
    status: out.extraction.mode === "gemini" ? "ok" : "warning",
    error: out.extraction.error ?? null,
    metadata: { action: out.action, extraction: out.extraction.mode, latency_ms: out.extraction.latencyMs ?? null, pricing_question: /price|cost|rate|how much|range/i.test(evt.text) },
  });

  if (out.endCall) await finalise(call.id, "agent_ended");
  return { say: out.reply, endCall: out.endCall };
}

// ------------------------------------------------------------------------------------ ended / missed

async function onCallEnded(provider: string, evt: Extract<VoiceEvent, { type: "call.ended" }>): Promise<VoiceReply> {
  const call = await loadCall(provider, evt.callId);
  if (!call) throw new Error("end for unknown call");
  if (call.status === "in_progress") await finalise(call.id, evt.reason, new Date(evt.at));
  return { say: null, endCall: true };
}

async function onMissed(provider: string, evt: Extract<VoiceEvent, { type: "call.missed" }>): Promise<VoiceReply> {
  // Should not happen while the agent answers every call; handled so a provider outage still produces a callback task.
  const db = serviceDb();
  const phone = normalisePhone(evt.from);
  const contactId = await upsertContact(phone);
  const at = new Date(evt.at);
  const inserted = await db
    .from("aangan_enquiries")
    .insert({ contact_id: contactId, source: "phone", status: "incomplete", received_at: at.toISOString(), after_hours: isAfterHours(at), knowledge_version: KNOWLEDGE_VERSION, summary: "Missed call: not answered." })
    .select("id")
    .single();
  const enquiryId = must(inserted, "missed enquiry insert").id as string;
  await db.from("aangan_calls").insert({ provider, provider_call_id: evt.callId, enquiry_id: enquiryId, from_number: phone, started_at: at.toISOString(), status: "missed" });
  await audit({ enquiryId, event: "call.missed", status: "warning" });
  await enqueue([{ enquiryId, channel: "telegram", kind: "missed_callback", idempotencyKey: `missed:${evt.callId}`, payload: { html: alertMessage("missed", { enquiryId, phone, name: null, detail: `Missed call at ${at.toISOString()}. Call back now to meet the five-minute standard.`, appUrl: appUrl() }) } }]);
  await dispatch({ enquiryId }).catch((e) => audit({ enquiryId, event: "outbox.dispatch_failed", status: "error", error: (e as Error).message }));
  return { say: null, endCall: true };
}

// ------------------------------------------------------------------------------------ finalise

const STATUS_BY_CLOSE: Record<string, string> = {
  qualified: "qualified",
  unqualified: "unqualified",
  escalated: "escalated",
  other: "other",
  needs_review: "needs_review",
  callback: "needs_review",
};

export async function finalise(callId: string, reason: string, endedAt = new Date()) {
  const db = serviceDb();
  // Claim the call atomically so a duplicate "ended" event can't finalise twice.
  const claimed = await db.from("aangan_calls").update({ status: reason === "dropped" || reason === "error" ? "dropped" : "completed", ended_at: endedAt.toISOString(), end_reason: reason }).eq("id", callId).eq("status", "in_progress").select("id, enquiry_id, started_at, from_number, session").maybeSingle();
  if (!claimed.data) return;
  const call = claimed.data as { id: string; enquiry_id: string; started_at: string; from_number: string | null; session: CallSession };
  const enquiryId = call.enquiry_id;
  const s = call.session;
  const f = s.facts;
  const ev = evaluate(f, s.dialogue.criterionAsked);
  const durationSec = Math.max(0, (endedAt.getTime() - new Date(call.started_at).getTime()) / 1000);
  await db.from("aangan_calls").update({ duration_seconds: Math.round(durationSec) }).eq("id", callId);

  let status = s.dialogue.closeReason ? STATUS_BY_CLOSE[s.dialogue.closeReason] : "incomplete";
  if (f.call_type === "existing_client") status = "escalated";
  const callback = s.dialogue.closeReason === "callback" || status === "incomplete";

  const enqRow = await db.from("aangan_enquiries").select("received_at, after_hours, response_seconds, override_status").eq("id", enquiryId).single();
  const enq = must(enqRow, "enquiry read");
  const finalStatus = (enq.override_status as string | null) ?? status;

  const sum = ["unqualified", "other"].includes(finalStatus)
    ? { summary: templateSummary(f, ev, finalStatus), mode: "template" as const, usage: undefined, error: undefined }
    : await summarise(s.turns, f, ev, finalStatus);
  await recordGeminiCost(enquiryId, callId, sum.usage, "summary");

  const qualified = finalStatus === "qualified";
  await db
    .from("aangan_enquiries")
    .update({
      status: finalStatus,
      call_type: f.call_type,
      facts: f,
      criteria: ev.criteria,
      qualification_reasons: ev.criteria.map((c) => `${c.label}: ${c.reason}`),
      uncertainty_notes: ev.notes,
      pricing_asked: f.pricing_asked,
      summary: sum.summary.summary,
      caller_concerns: sum.summary.caller_concerns,
      recommended_next_action: sum.summary.recommended_next_action,
      preferred_slots: f.preferred_slots,
      handoff_status: qualified ? "pending" : "not_required",
      scheduling_status: qualified && f.preferred_slots.length ? "slots_captured_pending_calendar" : "not_applicable",
      closed_at: endedAt.toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq("id", enquiryId);
  await audit({ enquiryId, callId, event: "enquiry.finalised", metadata: { status: finalStatus, failed: ev.failed, unclear: ev.blockingUnclear, summary_mode: sum.mode, end_reason: reason, duration_s: Math.round(durationSec) }, status: sum.error ? "warning" : "ok", error: sum.error ?? null });
  await recordVoiceCost(enquiryId, callId, durationSec);

  // Name / email onto the contact (dedup record).
  const contactPatch: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if (f.caller_name) contactPatch.name = f.caller_name;
  if (f.email) contactPatch.email = f.email;
  const phone = call.from_number ?? "unknown";
  await db.from("aangan_contacts").update(contactPatch).eq("phone", phone);

  const items: OutboxItem[] = [];
  if (qualified) {
    items.push({
      enquiryId,
      channel: "telegram",
      kind: "designer_handoff",
      idempotencyKey: `handoff:${enquiryId}`,
      payload: {
        html: designerHandoffMessage({
          enquiryId, phone, facts: f, criteria: ev.criteria, notes: ev.notes, summary: sum.summary.summary, concerns: sum.summary.caller_concerns,
          nextAction: sum.summary.recommended_next_action, receivedAt: enq.received_at as string, afterHours: Boolean(enq.after_hours),
          responseSeconds: (enq.response_seconds as number | null) ?? null, appUrl: appUrl(),
        }),
      },
    });
    if (f.preferred_slots.length) {
      items.push({ enquiryId, channel: "scheduling", kind: "preferred_slots", idempotencyKey: `sched:${enquiryId}`, payload: { enquiryId, phone, name: f.caller_name, slots: f.preferred_slots, siteVisit: f.site_visit_requested } });
    }
  }
  if (finalStatus === "escalated") {
    items.push({ enquiryId, channel: "telegram", kind: "escalation", idempotencyKey: `escalation:${enquiryId}`, payload: { html: alertMessage("escalation", { enquiryId, phone, name: f.caller_name, detail: f.existing_project_note ?? "Existing client calling about an ongoing project.", appUrl: appUrl() }) } });
  } else if (callback || finalStatus === "needs_review") {
    const detail = status === "incomplete" ? "Call ended before the enquiry was complete. Call back within five minutes." : `Couldn't confirm: ${ev.blockingUnclear.join(", ") || "caller asked for a person"}. Please call back.`;
    items.push({ enquiryId, channel: "telegram", kind: "callback", idempotencyKey: `callback:${enquiryId}:${callId}`, payload: { html: alertMessage("callback", { enquiryId, phone, name: f.caller_name, detail, appUrl: appUrl() }) } });
  }
  // Every caller goes to the CRM (HubSpot, later phase) so Nikhil sees the full pipeline.
  items.push({
    enquiryId,
    channel: "crm",
    kind: "upsert_lead",
    idempotencyKey: `crm:${enquiryId}:${finalStatus}`,
    payload: { enquiryId, phone, name: f.caller_name, email: f.email, status: finalStatus, summary: sum.summary.summary, facts: f, receivedAt: enq.received_at },
  });

  await enqueue(items);
  await dispatch({ enquiryId }).catch((e) => audit({ enquiryId, event: "outbox.dispatch_failed", status: "error", error: (e as Error).message }));
}

/** A manual override to "qualified" queues a handoff that the automated flow didn't send. */
export async function queueHandoffAfterOverride(enquiryId: string) {
  const db = serviceDb();
  const r = await db.from("aangan_enquiries").select("*, aangan_contacts(phone)").eq("id", enquiryId).single();
  const e = must(r, "enquiry read") as Record<string, unknown> & { aangan_contacts: { phone: string } | null };
  const f = e.facts as CallSession["facts"];
  const ev = evaluate(f, { real_project: true, service_area: true, timeline: true });
  await enqueue([
    {
      enquiryId,
      channel: "telegram",
      kind: "designer_handoff",
      idempotencyKey: `handoff:${enquiryId}`,
      payload: {
        html: designerHandoffMessage({
          enquiryId, phone: e.aangan_contacts?.phone ?? "unknown", facts: f, criteria: ev.criteria,
          notes: [...ev.notes, `Qualified by manual override: ${String(e.override_reason ?? "")}`],
          summary: String(e.summary ?? ""), concerns: (e.caller_concerns as string[]) ?? [], nextAction: String(e.recommended_next_action ?? "Call the caller to book a consultation."),
          receivedAt: String(e.received_at), afterHours: Boolean(e.after_hours), responseSeconds: (e.response_seconds as number | null) ?? null, appUrl: appUrl(),
        }),
      },
    },
  ]);
  return dispatch({ enquiryId });
}
