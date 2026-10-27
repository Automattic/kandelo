/** An actual forked guest presents its inherited cursor after opener retirement. */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";
import { compileSdkFixture } from "../../../host/test/support/compile-sdk-fixture";
import { resolveBinary } from "../../../host/src/binary-resolver";
import { KandeloImageFs } from "../../../images/vfs/lib/kandelo-image-fs";
import { installBrowserMemoryBoundaryProbe, memoryBoundaryFailures } from "./support/browser-memory-boundary";

test.use({ serviceWorkers: "block", viewport: { width: 800, height: 600 } });
let fixture: ReturnType<typeof compileSdkFixture>;
test.beforeAll(() => {
  fixture = compileSdkFixture(new URL("../../../host/test/fixtures/dri-kms-inheritance.c", import.meta.url), [
    "-DTEST_EGL_RENDER",
    `-I${fileURLToPath(new URL("../../../sysroot/include/drm", import.meta.url))}`,
    "-lEGL", "-lGLESv2", "-lgbm", "-ldrm",
  ], {
    forkInstrument: true,
  });
});
test.afterAll(() => fixture?.cleanup());

for (const mode of ["cursor", "render"]) {
  test(`inherited master presents ${mode} after the opener Worker exits`, async ({ page, baseURL }) => {
    test.setTimeout(60_000);
    const image = KandeloImageFs.create();
    image.mkdir("/bin", 0o755);
    image.writeFile("/bin/probe", readFileSync(fixture.programPath), 0o755);
    const imageBytes = await image.saveImage();
    await page.route("**/__kms_inherited_kernel", route => route.fulfill({
      body: readFileSync(resolveBinary("kernel.wasm")),
    }));
    await page.route("**/__kms_inherited_image", route => route.fulfill({ body: Buffer.from(imageBytes) }));
    const errors: string[] = [];
    page.on("pageerror", error => errors.push(error.message));
    await installBrowserMemoryBoundaryProbe(page);
    await page.goto(new URL("/trap-signal-test.html", baseURL).href);
    const modulePath = fileURLToPath(new URL("../../../host/src/browser-kernel-host.ts", import.meta.url));
    try {
      const prepared = await page.evaluate(async ({ moduleUrl, mode }) => {
        const { BrowserKernel } = await import(/* @vite-ignore */ moduleUrl);
        const state = { stdout: "", stderr: "", diagnostics: [] as unknown[], childPid: 0, openerPid: 0 };
        let resolveReady!: () => void;
        const ready = new Promise<void>(resolve => { resolveReady = resolve; });
        let resolveExit!: (status: number | undefined) => void;
        const childExit = new Promise<number | undefined>(resolve => { resolveExit = resolve; });
        const kernel = new BrowserKernel({
          kernelOwnedFs: true,
          onStdout: (data: Uint8Array) => {
            state.stdout += new TextDecoder().decode(data);
            const match = state.stdout.match(/kms-inherited-child=(\d+)/);
            if (match) state.childPid = Number(match[1]);
            if (state.stdout.includes(`inherited ${mode} after opener retirement: ready`)) resolveReady();
          },
          onStderr: (data: Uint8Array) => { state.stderr += new TextDecoder().decode(data); },
          onHostDiagnostic: (diagnostic: unknown) => state.diagnostics.push(diagnostic),
          onProcessEvent: (event: { kind: string; pid: number; exitStatus?: number }) => {
            if (event.kind === "exit" && event.pid === state.childPid) resolveExit(event.exitStatus);
          },
        });
        (globalThis as any).__kmsInheritance = { kernel, state, childExit };
        await kernel.initFromImage({
          kernelWasm: await (await fetch("/__kms_inherited_kernel")).arrayBuffer(),
          vfsImage: new Uint8Array(await (await fetch("/__kms_inherited_image")).arrayBuffer()),
        });
        const scene = document.createElement("canvas"), cursor = document.createElement("canvas");
        scene.id = "inherited-scene";
        scene.width = cursor.width = 640;
        scene.height = cursor.height = 480;
        cursor.id = "inherited-cursor";
        document.body.replaceChildren(scene, cursor);
        kernel.kmsSetDisplaySize(1, 640, 480);
        kernel.kmsAttachCanvas(1, scene.transferControlToOffscreen(), new SharedArrayBuffer(32), {
          mode: mode === "render" ? "webgl2-scanout" : "2d", cursorCanvas: cursor.transferControlToOffscreen(),
        });
        const opener = await kernel.spawnFromVfs("/bin/probe", ["probe", mode], { uid: 1000, gid: 1000 });
        state.openerPid = opener.pid;
        const openerStatus = await opener.exit;
        if (openerStatus !== 0 || !state.childPid) throw new Error(JSON.stringify({ ...state, openerStatus }));
        await kernel.terminateProcess(opener.pid, 0);
        // The registered input stream outlives its opener while inherited
        // read ends survive. Do not infer that stream from the new PPID.
        kernel.appendStdinData(opener.pid, new TextEncoder().encode("g"));
        await Promise.race([ready, childExit.then(status => {
          throw new Error(`Inherited child exited early (${status}): ${JSON.stringify(state)}`);
        })]);
        return { ...state, openerStatus };
      }, { moduleUrl: new URL(`/@fs${modulePath}`, baseURL).href, mode });
      expect(prepared.stderr).toBe("");
      const sampleCanvas = async (selector: string, x: number, y: number) => {
        const png = await page.locator(selector).screenshot({ scale: "css" });
        return page.evaluate(async ({ encoded, x, y }) => {
          const bitmap = await createImageBitmap(new Blob([
            Uint8Array.from(atob(encoded), c => c.charCodeAt(0)),
          ], { type: "image/png" }));
          const context = new OffscreenCanvas(bitmap.width, bitmap.height).getContext("2d")!;
          context.drawImage(bitmap, 0, 0);
          const pixel = Array.from(context.getImageData(x, y, 1, 1).data);
          bitmap.close();
          return pixel;
        }, { encoded: png.toString("base64"), x, y });
      };
      await expect.poll(() => sampleCanvas("#inherited-cursor", 35, 45), { timeout: 10_000 })
        .toEqual([0, 255, 0, 255]);
      if (mode === "render") {
        await expect.poll(() => sampleCanvas("#inherited-scene", 320, 240), { timeout: 10_000 })
          .toEqual([255, 0, 0, 255]);
      }
      const result = await page.evaluate(async () => {
        const { kernel, state, childExit } = (globalThis as any).__kmsInheritance;
        kernel.appendStdinData(state.openerPid, new TextEncoder().encode("q"));
        const childStatus = await childExit;
        await kernel.terminateProcess(state.childPid, 0);
        return { ...state, childStatus };
      });
      expect(result.childStatus, JSON.stringify(result)).toBe(0);
      expect(result.stdout).toContain("inherited KMS file: ok");
      expect(result.stderr).toBe("");
      expect(result.diagnostics).toEqual([]);
    } finally {
      await page.evaluate(async () => {
        await (globalThis as any).__kmsInheritance?.kernel.destroy();
      });
    }
    expect(await page.evaluate(() => (globalThis as any).__kmsInheritance.state.diagnostics)).toEqual([]);
    expect(errors).toEqual([]);
    expect(await memoryBoundaryFailures(page)).toEqual([]);
  });
}
