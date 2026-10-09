/**
 * End-of-call summary for the designer handoff. Gemini writes it from the validated facts +
 * transcript; a template is used if Gemini is unavailable or returns something invalid.
 */
import { z } from "zod";
import { generateJson, geminiConfigured, type GeminiUsage } from "@/lib/ai/gemini";
import type { Facts } from "@/lib/domain/facts";
import type { Evaluation } from "@/lib/qualification/engine";
import { renderTranscript } from "./extract";
import { containsPricing } from "./guard";
import type { Turn } from "./types";

export const SummarySchema = z.object({
  summary: z.string().min(10).max(700),
  caller_concerns: z.array(z.string().max(200)).max(6),
  recommended_next_action: z.string().min(5).max(300),
});
export type Summary = z.infer<typeof SummarySchema>;

const GEMINI_SCHEMA = {
  type: "OBJECT",
  properties: {
    summary: { type: "STRING", description: "2-4 sentences a designer can read in 15 seconds: who, what, where, size, current state, timeline, anything notable." },
    caller_concerns: { type: "ARRAY", items: { type: "STRING" }, description: "Questions or worries the caller raised, in plain words. Empty if none." },
    recommended_next_action: { type: "STRING", description: "One concrete next step for the designer." },
  },
  required: ["summary", "caller_concerns", "recommended_next_action"],
};

export function templateSummary(f: Facts, ev: Evaluation, status: string): Summary {
  const who = f.caller_name ?? "Caller";
  const what = [f.bhk ? `${f.bhk}BHK` : null, f.property_kind !== "unknown" ? f.property_kind.replace("_", " ") : null].filter(Boolean).join(" ") || "property";
  const parts = [
    `${who} called about a ${what}${f.location_text ? ` in ${f.location_text}` : ""}${f.carpet_area_sqft ? ` (~${f.carpet_area_sqft} sq ft)` : ""}.`,
    f.scope_rooms.length ? `Scope: ${f.scope_rooms.join(", ")}.` : null,
    f.current_state ? `Current state: ${f.current_state}.` : null,
    f.timeline_text ? `Timeline: ${f.timeline_text}.` : null,
  ].filter(Boolean);
  const next =
    status === "qualified"
      ? `Call ${who} to confirm the consultation${f.preferred_slots.length ? ` (prefers ${f.preferred_slots.join("; ")})` : ""}${f.site_visit_requested ? " at the site" : ""}.`
      : status === "escalated"
        ? "Senior team to call back urgently about the existing project."
        : status === "needs_review"
          ? `Front desk to call back and resolve: ${ev.blockingUnclear.join(", ") || "open questions"}.`
          : "No designer action needed.";
  return { summary: parts.join(" "), caller_concerns: f.caller_questions.slice(0, 6), recommended_next_action: next };
}

export async function summarise(turns: Turn[], f: Facts, ev: Evaluation, status: string): Promise<{ summary: Summary; mode: "gemini" | "template"; usage?: GeminiUsage; error?: string }> {
  const fallback = templateSummary(f, ev, status);
  if (!geminiConfigured()) return { summary: fallback, mode: "template", error: "Gemini not configured" };
  try {
    const r = await generateJson<unknown>({
      system: [
        "You write a short internal handoff note for an Aangan Studio interior designer about a phone enquiry.",
        "Use ONLY the facts and transcript provided. Never invent details. Never include any price, rate or budget estimate of your own.",
        "If the caller volunteered a budget you may repeat it exactly. Plain, warm, professional English.",
      ].join("\n"),
      user: `OUTCOME: ${status}\nFACTS (validated): ${JSON.stringify(f)}\nCRITERIA: ${JSON.stringify(ev.criteria.map((c) => ({ c: c.label, s: c.status, r: c.reason })))}\n\nTRANSCRIPT\n${renderTranscript(turns)}`,
      schema: GEMINI_SCHEMA,
      timeoutMs: 20_000,
    });
    const parsed = SummarySchema.safeParse(r.data);
    if (!parsed.success) return { summary: fallback, mode: "template", usage: r.usage, error: "invalid summary shape" };
    // Belt and braces: the model must not introduce prices the caller never said.
    const s = parsed.data;
    if (!f.budget_volunteered && containsPricing(`${s.summary} ${s.recommended_next_action}`)) {
      return { summary: fallback, mode: "template", usage: r.usage, error: "summary contained pricing; replaced with template" };
    }
    return { summary: s, mode: "gemini", usage: r.usage };
  } catch (e) {
    return { summary: fallback, mode: "template", error: (e as Error).message };
  }
}
