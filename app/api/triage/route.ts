import { NextResponse } from "next/server";
import { updateVisit } from "@/lib/db";
import { CORRECTION_RE } from "@/lib/agent";
import { extractSigns } from "@/lib/imnci/extract";
import {
  AGE_CORRECTION_RE,
  ageFromText,
  choiceLabels,
  inAgeBand,
  isUnknownAnswer,
  modelBusyRepeat,
  modelBusyStart,
  nextStep,
  outOfRangeMessage,
  promptText,
  STOP_RE,
  triageEntry,
  type Lang,
} from "@/lib/imnci/flow";
import { askIfChecker, PROTOCOL, STEPS } from "@/lib/imnci/protocol";
import { buildRecord, evaluateTriage, type ImnciTriageRecord } from "@/lib/imnci/record";
import type { Signs, TriageResult } from "@/lib/imnci/rules";
import { toLang } from "@/lib/i18n";
import { ageInMonths } from "@/lib/schedule";
import { t } from "@/lib/text";

export const dynamic = "force-dynamic";

const AGE_STEP = "__age__";
/** After this many unclear answers the step is recorded as not assessed, never guessed. */
const MAX_ATTEMPTS = 3;
const ageQuestion = (lang: Lang) => t("triage.age_question", lang);

/** Where the age came from: the patient record, the worker's visit sentence, or her answer to "how old?". */
export type AgeSource = "record" | "speech" | "answer";

export interface TriageState {
  stage: "age" | "questions" | "done";
  ageMonths: number | null;
  ageSource: AgeSource | null;
  agePhrase: string | null; // the words the age was read from, shown back to the worker
  signs: Signs;
  expecting: string | null; // step key the worker is answering
  lastAnswered: string | null; // step key a plain "galat hai" reopens
  skipped: string[];
  narrative: string; // the visit transcript, mined once for signs she already stated
  log: { q: string; a: string }[];
  stoppedEarly: boolean;
  attempts: number; // unclear answers to the current question
}

export interface TriageResponse {
  active: boolean; // false: this visit does not enter the pathway
  state: TriageState | null;
  result: TriageResult | null;
  question: string | null; // the one question to speak now
  say: string | null; // closing line once done, or why the assessment did not start
  protocol: { version: string; title: string; publisher: string; edition: string | null };
  saved: ImnciTriageRecord | null;
  saveError: string | null;
}

type StartBody = {
  action: "start";
  transcript: string;
  symptoms: string[];
  tempC: number | null;
  dateOfBirth: string | null; // only from a patient record that existed before this visit
  today: string;
  lang: Lang;
  visitId: string | null;
};
type TurnBody = { action: "turn"; state: TriageState; turn: string; lang: Lang; visitId: string | null };

function closing(result: TriageResult, lang: Lang): string {
  const names = result.classifications.map((c) => c.name.toLowerCase()).join(", ");
  return [t(`triage.outcome.${result.outcome}`, lang), names].filter(Boolean).join(" ");
}

/** Said once, before the first question, when the age was taken from her sentence. */
function ageLine(state: TriageState, lang: Lang): string {
  if (state.ageSource !== "speech") return "";
  return t("triage.age_line", lang, { months: state.ageMonths ?? "" });
}

function unclearAge(reason: string, lang: Lang): string {
  return t("triage.age_unclear", lang, { reason, question: ageQuestion(lang) });
}

const base = {
  protocol: { version: PROTOCOL.version, title: PROTOCOL.source.title, publisher: PROTOCOL.source.publisher, edition: PROTOCOL.source.edition ?? null },
  saved: null,
  saveError: null,
};

const notStarted = (say: string | null): TriageResponse => ({ ...base, active: false, state: null, result: null, question: null, say });
const askAge = (state: TriageState, question: string): TriageResponse => ({
  ...base,
  active: true,
  state: { ...state, stage: "age", expecting: AGE_STEP, ageMonths: null, ageSource: null, agePhrase: null, attempts: 0 },
  result: null,
  question,
  say: null,
});

async function advance(state: TriageState, lang: Lang, visitId: string | null): Promise<TriageResponse> {
  const result = evaluateTriage(state.signs, state.ageMonths, state.skipped);
  // A general danger sign means refer now: "Do not delay referral to finish other questions."
  const step = result.derived.general_danger_sign === true ? null : nextStep(STEPS, state.signs, state.skipped, askIfChecker(state.signs, state.ageMonths));
  if (step && !state.stoppedEarly) {
    const next = { ...state, stage: "questions" as const, expecting: step.key, attempts: step.key === state.expecting ? state.attempts : 0 };
    return { ...base, active: true, state: next, result, question: promptText(step, lang), say: null };
  }

  const done: TriageState = { ...state, stage: "done", expecting: null };
  let saved: ImnciTriageRecord | null = null;
  let saveError: string | null = null;
  if (visitId) {
    try {
      saved = buildRecord({
        signs: done.signs,
        ageMonths: done.ageMonths,
        ageSource: done.ageSource,
        agePhrase: done.agePhrase,
        skipped: done.skipped,
        stoppedEarly: done.stoppedEarly,
        log: done.log,
      });
      await updateVisit(visitId, { imnci_triage: saved as unknown as Record<string, unknown> });
    } catch (err) {
      saved = null;
      saveError = (err as Error).message;
    }
  }
  return { ...base, active: true, state: done, result, question: null, say: closing(result, lang), saved, saveError };
}

/**
 * Signs she already stated during the visit, so those questions are skipped. Measurements are never
 * taken from here. If the model is down nothing is seeded, and every question is simply asked.
 */
async function seed(state: TriageState): Promise<{ state: TriageState; modelUnavailable: boolean }> {
  const { signs, modelUnavailable } = await extractSigns(state.narrative, STEPS, null);
  return { state: { ...state, signs: { ...signs, ...state.signs } }, modelUnavailable };
}

/** Run the assessment for a child whose age is now known, opening with the age line if it came from her sentence. */
async function begin(state: TriageState, lang: Lang, visitId: string | null): Promise<TriageResponse> {
  const seeded = await seed(state);
  const res = await advance(seeded.state, lang, visitId);
  const busy = seeded.modelUnavailable ? modelBusyStart(lang) : "";
  return res.question ? { ...res, question: busy + ageLine(state, lang) + res.question } : res;
}

export async function POST(req: Request) {
  const body = (await req.json()) as StartBody | TurnBody;
  const lang: Lang = toLang(body.lang);

  try {
    if (body.action === "start") {
      // 1. A date of birth on the patient record. 2. An age she said, read without a model. 3. Ask.
      let ageMonths: number | null = null;
      let ageSource: AgeSource | null = null;
      let agePhrase: string | null = null;
      let unclearReason: string | null = null;
      if (body.dateOfBirth) {
        ageMonths = ageInMonths(body.dateOfBirth, body.today);
        ageSource = "record";
      } else {
        const r = ageFromText(body.transcript);
        if (r.kind === "age") [ageMonths, ageSource, agePhrase] = [r.months, "speech", r.phrase];
        else if (r.kind === "unclear") unclearReason = r.reason;
      }

      const entry = triageEntry({ transcript: body.transcript, symptoms: body.symptoms ?? [], tempC: body.tempC, ageMonths });
      if (entry === "skip") return NextResponse.json(notStarted(null));
      if (entry === "out_of_range") return NextResponse.json(notStarted(outOfRangeMessage(ageMonths!, lang)));

      const state: TriageState = {
        stage: "questions",
        ageMonths,
        ageSource,
        agePhrase,
        signs: {},
        expecting: null,
        lastAnswered: null,
        skipped: [],
        narrative: body.transcript,
        log: [],
        stoppedEarly: false,
        attempts: 0,
      };
      if (entry === "ask_age") return NextResponse.json(askAge(state, unclearReason ? unclearAge(unclearReason, lang) : ageQuestion(lang)));
      return NextResponse.json(await begin(state, lang, body.visitId ?? null));
    }

    const { state, visitId } = body;
    const turn = (body.turn ?? "").trim();

    if (STOP_RE.test(turn)) return NextResponse.json(await advance({ ...state, stoppedEarly: true }, lang, visitId));

    // "Umar galat hai" at any point, or a plain "galat hai" before anything else was answered,
    // reopens an age that was taken from her sentence.
    const log = [...state.log];
    if (AGE_CORRECTION_RE.test(turn) || (CORRECTION_RE.test(turn) && state.ageSource === "speech" && state.lastAnswered == null)) {
      log.push({ q: "(age correction)", a: turn });
      return NextResponse.json(askAge({ ...state, log }, ageQuestion(lang)));
    }

    if (state.expecting === AGE_STEP) {
      log.push({ q: ageQuestion(lang), a: turn });
      const r = ageFromText(turn, { answer: true });
      if (r.kind !== "age") {
        const q = r.kind === "unclear" ? unclearAge(r.reason, lang) : ageQuestion(lang);
        return NextResponse.json<TriageResponse>({ ...base, active: true, state: { ...state, log }, result: null, question: q, say: null });
      }
      if (!inAgeBand(r.months)) return NextResponse.json(notStarted(outOfRangeMessage(r.months, lang)));
      return NextResponse.json(await begin({ ...state, ageMonths: r.months, ageSource: "answer", agePhrase: r.phrase, log }, lang, visitId));
    }

    const step = STEPS.find((s) => s.key === state.expecting) ?? null;
    const asked = step ? promptText(step, lang) : "";

    // A plain "galat hai" reopens the last answered question, instead of being heard as "yes".
    if (CORRECTION_RE.test(turn) && state.lastAnswered) {
      const last = STEPS.find((s) => s.key === state.lastAnswered);
      if (last) {
        const signs = { ...state.signs };
        for (const id of last.signs) signs[id] = null;
        log.push({ q: asked, a: turn });
        const again = t("triage.again", lang, { question: promptText(last, lang) });
        const reopened: TriageState = {
          ...state,
          signs,
          log,
          stage: "questions",
          expecting: last.key,
          lastAnswered: null,
          skipped: state.skipped.filter((k) => k !== last.key),
          attempts: 0,
        };
        return NextResponse.json<TriageResponse>({ ...base, active: true, state: reopened, result: evaluateTriage(signs, state.ageMonths, reopened.skipped), question: again, say: null });
      }
    }

    log.push({ q: asked, a: turn });
    // "Pata nahi", "did not check", "skip": the sign stays not assessed and the next question is asked.
    // No retry and no model call; it counts the same as three unclear answers.
    if (step && isUnknownAnswer(turn)) {
      return NextResponse.json(await advance({ ...state, log, skipped: [...state.skipped, step.key], lastAnswered: step.key, attempts: 0 }, lang, visitId));
    }

    const { signs: found, modelUnavailable } = await extractSigns(turn, STEPS, step);
    const signs = { ...state.signs };
    for (const [k, v] of Object.entries(found)) {
      // Her answer to this question may correct it; anything else only fills a gap.
      if (v != null && (signs[k] == null || step?.signs.includes(k))) signs[k] = v;
    }

    if (step && step.signs.some((id) => signs[id] == null)) {
      // The model was down and her answer needed it: ask again in a form read without a model.
      // An outage is not her unclear answer, so it does not count toward skipping the step.
      if (modelUnavailable) {
        return NextResponse.json<TriageResponse>({ ...base, active: true, state: { ...state, signs, log }, result: evaluateTriage(signs, state.ageMonths, state.skipped), question: modelBusyRepeat(step, lang), say: null });
      }
      if (state.attempts + 1 >= MAX_ATTEMPTS) {
        return NextResponse.json(await advance({ ...state, signs, log, skipped: [...state.skipped, step.key], lastAnswered: step.key, attempts: 0 }, lang, visitId));
      }
      const options = step.choices ? ` (${choiceLabels(step, lang).join(" / ")})` : "";
      const again = t("triage.unclear", lang, { question: asked, options });
      return NextResponse.json<TriageResponse>({ ...base, active: true, state: { ...state, signs, log, attempts: state.attempts + 1 }, result: evaluateTriage(signs, state.ageMonths, state.skipped), question: again, say: null });
    }
    return NextResponse.json(await advance({ ...state, signs, log, lastAnswered: step?.key ?? state.lastAnswered }, lang, visitId));
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}
