import { CLAUDE_API_HEADERS } from "../shared.js";

// Z.ai (Zhipu GLM) — dual auth like kimi/xai:
//   OAuth = Z.ai account / GLM Coding Plan via ZCode OAuth proxy (authorization_code)
//   API key = api.z.ai / open.bigmodel.cn API keys
// OAuth client_id is the ZCode desktop app's public client. The token exchange
// goes through zcode.z.ai's backend proxy (which holds the real client_secret),
// so no client_secret is needed on our side — we POST {provider:"zai", code, ...}
// to https://zcode.z.ai/api/v1/oauth/token and get back data.zai.access_token.
// Verified against ZCode 3.7.5 desktop app (out/host/index.js runtime config).
export default {
  id: "zai",
  priority: 155,
  alias: "zai",
  display: {
    name: "Z.ai (GLM)",
    icon: "bolt",
    color: "#2563EB",
    textIcon: "ZA",
    website: "https://zcode.z.ai",
    notice: {
      apiKeyUrl: "https://open.bigmodel.cn/usercenter/apikeys",
      signupUrl: "https://z.ai",
    },
  },
  category: "oauth",
  authModes: ["oauth", "apikey"],
  hasOAuth: true,
  transport: {
    baseUrl: "https://api.z.ai/api/anthropic/v1/messages",
    format: "claude",
    urlSuffix: "?beta=true",
    headers: { ...CLAUDE_API_HEADERS },
    auth: {
      combined: true,
      header: "x-api-key",
      scheme: "raw",
    },
    usage: {
      url: "https://api.z.ai/api/monitor/usage/quota/limit",
    },
  },
  // Multi-endpoint: pick the transport matching client sourceFormat to skip translation.
  transports: [
    {
      format: "openai",
      baseUrl: "https://api.z.ai/api/coding/paas/v4/chat/completions",
      auth: { combined: true, header: "Authorization", scheme: "bearer" },
    },
    {
      format: "claude",
      baseUrl: "https://api.z.ai/api/anthropic/v1/messages",
      urlSuffix: "?beta=true",
      headers: { ...CLAUDE_API_HEADERS },
      auth: { combined: true, header: "x-api-key", scheme: "raw" },
    },
  ],
  models: [
    { id: "glm-5.2", name: "GLM 5.2" },
    { id: "glm-5.1", name: "GLM 5.1" },
    { id: "glm-5", name: "GLM 5" },
    { id: "glm-5-turbo", name: "GLM 5 Turbo" },
    { id: "glm-5v-turbo", name: "GLM 5V Turbo (Vision)" },
    { id: "glm-4.7", name: "GLM 4.7" },
    { id: "glm-4.7-flash", name: "GLM 4.7 Flash" },
    { id: "glm-4.7-flashx", name: "GLM 4.7 FlashX" },
    { id: "glm-4.6v", name: "GLM 4.6V (Vision)" },
    { id: "glm-4.6", name: "GLM 4.6" },
  ],
  oauth: {
    clientId: "client_P8X5CMWmlaRO9gyO-KSqtg",
    authorizeUrl: "https://chat.z.ai/api/oauth/authorize",
    tokenUrl: "https://zcode.z.ai/api/v1/oauth/token",
    userinfoUrl: "https://chat.z.ai/api/oauth/userinfo",
    businessLoginUrl: "https://api.z.ai/api/auth/z/login",
    redirectUri: "zcode://oauth/callback",
    // Token exchange goes through ZCode backend proxy — no client_secret needed client-side
    requiresClientSecret: false,
    // Z.ai tokens: access token long-lived (~30d), refresh via same proxy
    refreshLeadMs: 300000,
  },
  features: {
    usage: true,
    usageApikey: true,
  },
};
