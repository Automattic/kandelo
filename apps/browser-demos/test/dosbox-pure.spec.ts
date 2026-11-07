import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, test } from "../playwright-test";
import { resolveBinary } from "../../../host/src/binary-resolver";
import { dosSmokeImage } from "../../../packages/registry/dosbox-pure/test/fixtures";

test.use({ serviceWorkers: "block" });

for (const suspendedShutdown of [false, true]) {
test(`DOSBox Pure interprets VGA, BIOS keyboard and DOS filesystem calls${suspendedShutdown ? " with a suspended audio clock at exit" : ""}`, async ({ page, baseURL }) => {
  test.setTimeout(120_000);
  const image = await dosSmokeImage();
  await page.route("**/__dos_kernel", route => route.fulfill({ body: readFileSync(resolveBinary("kernel.wasm")) }));
  await page.route("**/__dos_image", route => route.fulfill({ body: Buffer.from(image) }));
  await page.goto(new URL("/trap-signal-test.html", baseURL).href);
  const moduleUrl = (path: string) => new URL(`/@fs/${fileURLToPath(new URL(path, import.meta.url))}`, baseURL).href;
  try {
    await page.evaluate(async urls => {
      const { BrowserKernel } = await import(urls.kernel);
      const { attachCanvas } = await import(urls.canvas);
      const { attachLinuxMediumRawKeyboard } = await import(urls.controls);
      const state = { stderr: "", kernel: null as any, child: null as any, detach: null as any, keys: null as any };
      (window as any).__dosTest = state;
      const kernel = state.kernel = new BrowserKernel({
        kernelOwnedFs: true,
        onStderr: (bytes: Uint8Array) => { state.stderr += new TextDecoder().decode(bytes); },
      });
      await kernel.initFromImage({
        kernelWasm: await (await fetch("/__dos_kernel")).arrayBuffer(),
        vfsImage: new Uint8Array(await (await fetch("/__dos_image")).arrayBuffer()),
      });
      const canvas = document.createElement("canvas");
      canvas.id = "dos-video";
      canvas.tabIndex = 0;
      document.body.replaceChildren(canvas);
      const child = state.child = await kernel.spawnFromVfs("/usr/bin/dosbox-pure",
        ["dosbox-pure", "/games/dosbox.conf"], {
          pty: true, uid: 1000, gid: 1000,
          env: ["HOME=/home/player", "XDG_DATA_HOME=/home/player/data"],
        });
      child.exit.catch(() => {});
      kernel.onPtyOutput(child.pid, (bytes: Uint8Array) => {
        state.stderr += new TextDecoder().decode(bytes);
      });
      state.detach = attachCanvas(canvas, kernel.framebuffers, child.pid, { getProcessMemory: () => undefined });
      state.keys = attachLinuxMediumRawKeyboard(canvas, {
        sendInput: (bytes: Uint8Array) => kernel.ptyWrite(child.pid, bytes),
      });
    }, {
      kernel: moduleUrl("../../../host/src/browser-kernel-host.ts"),
      canvas: moduleUrl("../../../host/src/framebuffer/canvas-renderer.ts"),
      controls: moduleUrl("../../../host/src/framebuffer/browser-controls.ts"),
    });
    await expect.poll(() => page.evaluate(async () => Array.from(
      await (window as any).__dosTest.kernel.readFileFromVfs("/games/READY.TXT") ?? [])),
      { timeout: 60_000 }).toEqual([1]);
    const canvas = page.locator("#dos-video");
    await expect.poll(() => canvas.evaluate((element: HTMLCanvasElement) => {
      const pixel = element.getContext("2d")!.getImageData(320, 200, 1, 1).data;
      return pixel[0] > 100 && pixel[1] < 20 && pixel[2] < 20;
    }), { timeout: 30_000 }).toBe(true);
    await canvas.focus();
    await page.keyboard.down("a");
    await expect.poll(() => page.evaluate(async () => Array.from(
      await (window as any).__dosTest.kernel.readFileFromVfs("/games/RESULT.TXT") ?? [])),
      { timeout: 30_000 }).toEqual([0x61]);
    await page.keyboard.up("a");
    if (suspendedShutdown) {
      await page.evaluate(async () => {
        const { kernel } = (window as any).__dosTest;
        await kernel.prepareAudio();
        await kernel.suspendAudio();
      });
      await expect.poll(() => page.evaluate(async () => {
        const { producer, consumer, discard } = await (window as any).__dosTest.kernel.getAudioTransportSnapshot();
        return producer > (consumer > discard ? consumer : discard);
      })).toBe(true);
    }
    const result = await page.evaluate(async () => {
      const state = (window as any).__dosTest;
      await state.kernel.signalProcess(state.child.pid, 15);
      const exit = await state.child.exit;
      return { exit, stderr: state.stderr, bound: state.kernel.framebuffers.get(state.child.pid) !== undefined };
    });
    expect(result.exit, result.stderr).toBe(0);
    expect(result.stderr).toContain("running x86 interpreter");
    expect(result.bound).toBe(false);
  } finally {
    await page.evaluate(async () => {
      const state = (window as any).__dosTest;
      state?.keys?.close();
      state?.detach?.();
      await state?.kernel?.destroy();
    });
  }
});
}
