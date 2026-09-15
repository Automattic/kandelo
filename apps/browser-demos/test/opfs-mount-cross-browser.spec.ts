import { expect, test } from "@playwright/test";

/**
 * Cross-browser contract for the `opfs` mount source. Chromium coverage
 * lives in opfs-mount-boot.spec.ts; this spec pins the other engines to
 * observed behavior: Firefox supports the full mount path, and WebKit
 * (whose OPFS surface is unavailable in this harness) must reject the
 * boot with an explicit proxy-init error instead of silently producing
 * a memory-only machine.
 */

type RunResult = { exitCode: number; stdout: string; stderr: string };

type TestRunnerWindow = Window & {
  __testRunnerReady: boolean;
  __runTest(
    wasmBytes: ArrayBuffer,
    argv: string[],
    timeoutMs: number,
    options?: { opfsMounts?: Array<{ path: string; name: string }> },
  ): Promise<RunResult>;
};

const workspace = `xbrowser-${Date.now().toString(36)}`;

async function gotoRunner(page: import("@playwright/test").Page) {
  await page.goto("/pages/test-runner/", { waitUntil: "domcontentloaded" });
  await page.waitForFunction(
    () => (window as unknown as TestRunnerWindow).__testRunnerReady === true,
    undefined,
    { timeout: 120_000 },
  );
}

async function loadDashBytes(): Promise<number[]> {
  const { readFile } = await import("node:fs/promises");
  const { resolveBinary } = await import("../../../host/src/binary-resolver");
  return Array.from(await readFile(resolveBinary("programs/dash.wasm")));
}

function runShell(
  page: import("@playwright/test").Page,
  dashBytes: number[],
  command: string,
): Promise<RunResult> {
  return page.evaluate(
    async ({ bytes, command, name }) =>
      (window as unknown as TestRunnerWindow).__runTest(
        new Uint8Array(bytes).buffer,
        ["dash", "-c", command],
        90_000,
        { opfsMounts: [{ path: "/persist", name }] },
      ),
    { bytes: dashBytes, command, name: workspace },
  );
}

test("Firefox mounts an opfs workspace and persists across kernels", async ({
  page,
  browserName,
}) => {
  test.skip(browserName !== "firefox", "Firefox-specific coverage");
  const dashBytes = await loadDashBytes();
  await gotoRunner(page);

  const write = await runShell(
    page,
    dashBytes,
    "echo firefox-persisted > /persist/state.txt; cat /persist/state.txt",
  );
  expect(write.exitCode).toBe(0);
  expect(write.stdout).toContain("firefox-persisted");

  // A fresh kernel in the same page must read the bytes back from origin
  // storage after the first kernel released the workspace lock.
  const reread = await runShell(page, dashBytes, "cat /persist/state.txt");
  expect(reread.exitCode).toBe(0);
  expect(reread.stdout).toContain("firefox-persisted");

  // Clean up this run's workspace.
  await page.evaluate(async (name) => {
    const root = await navigator.storage.getDirectory();
    const container = await root
      .getDirectoryHandle("kandelo-opfs")
      .catch(() => null);
    await container?.removeEntry(name, { recursive: true }).catch(() => {});
  }, workspace);
});

test("WebKit rejects the boot loudly when the OPFS proxy cannot start", async ({
  page,
  browserName,
}) => {
  test.skip(browserName !== "webkit", "WebKit-specific coverage");
  const dashBytes = await loadDashBytes();
  await gotoRunner(page);

  const outcome = await page.evaluate(
    async ({ bytes, name }) => {
      try {
        await (window as unknown as TestRunnerWindow).__runTest(
          new Uint8Array(bytes).buffer,
          ["dash", "-c", "true"],
          90_000,
          { opfsMounts: [{ path: "/persist", name }] },
        );
        return { booted: true, message: "" };
      } catch (error) {
        return {
          booted: false,
          message: error instanceof Error ? error.message : String(error),
        };
      }
    },
    { bytes: dashBytes, name: workspace },
  );

  // A workspace the engine cannot back must fail the boot with a specific
  // error, never degrade to a memory-only machine presented as persistent.
  expect(outcome.booted).toBe(false);
  expect(outcome.message).toContain("OPFS proxy worker init failed");
  expect(outcome.message).toContain(workspace);
});
