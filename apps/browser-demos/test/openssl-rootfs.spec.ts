import { expect, test } from "@playwright/test";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "../../..");
const programPath = resolve(repoRoot, "examples/mount_probe_test.wasm");

const entries = [
  {
    path: "/etc/ssl/openssl.cnf",
    source: resolve(repoRoot, "images/rootfs/etc/ssl/openssl.cnf"),
  },
  {
    path: "/etc/ssl/cert.pem",
    source: resolve(repoRoot, "images/rootfs/etc/ssl/cert.pem"),
  },
].map(({ path, source }) => {
  const bytes = readFileSync(source);
  return {
    path,
    size: bytes.byteLength,
    head: bytes.subarray(0, 16).toString("hex"),
  };
});

test("legacy browser boots receive rootfs-owned OpenSSL defaults", async ({
  page,
  baseURL,
  browserName,
}) => {
  test.skip(
    browserName !== "chromium",
    "the aggregate browser gate uses Chromium",
  );
  expect(baseURL).toBeTruthy();

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

  await page.goto(new URL("/pages/test-runner/", baseURL).href);
  await page.waitForFunction(() => (window as any).__testRunnerReady === true);

  const programUrl = new URL(`/@fs/${programPath}`, baseURL).href;
  const results = await page.evaluate(
    async ({ programUrl, paths }) => {
      const response = await fetch(programUrl);
      if (!response.ok) {
        throw new Error(`program fetch failed: ${response.status}`);
      }
      const program = await response.arrayBuffer();
      const output = [];
      for (const path of paths) {
        output.push(
          await (window as any).__runTest(
            program.slice(0),
            ["mount_probe_test", "rootfs", path],
            30_000,
          ),
        );
      }
      return output;
    },
    { programUrl, paths: entries.map((entry) => entry.path) },
  );

  for (const [index, entry] of entries.entries()) {
    const result = results[index];
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain(`ROOTFS size=${entry.size}`);
    expect(result.stdout).toContain(`head=${entry.head}`);
    expect(result.stderr).toBe("");
  }
  expect(runtimeErrors).toEqual([]);
});
