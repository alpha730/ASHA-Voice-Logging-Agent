/**
 * The voice question flow for the IMNCI sick child pathway. Pure: no network, no model.
 *
 * Questions come from the protocol JSON in its own order: general danger signs first, then each
 * assessment's trigger, then its ask and look items. A step is skipped once its signs are known,
 * and a follow-up step waits for its ask_if condition in the JSON.
 * Measurement steps (breath count, oxygen saturation, skin pinch, MCP card, MUAC, palms) are only
 * ever filled from the worker's answer to that step, parsed without a model, never from narrative.
 */
import {
  AGE_MAX_MONTHS,
  AGE_MIN_MONTHS,
  triggerSign,
  type Condition,
  type ImnciProtocol,
  type ProtocolItem,
  type SignValue,
  type Signs,
} from "./rules.ts";
import { hasReview, reviewedMwr, type Lang, type MwrText } from "../i18n.ts";
import { t, UI_TEXT } from "../text.ts";
import marwariAnswers from "../../marwari-answers.json" with { type: "json" };

export type { Lang };
export type StepKind = "yesno" | "days" | "count" | "choice";

export interface Step {
  key: string; // the sign id, or a group name for a combined observation
  signs: string[]; // sign ids this step fills
  kind: StepKind;
  measurement: boolean; // she must count or test; never filled from narrative or by the model
  look: boolean; // an observation item: she checks the child rather than asks the mother
  assessment: string; // "general_danger_signs", "cough", ...
  prompt: StepPrompt;
  positiveWhen: "yes" | "no"; // for yesno: which answer makes the sign true
  choices?: Record<string, Record<string, SignValue>>; // for choice: answer -> sign values
  range?: [number, number]; // for count: plausible values; anything outside is asked again
  askIf?: Condition; // from the JSON: only asked once this holds
  appAuthored?: boolean; // prompt text written by the app, not taken from the protocol JSON
}

/** A question in each language. hi is null when the protocol has no Hindi text; mwr only once reviewed. */
export interface StepPrompt {
  en: string;
  hi: string | null;
  mwr?: MwrText | null;
}

/** Reviewed Marwari from a protocol item's optional `mwr` field, or null. */
function mwrOf(m: { question?: string; observation?: string; reviewed_by?: string; reviewed_on?: string } | null | undefined): MwrText | null {
  const text = m?.question ?? m?.observation;
  const out = m && text ? { text, reviewed_by: m.reviewed_by ?? "", reviewed_on: m.reviewed_on ?? "" } : null;
  return out && hasReview(out) && reviewedMwr(out) ? out : null;
}

/** Two-way look items that are really one observation with three answers. Wording is in ui-text.json. */
const GROUPS: { key: string; signs: string[]; prompt: StepPrompt; choices: Record<string, Record<string, SignValue>> }[] = [
  {
    key: "skin_pinch",
    signs: ["skin_pinch_very_slow", "skin_pinch_slow"],
    prompt: UI_TEXT.texts["triage.group.skin_pinch"],
    choices: {
      very_slow: { skin_pinch_very_slow: true, skin_pinch_slow: false },
      slow: { skin_pinch_very_slow: false, skin_pinch_slow: true },
      immediately: { skin_pinch_very_slow: false, skin_pinch_slow: false },
    },
  },
  {
    key: "offer_fluid",
    signs: ["drinks_poorly", "drinks_eagerly"],
    prompt: UI_TEXT.texts["triage.group.offer_fluid"],
    choices: {
      poorly: { drinks_poorly: true, drinks_eagerly: false },
      eagerly: { drinks_poorly: false, drinks_eagerly: true },
      normally: { drinks_poorly: false, drinks_eagerly: false },
    },
  },
];

function itemStep(item: ProtocolItem, assessment: string, look: boolean): Step {
  const text = item.question_en ?? item.observation_en ?? item.id;
  const hi = item.question_hi ?? item.observation_hi ?? null;
  const base: Omit<Step, "kind" | "measurement"> = {
    key: item.id,
    signs: [item.id],
    assessment,
    look,
    prompt: { en: text, hi, mwr: mwrOf(item.mwr) },
    positiveWhen: item.positive_when ?? "yes",
    askIf: item.ask_if,
  };
  // Counted or read off an instrument: breaths, oxygen saturation, MUAC.
  if (item.type === "number") return { ...base, kind: "count", measurement: true, range: item.range };
  // Chosen from a fixed list: MCP card colour, RDT result, palmar pallor.
  if (item.type === "enum") {
    const choices = Object.fromEntries((item.values ?? []).map((v) => [v, { [item.id]: v }]));
    return { ...base, kind: "choice", measurement: true, choices };
  }
  if (item.type === "number_days") return { ...base, kind: "days", measurement: false };
  return { ...base, kind: "yesno", measurement: false };
}

/** Every step of the pathway, in protocol order. */
export function buildSteps(protocol: ImnciProtocol): Step[] {
  const steps: Step[] = [];
  const seen = new Set<string>();
  const push = (s: Step) => {
    if (s.signs.every((id) => seen.has(id))) return; // lethargic_unconscious is listed twice
    s.signs.forEach((id) => seen.add(id));
    steps.push(s);
  };

  const gds = protocol.general_danger_signs;
  for (const item of gds.ask) push(itemStep(item, "general_danger_signs", false));
  for (const item of gds.look) push(itemStep(item, "general_danger_signs", true));

  for (const a of protocol.assessments) {
    if (a.trigger) {
      push({
        key: triggerSign(a.id),
        signs: [triggerSign(a.id)],
        kind: "yesno",
        measurement: false,
        look: false,
        assessment: a.id,
        prompt: { en: a.trigger.question_en, hi: a.trigger.question_hi ?? null, mwr: mwrOf(a.trigger.mwr) },
        positiveWhen: "yes",
      });
    }
    const items = [...(a.ask ?? []).map((i) => [i, false] as const), ...(a.look ?? []).map((i) => [i, true] as const)];
    for (const [item, look] of items) {
      const group = GROUPS.find((g) => g.signs.includes(item.id));
      if (group) {
        push({
          key: group.key,
          signs: group.signs,
          kind: "choice",
          measurement: true,
          look: true,
          assessment: a.id,
          prompt: group.prompt,
          positiveWhen: "yes",
          choices: group.choices,
          appAuthored: true,
        });
      } else {
        push(itemStep(item, a.id, look));
      }
    }
  }
  return steps;
}

const answered = (s: Signs, id: string) => s[id] !== null && s[id] !== undefined;

/**
 * The next question to ask, or null when every relevant step is answered or skipped.
 * `check` decides a step's ask_if condition (rules.holds with the current signs and age).
 */
export function nextStep(
  steps: Step[],
  signs: Signs,
  skipped: string[] = [],
  check: (cond: Condition) => boolean | null = () => true,
): Step | null {
  for (const step of steps) {
    if (skipped.includes(step.key)) continue;
    if (step.signs.every((id) => answered(signs, id))) continue;
    // Assessments only run when their symptom is present; general danger signs and malnutrition always run.
    const trigger = triggerSign(step.assessment);
    if (step.key !== trigger && steps.some((s) => s.key === trigger) && signs[trigger] !== true) continue;
    if (step.askIf && check(step.askIf) !== true) continue;
    return step;
  }
  return null;
}

/** The question in this language: reviewed Marwari, else Hindi, else English. */
export function promptOf(prompt: StepPrompt, lang: Lang): string {
  if (lang === "en") return prompt.en;
  if (lang === "mwr" && reviewedMwr(prompt.mwr)) return prompt.mwr.text;
  return prompt.hi ?? prompt.en;
}

export function promptText(step: Step, lang: Lang): string {
  const text = promptOf(step.prompt, lang);
  // A question that already asks for the reading ("How many cm?") needs no extra instruction.
  if (step.kind === "count" && !/\?\s*$/.test(text)) return t("triage.prompt.count", lang, { text });
  if (step.look && step.kind === "yesno") return t("triage.prompt.look", lang, { text });
  return text;
}

// ---------------------------------------------------------------------------
// Deterministic answer parsing
// ---------------------------------------------------------------------------

const YES_RE = /\b(yes|yeah|haan|han|ha|hai|ji haan|bilkul|sahi)\b|हाँ|हां|जी हाँ/i;
const NO_RE = /\b(no|nahi|nahin|nahi hai|na|not)\b|नहीं|नही/i;

/** Hindi and English only: a clear yes or no, or null when both or neither appear. */
function hiEnYesNo(text: string): boolean | null {
  const t = text.toLowerCase();
  const no = NO_RE.test(t);
  // "hai" alone is too weak to count as yes when a negation is also present.
  const yes = YES_RE.test(t.replace(/\b(nahi|nahin)\s+hai\b/g, ""));
  if (yes && !no) return true;
  if (no && !yes) return false;
  return null;
}

/**
 * A clear yes or no. Null when both or neither appear, so the model or a re-ask decides.
 * Marwari words count only when the Hindi/English words do not decide, so they can never
 * change a Hindi or English answer.
 */
export function parseYesNo(text: string): boolean | null {
  const base = hiEnYesNo(text);
  if (base !== null) return base;
  const yes = MARWARI.yes?.test(text) ?? false;
  const no = MARWARI.no?.test(text) ?? false;
  if (yes && !no) return true;
  if (no && !yes) return false;
  return null;
}

const NUMBER_WORDS: Record<string, number> = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  ek: 1, do: 2, teen: 3, char: 4, chaar: 4, paanch: 5, panch: 5, chhe: 6, saat: 7, aath: 8, nau: 9, das: 10,
  bees: 20, tees: 30, chalis: 40, chaalis: 40, pachas: 50, pachaas: 50, saath: 60, sattar: 70,
  "एक": 1, "दो": 2, "तीन": 3, "चार": 4, "पांच": 5, "पाँच": 5, "सात": 7, "दस": 10,
};

/** The single number in an answer. Null when there is none or more than one, so nothing is guessed. */
export function parseNumber(text: string): number | null {
  text = text.replace(/[०-९]/g, (d) => String("०१२३४५६७८९".indexOf(d))); // Devanagari digits
  const digits = text.match(/\d+(?:\.\d+)?/g);
  if (digits) return digits.length === 1 ? Number(digits[0]) : null;
  const words = text.toLowerCase().split(/[\s,.।?!]+/).filter((w) => w in NUMBER_WORDS);
  return words.length === 1 ? NUMBER_WORDS[words[0]] : null;
}

/** "3 din", "do hafte", "a month" -> days. */
export function parseDays(text: string): number | null {
  const n = parseNumber(text) ?? (/\b(a|one|ek)\b/i.test(text) ? 1 : null);
  if (n == null) return null;
  if (/(week|hafte|hafta|हफ्ते|हफ़्ते)/i.test(text)) return n * 7;
  if (/(month|mahine|mahina|महीने|महीना)/i.test(text)) return n * 30;
  return n;
}

// Answer words per choice value, romanised and Devanagari (Sarvam's codemix writes Hindi in Devanagari).
const CHOICE_WORDS: Record<string, RegExp> = {
  very_slow: /(very slow|bahut dheere|bahut der|2 second|two second|do second|बहुत धीरे|बहुत देर|2 सेकंड|दो सेकंड)/i,
  slow: /(slow|dheere|der se|धीरे|देर से)/i,
  immediately: /(immediate|turant|jaldi|fauran|quick|normal|तुरंत|फ़ौरन|फौरन|जल्दी)/i,
  poorly: /(poor|not able|unable|nahi pee|kam pee|thoda|mushkil|नहीं पी|कम पी|मुश्किल)/i,
  eagerly: /(eager|thirst|pyaas|jaldi jaldi|zyada pee|gatagat|प्यास|जल्दी-जल्दी|जल्दी जल्दी|गटागट)/i,
  normally: /(normal|theek|sahi|aam|सामान्य|ठीक)/i,
  severe: /(severe|bahut|zyada|very pale|bilkul safed|बहुत|ज़्यादा|ज्यादा)/i,
  some: /(some|thoda|thodi|halka|halki|kuch|mild|थोड़ा|थोड़ी|थोडी|हल्की|हल्का)/i,
  none: /(none|no pallor|nahi|normal|theek|nahin|samanya|सामान्य|नहीं|ठीक)/i,
  // MCP card weight-for-length colours.
  below_minus_3sd: /(\bred\b|laal|\blal\b|लाल|minus 3|-3)/i,
  minus_3_to_minus_2sd: /(yellow|peela|peeli|पीला|पीली|minus 2|-2)/i,
  at_or_above_minus_2sd: /(green|hara|hari|हरा|हरी)/i,
  not_measured: /(not measured|could not|couldn.?t|nahi naap|naap nahi|नाप नहीं|नहीं नाप)/i,
  // Malaria RDT result.
  positive: /(positive|पॉज़िटिव|पॉजिटिव)/i,
  negative: /(negative|नेगेटिव)/i,
  not_available: /(not available|not done|nahi hai|nahi hua|nahi kiya|उपलब्ध नहीं|नहीं है|नहीं किया|नहीं हुआ)/i,
};

/** How each choice is read back to the worker when an answer needs repeating (ui-text.json "triage.choice.*"). */
export function choiceLabels(step: Step, lang: Lang): string[] {
  return Object.keys(step.choices ?? {}).map((c) => (UI_TEXT.texts[`triage.choice.${c}`] ? t(`triage.choice.${c}`, lang) : c.replace(/_/g, " ")));
}

/** Map an answer onto exactly one of a step's choices. Ambiguity returns null and the question is asked again. */
export function parseChoice(step: Step, text: string): Record<string, SignValue> | null {
  const options = Object.keys(step.choices ?? {});
  let hits = options.filter((o) => CHOICE_WORDS[o]?.test(text));
  // The more specific answer wins: "very slowly" contains "slow"; "could not measure" names no colour.
  if (hits.includes("very_slow")) hits = hits.filter((h) => h !== "slow");
  if (hits.includes("not_measured")) hits = ["not_measured"];
  return hits.length === 1 ? step.choices![hits[0]] : null;
}

// "I don't know" and "skip", as whole phrases. Checked before any yes/no, number or choice parsing,
// so "pata nahi" is never read as "no" (it contains "nahi") or as "no pallor". Ordinary negations
// ("nahi", "nahi hai", "doodh nahi pee raha") are not matched.
const UNKNOWN_LATIN = [
  "pata nahi[n]?",
  "nahi[n]? pata",
  "maa?l(?:oo|u)m nahi[n]?",
  "dekha nahi[n]?",
  "check nahi[n]? kiya",
  "(?:i )?(?:don'?t|do not) know",
  "not sure",
  "can'?t tell",
  "cannot tell",
  "skip",
  "chhodo",
];
const UNKNOWN_HINDI = ["पता नहीं", "पता नही", "नहीं पता", "मालूम नहीं", "देखा नहीं", "चेक नहीं किया"];
// Devanagari letters and vowel signs, but not the danda, so "पता नहीं।" still matches.
const DEV_LETTER = "\u0900-\u0963\u0971-\u097F";
const UNKNOWN_RE = new RegExp(
  String.raw`\b(?:${UNKNOWN_LATIN.join("|")})\b|(?<![${DEV_LETTER}])(?:${UNKNOWN_HINDI.join("|")})(?![${DEV_LETTER}])`,
  "i",
);

const hiEnUnknown = (text: string) => UNKNOWN_RE.test(text.replace(/[‘’`]/g, "'"));

/** True when she says she does not know, did not check, or wants to skip. The sign stays not assessed. */
export function isUnknownAnswer(text: string): boolean {
  return hiEnUnknown(text) || (MARWARI.unknown?.test(text) ?? false);
}

// ---------------------------------------------------------------------------
// Marwari answer words (marwari-answers.json), filled by a native speaker
// ---------------------------------------------------------------------------

export interface AnswerWords {
  yes: string[];
  no: string[];
  unknown: string[];
}

/**
 * Hindi and English answers whose reading must never change when Marwari words are added. Start-up
 * refuses a word list that changes any of them (for example "kabhi" as yes, or "kuch nahi" as unknown).
 */
export const REFERENCE_ANSWERS = [
  "haan", "han", "ha", "yes", "yeah", "ji haan", "bilkul", "sahi hai", "hai", "हाँ", "हां", "जी हाँ",
  "nahi", "nahin", "nahi hai", "na", "no", "not", "नहीं", "नहीं है", "नही",
  "pata nahi", "nahi pata", "maloom nahi", "dekha nahi", "check nahi kiya", "i don't know", "not sure", "skip", "पता नहीं", "मालूम नहीं",
  "doodh nahi pee raha", "दूध नहीं पी रहा", "pee raha hai", "kuch nahi", "kuch bhi nahi", "koi nahi", "theek hai", "sab theek",
  "kabhi kabhi", "thoda", "thodi", "bahut", "ek baar", "do baar", "subah", "raat ko", "abhi", "pehle", "kal", "aaj",
  "ulti ho rahi hai", "ulti nahi ho rahi", "khansi hai", "khansi nahi hai", "bukhar hai", "dast hai", "saans tez hai",
  "dekh nahi raha", "so raha hai", "jag raha hai", "ro raha hai", "maa keh rahi hai", "bachcha theek hai", "galat hai",
];

type Compiled = { yes: RegExp | null; no: RegExp | null; unknown: RegExp | null };
let MARWARI: Compiled = { yes: null, no: null, unknown: null };

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** Whole words or phrases only: "kon" never matches inside "kona". Spaces match any whitespace. */
function wholePhrases(list: string[]): RegExp | null {
  if (!list.length) return null;
  const alts = list.map((w) => escapeRe(w).replace(/\s+/g, "\\s+")).join("|");
  return new RegExp(`(?<![\\p{L}\\p{M}\\p{N}])(?:${alts})(?![\\p{L}\\p{M}\\p{N}])`, "iu");
}

const reading = (text: string) => (isUnknownAnswer(text) ? "unknown" : String(parseYesNo(text)));

/**
 * Check and load a Marwari word list. Throws if a word is empty, appears in two lists, is a yes or no
 * word that already means something else in Hindi or English, or changes how any REFERENCE_ANSWERS
 * answer is read.
 */
export function setMarwariAnswers(words: AnswerWords): void {
  const clean = (l: unknown) => (Array.isArray(l) ? l : []).map((w) => String(w).trim().toLowerCase().replace(/\s+/g, " "));
  const lists = { yes: clean(words.yes), no: clean(words.no), unknown: clean(words.unknown) };
  const errors: string[] = [];
  const seen = new Map<string, string>();
  for (const [kind, list] of Object.entries(lists)) {
    for (const w of list) {
      if (!w) errors.push(`${kind}: an empty word`);
      else if (seen.has(w) && seen.get(w) !== kind) errors.push(`"${w}" is in both ${seen.get(w)} and ${kind}`);
      seen.set(w, kind);
      const hiEn = hiEnUnknown(w) ? "unknown" : hiEnYesNo(w) === true ? "yes" : hiEnYesNo(w) === false ? "no" : null;
      // An unknown phrase may contain "nahi" ("... nahi" = "don't know"): unknown is checked first, so that is
      // its purpose. A yes or no word that already means something else in Hindi or English is refused.
      if (kind !== "unknown" && hiEn && hiEn !== kind) errors.push(`"${w}" (${kind}) already means "${hiEn}" in Hindi or English`);
    }
  }
  const before = new Map(REFERENCE_ANSWERS.map((a) => [a, reading(a)]));
  const previous = MARWARI;
  MARWARI = { yes: wholePhrases(lists.yes), no: wholePhrases(lists.no), unknown: wholePhrases(lists.unknown) };
  for (const a of REFERENCE_ANSWERS) {
    const after = reading(a);
    if (after !== before.get(a)) errors.push(`would change the reading of "${a}" from ${before.get(a)} to ${after}`);
  }
  if (errors.length) {
    MARWARI = previous;
    throw new Error(`Invalid marwari-answers.json:\n${errors.join("\n")}`);
  }
}

setMarwariAnswers(marwariAnswers as AnswerWords);

/**
 * Parse the answer to one step. Returns the sign values, or null if the answer did not settle the
 * step. An "I don't know" answer is never a value: it returns null here, and the route marks the step
 * not assessed (see isUnknownAnswer).
 */
export function parseStepAnswer(step: Step, text: string): Signs | null {
  if (isUnknownAnswer(text)) return null;
  if (step.kind === "count") {
    const n = parseNumber(text);
    const [min, max] = step.range ?? [1, 150];
    return n != null && n >= min && n <= max ? { [step.signs[0]]: n } : null;
  }
  if (step.kind === "choice") return parseChoice(step, text);
  if (step.kind === "days") {
    const d = parseDays(text);
    return d != null ? { [step.signs[0]]: d } : null;
  }
  const yn = parseYesNo(text);
  if (yn == null) return null;
  return { [step.signs[0]]: step.positiveWhen === "no" ? !yn : yn };
}

// ---------------------------------------------------------------------------
// When to enter the pathway
// ---------------------------------------------------------------------------

const CHILD_RE = /(baccha|bachcha|bacche|bachche|bacchi|bachchi|beta\b|beti\b|child|baby|infant|toddler|mahine ka|mahine ki|saal ka|saal ki|months old|years? old|बच्चा|बच्चे|बच्ची|शिशु)/i;

// Whole-utterance only: "bas do din se" is an answer, not a request to stop.
export const STOP_RE = /^\s*(stop|end assessment|bas karo|band karo|khatam karo|बस करो|खत्म करो)\s*[.!।]?\s*$/i;

// ---------------------------------------------------------------------------
// The child's age, read from what the worker said
// ---------------------------------------------------------------------------

const AGE_WORDS: Record<string, number> = {
  ...NUMBER_WORDS,
  dedh: 1.5, dhai: 2.5, "डेढ़": 1.5, "ढाई": 2.5,
  gyarah: 11, barah: 12, baarah: 12, terah: 13, chaudah: 14, pandrah: 15, solah: 16, satrah: 17,
  atharah: 18, athara: 18, athaarah: 18, unnees: 19, ikkees: 21, bais: 22, teis: 23, chaubees: 24,
  eleven: 11, twelve: 12, eighteen: 18, twenty: 20, "twenty-four": 24,
  "छह": 6, "छः": 6, "आठ": 8, "नौ": 9, "ग्यारह": 11, "बारह": 12, "पंद्रह": 15, "अठारह": 18, "बीस": 20, "चौबीस": 24,
};
// A number at a word boundary: digits, or a number word ("teen", "डेढ़").
const NUM = String.raw`(?<![a-zऀ-ॿ\d.])(\d+(?:\.\d+)?|[a-zऀ-ॿ][a-zऀ-ॿ-]*)`;
const UNITS: { re: string; months: number; needsAgeMarker: boolean }[] = [
  { re: "years?|yrs?|saal|sal|varsh|baras|साल|वर्ष|बरस", months: 12, needsAgeMarker: false },
  { re: "months?|mahine|mahina|maheene|महीने|महीना|माह", months: 1, needsAgeMarker: false },
  // "3 hafte ka hai" is an age, "3 din ka bukhar" is not: weeks and days count only as "... ka hai" / "old".
  { re: "weeks?|hafte|hafta|हफ्ते|हफ़्ते|सप्ताह", months: 7 / 30.44, needsAgeMarker: true },
  { re: "days?|din|दिन", months: 1 / 30.44, needsAgeMarker: true },
];
const AGE_MARKER_AFTER = /^\s*(ka|ki|ke|का|की|के)\s*(hai|he|है)|^\s*old/i;
// "do saal se khansi", "3 mahine pehle", "teen mahine ki khansi": a duration, not the child's age.
const DURATION_AFTER = /^\s*(se|से|from|since|pehle|पहले|ago|baad|बाद|later|tak|तक)\b|^\s*(ka|ki|ke|का|की|के)?\s*(khansi|khaansi|bukhar|bukhaar|dast|fever|cough|diarrh|loose|खाँसी|खांसी|बुखार|दस्त)/i;
const DURATION_BEFORE = /(for|pichhle|pichle|last|पिछले)\s*$/i;
const APPROX_BEFORE = /(lagbhag|takreeban|karib|kareeb|about|around|approx\w*|nearly|roughly|लगभग|करीब|क़रीब|तकरीबन)\s*$/i;

export type AgeReading =
  | { kind: "age"; months: number; phrase: string }
  | { kind: "unclear"; reason: string; phrase: string }
  | { kind: "none" };

/**
 * The child's age in completed months, read without a model. Never guesses: a range, an
 * approximate age, a number without a readable unit, or two different ages give "unclear",
 * and the worker is asked. In an answer to "how old?", a bare number is taken as months.
 */
export function ageFromText(text: string, opts: { answer?: boolean } = {}): AgeReading {
  const t = text.replace(/[०-९]/g, (d) => String("०१२३४५६७८९".indexOf(d))).toLowerCase();
  const num = (s: string) => (/^\d/.test(s) ? Number(s) : AGE_WORDS[s]);
  const unitAlt = UNITS.map((u) => u.re).join("|");

  // "2-3 saal", "2 se 3 saal", "do ya teen saal", "do teen saal". Years and months only, and not a duration.
  const ageUnits = UNITS.filter((u) => !u.needsAgeMarker).map((u) => u.re).join("|");
  const rangeRe = new RegExp(`${NUM}\\s*(?:-|–|/|\\bto\\b|\\bse\\b|\\bya\\b|\\bor\\b|से|या|\\s)\\s*${NUM}\\s*(?:${ageUnits})(?![a-zऀ-ॿ])`, "gi");
  for (const r of t.matchAll(rangeRe)) {
    const after = t.slice(r.index! + r[0].length, r.index! + r[0].length + 25);
    if (num(r[1]) != null && num(r[2]) != null && !DURATION_AFTER.test(after)) {
      return { kind: "unclear", reason: "a range of ages", phrase: text.slice(r.index!, r.index! + r[0].length) };
    }
  }

  const found: { months: number; start: number; end: number; phrase: string }[] = [];
  for (const m of t.matchAll(new RegExp(`${NUM}\\s*(${unitAlt})(?![a-zऀ-ॿ])`, "gi"))) {
    const n = num(m[1]);
    if (n == null || !Number.isFinite(n)) continue;
    const start = m.index!;
    const end = start + m[0].length;
    const before = t.slice(Math.max(0, start - 20), start);
    const after = t.slice(end, end + 25);
    const unit = UNITS.find((u) => new RegExp(`^(?:${u.re})$`, "i").test(m[2]))!;
    if (DURATION_AFTER.test(after) || DURATION_BEFORE.test(before)) continue;
    if (unit.needsAgeMarker && !AGE_MARKER_AFTER.test(after)) continue;
    if (APPROX_BEFORE.test(before)) return { kind: "unclear", reason: "an approximate age", phrase: text.slice(start, end) };
    found.push({ months: n * unit.months, start, end, phrase: text.slice(start, end) });
  }

  // "2 saal 3 mahine" is one age, not two.
  const ages: { months: number; phrase: string }[] = [];
  for (let i = 0; i < found.length; i++) {
    const a = found[i];
    const b = found[i + 1];
    if (b && a.months >= 12 && b.months < 12 && /^\s*(aur|and|,|और)?\s*$/i.test(t.slice(a.end, b.start))) {
      ages.push({ months: a.months + b.months, phrase: text.slice(a.start, b.end) });
      i++;
    } else ages.push(a);
  }

  if (!ages.length) {
    // "teen ka hai": an age with no unit we can read.
    const bare = t.match(new RegExp(`${NUM}\\s+(?:ka|ki|ke|का|की|के)\\s+(?:hai|है)`, "i"));
    if (bare && num(bare[1]) != null && !opts.answer) return { kind: "unclear", reason: "an age without a unit", phrase: bare[0] };
    if (opts.answer) {
      const n = parseNumber(t);
      if (n != null) return { kind: "age", months: Math.floor(n), phrase: text.trim() };
    }
    return { kind: "none" };
  }
  const distinct = [...new Set(ages.map((a) => Math.floor(a.months)))];
  if (distinct.length > 1) return { kind: "unclear", reason: "two different ages", phrase: ages.map((a) => a.phrase).join(" / ") };
  return { kind: "age", months: distinct[0], phrase: ages[0].phrase };
}

/** Months from an answer to "how old is the child?", or null when it has to be asked again. */
export function parseAgeMonths(text: string): number | null {
  const r = ageFromText(text, { answer: true });
  return r.kind === "age" ? r.months : null;
}

/** "Umar galat hai" / "age is wrong": the worker is correcting the age the app took. */
export const AGE_CORRECTION_RE = /(umar|umr|age|उम्र|उमर).{0,20}(galat|wrong|गलत)|(galat|wrong|गलत).{0,20}(umar|umr|age|उम्र|उमर)/i;

export const inAgeBand = (months: number) => months >= AGE_MIN_MONTHS && months < AGE_MAX_MONTHS;

export type Entry = "enter" | "ask_age" | "out_of_range" | "skip";

/**
 * After the visit is logged: enter the pathway for a sick child aged 2 months to 5 years.
 * "Sick" means a symptom or a fever was recorded. A child with an unknown age is asked once.
 * A child outside the age band does not enter, and the worker is told why ("out_of_range").
 * An adult with no child mentioned is skipped silently.
 */
export function triageEntry(opts: { transcript: string; symptoms: string[]; tempC: number | null; ageMonths: number | null }): Entry {
  const sick = opts.symptoms.length > 0 || (opts.tempC != null && opts.tempC >= 37.5);
  if (!sick) return "skip";
  const child = CHILD_RE.test(opts.transcript);
  if (opts.ageMonths != null) {
    if (inAgeBand(opts.ageMonths)) return "enter";
    return child || opts.ageMonths < 18 * 12 ? "out_of_range" : "skip";
  }
  return child ? "ask_age" : "skip";
}

export function outOfRangeMessage(months: number, lang: Lang): string {
  const young = months < AGE_MIN_MONTHS ? t("triage.out_of_range.young_infant", lang) : "";
  return t("triage.out_of_range", lang, { months }) + young;
}

/**
 * Said when every model provider is down and her answer could not be read without one. The
 * question is asked again in a form the parser reads directly; the answer is never guessed.
 */
export function modelBusyRepeat(step: Step, lang: Lang): string {
  const question = promptText(step, lang);
  return t(step.kind === "days" ? "triage.model_busy_repeat.days" : "triage.model_busy_repeat.yesno", lang, { question });
}

/** Opening line when the visit sentence could not be read for signs because the model was down. */
export const modelBusyStart = (lang: Lang): string => t("triage.model_busy_start", lang);
