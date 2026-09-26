import type { DueItem, DueStatus } from "@/types/patient";

/**
 * Due-date engine. Pure date arithmetic against India's National Immunization Schedule
 * and the ANC checkup schedule. No LLM is involved here, so the output is always correct
 * for a given date of birth or expected delivery date.
 */

const DAY_MS = 86_400_000;

export function addDays(date: string, days: number): string {
  return new Date(new Date(`${date}T00:00:00Z`).getTime() + days * DAY_MS).toISOString().slice(0, 10);
}

export function addMonths(date: string, months: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  const day = d.getUTCDate();
  d.setUTCMonth(d.getUTCMonth() + months);
  if (d.getUTCDate() < day) d.setUTCDate(0); // clamp e.g. 31 Jan + 1 month to 28/29 Feb
  return d.toISOString().slice(0, 10);
}

export function daysBetween(from: string, to: string): number {
  return Math.round((new Date(`${to}T00:00:00Z`).getTime() - new Date(`${from}T00:00:00Z`).getTime()) / DAY_MS);
}

export function ageInMonths(dob: string, on: string): number {
  const a = new Date(`${dob}T00:00:00Z`);
  const b = new Date(`${on}T00:00:00Z`);
  let months = (b.getUTCFullYear() - a.getUTCFullYear()) * 12 + (b.getUTCMonth() - a.getUTCMonth());
  if (b.getUTCDate() < a.getUTCDate()) months--;
  return months;
}

/** How long after a due date something counts as merely "due" rather than "overdue". */
const GRACE_DAYS = 14;
/** How far ahead to mention something that is not due yet. */
const LOOKAHEAD_DAYS = 30;

function statusFor(dueDate: string, today: string): { status: DueStatus; days: number } {
  const days = daysBetween(today, dueDate);
  if (days < -GRACE_DAYS) return { status: "overdue", days };
  if (days <= 0) return { status: "due", days };
  return { status: "upcoming", days };
}

// ---------------------------------------------------------------------------
// National Immunization Schedule (Universal Immunization Programme, India)
// ---------------------------------------------------------------------------

interface ScheduleEntry {
  label: string;
  /** Age at which the dose is due. */
  weeks?: number;
  months?: number;
  years?: number;
  note?: string;
}

export const IMMUNIZATION_SCHEDULE: ScheduleEntry[] = [
  { label: "BCG", weeks: 0, note: "at birth" },
  { label: "Hepatitis B birth dose", weeks: 0, note: "within 24 hours" },
  { label: "OPV-0", weeks: 0, note: "at birth" },
  { label: "OPV-1", weeks: 6 },
  { label: "Pentavalent-1", weeks: 6 },
  { label: "Rotavirus-1", weeks: 6 },
  { label: "fIPV-1", weeks: 6 },
  { label: "PCV-1", weeks: 6 },
  { label: "OPV-2", weeks: 10 },
  { label: "Pentavalent-2", weeks: 10 },
  { label: "Rotavirus-2", weeks: 10 },
  { label: "OPV-3", weeks: 14 },
  { label: "Pentavalent-3", weeks: 14 },
  { label: "Rotavirus-3", weeks: 14 },
  { label: "fIPV-2", weeks: 14 },
  { label: "PCV-2", weeks: 14 },
  { label: "MR-1", months: 9 },
  { label: "JE-1", months: 9, note: "endemic districts" },
  { label: "PCV booster", months: 9 },
  { label: "Vitamin A first dose", months: 9 },
  { label: "DPT booster-1", months: 16 },
  { label: "MR-2", months: 16 },
  { label: "JE-2", months: 16, note: "endemic districts" },
  { label: "OPV booster", months: 16 },
  { label: "DPT booster-2", years: 5 },
  { label: "Td (10 years)", years: 10 },
  { label: "Td (16 years)", years: 16 },
];

function dueDateFor(dob: string, entry: ScheduleEntry): string {
  if (entry.years) return addMonths(dob, entry.years * 12);
  if (entry.months) return addMonths(dob, entry.months);
  return addDays(dob, (entry.weeks ?? 0) * 7);
}

/**
 * Vaccines due, overdue, or coming up for a child, excluding any already given.
 * `given` holds labels recorded on previous visits.
 */
export function vaccinesDue(dob: string, today: string, given: string[] = []): DueItem[] {
  const done = new Set(given.map((g) => g.trim().toLowerCase()));
  return IMMUNIZATION_SCHEDULE.filter((e) => !done.has(e.label.toLowerCase()))
    .map((e) => {
      const due_date = dueDateFor(dob, e);
      return { label: e.label, due_date, note: e.note, ...statusFor(due_date, today) };
    })
    .filter((d) => d.status !== "upcoming" || d.days <= LOOKAHEAD_DAYS)
    .sort((a, b) => a.due_date.localeCompare(b.due_date));
}

// ---------------------------------------------------------------------------
// Antenatal care schedule, derived from the expected delivery date
// ---------------------------------------------------------------------------

/** A pregnancy is dated 280 days from the last menstrual period. */
export const GESTATION_DAYS = 280;

export function lmpFromEdd(edd: string): string {
  return addDays(edd, -GESTATION_DAYS);
}

export function gestationalWeeks(edd: string, today: string): number {
  return Math.max(0, Math.floor(daysBetween(lmpFromEdd(edd), today) / 7));
}

interface AncEntry {
  label: string;
  week: number;
  note?: string;
}

export const ANC_SCHEDULE: AncEntry[] = [
  { label: "ANC checkup 1", week: 12, note: "register within first trimester" },
  { label: "Td/TT dose 1", week: 16 },
  { label: "ANC checkup 2", week: 20 },
  { label: "Td/TT dose 2", week: 20, note: "4 weeks after dose 1" },
  { label: "ANC checkup 3", week: 30 },
  { label: "ANC checkup 4", week: 36, note: "confirm delivery plan" },
];

export function ancDue(edd: string, today: string, done: string[] = []): DueItem[] {
  const lmp = lmpFromEdd(edd);
  const completed = new Set(done.map((d) => d.trim().toLowerCase()));
  const items = ANC_SCHEDULE.filter((e) => !completed.has(e.label.toLowerCase())).map((e) => {
    const due_date = addDays(lmp, e.week * 7);
    return { label: e.label, due_date, note: e.note, ...statusFor(due_date, today) };
  });
  items.push({ label: "Expected delivery", due_date: edd, note: "plan institutional delivery", ...statusFor(edd, today) });
  return items
    .filter((d) => d.status !== "upcoming" || d.days <= LOOKAHEAD_DAYS)
    .sort((a, b) => a.due_date.localeCompare(b.due_date));
}

// ---------------------------------------------------------------------------
// Spoken read-back
// ---------------------------------------------------------------------------

/** One short line the agent says at the START of a visit, before asking anything. */
export function dueSummary(name: string, items: DueItem[], lang: "hi" | "en"): string | null {
  const actionable = items.filter((i) => i.status !== "upcoming");
  if (!actionable.length) return null;
  const overdue = actionable.filter((i) => i.status === "overdue");
  const labels = actionable.slice(0, 3).map((i) => i.label).join(", ");
  const more = actionable.length > 3 ? ` and ${actionable.length - 3} more` : "";
  if (lang === "hi") {
    return overdue.length
      ? `${name} ke liye ${labels}${more} baaki hai, ${Math.abs(overdue[0].days)} din se pending.`
      : `${name} ke liye aaj ${labels}${more} due hai.`;
  }
  return overdue.length
    ? `${name} is overdue for ${labels}${more}, by ${Math.abs(overdue[0].days)} days.`
    : `${name} is due for ${labels}${more} today.`;
}
