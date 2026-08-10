import { NextResponse } from "next/server";
import { clearAllPoolUnfit } from "open-sse/services/proxyPoolFitness.js";

// POST /api/proxy-pools/fitness/clear-all
// Body: { provider?: string } — clears every mark, or only marks scoped to the
// given provider ("provider::*") when provided.
export async function POST(request) {
  try {
    let body = {};
    try {
      body = await request.json();
    } catch {
      body = {};
    }
    const provider = typeof body?.provider === "string" && body.provider.trim() ? body.provider.trim() : null;
    clearAllPoolUnfit(provider);
    return NextResponse.json({ ok: true, provider: provider || null });
  } catch (error) {
    console.log("Error clearing proxy fitness:", error);
    return NextResponse.json({ error: "Failed to clear proxy fitness" }, { status: 500 });
  }
}