import { describe, it, expect } from "vitest";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { runCentralizedProgram } from "./centralized-test-helper";

const __dirname = dirname(fileURLToPath(import.meta.url));

describe("putenv / setenv / unsetenv", () => {
  it("populates __environ from kernel at startup and syncs setenv/putenv/unsetenv", async () => {
    const { exitCode, stdout } = await runCentralizedProgram({
      programPath: join(__dirname, "../../examples/putenv_test.wasm"),
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
    const myVarLines = stdout.split("\n").filter(l => l.startsWith("MY_VAR="));
    expect(myVarLines[0]).toBe("MY_VAR=hello");
    expect(myVarLines[1]).toBe("MY_VAR=world");
    expect(myVarLines[2]).toBe("MY_VAR=world");

    // putenv
    expect(stdout).toContain("PUT_VAR=from_putenv");

    // unsetenv
    expect(stdout).toContain("MY_VAR=<not set>");

    expect(stdout).toContain("DONE");
    expect(exitCode).toBe(0);
  }, 30_000);
});
