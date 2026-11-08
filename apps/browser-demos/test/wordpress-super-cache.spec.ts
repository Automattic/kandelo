import { test } from "./support/persistent-page";
import { expect } from "../playwright-test";
import { gotoInPreviewViaDock, machineAppPrefix, machineUrl, previewFrame } from "./support/kandelo-machine";
import { runTerminalCommand } from "./support/terminal-command";
import { readFileSync } from "node:fs";

type WordPressApiWindow = Window & {
  wp?: { apiFetch?: (request: { path: string; method: string; data?: unknown; signal?: AbortSignal }) =>
    Promise<{ id: number | string; content: { raw: string }; title?: { raw?: string } }> };
};

for (const demo of [
  { profile: "wordpress-sqlite", title: "WordPress SQLite", service: "nginx" },
  { profile: "wordpress-frankenphp", title: "WordPress on FrankenPHP", service: "frankenphp-classic" },
  { profile: "wordpress-frankenphp-caddy", title: "WordPress on FrankenPHP + Caddy", service: "frankenphp-caddy" },
] as const) {
test(`${demo.title} stock visitor cache preserves privacy, edits and expiry`, async ({ page }, testInfo) => {
  test.setTimeout(360_000);
  const observations: Record<string, unknown> = {};
  const browserCronRequests: string[] = [];
  page.on("request", request => {
    if (new URL(request.url()).pathname.endsWith("/wp-cron.php")) browserCronRequests.push(request.url());
  });
  const browserEvents: { event: string; detail: unknown }[] = [];
  const record = (event: string, detail: unknown) => {
    if (browserEvents.length < 200) browserEvents.push({ event, detail });
  };
  page.on("framenavigated", navigated => record("navigation", { url: navigated.url(), main: navigated === page.mainFrame() }));
  page.on("pageerror", error => record("page error", error.message));
  page.on("requestfailed", request => record("request failed", { url: request.url(), error: request.failure()?.errorText }));
  const frame = previewFrame(page, demo.title);
  const quote = (text: string) => "'" + text.replaceAll("'", "'\\''") + "'";
  const configure = async (script: string, marker: string) => {
    await page.getByRole("button", { name: "Terminal", exact: true }).click();
    await expect(page.getByRole("textbox", { name: "Terminal input" }).first()).toBeAttached({ timeout: 30_000 });
    await expect(page.locator(".kshell-host:visible .xterm-rows").first())
      .toContainText(/maker@[^:\s]+:[^\r\n]*\$\s*$/, { timeout: 60_000 });
    const result = await runTerminalCommand(page,
      `printf 'kandelo\\n' | sudo -S -p '' /bin/bash -c ${quote(`set -e\n${script}\nprintf '${marker}\\n'`)}`,
      marker, 30_000);
    await page.getByRole("button", { name: "Web", exact: true }).click();
    return result;
  };
  try {
    await page.goto(await machineUrl(page, demo.profile), { waitUntil: "domcontentloaded" });
    await expect(frame.locator("body")).toContainText("WordPress on Kandelo", { timeout: 180_000 });
    await page.getByRole("button", { name: "Shortcuts", exact: true }).click();
    const shortcuts = page.getByRole("dialog", { name: "Shortcuts", exact: true });
    await shortcuts.getByRole("button", { name: /^Log in as admin\b/ }).click();
    await expect(frame.locator("body.wp-admin")).toBeVisible({ timeout: 60_000 });
    if (await shortcuts.isVisible()) {
      await shortcuts.getByRole("button", { name: "Close shortcuts", exact: true }).click();
    }
    await gotoInPreviewViaDock(page, "/wp-admin/options-permalink.php");
    await frame.locator('input[type="radio"][value="/%postname%/"]').check({ timeout: 30_000 });
    await frame.getByRole("button", { name: "Save Changes", exact: true }).click();
    await expect(frame.locator("body")).toContainText("Permalink structure updated.", { timeout: 30_000 });
    await gotoInPreviewViaDock(page, "/wp-admin/plugins.php");
    const plugin = frame.locator('tr[data-plugin="wp-super-cache/wp-cache.php"]');
    await plugin.getByRole("link", { name: /^Activate/ }).click({ timeout: 30_000 });
    await expect(plugin).toHaveClass(/\bactive\b/, { timeout: 30_000 });
    await gotoInPreviewViaDock(page, "/wp-admin/options-general.php?page=wpsupercache");
    await frame.locator('input[name="wp_cache_easy_on"][value="1"]').check({ timeout: 30_000 });
    const submitted = page.waitForResponse(response => response.request().method() === "POST"
      && response.url().includes("/wp-admin/options-general.php?page=wpsupercache"), { timeout: 30_000 });
    await frame.getByRole("button", { name: "Update Status", exact: true }).click();
    expect((await submitted).status()).toBe(200);
    await gotoInPreviewViaDock(page, "/wp-admin/options-general.php?page=wpsupercache&verify=1");
    await expect.poll(() => frame.locator("body").evaluate(() => location.search), { timeout: 30_000 })
      .toContain("verify=1");
    await expect(frame.locator('input[name="wp_cache_easy_on"][value="1"]')).toBeChecked({ timeout: 30_000 });

    // The stock plugin leaves its hit header disabled and allows stale
    // responses during cache rebuild. Disable that option and select its
    // clear-on-edit setting so the first visitor must see saved content.
    observations.headerSetting = await configure(
      "/bin/sed -i 's/^\\$wpsc_served_header = false;$/\\$wpsc_served_header = true;/' /srv/www/html/wp-content/wp-cache-config.php\n"
      + "/bin/sed -i 's/^\\$cache_rebuild_files = .*;.*$/\\$cache_rebuild_files = 0;/' /srv/www/html/wp-content/wp-cache-config.php\n"
      + "/bin/sed -i 's/^\\$wp_cache_clear_on_post_edit = .*;.*$/\\$wp_cache_clear_on_post_edit = 1;/' /srv/www/html/wp-content/wp-cache-config.php\n"
      + "/bin/grep -F '$wpsc_served_header = true;' /srv/www/html/wp-content/wp-cache-config.php\n"
      + "/bin/grep -F '$cache_rebuild_files = 0;' /srv/www/html/wp-content/wp-cache-config.php\n"
      + "/bin/grep -F '$wp_cache_clear_on_post_edit = 1;' /srv/www/html/wp-content/wp-cache-config.php",
      "CACHE_HEADER_CONFIGURED");
    const prefix = await machineAppPrefix(page, demo.title);
    const visitor = async (path = "", method = "GET", authenticated = false) => page.evaluate(
      async ({ prefix, path, method, authenticated }) => {
        const response = await fetch(prefix + path, {
          method, credentials: authenticated ? "include" : "omit", cache: "no-store",
          headers: { Accept: "text/html" },
          ...(method === "POST" ? { body: new URLSearchParams({ cache_probe: "ordinary-post" }) } : {}),
          signal: AbortSignal.timeout(30_000),
        });
        return { status: response.status, hit: response.headers.get("x-wp-super-cache"), body: await response.text() };
      }, { prefix, path, method, authenticated });
    const first = await visitor();
    const hit = await visitor();
    const loggedIn = await visitor("", "GET", true);
    const posted = await visitor("", "POST");
    expect([first.status, hit.status, loggedIn.status, posted.status]).toEqual([200, 200, 200, 200]);
    expect(hit.hit).toMatch(/Served.*cache.*PHP/);
    expect(first.body + hit.body).not.toMatch(/id=["']wpadminbar["']/);
    expect(loggedIn.body).toMatch(/id=["']wpadminbar["']/);
    expect(loggedIn.hit).toBeNull();
    expect(posted.hit).toBeNull();
    observations.privacy = { anonymousHit: hit.hit, authenticatedHit: loggedIn.hit, postHit: posted.hit };

    // The settings document already supplies WordPress's configured REST
    // client. Keep it stable while testing cache invalidation; rendered editor
    // navigation and saves have their own separate acceptance gate.
    await expect(frame.locator("#wp-api-fetch-js-after")).toBeAttached({ timeout: 60_000 });
    await expect.poll(() => frame.locator("body").evaluate(() =>
      typeof (window as WordPressApiWindow).wp?.apiFetch), { timeout: 30_000 }).toBe("function");
    const rest = async (route: string, value?: unknown) => test.step(`WordPress REST ${route}`, () => frame.locator("body").evaluate(async (_body, { route, value }) => {
      const api = (window as WordPressApiWindow).wp?.apiFetch;
      if (!api) throw new Error("WordPress REST client is unavailable");
      try {
        return await api({ path: `/wp/v2/${route}?context=edit`, signal: AbortSignal.timeout(30_000),
          method: value === undefined ? "GET" : "POST", ...(value === undefined ? {} : { data: value }) });
      } catch (error) {
        const detail = error instanceof Error ? { name: error.name, message: error.message } : error;
        throw new Error(`WordPress REST ${route}: ${JSON.stringify(detail)}`);
      }
    }, { route, value }));
    const id = crypto.randomUUID();
    const title = `Cache original ${id}`;
    const changedTitle = `Cache updated ${id}`;
    const post = await rest("posts", { title, content: "Original cache body", slug: `cache-${id}`, status: "publish" });
    expect(typeof post.id).toBe("number");
    const homeAfterPublish = await visitor();
    expect(homeAfterPublish.body).toContain(title);
    const path = `cache-${id}/`;
    expect((await visitor(path)).body).toContain(title);
    expect((await visitor(path)).hit).toMatch(/Served.*cache.*PHP/);
    const updatedPost = await rest(`posts/${post.id}`, { title: changedTitle, content: "Updated cache body" });
    expect(updatedPost.title?.raw).toBe(changedTitle);
    expect(updatedPost.content.raw).toContain("Updated cache body");
    const afterEdit = await visitor(path);
    observations.afterEdit = { status: afterEdit.status, hit: afterEdit.hit,
      oldTitlePresent: afterEdit.body.includes(title), savedTitlePresent: afterEdit.body.includes(changedTitle),
      cacheFooter: afterEdit.body.slice(-1000) };
    expect(afterEdit.body).toContain(changedTitle);
    expect(afterEdit.body).not.toContain(title);
    expect((await visitor()).body).toContain(changedTitle);
    expect((await visitor()).hit).toMatch(/Served.*cache.*PHP/);
    observations.postInvalidation = { postId: post.id, publishVisible: true, editVisible: true };

    const templateId = "twentytwentyfive//home";
    const template = await rest(`templates/${templateId}`);
    expect(typeof template.content.raw).toBe("string");
    const heading = `Cache template ${id}`;
    await rest(`templates/${templateId}`, {
      content: template.content.raw + `\n<!-- wp:heading --><h2 class="wp-block-heading">${heading}</h2><!-- /wp:heading -->`,
    });
    expect((await visitor()).body).toContain(heading);
    expect((await visitor()).hit).toMatch(/Served.*cache.*PHP/);
    observations.templateInvalidation = { templateId, savedHeadingVisible: true };

    observations.expirySetting = await configure(
      "/bin/sed -i 's/^\\$cache_max_time = .*;.*$/\\$cache_max_time = 2;/' /srv/www/html/wp-content/wp-cache-config.php\n"
      + "/bin/grep -F '$cache_max_time = 2;' /srv/www/html/wp-content/wp-cache-config.php",
      "CACHE_EXPIRY_CONFIGURED");
    // Let the real wall clock exceed the stock cache's two-second TTL;
    // do not age files, clear caches or mutate the application's clock.
    await new Promise(resolve => setTimeout(resolve, 4000));
    const expired = await visitor(path);
    expect(expired.status).toBe(200);
    expect(expired.hit).toBeNull();
    expect(expired.body).toContain(changedTitle);
    expect((await visitor(path)).hit).toMatch(/Served.*cache.*PHP/);
    observations.expiry = { staleEntryBypassed: true, rebuiltEntryHit: true };

    // This authenticated test-owned probe only schedules and observes the
    // stock hook. WordPress's real wp-cron.php executes garbage collection.
    const scheduler = await configure(
      `/sbin/dinitctl -p /run/kandelo-services/dinitctl is-started ${demo.service}-cron\n`
      + "/bin/cat /etc/wordpress/cron.curl", "AUTOMATIC_CRON_READY");
    expect(scheduler.output).toContain(`X-Forwarded-Host: ${new URL(page.url()).host}"`);
    expect(scheduler.output).toContain(`X-Forwarded-Prefix: ${prefix.replace(/\/$/, "")}"`);
    observations.scheduler = scheduler;
    const cronProbe = readFileSync(new URL("./support/wordpress-cache-cron-probe.php", import.meta.url), "utf8");
    await configure(`printf '%s' ${quote(cronProbe)} > /srv/www/html/__kandelo_cache_cron.php`, "CACHE_CRON_PROBE_INSTALLED");
    await new Promise(resolve => setTimeout(resolve, 4000));
    const beforeGc = JSON.parse((await visitor("__kandelo_cache_cron.php", "POST", true)).body) as {
      now: number; lastGc: number; nextGc: number | false; files: { path: string; mtime: number }[];
    };
    const oldPostFiles = beforeGc.files.filter(file => file.path.includes(`/cache-${id}/`));
    expect(oldPostFiles.length).toBeGreaterThan(0);
    expect(oldPostFiles.every(file => file.mtime + 2 < beforeGc.now)).toBe(true);
    expect(beforeGc.nextGc).toBeLessThanOrEqual(beforeGc.now);
    await expect.poll(async () => {
      const response = await visitor("__kandelo_cache_cron.php", "GET", true);
      expect(response.status).toBe(200);
      const afterGc = JSON.parse(response.body) as typeof beforeGc;
      observations.scheduledGc = { before: beforeGc, after: afterGc,
        execution: "Image-owned Dinit/curl scheduler; browser never requests wp-cron.php" };
      return { ran: afterGc.lastGc >= beforeGc.now,
        removed: oldPostFiles.every(old => !afterGc.files.some(file => file.path === old.path)),
        rescheduled: afterGc.nextGc !== false && afterGc.nextGc > beforeGc.now };
    }, { timeout: 95_000, message: "Image-owned cron must remove expired cache files and reschedule the stock hook" })
      .toEqual({ ran: true, removed: true, rescheduled: true });
    expect(browserCronRequests).toEqual([]);
  } finally {
    await testInfo.attach("cache-browser-events", {
      body: JSON.stringify({ url: page.url(), events: browserEvents }), contentType: "application/json",
    });
    await testInfo.attach("visitor-cache-observations", {
      body: JSON.stringify({ ...observations,
        scope: "Stock plugin browser activation, privacy, clear-on-edit post/template invalidation, real-clock expiry and automatic guest cron GC. Final-artifact and lifecycle gates remain separate." }),
      contentType: "application/json",
    });
  }
});
}
