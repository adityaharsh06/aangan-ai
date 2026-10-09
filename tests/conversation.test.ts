import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { callerTurn, startCall, type CallSession } from "@/lib/agent/conversation";
import { containsPricing } from "@/lib/agent/guard";
import { heuristicExtract } from "@/lib/agent/heuristic";
import { mergeFacts, emptyFacts } from "@/lib/domain/facts";
import { evaluate } from "@/lib/qualification/engine";
import { SCRIPTS } from "@/lib/knowledge/rules";
import { parsePhoneTranscripts } from "@/lib/transcripts";
import type { AgentAction } from "@/lib/agent/types";

// 2 Oct 2026, 11:00 IST (inside studio hours) and 23:10 IST (after hours).
const DAY = new Date("2026-10-02T05:30:00Z");
const NIGHT = new Date("2026-10-02T17:40:00Z");

type Persona = Partial<Record<AgentAction | "opening", string>>;

/** Drive a whole call: the persona answers whatever the agent asks. Runs on the rules extractor (no Gemini). */
async function runCall(p: Persona, at = DAY) {
  let { session } = startCall(at);
  const replies: string[] = [];
  const actions: AgentAction[] = [];
  let next = p.opening!;
  for (let i = 0; i < 20; i++) {
    const out = await callerTurn(session, next, at, at);
    session = out.session;
    replies.push(out.reply);
    actions.push(out.action);
    if (out.endCall) break;
    next = p[out.action] ?? "No, that's all, thanks.";
  }
  return { session: session as CallSession, replies, actions };
}

const T01: Persona = {
  opening: "Hi, I'm Priya. I got your number from a friend, Shruti Joshi. We have a 3BHK in Kothrud and want to redo the whole thing: kitchen, living room, both bedrooms.",
  ask_timeline: "We'd like to be done by March. We're in no rush.",
  ask_size: "About 1,400 sq ft carpet.",
  ask_current_state: "It still looks like the builder flat.",
  ask_decision_maker: "Yes, myself and my husband. He knows we're calling and is happy to go ahead.",
  ask_slot: "Saturday morning works, at the flat if possible.",
};

describe("phone conversation (rules-only mode)", () => {
  it("qualifies a T01-style caller, asks each missing item once, and closes with a callback promise", async () => {
    const { session, replies, actions } = await runCall(T01);
    expect(session.dialogue.closeReason).toBe("qualified");
    expect(actions).toContain("ask_timeline");
    expect(actions).not.toContain("ask_name"); // name already given
    expect(actions.at(-1)).toBe("goodbye");
    expect(session.facts.preferred_slots.length).toBeGreaterThan(0);
    expect(session.facts.referral_source).toMatch(/friend/i);
    for (const r of replies) expect(containsPricing(r)).toBe(false);
    // No question is asked twice.
    const asks = actions.filter((a) => a.startsWith("ask_"));
    expect(new Set(asks).size).toBe(asks.length);
  });

  it("answers a pricing question with the verbatim pricing.md script, never a number, and does not disqualify", async () => {
    const { session, replies } = await runCall({
      ...T01,
      opening: "Hi. I have a 2BHK in Wakad, can you tell me roughly how much something like that would cost?",
      ask_scope: "Full redesign: modular kitchen, wardrobes, living room, both bedrooms. About 950 sq ft.",
      ask_timeline: "But seriously, can't you give me even a rough range? We'd like it done by February.",
      ask_name: "Rohan Kale",
    });
    expect(replies[0]).toContain(SCRIPTS.pricing.value);
    expect(replies.filter((r) => r.includes(SCRIPTS.pricing.value)).length).toBeGreaterThanOrEqual(2);
    for (const r of replies) expect(containsPricing(r)).toBe(false);
    expect(session.facts.pricing_asked).toBe(true);
    expect(session.dialogue.closeReason).toBe("qualified");
  });

  it("T03: out-of-area caller is declined politely and not forwarded", async () => {
    const { session, replies } = await runCall({
      opening: "Hello, my name is Suresh Patil. I'm in Nashik. Would you be able to take on a project here? I want to redo my home office and study.",
    });
    expect(session.dialogue.closeReason).toBe("unqualified");
    expect(replies[0]).toMatch(/Pune city and PCMC/);
  });

  it("T04: advice-only caller gets the full-service explanation", async () => {
    const { session, replies } = await runCall({
      opening: "Hi, can someone come and give us some ideas for our living room? We're not planning to do the full thing right now. Just want suggestions on colours, furniture arrangement.",
      ask_location: "Baner",
    });
    expect(session.dialogue.closeReason).toBe("unqualified");
    expect(replies.join(" ")).toMatch(/design and execution together/);
  });

  it("T07: needed in three weeks is declined honestly with an invitation to call back", async () => {
    const { session, replies } = await runCall({
      opening: "Hello, I want to redo my living room and kitchen in Aundh. Can you take it up?",
      ask_timeline: "In 3 weeks, before Diwali.",
    });
    expect(session.dialogue.closeReason).toBe("unqualified");
    expect(replies.join(" ")).toMatch(/3 to 4 weeks/);
  });

  it("two failures use the exact qualified.md decline line", async () => {
    const { replies } = await runCall({ opening: "We have a flat in Mumbai and want the kitchen and bedroom redone in 2 weeks." });
    expect(replies[0]).toContain(SCRIPTS.decline.value);
  });

  it("T10: volunteered budget clearly below scope is addressed without quoting any figure", async () => {
    const { session, replies } = await runCall({
      opening: "Hi. I have a 1BHK in Kharadi, about 550 sq ft. I want to do the kitchen and one bedroom. My budget is 1 to 1.5 lakh maximum for everything.",
      ask_timeline: "By March.",
    });
    expect(session.dialogue.closeReason).toBe("unqualified");
    expect(replies.join(" ")).toMatch(/significantly below/);
    for (const r of replies) expect(containsPricing(r)).toBe(false);
  });

  it("T09: existing client complaint is escalated, not qualified", async () => {
    const { session, actions } = await runCall({
      opening: "I need to speak to someone right now. My project has been going for three months and my designer hasn't replied in five days. My designer is Aryan.",
      ask_existing_details: "Sheetal Deshpande. Flat in Viman Nagar.",
    });
    expect(session.dialogue.closeReason).toBe("escalated");
    expect(actions).toContain("close_escalated");
  });

  it("caller who keeps not answering is offered a human callback instead of looping", async () => {
    const { session } = await runCall({
      opening: "hello?",
      ask_scope: "hmm",
      ask_real_project_direct: "what?",
      ask_location: "sorry",
      ask_location_direct: "hmm",
      ask_timeline: "I don't know",
      goodbye: "ok",
    });
    expect(["callback", "needs_review"]).toContain(session.dialogue.closeReason);
  });

  it("after-hours caller is answered, qualified and told the designer calls from 10am", async () => {
    const { session, replies } = await runCall({ ...T01, ask_slot: "Any weekday evening." }, NIGHT);
    expect(replies.length).toBeGreaterThan(0);
    expect(session.dialogue.closeReason).toBe("qualified");
    expect(replies.join(" ")).toMatch(/from 10am/);
  });
});

describe("Sep 2026 phone transcripts → rules extractor → engine", () => {
  const all = parsePhoneTranscripts(readFileSync("knowledge/enquiries-sep-2026.txt", "utf8"));

  it("parses all 20 phone calls", () => {
    expect(all.map((t) => t.id)).toEqual(Array.from({ length: 20 }, (_, i) => `T${String(i + 1).padStart(2, "0")}`));
  });

  // Expected outcome if our agent had heard exactly what the caller said.
  // "pending" = the front desk never asked for a criterion; our agent would ask it.
  const expected: Record<string, string> = {
    T01: "qualified", T02: "qualified", T03: "unqualified", T04: "unqualified", T05: "qualified", T06: "qualified",
    T07: "pending", // "before Diwali" — the rules extractor can't date festivals; the live agent asks for a completion date
    T10: "unqualified", T11: "pending", T12: "qualified", T13: "pending", T14: "pending", T15: "pending", T16: "pending",
    T17: "qualified", T18: "pending", T19: "unqualified", T20: "qualified",
  };

  for (const [id, want] of Object.entries(expected)) {
    it(`${id} → ${want}`, () => {
      const t = all.find((x) => x.id === id)!;
      const facts = mergeFacts(emptyFacts(), heuristicExtract(t.turns, t.date));
      const ev = evaluate(facts, { timeline: true, real_project: true, service_area: true });
      expect(ev.outcome, JSON.stringify({ facts, criteria: ev.criteria }, null, 1)).toBe(want);
    });
  }

  it("T09 is recognised as an existing client and T16 as a follow-up", () => {
    const t09 = all.find((x) => x.id === "T09")!;
    const t16 = all.find((x) => x.id === "T16")!;
    expect(heuristicExtract(t09.turns, t09.date).call_type).toBe("existing_client");
    expect(heuristicExtract(t16.turns, t16.date).call_type).toBe("follow_up");
  });
});
