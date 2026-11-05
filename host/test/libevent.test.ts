import { describe, expect, it } from "vitest";
import { runCentralizedProgram } from "./centralized-test-helper";
import { libeventCases, libeventModes, libeventProgram } from "./support/libevent-programs";

describe("libevent upstream epoll regressions", () => {
  for (const arch of ["wasm32", "wasm64"] as const) {
    for (const mode of libeventModes) {
      it(`${arch} ${mode.name} delivers edges and peer-close events`, async () => {
        const probe = await runCentralizedProgram({
          programPath: libeventProgram(arch, "backend"),
          argv: ["libevent-backend"], env: mode.env,
          useDefaultRootfs: false, timeout: 30_000,
        });
        expect(probe.exitCode, `${probe.stdout}\n${probe.stderr}`).toBe(0);
        expect(probe.stdout).toContain(`LIBEVENT_BACKEND=${mode.name} features=11 version=2.1.12-stable`);
        expect(probe.stderr).toBe("");
        expect(probe.hostDiagnostics).toEqual([]);

        const result = await runCentralizedProgram({
          programPath: libeventProgram(arch, "regress"),
          argv: ["libevent-regress", ...libeventCases], env: mode.env,
          useDefaultRootfs: false, timeout: 60_000,
        });
        expect(result.exitCode, `${result.stdout}\n${result.stderr}`).toBe(0);
        expect(result.stdout).toContain("12 tests ok.  (0 skipped)");
        for (const name of libeventCases) expect(result.stdout).toContain(`${name}:`);
        expect(result.stderr).toBe("");
        expect(result.hostDiagnostics).toEqual([]);
      }, 100_000);
    }
  }
});
