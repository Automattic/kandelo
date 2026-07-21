/**
 * Tests for Erlang/OTP 28 BEAM VM running on the kandelo.
 *
 * BEAM requires specialized setup (thread pre-compilation, max_addr
 * protection, Erlang-specific boot args) so tests use the serve.ts
 * launcher as a subprocess rather than the generic test helper.
 */
import { describe, it, expect, beforeAll } from "vitest";
import { join, dirname } from "node:path";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { tryResolveBinary, findRepoRoot } from "../../../../host/src/binary-resolver";
import {
  cases as miscompCases,
  activeCases,
  pendingCases,
  buildBatchProgram,
  parseBatchOutput,
  type BatchResult,
} from "./wasm32-miscompilation-matrix";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = findRepoRoot();
const beamBinary = tryResolveBinary("programs/erlang/erlang.wasm");
const serveScript = join(repoRoot, "packages/registry/erlang/demo/serve.ts");

// serve.ts passes -root/-bindir/-boot pointing at
// `packages/registry/erlang/erlang-install/` on the host; NodeKernelHost
// passes those paths through to the BEAM emulator. Without the
// install tree, BEAM crashes during boot. The tree comes from
// `bash packages/registry/erlang/build-erlang.sh` (a full source build);
// the binaries-abi-v6 release ships only erlang.wasm. Skip when the
// host-side OTP runtime isn't present — re-running this test on a
// machine without a local erlang build is an environment setup
// issue, not a regression.
const installDir = join(repoRoot, "packages/registry/erlang/erlang-install");
const hasErlang = !!beamBinary && existsSync(installDir);

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

// wasm32 -O2 miscompilation detection matrix (kd-jin7 / kd-r8h7 Layer A).
// The matrix source (oracles + Erlang exprs) lives in
// ./wasm32-miscompilation-matrix.ts and is shared with the CI gate runner
// (test/run-wasm32-miscompilation-smoke.mjs) so coverage cannot drift.
//
// This local runner is a dev convenience: it `skipIf`s without a local erlang
// build, exactly like the suite above. The AUTHORITATIVE runner is the CI gate,
// which has the OTP runtime tree. To keep this cheap even locally, the whole
// matrix runs in ONE BEAM boot (startup dominates), and each case asserts its
// own line so a failure names the offending operation. Cases whose `-O1`/patch
// is not yet on this base (e.g. chksum/compile behind PR #824) are reported as
// pending skips rather than run.
describe.skipIf(!hasErlang)("wasm32 -O2 miscompilation smoke matrix", () => {
  let batch: BatchResult;

  beforeAll(() => {
    const output = runErlang(buildBatchProgram(), 120_000);
    batch = parseBatchOutput(output, miscompCases.length);
  }, 130_000);

  it("runs the whole matrix to completion (no silent truncation)", () => {
    expect(batch.completed).toBe(true);
    // No case may FAIL; the message surfaces the expected/got on regression.
    expect([...batch.failures.values()]).toEqual([]);
  });

  for (const c of activeCases()) {
    it(`${c.name} — ${c.exercises}`, () => {
      const detail =
        batch.failures.get(c.name) ?? `no 'ok ${c.name}' line in BEAM output`;
      expect(batch.ok.has(c.name), detail).toBe(true);
    });
  }

  for (const c of pendingCases()) {
    // Not a bug: the guarding workaround lands with its PR; flip in that change.
    it.skip(`${c.name} — pending PR #${c.pendingPr} (${c.exercises})`, () => {});
  }
});
