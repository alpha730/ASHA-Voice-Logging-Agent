/**
 * Write marwari-todo.json: every string that needs Marwari, with its id, where it appears, the
 * English and the Hindi. Run again after text changes; Marwari already written for a string whose
 * Hindi is unchanged is kept.
 *
 *   node scripts/marwari-todo.ts [--out marwari-todo.json]
 */
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { marwariTodo, type TodoFile, type UiTextTable } from "../lib/marwari.ts";
import type { CounsellingFile } from "../lib/imnci/counselling.ts";
import type { ImnciProtocol } from "../lib/imnci/rules.ts";
import { readJson, writeJson } from "./json-file.ts";

const root = resolve(import.meta.dirname, "..");
const i = process.argv.indexOf("--out");
const out = resolve(i > 0 ? process.argv[i + 1] : `${root}/marwari-todo.json`);
const previous = existsSync(out) ? readJson<TodoFile>(out) : null;
const todo = marwariTodo(
  readJson<UiTextTable>(`${root}/ui-text.json`),
  readJson<ImnciProtocol>(`${root}/imnci-sick-child-2m-5y.json`),
  readJson<CounsellingFile>(`${root}/counselling.json`),
  previous,
);
writeJson(out, todo);
console.log(`${todo.items.length} strings, ${todo.items.filter((t) => t.mwr).length} with Marwari, written to ${out}`);
