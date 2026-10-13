import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { evaluate, holds, notAssessedLabels, type ImnciProtocol, type Signs } from "./rules.ts";
import { buildSteps, isUnknownAnswer, nextStep, parseStepAnswer, parseYesNo, type Step } from "./flow.ts";

const protocol = JSON.parse(readFileSync(new URL("../../imnci-sick-child-2m-5y.json", import.meta.url), "utf8")) as ImnciProtocol;
const steps = buildSteps(protocol);
const step = (key: string) => {
  const s = steps.find((x) => x.key === key);
  if (!s) throw new Error(`no step ${key}`);
  return s;
};

/**
 * Walks the questions in the route's order with the route's answer handling: an "I don't know"
 * answer marks the step not assessed and moves on; anything else must parse.
 */
function runAssessment(answers: Record<string, string>, ageMonths = 24) {
  const signs: Signs = {};
  const skipped: string[] = [];
  const asked: string[] = [];
  const check = (s: Signs) => (cond: Parameters<typeof holds>[2]) => holds(protocol, { signs: s, ageMonths }, cond);
  for (let i = 0; i < 60; i++) {
    const s: Step | null = nextStep(steps, signs, skipped, check(signs));
    if (!s) break;
    asked.push(s.key);
    const answer = answers[s.key];
    if (answer == null) throw new Error(`no answer scripted for ${s.key}`);
    if (isUnknownAnswer(answer)) {
      skipped.push(s.key);
      continue;
    }
    const parsed = parseStepAnswer(s, answer);
    if (!parsed) throw new Error(`"${answer}" did not parse for ${s.key}`);
    Object.assign(signs, parsed);
  }
  const notAssessed = steps.filter((s) => skipped.includes(s.key)).flatMap((s) => s.signs);
  return { result: evaluate(protocol, { signs, ageMonths, notAssessed }), signs, skipped, asked };
}

// A well child with no symptoms, every answer given.
const WELL: Record<string, string> = {
  unable_to_drink: "haan, pee raha hai",
  vomits_everything: "nahi",
  convulsions: "nahi",
  lethargic_unconscious: "nahi",
  convulsing_now: "nahi",
  has_cough: "nahi",
  has_diarrhoea: "nahi",
  has_fever: "nahi",
  wfl_band: "green",
  oedema_both_feet: "nahi",
  muac_cm: "13.5",
  palmar_pallor: "none",
};

test("baseline: the well child with every answer given is home care", () => {
  const { result } = runAssessment(WELL);
  assert.equal(result.outcome, "home_care");
  assert.deepEqual(result.pending, []);
});

test("(a) 'pata nahi' on a danger sign leaves it not assessed, moves on, and the result is never an all-clear", () => {
  for (const key of ["vomits_everything", "convulsions", "lethargic_unconscious", "convulsing_now", "unable_to_drink"]) {
    const { result, signs, skipped, asked } = runAssessment({ ...WELL, [key]: "pata nahi" });
    const sign = step(key).signs[0];
    assert.equal(signs[sign], undefined, `${key} is not recorded`);
    assert.deepEqual(skipped, [key]);
    assert.equal(asked.filter((k) => k === key).length, 1, "asked once: no retry");
    assert.ok(asked.indexOf(key) < asked.length - 1, "the next question follows");
    assert.notEqual(result.outcome, "home_care", key);
    assert.equal(result.complete, false);
    assert.ok(result.pending.some((p) => p.table === "general_danger_signs" && p.signs.includes(sign)), `${key} pending`);
  }
});

test("(b) 'doodh nahi pee raha' is still a danger sign", () => {
  assert.equal(isUnknownAnswer("doodh nahi pee raha"), false);
  assert.deepEqual(parseStepAnswer(step("unable_to_drink"), "doodh nahi pee raha"), { unable_to_drink: true });
  const { result } = runAssessment({ ...WELL, unable_to_drink: "doodh nahi pee raha" });
  assert.equal(result.outcome, "urgent_referral");
  assert.ok(result.classifications.some((c) => c.id === "general_danger_sign"));
});

test("(c) 'nahi' alone, 'nahi hai' and 'no' are still no", () => {
  for (const t of ["nahi", "nahin", "nahi hai", "no", "नहीं", "नहीं है"]) {
    assert.equal(isUnknownAnswer(t), false, t);
    assert.equal(parseYesNo(t), false, t);
    assert.deepEqual(parseStepAnswer(step("vomits_everything"), t), { vomits_everything: false }, t);
  }
});

test("(d) every 'I don't know' phrase, romanised, English and Devanagari, is unknown", () => {
  const phrases = [
    "pata nahi",
    "Pata nahin",
    "nahi pata",
    "maloom nahi",
    "malum nahi",
    "dekha nahi",
    "check nahi kiya",
    "I don't know",
    "i dont know",
    "I don’t know", // curly apostrophe
    "do not know",
    "not sure",
    "can't tell",
    "cannot tell",
    "skip",
    "ise skip karo",
    "पता नहीं",
    "पता नहीं।",
    "नहीं पता",
    "मालूम नहीं",
    "देखा नहीं",
    "चेक नहीं किया",
    "मुझे पता नहीं है",
  ];
  for (const t of phrases) assert.equal(isUnknownAnswer(t), true, t);
});

test("ordinary negations and answers are not mistaken for 'I don't know'", () => {
  const answers = [
    "doodh nahi pee raha",
    "दूध नहीं पी रहा",
    "nahi hai",
    "no",
    "nahi",
    "bachcha dekh nahi raha",
    "ulti nahi ho rahi",
    "khansi nahi hai",
    "naap nahi paye", // the growth-chart choice "not measured", a real answer
    "skin pinch bahut dheere",
    "पानी नहीं पी पा रहा",
    "sure, yes",
  ];
  for (const t of answers) assert.equal(isUnknownAnswer(t), false, t);
});

test("'pata nahi' is never a value for any question kind: yes/no, days, counts, SpO2 and three-way choices", () => {
  const kinds = ["vomits_everything", "cough_duration_days", "respiratory_rate", "oxygen_saturation", "skin_pinch", "offer_fluid", "palmar_pallor", "wfl_band"];
  for (const key of kinds) {
    for (const t of ["pata nahi", "पता नहीं", "not sure", "skip"]) {
      assert.equal(parseStepAnswer(step(key), t), null, `${key}: "${t}"`);
    }
  }
  // Before the fix, "pata nahi" on palms read as "no pallor" because it contains "nahi".
  assert.deepEqual(parseStepAnswer(step("palmar_pallor"), "nahi"), { palmar_pallor: "none" });
});

test("an unknown breath count or SpO2 leaves the cough table pending, never green", () => {
  const cough = { ...WELL, has_cough: "haan", cough_duration_days: "3 din", chest_indrawing: "nahi" };
  for (const unknown of [
    { respiratory_rate: "pata nahi", oxygen_saturation: "96" },
    { respiratory_rate: "36", oxygen_saturation: "मालूम नहीं" },
  ]) {
    const { result, skipped } = runAssessment({ ...cough, ...unknown });
    assert.equal(skipped.length, 1);
    assert.equal(result.classifications.some((c) => c.id === "no_pneumonia_cough_or_cold"), false, "no green cough row");
    assert.notEqual(result.outcome, "home_care");
    assert.ok(result.pending.some((p) => p.table === "cough"));
  }
});

test("an unknown skin pinch or offer-fluid observation leaves dehydration pending, never NO DEHYDRATION", () => {
  const diarrhoea = {
    ...WELL,
    has_diarrhoea: "haan",
    diarrhoea_duration_days: "2 din",
    blood_in_stool: "nahi",
    lethargic_unconscious: "nahi",
    restless_irritable: "nahi",
    sunken_eyes: "nahi",
    offer_fluid: "normal",
    skin_pinch: "turant",
  };
  for (const key of ["skin_pinch", "offer_fluid"]) {
    const { result, skipped } = runAssessment({ ...diarrhoea, [key]: "pata nahi" });
    assert.deepEqual(skipped, [key]);
    assert.equal(result.classifications.some((c) => c.id === "no_dehydration"), false, key);
    assert.notEqual(result.outcome, "home_care");
  }
});

test("(e) the card's 'Not assessed' line lists the sign", () => {
  const { result } = runAssessment({ ...WELL, lethargic_unconscious: "पता नहीं" });
  assert.ok(notAssessedLabels(result.pending).includes("lethargic unconscious"));
  const card = readFileSync(new URL("../../app/record/TriageCard.tsx", import.meta.url), "utf8");
  assert.match(card, /Not assessed: \{notAssessedLabels\(result\.pending\)/);
});

test("a table with an unassessed sign never settles on green, even when that sign could not change the row", () => {
  // All other dehydration signs are absent, so three-valued logic alone would say NO DEHYDRATION.
  const signs: Signs = {
    unable_to_drink: false, vomits_everything: false, convulsions: false, lethargic_unconscious: false, convulsing_now: false,
    has_cough: false, has_fever: false, has_diarrhoea: true, diarrhoea_duration_days: 2, blood_in_stool: false,
    restless_irritable: false, sunken_eyes: false, drinks_poorly: false, drinks_eagerly: false,
    wfl_band: "at_or_above_minus_2sd", oedema_both_feet: false, muac_cm: 13.5, palmar_pallor: "none",
  };
  const assessed = evaluate(protocol, { signs: { ...signs, skin_pinch_very_slow: false, skin_pinch_slow: false }, ageMonths: 24 });
  assert.ok(assessed.classifications.some((c) => c.id === "no_dehydration"));
  const unchecked = evaluate(protocol, { signs, ageMonths: 24, notAssessed: ["skin_pinch_very_slow", "skin_pinch_slow"] });
  assert.equal(unchecked.classifications.some((c) => c.id === "no_dehydration"), false);
  assert.ok(unchecked.pending.some((p) => p.table === "diarrhoea.dehydration" && p.signs.includes("skin_pinch_slow")));
  assert.equal(unchecked.outcome, "incomplete");
});

test("an unassessed sign never hides a pink or yellow row that is already settled", () => {
  // Two severe signs present: SEVERE DEHYDRATION whatever the skin pinch is.
  const severe = runAssessment({
    ...WELL, has_diarrhoea: "haan", diarrhoea_duration_days: "2 din", blood_in_stool: "nahi",
    restless_irritable: "nahi", sunken_eyes: "haan", offer_fluid: "nahi pee pa raha", skin_pinch: "pata nahi",
  });
  assert.ok(severe.result.classifications.some((c) => c.id === "severe_dehydration"));
  assert.equal(severe.result.outcome, "urgent_referral");
  // A fast count with SpO2 unknown: low SpO2 would make it pink, so the table stays open rather than yellow.
  const pneumonia = runAssessment({ ...WELL, has_cough: "haan", cough_duration_days: "3 din", respiratory_rate: "52", chest_indrawing: "nahi", oxygen_saturation: "pata nahi" });
  assert.notEqual(pneumonia.result.outcome, "home_care");
  assert.equal(pneumonia.result.classifications.some((c) => c.band === "green" && c.assessment === "cough"), false);
});

test("a question not asked because of ask_if is not 'not assessed': MUAC under 6 months still allows green", () => {
  const { result, skipped, asked } = runAssessment(WELL, 4);
  assert.equal(asked.includes("muac_cm"), false);
  assert.deepEqual(skipped, []);
  assert.equal(result.outcome, "home_care");
});
