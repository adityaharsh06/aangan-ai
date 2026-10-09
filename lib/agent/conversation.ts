/**
 * One phone call as a sequence of turns. Stateless between requests: the caller of these
 * functions persists `CallSession` (we keep it on the call row in the database).
 */
import { emptyFacts, mergeFacts, type Facts } from "@/lib/domain/facts";
import type { Evaluation } from "@/lib/qualification/engine";
import { extractFacts, type ExtractResult } from "./extract";
import { decide, greeting } from "./policy";
import { initialDialogueState, type AgentAction, type DialogueState, type Turn } from "./types";

export interface CallSession {
  facts: Facts;
  dialogue: DialogueState;
  turns: Turn[];
}

export interface TurnOutcome {
  session: CallSession;
  reply: string;
  action: AgentAction;
  endCall: boolean;
  evaluation: Evaluation;
  extraction: ExtractResult;
}

const PRICE_QUESTION = /how much|cost|price|pricing|\brates?\b|ballpark|\brange\b|charges?|per sq|estimate|quot(e|ation)|kitna|kharcha/i;
const SIGN_OFF = /^\s*(no|nope|nothing|that'?s (all|it)|all good|thanks?|thank you|ok(ay)?|bye)\b/i;
const TERMINAL: AgentAction[] = ["goodbye", "close_unqualified", "close_escalated", "close_other", "close_needs_review", "close_callback"];

export function startCall(at: Date): { session: CallSession; reply: string } {
  const reply = greeting(at);
  return {
    reply,
    session: { facts: emptyFacts(), dialogue: initialDialogueState(), turns: [{ role: "agent", text: reply, at: at.toISOString() }] },
  };
}

export async function callerTurn(prev: CallSession, text: string, at: Date, callStartedAt: Date): Promise<TurnOutcome> {
  const turns: Turn[] = [...prev.turns, { role: "caller", text: text.trim(), at: at.toISOString() }];
  const extraction = await extractFacts(turns, callStartedAt);
  const facts = mergeFacts(prev.facts, extraction.facts);
  // "No, that's all" at the close adds nothing, even if the model notes it somewhere.
  // Short replies only, so "No wait, we could finish by March" can still reopen a declined call.
  const signOff = prev.dialogue.phase === "closing" && SIGN_OFF.test(text) && text.trim().split(/\s+/).length <= 6;
  const factsChanged = !signOff && JSON.stringify({ ...facts, pricing_asked: false }) !== JSON.stringify({ ...prev.facts, pricing_asked: false });
  const pricingAskedThisTurn = PRICE_QUESTION.test(text);
  if (pricingAskedThisTurn) facts.pricing_asked = true;

  // Office-hours wording follows when the call came in, not when each sentence was said.
  const d = decide(facts, prev.dialogue, { pricingAskedThisTurn, factsChanged, at: callStartedAt });
  // Non-question closes end the call after the caller has had one chance to respond.
  const endCall = d.action === "goodbye";
  turns.push({ role: "agent", text: d.reply, at: new Date().toISOString() });
  return {
    session: { facts: d.facts, dialogue: d.state, turns },
    reply: d.reply,
    action: d.action,
    endCall,
    evaluation: d.evaluation,
    extraction,
  };
}

export function isTerminal(a: AgentAction): boolean {
  return TERMINAL.includes(a);
}
