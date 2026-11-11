import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import { runCentralizedProgram } from "./centralized-test-helper";
import { buildRustBacktraceFixture } from "./fixtures/rust-backtrace-build";

const guest = "/usr/bin/rust-backtrace";
let directory: string;
let program: string;
beforeAll(() => {
  directory = mkdtempSync(join(process.env.KANDELO_AGENT_SCRATCH_DIR ?? tmpdir(), "kandelo-rust-backtrace-"));
  program = buildRustBacktraceFixture(directory);
}, 900_000);
afterAll(() => { if (directory && !process.env.KANDELO_AGENT_SCRATCH_DIR) rmSync(directory, { recursive: true, force: true }); });

for (const mode of ["capture", "thread", "subprocess", "panic"]) {
  it(`Rust ${mode} preserves symbolized backtraces through ordinary SDK preparation`, async () => {
    const result = await runCentralizedProgram({
      programPath: program, argv: [guest, mode], execPrograms: new Map([[guest, program]]),
      env: [`RUST_BACKTRACE=${mode === "panic" ? "1" : "0"}`],
      useDefaultRootfs: false, timeout: 30_000,
    });
    const dump = JSON.stringify({ exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr, hostDiagnostics: result.hostDiagnostics });
    expect(result.exitCode, dump).toBe(mode === "panic" ? 134 : 0);
    const trace = mode === "panic" ? result.stderr : result.stdout;
    const name = mode === "panic" ? "user_panic" : "user_inner";
    const line = mode === "panic" ? 15 : 5;
    expect(trace, dump).toMatch(new RegExp(`^\\s+\\d+: kandelo_backtrace::${name}\\n\\s+at .*programs/rust/backtrace/src/main\\.rs:${line}:5$`, "m"));
    if (mode !== "panic") {
      expect(trace, dump).toMatch(/^\s+\d+: kandelo_backtrace::user_outer\n\s+at .*main\.rs:10:5$/m);
      expect(result.stderr, dump).toBe("");
    }
    if (mode === "capture") expect(trace.split("DEBUG_BACKTRACE=")[1], dump).toContain('"kandelo_backtrace::user_inner"');
  }, 60_000);
}
