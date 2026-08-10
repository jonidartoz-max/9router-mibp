import { NextResponse } from "next/server";
import { poolFitnessSnapshot } from "open-sse/services/proxyPoolFitness.js";

// GET /api/proxy-pools/fitness — in-memory snapshot of pool fitness marks.
// Returns { pools: { [poolId]: { [scope]: { until, reason } } } }.
export async function GET() {
  try {
    return NextResponse.json({ pools: poolFitnessSnapshot() });
  } catch (error) {
    console.log("Error reading proxy fitness:", error);
    return NextResponse.json({ error: "Failed to read proxy fitness" }, { status: 500 });
  }
}