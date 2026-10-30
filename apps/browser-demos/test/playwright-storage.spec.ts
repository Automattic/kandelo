import { expect, test } from "@playwright/test";
import { closeSync, lstatSync, mkdtempSync, openSync, readdirSync, readSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("macOS WebKit stores OPFS in the run-owned home and preserves strict reopen", async ({ playwright, browserName, baseURL }, testInfo) => {
  test.skip(process.platform !== "darwin" || browserName !== "webkit", "macOS WebKit storage ownership contract");
  const launchOptions = testInfo.project.use.launchOptions;
  const home = launchOptions?.env?.CFFIXED_USER_HOME;
  expect(home).toBeTruthy();
  expect(home).toContain("kandelo-playwright-storage-");
  const profile = mkdtempSync(join(tmpdir(), "kandelo-webkit-storage-probe-"));
  const name = "storage-probe-" + crypto.randomUUID();
  try {
    for (const phase of ["write", "reopen"] as const) {
      const context = await playwright.webkit.launchPersistentContext(profile, launchOptions);
      try {
        const page = context.pages()[0] ?? await context.newPage();
        await page.goto(new URL("/trap-signal-test.html", baseURL).href);
        const bytes = await page.evaluate(async ({ phase, name }) => {
          const root = await navigator.storage.getDirectory();
          const handle = await root.getFileHandle(name, { create: phase === "write" });
          if (phase === "write") {
            const stream = await handle.createWritable();
            await stream.write(new Uint8Array(4 * 1024 * 1024).fill(91));
            await stream.close();
          }
          const file = await handle.getFile();
          const tail = new Uint8Array(await file.slice(file.size - 1).arrayBuffer());
          return { size: file.size, tail: tail[0] };
        }, { phase, name });
        expect(bytes).toEqual({ size: 4 * 1024 * 1024, tail: 91 });
      } finally {
        await context.close();
      }
    }
    const dataRoot = join(home!, "Library/WebKit/org.webkit.Playwright/WebsiteData");
    const files = readdirSync(dataRoot, { recursive: true, encoding: "utf8" });
    const stored = files.some(relative => {
      const path = join(dataRoot, relative);
      const stat = lstatSync(path);
      if (!stat.isFile() || stat.size !== 4 * 1024 * 1024) return false;
      const descriptor = openSync(path, "r");
      try {
        const byte = new Uint8Array(1);
        return readSync(descriptor, byte, 0, 1, stat.size - 1) === 1 && byte[0] === 91;
      } finally {
        closeSync(descriptor);
      }
    });
    expect(stored, "OPFS payload must physically reside in the run-owned home").toBe(true);
    await testInfo.attach("browser-storage-home", { body: home!, contentType: "text/plain" });
  } finally {
    rmSync(profile, { recursive: true, force: true });
  }
});
