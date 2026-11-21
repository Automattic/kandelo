import { defineConfig } from "vite";
import appConfig from "./vite.config";

// Use the same worker pipeline, artifact resolution and runtime policy as the
// application. A second minimal server can silently omit those contracts.
export default defineConfig(async env => {
  const config = typeof appConfig === "function" ? await appConfig(env) : await appConfig;
  return { ...config, server: { ...config.server, host: "127.0.0.1", hmr: false } };
});
