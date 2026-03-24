import { createProxyMiddleware } from "http-proxy-middleware";

/**
 * @param {Record<string, string>} env from Vite `loadEnv` (loads `.env`, etc.)
 */
export function crispProxyPlugin(env) {
  const websiteId = (env.WEBSITE_ID ?? "").trim();
  const id = (env.PLUGIN_IDENTIFIER ?? "").trim();
  const key = (env.PLUGIN_KEY ?? "").trim();
  const missingCreds = !id || !key;

  /** Browser cookies (Crisp widget, other sites) must not be sent — Crisp returns 401. Strip any client Authorization too. */
  const headersToStrip = ["cookie", "authorization"];

  // http-proxy-middleware v3 only wires `on.proxyReq`, not top-level `onProxyReq` (that was v2 / legacy).
  const crispProxy = createProxyMiddleware({
    target: "https://api.crisp.chat",
    changeOrigin: true,
    secure: true,
    pathRewrite: { "^/crisp-api": "" },
    on: {
      proxyReq(proxyReq) {
        for (const h of headersToStrip) {
          proxyReq.removeHeader(h);
        }
        const token = Buffer.from(`${id}:${key}`).toString("base64");
        proxyReq.setHeader("Authorization", `Basic ${token}`);
        proxyReq.setHeader("X-Crisp-Tier", "plugin");
      },
    },
  });

  function setup(server) {
    if (missingCreds) {
      console.warn("\n[crisp] Set PLUGIN_IDENTIFIER and PLUGIN_KEY in .env (Crisp API proxy disabled until then).\n");
    }

    server.middlewares.use((req, res, next) => {
      const path = req.url?.split("?")[0] ?? "";
      if (path !== "/api/config") {
        next();
        return;
      }
      if (req.method !== "GET") {
        next();
        return;
      }
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ websiteId }));
    });

    if (!missingCreds) {
      server.middlewares.use("/crisp-api", crispProxy);
    } else {
      server.middlewares.use("/crisp-api", (_req, res) => {
        res.statusCode = 503;
        res.setHeader("Content-Type", "application/json");
        res.end(
          JSON.stringify({
            error: true,
            reason: "Missing PLUGIN_IDENTIFIER or PLUGIN_KEY in .env",
          })
        );
      });
    }
  }

  return {
    name: "crisp-proxy",
    configureServer: setup,
    configurePreviewServer: setup,
  };
}
