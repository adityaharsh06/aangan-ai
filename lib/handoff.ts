/**
 * Telegram message bodies. The designer handoff carries everything the caller already told us,
 * so the designer's first call starts at the consultation, not at discovery. It never carries
 * prices: pricing is quoted by the designer (decision agreed with the founder office).
 */
import type { Facts } from "@/lib/domain/facts";
import type { CriterionResult } from "@/lib/qualification/engine";
import { esc } from "@/lib/providers/telegram";

export interface HandoffInput {
  enquiryId: string;
  phone: string;
  facts: Facts;
  criteria: CriterionResult[];
  notes: string[];
  summary: string;
  concerns: string[];
  nextAction: string;
  receivedAt: string;
  afterHours: boolean;
  responseSeconds: number | null;
  appUrl: string | null;
}

const NP = "<i>Not provided</i>";
const v = (x: string | number | null | undefined) => (x === null || x === undefined || x === "" ? NP : esc(String(x)));
const icon = (s: CriterionResult["status"]) => (s === "pass" ? "✅" : s === "fail" ? "❌" : "⚠️");

function ist(iso: string) {
  return new Intl.DateTimeFormat("en-IN", { timeZone: "Asia/Kolkata", day: "numeric", month: "short", hour: "numeric", minute: "2-digit" }).format(new Date(iso));
}

function property(f: Facts) {
  const kind = f.property_kind !== "unknown" ? f.property_kind.replace("_", " ") : null;
  const parts = [f.bhk ? `${f.bhk}BHK` : null, kind, f.carpet_area_sqft ? `~${f.carpet_area_sqft} sq ft carpet` : null].filter(Boolean);
  return parts.length ? esc(parts.join(" · ")) : NP;
}

export function designerHandoffMessage(h: HandoffInput): string {
  const f = h.facts;
  const lines = [
    "🔔 <b>NEW QUALIFIED ENQUIRY</b> · Phone",
    `<i>Received ${esc(ist(h.receivedAt))}${h.afterHours ? " (after hours)" : ""}${h.responseSeconds !== null ? ` · answered in ${Math.round(h.responseSeconds)}s` : ""}</i>`,
    "",
    `<b>Caller:</b> ${v(f.caller_name)}`,
    `<b>Phone:</b> ${esc(h.phone)}`,
    f.email ? `<b>Email:</b> ${esc(f.email)}` : null,
    `<b>Found us via:</b> ${v(f.referral_source)}`,
    "",
    `<b>Site:</b> ${v(f.location_text)}`,
    `<b>Property:</b> ${property(f)}${f.rented ? " · <b>rented</b> (no structural changes)" : ""}`,
    `<b>Scope:</b> ${f.scope_type !== "unknown" ? esc(f.scope_type.replace("_", " ")) : NP}${f.scope_rooms.length ? ` · ${esc(f.scope_rooms.join(", "))}` : ""}`,
    `<b>Current state:</b> ${v(f.current_state)}`,
    `<b>Timeline:</b> ${v(f.timeline_text)}`,
    `<b>Decision-maker:</b> ${f.decision_maker === "unknown" ? NP : esc(f.decision_maker.replace("_", " "))}${f.decision_maker_note ? ` (${esc(f.decision_maker_note)})` : ""}`,
    `<b>Budget:</b> ${f.budget_volunteered ? "volunteered by caller, see summary" : "not discussed (not probed)"}`,
    `<b>Consultation:</b> ${f.preferred_slots.length ? esc(f.preferred_slots.join("; ")) : NP}${f.site_visit_requested ? " · <b>site visit requested</b>" : ""}`,
    "",
    "<b>Why it qualified</b> (Nikhil's rubric)",
    ...h.criteria.map((c) => `${icon(c.status)} ${esc(c.label)}: ${esc(c.reason)}`),
    h.notes.length ? "" : null,
    h.notes.length ? "<b>Check at consultation</b>" : null,
    ...h.notes.map((n) => `• ${esc(n)}`),
    "",
    `<b>Pricing:</b> ${f.pricing_asked ? "caller asked about price. No figure given; please walk them through it." : "not raised"}`,
    h.concerns.length ? `<b>Caller's questions:</b> ${esc(h.concerns.join(" | "))}` : null,
    "",
    `<b>Summary:</b> ${esc(h.summary)}`,
    `<b>Next:</b> ${esc(h.nextAction)}`,
    h.appUrl ? `\n<a href="${esc(h.appUrl)}/enquiries/${h.enquiryId}">Full record + transcript</a>` : null,
  ];
  return lines.filter((l) => l !== null).join("\n").slice(0, 4000);
}

export function alertMessage(kind: "escalation" | "callback" | "missed", h: { enquiryId: string; phone: string; name: string | null; detail: string; appUrl: string | null }): string {
  const title =
    kind === "escalation" ? "🚨 <b>EXISTING CLIENT NEEDS A SENIOR CALLBACK</b>" : kind === "missed" ? "📞 <b>MISSED CALL: CALL BACK</b>" : "📞 <b>CALL BACK NEEDED</b>";
  return [
    title,
    `<b>Caller:</b> ${v(h.name)}`,
    `<b>Phone:</b> ${esc(h.phone)}`,
    esc(h.detail),
    h.appUrl ? `<a href="${esc(h.appUrl)}/enquiries/${h.enquiryId}">Open record</a>` : null,
  ]
    .filter(Boolean)
    .join("\n");
}
