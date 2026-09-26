"use client";

import { Fragment, useCallback, useEffect, useRef, useState } from "react";
import type { ExtractResponse } from "@/app/api/extract/route";
import type { VisitStartResponse } from "@/app/api/visit-start/route";
import type { UiLang } from "@/lib/agent";
import { emptyVisit, missingFields, type ExtractedVisit, type RequiredField } from "@/types/visit";
import type { DueItem, Patient, VisitProtocol } from "@/types/patient";

type Phase = "idle" | "connecting" | "listening" | "thinking" | "speaking" | "error";
type AgentLine = { text: string; kind: "question" | "summary" | "info" | "warn" };

const SAMPLE_RATE = 16000;

const FIELD_LABELS: Record<RequiredField, string> = {
  worker_name: "Worker",
  household_id: "Household ID",
  health_findings: "Symptoms / vitals",
  follow_up_date: "Follow-up date",
};

function detectLanguage(text: string, fromStt?: string | null): string {
  if (fromStt) return fromStt;
  const devanagari = /[ऀ-ॿ]/.test(text);
  const hinglish = /\b(hai|nahi|mera|aaj|ghar|bukhar|khansi|din|baad|kal|kya|aur|ko|ka|ki)\b/i.test(text);
  const english = /\b(the|is|and|fever|temperature|follow|visit|household|days)\b/i.test(text);
  if ((devanagari || hinglish) && english) return "hi-en";
  if (devanagari || hinglish) return "hi";
  return "en";
}

function today() {
  const d = new Date();
  return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
}

export default function RecordPage() {
  const [phase, setPhase] = useState<Phase>("idle");
  const [lang, setLang] = useState<UiLang>("hi");
  const [workerId, setWorkerId] = useState("");
  const [turns, setTurns] = useState<string[]>([]);
  const [partial, setPartial] = useState("");
  const [visit, setVisit] = useState<ExtractedVisit>(emptyVisit());
  const [agent, setAgent] = useState<AgentLine[]>([]);
  const [reopened, setReopened] = useState<RequiredField | null>(null);
  const [detected, setDetected] = useState<string | null>(null);
  const [savedId, setSavedId] = useState<string | null>(null);
  const [typed, setTyped] = useState("");
  const [error, setError] = useState<string | null>(null);
  // Phase 5: patient record, due items, and the protocol driving the questions.
  const [lookupName, setLookupName] = useState("");
  const [patient, setPatient] = useState<Patient | null>(null);
  const [patientKnown, setPatientKnown] = useState<boolean | null>(null);
  const [due, setDue] = useState<DueItem[]>([]);
  const [protocol, setProtocol] = useState<{ id: VisitProtocol; label: string } | null>(null);
  const [protocolData, setProtocolData] = useState<Record<string, unknown>>({});

  // Refs mirror state that async callbacks (WebSocket, TTS) need without stale closures.
  const s = useRef({
    visit: emptyVisit(),
    expecting: null as RequiredField | null,
    lastFilled: null as RequiredField | null,
    turns: [] as string[],
    savedId: null as string | null,
    speaking: false,
    lang: "hi" as UiLang,
    detected: null as string | null,
    workerId: "",
    queue: Promise.resolve(),
    protocol: null as VisitProtocol | null,
    protocolData: {} as Record<string, unknown>,
    protocolExpecting: null as string | null,
    patientId: null as string | null,
  });
  const ws = useRef<WebSocket | null>(null);
  const audio = useRef<{ ctx: AudioContext; stream: MediaStream; node: AudioWorkletNode } | null>(null);

  useEffect(() => {
    s.current.lang = lang;
  }, [lang]);
  useEffect(() => {
    s.current.workerId = workerId;
    try {
      if (workerId) localStorage.setItem("asha.workerId", workerId);
    } catch {}
  }, [workerId]);
  useEffect(() => {
    try {
      setWorkerId(localStorage.getItem("asha.workerId") ?? "");
    } catch {}
  }, []);

  const speak = useCallback((text: string) => {
    return new Promise<void>((resolve) => {
      if (typeof window === "undefined" || !("speechSynthesis" in window)) return resolve();
      const u = new SpeechSynthesisUtterance(text);
      u.lang = s.current.lang === "hi" ? "hi-IN" : "en-IN";
      const voice = speechSynthesis.getVoices().find((v) => v.lang === u.lang);
      if (voice) u.voice = voice;
      u.rate = 1;
      s.current.speaking = true; // mute mic chunks so the agent doesn't transcribe itself
      setPhase((p) => (p === "idle" ? p : "speaking"));
      const done = () => {
        s.current.speaking = false;
        setPhase((p) => (p === "speaking" ? (ws.current ? "listening" : "idle") : p));
        resolve();
      };
      u.onend = done;
      u.onerror = done;
      speechSynthesis.cancel();
      speechSynthesis.speak(u);
    });
  }, []);

  const save = useCallback(async (v: ExtractedVisit) => {
    const payload = {
      visit: v,
      worker_id: s.current.workerId || null,
      language: s.current.detected,
      raw_transcript: s.current.turns.join("\n"),
    };
    const id = s.current.savedId;
    const res = await fetch(id ? `/api/visits/${id}` : "/api/visits", {
      method: id ? "PATCH" : "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error ?? "Save failed");
    s.current.savedId = data.visit.id;
    setSavedId(data.visit.id);
    if (data.patient) {
      s.current.patientId = data.patient.id;
      setPatient(data.patient);
      setPatientKnown(true);
    }
  }, []);

  const handleTurn = useCallback(
    async (text: string, sttLanguage?: string | null) => {
      const turn = text.trim();
      if (!turn) return;
      s.current.turns = [...s.current.turns, turn];
      setTurns(s.current.turns);
      const lang = detectLanguage(s.current.turns.join(" "), sttLanguage);
      s.current.detected = lang;
      setDetected(lang);

      setPhase("thinking");
      try {
        const res = await fetch("/api/extract", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            turn,
            current: s.current.visit,
            expecting: s.current.expecting,
            lastFilled: s.current.lastFilled,
            lang: s.current.lang,
            today: today(),
            protocol: s.current.protocol,
            protocolData: s.current.protocolData,
            protocolExpecting: s.current.protocolExpecting,
            patientId: s.current.patientId,
          }),
        });
        const data = (await res.json()) as ExtractResponse & { error?: string };
        if (!res.ok) throw new Error(data.error ?? "Extraction failed");
        console.log("[extraction]", data);

        s.current.visit = data.visit;
        s.current.expecting = data.expecting;
        s.current.lastFilled = data.lastFilled;
        s.current.protocol = data.protocol;
        s.current.protocolData = data.protocolData;
        s.current.protocolExpecting = data.protocolExpecting;
        setVisit(data.visit);
        setReopened(data.reopened);
        setProtocolData(data.protocolData);
        if (data.protocol && data.protocolLabel) setProtocol({ id: data.protocol, label: data.protocolLabel });

        if (data.complete && data.summary) {
          await save(data.visit);
          setAgent((a) => [...a, { text: data.summary!, kind: "summary" }]);
          setPhase(ws.current ? "listening" : "idle");
          await speak(data.summary);
        } else if (data.question) {
          setAgent((a) => [...a, { text: data.question!, kind: data.reopened ? "warn" : "question" }]);
          setPhase(ws.current ? "listening" : "idle");
          await speak(data.question);
        } else {
          setPhase(ws.current ? "listening" : "idle");
        }
      } catch (err) {
        setError((err as Error).message);
        setPhase(ws.current ? "listening" : "idle");
      }
    },
    [save, speak],
  );

  // Serialize turns so a fast second utterance never races the first extraction.
  const enqueueTurn = useCallback(
    (text: string, sttLanguage?: string | null) => {
      s.current.queue = s.current.queue.then(() => handleTurn(text, sttLanguage));
    },
    [handleTurn],
  );

  const stop = useCallback(() => {
    try {
      if (ws.current?.readyState === WebSocket.OPEN) ws.current.send(JSON.stringify({ type: "Terminate" }));
    } catch {}
    ws.current?.close();
    ws.current = null;
    if (audio.current) {
      audio.current.node.disconnect();
      audio.current.stream.getTracks().forEach((t) => t.stop());
      audio.current.ctx.close();
      audio.current = null;
    }
    setPartial("");
    setPhase("idle");
  }, []);

  const start = useCallback(async () => {
    setError(null);
    setPhase("connecting");
    try {
      const tokenRes = await fetch(`/api/transcribe?sample_rate=${SAMPLE_RATE}`);
      const { url, error } = await tokenRes.json();
      if (!tokenRes.ok) throw new Error(error ?? "Could not get a transcription token");

      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
      const ctx = new AudioContext();
      await ctx.audioWorklet.addModule("/pcm-worklet.js");
      const source = ctx.createMediaStreamSource(stream);
      const node = new AudioWorkletNode(ctx, "pcm-worklet", { processorOptions: { targetRate: SAMPLE_RATE } });
      source.connect(node);
      audio.current = { ctx, stream, node };

      const socket = new WebSocket(url);
      socket.binaryType = "arraybuffer";
      ws.current = socket;
      node.port.onmessage = (e) => {
        if (socket.readyState === WebSocket.OPEN && !s.current.speaking) socket.send(e.data);
      };
      socket.onopen = () => setPhase("listening");
      socket.onmessage = (e) => {
        const msg = JSON.parse(e.data);
        if (msg.type === "Turn") {
          if (msg.end_of_turn && msg.turn_is_formatted) {
            setPartial("");
            enqueueTurn(msg.transcript, msg.language_code ?? null);
          } else if (!msg.end_of_turn) {
            setPartial(msg.transcript ?? "");
          }
        } else if (msg.type === "Error" || msg.error) {
          setError(msg.error ?? JSON.stringify(msg));
        }
      };
      socket.onerror = () => setError("Streaming connection error");
      socket.onclose = (e) => {
        if (ws.current === socket) {
          if (e.code !== 1000 && e.reason) setError(`Stream closed: ${e.reason}`);
          stop();
        }
      };
    } catch (err) {
      setError((err as Error).message);
      stop();
      setPhase("error");
    }
  }, [enqueueTurn, stop]);

  useEffect(() => stop, [stop]);

  const reset = () => {
    stop();
    speechSynthesis?.cancel();
    s.current = {
      ...s.current,
      visit: emptyVisit(),
      expecting: null,
      lastFilled: null,
      turns: [],
      savedId: null,
      detected: null,
      protocol: null,
      protocolData: {},
      protocolExpecting: null,
      patientId: null,
    };
    setProtocol(null);
    setProtocolData({});
    setPatient(null);
    setPatientKnown(null);
    setDue([]);
    setTurns([]);
    setVisit(emptyVisit());
    setAgent([]);
    setReopened(null);
    setDetected(null);
    setSavedId(null);
    setError(null);
  };

  /** Step 4 of the planner's due-date engine: tell the worker what is due BEFORE they talk. */
  const lookupPatient = async () => {
    const name = lookupName.trim();
    if (!name) return;
    setError(null);
    try {
      const res = await fetch("/api/visit-start", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, household_id: s.current.visit.household_id, lang: s.current.lang, today: today() }),
      });
      const data = (await res.json()) as VisitStartResponse & { error?: string };
      if (!res.ok) throw new Error(data.error ?? "Lookup failed");
      setPatient(data.patient);
      setPatientKnown(data.known);
      setDue(data.due);
      s.current.patientId = data.patient?.id ?? null;
      if (data.say) {
        setAgent((a) => [...a, { text: data.say!, kind: "info" }]);
        await speak(data.say);
      } else if (!data.known) {
        setAgent((a) => [...a, { text: `${name} is not registered yet. Registering from this visit.`, kind: "info" }]);
      }
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const submitTyped = () => {
    if (!typed.trim()) return;
    enqueueTurn(typed);
    setTyped("");
  };

  const live = phase === "listening" || phase === "thinking" || phase === "speaking";
  const missing = new Set(missingFields(visit));
  const show = (field: RequiredField, value: React.ReactNode) =>
    missing.has(field) ? <span className="missing">not captured yet</span> : (
      <span className={reopened === field ? "reopened" : undefined}>{value}</span>
    );
  const vitals = Object.entries(visit.vitals).filter(([, v]) => v != null);

  return (
    <div className="stack">
      <div className="row" style={{ justifyContent: "space-between" }}>
        <div>
          <h1>Record a home visit</h1>
          <p className="muted small">Speak naturally in Hindi, English, or both. Say “that’s wrong” / “galat hai” to fix the last answer.</p>
        </div>
        <div className="row">
          <span className="small muted">Agent speaks</span>
          <div className="toggle" role="group" aria-label="Agent language">
            <button className={lang === "hi" ? "on" : ""} onClick={() => setLang("hi")}>हिन्दी</button>
            <button className={lang === "en" ? "on" : ""} onClick={() => setLang("en")}>English</button>
          </div>
          {detected && <span className="badge lang">Detected: {detected}</span>}
        </div>
      </div>

      <div className="row">
        {!live ? (
          <button className="primary big" onClick={start} disabled={phase === "connecting"}>
            {phase === "connecting" ? "Connecting…" : turns.length ? "Continue visit" : "Start visit"}
          </button>
        ) : (
          <button className="danger big" onClick={stop}>Stop</button>
        )}
        <button onClick={reset}>New visit</button>
        <label className="row small muted">
          Worker ID
          <input type="text" value={workerId} onChange={(e) => setWorkerId(e.target.value)} style={{ width: 120 }} placeholder="ASHA-017" />
        </label>
        {live && (
          <span className="row small">
            <span className="pulse" /> {phase}
          </span>
        )}
        {savedId && <span className="badge complete">Saved to dashboard</span>}
      </div>

      {error && <div className="agent-msg warn">⚠ {error}</div>}

      <section className="card">
        <div className="row" style={{ justifyContent: "space-between" }}>
          <h2 style={{ margin: 0 }}>Who are you visiting?</h2>
          {protocol && <span className="badge lang">Protocol: {protocol.label}</span>}
        </div>
        <div className="row" style={{ marginTop: 10 }}>
          <input
            type="text"
            value={lookupName}
            onChange={(e) => setLookupName(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && lookupPatient()}
            placeholder="Patient name, e.g. Priya"
            style={{ flex: 1, minWidth: 180 }}
          />
          <button className="primary" onClick={lookupPatient}>Check what is due</button>
          {patientKnown === false && <span className="badge needs_follow_up">New patient</span>}
          {patient && (
            <span className="small muted">
              {patient.date_of_birth && `DOB ${patient.date_of_birth}${patient.dob_is_approximate ? " (approx)" : ""}`}
              {patient.expected_delivery_date && ` · EDD ${patient.expected_delivery_date}`}
            </span>
          )}
        </div>
        {due.length > 0 && (
          <ul className="due-list">
            {due.map((d) => (
              <li key={d.label + d.due_date}>
                <span className={`badge ${d.status === "overdue" ? "flagged_for_review" : d.status === "due" ? "needs_follow_up" : "complete"}`}>
                  {d.status}
                </span>{" "}
                {d.label} · {d.due_date}
                {d.status === "overdue" && <span className="muted small"> ({Math.abs(d.days)} days late)</span>}
                {d.note && <span className="muted small"> — {d.note}</span>}
              </li>
            ))}
          </ul>
        )}
      </section>

      <div className="grid">
        <section className="card">
          <h2>Live transcript</h2>
          <div className="transcript">
            {turns.map((t, i) => (
              <div key={i}>{t}</div>
            ))}
            {partial && <div className="partial">{partial}</div>}
            {!turns.length && !partial && <span className="muted">Your words will appear here as you speak.</span>}
          </div>
          {agent.map((a, i) => (
            <div key={i} className={`agent-msg ${a.kind === "warn" ? "warn" : ""}`}>
              🗣 {a.text}
            </div>
          ))}
          <div className="row" style={{ marginTop: 12 }}>
            <input
              type="text"
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && submitTyped()}
              placeholder="No mic? Type an utterance and press Enter"
              style={{ flex: 1 }}
            />
            <button onClick={submitTyped}>Send</button>
          </div>
        </section>

        <section className="card">
          <h2>Structured record</h2>
          <dl className="fields">
            <dt>{FIELD_LABELS.worker_name}</dt>
            <dd>{show("worker_name", visit.worker_name)}</dd>
            <dt>{FIELD_LABELS.household_id}</dt>
            <dd>{show("household_id", visit.household_id)}</dd>
            <dt>Patient</dt>
            <dd>{visit.patient_name ?? <span className="muted">—</span>}</dd>
            <dt>Visit date</dt>
            <dd>{visit.visit_date ?? today()}</dd>
            <dt>Symptoms</dt>
            <dd>{show("health_findings", visit.symptoms.join(", ") || "—")}</dd>
            <dt>Vitals</dt>
            <dd>{show("health_findings", vitals.map(([k, v]) => `${k}: ${v}`).join(", ") || "—")}</dd>
            <dt>Vaccination</dt>
            <dd>{visit.vaccination_status ?? <span className="muted">—</span>}</dd>
            <dt>{FIELD_LABELS.follow_up_date}</dt>
            <dd>{show("follow_up_date", visit.follow_up_date)}</dd>
          </dl>
          {protocol && Object.keys(protocolData).length > 0 && (
            <>
              <h2 style={{ marginTop: 18 }}>{protocol.label} fields</h2>
              <dl className="fields">
                {Object.entries(protocolData).map(([k, v]) => (
                  <Fragment key={k}>
                    <dt>{k.replace(/_/g, " ")}</dt>
                    <dd>{Array.isArray(v) ? v.join(", ") || "none" : String(v)}</dd>
                  </Fragment>
                ))}
              </dl>
            </>
          )}
        </section>
      </div>
    </div>
  );
}
