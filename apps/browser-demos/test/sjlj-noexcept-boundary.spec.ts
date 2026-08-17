import { expect, test } from "@playwright/test";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { findRepoRoot, resolveBinary } from "../../../host/src/binary-resolver";

const __dirname = dirname(fileURLToPath(import.meta.url));
const browserKernelModulePath = resolve(
  __dirname,
  "../../../host/src/browser-kernel-host.ts",
);
const repoRoot = findRepoRoot();

const fixturePaths = {
  rawWasm32: join(
    repoRoot,
    "local-binaries/test-fixtures/wasm32/sjlj_noexcept_boundary.raw.wasm",
  ),
  rawWasm64: join(
    repoRoot,
    "local-binaries/test-fixtures/wasm64/sjlj_noexcept_boundary.raw.wasm",
  ),
  instrumented: resolveBinary("programs/sjlj_noexcept_boundary.wasm"),
  sigchld: resolveBinary("programs/sigchld_sjlj.wasm"),
};

test("Chromium preserves the SjLj controls and positive SIGCHLD path", async ({
  page,
  baseURL,
}) => {
  test.setTimeout(180_000);
  expect(baseURL).toBeTruthy();

  const asViteFsUrl = (path: string) =>
    new URL(`/@fs/${path}`, baseURL).href;
  const browserKernelModuleUrl = asViteFsUrl(browserKernelModulePath);
  const fixtureUrls = Object.fromEntries(
    Object.entries(fixturePaths).map(([name, path]) => [name, asViteFsUrl(path)]),
  );

  await page.goto(new URL("/trap-signal-test.html", baseURL).href);
  const results = await page.evaluate(
    async ({ browserKernelModuleUrl, fixtureUrls }) => {
      const { BrowserKernel } = await import(
        /* @vite-ignore */ browserKernelModuleUrl
      );
      const decoder = new TextDecoder();
      let stdout = "";
      let stderr = "";
      const kernel = new BrowserKernel({
        maxWorkers: 4,
        onStdout: (data: Uint8Array) => {
          stdout += decoder.decode(data);
        },
        onStderr: (data: Uint8Array) => {
          stderr += decoder.decode(data);
        },
      });
      let initialized = false;

      const run = async (url: string, argv: string[]) => {
        stdout = "";
        stderr = "";
        const response = await fetch(url);
        if (!response.ok) {
          throw new Error(`fixture fetch failed: ${response.status} ${url}`);
        }
        const exitCode = await kernel.spawn(await response.arrayBuffer(), argv);
        return { exitCode, stdout, stderr };
      };

      try {
        await kernel.initFromImage({ vfsImage: "default" });
        initialized = true;
        return {
          rawWasm32: await run(fixtureUrls.rawWasm32, [
            "sjlj_noexcept_boundary",
            "--noexcept",
          ]),
          instrumented: await run(fixtureUrls.instrumented, [
            "sjlj_noexcept_boundary",
            "--noexcept",
          ]),
          permissive: await run(fixtureUrls.instrumented, [
            "sjlj_noexcept_boundary",
            "--permissive",
          ]),
          sigchld: await run(fixtureUrls.sigchld, ["sigchld_sjlj"]),
          rawWasm64: await run(fixtureUrls.rawWasm64, [
            "sjlj_noexcept_boundary",
            "--noexcept",
          ]),
        };
      } finally {
        if (initialized) await kernel.destroy();
      }
    },
    { browserKernelModuleUrl, fixtureUrls },
  );

  for (const control of [
    results.rawWasm32,
    results.instrumented,
    results.rawWasm64,
  ]) {
    expect(control.exitCode).toBe(128 + 6);
    expect(control.stderr).toContain("HANDLER: siglongjmp");
    expect(control.stderr).toContain("libc++abi: terminating");
    expect(control.stdout).not.toContain("LANDING: siglongjmp resumed");
  }

  expect(results.permissive).toMatchObject({ exitCode: 0 });
  expect(results.permissive.stdout).toContain("LANDING: siglongjmp resumed");
  expect(results.sigchld).toMatchObject({ exitCode: 0 });
  expect(results.sigchld.stdout).toContain(
    "PASS: SIGCHLD siglongjmp resumed at pselect landing pad",
  );
});
