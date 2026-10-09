import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { BUSINESS } from "@/lib/knowledge/rules";
import { configStatus, numberEnv } from "@/lib/env";

export type Period = "7d" | "30d" | "all";

export interface EnquiryRow {
  id: string;
  status: string;
  call_type: string;
  received_at: string;
  first_response_at: string | null;
  response_seconds: number | null;
  within_sla: boolean | null;
  after_hours: boolean;
  pricing_asked: boolean;
  handoff_status: string;
  handoff_sent_at: string | null;
  closed_at: string | null;
  criteria: { key: string; status: string; label: string }[];
  facts: { caller_name?: string | null; location_text?: string | null };
  summary: string | null;
  override_status: string | null;
  aangan_contacts: { phone: string; name: string | null } | null;
}

export function periodStart(p: Period): string | null {
  if (p === "all") return null;
  const days = p === "7d" ? 7 : 30;
  return new Date(Date.now() - days * 86400_000).toISOString();
}

const pct = (n: number, d: number) => (d ? Math.round((n / d) * 1000) / 10 : null);

export async function loadDashboard(db: SupabaseClient, period: Period) {
  const from = periodStart(period);
  let eq = db
    .from("aangan_enquiries")
    .select("id, status, call_type, received_at, first_response_at, response_seconds, within_sla, after_hours, pricing_asked, handoff_status, handoff_sent_at, closed_at, criteria, facts, summary, override_status, aangan_contacts(phone, name)")
    .order("received_at", { ascending: false })
    .limit(5000);
  if (from) eq = eq.gte("received_at", from);
  let cq = db.from("aangan_cost_events").select("provider, units, unit, cost_inr, basis, at").limit(20000);
  if (from) cq = cq.gte("at", from);
  const [eRes, cRes, oRes, errRes] = await Promise.all([
    eq,
    cq,
    db.from("aangan_outbox").select("channel, kind, status, last_error, created_at").in("status", ["failed", "not_configured", "pending"]).limit(500),
    db.from("aangan_events").select("event, status, error, at, enquiry_id").in("status", ["error", "warning"]).order("at", { ascending: false }).limit(8),
  ]);
  if (eRes.error) throw new Error(eRes.error.message);
  const rows = (eRes.data ?? []) as unknown as EnquiryRow[];
  const costs = (cRes.data ?? []) as { provider: string; units: number; unit: string; cost_inr: number | null; basis: string; at: string }[];

  const answered = rows.filter((r) => r.first_response_at);
  const within = answered.filter((r) => r.within_sla).length;
  const responseSecs = answered.map((r) => Number(r.response_seconds ?? 0)).sort((a, b) => a - b);
  const newEnq = rows.filter((r) => r.call_type === "new_enquiry" || r.call_type === "follow_up" || r.call_type === "unknown");
  const by = (s: string) => rows.filter((r) => r.status === s).length;
  const qualified = by("qualified");
  const decided = qualified + by("unqualified") + by("needs_review");

  const failReasons: Record<string, number> = {};
  for (const r of rows.filter((x) => x.status === "unqualified")) {
    for (const c of r.criteria ?? []) if (c.status === "fail") failReasons[c.label] = (failReasons[c.label] ?? 0) + 1;
  }

  const handoffs = rows.filter((r) => r.status === "qualified");
  const handoffLatencies = handoffs
    .filter((r) => r.handoff_sent_at && r.closed_at)
    .map((r) => (new Date(r.handoff_sent_at!).getTime() - new Date(r.closed_at!).getTime()) / 1000)
    .sort((a, b) => a - b);

  // Daily series (IST dates).
  const dayKey = (iso: string) => new Intl.DateTimeFormat("en-CA", { timeZone: BUSINESS.timezone }).format(new Date(iso));
  const days = new Map<string, { total: number; qualified: number; afterHours: number }>();
  const spanDays = period === "7d" ? 7 : period === "30d" ? 30 : Math.min(60, Math.max(7, Math.ceil((Date.now() - new Date(rows.at(-1)?.received_at ?? Date.now()).getTime()) / 86400_000) + 1));
  for (let i = spanDays - 1; i >= 0; i--) days.set(dayKey(new Date(Date.now() - i * 86400_000).toISOString()), { total: 0, qualified: 0, afterHours: 0 });
  for (const r of rows) {
    const d = days.get(dayKey(r.received_at));
    if (!d) continue;
    d.total++;
    if (r.status === "qualified") d.qualified++;
    if (r.after_hours) d.afterHours++;
  }

  // Cost: only sum what has a price; list what doesn't.
  const byProvider: Record<string, { units: number; unit: string; inr: number; priced: number; unpriced: number; bases: string[] }> = {};
  for (const c of costs) {
    const p = (byProvider[c.provider] ??= { units: 0, unit: c.unit, inr: 0, priced: 0, unpriced: 0, bases: [] });
    p.units += Number(c.units);
    if (c.cost_inr === null) p.unpriced++;
    else {
      p.inr += Number(c.cost_inr);
      p.priced++;
    }
    if (!p.bases.includes(c.basis)) p.bases.push(c.basis);
  }
  const variableInr = Object.values(byProvider).reduce((s, p) => s + p.inr, 0);
  const platformMonthly = numberEnv("PLATFORM_INR_PER_MONTH");
  const unavailable = Object.entries(byProvider).filter(([, p]) => p.unpriced > 0).map(([k]) => k);
  if (platformMonthly === null) unavailable.push("platform");

  const outbox = (oRes.data ?? []) as { channel: string; kind: string; status: string; last_error: string | null }[];
  const cfg = configStatus();

  return {
    period,
    totals: {
      enquiries: rows.length,
      newEnquiries: newEnq.length,
      answered: answered.length,
      withinSla: within,
      withinSlaPct: pct(within, answered.length),
      unanswered: rows.length - answered.length,
      avgResponseSec: responseSecs.length ? Math.round((responseSecs.reduce((a, b) => a + b, 0) / responseSecs.length) * 10) / 10 : null,
      p95ResponseSec: responseSecs.length ? responseSecs[Math.min(responseSecs.length - 1, Math.floor(responseSecs.length * 0.95))] : null,
      afterHours: rows.filter((r) => r.after_hours).length,
      afterHoursPct: pct(rows.filter((r) => r.after_hours).length, rows.length),
      afterHoursQualified: rows.filter((r) => r.after_hours && r.status === "qualified").length,
      qualified,
      unqualified: by("unqualified"),
      needsReview: by("needs_review"),
      escalated: by("escalated"),
      incomplete: by("incomplete"),
      inProgress: by("in_progress"),
      other: by("other"),
      qualificationRatePct: pct(qualified, decided),
      pricingAsked: rows.filter((r) => r.pricing_asked).length,
      pricingAskedQualified: rows.filter((r) => r.pricing_asked && r.status === "qualified").length,
      overrides: rows.filter((r) => r.override_status).length,
    },
    handoff: {
      sent: handoffs.filter((r) => r.handoff_status === "sent").length,
      waiting: handoffs.filter((r) => ["pending", "not_configured"].includes(r.handoff_status)).length,
      failed: handoffs.filter((r) => r.handoff_status === "failed").length,
      medianLatencySec: handoffLatencies.length ? handoffLatencies[Math.floor(handoffLatencies.length / 2)] : null,
    },
    failReasons: Object.entries(failReasons).sort((a, b) => b[1] - a[1]),
    daily: [...days.entries()].map(([date, v]) => ({ date, ...v })),
    /** Case brief: average project value ₹8–14 lakh. An indicator of what qualified leads could be worth, not a forecast. */
    indicativeValueInr: { low: qualified * 800000, high: qualified * 1400000 },
    cost: {
      byProvider,
      variableInr,
      platformMonthlyInr: platformMonthly,
      perEnquiryInr: rows.length ? variableInr / rows.length : null,
      perQualifiedInr: qualified ? variableInr / qualified : null,
      unavailable,
    },
    health: {
      config: cfg,
      outboxFailed: outbox.filter((o) => o.status === "failed").length,
      outboxNotConfigured: outbox.filter((o) => o.status === "not_configured").length,
      outboxByChannel: outbox.reduce<Record<string, number>>((m, o) => ((m[`${o.channel}:${o.status}`] = (m[`${o.channel}:${o.status}`] ?? 0) + 1), m), {}),
      recentIssues: (errRes.data ?? []) as { event: string; status: string; error: string | null; at: string; enquiry_id: string | null }[],
    },
    recent: rows.slice(0, 8),
    slaSeconds: BUSINESS.responseSlaSeconds.value,
  };
}

export type Dashboard = Awaited<ReturnType<typeof loadDashboard>>;
