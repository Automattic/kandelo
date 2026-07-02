/**
 * Tests for Erlang/OTP 28 BEAM VM running on the kandelo.
 *
 * BEAM requires specialized setup (thread pre-compilation, max_addr
 * protection, Erlang-specific boot args) so tests use the serve.ts
 * launcher as a subprocess rather than the generic test helper.
 */
import { describe, it, expect } from "vitest";
import { join, dirname } from "node:path";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { tryResolveBinary, findRepoRoot } from "../../../../host/src/binary-resolver";

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

// Self-contained ring benchmark run via -eval. demo/ring.erl ships the
// same algorithm as readable reference source, but Erlang cannot compile
// modules on Kandelo yet: beam_asm hashes each module with erlang:md5/1
// over an iolist, and erlang:md5/1 returns badarg on iolist input in this
// wasm build (it works only on a binary) — tracked as kd-qe2c. So rather
// than loading a compiled ring.beam, the smoke drives spawn/2 and
// inter-process message passing across a ring directly with named funs.
// Kept small (50 procs x 10 rounds) so the compute finishes well inside
// serve.ts's 2s idle-exit watchdog (~0.06s locally).
const RING_EVAL = [
  "N = 50, M = 10,",
  'io:format("Ring benchmark: ~p processes, ~p rounds~n", [N, M]),',
  "Fwd = fun F(Next) -> receive token -> Next ! token, F(Next); stop -> ok end end,",
  "First = self(),",
  "Last = lists:foldl(fun(_, Nx) -> spawn(fun() -> Fwd(Nx) end) end, First, lists:seq(2, N)),",
  "T1 = erlang:monotonic_time(microsecond),",
  "Cnt = fun C(_, 0) -> ok; C(Nx, K) -> Nx ! token, receive token -> ok end, C(Nx, K - 1) end,",
  "Cnt(Last, M),",
  "T2 = erlang:monotonic_time(microsecond),",
  "El = T2 - T1,",
  'io:format("Completed in ~s seconds (~p us)~n", [erlang:float_to_list(El / 1.0e6, [{decimals, 3}]), El]),',
  'io:format("Total messages: ~p~n", [N * M]),',
  "halt().",
].join(" ");

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

  it("runs a ring benchmark with inter-process message passing", { timeout: 30_000 }, () => {
    const output = runErlang(RING_EVAL);
    expect(output).toContain("Ring benchmark: 50 processes, 10 rounds");
    expect(output).toContain("Completed in");
    expect(output).toContain("Total messages: 500");
  });
});
