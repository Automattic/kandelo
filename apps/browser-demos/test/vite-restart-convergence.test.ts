/**
 * The development server keeps its guest preview origin (the listener on the
 * app's port + 1, vite/preview-origin.ts) across its own restarts, and comes
 * back to the configuration on disk when a change lands while a restart is
 * still loading the previous one (vite/restart-convergence.ts).
 *
 * Each test runs a real Vite dev server in this process with a config file in
 * a temporary directory. The config waits before it returns, which holds a
 * restart's loading window open the way the app's real (much larger) config
 * does, so a second change can arrive inside it deterministically.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer, type ViteDevServer } from "vite";
import { findSignallingPhp } from "../vite/dev-signalling";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "../../..");
const PREVIEW_ORIGIN_MODULE = path.resolve(HERE, "../vite/preview-origin.ts");
const CONVERGENCE_MODULE = path.resolve(HERE, "../vite/restart-convergence.ts");
const SIGNALLING_MODULE = path.resolve(HERE, "../vite/dev-signalling.ts");

let previousPreviewOrigin: string | undefined;
let previousPreviewHost: string | undefined;
const roots: string[] = [];

before(() => {
  // The port + 1 listener is what is under test; a configured or disabled
  // preview origin from the caller's environment would replace it.
  previousPreviewOrigin = process.env.KANDELO_PREVIEW_ORIGIN;
  previousPreviewHost = process.env.KANDELO_PREVIEW_HOST;
  delete process.env.KANDELO_PREVIEW_ORIGIN;
  delete process.env.KANDELO_PREVIEW_HOST;
});

after(() => {
  if (previousPreviewOrigin === undefined) delete process.env.KANDELO_PREVIEW_ORIGIN;
  else process.env.KANDELO_PREVIEW_ORIGIN = previousPreviewOrigin;
  if (previousPreviewHost === undefined) delete process.env.KANDELO_PREVIEW_HOST;
  else process.env.KANDELO_PREVIEW_HOST = previousPreviewHost;
  for (const root of roots) fs.rmSync(root, { recursive: true, force: true });
});

function listenable(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once("error", () => resolve(false));
    server.listen(port, "127.0.0.1", () => server.close(() => resolve(true)));
  });
}

/** An app port whose port + 1 is free too. */
async function freePortPair(): Promise<number> {
  for (let attempt = 0; attempt < 50; attempt++) {
    const port = await new Promise<number>((resolve, reject) => {
      const server = net.createServer();
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        const { port } = server.address() as net.AddressInfo;
        server.close(() => resolve(port));
      });
    });
    if (port < 65535 && await listenable(port + 1)) return port;
  }
  throw new Error("no free port pair");
}

/** Status of GET <scope><file> on the preview origin, or null if refused. */
function previewStatus(port: number, file = "preview-service-worker.js"): Promise<number | null> {
  return new Promise((resolve) => {
    const request = http.get(
      { host: "127.0.0.1", port, path: `/${file}`, agent: false },
      (response) => {
        response.resume();
        resolve(response.statusCode ?? null);
      },
    );
    request.once("error", () => resolve(null));
  });
}

async function waitFor(check: () => Promise<boolean>, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return true;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return check();
}

function configSource(options: { port: number; root: string; plugins: boolean; marker: string }): string {
  const imports = options.plugins
    ? `import { previewOriginPlugin } from ${JSON.stringify(PREVIEW_ORIGIN_MODULE)};\n` +
      `import { restartConvergencePlugin } from ${JSON.stringify(CONVERGENCE_MODULE)};\n` +
      `import { findSignallingPhp } from ${JSON.stringify(SIGNALLING_MODULE)};\n`
    : "";
  const plugins = options.plugins
    ? `[restartConvergencePlugin(), previewOriginPlugin({ findPhp: () => findSignallingPhp(${JSON.stringify(REPO_ROOT)}) })]`
    : "[]";
  return `${imports}
await new Promise((resolve) => setTimeout(resolve, 800));
export default {
  cacheDir: ${JSON.stringify(path.join(options.root, ".vite"))},
  define: { __KANDELO_TEST_CONFIG__: ${JSON.stringify(JSON.stringify(options.marker))} },
  logLevel: "silent",
  plugins: ${plugins},
  optimizeDeps: { noDiscovery: true, include: [] },
  server: {
    host: "127.0.0.1",
    port: ${options.port},
    strictPort: true,
    // Only the test's own change events restart the server, so their timing
    // is the test's, not the file watcher's.
    watch: { ignored: ["**/vite.config.mts"] },
  },
};
`;
}

async function startServer(plugins: boolean): Promise<{
  configFile: string;
  port: number;
  root: string;
  server: ViteDevServer;
}> {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "kandelo-vite-restart-")));
  roots.push(root);
  fs.writeFileSync(path.join(root, "index.html"), "<!doctype html><title>t</title>\n");
  const port = await freePortPair();
  const configFile = path.join(root, "vite.config.mts");
  fs.writeFileSync(configFile, configSource({ port, root, plugins, marker: "initial" }));
  const server = await createServer({ configFile, root });
  await server.listen();
  return { configFile, port, root, server };
}

test("server.restart() keeps the preview origin and close() releases it", async () => {
  const { port, server } = await startServer(true);
  try {
    assert.ok(await waitFor(async () => await previewStatus(port + 1) === 200, 10_000));
    await server.restart();
    assert.ok(
      await waitFor(async () => await previewStatus(port + 1) === 200, 10_000),
      "the preview origin answers after a restart",
    );
    await server.restart();
    assert.ok(
      await waitFor(async () => await previewStatus(port + 1) === 200, 10_000),
      "the preview origin answers after a second restart",
    );
  } finally {
    await server.close();
  }
  assert.ok(
    await waitFor(async () => await previewStatus(port + 1) === null, 5_000),
    "closing the dev server closes its preview origin",
  );
  assert.ok(await listenable(port + 1), "the preview port is free again");
});

test("a config change that lands during a restart is not lost", async () => {
  const { configFile, port, root, server } = await startServer(true);
  try {
    assert.ok(await waitFor(async () => await previewStatus(port + 1) === 200, 10_000));
    // A rebase: first an intermediate checkout whose config predates both
    // plugins, then, while that restart is still loading it, the final
    // checkout, which has them again.
    fs.writeFileSync(configFile, configSource({ port, root, plugins: false, marker: "intermediate" }));
    server.watcher.emit("change", configFile);
    await new Promise((resolve) => setTimeout(resolve, 300));
    fs.writeFileSync(configFile, configSource({ port, root, plugins: true, marker: "final" }));
    server.watcher.emit("change", configFile);
    // The marker names the config the server is running; until a restart
    // completes it is still the initial one, whose preview origin answers.
    const running = () => server.config.define?.__KANDELO_TEST_CONFIG__;
    assert.ok(
      await waitFor(async () => running() === '"final"', 15_000),
      `the server runs the config on disk (running ${String(running())})`,
    );
    assert.ok(
      await waitFor(async () => await previewStatus(port + 1) === 200, 10_000),
      "the final config's preview origin answers",
    );
  } finally {
    await server.close();
  }
});

test("restarts hand the PHP preview origin's port from one php -S to the next", async (t) => {
  try {
    await findSignallingPhp(REPO_ROOT);
  } catch (error) {
    t.skip(`no PHP for the php preview bundle: ${String(error)}`);
    return;
  }
  process.env.KANDELO_PREVIEW_HOST = "php";
  try {
    const { port, server } = await startServer(true);
    const answers = () => previewStatus(port + 1, "preview-service-worker.php");
    try {
      assert.ok(await waitFor(async () => await answers() === 200, 15_000));
      for (let restart = 1; restart <= 3; restart++) {
        await server.restart();
        assert.ok(
          await waitFor(async () => await answers() === 200, 15_000),
          `the PHP preview origin answers after restart ${restart}`,
        );
      }
    } finally {
      await server.close();
    }
    assert.ok(
      await waitFor(async () => await answers() === null, 10_000),
      "closing the dev server stops its php -S",
    );
  } finally {
    delete process.env.KANDELO_PREVIEW_HOST;
  }
});
