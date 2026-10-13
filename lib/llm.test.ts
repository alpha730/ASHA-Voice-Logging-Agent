import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { backoffMs, completeJson, isLlmUnavailable, llmTargets, LlmUnavailableError, MAX_ATTEMPTS, runtime } from "./llm.ts";
import { extractSigns } from "./imnci/extract.ts";
import { buildSteps, modelBusyRepeat } from "./imnci/flow.ts";
import type { ImnciProtocol } from "./imnci/rules.ts";

const KEY = "sk-test-SECRET-KEY-123";
const FALLBACK_KEY = "fb-test-SECRET-KEY-456";
const TRANSCRIPT = "Sunita ki beti Pooja PRIVATE-TRANSCRIPT-MARKER teen saal ki hai";

const PRIMARY = { LLM_API_KEY: KEY, LLM_MODEL: "model-a", LLM_BASE_URL: "https://primary.example/v1" };
const WITH_FALLBACK = { ...PRIMARY, LLM_FALLBACK_MODEL: "model-b", LLM_FALLBACK_BASE_URL: "https://fallback.example/v1", LLM_FALLBACK_API_KEY: FALLBACK_KEY };

const original = { ...runtime };
let calls: { url: string; init: RequestInit }[] = [];
let waits: number[] = [];

/** A provider that answers each request with the next status (or "timeout"), then 200 with `content`. */
function mockModel(plan: Record<string, (number | "timeout")[]>, content = '{"unable_to_drink": true}') {
  const queues = Object.fromEntries(Object.entries(plan).map(([host, q]) => [host, [...q]]));
  runtime.fetch = async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    const host = new URL(url).host;
    const next = queues[host]?.shift();
    if (next === "timeout") throw Object.assign(new Error("aborted"), { name: "AbortError" });
    if (next != null) {
      return new Response(`{"error":"over capacity","echo":${JSON.stringify(TRANSCRIPT)}}`, { status: next });
    }
    return new Response(JSON.stringify({ choices: [{ message: { content } }] }), { status: 200 });
  };
}

beforeEach(() => {
  calls = [];
  waits = [];
  runtime.sleep = async (ms: number) => void waits.push(ms);
  runtime.random = () => 0.5;
});
afterEach(() => Object.assign(runtime, original));

const req = { system: "system prompt", user: TRANSCRIPT };
const hosts = () => calls.map((c) => new URL(c.url).host);

test("503 is retried up to 3 attempts with exponential backoff and jitter, then fails cleanly", async () => {
  mockModel({ "primary.example": [503, 503, 503] });
  await assert.rejects(completeJson(req, PRIMARY), LlmUnavailableError);
  assert.equal(calls.length, MAX_ATTEMPTS);
  // Base 500 ms, doubling, jitter between half and full: with random() = 0.5 that is 3/4 of each step.
  assert.deepEqual(waits, [375, 750]);
});

test("a transient failure that recovers returns the answer", async () => {
  mockModel({ "primary.example": [503, 429] });
  assert.equal(await completeJson(req, PRIMARY), '{"unable_to_drink": true}');
  assert.equal(calls.length, 3);
});

test("429, 500, 502, 503 and timeouts are retried; other statuses are not", async () => {
  for (const status of [429, 500, 502, 503, "timeout"] as const) {
    calls = [];
    mockModel({ "primary.example": [status] });
    await completeJson(req, PRIMARY);
    assert.equal(calls.length, 2, `retried ${status}`);
  }
  for (const status of [400, 401, 403, 404, 422, 504]) {
    calls = [];
    mockModel({ "primary.example": [status, status, status] });
    await assert.rejects(completeJson(req, PRIMARY), LlmUnavailableError);
    assert.equal(calls.length, 1, `not retried ${status}`);
  }
});

test("jitter stays between half and the full exponential delay, and is capped", () => {
  runtime.random = () => 0;
  assert.equal(backoffMs(0), 250);
  runtime.random = () => 0.999999;
  assert.ok(backoffMs(1) <= 1000 && backoffMs(1) > 999);
  assert.ok(backoffMs(10) <= runtime.maxDelayMs);
});

test("after the primary fails, a configured fallback provider is used", async () => {
  mockModel({ "primary.example": [503, 503, 503] });
  assert.equal(await completeJson(req, WITH_FALLBACK), '{"unable_to_drink": true}');
  assert.deepEqual(hosts(), ["primary.example", "primary.example", "primary.example", "fallback.example"]);
  const auth = new Headers(calls[3].init.headers).get("authorization");
  assert.equal(auth, `Bearer ${FALLBACK_KEY}`);
});

test("primary and fallback both down: LlmUnavailableError naming both, after 3 attempts each", async () => {
  mockModel({ "primary.example": [503, 503, 503], "fallback.example": ["timeout", "timeout", "timeout"] });
  const err = await completeJson(req, WITH_FALLBACK).catch((e) => e);
  assert.ok(isLlmUnavailable(err));
  assert.equal(calls.length, 6);
  assert.match(err.message, /primary \(primary\.example, model-a\) failed: HTTP 503 after 3 attempts/);
  assert.match(err.message, /fallback \(fallback\.example, model-b\) failed: timeout after 3 attempts/);
});

test("errors never contain the API keys, the transcript or the provider's response body", async () => {
  mockModel({ "primary.example": [503, 503, 503], "fallback.example": [401] });
  const err = await completeJson(req, WITH_FALLBACK).catch((e) => e);
  const text = `${err.message} ${err.stack} ${JSON.stringify(err)}`;
  for (const secret of [KEY, FALLBACK_KEY, "PRIVATE-TRANSCRIPT-MARKER", "over capacity"]) {
    assert.equal(text.includes(secret), false, `leaked ${secret}`);
  }
});

test("fallback configuration: same provider may reuse the key, another provider needs its own", () => {
  assert.equal(llmTargets({}).length, 0);
  assert.equal(llmTargets({ LLM_API_KEY: KEY }).length, 0);
  assert.deepEqual(llmTargets(PRIMARY).map((t) => t.label), ["primary"]);
  const sameProvider = llmTargets({ ...PRIMARY, LLM_FALLBACK_MODEL: "model-b" });
  assert.deepEqual(sameProvider.map((t) => [t.label, t.model, t.apiKey]), [["primary", "model-a", KEY], ["fallback", "model-b", KEY]]);
  // A different base URL without its own key is not configured: the primary key is never sent elsewhere.
  assert.equal(llmTargets({ ...PRIMARY, LLM_FALLBACK_MODEL: "model-b", LLM_FALLBACK_BASE_URL: "https://other.example/v1" }).length, 1);
  // The same model on the same provider is not a fallback.
  assert.equal(llmTargets({ ...PRIMARY, LLM_FALLBACK_MODEL: "model-a" }).length, 1);
});

// ---------------------------------------------------------------------------
// The IMNCI extractor with the model down: deterministic answers still work, nothing is invented
// ---------------------------------------------------------------------------

const protocol = JSON.parse(readFileSync(new URL("../imnci-sick-child-2m-5y.json", import.meta.url), "utf8")) as ImnciProtocol;
const steps = buildSteps(protocol);
const step = (key: string) => steps.find((s) => s.key === key)!;

function withEnv(env: Record<string, string>, fn: () => Promise<void>) {
  return async () => {
    const saved = { ...process.env };
    Object.assign(process.env, env);
    delete process.env.LLM_FALLBACK_MODEL;
    try {
      await fn();
    } finally {
      for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
      Object.assign(process.env, saved);
    }
  };
}

test(
  "model down, clear yes/no answer: parsed without the model",
  withEnv(PRIMARY, async () => {
    mockModel({ "primary.example": [503, 503, 503] });
    const r = await extractSigns("nahi", steps, step("vomits_everything"));
    assert.deepEqual(r.signs, { vomits_everything: false });
    assert.equal(r.modelUnavailable, true);
  }),
);

test(
  "model down, an answer that needs the model: no sign is filled, and the worker is asked to repeat",
  withEnv(PRIMARY, async () => {
    mockModel({ "primary.example": [503, 503, 503] });
    const s = step("vomits_everything");
    const r = await extractSigns("kabhi kabhi", steps, s);
    assert.deepEqual(r.signs, {});
    assert.equal(r.modelUnavailable, true);
    assert.match(modelBusyRepeat(s, "en"), /busy.*say it again.*"yes" or "no"/);
    assert.match(modelBusyRepeat(step("cough_duration_days"), "hi"), /दिनों की संख्या/);
  }),
);

test(
  "model down while reading the visit sentence: nothing is seeded, so every question gets asked",
  withEnv(PRIMARY, async () => {
    mockModel({ "primary.example": [503, 503, 503] });
    const r = await extractSigns(TRANSCRIPT + ", khansi hai, ulti nahi", steps, null);
    assert.deepEqual(r.signs, {});
    assert.equal(r.modelUnavailable, true);
  }),
);

test(
  "measurements never reach the model, even when it is up",
  withEnv(PRIMARY, async () => {
    mockModel({});
    const r = await extractSigns("45", steps, step("respiratory_rate"));
    assert.deepEqual(r.signs, { respiratory_rate: 45 });
    assert.equal(calls.length, 0);
  }),
);
