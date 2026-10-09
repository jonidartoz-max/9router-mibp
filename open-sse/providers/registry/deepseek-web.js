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
        "Proof-of-work is solved automatically with the official DeepSeekHash WASM.",
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
  models: [
    { id: "deepseek-chat", name: "DeepSeek V3" },
    { id: "deepseek-reasoner", name: "DeepSeek R1 (Thinking)" },
    { id: "deepseek-chat-search", name: "DeepSeek V3 + Search" },
    { id: "deepseek-reasoner-search", name: "DeepSeek R1 + Search" },
  ],
};
