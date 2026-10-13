import type { Lang } from "@/lib/i18n";
import { t } from "@/lib/text";
import type { ExtractedVisit, RequiredField } from "@/types/visit";

export type UiLang = Lang;

/** One short question per turn, never stacked. Text lives in ui-text.json. */
export function questionFor(field: RequiredField, lang: UiLang): string {
  return t(`agent.question.${field}`, lang);
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
  return t("agent.summary", lang, { who, noted, date: v.follow_up_date ?? "" });
}
