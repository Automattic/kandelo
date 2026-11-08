import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { expect } from "@playwright/test";
import { opfsTest as test } from "./support/opfs-page";
import { createRustCargoImage, resolveRustCargoArtifacts } from "../../../host/test/fixtures/rust-cargo";
import { rustCompilerEnv } from "../../../host/test/fixtures/rust-compiler";
import { rustDevtoolFiles } from "../../../host/test/fixtures/rust-devtools";

const paths = resolveRustCargoArtifacts();
const available = paths.every(path => path !== null);
if (!available && process.env.KANDELO_REQUIRE_GUEST_CARGO === "1") {
  throw new Error("Build kernel and kandelo-rust-sdk before Rust developer-tool acceptance");
}

test("guest Rust tools format, lint, document and run a doctest on an OPFS disk", async ({ page, baseURL }) => {
  test.skip(!available, "the standalone Rust SDK bundle is optional");
  test.setTimeout(1_800_000);
  page.on("console", message => console.info(`[Rust tools ${message.type()}]`, message.text()));
  page.on("pageerror", error => console.error("[Rust tools pageerror]", error.message));
  const [kernel, bundle] = paths.map(path => readFileSync(path!));
  const { image, assets } = await createRustCargoImage(bundle!, rustDevtoolFiles);
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
    if (!address || typeof address === "string") throw new Error("developer-tool asset server has no TCP address");
    const origin = `http://127.0.0.1:${address.port}`;
    const lazyUrlMap = Object.fromEntries(assets.map(asset => [asset.url, origin + new URL(asset.url).pathname]));
    await page.goto(new URL("/trap-signal-test.html", baseURL).href);
    const moduleUrl = (path: string) => new URL(`/@fs/${fileURLToPath(new URL(path, import.meta.url))}`, baseURL).href;
    const result = await page.evaluate(async options => {
      const [{ BrowserKernel }, { exerciseRustDevtools }] = await Promise.all([
        import(options.kernelModule), import(options.fixtureModule),
      ]);
      const host = new BrowserKernel({ kernelOwnedFs: true, maxWorkers: 8 });
      const name = `rust-devtools-${crypto.randomUUID()}`;
      try {
        await host.initFromImage({
          kernelWasm: await (await fetch(options.origin + "/kernel.wasm")).arrayBuffer(),
          vfsImage: new Uint8Array(await (await fetch(options.origin + "/image.vfs")).arrayBuffer()),
          lazyUrlMap: options.lazyUrlMap,
          experimentalResizablePersistenceName: name, persistentComputerName: name,
        });
        return await exerciseRustDevtools(host, options.env);
      } finally { await host.destroy(); }
    }, {
      origin, lazyUrlMap, env: rustCompilerEnv,
      kernelModule: moduleUrl("../../../host/src/browser-kernel-host.ts"),
      fixtureModule: moduleUrl("../../../host/test/fixtures/rust-devtools.ts"),
    });
    expect(result.results["doctests"].stdout).toContain("1 passed; 0 failed");
    expect(result.docsHtml).toContain("Adds two numbers");
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close(error => error ? reject(error) : resolve());
      server.closeAllConnections();
    });
  }
});
