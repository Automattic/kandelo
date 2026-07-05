import { writeFileSync } from "node:fs";
import { expect, test, type Locator, type Page, type TestInfo } from "@playwright/test";

interface KmsSnapshotMetrics {
  backingStore: { width: number; height: number };
  canvasRect: { x: number; y: number; width: number; height: number };
  stageRect: { width: number; height: number };
  litPixels: number;
  coloredPixels: number;
  litBounds: { minX: number; minY: number; maxX: number; maxY: number; width: number; height: number } | null;
  channelBoxes: Record<string, {
    minX: number;
    minY: number;
    maxX: number;
    maxY: number;
    count: number;
    meanX: number;
    width: number;
    height: number;
  } | null>;
  widthFill: number;
  heightFill: number;
  scanlineAlternation: number;
  adjacentRowContrast: number;
  strongestChannelShift: {
    rgShift: number;
    rgScore: number;
    rbShift: number;
    rbScore: number;
  };
}

const appUrl = (path: string): string => {
  const baseUrl = process.env.KANDELO_TEST_BASE_URL;
  return baseUrl ? new URL(path, baseUrl).href : path;
};

async function gotoOrSkip(page: Page, path: string) {
  await page.goto(appUrl(path), { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(2_000);
  if (await page.locator("vite-error-overlay").count()) {
    test.skip(true, "Required binary not built - Vite import error");
  }
}

async function captureKmsSnapshot(
  page: Page,
  canvas: Locator,
  label: string,
  testInfo: TestInfo,
): Promise<KmsSnapshotMetrics> {
  const metrics = await page.evaluate<KmsSnapshotMetrics>(() => {
    const canvas = document.querySelector<HTMLCanvasElement>("canvas.kmodeset-canvas");
    const stage = document.querySelector<HTMLElement>(".kmodeset-stage");
    if (!canvas || !stage) throw new Error("missing KMS canvas or stage");

    const canvasRect = canvas.getBoundingClientRect();
    const stageRect = stage.getBoundingClientRect();
    const sampleCanvas = new OffscreenCanvas(canvas.width, canvas.height);
    const ctx = sampleCanvas.getContext("2d");
    if (!ctx) throw new Error("2D sample context unavailable");
    ctx.drawImage(canvas, 0, 0);
    const sample = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
    let litPixels = 0;
    let coloredPixels = 0;
    let minX = canvas.width;
    let minY = canvas.height;
    let maxX = -1;
    let maxY = -1;
    const rowLuma = Array.from({ length: canvas.height }, () => 0);
    const channels = {
      red: { minX: canvas.width, minY: canvas.height, maxX: -1, maxY: -1, count: 0, sumX: 0 },
      green: { minX: canvas.width, minY: canvas.height, maxX: -1, maxY: -1, count: 0, sumX: 0 },
      blue: { minX: canvas.width, minY: canvas.height, maxX: -1, maxY: -1, count: 0, sumX: 0 },
    };
    const addChannel = (channel: keyof typeof channels, x: number, y: number) => {
      const box = channels[channel];
      box.minX = Math.min(box.minX, x);
      box.minY = Math.min(box.minY, y);
      box.maxX = Math.max(box.maxX, x);
      box.maxY = Math.max(box.maxY, y);
      box.count++;
      box.sumX += x;
    };
    for (let i = 0; i < sample.length; i += 4) {
      const r = sample[i];
      const g = sample[i + 1];
      const b = sample[i + 2];
      const pixelIndex = i / 4;
      const x = pixelIndex % canvas.width;
      const y = Math.floor(pixelIndex / canvas.width);
      const luma = 0.2126 * r + 0.7152 * g + 0.0722 * b;
      rowLuma[y] += luma;
      if (r > 20 || g > 20 || b > 20) {
        litPixels++;
        minX = Math.min(minX, x);
        minY = Math.min(minY, y);
        maxX = Math.max(maxX, x);
        maxY = Math.max(maxY, y);
      }
      if (Math.max(r, g, b) - Math.min(r, g, b) > 40) coloredPixels++;
      if (r > 80 && r > g * 1.5 && r > b * 1.5) addChannel("red", x, y);
      if (g > 80 && g > r * 1.5 && g > b * 1.5) addChannel("green", x, y);
      if (b > 80 && b > r * 1.5 && b > g * 1.5) addChannel("blue", x, y);
    }
    const rowMean = rowLuma.map((sum) => sum / canvas.width);
    const even = rowMean.filter((_, index) => index % 2 === 0);
    const odd = rowMean.filter((_, index) => index % 2 === 1);
    const mean = (values: number[]) => values.reduce((sum, value) => sum + value, 0) / Math.max(1, values.length);
    const meanLuma = Math.max(1, mean(rowMean));
    const adjacentRowContrast = rowMean.slice(1)
      .reduce((sum, value, index) => sum + Math.abs(value - rowMean[index]), 0)
      / Math.max(1, rowMean.length - 1)
      / meanLuma;
    const scanlineAlternation = Math.abs(mean(even) - mean(odd)) / meanLuma;

    const channelShiftScore = (aOffset: 0 | 1 | 2, bOffset: 0 | 1 | 2, shift: number) => {
      let overlap = 0;
      let aTotal = 0;
      let bTotal = 0;
      for (let y = 0; y < canvas.height; y++) {
        for (let x = 0; x < canvas.width - shift; x++) {
          const ai = (y * canvas.width + x) * 4 + aOffset;
          const bi = (y * canvas.width + x + shift) * 4 + bOffset;
          const a = sample[ai];
          const b = sample[bi];
          overlap += Math.min(a, b);
          aTotal += a;
          bTotal += b;
        }
      }
      return overlap / Math.max(1, Math.sqrt(aTotal * bTotal));
    };
    let rgShift = 0;
    let rgScore = 0;
    let rbShift = 0;
    let rbScore = 0;
    for (let shift = 1; shift <= Math.min(80, canvas.width - 1); shift++) {
      const rg = channelShiftScore(0, 1, shift);
      if (rg > rgScore) {
        rgScore = rg;
        rgShift = shift;
      }
      const rb = channelShiftScore(0, 2, shift);
      if (rb > rbScore) {
        rbScore = rb;
        rbShift = shift;
      }
    }

    const channelBoxes = Object.fromEntries(Object.entries(channels).map(([name, box]) => [
      name,
      box.maxX >= 0 ? {
        minX: box.minX,
        minY: box.minY,
        maxX: box.maxX,
        maxY: box.maxY,
        count: box.count,
        meanX: box.sumX / box.count,
        width: box.maxX - box.minX + 1,
        height: box.maxY - box.minY + 1,
      } : null,
    ]));
    return {
      backingStore: { width: canvas.width, height: canvas.height },
      canvasRect: {
        x: canvasRect.x,
        y: canvasRect.y,
        width: canvasRect.width,
        height: canvasRect.height,
      },
      stageRect: {
        width: stageRect.width,
        height: stageRect.height,
      },
      litPixels,
      coloredPixels,
      litBounds: maxX >= 0 ? {
        minX,
        minY,
        maxX,
        maxY,
        width: maxX - minX + 1,
        height: maxY - minY + 1,
      } : null,
      channelBoxes,
      widthFill: canvasRect.width / stageRect.width,
      heightFill: canvasRect.height / stageRect.height,
      scanlineAlternation,
      adjacentRowContrast,
      strongestChannelShift: { rgShift, rgScore, rbShift, rbScore },
    };
  });

  const metricsJson = JSON.stringify(metrics, null, 2);
  const canvasPng = Buffer.from(
    await canvas.evaluate((node: HTMLCanvasElement) => node.toDataURL("image/png").split(",")[1]),
    "base64",
  );
  const pagePng = await page.screenshot({ fullPage: true });
  writeFileSync(testInfo.outputPath(`${label}-metrics.json`), metricsJson);
  writeFileSync(testInfo.outputPath(`${label}-canvas.png`), canvasPng);
  writeFileSync(testInfo.outputPath(`${label}-page.png`), pagePng);

  await test.info().attach(`${label}-metrics.json`, {
    body: metricsJson,
    contentType: "application/json",
  });
  await test.info().attach(`${label}-canvas.png`, {
    body: canvasPng,
    contentType: "image/png",
  });
  await test.info().attach(`${label}-page.png`, {
    body: pagePng,
    contentType: "image/png",
  });

  return metrics;
}

test("BYTEPATH reaches gameplay on the native KMS/GLES renderer", async ({ browserName, page }, testInfo: TestInfo) => {
  test.skip(browserName !== "chromium", "KMS WebGL2 OffscreenCanvas rendering is Chromium-only in CI");
  test.setTimeout(360_000);

  await page.setViewportSize({ width: 2048, height: 1152 });
  await gotoOrSkip(page, `/?demo=bytepath&verify=${Date.now()}`);

  const guideClose = page.getByRole("button", { name: "Close demo guide" });
  if (await guideClose.count()) {
    await guideClose.first().click();
  }

  const canvas = page.locator("canvas.kmodeset-canvas").first();
  await expect(canvas).toBeVisible({ timeout: 180_000 });

  await expect
    .poll(() => canvas.evaluate((node: HTMLCanvasElement) => ({
      width: node.width,
      height: node.height,
    })), { timeout: 180_000, intervals: [1_000, 2_000, 5_000] })
    .toEqual({ width: 480, height: 270 });

  const box = await canvas.boundingBox();
  expect(box, "KMS canvas bounding box").not.toBeNull();
  await page.mouse.click(box!.x + box!.width / 2, box!.y + box!.height / 2);

  // BYTEPATH starts with an in-game simulated boot sequence. Drive the actual
  // player path instead of sending input during the boot text.
  await page.waitForTimeout(35_000);
  for (const key of ["s", "t", "a", "r", "t"]) {
    await page.keyboard.down(key);
    await page.waitForTimeout(80);
    await page.keyboard.up(key);
    await page.waitForTimeout(80);
  }
  await page.keyboard.press("Enter");
  await page.waitForTimeout(10_000);
  const metrics10s = await captureKmsSnapshot(page, canvas, "bytepath-gameplay-10s", testInfo);

  await page.keyboard.down("w");
  await page.keyboard.down("d");
  await page.waitForTimeout(4_000);
  await page.keyboard.up("w");
  await page.keyboard.up("d");
  await page.waitForTimeout(8_000);
  const metrics22s = await captureKmsSnapshot(page, canvas, "bytepath-gameplay-22s", testInfo);

  const internalsButton = page.getByRole("button", { name: /internals|system internals/i }).first();
  if (await internalsButton.count()) {
    await internalsButton.click();
    await page.waitForTimeout(250);
  }
  const syslog = (await page.locator(".ksys-line").allTextContents()).join("\n");
  writeFileSync(testInfo.outputPath("bytepath-syslog.txt"), syslog);
  await test.info().attach("bytepath-syslog.txt", {
    body: syslog,
    contentType: "text/plain",
  });

  expect(metrics10s.litPixels, "BYTEPATH should render nonblank gameplay pixels").toBeGreaterThan(2_000);
  expect(metrics10s.coloredPixels, "BYTEPATH should render colored gameplay/HUD pixels").toBeGreaterThan(500);
  expect(metrics10s.litBounds?.width ?? 0, "BYTEPATH gameplay should span the game surface").toBeGreaterThan(300);
  expect(metrics10s.litBounds?.height ?? 0, "BYTEPATH gameplay should span the game surface").toBeGreaterThan(180);
  expect(metrics22s.litPixels, "BYTEPATH should still be rendering after sustained gameplay input").toBeGreaterThan(2_000);

  expect(metrics10s.widthFill, "BYTEPATH KMS canvas should fill the available pane width").toBeGreaterThan(0.98);
  expect(metrics10s.heightFill, "BYTEPATH KMS canvas should fill the available pane height").toBeGreaterThan(0.98);
  expect(metrics10s.canvasRect.width * metrics10s.canvasRect.height, "KMS canvas should not be CSS scale-capped")
    .toBeGreaterThan(metrics10s.backingStore.width * metrics10s.backingStore.height * 8);
  expect(metrics10s.adjacentRowContrast, "BYTEPATH final shader pass should leave visible row-level distortion/scanline structure")
    .toBeGreaterThan(0.05);
  expect(metrics10s.strongestChannelShift.rgShift, "BYTEPATH RGB shader map should not quantize neutral gray into a large red/green offset")
    .toBeLessThanOrEqual(20);
  expect(metrics10s.strongestChannelShift.rbShift, "BYTEPATH RGB shader map should not quantize neutral gray into a large red/blue offset")
    .toBeLessThanOrEqual(40);
  expect(metrics22s.strongestChannelShift.rgShift, "BYTEPATH sustained gameplay red/green offset should stay in the intended glitch range")
    .toBeLessThanOrEqual(20);
  expect(metrics22s.strongestChannelShift.rbShift, "BYTEPATH sustained gameplay red/blue offset should stay in the intended glitch range")
    .toBeLessThanOrEqual(40);
});
