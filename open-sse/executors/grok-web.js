import { BaseExecutor } from "./base.js";
import { PROVIDERS } from "../config/providers.js";
import { SSE_DONE, SSE_HEADERS_NO_BUFFER } from "../utils/sseConstants.js";
import { sseChunk } from "../utils/sse.js";
import {
  formatToolsHint,
  extractToolCalls,
  endsWithToolResult,
  TOOL_RESULT_FOLLOWUP,
  messageToText,
} from "./webChatShared.js";
import { acquire, noteOutcome, classifyUpstream, releaseOnStream } from "./webPacer.js";

const GROK_CHAT_API = PROVIDERS["grok-web"].baseUrl;
const GROK_USER_AGENT = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36";

const MODEL_MAP = {
  // Grok 4.7 — "our new model" on grok.com; powers Expert and Heavy modes.
  "grok-4.7": { grokModel: "grok-4-7", modelMode: "MODEL_MODE_EXPERT", isThinking: true },
  "grok-4.7-expert": { grokModel: "grok-4-7", modelMode: "MODEL_MODE_EXPERT", isThinking: true },
  "grok-4.7-thinking": { grokModel: "grok-4-7", modelMode: "MODEL_MODE_EXPERT", isThinking: true },
  "grok-4.7-heavy": { grokModel: "grok-4-7", modelMode: "MODEL_MODE_HEAVY", isThinking: true },
  "grok-4.7-fast": { grokModel: "grok-4-7", modelMode: "MODEL_MODE_FAST", isThinking: false },
  "grok-4.7-auto": { grokModel: "grok-4-7", modelMode: "MODEL_MODE_AUTO", isThinking: false },
  // Grok 4.6
  "grok-4.6": { grokModel: "grok-4-6", modelMode: "MODEL_MODE_EXPERT", isThinking: true },
  "grok-4.6-fast": { grokModel: "grok-4-6", modelMode: "MODEL_MODE_FAST", isThinking: false },
  // Grok 4.5
  "grok-4.5": { grokModel: "grok-4-5", modelMode: "MODEL_MODE_EXPERT", isThinking: true },
  // Grok 4.3 / 4.2
  "grok-4.3": { grokModel: "grok-43", modelMode: "MODEL_MODE_GROK43", isThinking: false },
  "grok-4.2": { grokModel: "grok-420", modelMode: "MODEL_MODE_GROK_420", isThinking: false },
  "grok-4.20": { grokModel: "grok-420", modelMode: "MODEL_MODE_GROK_420", isThinking: false },
  "grok-4.20-beta": { grokModel: "grok-420", modelMode: "MODEL_MODE_GROK_420", isThinking: false },
  // Grok 4.1 (legacy)
  "grok-4.1-mini": { grokModel: "grok-4-1-thinking-1129", modelMode: "MODEL_MODE_GROK_4_1_MINI_THINKING", isThinking: true },
  "grok-4.1-fast": { grokModel: "grok-4-1-thinking-1129", modelMode: "MODEL_MODE_FAST", isThinking: false },
  "grok-4.1-expert": { grokModel: "grok-4-1-thinking-1129", modelMode: "MODEL_MODE_EXPERT", isThinking: true },
  "grok-4.1-thinking": { grokModel: "grok-4-1-thinking-1129", modelMode: "MODEL_MODE_GROK_4_1_THINKING", isThinking: true },
  // Grok 4 / 3 (legacy)
  "grok-4": { grokModel: "grok-4", modelMode: "MODEL_MODE_GROK_4", isThinking: false },
  "grok-4-mini": { grokModel: "grok-4-mini", modelMode: "MODEL_MODE_GROK_4_MINI_THINKING", isThinking: true },
  "grok-4-thinking": { grokModel: "grok-4", modelMode: "MODEL_MODE_GROK_4_THINKING", isThinking: true },
  "grok-4-heavy": { grokModel: "grok-4", modelMode: "MODEL_MODE_HEAVY", isThinking: true },
  "grok-3": { grokModel: "grok-3", modelMode: "MODEL_MODE_GROK_3", isThinking: false },
  "grok-3-mini": { grokModel: "grok-3", modelMode: "MODEL_MODE_GROK_3_MINI_THINKING", isThinking: true },
  "grok-3-thinking": { grokModel: "grok-3", modelMode: "MODEL_MODE_GROK_3_THINKING", isThinking: true },
};

function randomString(length, alphanumeric = false) {
  const chars = alphanumeric ? "abcdefghijklmnopqrstuvwxyz0123456789" : "abcdefghijklmnopqrstuvwxyz";
  let result = "";
  for (let i = 0; i < length; i++) result += chars[Math.floor(Math.random() * chars.length)];
  return result;
}

function generateStatsigId() {
  const msg = Math.random() < 0.5
    ? `e:TypeError: Cannot read properties of null (reading 'children["${randomString(5, true)}"]')`
    : `e:TypeError: Cannot read properties of undefined (reading '${randomString(10)}')`;
  return btoa(msg);
}

function randomHex(bytes) {
  const arr = new Uint8Array(bytes);
  crypto.getRandomValues(arr);
  return Array.from(arr, (b) => b.toString(16).padStart(2, "0")).join("");
}

function parseOpenAIMessages(messages) {
  const extracted = [];
  for (const msg of messages) {
    let role = String(msg.role || "user");
    if (role === "developer") role = "system";
    // messageToText keeps assistant tool_calls (as a [function_calls] block) and
    // labels tool results — without this the model re-calls tools forever.
    const text = messageToText({ ...msg, role });
    if (!text.trim()) continue;
    extracted.push({ role, text });
  }

  let lastUserIdx = -1;
  for (let i = extracted.length - 1; i >= 0; i--) {
    if (extracted[i].role === "user") { lastUserIdx = i; break; }
  }

  const parts = [];
  for (let i = 0; i < extracted.length; i++) {
    const { role, text } = extracted[i];
    parts.push(i === lastUserIdx ? text : `${role}: ${text}`);
  }
  return parts.join("\n\n");
}

async function* readGrokNdjsonEvents(body, signal) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (true) {
      if (signal?.aborted) return;
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      while (true) {
        const idx = buffer.indexOf("\n");
        if (idx < 0) break;
        const line = buffer.slice(0, idx).trim();
        buffer = buffer.slice(idx + 1);
        if (!line) continue;
        try { yield JSON.parse(line); } catch { /* skip */ }
      }
    }
    buffer += decoder.decode();
    const remaining = buffer.trim();
    if (remaining) {
      try { yield JSON.parse(remaining); } catch { /* skip */ }
    }
  } finally {
    reader.releaseLock();
  }
}

async function* extractContent(eventStream, isThinkingModel, signal) {
  let fingerprint = "";
  let responseId = "";
  let thinkOpened = false;

  for await (const event of readGrokNdjsonEvents(eventStream, signal)) {
    if (event.error) {
      yield { error: event.error.message || `Grok error: ${event.error.code}`, done: true };
      return;
    }
    const resp = event.result?.response;
    if (!resp) continue;

    if (resp.llmInfo?.modelHash && !fingerprint) fingerprint = resp.llmInfo.modelHash;
    if (resp.responseId) responseId = resp.responseId;

    if (resp.modelResponse) {
      const mr = resp.modelResponse;
      if (thinkOpened && isThinkingModel) {
        if (mr.message) yield { thinking: mr.message };
        thinkOpened = false;
      }
      if (mr.message) yield { fullMessage: mr.message, fingerprint, responseId };
      if (mr.metadata?.llm_info?.modelHash) fingerprint = mr.metadata.llm_info.modelHash;
      continue;
    }

    if (resp.token != null) yield { delta: resp.token, fingerprint, responseId };
  }
  yield { done: true, fingerprint, responseId };
}

function buildStreamingResponse(eventStream, model, cid, created, isThinkingModel, signal, tools) {
  const encoder = new TextEncoder();
  const wantTools = Array.isArray(tools) && tools.length > 0;
  return new ReadableStream({
    async start(controller) {
      let closed = false;
      const finish = () => { if (!closed) { closed = true; controller.close(); } };
      try {
        controller.enqueue(encoder.encode(sseChunk({
          id: cid, object: "chat.completion.chunk", created, model, system_fingerprint: null,
          choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null, logprobs: null }],
        })));

        let fp = "";
        let buffered = "";
        for await (const chunk of extractContent(eventStream, isThinkingModel, signal)) {
          if (chunk.fingerprint) fp = chunk.fingerprint;

          if (chunk.error) {
            controller.enqueue(encoder.encode(sseChunk({
              id: cid, object: "chat.completion.chunk", created, model, system_fingerprint: fp || null,
              choices: [{ index: 0, delta: { content: `[Error: ${chunk.error}]` }, finish_reason: null, logprobs: null }],
            })));
            break;
          }
          if (chunk.thinking) {
            controller.enqueue(encoder.encode(sseChunk({
              id: cid, object: "chat.completion.chunk", created, model, system_fingerprint: fp || null,
              choices: [{ index: 0, delta: { reasoning_content: chunk.thinking }, finish_reason: null, logprobs: null }],
            })));
            continue;
          }
          if (chunk.done) break;
          const piece = chunk.fullMessage != null ? chunk.fullMessage : chunk.delta;
          if (piece != null) {
            if (wantTools) { buffered += piece; }
            else {
              controller.enqueue(encoder.encode(sseChunk({
                id: cid, object: "chat.completion.chunk", created, model, system_fingerprint: fp || null,
                choices: [{ index: 0, delta: { content: piece }, finish_reason: null, logprobs: null }],
              })));
            }
          }
        }

        if (wantTools && buffered) {
          const { content, toolCalls } = extractToolCalls(buffered);
          if (toolCalls.length) {
            toolCalls.forEach((tc, i) => {
              controller.enqueue(encoder.encode(sseChunk({
                id: cid, object: "chat.completion.chunk", created, model, system_fingerprint: fp || null,
                choices: [{ index: 0, delta: { tool_calls: [{ index: i, id: tc.id, type: "function", function: { name: tc.name, arguments: tc.arguments } }] }, finish_reason: null, logprobs: null }],
              })));
            });
            controller.enqueue(encoder.encode(sseChunk({
              id: cid, object: "chat.completion.chunk", created, model, system_fingerprint: fp || null,
              choices: [{ index: 0, delta: {}, finish_reason: "tool_calls", logprobs: null }],
            })));
            controller.enqueue(encoder.encode(SSE_DONE));
            return;
          }
          if (content) {
            controller.enqueue(encoder.encode(sseChunk({
              id: cid, object: "chat.completion.chunk", created, model, system_fingerprint: fp || null,
              choices: [{ index: 0, delta: { content }, finish_reason: null, logprobs: null }],
            })));
          }
        }

        controller.enqueue(encoder.encode(sseChunk({
          id: cid, object: "chat.completion.chunk", created, model, system_fingerprint: fp || null,
          choices: [{ index: 0, delta: {}, finish_reason: "stop", logprobs: null }],
        })));
        controller.enqueue(encoder.encode(SSE_DONE));
      } catch (err) {
        controller.enqueue(encoder.encode(sseChunk({
          id: cid, object: "chat.completion.chunk", created, model, system_fingerprint: null,
          choices: [{ index: 0, delta: { content: `[Stream error: ${err.message || String(err)}]` }, finish_reason: "stop", logprobs: null }],
        })));
        controller.enqueue(encoder.encode(SSE_DONE));
      } finally {
        finish();
      }
    },
  });
}

async function buildNonStreamingResponse(eventStream, model, cid, created, isThinkingModel, signal, tools) {
  let fullContent = "";
  let fingerprint = "";
  const thinkingParts = [];

  for await (const chunk of extractContent(eventStream, isThinkingModel, signal)) {
    if (chunk.fingerprint) fingerprint = chunk.fingerprint;
    if (chunk.error) {
      return new Response(JSON.stringify({
        error: { message: chunk.error, type: "upstream_error", code: "GROK_ERROR" },
      }), { status: 502, headers: { "Content-Type": "application/json" } });
    }
    if (chunk.thinking) { thinkingParts.push(chunk.thinking); continue; }
    if (chunk.done) break;
    if (chunk.fullMessage != null) fullContent = chunk.fullMessage;
    else if (chunk.delta) fullContent += chunk.delta;
  }

  const msg = { role: "assistant", content: fullContent };
  if (thinkingParts.length > 0) msg.reasoning_content = thinkingParts.join("");

  let finishReason = "stop";
  if (Array.isArray(tools) && tools.length > 0 && fullContent) {
    const parsed = extractToolCalls(fullContent);
    if (parsed.toolCalls.length) {
      msg.content = parsed.content || null;
      msg.tool_calls = parsed.toolCalls.map((tc) => ({
        id: tc.id, type: "function", function: { name: tc.name, arguments: tc.arguments },
      }));
      finishReason = "tool_calls";
    }
  }

  const promptTokens = Math.ceil(fullContent.length / 4);
  const completionTokens = Math.ceil(fullContent.length / 4);

  return new Response(JSON.stringify({
    id: cid, object: "chat.completion", created, model, system_fingerprint: fingerprint || null,
    choices: [{ index: 0, message: msg, finish_reason: finishReason, logprobs: null }],
    usage: { prompt_tokens: promptTokens, completion_tokens: completionTokens, total_tokens: promptTokens + completionTokens },
  }), { status: 200, headers: { "Content-Type": "application/json" } });
}

export class GrokWebExecutor extends BaseExecutor {
  constructor() {
    super("grok-web", PROVIDERS["grok-web"]);
  }

  async execute({ model, body, stream, credentials, signal, log }) {
    const messages = body?.messages;
    if (!messages || !Array.isArray(messages) || messages.length === 0) {
      const errResp = new Response(JSON.stringify({
        error: { message: "Missing or empty messages array", type: "invalid_request" },
      }), { status: 400, headers: { "Content-Type": "application/json" } });
      return { response: errResp, url: GROK_CHAT_API, headers: {}, transformedBody: body };
    }

    const modelInfo = MODEL_MAP[model];
    if (!modelInfo) log?.info?.("GROK-WEB", `Unmapped model ${model}, defaulting to grok-4.7`);
    const { grokModel, modelMode, isThinking } = modelInfo || MODEL_MAP["grok-4.7"];

    const message = parseOpenAIMessages(messages);
    if (!message.trim()) {
      const errResp = new Response(JSON.stringify({
        error: { message: "Empty query after processing", type: "invalid_request" },
      }), { status: 400, headers: { "Content-Type": "application/json" } });
      return { response: errResp, url: GROK_CHAT_API, headers: {}, transformedBody: body };
    }

    // Tool support: append the bracket protocol, and when the transcript already
    // ends with tool results, tell the model to answer instead of re-calling.
    const toolsHint = formatToolsHint(body?.tools);
    const prompt = message
      + (toolsHint || "")
      + (toolsHint && endsWithToolResult(messages) ? TOOL_RESULT_FOLLOWUP : "");

    const grokPayload = {
      temporary: true, modelName: grokModel, modelMode, message: prompt,
      fileAttachments: [], imageAttachments: [],
      disableSearch: false, enableImageGeneration: false, returnImageBytes: false,
      returnRawGrokInXaiRequest: false, enableImageStreaming: false, imageGenerationCount: 0,
      forceConcise: false, toolOverrides: {}, enableSideBySide: true, sendFinalMetadata: true,
      isReasoning: false, disableTextFollowUps: false, disableMemory: true,
      forceSideBySide: false, isAsyncChat: false, disableSelfHarmShortCircuit: false,
      deviceEnvInfo: {
        darkModeEnabled: false, devicePixelRatio: 2,
        screenWidth: 2056, screenHeight: 1329, viewportWidth: 2056, viewportHeight: 1083,
      },
    };

    const traceId = randomHex(16);
    const spanId = randomHex(8);
    const headers = {
      Accept: "*/*",
      "Accept-Encoding": "gzip, deflate, br, zstd",
      "Accept-Language": "en-US,en;q=0.9",
      Baggage: "sentry-environment=production,sentry-release=d6add6fb0460641fd482d767a335ef72b9b6abb8,sentry-public_key=b311e0f2690c81f25e2c4cf6d4f7ce1c",
      "Cache-Control": "no-cache",
      "Content-Type": "application/json",
      Origin: "https://grok.com",
      Pragma: "no-cache",
      Referer: "https://grok.com/",
      "Sec-Ch-Ua": '"Google Chrome";v="136", "Chromium";v="136", "Not(A:Brand";v="24"',
      "Sec-Ch-Ua-Mobile": "?0",
      "Sec-Ch-Ua-Platform": '"macOS"',
      "Sec-Fetch-Dest": "empty",
      "Sec-Fetch-Mode": "cors",
      "Sec-Fetch-Site": "same-origin",
      "User-Agent": GROK_USER_AGENT,
      "x-statsig-id": generateStatsigId(),
      "x-xai-request-id": crypto.randomUUID(),
      traceparent: `00-${traceId}-${spanId}-00`,
    };

    // Strip "sso=" prefix if user pasted it
    if (credentials.apiKey) {
      let token = credentials.apiKey;
      if (token.startsWith("sso=")) token = token.slice(4);
      headers["Cookie"] = `sso=${token}`;
    }

    log?.info?.("GROK-WEB", `Query to ${model} (grok=${grokModel}, mode=${modelMode}), len=${message.length}`);

    const credential = credentials?.apiKey || credentials?.accessToken || "";
    const release = await acquire("grok-web", credential);

    let response;
    try {
      response = await fetch(GROK_CHAT_API, {
        method: "POST", headers, body: JSON.stringify(grokPayload), signal,
      });
    } catch (err) {
      release();
      log?.error?.("GROK-WEB", `Fetch failed: ${err.message || String(err)}`);
      const errResp = new Response(JSON.stringify({
        error: { message: `Grok connection failed: ${err.message || String(err)}`, type: "upstream_error" },
      }), { status: 502, headers: { "Content-Type": "application/json" } });
      return { response: errResp, url: GROK_CHAT_API, headers, transformedBody: grokPayload };
    }

    if (!response.ok) {
      const status = response.status;
      let errMsg = `Grok returned HTTP ${status}`;
      if (status === 401 || status === 403) errMsg = "Grok auth failed — SSO cookie may be expired. Re-paste your sso cookie value from grok.com.";
      else if (status === 429) errMsg = "Grok rate limited. Wait a moment and retry, or rotate cookies.";
      const bodyText = await response.text().catch(() => "");
      const kind = classifyUpstream(status, bodyText);
      if (kind) noteOutcome("grok-web", credential, kind, `HTTP ${status}`);
      if (kind === "suspended") errMsg = "Grok reports this account as SUSPENDED — requests are paused for 30 min.";
      release();
      log?.warn?.("GROK-WEB", errMsg);
      const errResp = new Response(JSON.stringify({
        error: { message: errMsg, type: "upstream_error", code: `HTTP_${status}` },
      }), { status, headers: { "Content-Type": "application/json" } });
      return { response: errResp, url: GROK_CHAT_API, headers, transformedBody: grokPayload };
    }

    if (!response.body) {
      release();
      const errResp = new Response(JSON.stringify({
        error: { message: "Grok returned empty response body", type: "upstream_error" },
      }), { status: 502, headers: { "Content-Type": "application/json" } });
      return { response: errResp, url: GROK_CHAT_API, headers, transformedBody: grokPayload };
    }

    noteOutcome("grok-web", credential, "ok");

    const cid = `chatcmpl-grok-${crypto.randomUUID().slice(0, 12)}`;
    const created = Math.floor(Date.now() / 1000);

    let finalResponse;
    if (stream) {
      const sseStream = buildStreamingResponse(releaseOnStream(response.body, release), model, cid, created, isThinking, signal, body?.tools);
      finalResponse = new Response(sseStream, {
        status: 200,
        headers: { ...SSE_HEADERS_NO_BUFFER },
      });
    } else {
      finalResponse = await buildNonStreamingResponse(releaseOnStream(response.body, release), model, cid, created, isThinking, signal, body?.tools);
    }
    return { response: finalResponse, url: GROK_CHAT_API, headers, transformedBody: grokPayload };
  }
}

export default GrokWebExecutor;
