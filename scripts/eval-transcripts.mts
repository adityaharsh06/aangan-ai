/**
 * Offline check of the understanding step against the 20 Sep 2026 phone transcripts:
 * extract facts (Gemini if GEMINI_API_KEY is set, otherwise the rules fallback), run the
 * qualification engine, and compare with the outcome our rules should reach.
 *
 *   npm run eval
 *
 * "pending" means the front desk never asked about a blocking criterion; the live agent would ask.
 * This reads .env.local for GEMINI_API_KEY and sends transcript text to Gemini; it writes nothing.
 */
import { existsSync, readFileSync } from "node:fs";
import { extractFacts } from "@/lib/agent/extract";
import { geminiConfigured } from "@/lib/ai/gemini";
import { emptyFacts, mergeFacts } from "@/lib/domain/facts";
import { evaluate } from "@/lib/qualification/engine";
import { parsePhoneTranscripts } from "@/lib/transcripts";

if (existsSync(".env.local")) process.loadEnvFile(".env.local");

/** Acceptable outcomes per call. Where a model can reasonably land on either, both are listed. */
const EXPECTED: Record<string, string[]> = {
  T01: ["qualified"],
  T02: ["qualified"],
  T03: ["unqualified"],
  T04: ["unqualified"],
  T05: ["qualified"],
  T06: ["qualified"],
  // "Before Diwali" (~3 weeks) fails; the caller then floats starting after Diwali.
  T07: ["unqualified", "pending"],
  T09: ["existing_client"],
  T10: ["unqualified"],
  T11: ["pending"],
  T12: ["qualified"],
  T13: ["pending", "qualified"],
  T14: ["pending"],
  T15: ["pending"],
  T16: ["pending", "qualified"],
  T17: ["qualified"],
  T18: ["pending", "qualified"],
  T19: ["unqualified"],
  T20: ["qualified"],
};

const all = parsePhoneTranscripts(readFileSync("knowledge/enquiries-sep-2026.txt", "utf8"));
// Free-tier Gemini keys allow only a few requests a minute; pace the run (EVAL_DELAY_MS=0 to disable).
const delayMs = geminiConfigured() ? Number(process.env.EVAL_DELAY_MS ?? 13_000) : 0;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let pass = 0;
let total = 0;
let tokens = 0;
const modes = new Set<string>();

for (const t of all) {
  const want = EXPECTED[t.id];
  if (!want || t.missed) {
    console.log(`${t.id}  skipped${t.missed ? " (missed call)" : ""}`);
    continue;
  }
  if (total > 0 && delayMs) await sleep(delayMs);
  total += 1;
  const x = await extractFacts(t.turns, t.date);
  modes.add(x.mode);
  tokens += x.usage?.totalTokenCount ?? 0;
  const facts = mergeFacts(emptyFacts(), x.facts);
  const ev = evaluate(facts, { real_project: true, service_area: true, timeline: true });
  const got = facts.call_type === "existing_client" ? "existing_client" : ev.outcome;
  const ok = want.includes(got);
  if (ok) pass += 1;
  const why = ev.criteria.filter((c) => c.status !== "pass").map((c) => `${c.key}=${c.status}`).join(" ");
  console.log(`${t.id}  ${ok ? "ok  " : "MISS"}  got ${got.padEnd(15)} want ${want.join("|").padEnd(22)} ${x.mode}${x.error ? ` (${x.error})` : ""}  ${why}`);
}

console.log(`\n${pass}/${total} match · extraction: ${[...modes].join(", ")}${tokens ? ` · ${tokens.toLocaleString("en-IN")} Gemini tokens` : ""}`);
