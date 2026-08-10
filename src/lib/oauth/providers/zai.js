import { ZAI_CONFIG } from "../constants/oauth.js";

// Z.ai (Zhipu GLM) OAuth — authorization_code via ZCode backend proxy.
//   1) Browser opens chat.z.ai/api/oauth/authorize?client_id=...&response_type=code&redirect_uri=...&state=...
//   2) User logs in / consents → redirect to redirect_uri?code=...&state=...
//   3) POST zcode.z.ai/api/v1/oauth/token {provider:"zai", code, redirect_uri, state}
//      → backend (holds client_secret) exchanges with Z.ai and returns
//        { data: { zai: { access_token }, token?, user? } }
//   4) data.zai.access_token = the API token used as x-api-key / Bearer for GLM.
//      It's a business token; best-effort resolve to a durable token via
//      api.z.ai/api/auth/z/login {token} → { data: { access_token } } (cached).
// Verified against ZCode 3.7.5 desktop (out/host/index.js runtime config).
const zai = {
  config: ZAI_CONFIG,
  flowType: "authorization_code_pkce",
  callbackPath: "/callback",
  buildAuthUrl: (config, redirectUri, state, codeChallenge) => {
    const params = new URLSearchParams({
      client_id: config.clientId,
      response_type: "code",
      redirect_uri: redirectUri,
      state: state,
    });
    if (codeChallenge) {
      params.set("code_challenge", codeChallenge);
      params.set("code_challenge_method", "S256");
    }
    return `${config.authorizeUrl}?${params.toString()}`;
  },
  exchangeToken: async (config, code, redirectUri, codeVerifier, state) => {
    const body = JSON.stringify({
      provider: "zai",
      code: String(code || "").trim(),
      redirect_uri: redirectUri,
      state: state,
    });
    const response = await fetch(config.tokenUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        "User-Agent": "antigravity-cockpit-tools",
      },
      body,
    });
    const text = await response.text();
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      throw new Error(`Z.ai token exchange returned non-JSON: ${text.slice(0, 200)}`);
    }
    if (!response.ok || (data.success === false && data.code !== 0 && data.code !== 200)) {
      const msg = data.msg || data.detail || data.error_description || `HTTP ${response.status}`;
      throw new Error(`Z.ai token exchange failed: ${msg}`);
    }
    // The proxy returns the raw upstream payload; find the zai access token.
    const accessToken =
      data?.data?.zai?.access_token ||
      data?.data?.access_token ||
      data?.zai?.access_token ||
      data?.access_token ||
      null;
    if (!accessToken) {
      throw new Error(`Z.ai token exchange response missing access_token: ${JSON.stringify(data).slice(0, 300)}`);
    }
    return {
      accessToken,
      // The proxy may also return a refresh/rotated token under data.token / data.data.token
      refreshToken: data?.data?.zai?.refresh_token || data?.data?.refresh_token || null,
      expiresIn: data?.data?.zai?.expires_in || data?.data?.expires_in || null,
      _raw: data,
    };
  },
  postExchange: async (tokens) => {
    // Best-effort: exchange the business token for a durable API token via Z.ai business login.
    let durableToken = tokens.accessToken;
    let userInfo = null;
    try {
      const res = await fetch(ZAI_CONFIG.businessLoginUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ token: tokens.accessToken }),
      });
      const data = await res.json();
      if (data?.success !== false && data?.data?.access_token) {
        durableToken = data.data.access_token;
        if (data.data.expires_in) tokens.expiresIn = data.data.expires_in;
        userInfo = data.data.user || data.data.userInfo || null;
      }
    } catch { /* keep original token */ }
    // Fetch user profile for email/name display.
    let email = userInfo?.email || userInfo?.name || null;
    let name = userInfo?.displayName || userInfo?.nickname || userInfo?.username || null;
    try {
      const res = await fetch(ZAI_CONFIG.userinfoUrl, {
        headers: { Authorization: `Bearer ${durableToken}` },
      });
      const data = await res.json();
      if (data && !data.error) {
        email = email || data.email || data.user?.email || null;
        name = name || data.name || data.user?.name || data.nickname || null;
      }
    } catch { /* best-effort */ }
    return { userInfo: { email, name }, accessToken: durableToken };
  },
  mapTokens: (tokens, extra) => ({
    accessToken: extra?.accessToken || tokens.accessToken,
    refreshToken: tokens.refreshToken,
    expiresIn: tokens.expiresIn,
    email: extra?.userInfo?.email || undefined,
    displayName: extra?.userInfo?.name || undefined,
    providerSpecificData: {
      authMethod: "oauth",
      userId: extra?.userInfo?.userId || "",
      plan: "zai",
    },
  }),
};

export default zai;
