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

async function openSurface(page: Page, label: "Internals" | "Terminal") {
  const internals = page.getByRole("button", { name: "Internals", exact: true });
  await internals.waitFor({ state: "visible", timeout: 30_000 });
  const open = (await internals.getAttribute("aria-pressed")) === "true";
  if (open !== (label === "Internals")) await internals.click();
  if (label !== "Internals") {
    const view = page
      .getByLabel("Computer views")
      .getByRole("button", { name: label, exact: true });
    if ((await view.getAttribute("aria-current")) !== "true") await view.click();
  }
}

async function syslogText(page: Page): Promise<string> {
  const lines = await page.locator(".ksys-line").allInnerTexts();
  return lines.join("\n");
}

async function terminalText(page: Page): Promise<string> {
  if ((await page.locator(".xterm-rows").count()) === 0) return "";
  const rows = await page.locator(".xterm-rows").first().locator(":scope > div").allInnerTexts();
  return rows.join("\n");
}

/**
 * Browser gate for the wgpu-window machine: wlcompositor with wgpu-window,
 * a winit + wgpu program, as its only client. Its window reaches the compositor
 * over xdg-shell, and wgpu's GLES backend renders through libEGL and
 * libGLESv2 into a libwayland-egl buffer on the compositor's WebGL2
 * context. The program prints the adapter wgpu picked, then WGPU WINDOW OK
 * after its 60th frame is presented.
 */
test("Kandelo wgpu-window renders 60 frames through wgpu's GLES backend", async ({ page }) => {
  test.setTimeout(300_000);

  await gotoOrSkip(page, "/?profile=wgpu-window");

  await openSurface(page, "Internals");
  await expect
    .poll(() => syslogText(page), { timeout: 180_000 })
    .toMatch(/running \/usr\/local\/bin\/wldesktop \/usr\/local\/bin\/wgpu-window/);
  expect(await syslogText(page)).not.toMatch(/configured command failed/);

  await openSurface(page, "Terminal");
  await expect
    .poll(() => terminalText(page), { timeout: 180_000 })
    .toMatch(/WGPU WINDOW OK|panicked|wldesktop: /);
  const text = await terminalText(page);
  expect(text).not.toMatch(/panicked|wldesktop: /);
  expect(text).toMatch(/CLIENT_CONNECTED count=1/);
  expect(text).toMatch(/adapter: .*\(Gl, OpenGL ES 3\.0/);
  expect(text).toMatch(/WGPU WINDOW OK/);
});
