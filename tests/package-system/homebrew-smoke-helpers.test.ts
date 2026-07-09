import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  browserCaseNamesForFormula,
  browserSmokeCasesForFormula,
  browserUnsupportedReason,
  parseHomebrewSmokeFormula,
  SQLITE_BROWSER_CONSUMER_PATH,
} from "../../scripts/homebrew-package-smoke-cases";
import {
  countOutcomes,
  writeOutcomeLists,
  type SmokeOutcome,
} from "../../scripts/homebrew-smoke-outcomes";

describe("Homebrew package smoke helpers", () => {
  it("plans concrete browser cases for pilot packages", () => {
    expect(browserCaseNamesForFormula("bzip2")).toEqual(["bzip2_help"]);
    expect(browserCaseNamesForFormula("xz")).toEqual(["xz_version"]);
    expect(browserCaseNamesForFormula("sqlite")).toEqual(["sqlite_basic_consumer"]);

    const bzip2 = browserSmokeCasesForFormula("bzip2")[0];
    expect(bzip2.command).toContain("/home/linuxbrew/.linuxbrew/bin/bzip2 --help");
    expect(bzip2.argv).toEqual(["/home/linuxbrew/.linuxbrew/bin/bzip2", "--help"]);
    expect(bzip2.expected.test("bzip2, a block-sorting file compressor")).toBe(true);

    const sqlite = browserSmokeCasesForFormula("sqlite")[0];
    expect(sqlite.command).toBe(SQLITE_BROWSER_CONSUMER_PATH);
    expect(sqlite.argv).toEqual([SQLITE_BROWSER_CONSUMER_PATH]);
    expect(sqlite.expected.test("PASS")).toBe(true);
  });

  it("classifies supported formulas and the current wasm64 browser boundary", () => {
    expect(parseHomebrewSmokeFormula("hello")).toBe("hello");
    expect(parseHomebrewSmokeFormula("sqlite")).toBe("sqlite");
    expect(() => parseHomebrewSmokeFormula("zlib")).toThrow(/formula must be/);
    expect(browserUnsupportedReason("wasm32")).toBeUndefined();
    expect(browserUnsupportedReason("wasm64")).toMatch(/wasm64 browser compatibility is unsupported/);
  });

  it("writes passed, failed, and skipped outcome lists with browser artifact paths", () => {
    const dir = mkdtempSync(join(tmpdir(), "kandelo-homebrew-smoke-"));
    try {
      const outcomes: SmokeOutcome[] = [
        {
          name: "browser_smoke_bzip2_help",
          status: "pass",
          durationMs: 12,
          details: "terminal command passed",
          artifactPath: "/tmp/terminal.txt",
        },
        {
          name: "browser_smoke_xz_version",
          status: "fail",
          durationMs: 34,
          error: "terminal command exited 1",
          artifactPath: "/tmp/trace.zip",
        },
        {
          name: "browser_smoke_sqlite_consumer",
          status: "skip",
          durationMs: 0,
          details: "sqlite consumer compiler is unavailable",
          artifactPath: "/tmp/sqlite",
        },
      ];
      writeOutcomeLists(dir, outcomes, { includeArtifactPath: true });

      expect(countOutcomes(outcomes)).toEqual({ pass: 1, fail: 1, skip: 1 });
      expect(readFileSync(join(dir, "outcome-lists", "passed-tests.tsv"), "utf8"))
        .toContain("test\tduration_ms\tdetails\tartifact_path");
      expect(readFileSync(join(dir, "outcome-lists", "failed-tests.tsv"), "utf8"))
        .toContain("browser_smoke_xz_version\t34\tterminal command exited 1\t/tmp/trace.zip");
      expect(readFileSync(join(dir, "outcome-lists", "skipped-tests.tsv"), "utf8"))
        .toContain("browser_smoke_sqlite_consumer\tsqlite consumer compiler is unavailable\t/tmp/sqlite");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
