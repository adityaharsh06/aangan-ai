import type { Metadata } from "next";
import { Simulator } from "@/components/simulator";
import { configStatus } from "@/lib/env";
import { Badge } from "@/components/ui";

export const metadata: Metadata = { title: "Call simulator" };
export const dynamic = "force-dynamic";

export default function SimulatorPage() {
  const cfg = configStatus();
  return (
    <div className="space-y-6">
      <div>
        <h1 className="font-display text-3xl">Call simulator</h1>
        <p className="mt-1 max-w-2xl text-sm text-ink-2">
          Test the phone assistant before a voice provider is connected. Calls made here are real enquiries in the database (provider &ldquo;simulator&rdquo;) and appear on the dashboard.
        </p>
        <div className="mt-3 flex flex-wrap gap-2 text-xs">
          <Badge tone={cfg.gemini ? "good" : "warn"}>{cfg.gemini ? `Gemini: ${cfg.model}` : "Gemini not configured: rules-only fallback"}</Badge>
          <Badge tone={cfg.telegram ? "good" : "warn"}>{cfg.telegram ? "Telegram connected" : "Telegram not configured: handoffs queue"}</Badge>
          <Badge>Voice: {cfg.voice}</Badge>
        </div>
      </div>
      <Simulator />
    </div>
  );
}
