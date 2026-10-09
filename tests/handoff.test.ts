import { describe, expect, it } from "vitest";
import { assertCustomerSafe, containsPricing, PricingLeakError } from "@/lib/agent/guard";
import { emptyFacts, mergeFacts } from "@/lib/domain/facts";
import { evaluate } from "@/lib/qualification/engine";
import { SCRIPTS } from "@/lib/knowledge/rules";
import { alertMessage, designerHandoffMessage } from "@/lib/handoff";
import { SCENARIOS, scenarioStart, scriptedAnswer } from "@/lib/scenarios";
import { callerTurn, startCall } from "@/lib/agent/conversation";

describe("pricing guard", () => {
  it("allows the verbatim pricing.md script", () => {
    expect(containsPricing(SCRIPTS.pricing.value)).toBe(false);
    expect(assertCustomerSafe(`Sure. ${SCRIPTS.pricing.value}`)).toContain(SCRIPTS.pricing.value);
  });

  it.each([
    "A 2BHK typically costs around 18 lakh.",
    "We charge ₹1,800 per sq ft.",
    "Rates start from 1800 per square foot.",
    "Roughly Rs 15 lakh to 20 lakh.",
    "Budget of 500k should do.",
  ])("blocks %s", (line) => {
    expect(containsPricing(line)).toBe(true);
    expect(() => assertCustomerSafe(line)).toThrow(PricingLeakError);
  });

  it("does not block ordinary numbers", () => {
    expect(containsPricing("Our design phase takes 3 to 4 weeks, and we'll call you from 10am.")).toBe(false);
    expect(containsPricing("Roughly how big is the home: how many BHK?")).toBe(false);
  });
});

describe("designer handoff (Telegram)", () => {
  const facts = mergeFacts(emptyFacts(), {
    call_type: "new_enquiry",
    caller_name: "Priya <script>",
    location_text: "Kothrud",
    property_category: "residential",
    property_kind: "apartment",
    bhk: 3,
    carpet_area_sqft: 1400,
    scope_type: "full_home",
    scope_rooms: ["kitchen", "living room"],
    wants_execution: "yes",
    timeline_text: "by March",
    weeks_until_needed: 22,
    decision_maker: "yes",
    pricing_asked: true,
    preferred_slots: ["Saturday morning"],
  });
  const ev = evaluate(facts);
  const msg = designerHandoffMessage({
    enquiryId: "00000000-0000-0000-0000-000000000001",
    phone: "+919822010001",
    facts,
    criteria: ev.criteria,
    notes: ev.notes,
    summary: "Priya wants her 3BHK in Kothrud redone.",
    concerns: [],
    nextAction: "Call to confirm Saturday.",
    receivedAt: "2026-10-02T17:40:00Z",
    afterHours: true,
    responseSeconds: 2,
    appUrl: "https://example.test",
  });

  it("carries what was already asked, so the designer doesn't repeat it", () => {
    for (const s of ["Kothrud", "3BHK", "1400 sq ft", "by March", "Saturday morning", "after hours", "answered in 2s"]) expect(msg).toContain(s);
  });

  it("never carries a price, only that the caller asked", () => {
    expect(msg).toMatch(/caller asked about price\. No figure given/);
    expect(containsPricing(msg)).toBe(false);
  });

  it("escapes HTML and stays within Telegram's limit", () => {
    expect(msg).toContain("Priya &lt;script&gt;");
    expect(msg.length).toBeLessThanOrEqual(4000);
  });

  it("alerts name the kind and the number", () => {
    const a = alertMessage("escalation", { enquiryId: "x", phone: "+91 98", name: null, detail: "Designer not replying", appUrl: null });
    expect(a).toMatch(/EXISTING CLIENT/);
    expect(a).toContain("+91 98");
  });
});

describe("simulator scenarios reach their expected outcome (rules-only mode)", () => {
  const CLOSE: Record<string, string> = { qualified: "qualified", unqualified: "unqualified", escalated: "escalated", needs_review: "needs_review" };
  for (const s of SCENARIOS) {
    it(`${s.id} → ${s.expect}`, async () => {
      const at = new Date(scenarioStart(s, new Date("2026-10-09T12:00:00Z")) ?? "2026-10-09T05:30:00Z");
      let { session } = startCall(at);
      for (let i = 0; i < 20; i++) {
        const out = await callerTurn(session, scriptedAnswer(s, session.dialogue.lastAction), at, at);
        session = out.session;
        expect(containsPricing(out.reply)).toBe(false);
        if (out.endCall) break;
      }
      expect(session.dialogue.closeReason).toBe(CLOSE[s.expect]);
    });
  }

  it("after-hours scenario time is in the past and outside 10am–7pm IST", () => {
    const now = new Date("2026-10-09T12:00:00Z");
    const iso = scenarioStart(SCENARIOS.find((s) => s.istTime)!, now)!;
    expect(new Date(iso) <= now).toBe(true);
    expect(iso).toBe("2026-10-08T17:40:00.000Z");
  });
});
