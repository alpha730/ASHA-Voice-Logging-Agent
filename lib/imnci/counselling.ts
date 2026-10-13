/**
 * "What to tell the mother": caregiver advice for the classifications in a result.
 *
 * Pure: no imports with side effects, so the test file can load it directly. The content lives in
 * counselling.json; this file only checks it and picks the entries that match a result.
 */
import { tablesFor, type Band, type CheckMethod, type ImnciProtocol, type Verification } from "./rules.ts";

export type SourceDoc = "booklet" | "facilitator_guide";

export interface CounsellingQuote {
  source?: SourceDoc; // defaults to the entry's source
  source_page: number;
  quote: string;
}

export interface CounsellingCheck {
  method: CheckMethod;
  date?: string;
  quote?: string;
  reason?: string; // why it is not confirmed
  reviewer?: string;
  supporting?: CounsellingQuote[];
}

export interface CounsellingEntry {
  id: string;
  priority: "urgent" | "normal"; // urgent entries are shown first on a pink result
  title_en: string;
  title_hi: string;
  steps_en: string[];
  steps_hi: string[];
  applies_to: string[]; // classification ids from the protocol JSON
  age_months_min?: number; // inclusive
  age_months_max?: number; // exclusive
  source: SourceDoc;
  source_page: number | string | null;
  verified: boolean;
  source_check: CounsellingCheck;
}

export interface CounsellingFile {
  version: string;
  sources: Record<SourceDoc, { title: string; edition: string; sha256: string }>;
  entries: CounsellingEntry[];
}

/** Every classification id a result can contain: the protocol's rows plus the general danger sign. */
export function classificationIds(protocol: ImnciProtocol): Set<string> {
  const ids = new Set(["general_danger_sign"]);
  for (const t of tablesFor(protocol)) for (const row of t.rows) ids.add(row.id);
  return ids;
}

const METHODS = ["ai-compared-to-booklet", "clinician-reviewed", "not-confirmed"];
const DEVANAGARI = /[ऀ-ॿ]/;

/** Same provenance rules as the protocol loader. Throws listing every problem. */
export function validateCounselling(file: CounsellingFile, protocol: ImnciProtocol): void {
  const errors: string[] = [];
  const known = classificationIds(protocol);
  const seen = new Set<string>();
  for (const e of file.entries) {
    const where = `counselling/${e.id}`;
    if (seen.has(e.id)) errors.push(`${where}: duplicate id`);
    seen.add(e.id);
    if (!e.title_en?.trim() || !e.title_hi?.trim()) errors.push(`${where}: needs title_en and title_hi`);
    if (!e.steps_en?.length || e.steps_en.length !== e.steps_hi?.length) errors.push(`${where}: steps_en and steps_hi must be non-empty and the same length`);
    if (!DEVANAGARI.test(e.title_hi ?? "") || !(e.steps_hi ?? []).every((s) => DEVANAGARI.test(s))) errors.push(`${where}: Hindi text must be in Devanagari`);
    if (!["urgent", "normal"].includes(e.priority)) errors.push(`${where}: unknown priority "${e.priority}"`);
    if (!file.sources?.[e.source]) errors.push(`${where}: unknown source "${e.source}"`);
    if (!e.applies_to?.length) errors.push(`${where}: applies_to is empty`);
    for (const id of e.applies_to ?? []) if (!known.has(id)) errors.push(`${where}: applies_to "${id}" is not a classification in the protocol`);

    const check = e.source_check;
    if (check && !METHODS.includes(check.method)) errors.push(`${where}: unknown source_check method "${check.method}"`);
    if (e.verified !== true) {
      if (check?.method !== "not-confirmed") errors.push(`${where}: verified is not true, so source_check must be not-confirmed`);
      if (!check?.reason?.trim()) errors.push(`${where}: an unverified entry needs a reason`);
      continue;
    }
    if (!check || check.method === "not-confirmed") {
      errors.push(`${where}: verified true without a source_check`);
      continue;
    }
    if (!Number.isInteger(e.source_page)) errors.push(`${where}: verified true needs a numeric page, got "${e.source_page}"`);
    if (!check.quote?.trim()) errors.push(`${where}: verified true needs a quote`);
    if (!check.date) errors.push(`${where}: verified true needs a date`);
    if (check.method === "clinician-reviewed" && !check.reviewer?.trim()) errors.push(`${where}: clinician-reviewed needs a reviewer`);
    for (const s of check.supporting ?? []) {
      if (!Number.isInteger(s.source_page) || !s.quote?.trim()) errors.push(`${where}: each supporting quote needs a numeric page and a quote`);
      if (s.source && !file.sources?.[s.source]) errors.push(`${where}: unknown supporting source "${s.source}"`);
    }
  }
  if (errors.length) throw new Error(`Invalid counselling file:\n${errors.join("\n")}`);
}

/** Every quote an entry relies on, with the document and page it must appear on. */
export function quotesOf(e: CounsellingEntry): { source: SourceDoc; page: number; quote: string }[] {
  if (!e.verified || !e.source_check.quote) return [];
  return [
    { source: e.source, page: e.source_page as number, quote: e.source_check.quote },
    ...(e.source_check.supporting ?? []).map((s) => ({ source: s.source ?? e.source, page: s.source_page, quote: s.quote })),
  ];
}

/**
 * The entries for one result: those whose applies_to names a classification in it (and whose age
 * band fits the child). On a result with any pink row, urgent entries come first. Otherwise file order.
 */
export function adviceFor(
  file: CounsellingFile,
  classifications: { id: string; band: Band }[],
  ageMonths: number | null,
): CounsellingEntry[] {
  const ids = new Set(classifications.map((c) => c.id));
  const matched = file.entries.filter((e) => {
    if (!e.applies_to.some((id) => ids.has(id))) return false;
    if (e.age_months_min == null && e.age_months_max == null) return true;
    if (ageMonths == null) return false; // age-banded advice needs the age
    return ageMonths >= (e.age_months_min ?? 0) && ageMonths < (e.age_months_max ?? Infinity);
  });
  if (!classifications.some((c) => c.band === "pink")) return matched;
  return [...matched.filter((e) => e.priority === "urgent"), ...matched.filter((e) => e.priority !== "urgent")];
}

/** How far an entry was checked, in the same terms as the rules. */
export function entryVerification(e: CounsellingEntry): Verification {
  if (!e.verified || e.source_check.method === "not-confirmed") return "draft";
  return e.source_check.method === "clinician-reviewed" ? "clinician-reviewed" : "ai-compared";
}

/** The text to read aloud: each title, then its steps, in one language. */
export function adviceSpeech(entries: CounsellingEntry[], lang: "en" | "hi"): string {
  return entries
    .map((e) => (lang === "hi" ? `${e.title_hi}: ${e.steps_hi.join(" ")}` : `${e.title_en}: ${e.steps_en.join(" ")}`))
    .join(" ");
}
