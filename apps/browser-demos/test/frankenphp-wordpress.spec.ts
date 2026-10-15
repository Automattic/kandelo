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
      try {
        await page.getByRole("button", { name: "Internals" }).click({ timeout: 5_000 });
        visibleSyslog = (await page.locator(".ksys-line").allTextContents()).slice(-100).join("\n");
        await page.getByRole("tab", { name: "Procs" }).click({ timeout: 5_000 });
        processes = (await page.locator(".ktable").allTextContents()).join("\n");
        await page.getByRole("tab", { name: "VFS" }).click({ timeout: 5_000 });
        for (const segment of ["var", "log"]) {
          await page.locator(".ktable tr", { has: page.locator("td", { hasText: new RegExp(`^${segment}/$`) }) }).click({ timeout: 5_000 });
        }
        await page.locator(".ktable tr", { has: page.locator("td", { hasText: demo.serviceLog }) }).click({ timeout: 5_000 });
        serviceLog = await page.locator(".kinternals-surface pre").last().textContent() ?? "";
      } catch (error) {
        serviceLog = `Service-log inspection unavailable: ${String(error)}`;
      }
    }
    const dockStatus = (await page.locator(".kdock-status-text").allTextContents()).join("\n");
    expect(editorLoaded, `url=${page.url()}\n${visibleSyslog}\n${processes}\n${serviceLog.slice(-10000)}`).toBe(true);
    expect(editorResult.status, `url=${page.url()} samples=${samples.join(",")} dock=${dockStatus}\n${editorResult.body}\n${visibleSyslog}\n${processes}\n${serviceLog.slice(-10000)}\n${browserDiagnostics.slice(-100).join("\n")}`).toBe(200);

    await expect(page.locator('.kdock-status-text[data-status="error"]')).toHaveCount(0);
  });

  test(`${demo.title} persists authenticated post edits`, async ({ page }) => {
    test.setTimeout(300_000);
    test.skip(process.env.KANDELO_WORDPRESS_FRANKENPHP_UI_TESTS !== "1", "Build and project WordPress, then set KANDELO_WORDPRESS_FRANKENPHP_UI_TESTS=1");
    await gotoMachine(page, demo.profile);
    const frame = page.frameLocator(`iframe[title="${demo.title}"]`);
    await expect(frame.locator("body")).toContainText("WordPress on Kandelo", { timeout: 240_000 });
    if (!(await page.locator("aside.kdemo").count())) {
      await page.getByRole("button", { name: "Demo guide" }).click();
    }
    await page.getByRole("button", { name: /Log in as admin/i }).click();
    await expect(frame.locator("#wpadminbar, #adminmenu, body.wp-admin").first())
      .toBeVisible({ timeout: 120_000 });
    await expect.poll(async () => {
      try {
        return await frame.locator("body").evaluate(() =>
          /\/wp-admin\/(?:index\.php)?$/.test(location.pathname) && document.readyState === "complete");
      } catch {
        return false;
      }
    }, { timeout: 120_000 }).toBe(true);

    const appPrefix = await machineAppPrefix(page, demo.title);
    const result = await frame.locator("body").evaluate(async (_body, prefix) => {
      const settings = (window as Window & {
        wpApiSettings?: { root: string; nonce: string };
      }).wpApiSettings;
      if (!settings?.root || !settings.nonce) throw new Error("WordPress REST settings are missing");
      const headers = { "Content-Type": "application/json", "X-WP-Nonce": settings.nonce };
      const fetchChecked = async (url: string, init?: RequestInit): Promise<Response> => {
        try {
          return await fetch(url, init);
        } catch (error) {
          throw new Error(`Fetch ${url} from ${location.href} failed: ${String(error)}`);
        }
      };
      const createUrl = `${settings.root}wp/v2/posts`;
      const createResponse = await fetchChecked(createUrl, {
        method: "POST",
        headers,
        body: JSON.stringify({ title: "Kandelo edit probe", content: "<p>First version</p>", status: "publish" }),
      });
      const createBody = await createResponse.text();
      if (createResponse.status !== 201) throw new Error(`Post create failed: ${createResponse.status} ${createBody.slice(0, 500)}`);
      const postId = (JSON.parse(createBody) as { id: number }).id;
      if (!Number.isSafeInteger(postId) || postId < 1) throw new Error(`Invalid post ID: ${postId}`);

      const firstResponse = await fetchChecked(`${prefix}?p=${postId}`, { cache: "no-store" });
      const firstBody = await firstResponse.text();
      const updateResponse = await fetchChecked(`${settings.root}wp/v2/posts/${postId}`, {
        method: "POST",
        headers,
        body: JSON.stringify({ content: "<p>Updated version</p>" }),
      });
      const updateBody = await updateResponse.text();
      if (updateResponse.status !== 200) throw new Error(`Post update failed: ${updateResponse.status} ${updateBody.slice(0, 500)}`);
      const secondResponse = await fetchChecked(`${prefix}?p=${postId}`, { cache: "no-store" });
      const secondBody = await secondResponse.text();
      const deleteUrl = new URL(`${settings.root}wp/v2/posts/${postId}`);
      deleteUrl.searchParams.set("force", "true");
      const deleteResponse = await fetchChecked(deleteUrl.href, { method: "DELETE", headers });
      const deleteBody = await deleteResponse.text();
      return {
        firstStatus: firstResponse.status,
        firstContent: firstBody.includes("First version"),
        updateStatus: updateResponse.status,
        secondStatus: secondResponse.status,
        secondContent: secondBody.includes("Updated version"),
        deleteStatus: deleteResponse.status,
        deleted: (JSON.parse(deleteBody) as { deleted?: boolean }).deleted,
      };
    }, appPrefix);
    expect(result).toEqual({
      firstStatus: 200,
      firstContent: true,
      updateStatus: 200,
      secondStatus: 200,
      secondContent: true,
      deleteStatus: 200,
      deleted: true,
    });
    await expect(page.locator('.kdock-status-text[data-status="error"]')).toHaveCount(0);
  });
}
