import { expect, test, type Page } from "@playwright/test";
import {
  gotoInPreview,
  gotoMachineOrSkip,
  machineAppPrefix,
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
 * Read the cookie jar from the complete bridge authority record. The service
 * worker replaces this single record atomically inside the registration's
 * scope-derived cache, so restart never combines a prefix, session, and jar
 * from different transitions.
 */
async function readPersistedCookieJar(
  page: Page,
): Promise<Array<{ name: string; path: string }>> {
  return page.evaluate(async () => {
    const registration = await navigator.serviceWorker.getRegistration();
    if (!registration) {
      throw new Error("WordPress page has no owning service worker registration");
    }
    const scopePath = new URL(registration.scope).pathname;
    const cacheName =
      `kandelo-sw:${encodeURIComponent(scopePath)}:bridge-v2`;
    if (!(await caches.keys()).includes(cacheName)) {
      throw new Error(`WordPress bridge cache is missing: ${cacheName}`);
    }
    const cache = await caches.open(cacheName);
    const keys = await cache.keys();
    // Each machine owns its own authority record, keyed
    // `bridge-authority-v1/<machine-name>` (see bridgeAuthorityKeyFor in
    // public/service-worker.js). Match the PREFIX, not a whole-segment
    // equality on the old single-instance key — that equality silently
    // matched nothing once routing became per-machine, which turns a real
    // "cookies were not persisted" failure into an empty list that reads
    // like one.
    const authorityReqs = keys.filter((r) =>
      new URL(r.url).pathname.includes("/bridge-authority-v1/"),
    );
    if (authorityReqs.length !== 1) {
      throw new Error(
        `expected exactly one machine authority record in ${cacheName}, got `
          + JSON.stringify(keys.map((r) => new URL(r.url).pathname)),
      );
    }
    const resp = await cache.match(authorityReqs[0]);
    if (!resp) {
      throw new Error(`machine authority record has no response body`);
    }
    const authority = JSON.parse(await resp.text());
    return authority?.version === 1 && Array.isArray(authority.cookies)
      ? authority.cookies
      : [];
  });
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

  const result = await page.evaluate(async (prefix) => {
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
  expect(data.variants.tcp.error).toBeUndefined();
  expect(data.variants.unix_persistent.error).toBeUndefined();
  expect(data.variants.tcp_persistent.error).toBeUndefined();
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

test("@slow Kandelo WordPress login survives a service worker restart", async ({
  page,
  browserName,
}) => {
  // Forcing a service worker to stop mid-session needs CDP
  // (ServiceWorker.stopWorker), which is Chromium-only.
  test.skip(browserName !== "chromium", "requires CDP ServiceWorker.stopWorker");
  test.setTimeout(420_000);

  const { frame, appPrefix } = await loginToWpAdmin(page);

  // The auth cookie must be durably persisted to Cache Storage, not just held
  // in the SW's in-memory jar. WordPress auth cookies are session cookies (no
  // Expires), so before the fix they lived only in memory and were lost
  // whenever the browser terminated the idle service worker — logging the user
  // out a minute or two after signing in.
  const persistedCookieNames = (await readPersistedCookieJar(page)).map((c) => c.name);
  expect(
    persistedCookieNames.some((name) => name.startsWith("wordpress_logged_in_")),
    `persisted cookie jar: ${JSON.stringify(persistedCookieNames)}`,
  ).toBe(true);

  // The SW jar is the ONLY cookie store: the browser's own cookie store must
  // stay empty so Kandelo cookies never accumulate there across sessions.
  const browserCookies = await page.context().cookies();
  expect(
    browserCookies.length,
    `browser cookie store: ${JSON.stringify(browserCookies.map((c) => c.name))}`,
  ).toBe(0);

  // Force the service worker to shut down, discarding all in-memory state
  // (the cookie jar included). The next request revives it, which must
  // restore the session from the persisted jar rather than fall back to
  // logged-out.
  const client = await page.context().newCDPSession(page);
  await client.send("ServiceWorker.enable");
  const versionId = await new Promise<string | null>((resolve) => {
    const timer = setTimeout(() => resolve(null), 15_000);
    client.on("ServiceWorker.workerVersionUpdated", (event) => {
      const running = (event.versions ?? []).find(
        (v: { runningStatus?: string; versionId: string }) =>
          v.runningStatus === "running",
      );
      if (running) {
        clearTimeout(timer);
        resolve(String(running.versionId));
      }
    });
  });
  expect(versionId, "expected a running service worker to stop").not.toBeNull();
  await client.send("ServiceWorker.stopWorker", { versionId: versionId! });

  // Re-enter wp-admin. This wakes the freshly-restarted SW, which restores
  // the cookie jar from Cache Storage and forwards the auth cookie — so we
  // land on the dashboard, not the login form.
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
  // are not controlled by the service worker, so without the blob-iframe
  // interceptor their asset requests (load-scripts.php/load-styles.php) escape
  // the bridge and 404 against the static origin. The interceptor rewrites
  // such iframes to about:srcdoc, which the SW controls. Assert that no editor
  // asset 404s and nothing under this machine's app prefix escapes to the
  // origin. The prefix is minted per machine, so the listener reads it from a
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

  expect(badAssets, `escaped/404 asset requests:\n${badAssets.join("\n")}`).toEqual([]);
});

test("@slow Kandelo WordPress auth cookie is retained for every cookie path", async ({
  page,
}) => {
  test.setTimeout(420_000);

  await loginToWpAdmin(page);

  // WordPress sets the SAME auth cookie name for two paths: ADMIN_COOKIE_PATH
  // (.../wp-admin) and PLUGINS_COOKIE_PATH (.../wp-content/plugins). Cookies are
  // identified by name AND path (RFC 6265), so a cookie jar keyed by name alone
  // collapses the two into one — dropping auth for the plugins subtree. Read the
  // persisted jar and confirm the auth cookie survives for both paths.
  const authCookiePaths = (await readPersistedCookieJar(page))
    .filter(
      (c) =>
        c.name.startsWith("wordpress_") &&
        !c.name.startsWith("wordpress_logged_in_") &&
        c.name !== "wordpress_test_cookie",
    )
    .map((c) => c.path);

  expect(
    authCookiePaths.some((p) => p.includes("/wp-admin")),
    `auth cookie paths: ${JSON.stringify(authCookiePaths)}`,
  ).toBe(true);
  expect(
    authCookiePaths.some((p) => p.includes("/wp-content/plugins")),
    `auth cookie paths: ${JSON.stringify(authCookiePaths)}`,
  ).toBe(true);
});
