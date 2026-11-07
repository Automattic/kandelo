// Standalone browser/automation reduction: no Kandelo code, Wasm, or SDK.
import { test, expect } from "../../../apps/browser-demos/node_modules/@playwright/test/index.mjs";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";

const source = process.env.PROBE_SOURCE ?? "gpu";
const capture = process.env.CAPTURE_METHOD ?? "element";
const contextHint = process.env.CONTEXT_HINT ?? "none";
if (!["gpu", "2d", "once"].includes(source)) throw new Error("Invalid PROBE_SOURCE");
if (!["element", "viewport", "bitmap"].includes(capture)) throw new Error("Invalid CAPTURE_METHOD");
if (!["none", "will-read-frequently", "desynchronized"].includes(contextHint)) throw new Error("Invalid CONTEXT_HINT");
const workerSource = readFileSync(new URL("./worker.js", import.meta.url), "utf8");
const workerSha256 = createHash("sha256").update(workerSource).digest("hex");
const playwrightVersion = JSON.parse(readFileSync(new URL(
  "../../../apps/browser-demos/node_modules/playwright-core/package.json", import.meta.url), "utf8")).version;

test("repeated capture of an unchanged worker-painted display", async ({ page, browser }) => {
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.setContent(`
    <div style="position:relative;width:640px;height:480px">
      <canvas id="scene" width="640" height="480" style="position:absolute;left:0;top:0"></canvas>
      <canvas id="cursor" width="640" height="480" style="position:absolute;left:0;top:0"></canvas>
    </div>`);
  await page.evaluate(async ({ code, source, readbackTimings, contextHint }) => {
    const worker = new Worker(URL.createObjectURL(new Blob([code], { type: "text/javascript" })));
    const scene = (document.querySelector("#scene") as HTMLCanvasElement).transferControlToOffscreen();
    const cursor = (document.querySelector("#cursor") as HTMLCanvasElement).transferControlToOffscreen();
    const readbacks: unknown[] = [];
    (globalThis as any).__probeReadbacks = readbacks;
    (globalThis as any).__probeContexts = null;
    await new Promise<void>((resolve, reject) => {
      worker.onmessage = ({ data }) => {
        if (data === "ready") resolve();
        else if (data?.kind === "contexts") (globalThis as any).__probeContexts = data;
        else if (data?.kind === "readback") {
          readbacks.push(data);
          if (readbacks.length > 64) readbacks.shift();
        }
      };
      worker.onerror = event => reject(new Error(event.message));
      worker.postMessage({ scene, cursor, source, readbackTimings, contextHint }, [scene, cursor]);
    });
    (globalThis as any).__probeWorker = worker;
  }, { code: workerSource, source, readbackTimings: capture === "bitmap" || contextHint !== "none", contextHint });
  const samples: unknown[] = [];
  const probes = [
    ["#cursor", 35, 45, [0, 255, 0, 255]],
    ["#scene", 320, 240, [255, 0, 0, 255]],
    ["#scene", 17, 19, [255, 255, 255, 255]],
  ] as const;
  let phase = capture === "bitmap" ? "initial canvas bitmap" : "initial visible paint";
  const sample = async (selector: string, x: number, y: number) => {
    const start = Date.now();
    const record: {phase:string;selector:string;x:number;y:number;stage:string;pixel?:number[];ms?:number} = {
      phase, selector, x, y, stage: "capture requested",
    };
    samples.push(record);
    // The bitmap mode deliberately observes the transferred HTML canvas's
    // committed bitmap, not the page compositor. It diagnoses the screenshot
    // path and must not replace visible-pixel product assertions.
    let bitmapTimer: ReturnType<typeof setTimeout> | undefined;
    const bitmapCapture = async () => {
      try {
        const encoded = await Promise.race([
          page.locator(selector).evaluate((canvas: HTMLCanvasElement) => canvas.toDataURL("image/png")),
          new Promise<never>((_, reject) => {
            bitmapTimer = setTimeout(() => reject(new Error("Canvas bitmap capture timed out after 10000ms")), 10_000);
          }),
        ]);
        if (!encoded.startsWith("data:image/png;base64,")) throw new Error("Canvas bitmap is not PNG");
        return Buffer.from(encoded.slice("data:image/png;base64,".length), "base64");
      } finally {
        if (bitmapTimer !== undefined) clearTimeout(bitmapTimer);
      }
    };
    const png = capture === "bitmap"
      ? await bitmapCapture()
      : capture === "viewport"
        ? await page.screenshot({ clip: (await page.locator(selector).boundingBox())!, scale: "css", timeout: 10_000 })
        : await page.locator(selector).screenshot({ scale: "css", timeout: 10_000 });
    record.stage = "captured";
    const pixel = await page.evaluate(async ({ encoded, x, y }) => {
      const bitmap = await createImageBitmap(new Blob([
        Uint8Array.from(atob(encoded), character => character.charCodeAt(0)),
      ], { type: "image/png" }));
      const context = new OffscreenCanvas(bitmap.width, bitmap.height).getContext("2d")!;
      context.drawImage(bitmap, 0, 0);
      const pixel = Array.from(context.getImageData(x, y, 1, 1).data);
      bitmap.close();
      return pixel;
    }, { encoded: png.toString("base64"), x, y });
    record.stage = "sampled";
    record.pixel = pixel;
    record.ms = Date.now() - start;
    return pixel;
  };
  try {
    // A worker message proves submission, not compositor presentation. Observe
    // each pixel through the selected capture path before steady captures.
    // Only element/viewport screenshots establish visible-page pixels.
    for (const [selector, x, y, wanted] of probes) {
      await expect.poll(() => sample(selector, x, y), { timeout: 10_000 }).toEqual(wanted);
    }
    for (let round = 0; round < 20; round++) {
      phase = `steady capture ${round}`;
      for (const [selector, x, y, wanted] of probes) {
        expect(await sample(selector, x, y)).toEqual(wanted);
      }
    }
    expect(errors).toEqual([]);
  } finally {
    const contexts = await page.evaluate(() => (globalThis as any).__probeContexts).catch(() => null);
    const readbacks = capture === "bitmap" || contextHint !== "none"
      ? await page.evaluate(() => (globalThis as any).__probeReadbacks).catch(() => null)
      : undefined;
    writeFileSync(test.info().outputPath("samples.json"), JSON.stringify({
      engine: browser.version(), playwrightVersion, platform: process.platform,
      arch: process.arch, source, capture, contextHint, workerSha256, errors, samples, readbacks, contexts,
    }, null, 2) + "\n");
    await page.evaluate(() => (globalThis as any).__probeWorker.terminate());
  }
});
