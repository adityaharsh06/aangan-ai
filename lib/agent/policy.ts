/**
 * Conversation policy: given what we know, decide the next thing the agent says.
 *
 * Design choice: the model understands (extraction), the rules decide (engine + this policy),
 * and approved templates speak. Templates are adapted from how Aangan's front desk actually
 * talks in the Sep 2026 calls, and every line is checked by the pricing guard.
 */
import type { Facts } from "@/lib/domain/facts";
import { evaluate, type Evaluation } from "@/lib/qualification/engine";
import { BUSINESS, SCRIPTS } from "@/lib/knowledge/rules";
import { assertCustomerSafe } from "./guard";
import type { AgentAction, DialogueState, TurnDecision } from "./types";

const MAX_CALLER_TURNS = 16;

export function isAfterHours(d: Date): boolean {
  const hour = Number(new Intl.DateTimeFormat("en-GB", { hour: "numeric", hour12: false, timeZone: BUSINESS.timezone }).format(d));
  const { startHour, endHour } = BUSINESS.frontDeskHours.value;
  return hour < startHour || hour >= endHour;
}

export function greeting(at: Date): string {
  const hour = Number(new Intl.DateTimeFormat("en-GB", { hour: "numeric", hour12: false, timeZone: BUSINESS.timezone }).format(at));
  const part = hour < 12 ? "Good morning" : hour < 17 ? "Good afternoon" : "Good evening";
  return `${part}, Aangan Studio. This is Kalyani, Aangan's virtual assistant. How can I help you today?`;
}

const firstName = (f: Facts) => (f.caller_name ? f.caller_name.split(" ")[0] : null);

function declineLine(ev: Evaluation, f: Facts): string {
  const failed = ev.criteria.filter((c) => c.status === "fail");
  if (failed.length >= 2) return `${SCRIPTS.decline.value} Thank you for calling Aangan Studio.`;
  const c = failed[0];
  switch (c.key) {
    case "real_project":
      if (["restaurant", "hotel", "retail", "gym"].includes(f.property_kind)) {
        return `Thank you for thinking of us. We focus on residential and office interiors, so ${f.property_kind} interiors are outside what we do. You'd be better served by a studio that specialises in them. Thank you for calling Aangan Studio.`;
      }
      return "We're a full-service studio: our projects include design and execution together, so we don't do advice-only or styling visits. If you decide to go ahead with a complete redesign, we'd love to hear from you. Thank you for calling Aangan Studio.";
    case "service_area":
      return "Thank you for calling. We only work in Pune city and PCMC at the moment, because our execution depends on our own contractors and vendors being on site. I'm sorry we can't help with this one.";
    case "timeline":
      return "Thank you for explaining. Our design phase alone takes 3 to 4 weeks, with execution after that, so we couldn't do justice to the project in that time. If a later completion date works for you, please call us again and we'd be glad to help.";
    case "budget":
      return "I appreciate you sharing that. Honestly, that would be significantly below what a project of that scope costs with us, and I wouldn't want to bring you to a consultation if the numbers don't align. Thank you for being straight with us, and for calling Aangan Studio.";
    case "decision_maker":
      return "Thank you. It would be best to speak once the people deciding on the project are ready to go ahead. Please feel free to call back then, or ask them to call us directly.";
  }
}

function questionFor(action: AgentAction, f: Facts, retry: boolean): string {
  const sorry = retry ? "Sorry, I didn't quite catch that. " : "";
  switch (action) {
    case "ask_scope":
      return `${sorry}What are you looking to do: which space, and which rooms?`;
    case "ask_real_project_direct":
      return `${sorry}Just to check: are you looking for full design with execution, or only advice and ideas?`;
    case "ask_location":
      return `${sorry}Where is the property? Which area of Pune or PCMC?`;
    case "ask_location_direct":
      return `${sorry}Is the site within Pune city or PCMC?`;
    case "ask_timeline":
      return `${sorry}${SCRIPTS.timelineQuestion.value}`;
    case "ask_timeline_confirm":
      return `${sorry}That's quite soon, so just to be sure: by when exactly do you need the project complete?`;
    case "ask_size":
      return f.property_category === "commercial"
        ? `${sorry}Roughly how big is the space, in square feet?`
        : `${sorry}Roughly how big is the home: how many BHK, and the carpet area if you know it?`;
    case "ask_current_state":
      return `${sorry}What's the current state of the space: bare shell, a new possession, or are you living there now?`;
    case "ask_decision_maker":
      return f.property_category === "commercial" ? `${sorry}Are you the one deciding on this project?` : `${sorry}Are you the owner, and the one deciding on the project?`;
    case "ask_name":
      return `${sorry}May I have your name, please?`;
    case "ask_slot":
      return `${sorry}A designer will meet you for a free consultation, and they can come to your site if you prefer. Which days or times suit you best?`;
    case "ask_email":
      return `${sorry}So we can email you a calendar invite, what's your email address? You can spell it out.`;
    case "ask_existing_details":
      return `${sorry}I'm sorry to hear that. Could you tell me your name, and which designer or project this is about?`;
    default:
      return "";
  }
}

function closeQualified(f: Facts, after: boolean, booking: boolean): string {
  const n = firstName(f);
  const slot = f.preferred_slots.length ? ` For the consultation, I've noted: "${f.preferred_slots[f.preferred_slots.length - 1].replace(/[.\s]+$/, "")}".` : "";
  const when = after ? " during studio hours (from 10am)" : " shortly";
  // The booking happens after the call, so no specific time is promised here (decision 4).
  const invite = booking && f.email ? " You'll get a calendar invite by email for the first open time that matches." : "";
  const number = f.callback_phone ? "" : " on this number";
  return `Thank you${n ? `, ${n}` : ""}. I've noted everything you've told me, so you won't need to repeat it.${slot}${invite} One of our designers will call you${number}${when} to confirm the consultation. Is there anything else you'd like them to know?`;
}

/** Decide the next action from the current facts. Pure: no I/O. */
export function decide(f: Facts, prev: DialogueState, opts: { pricingAskedThisTurn: boolean; factsChanged: boolean; at: Date; collectEmail?: boolean }): TurnDecision {
  const state: DialogueState = { ...prev, asked: { ...prev.asked }, criterionAsked: { ...prev.criterionAsked } };
  state.callerTurns += 1;
  const ev = evaluate(f, state.criterionAsked);
  const after = isAfterHours(opts.at);

  // Confusion: the caller's turn added nothing and wasn't a pricing question.
  const confused = !opts.factsChanged && !opts.pricingAskedThisTurn && state.lastAction !== null && state.lastAction.startsWith("ask_");
  if (confused) state.confusion += 1;

  const done = (action: AgentAction, reply: string, reason: DialogueState["closeReason"]): TurnDecision => {
    state.phase = action === "goodbye" ? "closed" : "closing";
    state.closeReason = reason;
    state.lastAction = action;
    return { action, reply: assertCustomerSafe(reply), state, evaluation: ev, facts: f };
  };
  const ask = (action: AgentAction, prefix = ""): TurnDecision => {
    const retry = state.lastAction === action;
    state.asked[action] = (state.asked[action] ?? 0) + 1;
    state.lastAction = action;
    const reply = `${prefix}${questionFor(action, f, retry && !prefix)}`.trim();
    return { action, reply: assertCustomerSafe(reply), state, evaluation: ev, facts: f };
  };
  const times = (a: AgentAction) => state.asked[a] ?? 0;

  // Already closing: one more caller turn, then goodbye.
  // A declined caller who changes the picture (e.g. "actually we could finish by March") is re-assessed.
  const reopened = prev.phase === "closing" && prev.closeReason === "unqualified" && opts.factsChanged && ev.outcome !== "unqualified";
  if (reopened) {
    state.phase = "open";
    state.closeReason = null;
  }
  if (prev.phase === "closing" && !reopened) {
    const pricing = opts.pricingAskedThisTurn ? `${SCRIPTS.pricing.value} ` : "";
    const note = opts.factsChanged && !pricing ? "Thank you, I've added that to your notes. " : "";
    return done("goodbye", `${pricing}${note}Thank you for calling Aangan Studio. Have a lovely day.`, prev.closeReason);
  }

  if (state.confusion >= 3 || state.callerTurns > MAX_CALLER_TURNS) {
    return done("close_callback", "I'm sorry, I don't want to keep you on the line. I'll ask someone from the studio team to call you back on this number. Thank you for calling Aangan Studio.", "callback");
  }

  // Pricing: verbatim script, never a number (pricing.md). Does not disqualify (qualified.md).
  const prefix = opts.pricingAskedThisTurn ? `${SCRIPTS.pricing.value} ` : "";
  if (opts.pricingAskedThisTurn) state.pricingAnswered += 1;

  if (f.call_type === "existing_client") {
    if ((!f.caller_name || !f.existing_project_note) && times("ask_existing_details") < 1) return ask("ask_existing_details", prefix);
    return done(
      "close_escalated",
      `${prefix}Thank you${firstName(f) ? `, ${firstName(f)}` : ""}. I'm alerting the studio's senior team right now with your details, and someone senior will call you back on this number as soon as possible. I'm sorry for the trouble.`,
      "escalated",
    );
  }
  if (f.call_type === "other") {
    if (!f.caller_name && times("ask_name") < 1) return ask("ask_name", prefix);
    return done("close_other", `${prefix}Thank you. I'll pass your message to the studio team and someone will get back to you. Thank you for calling Aangan Studio.`, "other");
  }

  // A clear failure: close gracefully, don't forward (qualified.md; decision U1).
  if (ev.outcome === "unqualified") return done("close_unqualified", `${prefix}${declineLine(ev, f)}`, "unqualified");

  // Criteria 1–3 unclear: ask (open question first, then one direct question).
  for (const key of ev.blockingUnclear) {
    if (key === "real_project") {
      if (times("ask_scope") < 1) return ask("ask_scope", prefix);
      if (times("ask_real_project_direct") < 1) {
        state.criterionAsked.real_project = true;
        return ask("ask_real_project_direct", prefix);
      }
    }
    if (key === "service_area") {
      if (times("ask_location") < 1) return ask("ask_location", prefix);
      if (times("ask_location_direct") < 1) {
        state.criterionAsked.service_area = true;
        return ask("ask_location_direct", prefix);
      }
    }
    if (key === "timeline") {
      if (f.weeks_until_needed === null && times("ask_timeline") < 1) return ask("ask_timeline", prefix);
      if (f.weeks_until_needed !== null && times("ask_timeline_confirm") < 1) {
        state.criterionAsked.timeline = true;
        return ask("ask_timeline_confirm", prefix);
      }
      state.criterionAsked.timeline = true;
    }
  }
  // Re-evaluate in case marking a criterion as asked resolved it (e.g. tight-but-possible timeline).
  const ev2 = evaluate(f, state.criterionAsked);
  if (ev2.outcome === "unqualified") return { ...done("close_unqualified", `${prefix}${declineLine(ev2, f)}`, "unqualified"), evaluation: ev2 };
  if (ev2.outcome === "pending") {
    // Asked, still unclear: hand to a human rather than guess (assumption, see README).
    return {
      ...done("close_needs_review", `${prefix}Thank you for all of that. I'll pass your details to our team so the right person can call you back and take this forward. ${after ? "They'll call during studio hours, from 10am. " : ""}Thank you for calling Aangan Studio.`, "needs_review"),
      evaluation: ev2,
    };
  }

  // Qualified so far: gather what the designer would otherwise have to ask (each asked once).
  if (f.carpet_area_sqft === null && f.bhk === null && times("ask_size") < 1) return ask("ask_size", prefix);
  if (!f.current_state && times("ask_current_state") < 1) return ask("ask_current_state", prefix);
  if (f.decision_maker === "unknown" && times("ask_decision_maker") < 1) return ask("ask_decision_maker", prefix);
  if (!f.caller_name && times("ask_name") < 1) return ask("ask_name", prefix);
  if (f.preferred_slots.length === 0 && times("ask_slot") < 1) return ask("ask_slot", prefix);
  if (opts.collectEmail && !f.email && times("ask_email") < 1) return ask("ask_email", prefix);

  return { ...done("close_qualified", `${prefix}${closeQualified(f, after, Boolean(opts.collectEmail))}`, "qualified"), evaluation: ev2 };
}
