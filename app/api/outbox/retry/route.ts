import { handle } from "@/lib/server/http";
import { dispatch } from "@/lib/server/outbox";

/** Retry failed / not-yet-configured deliveries (e.g. after adding the Telegram bot token). */
export async function POST(req: Request) {
  return handle(async () => {
    const url = new URL(req.url);
    const enquiryId = url.searchParams.get("enquiry") ?? undefined;
    const results = await dispatch({ enquiryId, includeNotConfigured: true });
    return { attempted: results.length, results };
  });
}
