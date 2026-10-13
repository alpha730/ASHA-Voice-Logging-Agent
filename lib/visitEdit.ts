/**
 * Hand edits to the structured record on the record page. The form holds plain strings; turning
 * them back into a record checks each field, so a typo is reported instead of saved.
 */
import type { ExtractedVisit, Vitals } from "../types/visit.ts";

export interface VisitForm {
  worker_name: string;
  household_id: string;
  patient_name: string;
  visit_date: string; // YYYY-MM-DD
  symptoms: string; // comma-separated
  temp_c: string;
  bp: string; // "120/80"
  pulse: string;
  weight_kg: string;
  spo2: string;
  vaccination_status: string;
  follow_up_date: string; // YYYY-MM-DD
}

/** The vitals the form edits. Any other vital already on the record is kept as it is. */
const NUMERIC_VITALS = [
  { key: "temp_c", label: "Temperature (°C)", min: 30, max: 45 },
  { key: "pulse", label: "Pulse", min: 20, max: 250 },
  { key: "weight_kg", label: "Weight (kg)", min: 0.5, max: 250 },
  { key: "spo2", label: "SpO2 (%)", min: 50, max: 100 },
] as const;

const str = (v: unknown) => (v == null ? "" : String(v));

export function formFromVisit(v: ExtractedVisit): VisitForm {
  return {
    worker_name: str(v.worker_name),
    household_id: str(v.household_id),
    patient_name: str(v.patient_name),
    visit_date: str(v.visit_date),
    symptoms: v.symptoms.join(", "),
    temp_c: str(v.vitals.temp_c),
    bp: str(v.vitals.bp),
    pulse: str(v.vitals.pulse),
    weight_kg: str(v.vitals.weight_kg),
    spo2: str(v.vitals.spo2),
    vaccination_status: str(v.vaccination_status),
    follow_up_date: str(v.follow_up_date),
  };
}

const isDate = (s: string) => /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s));

/**
 * The edited record, or the problems that stop it being saved. An emptied field becomes null
 * (not captured), the same as anything the worker never said.
 */
export function visitFromForm(form: VisitForm, prev: ExtractedVisit): { visit: ExtractedVisit; errors: string[] } {
  const errors: string[] = [];
  const text = (s: string) => s.trim() || null;
  const date = (s: string, label: string) => {
    const t = s.trim();
    if (!t) return null;
    if (!isDate(t)) errors.push(`${label}: use a date like 2026-10-20`);
    return isDate(t) ? t : null;
  };

  const vitals: Vitals = { ...prev.vitals };
  for (const { key, label, min, max } of NUMERIC_VITALS) {
    const t = form[key].trim();
    if (!t) {
      delete vitals[key];
      continue;
    }
    const n = Number(t);
    if (!Number.isFinite(n) || n < min || n > max) errors.push(`${label}: enter a number from ${min} to ${max}`);
    else vitals[key] = n;
  }
  const bp = form.bp.trim();
  if (!bp) delete vitals.bp;
  else if (!/^\d{2,3}\s*\/\s*\d{2,3}$/.test(bp)) errors.push("BP: use the form 120/80");
  else vitals.bp = bp.replace(/\s+/g, "");

  const visit: ExtractedVisit = {
    worker_name: text(form.worker_name),
    household_id: text(form.household_id),
    patient_name: text(form.patient_name),
    visit_date: date(form.visit_date, "Visit date"),
    symptoms: [...new Set(form.symptoms.split(/[,\n]/).map((s) => s.trim()).filter(Boolean))],
    vitals,
    vaccination_status: text(form.vaccination_status),
    follow_up_date: date(form.follow_up_date, "Follow-up date"),
  };
  return { visit, errors };
}
