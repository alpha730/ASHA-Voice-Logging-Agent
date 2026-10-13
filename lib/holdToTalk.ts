/**
 * The mic button's logic, separate from the DOM so it can be tested with a mocked recorder.
 *
 * Hold mode (default): pressing starts capturing, releasing ends the utterance. Audio is captured
 * locally from the press but only sent once the press has lasted MIN_PRESS_MS; a shorter press is
 * dropped without anything being sent. Release, pointer cancel and pointer leave all end it.
 * Tap mode: one press starts, the next press stops.
 * Pressing while the agent is speaking stops the speech and starts recording.
 */

export type MicMode = "hold" | "tap";
export type MicState = "idle" | "pressed" | "recording";
export const MIC_MODES: MicMode[] = ["hold", "tap"];
export const MIN_PRESS_MS = 300;

export interface Recorder {
  begin(): void; // start capturing locally; nothing is sent yet
  open(): void; // start sending: what was captured since begin, then live audio
  finish(): void; // stop capturing, send the rest, then the end-of-speech signal
  discard(): void; // stop capturing and drop it all; nothing is sent
}

export interface MicDeps {
  recorder: Recorder;
  agentSpeaking(): boolean;
  cancelSpeech(): void;
  setTimer(fn: () => void, ms: number): unknown;
  clearTimer(handle: unknown): void;
  onState?(state: MicState): void;
  onHint?(hint: "too_short" | null): void;
}

export function createMicController(deps: MicDeps, initialMode: MicMode = "hold") {
  let mode: MicMode = initialMode;
  let state: MicState = "idle";
  let timer: unknown = null;

  const set = (s: MicState) => {
    state = s;
    deps.onState?.(s);
  };
  const startCapture = () => {
    // The agent never talks over her: speaking stops when she presses.
    if (deps.agentSpeaking()) deps.cancelSpeech();
    deps.onHint?.(null);
    deps.recorder.begin();
  };
  const end = () => {
    if (timer != null) deps.clearTimer(timer);
    timer = null;
    if (state === "pressed") {
      deps.recorder.discard();
      deps.onHint?.("too_short");
    } else if (state === "recording") {
      deps.recorder.finish();
    }
    if (state !== "idle") set("idle");
  };

  return {
    get mode() {
      return mode;
    },
    get state() {
      return state;
    },
    press() {
      if (mode === "tap") {
        if (state === "idle") {
          startCapture();
          deps.recorder.open();
          set("recording");
        } else end();
        return;
      }
      if (state !== "idle") return; // a second pointer or a repeated key
      startCapture();
      set("pressed");
      timer = deps.setTimer(() => {
        timer = null;
        if (state !== "pressed") return;
        set("recording");
        deps.recorder.open();
      }, MIN_PRESS_MS);
    },
    /** pointerup, or the spacebar coming up. */
    release() {
      if (mode === "hold") end();
    },
    /** pointercancel or pointerleave: in hold mode the press is over. */
    cancel() {
      if (mode === "hold") end();
    },
    /** Stop whatever is in progress (a session closing, the page going away). */
    stop() {
      end();
    },
    setMode(next: MicMode) {
      if (next === mode) return;
      end();
      mode = next;
    },
  };
}

export type MicController = ReturnType<typeof createMicController>;
