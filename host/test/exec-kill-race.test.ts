import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveBinary } from "../src/binary-resolver";
import { runCentralizedProgram } from "./centralized-test-helper";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "../..");

// A child killed after its exec committed, and possibly reaped by its parent,
// before the host registered the replacement image used to fail registration
// with "unknown kernel process"; reporting a crash for that retired pid then
// failed the whole kernel worker. The kill must look like any other kill.
describe("exec handoff and SIGKILL", () => {
  it("survives children killed between exec commit and image start", async () => {
    const dir = mkdtempSync(join(tmpdir(), "exec-kill-race-"));
    try {
      const linked = join(dir, "exec-kill-race.linked.wasm");
      const program = join(dir, "exec-kill-race.wasm");
      execFileSync(join(repoRoot, "sdk/bin/wasm32posix-cc"), [
        "-O2", join(repoRoot, "host/test/fixtures/exec-kill-race.c"), "-lpthread", "-o", linked,
      ], { stdio: "inherit" });
      execFileSync("bash", [join(repoRoot, "scripts/run-wasm-fork-instrument.sh"), linked, "-o", program],
        { stdio: "inherit" });
      const sh = resolveBinary("programs/bash.wasm");
      // Several delays cover kills before, during, and after the handoff;
      // before the fix most runs at the short delays lost the kernel.
      for (const delay of ["0", "500", "0", "500", "5000", "0"]) {
        const result = await runCentralizedProgram({
          programPath: program,
          argv: ["exec-kill-race", "10", delay],
          useDefaultRootfs: false,
          timeout: 120_000,
          execPrograms: new Map([["/bin/sh", sh]]),
        });
        expect({ delay, exitCode: result.exitCode, stdout: result.stdout })
          .toEqual({ delay, exitCode: 0, stdout: expect.stringContaining("EXEC_KILL_RACE_OK rounds=10") });
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 600_000);
});
