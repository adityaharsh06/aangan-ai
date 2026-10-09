import { z } from "zod";

/**
 * Everything the system may know about an enquiry. Every field is nullable: `null` means
 * "the caller has not said", never a guess. Fields mirror what the front desk asks in the
 * Sep 2026 transcripts and the web-form fields (name, location, carpet area, current state,
 * timeline, budget, how they found us).
 */
export const CallTypeSchema = z.enum(["new_enquiry", "existing_client", "follow_up", "other", "unknown"]);
export type CallType = z.infer<typeof CallTypeSchema>;

export const Tri = z.enum(["yes", "no", "unknown"]);
export type Tri = z.infer<typeof Tri>;

export const FactsSchema = z.object({
  call_type: CallTypeSchema,
  caller_name: z.string().nullable(),
  email: z.string().nullable(),

  location_text: z.string().nullable(),
  /** True only when the caller states the site is in a town/city other than Pune city or PCMC. */
  location_outside_pune: z.boolean(),
  property_category: z.enum(["residential", "commercial", "unknown"]),
  property_kind: z.enum([
    "apartment", "independent_house", "villa", "office", "clinic", "studio", "coworking",
    "restaurant", "hotel", "retail", "gym", "other", "unknown",
  ]),
  bhk: z.number().int().min(1).max(10).nullable(),
  carpet_area_sqft: z.number().positive().max(100000).nullable(),
  scope_type: z.enum(["full_home", "partial_home", "single_room", "office_fitout", "unknown"]),
  scope_rooms: z.array(z.string()),
  room_count: z.number().int().min(0).max(30).nullable(),
  current_state: z.string().nullable(),

  wants_execution: Tri,
  advice_only: z.boolean(),
  decor_only: z.boolean(),
  furniture_only: z.boolean(),
  vastu_only: z.boolean(),
  structural_work_requested: z.boolean(),
  rented: z.boolean().nullable(),

  timeline_text: z.string().nullable(),
  weeks_until_needed: z.number().min(0).max(520).nullable(),

  budget_volunteered: z.boolean(),
  budget_min_inr: z.number().nonnegative().nullable(),
  budget_max_inr: z.number().nonnegative().nullable(),

  decision_maker: z.enum(["yes", "authorised", "not_authorised", "unknown"]),
  decision_maker_note: z.string().nullable(),

  pricing_asked: z.boolean(),
  referral_source: z.string().nullable(),
  site_visit_requested: z.boolean(),
  preferred_slots: z.array(z.string()),

  existing_project_note: z.string().nullable(),
  caller_questions: z.array(z.string()),
  other_notes: z.array(z.string()),
});
export type Facts = z.infer<typeof FactsSchema>;

export function emptyFacts(): Facts {
  return {
    call_type: "unknown",
    caller_name: null,
    email: null,
    location_text: null,
    location_outside_pune: false,
    property_category: "unknown",
    property_kind: "unknown",
    bhk: null,
    carpet_area_sqft: null,
    scope_type: "unknown",
    scope_rooms: [],
    room_count: null,
    current_state: null,
    wants_execution: "unknown",
    advice_only: false,
    decor_only: false,
    furniture_only: false,
    vastu_only: false,
    structural_work_requested: false,
    rented: null,
    timeline_text: null,
    weeks_until_needed: null,
    budget_volunteered: false,
    budget_min_inr: null,
    budget_max_inr: null,
    decision_maker: "unknown",
    decision_maker_note: null,
    pricing_asked: false,
    referral_source: null,
    site_visit_requested: false,
    preferred_slots: [],
    existing_project_note: null,
    caller_questions: [],
    other_notes: [],
  };
}

/**
 * Merge newly extracted facts over previous ones. A later "unknown"/null never erases
 * something the caller already said; booleans that flag a signal are sticky.
 */
export function mergeFacts(prev: Facts, next: Partial<Facts>): Facts {
  const out: Facts = { ...prev };
  for (const [k, v] of Object.entries(next) as [keyof Facts, unknown][]) {
    if (v === null || v === undefined) continue;
    if (v === "unknown") continue;
    if (Array.isArray(v)) {
      const merged = Array.from(new Set([...(prev[k] as string[]), ...(v as string[])]));
      (out as Record<string, unknown>)[k] = merged;
      continue;
    }
    if (typeof v === "boolean" && v === false && typeof prev[k] === "boolean") continue;
    (out as Record<string, unknown>)[k] = v;
  }
  return out;
}

/** Strip anything the model returned that isn't in the schema, coercing to safe defaults. */
export function sanitizeFacts(raw: unknown): Partial<Facts> {
  const partial = FactsSchema.partial().safeParse(raw);
  if (partial.success) return partial.data;
  // Keep the fields that individually validate; drop the rest.
  const out: Partial<Facts> = {};
  if (raw && typeof raw === "object") {
    const shape = FactsSchema.shape;
    for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
      const field = shape[k as keyof typeof shape];
      if (!field) continue;
      const r = field.safeParse(v);
      if (r.success) (out as Record<string, unknown>)[k] = r.data;
    }
  }
  return out;
}
