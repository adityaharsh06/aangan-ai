"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { CheckCircle2, CircleHelp, Loader2, PhoneCall, PhoneOff, Send, Unplug, Wand2, XCircle } from "lucide-react";
import type { CallSession } from "@/lib/agent/conversation";
import type { CriterionResult } from "@/lib/qualification/engine";
import { SCENARIOS, scenarioStart, scriptedAnswer, type Scenario } from "@/lib/scenarios";
import { Badge, Card, HandoffBadge, StatusBadge, cn, fmtSecs } from "./ui";

type Enquiry = {
  id: string;
  status: string;
  criteria: CriterionResult[] | null;
  handoff_status: string;
  within_sla: boolean | null;
  response_seconds: number | null;
  after_hours: boolean;
  extraction_mode: string | null;
};

type ApiState = {
  callId: string;
  reply: { say: string | null; endCall: boolean };
  enquiry: Enquiry | null;
  session: CallSession | null;
  callStatus?: string;
};

const FACT_LABELS: [keyof CallSession["facts"], string][] = [
  ["call_type", "Call type"],
  ["caller_name", "Name"],
  ["location_text", "Site"],
  ["property_kind", "Property"],
  ["bhk", "BHK"],
  ["carpet_area_sqft", "Carpet sq ft"],
  ["scope_type", "Scope"],
  ["scope_rooms", "Rooms"],
  ["current_state", "Current state"],
  ["wants_execution", "Wants execution"],
  ["timeline_text", "Timeline"],
  ["weeks_until_needed", "Weeks until needed"],
  ["budget_volunteered", "Budget volunteered"],
  ["decision_maker", "Decision-maker"],
  ["pricing_asked", "Asked about price"],
  ["referral_source", "Found us via"],
  ["preferred_slots", "Preferred slots"],
];

function show(v: unknown): string | null {
  if (v === null || v === undefined || v === "unknown" || v === false) return null;
  if (Array.isArray(v)) return v.length ? v.join(", ") : null;
  if (v === true) return "yes";
  return String(v).replace(/_/g, " ");
}

/** "2026-10-09T23:10" (IST wall clock) → ISO. */
const istToIso = (local: string) => new Date(`${local}:00+05:30`).toISOString();

export function Simulator() {
  const [from, setFrom] = useState("+91 98220 00000");
  const [simTime, setSimTime] = useState("");
  const [scenario, setScenario] = useState<Scenario | null>(null);
  const [state, setState] = useState<ApiState | null>(null);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const endRef = useRef<HTMLDivElement>(null);

  const active = state?.callStatus === "in_progress";
  const turns = state?.session?.turns ?? [];
  const lastAction = state?.session?.dialogue.lastAction ?? null;

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }, [turns.length]);

  async function call(body: Record<string, unknown>) {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/simulator", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error ?? `Request failed (${res.status})`);
      setState(json as ApiState);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  function pick(id: string) {
    const s = SCENARIOS.find((x) => x.id === id) ?? null;
    setScenario(s);
    if (s) {
      setFrom(s.from);
      const iso = scenarioStart(s);
      setSimTime(iso ? new Date(new Date(iso).getTime() + 5.5 * 3600_000).toISOString().slice(0, 16) : "");
    }
  }

  const start = () => call({ action: "start", from, ...(simTime ? { at: istToIso(simTime) } : {}) });
  function say(t: string) {
    if (!state || !t.trim()) return;
    setText("");
    void call({ action: "say", callId: state.callId, text: t });
  }
  const end = (reason: "hangup" | "dropped") => state && call({ action: "end", callId: state.callId, reason });

  const criteria = state?.enquiry?.criteria ?? [];
  const facts = state?.session?.facts;

  return (
    <div className="grid gap-6 lg:grid-cols-[1.4fr_1fr]">
      <div className="space-y-4">
        <Card title="Incoming call" subtitle="You play the caller. Events run through the same pipeline a telephony provider would use.">
          <div className="grid gap-3 sm:grid-cols-3">
            <label className="text-xs text-ink-3">
              Scripted caller
              <select disabled={active || busy} value={scenario?.id ?? ""} onChange={(e) => pick(e.target.value)} className="mt-1 h-9 w-full rounded-lg border border-line bg-surface px-2 text-sm text-ink">
                <option value="">None: I&apos;ll type</option>
                {SCENARIOS.map((s) => (
                  <option key={s.id} value={s.id}>{s.label}</option>
                ))}
              </select>
            </label>
            <label className="text-xs text-ink-3">
              Caller number
              <input disabled={active || busy} value={from} onChange={(e) => setFrom(e.target.value)} className="mt-1 h-9 w-full rounded-lg border border-line bg-surface px-2 text-sm text-ink" />
            </label>
            <label className="text-xs text-ink-3">
              Call time, IST (blank = now)
              <input type="datetime-local" disabled={active || busy} value={simTime} onChange={(e) => setSimTime(e.target.value)} className="mt-1 h-9 w-full rounded-lg border border-line bg-surface px-2 text-sm text-ink" />
            </label>
          </div>
          {scenario && (
            <p className="mt-3 text-xs text-ink-3">
              Based on {scenario.basedOn}. Expected outcome under our rules: <b className="text-ink-2">{scenario.expect.replace("_", " ")}</b>.
            </p>
          )}
          <div className="mt-4 flex flex-wrap gap-2">
            <button onClick={start} disabled={active || busy || from.trim().length < 6} className="flex items-center gap-1.5 rounded-lg bg-sage px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50">
              <PhoneCall className="size-4" /> {state ? "New call" : "Ring the studio"}
            </button>
            <button onClick={() => end("hangup")} disabled={!active || busy} className="flex items-center gap-1.5 rounded-lg border border-line px-3 py-1.5 text-sm disabled:opacity-50">
              <PhoneOff className="size-4" /> Hang up
            </button>
            <button onClick={() => end("dropped")} disabled={!active || busy} className="flex items-center gap-1.5 rounded-lg border border-line px-3 py-1.5 text-sm disabled:opacity-50" title="Simulate the line dropping. Ring again from the same number within 60 minutes to resume.">
              <Unplug className="size-4" /> Drop line
            </button>
          </div>
        </Card>

        <Card
          title="Conversation"
          action={state?.callStatus && <Badge tone={active ? "brand" : "neutral"}>{active ? "on call" : state.callStatus}</Badge>}
        >
          <div className="max-h-[28rem] min-h-40 space-y-2 overflow-y-auto">
            {turns.length === 0 && <p className="py-10 text-center text-sm text-ink-3">Ring the studio to start.</p>}
            {turns.map((t, i) => (
              <div key={i} className={cn("max-w-[88%] rounded-xl px-3 py-2 text-sm", t.role === "agent" ? "bg-sunken" : "ml-auto bg-brand-soft")}>
                <p className="mb-0.5 text-[10px] font-semibold uppercase tracking-wide text-ink-3">{t.role === "agent" ? "Assistant" : "Caller"}</p>
                {t.text}
              </div>
            ))}
            {busy && (
              <p className="flex items-center gap-2 text-xs text-ink-3">
                <Loader2 className="size-3.5 animate-spin" /> working…
              </p>
            )}
            <div ref={endRef} />
          </div>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              say(text);
            }}
            className="mt-4 flex gap-2"
          >
            <input value={text} onChange={(e) => setText(e.target.value)} disabled={!active || busy} placeholder={active ? "Say something as the caller…" : "No call in progress"} className="h-10 min-w-0 flex-1 rounded-lg border border-line bg-surface px-3 text-sm" />
            <button disabled={!active || busy || !text.trim()} className="flex items-center gap-1.5 rounded-lg bg-ink px-3 text-sm font-medium text-white disabled:opacity-50">
              <Send className="size-4" /> Say
            </button>
          </form>
          {scenario && active && (
            <button onClick={() => say(scriptedAnswer(scenario, lastAction))} disabled={busy} className="mt-2 flex items-center gap-1.5 text-xs font-medium text-brand disabled:opacity-50">
              <Wand2 className="size-3.5" /> Send scripted answer{lastAction ? ` to "${lastAction.replace(/_/g, " ")}"` : " (opening)"}
            </button>
          )}
          {error && <p className="mt-3 rounded-lg bg-danger-soft px-3 py-2 text-sm text-danger">{error}</p>}
        </Card>
      </div>

      <div className="space-y-4">
        <Card title="Outcome" subtitle="Updated after every caller turn">
          {state?.enquiry ? (
            <div className="space-y-3 text-sm">
              <div className="flex flex-wrap items-center gap-2">
                <StatusBadge status={state.enquiry.status} />
                {state.enquiry.status === "qualified" && <HandoffBadge status={state.enquiry.handoff_status} />}
                <Badge tone={state.enquiry.within_sla ? "good" : state.enquiry.within_sla === false ? "bad" : "neutral"}>answered in {fmtSecs(state.enquiry.response_seconds)}</Badge>
                {state.enquiry.after_hours && <Badge>after hours</Badge>}
              </div>
              <p className="text-xs text-ink-3">
                Understanding: {state.enquiry.extraction_mode === "gemini" ? "Gemini Flash" : state.enquiry.extraction_mode === "rules_fallback" ? "rules-only fallback (Gemini not configured or failed)" : "–"}
              </p>
              <Link href={`/enquiries/${state.enquiry.id}`} className="inline-block text-sm font-medium text-brand underline">
                Open enquiry record
              </Link>
            </div>
          ) : (
            <p className="text-sm text-ink-3">No call yet.</p>
          )}
        </Card>

        <Card title="Criteria" subtitle="qualified.md, evaluated by rules, not the model">
          {criteria.length ? (
            <ul className="space-y-2.5">
              {criteria.map((c) => (
                <li key={c.key} className="flex gap-2 text-sm">
                  {c.status === "pass" ? <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-sage" /> : c.status === "fail" ? <XCircle className="mt-0.5 size-4 shrink-0 text-danger" /> : <CircleHelp className="mt-0.5 size-4 shrink-0 text-amber" />}
                  <div>
                    <p className="font-medium">{c.label}</p>
                    <p className="text-xs text-ink-2">{c.reason}</p>
                  </div>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-sm text-ink-3">Shown once the caller has spoken.</p>
          )}
        </Card>

        <Card title="What the assistant has understood" subtitle="Blank = not said yet">
          {facts ? (
            <dl className="grid grid-cols-[9rem_1fr] gap-x-3 gap-y-1.5 text-sm">
              {FACT_LABELS.map(([k, label]) => {
                const v = show(facts[k]);
                return (
                  <div key={k} className="contents">
                    <dt className="text-ink-3">{label}</dt>
                    <dd className={v ? "" : "text-ink-3"}>{v ?? "–"}</dd>
                  </div>
                );
              })}
            </dl>
          ) : (
            <p className="text-sm text-ink-3">No call yet.</p>
          )}
        </Card>
      </div>
    </div>
  );
}
