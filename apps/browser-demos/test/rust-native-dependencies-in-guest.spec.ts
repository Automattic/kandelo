import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { expect } from "@playwright/test";
import { opfsTest as test } from "./support/opfs-page";
import { createRustCargoImage, resolveRustCargoArtifacts } from "../../../host/test/fixtures/rust-cargo";
import { rustCompilerEnv } from "../../../host/test/fixtures/rust-compiler";
import { rustNativeDependencyFiles } from "../../../host/test/fixtures/rust-native-dependency-source";

const paths = resolveRustCargoArtifacts();
const fixturePath = process.env.KANDELO_GUEST_RUST_NATIVE_FIXTURES;
const available = paths.every(path => path !== null) && fixturePath !== undefined;
if (!available && process.env.KANDELO_REQUIRE_GUEST_CARGO === "1") {
  throw new Error("Build kernel, kandelo-rust-sdk and rust-native-fixtures; set KANDELO_GUEST_RUST_NATIVE_FIXTURES to its ZIP");
}

test("guest Rust reports native dependency execution and compiler limits", async ({ page, baseURL, browserName }) => {
  test.skip(!available, "the standalone Rust SDK and native source fixture are optional");
  test.setTimeout(1_800_000);
  page.on("console", message => console.info(`[Rust native dependency ${message.type()}]`, message.text()));
  page.on("pageerror", error => console.error("[Rust native dependency pageerror]", error.message));
  const expectCompilerStackLimit = browserName === "webkit";
  const stackDiagnostic = expectCompilerStackLimit ? page.waitForEvent("console", {
    predicate: message => message.type() === "error" &&
      /Thread worker failed: Maximum call stack size exceeded\./.test(message.text()),
    timeout: 600_000,
  }) : null;
  // Retain the original assertion failure if evaluation fails first.
  void stackDiagnostic?.catch(() => {});
  const [kernel, bundle] = paths.map(path => readFileSync(path!));
  const { image, assets } = await createRustCargoImage(bundle!, rustNativeDependencyFiles(readFileSync(fixturePath!)));
  const payloads = new Map<string, Uint8Array>([
    ["/kernel.wasm", kernel!], ["/image.vfs", image],
    ...assets.map(asset => [new URL(asset.url).pathname, asset.bytes] as [string, Uint8Array]),
  ]);
  // Toolchain bytes travel over HTTP, never through browser-control messages.
  const server = createServer((request, response) => {
    response.setHeader("Access-Control-Allow-Origin", "*");
    response.setHeader("Access-Control-Allow-Headers", "Range");
    response.setHeader("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS");
    response.setHeader("Cross-Origin-Resource-Policy", "cross-origin");
    if (request.method === "OPTIONS") { response.writeHead(204); response.end(); return; }
    const bytes = payloads.get(new URL(request.url ?? "/", "http://127.0.0.1").pathname);
    if (!bytes) { response.writeHead(404); response.end(); return; }
    response.writeHead(200, { "Content-Type": "application/octet-stream", "Content-Length": bytes.byteLength });
    response.end(request.method === "HEAD" ? undefined : bytes);
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => { server.off("error", reject); resolve(); });
  });
  try {
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("compatibility asset server has no TCP address");
    const origin = `http://127.0.0.1:${address.port}`;
    const lazyUrlMap = Object.fromEntries(assets.map(asset => [asset.url, origin + new URL(asset.url).pathname]));
    await page.goto(new URL("/trap-signal-test.html", baseURL).href);
    const moduleUrl = (path: string) => new URL(`/@fs/${fileURLToPath(new URL(path, import.meta.url))}`, baseURL).href;
    const result = await page.evaluate(async options => {
      const [{ BrowserKernel }, { exerciseRustNativeDependencies }] = await Promise.all([
        import(options.kernelModule), import(options.fixtureModule),
      ]);
      const host = new BrowserKernel({ kernelOwnedFs: true, maxWorkers: 8 });
      const name = `rust-native-dependencies-${crypto.randomUUID()}`;
      try {
        await host.initFromImage({
          kernelWasm: await (await fetch(options.origin + "/kernel.wasm")).arrayBuffer(),
          vfsImage: new Uint8Array(await (await fetch(options.origin + "/image.vfs")).arrayBuffer()),
          lazyUrlMap: options.lazyUrlMap,
          experimentalResizablePersistenceName: name, persistentComputerName: name,
        });
        return await exerciseRustNativeDependencies(host, options.env, options.expectCompilerStackLimit);
      } finally { await host.destroy(); }
    }, {
      origin, lazyUrlMap, env: rustCompilerEnv, expectCompilerStackLimit,
      kernelModule: moduleUrl("../../../host/src/browser-kernel-host.ts"),
      fixtureModule: moduleUrl("../../../host/test/fixtures/rust-native-dependencies.ts"),
    });
    await test.info().attach("native-dependency-results", {
      body: JSON.stringify(result, null, 2), contentType: "application/json",
    });
    if (expectCompilerStackLimit) {
      expect(result.configured).toBeNull();
      await stackDiagnostic;
      test.info().annotations.push({ type: "platform-limit",
        description: "WebKit rustc exhausts its call stack compiling cc; native dependency execution is unsupported for this case" });
    } else {
      expect(result.configured?.stdout).toBe("cc-rs native execution=42/7\n");
    }
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close(error => error ? reject(error) : resolve());
      server.closeAllConnections();
    });
  }
});
