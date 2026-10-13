import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { evaluate, type Band, type ImnciProtocol, type Signs } from "./rules.ts";
import {
  adviceFor,
  adviceSpeech,
  classificationIds,
  entryVerification,
  quotesOf,
  validateCounselling,
  visibleSteps,
  type CounsellingEntry,
  type CounsellingFile,
  type SourceDoc,
} from "./counselling.ts";

const root = new URL("../../", import.meta.url);
const readJson = <T>(name: string) => JSON.parse(readFileSync(new URL(name, root), "utf8")) as T;
const protocol = readJson<ImnciProtocol>("imnci-sick-child-2m-5y.json");
const file = readJson<CounsellingFile>("counselling.json");
const clone = (): CounsellingFile => JSON.parse(JSON.stringify(file));

// ---------------------------------------------------------------------------
// Quotes against the source pages
// ---------------------------------------------------------------------------

const PAGE_DIR: Record<SourceDoc, string> = { booklet: "sources/imnci-2023/booklet", facilitator_guide: "sources/imnci-2023/facilitator-guide" };

/** Extracted PDF text with the layout noise removed: ligatures, bullet glyphs, curly apostrophes, line breaks. */
function norm(s: string): string {
  return s
    .replace(/ﬁ/g, "fi")
    .replace(/ﬂ/g, "fl")
    .replace(/[’]/g, "'")
    .replace(/[•ØŸð]/g, " ")
    .split(/\s+/)
    .filter(Boolean)
    .join(" ");
}

const pageCache = new Map<string, string>();
function pageText(source: SourceDoc, page: number): string | null {
  const path = new URL(`${PAGE_DIR[source]}/page-${page}.txt`, root);
  const key = path.href;
  if (!pageCache.has(key)) pageCache.set(key, existsSync(path) ? norm(readFileSync(path, "utf8")) : "");
  return pageCache.get(key) || null;
}

test("every counselling quote appears word for word on its cited page", () => {
  const missing: string[] = [];
  let checked = 0;
  for (const e of file.entries) {
    for (const q of quotesOf(e)) {
      const text = pageText(q.source, q.page);
      checked++;
      if (!text) missing.push(`${e.id}: no text for ${q.source} page ${q.page}`);
      else if (!text.includes(norm(q.quote))) missing.push(`${e.id}: not on ${q.source} page ${q.page}: "${q.quote}"`);
    }
  }
  assert.deepEqual(missing, []);
  assert.ok(checked >= file.entries.length, "every verified entry has at least its main quote");
});

test("every protocol rule quote appears on its cited booklet page", () => {
  const missing: string[] = [];
  const visit = (obj: unknown, inRetired: boolean): void => {
    if (Array.isArray(obj)) return obj.forEach((v) => visit(v, inRetired));
    if (!obj || typeof obj !== "object") return;
    const o = obj as Record<string, unknown>;
    const sc = o.source_check as { method?: string; quote?: string } | undefined;
    if (!inRetired && sc?.method === "ai-compared-to-booklet" && sc.quote) {
      const text = pageText("booklet", Number(o.source_page));
      if (!text?.includes(norm(sc.quote))) missing.push(`${String(o.id ?? o.group ?? "?")} page ${String(o.source_page)}: "${sc.quote}"`);
    }
    for (const [k, v] of Object.entries(o)) visit(v, inRetired || k === "retired_rules");
  };
  visit(protocol, false);
  assert.deepEqual(missing, []);
});

test("the quote check would catch a quote that is not on the page", () => {
  const e = clone().entries[0];
  e.source_check.quote = "Give the child cough syrup";
  const [q] = quotesOf(e);
  assert.equal(pageText(q.source, q.page)!.includes(norm(q.quote)), false);
});

// ---------------------------------------------------------------------------
// Loader rules, the same as for the protocol
// ---------------------------------------------------------------------------

test("the counselling file is valid against the protocol", () => {
  assert.doesNotThrow(() => validateCounselling(file, protocol));
});

test("verified:true is refused without a numeric page, a quote and a date", () => {
  const cases: [string, (e: CounsellingEntry) => void, RegExp][] = [
    ["page as text", (e) => (e.source_page = "SOURCE_PAGE_TBD"), /numeric page/],
    ["page missing", (e) => (e.source_page = null), /numeric page/],
    ["no quote", (e) => (e.source_check.quote = " "), /needs a quote/],
    ["no date", (e) => delete e.source_check.date, /needs a date/],
    ["not-confirmed but verified", (e) => (e.source_check.method = "not-confirmed"), /without a source_check/],
    ["reviewed without a reviewer", (e) => (e.source_check.method = "clinician-reviewed"), /needs a reviewer/],
  ];
  for (const [name, mutate, err] of cases) {
    const f = clone();
    mutate(f.entries[0]);
    assert.throws(() => validateCounselling(f, protocol), err, name);
  }
});

test("an unverified entry must say not-confirmed and give a reason", () => {
  const f = clone();
  f.entries[0].verified = false;
  assert.throws(() => validateCounselling(f, protocol), /must be not-confirmed/);
  f.entries[0].source_check = { method: "not-confirmed" };
  assert.throws(() => validateCounselling(f, protocol), /needs a reason/);
  f.entries[0].source_check = { method: "not-confirmed", reason: "text not found in the booklet" };
  assert.doesNotThrow(() => validateCounselling(f, protocol));
});

test("advice cannot point at a retired or unknown classification", () => {
  const retired = ["mastoiditis", "acute_ear_infection", "chronic_ear_infection", "no_ear_infection", "severe_complicated_measles", "measles_with_eye_or_mouth_complications", "measles"];
  const known = classificationIds(protocol);
  for (const id of retired) assert.equal(known.has(id), false, `${id} is retired`);
  for (const id of [...retired, "no_such_classification"]) {
    const f = clone();
    f.entries[0].applies_to = [id];
    assert.throws(() => validateCounselling(f, protocol), /not a classification in the protocol/, id);
  }
});

test("Hindi titles and steps must be Devanagari, and match the English step count", () => {
  const f = clone();
  f.entries[0].steps_hi = ["bachche ko turant aspatal le jaiye"];
  assert.throws(() => validateCounselling(f, protocol), /Devanagari/);
  const g = clone();
  g.entries[0].steps_hi = [...g.entries[0].steps_hi, "अतिरिक्त"];
  assert.throws(() => validateCounselling(g, protocol), /same length/);
});

// ---------------------------------------------------------------------------
// Which advice a result shows
// ---------------------------------------------------------------------------

const bandOf = new Map<string, Band>([["general_danger_sign", "pink"]]);
for (const a of protocol.assessments) {
  for (const t of [...(a.classifications ? [{ classifications: a.classifications }] : []), ...(a.classification_groups ?? [])]) {
    for (const c of t.classifications) bandOf.set(c.id, c.band as Band);
  }
}
const one = (id: string) => [{ id, band: bandOf.get(id)! }];
const AGES = [3, 7, 10, 18, 36];

test("each classification shows only advice written for it", () => {
  for (const id of classificationIds(protocol)) {
    for (const age of AGES) {
      for (const e of adviceFor(file, one(id), age)) {
        assert.ok(e.applies_to.includes(id), `${e.id} shown for ${id}`);
      }
    }
  }
});

test("every entry is shown for each classification it names, at an age it covers", () => {
  for (const e of file.entries) {
    const age = e.age_months_min != null ? Math.max(2, e.age_months_min) : 24;
    for (const id of e.applies_to) {
      assert.ok(adviceFor(file, one(id), age).some((x) => x.id === e.id), `${e.id} missing for ${id} at ${age} months`);
    }
  }
});

test("no advice for a result with no matching entry", () => {
  assert.deepEqual(adviceFor(file, [], 24), []);
  assert.deepEqual(adviceFor(file, [{ id: "chronic_ear_infection", band: "yellow" }, { id: "measles", band: "yellow" }], 24), []);
  const onlyCough = clone();
  onlyCough.entries = onlyCough.entries.filter((e) => e.id === "cough_cold_home_care");
  assert.deepEqual(adviceFor(onlyCough, one("no_dehydration"), 24), []);
  assert.deepEqual(
    adviceFor(onlyCough, one("pneumonia"), 24).map((e) => e.id),
    ["cough_cold_home_care"],
  );
});

test("feeding advice follows the child's age band, and needs a known age", () => {
  const feeding = (age: number | null, id = "moderate_acute_malnutrition") =>
    adviceFor(file, one(id), age)
      .filter((e) => e.id.startsWith("feeding_"))
      .map((e) => e.id);
  assert.deepEqual(feeding(4), ["feeding_up_to_6_months"]);
  assert.deepEqual(feeding(6), ["feeding_6_to_9_months"]);
  assert.deepEqual(feeding(11), ["feeding_9_to_12_months"]);
  assert.deepEqual(feeding(23), ["feeding_12_to_24_months"]);
  assert.deepEqual(feeding(24), ["feeding_2_years_and_older"]);
  assert.deepEqual(feeding(null), []);
  // The booklet counsels feeding for NO ACUTE MALNUTRITION only under 2 years.
  assert.deepEqual(feeding(18, "no_acute_malnutrition"), ["feeding_12_to_24_months"]);
  assert.deepEqual(feeding(30, "no_acute_malnutrition"), []);
});

test("keep-warm advice appears only for severe acute malnutrition, the one place the booklet gives it", () => {
  for (const id of classificationIds(protocol)) {
    const shown = adviceFor(file, one(id), 24).some((e) => e.id === "keep_warm_on_the_way");
    assert.equal(shown, id === "severe_acute_malnutrition", id);
  }
});

const NO_DANGER: Signs = { unable_to_drink: false, vomits_everything: false, convulsions: false, lethargic_unconscious: false, convulsing_now: false };
const NO_SYMPTOMS: Signs = { has_cough: false, has_diarrhoea: false, has_fever: false };
const NORMAL_NUTRITION: Signs = { wfl_band: "at_or_above_minus_2sd", oedema_both_feet: false, muac_cm: 13.5, palmar_pallor: "none" };
const well = (extra: Signs = {}): Signs => ({ ...NO_DANGER, ...NO_SYMPTOMS, ...NORMAL_NUTRITION, ...extra });
const adviceIds = (signs: Signs, age: number) => {
  const r = evaluate(protocol, { signs, ageMonths: age });
  return { outcome: r.outcome, ids: adviceFor(file, r.classifications, r.ageMonths).map((e) => e.id) };
};

test("pink result: go-to-hospital and keep-warm come first", () => {
  const { outcome, ids } = adviceIds(well({ oedema_both_feet: true }), 24);
  assert.equal(outcome, "urgent_referral");
  assert.deepEqual(ids.slice(0, 3), ["refer_urgently", "keep_warm_on_the_way", "breastfeed_against_low_blood_sugar"]);
  const danger = adviceIds(well({ unable_to_drink: true }), 24);
  assert.equal(danger.outcome, "urgent_referral");
  assert.equal(danger.ids[0], "refer_urgently");
});

test("severe dehydration gets ORS sips on the way first", () => {
  const signs = well({
    has_diarrhoea: true,
    diarrhoea_duration_days: 2,
    blood_in_stool: false,
    restless_irritable: false,
    sunken_eyes: true,
    drinks_poorly: true,
    drinks_eagerly: false,
    skin_pinch_very_slow: true,
    skin_pinch_slow: false,
  });
  const r = evaluate(protocol, { signs, ageMonths: 24 });
  assert.ok(r.classifications.some((c) => c.id === "severe_dehydration"));
  const ids = adviceFor(file, r.classifications, 24).map((e) => e.id);
  assert.deepEqual(ids.slice(0, 2), ["refer_urgently", "ors_sips_on_the_way"]);
  assert.equal(ids.includes("diarrhoea_extra_fluid"), false);
});

test("a non-pink result keeps file order and shows no urgent entries", () => {
  const { outcome, ids } = adviceIds(well({ has_cough: true, cough_duration_days: 3, respiratory_rate: 45, chest_indrawing: false, oxygen_saturation: 96 }), 36);
  assert.equal(outcome, "refer"); // the protocol marks PNEUMONIA refer: true; the band is still yellow
  assert.deepEqual(ids, ["cough_cold_home_care", "return_at_once_any_sick_child", "follow_up_earliest_day"]);
});

test("unverified entries are flagged as draft, the same as unverified rules", () => {
  const e = { ...file.entries[0], verified: false, source_check: { method: "not-confirmed" as const, reason: "x" } };
  assert.equal(entryVerification(e), "draft");
  assert.equal(entryVerification(file.entries[0]), "ai-compared");
});

test("read-aloud text is in one language per call", () => {
  const entries = adviceFor(file, one("severe_acute_malnutrition"), 24);
  const hi = adviceSpeech(entries, "hi");
  const en = adviceSpeech(entries, "en");
  assert.match(hi, /अस्पताल/);
  assert.equal(/[A-Za-z]{4,}/.test(hi.replace(/ORS/g, "")), false);
  assert.match(en, /Go to the hospital now/);
  assert.equal(/[ऀ-ॿ]/.test(en), false);
});

// ---------------------------------------------------------------------------
// Held text, app notes, cup sizes, open questions
// ---------------------------------------------------------------------------

const held = file.entries.flatMap((e) => (e.held_steps ?? []).map((h) => ({ entry: e.id, ...h })));

test("the honey and home-remedy sentence is held, with a reason, and still matches its page", () => {
  const honey = held.find((h) => h.entry === "cough_cold_home_care");
  assert.ok(honey, "held step present");
  assert.equal(honey.hold, true);
  assert.match(honey.hold_reason, /needs clinician decision; honey under 1 year is commonly advised against/);
  assert.match(honey.step_en, /honey/);
  assert.ok(pageText("booklet", honey.source_page)!.includes(norm(honey.quote)));
  // Everything else in the entry stays, including the separate "avoid cough syrups" sentence.
  const cough = file.entries.find((e) => e.id === "cough_cold_home_care")!;
  assert.ok(cough.steps_en.includes("Do not give cough syrups."));
  assert.equal(cough.steps_en.length, 5);
});

test("held text is never shown on the card or read aloud, for any result or age", () => {
  const card = readFileSync(new URL("app/record/TriageCard.tsx", root), "utf8");
  assert.equal(card.includes("held_steps"), false, "the card never reads held_steps");
  const banned = [...held.flatMap((h) => [h.step_en, h.step_hi]), "honey", "शहद"];
  for (const id of classificationIds(protocol)) {
    for (const age of [2, 7, 10, 18, 36, null]) {
      const entries = adviceFor(file, one(id), age);
      const shown = [
        ...entries.flatMap((e) => [...visibleSteps(e, "en"), ...visibleSteps(e, "hi")]),
        adviceSpeech(entries, "en"),
        adviceSpeech(entries, "hi"),
      ].join("\n");
      for (const text of banned) assert.equal(shown.includes(text), false, `"${text}" shown for ${id} at ${age}`);
    }
  }
});

test("a held step needs hold: true and a reason", () => {
  const f = clone();
  f.entries.find((e) => e.id === "cough_cold_home_care")!.held_steps![0].hold_reason = "";
  assert.throws(() => validateCounselling(f, protocol), /hold_reason/);
});

test("the ORS packet note is an app note: labelled on the card, read aloud, never verified", () => {
  const ors = file.entries.find((e) => e.id === "how_to_make_ors")!;
  assert.deepEqual(ors.app_notes!.map((n) => n.en), ["Use the amount of water printed on the ORS packet."]);
  // The quoted source steps are kept as they were.
  assert.ok(ors.steps_en.some((s) => s.includes("1 litre (1000 ml)")));
  const card = readFileSync(new URL("app/record/TriageCard.tsx", root), "utf8");
  assert.ok(card.includes("App note, not from the booklet"));
  // Read aloud with the other advice, in the chosen language only, after the source steps.
  const en = adviceSpeech([ors], "en");
  const hi = adviceSpeech([ors], "hi");
  for (const n of ors.app_notes!) {
    assert.ok(en.includes(n.en) && hi.includes(n.hi));
    assert.equal(en.includes(n.hi) || hi.includes(n.en), false);
    assert.ok(en.indexOf(n.en) > en.indexOf(ors.steps_en.at(-1)!));
  }
  // The label is for the card, not for the mother's ears.
  assert.equal(/app note/i.test(en), false);
  // Its presence does not change how the entry was checked, and quotesOf never includes it.
  assert.equal(entryVerification(ors), "ai-compared");
  assert.equal(quotesOf(ors).some((q) => q.quote.includes("printed on the ORS packet")), false);
  // An app note cannot carry a verification of its own.
  const f = clone();
  (f.entries.find((e) => e.id === "how_to_make_ors")!.app_notes![0] as unknown as Record<string, unknown>).verified = true;
  assert.throws(() => validateCounselling(f, protocol), /app note has only en and hi/);
});

/** "cup" or "कप" as a word: not the start of कपड़ा (cloth). */
const CUP = /\b(cups?)\b|कप(?![\u0900-\u097F])/g;
/** A cup is an amount when a number, fraction or amount word comes just before it. */
const AMOUNT_BEFORE = /([\d¼½¾]|half|quarter|आधा|चौथाई|पौना)\s*$/i;
/** ...and then it must be followed by its millilitres. */
const ML_AFTER = /^\s*(\((about |लगभग )?\d+([–-]\d+)? ?ml\)|= ?\d+ ?ml)/;
/** Cups that are the vessel, not an amount. Each one is listed, so a new one has to be looked at. */
const VESSEL = ["from a cup.", "ORS कप से"];

test("every cup amount shows millilitres beside it, in English and Hindi", () => {
  const problems: string[] = [];
  for (const e of file.entries) {
    const texts = [...e.steps_en, ...e.steps_hi, ...(e.app_notes ?? []).flatMap((n) => [n.en, n.hi])];
    for (const t of texts) {
      for (const m of t.matchAll(CUP)) {
        const before = t.slice(Math.max(0, m.index! - 12), m.index!);
        const after = t.slice(m.index! + m[0].length);
        const amount = AMOUNT_BEFORE.test(before) || /^\s*\(/.test(after);
        if (amount && !ML_AFTER.test(after)) problems.push(`${e.id}: "${t.slice(Math.max(0, m.index! - 15), m.index! + 25)}"`);
        if (!amount && !VESSEL.some((v) => t.includes(v))) {
          problems.push(`${e.id}: cup that is neither an amount with ml nor a listed vessel: "${t}"`);
        }
      }
    }
  }
  assert.deepEqual(problems, []);
});

test("the cup check catches a cup amount without ml", () => {
  const bad = "Give at least ½ cup at a time.";
  const m = [...bad.matchAll(CUP)][0];
  assert.ok(AMOUNT_BEFORE.test(bad.slice(0, m.index!)));
  assert.equal(ML_AFTER.test(bad.slice(m.index! + m[0].length)), false);
  assert.equal([..."मुलायम सूती कपड़े से".matchAll(CUP)].length, 0, "कपड़ा is cloth, not a cup");
});

test("the diarrhoea follow-up question (2 or 5 days) is recorded as an open question, and the advice gives no number", () => {
  const fu = file.entries.find((e) => e.id === "follow_up_earliest_day")!;
  assert.match(fu.open_question!, /2 days/);
  assert.match(fu.open_question!, /5 days/);
  assert.equal(/\d/.test(fu.steps_en.join(" ") + fu.steps_hi.join(" ")), false);
  const some = [...protocol.assessments.flatMap((a) => (a.classification_groups ?? []).flatMap((g) => g.classifications))].find((c) => c.id === "some_dehydration");
  assert.equal(some?.follow_up_days, 2, "the protocol keeps its value");
});

test("held_steps are never read aloud or shown, even when every entry is read at once", () => {
  assert.ok(held.length > 0);
  const everything = [
    adviceSpeech(file.entries, "en"),
    adviceSpeech(file.entries, "hi"),
    ...file.entries.flatMap((e) => [...visibleSteps(e, "en"), ...visibleSteps(e, "hi")]),
  ].join("\n");
  for (const h of held) {
    assert.equal(everything.includes(h.step_en), false, h.step_en);
    assert.equal(everything.includes(h.step_hi), false, h.step_hi);
  }
  for (const word of ["honey", "tulsi", "ginger", "शहद", "तुलसी", "अदरक"]) assert.equal(everything.includes(word), false, word);
});
