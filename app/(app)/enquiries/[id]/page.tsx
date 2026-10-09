import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft, CheckCircle2, CircleHelp, Moon, XCircle } from "lucide-react";
import { serviceDb } from "@/lib/supabase/server";
import type { Facts } from "@/lib/domain/facts";
import type { CriterionResult } from "@/lib/qualification/engine";
import type { Turn } from "@/lib/agent/types";
import { Badge, Card, HandoffBadge, StatusBadge, cn, fmtInr, fmtSecs, fmtWhen } from "@/components/ui";
import { OverrideForm } from "@/components/override-form";
import { RetryButton } from "@/components/retry-button";

export const metadata: Metadata = { title: "Enquiry" };
export const dynamic = "force-dynamic";

const NP = <span className="text-ink-3 italic">Not provided</span>;

export default async function EnquiryPage({ params }: PageProps<"/enquiries/[id]">) {
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/.test(id)) notFound();
  const db = serviceDb();
  const [eRes, calls, events, outbox, costs] = await Promise.all([
    db.from("aangan_enquiries").select("*, aangan_contacts(phone, name, email)").eq("id", id).maybeSingle(),
    db.from("aangan_calls").select("id, provider, provider_call_id, started_at, ended_at, duration_seconds, status, end_reason, session").eq("enquiry_id", id).order("started_at"),
    db.from("aangan_events").select("id, event, status, error, external_id, metadata, at").eq("enquiry_id", id).order("at"),
    db.from("aangan_outbox").select("channel, kind, status, attempts, last_error, sent_at").eq("enquiry_id", id).order("created_at"),
    db.from("aangan_cost_events").select("provider, units, unit, cost_inr, basis").eq("enquiry_id", id),
  ]);
  const e = eRes.data;
  if (!e) notFound();
  const f = e.facts as Facts;
  const criteria = (e.criteria ?? []) as CriterionResult[];
  const contact = e.aangan_contacts as { phone: string; name: string | null; email: string | null } | null;
  const totalCost = (costs.data ?? []).reduce((s, c) => s + (c.cost_inr === null ? 0 : Number(c.cost_inr)), 0);
  const unpricedCost = (costs.data ?? []).some((c) => c.cost_inr === null);

  const rows: [string, React.ReactNode][] = [
    ["Phone", contact?.phone ?? NP],
    ["Email", f.email ?? NP],
    ["Found us via", f.referral_source ?? NP],
    ["Site", f.location_text ?? NP],
    ["Property", [f.bhk ? `${f.bhk}BHK` : null, f.property_kind !== "unknown" ? f.property_kind?.replace("_", " ") : null, f.carpet_area_sqft ? `${f.carpet_area_sqft} sq ft` : null].filter(Boolean).join(" · ") || NP],
    ["Scope", f.scope_type && f.scope_type !== "unknown" ? `${f.scope_type.replace("_", " ")}${f.scope_rooms?.length ? `: ${f.scope_rooms.join(", ")}` : ""}` : f.scope_rooms?.length ? f.scope_rooms.join(", ") : NP],
    ["Current state", f.current_state ?? NP],
    ["Rented", f.rented === null || f.rented === undefined ? NP : f.rented ? "Yes" : "No"],
    ["Timeline", f.timeline_text ? `${f.timeline_text}${f.weeks_until_needed !== null ? ` (~${Math.round(f.weeks_until_needed)} weeks)` : ""}` : NP],
    ["Decision-maker", f.decision_maker && f.decision_maker !== "unknown" ? `${f.decision_maker.replace("_", " ")}${f.decision_maker_note ? ` (${f.decision_maker_note})` : ""}` : NP],
    ["Budget", f.budget_volunteered ? `Volunteered: ${[f.budget_min_inr, f.budget_max_inr].filter((x) => x !== null).map((x) => fmtInr(x as number)).join(" – ")}` : "Not discussed (never probed)"],
    ["Consultation", f.preferred_slots?.length ? `${f.preferred_slots.join("; ")}${f.site_visit_requested ? " · site visit" : ""}` : NP],
    ["Calendar", String(e.scheduling_status ?? "not_applicable").replace(/_/g, " ")],
    ...(f.callback_phone ? ([["Call back on", f.callback_phone]] as [string, React.ReactNode][]) : []),
  ];

  return (
    <div className="space-y-6">
      <Link href="/enquiries" className="inline-flex items-center gap-1.5 text-sm text-ink-2 hover:text-ink">
        <ArrowLeft className="size-4" /> Enquiries
      </Link>

      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="font-display text-3xl">{f.caller_name ?? contact?.name ?? "Unknown caller"}</h1>
          <div className="mt-2 flex flex-wrap items-center gap-2 text-sm text-ink-2">
            <StatusBadge status={e.status} />
            {e.status === "qualified" && <HandoffBadge status={e.handoff_status} />}
            {e.override_status && <Badge tone="brand">overridden by {e.override_by}</Badge>}
            <span>Received {fmtWhen(e.received_at)}</span>
            {e.after_hours && <Badge><Moon className="size-3" /> after hours</Badge>}
            <Badge tone={e.within_sla ? "good" : e.within_sla === false ? "bad" : "neutral"}>answered in {fmtSecs(e.response_seconds)}</Badge>
            {e.call_type !== "new_enquiry" && <Badge>{String(e.call_type).replace("_", " ")}</Badge>}
          </div>
        </div>
        {e.status === "qualified" && e.handoff_status !== "sent" && <RetryButton enquiryId={e.id} label="Resend handoff" />}
      </div>

      <div className="grid gap-6 lg:grid-cols-[1.25fr_1fr]">
        <div className="space-y-6">
          <Card title="Designer brief" subtitle="Everything already asked on the call">
            {e.summary && <p className="mb-4 rounded-lg bg-sunken/60 p-3 text-sm leading-relaxed">{e.summary}</p>}
            <dl className="grid grid-cols-[9rem_1fr] gap-x-4 gap-y-2 text-sm">
              {rows.map(([k, v]) => (
                <div key={k} className="contents">
                  <dt className="text-ink-3">{k}</dt>
                  <dd>{v}</dd>
                </div>
              ))}
            </dl>
            <div className="mt-4 space-y-2 border-t border-line pt-4 text-sm">
              <p>
                <span className="text-ink-3">Pricing:</span> {f.pricing_asked ? "Caller asked. The assistant gave the approved line and no figure; the designer quotes at consultation." : "Not raised."}
              </p>
              {(e.caller_concerns as string[])?.length > 0 && (
                <p>
                  <span className="text-ink-3">Caller&apos;s questions:</span> {(e.caller_concerns as string[]).join(" · ")}
                </p>
              )}
              {e.recommended_next_action && (
                <p>
                  <span className="text-ink-3">Next:</span> <span className="font-medium">{e.recommended_next_action}</span>
                </p>
              )}
            </div>
          </Card>

          <Card title="Call transcript" subtitle={`${(calls.data ?? []).length} call(s)`}>
            <div className="space-y-6">
              {(calls.data ?? []).map((c, i) => (
                <div key={c.id}>
                  <p className="mb-2 text-xs text-ink-3">
                    Call {i + 1} · {fmtWhen(c.started_at)} · {c.status}
                    {c.duration_seconds ? ` · ${fmtSecs(Number(c.duration_seconds))}` : ""} · via {c.provider}
                  </p>
                  <ol className="space-y-2">
                    {((c.session as { turns?: Turn[] })?.turns ?? []).map((t, j) => (
                      <li key={j} className={cn("max-w-[90%] rounded-xl px-3 py-2 text-sm", t.role === "agent" ? "bg-sunken" : "ml-auto bg-brand-soft")}>
                        <p className="mb-0.5 text-[10px] font-semibold uppercase tracking-wide text-ink-3">{t.role === "agent" ? "Assistant" : "Caller"}</p>
                        {t.text}
                      </li>
                    ))}
                  </ol>
                </div>
              ))}
            </div>
          </Card>
        </div>

        <div className="space-y-6">
          <Card title="Why this outcome" subtitle="Nikhil's five criteria (qualified.md)">
            <ul className="space-y-3">
              {criteria.map((c) => (
                <li key={c.key} className="flex gap-2.5">
                  {c.status === "pass" ? <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-sage" /> : c.status === "fail" ? <XCircle className="mt-0.5 size-4 shrink-0 text-danger" /> : <CircleHelp className="mt-0.5 size-4 shrink-0 text-amber" />}
                  <div className="text-sm">
                    <p className="font-medium">{c.label}</p>
                    <p className="text-ink-2">{c.reason}</p>
                    <p className="mt-0.5 text-[11px] text-ink-3">Source: {c.source}</p>
                  </div>
                </li>
              ))}
            </ul>
            {(e.uncertainty_notes as string[])?.length > 0 && (
              <div className="mt-4 rounded-lg bg-amber-soft p-3 text-sm text-amber">
                <p className="font-medium">For the designer to check</p>
                <ul className="mt-1 list-disc space-y-0.5 pl-4">
                  {(e.uncertainty_notes as string[]).map((n) => <li key={n}>{n}</li>)}
                </ul>
              </div>
            )}
            <p className="mt-4 text-[11px] text-ink-3">
              Rules version {e.knowledge_version ?? "–"} · understanding: {e.extraction_mode === "gemini" ? "Gemini Flash" : e.extraction_mode === "rules_fallback" ? "rules-only fallback" : "–"}
            </p>
          </Card>

          <Card title="Human override" subtitle="Correct the automated outcome. Your name and reason are recorded.">
            <OverrideForm enquiryId={e.id} current={e.status} />
            {e.override_reason && (
              <p className="mt-3 text-xs text-ink-2">
                Last override: <b>{e.override_status}</b> by {e.override_by} on {fmtWhen(e.override_at)}: “{e.override_reason}”
              </p>
            )}
          </Card>

          <Card title="Deliveries">
            {(outbox.data ?? []).length ? (
              <ul className="space-y-2 text-sm">
                {(outbox.data ?? []).map((o, i) => (
                  <li key={i} className="flex flex-wrap items-center justify-between gap-2">
                    <span>
                      {o.channel} · {String(o.kind).replace("_", " ")}
                    </span>
                    <Badge tone={o.status === "sent" ? "good" : o.status === "failed" ? "bad" : "warn"}>{o.status.replace("_", " ")}</Badge>
                    {o.last_error && <p className="w-full text-xs text-ink-3">{o.last_error}</p>}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-sm text-ink-3">Nothing queued.</p>
            )}
            <p className="mt-3 border-t border-line pt-3 text-xs text-ink-3">
              Cost of handling this enquiry: <span className="font-medium text-ink">{fmtInr(totalCost)}</span>
              {unpricedCost && " + items without a configured price"}
            </p>
          </Card>

          <Card title="Audit trail">
            <ol className="space-y-2 text-xs">
              {(events.data ?? []).map((ev) => (
                <li key={ev.id} className="flex gap-2">
                  <span className={cn("mt-1 size-1.5 shrink-0 rounded-full", ev.status === "error" ? "bg-danger" : ev.status === "warning" ? "bg-amber" : "bg-sage")} />
                  <div>
                    <p>
                      <span className="font-medium">{ev.event}</span> <span className="text-ink-3">{fmtWhen(ev.at)}</span>
                    </p>
                    {ev.error && <p className="text-ink-3">{ev.error}</p>}
                  </div>
                </li>
              ))}
            </ol>
          </Card>
        </div>
      </div>
    </div>
  );
}
