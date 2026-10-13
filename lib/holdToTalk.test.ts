import { test } from "node:test";
import assert from "node:assert/strict";
import { createMicController, MIN_PRESS_MS, type MicMode } from "./holdToTalk.ts";

/** A mocked recorder and clock: every call is logged, and timers fire only when the test says so. */
function setup(mode: MicMode = "hold", speaking = false) {
  const calls: string[] = [];
  const timers = new Map<number, { fn: () => void; ms: number }>();
  let nextId = 1;
  let agentSpeaking = speaking;
  const hints: (string | null)[] = [];
  const mic = createMicController(
    {
      recorder: {
        begin: () => calls.push("begin"),
        open: () => calls.push("open"),
        finish: () => calls.push("finish (end-of-speech)"),
        discard: () => calls.push("discard"),
      },
      agentSpeaking: () => agentSpeaking,
      cancelSpeech: () => {
        calls.push("cancelSpeech");
        agentSpeaking = false;
      },
      setTimer: (fn, ms) => {
        const id = nextId++;
        timers.set(id, { fn, ms });
        return id;
      },
      clearTimer: (id) => void timers.delete(id as number),
      onHint: (h) => hints.push(h),
    },
    mode,
  );
  /** Time passes past the minimum press. */
  const hold = () => {
    for (const [id, t] of [...timers]) {
      assert.equal(t.ms, MIN_PRESS_MS);
      timers.delete(id);
      t.fn();
    }
  };
  return { mic, calls, hold, hints, timers };
}

test("a press shorter than 300 ms is ignored: nothing is sent, and the hint is shown", () => {
  const { mic, calls, hints } = setup();
  mic.press();
  assert.equal(mic.state, "pressed");
  mic.release(); // before the timer fires
  assert.deepEqual(calls, ["begin", "discard"]);
  assert.equal(calls.includes("open"), false, "never sent");
  assert.equal(mic.state, "idle");
  assert.equal(hints.at(-1), "too_short");
});

test("hold: audio is sent only after 300 ms, and release stops it with the end-of-speech signal", () => {
  const { mic, calls, hold } = setup();
  mic.press();
  assert.deepEqual(calls, ["begin"]);
  hold();
  assert.equal(mic.state, "recording");
  assert.deepEqual(calls, ["begin", "open"]);
  mic.release();
  assert.deepEqual(calls, ["begin", "open", "finish (end-of-speech)"]);
  assert.equal(mic.state, "idle");
  mic.release(); // a stray pointerup after the fact does nothing
  assert.equal(calls.filter((c) => c.startsWith("finish")).length, 1);
});

test("pointercancel and pointerleave stop a hold, the same as release", () => {
  const long = setup();
  long.mic.press();
  long.hold();
  long.mic.cancel();
  assert.deepEqual(long.calls, ["begin", "open", "finish (end-of-speech)"]);
  const short = setup();
  short.mic.press();
  short.mic.cancel();
  assert.deepEqual(short.calls, ["begin", "discard"]);
  assert.equal(short.timers.size, 0, "the 300 ms timer is cleared");
});

test("a second press while held is ignored (another finger, or a repeating key)", () => {
  const { mic, calls, hold } = setup();
  mic.press();
  mic.press();
  hold();
  mic.press();
  assert.deepEqual(calls, ["begin", "open"]);
});

test("pressing while the agent is speaking stops the speech, then records", () => {
  const { mic, calls } = setup("hold", true);
  mic.press();
  assert.deepEqual(calls, ["cancelSpeech", "begin"]);
});

test("tap mode toggles: one press starts at once, the next press stops; release does nothing", () => {
  const { mic, calls, timers } = setup("tap");
  mic.press();
  assert.equal(mic.state, "recording");
  assert.deepEqual(calls, ["begin", "open"]);
  assert.equal(timers.size, 0, "no 300 ms wait in tap mode");
  mic.release();
  mic.cancel();
  assert.equal(mic.state, "recording", "lifting the finger or leaving the button does not stop it");
  mic.press();
  assert.deepEqual(calls, ["begin", "open", "finish (end-of-speech)"]);
  assert.equal(mic.state, "idle");
});

test("switching mode, or stopping, ends a recording properly", () => {
  const { mic, calls, hold } = setup();
  mic.press();
  hold();
  mic.setMode("tap");
  assert.deepEqual(calls, ["begin", "open", "finish (end-of-speech)"]);
  assert.equal(mic.mode, "tap");
  mic.press();
  mic.stop();
  assert.deepEqual(calls.slice(-3), ["begin", "open", "finish (end-of-speech)"]);
  assert.equal(mic.state, "idle");
});
