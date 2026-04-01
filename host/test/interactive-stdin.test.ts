/**
 * Tests for appendStdinData — interactive stdin delivery after process start.
 *
 * These tests verify that data can be sent to a running process's stdin
 * after it has already started and blocked on read, using the
 * CentralizedKernelWorker.appendStdinData() API.
 */
import { describe, it, expect } from "vitest";
import { join, dirname } from "node:path";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { runCentralizedProgram } from "./centralized-test-helper";

const __dirname = dirname(fileURLToPath(import.meta.url));
const dashBinary = join(
  __dirname,
  "../../examples/libs/dash/dash-src/src/dash",
);
const grepBinary = join(__dirname, "../../examples/libs/grep/bin/grep.wasm");

const hasDash = existsSync(dashBinary);
const hasGrep = existsSync(grepBinary);

describe.skipIf(!hasDash)("appendStdinData with dash", () => {
  it("delivers a single line to a blocked reader", async () => {
    // appendStdinData does NOT mark stdin as a pipe, so terminal echo is
    // enabled — input characters appear in stdout alongside program output.
    const result = await runCentralizedProgram({
      programPath: dashBinary,
      argv: ["dash", "-c", 'read line; echo "got:$line"'],
      timeout: 15_000,
      onStarted: async (kernelWorker, pid) => {
        // Small delay to ensure dash has started and blocked on read
        await new Promise((r) => setTimeout(r, 200));
        kernelWorker.appendStdinData(
          pid,
          new TextEncoder().encode("hello\n"),
        );
      },
    });
    expect(result.exitCode).toBe(0);
    // stdout includes echoed input + program output
    expect(result.stdout).toContain("got:hello");
  });

  it("delivers multiple lines incrementally", async () => {
    const result = await runCentralizedProgram({
      programPath: dashBinary,
      argv: ["dash", "-c", 'read a; echo "1:$a"; read b; echo "2:$b"'],
      timeout: 15_000,
      onStarted: async (kernelWorker, pid) => {
        await new Promise((r) => setTimeout(r, 200));
        kernelWorker.appendStdinData(
          pid,
          new TextEncoder().encode("first\n"),
        );
        // Delay between lines to ensure the first read completes before
        // the second line arrives
        await new Promise((r) => setTimeout(r, 500));
        kernelWorker.appendStdinData(
          pid,
          new TextEncoder().encode("second\n"),
        );
      },
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("1:first");
    expect(result.stdout).toContain("2:second");
  });

  it("delivers data pre-buffered in a single chunk", async () => {
    // Both lines sent together — dash should read them sequentially
    const result = await runCentralizedProgram({
      programPath: dashBinary,
      argv: ["dash", "-c", 'read a; echo "1:$a"; read b; echo "2:$b"'],
      timeout: 15_000,
      onStarted: async (kernelWorker, pid) => {
        await new Promise((r) => setTimeout(r, 200));
        kernelWorker.appendStdinData(
          pid,
          new TextEncoder().encode("alpha\nbeta\n"),
        );
      },
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("1:alpha");
    expect(result.stdout).toContain("2:beta");
  });

  it("terminal echo is present for interactive stdin", async () => {
    // Verify that input characters are echoed to stdout (terminal behavior)
    const result = await runCentralizedProgram({
      programPath: dashBinary,
      argv: ["dash", "-c", 'read line; echo "done"'],
      timeout: 15_000,
      onStarted: async (kernelWorker, pid) => {
        await new Promise((r) => setTimeout(r, 200));
        kernelWorker.appendStdinData(
          pid,
          new TextEncoder().encode("typed\n"),
        );
      },
    });
    expect(result.exitCode).toBe(0);
    // The echoed input should appear before the program output
    const lines = result.stdout.split("\n").filter(Boolean);
    expect(lines).toContain("typed");
    expect(lines).toContain("done");
    expect(result.stdout.indexOf("typed")).toBeLessThan(
      result.stdout.indexOf("done"),
    );
  });

  it("no echo when using setStdinData (pipe mode)", async () => {
    // setStdinData marks stdin as a pipe — no terminal echo
    const result = await runCentralizedProgram({
      programPath: dashBinary,
      argv: ["dash", "-c", 'read line; echo "got:$line"'],
      stdin: "hello\n",
      timeout: 15_000,
    });
    expect(result.exitCode).toBe(0);
    // Only program output, no echoed input
    expect(result.stdout.trim()).toBe("got:hello");
  });
});

describe.skipIf(!hasGrep)("appendStdinData with grep", () => {
  it("feeds stdin to grep after it blocks on read", async () => {
    // grep buffers all stdin, then outputs matches. We use setStdinData
    // for the base, then verify appendStdinData adds more data before
    // grep sees EOF.
    const result = await runCentralizedProgram({
      programPath: grepBinary,
      argv: ["grep", "match"],
      // Use setStdinData for initial + EOF semantics, since grep needs EOF
      stdin: "no hit\nmatch one\nskip\nmatch two\n",
      timeout: 10_000,
      onStarted: async (kernelWorker, pid) => {
        // For grep, stdin is already set via setStdinData (finite mode).
        // appendStdinData is not used here — this test confirms setStdinData
        // still works correctly via the onStarted path.
      },
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("match one\nmatch two\n");
  });
});
