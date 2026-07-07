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
 * Read the persisted cookie jar for the (single) active session. The SW stores
 * it under a session-scoped key `cookie-jar-<sessionId>` in the sw-bridge-config
 * cache, so find that entry rather than a fixed key.
 */
async function readPersistedCookieJar(
  page: Page,
): Promise<Array<{ name: string; path: string }>> {
  return page.evaluate(async () => {
    const cache = await caches.open("sw-bridge-config");
    const keys = await cache.keys();
    const jarReq = keys.find((r) =>
      (new URL(r.url).pathname.split("/").pop() ?? "").startsWith("cookie-jar-"),
    );
    if (!jarReq) return [];
    const resp = await cache.match(jarReq);
    if (!resp) return [];
    const records = JSON.parse(await resp.text());
    return Array.isArray(records) ? records : [];
  });
}

/** Boot the WordPress demo and sign into wp-admin. Returns the app frame. */
async function loginToWpAdmin(page: Page) {
  await gotoOrSkip(page, "/?demo=wordpress-mariadb");
  await page.waitForSelector('iframe[src*="/app/"]', { timeout: 180_000 });

  const frame = page.frameLocator('iframe[src*="/app/"]');
  await expect(frame.locator("body")).toContainText(/WordPress on Kandelo|Hello world/i, {
    timeout: 240_000,
  });

  await frame.locator("body").evaluate(() => {
    window.location.href = "/app/wp-login.php";
  });
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
  return frame;
}

test("@slow Kandelo WordPress/MariaDB mysqli transport benchmark returns", async ({
  page,
}) => {
  test.setTimeout(240_000);

  await gotoOrSkip(page, "/?demo=wordpress-mariadb");
  await page.waitForSelector('iframe[src*="/app/"]', { timeout: 180_000 });

  const result = await page.evaluate(async () => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort("timeout"), 90_000);
    try {
      const response = await fetch(
        `/app/kandelo-mysql-bench.php?connect_iters=1&query_iters=1&include_persistent=1&ts=${Date.now()}`,
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
  });

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

  await gotoOrSkip(page, "/?demo=wordpress-mariadb");
  await page.waitForSelector('iframe[src*="/app/"]', { timeout: 180_000 });

  const frame = page.frameLocator('iframe[src*="/app/"]');
  await expect(frame.locator("body")).toContainText(/WordPress on Kandelo|Hello world/i, {
    timeout: 240_000,
  });
  await expect(frame.locator("form#setup, form#language-chooser")).toHaveCount(0);

  await frame.locator("body").evaluate(() => {
    window.location.href = "/app/wp-login.php";
  });

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

  const frame = await loginToWpAdmin(page);

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
  await frame.locator("body").evaluate(() => {
    window.location.href = "/app/wp-admin/index.php";
  });
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
  // asset 404s and nothing under /app escapes to the origin.
  const badAssets: string[] = [];
  page.on("response", (resp) => {
    const url = resp.url();
    if (resp.status() >= 400 && (/load-scripts|load-styles/.test(url) || url.includes("/app/"))) {
      badAssets.push(`${resp.status()} ${url}`);
    }
  });

  const frame = await loginToWpAdmin(page);

  // Open the site editor and let its canvas iframe issue its asset requests.
  badAssets.length = 0;
  await frame.locator("body").evaluate(() => {
    window.location.href = "/app/wp-admin/site-editor.php";
  });
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

