/**
 * Lists your Calendly event types so you can copy the consultation one's URI into
 * CALENDLY_EVENT_TYPE_URI. Reads CALENDLY_TOKEN from .env.local; prints no secrets.
 *
 *   npm run calendly:event-types
 */
import { existsSync } from "node:fs";

if (existsSync(".env.local")) process.loadEnvFile(".env.local");
const token = process.env.CALENDLY_TOKEN?.trim();
if (!token) {
  console.error("Add CALENDLY_TOKEN to .env.local first (Calendly > Integrations & apps > API and webhooks).");
  process.exit(1);
}
const get = async (path: string) => {
  const r = await fetch(`https://api.calendly.com${path}`, { headers: { authorization: `Bearer ${token}` } });
  const j = await r.json();
  if (!r.ok) throw new Error(`Calendly ${r.status}: ${j.title ?? ""} ${j.message ?? ""}`);
  return j;
};

const me = await get("/users/me");
const user = me.resource.uri as string;
console.log(`Calendly user: ${me.resource.name} (${me.resource.current_organization ? "organization account" : "personal"})`);
const types = await get(`/event_types?user=${encodeURIComponent(user)}&active=true&count=100`);
if (!types.collection.length) console.log("No active event types. Create one (e.g. 'Aangan design consultation', 60 min) in Calendly first.");
for (const t of types.collection) {
  const loc = (t.locations ?? []).map((l: { kind: string }) => l.kind).join(", ") || "no location";
  console.log(`\n${t.name} · ${t.duration} min · ${loc}\n  CALENDLY_EVENT_TYPE_URI=${t.uri}`);
}
