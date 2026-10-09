/**
 * Deterministic qualification against Nikhil's rubric (qualified.md). The LLM never decides
 * the outcome; it only extracts facts. Each criterion returns pass / fail / unclear with a
 * human-readable reason and the source rule it came from.
 */
import type { Facts } from "@/lib/domain/facts";
import { BUDGET_CHECK, CRITERIA, SERVICES, TIMELINE, type CriterionKey } from "@/lib/knowledge/rules";
import { matchLocality } from "./locality";

export type CriterionStatus = "pass" | "fail" | "unclear";

export interface CriterionResult {
  id: number;
  key: CriterionKey;
  label: string;
  status: CriterionStatus;
  reason: string;
  source: string;
}

export type Outcome = "qualified" | "unqualified" | "pending";

export interface Evaluation {
  criteria: CriterionResult[];
  outcome: Outcome;
  failed: CriterionKey[];
  /** Criteria 1–3 still unclear (the agent must ask one direct question for each). */
  blockingUnclear: CriterionKey[];
  /** Uncertainty the designer should know about (unclear 4/5, assumptions, flags). */
  notes: string[];
}

/** Which criteria the agent has already asked its one direct question about. */
export type AskedMap = Partial<Record<CriterionKey, boolean>>;

const inr = (n: number) => (n >= 100000 ? `₹${(n / 100000).toFixed(n % 100000 ? 1 : 0)} lakh` : `₹${n.toLocaleString("en-IN")}`);

function meta(key: CriterionKey) {
  const c = CRITERIA.find((x) => x.key === key)!;
  return { id: c.id, key, label: c.label, source: c.source };
}

function realProject(f: Facts, notes: string[]): CriterionResult {
  const m = meta("real_project");
  if (SERVICES.excludedKinds.value.includes(f.property_kind)) {
    return { ...m, status: "fail", reason: `${f.property_kind} interiors are out of scope.`, source: SERVICES.excludedKinds.source };
  }
  if (f.furniture_only) return { ...m, status: "fail", reason: "Wants standalone furniture sourcing, which we don't offer without a design project.", source: "services.md#what-we-dont-do" };
  if (f.vastu_only) return { ...m, status: "fail", reason: "Wants a Vastu-only consultation; we only incorporate Vastu into design projects.", source: "services.md#what-we-dont-do" };
  if ((f.advice_only || f.decor_only) && f.wants_execution !== "yes") {
    return { ...m, status: "fail", reason: "Wants advice / styling only, not design with execution. Minimum engagement is a room redesign with execution.", source: "qualified.md#1" };
  }
  if (f.wants_execution === "no") {
    return { ...m, status: "fail", reason: "Caller will handle execution themselves; we only take design + execution projects.", source: "qualified.md#1" };
  }
  if (f.property_category === "commercial" && f.carpet_area_sqft) {
    if (f.carpet_area_sqft > SERVICES.commercialMaxToleranceSqft.value) {
      return { ...m, status: "fail", reason: `Commercial space of ${f.carpet_area_sqft} sq ft is above our ~${SERVICES.commercialMaxSqft.value} sq ft limit.`, source: SERVICES.commercialMaxSqft.source };
    }
    if (f.carpet_area_sqft > SERVICES.commercialMaxSqft.value) notes.push(`Commercial space (${f.carpet_area_sqft} sq ft) is slightly above the ~3,000 sq ft guideline: designer to confirm fit.`);
    if (f.carpet_area_sqft < SERVICES.commercialSmallFlagSqft.value) notes.push(`Small commercial space (${f.carpet_area_sqft} sq ft). The front desk has declined spaces under 500 sq ft before (T18), but services.md sets no minimum: designer to confirm.`);
  }
  if (f.structural_work_requested) notes.push("Caller mentioned structural changes (walls / structure). We don't do structural work; designer to clarify scope.");
  const scoped = f.scope_type !== "unknown" || f.scope_rooms.length > 0;
  if (f.wants_execution === "yes" || (scoped && !f.advice_only && !f.decor_only)) {
    const what = f.scope_type !== "unknown" ? f.scope_type.replace("_", " ") : f.scope_rooms.join(", ");
    return { ...m, status: "pass", reason: `Wants a design + execution project (${what}).`, source: "qualified.md#1" };
  }
  return { ...m, status: "unclear", reason: "Not yet clear whether this is a full design-and-execution project or advice only.", source: "qualified.md#1" };
}

function serviceArea(f: Facts, notes: string[]): CriterionResult {
  const m = meta("service_area");
  const loc = matchLocality(f.location_text);
  if (loc.status === "excluded") return { ...m, status: "fail", reason: `Site is in ${loc.match}, outside Pune city / PCMC.`, source: "services.md#service-area" };
  if (f.location_outside_pune) return { ...m, status: "fail", reason: `Site (${f.location_text ?? "stated by caller"}) is outside Pune city / PCMC.`, source: "qualified.md#2" };
  if (loc.status === "served") {
    if (loc.assumed && !["Pune", "PCMC"].includes(loc.match)) notes.push(`Locality "${loc.match}" isn't named in services.md; treated as Pune city / PCMC (assumption to confirm).`);
    return { ...m, status: "pass", reason: `Site in ${f.location_text}, within our service area.`, source: "services.md#service-area" };
  }
  return { ...m, status: "unclear", reason: f.location_text ? `Couldn't confirm whether "${f.location_text}" is in Pune city / PCMC.` : "Site location not given yet.", source: "qualified.md#2" };
}

function timeline(f: Facts, asked: AskedMap, notes: string[]): CriterionResult {
  const m = meta("timeline");
  const w = f.weeks_until_needed;
  if (w === null) return { ...m, status: "unclear", reason: "Completion timeline not given yet.", source: "qualified.md#3" };
  const when = f.timeline_text ? `"${f.timeline_text}"` : `in ~${Math.round(w)} weeks`;
  if (w < TIMELINE.hardMinimumWeeks.value) {
    return { ...m, status: "fail", reason: `Needs it ${when} (~${Math.round(w)} weeks). We can't begin execution on anything needed in under ${TIMELINE.hardMinimumWeeks.value} weeks.`, source: TIMELINE.hardMinimumWeeks.source };
  }
  if (w < TIMELINE.comfortableWeeks.value) {
    if (!asked.timeline) return { ...m, status: "unclear", reason: `Needs it ${when} (~${Math.round(w)} weeks), which is tight. Confirm completion date.`, source: "qualified.md#3" };
    notes.push(`Tight timeline: needs it ${when} (~${Math.round(w)} weeks). Designer to confirm feasibility.`);
    return { ...m, status: "pass", reason: `Needs it ${when} (~${Math.round(w)} weeks). Tight but not ruled out; flagged for the designer.`, source: "qualified.md#3; decision U2" };
  }
  if (w > 52) notes.push(`Far-off timeline (${when}); may need a later follow-up rather than an immediate consultation.`);
  return { ...m, status: "pass", reason: `Needs it ${when}, which leaves enough time for design and execution.`, source: "qualified.md#3" };
}

/** Lowest plausible cost for the described scope, from pricing.md. INTERNAL ONLY, never spoken. */
export function scopeFloorInr(f: Facts): number | null {
  if (f.property_category === "commercial") {
    return f.carpet_area_sqft ? f.carpet_area_sqft * BUDGET_CHECK.commercialFloorPerSqft.value : null;
  }
  const room = BUDGET_CHECK.singleRoomFloorInr.value;
  const perSqft = f.carpet_area_sqft ? f.carpet_area_sqft * BUDGET_CHECK.residentialFloorPerSqft.value : null;
  if (f.scope_type === "single_room") return room;
  if (f.scope_type === "partial_home") {
    const byRooms = f.room_count ? f.room_count * room : f.scope_rooms.length >= 2 ? f.scope_rooms.length * room : 2 * room;
    return perSqft ? Math.min(byRooms, perSqft) : byRooms;
  }
  if (f.scope_type === "full_home") return perSqft;
  return null;
}

function budget(f: Facts, notes: string[]): CriterionResult {
  const m = meta("budget");
  if (!f.budget_volunteered) return { ...m, status: "pass", reason: "Budget not mentioned. Not probed, treated as qualified per rubric.", source: "qualified.md#4" };
  const stated = f.budget_max_inr ?? f.budget_min_inr;
  const floor = scopeFloorInr(f);
  const range = f.budget_min_inr && f.budget_max_inr && f.budget_min_inr !== f.budget_max_inr ? `${inr(f.budget_min_inr)}–${inr(f.budget_max_inr)}` : stated ? inr(stated) : "an unspecified amount";
  if (stated === null || floor === null) {
    notes.push(`Caller volunteered a budget (${range}); couldn't compare it with the scope. Designer to discuss.`);
    return { ...m, status: "unclear", reason: `Volunteered budget ${range}; scope not detailed enough to compare.`, source: "qualified.md#4" };
  }
  if (stated < floor * BUDGET_CHECK.clearlyBelowFraction.value) {
    return { ...m, status: "fail", reason: `Volunteered budget ${range} is clearly below what this scope costs with us.`, source: "qualified.md#4; pricing.md (internal comparison only)" };
  }
  if (stated < floor) notes.push(`Volunteered budget ${range} may be on the low side for the described scope. Designer to discuss at consultation.`);
  return { ...m, status: "pass", reason: `Volunteered budget ${range}; not clearly misaligned with the scope.`, source: "qualified.md#4" };
}

function decisionMaker(f: Facts, notes: string[]): CriterionResult {
  const m = meta("decision_maker");
  const extra = f.decision_maker_note ? ` (${f.decision_maker_note})` : "";
  if (f.decision_maker === "yes") return { ...m, status: "pass", reason: `Caller is the decision-maker${extra}.`, source: "qualified.md#5" };
  if (f.decision_maker === "authorised") return { ...m, status: "pass", reason: `Caller is authorised by the decision-maker${extra}.`, source: "qualified.md#5" };
  if (f.decision_maker === "not_authorised") {
    return { ...m, status: "fail", reason: `Caller is researching on someone else's behalf without authority to proceed${extra}.`, source: "qualified.md#5" };
  }
  notes.push("Decision-maker not confirmed on the call. Designer to confirm who decides.");
  return { ...m, status: "unclear", reason: "Not confirmed. Rubric says don't push; treated as qualified with a note.", source: "qualified.md#at-the-boundary" };
}

export function evaluate(f: Facts, asked: AskedMap = {}): Evaluation {
  const notes: string[] = [];
  const criteria = [realProject(f, notes), serviceArea(f, notes), timeline(f, asked, notes), budget(f, notes), decisionMaker(f, notes)];
  const failed = criteria.filter((c) => c.status === "fail").map((c) => c.key);
  const blockingUnclear = criteria.filter((c) => c.status === "unclear" && c.id <= 3).map((c) => c.key);
  // U1 (agreed): any single failure means the lead is not forwarded.
  const outcome: Outcome = failed.length > 0 ? "unqualified" : blockingUnclear.length > 0 ? "pending" : "qualified";
  return { criteria, outcome, failed, blockingUnclear, notes };
}
