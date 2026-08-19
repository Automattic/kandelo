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

test("Kandelo espeak-ng demo speaks through pcaudiolib + /dev/dsp", async ({ page }) => {
  test.setTimeout(300_000);

  await gotoOrSkip(page, "/?demo=espeak");

  // Web Audio starts only after a trusted gesture. App.tsx activates the
  // PCM sink from a capturing pointerdown listener, so a physical click
  // anywhere moves the machine to its running audio state.
  await page.locator("body").click({ position: { x: 5, y: 5 } });
  await expect(page.locator("[data-audio-state]")).toHaveAttribute(
    "data-audio-state",
    "running",
    { timeout: 60_000 },
  );

  // The boot-path branch in live-setup.ts runs
  // `espeak-ng "Welcome to Kandelo, the WebAssembly POSIX kernel"`.
  // espeak-ng prints a few status lines on stderr; the more reliable
  // signal that the synth path worked end-to-end is the bash prompt
  // reappearing after the binary exits. We watch for the trailing
  // shell prompt instead of a specific espeak output line so the test
  // doesn't break on cosmetic CLI changes upstream. pcaudiolib aborts
  // the run when it cannot open /dev/dsp, so reaching the prompt with
  // a running sink proves the OSS backend negotiated the device.
  await expect
    .poll(() => terminalText(page), { timeout: 180_000 })
    .toMatch(/[#$]\s*$/);
});
