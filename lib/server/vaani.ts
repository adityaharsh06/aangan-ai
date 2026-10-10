import "server-only";
/**
 * Turns a finished Vaani call into an Aangan enquiry. Vaani's agent held the conversation, so
 * here we only understand and decide: extract facts from the whole transcript, judge them with
 * the same rules engine, then hand over to `finalise` for the summary, Telegram handoff, Calendly
 * booking and CRM queue, exactly as for a call the in-app agent handled.
 */
import { serviceDb } from "@/lib/supabase/server";
import { extractFacts } from "@/lib/agent/extract";
import { containsPricing } from "@/lib/agent/guard";
import { isAfterHours } from "@/lib/agent/policy";
import { initialDialogueState, type DialogueState } from "@/lib/agent/types";
import type { CallSession } from "@/lib/agent/conversation";
import { emptyFacts, mergeFacts } from "@/lib/domain/facts";
import { evaluate } from "@/lib/qualification/engine";
import { KNOWLEDGE_VERSION } from "@/lib/knowledge/source.generated";
import { normalisePhone } from "@/lib/providers/voice";
import type { VaaniCall } from "@/lib/providers/vaani";
import { audit, recordGeminiCost } from "./audit";
import { finalise, upsertContact } from "./pipeline";

const PROVIDER = "vaani";

export async function ingestVaaniCall(call: VaaniCall): Promise<{ enquiryId: string; status: string } | { duplicate: true }> {
  const db = serviceDb();
  const existing = await db.from("aangan_calls").select("id, enquiry_id").eq("provider", PROVIDER).eq("provider_call_id", call.callId).maybeSingle();
  if (existing.data) {
    // An earlier attempt was cut off before finishing (the route only retries after it has stalled for
    // 2 minutes, past the function limit): reopen the call and finish it rather than leave it half-done.
    const enquiryId = existing.data.enquiry_id as string;
    const st = await db.from("aangan_enquiries").select("status").eq("id", enquiryId).single();
    if (st.data?.status !== "in_progress") return { duplicate: true };
    await db.from("aangan_calls").update({ status: "in_progress" }).eq("id", existing.data.id);
    await audit({ enquiryId, callId: existing.data.id as string, event: "vaani.resumed", status: "warning", metadata: { reason: "previous attempt did not finish" } });
    await finalise(existing.data.id as string, "completed", call.endedAt);
    const after = await db.from("aangan_enquiries").select("status").eq("id", enquiryId).single();
    return { enquiryId, status: String(after.data?.status ?? "in_progress") };
  }

  const x = call.turns.length ? await extractFacts(call.turns, call.startedAt) : null;
  const facts = mergeFacts(emptyFacts(), x?.facts ?? {});
  // Vaani's agent asked its questions already; anything still unclear goes to a person.
  const ev = evaluate(facts, { real_project: true, service_area: true, timeline: true });
  const closeReason: DialogueState["closeReason"] = !call.turns.length
    ? "needs_review"
    : facts.call_type === "existing_client"
      ? "escalated"
      : facts.call_type === "other"
        ? "other"
        : ev.outcome === "qualified"
          ? "qualified"
          : ev.outcome === "unqualified"
            ? "unqualified"
            : "needs_review";

  // Vaani masks the caller's number, so the number the caller gave is the one we call back on.
  const phone = facts.callback_phone ? normalisePhone(facts.callback_phone) : call.from ? `vaani-masked:${call.from}` : `vaani:${call.callId}`;
  const contactId = await upsertContact(phone);
  const enq = await db
    .from("aangan_enquiries")
    .insert({
      contact_id: contactId,
      source: "phone",
      status: "in_progress",
      received_at: call.startedAt.toISOString(),
      // Vaani's agent picks up live, so the first response is at the start of the call.
      first_response_at: call.startedAt.toISOString(),
      response_seconds: 0,
      within_sla: true,
      after_hours: isAfterHours(call.startedAt),
      knowledge_version: KNOWLEDGE_VERSION,
      facts,
      criteria: ev.criteria,
      call_type: facts.call_type,
      extraction_mode: x?.mode ?? null,
    })
    .select("id")
    .single();
  if (enq.error || !enq.data) throw new Error(`enquiry insert failed: ${enq.error?.message}`);
  const enquiryId = enq.data.id as string;

  const session: CallSession = {
    facts,
    turns: call.turns,
    dialogue: { ...initialDialogueState(), phase: "closed", closeReason, criterionAsked: { real_project: true, service_area: true, timeline: true } },
  };
  const ins = await db
    .from("aangan_calls")
    .insert({ provider: PROVIDER, provider_call_id: call.callId, enquiry_id: enquiryId, from_number: phone, started_at: call.startedAt.toISOString(), answered_at: call.startedAt.toISOString(), session })
    .select("id")
    .single();
  if (ins.error || !ins.data) {
    // Lost a race with another delivery of the same call: retire our copy (rows are never deleted).
    if (ins.error?.code === "23505") {
      await db.from("aangan_enquiries").update({ status: "other", summary: "Duplicate Vaani delivery of a call already recorded; ignored." }).eq("id", enquiryId);
      return { duplicate: true };
    }
    throw new Error(`call insert failed: ${ins.error?.message}`);
  }
  const callRowId = ins.data.id as string;

  await recordGeminiCost(enquiryId, callRowId, x?.usage, "extraction");
  await audit({ enquiryId, callId: callRowId, event: "vaani.call_ingested", status: x?.mode === "gemini" ? "ok" : "warning", error: x?.error ?? null, metadata: { turns: call.turns.length, close: closeReason, phone_source: facts.callback_phone ? "caller_said" : "vaani_masked" } });

  // Vaani's agent speaks from its own flow, outside our pricing guard: check what it said.
  const leaks = call.turns.filter((t) => t.role === "agent" && containsPricing(t.text));
  if (leaks.length) await audit({ enquiryId, callId: callRowId, event: "vaani.pricing_leak", status: "error", error: "Vaani's agent mentioned a price. Tighten the flow prompt.", metadata: { lines: leaks.map((t) => t.text.slice(0, 300)) } });

  const ended = call.durationSec ? new Date(call.startedAt.getTime() + call.durationSec * 1000) : call.endedAt;
  await finalise(callRowId, "completed", ended);
  const after = await db.from("aangan_enquiries").select("status").eq("id", enquiryId).single();
  return { enquiryId, status: String(after.data?.status ?? closeReason) };
}
