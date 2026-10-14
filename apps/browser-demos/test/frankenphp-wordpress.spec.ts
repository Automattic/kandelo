import { expect, test } from "@playwright/test";
import { gotoInPreview, gotoMachine, machineAppPrefix } from "./support/kandelo-machine";

const soakSeconds = Number(process.env.KANDELO_FRANKENPHP_SOAK_SECONDS ?? "20");

for (const demo of [
  { profile: "wordpress-frankenphp", title: "WordPress on FrankenPHP", serviceLog: "frankenphp-classic.log" },
  { profile: "wordpress-frankenphp-caddy", title: "WordPress on FrankenPHP + Caddy", serviceLog: "frankenphp-caddy.log" },
] as const) {
  test(`${demo.title} serves the preinstalled site, admin, and site editor`, async ({ page, context }) => {
    test.setTimeout(Math.max(420_000, (soakSeconds + 300) * 1000));
    test.skip(process.env.KANDELO_WORDPRESS_FRANKENPHP_UI_TESTS !== "1", "Build and project WordPress, then set KANDELO_WORDPRESS_FRANKENPHP_UI_TESTS=1");
    const browserDiagnostics: string[] = [];
    context.on("console", (message) => browserDiagnostics.push(`console ${message.type()}: ${message.text()}`));
    page.on("pageerror", (error) => browserDiagnostics.push(`pageerror: ${error.message}`));
    page.on("crash", () => browserDiagnostics.push("page crashed"));
    await gotoMachine(page, demo.profile);
    if (browserDiagnostics.some((diagnostic) => diagnostic.startsWith("pageerror:"))) {
      throw new Error(`WordPress page failed to load: ${browserDiagnostics.join("\n")}`);
    }

    const frame = page.frameLocator(`iframe[title="${demo.title}"]`);
    try {
      await Promise.race([
        expect(frame.locator("body")).toContainText("WordPress on Kandelo", { timeout: 240_000 }),
        page.locator('.kdock-status-text[data-status="error"]')
          .waitFor({ state: "attached", timeout: 240_000 })
          .then(async () => {
            const syslog = await page.locator(".ksys-line").allTextContents();
            throw new Error(`WordPress machine failed: ${syslog.slice(-20).join("\n")}`);
          }),
        page.locator("vite-error-overlay").waitFor({ state: "attached", timeout: 240_000 })
          .then(() => { throw new Error("Vite error overlay appeared"); }),
      ]);
    } catch (error) {
      throw new Error(`WordPress page failed at ${page.url()}: ${String(error)}\n${browserDiagnostics.slice(-30).join("\n")}`);
    }
    await expect(frame.locator("form#setup, form#language-chooser")).toHaveCount(0);

    if (!(await page.locator("aside.kdemo").count())) {
      await page.getByRole("button", { name: "Demo guide" }).click();
    }
    await page.getByRole("button", { name: /Log in as admin/i }).click();
    await expect(frame.locator("#wpadminbar, #adminmenu, body.wp-admin").first())
      .toBeVisible({ timeout: 120_000 });

    const appPrefix = await machineAppPrefix(page, demo.title);
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
    let editorResult = { status: 0, body: "" };
    const samples: string[] = [];
    for (let elapsed = 0; elapsed < soakSeconds; elapsed += 10) {
      await page.waitForTimeout(10_000);
      editorResult = await page.evaluate(async (prefix) => {
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
      samples.push(`${elapsed + 10}s=${editorResult.status}`);
      if (editorResult.status !== 200) break;
    }
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
      await page.locator(".ktable tr", { has: page.locator("td", { hasText: demo.serviceLog }) }).click();
      serviceLog = await page.locator(".kinternals-surface pre").last().textContent() ?? "";
    }
    expect(editorLoaded, `url=${page.url()}\n${visibleSyslog}\n${processes}\n${serviceLog.slice(-10000)}`).toBe(true);
    expect(editorResult.status, `url=${page.url()} samples=${samples.join(",")}\n${editorResult.body}\n${visibleSyslog}\n${processes}\n${serviceLog.slice(-10000)}\n${browserDiagnostics.slice(-100).join("\n")}`).toBe(200);

    await expect(page.locator('.kdock-status-text[data-status="error"]')).toHaveCount(0);
  });
}
