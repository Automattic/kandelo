import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, test, type Page } from "@playwright/test";
import { zipSync } from "fflate";
import { resolveBinary } from "../../../host/src/binary-resolver";
import { KandeloImageFs } from "../../../images/vfs/lib/kandelo-image-fs";
import { parseZipCentralDirectory } from "../../../host/src/vfs/zip";

test.use({ serviceWorkers: "block" });
const digest = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

async function readNativeImage(page: Page, baseURL: string, image: Uint8Array, path: string, executable?: string) {
  const kernelUrl = new URL("/__native_lazy_kernel.wasm", baseURL).href;
  const imageUrl = new URL("/__native_lazy_image.vfs", baseURL).href;
  await page.route(kernelUrl, route => route.fulfill({ body: readFileSync(resolveBinary("kernel.wasm")) }));
  await page.route(imageUrl, route => route.fulfill({ body: Buffer.from(image) }));
  await page.goto(new URL("/pages/test-runner/?minimal=1", baseURL).href);
  await page.waitForFunction(() => (window as any).__testRunnerReady === true);
  const modulePath = fileURLToPath(new URL("../../../host/src/browser-kernel-host.ts", import.meta.url));
  return page.evaluate(async ({ moduleUrl, kernelUrl, imageUrl, path, executable }) => {
    const { BrowserKernel } = await import(moduleUrl);
    let stdout = "";
    let stderr = "";
    const kernel = new BrowserKernel({ kernelOwnedFs: true,
      onStdout: (bytes: Uint8Array) => { stdout += new TextDecoder().decode(bytes); },
      onStderr: (bytes: Uint8Array) => { stderr += new TextDecoder().decode(bytes); },
    });
    try {
      await kernel.initFromImage({
        kernelWasm: await (await fetch(kernelUrl)).arrayBuffer(),
        vfsImage: new Uint8Array(await (await fetch(imageUrl)).arrayBuffer()),
      });
      const before = await kernel.statVfsPath(path);
      const reads: Array<{ text?: string; error?: string }> = [];
      for (let read = 0; read < 2; read++) {
        try { reads.push({ text: new TextDecoder().decode(await kernel.readFileFromVfs(path)) }); }
        catch (error) { reads.push({ error: String(error) }); }
      }
      let exitCode: number | undefined;
      if (executable) {
        const { exit } = await kernel.spawnFromVfs(executable, [executable],
          { env: ["INITIAL=parent", "REMOVE=before-fork"] });
        exitCode = await exit;
      }
      return { before, after: await kernel.statVfsPath(path), reads, stdout, stderr, exitCode };
    } finally { await kernel.destroy(); }
  }, { moduleUrl: new URL(`/@fs/${modulePath}`, baseURL).href, kernelUrl, imageUrl, path, executable });
}

test("native lazy ZIP retries HTTP 502 and caches verified bytes on each browser engine", async ({ page, baseURL }) => {
  test.setTimeout(120_000);
  const url = new URL("/__native_lazy_data.zip", baseURL).href;
  const archive = zipSync({ "etc/data": new TextEncoder().encode("native archive bytes") });
  const fs = KandeloImageFs.create();
  fs.registerLazyArchive({ url, entries: parseZipCentralDirectory(archive), mountPrefix: "/",
    integrity: { sha256: digest(archive), bytes: archive.byteLength } });
  let fetches = 0;
  await page.route(url, route => {
    fetches++;
    return route.fulfill(fetches === 1
      ? { status: 502, body: "temporarily unavailable", headers: { "retry-after": "0" } }
      : { body: Buffer.from(archive) });
  });
  const result = await readNativeImage(page, baseURL!, await fs.saveImage(), "/etc/data");
  expect(result.reads).toEqual([{ text: "native archive bytes" }, { text: "native archive bytes" }]);
  expect(fetches).toBe(2);
  expect(result.before).toEqual(result.after);
});

test("native lazy file rejects an oversized response without retrying or changing file metadata", async ({ page, baseURL }) => {
  test.setTimeout(120_000);
  const url = new URL("/__native_lazy_oversized.bin", baseURL).href;
  const bytes = new Uint8Array([1, 2, 3]);
  const fs = KandeloImageFs.create();
  fs.registerLazyFile("/data", url, bytes.length, 0o644, digest(bytes));
  let fetches = 0;
  await page.route(url, route => { fetches++; return route.fulfill({ body: Buffer.from([1, 2, 3, 4]) }); });
  const result = await readNativeImage(page, baseURL!, await fs.saveImage(), "/data");
  expect(result.reads.every(read => read.error !== undefined)).toBe(true);
  expect(fetches).toBe(1);
  expect(result.before).toEqual(result.after);
  expect(result.after?.size).toBe(3);
});

test("native lazy archive launches a guest that forks and re-execs with real environment state", async ({ page, baseURL }) => {
  test.setTimeout(180_000);
  const executable = "/bin/environment-lifecycle";
  const url = new URL("/__native_lazy_program.zip", baseURL).href;
  const program = readFileSync(fileURLToPath(new URL("../../../examples/environment_lifecycle_test.wasm", import.meta.url)));
  const archive = zipSync({
    "bin/": [new Uint8Array(), { os: 3, attrs: (0o040755 << 16) >>> 0 }],
    "bin/environment-lifecycle": [program, { os: 3, attrs: (0o100755 << 16) >>> 0 }],
    "etc/data": new TextEncoder().encode("guest archive bytes"),
  });
  const fs = KandeloImageFs.create();
  fs.registerLazyArchive({ url, entries: parseZipCentralDirectory(archive), mountPrefix: "/",
    integrity: { sha256: digest(archive), bytes: archive.byteLength } });
  let fetches = 0;
  await page.route(url, route => { fetches++; return route.fulfill({ body: Buffer.from(archive) }); });
  const result = await readNativeImage(page, baseURL!, await fs.saveImage(), "/etc/data", executable);
  expect(result.exitCode, result.stderr).toBe(0);
  expect(result.stdout).toContain("EXEC_ENV_PASS");
  expect(result.stdout).toContain("EMPTY_ENV_PASS");
  expect(result.stderr).toBe("");
  expect(fetches).toBe(1);
});
