"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Loader2, RotateCw } from "lucide-react";

export function RetryButton({ enquiryId, label = "Retry deliveries" }: { enquiryId?: string; label?: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  async function run() {
    setBusy(true);
    setMsg(null);
    const res = await fetch(`/api/outbox/retry${enquiryId ? `?enquiry=${enquiryId}` : ""}`, { method: "POST" });
    const json = await res.json().catch(() => ({}));
    setBusy(false);
    setMsg(res.ok ? `${json.attempted ?? 0} attempted` : json.error ?? "Failed");
    router.refresh();
  }
  return (
    <span className="flex items-center gap-2">
      {msg && <span className="text-xs text-ink-3">{msg}</span>}
      <button onClick={run} disabled={busy} className="flex items-center gap-1.5 rounded-md border border-line px-2.5 py-1 text-xs font-medium hover:bg-sunken disabled:opacity-60">
        {busy ? <Loader2 className="size-3.5 animate-spin" /> : <RotateCw className="size-3.5" />}
        {label}
      </button>
    </span>
  );
}
