"use client";

import { useEffect, useRef, useState } from "react";
import type { Visit, VisitStatus } from "@/types/visit";

const POLL_MS = 3000;

/** Simple early-warning rule for supervisor review. */
function concerning(v: Visit): string | null {
  const t = Number(v.vitals?.temp_c);
  const spo2 = Number(v.vitals?.spo2);
  const [sys, dia] = String(v.vitals?.bp ?? "").split("/").map(Number);
  if (t >= 39) return `High fever ${t}°C`;
  if (spo2 && spo2 < 94) return `Low SpO2 ${spo2}%`;
  if (sys >= 140 || dia >= 90) return `High BP ${v.vitals.bp}`;
  return null;
}

function formatTime(iso: string) {
  return new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

export default function Dashboard() {
  const [visits, setVisits] = useState<Visit[]>([]);
  const [storage, setStorage] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<"all" | VisitStatus>("all");
  const seen = useRef<Set<string> | null>(null);
  const [fresh, setFresh] = useState<Set<string>>(new Set());

  const load = async () => {
    try {
      const res = await fetch("/api/visits", { cache: "no-store" });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      const list: Visit[] = data.visits;
      if (seen.current) {
        const added = list.filter((v) => !seen.current!.has(v.id)).map((v) => v.id);
        if (added.length) setFresh(new Set(added));
      }
      seen.current = new Set(list.map((v) => v.id));
      setVisits(list);
      setStorage(data.storage);
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    }
  };

  useEffect(() => {
    load();
    const id = setInterval(load, POLL_MS);
    return () => clearInterval(id);
  }, []);

  const setStatus = async (id: string, status: VisitStatus) => {
    await fetch(`/api/visits/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status }),
    });
    load();
  };

  const todayStr = new Date().toISOString().slice(0, 10);
  const weekOut = new Date(Date.now() + 7 * 864e5).toISOString().slice(0, 10);
  const dueThisWeek = visits.filter((v) => v.follow_up_date && v.follow_up_date >= todayStr && v.follow_up_date <= weekOut).length;
  const flagged = visits.filter((v) => v.status === "flagged_for_review" || concerning(v)).length;
  const shown = filter === "all" ? visits : visits.filter((v) => v.status === filter);

  return (
    <div>
      <div className="row" style={{ justifyContent: "space-between" }}>
        <div>
          <h1>Visit dashboard</h1>
          <p className="muted small">Updates every few seconds. Storage: {storage || "…"}</p>
        </div>
        <select value={filter} onChange={(e) => setFilter(e.target.value as typeof filter)} style={{ padding: 8, borderRadius: 8 }}>
          <option value="all">All statuses</option>
          <option value="complete">Complete</option>
          <option value="needs_follow_up">Needs follow-up</option>
          <option value="flagged_for_review">Flagged for review</option>
        </select>
      </div>

      <div className="stats">
        <div className="card stat"><div className="n">{visits.length}</div><div className="muted small">Visits logged</div></div>
        <div className="card stat"><div className="n">{dueThisWeek}</div><div className="muted small">Follow-ups due in 7 days</div></div>
        <div className="card stat"><div className="n">{flagged}</div><div className="muted small">Need supervisor attention</div></div>
      </div>

      {error && <div className="agent-msg warn">⚠ {error}</div>}

      <div className="table-wrap card" style={{ padding: 0 }}>
        <table>
          <thead>
            <tr>
              <th>Logged</th>
              <th>Worker</th>
              <th>Household</th>
              <th>Findings</th>
              <th>Follow-up</th>
              <th>Status</th>
              <th>Transcript</th>
            </tr>
          </thead>
          <tbody>
            {shown.map((v) => {
              const alert = concerning(v);
              const vitals = Object.entries(v.vitals ?? {}).filter(([, x]) => x != null);
              return (
                <tr key={v.id} className={[alert ? "alert" : "", fresh.has(v.id) ? "new" : ""].join(" ")}>
                  <td className="small">
                    {formatTime(v.created_at)}
                    {v.language && <div><span className="badge lang">{v.language}</span></div>}
                  </td>
                  <td>{v.worker_name ?? "—"}<div className="muted small">{v.worker_id}</div></td>
                  <td>{v.household_id ?? "—"}<div className="muted small">{v.patient_name}</div></td>
                  <td>
                    {v.symptoms?.join(", ") || "—"}
                    {vitals.length > 0 && <div className="small muted">{vitals.map(([k, x]) => `${k}: ${x}`).join(" · ")}</div>}
                    {v.vaccination_status && <div className="small muted">Vaccination: {v.vaccination_status}</div>}
                    {alert && <div className="small" style={{ color: "var(--danger)" }}>⚠ {alert}</div>}
                  </td>
                  <td>{v.follow_up_date ?? "—"}</td>
                  <td>
                    <span className={`badge ${v.status}`}>{v.status.replace(/_/g, " ")}</span>
                    <div style={{ marginTop: 6 }}>
                      {v.status !== "flagged_for_review" ? (
                        <button className="small" onClick={() => setStatus(v.id, "flagged_for_review")}>Flag</button>
                      ) : (
                        <button className="small" onClick={() => setStatus(v.id, "complete")}>Clear flag</button>
                      )}
                    </div>
                  </td>
                  <td>
                    <details>
                      <summary className="small">View</summary>
                      <pre>{v.raw_transcript}</pre>
                    </details>
                  </td>
                </tr>
              );
            })}
            {!shown.length && (
              <tr>
                <td colSpan={7} className="muted">No visits yet. Record one from the Record page.</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
