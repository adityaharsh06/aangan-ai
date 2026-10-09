import type { Metadata } from "next";
import { BUDGET_CHECK, BUSINESS, CRITERIA, SCRIPTS, SERVICE_AREA, SERVICES, TIMELINE, type Sourced } from "@/lib/knowledge/rules";
import { KNOWLEDGE_DOCS, KNOWLEDGE_VERSION } from "@/lib/knowledge/source.generated";
import { Badge, Card } from "@/components/ui";

export const metadata: Metadata = { title: "Rules & sources" };

const CRITERION_RULES: Record<string, string[]> = {
  real_project: [
    "Pass: design + execution of a home (full, partial or single room) or an office / clinic / studio.",
    "Fail: advice or styling only, standalone furniture, Vastu only, restaurants / hotels / retail / gyms.",
    "Unclear → one open question, then one direct question.",
  ],
  service_area: ["Pass: a named Pune / PCMC locality, or Pune / PCMC in general.", "Fail: Talegaon, Lonavala, Nashik, Mumbai or any other town.", "Unclear → ask where the site is, then one direct question."],
  timeline: [
    `Fail: needed in under ${TIMELINE.hardMinimumWeeks.value} weeks (services.md).`,
    `${TIMELINE.hardMinimumWeeks.value}–${TIMELINE.comfortableWeeks.value} weeks: ask once to confirm, then pass with a "tight timeline" note (decision U2).`,
    "Far-off or flexible starts are noted, never failed.",
  ],
  budget: ["Never quoted, never probed.", "No budget mentioned = pass.", "Fails only if the caller volunteers a figure clearly below the scope (internal check, see below)."],
  decision_maker: ["Pass: owner / decider, or calling on their behalf with authority.", "Unclear → treated as qualified and noted for the designer."],
};

function Assumption({ s }: { s: Sourced<unknown> }) {
  return s.assumption ? <Badge tone="warn">assumption: confirm with Nikhil</Badge> : null;
}

export default function RulesPage() {
  const sourced: [string, Sourced<unknown>, string][] = [
    ["Front desk hours", BUSINESS.frontDeskHours, `${BUSINESS.frontDeskHours.value.startHour}:00–${BUSINESS.frontDeskHours.value.endHour}:00 IST`],
    ["Response target", BUSINESS.responseSlaSeconds, `${BUSINESS.responseSlaSeconds.value / 60} minutes`],
    ["Commercial size limit", SERVICES.commercialMaxSqft, `~${SERVICES.commercialMaxSqft.value.toLocaleString("en-IN")} sq ft`],
    ["Commercial tolerance", SERVICES.commercialMaxToleranceSqft, `fail above ${SERVICES.commercialMaxToleranceSqft.value.toLocaleString("en-IN")} sq ft`],
    ["Small commercial flag", SERVICES.commercialSmallFlagSqft, `flag (not fail) under ${SERVICES.commercialSmallFlagSqft.value} sq ft`],
    ["Minimum lead time", TIMELINE.hardMinimumWeeks, `${TIMELINE.hardMinimumWeeks.value} weeks`],
    ["Comfortable lead time", TIMELINE.comfortableWeeks, `${TIMELINE.comfortableWeeks.value} weeks`],
    ["“Clearly below” budget", BUDGET_CHECK.clearlyBelowFraction, `under ${BUDGET_CHECK.clearlyBelowFraction.value * 100}% of the lowest indicative cost for the scope`],
  ];

  return (
    <div className="space-y-6">
      <div>
        <h1 className="font-display text-3xl">Rules &amp; sources</h1>
        <p className="mt-1 max-w-3xl text-sm text-ink-2">
          Every decision the assistant makes comes from Aangan&apos;s own documents. The AI only listens and extracts facts; these rules decide. Anything not stated in the documents is marked as an assumption.
          Knowledge version <code className="rounded bg-sunken px-1">{KNOWLEDGE_VERSION}</code>.
        </p>
      </div>

      <Card title="The five qualification criteria" subtitle="qualified.md: all five must pass. Any single failure means the lead is not forwarded (decision U1); two or more failures use the exact decline line.">
        <ol className="space-y-4">
          {CRITERIA.map((c) => (
            <li key={c.key} className="text-sm">
              <p className="font-medium">
                {c.id}. {c.label} <span className="ml-1 text-xs font-normal text-ink-3">{c.source}</span>
              </p>
              <ul className="mt-1 list-disc space-y-0.5 pl-5 text-ink-2">
                {CRITERION_RULES[c.key].map((r) => <li key={r}>{r}</li>)}
              </ul>
            </li>
          ))}
        </ol>
        <p className="mt-4 border-t border-line pt-3 text-xs text-ink-3">
          Never a reason to decline (qualified.md): calling after hours, asking about price, a single room, a rented home (no structural changes), being unsure of style.
        </p>
      </Card>

      <Card title="Verbatim scripts" subtitle="Spoken exactly as written in the source documents">
        <div className="space-y-4 text-sm">
          {[
            ["Any pricing question", SCRIPTS.pricing],
            ["Two or more criteria fail", SCRIPTS.decline],
            ["Timeline unclear", SCRIPTS.timelineQuestion],
          ].map(([label, s]) => (
            <div key={label as string}>
              <p className="text-xs text-ink-3">
                {label as string} · {(s as Sourced<string>).source}
              </p>
              <blockquote className="mt-1 border-l-2 border-brand pl-3">“{(s as Sourced<string>).value}”</blockquote>
            </div>
          ))}
          <p className="rounded-lg bg-brand-soft p-3 text-brand">
            Pricing is quoted by the designer, never the assistant. Nikhil asked for per-sq-ft quoting, but pricing.md says no number from the guide should be quoted to a client. Every customer-facing line is checked by a pricing guard before it is spoken, and the designer handoff carries no figures.
          </p>
        </div>
      </Card>

      <div className="grid gap-6 lg:grid-cols-2">
        <Card title="Thresholds">
          <dl className="space-y-3 text-sm">
            {sourced.map(([label, s, value]) => (
              <div key={label}>
                <dt className="flex flex-wrap items-center gap-2 font-medium">
                  {label} <Assumption s={s} />
                </dt>
                <dd className="text-ink-2">{value}</dd>
                <dd className="text-xs text-ink-3">{s.source}{s.note ? ` · ${s.note}` : ""}</dd>
              </div>
            ))}
          </dl>
        </Card>

        <Card title="Service area">
          <div className="space-y-3 text-sm">
            <div>
              <p className="font-medium">Named in services.md</p>
              <p className="text-ink-2">{SERVICE_AREA.served.value.join(", ")}</p>
            </div>
            <div>
              <p className="flex flex-wrap items-center gap-2 font-medium">
                Also treated as Pune / PCMC <Assumption s={SERVICE_AREA.servedAssumed} />
              </p>
              <p className="text-ink-2">{SERVICE_AREA.servedAssumed.value.join(", ")}</p>
              <p className="text-xs text-ink-3">{SERVICE_AREA.servedAssumed.source}</p>
            </div>
            <div>
              <p className="font-medium">Excluded</p>
              <p className="text-ink-2">{SERVICE_AREA.excluded.value.join(", ")}</p>
            </div>
          </div>
        </Card>
      </div>

      <Card title="Internal budget check" subtitle="Used only to spot a volunteered budget that is clearly below the scope. Never spoken, never sent to designers.">
        <ul className="space-y-1 text-sm text-ink-2">
          <li>Residential floor: lowest indicative per-sq-ft rate · {BUDGET_CHECK.residentialFloorPerSqft.source}</li>
          <li>Commercial floor: lowest indicative per-sq-ft rate · {BUDGET_CHECK.commercialFloorPerSqft.source}</li>
          <li>Single room floor · {BUDGET_CHECK.singleRoomFloorInr.source}</li>
        </ul>
      </Card>

      <Card title="Source documents" subtitle="As embedded in this build">
        <div className="space-y-3">
          {Object.entries(KNOWLEDGE_DOCS).map(([name, body]) => (
            <details key={name} className="rounded-lg border border-line">
              <summary className="cursor-pointer px-4 py-2.5 text-sm font-medium">{name}</summary>
              <pre className="overflow-x-auto border-t border-line bg-sunken/50 p-4 text-xs leading-relaxed whitespace-pre-wrap">{body}</pre>
            </details>
          ))}
        </div>
      </Card>
    </div>
  );
}
