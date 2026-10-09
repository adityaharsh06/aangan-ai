import { describe, expect, it } from "vitest";
import { KNOWLEDGE_DOCS, KNOWLEDGE_VERSION } from "@/lib/knowledge/source.generated";
import { SCRIPTS, SERVICE_AREA, BUDGET_CHECK } from "@/lib/knowledge/rules";
import { assertCustomerSafe, containsPricing } from "@/lib/agent/guard";

describe("rules stay in sync with the source documents", () => {
  it("has a knowledge version", () => expect(KNOWLEDGE_VERSION).toMatch(/^[0-9a-f]{12}$/));

  it("pricing script is verbatim from pricing.md", () => {
    expect(KNOWLEDGE_DOCS["pricing.md"]).toContain(SCRIPTS.pricing.value);
  });

  it("decline line is verbatim from qualified.md", () => {
    expect(KNOWLEDGE_DOCS["qualified.md"]).toContain(SCRIPTS.decline.value);
  });

  it("timeline question is verbatim from qualified.md", () => {
    expect(KNOWLEDGE_DOCS["qualified.md"]).toContain(SCRIPTS.timelineQuestion.value);
  });

  it("every named service-area locality appears in services.md", () => {
    for (const x of [...SERVICE_AREA.served.value, ...SERVICE_AREA.excluded.value]) expect(KNOWLEDGE_DOCS["services.md"]).toContain(x);
  });

  it("internal budget floors match pricing.md", () => {
    expect(KNOWLEDGE_DOCS["pricing.md"]).toContain("₹1,800 – ₹2,400 per sq ft");
    expect(KNOWLEDGE_DOCS["pricing.md"]).toContain("₹1,200 – ₹1,800 per sq ft");
    expect(KNOWLEDGE_DOCS["pricing.md"]).toContain("₹3.5 lakh – ₹8 lakh");
    expect(BUDGET_CHECK.residentialFloorPerSqft.value).toBe(1800);
  });
});

describe("pricing guard (pricing.md: never say a number)", () => {
  it.each([
    "It'll cost around 15 lakh",
    "Our rates start at ₹1,800",
    "For a 2BHK it's typically 12 lakhs",
    "We charge 2000 per sq ft",
    "Roughly Rs 5 lakh",
    "about 500k",
  ])("blocks: %s", (s) => {
    expect(containsPricing(s)).toBe(true);
    expect(() => assertCustomerSafe(s)).toThrow();
  });

  it("allows the approved pricing script and normal sentences", () => {
    expect(containsPricing(SCRIPTS.pricing.value)).toBe(false);
    expect(containsPricing(`${SCRIPTS.pricing.value} Where is the property?`)).toBe(false);
    expect(containsPricing("Our design phase alone takes 3 to 4 weeks.")).toBe(false);
  });
});
