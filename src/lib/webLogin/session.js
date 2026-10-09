// In-memory registry of live "login with browser" sessions.
//
// A session spans several HTTP requests (start → poll → capture → close), so the
// browser process and its CDP connection have to outlive a single route handler.
// State is intentionally process-local: the browser runs on this machine, and a
// restart just means the user clicks Login again.

import { randomUUID } from "node:crypto";
import {
  launchBrowser,
  connectCdp,
  findFreePort,
  profileDir,
  sleep,
  listPageTargets,
  attachToTarget,
} from "./browser.js";
import { siteFor } from "./sites.js";

const sessions = new Map();
const SESSION_TTL_MS = 15 * 60 * 1000;

// Hosts that mean "the user is off doing the sign-in dance somewhere else" (an
// OAuth popup or a same-tab redirect). While the tab sits here we cannot probe
// the app, so we tell the UI to keep waiting instead of reporting "not logged in".
const LOGIN_HOSTS = [
  "accounts.google.com",
  "appleid.apple.com",
  "login.microsoftonline.com",
  "login.live.com",
  "x.com/i/oauth",
  "twitter.com/i/oauth",
  "accounts.x.ai",
];

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

// The tab currently showing the provider's own site (not an OAuth popup).
async function findSiteTab(session) {
  const site = siteFor(session.provider);
  const hosts = site?.hosts || [];
  const targets = await listPageTargets(session.port);
  return targets.find((t) => hosts.some((h) => (t.url || "").includes(h))) || null;
}

// Check whether the user has signed in yet. Never navigates: the tab belongs to
// the user mid-login, and moving it can cancel the flow — which is exactly what
// broke "Log in with Google" before (the probe yanked the tab back to the site).
export async function checkSession(session) {
  const site = siteFor(session.provider);
  if (!site) return { loggedIn: false, error: "Unknown provider" };

  let targets = [];
  try {
    targets = await listPageTargets(session.port);
  } catch (e) {
    return { loggedIn: false, error: e.message };
  }

  const hosts = site.hosts || [];
  const siteTab = targets.find((t) => hosts.some((h) => (t.url || "").includes(h)));

  if (siteTab) {
    try {
      const cdp = await attachToTarget(siteTab.webSocketDebuggerUrl);
      const value = await cdp.evalNow(site.probe);
      cdp.close();
      return { loggedIn: !!value, origin: siteTab.url };
    } catch (e) {
      return { loggedIn: false, error: e.message, origin: siteTab.url };
    }
  }

  // No tab on the site: the user is on an OAuth popup / redirect page.
  const loginTab = targets.find((t) => LOGIN_HOSTS.some((h) => (t.url || "").includes(h)));
  if (loginTab) {
    return { loggedIn: false, needsHuman: true, on: loginTab.url };
  }

  return { loggedIn: false, closed: targets.length === 0 };
}

export async function captureSession(session) {
  const site = siteFor(session.provider);
  if (!site) return { error: "Unknown provider" };

  const siteTab = await findSiteTab(session);
  if (!siteTab) {
    return {
      error:
        "The browser tab for this site is gone (or you are still on a sign-in page). " +
        "Reopen the site, finish signing in, then click Capture again.",
    };
  }

  const cdp = await attachToTarget(siteTab.webSocketDebuggerUrl);
  const ctx = {
    // Evaluate in the tab as it is — never navigate away from a live session.
    eval: (expression) => cdp.evalNow(expression),
    getCookies: (url) => cdp.getCookies(url),
    navigate: (url) => cdp.navigate(url),
  };

  try {
    const result = await site.capture(ctx);
    session.lastStatus = result;
    return result;
  } finally {
    cdp.close();
  }
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
