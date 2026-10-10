/**
 * Vaani adapter. Vaani's own agent (configured in the Vaani dashboard) holds the live conversation;
 * when a call ends, Vaani POSTs an event to our webhook. Two documented formats are accepted:
 *
 *  1. Dashboard agent webhooks (app.vaanivoice.ai → Developers → Webhooks), per
 *     https://docs.vaanivoice.ai/guides/webhook-setup.md and .../campaigns/webhooks.md:
 *      X-Vaani-Signature: sha256=<hex HMAC-SHA256 of "<X-Vaani-Timestamp>.<raw body>", keyed with the secret>
 *      body: { event: "call_postprocessing", call_id, timestamp, data: { transcript, summary, call_duration (ms), … } }
 *     There is no event id, so `<event>:<call_id>` is used for idempotency.
 *  2. The VaaniVoice public API spec (https://www.vaanilabs.in/openapi/v1/vaanivoice.yaml):
 *      X-VaaniVoice-Signature: sha256=<hex HMAC-SHA256 of the raw body>
 *      body: { id: "evt_…", type: "call.completed" | "lead.created" | …, created, data }
 *
 * Neither doc guarantees every `data` field, so the parser looks under several plausible names and
 * the raw event is kept in the audit trail for tightening the mapping once a real event is seen.
 */
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import type { Turn } from "@/lib/agent/types";

export function vaaniConfigured(): boolean {
  return Boolean(process.env.VAANI_WEBHOOK_SECRET?.trim());
}

/** Events that carry a finished call's transcript. */
export const VAANI_CALL_EVENTS = new Set(["call_postprocessing", "call.completed", "lead.created"]);

const hmacHex = (secret: string, payload: string) => createHmac("sha256", secret).update(payload, "utf8").digest("hex");

function sigMatches(header: string, expectedHex: string): boolean {
  const got = header.trim().toLowerCase().replace(/^sha256=/, "");
  if (!/^[0-9a-f]{64}$/.test(got)) return false;
  return timingSafeEqual(Buffer.from(got), Buffer.from(expectedHex));
}

/** Public API spec format: `X-VaaniVoice-Signature` over the raw body. */
export function verifyVaaniSignature(rawBody: string, header: string | null, secret = process.env.VAANI_WEBHOOK_SECRET?.trim() ?? ""): boolean {
  if (!secret || !header || !/^sha256=[0-9a-f]{64}$/.test(header)) return false;
  return sigMatches(header, hmacHex(secret, rawBody));
}

export interface VaaniSignatureHeaders {
  /** X-Vaani-Signature (dashboard webhooks) */
  vaani?: string | null;
  /** X-Vaani-Timestamp (dashboard webhooks), unix seconds */
  timestamp?: string | null;
  /** X-VaaniVoice-Signature (public API spec) */
  vaanivoice?: string | null;
}

/** Accepts either documented signing scheme. Dashboard signatures older than 5 minutes are refused (replay). */
export function verifyVaaniRequest(rawBody: string, h: VaaniSignatureHeaders, secret = process.env.VAANI_WEBHOOK_SECRET?.trim() ?? "", nowSec = Date.now() / 1000): boolean {
  if (!secret) return false;
  if (h.vaani) {
    if (h.timestamp) {
      const ts = h.timestamp.trim();
      if (!/^\d{9,13}$/.test(ts)) return false;
      const sec = ts.length > 11 ? Number(ts) / 1000 : Number(ts);
      if (Math.abs(nowSec - sec) > 300) return false;
      return sigMatches(h.vaani, hmacHex(secret, `${ts}.${rawBody}`));
    }
    // No timestamp header: fall back to a signature over the body alone.
    return sigMatches(h.vaani, hmacHex(secret, rawBody));
  }
  return verifyVaaniSignature(rawBody, h.vaanivoice ?? null, secret);
}

export interface VaaniEnvelope {
  id: string;
  type: string;
  created: number;
  data: Record<string, unknown>;
}

export function parseEnvelope(raw: unknown, rawBody?: string): VaaniEnvelope {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("not a Vaani event envelope");
  const e = raw as Record<string, unknown>;
  const now = Math.floor(Date.now() / 1000);

  // Dashboard format: { event, call_id, timestamp, data: { … } }. Top-level fields are kept alongside data's.
  if (typeof e.event === "string" && e.event) {
    const inner = e.data && typeof e.data === "object" && !Array.isArray(e.data) ? (e.data as Record<string, unknown>) : {};
    const top = Object.fromEntries(Object.entries(e).filter(([k]) => k !== "data"));
    const data = { ...top, ...inner };
    const ref = pick(data, ["call_id", "room_name"]);
    const ts = typeof e.timestamp === "string" ? Date.parse(e.timestamp) : NaN;
    const fallbackRef = createHash("sha256").update(rawBody ?? JSON.stringify(raw)).digest("hex").slice(0, 32);
    return { id: `${e.event}:${ref !== undefined ? String(ref) : fallbackRef}`, type: e.event, created: Number.isNaN(ts) ? now : Math.floor(ts / 1000), data };
  }

  // Public API spec format: { id, type, created, data }.
  if (typeof e.id === "string" && typeof e.type === "string") {
    return { id: e.id, type: e.type, created: typeof e.created === "number" ? e.created : now, data: e.data && typeof e.data === "object" ? (e.data as Record<string, unknown>) : {} };
  }
  throw new Error("not a Vaani event envelope");
}

export interface VaaniCall {
  callId: string;
  turns: Turn[];
  startedAt: Date;
  endedAt: Date;
  durationSec: number | null;
  /** As sent by Vaani: masked per the spec, so only used when the caller gives no callback number. */
  from: string | null;
}

const pick = (o: Record<string, unknown>, keys: string[]): unknown => {
  for (const k of keys) if (o[k] !== undefined && o[k] !== null && o[k] !== "") return o[k];
  return undefined;
};
const AGENT = /^(agent|assistant|bot|ai|vaani|system_agent|model)$/i;
const CALLER = /^(user|caller|customer|human|client|lead|contact)$/i;

function toDate(v: unknown, fallback: Date): Date {
  if (typeof v === "number") return new Date(v < 1e12 ? v * 1000 : v);
  if (typeof v === "string" && !Number.isNaN(Date.parse(v))) return new Date(v);
  return fallback;
}

/** Transcript as text ("Agent: … / User: …") or as an array of messages with role + text. */
export function parseTranscript(raw: unknown, at: Date): Turn[] {
  const iso = at.toISOString();
  if (typeof raw === "string") {
    const turns: Turn[] = [];
    for (const line of raw.split(/\r?\n/)) {
      // Optional leading "[13:33:14] " time stamp (Vaani's call_postprocessing transcript).
      const m = line.match(/^\s*(?:\[[^\]]{1,20}\]\s*)?([A-Za-z_ ]{2,20}):\s*(.+)$/);
      if (!m) {
        if (turns.length && line.trim()) turns[turns.length - 1].text += ` ${line.trim()}`;
        continue;
      }
      const who = m[1].trim();
      const role = AGENT.test(who) ? "agent" : CALLER.test(who) ? "caller" : null;
      if (role) turns.push({ role, text: m[2].trim(), at: iso });
    }
    return turns;
  }
  if (Array.isArray(raw)) {
    return raw.flatMap((m): Turn[] => {
      if (!m || typeof m !== "object") return [];
      const o = m as Record<string, unknown>;
      const who = String(pick(o, ["role", "speaker", "from", "sender", "participant"]) ?? "");
      const text = pick(o, ["text", "message", "content", "transcript", "utterance"]);
      const role = AGENT.test(who) ? "agent" : CALLER.test(who) ? "caller" : null;
      if (!role || typeof text !== "string" || !text.trim()) return [];
      return [{ role, text: text.trim(), at: toDate(pick(o, ["timestamp", "time", "at", "created_at"]), at).toISOString() }];
    });
  }
  return [];
}

export function parseCall(env: VaaniEnvelope): VaaniCall {
  const d = env.data;
  const nested = (pick(d, ["call", "session", "conversation"]) as Record<string, unknown> | undefined) ?? {};
  const src = { ...nested, ...d };
  const created = new Date(env.created * 1000);
  const durRaw = pick(src, ["duration_seconds", "duration_sec", "billable_seconds", "duration", "call_duration"]);
  const durNum = typeof durRaw === "number" ? durRaw : typeof durRaw === "string" && /^\d+(\.\d+)?$/.test(durRaw) ? Number(durRaw) : null;
  // Vaani's docs: call_duration is in milliseconds on call_postprocessing (seconds on call_ended).
  const dur = durNum === null ? null : env.type === "call_postprocessing" && durRaw === src.call_duration ? Math.round(durNum / 1000) : Math.round(durNum);
  // call_postprocessing has no start time; it is sent once processing finishes, so start ≈ timestamp − duration.
  const startFallback = dur !== null && env.type === "call_postprocessing" ? new Date(created.getTime() - dur * 1000) : created;
  const startedAt = toDate(pick(src, ["started_at", "start_time", "startedAt", "created_at"]), startFallback);
  const endedAt = toDate(pick(src, ["ended_at", "end_time", "endedAt"]), created);
  const transcriptRaw = pick(src, ["transcript", "messages", "turns", "conversation", "transcript_text", "history"]);
  const from = pick(src, ["caller_number", "from", "phone", "phone_number", "caller", "customer_number"]);
  return {
    callId: String(pick(src, ["call_id", "session_id", "usage_id", "id"]) ?? env.id),
    turns: parseTranscript(transcriptRaw, startedAt),
    startedAt,
    endedAt: endedAt < startedAt ? startedAt : endedAt,
    durationSec: dur,
    from: typeof from === "string" ? from : null,
  };
}
