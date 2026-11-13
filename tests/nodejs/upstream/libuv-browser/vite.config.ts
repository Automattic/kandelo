// Preserve the application aliases and real worker protocol. The focused
// fixture requests its own modules; other product inputs need deferred images.
import appConfig from "../../../../apps/browser-demos/vite.config";
import { fileURLToPath } from "node:url";
import type { ConfigEnv } from "vite";

export default async function config(env: ConfigEnv) {
  const selected = typeof appConfig === "function" ? await appConfig(env) : await appConfig;
  return {
    ...selected,
    root: fileURLToPath(new URL("../../../../apps/browser-demos", import.meta.url)),
    optimizeDeps: { ...selected.optimizeDeps, entries: [], noDiscovery: true, include: [] },
  };
}
