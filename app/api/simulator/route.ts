import { randomUUID } from "node:crypto";
import { z } from "zod";
import { HttpError, handle } from "@/lib/server/http";
import { serviceDb } from "@/lib/supabase/server";
import { handleVoiceEvent } from "@/lib/server/pipeline";

export const maxDuration = 60;

/**
 * The app has no login, so the simulator caps how many test calls can start in a window. This
 * bounds Gemini spend and Telegram messages if the link is shared further than intended.
 */
const MAX_CALLS = 30;
const WINDOW_MIN = 10;

async function assertUnderLimit() {
  const since = new Date(Date.now() - WINDOW_MIN * 60_000).toISOString();
  const r = await serviceDb().from("aangan_calls").select("id", { count: "exact", head: true }).eq("provider", "simulator").gte("created_at", since);
  if (r.error) throw new Error(r.error.message);
  if ((r.count ?? 0) >= MAX_CALLS) throw new HttpError(`Test-call limit reached (${MAX_CALLS} per ${WINDOW_MIN} minutes). Please try again shortly.`, 429);
}

/**
 * In-app call simulator: the reviewer plays the caller; events go through exactly the same pipeline a
 * real telephony provider would use (provider "simulator"), so the dashboard, audit trail and
 * Telegram handoff behave as in production.
 */
const Body = z.discriminatedUnion("action", [
  z.object({ action: z.literal("start"), from: z.string().min(6).max(20), at: z.string().datetime().optional() }),
  z.object({ action: z.literal("say"), callId: z.string().min(8), text: z.string().min(1).max(2000) }),
  z.object({ action: z.literal("end"), callId: z.string().min(8), reason: z.enum(["hangup", "dropped"]) }),
]);

export async function POST(req: Request) {
  return handle(async () => {
    const body = Body.parse(await req.json());
    const eventId = randomUUID();
    if (body.action === "start") {
      await assertUnderLimit();
      const callId = `sim-${randomUUID()}`;
      const reply = await handleVoiceEvent("simulator", { type: "call.started", eventId, callId, from: body.from, at: body.at ?? new Date().toISOString() }, { simulatedClock: Boolean(body.at) });
      return { callId, reply, ...(await state(callId)) };
    }
    if (body.action === "say") {
      const reply = await handleVoiceEvent("simulator", { type: "caller.utterance", eventId, callId: body.callId, text: body.text, at: new Date().toISOString() });
      return { callId: body.callId, reply, ...(await state(body.callId)) };
    }
    const reply = await handleVoiceEvent("simulator", { type: "call.ended", eventId, callId: body.callId, reason: body.reason, at: new Date().toISOString() });
    return { callId: body.callId, reply, ...(await state(body.callId)) };
  });
}

async function state(callId: string) {
  const db = serviceDb();
  const call = await db.from("aangan_calls").select("enquiry_id, status, session").eq("provider", "simulator").eq("provider_call_id", callId).maybeSingle();
  if (!call.data) return { enquiry: null, session: null };
  const enq = await db.from("aangan_enquiries").select("id, status, criteria, handoff_status, within_sla, response_seconds, after_hours, extraction_mode").eq("id", call.data.enquiry_id).single();
  return { enquiry: enq.data, session: call.data.session, callStatus: call.data.status };
}
