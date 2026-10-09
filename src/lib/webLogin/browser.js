// Browser launcher + a tiny Chrome DevTools Protocol client.
//
// Powers the "login with browser" flow for webCookie (chat2api) providers: we
// open the user's real Chromium browser on the site's login page, let them sign
// in normally (password, Google, 2FA — whatever the site wants), then read the
// resulting cookies + localStorage over CDP. No password or code ever passes
// through 9Router or through the chat.
//
// The profile lives under DATA_DIR/weblogin-profile so a login survives between
// runs: the next time you click "Login" the session is usually already there and
// the credential is captured in a second or two.

import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { spawn } from "node:child_process";
import { getDataDir } from "@/lib/dataDir.js";

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function candidates() {
  if (process.platform === "win32") {
    const pf = process.env["ProgramFiles"] || "C:\\Program Files";
    const pf86 = process.env["ProgramFiles(x86)"] || "C:\\Program Files (x86)";
    const local = process.env["LOCALAPPDATA"] || "";
    return [
      path.join(pf, "Google", "Chrome", "Application", "chrome.exe"),
      path.join(pf86, "Google", "Chrome", "Application", "chrome.exe"),
      local && path.join(local, "Google", "Chrome", "Application", "chrome.exe"),
      path.join(pf86, "Microsoft", "Edge", "Application", "msedge.exe"),
      path.join(pf, "Microsoft", "Edge", "Application", "msedge.exe"),
    ].filter(Boolean);
  }
  if (process.platform === "darwin") {
    return [
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
      "/Applications/Chromium.app/Contents/MacOS/Chromium",
      "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
    ];
  }
  return [
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    "/usr/bin/microsoft-edge",
    "/usr/bin/microsoft-edge-stable",
    "/snap/bin/chromium",
    "/usr/bin/brave-browser",
  ];
}

export function findBrowser() {
  for (const p of candidates()) {
    try {
      if (p && fs.existsSync(p)) return p;
    } catch {
      /* ignore */
    }
  }
  return null;
}

export function findFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

export function profileDir() {
  return path.join(getDataDir(), "weblogin-profile");
}

// Launch a detached browser with a debugging port. Returns the child process.
export function launchBrowser({ port, startUrl }) {
  const exe = findBrowser();
  if (!exe) {
    const err = new Error(
      "No Chromium browser (Chrome/Edge/Brave/Chromium) found on this machine. " +
        "Install one, or paste the cookie manually instead.",
    );
    err.code = "NO_BROWSER";
    throw err;
  }
  const dir = profileDir();
  fs.mkdirSync(dir, { recursive: true });

  const args = [
    `--remote-debugging-port=${port}`,
    `--remote-allow-origins=*`,
    `--user-data-dir=${dir}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-features=Translate,MediaRouter",
    "--disable-background-networking",
    "--disable-component-update",
    "--new-window",
    startUrl,
  ];
  const child = spawn(exe, args, { detached: true, stdio: "ignore" });
  child.unref();
  return { child, exe };
}

class CdpConnection {
  constructor(ws) {
    this.ws = ws;
    this.seq = 0;
    this.pending = new Map();
    ws.addEventListener("message", (ev) => {
      let msg;
      try {
        msg = JSON.parse(ev.data);
      } catch {
        return;
      }
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        resolve(msg);
      }
    });
  }

  send(method, params = {}, timeoutMs = 15000) {
    return new Promise((resolve, reject) => {
      const id = ++this.seq;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP timeout: ${method}`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (m) => {
          clearTimeout(timer);
          resolve(m);
        },
      });
      try {
        this.ws.send(JSON.stringify({ id, method, params }));
      } catch (e) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(e);
      }
    });
  }

  async navigate(url) {
    await this.send("Page.navigate", { url });
    await sleep(600);
  }

  async currentOrigin() {
    try {
      const r = await this.send("Runtime.evaluate", {
        expression: "location.origin",
        returnByValue: true,
      });
      return r?.result?.result?.value || "";
    } catch {
      return "";
    }
  }

  // Evaluate an expression in the page, navigating to `url` first when the tab
  // is not already on that origin (localStorage is origin-scoped).
  async evalOn(url, expression) {
    if (url) {
      const origin = new URL(url).origin;
      if ((await this.currentOrigin()) !== origin) {
        await this.navigate(url);
        await sleep(500);
      }
    }
    const r = await this.send("Runtime.evaluate", {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    if (r?.result?.exceptionDetails) return null;
    return r?.result?.result?.value ?? null;
  }

  async getCookies(url) {
    const r = await this.send("Network.getCookies", url ? { urls: [url] } : {});
    return r?.result?.cookies || [];
  }

  close() {
    try {
      this.ws.close();
    } catch {
      /* ignore */
    }
  }
}

// Wait for the debugging port to come up and attach to the first page target.
export async function connectCdp(port, { timeoutMs = 25000 } = {}) {
  const base = `http://127.0.0.1:${port}`;
  const t0 = Date.now();
  let version = null;
  while (Date.now() - t0 < timeoutMs) {
    try {
      const r = await fetch(`${base}/json/version`);
      if (r.ok) {
        version = await r.json();
        break;
      }
    } catch {
      /* not up yet */
    }
    await sleep(350);
  }
  if (!version) throw new Error("Browser did not expose its debugging port");

  let target = null;
  while (Date.now() - t0 < timeoutMs) {
    try {
      const r = await fetch(`${base}/json/list`);
      const targets = await r.json();
      target = targets.find((t) => t.type === "page" && t.webSocketDebuggerUrl);
      if (target) break;
    } catch {
      /* ignore */
    }
    await sleep(350);
  }
  if (!target) throw new Error("No page target in browser");

  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("CDP websocket timeout")), 10000);
    ws.addEventListener("open", () => {
      clearTimeout(timer);
      resolve();
    });
    ws.addEventListener("error", (e) => {
      clearTimeout(timer);
      reject(new Error("CDP websocket error" + (e?.message ? `: ${e.message}` : "")));
    });
  });

  return new CdpConnection(ws);
}
