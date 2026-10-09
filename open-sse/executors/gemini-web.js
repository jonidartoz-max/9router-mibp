// Gemini Web (gemini.google.com) — chat2api executor.
//
// Protocol (reverse-engineered, 2026-10):
//   Gemini's web app talks to Google's `batchexecute` RPC. Anonymous use works
//   for the default Flash model; a signed-in cookie is needed for Pro/thinking
//   and the real model catalog.
//
//   1. GET /app (with cookie) → scrape `SNlM0e` (XSRF `at` token), `cfb2h` (build
//      label `bl`), `FdrFJe` (session id `f.sid`).
//   2. POST /_/BardChatUi/data/assistant.lamda.BardFrontendService/StreamGenerate
//        ?bl=<bl>&f.sid=<sid>&hl=en&_reqid=<n>&rt=c
//      form body: f.req=[[[null, JSON.stringify(payload)]]] & at=<SNlM0e>
//      payload is the 100+ slot nested array; index 0 = [prompt, 0, null, ...],
//      index 79 selects the model/mode category.
//   3. Response: length-prefixed frames (`)]}'` anti-XSSI prefix, then
//      "{len}\n{json}" chunks). Answer text lives deep in the wrb.fr envelope.
//
// Auth: paste the cookie string ("SID=…; HSID=…; __Secure-1PSID=…; …"). Without
// it, anonymous Flash still works. Model routing needs the cookie.

import { BaseExecutor } from "./base.js";
import { PROVIDERS } from "../config/providers.js";
import {
  parseOpenAIMessages,
  formatToolsHint,
  TOOL_RESULT_FOLLOWUP,
  endsWithToolResult,
  jsonError,
  badRequest,
  buildStreamingResponse,
  buildNonStreamingResponse,
} from "./webChatShared.js";

const BASE = "https://gemini.google.com";
const APP = `${BASE}/app`;
const STREAM_GEN = `${BASE}/_/BardChatUi/data/assistant.lamda.BardFrontendService/StreamGenerate`;
const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36";

// model slug → MODE_CATEGORY value (field [79]): 1=fast, 2=thinking, 3=pro
const MODEL_MAP = {
  "gemini-3.8-flash": 1,
  "gemini-3.6-flash": 1,
  "gemini-3.1-pro": 3,
  "gemini-pro": 3,
  "gemini-2.5-pro": 3,
};

let reqCounter = 100000;
const TOKEN_CACHE = new Map(); // cookie string → { at, bl, sid, ts }
const TOKEN_TTL_MS = 30 * 60 * 1000;

function cookieHeader(raw) {
  const s = String(raw || "").trim();
  if (!s) return "";
  if (s.includes("=")) return s; // already "k=v; k=v"
  return `__Secure-1PSID=${s}`;
}

async function fetchPageTokens(cookie, signal, log) {
  const cached = TOKEN_CACHE.get(cookie);
  if (cached && Date.now() - cached.ts < TOKEN_TTL_MS) return cached;
  const res = await fetch(APP, {
    headers: {
      "User-Agent": UA,
      "Accept-Language": "en-US,en;q=0.9",
      ...(cookie ? { Cookie: cookie } : {}),
    },
    signal,
  });
  const html = await res.text();
  const pick = (key) => html.match(new RegExp(`"${key}":"([^"]+)"`))?.[1] || null;
  const tokens = { at: pick("SNlM0e"), bl: pick("cfb2h"), sid: pick("FdrFJe"), ts: Date.now() };
  if (!tokens.at) log?.warn?.("GEMINI-WEB", "SNlM0e not found — proceeding anonymously (Flash only)");
  TOKEN_CACHE.set(cookie, tokens);
  return tokens;
}

// Build the nested f.req payload array for a single-turn prompt.
function buildPayload(prompt, modeCategory) {
  const inner = new Array(80).fill(null);
  inner[0] = [prompt, 0, null, null, null, null, 0];
  inner[1] = ["en"];
  inner[2] = ["", "", "", null, null, null, null, null, null, ""];
  inner[6] = [0];
  inner[7] = 1;
  inner[10] = 1;
  inner[11] = 0;
  inner[17] = [[0]];
  inner[18] = 0;
  inner[27] = 1;
  inner[30] = [4];
  inner[41] = [1];
  inner[53] = 0;
  inner[59] = crypto.randomUUID();
  inner[61] = [];
  inner[68] = 1;
  inner[79] = modeCategory;
  return inner;
}

function parseFrames(raw) {
  const texts = [];
  // strip anti-XSSI prefix
  let body = raw.startsWith(")]}'") ? raw.slice(raw.indexOf("\n") + 1) : raw;
  // length-prefixed frames: {len}\n{json}
  let i = 0;
  while (i < body.length) {
    const nl = body.indexOf("\n", i);
    if (nl < 0) break;
    const len = parseInt(body.slice(i, nl), 10);
    if (!Number.isFinite(len)) { i = nl + 1; continue; }
    const chunk = body.slice(nl + 1, nl + 1 + len);
    i = nl + 1 + len + 1;
    const frames = chunk.split("\n").filter(Boolean);
    for (const f of frames) {
      try {
        const arr = JSON.parse(f);
        // wrb.fr envelope: [ "wrb.fr", rpcid, innerJsonString, ... ]
        for (const item of arr) {
          if (Array.isArray(item) && item[0] === "wrb.fr" && typeof item[2] === "string") {
            texts.push(item[2]);
          }
        }
      } catch { /* partial frame */ }
    }
  }
  return texts;
}

// Pull candidate answer strings out of the deeply nested inner JSON.
function extractTexts(innerJson) {
  const out = [];
  let parsed;
  try { parsed = JSON.parse(innerJson); } catch { return out; }
  const walk = (node, depth) => {
    if (depth > 8 || node == null) return;
    if (typeof node === "string") { if (node.length > 0) out.push(node); return; }
    if (Array.isArray(node)) { for (const c of node) walk(c, depth + 1); }
  };
  walk(parsed, 0);
  return out;
}

async function* streamGemini(prompt, modeCategory, cookie, signal, log) {
  let tokens;
  try {
    tokens = await fetchPageTokens(cookie, signal, log);
  } catch (err) {
    yield { error: `Gemini page fetch failed: ${err.message || String(err)}` };
    return;
  }

  reqCounter += 100000;
  const url = `${STREAM_GEN}?bl=${encodeURIComponent(tokens.bl || "")}&f.sid=${encodeURIComponent(tokens.sid || "")}&hl=en&_reqid=${reqCounter}&rt=c`;
  const innerPayload = buildPayload(prompt, modeCategory);
  const fReq = JSON.stringify([[["", JSON.stringify(innerPayload), null, "generic"]]]);

  const body = new URLSearchParams();
  body.set("f.req", fReq);
  if (tokens.at) body.set("at", tokens.at);

  let res;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8",
        "User-Agent": UA,
        Origin: BASE,
        Referer: APP,
        "X-Same-Domain": "1",
        ...(cookie ? { Cookie: cookie } : {}),
      },
      body: body.toString(),
      signal,
    });
  } catch (err) {
    yield { error: `Gemini connection failed: ${err.message || String(err)}` };
    return;
  }

  if (!res.ok) {
    yield { error: `Gemini returned HTTP ${res.status}${res.status === 401 || res.status === 403 ? " — cookie may be expired" : ""}` };
    return;
  }

  const raw = await res.text();
  const frames = parseFrames(raw);
  const seen = new Set();
  for (const frame of frames) {
    for (const text of extractTexts(frame)) {
      // heuristic: skip structural/short tokens; keep prose-like strings
      if (text.length < 2 || /^[A-Za-z0-9_-]{1,6}$/.test(text)) continue;
      if (seen.has(text)) continue;
      seen.add(text);
      yield { delta: text };
    }
  }
  yield { done: true };
}

export class GeminiWebExecutor extends BaseExecutor {
  constructor() {
    super("gemini-web", PROVIDERS["gemini-web"]);
  }

  async execute({ model, body, stream, credentials, signal, log }) {
    const messages = body?.messages;
    if (!Array.isArray(messages) || messages.length === 0) {
      return { response: badRequest("Missing or empty messages array"), url: STREAM_GEN, headers: {}, transformedBody: body };
    }

    const cookie = cookieHeader(credentials?.apiKey || credentials?.accessToken || "");
    const modeCategory = MODEL_MAP[model] ?? 1;

    const parsed = parseOpenAIMessages(messages);
    let prompt = parsed.flatPrompt;
    const toolsHint = formatToolsHint(body?.tools);
    if (toolsHint) prompt += toolsHint;
    if (endsWithToolResult(parsed.items)) prompt += TOOL_RESULT_FOLLOWUP;
    if (!prompt.trim()) {
      return { response: badRequest("Empty query after processing"), url: STREAM_GEN, headers: {}, transformedBody: body };
    }

    log?.info?.("GEMINI-WEB", `Query ${model} (mode=${modeCategory}, auth=${cookie ? "cookie" : "anon"}), len=${prompt.length}`);

    const gen = streamGemini(prompt, modeCategory, cookie, signal, log);
    if (stream) {
      const { response: sseResponse } = buildStreamingResponse(gen, model, signal, body?.tools);
      return { response: sseResponse, url: STREAM_GEN, headers: {}, transformedBody: body };
    }
    const finalResponse = await buildNonStreamingResponse(gen, model, signal, body?.tools);
    return { response: finalResponse, url: STREAM_GEN, headers: {}, transformedBody: body };
  }
}

export default GeminiWebExecutor;
