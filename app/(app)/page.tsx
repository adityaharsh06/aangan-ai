import type { Metadata } from "next";
import Link from "next/link";
import { AlertTriangle, CheckCircle2, CircleDashed, Moon } from "lucide-react";
import { serviceDb } from "@/lib/supabase/server";
import { loadDashboard, type Period } from "@/lib/server/metrics";
import { Badge, Card, Empty, HandoffBadge, Stat, StatusBadge, cn, fmtInr, fmtLakh, fmtSecs, fmtWhen } from "@/components/ui";
import { RetryButton } from "@/components/retry-button";

export const metadata: Metadata = { title: "Dashboard" };
export const dynamic = "force-dynamic";

const PERIODS: { key: Period; label: string }[] = [
  { key: "7d", label: "7 days" },
  { key: "30d", label: "30 days" },
  { key: "all", label: "All time" },
];

export default async function Dashboard({ searchParams }: PageProps<"/">) {
  const sp = await searchParams;
  const period: Period = sp.period === "7d" || sp.period === "all" ? sp.period : "30d";
  const d = await loadDashboard(serviceDb(), period);
  const t = d.totals;
  const maxDay = Math.max(1, ...d.daily.map((x) => x.total));
  const slaTone = t.withinSlaPct === null ? undefined : t.withinSlaPct >= 99 ? "good" : t.withinSlaPct >= 90 ? "warn" : "bad";

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="text-xs font-medium uppercase tracking-wider text-ink-3">Nikhil&apos;s view</p>
          <h1 className="font-display text-3xl">Phone enquiries</h1>
        </div>
        <div className="flex rounded-lg border border-line bg-surface p-0.5 text-sm">
          {PERIODS.map((p) => (
            <Link key={p.key} href={p.key === "30d" ? "/" : `/?period=${p.key}`} className={cn("rounded-md px-3 py-1.5", period === p.key ? "bg-ink text-white" : "text-ink-2 hover:text-ink")}>
              {p.label}
            </Link>
          ))}
        </div>
      </div>

      {/* The ask, measured */}
      <section className="grid gap-4 lg:grid-cols-[1.3fr_1fr]">
        <div className="rounded-xl bg-night p-6 text-white">
          <p className="text-sm text-white/60">Answered within five minutes, day or night</p>
          <div className="mt-2 flex items-end gap-4">
            <p className={cn("font-display text-6xl tabular", slaTone === "good" && "text-[#b9d4b5]", slaTone === "bad" && "text-[#f0a49d]")}>{t.withinSlaPct === null ? "–" : `${t.withinSlaPct}%`}</p>
            <p className="pb-2 text-sm text-white/60">
              {t.withinSla} of {t.answered} answered calls · avg first response {fmtSecs(t.avgResponseSec)}
              {t.p95ResponseSec !== null && ` · slowest 5% ≥ ${fmtSecs(t.p95ResponseSec)}`}
            </p>
          </div>
          <div className="mt-5 grid grid-cols-3 gap-3 border-t border-white/10 pt-4 text-sm">
            <div>
              <p className="text-white/50">After hours</p>
              <p className="mt-0.5 flex items-center gap-1.5 font-medium">
                <Moon className="size-3.5" /> {t.afterHours} {t.afterHoursPct !== null && <span className="text-white/50">({t.afterHoursPct}%)</span>}
              </p>
            </div>
            <div>
              <p className="text-white/50">Qualified after hours</p>
              <p className="mt-0.5 font-medium">{t.afterHoursQualified}</p>
            </div>
            <div>
              <p className="text-white/50">Not answered</p>
              <p className={cn("mt-0.5 font-medium", t.unanswered > 0 && "text-[#f0a49d]")}>{t.unanswered}</p>
            </div>
          </div>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <Stat label="Enquiries" value={t.enquiries} hint={`${t.newEnquiries} new projects`} />
          <Stat label="Qualified → designers" value={t.qualified} tone="good" hint={t.qualificationRatePct !== null ? `${t.qualificationRatePct}% of decided enquiries` : undefined} />
          <Stat label="Needs a person" value={t.needsReview + t.incomplete} tone={t.needsReview + t.incomplete ? "warn" : undefined} hint="review or callback" />
          <Stat label="Existing-client escalations" value={t.escalated} tone={t.escalated ? "bad" : undefined} />
        </div>
      </section>

      <div className="grid gap-6 lg:grid-cols-2">
        <Card title="What the system is generating" subtitle="From answered phone calls in this period">
          <div className="space-y-4">
            <div className="flex h-36 items-end gap-1" aria-label="Enquiries per day">
              {d.daily.map((x) => (
                <div key={x.date} className="group relative flex h-full flex-1 flex-col justify-end" title={`${x.date}: ${x.total} enquiries, ${x.qualified} qualified`}>
                  <div className="w-full rounded-t-sm bg-brand-soft" style={{ height: `${(x.total / maxDay) * 100}%` }}>
                    <div className="w-full rounded-t-sm bg-sage" style={{ height: x.total ? `${(x.qualified / x.total) * 100}%` : 0 }} />
                  </div>
                </div>
              ))}
            </div>
            <div className="flex items-center gap-4 text-xs text-ink-3">
              <span className="flex items-center gap-1.5"><span className="size-2.5 rounded-sm bg-brand-soft" /> enquiries</span>
              <span className="flex items-center gap-1.5"><span className="size-2.5 rounded-sm bg-sage" /> qualified</span>
            </div>
            <dl className="grid grid-cols-2 gap-x-6 gap-y-2 border-t border-line pt-4 text-sm">
              <dt className="text-ink-2">Handoffs delivered</dt>
              <dd className="text-right tabular">{d.handoff.sent} / {t.qualified}</dd>
              <dt className="text-ink-2">Median call-end → designer</dt>
              <dd className="text-right tabular">{fmtSecs(d.handoff.medianLatencySec)}</dd>
              <dt className="text-ink-2">Asked about price</dt>
              <dd className="text-right tabular">{t.pricingAsked} <span className="text-ink-3">({t.pricingAskedQualified} still qualified)</span></dd>
              <dt className="text-ink-2">Not a fit / other</dt>
              <dd className="text-right tabular">{t.unqualified} / {t.other}</dd>
              <dt className="text-ink-2">Manual overrides</dt>
              <dd className="text-right tabular">{t.overrides}</dd>
              <dt className="text-ink-2">Qualified-lead value indicator</dt>
              <dd className="text-right tabular">{t.qualified ? `${fmtLakh(d.indicativeValueInr.low)}–${fmtLakh(d.indicativeValueInr.high)}` : "–"}</dd>
            </dl>
            <p className="text-[11px] leading-relaxed text-ink-3">Value indicator = qualified leads × the case&apos;s ₹8–14 lakh average project value. It shows what&apos;s reaching designers, not a revenue forecast or a quote.</p>
          </div>
        </Card>

        <Card title="What it costs to run" subtitle="Only priced items are summed; anything without a price is listed, never counted as zero">
          <div className="space-y-4">
            <div className="grid grid-cols-3 gap-3">
              <Stat label="Variable cost" value={fmtInr(d.cost.variableInr)} />
              <Stat label="Per enquiry" value={fmtInr(d.cost.perEnquiryInr)} />
              <Stat label="Per qualified lead" value={fmtInr(d.cost.perQualifiedInr)} />
            </div>
            <table className="w-full text-sm">
              <thead className="text-left text-xs text-ink-3">
                <tr>
                  <th className="pb-2 font-medium">Component</th>
                  <th className="pb-2 font-medium">Usage</th>
                  <th className="pb-2 text-right font-medium">Cost</th>
                  <th className="pb-2 text-right font-medium">Basis</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {(["gemini", "voice"] as const).map((k) => {
                  const p = d.cost.byProvider[k];
                  const label = k === "gemini" ? "AI (Gemini Flash)" : "Voice minutes";
                  return (
                    <tr key={k}>
                      <td className="py-2">{label}</td>
                      <td className="py-2 tabular text-ink-2">{p ? `${Math.round(p.units).toLocaleString("en-IN")} ${p.unit}` : "–"}</td>
                      <td className="py-2 text-right tabular">{p && p.priced ? fmtInr(p.inr) : "–"}</td>
                      <td className="py-2 text-right">{!p ? <Badge>no usage</Badge> : p.unpriced ? <Badge tone="warn">price unavailable</Badge> : <Badge tone={p.bases.includes("estimated") ? "warn" : "good"}>{p.bases.join(", ")}</Badge>}</td>
                    </tr>
                  );
                })}
                <tr>
                  <td className="py-2">Telegram handoffs</td>
                  <td className="py-2 text-ink-2">{d.handoff.sent} messages</td>
                  <td className="py-2 text-right tabular">₹0</td>
                  <td className="py-2 text-right"><Badge tone="good">free API</Badge></td>
                </tr>
                <tr>
                  <td className="py-2">Platform (Vercel + Supabase)</td>
                  <td className="py-2 text-ink-2">per month</td>
                  <td className="py-2 text-right tabular">{d.cost.platformMonthlyInr === null ? "–" : fmtInr(d.cost.platformMonthlyInr)}</td>
                  <td className="py-2 text-right">{d.cost.platformMonthlyInr === null ? <Badge tone="warn">not configured</Badge> : <Badge tone="good">configured</Badge>}</td>
                </tr>
              </tbody>
            </table>
            {d.cost.unavailable.length > 0 && (
              <p className="rounded-lg bg-amber-soft px-3 py-2 text-xs text-amber">
                Not included in totals: {d.cost.unavailable.join(", ")}. Set VOICE_INR_PER_MINUTE / PLATFORM_INR_PER_MONTH from your actual plans to complete the picture.
              </p>
            )}
            <p className="text-[11px] text-ink-3">AI cost = actual tokens used × configured Gemini list price (estimated). Voice cost = actual minutes × your plan rate once Vaani Labs is connected.</p>
          </div>
        </Card>
      </div>

      <div className="grid gap-6 lg:grid-cols-[1fr_1.4fr]">
        <Card title="Why enquiries weren't a fit" subtitle="Failed criteria from Nikhil's rubric">
          {d.failReasons.length ? (
            <ul className="space-y-2.5">
              {d.failReasons.map(([label, n]) => (
                <li key={label}>
                  <div className="flex justify-between text-sm">
                    <span>{label}</span>
                    <span className="tabular text-ink-2">{n}</span>
                  </div>
                  <div className="mt-1 h-1.5 rounded-full bg-sunken">
                    <div className="h-1.5 rounded-full bg-ink-3" style={{ width: `${(n / Math.max(...d.failReasons.map((x) => x[1]))) * 100}%` }} />
                  </div>
                </li>
              ))}
            </ul>
          ) : (
            <Empty>No declined enquiries in this period.</Empty>
          )}
        </Card>

        <Card title="System health" action={<RetryButton />}>
          <ul className="grid gap-2 text-sm sm:grid-cols-2">
            <Health ok={d.health.config.supabase} label="Database" detail="Supabase" />
            <Health ok={d.health.config.gemini} label="AI understanding" detail={d.health.config.gemini ? d.health.config.model : "Rules-only fallback active"} warn />
            <Health ok={d.health.config.telegram} label="Designer handoff" detail={d.health.config.telegram ? "Telegram connected" : "Telegram not set up; handoffs queued"} warn />
            <Health ok={d.health.config.voice !== "mock"} label="Voice line" detail={d.health.config.voice === "vaani" ? "Vaani Labs webhook connected; simulator also available" : "Simulator only (Vaani webhook secret not set)"} pending />
            <Health ok={d.health.config.crm !== "mock"} label="CRM" detail="HubSpot pending; leads queued for replay" pending />
            <Health ok={d.health.config.scheduling !== "mock"} label="Scheduling" detail={d.health.config.scheduling === "calendly" ? "Calendly: books after qualified calls" : "Calendly not set up; preferred slots kept on lead"} pending />
          </ul>
          <div className="mt-4 flex flex-wrap gap-2 text-xs">
            <Badge tone={d.health.outboxFailed ? "bad" : "good"}>{d.health.outboxFailed} failed deliveries</Badge>
            <Badge tone={d.health.outboxNotConfigured ? "warn" : "neutral"}>{d.health.outboxNotConfigured} waiting on an integration</Badge>
          </div>
          {d.health.recentIssues.length > 0 && (
            <ul className="mt-4 space-y-1.5 border-t border-line pt-3 text-xs">
              {d.health.recentIssues.slice(0, 5).map((i, n) => (
                <li key={n} className="flex gap-2">
                  <AlertTriangle className={cn("mt-0.5 size-3.5 shrink-0", i.status === "error" ? "text-danger" : "text-amber")} />
                  <span className="text-ink-2">
                    <span className="font-medium text-ink">{i.event}</span> · {fmtWhen(i.at)} {i.error && `· ${i.error.slice(0, 120)}`}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>

      <Card title="Latest enquiries" action={<Link href="/enquiries" className="text-sm text-brand hover:underline">All enquiries →</Link>}>
        {d.recent.length ? (
          <ul className="divide-y divide-line">
            {d.recent.map((r) => (
              <li key={r.id}>
                <Link href={`/enquiries/${r.id}`} className="flex flex-wrap items-center gap-x-4 gap-y-1 py-2.5 hover:bg-sunken/50">
                  <span className="w-28 text-xs text-ink-3">{fmtWhen(r.received_at)}</span>
                  <span className="min-w-40 flex-1 text-sm font-medium">{r.facts?.caller_name ?? r.aangan_contacts?.name ?? r.aangan_contacts?.phone ?? "Unknown caller"}</span>
                  <span className="hidden text-sm text-ink-2 sm:block sm:w-40 sm:truncate">{r.facts?.location_text ?? "–"}</span>
                  <StatusBadge status={r.status} />
                  {r.status === "qualified" && <HandoffBadge status={r.handoff_status} />}
                  {r.after_hours && <Badge><Moon className="size-3" /> after hours</Badge>}
                </Link>
              </li>
            ))}
          </ul>
        ) : (
          <Empty>
            No calls yet. Try the <Link href="/simulator" className="text-brand underline">call simulator</Link>.
          </Empty>
        )}
      </Card>
    </div>
  );
}

function Health({ ok, label, detail, warn, pending }: { ok: boolean; label: string; detail: string; warn?: boolean; pending?: boolean }) {
  const Icon = ok ? CheckCircle2 : pending ? CircleDashed : AlertTriangle;
  return (
    <li className="flex items-start gap-2.5 rounded-lg bg-sunken/60 px-3 py-2">
      <Icon className={cn("mt-0.5 size-4 shrink-0", ok ? "text-sage" : pending ? "text-ink-3" : warn ? "text-amber" : "text-danger")} />
      <div>
        <p className="font-medium">{label}</p>
        <p className="text-xs text-ink-3">{detail}</p>
      </div>
    </li>
  );
}
