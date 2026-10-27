/** Actual guest DRM buffers, observed through both browser CPU presenters. */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";
import { compileSdkFixture } from "../../../host/test/support/compile-sdk-fixture";
import { resolveBinary } from "../../../host/src/binary-resolver";
import { KandeloImageFs } from "../../../images/vfs/lib/kandelo-image-fs";
import { installBrowserMemoryBoundaryProbe, memoryBoundaryFailures } from "./support/browser-memory-boundary";

test.use({ serviceWorkers: "block", viewport: { width: 800, height: 600 } });
let fixture: ReturnType<typeof compileSdkFixture>;
const evidenceRoot = fileURLToPath(new URL("../../../.context/graphics-abi56-format-evidence/", import.meta.url));
const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
test.beforeAll(() => {
  fixture = compileSdkFixture(new URL("../../../host/test/fixtures/dri-scanout-formats.c", import.meta.url), [
    `-I${fileURLToPath(new URL("../../../sysroot/include/drm", import.meta.url))}`, "-ldrm",
  ]);
  mkdirSync(evidenceRoot, { recursive: true });
  writeFileSync(join(evidenceRoot, `scanout-probe-${test.info().project.name}.wasm`), readFileSync(fixture.programPath));
});
test.afterAll(() => fixture?.cleanup());

for (const mode of ["2d", "webgl2-scanout"] as const) {
  for (const [name, format] of [
    ["XRGB8888", 0x34325258], ["ARGB8888", 0x34325241], ["RGB565", 0x36314752],
    ["ABGR8888", 0x34324241], ["XBGR8888", 0x34324258],
  ] as const) {
    test(`${mode} displays ${name} colors and row pitch`, async ({ page, baseURL, browser }) => {
      const image = KandeloImageFs.create();
      image.mkdir("/bin", 0o755);
      image.writeFile("/bin/probe", readFileSync(fixture.programPath), 0o755);
      const bytes = await image.saveImage();
      await page.route("**/__scanout_kernel", route => route.fulfill({ body: readFileSync(resolveBinary("kernel.wasm")) }));
      await page.route("**/__scanout_image", route => route.fulfill({ body: Buffer.from(bytes) }));
      const errors: string[] = [];
      page.on("pageerror", error => errors.push(error.message));
      await installBrowserMemoryBoundaryProbe(page);
      await page.goto(new URL("/trap-signal-test.html", baseURL).href);
      const modulePath = fileURLToPath(new URL("../../../host/src/browser-kernel-host.ts", import.meta.url));
      try {
        await page.evaluate(async ({ moduleUrl, mode, format }) => {
          const { BrowserKernel } = await import(/* @vite-ignore */ moduleUrl);
          const state = { stdout: "", stderr: "", diagnostics: [] as unknown[] };
          const kernel = new BrowserKernel({
            kernelOwnedFs: true,
            onStdout: (data: Uint8Array) => { state.stdout += new TextDecoder().decode(data); },
            onStderr: (data: Uint8Array) => { state.stderr += new TextDecoder().decode(data); },
            onHostDiagnostic: (value: unknown) => state.diagnostics.push(value),
          });
          (globalThis as any).__scanout = { kernel, state };
          await kernel.initFromImage({
            kernelWasm: await (await fetch("/__scanout_kernel")).arrayBuffer(),
            vfsImage: new Uint8Array(await (await fetch("/__scanout_image")).arrayBuffer()),
          });
          const scene = document.createElement("canvas");
          scene.width = 640; scene.height = 480; scene.id = "scanout-scene";
          document.body.replaceChildren(scene);
          kernel.kmsSetDisplaySize(1, 640, 480);
          kernel.kmsAttachCanvas(1, scene.transferControlToOffscreen(), new SharedArrayBuffer(36), { mode });
          const child = await kernel.spawnFromVfs("/bin/probe", ["probe", String(format)], { uid: 1000, gid: 1000 });
          (globalThis as any).__scanout.child = child;
        }, { moduleUrl: new URL(`/@fs${modulePath}`, baseURL).href, mode, format });
        await expect.poll(() => page.evaluate(() => (globalThis as any).__scanout.state.stdout),
          { timeout: 10_000 }).toContain("scanout colors ready");
        const sample = async () => {
          const png = await page.locator("#scanout-scene").screenshot({ scale: "css" });
          return page.evaluate(async encoded => {
            const bitmap = await createImageBitmap(new Blob([
              Uint8Array.from(atob(encoded), c => c.charCodeAt(0)),
            ], { type: "image/png" }));
            const ctx = new OffscreenCanvas(bitmap.width, bitmap.height).getContext("2d")!;
            ctx.drawImage(bitmap, 0, 0); bitmap.close();
            return [[160, 120], [480, 120], [160, 360], [480, 360], [17, 19]]
              .map(([x, y]) => Array.from(ctx.getImageData(x, y, 1, 1).data));
          }, png.toString("base64"));
        };
        await expect.poll(sample, { timeout: 10_000 }).toEqual([
          [255, 0, 0, 255], [0, 255, 0, 255], [0, 0, 255, 255], [255, 255, 255, 255], [255, 0, 0, 255],
        ]);
        await page.evaluate(() => {
          const { kernel, child } = (globalThis as any).__scanout;
          kernel.appendStdinData(child.pid, new TextEncoder().encode("g"));
        });
        await expect.poll(() => page.evaluate(() => (globalThis as any).__scanout.state.stdout))
          .toContain("unflipped pixel updated");
        await expect.poll(sample, { timeout: 10_000 }).toEqual([
          [255, 0, 0, 255], [0, 255, 0, 255], [0, 0, 255, 255], [255, 255, 255, 255], [255, 255, 255, 255],
        ]);
        const evidenceName = `${test.info().project.name}-${mode}-${name}`;
        const screenshot = await page.locator("#scanout-scene").screenshot({
          scale: "css", path: join(evidenceRoot, `${evidenceName}.png`),
        });
        writeFileSync(join(evidenceRoot, `${evidenceName}.json`), JSON.stringify({
          engine: test.info().project.name, version: browser.version(), mode, format: name,
          kernelSha256: sha256(readFileSync(resolveBinary("kernel.wasm"))),
          guestSha256: sha256(readFileSync(fixture.programPath)), screenshotSha256: sha256(screenshot),
          pixelAssertion: "red, green, blue, white; one unflipped white pixel at 17,19", width: 640, height: 480,
        }, null, 2) + "\n");
        const result = await page.evaluate(async () => {
          const { kernel, state, child } = (globalThis as any).__scanout;
          kernel.appendStdinData(child.pid, new TextEncoder().encode("q"));
          const status = await child.exit;
          await kernel.terminateProcess(child.pid, 0);
          return { ...state, status };
        });
        expect(result.status, JSON.stringify(result)).toBe(0);
        expect(result.stderr).toBe("");
        expect(result.diagnostics).toEqual([]);
      } finally {
        await page.evaluate(async () => { await (globalThis as any).__scanout?.kernel.destroy(); });
      }
      expect(errors).toEqual([]);
      expect(await memoryBoundaryFailures(page)).toEqual([]);
      expect(await page.evaluate(() => (globalThis as any).__scanout.state.diagnostics)).toEqual([]);
    });
  }
}
