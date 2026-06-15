import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createIsolatedTests,
  destroyNodeHostBestEffort,
  envForRun,
  nodeArgvForOfficialTest,
  nodeExecProgramsForOfficialTest,
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
    const previousNixFlags = process.env.NIX_CFLAGS_COMPILE;
    const previousNpmCommand = process.env.npm_command;
    process.env.NODE_TEST_DIR = "/stale";
    process.env.TEST_SERIAL_ID = "0";
    process.env.TEST_THREAD_ID = "0";
    process.env.PATH = "/custom/bin:/usr/bin";
    process.env.NIX_CFLAGS_COMPILE = "x".repeat(10_000);
    process.env.npm_command = "exec";

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
      expect(browserEnv.get("PATH")).toBe("/usr/bin:/bin");
      expect(browserEnv.has("NIX_CFLAGS_COMPILE")).toBe(false);
      expect(browserEnv.has("npm_command")).toBe(false);
    } finally {
      restoreEnv("NODE_TEST_DIR", previousNodeTestDir);
      restoreEnv("TEST_SERIAL_ID", previousSerialId);
      restoreEnv("TEST_THREAD_ID", previousThreadId);
      restoreEnv("PATH", previousPath);
      restoreEnv("NIX_CFLAGS_COMPILE", previousNixFlags);
      restoreEnv("npm_command", previousNpmCommand);
    }
  });

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

  it("forwards official dotenv flags behind the SpiderMonkey argv separator", () => {
    const root = mkdtempSync(join(tmpdir(), "kandelo-node-core-flags-"));
    try {
      const testPath = join(root, "test-dotenv-node-options.js");
      writeFileSync(testPath, "// Flags: --env-file=.env --conditions demo\n");

      expect(nodeArgvForOfficialTest("/prelude.js", "/test.js", testPath)).toEqual([
        "node",
        "--",
        "--env-file=.env",
        "/prelude.js",
        "/test.js",
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("uses the SpiderMonkey argv separator for official tests without flags", () => {
    const root = mkdtempSync(join(tmpdir(), "kandelo-node-core-flags-"));
    try {
      const testPath = join(root, "test-plain.js");
      writeFileSync(testPath, "console.log(process.argv[1]);\n");

      expect(nodeArgvForOfficialTest("/prelude.js", "/test.js", testPath)).toEqual([
        "node",
        "--",
        "/prelude.js",
        "/test.js",
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("generates a prelude that presents the official test as argv[1]", () => {
    const root = mkdtempSync(join(tmpdir(), "kandelo-node-core-prelude-"));
    try {
      const preludePath = writePrelude(root);
      const source = readFileSync(preludePath, "utf8");
      expect(source).toContain("process.argv = [process.argv[0], testFile];");
      expect(source).not.toContain("process.argv[1] = testFile;");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("maps Node official self-exec and shell paths to wasm programs", () => {
    expect(nodeExecProgramsForOfficialTest(
      "/repo/node.wasm",
      "/repo/sh.wasm",
      "/repo/coreutils.wasm",
    )).toEqual({
      "node": "/repo/node.wasm",
      "/bin/node": "/repo/node.wasm",
      "/usr/bin/node": "/repo/node.wasm",
      "/usr/local/bin/node": "/repo/node.wasm",
      "sh": "/repo/sh.wasm",
      "/bin/sh": "/repo/sh.wasm",
      "/usr/bin/sh": "/repo/sh.wasm",
      "env": "/repo/coreutils.wasm",
      "/bin/env": "/repo/coreutils.wasm",
      "/usr/bin/env": "/repo/coreutils.wasm",
    });
  });

  it("keeps Node official shell and utility mappings optional", () => {
    expect(nodeExecProgramsForOfficialTest("/repo/node.wasm", null, null)).toEqual({
      "node": "/repo/node.wasm",
      "/bin/node": "/repo/node.wasm",
      "/usr/bin/node": "/repo/node.wasm",
      "/usr/local/bin/node": "/repo/node.wasm",
    });
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
