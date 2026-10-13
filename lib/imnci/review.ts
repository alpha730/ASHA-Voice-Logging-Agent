/**
 * Clinician review: the list of items the /review page shows, and the rules for applying an
 * exported review back to the protocol and counselling files (scripts/apply-review.ts).
 *
 * Pure, with relative imports, so the tests and the script can load it directly.
 */
import { tablesFor, validateProtocol, type Condition, type ImnciProtocol } from "./rules.ts";
import { validateCounselling, type CounsellingFile } from "./counselling.ts";

export type Verdict = "correct" | "wrong" | "needs_change";
export const VERDICTS: { value: Verdict; label: string }[] = [
  { value: "correct", label: "Correct" },
  { value: "wrong", label: "Wrong" },
  { value: "needs_change", label: "Needs change" },
];

export interface ReviewItem {
  key: string; // "decision:...", "protocol:...", "counselling:..."
  kind: "decision" | "rule" | "advice";
  group: string;
  name: string;
  does: string[]; // what the engine or the card does, one line each
  band?: string;
  follow_up_days?: number | null;
  asha_action?: string; // what the app tells the ASHA (never imnci_action)
  source?: string;
  source_page?: string | number | null;
  quote?: string | null;
  more_quotes?: string[];
  notes?: string[]; // held text, app notes, open questions
  method?: string; // current source_check.method
  verified?: boolean;
}

// ---------------------------------------------------------------------------
// Describing a rule in plain words
// ---------------------------------------------------------------------------

const OPS: Record<string, string> = { at_or_above: "≥", above: ">", below: "<" };
const META = new Set(["from", "then", "source_page", "verified", "source_check"]);

export function describeCondition(c: Condition): string {
  const parts: string[] = [];
  for (const [k, v] of Object.entries(c as Record<string, unknown>)) {
    if (META.has(k)) continue;
    if (k === "any_of") parts.push((v as string[]).length === 1 ? (v as string[])[0] : `any of (${(v as string[]).join(", ")})`);
    else if (k === "all_of") parts.push((v as string[]).join(" and "));
    else if (k === "none_of") parts.push(`none of (${(v as string[]).join(", ")})`);
    else if (k === "min_count") parts.push(`${v} or more of (${((c as Record<string, unknown>).from as string[]).join(", ")})`);
    else if (k === "otherwise") parts.push("otherwise (no row above it matched)");
    else if (k === "and") parts.push(describeCondition(v as Condition));
    else if (k === "or") parts.push(`[${(v as Condition[]).map((x) => `(${describeCondition(x)})`).join(" OR ")}]`);
    else if (k === "equals") parts.push(Object.entries(v as object).map(([a, b]) => `${a} = ${b}`).join(" and "));
    else {
      const m = k.match(/^(.+?)_(at_or_above|above|below)$/);
      parts.push(m ? `${m[1]} ${OPS[m[2]]} ${v}` : `${k} = ${String(v)}`);
    }
  }
  return parts.join(" AND ");
}

// ---------------------------------------------------------------------------
// Where each reviewable item lives in the files
// ---------------------------------------------------------------------------

interface Checked {
  source_page?: string | number | null;
  verified?: boolean;
  source_check?: { method: string; quote?: string; date?: string; reviewer?: string; [k: string]: unknown };
}

/** The live object for a key, so a promotion edits the file's own object. */
function locate(p: ImnciProtocol, c: CounsellingFile, key: string): Checked | null {
  if (key.startsWith("counselling:")) return (c.entries.find((e) => `counselling:${e.id}` === key) as unknown as Checked) ?? null;
  if (!key.startsWith("protocol:")) return null;
  if (key === "protocol:general_danger_signs") return p.general_danger_signs as unknown as Checked;
  const fb = key.match(/^protocol:(.+)\.fast_breathing$/);
  if (fb) return (p.assessments.find((a) => a.id === fb[1])?.derived?.fast_breathing as unknown as Checked) ?? null;
  const esc = key.match(/^protocol:(.+)\.escalate_if$/);
  if (esc) return (tablesFor(p).find((t) => t.id === esc[1])?.escalation as unknown as Checked) ?? null;
  for (const t of tablesFor(p)) for (const row of t.rows) if (`protocol:${row.id}` === key) return row as unknown as Checked;
  return null;
}

// ---------------------------------------------------------------------------
// The items the page shows
// ---------------------------------------------------------------------------

export function openDecisions(p: ImnciProtocol, c: CounsellingFile): ReviewItem[] {
  const honey = c.entries.flatMap((e) => e.held_steps ?? [])[0];
  const fu = c.entries.find((e) => e.open_question)?.open_question;
  const d = (slug: string, name: string, does: string[]): ReviewItem => ({ key: `decision:${slug}`, kind: "decision", group: "Open decisions", name, does });
  return [
    d("honey_home_remedies", "Honey and home remedies for cough", [
      `The booklet (page 13) advises a safe home remedy for children over 6 months, "like honey, tulsi, ginger". The app holds this sentence: it is never shown or read aloud.`,
      honey ? `Held text: "${honey.step_en}" Reason: ${honey.hold_reason}.` : "No held text found.",
      "Decide: show it as written, show it without honey (or honey only from 1 year), or leave it out.",
    ]),
    d("ors_packet_and_cup_size", "ORS packet size and cup size", [
      "The ORS steps follow the facilitator guide (page 86), which assumes a 1-litre packet. The card adds an app note: use the amount of water printed on the packet.",
      "Cup amounts use the booklet's 1 cup = 250 ml (page 18). The facilitator guide's ORS drill uses 1 cup = 150 ml (page 85). Every cup amount on the card shows millilitres.",
      "Decide: is the app note right, and which cup size should the card use?",
    ]),
    d("diarrhoea_follow_up_2_or_5_days", "Diarrhoea follow-up: 2 or 5 days", [fu ?? "Booklet page 10 says 2 days for some dehydration; page 16 says 5 days for diarrhoea if not improving."]),
    d("zinc_not_covered", "Zinc is not in the advice", [
      "Zinc for 14 days is rule 2 of the booklet's 4 rules of home treatment for diarrhoea (page 14). The advice leaves it out as a dosed supplement; the ASHA action text for dehydration still says to give zinc.",
      "Decide: should the card tell the mother about zinc (without a dose), and is zinc within ASHA scope?",
    ]),
    d("asha_action_scope", "What an ASHA may do (asha_action)", [
      "The card never shows the booklet's treatment column (imnci_action), which includes injections and antimalarials. It shows asha_action, wording written for the app.",
      "asha_action and the refer flag are not checked against the booklet. Review the asha_action shown under each rule below against the ASHA drug kit and scope.",
    ]),
    d("stop_at_first_danger_sign", "Stopping at the first danger sign", [
      'When any general danger sign is recorded, the assessment stops asking questions and gives URGENT REFERRAL at once ("Do not delay referral to finish other questions"). Signs not yet asked stay unassessed.',
      "The booklet says to complete the assessment and any pre-referral treatment immediately so that referral is not delayed. Decide: stop at once, or finish the remaining questions quickly?",
    ]),
    d("pneumonia_referral", "Referral for pneumonia", [
      `PNEUMONIA is marked refer: true, so the outcome reads REFER. asha_action: "${tableRow(p, "pneumonia")?.asha_action ?? ""}"`,
      "The booklet treats pneumonia at health-worker level (amoxycillin for 5 days, follow-up after 2 days). Decide whether an ASHA refers every pneumonia, or only when amoxicillin is not in her kit.",
    ]),
    d("ear_and_measles_removed", "Removal of ear and measles", [
      "The ear (mastoiditis, ear infection) and measles rows are retired: they are not in the 2023 health-worker booklet. They are kept in retired_rules for reference and are never classified or asked about.",
      "Decide: confirm the removal, or say where they should come from.",
    ]),
  ];
}

function tableRow(p: ImnciProtocol, id: string) {
  for (const t of tablesFor(p)) for (const row of t.rows) if (row.id === id) return row;
  return null;
}

const BOOKLET = (p: ImnciProtocol) => `${p.source.title}${p.source.edition ? ` (${p.source.edition})` : ""}`;

export function ruleItems(p: ImnciProtocol): ReviewItem[] {
  const items: ReviewItem[] = [];
  const gds = p.general_danger_signs;
  items.push({
    key: "protocol:general_danger_signs",
    kind: "rule",
    group: "General danger signs",
    name: "GENERAL DANGER SIGN",
    does: [`Any of: ${[...gds.ask, ...gds.look].map((i) => i.id).join(", ")}`, "Any one gives URGENT REFERRAL and ends the questions."],
    band: "pink",
    follow_up_days: null,
    asha_action: (gds as unknown as { asha_action?: string }).asha_action,
    source: BOOKLET(p),
    source_page: gds.source_page,
    quote: gds.source_check?.quote ?? null,
    method: gds.source_check?.method,
    verified: gds.verified,
  });
  for (const a of p.assessments) {
    const fb = a.derived?.fast_breathing;
    if (fb?.source_check) {
      items.push({
        key: `protocol:${a.id}.fast_breathing`,
        kind: "rule",
        group: a.id,
        name: "Fast breathing threshold",
        does: fb.thresholds.map((t) => `Age ${t.age_months_min} to under ${t.age_months_max} months: respiratory_rate ≥ ${t.breaths_per_min_at_or_above} per minute`),
        source: BOOKLET(p),
        source_page: (fb as { source_page?: string }).source_page ?? a.source_page,
        quote: fb.source_check.quote ?? null,
        method: fb.source_check.method,
        verified: fb.verified,
      });
    }
  }
  for (const t of tablesFor(p)) {
    if (t.escalation?.source_check) {
      items.push({
        key: `protocol:${t.id}.escalate_if`,
        kind: "rule",
        group: t.assessment,
        name: `Escalation on every ${t.id} row`,
        does: [`If ${describeCondition(t.escalation)}: ${t.escalation.then ?? "refer"}`],
        source: BOOKLET(p),
        source_page: t.escalation.source_page,
        quote: t.escalation.source_check.quote ?? null,
        method: t.escalation.source_check.method,
        verified: t.escalation.verified,
      });
    }
    for (const row of t.rows) {
      const esc = (row as unknown as { escalate_if?: Condition & { then?: string } }).escalate_if;
      items.push({
        key: `protocol:${row.id}`,
        kind: "rule",
        group: t.assessment,
        name: row.name,
        does: [
          `Signs: ${describeCondition(row.requires)}`,
          ...(t.gate ? [`Only when: ${describeCondition(t.gate)}`] : []),
          ...(esc ? [`Escalates if ${describeCondition(esc)}: ${esc.then ?? "refer"}`] : []),
          `Refer: ${row.refer ? "yes" : "no"}`,
        ],
        band: row.band,
        follow_up_days: row.follow_up_days ?? null,
        asha_action: row.asha_action,
        source: BOOKLET(p),
        source_page: row.source_page,
        quote: row.source_check?.quote ?? null,
        method: row.source_check?.method,
        verified: row.verified,
      });
    }
  }
  return items;
}

export function adviceItems(c: CounsellingFile): ReviewItem[] {
  return c.entries.map((e) => ({
    key: `counselling:${e.id}`,
    kind: "advice" as const,
    group: "What to tell the mother",
    name: e.title_en,
    does: [
      `Shown for: ${e.applies_to.join(", ")}${e.age_months_min != null ? `, age ${e.age_months_min} to under ${e.age_months_max} months` : ""}${e.priority === "urgent" ? " (first on a pink result)" : ""}`,
      ...e.steps_en.map((s) => `Says: ${s}`),
    ],
    source: `${c.sources[e.source].title} (${c.sources[e.source].edition})`,
    source_page: e.source_page,
    quote: e.source_check.quote ?? null,
    more_quotes: (e.source_check.supporting ?? []).map((s) => `p.${s.source_page}${s.source && s.source !== e.source ? ` (${s.source})` : ""}: "${s.quote}"`),
    notes: [
      ...(e.held_steps ?? []).map((h) => `HELD, never shown: "${h.step_en}" (${h.hold_reason})`),
      ...(e.app_notes ?? []).map((n) => `App note, not from the booklet: "${n.en}"`),
      ...(e.open_question ? [`Open question: ${e.open_question}`] : []),
    ],
    method: e.source_check.method,
    verified: e.verified,
  }));
}

export function reviewItems(p: ImnciProtocol, c: CounsellingFile): ReviewItem[] {
  return [...openDecisions(p, c), ...ruleItems(p), ...adviceItems(c)];
}

// ---------------------------------------------------------------------------
// The exported file, and applying it
// ---------------------------------------------------------------------------

export const EXPORT_FORMAT = "imnci-clinician-review";

export interface ReviewAnswer {
  key: string;
  verdict: Verdict;
  comment: string;
  reviewed?: { source_page: string | number | null; quote: string | null }; // what the reviewer saw
}

export interface ReviewExport {
  format: typeof EXPORT_FORMAT;
  format_version: 1;
  reviewer: string;
  date: string; // YYYY-MM-DD
  protocol_version: string;
  counselling_version: string;
  exported_at: string;
  items: ReviewAnswer[];
}

export interface ApplyReport {
  promoted: string[]; // set to clinician-reviewed
  unchanged: { key: string; verdict: Verdict; comment: string }[]; // wrong or needs change: left as they were
  skipped: { key: string; reason: string }[]; // marked correct but not promoted
  decisions: { key: string; verdict: Verdict; comment: string }[]; // open decisions: listed, never applied
  warnings: string[];
}

/** Throws on a file that cannot be applied safely. Unknown keys refuse the whole file. */
export function checkExport(raw: unknown, p: ImnciProtocol, c: CounsellingFile): ReviewExport {
  const r = (raw && typeof raw === "object" ? raw : {}) as Partial<ReviewExport>;
  const errors: string[] = [];
  if (r.format !== EXPORT_FORMAT) errors.push(`not a review export (format is "${String(r.format)}")`);
  if (typeof r.reviewer !== "string" || !r.reviewer.trim()) errors.push("no reviewer name");
  if (typeof r.date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(r.date) || Number.isNaN(Date.parse(r.date))) errors.push("no valid review date (YYYY-MM-DD)");
  if (!Array.isArray(r.items)) errors.push("no items");
  const known = new Set(reviewItems(p, c).map((i) => i.key));
  const seen = new Set<string>();
  for (const it of r.items ?? []) {
    if (!it || typeof it.key !== "string") {
      errors.push("an item without a key");
      continue;
    }
    if (seen.has(it.key)) errors.push(`${it.key}: listed twice`);
    seen.add(it.key);
    if (!known.has(it.key)) errors.push(`${it.key}: not an item in the current files`);
    if (!VERDICTS.some((v) => v.value === it.verdict)) errors.push(`${it.key}: unknown verdict "${String(it.verdict)}"`);
  }
  if (errors.length) throw new Error(`Review file refused:\n- ${errors.join("\n- ")}`);
  return r as ReviewExport;
}

/**
 * Apply a review to copies of the two files. Only items marked Correct are promoted, and only when
 * the page and quote the reviewer saw still match the file. Nothing the export does not mention is
 * touched. The results are validated with the same loaders the app uses.
 */
export function applyReview(
  protocolIn: ImnciProtocol,
  counsellingIn: CounsellingFile,
  raw: unknown,
): { protocol: ImnciProtocol; counselling: CounsellingFile; report: ApplyReport } {
  const exp = checkExport(raw, protocolIn, counsellingIn);
  const protocol = structuredClone(protocolIn);
  const counselling = structuredClone(counsellingIn);
  const report: ApplyReport = { promoted: [], unchanged: [], skipped: [], decisions: [], warnings: [] };
  if (exp.protocol_version !== protocol.version) report.warnings.push(`reviewed protocol v${exp.protocol_version}, file is v${protocol.version}`);
  if (exp.counselling_version !== (counselling as unknown as { version?: string }).version) {
    report.warnings.push(`reviewed counselling v${exp.counselling_version}, file is v${(counselling as unknown as { version?: string }).version}`);
  }
  const reviewer = exp.reviewer.trim();
  const current = new Map(reviewItems(protocolIn, counsellingIn).map((i) => [i.key, i]));

  for (const it of exp.items) {
    const entry = { key: it.key, verdict: it.verdict, comment: it.comment ?? "" };
    if (it.key.startsWith("decision:")) {
      report.decisions.push(entry);
      continue;
    }
    if (it.verdict !== "correct") {
      report.unchanged.push(entry);
      continue;
    }
    const target = locate(protocol, counselling, it.key);
    if (!target?.source_check) {
      report.skipped.push({ key: it.key, reason: "no source_check to promote" });
      continue;
    }
    if (target.verified !== true || target.source_check.method === "not-confirmed") {
      report.skipped.push({ key: it.key, reason: "not verified against the source, so it cannot be marked clinician-reviewed" });
      continue;
    }
    if (!it.reviewed) {
      report.skipped.push({ key: it.key, reason: "the export does not record the page and quote the reviewer saw" });
      continue;
    }
    const now = snapshotOf(current.get(it.key)!)!;
    if (String(it.reviewed.source_page ?? "") !== String(now.source_page ?? "") || (it.reviewed.quote ?? null) !== (now.quote ?? null)) {
      report.skipped.push({ key: it.key, reason: "the page or quote changed after the review" });
      continue;
    }
    target.source_check = { ...target.source_check, method: "clinician-reviewed", reviewer, date: exp.date };
    report.promoted.push(it.key);
  }

  validateProtocol(protocol);
  validateCounselling(counselling, protocol);
  return { protocol, counselling, report };
}

/** The page and quote of an item as the reviewer sees it, recorded in the export. */
export function snapshotOf(item: ReviewItem): ReviewAnswer["reviewed"] | undefined {
  return item.kind === "decision" ? undefined : { source_page: item.source_page ?? null, quote: item.quote ?? null };
}
