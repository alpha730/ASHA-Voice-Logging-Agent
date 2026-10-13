# ASHA Voice Logging Agent

A health worker speaks a home visit in Hindi, English, or a mix. Speech is transcribed live, an
extraction agent turns it into a structured record and asks one clarifying question at a time, and the
visit appears on a supervisor dashboard. For a sick child from 2 months up to 5 years, the app then
runs the IMNCI sick-child assessment and shows what to tell the mother.

## Run it

```bash
npm install
cp .env.example .env.local   # fill in what you have
npm run dev                  # http://localhost:3000
npm run relay                # only for live speech with Sarvam (the default), ws://localhost:8787
```

Checks:

```bash
npm test                     # rule engine, advice, model resilience, clinician review
npm run typecheck
npm run build
```

Tests run on Node 24, which runs the `.ts` files directly.

Nothing is required to see the loop run. With no keys at all, `/record` still works through the
"type an utterance" box, extraction falls back to a rule-based parser, and visits are stored in
`data/visits.json`.

| Route | Who it is for |
| --- | --- |
| `/record` | The health worker. Start a visit, talk, answer the agent's questions, run the sick-child assessment. |
| `/dashboard` | Supervisors. Visits newest first, transcripts, follow-ups due, flagged vitals. |
| `/patients` | The patient register, with what each person is due or overdue for. |
| `/before-after` | The pitch slide: paper register beside the latest structured record. |
| `/review` | A clinician reviewing the IMNCI rules and advice. Not linked; 404 unless `REVIEW_ENABLED=true`. |

## Environment variables

Put them in `.env.local` locally, and in the Vercel (app) or Render (relay) settings when deployed.
Never commit keys.

| Variable | What it does | When unset |
| --- | --- | --- |
| `STT_PROVIDER` | `sarvam` (default) or `assemblyai`. | Sarvam. |
| `SARVAM_API_KEY` | Sarvam key. Held by the relay; the browser never sees it. | No live speech with Sarvam; type instead. |
| `STT_RELAY_URL` | Where the browser reaches the relay. `wss://` once the app is on https. | `ws://localhost:8787`. |
| `SARVAM_MODEL`, `SARVAM_LANGUAGE_CODE`, `SARVAM_KEYTERMS` | Model, language (`hi-IN` or `auto`), and domain terms (`saaras:v4` only). | `saaras:v3-realtime`, `hi-IN`, none. |
| `PORT` or `STT_RELAY_PORT` | Port the relay listens on (Render sets `PORT`). | 8787. |
| `ASSEMBLYAI_API_KEY`, `ASSEMBLYAI_SPEECH_MODEL`, `ASSEMBLYAI_KEYTERMS` | Used only with `STT_PROVIDER=assemblyai`. | No AssemblyAI streaming. |
| `LLM_API_KEY`, `LLM_MODEL`, `LLM_BASE_URL` | The language model for extraction. The base URL picks the dialect: OpenAI-compatible (Groq by default) or Gemini's native API. | Rule-based extraction only. |
| `LLM_FALLBACK_MODEL`, `LLM_FALLBACK_BASE_URL`, `LLM_FALLBACK_API_KEY` | A second model, tried after the primary fails. The model alone means the same provider and key; another provider needs its own URL and key. | No fallback. |
| `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` | Postgres storage. Run [supabase/schema.sql](supabase/schema.sql) first. | `data/*.json`. |
| `REVIEW_ENABLED` | `true` turns on `/review`. | `/review` returns 404. |

## How a visit flows

1. The worker holds the mic button and speaks. [app/record/page.tsx](app/record/page.tsx) captures the
   mic only while the button is held, downsamples to 16 kHz PCM16 in
   [public/pcm-worklet.js](public/pcm-worklet.js), and streams it to the speech service.
2. [app/api/transcribe/route.ts](app/api/transcribe/route.ts) returns a short-lived streaming URL. With
   Sarvam, the browser connects to the relay ([scripts/stt-relay.ts](scripts/stt-relay.ts), deployed on
   Render by [render.yaml](render.yaml)), which holds the key. Vercel cannot hold WebSockets open.
3. On release, the browser sends `{"type":"ForceEndpoint"}`. The relay turns it into Sarvam's
   `speech_end` and `flush`, so the final words come back at once as one turn.
4. Each turn goes to [app/api/extract/route.ts](app/api/extract/route.ts), which extracts only what that
   utterance stated, merges it into the record, and returns one question for the next gap.
5. The browser speaks the question and mutes the mic while speaking.
6. Once the required fields are present, the agent reads back a summary and saves the visit.

Saying "that's wrong" or "galat hai" clears the last field filled and asks for it again.

### The mic button

The mic button, [lib/holdToTalk.ts](lib/holdToTalk.ts) and [app/record/MicButton.tsx](app/record/MicButton.tsx):

- **Hold to talk (default).** Press and hold, or hold the spacebar while the button is focused. The
  stream uses Sarvam's manual endpointing: the relay sends `speech_start` before the first audio of each
  press and `speech_end` plus `flush` on release.
- **Short presses.** A press under 300 ms is dropped with a hint, and nothing is sent.
- **Ending a press.** Lifting the finger, a cancelled touch, or sliding off the button all end the press.
- **Agent speaking.** Pressing while the agent is speaking stops the speech.
- **Tap to start and stop.** Set in the "Mic" selector. One press starts and the next stops.
- **No recording outside a press.** In both modes the microphone is released as soon as recording
  stops. The setting is remembered on the device.

### Languages: Hindi, English, Marwari

The "Agent speaks" choice is remembered on the device. Everything the app says comes from
[ui-text.json](ui-text.json), read with `t(id, lang)` from [lib/text.ts](lib/text.ts). Clinical text comes
from the protocol and counselling files.

- **Speech-to-text.** Saaras does not list Marwari, so Marwari mode transcribes as Hindi (`hi-IN`, never
  auto-detect) with code-mixing.
- **Text-to-speech.** Marwari text is Devanagari, so the Hindi voice speaks it.
- **Marwari wording.**
  - Every string can carry an optional `mwr` entry with `reviewed_by` and `reviewed_on`.
  - Without that review, or with different `{placeholders}` from the Hindi, the Hindi is shown and
    spoken instead.
  - Advice entries switch to Marwari only when the title and every step are filled.
  - The app writes no Marwari itself.
- **Adding Marwari.**
  1. A native speaker fills [marwari-todo.json](marwari-todo.json): one item per string, with its id,
     where it appears, the English and the Hindi.
  2. Run `node scripts/apply-marwari.ts marwari-todo.json`. It refuses a file without a reviewer name.
  3. After changing any text, run `node scripts/marwari-todo.ts` to refresh the list (filled items are kept).
- **Answer words.** Marwari yes, no and "don't know" words go in
  [marwari-answers.json](marwari-answers.json), which starts empty. "Don't know" is checked first, so it
  is never read as "no". Yes and no words count only when the Hindi and English words don't decide. The
  app refuses to start if a word would change how a reference Hindi or English answer is read.

Visits are linked to a patient register, and the visit is classified into a protocol (maternal ANC,
child immunization, and so on) so only that protocol's fields are asked. The due-date engine in
[lib/schedule.ts](lib/schedule.ts) is date arithmetic against the immunization and ANC schedules, with
no model involved.

## IMNCI sick-child assessment

For a sick child from 2 months up to 5 years, [app/api/triage/route.ts](app/api/triage/route.ts) runs
the 2023 IMNCI health-worker chart booklet, encoded in
[imnci-sick-child-2m-5y.json](imnci-sick-child-2m-5y.json) and evaluated by
[lib/imnci/rules.ts](lib/imnci/rules.ts).

Safety rules, each covered by tests:

- Danger signs are asked first. Any general danger sign ends the questions and gives URGENT REFERRAL.
- Any pink classification gives urgent referral.
- A sign that was not assessed never produces a green result. "Pata nahi", "did not check" or "skip"
  marks the sign not assessed and moves on, and is never read as "no". A table that reads an
  unassessed sign stays pending rather than ending on a green row.
- The booklet's treatment column (`imnci_action`) is never shown. The app shows `asha_action` only.
- Nothing from a model decides a classification. The model only maps her words to sign ids;
  measurements (breath count, SpO2, MUAC, skin pinch) are parsed from her answer, never from a model.

The child's age is read from the visit sentence ("teen saal ka hai"), or from a patient record that
existed before the visit, and asked only when neither gives a clear age.

### What to tell the mother

[counselling.json](counselling.json) holds the caregiver advice the result card shows and can read
aloud. Every step is taken from the booklet, or from the 2023 facilitator guide for ORS preparation,
with a page number and an exact quote. A test checks each quote against the page text kept in
[sources/imnci-2023/](sources/imnci-2023/). Drug doses and treatment are left out.

- `held_steps`: source text kept in the file but never shown or read aloud until a clinician decides
  (currently honey and home remedies for cough).
- `app_notes`: wording written by the app, labelled on the card as "App note, not from the booklet",
  and never counted as verified.
- `open_question`: a question for the clinician review page.

### When the model is down

Every model call goes through [lib/llm.ts](lib/llm.ts). It makes up to 3 attempts with exponential
backoff and jitter, retrying only on 429, 500, 502, 503 and timeouts. It then tries the fallback model
if one is configured. If every provider fails:

- The assessment carries on with the parsers that need no model (yes or no, counts, days, ages) and
  asks the worker to repeat any answer that needed the model. No answer is ever filled in for her.
- Visit extraction uses the rule-based reader, and the worker is told to repeat anything it missed.

Error messages name the provider, model and HTTP status only. They never include keys, transcripts or
the provider's response body.

## Clinician review workflow

Each rule and advice entry carries `source_check.method`:

- `ai-compared-to-booklet`: compared with the booklet by software.
- `clinician-reviewed`: confirmed by a named clinician.
- `not-confirmed`: not found in the source, with a reason.

The card warns until everything behind a result is clinician-reviewed.

1. Deploy or run with `REVIEW_ENABLED=true` and send the clinician to `/review`.
2. The page lists the open decisions first. Then it lists every rule (signs and thresholds, band,
   follow-up days, what the app tells the ASHA, page and exact quote) and every advice entry. The
   clinician marks each item Correct, Wrong or Needs change, with a comment.
3. A reviewer name and date are required to export. Answers stay in that browser; nothing is written to
   the database. "Export JSON" downloads the file.
4. Apply it:

   ```bash
   node scripts/apply-review.ts imnci-review-2026-10-20-dr-name.json --dry-run   # report only
   node scripts/apply-review.ts imnci-review-2026-10-20-dr-name.json
   ```

   Only items marked Correct, whose page and quote still match what the reviewer saw, become
   `clinician-reviewed` with the reviewer's name and date. Wrong and Needs change items, and the open
   decisions, are listed for you to act on. Items the file does not mention are never touched. A file
   without a reviewer name, or with items that are not in the current files, is refused.
5. Commit the changed JSON files.

## Branch status

- Work is on `imnci-verified`, which is ahead of `main` by the IMNCI commits and is not pushed.
- `backup-before-coauthor-removal` is an old safety branch from the history rewrite.
- Before deploying this branch, run the one schema line it needs on the live database (it is already in
  [supabase/schema.sql](supabase/schema.sql)):

  ```sql
  alter table visits add column if not exists imnci_triage jsonb;
  ```

- The source PDFs came from the NHM Mizoram mirror because nhm.gov.in was unreachable. Their SHA-256
  hashes are recorded in the JSON files; compare them with official copies when possible.

## Design decisions worth knowing

- Extraction prompts forbid guessing. Anything not spoken stays `null`, because a hallucinated vital
  sign is worse than a blank one. Model output is re-validated before it is used.
- `raw_transcript` is stored on every visit and shown on the dashboard, so any extraction error can be
  checked against what was said.
- Required fields are checked server-side in [types/visit.ts](types/visit.ts), so the agent asks about
  the same gaps whichever client is talking to it.
- The dashboard flags fever at or above 39°C, SpO2 under 94%, and BP at or above 140/90.
- The app logs and flags. It never diagnoses, and the IMNCI result says so.
