"use client";

import { useEffect, useState } from "react";
import type { Visit } from "@/types/visit";

// Drop a real scanned register photo at public/paper-register.jpg to replace the mock page.
const REGISTER_IMAGE = "/paper-register.jpg";

export default function BeforeAfter() {
  const [visit, setVisit] = useState<Visit | null>(null);
  const [hasImage, setHasImage] = useState(false);

  useEffect(() => {
    fetch("/api/visits")
      .then((r) => r.json())
      .then((d) => setVisit(d.visits?.[0] ?? null))
      .catch(() => {});
    const img = new Image();
    img.onload = () => setHasImage(true);
    img.src = REGISTER_IMAGE;
  }, []);

  return (
    <div className="stack">
      <div>
        <h1>Same visit, two ways</h1>
        <p className="muted">Paper gets re-typed weeks later. Voice lands in the dashboard seconds after the visit.</p>
      </div>
      <div className="grid">
        <section className="card">
          <h2>Before: paper register</h2>
          <div className="paper">
            {hasImage ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={REGISTER_IMAGE} alt="Scanned paper visit register" />
            ) : (
              <>
                <div>Date: 16/9 &nbsp; ASHA: Sunita</div>
                <div>Ghar no. 102 — Priya</div>
                <div>Bukhar, khansi. Temp 101°F</div>
                <div>BP 118/76</div>
                <div>Teeka: OPV due</div>
                <div>Agli visit — 3 din</div>
                <div className="small" style={{ marginTop: 28, fontFamily: "system-ui" }}>
                  ⏳ Re-typed into the district system: ~2–3 weeks later
                </div>
              </>
            )}
          </div>
        </section>
        <section className="card">
          <h2>After: spoken and structured</h2>
          {visit ? (
            <>
              <dl className="fields">
                <dt>Worker</dt><dd>{visit.worker_name ?? "—"}</dd>
                <dt>Household</dt><dd>{visit.household_id ?? "—"}</dd>
                <dt>Symptoms</dt><dd>{visit.symptoms.join(", ") || "—"}</dd>
                <dt>Vitals</dt>
                <dd>{Object.entries(visit.vitals).map(([k, v]) => `${k}: ${v}`).join(", ") || "—"}</dd>
                <dt>Vaccination</dt><dd>{visit.vaccination_status ?? "—"}</dd>
                <dt>Follow-up</dt><dd>{visit.follow_up_date ?? "—"}</dd>
                <dt>Status</dt><dd><span className={`badge ${visit.status}`}>{visit.status.replace(/_/g, " ")}</span></dd>
              </dl>
              <p className="small" style={{ marginTop: 16 }}>
                ⚡ Available to the supervisor at {new Date(visit.created_at).toLocaleTimeString()}
              </p>
              <details>
                <summary className="small">Original transcript</summary>
                <pre>{visit.raw_transcript}</pre>
              </details>
            </>
          ) : (
            <p className="muted">Record a visit first and it will appear here.</p>
          )}
        </section>
      </div>
    </div>
  );
}
