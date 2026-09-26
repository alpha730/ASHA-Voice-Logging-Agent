import { llmConfigured, llmJson } from "@/lib/extraction";
import { classifyByKeywords, PROTOCOLS, protocolFields, protocolSchema } from "@/lib/protocols";
import { addMonths } from "@/lib/schedule";
import { VISIT_PROTOCOLS, type VisitProtocol } from "@/types/patient";

/**
 * Step one of the two-call design: decide which protocol the visit follows, so step two
 * only ever extracts fields that apply to the person the worker just saw.
 */
export async function classifyVisit(transcript: string): Promise<VisitProtocol> {
  const keyword = classifyByKeywords(transcript);
  const system = `Classify an Indian community health worker's home-visit transcript into exactly one protocol.
Protocols:
${VISIT_PROTOCOLS.map((p) => `- ${p}: ${PROTOCOLS[p].label}`).join("\n")}

Rules:
- maternal_anc for a pregnant woman. newborn_hbnc for an infant under 6 weeks old.
- child_immunization when vaccines or a child's growth are the point of the visit.
- chronic_followup for TB, DOTS, diabetes or blood pressure medication adherence.
- general_illness when nothing else fits. Do not guess a specialised protocol from weak evidence.
Return JSON: {"protocol": "<one of the ids above>"}`;

  const raw = (await llmJson(system, `Transcript:\n"""${transcript}"""`)) as { protocol?: string } | null;
  const picked = raw?.protocol as VisitProtocol | undefined;
  return picked && VISIT_PROTOCOLS.includes(picked) ? picked : keyword;
}

export type ProtocolData = Record<string, unknown>;

/**
 * Step two: extract only this protocol's fields from the latest utterance.
 * Same strict rule as the core extractor, nothing unsaid is ever filled in.
 */
export async function extractProtocolData(
  turn: string,
  today: string,
  protocol: VisitProtocol,
  current: ProtocolData,
  expecting: string | null,
): Promise<ProtocolData> {
  const fields = protocolFields(protocol);
  if (!fields.length) return {};

  const system = `You extract one protocol's fields from a home-visit utterance spoken by an Indian community health worker.
The utterance may be Hindi, English or code-switched, in Devanagari or romanized script.
TODAY is ${today}. Protocol: ${PROTOCOLS[protocol].label}.

Return ONLY JSON matching:
${protocolSchema(protocol)}

Rules:
- null for anything not stated in this utterance. NEVER guess a measurement, date or answer.
- Return [] when the worker says there are none ("koi lakshan nahi", "no danger signs"). Return null only when the topic never came up.
- Resolve relative dates and ages against TODAY. Convert Fahrenheit to Celsius.`;

  const user = [
    `Fields collected so far: ${JSON.stringify(current)}`,
    expecting ? `The agent just asked about: ${expecting}` : null,
    `New utterance:\n"""${turn}"""`,
  ]
    .filter(Boolean)
    .join("\n\n");

  const raw = (await llmJson(system, user)) as ProtocolData | null;
  const parsed = raw ?? ruleBasedProtocolExtract(turn, today, protocol, expecting);
  return coerce(parsed, protocol);
}

/** Keep only known fields, with the declared type. Anything else is dropped. */
function coerce(raw: ProtocolData, protocol: VisitProtocol): ProtocolData {
  const out: ProtocolData = {};
  for (const f of protocolFields(protocol)) {
    const v = raw?.[f.key];
    if (v === null || v === undefined) continue;
    if (f.type === "number" && typeof v === "number" && Number.isFinite(v)) out[f.key] = v;
    else if (f.type === "boolean" && typeof v === "boolean") out[f.key] = v;
    else if (f.type === "string[]") {
      if (Array.isArray(v)) out[f.key] = v.filter((x): x is string => typeof x === "string" && !!x.trim());
    } else if (f.type === "date") {
      if (typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v)) out[f.key] = v;
    } else if (typeof v === "string" && v.trim()) out[f.key] = v.trim();
    else if (typeof v === "number" && f.type === "string") out[f.key] = String(v);
  }
  return out;
}

/**
 * Merge protocol answers. An empty array means "none present", which is a real answer.
 * The model is told to use null when a topic never came up; the keyword fallback cannot
 * make that distinction, so there [] only counts when the agent had just asked.
 */
export function mergeProtocolData(prev: ProtocolData, next: ProtocolData, expecting: string | null): ProtocolData {
  const trustEmpty = llmConfigured();
  const out = { ...prev };
  for (const [k, v] of Object.entries(next)) {
    if (Array.isArray(v) && v.length === 0 && !trustEmpty && k !== expecting) continue;
    out[k] = v;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Fallback used when no LLM is configured, so protocols still demo offline.
// ---------------------------------------------------------------------------

const VACCINE_WORDS: Record<string, RegExp> = {
  "BCG": /\bbcg\b/i,
  "OPV-0": /\bopv[\s-]?0\b/i,
  "OPV-1": /\bopv[\s-]?1\b/i,
  "OPV-2": /\bopv[\s-]?2\b/i,
  "OPV-3": /\bopv[\s-]?3\b/i,
  "Pentavalent-1": /\b(penta\w*)[\s-]?1\b/i,
  "Pentavalent-2": /\b(penta\w*)[\s-]?2\b/i,
  "Pentavalent-3": /\b(penta\w*)[\s-]?3\b/i,
  "Rotavirus-1": /\brota\w*[\s-]?1\b/i,
  "MR-1": /\b(mr|measles)[\s-]?1\b/i,
  "MR-2": /\b(mr|measles)[\s-]?2\b/i,
  "Hepatitis B birth dose": /\bhep\w*\s?b\b/i,
};

const NUM_WORDS: Record<string, number> = {
  ek: 1, do: 2, teen: 3, char: 4, chaar: 4, paanch: 5, panch: 5, chhe: 6, saat: 7, aath: 8, nau: 9, das: 10,
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
};

function numberNear(text: string, unit: RegExp): number | null {
  const m = text.match(new RegExp(`(\\d+(?:\\.\\d+)?|[a-z]+)\\s*(?:${unit.source})`, "i"));
  if (!m) return null;
  const n = /^\d/.test(m[1]) ? parseFloat(m[1]) : NUM_WORDS[m[1].toLowerCase()];
  return Number.isFinite(n) ? n : null;
}

export function ruleBasedProtocolExtract(
  turn: string,
  today: string,
  protocol: VisitProtocol,
  expecting: string | null,
): ProtocolData {
  const t = turn.toLowerCase();
  const out: ProtocolData = {};

  if (protocol === "maternal_anc") {
    const month = numberNear(t, /(?:mahine|महीने|month|months)/) ?? (expecting === "gestational_month" ? numberNear(t, /\b/) : null);
    if (month && month >= 1 && month <= 9) out.gestational_month = month;
    const bp = t.match(/(\d{2,3})\s*(?:\/|by|bata|पर)\s*(\d{2,3})/);
    if (bp) out.bp = `${bp[1]}/${bp[2]}`;
    const w = numberNear(t, /(?:kg|kilo)/);
    if (w) out.weight_kg = w;
    if (/(ifa|iron|goli|गोली|tablet)/i.test(t)) out.ifa_tablets_taken = !/(nahi|नहीं|not|no\b|band)/i.test(t);
    const signs = [
      ["bleeding", /(bleeding|khoon|खून|rakt)/i],
      ["severe headache", /(headache|sir dard|सिर दर्द)/i],
      ["blurred vision", /(blur|dhundh|धुंध|vision)/i],
      ["swelling", /(swelling|sujan|सूजन)/i],
      ["reduced fetal movement", /(movement|hilna|हलचल)/i],
    ] as const;
    const found = signs.filter(([, re]) => re.test(t)).map(([label]) => label);
    if (found.length) out.danger_signs = found;
    else if (expecting === "danger_signs" && /(nahi|नहीं|no\b|none|kuch nahi|theek)/i.test(t)) out.danger_signs = [];
  }

  if (protocol === "child_immunization") {
    const given = Object.entries(VACCINE_WORDS).filter(([, re]) => re.test(turn)).map(([label]) => label);
    if (given.length) out.vaccines_given = given;
    else if (expecting === "vaccines_given" && /(nahi|नहीं|no\b|none|koi nahi)/i.test(t)) out.vaccines_given = [];
    const w = numberNear(t, /(?:kg|kilo)/);
    if (w) out.weight_kg = w;
    const months = numberNear(t, /(?:mahine|महीने|month|months)\s*(?:ka|ki|old)?/);
    const years = numberNear(t, /(?:saal|साल|year|years)\s*(?:ka|ki|old)?/);
    if (months) out.date_of_birth = addMonths(today, -months);
    else if (years) out.date_of_birth = addMonths(today, -years * 12);
    const dob = turn.match(/\b(\d{4}-\d{2}-\d{2})\b/);
    if (dob) out.date_of_birth = dob[1];
  }

  return out;
}
