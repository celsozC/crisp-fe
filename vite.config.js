import { defineConfig, loadEnv } from "vite";
import { crispProxyPlugin } from "./crisp-proxy-plugin.js";

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");

  return {
    plugins: [crispProxyPlugin(env)],
  };
});
