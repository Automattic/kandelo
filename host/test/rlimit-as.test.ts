/**
 * RLIMIT_AS reports the address space a process actually has.
 *
 * Kandelo caps every process at a real Wasm memory ceiling that the host
 * chooses per device — 1 GiB under the desktop memory profile, 256 MiB under
 * the constrained profile browsers on small-reservation-pool devices (iOS
 * Safari) select. That bound is invisible to a guest unless getrlimit reports
 * it, and a guest told the limit is infinite will size allocations it cannot
 * have. See host/src/runtime-memory-profile.ts for why the budgets differ.
 */
import { describe, expect, it } from "vitest";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { runCentralizedProgram } from "./centralized-test-helper";

const __dirname = dirname(fileURLToPath(import.meta.url));
const program = join(__dirname, "../../examples/rlimit_as_test.wasm");
const WASM_PAGE_SIZE = 65536;

/** The two per-process ceilings the shipped memory profiles declare. */
const CEILINGS = [
  ["desktop", 16384],
  ["constrained", 4096],
] as const;

function reportedHardLimit(stdout: string): number {
  const match = /^RLIMIT_AS soft=(\d+) hard=(\d+)$/m.exec(stdout);
  if (match === null) throw new Error(`no RLIMIT_AS line in:\n${stdout}`);
  return Number(match[2]);
}

describe("RLIMIT_AS describes the process address space", () => {
  it.each(CEILINGS)(
    "is a real, enforced bound under the %s budget",
    async (_profile, maxPages) => {
      const result = await runCentralizedProgram({
        programPath: program,
        argv: ["rlimit-as-test"],
        maxPages,
        timeout: 30_000,
      });

      expect(result.stdout).toContain("RLIMIT_AS_PASS");
      expect(result.exitCode).toBe(0);

      // The host lowers the ceiling below its control pages, so the reported
      // limit sits at or just under the declared ceiling — never above it,
      // and never a different order of magnitude.
      const declared = maxPages * WASM_PAGE_SIZE;
      const hard = reportedHardLimit(result.stdout);
      expect(hard).toBeLessThanOrEqual(declared);
      expect(hard).toBeGreaterThan(declared / 2);
    },
  );

  it("tracks the host's ceiling rather than reporting a constant", async () => {
    const [desktop, constrained] = await Promise.all(
      CEILINGS.map(([, maxPages]) =>
        runCentralizedProgram({
          programPath: program,
          argv: ["rlimit-as-test"],
          maxPages,
          timeout: 30_000,
        })
      ),
    );
    expect(reportedHardLimit(desktop.stdout)).toBeGreaterThan(
      reportedHardLimit(constrained.stdout),
    );
  });
});
