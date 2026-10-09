/**
 * Structured business rules derived from knowledge/*.md.
 *
 * Every rule carries a `source` so it can be traced back to the document it came from.
 * Anything NOT stated in the source documents is marked `assumption: true` and should be
 * confirmed with Nikhil. Change the numbers here (or the .md files), never inside prompts.
 */

export interface Sourced<T> {
  value: T;
  source: string;
  assumption?: boolean;
  note?: string;
}

export const BUSINESS = {
  name: "Aangan Studio",
  timezone: "Asia/Kolkata",
  /** Front desk hours. Source: case brief ("two people covering 10am to 7pm"). */
  frontDeskHours: { value: { startHour: 10, endHour: 19 }, source: "Case brief: The Situation" } as Sourced<{ startHour: number; endHour: number }>,
  /** Nikhil's ask: every enquiry answered within five minutes, day or night. */
  responseSlaSeconds: { value: 300, source: "Case brief: The Ask" } as Sourced<number>,
};

// ---------------------------------------------------------------- service area (criterion 2)

export const SERVICE_AREA = {
  /** Named in services.md → "Service area". */
  served: {
    value: [
      "Kothrud", "Baner", "Aundh", "Wakad", "Koregaon Park", "Kalyani Nagar", "Viman Nagar", "Hadapsar",
      "Magarpatta", "NIBM", "Kondhwa", "Undri", "Shivane", "Warje", "Erandwane", "Deccan",
      "Pimpri", "Chinchwad", "Pimple Saudagar", "Pimple Nilakh", "Ravet", "Hinjewadi",
    ],
    source: "services.md#service-area",
  } as Sourced<string[]>,
  /**
   * Pune city / PCMC localities that services.md does not name but covers via "and adjoining areas".
   * ASSUMPTION: confirm this list with Nikhil (open item U4). Kharadi and Nanded City appear in the Sep 2026 calls.
   */
  servedAssumed: {
    value: [
      "Kharadi", "Nanded City", "Balewadi", "Pashan", "Bavdhan", "Shivajinagar", "Camp", "Yerwada",
      "Sinhagad Road", "Katraj", "Bibwewadi", "Wanowrie", "Mundhwa", "Dhanori", "Vishrantwadi", "Sus",
      "Akurdi", "Nigdi", "Bhosari", "Moshi", "Tathawade", "Punawale", "Pimple Gurav", "Sangvi", "Sunderban",
      "Cybercity", "Dahanukar Colony",
    ],
    source: "services.md#service-area ('and adjoining areas')",
    assumption: true,
  } as Sourced<string[]>,
  /** Explicitly excluded in services.md / qualified.md. */
  excluded: {
    value: ["Talegaon", "Lonavala", "Nashik", "Mumbai"],
    source: "services.md#service-area; qualified.md#2",
  } as Sourced<string[]>,
  /** Generic city names that mean "inside the area" without naming a locality. */
  cityAliases: { value: ["Pune", "PCMC", "Pimpri-Chinchwad", "Pimpri Chinchwad"], source: "services.md#service-area" } as Sourced<string[]>,
};

// ---------------------------------------------------------------- services (criterion 1)

export type PropertyKind =
  | "apartment" | "independent_house" | "villa" | "office" | "clinic" | "studio" | "coworking"
  | "restaurant" | "hotel" | "retail" | "gym" | "other" | "unknown";

export const SERVICES = {
  residentialKinds: { value: ["apartment", "independent_house", "villa"] as PropertyKind[], source: "services.md#what-we-do" },
  commercialKinds: { value: ["office", "clinic", "studio", "coworking"] as PropertyKind[], source: "services.md#what-we-do" },
  excludedKinds: {
    value: ["restaurant", "hotel", "retail", "gym"] as PropertyKind[],
    source: "services.md#what-we-dont-do ('Restaurants, hotels, retail stores, gyms: out of scope')",
  },
  commercialMaxSqft: { value: 3000, source: "services.md ('up to approximately 3,000 sq ft')" } as Sourced<number>,
  /** Tolerance above 3,000 that we flag as unclear rather than fail (because the doc says "approximately"). */
  commercialMaxToleranceSqft: { value: 3600, source: "services.md ('approximately')", assumption: true, note: "Above 3,600 sq ft fails; 3,000–3,600 flagged for designer." } as Sourced<number>,
  /**
   * T18: the front desk told a caller "our commercial projects are typically 500 sq ft or more".
   * Not in services.md, so this is a flag for the designer only, never a hard fail (open item U3).
   */
  commercialSmallFlagSqft: { value: 500, source: "Transcript T18 (not policy)", assumption: true } as Sourced<number>,
  notOffered: {
    value: [
      { key: "structural", label: "Architecture / structural work", source: "services.md#what-we-dont-do" },
      { key: "decor_only", label: "Decor and styling only (advice, colours, rearranging)", source: "services.md#what-we-dont-do; qualified.md#1" },
      { key: "furniture_only", label: "Standalone furniture sourcing", source: "services.md#what-we-dont-do" },
      { key: "vastu_only", label: "Vastu consultation only", source: "services.md#what-we-dont-do" },
    ],
    source: "services.md#what-we-dont-do",
  },
};

// ---------------------------------------------------------------- timeline (criterion 3)

export const TIMELINE = {
  /** "We cannot begin execution on a project that needs to be ready in under 6 weeks from today." */
  hardMinimumWeeks: { value: 6, source: "services.md#timelines" } as Sourced<number>,
  /**
   * qualified.md: "site must be available for execution within 8–10 weeks of the consultation";
   * T07: "a room redesign with execution takes at least 8–10 weeks". Between 6 and 10 weeks is
   * treated as unclear → ask one direct question, then forward with a note (decision U2, agreed).
   */
  comfortableWeeks: { value: 10, source: "qualified.md#3; transcript T07", note: "6–10 weeks = unclear (U2)" } as Sourced<number>,
};

// ---------------------------------------------------------------- budget (criterion 4, INTERNAL ONLY)

/**
 * pricing.md figures are used ONLY to detect an obviously mis-aligned budget that the caller
 * volunteered (qualified.md#4). They are never spoken to the caller and never sent in a handoff.
 */
export const BUDGET_CHECK = {
  residentialFloorPerSqft: { value: 1800, source: "pricing.md#residential (Standard ₹1,800–₹2,400 / sq ft)" } as Sourced<number>,
  commercialFloorPerSqft: { value: 1200, source: "pricing.md#commercial (Basic fitout ₹1,200–₹1,800 / sq ft)" } as Sourced<number>,
  singleRoomFloorInr: { value: 350000, source: "pricing.md#residential (Single room ₹3.5–8 lakh)" } as Sourced<number>,
  /**
   * "Clearly below" threshold: budget under this fraction of the lowest indicative cost for the
   * described scope. ASSUMPTION: 50% (T10: ₹1–1.5 lakh for kitchen + bedroom is clearly below).
   */
  clearlyBelowFraction: { value: 0.5, source: "qualified.md#4 ('clearly below')", assumption: true } as Sourced<number>,
};

// ---------------------------------------------------------------- scripted lines (verbatim from sources)

export const SCRIPTS = {
  /** pricing.md: "The only acceptable response to a pricing question". Must stay verbatim. */
  pricing: {
    value:
      "Pricing depends on the site, the materials you choose, and the scope — your designer will walk you through it in detail at the consultation. I can book that for you right now if you'd like.",
    source: "pricing.md#what-the-agent-must-never-say",
  } as Sourced<string>,
  /** qualified.md: decline wording when two or more criteria fail. */
  decline: {
    value:
      "This sounds like it may not be the right fit for us right now — but feel free to reach out if your timeline or scope changes.",
    source: "qualified.md#at-the-boundary",
  } as Sourced<string>,
  /** qualified.md#3 direct timeline question. */
  timelineQuestion: { value: "When would you need the project complete?", source: "qualified.md#3" } as Sourced<string>,
};

export const CRITERIA = [
  { id: 1, key: "real_project", label: "Real project, not just advice", source: "qualified.md#1; services.md" },
  { id: 2, key: "service_area", label: "In our service area (Pune / PCMC)", source: "qualified.md#2; services.md#service-area" },
  { id: 3, key: "timeline", label: "Realistic timeline", source: "qualified.md#3; services.md#timelines" },
  { id: 4, key: "budget", label: "Budget broadly aligned (never probed)", source: "qualified.md#4" },
  { id: 5, key: "decision_maker", label: "Decision-maker on the call (or authorised)", source: "qualified.md#5" },
] as const;

export type CriterionKey = (typeof CRITERIA)[number]["key"];
