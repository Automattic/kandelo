import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { join, resolve } from "node:path";
import { build } from "esbuild";
import { expect, test } from "../playwright-test";
import { compileSdkFixture } from "../../../host/test/support/compile-sdk-fixture";
import { resolveBinary } from "../../../host/src/binary-resolver";

const repository = resolve(import.meta.dirname, "../../..");
let ordinary: ReturnType<typeof compileSdkFixture> | undefined;
let server: Server | undefined;
let url: string;
let inputs: Record<string, string>;
const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

test.beforeAll(async () => {
  test.setTimeout(180_000);
  ordinary = compileSdkFixture(new URL("../../../host/test/fixtures/grouped-sdk-mapping.c", import.meta.url), [], { forkInstrument: true });
  const groupedPath = `${ordinary.programPath}.grouped.wasm`;
  execFileSync(join(repository, "sdk/bin/wasm32posix-shared-memory"), [ordinary.programPath, "-o", groupedPath],
    { cwd: repository, stdio: "pipe" });
  const routes = new Map<string, Uint8Array>([
    ["/kernel.wasm", readFileSync(resolveBinary("kernel.wasm"))],
    ["/ordinary.wasm", readFileSync(ordinary.programPath)],
    ["/grouped.wasm", readFileSync(groupedPath)],
  ]);
  inputs = Object.fromEntries([...routes].map(([path, bytes]) => [path, hash(bytes)]));
  for (const [route, source] of [
    ["/kernel.mjs", "host/test/fixtures/grouped-sdk-execution-browser.ts"],
    ["/process.mjs", "host/src/worker-entry-browser.ts"],
  ]) {
    const bundle = await build({ entryPoints: [join(repository, source)], bundle: true, write: false,
      format: "esm", platform: "browser", target: "es2022", metafile: true });
    routes.set(route, bundle.outputFiles[0].contents);
    inputs[route] = hash(bundle.outputFiles[0].contents);
    for (const path of Object.keys(bundle.metafile!.inputs)) inputs[path] = hash(readFileSync(path));
  }
  server = createServer((request, response) => {
    response.setHeader("Cross-Origin-Opener-Policy", "same-origin");
    response.setHeader("Cross-Origin-Embedder-Policy", "require-corp");
    const path = request.url ?? "/";
    if (path === "/") {
      response.setHeader("Content-Type", "text/html");
      response.end("<!doctype html><title>SDK grouped Worker execution</title>");
    } else if (routes.has(path)) {
      response.setHeader("Content-Type", path.endsWith(".wasm") ? "application/wasm" : "text/javascript");
      response.end(routes.get(path));
    } else { response.statusCode = 404; response.end(); }
  });
  await new Promise<void>(done => server!.listen(0, "127.0.0.1", done));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("missing fixture server address");
  url = `http://127.0.0.1:${address.port}/`;
});

test.afterAll(async () => {
  if (server) await new Promise<void>(done => { server!.close(() => done()); server!.closeAllConnections(); });
  ordinary?.cleanup();
});

for (const grouped of [false, true]) {
  test(`normal SDK libc mapping and I/O: ${grouped ? "grouped" : "ordinary"}`, async ({ page, browser }, info) => {
    test.setTimeout(90_000);
    await page.goto(url);
    const result = await page.evaluate(grouped => new Promise<Record<string, unknown>>((resolve, reject) => {
      const worker = new Worker("/kernel.mjs", { type: "module" });
      const deadline = setTimeout(() => { worker.terminate(); reject(new Error("kernel Worker deadline")); }, 75_000);
      worker.onmessage = event => { clearTimeout(deadline); worker.terminate(); resolve(event.data); };
      worker.onerror = event => { clearTimeout(deadline); worker.terminate(); reject(new Error(event.message)); };
      worker.postMessage({ grouped });
    }), grouped);
    writeFileSync(info.outputPath("result.json"), JSON.stringify({ engine: info.project.name,
      version: browser.version(), inputs, result }, null, 2) + "\n");
    expect(result.failure, JSON.stringify(result)).toBeUndefined();
    expect(result.diagnostics).toEqual([]);
    expect(result.stderr).toBe("");
    expect(result.kernelExit).toBe(0);
    expect(result.processExit).toBe(0);
    expect(result.processReady).toBe(true);
    expect(result.quiescent).toBe(true);
    expect(result.stdout).toContain("heap-ok\n");
    expect(result.stdout).toContain("protection-io-ok\n");
    expect(result.stdout).toContain("moving-remap-ok\n");
    expect(result.stdout).toMatch(/grouped-sdk-mapping PASS checks=\d+\n$/);
    expect(String(result.stdout).includes("ordinary-protection-partial")).toBe(!grouped);
  });
}
