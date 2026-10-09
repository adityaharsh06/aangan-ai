/**
 * Calendly adapter (API v2, developer.calendly.com). After a qualified call:
 *  1. read open times for the consultation event type (GET /event_type_available_times),
 *  2. pick the earliest slot that matches what the caller asked for,
 *  3. book it (POST /invitees, the Scheduling API, paid Calendly plans only).
 * If the caller gave no email, nothing matches, or booking is refused, it creates a single-use
 * booking link (POST /scheduling_links) for the designer to send instead. It never books a time
 * the caller didn't ask for.
 */
import { optionalEnv } from "@/lib/env";
import { formatIst, pickSlot } from "@/lib/scheduling/slot-match";
import type { BookingRequest, BookingResult, SchedulingProvider } from "./integrations";

const API = "https://api.calendly.com";
const LOOKAHEAD_DAYS = 14;

export function calendlyConfigured(): boolean {
  return Boolean(process.env.CALENDLY_TOKEN?.trim() && process.env.CALENDLY_EVENT_TYPE_URI?.trim());
}

class CalendlyError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

async function call<T>(method: "GET" | "POST", path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: { authorization: `Bearer ${process.env.CALENDLY_TOKEN!.trim()}`, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    cache: "no-store",
    signal: AbortSignal.timeout(15_000),
  });
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) {
    const detail = [json.title, json.message].filter(Boolean).join(": ") || `HTTP ${res.status}`;
    throw new CalendlyError(res.status, `Calendly ${res.status}: ${detail}`);
  }
  return json as T;
}

type LocationConfig = { kind: string; location?: string; phone_number?: string };

/** Build the invitee location the event type expects (Calendly requires it to match). */
function inviteeLocation(cfg: LocationConfig | undefined, req: BookingRequest): Record<string, string> | undefined {
  if (!cfg) return undefined;
  switch (cfg.kind) {
    case "physical":
    case "custom":
      return { kind: cfg.kind, location: cfg.location ?? "" };
    case "ask_invitee":
      return { kind: cfg.kind, location: req.siteVisit && req.site ? `Site visit: ${req.site}` : req.site ?? "Aangan Studio" };
    case "outbound_call":
      return { kind: cfg.kind, location: req.phone };
    case "inbound_call":
      return { kind: cfg.kind, location: cfg.phone_number ?? "" };
    default:
      return { kind: cfg.kind };
  }
}

async function bookingLink(eventType: string, reason: string): Promise<BookingResult> {
  const r = await call<{ resource: { booking_url: string } }>("POST", "/scheduling_links", { max_event_count: 1, owner: eventType, owner_type: "EventType" });
  return { ok: true, outcome: "link", bookingUrl: r.resource.booking_url, reason, externalId: r.resource.booking_url };
}

export const calendlyScheduling: SchedulingProvider = {
  name: "calendly",
  async book(req) {
    if (!calendlyConfigured()) return { ok: false, notConfigured: true, error: "Calendly not configured (CALENDLY_TOKEN / CALENDLY_EVENT_TYPE_URI)" };
    const eventType = process.env.CALENDLY_EVENT_TYPE_URI!.trim();
    try {
      if (!req.email) return await bookingLink(eventType, "Caller gave no email, which Calendly needs to send the invite.");

      const start = new Date(Date.now() + 60 * 60_000);
      const end = new Date(start.getTime() + LOOKAHEAD_DAYS * 86_400_000);
      const q = new URLSearchParams({ event_type: eventType, start_time: start.toISOString(), end_time: end.toISOString() });
      const avail = await call<{ collection: { start_time: string; status: string }[] }>("GET", `/event_type_available_times?${q}`);
      const open = avail.collection.filter((s) => s.status === "available").map((s) => new Date(s.start_time));
      const slot = pickSlot(req.slots, open);
      if (!slot) return await bookingLink(eventType, `No open slot in the next ${LOOKAHEAD_DAYS} days matches "${req.slots.join("; ") || "no preference"}".`);

      const et = await call<{ resource: { locations: LocationConfig[] | null } }>("GET", `/event_types/${encodeURIComponent(eventType.split("/").pop()!)}`);
      const location = inviteeLocation(et.resource.locations?.[0], req);
      const [first, ...rest] = (req.name ?? "Aangan caller").trim().split(/\s+/);
      const invitee = await call<{ resource: { uri: string; cancel_url?: string; reschedule_url?: string } }>("POST", "/invitees", {
        event_type: eventType,
        start_time: slot.toISOString(),
        invitee: { name: req.name ?? first, first_name: first, ...(rest.length ? { last_name: rest.join(" ") } : {}), email: req.email, timezone: optionalEnv("CALENDLY_INVITEE_TIMEZONE", "Asia/Kolkata") },
        ...(location ? { location } : {}),
      });
      return {
        ok: true,
        outcome: "booked",
        startTime: slot.toISOString(),
        startLabel: formatIst(slot),
        cancelUrl: invitee.resource.cancel_url,
        rescheduleUrl: invitee.resource.reschedule_url,
        externalId: invitee.resource.uri,
      };
    } catch (e) {
      const err = e as CalendlyError;
      // Booking refused (e.g. Free plan → 403, slot just taken → 400): fall back to a link rather than lose the booking.
      if (err.status === 400 || err.status === 403 || err.status === 409) {
        try {
          return await bookingLink(eventType, `Direct booking failed (${err.message}).`);
        } catch (e2) {
          return { ok: false, error: (e2 as Error).message, retryable: false };
        }
      }
      return { ok: false, error: err.message, retryable: true };
    }
  },
};
