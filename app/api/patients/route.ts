import { NextResponse } from "next/server";
import { insertPatient, listPatients, visitsForPatient } from "@/lib/db";
import { dueFor } from "@/lib/due";
import { addMonths } from "@/lib/schedule";
import type { NewPatient, Sex } from "@/types/patient";

export const dynamic = "force-dynamic";

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : null);
const date = (v: unknown) => (typeof v === "string" && DATE_RE.test(v) ? v : null);

export async function GET() {
  const today = new Date().toISOString().slice(0, 10);
  try {
    const patients = await listPatients();
    const withDue = await Promise.all(
      patients.map(async (p) => ({ ...p, due: dueFor(p, await visitsForPatient(p.id), today) })),
    );
    return NextResponse.json({ patients: withDue });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}

/** Register a patient once. Age in months or years is accepted instead of a date of birth. */
export async function POST(req: Request) {
  const body = await req.json();
  const name = str(body.name);
  if (!name) return NextResponse.json({ error: "name is required" }, { status: 400 });

  const today = new Date().toISOString().slice(0, 10);
  let dob = date(body.date_of_birth);
  let approximate = false;
  if (!dob && Number.isFinite(body.age_months)) {
    dob = addMonths(today, -Number(body.age_months));
    approximate = true;
  } else if (!dob && Number.isFinite(body.age_years)) {
    dob = addMonths(today, -Number(body.age_years) * 12);
    approximate = true;
  }

  const sex = ["female", "male", "other"].includes(body.sex) ? (body.sex as Sex) : null;
  const patient: NewPatient = {
    name,
    date_of_birth: dob,
    dob_is_approximate: approximate,
    sex,
    household_id: str(body.household_id),
    village: str(body.village),
    expected_delivery_date: date(body.expected_delivery_date),
  };

  try {
    return NextResponse.json({ patient: await insertPatient(patient) }, { status: 201 });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}
