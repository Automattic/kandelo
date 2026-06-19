import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  assertAuthoritativeBrowserJobs,
  filterChunks,
  laneViteCacheDir,
  mergeLaneSummaries,
  planPortNumbers,
  planShards,
  type ChunkPlan,
  type SummaryRow,
} from "../../scripts/spidermonkey-browser-sharding";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, "..", "..");

function chunk(index: number, name: string, runnableJsFiles: number): ChunkPlan {
  return {
    index,
    suite: "jstests",
    chunk: name,
    runnableJsFiles,
    selectors: Array.from({ length: runnableJsFiles }, (_, i) => `${name}/test-${i}.js`),
  };
}

function row(laneId: string, chunkName: string, log = `/tmp/${laneId}-${chunkName}.log`): SummaryRow {
  return {
    laneId,
    host: "browser",
    suite: "jstests",
    chunk: chunkName,
    status: 0,
    pass: 1,
    knownSkip: 0,
    unexpected: 0,
    elapsedSeconds: 2,
    queueSeconds: 0,
    guestSeconds: 2,
    start: "2026-06-19T00:00:00Z",
    end: "2026-06-19T00:00:02Z",
    log,
  };
}

describe("SpiderMonkey browser sharding planner", () => {
  it("partitions planned chunks without duplicates or omissions", () => {
    const chunks = [
      chunk(0, "test262/built-ins/Array/prototype/every", 218),
      chunk(1, "test262/built-ins/Array/prototype/filter", 242),
      chunk(2, "test262/built-ins/Array/prototype/find", 23),
      chunk(3, "test262/built-ins/Array/prototype/flat", 19),
    ];

    const lanes = planShards(chunks, 2, planPortNumbers(2, 5624, 5724), "/tmp/results");
    const planned = new Set(chunks.map((c) => c.chunk));
    const assigned = lanes.flatMap((lane) => lane.chunks.map((c) => c.chunk));

    expect(new Set(assigned)).toEqual(planned);
    expect(assigned).toHaveLength(planned.size);
    expect(lanes.map((lane) => lane.vitePort)).toEqual([5624, 5625]);
    expect(lanes.map((lane) => lane.bridgePort)).toEqual([5724, 5725]);
    expect(lanes.every((lane) => lane.chunks.length > 0)).toBe(true);
  });

  it("allocates isolated Vite cache directories per lane", () => {
    const lanes = planShards(
      [
        chunk(0, "test262/built-ins/Array/prototype/every", 218),
        chunk(1, "test262/built-ins/Array/prototype/filter", 242),
      ],
      2,
      planPortNumbers(2, 6024, 6124),
      "/tmp/kandelo-spidermonkey-shards",
    );

    const cacheDirs = lanes.map(laneViteCacheDir);
    expect(cacheDirs).toEqual([
      "/tmp/kandelo-spidermonkey-shards/lane-1/vite-cache",
      "/tmp/kandelo-spidermonkey-shards/lane-2/vite-cache",
    ]);
    expect(new Set(cacheDirs)).toHaveLength(cacheDirs.length);
  });

  it("rejects overlapping lane port allocations", () => {
    expect(() => planPortNumbers(2, 5600, 5601)).toThrow(/duplicate lane port/);
  });

  it("preserves #part chunk names during explicit selection", () => {
    const chunks = [
      chunk(0, "test262/built-ins/Array/_files#part-0001", 500),
      chunk(1, "test262/built-ins/Array/_files#part-0002", 27),
    ];

    expect(filterChunks(chunks, ["jstests/test262/built-ins/Array/_files#part-0002"]))
      .toEqual([chunks[1]]);
  });
});

describe("SpiderMonkey browser sharding merge audit", () => {
  const planned = [
    chunk(0, "test262/built-ins/Array/prototype/every", 218),
    chunk(1, "test262/built-ins/Array/prototype/filter", 242),
  ];

  it("merges lane rows and preserves lane-local artifact paths", () => {
    const merged = mergeLaneSummaries(planned, [
      row("lane-1", planned[0].chunk, "/artifacts/lane-1/every.log"),
      row("lane-2", planned[1].chunk, "/artifacts/lane-2/filter.log"),
    ]);

    expect(merged.audit).toMatchObject({
      plannedChunks: 2,
      mergedChunks: 2,
      missingChunks: [],
      duplicateChunks: [],
      extraChunks: [],
    });
    expect(merged.rows.map((r) => r.log)).toEqual([
      "/artifacts/lane-1/every.log",
      "/artifacts/lane-2/filter.log",
    ]);
    expect(merged.totals.queueSeconds).toBe(0);
    expect(merged.totals.guestSeconds).toBe(4);
  });

  it("fails the merge on duplicate chunks", () => {
    expect(() => mergeLaneSummaries(planned, [
      row("lane-1", planned[0].chunk),
      row("lane-2", planned[0].chunk),
      row("lane-2", planned[1].chunk),
    ])).toThrow(/merge audit failed/);
  });

  it("fails the merge on missing chunks", () => {
    expect(() => mergeLaneSummaries(planned, [
      row("lane-1", planned[0].chunk),
    ])).toThrow(/merge audit failed/);
  });
});

describe("SpiderMonkey browser jobs guard", () => {
  it("treats browser --jobs greater than one through one bridge as non-authoritative", () => {
    expect(() => assertAuthoritativeBrowserJobs("browser", 2)).toThrow(/non-authoritative/);
    expect(() => assertAuthoritativeBrowserJobs("both", 2)).toThrow(/non-authoritative/);
    expect(() => assertAuthoritativeBrowserJobs("node", 2)).not.toThrow();
    expect(() => assertAuthoritativeBrowserJobs("browser", 1)).not.toThrow();
  });

  it("refuses unsafe browser jobs before starting the focused or exhaustive runner", () => {
    for (const script of [
      "scripts/run-spidermonkey-official-tests.sh",
      "scripts/run-spidermonkey-official-all.sh",
    ]) {
      const result = spawnSync(
        "bash",
        [join(repoRoot, script), "--host", "browser", "--suite", "jstests", "--jobs", "2"],
        { cwd: repoRoot, encoding: "utf8" },
      );

      expect(result.status, result.stderr).toBe(2);
      expect(result.stderr).toContain("non-authoritative");
    }
  });
});
