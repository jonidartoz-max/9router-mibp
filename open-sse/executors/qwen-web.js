// Qwen Chat Web (chat.qwen.ai) — chat2api executor.
//
// Protocol (reverse-engineered, 2026-10):
//   1. POST /api/v2/chats/new { title, models } → { data.id } (chat_id)
//   2. POST /api/v2/chat/completions?chat_id=... with
//        { stream:true, version:"2.1", incremental_output:true, chat_id, model,
//          messages:[{role,content,...}], feature_config:{thinking_enabled} }
//      → SSE frames: data:{"choices":[{"delta":{"content":"…","phase":"think"|"answer"}}]}
//      phase "think" = reasoning_content, "answer" = visible content.
//      A final frame carries `response.created` / a `done` flag.
//
// Auth: the `token` cookie from chat.qwen.ai (starts with "eyJ…"), optionally
// followed by "|ssxmod_itna" (WAF cookie). Bearer auth also works.
// Anonymous access is possible but rate-limited; a cookie is recommended.

import { BaseExecutor } from "./base.js";
import { PROVIDERS } from "../config/providers.js";
import {
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
import { acquire, noteOutcome, classifyUpstream, pacedStream } from "./webPacer.js";

const BASE = "https://chat.qwen.ai";
const NEW_CHAT = `${BASE}/api/v2/chats/new`;
const COMPLETIONS = `${BASE}/api/v2/chat/completions`;

const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36";

// Model slug → upstream id. "-thinking" variants enable reasoning.
const MODEL_MAP = {
  "qwen-max": "qwen3.8-max",
  "qwen-plus": "qwen3.7-plus",
  "qwen3-max": "qwen3.8-max",
  "qwen3.8-max": "qwen3.8-max",
  "qwen3.7-max": "qwen3.8-max",
  "qwen3.7-plus": "qwen3.7-plus",
  "qwen3.8-omni-flash": "qwen3.8-omni-flash",
  "qwen3-omni-flash": "qwen3.8-omni-flash",
  "qwen3-coder": "qwen3.8-max",
};

function resolveModel(model) {
  if (MODEL_MAP[model]) return { id: MODEL_MAP[model], thinking: false };
  if (model?.endsWith("-thinking")) {
    const base = model.slice(0, -"-thinking".length);
    return { id: MODEL_MAP[base] || base, thinking: true };
  }
  return { id: model || "qwen3.7-max", thinking: false };
}

function buildHeaders(credential) {
  const [token, ssxmod] = splitCredential(credential);
  const headers = {
    Accept: "application/json, text/plain, */*",
    "Accept-Language": "en-US,en;q=0.9",
    "Content-Type": "application/json",
    Origin: BASE,
    Referer: `${BASE}/`,
    source: "web",
    version: "0.2.66",
    "User-Agent": UA,
    "x-request-id": crypto.randomUUID(),
    "x-accel-buffering": "no",
    "sec-fetch-dest": "empty",
    "sec-fetch-mode": "cors",
    "sec-fetch-site": "same-origin",
  };
  if (token) headers.Authorization = `Bearer ${token}`;
  const cookies = [];
  if (token) cookies.push(`token=${token}`);
  if (ssxmod) cookies.push(ssxmod.includes("=") ? ssxmod : `ssxmod_itna=${ssxmod}`);
  if (cookies.length) headers.Cookie = cookies.join("; ");
  return headers;
}

async function createChat(headers, model, signal, log) {
  try {
    const res = await fetch(NEW_CHAT, {
      method: "POST",
      headers,
      body: JSON.stringify({ title: "New Chat", models: [model], chat_mode: "normal", chat_type: "t2t" }),
      signal,
    });
    const data = await res.json().catch(() => ({}));
    return data?.data?.id || null;
  } catch (err) {
    log?.warn?.("QWEN-WEB", `chats/new failed: ${err.message || String(err)}`);
    return null;
  }
}

// Parse Qwen's OpenAI-ish SSE; `phase` routes thinking vs answer.
async function* extractContent(body, signal) {
  let usage = null;
  for await (const line of readLines(body, signal)) {
    if (!line.startsWith("data:")) continue;
    const payload = line.slice(5).trim();
    if (!payload || payload === "[DONE]") continue;
    let chunk;
    try { chunk = JSON.parse(payload); } catch { continue; }

    if (chunk?.usage) usage = chunk.usage;
    const choice = chunk?.choices?.[0];
    const delta = choice?.delta;
    if (delta) {
      const text = typeof delta.content === "string" ? delta.content : "";
      if (text) {
        if (delta.phase === "think") yield { thinking: text };
        else yield { delta: text };
      }
    }
    if (choice?.finish_reason) break;
    if (chunk?.done === true) break;
  }
  yield { done: true, usage };
}

export class QwenWebExecutor extends BaseExecutor {
  constructor() {
    super("qwen-web", PROVIDERS["qwen-web"]);
  }

  async execute({ model, body, stream, credentials, signal, log }) {
    const messages = body?.messages;
    if (!Array.isArray(messages) || messages.length === 0) {
      return { response: badRequest("Missing or empty messages array"), url: COMPLETIONS, headers: {}, transformedBody: body };
    }

    const credential = credentials?.apiKey || credentials?.accessToken || "";
    const headers = buildHeaders(credential);
    const { id: upstreamModel, thinking } = resolveModel(model);

    const parsed = parseOpenAIMessages(messages);
    let prompt = parsed.flatPrompt;
    const toolsHint = formatToolsHint(body?.tools);
    if (toolsHint) prompt += toolsHint;
    if (endsWithToolResult(parsed.items)) prompt += TOOL_RESULT_FOLLOWUP;
    if (!prompt.trim()) {
      return { response: badRequest("Empty query after processing"), url: COMPLETIONS, headers, transformedBody: body };
    }

    // Pace the whole flow so the chat-create handshake counts too.
    const release = await acquire("qwen-web", credential);
    const chatId = await createChat(headers, upstreamModel, signal, log);
    const url = chatId ? `${COMPLETIONS}?chat_id=${chatId}` : COMPLETIONS;

    const payload = {
      stream: true,
      version: "2.1",
      incremental_output: true,
      chat_id: chatId || null,
      chat_mode: "normal",
      model: upstreamModel,
      parent_id: null,
      timestamp: Date.now(),
      messages: [{ fid: crypto.randomUUID(), parentId: null, childrenIds: [], role: "user", content: prompt, user_action: "chat", files: [], models: [upstreamModel], chat_type: "t2t", sub_chat_type: "t2t", timestamp: Date.now() }],
      feature_config: {
        thinking_enabled: thinking || body?.thinking === true,
        output_schema: "phase",
        auto_thinking: false,
        thinking_mode: "Thinking",
        thinking_format: "summary",
      },
    };

    log?.info?.("QWEN-WEB", `Query ${model}→${upstreamModel} (thinking=${thinking}), len=${prompt.length}`);

    let response;
    try {
      response = await fetch(url, { method: "POST", headers, body: JSON.stringify(payload), signal });
    } catch (err) {
      release();
      return { response: jsonError(`Qwen connection failed: ${err.message || String(err)}`), url, headers, transformedBody: payload };
    }

    if (!response.ok) {
      const status = response.status;
      let msg = `Qwen returned HTTP ${status}`;
      if (status === 401 || status === 403) msg = "Qwen auth failed — the `token` cookie may be expired. Re-paste it from chat.qwen.ai.";
      else if (status === 429) msg = "Qwen rate limited. Wait and retry (or add a signed-in cookie).";
      const bodyText = await response.text().catch(() => "");
      const kind = classifyUpstream(status, bodyText);
      if (kind) noteOutcome("qwen-web", credential, kind, `HTTP ${status}`);
      if (kind === "suspended") msg = "Qwen reports this account as SUSPENDED — requests are paused for 30 min.";
      release();
      log?.warn?.("QWEN-WEB", msg);
      return { response: jsonError(msg, status, `HTTP_${status}`), url, headers, transformedBody: payload };
    }

    if (!response.body) {
      release();
      return { response: jsonError("Qwen returned an empty body"), url, headers, transformedBody: payload };
    }

    noteOutcome("qwen-web", credential, "ok");

    if (stream) {
      const { response: sseResponse } = buildStreamingResponse(pacedStream(extractContent(response.body, signal), release), model, signal, body?.tools);
      return { response: sseResponse, url, headers, transformedBody: payload };
    }
    const finalResponse = await buildNonStreamingResponse(pacedStream(extractContent(response.body, signal), release), model, signal, body?.tools);
    return { response: finalResponse, url, headers, transformedBody: payload };
  }
}

export default QwenWebExecutor;
