import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const MIB = 1024 * 1024;
const WAVE_CHILDREN = 8;
const WAVE_COUNT = 32;
const harnessPath = fileURLToPath(
  new URL("./fixtures/process-memory-reclamation-rss.ts", import.meta.url),
);
const tsxLoaderPath = fileURLToPath(
  new URL("../node_modules/tsx/dist/loader.mjs", import.meta.url),
);

type HarnessResult = {
  childMiB: number;
  pressureBytes: number;
  samples: Array<{
    completedChildren: number;
    rssBytes: number;
  }>;
  slopeBytesPerChild: number;
  slopeMiBPerChild: number;
  lateGrowthBytes: number;
  lateGrowthMiB: number;
  stderr: string[];
  diagnostics: string[];
};

describe("process-memory reclamation under real sequential spawn churn", () => {
  it(
    "makes exact-fenced retired memories collectible under bounded pressure",
    async () => {
      // WHY: Vitest itself owns workers and shared memories, so RSS measured
      // inside its process is not attributable to this lifecycle. The
      // allocator's fixed, bounded ordinary ArrayBuffer pressure is collection
      // evidence, not an engine API or a scheduling promise.
      const { stdout, stderr } = await execFileAsync(
        process.execPath,
        ["--import", tsxLoaderPath, harnessPath],
        {
          cwd: fileURLToPath(new URL("../..", import.meta.url)),
          env: {
            ...process.env,
            KANDELO_RECLAIM_WARMUP_CHILDREN: "4",
            KANDELO_RECLAIM_WAVE_CHILDREN: String(WAVE_CHILDREN),
            KANDELO_RECLAIM_WAVES: String(WAVE_COUNT),
            KANDELO_RECLAIM_CHILD_MIB: "8",
            KANDELO_RECLAIM_PRESSURE_BYTES: String(4 * MIB),
          },
          maxBuffer: 8 * MIB,
          timeout: 180_000,
        },
      );
      // Same allowance as ordinary-process-exit.test.ts: locally built
      // fixtures are unstamped, and the worker's documented
      // kandelo.abi.contract warning is not a reclamation diagnostic.
      const unexpectedStderr = stderr
        .split("\n")
        .filter((line) => !line.includes("lacks a kandelo.abi.contract stamp"))
        .join("\n");
      expect(unexpectedStderr).toBe("");

      const lines = stdout.trim().split("\n");
      const result = JSON.parse(lines.at(-1) ?? "") as HarnessResult;
      expect(result.stderr).toEqual([]);
      expect(result.diagnostics).toEqual([]);
      expect(result.samples.map((sample) => sample.completedChildren)).toEqual(
        Array.from({ length: WAVE_COUNT + 1 }, (_, wave) => wave * WAVE_CHILDREN),
      );
      expect(result.pressureBytes).toBe(4 * MIB);

      // A stale listener, Worker, lease, or process-table reference would keep
      // the retired Memory live even when ordinary allocation pressure makes
      // the engine collect. Permit noise, but reject history-proportional
      // retention. WHY: 48 children can end during startup/collection growth:
      // the same process failed that short window, then leveled off at 256.
      // Keep one persistent host and the original limits; restarting or
      // forcing GC would hide the history this test must observe. See
      // docs/measurements/2026-10-20-process-memory-rss-window.md.
      expect(
        result.slopeBytesPerChild,
        JSON.stringify(result),
      ).toBeLessThanOrEqual(2 * MIB);
      expect(
        result.lateGrowthBytes,
        JSON.stringify(result),
      ).toBeLessThanOrEqual(64 * MIB);
    },
    200_000,
  );
});
