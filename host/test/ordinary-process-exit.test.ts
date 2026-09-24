import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "../..");
const fixturePath = join(
  repoRoot,
  "host/test/fixtures/ordinary-nonzero-exit.ts",
);

describe("ordinary process exit diagnostics", () => {
  it("keeps a nonzero exit out of the embedding Node process stderr", () => {
    const child = spawnSync(
      process.execPath,
      ["--import", "tsx", fixturePath],
      {
        cwd: repoRoot,
        encoding: "utf8",
        timeout: 30_000,
      },
    );

    expect(child.error).toBeUndefined();
    expect(child.signal).toBeNull();
    expect(child.status, child.stderr).toBe(0);
    // Locally built test fixtures come from scripts/build-programs.sh, which
    // emits raw SDK output without the kandelo.abi.contract stamp; the worker
    // then prints its documented legacy-binary warning. That intended
    // diagnostic is not the "nonzero exit leaked to stderr" failure this test
    // guards against, so it is the one line allowed here.
    const unexpectedStderr = child.stderr
      .split("\n")
      .filter((line) => !line.includes("lacks a kandelo.abi.contract stamp"))
      .join("\n");
    expect(unexpectedStderr).toBe("");

    const result = JSON.parse(child.stdout) as {
      exitCode: number;
      stdout: string;
      stderr: string;
      hostDiagnostics: unknown[];
    };
    expect(result.exitCode).toBe(42);
    expect(result.stdout).toContain("argv[0]=exec-child");
    expect(result.stderr).toBe("");
    expect(result.hostDiagnostics).toEqual([]);
  });
});
