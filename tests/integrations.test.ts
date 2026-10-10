import { afterEach, describe, expect, it, vi } from "vitest";
import { createHmac } from "node:crypto";
import { matches, parsePreference, pickSlot } from "@/lib/scheduling/slot-match";
import { spokenEmail } from "@/lib/agent/heuristic";
import { callerTurn, startCall } from "@/lib/agent/conversation";
import { parseCall, parseEnvelope, parseTranscript, verifyVaaniRequest, verifyVaaniSignature } from "@/lib/providers/vaani";
import { calendlyScheduling } from "@/lib/providers/calendly";

// IST = UTC+5:30. 10 Oct 2026 is a Saturday.
const ist = (s: string) => new Date(`${s}+05:30`);

describe("slot matching (caller's words → open Calendly slot)", () => {
  it("reads day and part of day", () => {
    const p = parsePreference("Saturday morning works, at the flat if possible.");
    expect(matches(p, ist("2026-10-10T10:00:00"))).toBe(true);
    expect(matches(p, ist("2026-10-10T15:00:00"))).toBe(false);
    expect(matches(p, ist("2026-10-11T10:00:00"))).toBe(false);
  });

  it("'any weekday after 6pm' excludes weekends and daytime", () => {
    const p = parsePreference("Any weekday after 6pm.");
    expect(matches(p, ist("2026-10-12T18:30:00"))).toBe(true); // Monday
    expect(matches(p, ist("2026-10-12T11:00:00"))).toBe(false);
    expect(matches(p, ist("2026-10-10T18:30:00"))).toBe(false); // Saturday
  });

  it("'after 6' without am/pm means evening", () => {
    expect(parsePreference("weekdays after 6").fromHour).toBe(18);
  });

  it("an unreadable preference matches nothing (no guessing)", () => {
    const p = parsePreference("whenever my husband is free");
    expect(matches(p, ist("2026-10-12T11:00:00"))).toBe(false);
  });

  it("picks the earliest matching slot", () => {
    const slots = [ist("2026-10-17T09:00:00"), ist("2026-10-10T15:00:00"), ist("2026-10-10T11:00:00")];
    expect(pickSlot(["Saturday morning"], slots)?.toISOString()).toBe(ist("2026-10-10T11:00:00").toISOString());
    expect(pickSlot(["Sunday evening"], slots)).toBeNull();
  });
});

describe("email capture on the call", () => {
  it.each([
    ["priya dot joshi at example dot com", "priya.joshi@example.com"],
    ["It's rohan.kale@example.com", "rohan.kale@example.com"],
    ["anand underscore k at gmail dot com", "anand_k@gmail.com"],
    ["I'd rather not", null],
  ])("%s → %s", (said, want) => expect(spokenEmail(said)).toBe(want));

  it("asks qualified callers for an email only when booking is enabled, and promises no specific time", async () => {
    const at = ist("2026-10-09T11:00:00");
    const answers: Record<string, string> = {
      ask_timeline: "By March.",
      ask_current_state: "Builder flat.",
      ask_decision_maker: "Yes.",
      ask_slot: "Saturday morning.",
      ask_email: "priya dot joshi at example dot com",
    };
    let { session } = startCall(at);
    let text = "I'm Priya. 3BHK in Kothrud, 1400 sq ft, full home redesign with kitchen and bedrooms.";
    const replies: string[] = [];
    for (let i = 0; i < 12; i++) {
      const out = await callerTurn(session, text, at, at, { collectEmail: true });
      session = out.session;
      replies.push(out.reply);
      if (out.endCall) break;
      text = answers[out.action] ?? "No, that's all.";
    }
    expect(session.facts.email).toBe("priya.joshi@example.com");
    expect(replies.join(" ")).toMatch(/calendar invite by email/);
    expect(replies.join(" ")).not.toMatch(/\d{1,2}(:\d\d)?\s?(am|pm) on/i);
  });
});

describe("Vaani webhook", () => {
  const secret = "vv_whk_test";
  const body = JSON.stringify({ id: "evt_1", type: "call.completed", created: 1791500000, data: { call_id: "c1", transcript: "Agent: Hello\nUser: I have a 2BHK in Baner" } });
  const sig = `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;

  it("accepts the documented HMAC-SHA256 signature and rejects anything else", () => {
    expect(verifyVaaniSignature(body, sig, secret)).toBe(true);
    expect(verifyVaaniSignature(body + " ", sig, secret)).toBe(false);
    expect(verifyVaaniSignature(body, "sha256=" + "0".repeat(64), secret)).toBe(false);
    expect(verifyVaaniSignature(body, null, secret)).toBe(false);
    expect(verifyVaaniSignature(body, sig, "")).toBe(false);
  });

  it("parses a text transcript and the call id", () => {
    const call = parseCall(parseEnvelope(JSON.parse(body)));
    expect(call.callId).toBe("c1");
    expect(call.turns.map((t) => t.role)).toEqual(["agent", "caller"]);
    expect(call.turns[1].text).toMatch(/2BHK in Baner/);
  });

  it("parses an array transcript with assorted field names", () => {
    const turns = parseTranscript(
      [
        { speaker: "assistant", message: "Hi, Aangan Studio" },
        { role: "customer", content: "Need my office done" },
        { role: "system", text: "ignored" },
      ],
      new Date(),
    );
    expect(turns).toHaveLength(2);
    expect(turns[1]).toMatchObject({ role: "caller", text: "Need my office done" });
  });

  it("rejects a body that isn't an event envelope", () => {
    expect(() => parseEnvelope({ hello: 1 })).toThrow();
  });
});

describe("Vaani dashboard webhook (call_postprocessing)", () => {
  const secret = "vv_whk_test";
  // Shape from docs.vaanivoice.ai/guides/webhook-setup.md
  const payload = {
    event: "call_postprocessing",
    call_id: "inbound-1791640000-abc",
    timestamp: "2026-10-10T14:00:55.000000+00:00",
    data: {
      room_name: "inbound-1791640000-abc",
      call_id: "inbound-1791640000-abc",
      call_duration: 55150.02,
      end_reason: "Call ended",
      summary: "Caller wants a 3BHK in Baner done.",
      transcript: "[13:59:59] AGENT: Hello, Aangan Studio. This is Kalyani.\n\n[14:00:05] USER: I have a 3BHK in Baner, need full design and execution.\n\n[14:00:20] AGENT: When would you need the project complete?",
    },
  };
  const body = JSON.stringify(payload);
  const ts = "1791640855";
  const now = 1791640860;
  const sig = `sha256=${createHmac("sha256", secret).update(`${ts}.${body}`).digest("hex")}`;

  it("verifies X-Vaani-Signature over timestamp.body and refuses stale or wrong ones", () => {
    expect(verifyVaaniRequest(body, { vaani: sig, timestamp: ts }, secret, now)).toBe(true);
    expect(verifyVaaniRequest(body, { vaani: sig, timestamp: ts }, secret, now + 301)).toBe(false);
    expect(verifyVaaniRequest(body + " ", { vaani: sig, timestamp: ts }, secret, now)).toBe(false);
    expect(verifyVaaniRequest(body, { vaani: sig, timestamp: "1791640856" }, secret, now)).toBe(false);
    expect(verifyVaaniRequest(body, {}, secret, now)).toBe(false);
    expect(verifyVaaniRequest(body, { vaani: sig, timestamp: ts }, "", now)).toBe(false);
  });

  it("still accepts the public-API X-VaaniVoice-Signature", () => {
    const b = JSON.stringify({ id: "evt_1", type: "call.completed", created: 1, data: {} });
    expect(verifyVaaniRequest(b, { vaanivoice: `sha256=${createHmac("sha256", secret).update(b).digest("hex")}` }, secret)).toBe(true);
  });

  it("parses the envelope, timestamped transcript and millisecond duration", () => {
    const env = parseEnvelope(payload, body);
    expect(env).toMatchObject({ id: "call_postprocessing:inbound-1791640000-abc", type: "call_postprocessing" });
    const call = parseCall(env);
    expect(call.callId).toBe("inbound-1791640000-abc");
    expect(call.durationSec).toBe(55);
    expect(call.endedAt.toISOString()).toBe("2026-10-10T14:00:55.000Z");
    expect(call.startedAt.toISOString()).toBe("2026-10-10T14:00:00.000Z");
    expect(call.turns.map((t) => t.role)).toEqual(["agent", "caller", "agent"]);
    expect(call.turns[1].text).toBe("I have a 3BHK in Baner, need full design and execution.");
  });

  it("gives other lifecycle events a stable id so retries de-duplicate", () => {
    const e = { event: "call_ended", room_name: "room_1", call_duration: 42.5 };
    expect(parseEnvelope(e).id).toBe("call_ended:room_1");
    expect(parseEnvelope(e).id).toBe(parseEnvelope({ ...e }).id);
  });
});

describe("Calendly booking", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  function stubCalendly(handler: (url: string, init: RequestInit) => { status: number; body: unknown }) {
    vi.stubEnv("CALENDLY_TOKEN", "test-token");
    vi.stubEnv("CALENDLY_EVENT_TYPE_URI", "https://api.calendly.com/event_types/ET1");
    const calls: { url: string; body: unknown }[] = [];
    vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
      calls.push({ url, body: init.body ? JSON.parse(String(init.body)) : undefined });
      const r = handler(url, init);
      return new Response(JSON.stringify(r.body), { status: r.status, headers: { "content-type": "application/json" } });
    });
    return calls;
  }

  const req = { enquiryId: "e1", phone: "+919822010001", name: "Priya Joshi", email: "priya.joshi@example.com", slots: ["Saturday morning"], siteVisit: true, site: "Kothrud" };

  it("books the earliest open slot matching the caller's words", async () => {
    const sat = new Date(Date.now() + 3 * 86_400_000);
    // Find a Saturday 10:30 IST in the next two weeks.
    const slot = Array.from({ length: 14 }, (_, i) => new Date(Date.UTC(sat.getUTCFullYear(), sat.getUTCMonth(), sat.getUTCDate() + i, 5, 0))).find((d) => d.getUTCDay() === 6)!;
    const calls = stubCalendly((url) => {
      if (url.includes("/event_type_available_times")) return { status: 200, body: { collection: [{ status: "available", start_time: slot.toISOString(), invitees_remaining: 1, scheduling_url: "x" }] } };
      if (url.includes("/event_types/ET1")) return { status: 200, body: { resource: { locations: [{ kind: "ask_invitee" }] } } };
      if (url.endsWith("/invitees")) return { status: 201, body: { resource: { uri: "https://api.calendly.com/invitees/I1", reschedule_url: "https://calendly.com/r/1" } } };
      return { status: 404, body: {} };
    });
    const r = await calendlyScheduling.book(req);
    expect(r).toMatchObject({ ok: true, outcome: "booked", startTime: slot.toISOString(), externalId: "https://api.calendly.com/invitees/I1" });
    const booking = calls.find((c) => c.url.endsWith("/invitees"))!.body as Record<string, unknown>;
    expect(booking).toMatchObject({ event_type: "https://api.calendly.com/event_types/ET1", start_time: slot.toISOString(), invitee: { email: "priya.joshi@example.com", timezone: "Asia/Kolkata", first_name: "Priya", last_name: "Joshi" }, location: { kind: "ask_invitee", location: "Site visit: Kothrud" } });
  });

  it("sends a one-time booking link when no slot matches (never books a time the caller didn't ask for)", async () => {
    const calls = stubCalendly((url) => {
      if (url.includes("/event_type_available_times")) return { status: 200, body: { collection: [] } };
      if (url.endsWith("/scheduling_links")) return { status: 201, body: { resource: { booking_url: "https://calendly.com/d/abc" } } };
      return { status: 404, body: {} };
    });
    const r = await calendlyScheduling.book(req);
    expect(r).toMatchObject({ ok: true, outcome: "link", bookingUrl: "https://calendly.com/d/abc" });
    expect(calls.some((c) => c.url.endsWith("/invitees"))).toBe(false);
    expect(calls.find((c) => c.url.endsWith("/scheduling_links"))!.body).toEqual({ max_event_count: 1, owner: "https://api.calendly.com/event_types/ET1", owner_type: "EventType" });
  });

  it("falls back to a link on a Free plan (403 from the Scheduling API)", async () => {
    const sat = Array.from({ length: 14 }, (_, i) => new Date(Date.now() + (i + 1) * 86_400_000)).find((d) => d.getUTCDay() === 6)!;
    sat.setUTCHours(5, 0, 0, 0);
    stubCalendly((url) => {
      if (url.includes("/event_type_available_times")) return { status: 200, body: { collection: [{ status: "available", start_time: sat.toISOString() }] } };
      if (url.includes("/event_types/ET1")) return { status: 200, body: { resource: { locations: null } } };
      if (url.endsWith("/invitees")) return { status: 403, body: { title: "Permission Denied", message: "paid plan required" } };
      if (url.endsWith("/scheduling_links")) return { status: 201, body: { resource: { booking_url: "https://calendly.com/d/xyz" } } };
      return { status: 404, body: {} };
    });
    const r = await calendlyScheduling.book(req);
    expect(r).toMatchObject({ ok: true, outcome: "link", bookingUrl: "https://calendly.com/d/xyz" });
    expect(r.reason).toMatch(/403/);
  });

  it("without an email, goes straight to a link", async () => {
    stubCalendly((url) => (url.endsWith("/scheduling_links") ? { status: 201, body: { resource: { booking_url: "https://calendly.com/d/n" } } } : { status: 500, body: {} }));
    const r = await calendlyScheduling.book({ ...req, email: null });
    expect(r).toMatchObject({ outcome: "link" });
  });

  it("reports not configured without a token", async () => {
    const r = await calendlyScheduling.book(req);
    expect(r).toMatchObject({ ok: false, notConfigured: true });
  });
});

describe("Vaani flow prompt stays in step with the rules", () => {
  it("quotes the pricing, decline and timeline scripts word for word", async () => {
    const { readFileSync } = await import("node:fs");
    const { SCRIPTS } = await import("@/lib/knowledge/rules");
    const doc = readFileSync("vaani/FLOW_PROMPT.md", "utf8");
    for (const s of [SCRIPTS.pricing.value, SCRIPTS.decline.value, SCRIPTS.timelineQuestion.value]) expect(doc).toContain(s);
  });
});
