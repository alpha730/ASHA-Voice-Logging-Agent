import { ancDue, vaccinesDue } from "@/lib/schedule";
import type { DueItem, Patient } from "@/types/patient";
import type { Visit } from "@/types/visit";

/** Vaccine labels already recorded for this patient across previous visits. */
export function vaccinesAlreadyGiven(visits: Visit[]): string[] {
  return visits.flatMap((v) => {
    const given = v.protocol_data?.vaccines_given;
    return Array.isArray(given) ? given.filter((g): g is string => typeof g === "string") : [];
  });
}

/** ANC checkups already completed, counted from past maternal visits. */
function ancAlreadyDone(visits: Visit[]): string[] {
  const maternal = visits.filter((v) => v.protocol === "maternal_anc").length;
  return Array.from({ length: maternal }, (_, i) => `ANC checkup ${i + 1}`);
}

/**
 * What this patient is due or overdue for, from stored dates alone.
 * A child gets the immunization schedule; an expecting mother gets the ANC schedule.
 */
export function dueFor(patient: Patient, visits: Visit[], today: string): DueItem[] {
  const items: DueItem[] = [];
  if (patient.expected_delivery_date) items.push(...ancDue(patient.expected_delivery_date, today, ancAlreadyDone(visits)));
  if (patient.date_of_birth) items.push(...vaccinesDue(patient.date_of_birth, today, vaccinesAlreadyGiven(visits)));
  return items.sort((a, b) => a.due_date.localeCompare(b.due_date));
}
