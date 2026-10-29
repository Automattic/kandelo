// Standalone browser/automation reduction: no Kandelo code, Wasm, or SDK.
import { test, expect } from "../../../apps/browser-demos/node_modules/@playwright/test/index.mjs";
import { readFileSync, writeFileSync } from "node:fs";

const source = process.env.PROBE_SOURCE ?? "gpu";
const capture = process.env.CAPTURE_METHOD ?? "element";
if (!["gpu", "2d", "once"].includes(source)) throw new Error("Invalid PROBE_SOURCE");
if (!["element", "viewport"].includes(capture)) throw new Error("Invalid CAPTURE_METHOD");
const workerSource = readFileSync(new URL("./worker.js", import.meta.url), "utf8");
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
  await page.evaluate(async ({ code, source }) => {
    const worker = new Worker(URL.createObjectURL(new Blob([code], { type: "text/javascript" })));
    const scene = (document.querySelector("#scene") as HTMLCanvasElement).transferControlToOffscreen();
    const cursor = (document.querySelector("#cursor") as HTMLCanvasElement).transferControlToOffscreen();
    await new Promise<void>((resolve, reject) => {
      worker.onmessage = () => resolve();
      worker.onerror = event => reject(new Error(event.message));
      worker.postMessage({ scene, cursor, source }, [scene, cursor]);
    });
    (globalThis as any).__probeWorker = worker;
  }, { code: workerSource, source });
  const samples: unknown[] = [];
  const probes = [
    ["#cursor", 35, 45, [0, 255, 0, 255]],
    ["#scene", 320, 240, [255, 0, 0, 255]],
    ["#scene", 17, 19, [255, 255, 255, 255]],
  ] as const;
  let phase = "initial visible paint";
  const sample = async (selector: string, x: number, y: number) => {
    const start = Date.now();
    const record: {phase:string;selector:string;x:number;y:number;stage:string;pixel?:number[];ms?:number} = {
      phase, selector, x, y, stage: "capture requested",
    };
    samples.push(record);
    const png = capture === "viewport"
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
    // each visible pixel before treating a later mismatch as a steady capture.
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
    writeFileSync(test.info().outputPath("samples.json"), JSON.stringify({
      engine: browser.version(), playwrightVersion, platform: process.platform,
      arch: process.arch, source, capture, errors, samples,
    }, null, 2) + "\n");
    await page.evaluate(() => (globalThis as any).__probeWorker.terminate());
  }
});
