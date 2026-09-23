import { expect, test } from "@playwright/test";

const fixtureModuleUrl = "/test/fixtures/boot-progress-fixture.ts";
const fixturePageUrl = "/test/fixtures/boot-progress-fixture.html";

const bar = "[role=progressbar]";

test.beforeEach(async ({ page }) => {
  await page.goto(fixturePageUrl);
  await page.evaluate(async (moduleUrl) => {
    const { mountBootScreen } = await import(moduleUrl);
    const root = document.createElement("div");
    root.style.width = "800px";
    root.style.height = "500px";
    document.body.append(root);
    (window as unknown as { fixture: unknown }).fixture = mountBootScreen(root);
  }, fixtureModuleUrl);
});

/** Drive the host-owned boot progress channel from the page. */
async function setProgress(
  page: import("@playwright/test").Page,
  progress: unknown,
): Promise<void> {
  await page.evaluate((value) => {
    (window as unknown as {
      fixture: { setProgress(v: unknown): void };
    }).fixture.setProgress(value);
  }, progress);
}

test("shows no progress bar before the image load starts", async ({ page }) => {
  await expect(page.locator(bar)).toHaveCount(0);
});

test("reports a real percentage while the image loads", async ({ page }) => {
  await setProgress(page, {
    phase: "image",
    label: "wordpress-sqlite.vfs.zst",
    loadedBytes: 1024 * 1024,
    totalBytes: 4 * 1024 * 1024,
    status: "loading",
  });

  await expect(page.locator(bar)).toHaveAttribute("aria-valuenow", "25");
  await expect(page.getByText("loading wordpress-sqlite.vfs.zst"))
    .toBeVisible();
  await expect(page.getByText("1.0 MiB / 4.0 MiB")).toBeVisible();
});

test("names the image being loaded instead of a placeholder digest", async ({ page }) => {
  await setProgress(page, {
    phase: "image",
    label: "browser-main-shell.vfs.zst",
    loadedBytes: 512,
    totalBytes: 2048,
    status: "loading",
  });

  await expect(page.getByText("image: browser-main-shell.vfs.zst"))
    .toBeVisible();
});

test("falls back to an indeterminate bar when no total is known", async ({ page }) => {
  // A user-supplied ?vfs= image behind a compressing CDN has no trustworthy
  // denominator; the bar must not invent one.
  await setProgress(page, {
    phase: "image",
    label: "custom.vfs.zst",
    loadedBytes: 4096,
    status: "loading",
  });

  await expect(page.locator(bar)).not.toHaveAttribute("aria-valuenow", /.*/);
  await expect(page.locator(bar)).toHaveClass(/indeterminate/);
});

test("surfaces a failed image load", async ({ page }) => {
  await setProgress(page, {
    phase: "image",
    label: "custom.vfs.zst",
    loadedBytes: 0,
    status: "error",
    error: "custom.vfs.zst returned HTTP 503",
  });

  await expect(page.getByText("custom.vfs.zst returned HTTP 503"))
    .toBeVisible();
});

test("removes the bar once the machine is running", async ({ page }) => {
  await setProgress(page, {
    phase: "image",
    label: "shell.vfs.zst",
    loadedBytes: 2048,
    totalBytes: 2048,
    status: "complete",
  });
  await expect(page.locator(bar)).toBeVisible();

  await page.evaluate(() => {
    (window as unknown as { fixture: { finishBoot(): void } }).fixture
      .finishBoot();
  });

  await expect(page.locator(bar)).toHaveCount(0);
});
