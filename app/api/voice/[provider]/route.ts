import { NextResponse, type NextRequest } from "next/server";
import { getVoiceProvider } from "@/lib/providers/voice";
import { handleVoiceEvent } from "@/lib/server/pipeline";

export const maxDuration = 60;

/**
 * Inbound telephony webhook. Each provider adapter authenticates and normalises its own payload;
 * the pipeline is provider-agnostic. If processing fails we still answer with a safe line so the
 * caller is never left in silence, and the error is in the logs / audit trail.
 */
export async function POST(req: NextRequest, ctx: RouteContext<"/api/voice/[provider]">) {
  const { provider: name } = await ctx.params;
  const provider = getVoiceProvider(name);
  if (!provider) return NextResponse.json({ error: "unknown provider" }, { status: 404 });
  const raw = await req.text();
  if (!provider.verify(req.headers, raw)) return NextResponse.json({ error: "unauthorised" }, { status: 401 });
  let evt;
  try {
    evt = provider.parse(JSON.parse(raw));
  } catch (e) {
    return NextResponse.json({ error: `invalid event: ${(e as Error).message}` }, { status: 400 });
  }
  try {
    return NextResponse.json(provider.render(await handleVoiceEvent(provider.name, evt)));
  } catch (e) {
    console.error("voice pipeline error", e);
    return NextResponse.json(
      provider.render({ say: "I'm sorry, I'm having trouble on my side. Someone from Aangan Studio will call you back on this number shortly.", endCall: evt.type === "call.started" ? false : true }),
      { status: 200 },
    );
  }
}
