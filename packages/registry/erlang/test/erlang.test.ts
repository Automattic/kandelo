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

// Regression coverage for kd-qe2c: erlang:md5/1 must accept iodata (binary OR
// iolist), matching OTP semantics. On the wasm32 BEAM, do_chksum() in
// erl_bif_chksum.c (the shared routine behind md5/crc32/adler32) was
// miscompiled at -O2 by LLVM and returned badarg for any non-empty
// list/iolist, while binaries worked. That broke beam_asm — which hashes each
// module's chunks as an iolist via erlang:md5/1 — so no module could be
// compiled on Kandelo (erlc/compile:file/compile:forms all failed). The fix
// compiles erl_bif_chksum.c at -O1 in build-erlang.sh, alongside erl_unicode.c
// and the ETS files already handled the same way.
describe.skipIf(!hasErlang)("Erlang md5 iodata (kd-qe2c)", () => {
  it("hashes a byte list the same as the equivalent binary", { timeout: 30_000 }, () => {
    const output = runErlang(
      'B = erlang:md5(<<"abc">>), L = erlang:md5("abc"),'
      + ' io:format("eq=~p digest=~w~n", [B =:= L, L]), halt().'
    );
    expect(output).toContain("eq=true");
    // MD5("abc") = 900150983cd24fb0d6963f7d28e17f72
    expect(output).toContain(
      "digest=<<144,1,80,152,60,210,79,176,214,150,63,125,40,225,127,114>>"
    );
  });

  it("hashes a mixed iolist (binaries, strings, chars, nesting)", { timeout: 30_000 }, () => {
    // [<<"He">>,"ll",[111]," ",<<"world">>] flattens to "Hello world".
    const output = runErlang(
      'A = erlang:md5([<<"He">>,"ll",[111]," ",<<"world">>]),'
      + ' B = erlang:md5(<<"Hello world">>),'
      + ' io:format("eq=~p~n", [A =:= B]), halt().'
    );
    expect(output).toContain("eq=true");
  });

  it("compiles and loads a module on Kandelo (beam_asm md5-over-iolist)", { timeout: 30_000 }, () => {
    // beam_asm:build_file/8 md5-hashes the module chunk iolist; before the fix
    // this failed with "internal error in pass beam_asm: bad argument in
    // erlang:md5/1". compiler-*/ebin isn't on start_clean's path, so add it.
    const output = runErlang(
      '[CompEbin|_] = filelib:wildcard(filename:join([code:root_dir(),"lib","compiler-*","ebin"])),'
      + ' code:add_pathz(CompEbin),'
      + ' Forms = [{attribute,1,module,kd_qe2c_smoke},{attribute,2,export,[{f,0}]},'
      + '          {function,3,f,0,[{clause,3,[],[],[{integer,3,42}]}]}],'
      + ' {ok,kd_qe2c_smoke,Bin} = compile:forms(Forms, [binary]),'
      + ' {module,kd_qe2c_smoke} = code:load_binary(kd_qe2c_smoke, "kd_qe2c_smoke.beam", Bin),'
      + ' io:format("answer=~p~n", [kd_qe2c_smoke:f()]), halt().'
    );
    expect(output).toContain("answer=42");
  });
});
