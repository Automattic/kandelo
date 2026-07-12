/**
 * Playwright test — runs PHP CLI in a real Chromium browser via kandelo.
 *
 * This verifies the browser code path: VirtualPlatformIO + MemoryFileSystem +
 * BrowserTimeProvider + SharedArrayBuffer, which differs significantly from the
 * Node.js path tested in packages/registry/php/test/php-hello.test.ts.
 *
 * The browser harness runs multiple PHP tests (inline, file-based, extensions)
 * and reports all results as JSON in the #results element.
 *
 * Run: npx playwright test --config packages/registry/php/test/browser/playwright.config.ts
 */

import { test, expect } from "@playwright/test";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, "../../../../..");
const hasKernelWasm = [
  join(repoRoot, "local-binaries/kernel.wasm"),
  join(repoRoot, "binaries/kernel.wasm"),
].some((candidate) => existsSync(candidate));
const hasPhpWasm = [
  join(repoRoot, "local-binaries/programs/wasm32/php/php.wasm"),
  join(repoRoot, "binaries/programs/wasm32/php/php.wasm"),
  join(repoRoot, "packages/registry/php/php-src/sapi/cli/php"),
].some((candidate) => existsSync(candidate));
const hasZipSo = [
  join(repoRoot, "local-binaries/programs/wasm32/php/zip.so"),
  join(repoRoot, "binaries/programs/wasm32/php/zip.so"),
  join(repoRoot, "packages/registry/php/bin/zip.so"),
].some((candidate) => existsSync(candidate));
const hasRootfsVfs = existsSync(join(repoRoot, "host/wasm/rootfs.vfs"));

test.skip(!hasKernelWasm, "kernel.wasm is not built or fetched");
test.skip(!hasPhpWasm, "php.wasm is not built or fetched");
test.skip(!hasZipSo, "zip.so is not built or fetched");
test.skip(!hasRootfsVfs, "rootfs.vfs is not built");

test("PHP CLI runs in the browser (inline, file, session, SQLite, fileinfo, XML, OpenSSL, extensions)", async ({
  page,
}) => {
  const runtimeErrors: string[] = [];
  page.on("console", (msg) => {
    if (msg.type() === "error") runtimeErrors.push(`console: ${msg.text()}`);
  });
  page.on("pageerror", (error) => {
    runtimeErrors.push(`pageerror: ${error.message}`);
  });
  page.on("requestfailed", (request) => {
    runtimeErrors.push(
      `requestfailed: ${request.url()} ${request.failure()?.errorText ?? "failed"}`,
    );
  });
  page.on("response", (response) => {
    if (response.status() >= 400) {
      runtimeErrors.push(`response: ${response.status()} ${response.url()}`);
    }
  });

  await page.goto("/");

  // Wait for all tests to finish (up to 120s — multiple sequential PHP runs)
  await page.waitForFunction(
    () => {
      const status = document.getElementById("status");
      return (
        status &&
        (status.textContent === "done" || status.textContent === "error")
      );
    },
    { timeout: 120_000 },
  );

  const status = await page.locator("#status").textContent();
  const stderr = await page.locator("#stderr").textContent();
  const resultsText = await page.locator("#results").textContent();
  const exitCode = await page.locator("#exit-code").textContent();

  if (status === "error" || exitCode !== "0") {
    console.log("STDERR:", stderr);
    console.log("RESULTS:", resultsText);
  }

  expect(status).toBe("done");
  expect(exitCode).toBe("0");
  expect(stderr).toBe("");

  const results = JSON.parse(resultsText!);

  // Inline
  expect(results.hello).toContain("Hello World");

  // File-based execution
  expect(results.file).toContain("Browser File OK");

  // Extensions (mbstring + ctype)
  const extData = JSON.parse(results.extensions);
  expect(extData.mb).toBe(5);
  expect(extData.ctype).toBe("yes");

  // Session
  expect(results.session).toContain("session-ok");

  // SQLite3
  expect(results.sqlite).toContain("sqlite-ok");

  // fileinfo
  expect(results.fileinfo).toContain("image/gif");

  // SimpleXML
  expect(results.xml).toContain("xml-ok");

  // OpenSSL defaults are present in rootfs.vfs and key + CSR generation succeeds.
  expect(results.openssl).toContain("openssl-defaults-ok");

  // Packaged side module and DEFLATE behavior through the browser VFS.
  expect(results.zip).toContain("browser-zip-ok");
  expect(runtimeErrors).toEqual([]);
});
