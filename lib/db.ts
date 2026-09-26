import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { promises as fs } from "fs";
import path from "path";
import { randomUUID } from "crypto";
import type { Visit } from "@/types/visit";
import { nameKey, type NewPatient, type Patient } from "@/types/patient";

export type NewVisit = Omit<Visit, "id" | "created_at">;

let client: SupabaseClient | null = null;
function supabase(): SupabaseClient | null {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return null;
  client ??= createClient(url, key, { auth: { persistSession: false } });
  return client;
}

export const storageMode = () => (supabase() ? "supabase" : "local-json");

// Local JSON fallback so the app runs before Supabase is configured.
const FILE = path.join(process.cwd(), "data", "visits.json");

async function readLocal(): Promise<Visit[]> {
  try {
    return JSON.parse(await fs.readFile(FILE, "utf8"));
  } catch {
    return [];
  }
}

async function writeLocal(visits: Visit[]) {
  await fs.mkdir(path.dirname(FILE), { recursive: true });
  await fs.writeFile(FILE, JSON.stringify(visits, null, 2));
}

export async function insertVisit(v: NewVisit): Promise<Visit> {
  const sb = supabase();
  if (sb) {
    const { data, error } = await sb.from("visits").insert(v).select().single();
    if (error) throw new Error(error.message);
    return data as Visit;
  }
  const visit: Visit = { ...v, id: randomUUID(), created_at: new Date().toISOString() };
  const all = await readLocal();
  all.push(visit);
  await writeLocal(all);
  return visit;
}

export async function listVisits(): Promise<Visit[]> {
  const sb = supabase();
  if (sb) {
    const { data, error } = await sb
      .from("visits")
      .select("*")
      .order("created_at", { ascending: false })
      .limit(200);
    if (error) throw new Error(error.message);
    return (data ?? []) as Visit[];
  }
  return (await readLocal()).sort((a, b) => b.created_at.localeCompare(a.created_at));
}

export async function updateVisit(id: string, patch: Partial<NewVisit>): Promise<Visit | null> {
  const sb = supabase();
  if (sb) {
    const { data, error } = await sb.from("visits").update(patch).eq("id", id).select().single();
    if (error) throw new Error(error.message);
    return data as Visit;
  }
  const all = await readLocal();
  const i = all.findIndex((v) => v.id === id);
  if (i < 0) return null;
  all[i] = { ...all[i], ...patch };
  await writeLocal(all);
  return all[i];
}

export async function deleteVisit(id: string): Promise<boolean> {
  const sb = supabase();
  if (sb) {
    const { error } = await sb.from("visits").delete().eq("id", id);
    if (error) throw new Error(error.message);
    return true;
  }
  const all = await readLocal();
  const rest = all.filter((v) => v.id !== id);
  await writeLocal(rest);
  return rest.length !== all.length;
}

// ---------------------------------------------------------------------------
// Patients (Phase 5). Same Supabase-or-local-JSON split as visits above.
// ---------------------------------------------------------------------------

const PATIENT_FILE = path.join(process.cwd(), "data", "patients.json");

async function readPatientsLocal(): Promise<Patient[]> {
  try {
    return JSON.parse(await fs.readFile(PATIENT_FILE, "utf8"));
  } catch {
    return [];
  }
}

async function writePatientsLocal(patients: Patient[]) {
  await fs.mkdir(path.dirname(PATIENT_FILE), { recursive: true });
  await fs.writeFile(PATIENT_FILE, JSON.stringify(patients, null, 2));
}

export async function listPatients(): Promise<Patient[]> {
  const sb = supabase();
  if (sb) {
    const { data, error } = await sb.from("patients").select("*").order("created_at", { ascending: false }).limit(500);
    if (error) throw new Error(error.message);
    return (data ?? []) as Patient[];
  }
  return readPatientsLocal();
}

export async function getPatient(id: string): Promise<Patient | null> {
  const sb = supabase();
  if (sb) {
    const { data, error } = await sb.from("patients").select("*").eq("id", id).maybeSingle();
    if (error) throw new Error(error.message);
    return (data as Patient) ?? null;
  }
  return (await readPatientsLocal()).find((p) => p.id === id) ?? null;
}

/** Match a spoken name, preferring a patient in the same household. */
export async function findPatient(name: string, householdId?: string | null): Promise<Patient | null> {
  const key = nameKey(name);
  const all = await listPatients();
  const byName = all.filter((p) => nameKey(p.name) === key);
  if (!byName.length) return null;
  return byName.find((p) => householdId && p.household_id === householdId) ?? byName[0];
}

export async function insertPatient(p: NewPatient): Promise<Patient> {
  const sb = supabase();
  if (sb) {
    const { data, error } = await sb.from("patients").insert(p).select().single();
    if (error) throw new Error(error.message);
    return data as Patient;
  }
  const patient: Patient = { ...p, id: randomUUID(), created_at: new Date().toISOString() };
  const all = await readPatientsLocal();
  all.push(patient);
  await writePatientsLocal(all);
  return patient;
}

export async function updatePatient(id: string, patch: Partial<NewPatient>): Promise<Patient | null> {
  const sb = supabase();
  if (sb) {
    const { data, error } = await sb.from("patients").update(patch).eq("id", id).select().single();
    if (error) throw new Error(error.message);
    return data as Patient;
  }
  const all = await readPatientsLocal();
  const i = all.findIndex((p) => p.id === id);
  if (i < 0) return null;
  all[i] = { ...all[i], ...patch };
  await writePatientsLocal(all);
  return all[i];
}

/** Every visit recorded for one patient, newest first. Used for vaccines already given. */
export async function visitsForPatient(patientId: string): Promise<Visit[]> {
  const sb = supabase();
  if (sb) {
    const { data, error } = await sb
      .from("visits")
      .select("*")
      .eq("patient_id", patientId)
      .order("created_at", { ascending: false });
    if (error) throw new Error(error.message);
    return (data ?? []) as Visit[];
  }
  return (await readLocal()).filter((v) => v.patient_id === patientId).sort((a, b) => b.created_at.localeCompare(a.created_at));
}
