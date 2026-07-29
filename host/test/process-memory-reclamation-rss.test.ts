import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const MIB = 1024 * 1024;
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
            KANDELO_RECLAIM_WAVE_CHILDREN: "8",
            KANDELO_RECLAIM_WAVES: "6",
            KANDELO_RECLAIM_CHILD_MIB: "8",
          },
          maxBuffer: 8 * MIB,
          timeout: 180_000,
        },
      );
      expect(stderr).toBe("");

      const lines = stdout.trim().split("\n");
      const result = JSON.parse(lines.at(-1) ?? "") as HarnessResult;
      expect(result.stderr).toEqual([]);
      expect(result.diagnostics).toEqual([]);
      expect(result.samples).toHaveLength(7);
      expect(result.pressureBytes).toBe(32 * MIB);

      // A stale listener, Worker, lease, or process-table reference would keep
      // the retired Memory live even when ordinary allocation pressure makes
      // the engine collect. Permit noise, but reject history-proportional
      // retention.
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
