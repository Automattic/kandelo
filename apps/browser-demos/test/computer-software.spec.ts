import { expect } from "@playwright/test";
import { readFileSync, writeFileSync } from "node:fs";
import { test } from "./support/persistent-page";
import { clickDockTool } from "./support/dock";
import { configureNewComputer } from "./support/computer-library";
import { gotoInPreview, machineAppPrefix, machineUrl, previewFrame, vfsImageUrlForProduct } from "./support/kandelo-machine";
import { loginToWordPress } from "./support/wordpress-login";
import { publishWordPressPost } from "./support/wordpress-editor";
import { runTerminalCommand } from "./support/terminal-command";
import { expectWordPressUpload, uploadWordPressPng, type WordPressUpload } from "./support/wordpress-media";

const activateSoftware = process.env.KANDELO_TEST_SOFTWARE_UPGRADE === "1";
const interruptSoftware = process.env.KANDELO_TEST_SOFTWARE_INTERRUPT === "1";
if (interruptSoftware && !activateSoftware) throw new Error("Software interruption requires activation mode");
const releaseFixturePath = process.env.KANDELO_TEST_SOFTWARE_RELEASE_FIXTURE;
const releaseFixture: { selector?: string; before: string; after: string } | undefined = releaseFixturePath === undefined
  ? undefined : JSON.parse(readFileSync(releaseFixturePath, "utf8"));
if (releaseFixture && (!activateSoftware || releaseFixture.selector !== undefined && !releaseFixture.selector
    || !/^[a-f0-9]{64}$/.test(releaseFixture.before) || !/^[a-f0-9]{64}$/.test(releaseFixture.after)
    || releaseFixture.before === releaseFixture.after)) throw new Error("Invalid distinct-release software fixture");

test(activateSoftware ? "WordPress family package activation and rollback preserve the saved site" : "WordPress family maintenance entry retires services and restarts the same saved site", async ({ page, baseURL }, testInfo) => {
  test.setTimeout(activateSoftware ? 900_000 : 540_000);
  page.setDefaultTimeout(30_000);
  page.on("dialog", dialog => void dialog.accept());
  if (releaseFixture?.selector !== undefined) writeFileSync(releaseFixture.selector, "before\n");
  const errors: string[] = [];
  const attributed: { topLevel: boolean; document: string; message: string; code?: string }[] = [];
  page.on("pageerror", error => errors.push(error.message));
  page.on("console", message => { if (message.type() === "error") console.error(message.text()); });
  await page.exposeBinding("recordMaintenanceBrowserFailure", ({ frame }, failure: { message: string; code?: string }) => {
    attributed.push({ topLevel: frame === page.mainFrame(), document: frame.url(), ...failure });
  });
  await page.addInitScript(() => {
    const record = (failure: { message: string; code?: string }) => {
      const report = (window as unknown as { recordMaintenanceBrowserFailure(value: typeof failure): Promise<void> }).recordMaintenanceBrowserFailure;
      void report(failure).catch(() => {});
    };
    window.addEventListener("error", event => record({ message: event.message }));
    window.addEventListener("unhandledrejection", event => record({
      message: event.reason?.message ?? String(event.reason), code: event.reason?.code,
    }));
  });
  if (interruptSoftware) await page.addInitScript(() => {
    if (window !== window.top) return;
    const state = window as unknown as { interruptPackageSourceRead?: boolean; interruptedPackageRead?: { path: string; offset: number; length: number } };
    const sources = new WeakSet<Worker>();
    const postMessage = Worker.prototype.postMessage;
    Worker.prototype.postMessage = function (message: unknown, transfer?: Transferable[] | StructuredSerializeOptions) {
      const request = message as { type?: string; moduleBytes?: Uint8Array; directory?: string; path?: unknown; offset?: number; length?: number } | null;
      if (request?.type === "open" && request.moduleBytes instanceof Uint8Array && typeof request.directory === "string") sources.add(this);
      if (state.interruptPackageSourceRead && sources.has(this) && request?.type === "read" && typeof request.path === "string") {
        state.interruptPackageSourceRead = false;
        state.interruptedPackageRead = { path: request.path, offset: request.offset!, length: request.length! };
        return;
      }
      Reflect.apply(postMessage, this, [message, transfer ?? []]);
    };
  });
  const target = new URL(await machineUrl(page, "wordpress-mariadb"), baseURL);
  if (process.env.KANDELO_TEST_MACHINE_URLS === undefined) target.searchParams.set("vfs", await vfsImageUrlForProduct(page, "browser-wordpress-family"));
  await page.goto(target.href, { waitUntil: "domcontentloaded" });
  await expect(page.locator(".kdock-status-text")).toHaveAttribute("data-status", /running|error/, { timeout: 360_000 });
  await expect(page.locator(".kdock-status-text")).toHaveAttribute("data-status", "running");
  const title = "WordPress MariaDB";
  let frame = previewFrame(page, title);
  await expect(frame.locator("body")).toContainText(/WordPress on Kandelo|Hello world/i, { timeout: 360_000 });
  if (activateSoftware) {
    const keep = page.getByRole("button", { name: "Keep this temporary computer", exact: true });
    await keep.click();
    await expect(keep).toBeHidden();
  }
  const computer = new URL(page.url()).searchParams.get("computer");
  expect(computer).not.toBeNull();
  let prefix = await machineAppPrefix(page, title);
  await loginToWordPress(frame, prefix);
  await gotoInPreview(frame, prefix, "wp-admin/post-new.php");
  const postTitle = `Maintenance retained ${crypto.randomUUID()}`;
  const postId = await publishWordPressPost(frame, postTitle);
  let upload: WordPressUpload | undefined;
  if (activateSoftware) {
    upload = await uploadWordPressPng(page, frame, prefix);
  }
  const checkSoftware = async (digest: string) => {
    await page.getByRole("button", { name: "Terminal", exact: true }).click();
    await page.getByRole("tab", { name: "TTY1", exact: true }).click();
    const result = await runTerminalCommand(page, "sha256sum /etc/php-fpm.conf", digest);
    await testInfo.attach(`software-file-${digest}`, { body: result.output, contentType: "text/plain" });
  };
  const checkUpload = async () => {
    if (!upload) return;
    await expectWordPressUpload(page, prefix, upload);
  };
  if (releaseFixture) {
    await checkSoftware(releaseFixture.before);
    console.info("Distinct-release fixture: saved computer reopened under current deployment with original package bytes");
    if (releaseFixture.selector !== undefined) writeFileSync(releaseFixture.selector, "after\n");
    await page.reload({ waitUntil: "domcontentloaded" });
    await expect(page.locator(".kdock-status-text")).toHaveAttribute("data-status", "running", { timeout: 240_000 });
    await expect(frame.locator("body")).toContainText(/WordPress on Kandelo|Hello world/i, { timeout: 240_000 });
    expect(new URL(page.url()).searchParams.get("computer")).toBe(computer);
    await checkSoftware(releaseFixture.before);
  }
  await clickDockTool(page, "Software updates");
  const panel = page.getByRole("dialog", { name: "Software updates", exact: true });
  await panel.getByRole("button", { name: "Stop programs and enter maintenance", exact: true }).click();
  await expect(panel.getByRole("status")).toContainText("Maintenance mode", { timeout: 120_000 });
  await expect(page.locator(".kdock-status-text")).toHaveAttribute("data-status", "halted");
  expect(new URL(page.url()).searchParams.get("computer")).toBe(computer);
  await expect(panel.getByRole("alert")).toHaveCount(0);
  if (activateSoftware) {
    if (interruptSoftware) await page.evaluate(() => {
      (window as unknown as { interruptPackageSourceRead: boolean }).interruptPackageSourceRead = true;
    });
    await panel.getByRole("button", { name: "Update from this release", exact: true }).click();
    await expect(panel.getByRole("button", { name: "Cancel operation", exact: true })).toBeVisible();
    if (interruptSoftware) {
      await expect.poll(() => page.evaluate(() => (window as unknown as { interruptedPackageRead?: unknown }).interruptedPackageRead),
        { timeout: 180_000, message: "Interrupt a real resident-file read after native staging preparation" }).toBeTruthy();
      const interrupted = await page.evaluate(() => (window as unknown as { interruptedPackageRead: { path: string; offset: number; length: number } }).interruptedPackageRead);
      expect(interrupted.offset).toBe(0);
      expect(interrupted.length).toBeGreaterThan(0);
      await testInfo.attach("interrupted-package-source-read", { body: JSON.stringify(interrupted), contentType: "application/json" });
      await page.reload({ waitUntil: "domcontentloaded" });
      await expect(page.locator(".kdock-status-text")).toHaveAttribute("data-status", "halted", { timeout: 120_000 });
      expect(new URL(page.url()).searchParams.get("computer")).toBe(computer);
      await clickDockTool(page, "Software updates");
      await expect(panel.getByRole("status")).toContainText("pending");
      await panel.getByRole("button", { name: "Resume saved update", exact: true }).click();
      await expect(panel.getByRole("button", { name: "Cancel operation", exact: true })).toBeVisible();
      console.info(`WordPress update resumed after page interruption at ${interrupted.path}`);
    }
    await expect(panel.getByRole("button", { name: "Cancel operation", exact: true })).toBeHidden({ timeout: 360_000 });
    await expect(panel.getByRole("alert")).toHaveCount(0);
    await expect(panel.getByRole("status")).toContainText("active");
    console.info("WordPress package activation acknowledged");
  }
  await panel.getByRole("button", { name: "Start computer", exact: true }).click();
  await panel.getByRole("button", { name: "Close Software updates", exact: true }).click();
  frame = previewFrame(page, title);
  await expect(frame.locator("body")).toContainText(/WordPress on Kandelo|Hello world/i, { timeout: 240_000 });
  prefix = await machineAppPrefix(page, title);
  await gotoInPreview(frame, prefix, `?p=${postId}`);
  await expect(frame.locator("body")).toContainText(postTitle, { timeout: 60_000 });
  expect(new URL(page.url()).searchParams.get("computer")).toBe(computer);
  await checkUpload();
  if (releaseFixture) await checkSoftware(releaseFixture.after);
  if (activateSoftware) {
    await clickDockTool(page, "Software updates");
    await panel.getByRole("button", { name: "Stop programs and enter maintenance", exact: true }).click();
    await expect(panel.getByRole("status")).toContainText("active", { timeout: 120_000 });
    await panel.getByRole("button", { name: "Roll back software", exact: true }).click();
    await expect(panel.getByRole("button", { name: "Cancel operation", exact: true })).toBeHidden({ timeout: 360_000 });
    await expect(panel.getByRole("alert")).toHaveCount(0);
    await expect(panel.getByRole("status")).toContainText("rolled-back");
    console.info("WordPress package rollback acknowledged");
    await panel.getByRole("button", { name: "Start computer", exact: true }).click();
    await panel.getByRole("button", { name: "Close Software updates", exact: true }).click();
    frame = previewFrame(page, title);
    await expect(frame.locator("body")).toContainText(/WordPress on Kandelo|Hello world/i, { timeout: 240_000 });
    prefix = await machineAppPrefix(page, title);
    await gotoInPreview(frame, prefix, `?p=${postId}`);
    await expect(frame.locator("body")).toContainText(postTitle, { timeout: 60_000 });
    expect(new URL(page.url()).searchParams.get("computer")).toBe(computer);
    await checkUpload();
    if (releaseFixture) await checkSoftware(releaseFixture.before);
  }
  await testInfo.attach("browser-error-attribution", { body: JSON.stringify({ errors, attributed }, null, 2), contentType: "application/json" });
  expect(attributed.filter(failure => failure.topLevel)).toEqual([]);
});

for (const kernelQuiescenceUnconfirmed of [false, true]) {
test(`unconfirmed maintenance retirement retains the computer lock with kernel quiescence ${kernelQuiescenceUnconfirmed ? "unconfirmed" : "confirmed"}`, async ({ page, context, baseURL }) => {
  test.setTimeout(360_000);
  test.skip(process.env.KANDELO_TEST_BASE_URL !== undefined, "Failure injection uses the development module boundary");
  page.on("dialog", dialog => void dialog.accept());
  await page.goto(await machineUrl(page, "shell"), { waitUntil: "domcontentloaded" });
  await expect(page.locator(".kdock-status-text")).toHaveAttribute("data-status", "running", { timeout: 180_000 });
  const original = page.url();
  const source = new URL("pages/kandelo/kernel-host/package-maintenance-session.ts", baseURL).href;
  await page.evaluate(async ({ source, kernelQuiescenceUnconfirmed }) => {
    const { PackageMaintenanceSession } = await import(source);
    const close = PackageMaintenanceSession.prototype.close;
    PackageMaintenanceSession.prototype.close = async function () {
      const kernel = (this as unknown as { runtime: { hasUnconfirmedKernelQuiescence(): boolean } }).runtime;
      if (typeof kernel.hasUnconfirmedKernelQuiescence !== "function") throw new Error("Test did not capture the actual maintenance kernel");
      kernel.hasUnconfirmedKernelQuiescence = () => kernelQuiescenceUnconfirmed;
      (window as unknown as { maintenanceKernelInjected: boolean }).maintenanceKernelInjected = kernelQuiescenceUnconfirmed;
      await close.call(this);
      throw new Error("test: source retirement unconfirmed");
    };
  }, { source, kernelQuiescenceUnconfirmed });
  await clickDockTool(page, "Software updates");
  const panel = page.getByRole("dialog", { name: "Software updates", exact: true });
  await panel.getByRole("button", { name: "Stop programs and enter maintenance", exact: true }).click();
  await expect(panel.getByRole("status")).toContainText("Maintenance mode", { timeout: 90_000 });
  await panel.getByRole("button", { name: "Close Software updates", exact: true }).click();
  await configureNewComputer(page, "shell", "blocked switch");
  await page.getByRole("button", { name: "Create and boot", exact: true }).click();
  await expect(page.locator(".kdock-status-text")).toHaveAttribute("data-status", "error", { timeout: 90_000 });
  expect(await page.evaluate(() => (window as unknown as { maintenanceKernelInjected: boolean }).maintenanceKernelInjected)).toBe(kernelQuiescenceUnconfirmed);
  await configureNewComputer(page, "shell", "second blocked switch");
  await page.getByRole("button", { name: "Create and boot", exact: true }).click();
  await expect(page.locator(".kdock-status-text")).toHaveAttribute("data-status", "error", { timeout: 90_000 });
  const other = await context.newPage();
  await other.goto(original, { waitUntil: "domcontentloaded" });
  await expect(other.locator("body")).toContainText(/already.*another tab|already in use|locked/i, { timeout: 60_000 });
});
}
