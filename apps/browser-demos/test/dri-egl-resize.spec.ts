import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";
import { resolveBinary } from "../../../host/src/binary-resolver";
import { compileSdkFixture } from "../../../host/test/support/compile-sdk-fixture";
import { KandeloImageFs } from "../../../images/vfs/lib/kandelo-image-fs";

test.use({ serviceWorkers: "block" });

test("SDL preserves first-frame geometry and alpha blending after window and context replacement", async ({ page, baseURL }) => {
  test.setTimeout(120_000);
  const root = fileURLToPath(new URL("../../../", import.meta.url));
  const target = execFileSync("rustc", ["-vV"], { encoding: "utf8" }).match(/^host: (.+)$/m)![1];
  const xtask = process.env.WASM_POSIX_XTASK_BIN ?? resolve(root, "target", target, "release/xtask");
  const paths = ["sdl2", "libwayland", "libxkbcommon", "libffi"].map(name =>
    execFileSync(xtask, ["build-deps", "resolve", name, "--arch", "wasm32"],
      { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim());
  const { programPath, cleanup } = compileSdkFixture(
    new URL("../../../host/test/fixtures/sdl2-window-resize.c", import.meta.url), [
      `-I${paths[0]}/include/SDL2`, ...paths.map(path => `-L${path}/lib`),
      "-lSDL2", "-lwayland-client", "-lwayland-egl", "-lwayland-cursor", "-lxkbcommon",
      "-lffi", "-lgbm", "-ldrm", "-lEGL", "-lGLESv2", "-lm",
    ], { forkInstrument: true },
  );
  try {
    const image = KandeloImageFs.create();
    image.setImageCapacity(16 * 1024 * 1024);
    image.mkdir("/bin", 0o755);
    image.writeFile("/bin/resize", readFileSync(programPath), 0o755);
    const imageBytes = await image.saveImage();
    const kernelUrl = new URL("/__egl_resize_kernel", baseURL).href;
    const imageUrl = new URL("/__egl_resize_image", baseURL).href;
    await page.route(kernelUrl, route => route.fulfill({ body: readFileSync(resolveBinary("kernel.wasm")) }));
    await page.route(imageUrl, route => route.fulfill({ body: Buffer.from(imageBytes) }));
    await page.goto(new URL("/trap-signal-test.html", baseURL).href);
    await page.evaluate(async ({ moduleUrl, kernelUrl, imageUrl }) => {
      const { BrowserKernel } = await import(moduleUrl);
      const scope = globalThis as any;
      scope.__resizeOutput = "";
      scope.__resizeDiagnostics = [];
      const kernel = new BrowserKernel({ kernelOwnedFs: true,
        onStdout: (bytes: Uint8Array) => { scope.__resizeOutput += new TextDecoder().decode(bytes); },
        onStderr: (bytes: Uint8Array) => { scope.__resizeOutput += new TextDecoder().decode(bytes); },
        onHostDiagnostic: (diagnostic: unknown) => scope.__resizeDiagnostics.push(diagnostic),
      });
      scope.__resizeKernel = kernel;
      await kernel.initFromImage({
        kernelWasm: await (await fetch(kernelUrl)).arrayBuffer(),
        vfsImage: new Uint8Array(await (await fetch(imageUrl)).arrayBuffer()),
      });
      const canvas = document.createElement("canvas");
      canvas.id = "resize-screen";
      document.body.style.margin = "0";
      document.body.replaceChildren(canvas);
      const stats = new SharedArrayBuffer(32);
      scope.__resizeStats = new Int32Array(stats);
      kernel.kmsSetDisplaySize(1, 960, 540);
      kernel.kmsAttachCanvas(1, canvas.transferControlToOffscreen(), stats, { mode: "webgl2-scanout" });
      const child = await kernel.spawnFromVfs("/bin/resize", ["resize"], {
        uid: 1000, gid: 1000,
        env: ["SDL_VIDEODRIVER=kmsdrm", "SDL_EVDEV_DEVICES=2:/dev/input/event0,1:/dev/input/event1"],
      });
      scope.__resizeExit = child.exit;
      child.exit.then((code: number) => { scope.__resizeExitCode = code; });
    }, { moduleUrl: new URL(`/@fs/${resolve(root, "host/src/browser-kernel-host.ts")}`, baseURL).href,
      kernelUrl, imageUrl });
    for (const [width, height, red, green, blue] of [[960, 540, 255, 0, 0], [800, 600, 0, 255, 0], [1280, 720, 0, 0, 255]]) {
      await expect.poll(async () => {
        const status = await page.evaluate(() => ({ output: (globalThis as any).__resizeOutput,
          exit: (globalThis as any).__resizeExitCode, diagnostics: (globalThis as any).__resizeDiagnostics }));
        if (status.exit !== undefined) throw new Error(JSON.stringify(status));
        return status.output;
      }, { timeout: 30_000 })
        .toContain(`READY:${width}x${height}`);
      await expect.poll(() => page.evaluate(() => [
        Atomics.load((globalThis as any).__resizeStats, 2),
        Atomics.load((globalThis as any).__resizeStats, 3),
      ])).toEqual([width, height]);
      // The guest draws exactly once. Requiring its first frame at several
      // positions catches clears and clipping after a late SETCRTC resize.
      const baseColor = [red, green, blue];
      const expected = [baseColor, baseColor.map(value => 128 + value * 127 / 255), baseColor];
      // Native GL/screenshot quantization can differ by one intensity level.
      await expect.poll(async () => {
        const png = await page.locator("#resize-screen").screenshot();
        const pixels = await page.evaluate(async encoded => {
          const bitmap = await createImageBitmap(new Blob([
            Uint8Array.from(atob(encoded), c => c.charCodeAt(0)),
          ], { type: "image/png" }));
          const ctx = new OffscreenCanvas(bitmap.width, bitmap.height).getContext("2d")!;
          ctx.drawImage(bitmap, 0, 0);
          const pixels = [[0.1, 0.1], [0.5, 0.5], [0.9, 0.9]].map(([x, y]) =>
            Array.from(ctx.getImageData(Math.floor(bitmap.width * x), Math.floor(bitmap.height * y), 1, 1).data));
          bitmap.close();
          return pixels;
        }, png.toString("base64"));
        if (pixels.some(pixel => pixel[3] !== 255)) return 255;
        return Math.max(...pixels.flatMap((pixel, i) =>
          pixel.slice(0, 3).map((value, channel) => Math.abs(value - expected[i][channel]))));
      }).toBeLessThanOrEqual(1);
      await page.evaluate(() => {
        const kernel = (globalThis as any).__resizeKernel;
        kernel.injectInputEventBatch([
          { device: 0, ev_type: 1, code: 57, value: 1 }, { device: 0, ev_type: 0, code: 0, value: 0 },
          { device: 0, ev_type: 1, code: 57, value: 0 }, { device: 0, ev_type: 0, code: 0, value: 0 },
        ]);
      });
    }
    expect(await page.evaluate(() => (globalThis as any).__resizeExit)).toBe(0);
  } finally {
    await page.evaluate(() => (globalThis as any).__resizeKernel?.destroy());
    cleanup();
  }
});
