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
