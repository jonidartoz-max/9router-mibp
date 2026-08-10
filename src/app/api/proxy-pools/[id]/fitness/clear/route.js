import { NextResponse } from "next/server";
import { clearPoolUnfit } from "open-sse/services/proxyPoolFitness.js";

// POST /api/proxy-pools/[id]/fitness/clear
// Body: { scope: "provider::model" } — clears the mark for this pool + scope.
export async function POST(request, { params }) {
  try {
    const { id } = await params;
    let body = {};
    try {
      body = await request.json();
    } catch {
      body = {};
    }
    const scope = typeof body?.scope === "string" ? body.scope.trim() : "";
    if (!id || !scope) {
      return NextResponse.json({ error: "pool id and scope are required" }, { status: 400 });
    }
    clearPoolUnfit(id, scope);
    return NextResponse.json({ ok: true, poolId: id, scope });
  } catch (error) {
    console.log("Error clearing pool fitness:", error);
    return NextResponse.json({ error: "Failed to clear pool fitness" }, { status: 500 });
  }
}