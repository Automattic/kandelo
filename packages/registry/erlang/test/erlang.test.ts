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
  // erlang.wasm is compiled with -fwasm-exceptions, which emits the
  // `exn` value type. Node 24 keeps the wasm-exnref proposal behind a
  // flag, and NODE_OPTIONS doesn't accept --experimental-* flags, so
  // the spawned subprocess must receive it directly. The kernel
  // worker_thread that serve.ts spins up inherits process.execArgv.
  const result = execFileSync(
    process.execPath,
    ["--experimental-wasm-exnref", "--import", "tsx", serveScript, "-eval", evalExpr],
    {
      cwd: repoRoot,
      timeout: timeoutMs,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
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
