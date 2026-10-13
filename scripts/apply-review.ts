/**
 * Apply a clinician review exported from /review.
 *
 *   node scripts/apply-review.ts review.json [--dry-run] [--protocol FILE] [--counselling FILE]
 *
 * Only items marked Correct, whose page and quote still match what the reviewer saw, get
 * source_check.method "clinician-reviewed" with the reviewer's name and date. Wrong and Needs
 * change items are left as they are and listed. Items the file does not mention are never touched.
 * A file without a reviewer name, or with items not in the current files, is refused.
 */
import { resolve } from "node:path";
import { applyReview } from "../lib/imnci/review.ts";
import { readJson as read, writeJson as write } from "./json-file.ts";

function arg(name: string): string | null {
  const i = process.argv.indexOf(name);
  return i > 0 ? (process.argv[i + 1] ?? null) : null;
}

const exportPath = process.argv[2];
if (!exportPath || exportPath.startsWith("--")) {
  console.error("Usage: node scripts/apply-review.ts review.json [--dry-run] [--protocol FILE] [--counselling FILE]");
  process.exit(2);
}
const root = resolve(import.meta.dirname, "..");
const protocolPath = resolve(arg("--protocol") ?? `${root}/imnci-sick-child-2m-5y.json`);
const counsellingPath = resolve(arg("--counselling") ?? `${root}/counselling.json`);
const dryRun = process.argv.includes("--dry-run");


try {
  const { protocol, counselling, report } = applyReview(read(protocolPath), read(counsellingPath), read(exportPath));
  const out: string[] = [];
  for (const w of report.warnings) out.push(`Warning: ${w}`);
  out.push(`Marked clinician-reviewed (${report.promoted.length}):`, ...report.promoted.map((k) => `  ${k}`));
  out.push(`Left unchanged, marked Wrong or Needs change (${report.unchanged.length}):`);
  for (const u of report.unchanged) out.push(`  ${u.key}: ${u.verdict}${u.comment ? `: ${u.comment}` : ""}`);
  out.push(`Marked Correct but not promoted (${report.skipped.length}):`, ...report.skipped.map((s) => `  ${s.key}: ${s.reason}`));
  out.push(`Open decisions, for you to act on (${report.decisions.length}):`);
  for (const d of report.decisions) out.push(`  ${d.key}: ${d.verdict}${d.comment ? `: ${d.comment}` : ""}`);
  console.log(out.join("\n"));

  if (dryRun) console.log("\nDry run: no file written.");
  else if (report.promoted.length) {
    write(protocolPath, protocol);
    write(counsellingPath, counselling);
    console.log(`\nWrote ${protocolPath}\nWrote ${counsellingPath}`);
  } else console.log("\nNothing to promote: no file written.");
} catch (err) {
  console.error((err as Error).message);
  process.exit(1);
}
