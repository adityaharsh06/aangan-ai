import type { Facts } from "@/lib/domain/facts";
import type { AskedMap, Evaluation } from "@/lib/qualification/engine";

export interface Turn {
  role: "agent" | "caller";
  text: string;
  at: string; // ISO timestamp
}

export type AgentAction =
  | "greet"
  | "ask_scope"
  | "ask_real_project_direct"
  | "ask_location"
  | "ask_location_direct"
  | "ask_timeline"
  | "ask_timeline_confirm"
  | "ask_size"
  | "ask_current_state"
  | "ask_decision_maker"
  | "ask_name"
  | "ask_slot"
  | "ask_email"
  | "ask_existing_details"
  | "close_qualified"
  | "close_unqualified"
  | "close_escalated"
  | "close_other"
  | "close_needs_review"
  | "close_callback"
  | "goodbye";

export type CloseReason = "qualified" | "unqualified" | "escalated" | "other" | "needs_review" | "callback";

export interface DialogueState {
  phase: "open" | "closing" | "closed";
  /** How many times each question has been asked. */
  asked: Partial<Record<AgentAction, number>>;
  /** Criteria whose one direct question has been asked (qualified.md "ask one direct question"). */
  criterionAsked: AskedMap;
  lastAction: AgentAction | null;
  confusion: number;
  pricingAnswered: number;
  callerTurns: number;
  closeReason: CloseReason | null;
}

export function initialDialogueState(): DialogueState {
  return { phase: "open", asked: {}, criterionAsked: {}, lastAction: null, confusion: 0, pricingAnswered: 0, callerTurns: 0, closeReason: null };
}

export interface TurnDecision {
  action: AgentAction;
  reply: string;
  state: DialogueState;
  evaluation: Evaluation;
  facts: Facts;
}
