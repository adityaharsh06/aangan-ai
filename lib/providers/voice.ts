/**
 * Voice provider abstraction. The core pipeline only ever sees `VoiceEvent`s and returns a
 * `VoiceReply`; each telephony vendor (Vaani Labs in a later phase) gets an adapter that maps
 * its webhook format to these types. No vendor API details are assumed here.
 */
import { timingSafeEqual } from "node:crypto";

export type VoiceEvent =
  | { type: "call.started"; eventId: string; callId: string; from: string; at: string }
  | { type: "caller.utterance"; eventId: string; callId: string; text: string; at: string }
  | { type: "call.ended"; eventId: string; callId: string; at: string; reason: "hangup" | "dropped" | "agent_ended" | "error" }
  | { type: "call.missed"; eventId: string; callId: string; from: string; at: string };

export interface VoiceReply {
  /** Text for the provider's TTS to speak. null = say nothing. */
  say: string | null;
  endCall: boolean;
}

export interface VoiceProvider {
  readonly name: string;
  /** Authenticate the inbound webhook. */
  verify(headers: Headers, rawBody: string): boolean;
  /** Map the vendor payload to a normalised event. Throws on malformed input. */
  parse(body: unknown): VoiceEvent;
  /** Map our reply to the vendor's expected response body. */
  render(reply: VoiceReply): unknown;
}

function safeEqual(a: string, b: string) {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/**
 * Mock / generic JSON provider: used by the in-app call simulator and by tests, and a usable
 * contract for any provider that can POST our normalised JSON. Auth: shared secret header.
 */
export const mockVoiceProvider: VoiceProvider = {
  name: "mock",
  verify(headers) {
    const expected = process.env.VOICE_WEBHOOK_SECRET?.trim();
    const got = headers.get("x-aangan-webhook-secret") ?? "";
    return Boolean(expected) && safeEqual(got, expected!);
  },
  parse(body) {
    const b = body as Partial<VoiceEvent> & Record<string, unknown>;
    const str = (k: string) => {
      const v = b[k];
      if (typeof v !== "string" || !v.trim()) throw new Error(`missing ${k}`);
      return v.trim();
    };
    const base = { eventId: str("eventId"), callId: str("callId"), at: typeof b.at === "string" ? b.at : new Date().toISOString() };
    switch (b.type) {
      case "call.started":
        return { type: "call.started", ...base, from: str("from") };
      case "call.missed":
        return { type: "call.missed", ...base, from: str("from") };
      case "caller.utterance":
        return { type: "caller.utterance", ...base, text: str("text").slice(0, 2000) };
      case "call.ended": {
        const r = b.reason;
        return { type: "call.ended", ...base, reason: r === "dropped" || r === "agent_ended" || r === "error" ? r : "hangup" };
      }
      default:
        throw new Error("unknown event type");
    }
  },
  render(reply) {
    return reply;
  },
};

const PROVIDERS: Record<string, VoiceProvider> = { mock: mockVoiceProvider };

export function getVoiceProvider(name: string): VoiceProvider | null {
  return PROVIDERS[name] ?? null;
}

/** Normalise an Indian phone number for duplicate detection. */
export function normalisePhone(raw: string): string {
  const digits = raw.replace(/[^\d+]/g, "");
  if (/^\+\d{8,15}$/.test(digits)) return digits;
  const d = digits.replace(/\D/g, "");
  if (d.length === 10) return `+91${d}`;
  if (d.length === 12 && d.startsWith("91")) return `+${d}`;
  if (d.length === 11 && d.startsWith("0")) return `+91${d.slice(1)}`;
  return d ? `+${d}` : "unknown";
}
