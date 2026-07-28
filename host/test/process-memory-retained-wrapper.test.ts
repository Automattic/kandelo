import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const harnessPath = fileURLToPath(
  new URL("./fixtures/process-memory-retained-wrapper.ts", import.meta.url),
);
const tsxLoaderPath = fileURLToPath(
  new URL("../node_modules/tsx/dist/loader.mjs", import.meta.url),
);

type HarnessResult = {
  whileRetained: {
    observedFinalizations: number;
  };
  afterRelease: {
    observedFinalizations: number;
  };
};

describe("process-memory retirement telemetry negative control", () => {
  it("detects a retained typed-array wrapper until that alias is dropped", async () => {
    const { stdout, stderr } = await execFileAsync(
      process.execPath,
      ["--expose-gc", "--import", tsxLoaderPath, harnessPath],
      {
        timeout: 30_000,
        maxBuffer: 1024 * 1024,
      },
    );
    expect(stderr).toBe("");
    const result = JSON.parse(stdout.trim()) as HarnessResult;
    expect(result.whileRetained.observedFinalizations).toBe(1);
    expect(result.afterRelease.observedFinalizations).toBe(2);
  });
});
