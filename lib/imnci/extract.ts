import { isLlmUnavailable, llmConfigured, llmJson } from "../llm.ts";
import { parseStepAnswer, type Step } from "./flow.ts";
import type { Signs } from "./rules.ts";

/**
 * The only model call in the IMNCI pathway. It maps what the worker said onto the protocol's
 * sign ids and nothing else: no classification, no disease name, no medicine. The output is
 * checked against the step list, so a key or value the model invents is dropped.
 *
 * Measurement steps (breath count, skin pinch, palms, growth chart) are never offered to the
 * model. They are filled only by parsing her direct answer to that step.
 */

function describe(step: Step): string {
  const text = step.prompt.en;
  if (step.kind === "days") return `number of days (integer). Asked as: "${text}"`;
  if (step.positiveWhen === "no") return `boolean. TRUE when the answer to "${text}" is NO, FALSE when it is yes`;
  return `boolean. TRUE when the answer to "${text}" is yes`;
}

function systemPrompt(steps: Step[]): string {
  const lines = steps.flatMap((s) => s.signs.map((id) => `  "${id}": ${describe(s)}`));
  return `You map an Indian community health worker's words about a sick child onto a fixed list of signs.
She may speak Hindi, English or both, in Devanagari or romanized script.

Return ONLY a JSON object with these keys, each true/false, a number, or null:
{
${lines.join(",\n")},
  "fast_breathing": boolean. TRUE only if she says the child is breathing fast (recorded, but a breath count is still needed)
}

Rules:
- true only when she says the sign is present. false only when she says it is absent. Otherwise null.
- Never infer one sign from another, or from a general impression like "weak" or "very sick".
- Never output a diagnosis, classification, disease name, medicine or advice. Only the keys above.
- Do not include breath counts, skin pinch, palm pallor or growth chart results. Those are measured separately.`;
}

/** Keep only listed keys with the right type. */
function coerce(raw: unknown, steps: Step[]): Signs {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const out: Signs = {};
  for (const step of steps) {
    for (const id of step.signs) {
      const v = r[id];
      if (step.kind === "days") {
        if (typeof v === "number" && Number.isFinite(v) && v >= 0 && v < 3650) out[id] = Math.round(v);
      } else if (typeof v === "boolean") out[id] = v;
    }
  }
  if (typeof r.fast_breathing === "boolean") out.fast_breathing = r.fast_breathing;
  return out;
}

/**
 * Signs stated in an utterance. With `expecting`, the utterance is her answer to that step:
 * a clear answer is parsed directly, and measurement steps never reach the model.
 *
 * When every model provider is down, only the direct parse is used and `modelUnavailable` is set,
 * so the route can ask her to repeat. Nothing is ever filled in for her.
 */
export async function extractSigns(
  text: string,
  steps: Step[],
  expecting: Step | null,
): Promise<{ signs: Signs; modelUnavailable: boolean }> {
  const direct = expecting ? parseStepAnswer(expecting, text) : null;
  if (expecting?.measurement) return { signs: direct ?? {}, modelUnavailable: false };

  const offered = steps.filter((s) => !s.measurement);
  let fromModel: Signs = {};
  let modelUnavailable = false;
  if (llmConfigured()) {
    const user = [expecting ? `She was just asked: "${expecting.prompt.en}"` : null, `She said:\n"""${text}"""`]
      .filter(Boolean)
      .join("\n\n");
    try {
      fromModel = coerce(await llmJson(systemPrompt(offered), user), offered);
    } catch (err) {
      if (!isLlmUnavailable(err)) throw err;
      // A clear answer to the question just asked does not need the model, so an outage cannot stall the visit.
      modelUnavailable = true;
    }
  }
  // A clear direct answer to the question just asked beats the model's reading of it.
  return { signs: { ...fromModel, ...(direct ?? {}) }, modelUnavailable };
}
