export type VisitStatus = "complete" | "needs_follow_up" | "flagged_for_review";

export interface Vitals {
  temp_c?: number | null;
  bp?: string | null;
  pulse?: number | null;
  weight_kg?: number | null;
  spo2?: number | null;
  [key: string]: number | string | null | undefined;
}

/** Fields extracted from a transcript. Anything not spoken must stay null. */
export interface ExtractedVisit {
  worker_name: string | null;
  household_id: string | null;
  patient_name: string | null;
  visit_date: string | null; // YYYY-MM-DD
  symptoms: string[];
  vitals: Vitals;
  vaccination_status: string | null;
  follow_up_date: string | null; // YYYY-MM-DD
}

export interface Visit extends ExtractedVisit {
  id: string;
  worker_id: string | null;
  patient_id: string | null; // links the visit into a patient's history (Phase 5)
  protocol: string | null; // which visit protocol was followed
  protocol_data: Record<string, unknown>; // protocol-specific fields, e.g. gestational_month
  language: string | null;
  raw_transcript: string;
  status: VisitStatus;
  created_at: string;
}

/** "health_findings" is satisfied by at least one symptom or one vital sign. */
export type RequiredField = "worker_name" | "household_id" | "health_findings" | "follow_up_date";

export const REQUIRED_FIELDS: RequiredField[] = [
  "worker_name",
  "household_id",
  "health_findings",
  "follow_up_date",
];

export function emptyVisit(): ExtractedVisit {
  return {
    worker_name: null,
    household_id: null,
    patient_name: null,
    visit_date: null,
    symptoms: [],
    vitals: {},
    vaccination_status: null,
    follow_up_date: null,
  };
}

export function hasVitals(v: Vitals): boolean {
  return Object.values(v).some((x) => x !== null && x !== undefined && x !== "");
}

export function missingFields(v: ExtractedVisit): RequiredField[] {
  return REQUIRED_FIELDS.filter((f) => {
    if (f === "health_findings") return v.symptoms.length === 0 && !hasVitals(v.vitals);
    return !v[f];
  });
}
