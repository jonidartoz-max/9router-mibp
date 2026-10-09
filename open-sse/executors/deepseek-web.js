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
import { BaseExecutor } from "./base.js";
import { PROVIDERS } from "../config/providers.js";
import {
  SSE_HEADERS_NO_BUFFER,
  splitCredential,
  parseOpenAIMessages,
  formatToolsHint,
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

const UA = "DeepSeek/1.0.13 Android/35";

// Model slug → { thinking, search }. Anything else falls back to chat.
const MODEL_FLAGS = {
  "deepseek-chat": { thinking: false, search: false },
  "deepseek-v3": { thinking: false, search: false },
  "deepseek-reasoner": { thinking: true, search: false },
  "deepseek-r1": { thinking: true, search: false },
  "deepseek-chat-search": { thinking: false, search: true },
  "deepseek-v3-search": { thinking: false, search: true },
  "deepseek-reasoner-search": { thinking: true, search: true },
  "deepseek-r1-search": { thinking: true, search: true },
};

const POW_CACHE = new Map(); // challenge hex → nonce, avoids re-solving identical challenges

function baseHeaders() {
  return {
    Host: HOST,
    "User-Agent": UA,
    Accept: "application/json",
    "Accept-Encoding": "gzip, deflate, br",
    "Content-Type": "application/json",
    "x-client-platform": "android",
    "x-client-version": "1.3.0-auto-resume",
    "x-client-locale": "en_US",
    "accept-charset": "UTF-8",
  };
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

function solvePow(challenge, salt, expireAt, difficulty) {
  if (POW_CACHE.has(challenge)) return POW_CACHE.get(challenge);
  const prefix = `${salt}_${expireAt}_`;
  const max = Number(difficulty) || 144000;
  for (let n = 0; n < max; n++) {
    const digest = crypto.createHash("sha3-256").update(prefix + n, "utf8").digest("hex");
    if (digest === challenge) {
      POW_CACHE.set(challenge, n);
      return n;
    }
  }
  return null;
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
  const answer = solvePow(ch.challenge, ch.salt, ch.expire_at, ch.difficulty);
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
  const data = await res.json().catch(() => ({}));
  return data?.data?.biz_data?.id || null;
}

// Parse the JSON-patch SSE stream into { delta } / { thinking } events.
async function* extractContent(body, signal) {
  for await (const line of readLines(body, signal)) {
    if (!line || !line.startsWith("data:")) continue;
    const payload = line.slice(5).trim();
    if (!payload || payload === "[DONE]") continue;
    let chunk;
    try { chunk = JSON.parse(payload); } catch { continue; }

    if (chunk.p === "response/status" && chunk.v === "FINISHED") { yield { done: true }; return; }
    if (chunk.p === "response/content" && typeof chunk.v === "string") yield { delta: chunk.v };
    else if (chunk.p === "response/thinking_content" && typeof chunk.v === "string") yield { thinking: chunk.v };
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

    const [userToken, cookie] = splitCredential(credentials?.apiKey || credentials?.accessToken || "");
    if (!userToken && !cookie) {
      return { response: badRequest("DeepSeek Web needs a userToken and/or session cookie"), url: COMPLETION, headers: {}, transformedBody: body };
    }

    const flags = MODEL_FLAGS[model] || MODEL_FLAGS["deepseek-chat"];
    const parsed = parseOpenAIMessages(messages);
    let prompt = buildPrompt(parsed.items);
    const toolsHint = formatToolsHint(body?.tools);
    if (toolsHint) prompt += toolsHint;
    if (!prompt.trim()) {
      return { response: badRequest("Empty query after processing"), url: COMPLETION, headers: {}, transformedBody: body };
    }

    const authHeaders = { ...baseHeaders() };
    if (cookie) authHeaders.Cookie = cookie.includes("=") ? cookie : `ds_session_id=${cookie}`;
    if (userToken) authHeaders.Authorization = `Bearer ${userToken}`;

    let sessionId;
    let powHeader;
    try {
      sessionId = await createSession(authHeaders, signal);
      powHeader = await getPowHeader(authHeaders, signal, log);
    } catch (err) {
      log?.error?.("DEEPSEEK-WEB", `Handshake failed: ${err.message || String(err)}`);
      return { response: jsonError(`DeepSeek handshake failed: ${err.message || String(err)}`), url: COMPLETION, headers: authHeaders, transformedBody: body };
    }

    if (!sessionId) {
      return {
        response: jsonError("DeepSeek refused session creation — userToken/cookie likely expired. Re-paste them from chat.deepseek.com."),
        url: COMPLETION, headers: authHeaders, transformedBody: body,
      };
    }

    const payload = {
      chat_session_id: sessionId,
      parent_message_id: null,
      prompt,
      ref_file_ids: [],
      thinking_enabled: flags.thinking,
      search_enabled: flags.search,
    };

    const headers = { ...authHeaders };
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
      const { response: sseResponse } = buildStreamingResponse(extractContent(response.body, signal), model, signal);
      return { response: sseResponse, url: COMPLETION, headers, transformedBody: payload, onComplete: cleanup };
    }
    const finalResponse = await buildNonStreamingResponse(extractContent(response.body, signal), model, signal);
    cleanup();
    return { response: finalResponse, url: COMPLETION, headers, transformedBody: payload };
  }
}

export default DeepSeekWebExecutor;
