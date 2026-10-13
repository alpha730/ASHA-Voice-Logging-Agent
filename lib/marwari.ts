/**
 * Marwari text is written by a native speaker, never by the app. marwariTodo() lists every string
 * that needs it (marwari-todo.json); applyMarwari() writes a completed list back into ui-text.json,
 * the protocol and the counselling file, stamped with the reviewer's name and date.
 *
 * Pure, with relative imports, so tests and scripts load it directly.
 */
import { isIsoDate, placeholders, type MwrText } from "./i18n.ts";
import type { CounsellingFile } from "./imnci/counselling.ts";
import type { ImnciProtocol, ProtocolItem } from "./imnci/rules.ts";

export interface UiTextTable {
  texts: Record<string, { en: string; hi: string; where: string; mwr?: MwrText | null }>;
}

export interface TodoItem {
  id: string;
  where: string;
  en: string;
  hi: string;
  placeholders: string[]; // must appear unchanged in the Marwari, e.g. {months}
  mwr: string; // filled in by the native speaker
}

export interface TodoFile {
  _about: string;
  reviewer: string;
  reviewed_on: string; // YYYY-MM-DD
  items: TodoItem[];
}

const ABOUT =
  "Marwari for every sentence the app says or shows. Fill 'mwr' in Devanagari for each item, keep every {placeholder} exactly as written, and leave 'mwr' empty where you are unsure: those items stay in Hindi. Put your name in 'reviewer' and the date in 'reviewed_on' (YYYY-MM-DD), then run: node scripts/apply-marwari.ts marwari-todo.json. Advice entries ('counselling:...') are used only when the title and every step of the entry are filled.";

/** Every ask/look item of the protocol, with where it is asked. */
function protocolItems(p: ImnciProtocol): { item: ProtocolItem; where: string }[] {
  const out: { item: ProtocolItem; where: string }[] = [];
  const gds = p.general_danger_signs;
  for (const item of [...gds.ask, ...gds.look]) out.push({ item, where: "Sick-child assessment, general danger signs" });
  for (const a of p.assessments) {
    for (const item of [...(a.ask ?? []), ...(a.look ?? [])]) out.push({ item, where: `Sick-child assessment, ${a.title ?? a.id}` });
  }
  return out;
}

const fieldOf = (item: ProtocolItem): "question" | "observation" => (item.question_en || item.question_hi ? "question" : "observation");

export function marwariTodo(ui: UiTextTable, p: ImnciProtocol, c: CounsellingFile, previous?: TodoFile | null): TodoFile {
  const items: TodoItem[] = [];
  const add = (id: string, where: string, en: string, hi: string) => items.push({ id, where, en, hi, placeholders: placeholders(hi), mwr: "" });

  for (const [id, e] of Object.entries(ui.texts)) add(`ui:${id}`, e.where, e.en, e.hi);

  const seen = new Set<string>();
  for (const { item, where } of protocolItems(p)) {
    if (seen.has(item.id)) continue; // lethargic_unconscious is listed twice; one answer covers both
    seen.add(item.id);
    const f = fieldOf(item);
    const en = (f === "question" ? item.question_en : item.observation_en) ?? item.id;
    const hi = (f === "question" ? item.question_hi : item.observation_hi) ?? "";
    add(`protocol:${item.id}`, `${where} (${f})`, en, hi);
  }
  for (const a of p.assessments) {
    if (a.trigger) add(`protocol:trigger:${a.id}`, `Sick-child assessment, opening question for ${a.title ?? a.id}`, a.trigger.question_en, a.trigger.question_hi ?? "");
  }

  // Held steps are not listed: they are never shown in any language until a clinician decides.
  for (const e of c.entries) {
    const where = `"What to tell the mother": ${e.title_en}`;
    add(`counselling:${e.id}:title`, `${where} (title)`, e.title_en, e.title_hi);
    e.steps_en.forEach((en, i) => add(`counselling:${e.id}:step:${i + 1}`, `${where} (step ${i + 1})`, en, e.steps_hi[i]));
    (e.app_notes ?? []).forEach((n, i) => add(`counselling:${e.id}:app_note:${i + 1}`, `${where} (app note ${i + 1}, not from the booklet)`, n.en, n.hi));
  }

  // Keep what the speaker already wrote for strings that have not changed.
  const before = new Map((previous?.items ?? []).map((i) => [i.id, i]));
  for (const it of items) {
    const old = before.get(it.id);
    if (old?.mwr && old.hi === it.hi) it.mwr = old.mwr;
  }
  return { _about: ABOUT, reviewer: previous?.reviewer ?? "", reviewed_on: previous?.reviewed_on ?? "", items };
}

export interface MarwariReport {
  written: string[];
  skipped: { id: string; reason: string }[];
  empty: number; // items left blank, which stay in Hindi
}

/**
 * Write the filled items into copies of the three files. Refuses a list with no reviewer name, no
 * valid date, or ids that are not current strings. A filled item is skipped (and reported) when it is
 * not Devanagari or its {placeholders} differ from the Hindi; an advice entry is written only whole.
 */
export function applyMarwari(
  uiIn: UiTextTable,
  pIn: ImnciProtocol,
  cIn: CounsellingFile,
  todo: TodoFile,
  opts: { reviewer?: string | null; date?: string | null } = {},
): { ui: UiTextTable; protocol: ImnciProtocol; counselling: CounsellingFile; report: MarwariReport } {
  const reviewer = (opts.reviewer ?? todo?.reviewer ?? "").trim();
  const date = (opts.date ?? todo?.reviewed_on ?? "").trim();
  const errors: string[] = [];
  if (!reviewer) errors.push("no reviewer name (set 'reviewer' in the file or pass --reviewer)");
  if (!isIsoDate(date)) errors.push("no valid review date (YYYY-MM-DD)");
  if (!Array.isArray(todo?.items)) errors.push("no items");
  const current = new Map(marwariTodo(uiIn, pIn, cIn).items.map((i) => [i.id, i]));
  for (const it of todo?.items ?? []) if (!current.has(it.id)) errors.push(`${it.id}: not a current string (regenerate the list)`);
  if (errors.length) throw new Error(`Marwari file refused:\n- ${errors.join("\n- ")}`);

  const ui = structuredClone(uiIn);
  const protocol = structuredClone(pIn);
  const counselling = structuredClone(cIn);
  const report: MarwariReport = { written: [], skipped: [], empty: 0 };
  const stamp = { reviewed_by: reviewer, reviewed_on: date };

  // Check each filled item against the current Hindi.
  const ok = new Map<string, string>();
  for (const it of todo.items) {
    const text = (it.mwr ?? "").trim();
    if (!text) {
      report.empty++;
      continue;
    }
    const hi = current.get(it.id)!.hi;
    if (!/[ऀ-ॿ]/.test(text)) report.skipped.push({ id: it.id, reason: "not written in Devanagari" });
    else if (placeholders(text).join() !== placeholders(hi).join()) {
      report.skipped.push({ id: it.id, reason: `placeholders differ from the Hindi (${placeholders(hi).join(", ") || "none"})` });
    } else ok.set(it.id, text);
  }

  for (const [id, text] of ok) {
    if (id.startsWith("ui:")) {
      ui.texts[id.slice(3)].mwr = { text, ...stamp };
      report.written.push(id);
    } else if (id.startsWith("protocol:trigger:")) {
      const a = protocol.assessments.find((x) => x.id === id.slice("protocol:trigger:".length))!;
      a.trigger!.mwr = { question: text, ...stamp };
      report.written.push(id);
    } else if (id.startsWith("protocol:")) {
      for (const { item } of protocolItems(protocol)) {
        if (`protocol:${item.id}` === id) item.mwr = { [fieldOf(item)]: text, ...stamp };
      }
      report.written.push(id);
    }
  }

  // Advice is all or nothing per entry, so a mother never hears half Marwari, half Hindi advice.
  for (const e of counselling.entries) {
    const ids = [
      `counselling:${e.id}:title`,
      ...e.steps_en.map((_, i) => `counselling:${e.id}:step:${i + 1}`),
      ...(e.app_notes ?? []).map((_, i) => `counselling:${e.id}:app_note:${i + 1}`),
    ];
    const have = ids.filter((id) => ok.has(id));
    if (!have.length) continue;
    if (have.length < ids.length) {
      for (const id of have) report.skipped.push({ id, reason: `entry ${e.id} is incomplete (${have.length} of ${ids.length} strings filled)` });
      continue;
    }
    e.mwr = {
      title: ok.get(ids[0])!,
      steps: e.steps_en.map((_, i) => ok.get(`counselling:${e.id}:step:${i + 1}`)!),
      ...(e.app_notes?.length ? { app_notes: e.app_notes.map((_, i) => ok.get(`counselling:${e.id}:app_note:${i + 1}`)!) } : {}),
      ...stamp,
    };
    report.written.push(...ids);
  }
  return { ui, protocol, counselling, report };
}
