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
        "Paste the userToken (localStorage) and, separated by \"|\", the session cookie: " +
        "\"userToken|cookie\". Solve the per-message proof-of-work automatically.",
    },
  },
  category: "webCookie",
  authType: "cookie",
  authHint: "userToken|cookie (from chat.deepseek.com)",
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
