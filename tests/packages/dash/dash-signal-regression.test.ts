/**
 * Regression tests for dash signal-name generation.
 *
 * dash's Makefile runs `mksignames` during build to regenerate signames.c.
 * On macOS the host-compiled mksignames emits macOS signal numbers unless the
 * package build preserves the Linux-numbered table. libc-test's
 * `functional/popen` uses `kill -USR1 %d` from a shell child; if dash maps
 * USR1 to the host's number, the parent never receives Linux SIGUSR1.
 */
import { describe, it, expect } from "vitest";
import { join, dirname } from "node:path";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { runCentralizedProgram } from "../../../host/test/centralized-test-helper";
import { tryResolveBinary } from "../../../host/src/binary-resolver";

const __dirname = dirname(fileURLToPath(import.meta.url));
const dashBinary =
  tryResolveBinary("programs/dash.wasm") ??
  join(__dirname, "../../../packages/registry/dash/bin/dash.wasm");
const hasDash = existsSync(dashBinary);

describe.skipIf(!hasDash)("dash signal regression gates", () => {
  it("signal-10 name is USR1, not BUS", async () => {
    // Linux/musl puts SIGUSR1 at 10 and SIGBUS at 7; macOS puts SIGBUS at 10.
    const result = await runCentralizedProgram({
      programPath: dashBinary,
      argv: ["dash", "-c", "kill -l 10"],
      timeout: 10_000,
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe("USR1");
  });

  it("shell-driven `kill -USR1 $$` reaches the parent as signal 10", async () => {
    const result = await runCentralizedProgram({
      programPath: dashBinary,
      argv: [
        "dash",
        "-c",
        "trap 'echo got=10' 10; kill -USR1 $$; echo done",
      ],
      timeout: 10_000,
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("got=10");
    expect(result.stdout).toContain("done");
  });
});
