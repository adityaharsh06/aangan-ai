import type { ReactNode } from "react";

export function cn(...c: (string | false | null | undefined)[]) {
  return c.filter(Boolean).join(" ");
}

export function Card({ children, className, title, action, subtitle }: { children: ReactNode; className?: string; title?: ReactNode; subtitle?: ReactNode; action?: ReactNode }) {
  return (
    <section className={cn("rounded-xl border border-line bg-surface", className)}>
      {(title || action) && (
        <header className="flex items-start justify-between gap-4 border-b border-line px-5 py-3.5">
          <div>
            {title && <h2 className="text-sm font-semibold text-ink">{title}</h2>}
            {subtitle && <p className="mt-0.5 text-xs text-ink-3">{subtitle}</p>}
          </div>
          {action}
        </header>
      )}
      <div className="p-5">{children}</div>
    </section>
  );
}

const TONES = {
  neutral: "bg-slate-soft text-ink-2",
  good: "bg-sage-soft text-sage",
  warn: "bg-amber-soft text-amber",
  bad: "bg-danger-soft text-danger",
  brand: "bg-brand-soft text-brand",
} as const;
export type Tone = keyof typeof TONES;

export function Badge({ children, tone = "neutral", className }: { children: ReactNode; tone?: Tone; className?: string }) {
  return <span className={cn("inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium whitespace-nowrap", TONES[tone], className)}>{children}</span>;
}

const STATUS: Record<string, { label: string; tone: Tone }> = {
  qualified: { label: "Qualified", tone: "good" },
  unqualified: { label: "Not a fit", tone: "neutral" },
  needs_review: { label: "Needs review", tone: "warn" },
  escalated: { label: "Escalated", tone: "bad" },
  incomplete: { label: "Incomplete", tone: "warn" },
  in_progress: { label: "On call", tone: "brand" },
  other: { label: "Other", tone: "neutral" },
};

export function StatusBadge({ status }: { status: string }) {
  const s = STATUS[status] ?? { label: status, tone: "neutral" as Tone };
  return <Badge tone={s.tone}>{s.label}</Badge>;
}

const HANDOFF: Record<string, { label: string; tone: Tone }> = {
  sent: { label: "Sent to designers", tone: "good" },
  pending: { label: "Sending", tone: "brand" },
  failed: { label: "Send failed", tone: "bad" },
  not_configured: { label: "Queued: Telegram not set up", tone: "warn" },
  not_required: { label: "Not needed", tone: "neutral" },
};

export function HandoffBadge({ status }: { status: string }) {
  const s = HANDOFF[status] ?? { label: status, tone: "neutral" as Tone };
  return <Badge tone={s.tone}>{s.label}</Badge>;
}

export function Stat({ label, value, hint, tone }: { label: string; value: ReactNode; hint?: ReactNode; tone?: Tone }) {
  return (
    <div className="rounded-xl border border-line bg-surface px-4 py-3.5">
      <p className="text-xs font-medium text-ink-3">{label}</p>
      <p className={cn("mt-1 font-display text-2xl tabular", tone === "good" && "text-sage", tone === "bad" && "text-danger", tone === "warn" && "text-amber")}>{value}</p>
      {hint && <p className="mt-0.5 text-xs text-ink-3">{hint}</p>}
    </div>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <p className="rounded-lg border border-dashed border-line px-4 py-6 text-center text-sm text-ink-3">{children}</p>;
}

export const fmtInr = (n: number | null | undefined, digits = 2) =>
  n === null || n === undefined ? "–" : `₹${n.toLocaleString("en-IN", { minimumFractionDigits: n > 0 && n < 100 ? digits : 0, maximumFractionDigits: n < 100 ? digits : 0 })}`;

export const fmtLakh = (n: number) => `₹${(n / 100000).toLocaleString("en-IN", { maximumFractionDigits: 1 })}L`;

export function fmtSecs(s: number | null | undefined) {
  if (s === null || s === undefined) return "–";
  if (s < 90) return `${Math.round(s)}s`;
  if (s < 3600) return `${Math.round(s / 60)} min`;
  return `${(s / 3600).toFixed(1)} h`;
}

export function fmtWhen(iso: string | null | undefined) {
  if (!iso) return "–";
  return new Intl.DateTimeFormat("en-IN", { timeZone: "Asia/Kolkata", day: "numeric", month: "short", hour: "numeric", minute: "2-digit" }).format(new Date(iso));
}
