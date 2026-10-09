/**
 * Parser for the Sep 2026 phone transcripts (knowledge/enquiries-sep-2026.txt, extracted from
 * Aangan_Sep 2026_Enquiries.pdf). Used by tests, the eval script and the call simulator's replay.
 * The transcripts are evidence of how callers talk, never a source of business policy.
 */
import type { Turn } from "@/lib/agent/types";

export interface PhoneTranscript {
  id: string;
  date: Date;
  header: string;
  turns: Turn[];
  note: string | null;
  missed: boolean;
}

const MONTHS: Record<string, number> = { September: 8, October: 9 };

export function parsePhoneTranscripts(raw: string): PhoneTranscript[] {
  const text = raw.replace(/=== PAGE \d+ ===/g, " ").replace(/\r/g, "");
  const phoneSection = text.split("SECTION 2")[0];
  const re = /(T\d{2}) · Phone · (\d{1,2}) (September|October) · ([0-9:]+\s?[ap]m)([^\n]*)/g;
  const heads = [...phoneSection.matchAll(re)];
  return heads.map((h, i) => {
    const start = (h.index ?? 0) + h[0].length;
    const end = i + 1 < heads.length ? heads[i + 1].index : phoneSection.length;
    const body = phoneSection.slice(start, end).replace(/\s+/g, " ").trim();
    const [hh, mm] = h[4].replace(/\s?[ap]m/, "").split(":").map(Number);
    const pm = /pm/.test(h[4]) && hh !== 12;
    // Times in the transcripts are IST (UTC+5:30).
    const date = new Date(Date.UTC(2026, MONTHS[h[3]], Number(h[2]), (pm ? hh + 12 : hh) - 5, (mm ?? 0) - 30));
    const turns: Turn[] = [];
    let note: string | null = null;
    for (const m of body.matchAll(/(Front Desk|Caller|Note):\s*(.*?)(?=(?:Front Desk|Caller|Note):|$)/g)) {
      const t = m[2].replace(/\(gives number\)/g, "").trim();
      if (!t) continue;
      if (m[1] === "Note") note = t;
      else turns.push({ role: m[1] === "Caller" ? "caller" : "agent", text: t, at: date.toISOString() });
    }
    return { id: h[1], date, header: h[0].trim(), turns, note, missed: /MISSED CALL/.test(h[0] + body) };
  });
}
