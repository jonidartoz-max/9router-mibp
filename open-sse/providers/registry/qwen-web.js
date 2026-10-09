export default {
  id: "qwen-web",
  priority: 230,
  alias: "qwen-web",
  aliases: ["qw"],
  uiAlias: "qw",
  display: {
    name: "Qwen Chat Web (Session)",
    icon: "bubble_chart",
    color: "#615CED",
    textIcon: "QW",
    website: "https://chat.qwen.ai",
    notice: {
      text:
        "Uses your chat.qwen.ai session. Paste the `token` cookie value; optionally " +
        "append the WAF cookie as \"token|ssxmod_itna\". Anonymous access also works but " +
        "is rate-limited. Add \"-thinking\" to a model to enable reasoning.",
    },
  },
  category: "webCookie",
  authType: "cookie",
  authHint: "token cookie (eyJ…) from chat.qwen.ai, optionally \"|ssxmod_itna\"",
  transport: {
    baseUrl: "https://chat.qwen.ai/api/v2/chat/completions",
    format: "qwen-web",
    authType: "cookie",
  },
  models: [
    { id: "qwen3.8-max", name: "Qwen3.8 Max" },
    { id: "qwen3.7-max", name: "Qwen3.7 Max" },
    { id: "qwen3.7-plus", name: "Qwen3.7 Plus" },
    { id: "qwen3-coder", name: "Qwen3 Coder" },
    { id: "qwen3.7-max-thinking", name: "Qwen3.7 Max (Thinking)" },
    { id: "qwen3-coder-thinking", name: "Qwen3 Coder (Thinking)" },
  ],
};
