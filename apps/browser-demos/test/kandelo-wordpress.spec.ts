import { expect, test, type Page } from "@playwright/test";
import {
  gotoInPreview,
  gotoMachineOrSkip,
  machineAppPrefix,
  machinePreviewOrigin,
  previewFrame,
} from "./support/kandelo-machine";

// The machine's own identity.title from its image's /etc/kandelo/demo.json.
const MACHINE_TITLE = "WordPress MariaDB";

// The demo dock auto-opens a guide/theme popover whose full-screen dismiss
// layer overlays the iframe and intercepts pointer events (a real user's first
// click merely closes the popover). Close it so subsequent clicks reach the
// app iframe.
async function dismissDockPopover(page: Page) {
  const layer = page.locator(".kdock-popover-dismiss-layer");
  if (await layer.count()) {
    await layer.first().click({ force: true }).catch(() => {});
  }
}

/**
 * WordPress's cookies live in the owning tab's per-machine jar
 * (`lib/preview/cookie-jar.ts`) and are never handed to the browser: neither
 * Kandelo's origin nor the preview origin may hold one. The whole browser
 * store must stay empty, as it had to when the jar lived in Kandelo's
 * service worker: every cookie a guest server sets is consumed by the jar.
 */
async function browserCookieNames(page: Page): Promise<string[]> {
  return (await page.context().cookies()).map((cookie) => cookie.name);
}

/**
 * Names and paths (never values) of the cookies the owning tab's jar holds
 * for this machine. Development servers expose them to tests
 * (`exposeCookieNamesForTests` in `kernel-host/machine-preview.ts`); the jar
 * exists nowhere else.
 */
async function machineJarEntries(
  page: Page,
  appPrefix: string,
): Promise<Array<{ name: string; path: string }>> {
  const name = /\/computer\/([a-z]+-[a-z]+-[a-z]+-[a-z2-7]{20})\/$/.exec(appPrefix)?.[1];
  if (!name) throw new Error(`no machine name in ${appPrefix}`);
  return page.evaluate((machine) => {
    const registry = (window as unknown as {
      __kandeloPreviewCookieNames?: Map<string, () => Array<{ name: string; path: string }>>;
    }).__kandeloPreviewCookieNames;
    const read = registry?.get(machine);
    if (!read) throw new Error(`the development server exposes no cookie jar for ${machine}`);
    return read();
  }, name);
}

/**
 * Boot the WordPress demo and sign into wp-admin. Returns the app frame and
 * the prefix the service worker minted for this machine's web preview, which
 * later navigations need to name an absolute app path.
 */
async function loginToWpAdmin(page: Page) {
  await gotoMachineOrSkip(page, "wordpress-mariadb");
  const appPrefix = await machineAppPrefix(page, MACHINE_TITLE);

  const frame = previewFrame(page, MACHINE_TITLE);
  await expect(frame.locator("body")).toContainText(/WordPress on Kandelo|Hello world/i, {
    timeout: 240_000,
  });

  await gotoInPreview(frame, appPrefix, "wp-login.php");
  await expect(frame.locator("#loginform")).toBeVisible({ timeout: 120_000 });
  await frame.locator("#user_login").fill("admin");
  await frame.locator("#user_pass").fill("password");
  // Close any auto-opened dock popover, then submit via Enter so the login
  // isn't blocked by the popover's overlay covering the iframe.
  await dismissDockPopover(page);
  await frame.locator("#user_pass").press("Enter");
  await expect(frame.locator("#wpadminbar, #adminmenu, body.wp-admin").first()).toBeVisible({
    timeout: 180_000,
  });
  return { frame, appPrefix };
}

test("@slow Kandelo WordPress/MariaDB mysqli transport benchmark returns", async ({
  page,
}) => {
  test.setTimeout(240_000);

  await gotoMachineOrSkip(page, "wordpress-mariadb");
  const appPrefix = await machineAppPrefix(page, MACHINE_TITLE);

  // The preview pane mounts as soon as the bridge has a prefix, which is
  // before MariaDB has finished starting. Benchmarking the mysqli transports
  // at that moment measures a database that is not up yet ("Connection
  // refused"), so wait for the site to actually render first — the same
  // readiness signal every other test in this file uses.
  await expect(
    previewFrame(page, MACHINE_TITLE).locator("body"),
  ).toContainText(/WordPress on Kandelo|Hello world/i, { timeout: 240_000 });

  // The machine is reachable only from its own preview origin, so the
  // benchmark request runs inside the preview frame.
  const result = await previewFrame(page, MACHINE_TITLE).locator("body").evaluate(async (_body, prefix) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort("timeout"), 90_000);
    try {
      const response = await fetch(
        `${prefix}kandelo-mysql-bench.php?connect_iters=1&query_iters=1&include_persistent=1&ts=${Date.now()}`,
        { cache: "no-store", signal: controller.signal },
      );
      const text = await response.text();
      return {
        ok: response.ok,
        status: response.status,
        text,
      };
    } catch (err) {
      return {
        ok: false,
        status: 0,
        text: err instanceof Error ? err.message : String(err),
      };
    } finally {
      clearTimeout(timer);
    }
  }, appPrefix);

  expect(result.ok, result.text).toBe(true);
  const data = JSON.parse(result.text);
  expect(data.include_persistent).toBe(true);
  expect(Object.keys(data.variants).sort()).toEqual([
    "tcp",
    "tcp_persistent",
    "unix",
    "unix_persistent",
  ]);
  expect(data.variants.unix.error).toBeUndefined();
  expect(data.variants.unix_persistent.error).toBeUndefined();
  // TODO(revisit): the TCP variants are deliberately not asserted. Since
  // PR #686 this image starts MariaDB with --skip-networking, so `tcp` and
  // `tcp_persistent` report "Connection refused"; WordPress itself uses the
  // Unix socket. Re-enabling TCP was deferred because on the Node.js host a
  // guest listen() becomes a real host socket on 0.0.0.0, and this MariaDB
  // runs --skip-grant-tables, so booting the image under Node.js would expose
  // a password-less database. Revisit once the Node.js host's networking
  // model is settled (sandboxed like the browser's, or honoring the guest's
  // bind address), then restore both assertions.
});

test("@slow Kandelo WordPress/MariaDB preinstalled site logs into wp-admin", async ({
  page,
}) => {
  test.setTimeout(420_000);

  await gotoMachineOrSkip(page, "wordpress-mariadb");
  const appPrefix = await machineAppPrefix(page, MACHINE_TITLE);

  const frame = previewFrame(page, MACHINE_TITLE);
  await expect(frame.locator("body")).toContainText(/WordPress on Kandelo|Hello world/i, {
    timeout: 240_000,
  });
  await expect(frame.locator("form#setup, form#language-chooser")).toHaveCount(0);

  await gotoInPreview(frame, appPrefix, "wp-login.php");

  await expect(frame.locator("#loginform")).toBeVisible({ timeout: 120_000 });
  await frame.locator("#user_login").fill("admin");
  await frame.locator("#user_pass").fill("password");
  await frame.locator("#wp-submit").click();
  await expect(frame.locator("#wpadminbar, #adminmenu, body.wp-admin").first()).toBeVisible({
    timeout: 180_000,
  });
});

test("@slow Kandelo WordPress login survives a preview service worker restart", async ({
  page,
  browserName,
}) => {
  // Forcing a service worker to stop mid-session needs CDP
  // (ServiceWorker.stopWorker), which is Chromium-only.
  test.skip(browserName !== "chromium", "requires CDP ServiceWorker.stopWorker");
  test.setTimeout(420_000);

  const { frame, appPrefix } = await loginToWpAdmin(page);
  const previewOrigin = await machinePreviewOrigin(page, MACHINE_TITLE);
  expect(previewOrigin).not.toBe(new URL(page.url()).origin);

  // The jar is the owning tab's; the browser's cookie store stays empty so
  // machine cookies never outlive the machine or reach another origin.
  expect(await browserCookieNames(page)).toEqual([]);

  // Force the preview service worker to shut down, discarding its in-memory
  // bridge port. The next guest request revives it; it asks the owning tab
  // for a fresh port, and the tab's jar keeps the session signed in.
  const client = await page.context().newCDPSession(page);
  await client.send("ServiceWorker.enable");
  const scriptUrl = `${previewOrigin}${appPrefix.replace(/computer\/[^/]+\/$/, "")}preview-service-worker.js`;
  const versionId = await new Promise<string | null>((resolve) => {
    const timer = setTimeout(() => resolve(null), 15_000);
    client.on("ServiceWorker.workerVersionUpdated", (event) => {
      const running = (event.versions ?? []).find(
        (v: { runningStatus?: string; scriptURL?: string; versionId: string }) =>
          v.runningStatus === "running" && v.scriptURL === scriptUrl,
      );
      if (running) {
        clearTimeout(timer);
        resolve(String(running.versionId));
      }
    });
  });
  expect(versionId, `expected a running ${scriptUrl}`).not.toBeNull();
  await client.send("ServiceWorker.stopWorker", { versionId: versionId! });

  await gotoInPreview(frame, appPrefix, "wp-admin/index.php");
  await expect(frame.locator("#wpadminbar, #adminmenu, body.wp-admin").first()).toBeVisible({
    timeout: 180_000,
  });
  await expect(frame.locator("#loginform")).toHaveCount(0);
});

test("@slow Kandelo WordPress site editor loads assets through the bridge (no blob-iframe 404s)", async ({
  page,
}) => {
  test.setTimeout(420_000);

  // The block/site editor mounts its canvas from a `blob:` URL. Blob documents
  // are not controlled by the preview service worker, so without the
  // blob-iframe helper their asset requests (load-scripts.php/load-styles.php)
  // escape the bridge to the preview origin's network. The helper hands the
  // canvas HTML to the preview worker, which serves it as an ordinary
  // controlled document; it also keeps the editor's keepalive preference
  // writes on the bridge in Firefox. Assert that no editor asset fails and
  // nothing under this machine's app prefix escapes to the network. The prefix is minted per machine, so the listener reads it from a
  // binding the login fills in; the window that matters starts after the reset
  // below, by which time it is set.
  let appPrefix = "";
  const badAssets: string[] = [];
  page.on("response", (resp) => {
    const url = resp.url();
    const underApp = appPrefix !== "" && url.includes(appPrefix);
    if (resp.status() >= 400 && (/load-scripts|load-styles/.test(url) || underApp)) {
      badAssets.push(`${resp.status()} ${url}`);
    }
  });

  const login = await loginToWpAdmin(page);
  const frame = login.frame;
  appPrefix = login.appPrefix;

  // Open the site editor and let its canvas iframe issue its asset requests.
  badAssets.length = 0;
  await gotoInPreview(frame, appPrefix, "wp-admin/site-editor.php");
  await expect(frame.locator("iframe").first()).toBeVisible({ timeout: 180_000 });
  await page.waitForTimeout(20_000);

  // Whether the canvas's own scripts escape depends on timing, so also check
  // the cause directly. WordPress admin sends a CSP (`frame-ancestors`) that
  // does not govern scripts, so the helper must run in the editor document,
  // and no editor frame may be left as an uncontrolled `blob:` document.
  const editor = page.frames().find((f) => f.url().includes("/wp-admin/site-editor.php"));
  expect(editor, "the site editor document").toBeDefined();
  expect(await editor!.evaluate(() =>
    (window as unknown as { __kandeloBlobIframePatched?: boolean }).__kandeloBlobIframePatched === true,
  )).toBe(true);
  expect(page.frames().map((f) => f.url()).filter((u) => u.startsWith("blob:"))).toEqual([]);
  expect(badAssets, `escaped/404 asset requests:\n${badAssets.join("\n")}`).toEqual([]);
});

test("@slow Kandelo WordPress auth cookies stay in the machine and keep every admin path signed in", async ({
  page,
}) => {
  test.setTimeout(420_000);

  const { frame, appPrefix } = await loginToWpAdmin(page);

  // WordPress sets the SAME auth cookie name for two paths: ADMIN_COOKIE_PATH
  // (.../wp-admin) and PLUGINS_COOKIE_PATH (.../wp-content/plugins). Cookies
  // are identified by name AND path (RFC 6265), so a jar keyed by name alone
  // collapses the two into one and drops auth for the plugins subtree. Read
  // the machine's jar in the owning tab and confirm both survive.
  const authCookiePaths = (await machineJarEntries(page, appPrefix))
    .filter((cookie) =>
      cookie.name.startsWith("wordpress_") &&
      !cookie.name.startsWith("wordpress_logged_in_") &&
      cookie.name !== "wordpress_test_cookie"
    )
    .map((cookie) => cookie.path);
  expect(
    authCookiePaths.some((path) => path.includes("/wp-admin")),
    `auth cookie paths: ${JSON.stringify(authCookiePaths)}`,
  ).toBe(true);
  expect(
    authCookiePaths.some((path) => path.includes("/wp-content/plugins")),
    `auth cookie paths: ${JSON.stringify(authCookiePaths)}`,
  ).toBe(true);

  // None of them reached the browser's own store, and admin pages stay
  // signed in through the jar.
  expect(await browserCookieNames(page)).toEqual([]);
  await gotoInPreview(frame, appPrefix, "wp-admin/plugins.php");
  await expect(frame.locator("body.plugins-php, body.wp-admin").first()).toBeVisible({
    timeout: 180_000,
  });
  await expect(frame.locator("#loginform")).toHaveCount(0);
});
