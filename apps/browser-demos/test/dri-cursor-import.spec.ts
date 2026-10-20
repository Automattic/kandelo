import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";
import { compileSdkFixture } from "../../../host/test/support/compile-sdk-fixture";
import { resolveBinary } from "../../../host/src/binary-resolver";
import { KandeloImageFs } from "../../../images/vfs/lib/kandelo-image-fs";

test.use({ serviceWorkers: "block", viewport: { width: 800, height: 600 } });
let fixture: ReturnType<typeof compileSdkFixture>;
test.beforeAll(() => {
  fixture = compileSdkFixture(new URL("../../../host/test/fixtures/kms-import-writer.c", import.meta.url), [], {
    forkInstrument: true,
  });
});
test.afterAll(() => fixture?.cleanup());

for (const [writer, label] of [
  ["allocator", "allocator before import"],
  ["allocator-after-import", "allocator after an unchanged import"],
  ["importer", "importing process"],
]) {
  test(`presents cursor pixels written by the ${label}`, async ({ page, baseURL }) => {
    const image = KandeloImageFs.create();
    image.mkdir("/bin", 0o755);
    image.writeFile("/bin/probe", readFileSync(fixture.programPath), 0o755);
    const bytes = await image.saveImage();
    await page.route("**/__cursor_import_kernel", route => route.fulfill({
      body: readFileSync(resolveBinary("kernel.wasm")),
    }));
    await page.route("**/__cursor_import_image", route => route.fulfill({ body: Buffer.from(bytes) }));
    await page.goto(new URL("/trap-signal-test.html", baseURL).href);
    const modulePath = fileURLToPath(new URL("../../../host/src/browser-kernel-host.ts", import.meta.url));
    try {
      await page.evaluate(async moduleUrl => {
        const { BrowserKernel } = await import(moduleUrl);
        const state = { stdout: "", stderr: "" };
        (globalThis as any).__cursorImportOutput = state;
        const kernel = new BrowserKernel({
          kernelOwnedFs: true,
          onStdout: (data: Uint8Array) => { state.stdout += new TextDecoder().decode(data); },
          onStderr: (data: Uint8Array) => { state.stderr += new TextDecoder().decode(data); },
        });
        (globalThis as any).__cursorImportKernel = kernel;
        await kernel.initFromImage({
          kernelWasm: await (await fetch("/__cursor_import_kernel")).arrayBuffer(),
          vfsImage: new Uint8Array(await (await fetch("/__cursor_import_image")).arrayBuffer()),
        });
        const scene = document.createElement("canvas"), cursor = document.createElement("canvas");
        scene.width = cursor.width = 640;
        scene.height = cursor.height = 480;
        cursor.id = "cursor-plane";
        cursor.style.position = "absolute";
        cursor.style.left = cursor.style.top = "0";
        document.body.replaceChildren(scene, cursor);
        kernel.kmsSetDisplaySize(1, 640, 480);
        kernel.kmsAttachCanvas(1, scene.transferControlToOffscreen(), new SharedArrayBuffer(32), {
          mode: "2d", cursorCanvas: cursor.transferControlToOffscreen(),
        });
      }, new URL(`/@fs/${modulePath}`, baseURL).href);
      await page.evaluate(async writer => {
        const child = await (globalThis as any).__cursorImportKernel.spawnFromVfs(
          "/bin/probe", ["probe", writer], { uid: 1000, gid: 1000 });
        child.exit.catch(() => {});
      }, writer);
      await expect.poll(() => page.evaluate(() => (globalThis as any).__cursorImportOutput.stdout),
        { timeout: 30_000 }).toContain("cursor submitted");
      // Observe the actual browser output, without injecting registry state
      // or replacing the presentation path. Both writers fill the same red.
      await expect.poll(async () => {
        const png = await page.locator("#cursor-plane").screenshot({ scale: "css" });
        return page.evaluate(async encoded => {
          const bitmap = await createImageBitmap(new Blob([
            Uint8Array.from(atob(encoded), c => c.charCodeAt(0)),
          ], { type: "image/png" }));
          const ctx = new OffscreenCanvas(bitmap.width, bitmap.height).getContext("2d")!;
          ctx.drawImage(bitmap, 0, 0);
          const pixel = Array.from(ctx.getImageData(35, 45, 1, 1).data);
          bitmap.close();
          return pixel;
        }, png.toString("base64"));
      }, { timeout: 10_000 }).toEqual([255, 0, 0, 255]);
    } finally {
      await page.evaluate(() => (globalThis as any).__cursorImportKernel?.destroy());
    }
  });
}
