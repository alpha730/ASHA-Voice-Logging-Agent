import type { Metadata } from "next";
import { notFound } from "next/navigation";
import rawCounselling from "@/counselling.json";
import rawProtocol from "@/imnci-sick-child-2m-5y.json";
import type { CounsellingFile } from "@/lib/imnci/counselling";
import { reviewItems } from "@/lib/imnci/review";
import type { ImnciProtocol } from "@/lib/imnci/rules";
import { ReviewForm } from "./ReviewForm";

// Read REVIEW_ENABLED on every request, not once at build time.
export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Clinician review", robots: { index: false, follow: false } };

/** Clinician review of the IMNCI rules and advice. Not linked anywhere; 404 unless REVIEW_ENABLED=true. */
export default function ReviewPage() {
  if (process.env.REVIEW_ENABLED !== "true") notFound();
  const protocol = rawProtocol as unknown as ImnciProtocol;
  const counselling = rawCounselling as unknown as CounsellingFile;
  return (
    <ReviewForm
      items={reviewItems(protocol, counselling)}
      protocolVersion={protocol.version}
      counsellingVersion={(counselling as unknown as { version: string }).version}
      source={`${protocol.source.title}${protocol.source.edition ? ` (${protocol.source.edition})` : ""}`}
    />
  );
}
