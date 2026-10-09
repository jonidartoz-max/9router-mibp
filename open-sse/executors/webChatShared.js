// Shared helpers for "chat2api" web-cookie executors (grok-web / perplexity-web
// style). Each provider file implements only the upstream call; the OpenAI-shaped
// request parsing, SSE framing and non-streaming assembly live here so the four
// executors stay thin and behave identically to the existing webCookie providers.
//
// Conventions:
//  - credentials.apiKey carries the pasted browser credential (cookie / bearer).
//    A literal "|" separates a second value when a provider needs two
//    (e.g. "userToken|cookie" for DeepSeek, "sessionKey|orgId" for Claude).
//  - All helpers are fail-soft: a malformed upstream line is skipped, never thrown.

import { SSE_DONE, SSE_HEADERS_NO_BUFFER } from "../utils/sseConstants.js";
import { sseChunk } from "../utils/sse.js";

export { SSE_DONE, SSE_HEADERS_NO_BUFFER };

// Split a pasted credential on "|" (keeps the first segment when absent).
export function splitCredential(raw, parts = 2) {
  const s = String(raw ?? "");
  const idx = s.indexOf("|");
  if (idx < 0) return [s.trim(), ""];
  return [s.slice(0, idx).trim(), s.slice(idx + 1).trim()];
}

export function randomHex(bytes) {
  const arr = new Uint8Array(bytes);
  crypto.getRandomValues(arr);
  return Array.from(arr, (b) => b.toString(16).padStart(2, "0")).join("");
}

export function randomString(length, alphanumeric = false) {
  const chars = alphanumeric
    ? "abcdefghijklmnopqrstuvwxyz0123456789"
    : "abcdefghijklmnopqrstuvwxyz";
  let out = "";
  for (let i = 0; i < length; i++) out += chars[Math.floor(Math.random() * chars.length)];
  return out;
}

export function contentToText(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter((c) => c && (c.type === "text" || c.type === "input_text") && typeof c.text === "string")
      .map((c) => c.text)
      .join("\n");
  }
  return "";
}

// Flatten an OpenAI messages array into { system, history, currentMsg, flatPrompt }.
// `history` excludes the final user turn; `currentMsg` is the last user text.
export function parseOpenAIMessages(messages) {
  const items = [];
  for (const msg of messages || []) {
    let role = String(msg?.role || "user");
    if (role === "developer") role = "system";
    const text = contentToText(msg?.content);
    if (!text.trim()) continue;
    items.push({ role, content: text });
  }

  let lastUserIdx = -1;
  for (let i = items.length - 1; i >= 0; i--) {
    if (items[i].role === "user") { lastUserIdx = i; break; }
  }

  const system = items.filter((m) => m.role === "system").map((m) => m.content).join("\n\n");
  const history = items.slice(0, lastUserIdx);
  const currentMsg = lastUserIdx >= 0 ? items[lastUserIdx].content : (items[items.length - 1]?.content || "");
  const flatPrompt = items
    .map((m, i) => (i === lastUserIdx ? m.content : `${m.role}: ${m.content}`))
    .join("\n\n");

  return { system, history, currentMsg, flatPrompt, items };
}

// Render OpenAI tool definitions into a plain-text hint appended to the prompt.
export function formatToolsHint(tools) {
  if (!Array.isArray(tools) || tools.length === 0) return "";
  const lines = tools.map((t) => {
    const f = t?.function || {};
    const params = f.parameters?.properties
      ? Object.entries(f.parameters.properties)
          .map(([k, v]) => `    - ${k}: ${v?.type || "any"}${v?.description ? ` — ${v.description}` : ""}`)
          .join("\n")
      : "";
    return `- ${f.name || "tool"}${f.description ? `: ${f.description}` : ""}${params ? `\n${params}` : ""}`;
  });
  return (
    "\n\nYou have access to these tools. To call one, reply with a single JSON object " +
    "of the form {\"name\": \"<tool>\", \"arguments\": {...}} and nothing else.\n" + lines.join("\n")
  );
}

export function jsonError(message, status = 502, code = "UPSTREAM_ERROR") {
  return new Response(JSON.stringify({ error: { message, type: "upstream_error", code } }), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

export function badRequest(message) {
  return new Response(JSON.stringify({ error: { message, type: "invalid_request" } }), {
    status: 400,
    headers: { "Content-Type": "application/json" },
  });
}

// Build an OpenAI streaming Response from an async generator that yields:
//   { delta }            → append text content
//   { thinking }         → append reasoning_content
//   { error }            → emit an error frame and stop
//   { done: true }       → finish
export function buildStreamingResponse(gen, model, signal) {
  const cid = `chatcmpl-web-${crypto.randomUUID().slice(0, 12)}`;
  const created = Math.floor(Date.now() / 1000);
  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    async start(controller) {
      const emit = (delta, finishReason = null, extra = {}) =>
        controller.enqueue(encoder.encode(sseChunk({
          id: cid, object: "chat.completion.chunk", created, model,
          choices: [{ index: 0, delta, finish_reason: finishReason, logprobs: null }], ...extra,
        })));

      try {
        emit({ role: "assistant" });
        for await (const chunk of gen) {
          if (signal?.aborted) break;
          if (chunk?.error) { emit({ content: `[Error: ${chunk.error}]` }); break; }
          if (chunk?.thinking) { emit({ reasoning_content: chunk.thinking }); continue; }
          if (chunk?.done) break;
          if (chunk?.delta) emit({ content: chunk.delta });
        }
        emit({}, "stop");
        controller.enqueue(encoder.encode(SSE_DONE));
      } catch (err) {
        emit({ content: `[Stream error: ${err?.message || String(err)}]` }, "stop");
        controller.enqueue(encoder.encode(SSE_DONE));
      } finally {
        controller.close();
      }
    },
  });

  return { response: new Response(stream, { status: 200, headers: { ...SSE_HEADERS_NO_BUFFER } }), cid, created };
}

// Assemble a non-streaming OpenAI chat.completion Response from a generator.
export async function buildNonStreamingResponse(gen, model, signal) {
  let content = "";
  const thinking = [];
  for await (const chunk of gen) {
    if (signal?.aborted) break;
    if (chunk?.error) return jsonError(chunk.error);
    if (chunk?.thinking) { thinking.push(chunk.thinking); continue; }
    if (chunk?.done) break;
    if (chunk?.delta) content += chunk.delta;
  }

  const msg = { role: "assistant", content };
  if (thinking.length) msg.reasoning_content = thinking.join("\n");

  const cid = `chatcmpl-web-${crypto.randomUUID().slice(0, 12)}`;
  const promptTokens = Math.ceil((content.length || 1) / 4);
  const completionTokens = Math.ceil((content.length || 1) / 4);
  return new Response(JSON.stringify({
    id: cid, object: "chat.completion", created: Math.floor(Date.now() / 1000), model,
    choices: [{ index: 0, message: msg, finish_reason: "stop", logprobs: null }],
    usage: { prompt_tokens: promptTokens, completion_tokens: completionTokens, total_tokens: promptTokens + completionTokens },
  }), { status: 200, headers: { "Content-Type": "application/json" } });
}

// Async line reader over a fetch body (handles CRLF, ignores blank lines).
export async function* readLines(body, signal) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (true) {
      if (signal?.aborted) return;
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let idx;
      while ((idx = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, idx).replace(/\r$/, "");
        buffer = buffer.slice(idx + 1);
        yield line;
      }
    }
    if (buffer.length) yield buffer.replace(/\r$/, "");
  } finally {
    reader.releaseLock();
  }
}

// Standard browser-ish headers shared by every web-cookie executor.
export function browserHeaders(extra = {}) {
  return {
    Accept: "*/*",
    "Accept-Language": "en-US,en;q=0.9",
    "User-Agent":
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36",
    ...extra,
  };
}
