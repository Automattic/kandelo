import { describe, expect, it } from "vitest";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { runCentralizedProgram } from "./centralized-test-helper";

const __dirname = dirname(fileURLToPath(import.meta.url));

// examples/rusage_cpu_time_test.c checks, through musl and the syscall
// channel, that computation is charged as user time and blocking is not;
// that getrusage(), times(), clock() and the process, thread and encoded
// CPU-time clocks agree; that a thread's time counts toward its process;
// and that wait4() reports, and RUSAGE_CHILDREN accumulates, the time of
// waited-for children and grandchildren, including a child killed while
// computing, but not an auto-reaped child.
describe("CPU-time accounting", () => {
  it("reports the same CPU time through every interface", async () => {
    const result = await runCentralizedProgram({
      programPath: join(__dirname, "../../examples/rusage_cpu_time_test.wasm"),
      argv: ["rusage-cpu-time-test"],
      useDefaultRootfs: false,
      timeout: 60_000,
    });

    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("RUSAGE_CPU_TIME_PASS");
    expect(result.exitCode).toBe(0);
  }, 90_000);
});
