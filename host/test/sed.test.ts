/**
 * Tests for GNU sed running on the wasm-posix-kernel.
 */
import { describe, it, expect } from "vitest";
import { runCentralizedProgram } from "./centralized-test-helper";
import { tryResolveBinary } from "../src/binary-resolver";

const sedBinary = tryResolveBinary("programs/sed.wasm");

const hasSed = !!sedBinary;

describe.skipIf(!hasSed)("GNU sed", () => {
  it("substitutes first match per line", async () => {
    const result = await runCentralizedProgram({
      programPath: sedBinary!,
      argv: ["sed", "s/old/new/"],
      stdin: "old text old\nanother old line\n",
      timeout: 10_000,
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("new text old\nanother new line\n");
  });

  it("substitutes all matches with g flag", async () => {
    const result = await runCentralizedProgram({
      programPath: sedBinary!,
      argv: ["sed", "s/a/X/g"],
      stdin: "banana\napple\n",
      timeout: 10_000,
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("bXnXnX\nXpple\n");
  });

  it("deletes matching lines", async () => {
    const result = await runCentralizedProgram({
      programPath: sedBinary!,
      argv: ["sed", "/bad/d"],
      stdin: "good\nbad\ngreat\nbad line\n",
      timeout: 10_000,
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("good\ngreat\n");
  });

  it("prints only matching lines with -n and p", async () => {
    const result = await runCentralizedProgram({
      programPath: sedBinary!,
      argv: ["sed", "-n", "/match/p"],
      stdin: "no\nmatch here\nno\nmatch again\n",
      timeout: 10_000,
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("match here\nmatch again\n");
  });

  it("supports line address ranges", async () => {
    const result = await runCentralizedProgram({
      programPath: sedBinary!,
      argv: ["sed", "2,3d"],
      stdin: "line1\nline2\nline3\nline4\n",
      timeout: 10_000,
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("line1\nline4\n");
  });

  it("supports multiple expressions with -e", async () => {
    const result = await runCentralizedProgram({
      programPath: sedBinary!,
      argv: ["sed", "-e", "s/a/A/g", "-e", "s/e/E/g"],
      stdin: "apple\nbanana\n",
      timeout: 10_000,
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("ApplE\nbAnAnA\n");
  });

  it("appends text after matching line", async () => {
    const result = await runCentralizedProgram({
      programPath: sedBinary!,
      argv: ["sed", "/target/a\\inserted line"],
      stdin: "before\ntarget\nafter\n",
      timeout: 10_000,
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("before\ntarget\ninserted line\nafter\n");
  });

  it("transliterates characters with y", async () => {
    const result = await runCentralizedProgram({
      programPath: sedBinary!,
      argv: ["sed", "y/abc/XYZ/"],
      stdin: "aabbcc\n",
      timeout: 10_000,
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("XXYYZZ\n");
  });
});
