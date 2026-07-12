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
 * Run the default suite:
 *   npx playwright test --config packages/registry/php/test/browser/playwright.config.ts
 * Both cases resolve their complete PHP package closure through the normal
 * local/published binary mirrors.
 */

import { test, expect } from "@playwright/test";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { resolvePackageRuntimeFile } from "../../../../../scripts/package-runtime-file";
import { tryResolveBinary } from "../../../../../host/src/binary-resolver";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, "../../../../..");
const hasKernelWasm = tryResolveBinary("kernel.wasm") != null;
const hasPhpWasm = tryResolveBinary("programs/php/php.wasm") != null
  || existsSync(join(repoRoot, "packages/registry/php/php-src/sapi/cli/php"));
const hasZipSo = tryResolveBinary("programs/php/zip.so") != null
  || existsSync(join(repoRoot, "packages/registry/php/bin/zip.so"));
const hasCurlSo = tryResolveBinary("programs/php/curl.so") != null
  || existsSync(join(repoRoot, "packages/registry/php/bin/curl.so"));
const hasIntlSo = tryResolveBinary("programs/php/intl.so") != null
  || existsSync(join(repoRoot, "packages/registry/php/bin/intl.so"));
const phpIcuRuntime = resolvePackageRuntimeFile(repoRoot, "php", "icu.dat");
if (hasIntlSo && !phpIcuRuntime) {
  throw new Error(
    "PHP intl.so is present but the declared php:icu.dat runtime file is not materialized",
  );
}
const hasRootfsVfs = tryResolveBinary("rootfs.vfs") != null
  || tryResolveBinary("programs/rootfs.vfs") != null;

test.skip(!hasKernelWasm, "kernel.wasm is not built or fetched");
test.skip(!hasPhpWasm, "php.wasm is not built or fetched");
test.skip(!hasRootfsVfs, "rootfs.vfs is not built");

test("PHP CLI runs in the browser (inline, file, session, SQLite, fileinfo, XML, OpenSSL, extensions)", async ({
  page,
}) => {
  test.skip(!hasZipSo, "zip.so is not built or fetched");
  test.skip(!hasCurlSo, "curl.so is not built or fetched");
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

  // Packaged curl side module and linked libcurl through browser dlopen.
  expect(JSON.parse(results.curl)).toEqual({
    loaded: true,
    version: "8.11.1",
    constant: true,
    handle: true,
  });
  expect(JSON.parse(results.curlHttp)).toEqual({
    body: "kandelo-curl-ok\n",
    status: 200,
  });
  expect(runtimeErrors).toEqual([]);
});

test("PHP intl and ICU data survive browser side-module fork replay", async ({ page }) => {
  test.skip(!hasIntlSo, "intl.so is not built or fetched");

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

  await page.goto("/?intl=1");
  await page.waitForFunction(
    () => {
      const status = document.getElementById("status");
      return status?.textContent === "done" || status?.textContent === "error";
    },
    { timeout: 120_000 },
  );

  const status = await page.locator("#status").textContent();
  const stderr = await page.locator("#stderr").textContent();
  const resultsText = await page.locator("#results").textContent();
  const exitCode = await page.locator("#exit-code").textContent();
  if (status === "error" || exitCode !== "0") {
    console.log("INTL STDERR:", stderr);
    console.log("INTL RESULTS:", resultsText);
  }

  expect(status).toBe("done");
  expect(exitCode).toBe("0");
  expect(stderr).toBe("");
  const results = JSON.parse(resultsText!);
  expect(results.intlFork).toContain("child=French");
  expect(results.intlFork).toContain("parent=French:apple,banana,cherry");
  expect(runtimeErrors).toEqual([]);
});
