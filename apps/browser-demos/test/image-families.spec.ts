import { expect, type Page } from "@playwright/test";
import { resolve } from "node:path";
import { test } from "./support/persistent-page";
import { gotoInPreview, machineAppPrefix, machineUrl } from "./support/kandelo-machine";
import { loginToWordPress } from "./support/wordpress-login";
import { publishWordPressPost } from "./support/wordpress-editor";
import { clickDockTool } from "./support/dock";
import { currentComputerMetadata } from "./support/computer-library";
import { runTerminalCommand } from "./support/terminal-command";

async function terminal(page: Page) {
  await page.getByRole("button", { name: "Terminal", exact: true }).click();
  await page.getByRole("tab", { name: "TTY1", exact: true }).click();
}

async function expectPreview(page: Page, content: RegExp, timeout: number) {
  const frame = page.locator("iframe.kweb-frame");
  await expect(frame).toBeVisible({ timeout });
  await expect.poll(() => frame.evaluate((element: HTMLIFrameElement) => element.contentDocument?.body?.innerText ?? ""), { timeout }).toMatch(content);
}

function computerIdentity({ id, title, storageFormat, profileId, filesystemProfileId, descriptor }: Awaited<ReturnType<typeof currentComputerMetadata>>) {
  return { id, title, storageFormat, profileId, filesystemProfileId, descriptor };
}

test("Web Stack changes all five service activities live and retains startup preferences and its computer", async ({ page }, testInfo) => {
  test.setTimeout(600000);
  page.setDefaultTimeout(30000);
  const kernels: string[] = [];
  page.on("worker", worker => { if (worker.url().includes("browser-kernel-worker-entry")) kernels.push(worker.url()); });
  await page.goto(await machineUrl(page, "nginx-php"));
  await expectPreview(page, /Kandelo SQLite demo/i, 240000);
  const computer = await currentComputerMetadata(page);
  const originalUrl = page.url();
  const originalKernels = kernels.length;
  await terminal(page);
  await runTerminalCommand(page, "kandelo-service list | tee /tmp/service-list; grep -E 'web-php +running +enabled' /tmp/service-list && printf 'SERVICE_LIST_READY\\n'", "SERVICE_LIST_READY");
  await runTerminalCommand(page, "printf 'retained\\n' >/home/projects/family-note; ps -A | grep '[d]init' | awk '{print $1}' >/tmp/service-supervisor-pid; sync; printf 'FAMILY_NOTE_READY\\n'", "FAMILY_NOTE_READY");
  const panel = page.getByRole("region", { name: "Installed activities" });
  for (const [id, content] of [["nginx", /Hello from nginx/], ["nginx-python", /Notes/i], ["ruby-todo", /Todo/i], ["redis", /What should we do next/], ["nginx-php", /Kandelo SQLite demo/i]] as const) {
    await page.getByRole("button", { name: "Activities", exact: true }).click();
    await panel.locator(`[data-image-activity="${id}"]`).getByRole("button", { name: "Start", exact: true }).click();
    await expect(panel).not.toBeVisible({ timeout: 120000 });
    await expectPreview(page, content, 120000);
    expect(page.url()).toBe(originalUrl);
    expect(kernels).toHaveLength(originalKernels);
    expect(await currentComputerMetadata(page)).toMatchObject(computer);
  }
  await terminal(page);
  await runTerminalCommand(page, "ps -A | grep '[d]init' | awk '{print $1}' >/tmp/supervisor-after; cmp /tmp/service-supervisor-pid /tmp/supervisor-after && test \"$(cat /home/projects/family-note)\" = retained && /usr/local/bin/kandelo-service enable web-python && printf 'FAMILY_STARTUP_SAVED\\n'", "FAMILY_STARTUP_SAVED");
  await runTerminalCommand(page, "kandelo-service list >/tmp/service-list; grep -E 'web-php +running +disabled' /tmp/service-list && grep -E 'web-python +stopped +enabled' /tmp/service-list && printf 'SERVICE_LIST_PREFERENCES_READY\\n'", "SERVICE_LIST_PREFERENCES_READY");
  const kernelsBeforeReload = kernels.length;
  await page.evaluate(() => { window.setTimeout(() => window.location.reload(), 0); });
  await expect.poll(() => kernels.length, { timeout: 30000 }).toBeGreaterThan(kernelsBeforeReload);
  await expect.poll(async () => {
    const child = page.frames().find(frame => frame.parentFrame() === page.mainFrame());
    if (!child) return null;
    return child.evaluate(() => {
      const frame = parent.document.querySelector<HTMLIFrameElement>("iframe.kweb-frame");
      const bounds = frame?.getBoundingClientRect();
      const style = frame && parent.getComputedStyle(frame);
      return { url: parent.location.href, ready: parent.document.readyState,
        status: parent.document.querySelector(".kdock-status-text")?.getAttribute("data-status"),
        visible: !!bounds && bounds.width > 0 && bounds.height > 0 && style?.visibility === "visible" && style.display !== "none",
        text: document.body.innerText };
    }).catch(() => null);
  }, { timeout: 240000 }).toMatchObject({ url: originalUrl, ready: "complete", status: "running", visible: true, text: expect.stringMatching(/Notes/i) });
  const context = page.context();
  await page.close();
  const reopened = await context.newPage();
  await reopened.goto(originalUrl, { waitUntil: "domcontentloaded" });
  await expectPreview(reopened, /Notes/i, 240000);
  expect(computerIdentity(await currentComputerMetadata(reopened))).toEqual(computerIdentity(computer));
  await terminal(reopened);
  await runTerminalCommand(reopened, "test \"$(cat /home/projects/family-note)\" = retained && printf 'FAMILY_REOPEN_RETAINED\\n'", "FAMILY_REOPEN_RETAINED");
  await reopened.getByRole("button", { name: "Web", exact: true }).click();
  await reopened.getByRole("button", { name: "Library", exact: true }).click();
  await reopened.getByRole("button", { name: "+ New computer", exact: true }).click();
  await expect(reopened.locator("[data-image-id]")).toHaveCount(3);
  await reopened.screenshot({ path: resolve(import.meta.dirname, `../../../.context/image-families-library-${testInfo.project.name}.png`) });
});

test("Web and Graphics switch independently without reloading the website or restarting its computer", async ({ page }, testInfo) => {
  test.setTimeout(360000);
  const kernels: string[] = [];
  const errors: string[] = [];
  page.on("worker", worker => { if (worker.url().includes("browser-kernel-worker-entry")) kernels.push(worker.url()); });
  page.on("pageerror", error => errors.push(error.message));
  await page.goto(await machineUrl(page, "nginx"));
  await expectPreview(page, /Hello from nginx/, 240000);
  await expect(page.getByLabel("Computer views").getByRole("button")).toHaveText(["Web", "Graphics", "Terminal", "Activities"]);
  await expect(page.getByRole("button", { name: "Web", exact: true })).toBeEnabled();
  await expect(page.getByRole("button", { name: "Graphics", exact: true })).toBeDisabled();
  const original = await currentComputerMetadata(page);
  const originalKernelCount = kernels.length;
  const frame = page.locator("iframe.kweb-frame");
  const iframe = await frame.elementHandle();
  await frame.evaluate((element: HTMLIFrameElement) => { element.contentDocument!.documentElement.dataset.viewRetention = "retained-web-preview"; });
  await terminal(page);
  await runTerminalCommand(page, "ps -A | grep '[d]init' | awk '{print $1}' >/tmp/display-supervisor-pid; printf 'VIEW_TEST_READY\\n'", "VIEW_TEST_READY");
  await page.locator(".kshell-host:visible .xterm-helper-textarea").focus();
  await page.keyboard.insertText("/usr/local/bin/modeset");
  await page.keyboard.press("Enter");
  const graphics = page.locator(".kmodeset-surface");
  await expect(graphics).toBeVisible({ timeout: 120000 });
  await expect(graphics).toHaveAttribute("data-kms-owner-pid", /^[1-9]\d*$/);
  const owner = await graphics.getAttribute("data-kms-owner-pid");
  const canvas = await page.locator(".kmodeset-canvas").elementHandle();
  for (let cycle = 0; cycle < 3; cycle++) {
    await page.getByRole("button", { name: "Web", exact: true }).click();
    await expectPreview(page, /Hello from nginx/, 30000);
    await expect(page.getByRole("button", { name: "Web", exact: true })).toHaveAttribute("aria-current", "true");
    await expect(page.getByRole("textbox", { name: "Preview URL path" })).toBeVisible();
    expect(await frame.evaluate((element, originalFrame) => element === originalFrame, iframe)).toBe(true);
    expect(await frame.evaluate((element: HTMLIFrameElement) => element.contentDocument!.documentElement.dataset.viewRetention)).toBe("retained-web-preview");
    await page.getByRole("button", { name: "Terminal", exact: true }).click();
    await page.getByRole("button", { name: "Graphics", exact: true }).click();
    await expect(graphics).toBeVisible();
    await expect(graphics).toHaveAttribute("data-kms-owner-pid", owner!);
    await expect(page.getByRole("button", { name: "Graphics", exact: true })).toHaveAttribute("aria-current", "true");
    await expect(page.getByRole("textbox", { name: "Preview URL path" })).not.toBeVisible();
    expect(await page.locator(".kmodeset-canvas").evaluate((element, originalCanvas) => element === originalCanvas, canvas)).toBe(true);
  }
  await page.screenshot({ path: resolve(import.meta.dirname, `../../../.context/separate-views-${testInfo.project.name}.png`) });
  await terminal(page);
  await page.getByRole("button", { name: "New terminal", exact: true }).click();
  await expect(page.locator(".kshell-host:visible .xterm-rows").first()).toContainText(/kandelo(?:-bash-[0-9.]+)?\$ ?/, { timeout: 120000 });
  await runTerminalCommand(page, "ps -A | grep '[d]init' | awk '{print $1}' >/tmp/display-supervisor-after; cmp /tmp/display-supervisor-pid /tmp/display-supervisor-after && kandelo-service list | grep -E 'web-static +running +enabled' && printf 'VIEW_SERVICES_RETAINED\\n'", "VIEW_SERVICES_RETAINED");
  expect(kernels).toHaveLength(originalKernelCount);
  expect(await currentComputerMetadata(page)).toMatchObject(original);
  expect(errors).toEqual([]);
});

for (const backend of ["sqlite", "mariadb"] as const) {
  test(`WordPress family boots ${backend} and switches two independent sites without duplicating core files`, async ({ page }) => {
    test.setTimeout(900000);
    page.setDefaultTimeout(30000);
    await page.goto(await machineUrl(page, `wordpress-${backend}`));
    await expectPreview(page, /Hello world|WordPress on Kandelo/i, 240000);
    const computer = await currentComputerMetadata(page);
    const other = backend === "sqlite" ? "mariadb" : "sqlite";
    const frame = page.frameLocator("iframe.kweb-frame");
    const prefix = await machineAppPrefix(page, backend === "sqlite" ? "WordPress SQLite" : "WordPress MariaDB");
    const posts = new Map<string, { title: string; id: number; media: string }>();
    const switchSite = async (site: string) => {
      await clickDockTool(page, "Services");
      const panel = page.getByRole("dialog", { name: "Services", exact: true });
      const service = panel.locator(`[data-service-id="wordpress-${site}"]`);
      await expect(service).toBeVisible({ timeout: 30000 });
      const state = service.getByText(/^State: /);
      await expect(state).toHaveText(/^State: (running|stopped|not-loaded|failed|skipped)$/, { timeout: 120000 });
      if ((await state.innerText()) !== "State: running") {
        await expect(service.getByRole("button", { name: "Start", exact: true })).toBeEnabled({ timeout: 120000 });
        await service.getByRole("button", { name: "Start", exact: true }).click();
      }
      await expect(service).toContainText("State: running", { timeout: 120000 });
      await panel.getByRole("button", { name: "Close Services", exact: true }).click();
      await page.getByRole("button", { name: "Web", exact: true }).click();
    };
    for (const site of [backend, other]) {
      await switchSite(site);
      await loginToWordPress(frame, prefix);
      await gotoInPreview(frame, prefix, "wp-admin/post-new.php");
      const title = `${site} private post ${Date.now()}`;
      const id = await publishWordPressPost(frame, title);
      const nonce = await frame.locator("body").evaluate(() => {
        const current = (window as Window & { wpApiSettings?: { nonce?: string } }).wpApiSettings?.nonce;
        const inline = document.querySelector("#wp-api-fetch-js-after")?.textContent ?? "";
        const nonce = current ?? /"nonce":"([^"]+)"/.exec(inline)?.[1];
        if (!nonce) throw new Error(`Missing WordPress REST nonce: ${inline.slice(0, 500)}`);
        return nonce;
      });
      const media = await page.evaluate(async ({ prefix, nonce, site }) => {
        const canvas = document.createElement("canvas"); canvas.width = 2; canvas.height = 2;
        const context = canvas.getContext("2d");
        if (!context) throw new Error("Canvas unavailable");
        context.fillStyle = site === "sqlite" ? "#ff0000" : "#0000ff"; context.fillRect(0, 0, 2, 2);
        const blob = await new Promise<Blob>((resolve, reject) => canvas.toBlob(value => value ? resolve(value) : reject(new Error("PNG encoding failed")), "image/png"));
        const response = await fetch(`${prefix}index.php?rest_route=/wp/v2/media`, {
          method: "POST", credentials: "same-origin", headers: { "Content-Type": "image/png", "Content-Disposition": `attachment; filename="${site}-private.png"`, "X-WP-Nonce": nonce }, body: blob,
        });
        const text = await response.text();
        if (!response.ok) throw new Error(`Upload failed ${response.status}: ${text.slice(0, 1000)}`);
        return (JSON.parse(text) as { source_url: string }).source_url;
      }, { prefix, nonce, site });
      expect(media).toContain(prefix);
      posts.set(site, { title, id, media });
    }
    for (const site of [backend, other, backend]) {
      await switchSite(site);
      const post = posts.get(site)!;
      await gotoInPreview(frame, prefix, `?p=${post.id}`);
      await expect(frame.locator("body")).toContainText(post.title, { timeout: 120000 });
      await expect(frame.locator("body")).not.toContainText(posts.get(site === "sqlite" ? "mariadb" : "sqlite")!.title);
      const mediaStatus = await page.evaluate(async url => (await fetch(url, { credentials: "same-origin" })).status, post.media);
      expect(mediaStatus).toBe(200);
      expect(await page.evaluate(async url => (await fetch(url, { credentials: "same-origin" })).status, posts.get(site === "sqlite" ? "mariadb" : "sqlite")!.media)).toBe(404);
      expect(await currentComputerMetadata(page)).toMatchObject(computer);
    }
    await page.reload({ waitUntil: "domcontentloaded" });
    await expectPreview(page, new RegExp(posts.get(backend)!.title), 240000);
    await switchSite(other);
    await gotoInPreview(frame, prefix, `?p=${posts.get(other)!.id}`);
    await expect(frame.locator("body")).toContainText(posts.get(other)!.title, { timeout: 120000 });
    expect(await page.evaluate(async url => (await fetch(url, { credentials: "same-origin" })).status, posts.get(other)!.media)).toBe(200);
    await terminal(page);
    await runTerminalCommand(page, "test ! -d /var/lib/wordpress-sites/sqlite/wp-admin && test ! -d /var/lib/wordpress-sites/mariadb/wp-admin && printf 'WORDPRESS_CORE_SHARED\\n'", "WORDPRESS_CORE_SHARED");
  });
}
