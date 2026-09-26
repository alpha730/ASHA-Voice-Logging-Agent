# ASHA Voice Logging Agent

A health worker speaks a home visit in Hindi, English, or a mix. AssemblyAI streams the transcript, an
extraction agent turns it into a structured record, asks one clarifying question if a required field is
missing, and the visit appears on a supervisor dashboard seconds later.

## Run it

```bash
npm install
cp .env.example .env.local   # fill in what you have
npm run dev                  # http://localhost:3000
```

Pages:

| Route | Who it is for |
| --- | --- |
| `/record` | The health worker. Start visit, talk, answer the agent's question. |
| `/dashboard` | Supervisors. Visits newest first, transcripts, follow-ups due, flagged vitals. |
| `/patients` | The patient register, with what each person is due or overdue for. |
| `/before-after` | The pitch slide: paper register beside the latest structured record. |

Nothing is required to see the loop run. With no keys at all, `/record` still works through the
"type an utterance" box, extraction falls back to a rule-based parser, and visits are stored in
`data/visits.json`.

## Environment variables

| Variable | Effect when unset |
| --- | --- |
| `ASSEMBLYAI_API_KEY` | Live mic streaming is disabled. Use the typed-utterance box instead. |
| `ASSEMBLYAI_SPEECH_MODEL` | AssemblyAI's default streaming model is used. Set this to the Universal-3.5 Pro Streaming id, which is the tier that supports Hindi and code-switching. |
| `ASSEMBLYAI_KEYTERMS` | No keyterm prompting. Comma-separated domain terms bias recognition toward village names, symptoms and vaccines. |
| `LLM_API_KEY`, `LLM_MODEL`, `LLM_BASE_URL` | Extraction and protocol classification use the rule-based fallback in [lib/extraction.ts](lib/extraction.ts). |
| `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` | Visits and patients are written to `data/*.json` instead of Postgres. |

The extraction client speaks two dialects, chosen by the base URL. A `generativelanguage.googleapis.com`
URL uses Gemini's `generateContent` with a strict response schema; anything else uses OpenAI-compatible
chat completions, which covers Groq, OpenAI and OpenRouter. Switching providers is an env edit, not a
code change. Current setup is Groq.

For Supabase, run [supabase/schema.sql](supabase/schema.sql) in the SQL editor, then set the two variables.

## How a visit flows

1. [app/record/page.tsx](app/record/page.tsx) captures the mic, downsamples to 16 kHz PCM16 in
   [public/pcm-worklet.js](public/pcm-worklet.js), and streams it to AssemblyAI over a WebSocket.
2. [app/api/transcribe/route.ts](app/api/transcribe/route.ts) mints a temporary streaming token, so the
   API key never reaches the browser.
3. Partial transcripts render live. When AssemblyAI's endpointing marks the end of a turn, the formatted
   turn goes to [app/api/extract/route.ts](app/api/extract/route.ts).
4. That route extracts only what the new utterance stated, merges it into the running record, and returns
   the missing required fields plus one question to ask. Turns are queued client-side, so a fast second
   utterance never races the first extraction.
5. The browser speaks the question with `SpeechSynthesis` and mutes the mic while speaking.
6. Once worker name, household ID, at least one symptom or vital, and a follow-up date are present, the
   agent reads back a summary and saves the visit. Later corrections update the saved row in place.

Saying "that's wrong" or "galat hai" clears just the last field filled and re-asks for it, rather than
restarting the visit.

## Phase 5: patient records and protocols

Visits stopped being orphan notes. A name spoken during a visit is matched against the patient
register, registered once if new, and linked to the visit, so the app can answer "what is this
child overdue for?" on the next visit.

Extraction became two calls. First [protocol-extract.ts](lib/protocol-extract.ts) classifies the
visit, then it extracts against that protocol's fields only. A maternal visit is asked about
gestational month, blood pressure, IFA tablets and danger signs. An immunization visit is asked
about vaccines given and weight. Neither is asked the other's questions, and a generic "any
symptoms?" is skipped entirely once a protocol is driving the conversation.

The due-date engine in [schedule.ts](lib/schedule.ts) is pure date arithmetic against India's
Universal Immunization Programme schedule and the ANC checkup schedule. No model is involved, so
its output is always correct for a given date of birth or delivery date. It is covered by unit
tests for month-end clamping, overdue and grace-period boundaries, and doses already given.

The strongest demo moment is the read-back at the *start* of a visit. Type a name on the record
page, press "Check what is due", and the agent says what is pending before the worker says
anything, for example "Aarav is overdue for Pentavalent-1, by 107 days."

Two things it deliberately does not do. Age is asked once at registration and then read from the
record forever, because re-asking is what makes workers abandon an app. And the agent logs and
flags, it never diagnoses or recommends treatment.

Protocol coverage matches the planner: maternal and child immunization are fully built. Newborn
HBNC and chronic follow-up are classified and labelled, but reuse the general fields rather than
having their own question sets.

## Design decisions worth knowing

- The extraction prompt forbids guessing. Anything not spoken stays `null`, because a hallucinated vital
  sign is worse than a blank one. `normalize()` re-validates the model's output before it is trusted.
- `raw_transcript` is stored on every visit and shown on the dashboard, so any extraction error is
  auditable against what was actually said.
- Required fields are checked server-side in [types/visit.ts](types/visit.ts), so the agent asks about the
  same gaps whichever client is talking to it.
- The dashboard flags concerning vitals, currently fever at or above 39°C, SpO2 under 94%, and BP at or
  above 140/90.
- A stated month of pregnancy is converted into an approximate delivery date when none was given, so the
  ANC schedule is usable from the first visit. An exact date always wins over the estimate.
- LLM calls retry on rate limits and server errors, honouring the provider's stated wait. Free tiers
  throttle hard, and a live demo should not die on a 429.
