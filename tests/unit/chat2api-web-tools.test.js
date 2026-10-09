// Chat2API Pack — tool-calling coverage for the six webCookie providers.
//
// Four providers (deepseek/qwen/claude/gemini) share one prompt+builder in
// open-sse/executors/webChatShared.js; grok-web and perplexity-web build their own
// SSE but reuse the same helpers (extractToolCalls / TOOL_RESULT_FOLLOWUP /
// messageToText). These tests pin the behaviour that makes tool-calling work:
//
//  1. formatToolsHint emits the bracket protocol ([function_calls] / [call:name]).
//  2. parseOpenAIMessages KEEPS assistant tool_calls and labels tool results, so the
//     model learns the tool already ran (without it, it re-calls forever).
//  3. A transcript ending in a tool result gets TOOL_RESULT_FOLLOWUP (stop looping).
//  4. extractToolCalls turns the bracket reply back into OpenAI tool_calls.
//  5. Every executor's execute() path returns finish_reason "tool_calls" (streaming
//     and non-streaming) when the upstream emits a bracket reply.
import { describe, expect, it, vi, afterEach } from "vitest";

import {
  formatToolsHint,
  extractToolCalls,
  endsWithToolResult,
  messageToText,
  parseOpenAIMessages,
  TOOL_RESULT_FOLLOWUP,
} from "../../open-sse/executors/webChatShared.js";

const WEATHER_TOOLS = [
  {
    type: "function",
    function: {
      name: "get_weather",
      description: "Get the weather",
      parameters: { type: "object", properties: { city: { type: "string" } }, required: ["city"] },
    },
  },
];

const BRACKET_REPLY = '[function_calls]\n[call:get_weather]{"city":"Jakarta"}[/call]\n[/function_calls]';

afterEach(() => {
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------- shared helpers
describe("webChatShared — shared by deepseek/qwen/claude/gemini", () => {
  it("formatToolsHint advertises the bracket protocol and the tool schema", () => {
    const hint = formatToolsHint(WEATHER_TOOLS);
    expect(hint).toContain("[function_calls]");
    expect(hint).toContain("[call:");
    expect(hint).toContain("get_weather");
    expect(hint).toContain("city");
  });

  it("formatToolsHint is empty when there are no tools", () => {
    expect(formatToolsHint([])).toBe("");
    expect(formatToolsHint(undefined)).toBe("");
  });

  it("extractToolCalls parses a bracket reply into OpenAI tool_calls", () => {
    const { content, toolCalls } = extractToolCalls(BRACKET_REPLY);
    expect(toolCalls).toHaveLength(1);
    expect(toolCalls[0].name).toBe("get_weather");
    expect(JSON.parse(toolCalls[0].arguments)).toEqual({ city: "Jakarta" });
    expect(content).toBe("");
  });

  it("extractToolCalls parses several calls and keeps surrounding prose", () => {
    const reply = 'Let me check.\n[function_calls]\n[call:get_weather]{"city":"A"}[/call]\n[call:get_weather]{"city":"B"}[/call]\n[/function_calls]';
    const { content, toolCalls } = extractToolCalls(reply);
    expect(toolCalls).toHaveLength(2);
    expect(JSON.parse(toolCalls[1].arguments)).toEqual({ city: "B" });
    expect(content).toContain("Let me check.");
  });

  it("extractToolCalls returns plain text untouched when there is no call block", () => {
    const { content, toolCalls } = extractToolCalls("The weather is sunny.");
    expect(toolCalls).toHaveLength(0);
    expect(content).toBe("The weather is sunny.");
  });

  it("messageToText re-renders an assistant tool_calls message as a bracket block", () => {
    const text = messageToText({
      role: "assistant",
      content: null,
      tool_calls: [{ id: "call_1", type: "function", function: { name: "get_weather", arguments: '{"city":"Jakarta"}' } }],
    });
    expect(text).toContain("[function_calls]");
    expect(text).toContain("[call:get_weather]");
    expect(text).toContain("Jakarta");
  });

  it("messageToText labels a tool result so the pairing survives", () => {
    const text = messageToText({ role: "tool", tool_call_id: "call_1", content: '{"temp_c":32}' });
    expect(text).toContain("[TOOL_RESULT for call_1]");
    expect(text).toContain("32");
  });

  it("parseOpenAIMessages KEEPS the assistant tool_calls and the tool result", () => {
    const parsed = parseOpenAIMessages([
      { role: "user", content: "weather in Jakarta?" },
      { role: "assistant", content: null, tool_calls: [{ id: "call_1", type: "function", function: { name: "get_weather", arguments: '{"city":"Jakarta"}' } }] },
      { role: "tool", tool_call_id: "call_1", content: '{"temp_c":32}' },
    ]);
    // The tool_calls assistant turn survives as a bracket block, and the tool
    // result is labelled — this is what stops the model re-calling the tool.
    expect(parsed.flatPrompt).toContain("[function_calls]");
    expect(parsed.flatPrompt).toContain("[TOOL_RESULT for call_1]");
    expect(parsed.items.some((m) => m.content.includes("[function_calls]"))).toBe(true);
    expect(parsed.items.some((m) => m.role === "tool")).toBe(true);
  });

  it("endsWithToolResult is true only when the transcript ends on tool output", () => {
    expect(endsWithToolResult([{ role: "user", content: "hi" }, { role: "tool", content: "x" }])).toBe(true);
    expect(endsWithToolResult([{ role: "user", content: "hi" }])).toBe(false);
    expect(endsWithToolResult([{ role: "tool", content: "x" }, { role: "user", content: "thanks" }])).toBe(false);
  });

  it("TOOL_RESULT_FOLLOWUP tells the model to answer, not re-call", () => {
    expect(TOOL_RESULT_FOLLOWUP).toMatch(/do not emit another \[function_calls\]/i);
  });
});

// ------------------------------------------------------------------ grok-web
// Grok streams NDJSON: {result:{response:{token}}} for text, and a single
// {result:{response:{modelResponse:{message}}}} for the final/tool reply.
function grokNdjson(lines) {
  const enc = new TextEncoder();
  return new ReadableStream({
    start(c) { for (const l of lines) c.enqueue(enc.encode(l + "\n")); c.close(); },
  });
}
const grokText = (tokens) => tokens.map((t) => JSON.stringify({ result: { response: { token: t } } }));
const grokFinal = (text) => [JSON.stringify({ result: { response: { modelResponse: { message: text } } } })];

function stubFetch(bodyFactory) {
  vi.stubGlobal("fetch", async () => new Response(bodyFactory(), { status: 200 }));
}

async function readOpenAiSse(res) {
  const out = { content: "", toolCalls: [], finish: null };
  for (const line of (await res.text()).split("\n")) {
    if (!line.startsWith("data:")) continue;
    const p = line.slice(5).trim();
    if (!p || p === "[DONE]") continue;
    const ch = JSON.parse(p).choices?.[0];
    if (!ch) continue;
    if (ch.delta?.content) out.content += ch.delta.content;
    if (ch.delta?.tool_calls) out.toolCalls.push(...ch.delta.tool_calls);
    if (ch.finish_reason) out.finish = ch.finish_reason;
  }
  return out;
}

describe("grok-web tool-calling", () => {
  it("passes plain tokens through as content", async () => {
    stubFetch(() => grokNdjson(grokText(["Hello", " world"])));
    const { GrokWebExecutor } = await import("../../open-sse/executors/grok-web.js");
    const out = await new GrokWebExecutor().execute({
      model: "grok-4", stream: true, credentials: { apiKey: "sso=abc" }, log: {},
      body: { messages: [{ role: "user", content: "hi" }] },
    });
    const sse = await readOpenAiSse(out.response);
    expect(sse.content).toBe("Hello world");
    expect(sse.finish).toBe("stop");
  });

  it("returns finish_reason tool_calls (non-streaming)", async () => {
    stubFetch(() => grokNdjson(grokFinal(BRACKET_REPLY)));
    const { GrokWebExecutor } = await import("../../open-sse/executors/grok-web.js");
    const out = await new GrokWebExecutor().execute({
      model: "grok-4", stream: false, credentials: { apiKey: "sso=abc" }, log: {},
      body: { messages: [{ role: "user", content: "weather?" }], tools: WEATHER_TOOLS },
    });
    const json = JSON.parse(await out.response.text());
    expect(json.choices[0].finish_reason).toBe("tool_calls");
    expect(json.choices[0].message.tool_calls[0].function.name).toBe("get_weather");
    expect(json.choices[0].message.content).toBeNull();
  });

  it("returns finish_reason tool_calls (streaming)", async () => {
    stubFetch(() => grokNdjson(grokFinal(BRACKET_REPLY)));
    const { GrokWebExecutor } = await import("../../open-sse/executors/grok-web.js");
    const out = await new GrokWebExecutor().execute({
      model: "grok-4", stream: true, credentials: { apiKey: "sso=abc" }, log: {},
      body: { messages: [{ role: "user", content: "weather?" }], tools: WEATHER_TOOLS },
    });
    const sse = await readOpenAiSse(out.response);
    expect(sse.toolCalls).toHaveLength(1);
    expect(sse.finish).toBe("tool_calls");
  });

  it("sends the bracket protocol and the followup after a tool result", async () => {
    let sent = null;
    vi.stubGlobal("fetch", async (_url, opts) => {
      sent = JSON.parse(opts.body);
      return new Response(grokNdjson(grokFinal("done")), { status: 200 });
    });
    const { GrokWebExecutor } = await import("../../open-sse/executors/grok-web.js");
    await new GrokWebExecutor().execute({
      model: "grok-4", stream: false, credentials: { apiKey: "sso=abc" }, log: {},
      body: {
        tools: WEATHER_TOOLS,
        messages: [
          { role: "user", content: "weather?" },
          { role: "assistant", content: null, tool_calls: [{ id: "call_1", type: "function", function: { name: "get_weather", arguments: '{"city":"Jakarta"}' } }] },
          { role: "tool", tool_call_id: "call_1", content: '{"temp_c":32}' },
        ],
      },
    });
    expect(sent.message).toContain("[function_calls]");
    expect(sent.message).toContain("[TOOL_RESULT for call_1]");
    expect(sent.message).toMatch(/do not emit another \[function_calls\]/i);
  });
});

// -------------------------------------------------------------- perplexity-web
// Perplexity streams SSE "data: {json}" frames with markdown blocks.
function pplxSse(blocks) {
  const enc = new TextEncoder();
  const text = blocks.map((b) => `data: ${JSON.stringify({ blocks: [b] })}\n\n`).join("");
  return new ReadableStream({ start(c) { c.enqueue(enc.encode(text)); c.close(); } });
}
const pplxMarkdown = (text) => ({ intended_usage: "markdown_block", markdown_block: { chunks: [text], progress: "DONE" } });

describe("perplexity-web tool-calling", () => {
  it("formatToolsHint advertises invokable tools (no longer reference-only)", async () => {
    const { formatToolsHint: pplxHint } = await import("../../open-sse/executors/perplexity-web.js");
    const hint = pplxHint(WEATHER_TOOLS);
    expect(hint).toContain("[function_calls]");
    expect(hint).toContain("get_weather");
    expect(hint.toLowerCase()).not.toContain("cannot invoke");
  });

  it("buildQuery appends the followup after a tool result", async () => {
    const { buildQuery } = await import("../../open-sse/executors/perplexity-web.js");
    const parsed = {
      systemMsg: "",
      history: [
        { role: "user", content: "weather?" },
        { role: "assistant", content: BRACKET_REPLY },
        { role: "tool", content: "[TOOL_RESULT for call_1] 32C" },
      ],
      currentMsg: "",
    };
    const q = buildQuery(parsed, null, WEATHER_TOOLS);
    expect(q).toMatch(/do not emit another \[function_calls\]/i);
    expect(q).toContain("[TOOL_RESULT for");
  });

  it("returns finish_reason tool_calls (non-streaming)", async () => {
    stubFetch(() => pplxSse([pplxMarkdown(BRACKET_REPLY)]));
    const { PerplexityWebExecutor } = await import("../../open-sse/executors/perplexity-web.js");
    const out = await new PerplexityWebExecutor().execute({
      model: "pplx-gpt", stream: false, credentials: { apiKey: "tok" }, log: {},
      body: { messages: [{ role: "user", content: "weather?" }], tools: WEATHER_TOOLS },
    });
    const json = JSON.parse(await out.response.text());
    expect(json.choices[0].finish_reason).toBe("tool_calls");
    expect(json.choices[0].message.tool_calls[0].function.name).toBe("get_weather");
  });

  it("returns finish_reason tool_calls (streaming)", async () => {
    stubFetch(() => pplxSse([pplxMarkdown(BRACKET_REPLY)]));
    const { PerplexityWebExecutor } = await import("../../open-sse/executors/perplexity-web.js");
    const out = await new PerplexityWebExecutor().execute({
      model: "pplx-gpt", stream: true, credentials: { apiKey: "tok" }, log: {},
      body: { messages: [{ role: "user", content: "weather?" }], tools: WEATHER_TOOLS },
    });
    const sse = await readOpenAiSse(out.response);
    expect(sse.toolCalls).toHaveLength(1);
    expect(sse.finish).toBe("tool_calls");
  });
});

// ------------------------------------------- the four shared-builder providers
describe("deepseek/qwen/claude/gemini share the tool-calling builder", () => {
  it("each executor imports the shared helper and wires body.tools", async () => {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const dir = path.resolve(__dirname, "../../open-sse/executors");
    for (const name of ["deepseek-web", "qwen-web", "claude-web", "gemini-web"]) {
      const src = fs.readFileSync(path.join(dir, `${name}.js`), "utf8");
      expect(src, `${name} imports webChatShared`).toContain("webChatShared.js");
      expect(src, `${name} uses formatToolsHint`).toContain("formatToolsHint");
      expect(src, `${name} wires body?.tools`).toMatch(/body\?\.tools|body\.tools/);
    }
  });
});
