import { readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { expect } from "@playwright/test";
import { opfsTest as test } from "./support/opfs-page";
import {
  createRustSdkUpgradeImage,
  resolveRustSdkUpgradeArtifacts,
} from "../../../host/test/fixtures/rust-sdk-upgrade-image";

const paths = resolveRustSdkUpgradeArtifacts();
const available = paths.every((path) => path !== null);
if (!available && process.env.KANDELO_REQUIRE_RUST_SDK_UPGRADE === "1") {
  throw new Error(
    "SDK upgrade acceptance requires explicit old/new SDKs, kernel and normal unzip package",
  );
}

test("real SDK replacement invalidates Cargo caches and remains fresh across OPFS reopen", async ({
  page,
  baseURL,
}) => {
  test.skip(!available, "historical Rust SDK is an explicit acceptance input");
  test.setTimeout(2_400_000);
  page.on("console", (message) =>
    console.info(`[SDK upgrade ${message.type()}]`, message.text()),
  );
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const [kernel, next, old, unzip] = paths.map((path) => readFileSync(path!));
  const { image, assets, identity, driverSize } =
    await createRustSdkUpgradeImage(old!, next!, unzip!);
  const payloads = new Map<string, Uint8Array>([
    ["/kernel.wasm", kernel!],
    ["/image.vfs", image],
    ...assets.map(
      (asset) =>
        [new URL(asset.url).pathname, asset.bytes] as [string, Uint8Array],
    ),
  ]);
  const server = createServer((request, response) => {
    response.setHeader("Access-Control-Allow-Origin", "*");
    response.setHeader("Access-Control-Allow-Headers", "Range");
    response.setHeader("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS");
    response.setHeader("Cross-Origin-Resource-Policy", "cross-origin");
    if (request.method === "OPTIONS") {
      response.writeHead(204);
      response.end();
      return;
    }
    const bytes = payloads.get(
      new URL(request.url ?? "/", "http://127.0.0.1").pathname,
    );
    if (!bytes) {
      response.writeHead(404);
      response.end();
      return;
    }
    response.writeHead(200, {
      "Content-Type": "application/octet-stream",
      "Content-Length": bytes.byteLength,
    });
    response.end(request.method === "HEAD" ? undefined : bytes);
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  try {
    const address = server.address();
    if (!address || typeof address === "string")
      throw new Error("SDK upgrade asset server has no TCP address");
    const origin = `http://127.0.0.1:${address.port}`;
    const lazyUrlMap = Object.fromEntries(
      assets.map((asset) => [asset.url, origin + new URL(asset.url).pathname]),
    );
    const moduleUrl = (path: string) =>
      new URL(`/@fs/${fileURLToPath(new URL(path, import.meta.url))}`, baseURL)
        .href;
    await page.goto(new URL("/trap-signal-test.html", baseURL).href);
    const results = await page.evaluate(
      async (options) => {
        const [{ BrowserKernel }, { checkRustSdkUpgrade }] = await Promise.all([
          import(options.kernelModule),
          import(options.fixtureModule),
        ]);
        const createHost = () =>
          new BrowserKernel({ kernelOwnedFs: true, maxWorkers: 8 });
        console.info("[SDK upgrade storage before]", JSON.stringify(await navigator.storage.estimate()));
        let host = createHost();
        const name = `rust-sdk-upgrade-${crypto.randomUUID()}`;
        const boot = {
          kernelWasm: await (
            await fetch(options.origin + "/kernel.wasm")
          ).arrayBuffer(),
          vfsImage: new Uint8Array(
            await (await fetch(options.origin + "/image.vfs")).arrayBuffer(),
          ),
          lazyUrlMap: options.lazyUrlMap,
          experimentalResizablePersistenceName: name,
          persistentComputerName: name,
        };
        try {
          await host.initFromImage(boot);
          return await checkRustSdkUpgrade(
            () => host,
            async () => {
              await host.destroy();
              host = createHost();
              await host.initFromImage({
                ...boot,
                requireExistingRootfsPersistence: true,
              });
            },
            options.driverSize,
            options.identity,
          );
        } finally {
          console.info("[SDK upgrade storage after]", JSON.stringify(await navigator.storage.estimate()));
          await host.destroy();
        }
      },
      {
        origin,
        lazyUrlMap,
        driverSize,
        identity,
        kernelModule: moduleUrl("../../../host/src/browser-kernel-host.ts"),
        fixtureModule: moduleUrl(
          "../../../host/test/fixtures/rust-sdk-upgrade-checks.ts",
        ),
      },
    );
    const evidence = test.info().outputPath("sdk-upgrade-results.json");
    writeFileSync(evidence, JSON.stringify(results, null, 2) + "\n");
    await test
      .info()
      .attach("sdk-upgrade-results", {
        path: evidence,
        contentType: "application/json",
      });
    expect(results.map((result: { phase: string }) => result.phase)).toContain(
      "reopened-fresh",
    );
    expect(errors).toEqual([]);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
      server.closeAllConnections();
    });
  }
});
