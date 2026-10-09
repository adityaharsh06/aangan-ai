import { describe, expect, it } from "vitest";
import { emptyFacts, type Facts } from "@/lib/domain/facts";
import { evaluate, scopeFloorInr } from "@/lib/qualification/engine";
import { matchLocality } from "@/lib/qualification/locality";

const f = (p: Partial<Facts>): Facts => ({ ...emptyFacts(), call_type: "new_enquiry", ...p });

const t01 = f({
  location_text: "Kothrud, Dahanukar Colony", property_category: "residential", property_kind: "apartment", bhk: 3,
  carpet_area_sqft: 1400, scope_type: "full_home", scope_rooms: ["kitchen", "living room", "bedrooms"], wants_execution: "yes",
  weeks_until_needed: 26, timeline_text: "done by March", decision_maker: "yes",
});

describe("qualification engine (qualified.md)", () => {
  it("T01: full home in Kothrud, March, owner → qualified", () => {
    const ev = evaluate(t01);
    expect(ev.outcome).toBe("qualified");
    expect(ev.criteria.every((c) => c.status === "pass")).toBe(true);
  });

  it("T03: Nashik → fails service area", () => {
    const ev = evaluate({ ...t01, location_text: "Nashik", location_outside_pune: true });
    expect(ev.outcome).toBe("unqualified");
    expect(ev.failed).toEqual(["service_area"]);
  });

  it("F03: Talegaon is explicitly excluded even when caller says 'near Pune'", () => {
    expect(matchLocality("Talegaon Dabhade, near Pune").status).toBe("excluded");
    expect(evaluate({ ...t01, location_text: "Talegaon Dabhade, near Pune" }).failed).toContain("service_area");
  });

  it("T04: advice only → fails real project", () => {
    const ev = evaluate(f({ ...t01, advice_only: true, decor_only: true, wants_execution: "unknown", scope_type: "single_room" }));
    expect(ev.failed).toContain("real_project");
  });

  it("T19 / W07: restaurant and gym are out of scope", () => {
    expect(evaluate(f({ ...t01, property_category: "commercial", property_kind: "restaurant" })).failed).toContain("real_project");
    expect(evaluate(f({ ...t01, property_category: "commercial", property_kind: "gym" })).failed).toContain("real_project");
  });

  it("T07: needed in 3 weeks → fails timeline (services.md 6-week minimum)", () => {
    const ev = evaluate({ ...t01, weeks_until_needed: 3, timeline_text: "before Diwali" });
    expect(ev.failed).toEqual(["timeline"]);
    expect(ev.outcome).toBe("unqualified");
  });

  it("6–10 weeks is unclear until the direct question has been asked, then passes with a note (U2)", () => {
    const tight = { ...t01, weeks_until_needed: 8 };
    expect(evaluate(tight).blockingUnclear).toContain("timeline");
    const after = evaluate(tight, { timeline: true });
    expect(after.outcome).toBe("qualified");
    expect(after.notes.join(" ")).toMatch(/Tight timeline/);
  });

  it("T10: ₹1–1.5 lakh volunteered for kitchen + bedroom → clearly below → fails budget", () => {
    const t10 = f({
      location_text: "Kharadi", property_category: "residential", property_kind: "apartment", bhk: 1, carpet_area_sqft: 550,
      scope_type: "partial_home", scope_rooms: ["kitchen", "bedroom"], room_count: 2, wants_execution: "yes", weeks_until_needed: 20,
      budget_volunteered: true, budget_min_inr: 100000, budget_max_inr: 150000,
    });
    expect(scopeFloorInr(t10)).toBe(700000);
    const ev = evaluate(t10);
    expect(ev.failed).toEqual(["budget"]);
  });

  it("budget not mentioned → qualified (never probed)", () => {
    expect(evaluate(t01).criteria.find((c) => c.key === "budget")!.status).toBe("pass");
  });

  it("F06: ₹35–40 lakh for 1,950 sq ft partial scope is not 'clearly below'", () => {
    const ev = evaluate({ ...t01, carpet_area_sqft: 1950, scope_type: "partial_home", room_count: 5, budget_volunteered: true, budget_min_inr: 3_500_000, budget_max_inr: 4_000_000 });
    expect(ev.failed).not.toContain("budget");
  });

  it("decision-maker unknown → qualified with a note (don't push)", () => {
    const ev = evaluate({ ...t01, decision_maker: "unknown" });
    expect(ev.outcome).toBe("qualified");
    expect(ev.notes.join(" ")).toMatch(/Decision-maker not confirmed/);
  });

  it("T14: calling for parents who will attend → authorised → qualified", () => {
    expect(evaluate({ ...t01, decision_maker: "authorised", decision_maker_note: "son; parents will attend and decide" }).outcome).toBe("qualified");
  });

  it("only researching for in-laws, no authority → fails decision-maker", () => {
    expect(evaluate({ ...t01, decision_maker: "not_authorised" }).failed).toEqual(["decision_maker"]);
  });

  it("two or more failures → unqualified", () => {
    const ev = evaluate({ ...t01, location_text: "Mumbai", weeks_until_needed: 2 });
    expect(ev.failed.length).toBe(2);
    expect(ev.outcome).toBe("unqualified");
  });

  it("T11: rented apartment is fine (no structural changes)", () => {
    expect(evaluate({ ...t01, rented: true }).outcome).toBe("qualified");
  });

  it("T18: 180 sq ft commercial pod is flagged, not failed (500 sq ft is a transcript remark, not policy)", () => {
    const ev = evaluate(f({ location_text: "Baner", property_category: "commercial", property_kind: "coworking", carpet_area_sqft: 180, scope_type: "office_fitout", wants_execution: "yes", weeks_until_needed: 20 }));
    expect(ev.failed).toEqual([]);
    expect(ev.notes.join(" ")).toMatch(/Small commercial space/);
  });

  it("commercial above ~3,000 sq ft: slightly above is flagged, far above fails", () => {
    const base = f({ location_text: "Baner", property_category: "commercial", property_kind: "office", scope_type: "office_fitout", wants_execution: "yes", weeks_until_needed: 20 });
    expect(evaluate({ ...base, carpet_area_sqft: 3200 }).failed).toEqual([]);
    expect(evaluate({ ...base, carpet_area_sqft: 8000 }).failed).toContain("real_project");
  });

  it("missing location / scope / timeline → pending with blocking unclear criteria", () => {
    const ev = evaluate(f({}));
    expect(ev.outcome).toBe("pending");
    expect(ev.blockingUnclear).toEqual(["real_project", "service_area", "timeline"]);
  });

  it("every criterion result cites a source document", () => {
    for (const c of evaluate(t01).criteria) expect(c.source).toMatch(/\.md|decision U2/);
  });
});
