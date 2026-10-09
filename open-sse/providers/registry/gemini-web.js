export default {
  id: "gemini-web",
  priority: 250,
  alias: "gemini-web",
  aliases: ["gw2", "gemweb"],
  uiAlias: "gw2",
  display: {
    name: "Gemini Web (Session)",
    icon: "diamond",
    color: "#4285F4",
    textIcon: "GMW",
    website: "https://gemini.google.com",
    notice: {
      text:
        "Uses gemini.google.com's web StreamGenerate protocol. Anonymous access serves " +
        "Flash only; paste your Google cookie string (__Secure-1PSID=…; __Secure-1PSIDTS=…; " +
        "SAPISID=…) for Pro/thinking and the full model list.",
    },
  },
  category: "webCookie",
  authType: "cookie",
  authHint: "Google cookie string (__Secure-1PSID=…; …) from gemini.google.com",
  transport: {
    baseUrl: "https://gemini.google.com/_/BardChatUi/data/assistant.lamda.BardFrontendService/StreamGenerate",
    format: "gemini-web",
    authType: "cookie",
  },
  models: [
    { id: "gemini-3.8-flash", name: "Gemini 3.8 Flash" },
    { id: "gemini-3.6-flash", name: "Gemini 3.6 Flash" },
    { id: "gemini-3.1-pro", name: "Gemini 3.1 Pro" },
    { id: "gemini-2.5-pro", name: "Gemini 2.5 Pro" },
  ],
  passthroughModels: true,
};
