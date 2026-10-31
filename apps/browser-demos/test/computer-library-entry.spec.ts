import { expect, type Dialog, type Page } from "@playwright/test";
import { test } from "./support/persistent-page";
import { currentComputerMetadata } from "./support/computer-library";
import { runTerminalCommand } from "./support/terminal-command";

async function ready(page: Page): Promise<void> {
  await expect.poll(async () => {
    const status = await page.locator(".kdock-status-text").getAttribute("data-status");
    if (status === "error") throw new Error(await page.locator("body").innerText());
    return status;
  }, { timeout: 120_000 }).toBe("running");
  await expect.poll(() => page.locator(".xterm-rows").first().textContent(), { timeout: 60_000 }).toMatch(/kandelo(?:-bash-[0-9.]+)?\$ ?/);
}

test("bare entry defaults to temporary, reload preserves its disk, and keeping it requires confirmation without another download", async ({ page }, testInfo) => {
  test.setTimeout(240_000);
  const images: string[] = [];
  const errors: string[] = [];
  await page.addInitScript(() => {
    const post = Worker.prototype.postMessage;
    Worker.prototype.postMessage = function(...args: Parameters<Worker["postMessage"]>) {
      const seen = new WeakSet<object>();
      const inspect = (value: unknown): void => {
        if (typeof FileSystemHandle !== "undefined" && value instanceof FileSystemHandle) {
          throw new DOMException("OPFS handles must not cross worker messages", "DataCloneError");
        }
        if (value === null || typeof value !== "object" || seen.has(value)) return;
        seen.add(value);
        if (Array.isArray(value) || Object.getPrototypeOf(value) === Object.prototype) {
          for (const child of Object.values(value)) inspect(child);
        }
      };
      inspect(args[0]);
      return post.apply(this, args);
    };
  });
  page.on("pageerror", error => errors.push(error.message));
  page.on("request", request => {
    if (/\.vfs(?:\.zst)?$/.test(new URL(request.url()).pathname)) images.push(request.url());
  });
  const started = Date.now();
  await page.goto("/");
  await ready(page);
  const initialBootMs = Date.now() - started;
  const releaseWarning = page.locator(".kdock-shell").getByRole("note", { name: "Release compatibility warning" });
  await expect(releaseWarning).toBeVisible();
  await expect(releaseWarning).toContainText("Saved computers from this release will not work in the next release.");
  const computerUrl = page.url();
  expect(new URL(computerUrl).searchParams.get("computer")).toMatch(/^[0-9a-f-]{36}$/);
  const computer = await currentComputerMetadata(page);
  expect(computer.storageFormat).toBe("kandelo-opfs-image-v1");
  expect(computer.title).toMatch(/^[a-z]+-[a-z]+-[a-z]+$/);
  expect(computer.retention).toBe("temporary");
  expect(computer.expiresAt).not.toBeNull();
  await expect(page.locator(".kdock-temporary-badge")).toHaveText("Temporary");
  const initialViewport = page.viewportSize();
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.locator(".kdock-temporary-badge")).toBeVisible();
  if (initialViewport) await page.setViewportSize(initialViewport);
  expect(images).toHaveLength(1);
  await runTerminalCommand(page, "printf 'entry-disk\\n' > /home/projects/entry-note; sync; printf 'ENTRY_NOTE_SAVED\\n'", "ENTRY_NOTE_SAVED");
  const reloadStarted = Date.now();
  await page.reload();
  await ready(page);
  const restoredBootMs = Date.now() - reloadStarted;
  await expect(releaseWarning).toBeVisible();
  expect(page.url()).toBe(computerUrl);
  expect((await currentComputerMetadata(page)).title).toBe(computer.title);
  expect((await currentComputerMetadata(page)).storageFormat).toBe(computer.storageFormat);
  expect(images).toHaveLength(1);
  await runTerminalCommand(page, "test \"$(cat /home/projects/entry-note)\" = entry-disk && printf 'ENTRY_NOTE_RESTORED\\n'", "ENTRY_NOTE_RESTORED");
  await page.getByRole("button", { name: "Library", exact: true }).click();
  const entry = page.locator(`[data-computer-id="${computer.id}"]`);
  await expect(entry.locator(".kcomputer-retention-status").getByRole("button", { name: "Keep this computer", exact: true })).toBeVisible();
  await expect(entry.getByLabel("Initial image: Base Shell", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "List", exact: true }).click();
  for (const side of ["Top", "Right", "Bottom", "Left"]) {
    expect(await entry.evaluate((element, side) => getComputedStyle(element).getPropertyValue(`border-${side.toLowerCase()}-style`), side)).toBe("solid");
  }
  const cancelKeeping = async (dialog: Dialog) => { await dialog.dismiss(); };
  page.once("dialog", cancelKeeping);
  await entry.getByRole("button", { name: "Keep this computer", exact: true }).click();
  expect((await currentComputerMetadata(page)).retention).toBe("temporary");
  page.once("dialog", async dialog => {
    expect(dialog.message()).toContain(`Keep “${computer.title}” on this device?`);
    expect(dialog.message()).toContain("Saved computers from this release will not work in the next release.");
    await dialog.accept();
  });
  await entry.getByRole("button", { name: "Keep this computer", exact: true }).click();
  await expect(entry.getByText("Saved on this device", { exact: true })).toBeVisible();
  expect(await currentComputerMetadata(page)).toMatchObject({ retention: "saved", expiresAt: null });
  await expect(page.locator(".kdock-temporary-badge")).toHaveCount(0);
  expect(page.url()).toBe(computerUrl);
  await page.getByRole("button", { name: "More", exact: true }).click();
  const community = page.getByRole("navigation", { name: "Kandelo community", exact: true });
  await expect(community.getByRole("link", { name: "Send feedback", exact: true })).toHaveAttribute("href", "https://github.com/Automattic/kandelo/issues/new?template=feedback.yml");
  await expect(community.getByRole("link", { name: "Follow the blog", exact: true })).toHaveAttribute("href", "https://kandelo.blog/");
  await expect(community.getByRole("link", { name: "GitHub repository", exact: true })).toHaveAttribute("href", "https://github.com/Automattic/kandelo");
  await page.reload();
  await ready(page);
  expect(await currentComputerMetadata(page)).toMatchObject({ retention: "saved", expiresAt: null });
  await expect(releaseWarning).toBeVisible();
  expect(page.url()).toBe(computerUrl);
  expect(images).toHaveLength(1);
  await runTerminalCommand(page, "test \"$(cat /home/projects/entry-note)\" = entry-disk && printf 'KEPT_ENTRY_NOTE_RESTORED\\n'", "KEPT_ENTRY_NOTE_RESTORED");
  expect(errors).toEqual([]);
  await testInfo.attach("entry-startup-measurement", {
    body: JSON.stringify({ initialBootMs, restoredBootMs, images }, null, 2), contentType: "application/json",
  });
  console.log(JSON.stringify({ engine: testInfo.project.name, initialBootMs, restoredBootMs, imageDownloads: images.length }));
});

test("the computer storage prefix cannot be opened through the experimental-name interface", async ({ page }) => {
  const dialogs: string[] = [];
  page.on("dialog", async dialog => { dialogs.push(dialog.message()); await dialog.dismiss(); });
  await page.goto(`/?experimentalPersistence=computer-${crypto.randomUUID()}&experimentalPersistenceMode=resizable`);
  await expect(page.getByRole("alert")).toContainText("The computer- namespace is reserved for Library computers");
  expect(dialogs).toEqual([]);
});

test("an unknown storage format fails before boot and never replaces the stored computer", async ({ page }) => {
  test.setTimeout(240_000);
  const images: string[] = [];
  page.on("request", request => {
    if (/\.vfs(?:\.zst)?$/.test(new URL(request.url()).pathname)) images.push(request.url());
  });
  await page.goto("/");
  await ready(page);
  await runTerminalCommand(page, "printf 'format-disk\\n' > /home/projects/format-note; sync; printf 'FORMAT_NOTE_SAVED\\n'", "FORMAT_NOTE_SAVED");
  const computerUrl = page.url();
  const original = await page.evaluate(async () => {
    const root = await navigator.storage.getDirectory();
    const machines = await (await root.getDirectoryHandle("kandelo")).getDirectoryHandle("computers");
    const directory = await machines.getDirectoryHandle(new URL(location.href).searchParams.get("computer")!);
    const metadata = await directory.getFileHandle("computer.json");
    const original = await (await metadata.getFile()).text();
    const writer = await metadata.createWritable();
    await writer.write(JSON.stringify({ ...JSON.parse(original), storageFormat: "kandelo-opfs-files-v1" }));
    await writer.close();
    return original;
  });
  await page.reload();
  await expect(page.getByRole("alert")).toContainText('Unsupported computer storage format "kandelo-opfs-files-v1"');
  expect(page.url()).toBe(computerUrl);
  expect(images).toHaveLength(1);
  expect((await currentComputerMetadata(page)).storageFormat).toBe("kandelo-opfs-files-v1");
  await page.evaluate(async original => {
    const root = await navigator.storage.getDirectory();
    const machines = await (await root.getDirectoryHandle("kandelo")).getDirectoryHandle("computers");
    const directory = await machines.getDirectoryHandle(new URL(location.href).searchParams.get("computer")!);
    const writer = await (await directory.getFileHandle("computer.json")).createWritable();
    await writer.write(original); await writer.close();
  }, original);
  await page.reload();
  await ready(page);
  expect(page.url()).toBe(computerUrl);
  expect(images).toHaveLength(1);
  await runTerminalCommand(page, "test \"$(cat /home/projects/format-note)\" = format-disk && printf 'FORMAT_DISK_PRESERVED\\n'", "FORMAT_DISK_PRESERVED");
});
