import { z } from "zod";
import { HttpError, handle } from "@/lib/server/http";
import { serviceDb } from "@/lib/supabase/server";
import { queueHandoffAfterOverride } from "@/lib/server/pipeline";
import { audit } from "@/lib/server/audit";

const Body = z.object({
  status: z.enum(["qualified", "unqualified", "needs_review", "escalated", "other"]),
  reason: z.string().trim().min(5).max(500),
  by: z.string().trim().min(2).max(80),
});

/**
 * Human override: correct the automated outcome. There is no login, so the reviewer types their
 * name; the change, the reason and the name are written to the enquiry and the audit trail.
 */
export async function POST(req: Request, ctx: RouteContext<"/api/enquiries/[id]/override">) {
  return handle(async () => {
    const { id } = await ctx.params;
    if (!/^[0-9a-f-]{36}$/.test(id)) throw new HttpError("Enquiry not found", 404);
    const body = Body.parse(await req.json());
    const db = serviceDb();
    const prev = await db.from("aangan_enquiries").select("status, handoff_status").eq("id", id).maybeSingle();
    if (prev.error) throw new Error(prev.error.message);
    if (!prev.data) throw new HttpError("Enquiry not found", 404);

    const now = new Date().toISOString();
    const upd = await db
      .from("aangan_enquiries")
      .update({
        status: body.status,
        override_status: body.status,
        override_reason: body.reason,
        override_by: body.by,
        override_at: now,
        updated_at: now,
        ...(body.status === "qualified" && prev.data.handoff_status === "not_required" ? { handoff_status: "pending" } : {}),
      })
      .eq("id", id);
    if (upd.error) throw new Error(upd.error.message);
    await audit({ enquiryId: id, event: "status.overridden", status: "info", metadata: { from: prev.data.status, to: body.status, reason: body.reason, by: body.by } });

    if (body.status === "qualified") await queueHandoffAfterOverride(id);
    return { ok: true };
  });
}
