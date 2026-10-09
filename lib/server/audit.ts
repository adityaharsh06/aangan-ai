import "server-only";
import { serviceDb } from "@/lib/supabase/server";
import { numberEnv } from "@/lib/env";
import type { GeminiUsage } from "@/lib/ai/gemini";

/** Audit events must never break the call flow: failures are logged, not thrown. */
export async function audit(e: {
  enquiryId?: string | null;
  callId?: string | null;
  event: string;
  status?: "ok" | "error" | "info" | "warning";
  externalId?: string | null;
  error?: string | null;
  metadata?: Record<string, unknown>;
}) {
  const { error } = await serviceDb().from("aangan_events").insert({
    enquiry_id: e.enquiryId ?? null,
    call_id: e.callId ?? null,
    event: e.event,
    status: e.status ?? "ok",
    external_id: e.externalId ?? null,
    error: e.error ?? null,
    metadata: e.metadata ?? {},
  });
  if (error) console.error("audit insert failed", e.event, error.message);
}

/** Gemini cost from actual token counts × configured list price (so the basis is "estimated"). */
export async function recordGeminiCost(enquiryId: string, callId: string | null, usage: GeminiUsage | undefined, purpose: string) {
  if (!usage) return;
  const inTok = usage.promptTokenCount ?? 0;
  const outTok = (usage.candidatesTokenCount ?? 0) + (usage.thoughtsTokenCount ?? 0);
  const pin = numberEnv("GEMINI_USD_PER_M_INPUT");
  const pout = numberEnv("GEMINI_USD_PER_M_OUTPUT");
  const fx = numberEnv("USD_INR");
  const priced = pin !== null && pout !== null && fx !== null;
  const cost = priced ? ((inTok / 1e6) * pin! + (outTok / 1e6) * pout!) * fx! : null;
  const { error } = await serviceDb().from("aangan_cost_events").insert({
    enquiry_id: enquiryId,
    call_id: callId,
    provider: "gemini",
    units: inTok + outTok,
    unit: "tokens",
    cost_inr: cost,
    basis: priced ? "estimated" : "unavailable",
    metadata: { purpose, input_tokens: inTok, output_tokens: outTok, price_usd_per_m: priced ? { input: pin, output: pout } : null, usd_inr: fx },
  });
  if (error) console.error("cost insert failed", error.message);
}

export async function recordVoiceCost(enquiryId: string, callId: string, seconds: number) {
  const perMin = numberEnv("VOICE_INR_PER_MINUTE");
  const minutes = Math.max(0, seconds) / 60;
  const { error } = await serviceDb().from("aangan_cost_events").insert({
    enquiry_id: enquiryId,
    call_id: callId,
    provider: "voice",
    units: Math.round(minutes * 100) / 100,
    unit: "minutes",
    cost_inr: perMin === null ? null : minutes * perMin,
    basis: perMin === null ? "unavailable" : "configured",
    metadata: { provider: process.env.VOICE_PROVIDER || "mock", inr_per_minute: perMin },
  });
  if (error) console.error("voice cost insert failed", error.message);
}
