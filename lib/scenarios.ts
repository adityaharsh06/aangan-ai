/**
 * Scripted callers for the call simulator. Each persona answers whatever the agent last asked
 * (keyed by `session.dialogue.lastAction`). Personas are modelled on the Sep 2026 phone calls
 * (knowledge/enquiries-sep-2026.txt); `expect` is what our rules should conclude, not what the
 * front desk did on the day.
 */
import type { AgentAction } from "@/lib/agent/types";

export interface Scenario {
  id: string;
  label: string;
  basedOn: string;
  expect: "qualified" | "unqualified" | "escalated" | "needs_review";
  /** Caller number; distinct per scenario so duplicate detection / resume don't merge them. */
  from: string;
  /** Simulated call time in IST ("HH:MM"), for after-hours scenarios. */
  istTime?: string;
  opening: string;
  answers: Partial<Record<AgentAction, string>>;
}

const FALLBACK = "No, that's all, thank you.";

export const SCENARIOS: Scenario[] = [
  {
    id: "t01",
    label: "Referral, 3BHK full home",
    basedOn: "T01",
    expect: "qualified",
    from: "+91 98220 10001",
    opening: "Hi, I'm Priya. I got your number from a friend, Shruti Joshi. We have a 3BHK in Kothrud and want to redo the whole thing: kitchen, living room, both bedrooms.",
    answers: {
      ask_timeline: "We'd like to be done by March. We're in no rush.",
      ask_size: "About 1,400 sq ft carpet.",
      ask_current_state: "It still looks like the builder flat.",
      ask_decision_maker: "Yes, myself and my husband. He knows we're calling and is happy to go ahead.",
      ask_slot: "Saturday morning works, at the flat if possible.",
    },
  },
  {
    id: "t02",
    label: "Price-pusher, 2BHK Wakad",
    basedOn: "T02",
    expect: "qualified",
    from: "+91 98220 10002",
    opening: "Hi. I have a 2BHK in Wakad, can you tell me roughly how much something like that would cost?",
    answers: {
      ask_scope: "Full redesign: modular kitchen, wardrobes, living room, both bedrooms. About 950 sq ft.",
      ask_timeline: "But seriously, can't you give me even a rough range? We'd like it done by February.",
      ask_size: "About 950 sq ft.",
      ask_current_state: "New possession, nothing done yet.",
      ask_decision_maker: "Yes, it's my flat.",
      ask_name: "Rohan Kale",
      ask_slot: "Sunday afternoon.",
    },
  },
  {
    id: "t03",
    label: "Out of area (Nashik)",
    basedOn: "T03",
    expect: "unqualified",
    from: "+91 98220 10003",
    opening: "Hello, my name is Suresh Patil. I'm in Nashik. Would you be able to take on a project here? I want to redo my home office and study.",
    answers: {},
  },
  {
    id: "t04",
    label: "Advice only",
    basedOn: "T04",
    expect: "unqualified",
    from: "+91 98220 10004",
    opening: "Hi, can someone come and give us some ideas for our living room? We're not planning to do the full thing right now. Just want suggestions on colours, furniture arrangement.",
    answers: { ask_location: "Baner." },
  },
  {
    id: "t07",
    label: "Needed before Diwali (3 weeks)",
    basedOn: "T07",
    expect: "unqualified",
    from: "+91 98220 10007",
    opening: "Hello, I want to redo my living room and kitchen in Aundh. Can you take it up?",
    answers: { ask_timeline: "In 3 weeks, before Diwali. Guests are coming." },
  },
  {
    id: "t10",
    label: "Volunteered budget far below scope",
    basedOn: "T10",
    expect: "unqualified",
    from: "+91 98220 10010",
    opening: "Hi. I have a 1BHK in Kharadi, about 550 sq ft. I want to do the kitchen and one bedroom. My budget is 1 to 1.5 lakh maximum for everything.",
    answers: { ask_timeline: "By March." },
  },
  {
    id: "t09",
    label: "Existing client complaint",
    basedOn: "T09",
    expect: "escalated",
    from: "+91 98220 10009",
    opening: "I need to speak to someone right now. My project has been going for three months and my designer hasn't replied in five days. My designer is Aryan.",
    answers: { ask_existing_details: "Sheetal Deshpande. Flat in Viman Nagar." },
  },
  {
    id: "night-office",
    label: "After-hours office fit-out (11:10pm)",
    basedOn: "Case brief: a third of enquiries arrive after hours",
    expect: "qualified",
    from: "+91 98220 10099",
    istTime: "23:10",
    opening: "Hi, sorry for calling so late. I run a small accounting firm and we've taken a new office in Baner, about 1,200 sq ft. We need the full interiors done.",
    answers: {
      ask_timeline: "We'd like to move in by end of February.",
      ask_current_state: "Bare shell, just handed over.",
      ask_decision_maker: "Yes, I'm the founder, I decide.",
      ask_name: "Anand Kulkarni.",
      ask_slot: "Any weekday after 6pm.",
    },
  },
];

export function scriptedAnswer(s: Scenario, lastAction: AgentAction | null): string {
  if (lastAction === null || lastAction === "greet") return s.opening;
  return s.answers[lastAction] ?? FALLBACK;
}

/** ISO timestamp for today's date (IST) at the scenario's simulated time, or null for "now". */
export function scenarioStart(s: Scenario, now = new Date()): string | null {
  if (!s.istTime) return null;
  const ymd = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata" }).format(now);
  const at = new Date(`${ymd}T${s.istTime}:00+05:30`);
  // Never simulate a call in the future.
  if (at > now) at.setUTCDate(at.getUTCDate() - 1);
  return at.toISOString();
}
