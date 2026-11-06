import { expect, type Page, type Request } from "@playwright/test";
import { gotoInPreviewViaDock, machineUrl, machineAppPrefix } from "./support/kandelo-machine";
import { clickDockTool } from "./support/dock";
import { test } from "./support/persistent-page";
import { saveWordPressTemplateHeading } from "./support/wordpress-editor";

// WordPress uses OPFS; Playwright's ephemeral WebKit context has no
// backing store. Use the same persistent profile fixture as OPFS tests.

const soakSeconds = Number(process.env.KANDELO_FRANKENPHP_SOAK_SECONDS ?? "20");

async function gotoWordPressMachine(page: Page, profile: string, baseURL: string | undefined) {
  // The gallery's FPM shortcut owns a separate family image. Keep this
  // control on the exact image under test, using its ordinary FPM profile.
  if (!baseURL) throw new Error("WordPress UI tests require a preview base URL");
  const url = new URL(await machineUrl(page, "wordpress-frankenphp-caddy"), baseURL);
  url.searchParams.set("profile", profile);
  await page.goto(url.href, { waitUntil: "domcontentloaded" });
}

test.afterEach(async ({ page }, testInfo) => {
  if (testInfo.status === testInfo.expectedStatus) return;
  const files = testInfo.title.startsWith("WordPress SQLite")
    ? ["php-fpm.log", "nginx.log"]
    : [testInfo.title.includes("+ Caddy") ? "frankenphp-caddy.log" : "frankenphp-classic.log"];
  try {
    const inspector = page.getByRole("dialog", { name: "Internals", exact: true });
    if (!await inspector.isVisible()) await clickDockTool(page, "Internals", { timeout: 2_000 });
    await inspector.getByRole("tab", { name: "VFS" }).click({ timeout: 2_000 });
    for (const segment of ["var", "log"]) {
      await inspector.locator(".ktable tr", {
        has: page.locator("td", { hasText: new RegExp(`^${segment}/$`) }),
      }).click({ timeout: 2_000 });
    }
    for (const file of files) {
      await inspector.locator(".ktable tr", {
        has: page.locator("td", { hasText: file }),
      }).click({ timeout: 2_000 });
      const body = await inspector.locator(".kinternals-surface pre").last().textContent({ timeout: 2_000 });
      await testInfo.attach(file, { body: body ?? "", contentType: "text/plain" });
      // The file inspector leaves the directory listing available.
    }
  } catch (error) {
    await testInfo.attach("guest-log-inspection-error", { body: String(error), contentType: "text/plain" });
  }
});

async function probeWorkerEventLoops(page: Page) {
  return Promise.all(page.workers().map(async worker => ({
    url: worker.url(),
    state: await Promise.race([
      worker.evaluate(() => ({ now: performance.now() }))
        .catch(error => ({ error: String(error) })),
      new Promise(resolve => setTimeout(() => resolve("event-loop probe timed out"), 1000)),
    ]),
  })));
}

for (const demo of [
  { profile: "wordpress-frankenphp", title: "WordPress on FrankenPHP", serviceLog: "frankenphp-classic.log" },
  { profile: "wordpress-frankenphp-caddy", title: "WordPress on FrankenPHP + Caddy", serviceLog: "frankenphp-caddy.log" },
  // The same image's nginx/PHP-FPM profile is a control for browser and VFS load.
  { profile: "wordpress-sqlite", title: "WordPress SQLite", serviceLog: "nginx.log" },
] as const) {
  test(`${demo.title} serves the preinstalled site, admin, and site editor`, async ({ page, context, baseURL }) => {
    test.setTimeout(Math.max(720_000, (soakSeconds + 480) * 1000));
    test.skip(process.env.KANDELO_WORDPRESS_FRANKENPHP_UI_TESTS !== "1", "Build and project WordPress, then set KANDELO_WORDPRESS_FRANKENPHP_UI_TESTS=1");
    const browserDiagnostics: string[] = [];
    const pendingRequests = new Map<Request, number>();
    context.on("console", (message) => browserDiagnostics.push(`console ${message.type()}: ${message.text()}`));
    page.on("pageerror", (error) => browserDiagnostics.push(`pageerror: ${error.message}`));
    page.on("crash", () => browserDiagnostics.push("page crashed"));
    page.on("request", (request) => pendingRequests.set(request, Date.now()));
    page.on("requestfinished", (request) => pendingRequests.delete(request));
    page.on("requestfailed", (request) => {
      pendingRequests.delete(request);
      browserDiagnostics.push(`requestfailed: ${request.method()} ${request.url()} ${request.failure()?.errorText ?? "unknown"}`);
    });
    await gotoWordPressMachine(page, demo.profile, baseURL);
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
        page.getByText("LiveKernelHost setup failed", { exact: true })
          .waitFor({ state: "visible", timeout: 240_000 })
          .then(async () => {
            const detail = await page.getByRole("alert").textContent();
            throw new Error(`WordPress machine setup failed: ${detail}`);
          }),
      ]);
    } catch (error) {
      throw new Error(`WordPress page failed at ${page.url()}: ${String(error)}\n${browserDiagnostics.slice(-30).join("\n")}`);
    }
    await expect(frame.locator("form#setup, form#language-chooser")).toHaveCount(0);
    const initialWorkers = await probeWorkerEventLoops(page);
    await test.info().attach("initial-worker-state", {
      body: JSON.stringify(initialWorkers), contentType: "text/plain",
    });

    await expect(page.getByRole("button", { name: "Shortcuts", exact: true })).toBeVisible({ timeout: 30_000 });
    await page.getByRole("button", { name: "Shortcuts", exact: true }).click();
    await page.getByRole("dialog", { name: "Shortcuts", exact: true }).getByRole("button", { name: /^Log in as admin\b/ }).click();
    await expect(frame.locator("#wpadminbar, #adminmenu, body.wp-admin").first())
      .toBeVisible({ timeout: 120_000 });

    // The login action can dismiss the dock popup when it selects the web
    // view. Close it if it remains open, then require the unobstructed view.
    const shortcuts = page.getByRole("dialog", { name: "Shortcuts", exact: true });
    if (await shortcuts.isVisible()) {
      await shortcuts.getByRole("button", { name: "Close shortcuts", exact: true }).click();
    }
    await expect(shortcuts).toBeHidden();
    const appPrefix = await machineAppPrefix(page, demo.title);
    await gotoInPreviewViaDock(page, "/wp-admin/site-editor.php");
    const editorLoaded = await Promise.race([
      expect(frame.locator("iframe").first()).toBeVisible({ timeout: 60_000 }).then(() => true, () => false),
      page.locator('.kdock-status-text[data-status="error"]')
        .waitFor({ state: "attached", timeout: 60_000 })
        .then(() => false),
    ]);
    if (editorLoaded) {
      // The hub's first iframe can appear while its document and scripts are
      // still loading. Finish that navigation before opening the template.
      await expect.poll(() => frame.locator("body").evaluate(() => document.readyState),
        { timeout: 120_000 }).toBe("complete");
      await gotoInPreviewViaDock(page,
        "/wp-admin/site-editor.php?postType=wp_template&postId=twentytwentyfive//index&canvas=edit");
      const canvas = frame.frameLocator('iframe[name="editor-canvas"]');
      await expect(canvas.locator("[data-block]").first()).toBeVisible({ timeout: 180_000 });
    }
    let editorResult = { status: 0, body: "" };
    const samples: string[] = [];
    for (let elapsed = 0; editorLoaded && elapsed < soakSeconds; elapsed += 10) {
      await page.waitForTimeout(10_000);
      // Probe from the same preview client that issues WordPress AJAX requests.
      editorResult = await frame.locator("body").evaluate(async (_body, prefix) => {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 30_000);
        try {
          const response = await fetch(`${prefix}wp-admin/site-editor.php?health=${Date.now()}`, {
            cache: "no-store",
            signal: controller.signal,
          });
          const body = await response.text();
          return { status: response.status, body: body.slice(-5000) };
        } catch (error) {
          return { status: 0, body: `Editor health fetch failed: ${String(error)}` };
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
    let vfsState = "";
    try {
      await clickDockTool(page, "Internals", { timeout: 5_000 });
      const inspector = page.getByRole("dialog", { name: "Internals" });
      visibleSyslog = (await inspector.locator(".ksys-line").allTextContents()).slice(-100).join("\n");
      await inspector.getByRole("tab", { name: "Procs" }).click({ timeout: 5_000 });
      processes = (await inspector.locator(".ktable").allTextContents()).join("\n");
      await inspector.getByRole("tab", { name: "VFS" }).click({ timeout: 5_000 });
      vfsState = (await inspector.locator(".kinternals-surface").textContent() ?? "").slice(0, 10_000);
      for (const segment of ["var", "log"]) {
        await inspector.locator(".ktable tr", { has: page.locator("td", { hasText: new RegExp(`^${segment}/$`) }) }).click({ timeout: 5_000 });
      }
      await inspector.locator(".ktable tr", { has: page.locator("td", { hasText: demo.serviceLog }) }).click({ timeout: 5_000 });
      serviceLog = await inspector.locator(".kinternals-surface pre").last().textContent() ?? "";
    } catch (error) {
      serviceLog = `Service-log inspection unavailable: ${String(error)}\nVFS: ${vfsState}`;
    }
    const dockStatus = (await page.locator(".kdock-status-text").allTextContents()).join("\n");
    const pending = [...pendingRequests].map(([request, started]) =>
      `${Date.now() - started}ms ${request.method()} ${request.url()}`);
    if (!editorLoaded || editorResult.status !== 200) {
      // A bounded read-only probe distinguishes a worker whose event loop is
      // blocked from a responsive worker waiting on a guest or bridge result.
      const workers = await probeWorkerEventLoops(page);
      await test.info().attach("guest-service-log", { body: serviceLog, contentType: "text/plain" });
      await test.info().attach("browser-state", {
        body: JSON.stringify({
          frames: page.frames().map((item) => item.url()),
          body: (await page.locator("body").innerText({ timeout: 5_000 }).catch(() => "unavailable")).slice(-64_000),
          diagnostics: browserDiagnostics.slice(-100),
          pending,
          initialWorkers,
          workers,
        }),
        contentType: "application/json",
      });
    }
    expect(editorLoaded, `url=${page.url()}\n${visibleSyslog}\n${processes}\n${serviceLog.slice(0, 10000)}`).toBe(true);
    expect(editorResult.status, `url=${page.url()} samples=${samples.join(",")} dock=${dockStatus}\n${editorResult.body}\npending=${pending.length}\n${pending.slice(0, 30).join("\n")}\n${visibleSyslog}\n${processes}\n${serviceLog.slice(0, 10000)}\n${browserDiagnostics.slice(-100).join("\n")}`).toBe(200);
    expect(serviceLog).not.toMatch(/^Service-log inspection unavailable:/);
    expect(serviceLog.length).toBeGreaterThan(0);
    // A supervisor restart can restore HTTP while hiding a Go server crash.
    expect(serviceLog).not.toMatch(/^(?:panic:|fatal error:)/mi);
    if (demo.profile === "wordpress-frankenphp-caddy") {
      expect(serviceLog.match(/FrankenPHP started/g) ?? [],
        "The editor workflow must keep its original Caddy/PHP service alive").toHaveLength(1);
    }

    await expect(page.locator('.kdock-status-text[data-status="error"]')).toHaveCount(0);
  });

  test(`${demo.title} persists authenticated post edits`, async ({ page, baseURL }) => {
    test.setTimeout(300_000);
    test.skip(process.env.KANDELO_WORDPRESS_FRANKENPHP_UI_TESTS !== "1", "Build and project WordPress, then set KANDELO_WORDPRESS_FRANKENPHP_UI_TESTS=1");
    await gotoWordPressMachine(page, demo.profile, baseURL);
    const frame = page.frameLocator(`iframe[title="${demo.title}"]`);
    await expect(frame.locator("body")).toContainText("WordPress on Kandelo", { timeout: 240_000 });
    await expect(page.getByRole("button", { name: "Shortcuts", exact: true })).toBeVisible({ timeout: 30_000 });
    await page.getByRole("button", { name: "Shortcuts", exact: true }).click();
    await page.getByRole("dialog", { name: "Shortcuts", exact: true }).getByRole("button", { name: /^Log in as admin\b/ }).click();
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

  test(`${demo.title} saves a template from the site editor`, async ({ page, baseURL }) => {
    test.setTimeout(720_000);
    test.skip(process.env.KANDELO_WORDPRESS_FRANKENPHP_UI_TESTS !== "1", "Build and project WordPress, then set KANDELO_WORDPRESS_FRANKENPHP_UI_TESTS=1");
    const navigation: string[] = [];
    const pendingRequests = new Map<Request, number>();
    const record = (line: string) => {
      navigation.push(line);
      if (navigation.length > 200) navigation.shift();
    };
    page.on("response", (response) => {
      if (response.request().isNavigationRequest() && new URL(response.url()).pathname.includes("/computer/")) {
        record(`response ${response.status()} serviceWorker=${response.fromServiceWorker()} ${response.url()}`);
      }
    });
    page.on("framenavigated", (navigated) => {
      if (navigated !== page.mainFrame()) record(`frame ${navigated.url()}`);
    });
    page.on("request", (request) => pendingRequests.set(request, Date.now()));
    page.on("requestfinished", (request) => pendingRequests.delete(request));
    page.on("requestfailed", (request) => {
      pendingRequests.delete(request);
      if (request.isNavigationRequest()) record(`failed ${request.url()}: ${request.failure()?.errorText ?? "unknown"}`);
    });
    await gotoWordPressMachine(page, demo.profile, baseURL);
    const frame = page.frameLocator(`iframe[title="${demo.title}"]`);
    const reportNavigationFailure = async (stage: string, error: unknown): Promise<never> => {
      const state = await frame.locator("body").evaluate(() => ({
        url: location.href,
        controller: navigator.serviceWorker.controller?.scriptURL ?? null,
        text: document.body.innerText.slice(0, 2000),
      }), undefined, { timeout: 5_000 }).catch((cause) => ({ error: String(cause) }));
      const pending = [...pendingRequests].map(([request, started]) =>
        `${Date.now() - started}ms ${request.method()} ${request.url()}`);
      const detail = `${stage}: ${String(error)}\npreview=${JSON.stringify(state)}` +
        `\nframes=${JSON.stringify(page.frames().map((item) => item.url()))}` +
        `\npending=${pending.length}\n${pending.slice(0, 40).join("\n")}` +
        `\n${navigation.slice(-80).join("\n")}`;
      await test.info().attach("preview-navigation", { body: detail, contentType: "text/plain" });
      throw new Error(detail);
    };
    const expectPreviewContent = async (assertion: Promise<void>, stage: string): Promise<void> => {
      try {
        await Promise.race([
          assertion,
          frame.locator(".kdock-status-text").waitFor({ state: "attached", timeout: 180_000 })
            .then(() => { throw new Error("Kandelo app shell loaded inside WordPress preview"); }),
          frame.getByText("Kandelo computer unavailable", { exact: false })
            .waitFor({ state: "visible", timeout: 180_000 })
            .then(() => { throw new Error("WordPress preview reached the static origin without its service worker"); }),
        ]);
      } catch (error) {
        await reportNavigationFailure(stage, error);
      }
    };
    await expect(frame.locator("body")).toContainText("WordPress on Kandelo", { timeout: 240_000 });
    await page.getByRole("button", { name: "Shortcuts", exact: true }).click();
    await page.getByRole("dialog", { name: "Shortcuts", exact: true }).getByRole("button", { name: /^Log in as admin\b/ }).click();
    await expect(frame.locator("body.wp-admin")).toBeVisible({ timeout: 120_000 });
    const shortcuts = page.getByRole("dialog", { name: "Shortcuts", exact: true });
    if (await shortcuts.isVisible()) {
      await shortcuts.getByRole("button", { name: "Close shortcuts", exact: true }).click();
    }
    await expect(shortcuts).toBeHidden();
    record(`before editor ${JSON.stringify(await frame.locator("body").evaluate(() => ({
      url: location.href,
      controller: navigator.serviceWorker.controller?.scriptURL ?? null,
    })))}`);
    await gotoInPreviewViaDock(page,
      "/wp-admin/site-editor.php?postType=wp_template&postId=twentytwentyfive//index&canvas=edit");
    const canvas = frame.frameLocator('iframe[name="editor-canvas"]');
    await expectPreviewContent(expect(canvas.locator("[data-block]").first())
      .toBeVisible({ timeout: 180_000 }), "initial editor navigation");
    const savedHeading = "Kandelo template save probe";
    await saveWordPressTemplateHeading(frame, savedHeading, "twentytwentyfive//index");
    await gotoInPreviewViaDock(page,
      `/wp-admin/site-editor.php?postType=wp_template&postId=twentytwentyfive//index&canvas=edit&verify=${Date.now()}`,
    );
    await expectPreviewContent(expect(canvas.locator('[data-type="core/heading"]').filter({ hasText: savedHeading }).first())
      .toBeVisible({ timeout: 180_000 }), "saved template verification");
    await expect(page.locator('.kdock-status-text[data-status="error"]')).toHaveCount(0);
  });
}
