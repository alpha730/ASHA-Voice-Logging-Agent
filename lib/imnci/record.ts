import { PROTOCOL } from "@/lib/imnci/protocol";
import { evaluate, type Signs, type TriageResult } from "@/lib/imnci/rules";

/**
 * What is stored against the visit. Everything needed to re-run the rules and get the same
 * answer: the protocol version, the source document, the age, and every sign as captured.
 */
export interface ImnciTriageRecord {
  protocol: string;
  pathway: string;
  version: string;
  source: { title: string; edition: string | null; sha256: string | null };
  verification: TriageResult["verification"]; // how far the rules behind this result were checked
  evaluated_at: string;
  age_months: number | null;
  age_source: string | null; // "record", "speech" (read from her visit sentence) or "answer"
  age_phrase: string | null; // the words the age was read from
  signs: Signs; // inputs exactly as captured
  skipped: string[]; // steps the worker could not answer
  derived: TriageResult["derived"];
  classifications: TriageResult["classifications"];
  outcome: TriageResult["outcome"];
  complete: boolean;
  pending: TriageResult["pending"];
  unmatched: string[];
  stopped_early: boolean;
  qa_log: { q: string; a: string }[]; // the triage conversation, question by question
}

export function evaluateTriage(signs: Signs, ageMonths: number | null): TriageResult {
  return evaluate(PROTOCOL, { signs, ageMonths });
}

export function buildRecord(opts: {
  signs: Signs;
  ageMonths: number | null;
  ageSource: string | null;
  agePhrase: string | null;
  skipped: string[];
  stoppedEarly: boolean;
  log: { q: string; a: string }[];
}): ImnciTriageRecord {
  const result = evaluateTriage(opts.signs, opts.ageMonths);
  return {
    protocol: PROTOCOL.protocol,
    pathway: PROTOCOL.pathway,
    version: PROTOCOL.version,
    source: { title: PROTOCOL.source.title, edition: PROTOCOL.source.edition ?? null, sha256: PROTOCOL.source.sha256 ?? null },
    verification: result.verification,
    evaluated_at: new Date().toISOString(),
    age_months: opts.ageMonths,
    age_source: opts.ageSource,
    age_phrase: opts.agePhrase,
    signs: opts.signs,
    skipped: opts.skipped,
    derived: result.derived,
    classifications: result.classifications,
    outcome: result.outcome,
    complete: result.complete,
    pending: result.pending,
    unmatched: result.unmatched,
    stopped_early: opts.stoppedEarly,
    qa_log: opts.log,
  };
}
