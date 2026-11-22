import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { unzipSync } from "fflate";
import { expect, test, type Page } from "../playwright-test";

async function openExport(page: Page, changes = false) {
  // Exercise the fallback in all engines, including Chromium where a real
  // native save dialog would otherwise require interaction outside Playwright.
  await page.addInitScript(() => Object.defineProperty(window, "showSaveFilePicker", { value: undefined, configurable: true }));
  await page.goto("/test/fixtures/export-files.html");
  await page.getByTitle("More tools and help").click();
  await page.getByRole("button", { name: "Export files…", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Export files", exact: true });
  if (!changes) await dialog.getByRole("radio", { name: "All files", exact: true }).check();
  return dialog;
}

test("exports live tree entries to a real ZIP download and lets users choose a folder", async ({ page }, testInfo) => {
  const dialog = await openExport(page);
  const downloadEvent = page.waitForEvent("download");
  await dialog.getByRole("button", { name: "Download ZIP", exact: true }).click();
  const download = await downloadEvent;
  expect(download.suggestedFilename()).toBe("Export-demo.zip");
  const bytes = await readFile((await download.path())!);
  const files = unzipSync(bytes);
  expect(Object.keys(files).sort()).toEqual(["home/", "home/.config", "home/empty/", "home/hello.txt", "home/link", "home/new.txt"]);
  expect(new TextDecoder().decode(files["home/hello.txt"])).toBe("Hello from Kandelo\n");
  expect([...files["home/.config"]]).toEqual([0, 255, 10, 128]);
  expect(new TextDecoder().decode(files["home/link"])).toBe("../home");
  await expect(dialog.getByRole("status")).toContainText("4 entries excluded");
  const calls = await page.evaluate(() => (window as any).__exportTest.calls as string[]);
  expect(calls.some(path => /^\/(proc|dev|sys)(\/|$)/.test(path) || path.startsWith("/home/link"))).toBe(false);
  await dialog.getByRole("button", { name: "home/", exact: true }).click();
  await expect(dialog.getByLabel("Selected folder")).toHaveText("/home");
  const folderEvent = page.waitForEvent("download");
  await dialog.getByRole("button", { name: "Download ZIP", exact: true }).click();
  const folder = await folderEvent;
  expect(folder.suggestedFilename()).toBe("home.zip");
  expect(Object.keys(unzipSync(await readFile((await folder.path())!))).sort()).toEqual([".config", "empty/", "hello.txt", "link", "new.txt"]);
  if (testInfo.project.name === "chromium") await page.screenshot({ path: fileURLToPath(new URL("../../../.context/export-files.png", import.meta.url)) });
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(page.getByTitle("More tools and help")).toBeFocused();
});

test("read failures never deliver a partial download", async ({ page }) => {
  const dialog = await openExport(page);
  let downloads = 0;
  page.on("download", () => downloads++);
  await page.evaluate(() => (window as any).__exportTest.fail());
  await dialog.getByRole("button", { name: "Download ZIP", exact: true }).click();
  await expect(dialog.getByRole("alert")).toContainText("Cannot read /home/hello.txt");
  expect(downloads).toBe(0);
});

test("cancellation and computer replacement stop pending exports", async ({ page }) => {
  const dialog = await openExport(page);
  let downloads = 0;
  page.on("download", () => downloads++);
  await page.evaluate(() => (window as any).__exportTest.pause());
  await dialog.getByRole("button", { name: "Download ZIP", exact: true }).click();
  await expect.poll(() => page.evaluate(() => (window as any).__exportTest.calls.some((path: string) => path.startsWith("/home/hello.txt:")))).toBe(true);
  await dialog.getByRole("button", { name: "Cancel export", exact: true }).click();
  await expect(dialog.getByRole("status")).toHaveText("Export cancelled.");
  await page.evaluate(() => (window as any).__exportTest.resume());
  await page.evaluate(() => (window as any).__exportTest.pause());
  await dialog.getByRole("button", { name: "Download ZIP", exact: true }).click();
  await expect.poll(() => page.evaluate(() => (window as any).__exportTest.calls.filter((path: string) => path.startsWith("/home/hello.txt:")).length)).toBe(2);
  await page.evaluate(() => { (window as any).__exportTest.replace(); (window as any).__exportTest.resume(); });
  await expect(dialog.getByRole("alert")).toContainText("computer changed during export");
  expect(downloads).toBe(0);
});

test("save picker streams the ZIP and aborts its writer on cancellation", async ({ page }) => {
  const dialog = await openExport(page);
  await page.evaluate(() => {
    const output = { chunks: [] as number[][], closed: false, aborted: false };
    Object.assign(window, { __savedZip: output });
    Object.defineProperty(window, "showSaveFilePicker", { configurable: true, value: async () => ({ createWritable: async () => new WritableStream({
      write(chunk: Uint8Array) { output.chunks.push([...chunk]); },
      close() { output.closed = true; },
      abort() { output.aborted = true; },
    }) }) });
  });
  await dialog.getByRole("button", { name: "Download ZIP", exact: true }).click();
  await expect(dialog.getByRole("status")).toContainText("ZIP handed to your browser");
  const saved = await page.evaluate(() => (window as any).__savedZip);
  expect(saved.closed).toBe(true);
  expect(saved.aborted).toBe(false);
  expect(unzipSync(new Uint8Array(saved.chunks.flat()))["home/hello.txt"]).toBeTruthy();
  await page.evaluate(() => (window as any).__exportTest.pause());
  await dialog.getByRole("button", { name: "Download ZIP", exact: true }).click();
  await expect.poll(() => page.evaluate(() => (window as any).__exportTest.calls.filter((path: string) => path.startsWith("/home/hello.txt:")).length)).toBe(2);
  await dialog.getByRole("button", { name: "Cancel export", exact: true }).click();
  await expect.poll(() => page.evaluate(() => (window as any).__savedZip.aborted)).toBe(true);
  await page.evaluate(() => (window as any).__exportTest.resume());
  await expect(dialog.getByRole("status")).toHaveText("Export cancelled.");
});

test("folder controls fit a narrow screen", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const dialog = await openExport(page);
  await expect(dialog.getByRole("button", { name: "home/", exact: true })).toBeVisible();
  expect(await dialog.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
  if (testInfo.project.name === "chromium") await page.screenshot({ path: fileURLToPath(new URL("../../../.context/export-files-mobile.png", import.meta.url)) });
});

test("defaults to comparison and omits unchanged files and deleted reference paths", async ({ page }) => {
  const dialog = await openExport(page, true);
  await expect(dialog.getByRole("radio", { name: "Added and changed files", exact: true })).toBeChecked();
  const event = page.waitForEvent("download");
  await dialog.getByRole("button", { name: "Download ZIP", exact: true }).click();
  const download = await event;
  expect(download.suggestedFilename()).toBe("Export-demo-changes.zip");
  const files = unzipSync(await readFile((await download.path())!));
  expect(Object.keys(files).sort()).toEqual(["home/", "home/.config", "home/link", "home/new.txt"]);
  expect([...files["home/.config"]]).toEqual([0, 255, 10, 128]);
  expect(new TextDecoder().decode(files["home/link"])).toBe("../home");
  await expect(dialog.getByRole("status")).toContainText("1 unchanged file omitted");
  expect(await page.evaluate(() => (window as any).__exportTest.referenceClosed())).toBe(1);
});

test("reference failures are explicit and All files remains usable", async ({ page }) => {
  const dialog = await openExport(page, true);
  await page.evaluate(() => (window as any).__exportTest.failReference());
  await dialog.getByRole("button", { name: "Download ZIP", exact: true }).click();
  await expect(dialog.getByRole("alert")).toContainText("reference image has changed");
  await dialog.getByRole("radio", { name: "All files", exact: true }).check();
  const event = page.waitForEvent("download");
  await dialog.getByRole("button", { name: "Download ZIP", exact: true }).click();
  const download = await event;
  expect(unzipSync(await readFile((await download.path())!))["home/hello.txt"]).toBeTruthy();
});

test("computers without a known reference retain full export", async ({ page }) => {
  await page.addInitScript(() => Object.defineProperty(window, "showSaveFilePicker", { value: undefined, configurable: true }));
  await page.goto("/test/fixtures/export-files.html");
  await page.evaluate(() => (window as any).__exportTest.legacy());
  await page.getByTitle("More tools and help").click();
  await page.getByRole("button", { name: "Export files…", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Export files", exact: true });
  await expect(dialog.getByRole("radio", { name: "Added and changed files", exact: true })).toBeDisabled();
  await expect(dialog.getByRole("radio", { name: "All files", exact: true })).toBeChecked();
  const event = page.waitForEvent("download");
  await dialog.getByRole("button", { name: "Download ZIP", exact: true }).click();
  expect((await event).suggestedFilename()).toBe("Export-demo.zip");
});
