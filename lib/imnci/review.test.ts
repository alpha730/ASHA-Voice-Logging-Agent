import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { applyReview, EXPORT_FORMAT, reviewItems, snapshotOf, type ReviewAnswer, type ReviewExport, type Verdict } from "./review.ts";
import type { CounsellingFile } from "./counselling.ts";
import type { ImnciProtocol } from "./rules.ts";

const root = new URL("../../", import.meta.url);
const protocolText = readFileSync(new URL("imnci-sick-child-2m-5y.json", root), "utf8");
const counsellingText = readFileSync(new URL("counselling.json", root), "utf8");
const fresh = () => ({ protocol: JSON.parse(protocolText) as ImnciProtocol, counselling: JSON.parse(counsellingText) as CounsellingFile });
const items = () => reviewItems(fresh().protocol, fresh().counselling);
const item = (key: string) => items().find((i) => i.key === key)!;

function answer(key: string, verdict: Verdict, comment = ""): ReviewAnswer {
  return { key, verdict, comment, reviewed: snapshotOf(item(key)) };
}
function exportOf(answers: ReviewAnswer[], over: Partial<ReviewExport> = {}): ReviewExport {
  const { protocol, counselling } = fresh();
  return {
    format: EXPORT_FORMAT,
    format_version: 1,
    reviewer: "Dr. A. Reviewer",
    date: "2026-10-20",
    protocol_version: protocol.version,
    counselling_version: (counselling as unknown as { version: string }).version,
    exported_at: "2026-10-20T10:00:00Z",
    items: answers,
    ...over,
  };
}

/** Every source_check in both files, by review key, so a test can see exactly what changed. */
function checks(protocol: ImnciProtocol, counselling: CounsellingFile): Map<string, string> {
  const out = new Map<string, string>();
  for (const it of reviewItems(protocol, counselling)) {
    if (it.kind === "decision") continue;
    const found = findCheck(protocol, counselling, it.key);
    out.set(it.key, JSON.stringify(found));
  }
  return out;
}
function findCheck(p: ImnciProtocol, c: CounsellingFile, key: string): unknown {
  if (key.startsWith("counselling:")) return c.entries.find((e) => `counselling:${e.id}` === key)?.source_check;
  if (key === "protocol:general_danger_signs") return p.general_danger_signs.source_check;
  const fb = key.match(/^protocol:(.+)\.fast_breathing$/);
  if (fb) return p.assessments.find((a) => a.id === fb[1])?.derived?.fast_breathing?.source_check;
  const id = key.slice("protocol:".length);
  for (const a of p.assessments) {
    for (const g of a.classification_groups ?? []) {
      if (`${a.id}.${g.group}.escalate_if` === id) return g.escalate_if?.source_check;
      for (const r of g.classifications) if (r.id === id) return r.source_check;
    }
    for (const r of a.classifications ?? []) if (r.id === id) return r.source_check;
  }
  throw new Error(`no check for ${key}`);
}

// ---------------------------------------------------------------------------
// The page's item list
// ---------------------------------------------------------------------------

test("the review lists every classification, every counselling entry and the open decisions", () => {
  const { protocol, counselling } = fresh();
  const keys = new Set(items().map((i) => i.key));
  for (const a of protocol.assessments) {
    for (const r of [...(a.classifications ?? []), ...(a.classification_groups ?? []).flatMap((g) => g.classifications)]) assert.ok(keys.has(`protocol:${r.id}`), r.id);
  }
  assert.ok(keys.has("protocol:general_danger_signs"));
  for (const e of counselling.entries) assert.ok(keys.has(`counselling:${e.id}`), e.id);
  const decisions = items().filter((i) => i.kind === "decision").map((i) => i.key);
  assert.deepEqual(decisions, [
    "decision:honey_home_remedies",
    "decision:ors_packet_and_cup_size",
    "decision:diarrhoea_follow_up_2_or_5_days",
    "decision:zinc_not_covered",
    "decision:asha_action_scope",
    "decision:stop_at_first_danger_sign",
    "decision:pneumonia_referral",
    "decision:ear_and_measles_removed",
  ]);
  for (const k of ["mastoiditis", "measles", "chronic_ear_infection"]) assert.equal(keys.has(`protocol:${k}`), false);
});

test("each rule item shows signs, band, follow-up, page and exact quote, and never imnci_action", () => {
  const pneumonia = item("protocol:pneumonia");
  assert.equal(pneumonia.band, "yellow");
  assert.equal(pneumonia.follow_up_days, 2);
  assert.equal(pneumonia.source_page, "09");
  assert.ok(pneumonia.quote && protocolText.includes(JSON.stringify(pneumonia.quote).slice(1, -1)));
  assert.ok(pneumonia.does.some((d) => d.includes("fast_breathing")));
  // The booklet quote can match the treatment column word for word (no_anaemia), so check the code
  // never reads the imnci_action field rather than comparing text.
  for (const it of items()) assert.equal("imnci_action" in it, false);
  for (const file of ["lib/imnci/review.ts", "app/review/page.tsx", "app/review/ReviewForm.tsx"]) {
    assert.equal(/\.imnci_action|\["imnci_action"\]/.test(readFileSync(new URL(file, root), "utf8")), false, file);
  }
  assert.ok(item("counselling:cough_cold_home_care").notes!.some((n) => n.startsWith("HELD")));
  assert.ok(item("counselling:how_to_make_ors").notes!.some((n) => n.startsWith("App note, not from the booklet")));
  assert.ok(item("counselling:follow_up_earliest_day").notes!.some((n) => n.startsWith("Open question")));
});

// ---------------------------------------------------------------------------
// Applying an export
// ---------------------------------------------------------------------------

test("Correct promotes only that item to clinician-reviewed, with the reviewer's name and date", () => {
  const { protocol, counselling } = fresh();
  const before = checks(protocol, counselling);
  const out = applyReview(protocol, counselling, exportOf([answer("protocol:pneumonia", "correct"), answer("counselling:how_to_give_ors", "correct")]));
  assert.deepEqual(out.report.promoted, ["protocol:pneumonia", "counselling:how_to_give_ors"]);
  const after = checks(out.protocol, out.counselling);
  for (const [key, was] of before) {
    if (out.report.promoted.includes(key)) {
      const sc = JSON.parse(after.get(key)!);
      assert.equal(sc.method, "clinician-reviewed");
      assert.equal(sc.reviewer, "Dr. A. Reviewer");
      assert.equal(sc.date, "2026-10-20");
      assert.equal(sc.quote, JSON.parse(was).quote, "the quote is kept");
    } else assert.equal(after.get(key), was, `${key} must not change`);
  }
  // The inputs were not modified in place.
  assert.deepEqual(protocol, fresh().protocol);
});

test("an item the file does not mention is never promoted or changed", () => {
  const { protocol, counselling } = fresh();
  const out = applyReview(protocol, counselling, exportOf([answer("protocol:no_anaemia", "correct")]));
  const before = fresh();
  // Remove the one promoted item from both sides; everything else must be byte-identical.
  const strip = (p: ImnciProtocol) => {
    const copy = structuredClone(p);
    const row = copy.assessments.flatMap((a) => (a.classification_groups ?? []).flatMap((g) => g.classifications)).find((r) => r.id === "no_anaemia")!;
    delete (row as { source_check?: unknown }).source_check;
    return copy;
  };
  assert.deepEqual(strip(out.protocol), strip(before.protocol));
  assert.deepEqual(out.counselling, before.counselling);
  const promoted = [...checks(out.protocol, out.counselling).values()].filter((v) => v.includes("clinician-reviewed"));
  assert.equal(promoted.length, 1);
});

test("Wrong and Needs change are left unchanged and listed with their comments", () => {
  const { protocol, counselling } = fresh();
  const out = applyReview(
    protocol,
    counselling,
    exportOf([answer("protocol:pneumonia", "wrong", "rate threshold"), answer("counselling:fever_home_care", "needs_change", "add tepid sponging?")]),
  );
  assert.deepEqual(out.report.promoted, []);
  assert.deepEqual(out.report.unchanged, [
    { key: "protocol:pneumonia", verdict: "wrong", comment: "rate threshold" },
    { key: "counselling:fever_home_care", verdict: "needs_change", comment: "add tepid sponging?" },
  ]);
  assert.deepEqual(out.protocol, fresh().protocol);
  assert.deepEqual(out.counselling, fresh().counselling);
});

test("open decisions are listed, never applied", () => {
  const { protocol, counselling } = fresh();
  const out = applyReview(protocol, counselling, exportOf([{ key: "decision:honey_home_remedies", verdict: "correct", comment: "honey only from 1 year" }]));
  assert.deepEqual(out.report.decisions, [{ key: "decision:honey_home_remedies", verdict: "correct", comment: "honey only from 1 year" }]);
  assert.deepEqual(out.counselling, fresh().counselling);
});

test("a file with no reviewer name, or no valid date, is refused", () => {
  const { protocol, counselling } = fresh();
  for (const reviewer of ["", "   ", undefined]) {
    assert.throws(() => applyReview(protocol, counselling, exportOf([answer("protocol:pneumonia", "correct")], { reviewer: reviewer as string })), /no reviewer name/);
  }
  assert.throws(() => applyReview(protocol, counselling, exportOf([], { date: "20/10/2026" })), /review date/);
  assert.throws(() => applyReview(protocol, counselling, { items: [] }), /not a review export/);
});

test("unknown items, duplicates and unknown verdicts refuse the whole file", () => {
  const { protocol, counselling } = fresh();
  assert.throws(() => applyReview(protocol, counselling, exportOf([answer("protocol:pneumonia", "correct"), { key: "protocol:measles", verdict: "correct", comment: "" }])), /protocol:measles: not an item/);
  assert.throws(() => applyReview(protocol, counselling, exportOf([answer("protocol:pneumonia", "correct"), answer("protocol:pneumonia", "wrong")])), /listed twice/);
  assert.throws(() => applyReview(protocol, counselling, exportOf([{ ...answer("protocol:pneumonia", "correct"), verdict: "ok" as Verdict }])), /unknown verdict/);
});

test("Correct is not applied if the page or quote changed after the review, or was not recorded", () => {
  const { protocol, counselling } = fresh();
  const stale = { ...answer("protocol:pneumonia", "correct"), reviewed: { source_page: "09", quote: "an older quote" } };
  const noSnapshot = { key: "protocol:no_pneumonia_cough_or_cold", verdict: "correct" as const, comment: "" };
  const out = applyReview(protocol, counselling, exportOf([stale, noSnapshot]));
  assert.deepEqual(out.report.promoted, []);
  assert.deepEqual(out.report.skipped.map((s) => s.key), ["protocol:pneumonia", "protocol:no_pneumonia_cough_or_cold"]);
  assert.deepEqual(out.protocol, fresh().protocol);
});

test("an unverified item marked Correct is not promoted", () => {
  const { protocol, counselling } = fresh();
  const e = counselling.entries.find((x) => x.id === "fever_home_care")!;
  e.verified = false;
  e.source_check = { method: "not-confirmed", reason: "test" };
  const reviewed = snapshotOf(reviewItems(protocol, counselling).find((i) => i.key === "counselling:fever_home_care")!);
  const out = applyReview(protocol, counselling, exportOf([{ key: "counselling:fever_home_care", verdict: "correct", comment: "", reviewed }]));
  assert.deepEqual(out.report.promoted, []);
  assert.match(out.report.skipped[0].reason, /not verified/);
});

// ---------------------------------------------------------------------------
// The command-line script, on copies of the files
// ---------------------------------------------------------------------------

function runScript(exp: unknown, extra: string[] = []) {
  const dir = mkdtempSync(join(tmpdir(), "imnci-review-"));
  const files = { protocol: join(dir, "protocol.json"), counselling: join(dir, "counselling.json"), review: join(dir, "review.json") };
  writeFileSync(files.protocol, protocolText);
  writeFileSync(files.counselling, counsellingText);
  writeFileSync(files.review, JSON.stringify(exp));
  const script = fileURLToPath(new URL("scripts/apply-review.ts", root));
  const r = spawnSync(process.execPath, ["--disable-warning=MODULE_TYPELESS_PACKAGE_JSON", script, files.review, "--protocol", files.protocol, "--counselling", files.counselling, ...extra], { encoding: "utf8" });
  const result = { status: r.status, stdout: r.stdout, stderr: r.stderr, protocol: readFileSync(files.protocol, "utf8"), counselling: readFileSync(files.counselling, "utf8") };
  rmSync(dir, { recursive: true, force: true });
  return result;
}

test("script: promotes Correct items, reports the rest, and changes only those lines", () => {
  const r = runScript(exportOf([answer("protocol:pneumonia", "correct"), answer("protocol:malaria", "needs_change", "check RDT wording")]));
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /Marked clinician-reviewed \(1\):\n {2}protocol:pneumonia/);
  assert.match(r.stdout, /protocol:malaria: needs_change: check RDT wording/);
  assert.equal(r.counselling, counsellingText, "counselling file unchanged");
  // The changed block is what lies between the longest common start and the longest common end.
  const before = protocolText.split("\n");
  const after = r.protocol.split("\n");
  let start = 0;
  while (before[start] === after[start]) start++;
  let end = 0;
  while (end < before.length - start && before[before.length - 1 - end] === after[after.length - 1 - end]) end++;
  const removed = before.slice(start, before.length - end);
  const added = after.slice(start, after.length - end);
  assert.ok(removed.length <= 3 && added.length <= 4, `only the pneumonia source_check changes:\n${removed.join("\n")}\n---\n${added.join("\n")}`);
  assert.ok([...removed, ...added].every((l) => /"(method|reviewer|date|quote)"/.test(l)), added.join("\n"));
  assert.ok(added.some((l) => l.includes('"clinician-reviewed"')) && added.some((l) => l.includes('"reviewer": "Dr. A. Reviewer"')));
});

test("script: refuses a file with no reviewer name and writes nothing", () => {
  const r = runScript(exportOf([answer("protocol:pneumonia", "correct")], { reviewer: "" }));
  assert.equal(r.status, 1);
  assert.match(r.stderr, /no reviewer name/);
  assert.equal(r.protocol, protocolText);
  assert.equal(r.counselling, counsellingText);
});

test("script: --dry-run writes nothing", () => {
  const r = runScript(exportOf([answer("protocol:pneumonia", "correct")]), ["--dry-run"]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /Dry run/);
  assert.equal(r.protocol, protocolText);
});
