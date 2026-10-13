/**
 * IMNCI sick child (2 months to 5 years) rules engine.
 *
 * The model only maps speech onto sign ids. This file decides every classification, from the
 * protocol JSON alone, with no network or model calls. Same inputs, same output, always.
 *
 * Signs are three-valued: true, false, or null (not yet assessed). A table never falls through
 * to a milder row while a sign that could put the child in a more severe row is still unknown,
 * and never settles while an escalation that could turn it into a referral is still unknown.
 * That is what stops an unasked question from turning into a green "home care" result.
 *
 * No imports, so `node --test` can load it directly.
 */

export type Band = "pink" | "yellow" | "green";
export type SignValue = boolean | number | string | null;
export type Signs = Record<string, SignValue | undefined>;

// ---------------------------------------------------------------------------
// Protocol JSON shape (only the parts the engine reads)
// ---------------------------------------------------------------------------

export type Condition = Record<string, unknown>;

/** How a rule was checked. "clinician-reviewed" is only ever set by hand in the JSON. */
export type CheckMethod = "ai-compared-to-booklet" | "clinician-reviewed" | "not-confirmed";
export interface SourceCheck {
  method: CheckMethod;
  date?: string;
  quote?: string;
  reason?: string;
  reviewer?: string;
}

export interface ProtocolItem {
  id: string;
  question_en?: string;
  question_hi?: string;
  observation_en?: string;
  observation_hi?: string;
  positive_when?: "yes" | "no";
  type?: string; // "number_days" | "number" | "enum"
  values?: string[];
  range?: [number, number];
  ask_if?: Condition; // only asked once this holds
  mwr?: ClinicalMwr | null; // Marwari question or observation; used only once reviewed
}

/** Optional Marwari for a protocol question, filled by scripts/apply-marwari.ts. */
export interface ClinicalMwr {
  question?: string;
  observation?: string;
  reviewed_by?: string;
  reviewed_on?: string;
}

export interface ProtocolClassification {
  id: string;
  name: string;
  band: Band;
  requires: Condition;
  applies_when?: Condition;
  asha_action: string;
  refer: boolean;
  follow_up_days?: number;
  escalate_if?: Condition;
  source_page: string;
  verified?: boolean;
  source_check?: SourceCheck;
}

/** A table-level escalation, e.g. "If blood in stool or diarrhoea ≥ 14 days, refer to hospital." */
export type Escalation = Condition & { then?: string; source_page?: string; verified?: boolean; source_check?: SourceCheck };

export interface ProtocolGroup {
  group: string;
  applies_when?: Condition;
  escalate_if?: Escalation;
  classifications: ProtocolClassification[];
}

export interface ProtocolAssessment {
  id: string;
  title: string;
  source_page: string;
  trigger?: { question_en: string; question_hi?: string; mwr?: ClinicalMwr | null };
  ask?: ProtocolItem[];
  look?: ProtocolItem[];
  derived?: {
    fast_breathing?: {
      thresholds: { age_months_min: number; age_months_max: number; breaths_per_min_at_or_above: number }[];
      verified?: boolean;
      source_check?: SourceCheck;
    };
  };
  classifications?: ProtocolClassification[];
  classification_groups?: ProtocolGroup[];
}

export interface ImnciProtocol {
  protocol: string;
  pathway: string;
  version: string;
  source: { title: string; publisher: string; edition?: string; official_listing?: string; retrieved_from?: string; sha256?: string };
  general_danger_signs: {
    source_page: string;
    verified?: boolean;
    source_check?: SourceCheck;
    ask: ProtocolItem[];
    look: ProtocolItem[];
    asha_action: string;
  };
  assessments: ProtocolAssessment[];
}

// ---------------------------------------------------------------------------
// Engine input and output
// ---------------------------------------------------------------------------

export interface TriageInput {
  signs: Signs;
  ageMonths: number | null;
  // Signs the worker could not assess ("pata nahi", skipped, or three unclear answers). A table that
  // reads any of them never settles on a green row: it stays pending instead.
  notAssessed?: string[];
}

/** What the worker is shown. Deliberately has no imnci_action: facility treatments are out of ASHA scope. */
export interface MatchedClassification {
  id: string;
  name: string;
  band: Band;
  assessment: string; // "general_danger_signs", "cough", "diarrhoea" ...
  asha_action: string;
  refer: boolean;
  follow_up_days: number | null;
  source_page: string;
  verified: boolean;
  checks: CheckMethod[]; // the row's check, plus the check of any escalation rule that fired
  escalation: string | null; // e.g. "refer for assessment" when a cough has lasted more than 14 days
}

/** Overall outcome. Bands follow the JSON: pink urgent referral, yellow treat and follow up, green home care. */
export type Outcome = "urgent_referral" | "refer" | "treat_follow_up" | "home_care" | "incomplete" | "not_applicable";

/** How far the rules behind one result have been checked. Drives the warning on the result card. */
export type Verification = "draft" | "ai-compared" | "clinician-reviewed";

export interface TriageResult {
  eligible: boolean;
  ineligibleReason: string | null;
  ageMonths: number | null;
  classifications: MatchedClassification[]; // general danger sign first, then assessment order
  outcome: Outcome;
  urgent: boolean; // any pink classification
  complete: boolean;
  pending: { table: string; signs: string[] }[]; // tables that cannot be decided yet, and the signs they need
  unmatched: string[]; // tables fully assessed where no row of the encoded protocol matched
  verification: Verification;
  derived: { general_danger_sign: boolean | null; fast_breathing: boolean | null; dehydration_present: boolean | null };
}

export const AGE_MIN_MONTHS = 2;
export const AGE_MAX_MONTHS = 60; // exclusive: "up to 5 years"

/** The trigger question of an assessment ("Does the child have diarrhoea?") is stored as has_<id>. */
export const triggerSign = (assessmentId: string) => `has_${assessmentId}`;

// ---------------------------------------------------------------------------
// Tables
// ---------------------------------------------------------------------------

export interface Table {
  id: string; // "cough", "diarrhoea.dehydration", "fever.fever", "malnutrition_anaemia.anaemia"
  assessment: string;
  gate: Condition | null;
  escalation: Escalation | null;
  rows: ProtocolClassification[];
}

/** Each chart table is read top-down and gives at most one classification. */
export function tablesFor(protocol: ImnciProtocol): Table[] {
  const tables: Table[] = [];
  for (const a of protocol.assessments) {
    if (a.classifications?.length) tables.push({ id: a.id, assessment: a.id, gate: null, escalation: null, rows: a.classifications });
    for (const g of a.classification_groups ?? []) {
      tables.push({ id: `${a.id}.${g.group}`, assessment: a.id, gate: g.applies_when ?? null, escalation: g.escalate_if ?? null, rows: g.classifications });
    }
  }
  return tables;
}

// ---------------------------------------------------------------------------
// Three-valued condition evaluation
// ---------------------------------------------------------------------------

type Tri = boolean | null;
interface Eval {
  v: Tri;
  missing: string[]; // only meaningful when v is null
}

const T: Eval = { v: true, missing: [] };
const F: Eval = { v: false, missing: [] };
const unknown = (missing: string[]): Eval => ({ v: null, missing: [...new Set(missing)] });

// Non-greedy: "muac_cm_at_or_above" is muac_cm at-or-above, not muac_cm_at_or above.
const COMPARE_RE = /^(.+?)_(at_or_above|above|below)$/;
const KNOWN_KEYS = new Set(["any_of", "all_of", "none_of", "min_count", "from", "equals", "otherwise", "and", "or"]);
// Escalation rules carry their own provenance next to the condition.
const META_KEYS = new Set(["then", "source_page", "verified", "source_check"]);

interface Ctx {
  resolve: (id: string) => { value: SignValue; missing: string[] };
}

function boolOf(ctx: Ctx, id: string): Eval {
  const { value, missing } = ctx.resolve(id);
  if (value === null || value === undefined) return unknown(missing.length ? missing : [id]);
  return value === true ? T : F;
}

function anyOf(ctx: Ctx, ids: string[]): Eval {
  return orOf(ids.map((id) => boolOf(ctx, id)));
}

function allOf(ctx: Ctx, ids: string[]): Eval {
  return andOf(ids.map((id) => boolOf(ctx, id)));
}

function noneOf(ctx: Ctx, ids: string[]): Eval {
  const r = anyOf(ctx, ids);
  return r.v === null ? r : r.v ? F : T;
}

/** Kleene OR: one true settles it; it is false only when every part is false. */
function orOf(parts: Eval[]): Eval {
  if (parts.some((p) => p.v === true)) return T;
  if (parts.every((p) => p.v === false)) return F;
  return unknown(parts.filter((p) => p.v === null).flatMap((p) => p.missing));
}

/** Kleene AND: one false settles it; it is true only when every part is true. */
function andOf(parts: Eval[]): Eval {
  if (parts.some((p) => p.v === false)) return F;
  if (parts.every((p) => p.v === true)) return T;
  return unknown(parts.filter((p) => p.v === null).flatMap((p) => p.missing));
}

/** "TWO OR MORE of these signs". Undecided while the unknown signs could still reach the count. */
function minCount(ctx: Ctx, n: number, ids: string[]): Eval {
  const parts = ids.map((id) => boolOf(ctx, id));
  const yes = parts.filter((p) => p.v === true).length;
  const open = parts.filter((p) => p.v === null);
  if (yes >= n) return T;
  if (yes + open.length < n) return F;
  return unknown(open.flatMap((p) => p.missing));
}

function equalsValue(ctx: Ctx, id: string, expected: unknown): Eval {
  const { value, missing } = ctx.resolve(id);
  if (value === null || value === undefined) return unknown(missing.length ? missing : [id]);
  return value === expected ? T : F;
}

function compare(ctx: Ctx, id: string, op: string, limit: number): Eval {
  const { value, missing } = ctx.resolve(id);
  if (typeof value !== "number") return unknown(missing.length ? missing : [id]);
  const ok = op === "at_or_above" ? value >= limit : op === "above" ? value > limit : value < limit;
  return ok ? T : F;
}

/** Every key in a condition must hold (Kleene AND). "or" holds when any of its conditions holds. */
function evalCondition(ctx: Ctx, cond: Condition): Eval {
  const parts: Eval[] = [];
  for (const [key, val] of Object.entries(cond)) {
    if (key === "from" || META_KEYS.has(key)) continue; // paired with min_count, or provenance
    if (key === "any_of") parts.push(anyOf(ctx, val as string[]));
    else if (key === "all_of") parts.push(allOf(ctx, val as string[]));
    else if (key === "none_of") parts.push(noneOf(ctx, val as string[]));
    else if (key === "min_count") parts.push(minCount(ctx, val as number, cond.from as string[]));
    else if (key === "otherwise") parts.push(T);
    else if (key === "and") parts.push(evalCondition(ctx, val as Condition));
    else if (key === "or") parts.push(orOf((val as Condition[]).map((c) => evalCondition(ctx, c))));
    else if (key === "equals") {
      for (const [id, expected] of Object.entries(val as Record<string, unknown>)) parts.push(equalsValue(ctx, id, expected));
    } else {
      const m = key.match(COMPARE_RE);
      parts.push(m ? compare(ctx, m[1], m[2], val as number) : equalsValue(ctx, key, val));
    }
  }
  return andOf(parts);
}

type TableOutcome =
  | { status: "matched"; row: ProtocolClassification }
  | { status: "pending"; missing: string[] }
  | { status: "unmatched" }
  | { status: "not_applicable" };

function evalTable(ctx: Ctx, table: Table): TableOutcome {
  if (table.gate) {
    const g = evalCondition(ctx, table.gate);
    if (g.v === false) return { status: "not_applicable" };
    if (g.v === null) return { status: "pending", missing: g.missing };
  }
  for (const row of table.rows) {
    if (row.applies_when) {
      const a = evalCondition(ctx, row.applies_when);
      if (a.v === false) continue;
      if (a.v === null) return { status: "pending", missing: a.missing };
    }
    const r = evalCondition(ctx, row.requires);
    if (r.v === true) return { status: "matched", row };
    // An undecided row stops the table: a milder row below it must not win by default.
    if (r.v === null) return { status: "pending", missing: r.missing };
  }
  return { status: "unmatched" };
}

// ---------------------------------------------------------------------------
// Derived signs
// ---------------------------------------------------------------------------

/** The raw signs a table reads, with derived signs (fast breathing, dehydration) expanded to their inputs. */
function tableInputs(protocol: ImnciProtocol, tables: Table[], table: Table, seen = new Set<string>()): Set<string> {
  const refs = new Set<string>();
  for (const cond of [table.gate, table.escalation, ...table.rows.flatMap((r) => [r.requires, r.escalate_if ?? null])]) {
    if (cond) referencedSigns(cond, refs);
  }
  const out = new Set<string>();
  seen.add(table.id);
  for (const id of refs) {
    if (id === "general_danger_sign") generalDangerSignIds(protocol).forEach((s) => out.add(s));
    else if (id === "fast_breathing") out.add("respiratory_rate");
    else if (id === "dehydration_present") {
      const t = tables.find((x) => x.id.endsWith(".dehydration"));
      if (t && !seen.has(t.id)) tableInputs(protocol, tables, t, seen).forEach((s) => out.add(s));
    } else out.add(id);
  }
  return out;
}

export function generalDangerSignIds(protocol: ImnciProtocol): string[] {
  return [...protocol.general_danger_signs.ask, ...protocol.general_danger_signs.look].map((i) => i.id);
}

/** Breaths per minute at or above which breathing is fast, for this age. Lower bound inclusive, upper exclusive. */
export function fastBreathingThreshold(protocol: ImnciProtocol, ageMonths: number): number | null {
  const thresholds = protocol.assessments.find((a) => a.derived?.fast_breathing)?.derived?.fast_breathing?.thresholds ?? [];
  const t = thresholds.find((x) => ageMonths >= x.age_months_min && ageMonths < x.age_months_max);
  return t ? t.breaths_per_min_at_or_above : null;
}

function makeCtx(protocol: ImnciProtocol, input: TriageInput, tables: Table[]): Ctx {
  const signs = input.signs;
  const memo = new Map<string, { value: SignValue; missing: string[] }>();
  const raw = (id: string): SignValue => (signs[id] === undefined ? null : (signs[id] as SignValue));

  const ctx: Ctx = {
    resolve(id) {
      const hit = memo.get(id);
      if (hit) return hit;
      let out: { value: SignValue; missing: string[] };
      switch (id) {
        case "general_danger_sign": {
          const r = anyOf({ resolve: (x) => ({ value: raw(x), missing: [x] }) }, generalDangerSignIds(protocol));
          out = { value: r.v, missing: r.missing };
          break;
        }
        case "fast_breathing": {
          // Always derived from the counted rate. A spoken "saans tez hai" is recorded but never classifies.
          const rate = raw("respiratory_rate");
          const limit = input.ageMonths == null ? null : fastBreathingThreshold(protocol, input.ageMonths);
          out = typeof rate === "number" && limit != null ? { value: rate >= limit, missing: [] } : { value: null, missing: ["respiratory_rate"] };
          break;
        }
        case "dehydration_present": {
          const t = tables.find((x) => x.id.endsWith(".dehydration"));
          const r = t ? evalTable(ctx, t) : { status: "unmatched" as const };
          if (r.status === "matched") out = { value: r.row.band !== "green", missing: [] };
          else if (r.status === "pending") out = { value: null, missing: r.missing };
          else out = { value: false, missing: [] };
          break;
        }
        case "age_months":
          out = { value: input.ageMonths, missing: ["age_months"] };
          break;
        default:
          out = { value: raw(id), missing: [id] };
      }
      memo.set(id, out);
      return out;
    },
  };
  return ctx;
}

/** Whether a condition holds for these signs: true, false, or null while it cannot be decided. */
export function holds(protocol: ImnciProtocol, input: TriageInput, cond: Condition): boolean | null {
  return evalCondition(makeCtx(protocol, input, tablesFor(protocol)), cond).v;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

const checkOf = (check: SourceCheck | undefined, verified: boolean | undefined): CheckMethod =>
  verified === true && check && check.method !== "not-confirmed" ? check.method : "not-confirmed";

function toMatched(row: ProtocolClassification, assessment: string, escalations: { text: string; check: CheckMethod }[]): MatchedClassification {
  const rowCheck = checkOf(row.source_check, row.verified);
  return {
    id: row.id,
    name: row.name,
    band: row.band,
    assessment,
    asha_action: row.asha_action,
    refer: row.refer || escalations.length > 0,
    follow_up_days: row.follow_up_days ?? null,
    source_page: row.source_page,
    verified: rowCheck !== "not-confirmed",
    checks: [rowCheck, ...escalations.map((e) => e.check)],
    escalation: escalations.map((e) => e.text).join("; ") || null,
  };
}

/** Draft unless every rule behind every classification shown was compared to the booklet or reviewed. */
/** The signs a result could not assess, as words, for the card's "Not assessed" line. */
export function notAssessedLabels(pending: TriageResult["pending"]): string[] {
  return [...new Set(pending.flatMap((p) => p.signs))].map((id) => id.replace(/^has_/, "").replace(/_/g, " "));
}

export function verificationOf(classifications: MatchedClassification[]): Verification {
  const checks = classifications.flatMap((c) => c.checks);
  if (!checks.length || checks.includes("not-confirmed")) return "draft";
  return checks.every((c) => c === "clinician-reviewed") ? "clinician-reviewed" : "ai-compared";
}

export function evaluate(protocol: ImnciProtocol, input: TriageInput): TriageResult {
  const empty = { general_danger_sign: null, fast_breathing: null, dehydration_present: null };
  const age = input.ageMonths;
  if (age == null || !Number.isFinite(age) || age < AGE_MIN_MONTHS || age >= AGE_MAX_MONTHS) {
    return {
      eligible: false,
      ineligibleReason: age == null ? "Child's age is not known." : `This protocol covers 2 months up to 5 years; the child is ${age} months.`,
      ageMonths: age,
      classifications: [],
      outcome: "not_applicable",
      urgent: false,
      complete: false,
      pending: [],
      unmatched: [],
      verification: "draft",
      derived: empty,
    };
  }

  const tables = tablesFor(protocol);
  const ctx = makeCtx(protocol, input, tables);
  const classifications: MatchedClassification[] = [];
  const pending: TriageResult["pending"] = [];
  const unmatched: string[] = [];

  // 1. General danger signs: checked first and always, whatever symptoms were reported.
  const gds = protocol.general_danger_signs;
  const danger = boolOf(ctx, "general_danger_sign");
  if (danger.v === true) {
    const check = checkOf(gds.source_check, gds.verified);
    classifications.push({
      id: "general_danger_sign",
      name: "GENERAL DANGER SIGN",
      band: "pink",
      assessment: "general_danger_signs",
      asha_action: gds.asha_action,
      refer: true,
      follow_up_days: null,
      source_page: gds.source_page,
      verified: check !== "not-confirmed",
      checks: [check],
      escalation: null,
    });
  } else if (danger.v === null) {
    pending.push({ table: "general_danger_signs", signs: danger.missing });
  }

  // 2. Every assessment whose symptom is present. One classification per table; several tables can match.
  for (const a of protocol.assessments) {
    if (a.trigger) {
      const has = boolOf(ctx, triggerSign(a.id));
      if (has.v === false) continue;
      if (has.v === null) {
        pending.push({ table: a.id, signs: [triggerSign(a.id)] });
        continue;
      }
    }
    for (const table of tables.filter((t) => t.assessment === a.id)) {
      const r = evalTable(ctx, table);
      if (r.status === "pending") pending.push({ table: table.id, signs: r.missing });
      else if (r.status === "unmatched") unmatched.push(table.id);
      else if (r.status === "matched") {
        const fired: { text: string; check: CheckMethod }[] = [];
        const open: string[] = [];
        for (const esc of [r.row.escalate_if as Escalation | undefined, table.escalation ?? undefined]) {
          if (!esc) continue;
          const e = evalCondition(ctx, esc);
          // An escalation can turn the result into a referral, so it must be decided before the table settles.
          if (e.v === null) open.push(...e.missing);
          else if (e.v) {
            const check = esc === table.escalation ? checkOf(esc.source_check, esc.verified) : checkOf(r.row.source_check, r.row.verified);
            fired.push({ text: typeof esc.then === "string" ? esc.then : "refer", check });
          }
        }
        // A green row is an all-clear. It is never given while a sign this table reads was not assessed,
        // even when three-valued logic says that sign could not change the row. Pink and yellow rows stand.
        const unchecked = r.row.band === "green" ? (input.notAssessed ?? []).filter((s) => tableInputs(protocol, tables, table).has(s)) : [];
        if (unchecked.length) open.push(...unchecked);
        if (open.length) pending.push({ table: table.id, signs: [...new Set(open)] });
        else classifications.push(toMatched(r.row, a.id, fired));
      }
    }
  }

  // 3. Any pink classification means urgent referral, whatever else matched or is still pending.
  const urgent = classifications.some((c) => c.band === "pink");
  const complete = pending.length === 0;
  const outcome: Outcome = urgent
    ? "urgent_referral"
    : !complete
      ? "incomplete"
      : classifications.some((c) => c.refer)
        ? "refer"
        : classifications.some((c) => c.band === "yellow")
          ? "treat_follow_up"
          : "home_care";

  const derivedValue = (id: string) => {
    const v = ctx.resolve(id).value;
    return typeof v === "boolean" ? v : null;
  };
  return {
    eligible: true,
    ineligibleReason: null,
    ageMonths: age,
    classifications,
    outcome,
    urgent,
    complete,
    pending,
    unmatched,
    verification: verificationOf(classifications),
    derived: {
      general_danger_sign: derivedValue("general_danger_sign"),
      fast_breathing: derivedValue("fast_breathing"),
      dehydration_present: derivedValue("dehydration_present"),
    },
  };
}

// ---------------------------------------------------------------------------
// Load-time validation, so an edit to the JSON cannot be silently ignored
// ---------------------------------------------------------------------------

const DERIVED_SIGNS = new Set(["general_danger_sign", "fast_breathing", "dehydration_present", "age_months"]);

function referencedSigns(cond: Condition, out: Set<string>) {
  for (const [key, val] of Object.entries(cond)) {
    if (META_KEYS.has(key) || key === "min_count" || key === "otherwise") continue;
    if (key === "any_of" || key === "all_of" || key === "none_of" || key === "from") (val as string[]).forEach((s) => out.add(s));
    else if (key === "and") referencedSigns(val as Condition, out);
    else if (key === "or") (val as Condition[]).forEach((c) => referencedSigns(c, out));
    else if (key === "equals") Object.keys(val as object).forEach((s) => out.add(s));
    else out.add(key.match(COMPARE_RE)?.[1] ?? key);
  }
}

function unknownKeys(cond: Condition): string[] {
  const bad: string[] = [];
  for (const [key, val] of Object.entries(cond)) {
    if (key === "and") bad.push(...unknownKeys(val as Condition));
    else if (key === "or") (val as Condition[]).forEach((c) => bad.push(...unknownKeys(c)));
    else if (!KNOWN_KEYS.has(key) && !META_KEYS.has(key) && !COMPARE_RE.test(key)) bad.push(key);
  }
  return bad;
}

/** "Never set verified true without a real page and a quote." Enforced here, at load. */
function checkProvenance(where: string, page: string | undefined, verified: boolean | undefined, check: SourceCheck | undefined, errors: string[]) {
  if (check && !["ai-compared-to-booklet", "clinician-reviewed", "not-confirmed"].includes(check.method)) {
    errors.push(`${where}: unknown source_check method "${check.method}"`);
  }
  if (verified !== true) {
    if (check && check.method !== "not-confirmed") errors.push(`${where}: verified is not true, so source_check must be not-confirmed`);
    return;
  }
  if (!check || check.method === "not-confirmed") errors.push(`${where}: verified true without a source_check`);
  else {
    if (!/^\d+$/.test(page ?? "")) errors.push(`${where}: verified true needs a real page number, got "${page}"`);
    if (!check.quote?.trim()) errors.push(`${where}: verified true needs a quote`);
    if (!check.date) errors.push(`${where}: verified true needs a date`);
    if (check.method === "clinician-reviewed" && !check.reviewer?.trim()) errors.push(`${where}: clinician-reviewed needs a reviewer`);
  }
}

/**
 * Throws on anything the engine would not understand, or on a verified rule without a page and
 * quote. Returns the sign ids that rules use but no ask/look item defines.
 */
export function validateProtocol(protocol: ImnciProtocol): { undefinedSigns: string[] } {
  const errors: string[] = [];
  const gds = protocol.general_danger_signs;
  checkProvenance("general_danger_signs", gds.source_page, gds.verified, gds.source_check, errors);
  const defined = new Set(generalDangerSignIds(protocol));
  const used = new Set<string>();
  for (const a of protocol.assessments) {
    if (a.trigger) defined.add(triggerSign(a.id));
    for (const item of [...(a.ask ?? []), ...(a.look ?? [])]) {
      defined.add(item.id);
      if (item.ask_if) referencedSigns(item.ask_if, used);
    }
    const fb = a.derived?.fast_breathing;
    if (fb) checkProvenance(`${a.id}/fast_breathing`, a.source_page, fb.verified, fb.source_check, errors);
  }
  for (const t of tablesFor(protocol)) {
    if (t.gate) referencedSigns(t.gate, used);
    if (t.escalation) {
      checkProvenance(`${t.id}/escalate_if`, t.escalation.source_page, t.escalation.verified, t.escalation.source_check, errors);
      referencedSigns(t.escalation, used);
    }
    for (const row of t.rows) {
      const where = `${t.id}/${row.id}`;
      if (!["pink", "yellow", "green"].includes(row.band)) errors.push(`${where}: unknown band "${row.band}"`);
      if (!row.asha_action?.trim()) errors.push(`${where}: missing asha_action`);
      if (!row.source_page) errors.push(`${where}: missing source_page`);
      checkProvenance(where, row.source_page, row.verified, row.source_check, errors);
      for (const key of unknownKeys(row.requires)) errors.push(`${where}: unknown requires key "${key}"`);
      for (const cond of [row.requires, row.applies_when, row.escalate_if]) {
        if (!cond) continue;
        if ("min_count" in cond && !Array.isArray(cond.from)) errors.push(`${where}: min_count without "from"`);
        referencedSigns(cond, used);
      }
    }
  }
  if (errors.length) throw new Error(`IMNCI protocol is invalid:\n${errors.join("\n")}`);
  return { undefinedSigns: [...used].filter((s) => !defined.has(s) && !DERIVED_SIGNS.has(s)).sort() };
}
