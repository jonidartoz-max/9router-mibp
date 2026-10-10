// GET /api/web-health
//
// Exposes the per-account pacing/health ledger maintained by
// open-sse/executors/webPacer.js. Credentials are hashed inside the pacer, so
// this endpoint only ever returns short account fingerprints — never a cookie
// or session token.
//
// Use it to spot an account heading toward trouble BEFORE it is suspended:
//   * status "ok"          — healthy
//   * status "rate_limited"— hit 429; cooling down
//   * status "auth_failed" — cookie/session expired; re-paste it
//   * status "suspended"   — upstream reported a suspension; parked
//
// Query: ?provider=deepseek-web  → filter to one provider.

import { NextResponse } from "next/server";
import { healthStatus } from "open-sse/executors/webPacer.js";

export const dynamic = "force-dynamic";

export async function GET(request) {
  const snap = healthStatus();
  const provider = new URL(request.url).searchParams.get("provider");

  let accounts = snap.accounts;
  if (provider) {
    accounts = Object.fromEntries(
      Object.entries(accounts).filter(([, v]) => v.provider === provider),
    );
  }

  return NextResponse.json({ ...snap, accounts }, {
    headers: { "Access-Control-Allow-Origin": "*" },
  });
}

export async function OPTIONS() {
  return new NextResponse(null, {
    status: 204,
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, OPTIONS",
      "Access-Control-Allow-Headers": "*",
    },
  });
}
