import { NextResponse } from "next/server";
import { deleteVisit, updateVisit, type NewVisit } from "@/lib/db";
import { normalize } from "@/lib/extraction";
import { missingFields } from "@/types/visit";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

export async function PATCH(req: Request, { params }: Params) {
  const { id } = await params;
  const body = await req.json();
  const patch: Partial<NewVisit> = {};
  if (body.visit) {
    const v = normalize(body.visit);
    Object.assign(patch, v, { status: missingFields(v).length ? "needs_follow_up" : "complete" });
  }
  if (typeof body.raw_transcript === "string") patch.raw_transcript = body.raw_transcript;
  if (["complete", "needs_follow_up", "flagged_for_review"].includes(body.status)) patch.status = body.status;
  try {
    const visit = await updateVisit(id, patch);
    if (!visit) return NextResponse.json({ error: "Not found" }, { status: 404 });
    return NextResponse.json({ visit });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}

export async function DELETE(_req: Request, { params }: Params) {
  const { id } = await params;
  try {
    const ok = await deleteVisit(id);
    return ok ? new NextResponse(null, { status: 204 }) : NextResponse.json({ error: "Not found" }, { status: 404 });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}
