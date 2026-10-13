/**
 * Apply a completed marwari-todo.json.
 *
 *   node scripts/apply-marwari.ts marwari-todo.json [--reviewer "Name"] [--date YYYY-MM-DD] [--dry-run]
 *
 * Writes each filled string into ui-text.json, the protocol or counselling.json as an "mwr" field
 * with the reviewer's name and date. Refuses a file with no reviewer name. Blank items stay Hindi.
 */
import { resolve } from "node:path";
import { applyMarwari, type TodoFile, type UiTextTable } from "../lib/marwari.ts";
import type { CounsellingFile } from "../lib/imnci/counselling.ts";
import type { ImnciProtocol } from "../lib/imnci/rules.ts";
import { readJson, writeJson } from "./json-file.ts";

const arg = (name: string) => {
  const i = process.argv.indexOf(name);
  return i > 0 ? (process.argv[i + 1] ?? null) : null;
};
const todoPath = process.argv[2];
if (!todoPath || todoPath.startsWith("--")) {
  console.error('Usage: node scripts/apply-marwari.ts marwari-todo.json [--reviewer "Name"] [--date YYYY-MM-DD] [--dry-run]');
  process.exit(2);
}
const root = resolve(import.meta.dirname, "..");
const paths = {
  ui: resolve(arg("--ui") ?? `${root}/ui-text.json`),
  protocol: resolve(arg("--protocol") ?? `${root}/imnci-sick-child-2m-5y.json`),
  counselling: resolve(arg("--counselling") ?? `${root}/counselling.json`),
};

try {
  const { ui, protocol, counselling, report } = applyMarwari(
    readJson<UiTextTable>(paths.ui),
    readJson<ImnciProtocol>(paths.protocol),
    readJson<CounsellingFile>(paths.counselling),
    readJson<TodoFile>(resolve(todoPath)),
    { reviewer: arg("--reviewer"), date: arg("--date") },
  );
  console.log(`Written (${report.written.length}):`);
  for (const id of report.written) console.log(`  ${id}`);
  console.log(`Skipped (${report.skipped.length}):`);
  for (const s of report.skipped) console.log(`  ${s.id}: ${s.reason}`);
  console.log(`Left blank, stays Hindi: ${report.empty}`);
  if (process.argv.includes("--dry-run")) console.log("\nDry run: no file written.");
  else if (report.written.length) {
    writeJson(paths.ui, ui);
    writeJson(paths.protocol, protocol);
    writeJson(paths.counselling, counselling);
    console.log(`\nWrote ${paths.ui}\nWrote ${paths.protocol}\nWrote ${paths.counselling}`);
  } else console.log("\nNothing to write.");
} catch (err) {
  console.error((err as Error).message);
  process.exit(1);
}
