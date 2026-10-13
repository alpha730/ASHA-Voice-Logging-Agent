import { test } from "node:test";
import assert from "node:assert/strict";
import { formFromVisit, visitFromForm } from "./visitEdit.ts";
import type { ExtractedVisit } from "../types/visit.ts";

const VISIT: ExtractedVisit = {
  worker_name: "Sunita",
  household_id: "H-102",
  patient_name: "Raju",
  visit_date: "2026-10-13",
  symptoms: ["fever", "cough"],
  vitals: { temp_c: 38.5, bp: "110/70", resp_rate: 40 },
  vaccination_status: null,
  follow_up_date: "2026-10-16",
};

test("an unchanged form gives back the same record", () => {
  const { visit, errors } = visitFromForm(formFromVisit(VISIT), VISIT);
  assert.deepEqual(errors, []);
  assert.deepEqual(visit, VISIT);
});

test("edits are applied: text, symptoms, vitals and dates", () => {
  const form = { ...formFromVisit(VISIT), worker_name: " Meena ", symptoms: "fever, diarrhoea,  fever", pulse: "110", temp_c: "", follow_up_date: "2026-10-20" };
  const { visit, errors } = visitFromForm(form, VISIT);
  assert.deepEqual(errors, []);
  assert.equal(visit.worker_name, "Meena");
  assert.deepEqual(visit.symptoms, ["fever", "diarrhoea"]);
  assert.equal(visit.vitals.pulse, 110);
  assert.equal("temp_c" in visit.vitals, false, "an emptied vital is removed");
  assert.equal(visit.vitals.resp_rate, 40, "a vital the form does not show is kept");
  assert.equal(visit.follow_up_date, "2026-10-20");
});

test("an emptied field becomes not captured (null), never an empty string", () => {
  const { visit } = visitFromForm({ ...formFromVisit(VISIT), household_id: "  ", follow_up_date: "" }, VISIT);
  assert.equal(visit.household_id, null);
  assert.equal(visit.follow_up_date, null);
});

test("typos are reported and nothing is guessed", () => {
  const form = { ...formFromVisit(VISIT), temp_c: "1o2", bp: "110-70", spo2: "140", visit_date: "13/10/2026" };
  const { errors } = visitFromForm(form, VISIT);
  assert.equal(errors.length, 4);
  assert.ok(errors.some((e) => e.startsWith("Temperature")));
  assert.ok(errors.some((e) => e.startsWith("BP")));
  assert.ok(errors.some((e) => e.startsWith("SpO2")));
  assert.ok(errors.some((e) => e.startsWith("Visit date")));
});
