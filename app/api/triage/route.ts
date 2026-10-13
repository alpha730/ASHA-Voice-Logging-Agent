import { NextResponse } from "next/server";
import { updateVisit } from "@/lib/db";
import { extractSigns } from "@/lib/imnci/extract";
import { choiceLabels, nextStep, parseAgeMonths, promptText, SKIP_RE, STOP_RE, triageEntry, type Lang } from "@/lib/imnci/flow";
import { askIfChecker, PROTOCOL, STEPS } from "@/lib/imnci/protocol";
import { buildRecord, evaluateTriage, type ImnciTriageRecord } from "@/lib/imnci/record";
import { AGE_MAX_MONTHS, AGE_MIN_MONTHS, type Signs, type TriageResult } from "@/lib/imnci/rules";
import { ageInMonths } from "@/lib/schedule";

export const dynamic = "force-dynamic";

const AGE_STEP = "__age__";
/** After this many unclear answers the step is recorded as not assessed, never guessed. */
const MAX_ATTEMPTS = 3;
const AGE_QUESTION: Record<Lang, string> = {
  en: "How old is the child, in months?",
  hi: "बच्चा कितने महीने का है?",
};

export interface TriageState {
  stage: "age" | "questions" | "done";
  ageMonths: number | null;
  signs: Signs;
  expecting: string | null; // step key the worker is answering
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
  say: string | null; // closing line once done
  protocol: { version: string; title: string; publisher: string; edition: string | null };
  saved: ImnciTriageRecord | null;
  saveError: string | null;
}

type StartBody = {
  action: "start";
  transcript: string;
  symptoms: string[];
  tempC: number | null;
  dateOfBirth: string | null;
  today: string;
  lang: Lang;
  visitId: string | null;
};
type TurnBody = { action: "turn"; state: TriageState; turn: string; lang: Lang; visitId: string | null };

const OUTCOME_LINE: Record<TriageResult["outcome"], Record<Lang, string>> = {
  urgent_referral: { en: "Urgent referral.", hi: "तुरंत refer कीजिए।" },
  refer: { en: "Refer.", hi: "Refer कीजिए।" },
  treat_follow_up: { en: "Treat and follow up.", hi: "इलाज और follow-up कीजिए।" },
  home_care: { en: "Home care.", hi: "घर पर देखभाल।" },
  incomplete: { en: "Assessment incomplete.", hi: "जाँच अधूरी है।" },
  not_applicable: { en: "This assessment does not apply.", hi: "यह जाँच इस बच्चे पर लागू नहीं होती।" },
};

function closing(result: TriageResult, lang: Lang): string {
  const names = result.classifications.map((c) => c.name.toLowerCase()).join(", ");
  return [OUTCOME_LINE[result.outcome][lang], names].filter(Boolean).join(" ");
}

const base = {
  protocol: { version: PROTOCOL.version, title: PROTOCOL.source.title, publisher: PROTOCOL.source.publisher, edition: PROTOCOL.source.edition ?? null },
  saved: null,
  saveError: null,
};

async function advance(state: TriageState, lang: Lang, visitId: string | null): Promise<TriageResponse> {
  const result = evaluateTriage(state.signs, state.ageMonths);
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
      saved = buildRecord({ signs: done.signs, ageMonths: done.ageMonths, skipped: done.skipped, stoppedEarly: done.stoppedEarly, log: done.log });
      await updateVisit(visitId, { imnci_triage: saved as unknown as Record<string, unknown> });
    } catch (err) {
      saved = null;
      saveError = (err as Error).message;
    }
  }
  return { ...base, active: true, state: done, result, question: null, say: closing(result, lang), saved, saveError };
}

/** Signs she already stated during the visit, so those questions are skipped. Measurements are never taken from here. */
async function seed(state: TriageState): Promise<TriageState> {
  const signs = await extractSigns(state.narrative, STEPS, null);
  return { ...state, signs: { ...signs, ...state.signs } };
}

export async function POST(req: Request) {
  const body = (await req.json()) as StartBody | TurnBody;
  const lang: Lang = body.lang === "en" ? "en" : "hi";

  try {
    if (body.action === "start") {
      const ageMonths = body.dateOfBirth ? ageInMonths(body.dateOfBirth, body.today) : null;
      const entry = triageEntry({ transcript: body.transcript, symptoms: body.symptoms ?? [], tempC: body.tempC, ageMonths });
      if (entry === "skip") return NextResponse.json<TriageResponse>({ ...base, active: false, state: null, result: null, question: null, say: null });

      const state: TriageState = {
        stage: entry === "ask_age" ? "age" : "questions",
        ageMonths,
        signs: {},
        expecting: entry === "ask_age" ? AGE_STEP : null,
        skipped: [],
        narrative: body.transcript,
        log: [],
        stoppedEarly: false,
        attempts: 0,
      };
      if (entry === "ask_age") {
        return NextResponse.json<TriageResponse>({ ...base, active: true, state, result: null, question: AGE_QUESTION[lang], say: null });
      }
      return NextResponse.json(await advance(await seed(state), lang, body.visitId ?? null));
    }

    const { state, visitId } = body;
    const turn = (body.turn ?? "").trim();

    if (STOP_RE.test(turn)) return NextResponse.json(await advance({ ...state, stoppedEarly: true }, lang, visitId));

    if (state.expecting === AGE_STEP) {
      const months = parseAgeMonths(turn);
      const log = [...state.log, { q: AGE_QUESTION[lang], a: turn }];
      if (months == null) {
        return NextResponse.json<TriageResponse>({ ...base, active: true, state: { ...state, log }, result: null, question: AGE_QUESTION[lang], say: null });
      }
      if (months < AGE_MIN_MONTHS || months >= AGE_MAX_MONTHS) {
        const say = lang === "hi" ? "यह जाँच 2 महीने से 5 साल तक के बच्चों के लिए है।" : "This assessment is for children from 2 months up to 5 years.";
        return NextResponse.json<TriageResponse>({ ...base, active: false, state: null, result: null, question: null, say });
      }
      return NextResponse.json(await advance(await seed({ ...state, ageMonths: months, log }), lang, visitId));
    }

    const step = STEPS.find((s) => s.key === state.expecting) ?? null;
    const asked = step ? promptText(step, lang) : "";
    const log = [...state.log, { q: asked, a: turn }];

    if (step && SKIP_RE.test(turn)) {
      return NextResponse.json(await advance({ ...state, log, skipped: [...state.skipped, step.key] }, lang, visitId));
    }

    const found = await extractSigns(turn, STEPS, step);
    const signs = { ...state.signs };
    for (const [k, v] of Object.entries(found)) {
      // Her answer to this question may correct it; anything else only fills a gap.
      if (v != null && (signs[k] == null || step?.signs.includes(k))) signs[k] = v;
    }

    if (step && step.signs.some((id) => signs[id] == null)) {
      if (state.attempts + 1 >= MAX_ATTEMPTS) {
        return NextResponse.json(await advance({ ...state, signs, log, skipped: [...state.skipped, step.key], attempts: 0 }, lang, visitId));
      }
      const options = step.choices ? ` (${choiceLabels(step, lang).join(" / ")})` : "";
      const again = lang === "hi" ? `समझ नहीं आया। ${asked}${options}` : `Sorry, I did not get that. ${asked}${options}`;
      return NextResponse.json<TriageResponse>({ ...base, active: true, state: { ...state, signs, log, attempts: state.attempts + 1 }, result: evaluateTriage(signs, state.ageMonths), question: again, say: null });
    }
    return NextResponse.json(await advance({ ...state, signs, log }, lang, visitId));
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}
