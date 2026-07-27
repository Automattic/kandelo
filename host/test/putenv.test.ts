import { describe, it, expect } from "vitest";
import { dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { runCentralizedProgram } from "./centralized-test-helper";
import { ensureEnvironmentTransactionFixture } from "./environment-transaction-fixture";

const architectures = ["wasm32", "wasm64"] as const;
const fixtureDirectory = dirname(
  fileURLToPath(new URL("./fixtures/.fixture", import.meta.url)),
);

describe("putenv / setenv / unsetenv", () => {
  it.each(architectures)(
    "populates and transactionally syncs a %s guest environment",
    async (arch) => {
      const programPath = ensureEnvironmentTransactionFixture(arch);
      const fixtureRelativePath = relative(fixtureDirectory, programPath);
      // The link-wrapped failure-injection fixture must never overwrite the
      // ordinary examples/putenv_test binaries consumed by browser tests.
      expect(dirname(programPath)).toBe(fixtureDirectory);
      expect(fixtureRelativePath).not.toMatch(/^\.\.(?:[/\\]|$)/);

      const { exitCode, stdout, stderr } = await runCentralizedProgram({
        programPath,
        env: ["HOME=/home/test", "PATH=/usr/bin"],
      });

      // Startup env population from kernel
      expect(stdout).toContain("HOME=/home/test");
      expect(stdout).toContain("PATH=/usr/bin");

      // setenv
      expect(stdout).toContain("MY_VAR=hello");

      // setenv overwrite
      expect(stdout).toMatch(/MY_VAR=world/);

      // setenv no-overwrite (should still be "world")
      const myVarLines = stdout
        .split("\n")
        .filter((l) => l.startsWith("MY_VAR="));
      expect(myVarLines[0]).toBe("MY_VAR=hello");
      expect(myVarLines[1]).toBe("MY_VAR=world");
      expect(myVarLines[2]).toBe("MY_VAR=world");

      // putenv
      expect(stdout).toContain("PUT_VAR=from_putenv");

      // unsetenv
      expect(stdout).toContain("MY_VAR=<not set>");

      // Exact process-metadata capacity, capacity+1 rejection, and a name well
      // beyond the removed 256-byte implementation cutoff all remain coherent
      // between libc's environ and the kernel Process environment.
      expect(stdout).toContain("SETENV_BOUNDARY_PASS");
      expect(stdout).toContain("PUTENV_LONG_BOUNDARY_PASS");
      expect(stdout).toContain("ENV_TRANSACTION_FAILURE_PASS");
      expect(stdout).toContain("ENV_COHERENCE_PASS");

      expect(stderr).toBe("");
      expect(stdout).toContain("DONE");
      expect(exitCode).toBe(0);
    },
    30_000,
  );
});
