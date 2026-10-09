import { SCRIPTS } from "@/lib/knowledge/rules";

/**
 * pricing.md: the agent must never say "any specific number, range, or per-sq-ft figure".
 * Every customer-facing line passes through this check before it is spoken.
 */
const MONEY = [
  /₹/,
  /\brs\.?\s*\d/i,
  /\binr\b/i,
  /\d[\d,.]*\s*(lakh|lakhs|lac|lacs|crore|crores|cr)\b/i,
  /\b(lakh|lac|crore)s?\b/i,
  /per\s*(sq|square)/i,
  /\bstart(s)? (at|from)\b/i,
  /\bit'?ll cost\b|\bcost(s)? around\b|\btypically costs?\b/i,
  /\d+\s*k\b/i,
];

export class PricingLeakError extends Error {
  constructor(public readonly text: string) {
    super("Customer-facing reply contained pricing language and was blocked.");
    this.name = "PricingLeakError";
  }
}

export function containsPricing(text: string): boolean {
  const withoutScript = text.split(SCRIPTS.pricing.value).join(" ");
  return MONEY.some((re) => re.test(withoutScript));
}

/** Returns the text if safe, otherwise throws so the caller can fall back to a safe template. */
export function assertCustomerSafe(text: string): string {
  if (containsPricing(text)) throw new PricingLeakError(text);
  return text;
}
