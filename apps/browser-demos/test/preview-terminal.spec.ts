import { expect, test } from "@playwright/test";
import type { mountPreviewFixture } from "./fixtures/preview-terminal-fixture";

declare global { interface Window { previewFixture: ReturnType<typeof mountPreviewFixture>; } }

test.beforeEach(async ({ page }) => {
  await page.goto("/test/fixtures/preview-terminal-fixture.html");
  await page.evaluate(async () => {
    const { mountPreviewFixture } = await import("/test/fixtures/preview-terminal-fixture.tsx");
    const container = document.createElement("div");
    container.style.height = "600px";
    document.body.append(container);
    window.previewFixture = mountPreviewFixture(container);
  });
  await expect(page.locator(".xterm-rows")).toContainText("HISTORY_END");
});

test("only live versioned preview requests run, never scrollback replay or ordinary text", async ({ page }) => {
  expect(await page.evaluate(() => window.previewFixture.requests)).toEqual([]);
  await page.evaluate(() => window.previewFixture.send("kandelo-preview http://localhost:3000/plain\r\nPLAIN_END\r\n"));
  await expect(page.locator(".xterm-rows")).toContainText("PLAIN_END");
  expect(await page.evaluate(() => window.previewFixture.requests)).toEqual([]);
  await page.evaluate(() => window.previewFixture.send("\x1b]777;kandelo-preview;1;http://localhost:3000/live\x07LIVE_END\r\n"));
  await expect.poll(() => page.evaluate(() => window.previewFixture.requests)).toEqual([{ hostname: "localhost", port: 3000, path: "/live" }]);
  await page.evaluate(() => window.previewFixture.remount());
  await expect(page.locator(".xterm-rows")).toContainText("LIVE_END");
  expect(await page.evaluate(() => window.previewFixture.requests)).toHaveLength(1);
  await page.evaluate(() => window.previewFixture.send("\x1b]777;kandelo-preview;1;http://outside.example/\x07"));
  await expect.poll(() => page.evaluate(() => window.previewFixture.errors)).toContain("Preview failed: Choose localhost, host, or a connected Kandelo peer (peer-1 through peer-254)");
  expect(await page.evaluate(() => window.previewFixture.requests)).toHaveLength(1);
});

test("structured progress updates in place and failure retires its bar without losing raw records", async ({ page }) => {
  const line = { t: 0, facility: "image", level: "info", msg: "Checking image", progress: { id: "check-1", label: "Checking image", completed: 20, total: 100, unit: "bytes", status: "loading" } } as const;
  await page.evaluate(line => window.previewFixture.log(line), line);
  const progress = page.getByRole("progressbar", { name: "Checking image", exact: true });
  await expect(progress).toHaveAttribute("value", "20");
  await page.evaluate(line => window.previewFixture.log({ ...line, progress: { ...line.progress, completed: 60 } }), line);
  await expect(progress).toHaveAttribute("value", "60");
  await expect(page.locator(".ksys-line")).toHaveCount(1);
  await page.evaluate(line => window.previewFixture.log({ ...line, level: "err", msg: "Image read failed", progress: { ...line.progress, status: "error" } }), line);
  await expect(progress).toHaveCount(0);
  await expect(page.locator(".ksys-line")).toHaveCount(1);
  await expect(page.locator(".ksys-line")).toContainText("Image read failed");
  await page.getByRole("checkbox", { name: "Show raw log", exact: true }).check();
  await expect(page.locator(".ksys-line")).toHaveCount(3);
  await expect(page.locator(".ksys-line").last()).toContainText("Image read failed");
});
