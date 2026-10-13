"use client";

import { useState } from "react";
import type { TriageResponse } from "@/app/api/triage/route";
import { COUNSELLING } from "@/lib/imnci/advice";
import { adviceFor, adviceSpeech, appNotesOf, entryVerification, titleOf, visibleSteps } from "@/lib/imnci/counselling";
import type { Lang } from "@/lib/i18n";
import { t } from "@/lib/text";
import { notAssessedLabels, type Outcome, type Verification } from "@/lib/imnci/rules";

const OUTCOME: Record<Outcome, { label: string; band: string }> = {
  urgent_referral: { label: "URGENT REFERRAL", band: "pink" },
  refer: { label: "REFER", band: "yellow" },
  treat_follow_up: { label: "TREAT AND FOLLOW UP", band: "yellow" },
  home_care: { label: "HOME CARE", band: "green" },
  incomplete: { label: "ASSESSMENT INCOMPLETE", band: "grey" },
  not_applicable: { label: "NOT APPLICABLE", band: "grey" },
};

const labelOf = (id: string) => id.replace(/^has_/, "").replace(/_/g, " ");

/** Shown with every result whose rules are not all clinician-reviewed. */
const VERIFICATION_NOTE: Record<Verification, string | null> = {
  draft: "Draft protocol. Some rules behind this result have not been checked against the printed chart. Follow the chart booklet if they differ.",
  "ai-compared": "Checked against the NHM booklet by software. Not yet reviewed by a clinician.",
  "clinician-reviewed": null,
};

/** IMNCI sick child assessment: the question in progress, then the classification and what the ASHA does. */
export function TriageCard({
  triage,
  onEnd,
  lang,
  onSpeak,
}: {
  triage: TriageResponse;
  onEnd: () => void;
  lang: Lang;
  onSpeak: (text: string) => Promise<void>; // the page's speak(): mutes the mic while talking
}) {
  const { state, result, question } = triage;
  const [reading, setReading] = useState(false);
  const done = state?.stage === "done";
  const outcome = result ? OUTCOME[result.outcome] : null;
  const note = done && result ? VERIFICATION_NOTE[result.verification] : null;
  const source = `${triage.protocol.title}${triage.protocol.edition ? ` (${triage.protocol.edition})` : ""}`;
  const advice = done && result ? adviceFor(COUNSELLING, result.classifications, result.ageMonths) : [];
  const adviceNote = advice.some((e) => entryVerification(e) === "draft") ? VERIFICATION_NOTE.draft : null;
  const docOf = (key: keyof typeof COUNSELLING.sources) => `${COUNSELLING.sources[key].title} (${COUNSELLING.sources[key].edition})`;
  const readAloud = async () => {
    setReading(true);
    try {
      await onSpeak(adviceSpeech(advice, lang));
    } finally {
      setReading(false);
    }
  };

  return (
    <section className="card triage">
      <div className="row" style={{ justifyContent: "space-between" }}>
        <h2 style={{ margin: 0 }}>Sick child assessment (IMNCI, 2 months to 5 years)</h2>
        <span className="small muted">Protocol v{triage.protocol.version}</span>
      </div>

      {state?.ageMonths != null && (
        <div className="small">
          Child <strong>{state.ageMonths} months</strong>
          {state.ageSource === "speech" && <>, from what you said (“{state.agePhrase}”)</>}
          {state.ageSource === "record" && <>, from the patient record</>}
          {state.ageSource === "answer" && <>, as you answered</>}
          {!done && <span className="muted"> · {t("ui.triage.wrong_age", lang)}</span>}
        </div>
      )}

      {note && <div className="agent-msg warn small">{note}</div>}

      {!done && question && (
        <div className="triage-question">
          <div className="small muted">Ask or check, then answer out loud or type below</div>
          <div className="q">{question}</div>
          <button onClick={onEnd}>End assessment</button>
        </div>
      )}

      {result?.urgent && !done && <div className="outcome band-pink">URGENT REFERRAL: refer now, do not wait to finish</div>}

      {done && result && outcome && (
        <>
          <div className={`outcome band-${outcome.band}`}>{outcome.label}</div>
          {result.classifications.map((c) => (
            <article key={c.id} className={`classification band-${c.band}`}>
              <div className="row" style={{ justifyContent: "space-between" }}>
                <strong>{c.name}</strong>
                <span className={`band-chip band-${c.band}`}>{c.band}</span>
              </div>
              <p className="action">{c.asha_action}</p>
              {c.escalation && <p className="small"><strong>Also:</strong> {c.escalation}.</p>}
              <p className="small muted">
                {c.follow_up_days != null && <>Follow up in {c.follow_up_days} days · </>}
                Source: {c.verified ? `${source}, page ${c.source_page}` : c.source_page}
                {!c.verified && " · not in the current booklet, not verified"}
              </p>
            </article>
          ))}
          {advice.length > 0 && (
            <section className="advice">
              <div className="row" style={{ justifyContent: "space-between" }}>
                <h3 style={{ margin: 0 }}>{t("ui.advice.heading", lang)}</h3>
                <button onClick={readAloud} disabled={reading}>
                  {t(reading ? "ui.advice.reading" : "ui.advice.read", lang)}
                </button>
              </div>
              {adviceNote && <div className="agent-msg warn small">{adviceNote}</div>}
              {advice.map((e) => (
                <article key={e.id} className={`advice-entry${e.priority === "urgent" ? " urgent" : ""}`}>
                  <strong>{titleOf(e, lang)}</strong>
                  <ul>
                    {visibleSteps(e, lang).map((step, i) => (
                      <li key={i}>{step}</li>
                    ))}
                  </ul>
                  {appNotesOf(e, lang).map((note, i) => (
                    <p key={i} className="app-note small">
                      <strong>App note, not from the booklet:</strong> {note}
                    </p>
                  ))}
                  <p className="small muted">
                    Source: {e.verified ? `${docOf(e.source)}, page ${e.source_page}` : e.source_page ?? "none"}
                    {!e.verified && " · not in the current booklet, not verified"}
                  </p>
                </article>
              ))}
            </section>
          )}
          {result.pending.length > 0 && (
            <p className="small missing">
              Not assessed: {notAssessedLabels(result.pending).join(", ")}
            </p>
          )}
          {result.unmatched.length > 0 && (
            <p className="small missing">
              No row of the encoded protocol matched for: {result.unmatched.map(labelOf).join(", ")}. Check the printed chart.
            </p>
          )}
          <p className="small">
            {triage.saveError ? <span className="missing">Not saved: {triage.saveError}</span> : triage.saved ? "Saved to this visit." : null}
          </p>
        </>
      )}

      <p className="small disclaimer">
        This is a referral and triage protocol from the {source} ({triage.protocol.publisher}). It is not a diagnosis.
      </p>

      {state && (state.log.length > 0 || Object.keys(state.signs).length > 0) && (
        <details className="small">
          <summary>Signs recorded ({Object.values(state.signs).filter((v) => v != null).length})</summary>
          <ul className="signs">
            {Object.entries(state.signs)
              .filter(([, v]) => v != null)
              .map(([k, v]) => (
                <li key={k}>
                  {labelOf(k)}: <strong>{String(v)}</strong>
                </li>
              ))}
          </ul>
          {state.log.map((l, i) => (
            <div key={i} className="muted">
              Q: {l.q} · A: {l.a}
            </div>
          ))}
        </details>
      )}
    </section>
  );
}
