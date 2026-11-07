import { expect, test } from "@playwright/test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer, type ViteDevServer } from "vite";
import { devServerCache } from "../vite/dev-server-cache";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

test("concurrent Vite servers preserve their own optimized dependency graph", async ({ browser }) => {
  test.setTimeout(60_000);
  const root = mkdtempSync(join(repoRoot, ".context/vite-cache-fixture-"));
  const servers: ViteDevServer[] = [];
  const contexts: Awaited<ReturnType<typeof browser.newContext>>[] = [];
  const dependency = join(root, "node_modules/cache-fixture-dependency");
  mkdirSync(dependency, { recursive: true });
  writeFileSync(join(root, "package.json"), JSON.stringify({ type: "module" }));
  writeFileSync(join(dependency, "package.json"), JSON.stringify({
    name: "cache-fixture-dependency", version: "1.0.0", type: "module", exports: "./index.js",
  }));
  writeFileSync(join(dependency, "index.js"), "export const server = __SERVER_NAME__;\n");
  writeFileSync(join(root, "index.html"), '<!doctype html><body><script type="module" src="/main.js"></script></body>');
  writeFileSync(join(root, "main.js"), `
import { server } from "cache-fixture-dependency";
document.body.dataset.server = server;
`);
  const start = async (name: string) => {
    const server = await createServer({
      root, configFile: false, logLevel: "error", plugins: [devServerCache()],
      optimizeDeps: {
        include: ["cache-fixture-dependency"], noDiscovery: true,
        rolldownOptions: { transform: { define: { __SERVER_NAME__: JSON.stringify(name) } } },
      },
      server: { host: "127.0.0.1", port: 0, strictPort: true },
    });
    servers.push(server);
    await server.listen();
    const address = server.httpServer!.address() as AddressInfo;
    return { server, url: `http://127.0.0.1:${address.port}/` };
  };
  const load = async (url: string, name: string) => {
    // A fresh context must fetch the optimized module again; HTTP's immutable
    // cache would otherwise conceal another server replacing its bytes.
    const context = await browser.newContext();
    contexts.push(context);
    const page = await context.newPage();
    await page.goto(url);
    await expect(page.locator("body")).toHaveAttribute("data-server", name);
  };
  try {
    const first = await start("first");
    // Prime the app's import URLs without caching the optimized dependency's
    // HTTP response. Another server can then replace its on-disk graph.
    expect((await fetch(new URL("main.js", first.url))).status).toBe(200);
    const second = await start("second");
    await load(second.url, "second");
    await load(first.url, "first");
    expect(first.server.config.cacheDir).not.toBe(second.server.config.cacheDir);
    await second.server.close();
    expect(existsSync(second.server.config.cacheDir)).toBe(false);
    await load(first.url, "first");
    await first.server.close();
    expect(existsSync(first.server.config.cacheDir)).toBe(false);
  } finally {
    await Promise.allSettled(contexts.map(context => context.close()));
    await Promise.allSettled(servers.map(server => server.close()));
    rmSync(root, { recursive: true, force: true });
  }
});
