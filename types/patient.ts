export type Sex = "female" | "male" | "other";

export interface Patient {
  id: string;
  name: string;
  date_of_birth: string | null; // YYYY-MM-DD
  dob_is_approximate: boolean; // true when derived from a spoken age rather than a stated date
  sex: Sex | null;
  household_id: string | null;
  village: string | null;
  expected_delivery_date: string | null; // drives the ANC schedule for maternal visits
  created_at: string;
}

export type NewPatient = Omit<Patient, "id" | "created_at">;

/** Visit protocols. Maternal and child immunization have full field schemas; the rest reuse the general set. */
export type VisitProtocol =
  | "maternal_anc"
  | "newborn_hbnc"
  | "child_immunization"
  | "chronic_followup"
  | "general_illness";

export const VISIT_PROTOCOLS: VisitProtocol[] = [
  "maternal_anc",
  "newborn_hbnc",
  "child_immunization",
  "chronic_followup",
  "general_illness",
];

export type DueStatus = "overdue" | "due" | "upcoming";

export interface DueItem {
  label: string; // "Penta-1" or "ANC checkup 2"
  due_date: string; // YYYY-MM-DD
  status: DueStatus;
  days: number; // negative when overdue
  note?: string;
}

/** Normalized key for matching a spoken name against stored patients. */
export function nameKey(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, " ");
}
