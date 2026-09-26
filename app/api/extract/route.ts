import { NextResponse } from "next/server";
import { clearField, extractVisit, mergeVisit, normalize } from "@/lib/extraction";
import { CORRECTION_RE, questionFor, summaryLine, type UiLang } from "@/lib/agent";
import { classifyVisit, extractProtocolData, mergeProtocolData, type ProtocolData } from "@/lib/protocol-extract";
import { missingProtocolFields, protocolFields, PROTOCOLS } from "@/lib/protocols";
import { getPatient } from "@/lib/db";
import { missingFields, REQUIRED_FIELDS, type ExtractedVisit, type RequiredField } from "@/types/visit";
import type { VisitProtocol } from "@/types/patient";

export const dynamic = "force-dynamic";

interface ExtractRequest {
  turn: string;
  current?: ExtractedVisit;
  expecting?: RequiredField | null;
  lastFilled?: RequiredField | null;
  lang?: UiLang;
  today?: string;
  // Phase 5
  protocol?: VisitProtocol | null;
  protocolData?: ProtocolData;
  protocolExpecting?: string | null;
  patientId?: string | null;
}

export interface ExtractResponse {
  visit: ExtractedVisit;
  missing: RequiredField[];
  expecting: RequiredField | null; // core field the agent is now asking about
  lastFilled: RequiredField | null;
  question: string | null; // one question to speak, or null
  summary: string | null; // read-back line once complete
  reopened: RequiredField | null; // set when the worker said "that's wrong"
  complete: boolean;
  // Phase 5
  protocol: VisitProtocol | null;
  protocolLabel: string | null;
  protocolData: ProtocolData;
  protocolExpecting: string | null; // protocol field the agent is now asking about
  missingProtocol: string[];
}

function filledFields(v: ExtractedVisit): Set<RequiredField> {
  const missing = new Set(missingFields(v));
  return new Set(REQUIRED_FIELDS.filter((f) => !missing.has(f)));
}

/**
 * A protocol's own fields cover the clinical findings, so a maternal or immunization
 * visit is not also asked the generic "any symptoms?" question.
 */
function coreMissing(visit: ExtractedVisit, protocol: VisitProtocol | null, data: ProtocolData): RequiredField[] {
  const missing = missingFields(visit);
  const protocolCovers = protocol && protocolFields(protocol).length > 0 && Object.keys(data).length > 0;
  return protocolCovers ? missing.filter((f) => f !== "health_findings") : missing;
}

export async function POST(req: Request) {
  const body = (await req.json()) as ExtractRequest;
  const lang: UiLang = body.lang === "en" ? "en" : "hi";
  const today = body.today ?? new Date().toISOString().slice(0, 10);
  const current = normalize(body.current ?? {});
  const turn = (body.turn ?? "").trim();

  try {
    // Correction: reopen one field instead of restarting the visit.
    if (CORRECTION_RE.test(turn)) {
      const field = body.lastFilled ?? body.expecting ?? null;
      if (field) {
        const visit = clearField(current, field);
        return NextResponse.json<ExtractResponse>({
          visit,
          missing: missingFields(visit),
          expecting: field,
          lastFilled: null,
          question: questionFor(field, lang),
          summary: null,
          reopened: field,
          complete: false,
          protocol: body.protocol ?? null,
          protocolLabel: body.protocol ? PROTOCOLS[body.protocol].label : null,
          protocolData: body.protocolData ?? {},
          protocolExpecting: null,
          missingProtocol: [],
        });
      }
    }

    // Step one: classify the visit once, on the first turn.
    const protocol = body.protocol ?? (await classifyVisit(turn));

    const before = filledFields(current);
    const [extracted, protocolExtracted] = await Promise.all([
      extractVisit(turn, today, { current, expecting: body.expecting ?? null }),
      extractProtocolData(turn, today, protocol, body.protocolData ?? {}, body.protocolExpecting ?? null),
    ]);

    const visit = mergeVisit(current, extracted);
    visit.visit_date ??= today;
    const protocolData = mergeProtocolData(body.protocolData ?? {}, protocolExtracted, body.protocolExpecting ?? null);

    // Never ask a registered patient for something already on file.
    if (body.patientId) {
      const patient = await getPatient(body.patientId);
      if (patient?.date_of_birth && protocolData.date_of_birth == null) protocolData.date_of_birth = patient.date_of_birth;
      if (patient?.expected_delivery_date && protocolData.expected_delivery_date == null) {
        protocolData.expected_delivery_date = patient.expected_delivery_date;
      }
      if (patient && !visit.patient_name) visit.patient_name = patient.name;
    }

    const newlyFilled = [...filledFields(visit)].filter((f) => !before.has(f));
    const lastFilled = newlyFilled.at(-1) ?? body.lastFilled ?? null;

    const missing = coreMissing(visit, protocol, protocolData);
    const missingProtocol = missingProtocolFields(protocol, protocolData);
    const complete = missing.length === 0 && missingProtocol.length === 0;

    // One question per turn: core identity fields first, then the protocol's own fields.
    const nextCore = missing[0] ?? null;
    const nextProtocol = nextCore ? null : missingProtocol[0] ?? null;
    const question = nextCore
      ? questionFor(nextCore, lang)
      : nextProtocol
        ? nextProtocol.question[lang]
        : null;

    return NextResponse.json<ExtractResponse>({
      visit,
      missing,
      expecting: nextCore,
      lastFilled,
      question,
      summary: complete ? summaryLine(visit, lang) : null,
      reopened: null,
      complete,
      protocol,
      protocolLabel: PROTOCOLS[protocol].label,
      protocolData,
      protocolExpecting: nextProtocol?.key ?? null,
      missingProtocol: missingProtocol.map((f) => f.key),
    });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}
