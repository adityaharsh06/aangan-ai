/**
 * Deterministic fallback extractor (no LLM). Used when Gemini is unavailable so a live call
 * can still be handled. It is deliberately conservative: when a pattern isn't clearly present
 * the field stays null/unknown and the agent asks.
 */
import type { Facts } from "@/lib/domain/facts";
import { SERVICE_AREA } from "@/lib/knowledge/rules";
import type { Turn } from "./types";

const MONTHS = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];
const WORDNUM: Record<string, number> = { a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, twelve: 12 };
const OTHER_CITIES = ["nashik", "mumbai", "thane", "navi mumbai", "satara", "kolhapur", "nagpur", "aurangabad", "bangalore", "bengaluru", "hyderabad", "delhi", "goa", "lonavala", "talegaon", "solapur", "ahmednagar"];

const ROOM_WORDS: [RegExp, string][] = [
  [/\bkitchen\b/, "kitchen"],
  [/\bliving( room)?\b|\bhall\b/, "living room"],
  [/\bdining\b/, "dining"],
  [/\bmaster bedroom\b/, "master bedroom"],
  [/\b(all|both|two|three|four) bedrooms\b/, "bedrooms"],
  [/\bbedroom\b/, "bedroom"],
  [/\bwardrobes?\b/, "wardrobes"],
  [/\bstudy\b/, "study"],
  [/\bhome office\b/, "home office"],
  [/\bflooring\b/, "flooring"],
  [/\bworkstations?\b/, "workstations"],
  [/\bcabins?\b/, "cabins"],
  [/\bmeeting room\b|\bboardroom\b/, "meeting room"],
  [/\breception\b/, "reception"],
  [/\bbreak area\b|\bpantry\b/, "pantry / break area"],
];

function num(s: string): number {
  const n = WORDNUM[s.toLowerCase()];
  return n ?? Number(s.replace(/,/g, ""));
}

function weeksUntilMonth(month: number, from: Date): number {
  let year = from.getFullYear();
  if (month <= from.getMonth()) year += 1;
  const target = new Date(Date.UTC(year, month, 1));
  return Math.max(0, (target.getTime() - from.getTime()) / (7 * 24 * 3600 * 1000));
}

export function parseTimeline(text: string, from: Date): { weeks: number | null; phrase: string | null } {
  const t = text.toLowerCase();
  const rel = t.match(/\b(?:in|within|about|around|next|only|just)?\s*(\d+|a|an|one|two|three|four|five|six|seven|eight|nine|ten|twelve)\s*(week|weeks|month|months)\b/);
  const monthHit = MONTHS.map((m, i) => ({ i, idx: t.search(new RegExp(`\\b(by|in|before|from|till|until|for)?\\s*${m}\\b`)) })).filter((x) => x.idx >= 0).sort((a, b) => a.idx - b.idx)[0];
  if (/\b(no rush|flexible|no specific deadline|no deadline|whenever|not in a rush|plenty of time)\b/.test(t) && !rel && !monthHit) {
    return { weeks: 26, phrase: "flexible / no deadline" };
  }
  if (rel) {
    const n = num(rel[1]);
    const weeks = rel[2].startsWith("month") ? n * 4.3 : n;
    // "possession in six weeks" is about the site, not the completion date.
    const ctx = t.slice(Math.max(0, (rel.index ?? 0) - 40), (rel.index ?? 0) + rel[0].length);
    if (!/possession|lease|been here|ago|years? (back|ago)/.test(ctx)) return { weeks: Math.round(weeks * 10) / 10, phrase: rel[0].trim() };
  }
  if (monthHit) return { weeks: Math.round(weeksUntilMonth(monthHit.i, from) * 10) / 10, phrase: MONTHS[monthHit.i] };
  return { weeks: null, phrase: null };
}

function parseBudget(t: string): { min: number | null; max: number | null } | null {
  const unit = (u: string) => (/crore|cr/.test(u) ? 1e7 : 1e5);
  const range = t.match(/(\d+(?:\.\d+)?)\s*(?:to|-|–|or)\s*(\d+(?:\.\d+)?)\s*(lakhs?|lacs?|crores?|cr|l)\b/);
  if (range) return { min: Number(range[1]) * unit(range[3]), max: Number(range[2]) * unit(range[3]) };
  const single = t.match(/(\d+(?:\.\d+)?)\s*(lakhs?|lacs?|crores?)\b/);
  if (single) return { min: null, max: Number(single[1]) * unit(single[2]) };
  return null;
}

function findLocation(callerText: string): { text: string | null; outside: boolean } {
  const t = callerText.toLowerCase();
  const all = [...SERVICE_AREA.excluded.value, ...SERVICE_AREA.served.value, ...SERVICE_AREA.servedAssumed.value];
  const hits = all.filter((x) => new RegExp(`\\b${x.toLowerCase()}\\b`).test(t));
  if (hits.length) return { text: hits.join(", "), outside: false };
  const city = OTHER_CITIES.find((c) => new RegExp(`\\b${c}\\b`).test(t));
  if (city) return { text: city[0].toUpperCase() + city.slice(1), outside: true };
  if (/\bpune\b|\bpcmc\b/.test(t) && !/\b(near|outside) pune\b/.test(t)) return { text: "Pune", outside: false };
  return { text: null, outside: false };
}

const YES = /^\s*(yes|yeah|yep|yup|sure|correct|right|haan|ha|ho|of course|absolutely)\b/i;

export function heuristicExtract(turns: Turn[], callDate: Date): Partial<Facts> {
  turns = turns.map((x) => ({ ...x, text: x.text.replace(/[‘’]/g, "'") }));
  const caller = turns.filter((x) => x.role === "caller").map((x) => x.text);
  const text = caller.join(" \n ");
  const t = text.toLowerCase();
  const f: Partial<Facts> = {};

  // Answers to the agent's direct questions ("yes" right after a question).
  for (let i = 1; i < turns.length; i++) {
    const prev = turns[i - 1];
    const cur = turns[i];
    if (prev.role !== "agent" || cur.role !== "caller") continue;
    const q = prev.text.toLowerCase();
    if (YES.test(cur.text)) {
      if (/are you the owner|deciding on the project|decision/.test(q)) f.decision_maker = "yes";
      if (/design with execution|full design/.test(q)) f.wants_execution = "yes";
      if (/within pune city or pcmc/.test(q)) f.location_text = "Pune / PCMC (confirmed by caller)";
    }
    if (/^\s*(no|nope|nahi)\b/i.test(cur.text) && /within pune city or pcmc/.test(q)) f.location_outside_pune = true;
    if (/your name/.test(q)) {
      const m = cur.text.match(/(?:i'?m|i am|my name is|this is|it'?s)?\s*([A-Z][a-z]+(?:\s[A-Z][a-z]+)?)/);
      if (m && !YES.test(cur.text)) f.caller_name = m[1];
    }
    if (/days or times|consultation/.test(q) && !/^\s*(no|not)\b/i.test(cur.text) && /(mon|tue|wed|thu|fri|sat|sun)[a-z]*|weekend|weekday|morning|afternoon|evening|tomorrow|next week|after \d|\d\s*(am|pm)/i.test(cur.text)) {
      f.preferred_slots = [cur.text.trim()];
    }
  }

  // Call type
  if (/my (designer|project has been|project is)|designer hasn'?t replied|existing project|ongoing project|complaint/.test(t)) f.call_type = "existing_client";
  else if (/i('?d)? called (on|earlier|yesterday|just now|before)|messaged \d+ days ago|following up|got cut off|no one (replied|called back)|someone said they'?d get back/.test(t)) f.call_type = "follow_up";
  else if (/interior|design|redo|renovat|flat|bhk|office|home|room|kitchen|villa|project/.test(t)) f.call_type = "new_enquiry";

  const name = text.match(/\b(?:[Ii]'?m|[Ii] am|[Mm]y name is|[Tt]his is)\s+([A-Z][a-z]+(?:\s[A-Z][a-z]+)?)/);
  if (name && !/^(calling|looking|planning|in|not|just|the|a)$/i.test(name[1].split(" ")[0])) f.caller_name = name[1];

  const loc = findLocation(text);
  if (loc.text) f.location_text = loc.text;
  if (loc.outside) f.location_outside_pune = true;

  // Property
  if (/\brestaurant|caf[eé]\b/.test(t)) f.property_kind = "restaurant";
  else if (/\bhotel\b/.test(t)) f.property_kind = "hotel";
  else if (/\b(retail|shop|store|showroom)\b/.test(t)) f.property_kind = "retail";
  else if (/\bgym\b|fitness/.test(t)) f.property_kind = "gym";
  else if (/\bcoworking\b|\bpod\b/.test(t)) f.property_kind = "coworking";
  else if (/\bclinic\b/.test(t)) f.property_kind = "clinic";
  else if (/\boffice\b(?! corner)/.test(t) && !/home office/.test(t)) f.property_kind = "office";
  else if (/\bvilla\b/.test(t)) f.property_kind = "villa";
  else if (/independent house|bungalow|row house/.test(t)) f.property_kind = "independent_house";
  else if (/\bbhk\b|\bflat\b|apartment/.test(t)) f.property_kind = "apartment";
  if (f.property_kind) {
    f.property_category = ["office", "clinic", "coworking", "restaurant", "hotel", "retail", "gym"].includes(f.property_kind) ? "commercial" : "residential";
  }

  const bhk = t.match(/(\d)\s*bhk/);
  if (bhk) f.bhk = Number(bhk[1]);
  const area = t.match(/(\d[\d,]{1,6})\s*(?:sq\.?\s*ft|sqft|square feet|sq feet)/);
  if (area) f.carpet_area_sqft = Number(area[1].replace(/,/g, ""));

  const rooms = ROOM_WORDS.filter(([re]) => re.test(t)).map(([, n]) => n);
  const roomSet = Array.from(new Set(rooms.filter((r) => !(r === "bedroom" && rooms.includes("bedrooms")))));
  if (roomSet.length) f.scope_rooms = roomSet;
  const scopeRooms = roomSet.filter((r) => !["wardrobes", "flooring"].includes(r));
  if (f.property_category === "commercial") {
    if (/fit\s?out|workstations|full|whole|complete|from scratch|bare shell/.test(t)) f.scope_type = "office_fitout";
  } else if (/\b(whole|entire|full|complete)\s+(home|house|flat|thing|interiors|redesign|package|end-to-end)|end-to-end|everything from scratch|do everything|full home|full interiors|poora ghar/.test(t)) {
    f.scope_type = "full_home";
  } else if (scopeRooms.length >= 2 || /\bboth bedrooms|all .* bedrooms/.test(t)) {
    f.scope_type = "partial_home";
  } else if (scopeRooms.length === 1) {
    f.scope_type = "single_room";
  }
  if (scopeRooms.length) f.room_count = scopeRooms.length + (/both bedrooms|two bedrooms/.test(t) ? 1 : 0);

  const state = t.match(/(bare shell|builder flat|builder furniture|new possession|just got possession|completely empty|empty|new construction|moved in [^.,]+|lived here [^.,]+)/);
  if (state) f.current_state = state[1];

  // Intent signals (qualified.md#1 red flags)
  if (/just (looking for|want) (some )?(ideas|suggestions)|give us some ideas|come and (advise|give)|just suggestions|second opinion|consultation only|just exploring|not planning to do the full/.test(t)) f.advice_only = true;
  if (/colou?rs?,? furniture arrangement|rearrang|styling only|just (colours|decor)/.test(t)) f.decor_only = true;
  if (/(do|handle) the execution (myself|ourselves)|i'?ll do the execution/.test(t)) f.wants_execution = "no";
  else if (/full (redesign|execution|interiors|package)|design and execution|execution|redo|redesign|end-to-end|do the (full|whole)|fit\s?out|modular kitchen|wardrobes|properly design/.test(t) && !f.advice_only) f.wants_execution = "yes";
  if (/only (want|need) (furniture|a sofa|furniture sourced)|just (buy|source) furniture/.test(t)) f.furniture_only = true;
  if (/vastu/.test(t) && /only|just/.test(t) && !/design/.test(t)) f.vastu_only = true;
  if (/(break|move|remove|knock) (down )?(a |the )?walls?|structural/.test(t) && !/no structural|don'?t break|not break|no wall/.test(t)) f.structural_work_requested = true;
  if (/\brent(ed|al)?\b|\blease\b|landlord/.test(t)) f.rented = true;

  // Timeline: prefer the caller's line that talks about timing.
  const timingLines = caller.filter((c) => /\bby (?!you)|before |done|move in|move back|operational|complete|ready|start|weeks|months|deadline|flexible|no rush|diwali|whenever/i.test(c));
  for (const line of timingLines) {
    const tl = parseTimeline(line, callDate);
    if (tl.weeks === null) continue;
    f.weeks_until_needed = tl.weeks;
    f.timeline_text = line.trim().slice(0, 140);
    break;
  }
  if (!f.timeline_text && timingLines.length) f.timeline_text = timingLines[0].trim().slice(0, 140);

  const budget = parseBudget(t);
  if (budget && /budget|afford|maximum|max|spend|lakh/.test(t)) {
    f.budget_volunteered = true;
    f.budget_min_inr = budget.min;
    f.budget_max_inr = budget.max;
  }

  if (/\b(i'?m|i am) the (owner|founder|decision|director|md)\b|\bwe own\b|i own (it|the)|both want to be at the consultation|(husband|wife|partner|spouse) (knows|said|is happy|agreed)|happy to go ahead|said to go ahead/.test(t)) f.decision_maker = "yes";
  else if (/(asked me to call|on behalf of)/.test(t)) f.decision_maker = "authorised";
  else if (/(parents|in-?laws|my (mother|father|boss))/.test(t)) {
    f.decision_maker = /(they'?ll decide|they would come|will attend|they'?ll come)/.test(t) ? "authorised" : "unknown";
    f.decision_maker_note = "Calling on behalf of family / others";
    if (/just (doing )?(initial )?research|just checking/.test(t) && f.decision_maker === "unknown") f.decision_maker = "not_authorised";
  }

  if (/how much|cost|price|pricing|rate|ballpark|per sq|budget range|charges?/.test(t)) f.pricing_asked = true;

  const ref = text.match(/(?:from (?:a )?friend[^.,]*|referred by [^.,]+|on instagram|on linkedin|google|asked me to call|recommend[a-z]* [^.,]+)/i);
  if (ref) f.referral_source = ref[0].trim();
  if (/site visit|come to (the )?site|see the site|at (the|my) (site|flat)/.test(t)) f.site_visit_requested = true;

  if (f.call_type === "existing_client") {
    const d = text.match(/my designer is (\w+)/i);
    f.existing_project_note = d ? `Existing client, designer ${d[1]}` : "Existing client calling about an ongoing project";
  }
  return f;
}
