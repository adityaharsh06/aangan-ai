/**
 * Vaani Labs (VaaniVoice) adapter, from the published OpenAPI spec
 * (https://www.vaanilabs.in/openapi/v1/vaanivoice.yaml):
 *
 *  - Vaani's own agent ("flow", configured in the Vaani dashboard) holds the live conversation.
 *  - When a call ends, Vaani POSTs a signed event to our webhook:
 *      X-VaaniVoice-Signature: sha256=<hex HMAC-SHA256 of the raw body, keyed with the vv_whk_ secret>
 *      X-VaaniVoice-Event:     call.completed | call.failed | lead.created | webhook.ping | …
 *      body: { id: "evt_…", type, created, data }   (id is reused across retries)
 *  - The spec says `data` is event-specific and "no sub-field is guaranteed", and phone numbers
 *    are masked. So the parser below looks for the transcript under several plausible names and
 *    the raw event is kept in the audit trail; tighten the mapping once a real event is seen.
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import type { Turn } from "@/lib/agent/types";

export function vaaniConfigured(): boolean {
  return Boolean(process.env.VAANI_WEBHOOK_SECRET?.trim());
}

export function verifyVaaniSignature(rawBody: string, header: string | null, secret = process.env.VAANI_WEBHOOK_SECRET?.trim() ?? ""): boolean {
  if (!secret || !header || !/^sha256=[0-9a-f]{64}$/.test(header)) return false;
  const expected = `sha256=${createHmac("sha256", secret).update(rawBody, "utf8").digest("hex")}`;
  const a = Buffer.from(header);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export interface VaaniEnvelope {
  id: string;
  type: string;
  created: number;
  data: Record<string, unknown>;
}

export function parseEnvelope(raw: unknown): VaaniEnvelope {
  const e = raw as Partial<VaaniEnvelope>;
  if (!e || typeof e.id !== "string" || typeof e.type !== "string") throw new Error("not a VaaniVoice event envelope");
  return { id: e.id, type: e.type, created: typeof e.created === "number" ? e.created : Math.floor(Date.now() / 1000), data: e.data && typeof e.data === "object" ? (e.data as Record<string, unknown>) : {} };
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
      const m = line.match(/^\s*([A-Za-z_ ]{2,20}):\s*(.+)$/);
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
  const startedAt = toDate(pick(src, ["started_at", "start_time", "startedAt", "created_at"]), created);
  const endedAt = toDate(pick(src, ["ended_at", "end_time", "endedAt"]), created);
  const dur = pick(src, ["duration_seconds", "duration_sec", "billable_seconds", "duration"]);
  const transcriptRaw = pick(src, ["transcript", "messages", "turns", "conversation", "transcript_text", "history"]);
  const from = pick(src, ["caller_number", "from", "phone", "phone_number", "caller", "customer_number"]);
  return {
    callId: String(pick(src, ["call_id", "session_id", "usage_id", "id"]) ?? env.id),
    turns: parseTranscript(transcriptRaw, startedAt),
    startedAt,
    endedAt: endedAt < startedAt ? startedAt : endedAt,
    durationSec: typeof dur === "number" ? dur : typeof dur === "string" && /^\d+(\.\d+)?$/.test(dur) ? Number(dur) : null,
    from: typeof from === "string" ? from : null,
  };
}
