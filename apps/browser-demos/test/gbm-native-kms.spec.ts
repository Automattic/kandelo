import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";
import { resolveBinary } from "../../../host/src/binary-resolver";
import { compileSdkFixture } from "../../../host/test/support/compile-sdk-fixture";
import { KandeloImageFs } from "../../../images/vfs/lib/kandelo-image-fs";
import { installBrowserMemoryBoundaryProbe, memoryBoundaryFailures } from "./support/browser-memory-boundary";

const fixtures = new Map<string, ReturnType<typeof compileSdkFixture>>();
const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
test.use({ serviceWorkers: "block", viewport: { width: 400, height: 300 } });
test.beforeAll(() => {
  for (const arch of ["wasm32", "wasm64"] as const) {
    const sysroot = arch === "wasm64" ? "sysroot64" : "sysroot";
    fixtures.set(arch, compileSdkFixture(new URL("../../../host/test/fixtures/gbm-native-kms.c", import.meta.url), [
      `-I${fileURLToPath(new URL(`../../../${sysroot}/include/drm`, import.meta.url))}`,
      "-lEGL", "-lGLESv2", "-lgbm", "-ldrm",
    ], { arch }));
  }
});
test.afterAll(() => { for (const fixture of fixtures.values()) fixture.cleanup(); });

for (const arch of ["wasm32", "wasm64"] as const) {
  for (const mode of ["webgl2-scanout", "2d"] as const) {
    test(`${arch} ${mode} native window waits for KMS selection and preserves GL row orientation`, async ({ page, baseURL, browser }) => {
      test.setTimeout(90_000);
      const program = readFileSync(fixtures.get(arch)!.programPath);
      const kernelBytes = readFileSync(resolveBinary("kernel.wasm"));
      const fs = KandeloImageFs.create();
      fs.mkdir("/bin", 0o755);
      fs.writeFile("/bin/probe", program, 0o755);
      const bytes = await fs.saveImage();
      const evidence = fileURLToPath(new URL("../../../.context/gbm-native-kms-guests/", import.meta.url));
      mkdirSync(evidence, { recursive: true });
      const identity = `${Date.now()}-${test.info().project.name}-${arch}-${mode}`;
      writeFileSync(`${evidence}/${identity}.wasm`, program);
      const observations: Record<string, number[][]> = {};
      let phase = "unselected", exitStatus: number | undefined;
      const errors: string[] = [];
      page.on("pageerror", error => errors.push(error.message));
      await page.route("**/__ring_kernel", route => route.fulfill({ body: kernelBytes }));
      await page.route("**/__ring_image", route => route.fulfill({ body: Buffer.from(bytes) }));
      await installBrowserMemoryBoundaryProbe(page);
      await page.goto("/trap-signal-test.html");
      const module = fileURLToPath(new URL("../../../host/src/browser-kernel-host.ts", import.meta.url));
      try {
        await page.evaluate(async ({ url, mode }) => {
          const { BrowserKernel } = await import(/* @vite-ignore */ url);
          const state = { stdout: "", stderr: "", diagnostics: [] as unknown[], pid: 0 };
          const kernel = new BrowserKernel({
            kernelOwnedFs: true,
            onStdout: (data: Uint8Array) => { state.stdout += new TextDecoder().decode(data); },
            onStderr: (data: Uint8Array) => { state.stderr += new TextDecoder().decode(data); },
            onHostDiagnostic: (value: unknown) => state.diagnostics.push(value),
          });
          (globalThis as any).__ringKms = { state, kernel };
          await kernel.initFromImage({
            kernelWasm: await (await fetch("/__ring_kernel")).arrayBuffer(),
            vfsImage: new Uint8Array(await (await fetch("/__ring_image")).arrayBuffer()),
          });
          const scene = document.createElement("canvas");
          scene.id = "ring-scene"; scene.width = 640; scene.height = 480;
          scene.style.cssText = "width:400px;height:300px;background:black;image-rendering:pixelated";
          document.body.style.cssText = "margin:0;background:black";
          document.body.replaceChildren(scene);
          kernel.kmsSetDisplaySize(1, 640, 480);
          kernel.kmsAttachCanvas(1, scene.transferControlToOffscreen(), new SharedArrayBuffer(32), { mode });
          const child = await kernel.spawnFromVfs("/bin/probe", ["probe"], { uid: 1000, gid: 1000 });
          state.pid = child.pid;
          (globalThis as any).__ringKms.exit = child.exit;
        }, { url: new URL(`/@fs${module}`, baseURL).href, mode });
        const state = () => page.evaluate(() => (globalThis as any).__ringKms.state);
        await expect.poll(state, { timeout: 15_000 }).toMatchObject({ stdout: "READY_UNSELECTED\n", stderr: "", diagnostics: [] });
        const sample = async () => {
          const png = await page.locator("#ring-scene").screenshot({ scale: "css" });
          const values = await page.evaluate(async encoded => {
            const bitmap = await createImageBitmap(new Blob([
              Uint8Array.from(atob(encoded), c => c.charCodeAt(0)),
            ], { type: "image/png" }));
            const context = new OffscreenCanvas(bitmap.width, bitmap.height).getContext("2d")!;
            context.drawImage(bitmap, 0, 0); bitmap.close();
            return [[50, 250], [350, 50], [200, 150], [50, 50], [350, 250]]
              .map(([x, y]) => Array.from(context.getImageData(x, y, 1, 1).data));
          }, png.toString("base64"));
          observations[phase] = values;
          return values;
        };
        await expect.poll(sample, { timeout: 10_000 }).toEqual(Array.from({ length: 5 }, () => [0, 0, 0, 255]));
        phase = "selected";
        await page.evaluate(() => {
          const value = (globalThis as any).__ringKms;
          value.kernel.appendStdinData(value.state.pid, new TextEncoder().encode("p"));
        });
        await expect.poll(state, { timeout: 15_000 }).toMatchObject({ stdout: "READY_UNSELECTED\nREADY_SELECTED\n", stderr: "", diagnostics: [] });
        await expect.poll(sample, { timeout: 10_000 }).toEqual([
          [0, 255, 0, 255], [0, 0, 255, 255], [255, 0, 0, 255], [255, 0, 0, 255], [255, 0, 0, 255],
        ]);
        await page.evaluate(() => {
          const value = (globalThis as any).__ringKms;
          value.kernel.appendStdinData(value.state.pid, new TextEncoder().encode("q"));
        });
        exitStatus = await page.evaluate(async () => await (globalThis as any).__ringKms.exit);
        expect(exitStatus).toBe(0);
        await page.evaluate(async () => {
          const value = (globalThis as any).__ringKms;
          await value.kernel.terminateProcess(value.state.pid, 0);
        });
        expect(await state()).toMatchObject({ stderr: "", diagnostics: [] });
      } finally {
        try { await page.evaluate(async () => await (globalThis as any).__ringKms?.kernel.destroy()); }
        finally {
          writeFileSync(`${evidence}/${identity}.json`, JSON.stringify({
            arch, mode, engine: test.info().project.name, version: browser.version(),
            kernelSha256: hash(kernelBytes), programSha256: hash(program), imageSha256: hash(bytes),
            observations, exitStatus, errors,
          }, null, 2) + "\n");
        }
      }
      expect(errors).toEqual([]);
      expect(await page.evaluate(() => (globalThis as any).__ringKms.state.diagnostics)).toEqual([]);
      expect(await memoryBoundaryFailures(page)).toEqual([]);
    });
  }
}
