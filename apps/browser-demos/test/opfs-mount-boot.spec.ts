import { expect, test } from "@playwright/test";

/**
 * Boot-level coverage for the `opfs` mount source: a kernel mounts a
 * persistent, origin-scoped OPFS workspace at /persist through the normal
 * VFS mount path. Data must survive kernel destroy/reboot and a full page
 * reload; POSIX gaps must fail with real errors; statfs must report real origin
 * quota; and a second concurrent mount of the same workspace must fail
 * loudly (single-writer boundary).
 */

const lockProbeModuleUrl = "/pages/test-runner/opfs-lock-probe.ts";

type RunResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
  combined: string;
};

type TestRunnerWindow = Window & {
  __testRunnerReady: boolean;
  __runTest(
    wasmBytes: ArrayBuffer,
    argv: string[],
    timeoutMs: number,
    options?: {
      opfsMounts?: Array<{ path: string; name: string }>;
    },
  ): Promise<RunResult>;
};

// Unique per spec execution so runs never observe a previous run's state.
const workspace = `proto-${Date.now().toString(36)}`;
const opfsMounts = [{ path: "/persist", name: workspace }];

async function gotoRunner(page: import("@playwright/test").Page) {
  await page.goto("/pages/test-runner/", { waitUntil: "domcontentloaded" });
  await page.waitForFunction(
    () => (window as unknown as TestRunnerWindow).__testRunnerReady === true,
  );
}

async function runShell(
  page: import("@playwright/test").Page,
  dashBytes: number[],
  command: string,
  mounts: Array<{ path: string; name: string }>,
): Promise<RunResult> {
  return page.evaluate(
    async ({ bytes, command, mounts }) =>
      (window as unknown as TestRunnerWindow).__runTest(
        new Uint8Array(bytes).buffer,
        ["dash", "-c", command],
        60_000,
        { opfsMounts: mounts },
      ),
    { bytes: dashBytes, command, mounts },
  );
}

async function loadDashBytes(): Promise<number[]> {
  const { readFile } = await import("node:fs/promises");
  const { resolveBinary } = await import("../../../host/src/binary-resolver");
  return Array.from(await readFile(resolveBinary("programs/dash.wasm")));
}

test.describe("opfs mount source", () => {
  test.beforeEach(({ browserName }) => {
    test.skip(
      browserName !== "chromium",
      "OPFS sync access handles are Chromium-only here",
    );
  });

  test("data written to /persist survives kernel reboot and page reload", async ({
    page,
  }) => {
    const dashBytes = await loadDashBytes();
    await gotoRunner(page);

    const write = await runShell(
      page,
      dashBytes,
      "echo persisted-bytes > /persist/state.txt; cat /persist/state.txt",
      opfsMounts,
    );
    expect(write.exitCode).toBe(0);
    expect(write.stdout).toContain("persisted-bytes");

    // Fresh kernel in the same page realm: the workspace lock from the
    // first kernel must have been released by destroy(), and the bytes
    // must come back from origin storage, not from kernel memory.
    const reread = await runShell(
      page,
      dashBytes,
      "cat /persist/state.txt",
      opfsMounts,
    );
    expect(reread.exitCode).toBe(0);
    expect(reread.stdout).toContain("persisted-bytes");

    // Full page reload: a brand-new JS realm and a third kernel.
    await gotoRunner(page);
    const afterReload = await runShell(
      page,
      dashBytes,
      "cat /persist/state.txt",
      opfsMounts,
    );
    expect(afterReload.exitCode).toBe(0);
    expect(afterReload.stdout).toContain("persisted-bytes");
  });

  test("unsupported POSIX operations fail with real errors instead of faking success", async ({
    page,
  }) => {
    const dashBytes = await loadDashBytes();
    await gotoRunner(page);

    const result = await runShell(
      page,
      dashBytes,
      "echo t > /persist/target; " +
        "ln /persist/target /persist/hard 2>/dev/null; echo hard=$?; " +
        "ln -s /persist/target /persist/sym 2>/dev/null; echo sym=$?; " +
        'stat -c "dirmode=%a" /persist; stat -c "filemode=%a" /persist/target',
      opfsMounts,
    );
    expect(result.exitCode).toBe(0);
    // coreutils ln exits nonzero when link()/symlink() return ENOTSUP.
    expect(result.stdout).not.toContain("hard=0");
    expect(result.stdout).not.toContain("sym=0");
    // OPFS has no permission model; the backend reports world-writable
    // modes (vfat-style) so non-root guest processes can use the mount.
    expect(result.stdout).toContain("dirmode=777");
    expect(result.stdout).toContain("filemode=666");
  });

  test("df on /persist reports the real origin storage quota", async ({
    page,
  }) => {
    const dashBytes = await loadDashBytes();
    await gotoRunner(page);

    const result = await runShell(page, dashBytes, "df -k /persist", opfsMounts);
    expect(result.exitCode).toBe(0);
    const line = result.stdout
      .split("\n")
      .find((l) => l.trimEnd().endsWith("/persist"));
    expect(line, `df output:\n${result.stdout}`).toBeTruthy();
    const [, blocks] = line!.trim().split(/\s+/);
    // A quota-backed filesystem is nonempty; a zero here would mean the
    // mount is misreporting the backing store.
    expect(Number(blocks)).toBeGreaterThan(0);
  });

  test("a workspace nested under a scratch mount is listed by its parent", async ({
    page,
  }) => {
    const dashBytes = await loadDashBytes();
    await gotoRunner(page);
    // /home/maker is a scratch mount in DEFAULT_MOUNT_SPEC. The mounted-over
    // directory must exist in that mount, or `ls` of the home directory
    // omits a mount a process can nevertheless cd into.
    const nested = [{ path: "/home/maker/.fdoom.tar", name: `${workspace}-nested` }];
    const listing = await runShell(
      page,
      dashBytes,
      "ls -a /home/maker; echo listed=$?; cd /home/maker/.fdoom.tar && pwd",
      nested,
    );
    expect(listing.exitCode).toBe(0);
    expect(listing.stdout).toContain(".fdoom.tar");
    expect(listing.stdout).toContain("listed=0");
    expect(listing.stdout).toContain("/home/maker/.fdoom.tar");
  });

  test("a second kernel cannot mount a workspace another kernel holds", async ({
    page,
  }) => {
    await gotoRunner(page);
    const result = await page.evaluate(
      async ({ moduleUrl, name }) => {
        const { probeWorkspaceLockConflict } = await import(moduleUrl);
        return probeWorkspaceLockConflict(name);
      },
      { moduleUrl: lockProbeModuleUrl, name: `${workspace}-lock` },
    );
    expect(result.firstBooted).toBe(true);
    expect(result.secondError).toContain("already mounted");
  });

  test("duplicate mount paths are rejected before any workspace lock is taken", async ({
    page,
  }) => {
    await gotoRunner(page);
    const result = await page.evaluate(
      async ({ moduleUrl, name }) => {
        const { probeDuplicateMountPath } = await import(moduleUrl);
        return probeDuplicateMountPath(name);
      },
      { moduleUrl: lockProbeModuleUrl, name: `${workspace}-dup` },
    );
    expect(result.duplicateError).toContain("duplicate OPFS mount path");
    expect(result.lockHeldAfterFailure).toBe(false);
    expect(result.retryBooted).toBe(true);
  });

  test.afterAll(async ({ browser }) => {
    // Remove this run's workspaces so repeated runs do not accumulate
    // origin storage. Scoped strictly to the names this spec created.
    const page = await browser.newPage();
    try {
      await page.goto("/pages/test-runner/", { waitUntil: "domcontentloaded" });
      await page.evaluate(async (names) => {
        // Engines without an OPFS surface have nothing to clean up.
        const root = await navigator.storage.getDirectory().catch(() => null);
        if (!root) return;
        const container = await root
          .getDirectoryHandle("kandelo-opfs")
          .catch(() => null);
        if (!container) return;
        for (const name of names) {
          await container.removeEntry(name, { recursive: true }).catch(() => {});
        }
      }, [
        workspace,
        `${workspace}-lock`,
        `${workspace}-nested`,
        `${workspace}-dup-a`,
        `${workspace}-dup-b`,
      ]);
    } finally {
      await page.close();
    }
  });
});
