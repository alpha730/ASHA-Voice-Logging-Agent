import raw from "@/imnci-sick-child-2m-5y.json";
import { holds, validateProtocol, type Condition, type ImnciProtocol, type Signs } from "@/lib/imnci/rules";
import { buildSteps } from "@/lib/imnci/flow";

export const PROTOCOL = raw as unknown as ImnciProtocol;

// Fail at startup, not mid-visit, if the JSON uses a rule the engine does not understand,
// marks a rule verified without a page and quote, or references a sign nothing asks about.
const { undefinedSigns } = validateProtocol(PROTOCOL);
if (undefinedSigns.length) throw new Error(`IMNCI protocol uses signs with no question: ${undefinedSigns.join(", ")}`);

export const STEPS = buildSteps(PROTOCOL);

/** The sign ids behind the steps the worker could not answer. */
export const signsOfSteps = (keys: string[]): string[] => STEPS.filter((s) => keys.includes(s.key)).flatMap((s) => s.signs);

/** Decides a step's ask_if condition for the next-question logic. */
export const askIfChecker = (signs: Signs, ageMonths: number | null) => (cond: Condition) =>
  holds(PROTOCOL, { signs, ageMonths }, cond);
