/**
 * Every language-model call goes through completeJson(): up to 3 attempts per provider with
 * exponential backoff and jitter, then the fallback provider if one is configured.
 *
 * Only 429, 500, 502, 503 and timeouts are retried. Error messages carry the provider host, the
 * model and the HTTP status, never the API key, the prompt or the response body (which can echo
 * the transcript back).
 *
 * Pure apart from `runtime`, which tests replace to mock the network and skip the waits.
 */

export interface LlmTarget {
  label: "primary" | "fallback";
  baseUrl: string;
  model: string;
  apiKey: string;
}

type Env = Record<string, string | undefined>;

const DEFAULT_BASE_URL = "https://api.groq.com/openai/v1";
const RETRYABLE = new Set([429, 500, 502, 503]);
export const MAX_ATTEMPTS = 3;

export const runtime = {
  fetch: (url: string, init: RequestInit) => fetch(url, init),
  sleep: (ms: number) => new Promise<void>((r) => setTimeout(r, ms)),
  random: () => Math.random(),
  timeoutMs: 20_000,
  baseDelayMs: 500,
  maxDelayMs: 4_000,
};

/** The primary provider (LLM_*), then the fallback (LLM_FALLBACK_*) when one is configured. */
export function llmTargets(env: Env = process.env): LlmTarget[] {
  const key = env.LLM_API_KEY?.trim();
  const model = env.LLM_MODEL?.trim();
  if (!key || !model) return [];
  const baseUrl = (env.LLM_BASE_URL?.trim() || DEFAULT_BASE_URL).replace(/\/$/, "");
  const targets: LlmTarget[] = [{ label: "primary", baseUrl, model, apiKey: key }];

  const fbModel = env.LLM_FALLBACK_MODEL?.trim();
  if (fbModel) {
    const fbBase = (env.LLM_FALLBACK_BASE_URL?.trim() || baseUrl).replace(/\/$/, "");
    // Another provider needs its own key; the same provider may reuse the primary key.
    const fbKey = env.LLM_FALLBACK_API_KEY?.trim() || (fbBase === baseUrl ? key : "");
    if (fbKey && (fbModel !== model || fbBase !== baseUrl)) targets.push({ label: "fallback", baseUrl: fbBase, model: fbModel, apiKey: fbKey });
  }
  return targets;
}

export const llmConfigured = (env: Env = process.env) => llmTargets(env).length > 0;

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return "invalid-url";
  }
}

/** One failed request. `status` is null for a timeout or a network error. */
export class LlmError extends Error {
  readonly status: number | null;
  readonly reason: "http" | "timeout" | "network";
  readonly retryAfterMs: number | null;
  constructor(target: LlmTarget, status: number | null, reason: "http" | "timeout" | "network", retryAfterMs: number | null = null) {
    const what = reason === "http" ? `HTTP ${status}` : reason;
    super(`LLM ${target.label} (${hostOf(target.baseUrl)}, ${target.model}) failed: ${what}`);
    this.name = "LlmError";
    this.status = status;
    this.reason = reason;
    this.retryAfterMs = retryAfterMs;
  }
  get retryable(): boolean {
    return this.reason === "timeout" || (this.status != null && RETRYABLE.has(this.status));
  }
}

/** Every configured provider failed. The caller falls back to its deterministic path. */
export class LlmUnavailableError extends Error {
  readonly failures: string[];
  constructor(failures: string[]) {
    super(`Language model unavailable. ${failures.join("; ")}`);
    this.name = "LlmUnavailableError";
    this.failures = failures;
  }
}

export const isLlmUnavailable = (err: unknown): err is LlmUnavailableError => err instanceof LlmUnavailableError;

/** Delay before retry `attempt` (0-based): 2^attempt × base, capped, with jitter in [half, full]. */
export function backoffMs(attempt: number, retryAfterMs: number | null = null): number {
  const exp = Math.min(runtime.maxDelayMs, runtime.baseDelayMs * 2 ** attempt);
  const jittered = exp / 2 + runtime.random() * (exp / 2);
  return retryAfterMs != null ? Math.max(jittered, Math.min(retryAfterMs, runtime.maxDelayMs)) : jittered;
}

export async function withRetry<T>(fn: () => Promise<T>, attempts = MAX_ATTEMPTS): Promise<{ value: T; tries: number }> {
  for (let i = 0; ; i++) {
    try {
      return { value: await fn(), tries: i + 1 };
    } catch (err) {
      if (!(err instanceof LlmError) || !err.retryable || i >= attempts - 1) throw Object.assign(err as Error, { tries: i + 1 });
      await runtime.sleep(backoffMs(i, err.retryAfterMs));
    }
  }
}

export interface JsonRequest {
  system: string;
  user: string;
  geminiSchema?: unknown; // strict response schema, used only by the Gemini dialect
}

/**
 * Two request shapes: Gemini's native generateContent, and the OpenAI-compatible chat completions
 * used by Groq, OpenAI, OpenRouter and most others. The base URL picks.
 */
async function requestOnce(target: LlmTarget, req: JsonRequest): Promise<string> {
  const gemini = target.baseUrl.includes("generativelanguage.googleapis.com");
  const url = gemini ? `${target.baseUrl}/models/${target.model}:generateContent` : `${target.baseUrl}/chat/completions`;
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (gemini) headers["x-goog-api-key"] = target.apiKey;
  else headers.Authorization = `Bearer ${target.apiKey}`;
  const body = gemini
    ? {
        systemInstruction: { parts: [{ text: req.system }] },
        contents: [{ role: "user", parts: [{ text: req.user }] }],
        generationConfig: {
          temperature: 0,
          responseMimeType: "application/json",
          ...(req.geminiSchema ? { responseSchema: req.geminiSchema } : {}),
          // Flash-lite models reason by default; disabling it keeps latency and token cost down.
          thinkingConfig: { thinkingBudget: 0 },
        },
      }
    : {
        model: target.model,
        temperature: 0,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: req.system },
          { role: "user", content: req.user },
        ],
      };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), runtime.timeoutMs);
  let res: Response;
  try {
    res = await runtime.fetch(url, { method: "POST", headers, body: JSON.stringify(body), signal: controller.signal });
  } catch (err) {
    const timedOut = controller.signal.aborted || (err as Error)?.name === "AbortError" || (err as Error)?.name === "TimeoutError";
    throw new LlmError(target, null, timedOut ? "timeout" : "network");
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) {
    const retryAfter = Number(res.headers.get("retry-after"));
    throw new LlmError(target, res.status, "http", Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : null);
  }
  const data = (await res.json().catch(() => null)) as Record<string, any> | null;
  return (gemini ? data?.candidates?.[0]?.content?.parts?.[0]?.text : data?.choices?.[0]?.message?.content) ?? "{}";
}

/** The model's raw JSON text. Throws LlmUnavailableError once every provider has failed. */
export async function completeJson(req: JsonRequest, env: Env = process.env): Promise<string> {
  const targets = llmTargets(env);
  if (!targets.length) throw new LlmUnavailableError(["no model configured"]);
  const failures: string[] = [];
  for (const target of targets) {
    try {
      return (await withRetry(() => requestOnce(target, req))).value;
    } catch (err) {
      const tries = (err as { tries?: number }).tries ?? 1;
      failures.push(err instanceof LlmError ? `${err.message} after ${tries} attempt${tries === 1 ? "" : "s"}` : `LLM ${target.label} failed`);
    }
  }
  throw new LlmUnavailableError(failures);
}

/** First JSON object in the model's text, or {} when there is none. */
export function parseJson(text: string): unknown {
  const match = text.match(/\{[\s\S]*\}/);
  try {
    return JSON.parse(match ? match[0] : text);
  } catch {
    return {};
  }
}

/**
 * Strict-JSON call used by every extractor. Null when no model is configured; throws
 * LlmUnavailableError when one is configured but every provider failed.
 */
export async function llmJson(system: string, user: string, geminiSchema?: unknown): Promise<unknown | null> {
  if (!llmConfigured()) return null;
  return parseJson(await completeJson({ system, user, geminiSchema }));
}
