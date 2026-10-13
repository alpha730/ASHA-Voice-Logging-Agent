import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { LANGS, pickText, resolvedLang, toLang, type Localized } from "./i18n.ts";
import { t, UI_TEXT, type UiTextFile } from "./text.ts";
import { applyMarwari, marwariTodo, type TodoFile, type UiTextTable } from "./marwari.ts";
import { readSetting, SETTING_KEYS, writeSetting } from "./settings.ts";
import { relayOptions, relaySession, streamingUrl, sttLanguageFor, upstreamConnection } from "./sarvam.ts";
import { adviceFor, adviceSpeech, appNotesOf, titleOf, visibleSteps, type CounsellingFile } from "./imnci/counselling.ts";
import { buildSteps, isUnknownAnswer, parseStepAnswer, parseYesNo, promptOf, promptText, REFERENCE_ANSWERS, setMarwariAnswers } from "./imnci/flow.ts";
import type { ImnciProtocol } from "./imnci/rules.ts";

const root = new URL("../", import.meta.url);
const read = <T>(name: string) => JSON.parse(readFileSync(new URL(name, root), "utf8")) as T;
const protocol = () => read<ImnciProtocol>("imnci-sick-child-2m-5y.json");
const counselling = () => read<CounsellingFile>("counselling.json");
const ui = () => read<UiTextTable>("ui-text.json");

// Devanagari test markers. They are not Marwari wording; real Marwari comes from a native speaker.
const MARK = "परीक्षण";
const REVIEW = { reviewed_by: "Test Reviewer", reviewed_on: "2026-10-20" };

// ---------------------------------------------------------------------------
// Language fallback
// ---------------------------------------------------------------------------

test("Marwari falls back to Hindi when missing, unreviewed, not Devanagari, or with different placeholders", () => {
  const base: Localized = { en: "Child is {months} months", hi: "बच्चा {months} महीने का" };
  const cases: [string, Localized["mwr"]][] = [
    ["missing", undefined],
    ["null", null],
    ["no reviewer", { text: `${MARK} {months}`, reviewed_by: "", reviewed_on: "2026-10-20" }],
    ["blank reviewer", { text: `${MARK} {months}`, reviewed_by: "   ", reviewed_on: "2026-10-20" }],
    ["no date", { text: `${MARK} {months}`, reviewed_by: "R", reviewed_on: "" }],
    ["bad date", { text: `${MARK} {months}`, reviewed_by: "R", reviewed_on: "20/10/2026" }],
    ["empty text", { text: "", ...REVIEW }],
    ["Latin text", { text: "baccho {months}", ...REVIEW }],
    ["placeholder missing", { text: MARK, ...REVIEW }],
  ];
  for (const [name, mwr] of cases) {
    const e = { ...base, mwr };
    assert.equal(resolvedLang(e, "mwr"), "hi", name);
    assert.equal(pickText(e, "mwr", { months: 18 }), "बच्चा 18 महीने का", name);
  }
  const reviewed = { ...base, mwr: { text: `${MARK} {months}`, ...REVIEW } };
  assert.equal(pickText(reviewed, "mwr", { months: 18 }), `${MARK} 18`);
  // Hindi and English never change because Marwari exists.
  assert.equal(pickText(reviewed, "hi", { months: 18 }), "बच्चा 18 महीने का");
  assert.equal(pickText(reviewed, "en", { months: 18 }), "Child is 18 months");
});

test("today every app sentence in Marwari mode is the Hindi sentence, since no Marwari has been reviewed", () => {
  for (const id of Object.keys(UI_TEXT.texts)) assert.equal(t(id, "mwr"), t(id, "hi"), id);
  // The unreviewed path also holds when a file carries Marwari without a reviewer.
  const file: UiTextFile = { texts: { x: { where: "test", en: "Yes", hi: "हाँ", mwr: { text: MARK, reviewed_by: "", reviewed_on: "" } } } };
  assert.equal(t("x", "mwr", undefined, file), "हाँ");
});

test("a request's language: hi, en and mwr are kept; anything else is Hindi", () => {
  assert.deepEqual(LANGS, ["hi", "en", "mwr"]);
  assert.equal(toLang("mwr"), "mwr");
  assert.equal(toLang("en"), "en");
  assert.equal(toLang("marwari"), "hi");
  assert.equal(toLang(undefined), "hi");
});

test("clinical questions: protocol Marwari is used only once reviewed", () => {
  const p = protocol();
  const item = p.general_danger_signs.ask[0];
  const hiStep = () => buildSteps(p).find((s) => s.key === item.id)!;
  assert.equal(promptText(hiStep(), "mwr"), promptText(hiStep(), "hi"), "no mwr field: Hindi");
  item.mwr = { question: `${MARK} 1`, reviewed_by: "", reviewed_on: "2026-10-20" };
  assert.equal(promptOf(hiStep().prompt, "mwr"), item.question_hi, "unreviewed: Hindi");
  item.mwr = { question: `${MARK} 1`, ...REVIEW };
  assert.equal(promptOf(hiStep().prompt, "mwr"), `${MARK} 1`);
  assert.equal(promptOf(hiStep().prompt, "hi"), item.question_hi);
  assert.equal(promptOf(hiStep().prompt, "en"), item.question_en);
});

test("advice: an entry's Marwari is used only when reviewed and complete", () => {
  const c = counselling();
  const e = c.entries.find((x) => x.id === "how_to_make_ors")!;
  const full = { title: `${MARK} शीर्षक`, steps: e.steps_en.map((_, i) => `${MARK} ${i + 1}`), app_notes: [`${MARK} नोट`], ...REVIEW };
  e.mwr = { ...full, reviewed_by: "" };
  assert.deepEqual(visibleSteps(e, "mwr"), e.steps_hi, "unreviewed");
  e.mwr = { ...full, steps: full.steps.slice(1) };
  assert.deepEqual(visibleSteps(e, "mwr"), e.steps_hi, "a step missing");
  e.mwr = { ...full, app_notes: [] };
  assert.deepEqual(visibleSteps(e, "mwr"), e.steps_hi, "the app note missing");
  e.mwr = full;
  assert.equal(titleOf(e, "mwr"), full.title);
  assert.deepEqual(visibleSteps(e, "mwr"), full.steps);
  assert.deepEqual(appNotesOf(e, "mwr"), full.app_notes);
  assert.deepEqual(visibleSteps(e, "hi"), e.steps_hi);
});

test("held Marwari text is never shown or spoken", () => {
  const c = counselling();
  const cough = c.entries.find((x) => x.id === "cough_cold_home_care")!;
  const heldMwr = `${MARK} रोका गया`;
  cough.held_steps![0].mwr = heldMwr;
  cough.mwr = { title: `${MARK} खांसी`, steps: cough.steps_en.map((_, i) => `${MARK} ${i + 1}`), ...REVIEW };
  const entries = adviceFor(c, [{ id: "pneumonia", band: "yellow" }], 36);
  const all = [adviceSpeech(entries, "mwr"), ...entries.flatMap((x) => [titleOf(x, "mwr"), ...visibleSteps(x, "mwr"), ...appNotesOf(x, "mwr")])].join("\n");
  assert.ok(all.includes(`${MARK} 1`), "the entry's own Marwari is shown");
  assert.equal(all.includes(heldMwr), false);
  for (const h of cough.held_steps!) assert.equal(all.includes(h.step_hi) || all.includes(h.step_en), false);
  // Held steps are not even put on the list for translation.
  const todo = marwariTodo(ui(), protocol(), c);
  assert.equal(todo.items.some((i) => i.hi === cough.held_steps![0].step_hi), false);
});

// ---------------------------------------------------------------------------
// marwari-todo.json and scripts/apply-marwari.ts
// ---------------------------------------------------------------------------

test("marwari-todo.json lists every string, with id, where, English and Hindi, and is up to date", () => {
  const fresh = marwariTodo(ui(), protocol(), counselling());
  const committed = read<TodoFile>("marwari-todo.json");
  assert.deepEqual(committed.items.map((i) => i.id), fresh.items.map((i) => i.id), "run node scripts/marwari-todo.ts");
  for (const it of committed.items) {
    assert.ok(it.id && it.where && it.en && it.hi, it.id);
    assert.equal(it.mwr, "", `${it.id}: Marwari starts empty`);
  }
  assert.ok(committed.items.some((i) => i.id === "ui:agent.question.worker_name"));
  assert.ok(committed.items.some((i) => i.id === "protocol:unable_to_drink"));
  assert.ok(committed.items.some((i) => i.id === "counselling:how_to_make_ors:step:1"));
  assert.equal(committed.reviewer, "");
});

function filled(ids: Record<string, string>, over: Partial<TodoFile> = {}): TodoFile {
  const todo = marwariTodo(ui(), protocol(), counselling());
  for (const it of todo.items) if (it.id in ids) it.mwr = ids[it.id];
  return { ...todo, reviewer: "Test Reviewer", reviewed_on: "2026-10-20", ...over };
}

test("apply: a file with no reviewer name, or no date, or unknown ids is refused", () => {
  for (const reviewer of ["", "  "]) {
    assert.throws(() => applyMarwari(ui(), protocol(), counselling(), filled({ "ui:ui.advice.read": MARK }, { reviewer })), /no reviewer name/);
  }
  assert.throws(() => applyMarwari(ui(), protocol(), counselling(), filled({}, { reviewed_on: "" })), /review date/);
  const bad = filled({});
  bad.items.push({ id: "ui:no.such.text", where: "", en: "", hi: "", placeholders: [], mwr: MARK });
  assert.throws(() => applyMarwari(ui(), protocol(), counselling(), bad), /not a current string/);
});

test("apply: writes reviewed mwr fields, skips bad items, keeps advice whole", () => {
  const ors = counselling().entries.find((e) => e.id === "how_to_make_ors")!;
  const orsIds: Record<string, string> = { "counselling:how_to_make_ors:title": `${MARK} ORS`, "counselling:how_to_make_ors:app_note:1": `${MARK} नोट` };
  ors.steps_en.forEach((_, i) => (orsIds[`counselling:how_to_make_ors:step:${i + 1}`] = `${MARK} ${i + 1}`));
  const out = applyMarwari(
    ui(),
    protocol(),
    counselling(),
    filled({
      "ui:triage.age_line": `${MARK} {months}`,
      "ui:triage.age_unclear": `${MARK}`, // placeholders dropped
      "ui:ui.advice.read": "padhiye", // not Devanagari
      "protocol:unable_to_drink": `${MARK} पीना`,
      "protocol:trigger:cough": `${MARK} खांसी`,
      "counselling:fever_home_care:title": `${MARK} बुखार`, // the rest of that entry is blank
      ...orsIds,
    }),
  );
  assert.deepEqual(out.ui.texts["triage.age_line"].mwr, { text: `${MARK} {months}`, ...REVIEW });
  assert.equal(t("triage.age_line", "mwr", { months: 9 }, out.ui as UiTextFile), `${MARK} 9`);
  assert.equal(out.ui.texts["triage.age_unclear"].mwr, undefined);
  assert.equal(out.ui.texts["ui.advice.read"].mwr, undefined);
  assert.deepEqual(out.protocol.general_danger_signs.ask.find((i) => i.id === "unable_to_drink")!.mwr, { question: `${MARK} पीना`, ...REVIEW });
  assert.deepEqual(out.protocol.assessments.find((a) => a.id === "cough")!.trigger!.mwr, { question: `${MARK} खांसी`, ...REVIEW });
  assert.equal(out.counselling.entries.find((e) => e.id === "fever_home_care")!.mwr, undefined);
  const orsOut = out.counselling.entries.find((e) => e.id === "how_to_make_ors")!;
  assert.equal(titleOf(orsOut, "mwr"), `${MARK} ORS`);
  assert.deepEqual(appNotesOf(orsOut, "mwr"), [`${MARK} नोट`]);
  const reasons = Object.fromEntries(out.report.skipped.map((s) => [s.id, s.reason]));
  assert.match(reasons["ui:triage.age_unclear"], /placeholders/);
  assert.match(reasons["ui:ui.advice.read"], /Devanagari/);
  assert.match(reasons["counselling:fever_home_care:title"], /incomplete/);
  // The inputs are untouched.
  assert.equal(ui().texts["triage.age_line"].mwr, undefined);
});

test("apply script: refuses a file with no reviewer name and writes nothing", () => {
  const dir = mkdtempSync(join(tmpdir(), "mwr-"));
  const files = { ui: join(dir, "ui.json"), protocol: join(dir, "p.json"), counselling: join(dir, "c.json"), todo: join(dir, "todo.json") };
  writeFileSync(files.ui, readFileSync(new URL("ui-text.json", root)));
  writeFileSync(files.protocol, readFileSync(new URL("imnci-sick-child-2m-5y.json", root)));
  writeFileSync(files.counselling, readFileSync(new URL("counselling.json", root)));
  const run = (todo: TodoFile, extra: string[] = []) => {
    writeFileSync(files.todo, JSON.stringify(todo));
    const script = fileURLToPath(new URL("scripts/apply-marwari.ts", root));
    return spawnSync(process.execPath, ["--disable-warning=MODULE_TYPELESS_PACKAGE_JSON", script, files.todo, "--ui", files.ui, "--protocol", files.protocol, "--counselling", files.counselling, ...extra], { encoding: "utf8" });
  };
  const before = readFileSync(files.ui, "utf8");
  const refused = run(filled({ "ui:ui.advice.read": MARK }, { reviewer: "" }));
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /no reviewer name/);
  assert.equal(readFileSync(files.ui, "utf8"), before);
  // The reviewer may also be given on the command line.
  const ok = run(filled({ "ui:ui.advice.read": MARK }, { reviewer: "" }), ["--reviewer", "Test Reviewer", "--date", "2026-10-20"]);
  assert.equal(ok.status, 0, ok.stderr);
  assert.equal(JSON.parse(readFileSync(files.ui, "utf8")).texts["ui.advice.read"].mwr.reviewed_by, "Test Reviewer");
  rmSync(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Marwari answer words
// ---------------------------------------------------------------------------

afterEach(() => setMarwariAnswers({ yes: [], no: [], unknown: [] }));

const reading = (a: string) => (isUnknownAnswer(a) ? "unknown" : String(parseYesNo(a)));
const SAMPLE = { yes: ["hau", "haanji sa"], no: ["koni", "na koni"], unknown: ["zzpato nahi", "koni zzthauk"] }; // test tokens

test("Marwari answer words never change how Hindi and English answers are read", () => {
  const extra = ["nahi pee raha", "haan pee raha hai", "kon", "kona", "hau hau", "ji", "na sa", "pee", "doodh koni"];
  const corpus = [...REFERENCE_ANSWERS, ...extra.filter((a) => !/\b(hau|koni)\b/.test(a))];
  const before = corpus.map(reading);
  setMarwariAnswers(SAMPLE);
  assert.deepEqual(corpus.map(reading), before);
});

test("Marwari words: whole words only, yes and no only when Hindi/English do not decide, unknown first", () => {
  setMarwariAnswers(SAMPLE);
  assert.equal(parseYesNo("hau"), true);
  assert.equal(parseYesNo("koni"), false);
  assert.equal(parseYesNo("haanji sa"), true);
  assert.equal(parseYesNo("kona"), null, "not inside another word");
  assert.equal(parseYesNo("hauli"), null);
  assert.equal(isUnknownAnswer("zzpato nahi"), true, "unknown even though it contains nahi");
  const step = buildSteps(protocol()).find((s) => s.key === "vomits_everything")!;
  assert.equal(parseStepAnswer(step, "zzpato nahi"), null, "an unknown answer is never 'no'");
  assert.deepEqual(parseStepAnswer(step, "koni"), { vomits_everything: false });
});

test("a Marwari word list that would change a Hindi or English answer is refused at start-up", () => {
  for (const words of [{ yes: ["kabhi"] }, { unknown: ["kuch nahi"] }, { unknown: ["nahi"] }, { yes: ["nahi"] }, { no: ["haan"] }, { yes: ["hau"], no: ["hau"] }]) {
    assert.throws(() => setMarwariAnswers({ yes: [], no: [], unknown: [], ...words }), /Invalid marwari-answers.json/, JSON.stringify(words));
  }
  // A refused list leaves the previous one in place.
  assert.equal(parseYesNo("kabhi kabhi"), null);
});

test("marwari-answers.json starts empty", () => {
  assert.deepEqual(read<{ yes: string[]; no: string[]; unknown: string[] }>("marwari-answers.json"), {
    ...read<object>("marwari-answers.json"),
    yes: [],
    no: [],
    unknown: [],
  });
});

// ---------------------------------------------------------------------------
// Settings and speech-to-text
// ---------------------------------------------------------------------------

function fakeStore() {
  const data = new Map<string, string>();
  return { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => void data.set(k, v) };
}

test("the language and mic settings persist, and broken storage falls back to the defaults", () => {
  const store = fakeStore();
  assert.equal(readSetting(store, SETTING_KEYS.lang, LANGS, "hi"), "hi");
  writeSetting(store, SETTING_KEYS.lang, "mwr");
  assert.equal(readSetting(store, SETTING_KEYS.lang, LANGS, "hi"), "mwr");
  writeSetting(store, SETTING_KEYS.micMode, "tap");
  assert.equal(readSetting(store, SETTING_KEYS.micMode, ["hold", "tap"] as const, "hold"), "tap");
  writeSetting(store, SETTING_KEYS.lang, "fr");
  assert.equal(readSetting(store, SETTING_KEYS.lang, LANGS, "hi"), "hi", "unknown value");
  const broken = { getItem: () => { throw new Error("blocked"); }, setItem: () => { throw new Error("blocked"); } };
  assert.equal(readSetting(broken, SETTING_KEYS.lang, LANGS, "hi"), "hi");
  assert.doesNotThrow(() => writeSetting(broken, SETTING_KEYS.lang, "mwr"));
  assert.equal(readSetting(null, SETTING_KEYS.micMode, ["hold", "tap"] as const, "hold"), "hold");
});

test("speech-to-text in Marwari mode is hi-IN, never auto-detect, with code-mixing kept", () => {
  const saved = { ...process.env };
  process.env.SARVAM_API_KEY = "test-key";
  process.env.SARVAM_LANGUAGE_CODE = "auto";
  try {
    assert.equal(sttLanguageFor("mwr"), "hi-IN");
    assert.equal(sttLanguageFor("hi"), null);
    assert.equal(sttLanguageFor("en"), null);
    const browserUrl = new URL(streamingUrl("tok", 16000, { language: sttLanguageFor("mwr"), endpointing: "manual" }));
    const opts = relayOptions(browserUrl.searchParams);
    assert.deepEqual(opts, { sampleRate: 16000, language: "hi-IN", endpointing: "manual" });
    const upstream = new URL(upstreamConnection(opts.sampleRate, opts).url).searchParams;
    assert.equal(upstream.get("language_code"), "hi-IN");
    assert.equal(upstream.get("mode"), "codemix");
    assert.equal(upstream.get("endpointing"), "manual");
    // Hindi mode keeps the configured default.
    const hindi = relayOptions(new URL(streamingUrl("tok", 16000, { language: sttLanguageFor("hi") })).searchParams);
    assert.equal(new URL(upstreamConnection(16000, hindi).url).searchParams.get("language_code"), "auto");
    // A language the relay does not allow is ignored.
    assert.equal(relayOptions(new URLSearchParams({ language_code: "x;drop" })).language, null);
  } finally {
    process.env = saved;
  }
});

test("relay: releasing the button sends speech_end and flush, so the last words are transcribed", () => {
  const audio = Buffer.from([1, 2, 3, 4]);
  const control = (type: string) => Buffer.from(JSON.stringify({ type }));
  const events = (msgs: string[]) => msgs.map((m) => JSON.parse(m).event);
  const manual = relaySession("manual");
  assert.deepEqual(events(manual.fromClient(audio, true)), ["speech_start", "audio_input"]);
  assert.deepEqual(events(manual.fromClient(audio, true)), ["audio_input"]);
  assert.deepEqual(events(manual.fromClient(control("ForceEndpoint"), false)), ["speech_end", "flush"]);
  assert.deepEqual(manual.fromClient(control("ForceEndpoint"), false), [], "a second release sends nothing");
  assert.deepEqual(events(manual.fromClient(audio, true)), ["speech_start", "audio_input"], "the next press starts a new utterance");
  assert.deepEqual(events(manual.fromClient(control("Terminate"), false)), ["end"]);
  const vad = relaySession("vad");
  assert.deepEqual(events(vad.fromClient(audio, true)), ["audio_input"]);
  assert.deepEqual(vad.fromClient(control("ForceEndpoint"), false), [], "Sarvam accepts flush only in manual mode");
});

test("Marwari text is spoken with the Hindi voice: Devanagari goes to hi-IN, no new voice", async () => {
  const { splitBySpeechLang } = await import("./speech.ts");
  assert.deepEqual(splitBySpeechLang(`${MARK} ORS ${MARK}`), [
    { text: MARK, lang: "hi-IN" },
    { text: "ORS", lang: "en-IN" },
    { text: MARK, lang: "hi-IN" },
  ]);
});
