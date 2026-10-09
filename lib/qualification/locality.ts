import { SERVICE_AREA } from "@/lib/knowledge/rules";

export type LocalityMatch =
  | { status: "served"; match: string; assumed: boolean }
  | { status: "excluded"; match: string }
  | { status: "unknown"; match: null };

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim();

function contains(haystack: string, needle: string): boolean {
  return ` ${haystack} `.includes(` ${norm(needle)} `);
}

/** Classify a free-text location against services.md. Excluded places win over generic "near Pune". */
export function matchLocality(text: string | null | undefined): LocalityMatch {
  if (!text) return { status: "unknown", match: null };
  const t = norm(text);
  for (const x of SERVICE_AREA.excluded.value) if (contains(t, x)) return { status: "excluded", match: x };
  for (const x of SERVICE_AREA.served.value) if (contains(t, x)) return { status: "served", match: x, assumed: false };
  for (const x of SERVICE_AREA.servedAssumed.value) if (contains(t, x)) return { status: "served", match: x, assumed: true };
  // "near Pune" / "outside Pune" is not a confirmation of being inside the area.
  if (/\b(near|outside|around|beyond)\s+(pune|pcmc)\b/.test(t)) return { status: "unknown", match: null };
  for (const x of SERVICE_AREA.cityAliases.value) if (contains(t, x)) return { status: "served", match: x, assumed: true };
  return { status: "unknown", match: null };
}
