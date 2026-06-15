import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createIsolatedTests,
  destroyNodeHostBestEffort,
  envForRun,
  terminateTimedOutNodeHostBestEffort,
  writePrelude,
  type SelectedTest,
} from "../../scripts/node-core-official-runner";

function selected(path: string): SelectedTest {
  return {
    spec: {
      path,
      area: "fs",
      expected: "PASS",
    },
    expected: "PASS",
    reason: "test",
    timeoutMs: 30_000,
  };
}

function envMap(entries: string[]): Map<string, string> {
  return new Map(entries.map((entry) => {
    const index = entry.indexOf("=");
    return [entry.slice(0, index), entry.slice(index + 1)];
  }));
}

describe("node-core official runner isolation", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("assigns unique tmpdir identity env to each selected test", () => {
    const resultsDir = "/tmp/kandelo-node-core-results";
    const isolated = createIsolatedTests([
      selected("test/parallel/test-fs-mkdtemp.js"),
      selected("test/parallel/test-fs-append-file.js"),
    ], resultsDir);

    expect(isolated.map((item) => item.isolation.serialId)).toEqual(["1", "2"]);
    expect(isolated[0].isolation.nodeTestDir).toBe(
      join(resultsDir, "node-test-roots", "1-test_parallel_test-fs-mkdtemp.js"),
    );
    expect(isolated[1].isolation.nodeTestDir).toBe(
      join(resultsDir, "node-test-roots", "2-test_parallel_test-fs-append-file.js"),
    );
    expect(isolated[0].isolation.browserTestDir).toBe(
      "/node-v22.0.0/.kandelo-test-roots/1-test_parallel_test-fs-mkdtemp.js",
    );
    expect(isolated[0].isolation.browserMarkerPath).toBe(
      "/node-v22.0.0/.kandelo-test-roots/1-test_parallel_test-fs-mkdtemp.js/.keep",
    );

    const firstEnv = envMap(envForRun(isolated[0].isolation));
    const secondEnv = envMap(envForRun(isolated[1].isolation));
    expect(firstEnv.get("NODE_TEST_DIR")).toBe(isolated[0].isolation.nodeTestDir);
    expect(firstEnv.get("TEST_SERIAL_ID")).toBe("1");
    expect(firstEnv.get("TEST_THREAD_ID")).toBe("1");
    expect(secondEnv.get("NODE_TEST_DIR")).toBe(isolated[1].isolation.nodeTestDir);
    expect(secondEnv.get("TEST_SERIAL_ID")).toBe("2");
    expect(secondEnv.get("TEST_THREAD_ID")).toBe("2");
  });

  it("overrides inherited identity env and can target browser VFS roots", () => {
    const previousNodeTestDir = process.env.NODE_TEST_DIR;
    const previousSerialId = process.env.TEST_SERIAL_ID;
    const previousThreadId = process.env.TEST_THREAD_ID;
    const previousPath = process.env.PATH;
    process.env.NODE_TEST_DIR = "/stale";
    process.env.TEST_SERIAL_ID = "0";
    process.env.TEST_THREAD_ID = "0";
    process.env.PATH = "/host/path/that/does/not/belong/in/guest";

    try {
      const [isolated] = createIsolatedTests([
        selected("test/parallel/test-module-loading-globalpaths.js"),
      ], "/tmp/kandelo-node-core-results");
      const browserEnv = envMap(envForRun({
        ...isolated.isolation,
        nodeTestDir: isolated.isolation.browserTestDir,
      }));

      expect(browserEnv.get("NODE_TEST_DIR")).toBe(isolated.isolation.browserTestDir);
      expect(browserEnv.get("TEST_SERIAL_ID")).toBe("1");
      expect(browserEnv.get("TEST_THREAD_ID")).toBe("1");
      expect(browserEnv.get("PATH")).toBe("/usr/local/bin:/usr/bin:/bin");
      expect(browserEnv.get("HOME")).toBe("/tmp");
      expect(browserEnv.has("npm_execpath")).toBe(false);
    } finally {
      restoreEnv("NODE_TEST_DIR", previousNodeTestDir);
      restoreEnv("TEST_SERIAL_ID", previousSerialId);
      restoreEnv("TEST_THREAD_ID", previousThreadId);
      restoreEnv("PATH", previousPath);
    }
  });
});

describe("node-core official runner prelude", () => {
  it("installs SpiderMonkey shims for common helper diagnostics", () => {
    const dir = mkdtempSync(join(tmpdir(), "kandelo-node-core-prelude-"));
    try {
      const prelude = readFileSync(writePrelude(dir), "utf8");

      expect(prelude).toContain("__kandeloSpiderMonkeyCallSite");
      expect(prelude).toContain("Math.max(1, frame.line - 1)");
      expect(prelude).toContain("new assert.AssertionError");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("node-core official runner cleanup", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("bounds timed-out Node-host process termination cleanup", async () => {
    vi.useFakeTimers();
    const host = {
      terminateProcess: vi.fn(() => new Promise<void>(() => {})),
    };

    const cleanup = terminateTimedOutNodeHostBestEffort(host, 123);
    await vi.advanceTimersByTimeAsync(5_000);

    await expect(cleanup).resolves.toBeUndefined();
    expect(host.terminateProcess).toHaveBeenCalledWith(123, 124);
  });

  it("does not terminate when a timed-out test never reported a pid", async () => {
    const host = {
      terminateProcess: vi.fn(() => Promise.resolve()),
    };

    await terminateTimedOutNodeHostBestEffort(host, null);

    expect(host.terminateProcess).not.toHaveBeenCalled();
  });

  it("bounds Node-host destroy cleanup", async () => {
    vi.useFakeTimers();
    const host = {
      destroy: vi.fn(() => new Promise<void>(() => {})),
    };

    const cleanup = destroyNodeHostBestEffort(host);
    await vi.advanceTimersByTimeAsync(5_000);

    await expect(cleanup).resolves.toBeUndefined();
    expect(host.destroy).toHaveBeenCalledOnce();
  });
});

function restoreEnv(key: string, value: string | undefined): void {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}
