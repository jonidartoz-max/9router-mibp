// DeepSeek Web (chat.deepseek.com) — chat2api executor.
//
// Turns a logged-in DeepSeek web session into an OpenAI-compatible chat provider.
// Protocol (reverse-engineered, 2026-10):
//   1. POST /api/v0/chat_session/create { agent: "chat" }        → { data.biz_data.id }
//   2. POST /api/v0/chat/create_pow_challenge { target_path }    → challenge (PoW)
//        solve: find n in [0,difficulty) with SHA3-256(`${salt}_${expire_at}_${n}`)
//        equal to `challenge`; header value is base64(JSON{...,answer:n}).
//        Node's built-in sha3-256 makes this ~40ms — no wasm needed.
//   3. POST /api/v0/chat/completion { chat_session_id, prompt, ... } with
//        x-ds-pow-response → SSE; each frame carries a JSON-patch style object
//        { p: "response/content" | "response/thinking_content", v: "<text>" }.
//
// Credentials: paste `userToken` (from localStorage) then the session cookie
// separated by "|" — "userToken|cookie". The cookie carries the AWS-WAF token the
// real browser earned. Either half may be omitted; the request degrades to
// bearer-only / cookie-only, which the server accepts for most accounts.

import crypto from "node:crypto";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { BaseExecutor } from "./base.js";
import { PROVIDERS } from "../config/providers.js";
import {
  SSE_HEADERS_NO_BUFFER,
  splitCredential,
  parseOpenAIMessages,
  formatToolsHint,
  TOOL_RESULT_FOLLOWUP,
  endsWithToolResult,
  jsonError,
  badRequest,
  buildStreamingResponse,
  buildNonStreamingResponse,
  readLines,
} from "./webChatShared.js";

const HOST = "chat.deepseek.com";
const BASE = `https://${HOST}`;
const CREATE_SESSION = `${BASE}/api/v0/chat_session/create`;
const CREATE_POW = `${BASE}/api/v0/chat/create_pow_challenge`;
const COMPLETION = `${BASE}/api/v0/chat/completion`;
const DELETE_SESSION = `${BASE}/api/v0/chat_session/delete`;

// --- Web-client headers (ported from xiaoY233/Chat2API) ---------------------
// The web endpoint fingerprints the client. The Android client headers that were
// used before got flagged ("Current device environment error"); the browser
// profile below is what the real chat.deepseek.com web app sends, so the server
// treats us as a normal web session.
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36";

const WEB_HEADERS = {
  Accept: "*/*",
  "Accept-Encoding": "gzip, deflate, br",
  "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8,en-GB;q=0.7,en-US;q=0.6",
  // Content-Type is REQUIRED: without it the API returns HTTP 422
  // {"detail":[{"loc":"body"}]} and the caller wrongly reports "token expired".
  "Content-Type": "application/json",
  Origin: BASE,
  Referer: `${BASE}/`,
  "Sec-Ch-Ua": '"Not/A)Brand";v="99", "Chromium";v="148"',
  "Sec-Ch-Ua-Mobile": "?0",
  "Sec-Ch-Ua-Platform": '"macOS"',
  "Sec-Fetch-Dest": "empty",
  "Sec-Fetch-Mode": "cors",
  "Sec-Fetch-Site": "same-origin",
  "User-Agent": UA,
  "X-App-Version": "2.0.0",
  "X-Client-Locale": "zh_CN",
  "X-Client-Platform": "web",
  "x-Client-Timezone-Offset": "28800",
  "X-Client-Version": "2.0.0",
};

const USERS_CURRENT = `${BASE}/api/v0/users/current`;

// token → { accessToken, expiresAt }. The localStorage `userToken` is a refresh
// credential: exchanging it at /users/current yields a short-lived access token.
const TOKEN_CACHE = new Map();

function randomHex(n) {
  return crypto.randomBytes(Math.ceil(n / 2)).toString("hex").slice(0, n);
}

function fakeUuid() {
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === "x" ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

// A browser session cookie invented on the spot. The real site earns a WAF
// cookie via JS, but the API only needs *a* well-formed one — this removes the
// requirement to hand-copy cookies out of DevTools.
function generateCookie() {
  const ts = Date.now();
  const s = Math.floor(ts / 1000);
  const h = randomHex(18);
  return [
    `intercom-HWWAFSESTIME=${ts}`,
    `HWWAFSESID=${h}`,
    `Hm_lvt_${fakeUuid()}=${s},${s},${s}`,
    `Hm_lpvt_${fakeUuid()}=${s}`,
    `_frid=${fakeUuid()}`,
    `_fr_ssid=${fakeUuid()}`,
    `_fr_pvid=${fakeUuid()}`,
  ].join("; ");
}

// Model slug → { thinking, search, modelType }. model_type is what the server
// expects ("default" | "expert") — NOT "chat"/"reasoner".
const MODEL_FLAGS = {
  "deepseek-chat": { thinking: false, search: false, modelType: "default" },
  "deepseek-v3": { thinking: false, search: false, modelType: "default" },
  "deepseek-reasoner": { thinking: true, search: false, modelType: "expert" },
  "deepseek-r1": { thinking: true, search: false, modelType: "expert" },
  "deepseek-chat-search": { thinking: false, search: true, modelType: "default" },
  "deepseek-v3-search": { thinking: false, search: true, modelType: "default" },
  "deepseek-reasoner-search": { thinking: true, search: true, modelType: "expert" },
  "deepseek-r1-search": { thinking: true, search: true, modelType: "expert" },
};

const POW_CACHE = new Map(); // challenge hex → nonce, avoids re-solving identical challenges

function baseHeaders() {
  return { ...WEB_HEADERS };
}

// Exchange the stored localStorage `userToken` for a fresh access token.
// The raw userToken works for a while, but the server also accepts it as a
// refresh credential here — refreshing keeps long sessions alive without the
// user re-pasting anything.
async function refreshAccessToken(userToken, signal, log) {
  const cached = TOKEN_CACHE.get(userToken);
  const now = Math.floor(Date.now() / 1000);
  if (cached && cached.expiresAt > now + 60) return cached.accessToken;

  try {
    const res = await fetch(USERS_CURRENT, {
      method: "GET",
      headers: { ...WEB_HEADERS, Authorization: `Bearer ${userToken}` },
      signal,
    });
    if (!res.ok) return userToken;
    const data = await res.json().catch(() => null);
    const fresh = data?.data?.biz_data?.token;
    if (fresh && typeof fresh === "string") {
      TOKEN_CACHE.set(userToken, { accessToken: fresh, expiresAt: now + 3600 });
      log?.info?.("DEEPSEEK-WEB", "Access token refreshed via /users/current");
      return fresh;
    }
  } catch (err) {
    log?.warn?.("DEEPSEEK-WEB", `Token refresh skipped: ${err.message || String(err)}`);
  }
  return userToken;
}

// Merge consecutive same-role turns and tag non-final turns, mirroring the app.
function buildPrompt(items) {
  const merged = [];
  for (const m of items) {
    const role = m.role === "assistant" ? "assistant" : m.role === "system" ? "system" : "user";
    if (merged.length && merged[merged.length - 1].role === role) {
      merged[merged.length - 1].text += `\n\n${m.content}`;
    } else {
      merged.push({ role, text: m.content });
    }
  }
  return merged
    .map((m, i) => (i === 0 ? m.text : `${m.role === "assistant" ? "Assistant" : "User"}: ${m.text}`))
    .join("\n\n");
}

// --- Proof of Work: official DeepSeekHash WASM -------------------------------
// The challenge is NOT a plain SHA3-256 preimage search — the server validates a
// hash the official `sha3_wasm_bg.wasm` computes. A naive SHA3 loop returns
// INVALID_POW_RESPONSE (40301). This loads the real module once and reuses it.
const WASM_PATH = fileURLToPath(new URL("./sha3_wasm_bg.wasm", import.meta.url));

let wasmExports = null;
let wasmMem = null;
let wasmOffset = 0;

async function loadWasm() {
  if (wasmExports) return wasmExports;
  const bytes = fs.readFileSync(WASM_PATH);
  const { instance } = await WebAssembly.instantiate(bytes, { wbg: {} });
  wasmExports = instance.exports;
  return wasmExports;
}

function wasmGetMem() {
  if (!wasmMem || wasmMem.byteLength === 0) wasmMem = new Uint8Array(wasmExports.memory.buffer);
  return wasmMem;
}

function wasmEncode(text) {
  const enc = new TextEncoder().encode(text);
  const ptr = wasmExports.__wbindgen_export_0(enc.length, 1) >>> 0;
  wasmGetMem().subarray(ptr, ptr + enc.length).set(enc);
  wasmOffset = enc.length;
  return ptr;
}

function wasmSolve(challenge, salt, expireAt, difficulty) {
  const prefix = `${salt}_${expireAt}_`;
  const retptr = wasmExports.__wbindgen_add_to_stack_pointer(-16);
  const p0 = wasmEncode(challenge);
  const l0 = wasmOffset;
  const p1 = wasmEncode(prefix);
  const l1 = wasmOffset;
  wasmExports.wasm_solve(retptr, p0, l0, p1, l1, difficulty);
  const dv = new DataView(wasmExports.memory.buffer);
  const status = dv.getInt32(retptr + 0, true);
  const value = dv.getFloat64(retptr + 8, true);
  wasmExports.__wbindgen_add_to_stack_pointer(16);
  return status === 0 ? null : value;
}

async function solvePow(challenge, salt, expireAt, difficulty) {
  const key = `${challenge}:${salt}:${expireAt}`;
  if (POW_CACHE.has(key)) return POW_CACHE.get(key);
  await loadWasm();
  const answer = wasmSolve(challenge, salt, expireAt, difficulty);
  if (answer !== null && answer !== undefined) POW_CACHE.set(key, answer);
  return answer;
}

async function getPowHeader(authHeaders, signal, log) {
  const res = await fetch(CREATE_POW, {
    method: "POST",
    headers: authHeaders,
    body: JSON.stringify({ target_path: "/api/v0/chat/completion" }),
    signal,
  });
  const data = await res.json().catch(() => ({}));
  const ch = data?.data?.biz_data?.challenge;
  if (!ch?.challenge) {
    log?.warn?.("DEEPSEEK-WEB", "PoW challenge missing; sending request without proof");
    return null;
  }
  const answer = await solvePow(ch.challenge, ch.salt, ch.expire_at, ch.difficulty);
  if (answer === null || answer === undefined) {
    log?.warn?.("DEEPSEEK-WEB", "PoW could not be solved; sending request without proof");
    return null;
  }
  const payload = {
    algorithm: ch.algorithm || "DeepSeekHashV1",
    challenge: ch.challenge,
    salt: ch.salt,
    answer,
    signature: ch.signature,
    target_path: ch.target_path || "/api/v0/chat/completion",
  };
  log?.info?.("DEEPSEEK-WEB", `PoW solved (answer=${answer})`);
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64");
}

async function createSession(authHeaders, signal) {
  const res = await fetch(CREATE_SESSION, {
    method: "POST",
    headers: authHeaders,
    body: JSON.stringify({ agent: "chat" }),
    signal,
  });
  const text = await res.text().catch(() => "");
  let data = {};
  try { data = JSON.parse(text); } catch {}
  // Shape: { data: { biz_data: { chat_session: { id } } } } — the id is nested
  // under chat_session, NOT directly under biz_data.
  const id = data?.data?.biz_data?.chat_session?.id || null;
  if (!id) {
    // Surface the real reason instead of blaming the token for every failure.
    const detail = data?.data?.biz_msg || data?.detail || text.slice(0, 160) || `HTTP ${res.status}`;
    const err = new Error(`session create HTTP ${res.status}: ${typeof detail === "string" ? detail : JSON.stringify(detail)}`);
    err.status = res.status;
    throw err;
  }
  return id;
}

// Parse the JSON-patch SSE stream.
// The response is a list of fragments, each with a type. Content deltas are sent
// as `response/fragments/-1/content` — the `-1` means "the LAST fragment", so we
// must track fragment types to know whether a chunk is reasoning or the answer:
//   THINK    → reasoning_content
//   RESPONSE → content
//   SEARCH   → web-search status text (ignored)
// Frame shapes seen live:
//   {"v":{"response":{"fragments":[{"type":"THINK","content":"We"}]}}}     snapshot
//   {"p":"response","o":"BATCH","v":[{"p":"fragments","o":"APPEND","v":[{"type":"RESPONSE"}]}]}
//   {"p":"response/fragments/-1/content","o":"APPEND","v":" x"}            op with path
//   {"v":"x"}                                                             op continuing last path
async function* extractContent(body, signal) {
  let lastPath = "";
  const fragTypes = []; // index → fragment type, kept in sync with the server

  const channelFor = (path) => {
    if (path.endsWith("/thinking_content")) return "thinking";
    const m = path.match(/fragments\/(-?\d+)\/content$/);
    if (!m) return null;
    const idx = Number(m[1]);
    const resolved = idx < 0 ? fragTypes.length + idx : idx;
    const type = fragTypes[resolved];
    if (type === "THINK") return "thinking";
    if (type === "RESPONSE") return "content";
    return null; // SEARCH / unknown fragments carry no answer text
  };

  const handleOp = (op, out) => {
    if (op && typeof op.p === "string") lastPath = op.p;
    const path = op && typeof op.p === "string" ? op.p : lastPath;
    if (!op) return;
    // fragment list append: record the new fragment types
    if (path.endsWith("fragments") && op.v) {
      const arr = Array.isArray(op.v) ? op.v : [op.v];
      for (const f of arr) if (f?.type) fragTypes.push(f.type);
      return;
    }
    if (typeof op.v === "string" && path) {
      const ch = channelFor(path);
      if (ch === "thinking") out.push({ thinking: op.v });
      else if (ch === "content") out.push({ delta: op.v });
    }
    if (path === "response/status" && op.v === "FINISHED") out.push({ done: true });
  };

  for await (const line of readLines(body, signal)) {
    if (!line || !line.startsWith("data:")) continue;
    const payload = line.slice(5).trim();
    if (!payload || payload === "[DONE]") continue;
    let chunk;
    try { chunk = JSON.parse(payload); } catch { continue; }

    // Upstream error frames (e.g. rate limiting) arrive as
    //   {"type":"error","content":"...","finish_reason":"rate_limit_reached"}
    // with no patch/response body. Surface them instead of returning empty text.
    if (chunk?.type === "error" || chunk?.finish_reason === "rate_limit_reached") {
      const msg = chunk?.content || "DeepSeek returned an error";
      yield { error: /频繁|too frequently|rate/i.test(msg) ? "DeepSeek rate limit reached — wait a few seconds and retry" : msg };
      return;
    }

    const out = [];

    // snapshot frame: full response object with fragments[]
    const resp = chunk?.v?.response;
    if (!chunk?.p && resp) {
      fragTypes.length = 0;
      for (const frag of resp.fragments || []) {
        fragTypes.push(frag.type);
        if (!frag?.content) continue;
        if (frag.type === "THINK") out.push({ thinking: frag.content });
        else if (frag.type === "RESPONSE") out.push({ delta: frag.content });
      }
      if (resp.status === "FINISHED") out.push({ done: true });
    } else if (chunk?.o === "BATCH" && Array.isArray(chunk.v)) {
      for (const op of chunk.v) handleOp(op, out);
    } else if (typeof chunk?.p === "string" || (typeof chunk?.v === "string" && lastPath)) {
      handleOp(chunk, out);
    }

    for (const ev of out) {
      yield ev;
      if (ev.done) return;
    }
  }
  yield { done: true };
}

export class DeepSeekWebExecutor extends BaseExecutor {
  constructor() {
    super("deepseek-web", PROVIDERS["deepseek-web"]);
  }

  async execute({ model, body, stream, credentials, signal, log }) {
    const messages = body?.messages;
    if (!Array.isArray(messages) || messages.length === 0) {
      return { response: badRequest("Missing or empty messages array"), url: COMPLETION, headers: {}, transformedBody: body };
    }

    const [userTokenRaw, cookie] = splitCredential(credentials?.apiKey || credentials?.accessToken || "");
    if (!userTokenRaw && !cookie) {
      return { response: badRequest("DeepSeek Web needs a userToken (localStorage) — cookie is optional"), url: COMPLETION, headers: {}, transformedBody: body };
    }

    // Refresh the token; fall back to the raw value if the exchange fails.
    const userToken = userTokenRaw ? await refreshAccessToken(userTokenRaw, signal, log) : "";

    const flags = MODEL_FLAGS[model] || MODEL_FLAGS["deepseek-chat"];
    const parsed = parseOpenAIMessages(messages);
    let prompt = buildPrompt(parsed.items);
    const toolsHint = formatToolsHint(body?.tools);
    if (toolsHint) prompt += toolsHint;
    if (endsWithToolResult(parsed.items)) prompt += TOOL_RESULT_FOLLOWUP;
    if (!prompt.trim()) {
      return { response: badRequest("Empty query after processing"), url: COMPLETION, headers: {}, transformedBody: body };
    }

    const authHeaders = { ...baseHeaders() };
    // Prefer the real browser cookie when the user pasted one, otherwise mint a
    // well-formed one — this is what removes the "copy cookies from DevTools" step.
    authHeaders.Cookie = cookie
      ? (cookie.includes("=") ? cookie : `ds_session_id=${cookie}`)
      : generateCookie();
    if (userToken) authHeaders.Authorization = `Bearer ${userToken}`;

    let sessionId;
    let powHeader;
    try {
      sessionId = await createSession(authHeaders, signal);
      powHeader = await getPowHeader(authHeaders, signal, log);
    } catch (err) {
      log?.error?.("DEEPSEEK-WEB", `Handshake failed: ${err.message || String(err)}`);
      return { response: jsonError(`DeepSeek handshake failed: ${err.message || String(err)}`, err.status || 502, "UPSTREAM_ERROR"), url: COMPLETION, headers: authHeaders, transformedBody: body };
    }

    const payload = {
      chat_session_id: sessionId,
      parent_message_id: null,
      prompt,
      model_type: flags.modelType || (flags.thinking ? "expert" : "default"),
      ref_file_ids: [],
      thinking_enabled: flags.thinking,
      search_enabled: flags.search,
      preempt: false,
    };

    const headers = { ...authHeaders, Referer: `${BASE}/a/chat/s/${sessionId}` };
    if (powHeader) headers["x-ds-pow-response"] = powHeader;

    log?.info?.("DEEPSEEK-WEB", `Query ${model} (thinking=${flags.thinking}, search=${flags.search}), len=${prompt.length}`);

    let response;
    try {
      response = await fetch(COMPLETION, { method: "POST", headers, body: JSON.stringify(payload), signal });
    } catch (err) {
      return { response: jsonError(`DeepSeek connection failed: ${err.message || String(err)}`), url: COMPLETION, headers, transformedBody: payload };
    }

    if (!response.ok) {
      const status = response.status;
      let msg = `DeepSeek returned HTTP ${status}`;
      if (status === 401 || status === 403) msg = "DeepSeek auth failed — userToken/cookie expired. Re-paste from chat.deepseek.com.";
      else if (status === 429) msg = "DeepSeek rate limited. Wait and retry.";
      else if (status === 400) msg = "DeepSeek rejected the request (PoW or session may be stale). Retry once.";
      log?.warn?.("DEEPSEEK-WEB", msg);
      return { response: jsonError(msg, status, `HTTP_${status}`), url: COMPLETION, headers, transformedBody: payload };
    }

    if (!response.body) {
      return { response: jsonError("DeepSeek returned an empty body"), url: COMPLETION, headers, transformedBody: payload };
    }

    // Best-effort cleanup so the throwaway conversation never shows in the sidebar.
    const cleanup = () => {
      fetch(DELETE_SESSION, {
        method: "POST", headers: authHeaders, body: JSON.stringify({ chat_session_id: sessionId }),
      }).catch(() => {});
    };

    if (stream) {
      const { response: sseResponse } = buildStreamingResponse(extractContent(response.body, signal), model, signal, body?.tools);
      return { response: sseResponse, url: COMPLETION, headers, transformedBody: payload, onComplete: cleanup };
    }
    const finalResponse = await buildNonStreamingResponse(extractContent(response.body, signal), model, signal, body?.tools);
    cleanup();
    return { response: finalResponse, url: COMPLETION, headers, transformedBody: payload };
  }
}

export default DeepSeekWebExecutor;
