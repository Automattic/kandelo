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

async function openSurface(page: Page, label: string) {
  const btn = page.locator("button.kmachine-switch-btn", { hasText: label });
  await btn.waitFor({ state: "visible", timeout: 30_000 });
  await btn.click();
}

async function terminalText(page: Page): Promise<string> {
  const count = await page.locator(".xterm-rows").count();
  if (count === 0) return "";
  return page.locator(".xterm-rows").first().evaluate((n) => n.textContent ?? "");
}

async function syslogText(page: Page): Promise<string> {
  const lines = await page.locator(".ksys-line").allInnerTexts();
  return lines.join("\n");
}

test("Kandelo sdl2 demo boots, runs, exits clean", async ({ page }) => {
  test.setTimeout(120_000);

  await gotoOrSkip(page, "/?demo=sdl2");

  await openSurface(page, "Internals");
  await expect
    .poll(() => syslogText(page), { timeout: 90_000 })
    .toMatch(/running sdl2/);

  // Capture the KMSDRM canvas mid-run — the demo exits after 5 s and
  // the Demo surface is hidden once the process has reaped, so these
  // gates have to fire before "sdl2 exited" appears. Guards against a
  // silent shader-compile / viewport-zero / framebuffer failure that
  // would still print "OK frames=… exit=timeout" but leave the canvas
  // blank.
  await openSurface(page, "Demo");
  const canvas = page.locator(".kmachine-primary-slot:not(.is-hidden) canvas").first();
  await expect(canvas).toBeVisible({ timeout: 10_000 });
  // Sample the canvas across the run and assert (a) every frame
  // encodes well above the blank-canvas baseline (1920×1080 dark-gray
  // PNG ≈ 3.2 KiB) and (b) the byteLengths SPAN a meaningful range —
  // the fragment shader oscillates color via sin(u_t) (period ≈
  // π/2 s) and the vertex shader rotates the quad continuously, so
  // PNG-compressed frame sizes from a working render vary by a few
  // hundred bytes over a 3 s window. A blank-canvas regression (no
  // shader bound, zero viewport, GL submits dropped, …) yields five
  // identical PNGs and fails the spread gate. The single byteLength
  // gate the predecessor session shipped (> 2 000) was a false
  // positive: a uninitialised canvas still encodes to ~3 KiB.
  const sizes: number[] = [];
  for (let i = 0; i < 5; i++) {
    await page.waitForTimeout(600);
    const shot = await canvas.screenshot();
    sizes.push(shot.byteLength);
  }
  for (const sz of sizes) {
    expect(sz, `canvas frame too small: ${sizes.join(",")}`).toBeGreaterThan(3_500);
  }
  const spread = Math.max(...sizes) - Math.min(...sizes);
  expect(spread, `canvas not animating: sizes=${sizes.join(",")}`).toBeGreaterThan(400);

  await openSurface(page, "Internals");
  await expect
    .poll(() => syslogText(page), { timeout: 30_000 })
    .toMatch(/sdl2 exited/);
  expect(await syslogText(page), "sdl2 reported failure")
    .not.toMatch(/sdl2 failed/);

  await openSurface(page, "Terminal");
  await expect
    .poll(() => terminalText(page), { timeout: 30_000 })
    .toMatch(/sdl2: OK frames=\d+ elapsed=\d+ ms exit=timeout/);
});
