import { readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { expect } from "@playwright/test";
import { opfsTest as test } from "./support/opfs-page";
import { createDirectoryMutationFixture, directoryMutationKernel } from "../../../host/test/fixtures/directory-mutation-build";

test("directory mutation preserves readdir and seekdir cookies on OPFS rootfs and tmpfs", async ({ page, baseURL }) => {
  test.skip(!directoryMutationKernel, "requires the current kernel and SDK");
  test.setTimeout(600_000);
  const fixture = await createDirectoryMutationFixture();
  const payloads = new Map<string, Uint8Array>([["/image.vfs", fixture.image], ["/kernel.wasm", readFileSync(directoryMutationKernel!)]]);
  const server = createServer((request, response) => {
    response.setHeader("Access-Control-Allow-Origin", "*");
    response.setHeader("Cross-Origin-Resource-Policy", "cross-origin");
    const bytes = payloads.get(request.url ?? "");
    if (!bytes) { response.writeHead(404); response.end(); return; }
    response.writeHead(200, { "Content-Type": "application/octet-stream", "Content-Length": bytes.byteLength });
    response.end(bytes);
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => { server.off("error", reject); resolve(); });
  });
  try {
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("directory fixture server lacks a TCP address");
    const origin = `http://127.0.0.1:${address.port}`;
    const moduleUrl = (path: string) => new URL(`/@fs/${fileURLToPath(new URL(path, import.meta.url))}`, baseURL).href;
    const errors: string[] = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.goto(new URL("/trap-signal-test.html", baseURL).href);
    const result = await page.evaluate(async options => {
      const [{ BrowserKernel }, { readRustCompilerJob }] = await Promise.all([
        import(options.kernelModule), import(options.jobModule),
      ]);
      const host = new BrowserKernel({ kernelOwnedFs: true });
      const name = `directory-mutation-${crypto.randomUUID()}`;
      try {
        await host.initFromImage({
          kernelWasm: await (await fetch(options.origin + "/kernel.wasm")).arrayBuffer(),
          vfsImage: new Uint8Array(await (await fetch(options.origin + "/image.vfs")).arrayBuffer()),
          experimentalResizablePersistenceName: name, persistentComputerName: name,
        });
        const command = await host.spawnFromVfs("/usr/bin/directory-mutation", ["directory-mutation"], {
          uid: 1000, gid: 1000, ownedJob: { id: "directory-mutation", timeoutMs: 300_000 },
        });
        void command.exit.catch(() => {});
        return await readRustCompilerJob(host, "directory-mutation", 330_000);
      } finally { await host.destroy(); }
    }, { origin, kernelModule: moduleUrl("../../../host/src/browser-kernel-host.ts"),
      jobModule: moduleUrl("../../../host/test/fixtures/rust-guest-job.ts") });
    const evidence = test.info().outputPath("directory-mutation.json");
    writeFileSync(evidence, JSON.stringify(result, null, 2) + "\n");
    await test.info().attach("directory-mutation", { path: evidence, contentType: "application/json" });
    expect(result.exitCode, JSON.stringify(result)).toBe(0);
    expect(result.stdout).toContain("directory-cookies: rootfs=256 tmpfs=256 seekdir=ok");
    expect(result.stderr).toBe("");
    expect(errors).toEqual([]);
  } finally {
    await new Promise<void>((resolve, reject) => { server.close(error => error ? reject(error) : resolve()); server.closeAllConnections(); });
    fixture.cleanup();
  }
});
