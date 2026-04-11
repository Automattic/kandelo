/**
 * Tests for Erlang/OTP 28 BEAM VM running on the wasm-posix-kernel.
 *
 * BEAM requires specialized setup (thread pre-compilation, max_addr
 * protection, Erlang-specific boot args) so tests use the serve.ts
 * launcher as a subprocess rather than the generic test helper.
 */
import { describe, it, expect } from "vitest";
import { join, dirname } from "node:path";
import { existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, "../..");
const beamBinary = join(repoRoot, "examples/libs/erlang/bin/beam.wasm");
const serveScript = join(repoRoot, "examples/erlang/serve.ts");

const hasErlang = existsSync(beamBinary);

function runErlang(evalExpr: string, timeoutMs = 30_000): string {
  const result = execFileSync("npx", ["tsx", serveScript, "-eval", evalExpr], {
    cwd: repoRoot,
    timeout: timeoutMs,
    encoding: "utf-8",
    stdio: ["pipe", "pipe", "pipe"],
  });
  return result;
}

describe.skipIf(!hasErlang)("Erlang BEAM", () => {
  it("prints hello world", { timeout: 30_000 }, () => {
    const output = runErlang('io:format("Hello from BEAM!~n"), halt().');
    expect(output).toContain("Hello from BEAM!");
  });

  it("evaluates arithmetic", { timeout: 30_000 }, () => {
    const output = runErlang('io:format("~p~n", [2 + 3 * 7]), halt().');
    expect(output).toContain("23");
  });

  it("handles lists and pattern matching", { timeout: 30_000 }, () => {
    const output = runErlang(
      'L = [1,2,3,4,5], S = lists:sum(L), io:format("sum=~p~n", [S]), halt().'
    );
    expect(output).toContain("sum=15");
  });

  it("spawns lightweight processes", { timeout: 30_000 }, () => {
    const output = runErlang(
      'Self = self(), spawn(fun() -> Self ! done end), receive done -> io:format("process ok~n") end, halt().'
    );
    expect(output).toContain("process ok");
  });

  it("runs ring benchmark with message passing", { timeout: 30_000 }, () => {
    const output = runErlang("ring:start().");
    expect(output).toContain("Ring benchmark:");
    expect(output).toContain("Completed in");
  });
});
