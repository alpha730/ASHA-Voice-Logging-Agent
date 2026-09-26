"use client";

import { useEffect, useState } from "react";
import type { DueItem, Patient } from "@/types/patient";

type PatientWithDue = Patient & { due: DueItem[] };

function ageLabel(dob: string | null): string {
  if (!dob) return "—";
  const months = Math.max(0, Math.floor((Date.now() - new Date(`${dob}T00:00:00Z`).getTime()) / 2_629_800_000));
  if (months < 24) return `${months} months`;
  return `${Math.floor(months / 12)} years`;
}

export default function PatientsPage() {
  const [patients, setPatients] = useState<PatientWithDue[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [onlyDue, setOnlyDue] = useState(false);

  useEffect(() => {
    const load = () =>
      fetch("/api/patients", { cache: "no-store" })
        .then((r) => r.json())
        .then((d) => (d.error ? setError(d.error) : setPatients(d.patients)))
        .catch((e) => setError(e.message));
    load();
    const id = setInterval(load, 5000);
    return () => clearInterval(id);
  }, []);

  const actionable = (p: PatientWithDue) => p.due.filter((d) => d.status !== "upcoming");
  const shown = onlyDue ? patients.filter((p) => actionable(p).length > 0) : patients;
  const overdueCount = patients.filter((p) => p.due.some((d) => d.status === "overdue")).length;

  return (
    <div>
      <div className="row" style={{ justifyContent: "space-between" }}>
        <div>
          <h1>Patient register</h1>
          <p className="muted small">
            Due dates come from the National Immunization Schedule and the ANC schedule. Pure date arithmetic, no model involved.
          </p>
        </div>
        <label className="row small">
          <input type="checkbox" checked={onlyDue} onChange={(e) => setOnlyDue(e.target.checked)} style={{ width: "auto" }} />
          Only those with something due
        </label>
      </div>

      <div className="stats">
        <div className="card stat"><div className="n">{patients.length}</div><div className="muted small">Patients registered</div></div>
        <div className="card stat"><div className="n">{overdueCount}</div><div className="muted small">With something overdue</div></div>
      </div>

      {error && <div className="agent-msg warn">⚠ {error}</div>}

      <div className="table-wrap card" style={{ padding: 0 }}>
        <table>
          <thead>
            <tr>
              <th>Name</th>
              <th>Age</th>
              <th>Household</th>
              <th>Pregnancy</th>
              <th>Due and overdue</th>
            </tr>
          </thead>
          <tbody>
            {shown.map((p) => {
              const items = actionable(p);
              return (
                <tr key={p.id} className={p.due.some((d) => d.status === "overdue") ? "alert" : ""}>
                  <td>{p.name}</td>
                  <td>
                    {ageLabel(p.date_of_birth)}
                    {p.dob_is_approximate && <div className="muted small">approximate</div>}
                  </td>
                  <td>{p.household_id ?? "—"}<div className="muted small">{p.village}</div></td>
                  <td>{p.expected_delivery_date ? `EDD ${p.expected_delivery_date}` : "—"}</td>
                  <td>
                    {items.length ? (
                      <ul className="due-list" style={{ margin: 0 }}>
                        {items.slice(0, 4).map((d) => (
                          <li key={d.label + d.due_date}>
                            <span className={`badge ${d.status === "overdue" ? "flagged_for_review" : "needs_follow_up"}`}>{d.status}</span>{" "}
                            {d.label} · {d.due_date}
                          </li>
                        ))}
                        {items.length > 4 && <li className="muted small">and {items.length - 4} more</li>}
                      </ul>
                    ) : (
                      <span className="muted">Nothing due</span>
                    )}
                  </td>
                </tr>
              );
            })}
            {!shown.length && (
              <tr>
                <td colSpan={5} className="muted">No patients yet. They are registered the first time a name is spoken in a visit.</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
