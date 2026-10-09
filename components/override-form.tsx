"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Loader2 } from "lucide-react";

const OPTIONS = [
  { value: "qualified", label: "Qualified: send to designers" },
  { value: "unqualified", label: "Not a fit" },
  { value: "needs_review", label: "Needs review" },
  { value: "escalated", label: "Escalated (existing client)" },
  { value: "other", label: "Other (not an enquiry)" },
];

export function OverrideForm({ enquiryId, current }: { enquiryId: string; current: string }) {
  const router = useRouter();
  const [status, setStatus] = useState(current === "qualified" ? "unqualified" : "qualified");
  const [reason, setReason] = useState("");
  const [by, setBy] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setMsg(null);
    const res = await fetch(`/api/enquiries/${enquiryId}/override`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ status, reason, by }) });
    const json = await res.json().catch(() => ({}));
    setBusy(false);
    if (!res.ok) return setMsg({ ok: false, text: json.error ?? "Override failed" });
    setMsg({ ok: true, text: status === "qualified" ? "Saved. Handoff queued to designers." : "Saved." });
    setReason("");
    router.refresh();
  }

  return (
    <form onSubmit={submit} className="space-y-3 text-sm">
      <select value={status} onChange={(e) => setStatus(e.target.value)} className="h-9 w-full rounded-lg border border-line bg-surface px-2">
        {OPTIONS.map((o) => (
          <option key={o.value} value={o.value}>{o.label}</option>
        ))}
      </select>
      <textarea value={reason} onChange={(e) => setReason(e.target.value)} required minLength={5} maxLength={500} rows={2} placeholder="Reason (required), e.g. 'Called back: site is in Kharadi, timeline March'" className="w-full rounded-lg border border-line bg-surface px-3 py-2" />
      <input value={by} onChange={(e) => setBy(e.target.value)} required minLength={2} maxLength={80} placeholder="Your name (recorded in the audit trail)" className="h-9 w-full rounded-lg border border-line bg-surface px-3" />
      <div className="flex items-center gap-3">
        <button disabled={busy || reason.trim().length < 5 || by.trim().length < 2} className="flex items-center gap-1.5 rounded-lg bg-ink px-3 py-1.5 font-medium text-white disabled:opacity-50">
          {busy && <Loader2 className="size-3.5 animate-spin" />} Save override
        </button>
        {msg && <span className={msg.ok ? "text-sage" : "text-danger"}>{msg.text}</span>}
      </div>
    </form>
  );
}
