// In-memory registry of live "login with browser" sessions.
//
// A session spans several HTTP requests (start → poll → capture → close), so the
// browser process and its CDP connection have to outlive a single route handler.
// State is intentionally process-local: the browser runs on this machine, and a
// restart just means the user clicks Login again.

import { randomUUID } from "node:crypto";
import { launchBrowser, connectCdp, findFreePort, profileDir, sleep } from "./browser.js";
import { siteFor } from "./sites.js";

const sessions = new Map();
const SESSION_TTL_MS = 15 * 60 * 1000;

function sweep() {
  const now = Date.now();
  for (const [id, s] of sessions) {
    if (now - s.startedAt > SESSION_TTL_MS) closeSession(id).catch(() => {});
  }
}

export function getSession(id) {
  return sessions.get(id) || null;
}

export async function startSession(provider) {
  sweep();
  const site = siteFor(provider);
  if (!site) {
    const err = new Error(`No browser login flow for provider "${provider}"`);
    err.code = "NO_SITE";
    throw err;
  }

  const port = await findFreePort();
  const { exe } = launchBrowser({ port, startUrl: site.loginUrl });

  let cdp;
  try {
    cdp = await connectCdp(port);
  } catch (e) {
    throw new Error(`Could not attach to the browser: ${e.message}`);
  }

  const id = randomUUID();
  const session = {
    id,
    provider,
    port,
    cdp,
    exe,
    profile: profileDir(),
    startedAt: Date.now(),
    lastStatus: null,
  };
  sessions.set(id, session);
  return session;
}

// Check whether the user has signed in on the site's origin yet.
export async function checkSession(session) {
  const site = siteFor(session.provider);
  if (!site) return { loggedIn: false, error: "Unknown provider" };
  try {
    const origin = new URL(site.loginUrl).origin;
    const onSite = (await session.cdp.currentOrigin()).includes(new URL(site.loginUrl).hostname);
    let value = null;
    if (onSite) {
      value = await session.cdp.evalOn(null, site.probe);
    } else {
      value = await session.cdp.evalOn(origin + "/", site.probe);
    }
    return { loggedIn: !!value, origin: await session.cdp.currentOrigin() };
  } catch (e) {
    return { loggedIn: false, error: e.message };
  }
}

export async function captureSession(session) {
  const site = siteFor(session.provider);
  if (!site) return { error: "Unknown provider" };

  const origin = new URL(site.loginUrl).origin;
  const ctx = {
    eval: (expression, url = null) => session.cdp.evalOn(url ?? origin + "/", expression),
    getCookies: (url) => session.cdp.getCookies(url),
    navigate: (url) => session.cdp.navigate(url),
  };

  const result = await site.capture(ctx);
  session.lastStatus = result;
  return result;
}

export async function closeSession(id) {
  const s = sessions.get(id);
  if (!s) return false;
  sessions.delete(id);
  try {
    // Ask the browser to exit cleanly; it shares our profile dir.
    const v = await fetch(`http://127.0.0.1:${s.port}/json/version`).then((r) => r.json());
    if (v?.webSocketDebuggerUrl) {
      const ws = new WebSocket(v.webSocketDebuggerUrl);
      await new Promise((res) => {
        const t = setTimeout(res, 1500);
        ws.addEventListener("open", () => {
          ws.send(JSON.stringify({ id: 1, method: "Browser.close", params: {} }));
          setTimeout(() => {
            clearTimeout(t);
            res();
          }, 400);
        });
        ws.addEventListener("error", () => {
          clearTimeout(t);
          res();
        });
      });
      ws.close();
    }
  } catch {
    /* browser may already be gone */
  }
  try {
    s.cdp.close();
  } catch {
    /* ignore */
  }
  await sleep(200);
  return true;
}

export async function closeAll() {
  for (const id of [...sessions.keys()]) await closeSession(id).catch(() => {});
}
