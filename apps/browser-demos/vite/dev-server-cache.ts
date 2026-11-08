import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import type { Plugin } from "vite";

export function devServerCache(): Plugin {
  let directory: string | undefined;
  const dispose = () => {
    if (directory === undefined) return;
    rmSync(directory, { recursive: true, force: true });
    directory = undefined;
    process.off("exit", dispose);
  };
  return {
    name: "kandelo-dev-server-cache",
    config(config, { command, isPreview }) {
      if (command !== "serve" || isPreview) return;
      // Each server owns the optimized modules referenced by its import graph.
      // A second server must not replace those files or clean their directory.
      const parent = resolve(config.root ?? process.cwd(), config.cacheDir ?? "node_modules/.vite");
      mkdirSync(parent, { recursive: true });
      directory = mkdtempSync(join(parent, "kandelo-server-"));
      process.once("exit", dispose);
      return { cacheDir: directory };
    },
    closeBundle: dispose,
  };
}
