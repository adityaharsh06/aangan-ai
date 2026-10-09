/**
 * Matches a caller's spoken preference ("Saturday morning", "any weekday after 6pm") to an open
 * calendar slot. Deterministic and conservative: if the preference can't be read, nothing matches
 * and the caller gets a booking link instead of a time they never agreed to.
 */
const TZ = "Asia/Kolkata";
const DAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];

export interface SlotPreference {
  days: Set<number> | null; // 0 = Sunday; null = any day
  fromHour: number; // inclusive, IST
  toHour: number; // exclusive, IST
  understood: boolean;
}

export function parsePreference(text: string): SlotPreference {
  const t = text.toLowerCase();
  let days: Set<number> | null = null;
  let understood = false;
  const add = (d: number) => {
    days ??= new Set();
    days.add(d);
    understood = true;
  };
  DAYS.forEach((d, i) => {
    if (new RegExp(`\\b${d.slice(0, 3)}(${d.slice(3)})?s?\\b`).test(t)) add(i);
  });
  if (/\bweekends?\b/.test(t)) [0, 6].forEach(add);
  if (/\bweekdays?\b/.test(t)) [1, 2, 3, 4, 5].forEach(add);
  if (/\bany ?(day|time)\b|\banytime\b|\bflexible\b/.test(t)) understood = true;

  let fromHour = 0;
  let toHour = 24;
  if (/\bmorning\b/.test(t)) [fromHour, toHour, understood] = [8, 12, true];
  else if (/\bafternoon\b/.test(t)) [fromHour, toHour, understood] = [12, 17, true];
  else if (/\bevening\b/.test(t)) [fromHour, toHour, understood] = [17, 21, true];
  const after = t.match(/\bafter (\d{1,2})(?::\d{2})?\s*(am|pm)?/);
  if (after) {
    fromHour = to24(Number(after[1]), after[2]);
    toHour = Math.max(toHour, fromHour + 1);
    understood = true;
  }
  const before = t.match(/\bbefore (\d{1,2})(?::\d{2})?\s*(am|pm)?/);
  if (before) {
    toHour = to24(Number(before[1]), before[2]);
    understood = true;
  }
  return { days, fromHour, toHour, understood };
}

function to24(h: number, ampm?: string): number {
  if (ampm === "pm" && h < 12) return h + 12;
  if (ampm === "am" && h === 12) return 0;
  // "after 6" on a consultation means the evening, not 6am.
  if (!ampm && h >= 1 && h <= 7) return h + 12;
  return h;
}

function istParts(d: Date) {
  const p = new Intl.DateTimeFormat("en-GB", { timeZone: TZ, weekday: "long", hour: "numeric", hour12: false }).formatToParts(d);
  const weekday = DAYS.indexOf(p.find((x) => x.type === "weekday")!.value.toLowerCase());
  const hour = Number(p.find((x) => x.type === "hour")!.value) % 24;
  return { weekday, hour };
}

export function matches(pref: SlotPreference, start: Date): boolean {
  if (!pref.understood) return false;
  const { weekday, hour } = istParts(start);
  if (pref.days && !pref.days.has(weekday)) return false;
  return hour >= pref.fromHour && hour < pref.toHour;
}

/** Earliest slot matching any of the caller's stated preferences (latest stated first). */
export function pickSlot(preferences: string[], slots: Date[]): Date | null {
  const sorted = [...slots].sort((a, b) => a.getTime() - b.getTime());
  for (const text of [...preferences].reverse()) {
    const pref = parsePreference(text);
    const hit = sorted.find((s) => matches(pref, s));
    if (hit) return hit;
  }
  return null;
}

export function formatIst(d: Date): string {
  return new Intl.DateTimeFormat("en-IN", { timeZone: TZ, weekday: "short", day: "numeric", month: "short", hour: "numeric", minute: "2-digit" }).format(d);
}
