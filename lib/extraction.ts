import { isLlmUnavailable, llmConfigured, llmJson } from "@/lib/llm";
import { emptyVisit, type ExtractedVisit, type RequiredField } from "@/types/visit";

const SCHEMA_DESCRIPTION = `{
  "worker_name": string | null,         // the ASHA/Anganwadi worker speaking
  "household_id": string | null,        // household or patient ID, e.g. "H-102"
  "patient_name": string | null,
  "visit_date": "YYYY-MM-DD" | null,    // only if a date is stated
  "symptoms": string[],                 // short lowercase English terms, [] if none mentioned
  "vitals": { "temp_c"?: number, "bp"?: "120/80", "pulse"?: number, "weight_kg"?: number, "spo2"?: number },
  "vaccination_status": string | null,
  "follow_up_date": "YYYY-MM-DD" | null // resolve "in 3 days" / "teen din baad" against TODAY
}`;

export function systemPrompt(today: string): string {
  return `You extract structured home-visit records from transcripts spoken by Indian community health workers.
Transcripts may be Hindi, English, or code-switched Hindi/English, in Devanagari or romanized script.
TODAY is ${today}.

Return ONLY a JSON object matching this schema:
${SCHEMA_DESCRIPTION}

Rules:
- Use null, [] or {} for anything not explicitly said. NEVER guess a vital sign, date, name or ID that was not spoken.
- Convert Fahrenheit temperatures to Celsius, rounded to 1 decimal.
- If the speaker corrects themselves, use the corrected value.
- Translate symptoms to short English terms.`;
}

/**
 * Response schema handed to Gemini. Nullable strings let the model say "not mentioned"
 * without inventing a value, which is the whole point of the extraction design.
 */
const RESPONSE_SCHEMA = {
  type: "object",
  properties: {
    worker_name: { type: "string", nullable: true },
    household_id: { type: "string", nullable: true },
    patient_name: { type: "string", nullable: true },
    visit_date: { type: "string", nullable: true, description: "YYYY-MM-DD" },
    symptoms: { type: "array", items: { type: "string" } },
    vitals: {
      type: "object",
      properties: {
        temp_c: { type: "number", nullable: true },
        bp: { type: "string", nullable: true },
        pulse: { type: "number", nullable: true },
        weight_kg: { type: "number", nullable: true },
        spo2: { type: "number", nullable: true },
      },
    },
    vaccination_status: { type: "string", nullable: true },
    follow_up_date: { type: "string", nullable: true, description: "YYYY-MM-DD" },
  },
  required: ["worker_name", "household_id", "symptoms", "vitals", "follow_up_date"],
} as const;

/**
 * Extraction entry point. Uses the language model when one is configured; otherwise, or when every
 * configured provider is down, the rule-based extractor below. `modelUnavailable` tells the route
 * to ask the worker to repeat anything the simple reader missed.
 */
export interface ExtractContext {
  current: ExtractedVisit;
  expecting: RequiredField | null; // the field the agent just asked about, if any
}

export async function extractVisit(
  turn: string,
  today: string,
  ctx: ExtractContext,
): Promise<{ visit: ExtractedVisit; modelUnavailable: boolean }> {
  if (!llmConfigured()) return { visit: ruleBasedExtract(turn, today, ctx.expecting), modelUnavailable: false };
  const user = [
    `Record so far: ${JSON.stringify(ctx.current)}`,
    ctx.expecting ? `The agent just asked the worker about: ${ctx.expecting}` : null,
    `New utterance:\n"""${turn}"""`,
    "Return only fields stated in the new utterance. Everything else must be null, [] or {}.",
  ]
    .filter(Boolean)
    .join("\n\n");
  try {
    return { visit: normalize(await llmJson(systemPrompt(today), user, RESPONSE_SCHEMA)), modelUnavailable: false };
  } catch (err) {
    if (!isLlmUnavailable(err)) throw err;
    return { visit: ruleBasedExtract(turn, today, ctx.expecting), modelUnavailable: true };
  }
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Coerce untrusted model output into a valid ExtractedVisit. */
export function normalize(raw: unknown): ExtractedVisit {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : null);
  const date = (v: unknown) => (typeof v === "string" && DATE_RE.test(v) ? v : null);
  const vitalsIn = (r.vitals && typeof r.vitals === "object" ? r.vitals : {}) as Record<string, unknown>;
  const vitals: ExtractedVisit["vitals"] = {};
  for (const [k, v] of Object.entries(vitalsIn)) {
    if (typeof v === "number" && Number.isFinite(v)) vitals[k] = v;
    else if (typeof v === "string" && v.trim()) vitals[k] = v.trim();
  }
  return {
    worker_name: str(r.worker_name),
    household_id: str(r.household_id),
    patient_name: str(r.patient_name),
    visit_date: date(r.visit_date),
    symptoms: Array.isArray(r.symptoms)
      ? r.symptoms.filter((s): s is string => typeof s === "string" && !!s.trim())
      : [],
    vitals,
    vaccination_status: str(r.vaccination_status),
    follow_up_date: date(r.follow_up_date),
  };
}

/** Merge a fresh extraction into the running record. New non-null values win. */
export function mergeVisit(prev: ExtractedVisit, next: ExtractedVisit): ExtractedVisit {
  return {
    worker_name: next.worker_name ?? prev.worker_name,
    household_id: next.household_id ?? prev.household_id,
    patient_name: next.patient_name ?? prev.patient_name,
    visit_date: next.visit_date ?? prev.visit_date,
    symptoms: Array.from(new Set([...prev.symptoms, ...next.symptoms])),
    vitals: { ...prev.vitals, ...next.vitals },
    vaccination_status: next.vaccination_status ?? prev.vaccination_status,
    follow_up_date: next.follow_up_date ?? prev.follow_up_date,
  };
}

export function clearField(v: ExtractedVisit, field: RequiredField): ExtractedVisit {
  if (field === "health_findings") return { ...v, symptoms: [], vitals: {} };
  return { ...v, [field]: null };
}

// ---------------------------------------------------------------------------
// Rule-based fallback so the demo loop works before an LLM key is configured.
// ---------------------------------------------------------------------------

const SYMPTOMS: Record<string, string[]> = {
  fever: ["fever", "bukhar", "बुखार", "taap"],
  cough: ["cough", "khansi", "खांसी", "खाँसी"],
  cold: ["cold", "zukam", "jukam", "जुकाम"],
  diarrhea: ["diarrhea", "diarrhoea", "dast", "दस्त", "loose motion"],
  vomiting: ["vomiting", "ulti", "उल्टी"],
  headache: ["headache", "sir dard", "सिर दर्द"],
  weakness: ["weakness", "kamzori", "कमजोरी", "कमज़ोरी"],
  "body pain": ["body pain", "badan dard", "बदन दर्द"],
  swelling: ["swelling", "sujan", "सूजन"],
  rash: ["rash", "daane", "दाने"],
};

const NUMBER_WORDS: Record<string, number> = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, ten: 10, fourteen: 14,
  ek: 1, do: 2, teen: 3, char: 4, chaar: 4, paanch: 5, panch: 5, saat: 7, das: 10,
  "एक": 1, "दो": 2, "तीन": 3, "चार": 4, "पांच": 5, "पाँच": 5, "सात": 7, "दस": 10,
};

function addDays(today: string, days: number): string {
  const d = new Date(`${today}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

const NOT_NAMES = new Set(["hoon", "hu", "hun", "a", "an", "the", "here", "at", "है", "हूं", "हूँ", "ne", "aaj"]);

export function ruleBasedExtract(
  transcript: string,
  today: string,
  expecting: RequiredField | null = null,
): ExtractedVisit {
  const t = transcript.toLowerCase();
  const v = emptyVisit();

  const name = transcript.match(/(?:my name is|this is|i am|mera naam|मेरा नाम)\s+([A-Za-zऀ-ॿ]+)/i);
  if (name && !NOT_NAMES.has(name[1].toLowerCase())) v.worker_name = name[1];
  if (!v.worker_name && expecting === "worker_name") {
    const word = transcript.split(/[\s,.।]+/).find((w) => w.length > 1 && !NOT_NAMES.has(w.toLowerCase()));
    if (word) v.worker_name = word;
  }

  const hh = transcript.match(/(?:household|house|ghar|घर)\s*(?:id|number|no\.?|नंबर)?\s*(?:is|hai|है)?\s*[:#-]?\s*([A-Za-z]?-?\s?\d+)/i);
  if (hh) v.household_id = hh[1].replace(/\s/g, "").toUpperCase();
  if (!v.household_id && expecting === "household_id") {
    const id = transcript.match(/[A-Za-z]?-?\s?\d+/);
    if (id) v.household_id = id[0].replace(/\s/g, "").toUpperCase();
  }

  const patient = transcript.match(/(?:patient|patient name|mareez)\s*(?:is|hai|name is)?\s*([A-Z][a-z]+|[ऀ-ॿ]+)/);
  if (patient) v.patient_name = patient[1];

  for (const [symptom, words] of Object.entries(SYMPTOMS)) {
    if (words.some((w) => t.includes(w))) v.symptoms.push(symptom);
  }

  const temp = t.match(/(\d{2,3}(?:\.\d)?)\s*(?:degrees?|°|डिग्री)\s*(f|fahrenheit|c|celsius)?/);
  if (temp) {
    let val = parseFloat(temp[1]);
    if (temp[2]?.startsWith("f") || val > 45) val = Math.round((((val - 32) * 5) / 9) * 10) / 10;
    if (val > 30 && val < 45) v.vitals.temp_c = val;
  }
  const bp = t.match(/(?:bp|blood pressure)\D{0,10}(\d{2,3})\s*(?:\/|by|over)\s*(\d{2,3})/);
  if (bp) v.vitals.bp = `${bp[1]}/${bp[2]}`;
  const pulse = t.match(/(?:pulse|nadi|नाड़ी)\D{0,10}(\d{2,3})/);
  if (pulse) v.vitals.pulse = parseInt(pulse[1], 10);
  const weight = t.match(/(\d{1,3}(?:\.\d)?)\s*(?:kg|kilo)/);
  if (weight) v.vitals.weight_kg = parseFloat(weight[1]);

  const vaccRe = /(vaccin|teeka|टीका|bcg|opv|penta|measles|polio)/i;
  if (vaccRe.test(t)) {
    const sentence = transcript.split(/[.।?!]/).find((s) => vaccRe.test(s));
    v.vaccination_status = sentence?.trim() ?? null;
  }

  const followCtx = expecting === "follow_up_date" || /(follow|next visit|visit again|dobara|फिर से|baad|बाद|after|come back)/.test(t);
  const rel = t.match(/(\d+|[a-zऀ-ॿ]+)\s*(days?|din|दिन|weeks?|hafte|हफ्ते)/);
  const relN = rel ? (/^\d+$/.test(rel[1]) ? parseInt(rel[1], 10) : NUMBER_WORDS[rel[1]]) : undefined;
  if (rel && relN && followCtx) {
    v.follow_up_date = addDays(today, /week|hafte|हफ्ते/.test(rel[2]) ? relN * 7 : relN);
  } else if (/(tomorrow|\bkal\b)/.test(t) && followCtx) {
    v.follow_up_date = addDays(today, 1);
  }
  return v;
}
