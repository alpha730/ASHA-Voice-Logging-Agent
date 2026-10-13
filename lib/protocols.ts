import type { VisitProtocol } from "@/types/patient";

/**
 * A protocol decides which fields the agent asks about. The worker is never asked for a
 * gestational month during a child immunization visit, or a birth weight during a TB follow-up.
 */
export interface ProtocolField {
  key: string;
  type: "string" | "number" | "boolean" | "string[]" | "date";
  describe: string; // goes into the extraction prompt
  required?: boolean;
  question: string; // ui-text.json id, read with t()
}

export interface ProtocolSpec {
  label: string;
  /** Keywords that classify a transcript without an LLM call. */
  triggers: RegExp;
  /** Whether the protocol is about a child (drives the immunization due engine). */
  subject: "child" | "mother" | "any";
  fields: ProtocolField[];
}


export const PROTOCOLS: Record<VisitProtocol, ProtocolSpec> = {
  maternal_anc: {
    label: "Maternal / ANC",
    subject: "mother",
    triggers: /(pregnan|garbh|गर्भ|anc|antenatal|delivery|prasav|प्रसव|expecting|mahine ki pregnan)/i,
    fields: [
      {
        key: "gestational_month",
        type: "number",
        describe: "month of pregnancy, 1-9",
        required: true,
        question: "protocol.maternal_anc.gestational_month",
      },
      {
        key: "bp",
        type: "string",
        describe: "blood pressure as systolic/diastolic, e.g. 120/80",
        required: true,
        question: "protocol.maternal_anc.bp",
      },
      {
        key: "weight_kg",
        type: "number",
        describe: "weight in kilograms",
        question: "protocol.maternal_anc.weight_kg",
      },
      {
        key: "ifa_tablets_taken",
        type: "boolean",
        describe: "true if she is taking iron folic acid tablets, false if not, null if not discussed",
        required: true,
        question: "protocol.maternal_anc.ifa_tablets_taken",
      },
      {
        key: "danger_signs",
        type: "string[]",
        describe: "danger signs such as bleeding, severe headache, blurred vision, swelling, reduced fetal movement",
        required: true,
        question: "protocol.maternal_anc.danger_signs",
      },
      {
        key: "expected_delivery_date",
        type: "date",
        describe: "expected date of delivery as YYYY-MM-DD",
        question: "protocol.maternal_anc.expected_delivery_date",
      },
    ],
  },

  child_immunization: {
    label: "Child immunization",
    subject: "child",
    triggers: /(vaccin|teeka|टीका|immuni|bcg|opv|penta|rota|measles|mr-?[12]|polio|booster|mahine ka bacch|months old|saal ka)/i,
    fields: [
      {
        key: "date_of_birth",
        type: "date",
        describe: "the child's date of birth as YYYY-MM-DD, or derived from a stated age",
        required: true,
        question: "protocol.child_immunization.date_of_birth",
      },
      {
        key: "vaccines_given",
        type: "string[]",
        describe: "vaccines administered at this visit, e.g. [\"Pentavalent-1\", \"OPV-1\"]",
        required: true,
        question: "protocol.child_immunization.vaccines_given",
      },
      {
        key: "weight_kg",
        type: "number",
        describe: "weight in kilograms",
        required: true,
        question: "protocol.child_immunization.weight_kg",
      },
      {
        key: "growth_concern",
        type: "string",
        describe: "any growth or nutrition concern noted",
        question: "protocol.child_immunization.growth_concern",
      },
    ],
  },

  // Recognised and classified, but they reuse the general illness fields for the hackathon build.
  newborn_hbnc: {
    label: "Newborn (HBNC)",
    subject: "child",
    triggers: /(newborn|navjat|नवजात|just delivered|abhi hua|days old|din ka bacch|cord|breastfeed|stanpan)/i,
    fields: [],
  },
  chronic_followup: {
    label: "Chronic follow-up",
    subject: "any",
    triggers: /(\btb\b|tuberculosis|dots|kshay|diabetes|sugar|hypertension|bp ki dawa|medicine|dawa|adherence)/i,
    fields: [],
  },
  general_illness: {
    label: "General illness",
    subject: "any",
    triggers: /.^/, // never matches; this is the fallback
    fields: [],
  },
};

/** Keyword classification, used as the fallback and as a check on the model. */
export function classifyByKeywords(text: string): VisitProtocol {
  const ordered: VisitProtocol[] = ["maternal_anc", "newborn_hbnc", "child_immunization", "chronic_followup"];
  return ordered.find((p) => PROTOCOLS[p].triggers.test(text)) ?? "general_illness";
}

export function protocolFields(protocol: VisitProtocol): ProtocolField[] {
  return PROTOCOLS[protocol].fields;
}

/** Protocol fields still missing from the collected data. */
export function missingProtocolFields(protocol: VisitProtocol, data: Record<string, unknown>): ProtocolField[] {
  return protocolFields(protocol).filter((f) => {
    if (!f.required) return false;
    const v = data[f.key];
    if (v === null || v === undefined || v === "") return true;
    return Array.isArray(v) && v.length === 0 && f.key !== "danger_signs";
  });
}

/** Schema block describing the protocol's fields, appended to the extraction prompt. */
export function protocolSchema(protocol: VisitProtocol): string {
  const fields = protocolFields(protocol);
  if (!fields.length) return "";
  const lines = fields.map((f) => `  "${f.key}": ${f.type} | null,   // ${f.describe}`);
  return `{\n${lines.join("\n")}\n}`;
}
