/**
 * The app's own sentences (ui-text.json), looked up by id in the chosen language. Clinical text
 * lives in the protocol and counselling files instead, with the same Marwari rule.
 */
import table from "../ui-text.json" with { type: "json" };
import { pickText, placeholders, type Lang, type Localized } from "./i18n.ts";

export interface UiTextFile {
  texts: Record<string, Localized & { where: string }>;
}

export const UI_TEXT = table as unknown as UiTextFile;

/** Throws on a missing English or Hindi string, or Hindi and English that use different {placeholders}. */
export function validateUiText(file: UiTextFile): void {
  const errors: string[] = [];
  for (const [id, e] of Object.entries(file.texts)) {
    if (!e.en?.trim() || !e.hi?.trim()) errors.push(`${id}: needs en and hi`);
    if (!e.where?.trim()) errors.push(`${id}: needs where`);
    if (placeholders(e.en).join() !== placeholders(e.hi).join()) errors.push(`${id}: en and hi use different placeholders`);
    if (e.mwr != null && typeof e.mwr !== "object") errors.push(`${id}: mwr must be { text, reviewed_by, reviewed_on }`);
  }
  if (errors.length) throw new Error(`Invalid ui-text.json:\n${errors.join("\n")}`);
}
validateUiText(UI_TEXT);

/** The sentence `id` in `lang`. Marwari falls back to Hindi unless reviewed. */
export function t(id: string, lang: Lang, vars?: Record<string, string | number>, file: UiTextFile = UI_TEXT): string {
  const entry = file.texts[id];
  if (!entry) throw new Error(`No text "${id}" in ui-text.json`);
  return pickText(entry, lang, vars);
}
