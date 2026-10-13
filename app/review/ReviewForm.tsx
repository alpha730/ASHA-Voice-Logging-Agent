"use client";

import { useEffect, useMemo, useState } from "react";
import { EXPORT_FORMAT, snapshotOf, VERDICTS, type ReviewExport, type ReviewItem, type Verdict } from "@/lib/imnci/review";

type Answers = Record<string, { verdict?: Verdict; comment: string }>;
type Saved = { reviewer: string; date: string; answers: Answers };

const SECTION_TITLE: Record<ReviewItem["kind"], string> = {
  decision: "Open decisions",
  rule: "Protocol rules",
  advice: "What to tell the mother",
};

/** Answers stay in this browser (localStorage) until exported. Nothing is sent to the server. */
export function ReviewForm({
  items,
  protocolVersion,
  counsellingVersion,
  source,
}: {
  items: ReviewItem[];
  protocolVersion: string;
  counsellingVersion: string;
  source: string;
}) {
  const storageKey = `imnci-review:${protocolVersion}:${counsellingVersion}`;
  const [reviewer, setReviewer] = useState("");
  const [date, setDate] = useState("");
  const [answers, setAnswers] = useState<Answers>({});
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(storageKey) ?? "null") as Saved | null;
      if (saved) {
        setReviewer(saved.reviewer ?? "");
        setDate(saved.date ?? "");
        setAnswers(saved.answers ?? {});
      }
    } catch {}
    setLoaded(true);
  }, [storageKey]);

  useEffect(() => {
    if (!loaded) return;
    try {
      localStorage.setItem(storageKey, JSON.stringify({ reviewer, date, answers } satisfies Saved));
    } catch {}
  }, [loaded, storageKey, reviewer, date, answers]);

  const answered = items.filter((i) => answers[i.key]?.verdict).length;
  const commentOnly = items.filter((i) => !answers[i.key]?.verdict && answers[i.key]?.comment?.trim()).length;
  const missing = [!reviewer.trim() && "your name", !/^\d{4}-\d{2}-\d{2}$/.test(date) && "the review date", !answered && "at least one answer"].filter(Boolean);

  const sections = useMemo(() => {
    const out: { kind: ReviewItem["kind"]; groups: [string, ReviewItem[]][] }[] = [];
    for (const kind of ["decision", "rule", "advice"] as const) {
      const groups = new Map<string, ReviewItem[]>();
      for (const it of items.filter((i) => i.kind === kind)) groups.set(it.group, [...(groups.get(it.group) ?? []), it]);
      out.push({ kind, groups: [...groups] });
    }
    return out;
  }, [items]);

  const set = (key: string, patch: Partial<Answers[string]>) =>
    setAnswers((a) => ({ ...a, [key]: { ...(a[key] ?? { comment: "" }), ...patch } }));

  function exportJson() {
    const data: ReviewExport = {
      format: EXPORT_FORMAT,
      format_version: 1,
      reviewer: reviewer.trim(),
      date,
      protocol_version: protocolVersion,
      counselling_version: counsellingVersion,
      exported_at: new Date().toISOString(),
      items: items
        .filter((i) => answers[i.key]?.verdict)
        .map((i) => ({ key: i.key, verdict: answers[i.key].verdict!, comment: answers[i.key].comment.trim(), reviewed: snapshotOf(i) })),
    };
    const blob = new Blob([JSON.stringify(data, null, 2) + "\n"], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `imnci-review-${date}-${reviewer.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-")}.json`;
    a.click();
    URL.revokeObjectURL(a.href);
  }

  function clearAll() {
    if (confirm("Clear every answer and comment on this page?")) setAnswers({});
  }

  return (
    <div className="review">
      <section className="card review-head">
        <h1 style={{ margin: 0 }}>Clinician review: IMNCI sick child, 2 months to 5 years</h1>
        <p className="small muted">
          Protocol v{protocolVersion}, advice v{counsellingVersion}. Source: {source}. Compare each item with the printed page and mark it.
          Answers are kept in this browser only and are never sent anywhere. Export the file and pass it to the team, who apply it with{" "}
          <code>node scripts/apply-review.ts</code>. Only items marked Correct become &quot;clinician-reviewed&quot;.
        </p>
        <div className="review-who">
          <label>
            Reviewer name (required)
            <input value={reviewer} onChange={(e) => setReviewer(e.target.value)} placeholder="Dr. Full Name" />
          </label>
          <label>
            Review date (required)
            <input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
          </label>
        </div>
        <div className="row">
          <button className="primary" onClick={exportJson} disabled={missing.length > 0}>
            Export JSON
          </button>
          <button onClick={clearAll}>
            Clear answers
          </button>
          <span className="small muted">
            {answered} of {items.length} answered
            {commentOnly > 0 && ` · ${commentOnly} with a comment but no answer (not exported)`}
          </span>
        </div>
        {missing.length > 0 && <p className="small missing">To export, add {missing.join(", ")}.</p>}
      </section>

      {sections.map(({ kind, groups }) => (
        <section key={kind} className="review-section">
          <h2>{SECTION_TITLE[kind]}</h2>
          {groups.map(([group, list]) => (
            <div key={group}>
              {kind !== "decision" && kind !== "advice" && <h3 className="review-group">{group.replace(/_/g, " ")}</h3>}
              {list.map((it) => (
                <ReviewCard key={it.key} item={it} answer={answers[it.key]} onChange={(patch) => set(it.key, patch)} />
              ))}
            </div>
          ))}
        </section>
      ))}
    </div>
  );
}

function ReviewCard({
  item,
  answer,
  onChange,
}: {
  item: ReviewItem;
  answer: Answers[string] | undefined;
  onChange: (patch: Partial<Answers[string]>) => void;
}) {
  return (
    <article className={`card review-item${answer?.verdict ? ` answered-${answer.verdict}` : ""}`} id={item.key}>
      <div className="row" style={{ justifyContent: "space-between" }}>
        <strong>{item.name}</strong>
        <span className="row small">
          {item.band && <span className={`band-chip band-${item.band}`}>{item.band}</span>}
          {item.method && <span className="muted">{item.method}</span>}
        </span>
      </div>
      <ul className="small review-does">
        {item.does.map((d, i) => (
          <li key={i}>{d}</li>
        ))}
        {item.kind === "rule" && <li>Follow-up: {item.follow_up_days != null ? `${item.follow_up_days} days` : "none"}</li>}
      </ul>
      {item.asha_action && (
        <p className="small">
          <strong>The app tells the ASHA:</strong> {item.asha_action}
        </p>
      )}
      {item.kind !== "decision" && (
        <div className="small">
          <div>
            <strong>Source:</strong> {item.source}, page {item.source_page ?? "none"}
            {item.verified === false && <span className="missing"> · not verified</span>}
          </div>
          {item.quote && <blockquote className="review-quote">“{item.quote}”</blockquote>}
          {!!item.more_quotes?.length && (
            <details>
              <summary>Supporting quotes ({item.more_quotes.length})</summary>
              <ul>
                {item.more_quotes.map((q, i) => (
                  <li key={i}>{q}</li>
                ))}
              </ul>
            </details>
          )}
        </div>
      )}
      {!!item.notes?.length && (
        <ul className="small review-notes">
          {item.notes.map((n, i) => (
            <li key={i}>{n}</li>
          ))}
        </ul>
      )}
      <fieldset className="review-verdict">
        <legend className="small muted">Your answer</legend>
        {VERDICTS.map((v) => (
          <label key={v.value} className="row small">
            <input type="radio" name={item.key} checked={answer?.verdict === v.value} onChange={() => onChange({ verdict: v.value })} />
            {v.label}
          </label>
        ))}
      </fieldset>
      <textarea
        className="review-comment"
        placeholder="Comment (what is wrong, or what should change)"
        value={answer?.comment ?? ""}
        onChange={(e) => onChange({ comment: e.target.value })}
        rows={2}
      />
    </article>
  );
}
