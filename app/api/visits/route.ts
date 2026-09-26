import { NextResponse } from "next/server";
import { findPatient, insertPatient, insertVisit, listVisits, storageMode, updatePatient, type NewVisit } from "@/lib/db";
import { normalize } from "@/lib/extraction";
import { missingFields, type VisitStatus } from "@/types/visit";
import type { Patient } from "@/types/patient";
import { addDays } from "@/lib/schedule";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    return NextResponse.json({ visits: await listVisits(), storage: storageMode() });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const asDate = (v: unknown) => (typeof v === "string" && DATE_RE.test(v) ? v : null);

/**
 * Register a patient the first time a name is heard, and afterwards only fill in dates
 * that were not already on file. The worker is never asked for an age twice.
 */
async function resolvePatient(
  patientId: string | null,
  name: string | null,
  householdId: string | null,
  protocolData: Record<string, unknown>,
): Promise<Patient | null> {
  const dob = asDate(protocolData.date_of_birth);
  // A stated month of pregnancy dates the ANC schedule when no delivery date was given.
  const edd = asDate(protocolData.expected_delivery_date) ?? eddFromGestationalMonth(protocolData.gestational_month);
  if (patientId) {
    const patch: Record<string, string> = {};
    if (dob) patch.date_of_birth = dob;
    if (edd) patch.expected_delivery_date = edd;
    return Object.keys(patch).length ? updatePatient(patientId, patch) : null;
  }
  if (!name) return null;

  const existing = await findPatient(name, householdId);
  if (existing) {
    const patch: Record<string, string> = {};
    if (dob && !existing.date_of_birth) patch.date_of_birth = dob;
    if (edd && edd !== existing.expected_delivery_date) patch.expected_delivery_date = edd;
    return Object.keys(patch).length ? ((await updatePatient(existing.id, patch)) ?? existing) : existing;
  }
  return insertPatient({
    name,
    date_of_birth: dob,
    dob_is_approximate: false,
    sex: null,
    household_id: householdId,
    village: null,
    expected_delivery_date: edd,
  });
}

/** Month 7 of pregnancy means roughly two months to term. Approximate, but it makes the ANC schedule usable. */
function eddFromGestationalMonth(month: unknown): string | null {
  const m = Number(month);
  if (!Number.isFinite(m) || m < 1 || m > 9) return null;
  return addDays(new Date().toISOString().slice(0, 10), Math.round((9 - m) * 30.44));
}

export async function POST(req: Request) {
  const body = await req.json();
  const extracted = normalize(body.visit);
  const protocolData = (body.protocol_data && typeof body.protocol_data === "object" ? body.protocol_data : {}) as Record<string, unknown>;
  const status: VisitStatus = missingFields(extracted).length ? "needs_follow_up" : "complete";

  try {
    const patient = await resolvePatient(
      typeof body.patient_id === "string" ? body.patient_id : null,
      extracted.patient_name,
      extracted.household_id,
      protocolData,
    );

    const visit: NewVisit = {
      ...extracted,
      visit_date: extracted.visit_date ?? new Date().toISOString().slice(0, 10),
      worker_id: typeof body.worker_id === "string" ? body.worker_id : null,
      patient_id: patient?.id ?? (typeof body.patient_id === "string" ? body.patient_id : null),
      protocol: typeof body.protocol === "string" ? body.protocol : null,
      protocol_data: protocolData,
      language: typeof body.language === "string" ? body.language : null,
      raw_transcript: typeof body.raw_transcript === "string" ? body.raw_transcript : "",
      status,
    };
    return NextResponse.json({ visit: await insertVisit(visit), patient }, { status: 201 });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}
