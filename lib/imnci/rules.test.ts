import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { evaluate, fastBreathingThreshold, holds, validateProtocol, type Condition, type ImnciProtocol, type Signs } from "./rules.ts";
import { buildSteps, nextStep, parseAgeMonths, parseStepAnswer, triageEntry } from "./flow.ts";

const load = () => JSON.parse(readFileSync(new URL("../../imnci-sick-child-2m-5y.json", import.meta.url), "utf8")) as ImnciProtocol;
const protocol = load();

// Every general danger sign and every symptom explicitly ruled out, normal nutrition.
const NO_DANGER: Signs = { unable_to_drink: false, vomits_everything: false, convulsions: false, lethargic_unconscious: false, convulsing_now: false };
const NO_SYMPTOMS: Signs = { has_cough: false, has_diarrhoea: false, has_fever: false };
const NORMAL_NUTRITION: Signs = { wfl_band: "at_or_above_minus_2sd", oedema_both_feet: false, muac_cm: 13.5, palmar_pallor: "none" };
const well = (extra: Signs = {}): Signs => ({ ...NO_DANGER, ...NO_SYMPTOMS, ...NORMAL_NUTRITION, ...extra });

const run = (signs: Signs, ageMonths = 24, p: ImnciProtocol = protocol) => evaluate(p, { signs, ageMonths });
const ids = (r: ReturnType<typeof run>) => r.classifications.map((c) => c.id);
const find = (r: ReturnType<typeof run>, id: string) => r.classifications.find((c) => c.id === id);
const cough = (rate: number, extra: Signs = {}): Signs =>
  well({ has_cough: true, cough_duration_days: 3, respiratory_rate: rate, chest_indrawing: false, oxygen_saturation: 97, ...extra });

// ---------------------------------------------------------------------------
// Protocol file and provenance
// ---------------------------------------------------------------------------

test("the protocol file is valid and every sign a rule uses has a question", () => {
  assert.deepEqual(validateProtocol(protocol).undefinedSigns, []);
});

test("verified:true is refused without a real page and a quote", () => {
  const p = load();
  const row = p.assessments[0].classifications![0];
  delete row.source_check!.quote;
  assert.throws(() => validateProtocol(p), /needs a quote/);
  const q = load();
  q.assessments[0].classifications![0].source_page = "cough classify table";
  assert.throws(() => validateProtocol(q), /real page number/);
  const r = load();
  r.assessments[0].classifications![0].source_check = { method: "clinician-reviewed", date: "2026-10-13", quote: "x" };
  assert.throws(() => validateProtocol(r), /needs a reviewer/);
});

// ---------------------------------------------------------------------------
// Safety behaviour (unchanged)
// ---------------------------------------------------------------------------

test("a general danger sign alone, with no symptom reported, is urgent referral", () => {
  const r = run(well({ convulsions: true }));
  assert.deepEqual(ids(r), ["general_danger_sign", "no_acute_malnutrition", "no_anaemia"]);
  assert.equal(r.classifications[0].band, "pink");
  assert.equal(r.outcome, "urgent_referral");
});

test("'convulsing now' (2023 booklet, page 09) is a general danger sign", () => {
  assert.equal(run(well({ convulsing_now: true })).outcome, "urgent_referral");
});

test("general danger signs are evaluated even when nothing else has been asked yet", () => {
  const r = run({ unable_to_drink: true });
  assert.equal(r.derived.general_danger_sign, true);
  assert.equal(r.outcome, "urgent_referral");
  assert.equal(r.complete, false);
});

test("a pink and a yellow classification together: both shown, pink wins", () => {
  const r = run(
    cough(30, {
      chest_indrawing: true,
      has_diarrhoea: true,
      diarrhoea_duration_days: 3,
      blood_in_stool: false,
      lethargic_unconscious: false,
      restless_irritable: true,
      sunken_eyes: true,
      drinks_poorly: false,
      drinks_eagerly: false,
      skin_pinch_very_slow: false,
      skin_pinch_slow: false,
    }),
  );
  assert.equal(find(r, "severe_pneumonia_or_very_severe_disease")?.band, "pink");
  assert.equal(find(r, "some_dehydration")?.band, "yellow");
  assert.equal(r.outcome, "urgent_referral");
});

test("results carry asha_action and source_page, and never imnci_action", () => {
  for (const c of run(cough(55, { convulsions: true }), 8).classifications) {
    assert.ok(c.asha_action.length > 0);
    assert.ok(c.source_page.length > 0);
    assert.ok(!("imnci_action" in c));
  }
});

// ---------------------------------------------------------------------------
// Cough or difficult breathing (page 09)
// ---------------------------------------------------------------------------

test("the brief's example: fast breathing reported plus unable to drink is severe pneumonia", () => {
  const r = run({ ...well(), has_cough: true, unable_to_drink: true, fast_breathing: true, respiratory_rate: null }, 18);
  assert.ok(ids(r).includes("severe_pneumonia_or_very_severe_disease"));
  assert.equal(r.outcome, "urgent_referral");
});

test("45 breaths/min at 8 months is NOT fast breathing (2-11 months: 50 or more)", () => {
  assert.equal(fastBreathingThreshold(protocol, 8), 50);
  const r = run(cough(45), 8);
  assert.equal(r.derived.fast_breathing, false);
  assert.ok(ids(r).includes("no_pneumonia_cough_or_cold"));
});

test("45 breaths/min at 3 years IS fast breathing (12-59 months: 40 or more), so pneumonia", () => {
  assert.equal(fastBreathingThreshold(protocol, 36), 40);
  const r = run(cough(45), 36);
  assert.equal(find(r, "pneumonia")?.band, "yellow");
  assert.equal(find(r, "pneumonia")?.follow_up_days, 2);
});

test("55 breaths/min at 8 months is fast breathing, and 12 months uses the threshold of 40", () => {
  assert.ok(ids(run(cough(55), 8)).includes("pneumonia"));
  assert.equal(fastBreathingThreshold(protocol, 11), 50);
  assert.equal(fastBreathingThreshold(protocol, 12), 40);
});

test("a spoken 'breathing fast' without a counted rate never classifies", () => {
  const r = run(cough(0, { respiratory_rate: null, fast_breathing: true }), 30);
  assert.ok(!ids(r).includes("pneumonia"));
  assert.ok(!ids(r).includes("no_pneumonia_cough_or_cold"), "must not fall through to green while the rate is uncounted");
  assert.deepEqual(r.pending.find((p) => p.table === "cough")?.signs, ["respiratory_rate"]);
});

test("oxygen saturation below 90% alone is SEVERE PNEUMONIA (changed: replaces stridor)", () => {
  assert.equal(find(run(cough(30, { oxygen_saturation: 88 }), 36), "severe_pneumonia_or_very_severe_disease")?.band, "pink");
  assert.ok(ids(run(cough(30, { oxygen_saturation: 90 }), 36)).includes("no_pneumonia_cough_or_cold"));
});

test("an unmeasured oxygen saturation keeps the cough table pending, never green", () => {
  const r = run(cough(30, { oxygen_saturation: null }), 36);
  assert.ok(!ids(r).includes("no_pneumonia_cough_or_cold"));
  assert.ok(r.pending.some((p) => p.signs.includes("oxygen_saturation")));
});

test("stridor is no longer a sign (not in the 2023 booklet)", () => {
  assert.ok(ids(run(cough(30, { stridor: true }), 36)).includes("no_pneumonia_cough_or_cold"));
});

test("a cough of MORE than 14 days escalates to referral (changed from 30)", () => {
  const at15 = find(run(cough(30, { cough_duration_days: 15 }), 36), "no_pneumonia_cough_or_cold");
  assert.match(at15?.escalation ?? "", /refer for assessment/);
  assert.equal(at15?.refer, true);
  assert.equal(find(run(cough(30, { cough_duration_days: 14 }), 36), "no_pneumonia_cough_or_cold")?.escalation, null);
  const unknownDays = run(cough(30, { cough_duration_days: null }), 36);
  assert.ok(!ids(unknownDays).includes("no_pneumonia_cough_or_cold"), "duration could still make it a referral");
});

// ---------------------------------------------------------------------------
// Diarrhoea (page 10)
// ---------------------------------------------------------------------------

const diarrhoea = (extra: Signs): Signs =>
  well({
    has_diarrhoea: true,
    diarrhoea_duration_days: 2,
    blood_in_stool: false,
    restless_irritable: false,
    sunken_eyes: false,
    drinks_poorly: false,
    drinks_eagerly: false,
    skin_pinch_very_slow: false,
    skin_pinch_slow: false,
    ...extra,
  });

test("exactly one dehydration sign is NO DEHYDRATION (rows need two or more)", () => {
  const r = run(diarrhoea({ sunken_eyes: true }));
  assert.ok(ids(r).includes("no_dehydration"));
  assert.equal(r.outcome, "home_care");
});

test("two some-dehydration signs is SOME DEHYDRATION, follow-up after 2 days (changed from 5)", () => {
  const r = run(diarrhoea({ restless_irritable: true, sunken_eyes: true }));
  assert.equal(find(r, "some_dehydration")?.follow_up_days, 2);
  assert.equal(r.outcome, "treat_follow_up");
});

test("two severe-dehydration signs is SEVERE DEHYDRATION, one dehydration row only", () => {
  const r = run(diarrhoea({ sunken_eyes: true, skin_pinch_very_slow: true, restless_irritable: true }));
  assert.ok(ids(r).includes("severe_dehydration"));
  assert.ok(!ids(r).includes("some_dehydration"));
  assert.equal(r.outcome, "urgent_referral");
});

test("dehydration stays undecided while a sign that could reach the count is unknown", () => {
  const r = run(diarrhoea({ sunken_eyes: true, skin_pinch_very_slow: null }));
  assert.ok(!ids(r).some((id) => id.endsWith("dehydration")));
});

test("blood in stool or diarrhoea of 14 days or more refers to hospital (replaces dysentery and persistent rows)", () => {
  const blood = run(diarrhoea({ blood_in_stool: true }));
  assert.match(find(blood, "no_dehydration")?.escalation ?? "", /refer to hospital/);
  assert.equal(blood.outcome, "refer");
  assert.ok(!ids(blood).includes("dysentery"));
  assert.equal(run(diarrhoea({ diarrhoea_duration_days: 14 })).outcome, "refer");
  assert.equal(run(diarrhoea({ diarrhoea_duration_days: 13 })).outcome, "home_care");
  const unknownBlood = run(diarrhoea({ blood_in_stool: null }));
  assert.ok(!ids(unknownBlood).includes("no_dehydration"), "blood in stool could still make it a referral");
});

// ---------------------------------------------------------------------------
// Fever (page 10)
// ---------------------------------------------------------------------------

const fever = (extra: Signs): Signs =>
  well({ has_fever: true, fever_duration_days: 3, stiff_neck: false, other_cause_of_fever: false, ...extra });

test("stiff neck or a danger sign with fever is VERY SEVERE FEBRILE DISEASE; bulging fontanelle is no longer a sign", () => {
  assert.equal(find(run(fever({ stiff_neck: true, rdt_result: "negative" })), "very_severe_febrile_disease")?.band, "pink");
  assert.ok(!ids(run(fever({ bulging_fontanelle: true, rdt_result: "negative" }))).includes("very_severe_febrile_disease"));
});

test("positive RDT, or RDT not available with no other cause, is MALARIA/ SUSPECTED MALARIA", () => {
  assert.equal(find(run(fever({ rdt_result: "positive" })), "malaria")?.band, "yellow");
  assert.ok(ids(run(fever({ rdt_result: "not_available" }))).includes("malaria"));
  assert.ok(ids(run(fever({ rdt_result: "positive", other_cause_of_fever: true }))).includes("malaria"));
});

test("negative RDT, or another cause of fever, is FEVER - MALARIA UNLIKELY, now yellow (was green)", () => {
  const neg = find(run(fever({ rdt_result: "negative" })), "fever_malaria_unlikely");
  assert.equal(neg?.band, "yellow");
  assert.ok(ids(run(fever({ rdt_result: "not_available", other_cause_of_fever: true }))).includes("fever_malaria_unlikely"));
});

test("fever without an RDT answer stays incomplete instead of guessing", () => {
  const r = run(fever({}));
  assert.ok(r.pending.some((p) => p.signs.includes("rdt_result")));
  assert.equal(r.outcome, "incomplete");
});

test("fever every day for more than 7 days escalates MALARIA UNLIKELY to referral", () => {
  const long = find(run(fever({ rdt_result: "negative", fever_duration_days: 9, fever_daily_over_7_days: true })), "fever_malaria_unlikely");
  assert.match(long?.escalation ?? "", /refer for assessment/);
  const short = find(run(fever({ rdt_result: "negative", fever_duration_days: 5 })), "fever_malaria_unlikely");
  assert.equal(short?.escalation, null, "a 5-day fever needs no 'every day' answer");
});

test("measles and ear rows are retired: kept for reference, never classified", () => {
  const retired = (protocol as unknown as { retired_rules: { id: string; reason: string }[] }).retired_rules;
  for (const id of ["mastoiditis", "acute_ear_infection", "chronic_ear_infection", "no_ear_infection", "severe_complicated_measles", "measles_with_eye_or_mouth_complications", "measles"]) {
    assert.equal(retired.find((r) => r.id === id)?.reason, "not in the 2023 health-worker booklet; kept for reference");
  }
  const r = run(fever({ rdt_result: "negative", measles_signs: true, mouth_ulcers: true, corneal_clouding: true, ear_pain: true }));
  assert.ok(!ids(r).some((id) => id.includes("measles") || id.includes("ear")));
});

// ---------------------------------------------------------------------------
// Malnutrition and anaemia (page 11)
// ---------------------------------------------------------------------------

test("WFL red, MUAC under 11.5 cm, or oedema of both feet is SEVERE ACUTE MALNUTRITION", () => {
  assert.equal(find(run(well({ wfl_band: "below_minus_3sd" })), "severe_acute_malnutrition")?.band, "pink");
  assert.ok(ids(run(well({ muac_cm: 11.2 }))).includes("severe_acute_malnutrition"));
  assert.ok(ids(run(well({ oedema_both_feet: true }))).includes("severe_acute_malnutrition"));
});

test("WFL yellow or MUAC 11.5-12.4 cm, without oedema, is MODERATE ACUTE MALNUTRITION (new row), follow-up 30 days", () => {
  const byMuac = find(run(well({ muac_cm: 12.0 })), "moderate_acute_malnutrition");
  assert.equal(byMuac?.band, "yellow");
  assert.equal(byMuac?.follow_up_days, 30);
  assert.ok(ids(run(well({ wfl_band: "minus_3_to_minus_2sd" }))).includes("moderate_acute_malnutrition"));
  assert.ok(ids(run(well({ muac_cm: 12.5 }))).includes("no_acute_malnutrition"));
});

test("MUAC is only needed from 6 months: a 4-month-old with green WFL is NO ACUTE MALNUTRITION", () => {
  assert.ok(ids(run(well({ muac_cm: null }), 4)).includes("no_acute_malnutrition"));
  assert.ok(run(well({ muac_cm: null }), 24).pending.some((p) => p.signs.includes("muac_cm")));
});

test("visible severe wasting counts only when WFL could not be measured", () => {
  assert.ok(ids(run(well({ wfl_band: "not_measured", visible_severe_wasting: true }))).includes("severe_acute_malnutrition"));
  const noRow = run(well({ wfl_band: "not_measured", visible_severe_wasting: false }));
  assert.ok(noRow.unmatched.includes("malnutrition_anaemia.nutrition"), "no row fits; the card says check the printed chart");
});

test("anaemia rows use the booklet names", () => {
  assert.equal(find(run(well({ palmar_pallor: "severe" })), "severe_anaemia")?.name, "SEVERE ANEMIA");
  assert.equal(find(run(well({ palmar_pallor: "some" })), "anaemia")?.follow_up_days, 14);
});

// ---------------------------------------------------------------------------
// Verification level shown on the card
// ---------------------------------------------------------------------------

test("a result built only from booklet-compared rules reads 'ai-compared', not draft", () => {
  assert.equal(run(cough(45), 36).verification, "ai-compared");
});

test("a result using any unconfirmed rule is draft", () => {
  const p = load();
  const row = p.assessments.find((a) => a.id === "cough")!.classifications!.find((c) => c.id === "pneumonia")!;
  row.verified = false;
  row.source_check = { method: "not-confirmed", reason: "test" };
  const r = run(cough(45), 36, p);
  assert.equal(find(r, "pneumonia")?.verified, false);
  assert.equal(r.verification, "draft");
});

test("'clinician-reviewed' only when every rule behind the result was reviewed by hand", () => {
  const p = load();
  const reviewed = { method: "clinician-reviewed" as const, date: "2026-10-20", quote: "x", reviewer: "Dr Test" };
  p.assessments[0].classifications!.forEach((c) => (c.source_check = reviewed));
  p.assessments.find((a) => a.id === "malnutrition_anaemia")!.classification_groups!.forEach((g) => g.classifications.forEach((c) => (c.source_check = reviewed)));
  assert.equal(run(cough(45), 36, p).verification, "clinician-reviewed");
  const mixed = load();
  mixed.assessments[0].classifications!.forEach((c) => (c.source_check = reviewed));
  assert.equal(run(cough(45), 36, mixed).verification, "ai-compared");
});

test("children outside 2 months to 5 years are not classified", () => {
  assert.equal(run(well({ convulsions: true }), 1).eligible, false);
  assert.equal(run(well({ convulsions: true }), 60).eligible, false);
  assert.equal(run(well({ convulsions: true }), 59).eligible, true);
});

// ---------------------------------------------------------------------------
// Question flow
// ---------------------------------------------------------------------------

const steps = buildSteps(protocol);
const next = (signs: Signs, ageMonths = 24) =>
  nextStep(steps, signs, [], (cond: Condition) => holds(protocol, { signs, ageMonths }, cond))?.key;

test("danger signs first (including 'convulsing now'), answered steps skipped, absent symptoms skipped", () => {
  assert.equal(next({}), "unable_to_drink");
  assert.equal(next({ ...NO_DANGER, convulsing_now: null }), "convulsing_now");
  assert.equal(next({ ...NO_DANGER }), "has_cough");
  assert.equal(next({ ...NO_DANGER, has_cough: false, has_diarrhoea: true }), "diarrhoea_duration_days");
});

test("ask_if from the JSON: 'every day?' only after more than 7 days, MUAC only from 6 months, wasting only if WFL unmeasured", () => {
  const feverSigns = { ...NO_DANGER, ...NO_SYMPTOMS, has_fever: true, fever_duration_days: 5 };
  assert.notEqual(next(feverSigns), "fever_daily_over_7_days");
  assert.equal(next({ ...feverSigns, fever_duration_days: 9 }), "fever_daily_over_7_days");
  const nutrition = { ...NO_DANGER, ...NO_SYMPTOMS, wfl_band: "at_or_above_minus_2sd", oedema_both_feet: false };
  assert.equal(next(nutrition, 4), "palmar_pallor");
  assert.equal(next(nutrition, 24), "muac_cm");
  assert.equal(next({ ...NO_DANGER, ...NO_SYMPTOMS, wfl_band: "not_measured" }), "visible_severe_wasting");
});

test("a fever case never asks a measles or ear question", () => {
  const answers: Record<string, unknown> = {
    unable_to_drink: false, vomits_everything: false, convulsions: false, lethargic_unconscious: false, convulsing_now: false,
    has_cough: false, has_diarrhoea: false, has_fever: true, fever_duration_days: 9, fever_daily_over_7_days: true,
    stiff_neck: false, other_cause_of_fever: false, rdt_result: "negative",
    wfl_band: "at_or_above_minus_2sd", oedema_both_feet: false, muac_cm: 13, palmar_pallor: "none",
  };
  const signs: Signs = {};
  const asked: string[] = [];
  for (let key = next(signs); key; key = next(signs)) {
    assert.ok(key in answers, `unexpected question: ${key}`);
    asked.push(key);
    signs[key] = answers[key] as Signs[string];
  }
  assert.ok(asked.includes("rdt_result") && asked.includes("fever_daily_over_7_days"));
  for (const id of ["measles_signs", "measles_last_3_months", "mouth_ulcers", "pus_from_eye", "corneal_clouding", "has_ear_problem", "ear_pain"]) {
    assert.ok(!asked.includes(id), `asked ${id}`);
  }
  assert.ok(!steps.some((s) => /measles|ear_/.test(s.key)), "no measles or ear step exists at all");
});

test("measurement answers are parsed without a model, in English or Devanagari, and vague answers are refused", () => {
  const step = (k: string) => steps.find((s) => s.key === k)!;
  assert.deepEqual(parseStepAnswer(step("respiratory_rate"), "47 saans"), { respiratory_rate: 47 });
  assert.equal(parseStepAnswer(step("respiratory_rate"), "bahut tez saans le raha hai"), null);
  assert.deepEqual(parseStepAnswer(step("oxygen_saturation"), "८८ प्रतिशत"), { oxygen_saturation: 88 });
  assert.equal(parseStepAnswer(step("oxygen_saturation"), "120"), null, "outside the plausible range");
  assert.deepEqual(parseStepAnswer(step("muac_cm"), "11.8 cm"), { muac_cm: 11.8 });
  assert.deepEqual(parseStepAnswer(step("wfl_band"), "लाल रंग में है"), { wfl_band: "below_minus_3sd" });
  assert.deepEqual(parseStepAnswer(step("wfl_band"), "yellow"), { wfl_band: "minus_3_to_minus_2sd" });
  assert.deepEqual(parseStepAnswer(step("wfl_band"), "नाप नहीं पाए"), { wfl_band: "not_measured" });
  assert.deepEqual(parseStepAnswer(step("rdt_result"), "नेगेटिव आया"), { rdt_result: "negative" });
  assert.deepEqual(parseStepAnswer(step("palmar_pallor"), "थोड़ी पीली है"), { palmar_pallor: "some" });
  assert.deepEqual(parseStepAnswer(step("skin_pinch"), "बहुत धीरे वापस गई"), { skin_pinch_very_slow: true, skin_pinch_slow: false });
  assert.deepEqual(parseStepAnswer(step("unable_to_drink"), "नहीं, दूध नहीं पी रहा"), { unable_to_drink: true });
});

test("every question has Hindi text, in Devanagari", () => {
  for (const s of steps) {
    assert.ok(s.prompt.hi, `${s.key} has no Hindi text`);
    assert.match(s.prompt.hi!, /[ऀ-ॿ]/, `${s.key} Hindi is not in Devanagari`);
  }
});

test("spoken ages are read with their own unit", () => {
  assert.equal(parseAgeMonths("dedh saal, 18 mahine"), 18);
  assert.equal(parseAgeMonths("dedh saal"), 18);
  assert.equal(parseAgeMonths("2 saal"), 24);
  assert.equal(parseAgeMonths("8 mahine ka hai"), 8);
  assert.equal(parseAgeMonths("pata nahi"), null);
});

test("only a sick child in the age band enters the pathway", () => {
  assert.equal(triageEntry({ transcript: "bacche ko bukhar hai", symptoms: ["fever"], tempC: null, ageMonths: 14 }), "enter");
  assert.equal(triageEntry({ transcript: "bacche ko bukhar hai", symptoms: ["fever"], tempC: null, ageMonths: null }), "ask_age");
  assert.equal(triageEntry({ transcript: "routine visit", symptoms: [], tempC: null, ageMonths: 14 }), "skip");
  assert.equal(triageEntry({ transcript: "bukhar", symptoms: ["fever"], tempC: null, ageMonths: 72 }), "skip");
});
