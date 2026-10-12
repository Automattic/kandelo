import { expect, test } from "@playwright/test";
import { gotoInPreview, gotoMachine, machineAppPrefix } from "./support/kandelo-machine";

test("WordPress on FrankenPHP serves the preinstalled site, admin, and site editor", async ({ page, browserName }) => {
  test.setTimeout(420_000);
  test.skip(browserName === "firefox", "FrankenPHP WordPress editor gate uses Chromium and WebKit");
  test.skip(process.env.KANDELO_WORDPRESS_FRANKENPHP_UI_TESTS !== "1", "Build and project WordPress, then set KANDELO_WORDPRESS_FRANKENPHP_UI_TESTS=1");
  await gotoMachine(page, "wordpress-frankenphp");

  const frame = page.frameLocator('iframe[title="WordPress on FrankenPHP"]');
  await Promise.race([
    expect(frame.locator("body")).toContainText("WordPress on Kandelo", { timeout: 240_000 }),
    page.locator('.kdock-status-text[data-status="error"]')
      .waitFor({ state: "attached", timeout: 240_000 })
      .then(async () => {
        const syslog = await page.locator(".ksys-line").allTextContents();
        throw new Error(`WordPress machine failed: ${syslog.slice(-20).join("\n")}`);
      }),
  ]);
  await expect(frame.locator("form#setup, form#language-chooser")).toHaveCount(0);

  if (!(await page.locator("aside.kdemo").count())) {
    await page.getByRole("button", { name: "Demo guide" }).click();
  }
  await page.getByRole("button", { name: /Log in as admin/i }).click();
  await expect(frame.locator("#wpadminbar, #adminmenu, body.wp-admin").first())
    .toBeVisible({ timeout: 120_000 });

  const appPrefix = await machineAppPrefix(page, "WordPress on FrankenPHP");
  await gotoInPreview(frame, appPrefix, "wp-admin/site-editor.php");
  const editorLoaded = await Promise.race([
    expect(frame.locator("iframe").first()).toBeVisible({ timeout: 60_000 }).then(() => true, () => false),
    page.locator('.kdock-status-text[data-status="error"]')
      .waitFor({ state: "attached", timeout: 60_000 })
      .then(async () => {
        const syslog = await page.locator(".ksys-line").allTextContents();
        throw new Error(`WordPress editor failed: ${syslog.slice(-40).join("\n")}`);
      }),
  ]);
  if (editorLoaded) await page.waitForTimeout(20_000);
  const editorResult = await page.evaluate(async (prefix) => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30_000);
    try {
      const response = await fetch(`${prefix}wp-admin/site-editor.php?health=${Date.now()}`, {
        cache: "no-store",
        signal: controller.signal,
      });
      const body = await response.text();
      return { status: response.status, body: body.slice(-5000) };
    } finally {
      clearTimeout(timeout);
    }
  }, appPrefix);
  let serviceLog = "";
  let visibleSyslog = "";
  let processes = "";
  if (editorResult.status !== 200) {
    await page.getByRole("button", { name: "Internals" }).click();
    visibleSyslog = (await page.locator(".ksys-line").allTextContents()).slice(-100).join("\n");
    await page.getByRole("tab", { name: "Procs" }).click();
    processes = (await page.locator(".ktable").allTextContents()).join("\n");
    await page.getByRole("tab", { name: "VFS" }).click();
    for (const segment of ["var", "log"]) {
      await page.locator(".ktable tr", { has: page.locator("td", { hasText: new RegExp(`^${segment}/$`) }) }).click();
    }
    await page.locator(".ktable tr", { has: page.locator("td", { hasText: "frankenphp-classic.log" }) }).click();
    serviceLog = await page.locator(".kinternals-surface pre").last().textContent() ?? "";
  }
  expect(editorLoaded, `url=${page.url()}\n${visibleSyslog}\n${processes}\n${serviceLog.slice(-10000)}`).toBe(true);
  expect(editorResult.status, `url=${page.url()}\n${editorResult.body}\n${visibleSyslog}\n${processes}\n${serviceLog.slice(-10000)}`).toBe(200);

  await expect(page.locator('.kdock-status-text[data-status="error"]')).toHaveCount(0);
});
