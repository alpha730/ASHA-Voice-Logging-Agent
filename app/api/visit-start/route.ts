import { NextResponse } from "next/server";
import { findPatient, visitsForPatient } from "@/lib/db";
import { dueFor } from "@/lib/due";
import { dueSummary } from "@/lib/schedule";
import type { UiLang } from "@/lib/agent";
import type { DueItem, Patient } from "@/types/patient";

export const dynamic = "force-dynamic";

export interface VisitStartResponse {
  patient: Patient | null;
  known: boolean; // false means this name needs registering
  due: DueItem[];
  say: string | null; // spoken at the START of the visit, before any question
  history: number; // previous visits on record
}

/**
 * Called before the worker starts talking. Looks up the patient and returns what is
 * due or overdue, so the agent can tell the worker something they did not know.
 */
export async function POST(req: Request) {
  const body = await req.json();
  const name = typeof body.name === "string" ? body.name.trim() : "";
  const lang: UiLang = body.lang === "en" ? "en" : "hi";
  const today = body.today ?? new Date().toISOString().slice(0, 10);
  if (!name) return NextResponse.json({ error: "name is required" }, { status: 400 });

  try {
    const patient = await findPatient(name, body.household_id ?? null);
    if (!patient) {
      return NextResponse.json<VisitStartResponse>({ patient: null, known: false, due: [], say: null, history: 0 });
    }
    const visits = await visitsForPatient(patient.id);
    const due = dueFor(patient, visits, today);
    return NextResponse.json<VisitStartResponse>({
      patient,
      known: true,
      due,
      say: dueSummary(patient.name, due, lang),
      history: visits.length,
    });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}
