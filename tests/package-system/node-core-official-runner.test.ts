import { describe, expect, it } from "vitest";
import { join } from "node:path";
import {
  createIsolatedTests,
  envForRun,
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
    process.env.NODE_TEST_DIR = "/stale";
    process.env.TEST_SERIAL_ID = "0";
    process.env.TEST_THREAD_ID = "0";

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
    } finally {
      restoreEnv("NODE_TEST_DIR", previousNodeTestDir);
      restoreEnv("TEST_SERIAL_ID", previousSerialId);
      restoreEnv("TEST_THREAD_ID", previousThreadId);
    }
  });
});

function restoreEnv(key: string, value: string | undefined): void {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}
