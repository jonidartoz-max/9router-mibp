export default {
  id: "claude-web",
  priority: 240,
  alias: "claude-web",
  aliases: ["cw"],
  uiAlias: "cw",
  display: {
    name: "Claude Web (Subscription)",
    icon: "psychology",
    color: "#D97757",
    textIcon: "CW",
    website: "https://claude.ai",
    notice: {
      text:
        "Uses your claude.ai subscription session instead of an API key. Paste " +
        "\"sessionKey|orgUuid\" (orgUuid from the lastActiveOrg cookie). If Cloudflare " +
        "challenges the request, append your cf_clearance as a third field: " +
        "\"sessionKey|orgUuid|cfClearance\".",
    },
  },
  category: "webCookie",
  authType: "cookie",
  authHint: "sessionKey|orgUuid (sk-ant-sid02-…) from claude.ai",
  transport: {
    baseUrl: "https://claude.ai/api/organizations",
    format: "claude-web",
    authType: "cookie",
  },
  models: [
    { id: "claude-opus-5.5", name: "Claude Opus 5.5" },
    { id: "claude-sonnet-5.5", name: "Claude Sonnet 5.5" },
    { id: "claude-fable-5.1", name: "Claude Fable 5.1" },
    { id: "claude-opus-5", name: "Claude Opus 5" },
    { id: "claude-sonnet-5", name: "Claude Sonnet 5" },
    { id: "claude-opus-4.8", name: "Claude Opus 4.8" },
    { id: "claude-opus-4.7", name: "Claude Opus 4.7" },
    { id: "claude-sonnet-4.6", name: "Claude Sonnet 4.6" },
    { id: "claude-opus-4.6", name: "Claude Opus 4.6" },
    { id: "claude-haiku-4.5", name: "Claude Haiku 4.5" },
  ],
  passthroughModels: true,
};
