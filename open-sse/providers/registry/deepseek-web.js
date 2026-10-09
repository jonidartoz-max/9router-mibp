export default {
  id: "deepseek-web",
  priority: 210,
  alias: "deepseek-web",
  aliases: ["dsw"],
  uiAlias: "dsw",
  display: {
    name: "DeepSeek Web (Session)",
    icon: "bolt",
    color: "#4D6BFE",
    textIcon: "DSW",
    website: "https://chat.deepseek.com",
    notice: {
      text:
        "Uses your logged-in DeepSeek web session instead of an API key. " +
        "Paste the userToken (localStorage); the session cookie is optional — " +
        "one is generated if omitted. Web search, thinking and tool-calls all work. " +
        "Proof-of-work is solved automatically with the official DeepSeekHash WASM. " +
        "chat.deepseek.com serves DeepSeek V4.1-Flash; the backend picks the exact " +
        "weights, so 'Instant' (non-thinking) and 'Expert' (thinking) are the same " +
        "model with different reasoning toggles.",
    },
  },
  category: "webCookie",
  authType: "cookie",
  authHint: "userToken (cookie optional)",
  transport: {
    baseUrl: "https://chat.deepseek.com/api/v0/chat/completion",
    format: "deepseek-web",
    authType: "cookie",
  },
  // The web app (2026-10) exposes Instant (non-thinking) and Expert (thinking),
  // both served by DeepSeek V4.1-Flash. The completion endpoint currently ignores
  // model_type and keys off thinking_enabled / search_enabled, so we send both and
  // keep the old slugs so existing client configs keep working.
  models: [
    { id: "deepseek-chat", name: "DeepSeek V4.1-Flash (Instant)" },
    { id: "deepseek-reasoner", name: "DeepSeek V4.1-Flash (Expert · Thinking)" },
    { id: "deepseek-chat-search", name: "DeepSeek V4.1-Flash + Search" },
    { id: "deepseek-reasoner-search", name: "DeepSeek V4.1-Flash Thinking + Search" },
  ],
};
