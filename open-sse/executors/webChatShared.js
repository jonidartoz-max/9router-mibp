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

// Render OpenAI tool definitions into the bracket protocol the web models follow
// reliably (ported from xiaoY233/Chat2API's DeepSeek prompt variant).
export function formatToolsHint(tools) {
  if (!Array.isArray(tools) || tools.length === 0) return "";
  const lines = tools.map((t) => {
    const f = t?.function || {};
    const schema = f.parameters ? JSON.stringify(f.parameters) : "{}";
    return `- ${f.name || "tool"}${f.description ? `: ${f.description}` : ""}\n    schema: ${schema}`;
  });
  return (
    "\n\n## Available Tools\n" +
    "You can invoke the following developer tools. Tool names are CASE-SENSITIVE.\n" +
    lines.join("\n") +
    "\n\n## Tool Call Protocol\n" +
    "When you decide to call a tool, respond with NOTHING except a single [function_calls] block:\n\n" +
    "[function_calls]\n" +
    '[call:exact_tool_name]{"argument":"value"}[/call]\n' +
    "[/function_calls]\n\n" +
    "Rules: use the EXACT tool name; the JSON between [call:...] and [/call] must be a raw " +
    "compact JSON object on ONE line; do not wrap it in code fences; do not add any other text. " +
    "For multiple tools, put several [call:...]...[/call] entries in the same block."
  );
}

// Extract [function_calls]/[call:name]{json}[/call] blocks into OpenAI tool_calls.
// Falls back to a bare {"name":..,"arguments":..} object if no bracket block exists.
export function extractToolCalls(text) {
  const calls = [];
  const blockRe = /\[function_calls\]([\s\S]*?)\[\/function_calls\]/g;
  const callRe = /\[call:([^\]]+)\]([\s\S]*?)\[\/call\]/g;
  let block;
  while ((block = blockRe.exec(text)) !== null) {
    let call;
    callRe.lastIndex = 0;
    while ((call = callRe.exec(block[1])) !== null) {
      const name = call[1].trim();
      const raw = call[2].trim();
      if (!name) continue;
      calls.push({ id: `call_${calls.length}_${Math.random().toString(36).slice(2, 8)}`, name, arguments: raw || "{}" });
    }
  }

  let content = text.replace(blockRe, "").trim();

  // Fallback: a lone JSON object with name/arguments (older prompt style).
  if (calls.length === 0) {
    const fenced = content.match(/```(?:json)?\s*(\{[\s\S]*?\})\s*```/);
    const candidates = [];
    if (fenced) candidates.push(fenced[1]);
    const braceMatch = content.match(/\{[\s\S]*\}/);
    if (braceMatch) candidates.push(braceMatch[0]);
    for (const c of candidates) {
      try {
        const obj = JSON.parse(c);
        if (obj && typeof obj.name === "string") {
          const args = obj.arguments ?? obj.parameters ?? {};
          calls.push({
            id: `call_0_${Math.random().toString(36).slice(2, 8)}`,
            name: obj.name,
            arguments: typeof args === "string" ? args : JSON.stringify(args),
          });
          content = content.replace(c, "").replace(/```(?:json)?|```/g, "").trim();
          break;
        }
      } catch {}
    }
  }

  return { content, toolCalls: calls };
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
// `tools` (optional): when present, buffer the text and, at the end, convert any
// [function_calls] block into OpenAI tool_calls (streamed as one delta).
export function buildStreamingResponse(gen, model, signal, tools) {
  const cid = `chatcmpl-web-${crypto.randomUUID().slice(0, 12)}`;
  const created = Math.floor(Date.now() / 1000);
  const encoder = new TextEncoder();
  const wantTools = Array.isArray(tools) && tools.length > 0;

  const stream = new ReadableStream({
    async start(controller) {
      let closed = false;
      const finish = () => { if (!closed) { closed = true; controller.close(); } };
      const emit = (delta, finishReason = null, extra = {}) =>
        controller.enqueue(encoder.encode(sseChunk({
          id: cid, object: "chat.completion.chunk", created, model,
          choices: [{ index: 0, delta, finish_reason: finishReason, logprobs: null }], ...extra,
        })));

      try {
        emit({ role: "assistant" });
        let buffered = "";
        for await (const chunk of gen) {
          if (signal?.aborted) break;
          if (chunk?.error) { emit({ content: `[Error: ${chunk.error}]` }); break; }
          if (chunk?.thinking) { emit({ reasoning_content: chunk.thinking }); continue; }
          if (chunk?.done) break;
          if (chunk?.delta) {
            // When tools are in play we must buffer to detect the marker mid-stream.
            if (wantTools) buffered += chunk.delta;
            else emit({ content: chunk.delta });
          }
        }

        if (wantTools && buffered) {
          const { content, toolCalls } = extractToolCalls(buffered);
          if (toolCalls.length) {
            toolCalls.forEach((tc, i) => {
              emit({
                tool_calls: [{
                  index: i, id: tc.id, type: "function",
                  function: { name: tc.name, arguments: tc.arguments },
                }],
              });
            });
            emit({}, "tool_calls");
            controller.enqueue(encoder.encode(SSE_DONE));
            return;
          }
          if (content) emit({ content });
        }

        emit({}, "stop");
        controller.enqueue(encoder.encode(SSE_DONE));
      } catch (err) {
        emit({ content: `[Stream error: ${err?.message || String(err)}]` }, "stop");
        controller.enqueue(encoder.encode(SSE_DONE));
      } finally {
        finish();
      }
    },
  });

  return { response: new Response(stream, { status: 200, headers: { ...SSE_HEADERS_NO_BUFFER } }), cid, created };
}

// Assemble a non-streaming OpenAI chat.completion Response from a generator.
// When `tools` is provided, a [function_calls] block in the text is converted
// into tool_calls (finish_reason "tool_calls") instead of plain content.
export async function buildNonStreamingResponse(gen, model, signal, tools) {
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

  let finishReason = "stop";
  if (Array.isArray(tools) && tools.length > 0 && content) {
    const parsed = extractToolCalls(content);
    if (parsed.toolCalls.length) {
      msg.content = parsed.content || null;
      msg.tool_calls = parsed.toolCalls.map((tc) => ({
        id: tc.id, type: "function", function: { name: tc.name, arguments: tc.arguments },
      }));
      finishReason = "tool_calls";
    }
  }

  const cid = `chatcmpl-web-${crypto.randomUUID().slice(0, 12)}`;
  const promptTokens = Math.ceil((content.length || 1) / 4);
  const completionTokens = Math.ceil((content.length || 1) / 4);
  return new Response(JSON.stringify({
    id: cid, object: "chat.completion", created: Math.floor(Date.now() / 1000), model,
    choices: [{ index: 0, message: msg, finish_reason: finishReason, logprobs: null }],
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
