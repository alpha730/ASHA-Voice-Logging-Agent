/**
 * "What to tell the mother": caregiver advice for the classifications in a result.
 *
 * Pure: no imports with side effects, so the test file can load it directly. The content lives in
 * counselling.json; this file only checks it and picks the entries that match a result.
 */
import { tablesFor, type Band, type CheckMethod, type ImnciProtocol, type Verification } from "./rules.ts";
import { hasReview, type Lang } from "../i18n.ts";

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

/** Source text kept in the file but never shown or read aloud until a clinician decides. */
export interface HeldStep {
  step_en: string;
  step_hi: string;
  hold: true;
  hold_reason: string;
  source_page: number;
  quote: string;
  mwr?: string; // never shown or spoken while the step is held
}

/** Written by the app, not taken from a source. Shown labelled as such, never counted as verified. */
export interface AppNote {
  en: string;
  hi: string;
}

/**
 * Optional Marwari for a whole entry, filled by scripts/apply-marwari.ts. Used only when reviewed
 * and complete (a title, every step, every app note); otherwise the Hindi entry is shown and spoken.
 */
export interface EntryMwr {
  title: string;
  steps: string[];
  app_notes?: string[];
  reviewed_by: string;
  reviewed_on: string;
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
  held_steps?: HeldStep[];
  app_notes?: AppNote[];
  open_question?: string; // listed on the clinician review page
  mwr?: EntryMwr | null;
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

    for (const h of e.held_steps ?? []) {
      if (h.hold !== true || !h.hold_reason?.trim()) errors.push(`${where}: a held step needs hold: true and a hold_reason`);
      if (!h.step_en?.trim() || !DEVANAGARI.test(h.step_hi ?? "")) errors.push(`${where}: a held step needs step_en and a Devanagari step_hi`);
      if (!Number.isInteger(h.source_page) || !h.quote?.trim()) errors.push(`${where}: a held step needs a numeric page and its quote`);
    }
    for (const n of e.app_notes ?? []) {
      const extra = Object.keys(n).filter((k) => k !== "en" && k !== "hi");
      // Marwari for an app note goes in the entry's mwr.app_notes, so a note never carries its own status.
      if (extra.length) errors.push(`${where}: an app note has only en and hi, never ${extra.join(", ")}; it is not source text`);
      if (!n.en?.trim() || !DEVANAGARI.test(n.hi ?? "")) errors.push(`${where}: an app note needs en and a Devanagari hi`);
    }
    if (e.open_question != null && !e.open_question.trim()) errors.push(`${where}: open_question is empty`);
    if (e.mwr != null && (typeof e.mwr !== "object" || !Array.isArray(e.mwr.steps))) errors.push(`${where}: mwr must be { title, steps[], reviewed_by, reviewed_on }`);

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
  const held = (e.held_steps ?? []).map((h) => ({ source: e.source, page: h.source_page, quote: h.quote }));
  if (!e.verified || !e.source_check.quote) return held;
  return [
    { source: e.source, page: e.source_page as number, quote: e.source_check.quote },
    ...(e.source_check.supporting ?? []).map((s) => ({ source: s.source ?? e.source, page: s.source_page, quote: s.quote })),
    ...held,
  ];
}

/** The entry's Marwari, only when reviewed and complete. Otherwise null, and Hindi is used. */
export function usableMwr(e: CounsellingEntry): EntryMwr | null {
  const m = e.mwr;
  if (!m || !hasReview(m)) return null;
  const dev = (s: unknown) => typeof s === "string" && /[ऀ-ॿ]/.test(s);
  if (!dev(m.title) || m.steps.length !== e.steps_en.length || !m.steps.every(dev)) return null;
  if ((e.app_notes?.length ?? 0) !== (m.app_notes?.length ?? 0) || !(m.app_notes ?? []).every(dev)) return null;
  return m;
}

/** Which language an entry is actually shown in. */
export function entryLang(e: CounsellingEntry, lang: Lang): "en" | "hi" | "mwr" {
  return lang === "en" ? "en" : lang === "mwr" && usableMwr(e) ? "mwr" : "hi";
}

export function titleOf(e: CounsellingEntry, lang: Lang): string {
  const l = entryLang(e, lang);
  return l === "mwr" ? usableMwr(e)!.title : l === "en" ? e.title_en : e.title_hi;
}

/** The steps shown and read aloud. Held steps are a separate field, so they never appear here. */
export function visibleSteps(e: CounsellingEntry, lang: Lang): string[] {
  const l = entryLang(e, lang);
  return l === "mwr" ? usableMwr(e)!.steps : l === "en" ? e.steps_en : e.steps_hi;
}

export function appNotesOf(e: CounsellingEntry, lang: Lang): string[] {
  const l = entryLang(e, lang);
  if (l === "mwr") return usableMwr(e)!.app_notes ?? [];
  return (e.app_notes ?? []).map((n) => (l === "en" ? n.en : n.hi));
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

/** How far an entry was checked, in the same terms as the rules. App notes never count toward it. */
export function entryVerification(e: CounsellingEntry): Verification {
  if (!e.verified || e.source_check.method === "not-confirmed") return "draft";
  return e.source_check.method === "clinician-reviewed" ? "clinician-reviewed" : "ai-compared";
}

/**
 * The text to read aloud: each title, its source steps, then its app notes, in one language. Held
 * steps are never read. App notes are read as plain advice; the card labels them as app notes.
 */
export function adviceSpeech(entries: CounsellingEntry[], lang: Lang): string {
  return entries.map((e) => `${titleOf(e, lang)}: ${[...visibleSteps(e, lang), ...appNotesOf(e, lang)].join(" ")}`).join(" ");
}
