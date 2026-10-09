import type { Metadata } from "next";
import Link from "next/link";
import { Moon } from "lucide-react";
import { serviceDb } from "@/lib/supabase/server";
import { Badge, Card, Empty, HandoffBadge, StatusBadge, cn, fmtSecs, fmtWhen } from "@/components/ui";

export const metadata: Metadata = { title: "Enquiries" };
export const dynamic = "force-dynamic";

const FILTERS = [
  { key: "all", label: "All" },
  { key: "qualified", label: "Qualified" },
  { key: "needs_review", label: "Needs review" },
  { key: "incomplete", label: "Incomplete" },
  { key: "escalated", label: "Escalated" },
  { key: "unqualified", label: "Not a fit" },
];

type Row = {
  id: string;
  status: string;
  received_at: string;
  response_seconds: number | null;
  within_sla: boolean | null;
  after_hours: boolean;
  handoff_status: string;
  pricing_asked: boolean;
  summary: string | null;
  facts: { caller_name?: string | null; location_text?: string | null; scope_type?: string; bhk?: number | null };
  aangan_contacts: { phone: string; name: string | null } | null;
};

export default async function Enquiries({ searchParams }: PageProps<"/enquiries">) {
  const sp = await searchParams;
  const filter = typeof sp.status === "string" && FILTERS.some((f) => f.key === sp.status) ? sp.status : "all";
  const db = serviceDb();
  let q = db
    .from("aangan_enquiries")
    .select("id, status, received_at, response_seconds, within_sla, after_hours, handoff_status, pricing_asked, summary, facts, aangan_contacts(phone, name)")
    .order("received_at", { ascending: false })
    .limit(200);
  if (filter !== "all") q = q.eq("status", filter);
  const { data, error } = await q;
  const rows = (data ?? []) as unknown as Row[];

  return (
    <div className="space-y-6">
      <div>
        <h1 className="font-display text-3xl">Enquiries</h1>
        <p className="mt-1 text-sm text-ink-2">Every phone enquiry, with its outcome and the reason for it.</p>
      </div>
      <div className="flex flex-wrap gap-2">
        {FILTERS.map((f) => (
          <Link key={f.key} href={f.key === "all" ? "/enquiries" : `/enquiries?status=${f.key}`} className={cn("rounded-full border px-3 py-1 text-sm", filter === f.key ? "border-ink bg-ink text-white" : "border-line bg-surface text-ink-2 hover:text-ink")}>
            {f.label}
          </Link>
        ))}
      </div>
      <Card>
        {error ? (
          <p className="text-sm text-danger">Couldn&apos;t load enquiries: {error.message}</p>
        ) : rows.length === 0 ? (
          <Empty>No enquiries here yet.</Empty>
        ) : (
          <div className="-mx-5 -my-5 overflow-x-auto">
            <table className="w-full min-w-[760px] text-sm">
              <thead className="border-b border-line bg-sunken/50 text-left text-xs text-ink-3">
                <tr>
                  <th className="px-5 py-2.5 font-medium">Received</th>
                  <th className="px-3 py-2.5 font-medium">Caller</th>
                  <th className="px-3 py-2.5 font-medium">Project</th>
                  <th className="px-3 py-2.5 font-medium">Answered in</th>
                  <th className="px-3 py-2.5 font-medium">Outcome</th>
                  <th className="px-5 py-2.5 font-medium">Handoff</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {rows.map((r) => (
                  <tr key={r.id} className="hover:bg-sunken/40">
                    <td className="px-5 py-3 align-top whitespace-nowrap">
                      <Link href={`/enquiries/${r.id}`} className="font-medium hover:text-brand">{fmtWhen(r.received_at)}</Link>
                      {r.after_hours && <span className="mt-1 flex items-center gap-1 text-xs text-ink-3"><Moon className="size-3" /> after hours</span>}
                    </td>
                    <td className="px-3 py-3 align-top">
                      <p className="font-medium">{r.facts?.caller_name ?? r.aangan_contacts?.name ?? "Not provided"}</p>
                      <p className="text-xs text-ink-3">{r.aangan_contacts?.phone}</p>
                    </td>
                    <td className="max-w-xs px-3 py-3 align-top">
                      <p>{[r.facts?.bhk ? `${r.facts.bhk}BHK` : null, r.facts?.location_text].filter(Boolean).join(" · ") || "–"}</p>
                      {r.summary && <p className="mt-0.5 line-clamp-2 text-xs text-ink-3">{r.summary}</p>}
                    </td>
                    <td className="px-3 py-3 align-top tabular">
                      <span className={cn(r.within_sla === false && "text-danger")}>{fmtSecs(r.response_seconds)}</span>
                    </td>
                    <td className="px-3 py-3 align-top">
                      <StatusBadge status={r.status} />
                      {r.pricing_asked && <Badge className="ml-1">asked price</Badge>}
                    </td>
                    <td className="px-5 py-3 align-top">{r.status === "qualified" ? <HandoffBadge status={r.handoff_status} /> : <span className="text-xs text-ink-3">–</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}
