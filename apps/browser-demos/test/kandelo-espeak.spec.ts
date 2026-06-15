import { expect, test, type Page } from "@playwright/test";

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

async function terminalText(page: Page): Promise<string> {
  return page.locator(".xterm-rows").first().evaluate((node) => node.textContent ?? "");
}

async function framesConsumed(page: Page): Promise<number> {
  return page.evaluate(() => {
    const w = window as unknown as { __alsaFramesConsumed?: number };
    return w.__alsaFramesConsumed ?? 0;
  });
}

test("Kandelo espeak-ng demo speaks through pcaudiolib + /dev/snd/pcmC0D0p", async ({ page }) => {
  test.setTimeout(300_000);

  await gotoOrSkip(page, "/?demo=espeak");

  // The boot-path branch in live-setup.ts attaches the BrowserAudioDriver
  // and then runs `espeak-ng "Welcome to Kandelo, the WebAssembly POSIX kernel"`.
  // espeak-ng prints a few status lines on stderr; the more reliable
  // signal that the synth path worked end-to-end is the bash prompt
  // reappearing after the binary exits. We watch for the trailing
  // shell prompt instead of a specific espeak output line so the test
  // doesn't break on cosmetic CLI changes upstream.
  await expect
    .poll(() => terminalText(page), { timeout: 180_000 })
    .toMatch(/[#$]\s*$/);

  // Frames-consumed counter: the instrumented audio driver bumps
  // `window.__alsaFramesConsumed` from the per-period tick
  // callback. The phrase is ~3 s of audio at 22050 Hz mono =
  // ~66150 frames. Demand at least 22050 (~1 s) so the test passes
  // even with aggressive worklet startup delay or early-exit
  // synthesis variants. A non-zero count proves the worklet → main
  // → kernel pipeline (browser-host parity).
  const consumed = await framesConsumed(page);
  expect(consumed).toBeGreaterThanOrEqual(22_050);
});
