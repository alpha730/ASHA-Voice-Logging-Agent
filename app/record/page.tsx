"use client";

import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ExtractResponse } from "@/app/api/extract/route";
import type { VisitStartResponse } from "@/app/api/visit-start/route";
import type { TriageResponse, TriageState } from "@/app/api/triage/route";
import { MicButton } from "./MicButton";
import { TriageCard } from "./TriageCard";
import type { UiLang } from "@/lib/agent";
import { emptyVisit, missingFields, type ExtractedVisit, type RequiredField } from "@/types/visit";
import type { DueItem, Patient, VisitProtocol } from "@/types/patient";
import { pickVoice, splitBySpeechLang } from "@/lib/speech";
import { createMicController, MIC_MODES, type MicController, type MicMode, type MicState, type Recorder } from "@/lib/holdToTalk";
import { LANG_LABELS, LANGS } from "@/lib/i18n";
import { browserStore, readSetting, SETTING_KEYS, writeSetting } from "@/lib/settings";
import { t } from "@/lib/text";
import { formFromVisit, visitFromForm, type VisitForm } from "@/lib/visitEdit";

type Phase = "idle" | "connecting" | "listening" | "thinking" | "speaking" | "error";
type AgentLine = { text: string; kind: "question" | "summary" | "info" | "warn" };

const SAMPLE_RATE = 16000;
const MAX_QUEUED = 400; // ~20 s of 50 ms frames waiting for the stream to open

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
  // IMNCI sick child assessment, run after the visit is logged.
  const [triage, setTriage] = useState<TriageResponse | null>(null);

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
    childDob: null as string | null, // only from a patient record that existed before this visit
    startedAt: null as string | null, // when this visit began, to tell an old record from one just created
    triage: null as TriageState | null,
    triageStarted: false,
  });
  const ws = useRef<WebSocket | null>(null);
  const sessionLang = useRef<UiLang | null>(null); // the language the open stream was started for
  const sessionPending = useRef<Promise<void> | null>(null);
  const outbox = useRef<(ArrayBuffer | string)[]>([]); // sent in order once the stream opens
  // The microphone, only while the button is held: frames are held back until the press counts.
  const capture = useRef({ token: 0, sending: false, held: [] as ArrayBuffer[], live: null as { stream: MediaStream; node: AudioWorkletNode } | null });
  const audioCtx = useRef<AudioContext | null>(null);
  const workletLoaded = useRef(false);
  const mic = useRef<MicController | null>(null);
  const recorderRef = useRef<Recorder>(null!);
  const [micMode, setMicMode] = useState<MicMode>("hold");
  const [micState, setMicState] = useState<MicState>("idle");
  const [micHint, setMicHint] = useState<"too_short" | null>(null);
  // Hand edits to the structured record.
  const [editing, setEditing] = useState<VisitForm | null>(null);
  const [editErrors, setEditErrors] = useState<string[]>([]);
  const [editSaving, setEditSaving] = useState(false);

  // Settings remembered on this device.
  useEffect(() => {
    const store = browserStore();
    setLang(readSetting(store, SETTING_KEYS.lang, LANGS, "hi"));
    setMicMode(readSetting(store, SETTING_KEYS.micMode, MIC_MODES, "hold"));
  }, []);
  const chooseLang = (next: UiLang) => {
    setLang(next);
    writeSetting(browserStore(), SETTING_KEYS.lang, next);
  };
  const chooseMicMode = (next: MicMode) => {
    setMicMode(next);
    writeSetting(browserStore(), SETTING_KEYS.micMode, next);
  };
  useEffect(() => {
    mic.current?.setMode(micMode);
  }, [micMode]);

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
      // One utterance per script run, so Hindi text gets a Hindi voice and Latin text an
      // English (India) voice. A Hindi voice reading Latin text spells it out letter by letter.
      const chunks = splitBySpeechLang(text);
      if (!chunks.length) return resolve();
      s.current.speaking = true; // mute mic chunks so the agent doesn't transcribe itself
      setPhase((p) => (p === "idle" ? p : "speaking"));
      const done = () => {
        s.current.speaking = false;
        setPhase((p) => (p === "speaking" ? (ws.current ? "listening" : "idle") : p));
        resolve();
      };
      speechSynthesis.cancel();
      chunks.forEach((c, i) => {
        const u = new SpeechSynthesisUtterance(c.text);
        u.lang = c.lang;
        const voice = pickVoice(c.lang);
        if (voice) u.voice = voice;
        u.rate = 1;
        if (i === chunks.length - 1) {
          u.onend = done;
          u.onerror = done;
        }
        speechSynthesis.speak(u);
      });
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
      // A patient registered by this very visit got their date of birth from a model reading of her
      // words; the triage reads the age from those words itself, so only an older record counts.
      const existedBefore = s.current.startedAt != null && data.patient.created_at < s.current.startedAt;
      if (existedBefore) s.current.childDob ??= data.patient.date_of_birth ?? null;
      setPatient(data.patient);
      setPatientKnown(true);
    }
  }, []);

  /** Show and speak one triage step. Inactive means this visit does not enter the IMNCI pathway. */
  const applyTriage = useCallback(
    async (data: TriageResponse) => {
      s.current.triage = data.active ? data.state : null;
      setTriage(data.active ? data : null);
      // Not started (for example a child outside 2 months to 5 years): say why, on screen and aloud.
      if (!data.active && data.say) setAgent((a) => [...a, { text: data.say!, kind: "warn" }]);
      setPhase(ws.current ? "listening" : "idle");
      if (data.question) await speak(data.question);
      else if (data.say) await speak(data.say);
    },
    [speak],
  );

  const triageRequest = useCallback(
    async (body: Record<string, unknown>) => {
      setPhase("thinking");
      try {
        const res = await fetch("/api/triage", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ...body, lang: s.current.lang, visitId: s.current.savedId }),
        });
        const data = (await res.json()) as TriageResponse & { error?: string };
        if (!res.ok) throw new Error(data.error ?? "Assessment failed");
        await applyTriage(data);
      } catch (err) {
        setError((err as Error).message);
        setPhase(ws.current ? "listening" : "idle");
      }
    },
    [applyTriage],
  );

  /** After the visit is logged: a sick child aged 2 months to 5 years enters the IMNCI assessment. */
  const startTriage = useCallback(
    async (v: ExtractedVisit) => {
      if (s.current.triageStarted) return;
      s.current.triageStarted = true;
      await triageRequest({
        action: "start",
        transcript: s.current.turns.join("\n"),
        symptoms: v.symptoms,
        tempC: typeof v.vitals.temp_c === "number" ? v.vitals.temp_c : null,
        dateOfBirth: s.current.childDob,
        today: today(),
      });
    },
    [triageRequest],
  );

  const triageTurn = useCallback(
    (turn: string) => triageRequest({ action: "turn", state: s.current.triage, turn }),
    [triageRequest],
  );

  const handleTurn = useCallback(
    async (text: string, sttLanguage?: string | null) => {
      const turn = text.trim();
      if (!turn) return;
      // While the IMNCI assessment is running, answers go to it and stay out of the visit transcript.
      if (s.current.triage && s.current.triage.stage !== "done") return triageTurn(turn);
      s.current.startedAt ??= new Date().toISOString();
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
        // The model was down and only the rule-based reader ran: say so, so she repeats what was missed.
        if (data.notice) {
          setAgent((a) => [...a, { text: data.notice!, kind: "warn" }]);
          await speak(data.notice);
        }

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
          await startTriage(data.visit);
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
    [save, speak, startTriage, triageTurn],
  );

  // Serialize turns so a fast second utterance never races the first extraction.
  const enqueueTurn = useCallback(
    (text: string, sttLanguage?: string | null) => {
      s.current.queue = s.current.queue.then(() => handleTurn(text, sttLanguage));
    },
    [handleTurn],
  );

  /** Send now if the stream is open, otherwise keep it, in order, for when it opens. */
  const sendOrQueue = useCallback((msg: ArrayBuffer | string) => {
    const socket = ws.current;
    if (socket?.readyState === WebSocket.OPEN) socket.send(msg);
    else if (outbox.current.length < MAX_QUEUED) outbox.current.push(msg);
  }, []);

  /** Release the microphone. Frames still on their way from the worklet are dropped. */
  const stopCapture = useCallback(() => {
    capture.current.token++;
    const c = capture.current.live;
    if (c) {
      c.node.port.onmessage = null;
      c.node.disconnect();
      c.stream.getTracks().forEach((tr) => tr.stop());
    }
    capture.current.live = null;
    capture.current.sending = false;
    capture.current.held = [];
  }, []);

  /** Close the speech-to-text stream only. The next press opens a new one. */
  const closeSocket = useCallback(() => {
    const socket = ws.current;
    ws.current = null;
    outbox.current = [];
    try {
      if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: "Terminate" }));
    } catch {}
    socket?.close();
    setPartial("");
    setPhase("idle");
  }, []);

  /** End any press in progress, release the microphone and close the stream. */
  const closeSession = useCallback(() => {
    mic.current?.stop();
    stopCapture();
    closeSocket();
  }, [closeSocket, stopCapture]);

  /**
   * Open the stream once and keep it for the visit. It carries audio only while the button is held;
   * hold-to-talk uses manual endpointing, so each release ends one utterance.
   */
  const openSession = useCallback(async () => {
    // The language changed since the stream opened (Marwari is transcribed as hi-IN): reopen it,
    // keeping the press in progress and the audio waiting in the outbox.
    if (ws.current) {
      const queued = outbox.current;
      closeSocket();
      outbox.current = queued;
    }
    sessionLang.current = s.current.lang;
    setError(null);
    setPhase("connecting");
    const query = new URLSearchParams({ sample_rate: String(SAMPLE_RATE), lang: s.current.lang, endpointing: "manual" });
    const tokenRes = await fetch(`/api/transcribe?${query}`);
    const { url, error } = await tokenRes.json();
    if (!tokenRes.ok) throw new Error(error ?? "Could not get a transcription token");
    const socket = new WebSocket(url);
    socket.binaryType = "arraybuffer";
    ws.current = socket;
    socket.onopen = () => {
      for (const msg of outbox.current.splice(0)) socket.send(msg);
      setPhase((p) => (p === "connecting" ? "listening" : p));
    };
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
        closeSession();
      }
    };
  }, [closeSession, closeSocket, enqueueTurn]);

  const ensureSession = useCallback((): Promise<void> => {
    const open = ws.current && (ws.current.readyState === WebSocket.OPEN || ws.current.readyState === WebSocket.CONNECTING);
    if (open && sessionLang.current === s.current.lang) return Promise.resolve();
    // A press while the stream is still being set up waits for that one instead of opening another.
    if (sessionPending.current) return sessionPending.current;
    sessionPending.current = openSession().finally(() => {
      sessionPending.current = null;
    });
    return sessionPending.current;
  }, [openSession]);

  /** The microphone side of the mic button. Nothing is captured or sent outside a press. */
  const recorder = useMemo<Recorder>(
    () => ({
      begin() {
        const token = ++capture.current.token;
        capture.current.held = [];
        capture.current.sending = false;
        ensureSession().catch((err) => {
          setError((err as Error).message);
          mic.current?.stop();
        });
        (async () => {
          const ctx = (audioCtx.current ??= new AudioContext());
          await ctx.resume();
          if (!workletLoaded.current) {
            await ctx.audioWorklet.addModule("/pcm-worklet.js");
            workletLoaded.current = true;
          }
          const stream = await navigator.mediaDevices.getUserMedia({
            audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
          });
          // Released (or discarded) while the microphone was starting: let it go at once.
          if (token !== capture.current.token) return stream.getTracks().forEach((tr) => tr.stop());
          const node = new AudioWorkletNode(ctx, "pcm-worklet", { processorOptions: { targetRate: SAMPLE_RATE } });
          ctx.createMediaStreamSource(stream).connect(node);
          node.port.onmessage = (e) => {
            if (s.current.speaking) return; // never send the agent's own voice
            if (capture.current.sending) sendOrQueue(e.data);
            else capture.current.held.push(e.data);
          };
          capture.current.live = { stream, node };
        })().catch((err) => {
          setError((err as Error).message);
          mic.current?.stop();
        });
      },
      open() {
        capture.current.sending = true;
        for (const frame of capture.current.held.splice(0)) sendOrQueue(frame);
      },
      finish() {
        stopCapture();
        // Tells the speech service the utterance is over, so the last words are transcribed now.
        sendOrQueue(JSON.stringify({ type: "ForceEndpoint" }));
      },
      discard() {
        stopCapture();
      },
    }),
    [ensureSession, sendOrQueue, stopCapture],
  );

  if (!mic.current) {
    mic.current = createMicController(
      {
        recorder: { begin: () => recorderRef.current.begin(), open: () => recorderRef.current.open(), finish: () => recorderRef.current.finish(), discard: () => recorderRef.current.discard() },
        agentSpeaking: () => s.current.speaking,
        cancelSpeech: () => {
          speechSynthesis?.cancel();
          s.current.speaking = false;
          setPhase((p) => (p === "speaking" ? "listening" : p));
        },
        setTimer: (fn, ms) => window.setTimeout(fn, ms),
        clearTimer: (h) => window.clearTimeout(h as number),
        onState: setMicState,
        onHint: setMicHint,
      },
      "hold",
    );
  }
  recorderRef.current = recorder;

  useEffect(
    () => () => {
      closeSession();
      audioCtx.current?.close();
    },
    [closeSession],
  );

  const reset = () => {
    closeSession();
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
      childDob: null,
      startedAt: null,
      triage: null,
      triageStarted: false,
    };
    setTriage(null);
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
      s.current.childDob = data.patient?.date_of_birth ?? null; // found on the register: a real record
      s.current.startedAt ??= new Date().toISOString();
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

  /** Apply the edited record. A visit already saved is updated in place, the same way the agent saves it. */
  const saveEdit = async () => {
    if (!editing) return;
    const { visit: next, errors } = visitFromForm(editing, s.current.visit);
    setEditErrors(errors);
    if (errors.length) return;
    if (s.current.savedId) {
      setEditSaving(true);
      try {
        await save(next);
      } catch (err) {
        setEditErrors([`Not saved: ${(err as Error).message}`]);
        return;
      } finally {
        setEditSaving(false);
      }
    }
    s.current.visit = next;
    setVisit(next);
    setReopened(null);
    setEditing(null);
  };
  const setField = (key: keyof VisitForm) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setEditing((f) => (f ? { ...f, [key]: e.target.value } : f));

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
          <p className="muted small">{t("ui.hint.correction", lang)}</p>
        </div>
        <div className="row">
          <span className="small muted">Agent speaks</span>
          <div className="toggle" role="group" aria-label="Agent language">
            {LANGS.map((l) => (
              <button key={l} className={lang === l ? "on" : ""} aria-pressed={lang === l} onClick={() => chooseLang(l)}>
                {LANG_LABELS[l]}
              </button>
            ))}
          </div>
          {detected && <span className="badge lang">Detected: {detected}</span>}
        </div>
      </div>

      <div className="row">
        {mic.current && <MicButton mic={mic.current} mode={micMode} state={micState} lang={lang} hint={micHint} />}
        <button onClick={reset}>New visit</button>
        <label className="row small muted">
          Mic
          <select value={micMode} onChange={(e) => chooseMicMode(e.target.value as MicMode)}>
            <option value="hold">Hold to talk</option>
            <option value="tap">Tap to start and stop</option>
          </select>
        </label>
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
          <div className="row" style={{ justifyContent: "space-between" }}>
            <h2 style={{ margin: 0 }}>Structured record</h2>
            {!editing && (
              <button
                onClick={() => {
                  setEditErrors([]);
                  setEditing(formFromVisit(s.current.visit));
                }}
              >
                Edit
              </button>
            )}
          </div>
          {editing ? (
            <form
              className="record-edit"
              onSubmit={(e) => {
                e.preventDefault();
                saveEdit();
              }}
            >
              <dl className="fields">
                <dt><label htmlFor="ed-worker">{FIELD_LABELS.worker_name}</label></dt>
                <dd><input id="ed-worker" type="text" value={editing.worker_name} onChange={setField("worker_name")} /></dd>
                <dt><label htmlFor="ed-household">{FIELD_LABELS.household_id}</label></dt>
                <dd><input id="ed-household" type="text" value={editing.household_id} onChange={setField("household_id")} /></dd>
                <dt><label htmlFor="ed-patient">Patient</label></dt>
                <dd><input id="ed-patient" type="text" value={editing.patient_name} onChange={setField("patient_name")} /></dd>
                <dt><label htmlFor="ed-date">Visit date</label></dt>
                <dd><input id="ed-date" type="date" value={editing.visit_date} onChange={setField("visit_date")} /></dd>
                <dt><label htmlFor="ed-symptoms">Symptoms</label></dt>
                <dd><input id="ed-symptoms" type="text" value={editing.symptoms} onChange={setField("symptoms")} placeholder="fever, cough" /></dd>
                <dt>Vitals</dt>
                <dd className="record-edit-vitals">
                  <label>Temp °C <input type="text" inputMode="decimal" value={editing.temp_c} onChange={setField("temp_c")} /></label>
                  <label>BP <input type="text" value={editing.bp} onChange={setField("bp")} placeholder="120/80" /></label>
                  <label>Pulse <input type="text" inputMode="numeric" value={editing.pulse} onChange={setField("pulse")} /></label>
                  <label>Weight kg <input type="text" inputMode="decimal" value={editing.weight_kg} onChange={setField("weight_kg")} /></label>
                  <label>SpO2 % <input type="text" inputMode="numeric" value={editing.spo2} onChange={setField("spo2")} /></label>
                </dd>
                <dt><label htmlFor="ed-vacc">Vaccination</label></dt>
                <dd><input id="ed-vacc" type="text" value={editing.vaccination_status} onChange={setField("vaccination_status")} /></dd>
                <dt><label htmlFor="ed-followup">{FIELD_LABELS.follow_up_date}</label></dt>
                <dd><input id="ed-followup" type="date" value={editing.follow_up_date} onChange={setField("follow_up_date")} /></dd>
              </dl>
              {editErrors.length > 0 && (
                <ul className="small missing" role="alert">
                  {editErrors.map((err) => (
                    <li key={err}>{err}</li>
                  ))}
                </ul>
              )}
              <div className="row">
                <button type="submit" className="primary" disabled={editSaving}>
                  {editSaving ? "Saving…" : "Save changes"}
                </button>
                <button type="button" onClick={() => setEditing(null)} disabled={editSaving}>
                  Cancel
                </button>
                <span className="small muted">{savedId ? "Updates the saved visit." : "Updates the record in progress."}</span>
              </div>
            </form>
          ) : (
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
          )}
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

      {triage && <TriageCard triage={triage} onEnd={() => enqueueTurn("stop")} lang={lang} onSpeak={speak} />}
    </div>
  );
}
