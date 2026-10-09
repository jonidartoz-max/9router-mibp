import { NextResponse } from "next/server";
import { startSession, getSession, checkSession, captureSession, closeSession } from "@/lib/webLogin/session.js";
import { findBrowser, profileDir } from "@/lib/webLogin/browser.js";
import { siteFor, isWebLoginProvider, WEB_LOGIN_SITES } from "@/lib/webLogin/sites.js";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET /api/providers/weblogin            -> which providers support browser login
// GET /api/providers/weblogin?session=X  -> poll a session's sign-in state
export async function GET(request) {
  const { searchParams } = new URL(request.url);
  const id = searchParams.get("session");

  if (!id) {
    return NextResponse.json({
      supported: Object.keys(WEB_LOGIN_SITES),
      browser: findBrowser(),
      profile: profileDir(),
    });
  }

  const session = getSession(id);
  if (!session) {
    return NextResponse.json({ error: "Session not found or expired" }, { status: 404 });
  }
  const status = await checkSession(session);
  return NextResponse.json({ session: id, provider: session.provider, ...status });
}

// POST /api/providers/weblogin  { action, provider?, session? }
export async function POST(request) {
  let body;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const action = body?.action;

  try {
    if (action === "start") {
      const provider = body.provider;
      if (!isWebLoginProvider(provider)) {
        return NextResponse.json({ error: `"${provider}" does not support browser login` }, { status: 400 });
      }
      if (!findBrowser()) {
        return NextResponse.json(
          {
            error:
              "No Chromium browser found (Chrome / Edge / Brave / Chromium). Install one, or paste the cookie manually.",
          },
          { status: 400 },
        );
      }
      const session = await startSession(provider);
      return NextResponse.json({
        session: session.id,
        provider,
        loginUrl: siteFor(provider).loginUrl,
        profile: session.profile,
      });
    }

    if (action === "capture") {
      const session = getSession(body.session);
      if (!session) return NextResponse.json({ error: "Session not found or expired" }, { status: 404 });
      const result = await captureSession(session);
      if (result?.error) return NextResponse.json({ error: result.error }, { status: 400 });
      return NextResponse.json(result);
    }

    if (action === "close") {
      const ok = await closeSession(body.session);
      return NextResponse.json({ closed: ok });
    }

    return NextResponse.json({ error: `Unknown action "${action}"` }, { status: 400 });
  } catch (e) {
    return NextResponse.json({ error: e?.message || String(e) }, { status: 500 });
  }
}
