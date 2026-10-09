// Claude Web (claude.ai) — chat2api executor.
//
// Protocol (reverse-engineered, 2026-10):
//   1. Resolve the org UUID (from the `lastActiveOrg` cookie or /api/organizations).
//   2. POST /api/organizations/{org}/chat_conversations
//        { uuid, name, model }                       → conversation uuid
//   3. POST /api/organizations/{org}/chat_conversations/{uuid}/completion
//        { prompt, parent_message_uuid, timezone, ... } → Anthropic-style SSE:
//        content_block_delta { delta: { type:"text_delta", text } }
//        content_block_delta { delta: { type:"thinking_delta", thinking } }
//        message_stop → done.
//
// Auth: the `sessionKey` cookie (starts with "sk-ant-sid02-…"). The org UUID is
// required — pass it after a "|" ("sessionKey|orgUuid"); when omitted we try the
// lastActiveOrg cookie, then /api/organizations.
//
// Note: claude.ai sits behind Cloudflare and may demand a `cf_clearance` cookie.
// If requests 403, the user must include it too — paste "sessionKey|orgUuid|cfClearance".

import { BaseExecutor } from "./base.js";
import { PROVIDERS } from "../config/providers.js";
import {
  splitCredential,
  parseOpenAIMessages,
  formatToolsHint,
  jsonError,
  badRequest,
  buildStreamingResponse,
  buildNonStreamingResponse,
  readLines,
} from "./webChatShared.js";

const BASE = "https://claude.ai";
const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36";

const MODEL_MAP = {
  "claude-sonnet-4.6": "claude-sonnet-4-6",
  "claude-opus-4.6": "claude-opus-4-6",
  "claude-sonnet-4.5": "claude-sonnet-4-5",
  "claude-haiku-4.5": "claude-haiku-4-5",
};

function buildHeaders(credential) {
  const parts = String(credential ?? "").split("|");
  const sessionKey = (parts[0] || "").trim();
  const orgId = (parts[1] || "").trim();
  const cfClearance = (parts[2] || "").trim();
  const cookies = [];
  if (sessionKey) cookies.push(`sessionKey=${sessionKey}`);
  if (orgId) cookies.push(`lastActiveOrg=${orgId}`);
  if (cfClearance) cookies.push(`cf_clearance=${cfClearance}`);
  return {
    headers: {
      Accept: "text/event-stream",
      "Accept-Language": "en-US,en;q=0.9",
      "Content-Type": "application/json",
      Origin: BASE,
      Referer: `${BASE}/`,
      "User-Agent": UA,
      "anthropic-client-platform": "web_claude_ai",
      ...(cookies.length ? { Cookie: cookies.join("; ") } : {}),
    },
    sessionKey,
    orgId,
  };
}

async function resolveOrg(headers, providedOrg, signal) {
  if (providedOrg) return providedOrg;
  try {
    const res = await fetch(`${BASE}/api/organizations`, { headers, signal });
    if (res.ok) {
      const orgs = await res.json();
      if (Array.isArray(orgs) && orgs[0]?.uuid) return orgs[0].uuid;
    }
  } catch { /* fall through */ }
  return null;
}

async function createConversation(headers, orgId, model, signal) {
  const res = await fetch(`${BASE}/api/organizations/${orgId}/chat_conversations`, {
    method: "POST",
    headers,
    body: JSON.stringify({ uuid: crypto.randomUUID(), name: "", model }),
    signal,
  });
  if (!res.ok) return null;
  const data = await res.json().catch(() => ({}));
  return data?.uuid || null;
}

// Parse Anthropic's SSE (text_delta / thinking_delta / message_stop).
async function* extractContent(body, signal) {
  for await (const line of readLines(body, signal)) {
    if (!line.startsWith("data:")) continue;
    const payload = line.slice(5).trim();
    if (!payload) continue;
    let ev;
    try { ev = JSON.parse(payload); } catch { continue; }

    if (ev.type === "content_block_delta") {
      const d = ev.delta || {};
      if (d.type === "text_delta" && d.text) yield { delta: d.text };
      else if (d.type === "thinking_delta" && d.thinking) yield { thinking: d.thinking };
    } else if (ev.type === "message_stop" || ev.type === "message_limit") {
      break;
    } else if (ev.type === "error") {
      yield { error: ev.error?.message || "Claude stream error" };
      return;
    }
  }
  yield { done: true };
}

export class ClaudeWebExecutor extends BaseExecutor {
  constructor() {
    super("claude-web", PROVIDERS["claude-web"]);
  }

  async execute({ model, body, stream, credentials, signal, log }) {
    const messages = body?.messages;
    if (!Array.isArray(messages) || messages.length === 0) {
      return { response: badRequest("Missing or empty messages array"), url: BASE, headers: {}, transformedBody: body };
    }

    const { headers, sessionKey, orgId: providedOrg } = buildHeaders(credentials?.apiKey || credentials?.accessToken || "");
    if (!sessionKey) {
      return { response: badRequest("Claude Web needs the sessionKey cookie (sk-ant-sid02-…)"), url: BASE, headers, transformedBody: body };
    }

    const upstreamModel = MODEL_MAP[model] || model || "claude-sonnet-4-6";
    const parsed = parseOpenAIMessages(messages);
    let prompt = parsed.flatPrompt;
    const toolsHint = formatToolsHint(body?.tools);
    if (toolsHint) prompt += toolsHint;
    if (!prompt.trim()) {
      return { response: badRequest("Empty query after processing"), url: BASE, headers, transformedBody: body };
    }

    const orgId = await resolveOrg(headers, providedOrg, signal);
    if (!orgId) {
      return {
        response: jsonError("Claude Web could not resolve the organization — sessionKey may be expired, or pass it explicitly as \"sessionKey|orgUuid\"."),
        url: BASE, headers, transformedBody: body,
      };
    }

    let convId;
    try {
      convId = await createConversation(headers, orgId, upstreamModel, signal);
    } catch (err) {
      return { response: jsonError(`Claude conversation create failed: ${err.message || String(err)}`), url: BASE, headers, transformedBody: body };
    }
    if (!convId) {
      return { response: jsonError("Claude refused to create a conversation — sessionKey/cf_clearance likely expired."), url: BASE, headers, transformedBody: body };
    }

    const url = `${BASE}/api/organizations/${orgId}/chat_conversations/${convId}/completion`;
    const payload = {
      prompt,
      parent_message_uuid: "00000000-0000-4000-8000-000000000000",
      timezone: "Asia/Jakarta",
      attachments: [],
      files: [],
      sync_sources: [],
      rendering_mode: "messages",
    };

    log?.info?.("CLAUDE-WEB", `Query ${model}→${upstreamModel} org=${orgId.slice(0, 8)} conv=${convId.slice(0, 8)}, len=${prompt.length}`);

    let response;
    try {
      response = await fetch(url, { method: "POST", headers, body: JSON.stringify(payload), signal });
    } catch (err) {
      return { response: jsonError(`Claude connection failed: ${err.message || String(err)}`), url, headers, transformedBody: payload };
    }

    if (!response.ok) {
      const status = response.status;
      let msg = `Claude returned HTTP ${status}`;
      if (status === 401 || status === 403) msg = "Claude auth failed — sessionKey (and cf_clearance if Cloudflare challenges) may be expired.";
      else if (status === 429) msg = "Claude rate limited. Wait and retry.";
      log?.warn?.("CLAUDE-WEB", msg);
      return { response: jsonError(msg, status, `HTTP_${status}`), url, headers, transformedBody: payload };
    }

    if (!response.body) {
      return { response: jsonError("Claude returned an empty body"), url, headers, transformedBody: payload };
    }

    // Best-effort cleanup so the throwaway conversation never lingers in the sidebar.
    const cleanup = () => {
      fetch(`${BASE}/api/organizations/${orgId}/chat_conversations/${convId}`, { method: "DELETE", headers }).catch(() => {});
    };

    if (stream) {
      const { response: sseResponse } = buildStreamingResponse(extractContent(response.body, signal), model, signal);
      return { response: sseResponse, url, headers, transformedBody: payload, onComplete: cleanup };
    }
    const finalResponse = await buildNonStreamingResponse(extractContent(response.body, signal), model, signal);
    cleanup();
    return { response: finalResponse, url, headers, transformedBody: payload };
  }
}

export default ClaudeWebExecutor;
