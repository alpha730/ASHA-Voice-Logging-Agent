import type { ExtractedVisit, RequiredField } from "@/types/visit";

export type UiLang = "hi" | "en";

const QUESTIONS: Record<RequiredField, Record<UiLang, string>> = {
  worker_name: { en: "What is your name?", hi: "Aapka naam kya hai?" },
  household_id: { en: "What is the household ID?", hi: "Ghar ka number kya hai?" },
  health_findings: {
    en: "Did you record a temperature or any symptoms?",
    hi: "Kya aapne taapmaan ya koi lakshan note kiya?",
  },
  follow_up_date: { en: "When is the next follow-up visit?", hi: "Agli visit kab hogi?" },
};

/** One short question per turn, never stacked. */
export function questionFor(field: RequiredField, lang: UiLang): string {
  return QUESTIONS[field][lang];
}

export const CORRECTION_RE = /(that'?s wrong|that is wrong|not correct|galat|गलत|sahi nahi|सही नहीं)/i;

export function summaryLine(v: ExtractedVisit, lang: UiLang): string {
  const who = v.patient_name ?? `household ${v.household_id}`;
  const findings = [
    ...v.symptoms,
    v.vitals.temp_c != null ? `temperature ${v.vitals.temp_c}°C` : null,
    v.vitals.bp ? `BP ${v.vitals.bp}` : null,
  ].filter(Boolean);
  const noted = findings.length ? findings.join(", ") : "no findings";
  if (lang === "hi") return `Log ho gaya: ${who}, ${noted}, agli visit ${v.follow_up_date}.`;
  return `Logged: ${who}, ${noted}, follow-up on ${v.follow_up_date}.`;
}
