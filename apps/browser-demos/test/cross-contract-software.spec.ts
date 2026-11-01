import { expect } from "@playwright/test";
import { readFileSync, writeFileSync } from "node:fs";
import { test } from "./support/persistent-page";
import { clickDockTool } from "./support/dock";
import { gotoInPreview, machineAppPrefix, previewFrame } from "./support/kandelo-machine";
import { loginToWordPress } from "./support/wordpress-login";
import { publishWordPressPost } from "./support/wordpress-editor";
import { expectWordPressUpload, uploadWordPressPng } from "./support/wordpress-media";

// Needs two real deployments on one origin, each with its own kernel and
// programs built for a different program contract. See docs/package-upgrades.md.
const fixturePath = process.env.KANDELO_TEST_CROSS_CONTRACT_FIXTURE;
const fixture: { selector: string; before: string } | undefined =
  fixturePath === undefined ? undefined : JSON.parse(readFileSync(fixturePath, "utf8"));

test("a saved WordPress computer crosses a program contract change and keeps its data", async ({ page }) => {
  test.skip(fixture === undefined, "requires two deployments built for different program contracts");
  test.setTimeout(1_500_000);
  page.setDefaultTimeout(30_000);
  page.on("dialog", dialog => void dialog.accept());
  page.on("console", message => { if (message.type() === "error") console.error(message.text()); });
  const status = page.locator(".kdock-status-text");
  const title = "WordPress MariaDB";
  const panel = page.getByRole("dialog", { name: "Software updates", exact: true });
  const finished = async (phase: string) => {
    await expect(panel.getByRole("button", { name: "Cancel operation", exact: true })).toBeHidden({ timeout: 480_000 });
    expect(await panel.getByRole("alert").allTextContents()).toEqual([]);
    await expect(panel.getByRole("status")).toContainText(phase);
  };

  await page.addInitScript(() => {
    if (window !== window.top) return;
    const state = window as unknown as { interruptPackageSourceRead?: boolean; interruptedPackageRead?: boolean };
    const sources = new WeakSet<Worker>();
    const postMessage = Worker.prototype.postMessage;
    Worker.prototype.postMessage = function (message: unknown, transfer?: Transferable[] | StructuredSerializeOptions) {
      const request = message as { type?: string; moduleBytes?: Uint8Array; directory?: string; path?: unknown } | null;
      if (request?.type === "open" && request.moduleBytes instanceof Uint8Array && typeof request.directory === "string") sources.add(this);
      if (state.interruptPackageSourceRead && sources.has(this) && request?.type === "read" && typeof request.path === "string") {
        state.interruptPackageSourceRead = false;
        state.interruptedPackageRead = true;
        return;
      }
      Reflect.apply(postMessage, this, [message, transfer ?? []]);
    };
  });

  writeFileSync(fixture!.selector, "before\n");
  await page.goto(fixture!.before, { waitUntil: "domcontentloaded" });
  await expect(status).toHaveAttribute("data-status", "running", { timeout: 360_000 });
  let frame = previewFrame(page, title);
  await expect(frame.locator("body")).toContainText(/WordPress on Kandelo|Hello world/i, { timeout: 360_000 });
  const keep = page.getByRole("button", { name: "Keep this temporary computer", exact: true });
  await keep.click();
  await expect(keep).toBeHidden();
  const computer = new URL(page.url()).searchParams.get("computer");
  expect(computer).not.toBeNull();
  let prefix = await machineAppPrefix(page, title);
  await loginToWordPress(frame, prefix);
  await gotoInPreview(frame, prefix, "wp-admin/post-new.php");
  const postTitle = `Crossed a contract ${crypto.randomUUID()}`;
  const postId = await publishWordPressPost(frame, postTitle);
  const upload = await uploadWordPressPng(page, frame, prefix);

  const expectSiteRetained = async () => {
    await expect(status).toHaveAttribute("data-status", "running", { timeout: 240_000 });
    frame = previewFrame(page, title);
    await expect(frame.locator("body")).toContainText(/WordPress on Kandelo|Hello world/i, { timeout: 240_000 });
    prefix = await machineAppPrefix(page, title);
    await gotoInPreview(frame, prefix, `?p=${postId}`);
    await expect(frame.locator("body")).toContainText(postTitle, { timeout: 60_000 });
    await expectWordPressUpload(page, prefix, upload);
    expect(new URL(page.url()).searchParams.get("computer")).toBe(computer);
  };
  const reload = async (expected: string) => {
    await page.reload({ waitUntil: "domcontentloaded" });
    await expect(status).toHaveAttribute("data-status", expected, { timeout: 240_000 });
    expect(new URL(page.url()).searchParams.get("computer")).toBe(computer);
  };
  const start = async () => {
    await panel.getByRole("button", { name: "Start computer", exact: true }).click();
    await panel.getByRole("button", { name: "Close Software updates", exact: true }).click();
  };

  writeFileSync(fixture!.selector, "after\n");
  await reload("halted");
  await clickDockTool(page, "Software updates");
  await expect(panel.getByRole("status")).toContainText("Maintenance mode");
  await expect(panel).toContainText(/cannot run on this version of Kandelo/);

  await page.evaluate(() => { (window as unknown as { interruptPackageSourceRead: boolean }).interruptPackageSourceRead = true; });
  await panel.getByRole("button", { name: "Update from this release", exact: true }).click();
  await expect.poll(() => page.evaluate(() => (window as unknown as { interruptedPackageRead?: boolean }).interruptedPackageRead),
    { timeout: 300_000, message: "Interrupt a real package read after native staging preparation" }).toBeTruthy();
  await reload("halted");
  await clickDockTool(page, "Software updates");
  await expect(panel.getByRole("status")).toContainText("pending");
  await panel.getByRole("button", { name: "Resume saved update", exact: true }).click();
  await finished("active");
  await start();
  await expectSiteRetained();

  await reload("running");
  await expectSiteRetained();

  await clickDockTool(page, "Software updates");
  await panel.getByRole("button", { name: "Stop programs and enter maintenance", exact: true }).click();
  await expect(panel.getByRole("status")).toContainText("active", { timeout: 120_000 });
  await panel.getByRole("button", { name: "Roll back software", exact: true }).click();
  await finished("rolled-back");
  await panel.getByRole("button", { name: "Start computer", exact: true }).click();
  await expect(panel.getByRole("alert")).toContainText(/cannot run on this version of Kandelo/, { timeout: 60_000 });
  await expect(status).toHaveAttribute("data-status", "halted");

  await reload("halted");
  await clickDockTool(page, "Software updates");
  await expect(panel.getByRole("status")).toContainText("rolled-back");
  await panel.getByRole("button", { name: "Update from this release", exact: true }).click();
  await finished("active");
  await start();
  await expectSiteRetained();
});
