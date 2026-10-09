# Aangan AI

Phone enquiry handling for Aangan Studio, Pune (MESA AI & Its Applications, Case 03). Built in response to Nikhil Deshpande's ask: every enquiry answered within five minutes, day or night, and qualified leads reaching designers with everything already asked.

**In scope:** incoming phone calls. WhatsApp and the web form are out of scope. They could reuse the same pipeline, because facts → rules → handoff doesn't depend on the channel (`aangan_enquiries.source` already allows `whatsapp | web`).

## How it works

```
call.started → contact (dedup by phone) → enquiry → greeting   (SLA clock stops)
caller speaks → Gemini Flash extracts facts (rules fallback) → rules engine decides → approved template, pricing-guarded
call ends   → outcome + summary → outbox: Telegram handoff / alert, CRM, scheduling → dashboard
```

- **The model understands; the rules decide.** Gemini only turns speech into validated `Facts` (zod). Qualification is deterministic (`lib/qualification/engine.ts`). Every reply comes from an approved template (`lib/agent/policy.ts`).
- **The database is written first.** Telegram, CRM and scheduling go through a retry outbox, so an outage never loses a lead.
- Webhooks are idempotent. Every step is in `aangan_events` (audit trail). Every Gemini call and connected minute is costed in `aangan_cost_events`.
- Any outcome can be overridden by a named reviewer. Overrides are audited, and overriding to "qualified" sends the designer handoff.

## Requirements, inferences and recommendations

**Required by the assignment / sources**
- Answer every call, including after hours. Measure first response against the five-minute target.
- Qualify against the five criteria in `qualified.md`, follow its boundary rules and use its decline line verbatim.
- Never quote a price: `pricing.md` forbids any number, range or per-sq-ft figure. The agent says the verbatim pricing line instead. This is **the Cut**: Nikhil asked for per-sq-ft quoting, and his own guide rules it out. In T02 and T13, callers who were refused a price still booked.
- Hand designers the full context (Telegram, see below). Show on a dashboard what the system produces and what it costs, including its own cost.

**Inferred (decisions agreed with the founder's office)**
- U1: any single failed criterion means the lead is not forwarded. Two or more failures use the exact decline line.
- U2: needed in under 6 weeks fails. Between 6 and 10 weeks, the agent asks once, then passes the lead with a "tight timeline" note.
- No booked slot is promised on the call. The caller's preferred slots are captured, and a designer confirms them.

**Assumptions to confirm with Nikhil** (marked `assumption: true` in `lib/knowledge/rules.ts` and shown on the Rules page)
- U3: commercial spaces under 500 sq ft are flagged, not failed. The 500 figure comes only from transcript T18.
- U4: Pune and PCMC localities not named in `services.md` (Kharadi, Nanded City, …) count as served.
- "Clearly below" budget means under 50% of the lowest indicative cost for the scope.
- Commercial spaces up to 3,600 sq ft are flagged rather than failed, because the guide says "approximately 3,000".
- If a criterion is still unclear after one direct question, the enquiry goes to `needs_review` with a callback alert.
- "No deadline" or "flexible" is recorded as 26 weeks.
- An existing-client complaint (T09) is escalated rather than qualified.
- A caller who gets cut off and rings back within 60 minutes resumes the same enquiry (T17).

**Recommended, not built yet:** Vaani Labs voice adapter, HubSpot CRM, Calendly (see Phases).

## Why Telegram, not email, for the designer handoff
Leads answered within an hour convert at 4× the rate of next-day leads. Designers are often on site visits, so the note has to reach their phones as a push. Escalations need to be seen instantly. Email's one advantage, a permanent record, is already covered by the database record and the audit trail.

Source inconsistency: the case PDF's instruction for the Cut says "Arjun" where it means Nikhil.

## Running locally

Node 24. The project path contains `&` and `'`, which breaks npm's `.cmd` shims, so every script calls `node node_modules/...` directly.

```bash
npm install
npm run dev        # http://localhost:3000 (no login: access is by link)
npm test           # vitest: rules, conversation, transcripts, pricing guard, handoff, simulator scenarios
npm run typecheck
npm run eval       # 20 Sep phone transcripts → extraction → engine (uses Gemini if GEMINI_API_KEY is set)
npm run build
```

Copy `.env.example` to `.env.local`. Every variable is documented there. If a value is missing, that feature degrades instead of crashing:

| Missing | What happens instead |
|---|---|
| `GEMINI_API_KEY` | The rules-only extractor and template summaries are used |
| `TELEGRAM_*` | Handoffs queue as `not_configured`; use "Retry deliveries" once the keys are added |
| Cost variables | Cost shows as "unavailable", never as ₹0 |

## Pages
- **Dashboard**: SLA %, after-hours share, outcomes, fail reasons, handoffs, pricing questions, an indicative value (qualified × ₹8–14 L from the case brief, labelled as not a forecast) and running cost by provider.
- **Enquiries**: each record shows the designer brief, the criteria with reasons and sources, the transcript, deliveries, cost, the audit trail and the override control.
- **Call simulator**: play the caller, or use the scripted personas based on T01, T02, T03, T04, T07, T09, T10 and an after-hours office call. Calls go through the real pipeline.
- **Rules & sources**: the criteria, the verbatim scripts, the thresholds with their sources and assumption flags, and the raw source documents.

## Data
Supabase. All objects are prefixed `aangan_` (migration in `supabase/migrations/`), and RLS is on for every table. The server pipeline authenticates with the publishable key plus an `x-aangan-service` header, whose SHA-256 hash is checked in the database. The app has no login (it is an assessment build shared only with the instructor), so every page and API route reads and writes through that server-side connection; the secret never reaches the browser. The test-call simulator is capped at 30 calls per 10 minutes. Before real callers use it, put a login back in front of it: `aangan_staff` and the staff RLS policies are still in the database.

## Voice provider contract
`POST /api/voice/{provider}`. The generic `mock` provider accepts normalised JSON events (`call.started`, `caller.utterance`, `call.ended`, `call.missed`) authenticated by the `VOICE_WEBHOOK_SECRET` header, and replies with `{ say, endCall }`. A Vaani Labs adapter will implement `VoiceProvider` in `lib/providers/voice.ts` once its API documentation is available. Its API has not been guessed at.

## Phases
1. ✅ Core: rules, conversation, pipeline, dashboard, simulator
2. Gemini and Telegram keys → retest
3. Vaani Labs (voice) · 4. HubSpot (replays the `crm` outbox, dedup by phone/email) · 5. Calendly (from the `scheduling` outbox) · 6. Deploy on Vercel
