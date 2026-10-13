/**
 * The three languages the agent speaks: Hindi, English and Marwari.
 *
 * Marwari text is optional everywhere and is only used once a native speaker has written and
 * reviewed it ({ text, reviewed_by, reviewed_on }). Anything else falls back to Hindi, so
 * unreviewed Marwari is never shown or spoken. Pure, so tests and scripts load it directly.
 */

export type Lang = "hi" | "en" | "mwr";
export const LANGS: Lang[] = ["hi", "en", "mwr"];
export const LANG_LABELS: Record<Lang, string> = { hi: "हिन्दी", en: "English", mwr: "मारवाड़ी" };

export const isLang = (v: unknown): v is Lang => v === "hi" || v === "en" || v === "mwr";
/** A request's language, defaulting to Hindi as before. */
export const toLang = (v: unknown): Lang => (isLang(v) ? v : "hi");

/** Reviewed Marwari for one string. */
export interface MwrText {
  text: string;
  reviewed_by: string;
  reviewed_on: string; // YYYY-MM-DD
}

export interface Localized {
  en: string;
  hi: string;
  mwr?: MwrText | null;
}

export const isIsoDate = (v: unknown): v is string => typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(v));

/** Who reviewed it and when: both present and valid. Text-free, for entries holding several strings. */
export function hasReview(m: unknown): m is { reviewed_by: string; reviewed_on: string } {
  const r = m as { reviewed_by?: unknown; reviewed_on?: unknown } | null | undefined;
  return !!r && typeof r.reviewed_by === "string" && r.reviewed_by.trim() !== "" && isIsoDate(r.reviewed_on);
}

/** Marwari that may be shown: non-empty Devanagari text with a reviewer and a review date. */
export function reviewedMwr(m: unknown): m is MwrText {
  const t = (m as { text?: unknown } | null | undefined)?.text;
  return hasReview(m) && typeof t === "string" && /[ऀ-ॿ]/.test(t);
}

/** The {names} a template uses, sorted. */
export function placeholders(text: string): string[] {
  return [...new Set([...text.matchAll(/\{([a-z_]+)\}/gi)].map((m) => m[1]))].sort();
}

const samePlaceholders = (a: string, b: string) => placeholders(a).join(",") === placeholders(b).join(",");

/** Which language a string will actually be shown in: Marwari only when reviewed and complete. */
export function resolvedLang(entry: Localized, lang: Lang): "en" | "hi" | "mwr" {
  if (lang === "en") return "en";
  if (lang === "mwr" && reviewedMwr(entry.mwr) && samePlaceholders(entry.mwr.text, entry.hi)) return "mwr";
  return "hi";
}

export function fill(template: string, vars: Record<string, string | number> = {}): string {
  return template.replace(/\{([a-z_]+)\}/gi, (whole, name: string) => (name in vars ? String(vars[name]) : whole));
}

/** The text to show and speak for this language, with {placeholders} filled. */
export function pickText(entry: Localized, lang: Lang, vars?: Record<string, string | number>): string {
  const which = resolvedLang(entry, lang);
  const text = which === "mwr" ? entry.mwr!.text : which === "en" ? entry.en : entry.hi;
  return fill(text, vars);
}
