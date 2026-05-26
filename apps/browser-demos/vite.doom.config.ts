import path from "path";
import { fileURLToPath } from "url";
import { defineConfig, mergeConfig } from "vite";
import baseConfig from "./vite.config";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig((env) => {
  const base = typeof baseConfig === "function" ? baseConfig(env) : baseConfig;
  const doomInput = path.resolve(__dirname, "pages/doom/index.html");
  const config = mergeConfig(base, {
    optimizeDeps: {
      entries: [doomInput],
    },
    build: {
      rollupOptions: {
        input: {
          doom: doomInput,
        },
      },
    },
  });
  config.build ??= {};
  config.build.rollupOptions ??= {};
  config.build.rollupOptions.input = { doom: doomInput };
  return config;
});
