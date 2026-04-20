/**
 * Tests for GNU grep running on the wasm-posix-kernel.
 */
import { describe, it, expect } from "vitest";
import { runCentralizedProgram } from "./centralized-test-helper";
import { tryResolveBinary } from "../src/binary-resolver";

const grepBinary = tryResolveBinary("programs/grep.wasm");

const hasGrep = !!grepBinary;

describe.skipIf(!hasGrep)("GNU grep", () => {
  it("matches a simple pattern", async () => {
    const result = await runCentralizedProgram({
      programPath: grepBinary!,
      argv: ["grep", "hello"],
      stdin: "hello world\ngoodbye world\nhello again\n",
      timeout: 10_000,
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("hello world\nhello again\n");
  });

  it("returns 1 when no match", async () => {
    const result = await runCentralizedProgram({
      programPath: grepBinary!,
      argv: ["grep", "xyz"],
      stdin: "hello world\n",
      timeout: 10_000,
    });
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe("");
  });

  it("supports -i for case insensitive", async () => {
    const result = await runCentralizedProgram({
      programPath: grepBinary!,
      argv: ["grep", "-i", "hello"],
      stdin: "HELLO world\nhello again\nGoodbye\n",
      timeout: 10_000,
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("HELLO world\nhello again\n");
  });

  it("supports -c for count", async () => {
    const result = await runCentralizedProgram({
      programPath: grepBinary!,
      argv: ["grep", "-c", "a"],
      stdin: "apple\nbanana\ncherry\navocado\n",
      timeout: 10_000,
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe("3");
  });

  it("supports -v for inverted match", async () => {
    const result = await runCentralizedProgram({
      programPath: grepBinary!,
      argv: ["grep", "-v", "bad"],
      stdin: "good\nbad\ngreat\nbad news\n",
      timeout: 10_000,
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("good\ngreat\n");
  });

  it("supports -n for line numbers", async () => {
    const result = await runCentralizedProgram({
      programPath: grepBinary!,
      argv: ["grep", "-n", "match"],
      stdin: "no\nmatch here\nno\nmatch again\n",
      timeout: 10_000,
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("2:match here\n4:match again\n");
  });

  it("supports basic regex", async () => {
    const result = await runCentralizedProgram({
      programPath: grepBinary!,
      argv: ["grep", "^[0-9]"],
      stdin: "123 numbers\nabc letters\n456 more\n",
      timeout: 10_000,
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("123 numbers\n456 more\n");
  });

  it("supports -E for extended regex", async () => {
    const result = await runCentralizedProgram({
      programPath: grepBinary!,
      argv: ["grep", "-E", "(cat|dog)"],
      stdin: "I have a cat\nI have a bird\nI have a dog\n",
      timeout: 10_000,
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("I have a cat\nI have a dog\n");
  });

  it("supports -w for word match", async () => {
    const result = await runCentralizedProgram({
      programPath: grepBinary!,
      argv: ["grep", "-w", "in"],
      stdin: "in the beginning\nfind it\nit is in here\n",
      timeout: 10_000,
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("in the beginning\nit is in here\n");
  });
});
