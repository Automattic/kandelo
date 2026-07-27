import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("musl startup metadata materialization", () => {
  it("keeps allocation failure and query/copy mismatch atomic", () => {
    const repoRoot = resolve(import.meta.dirname, "../..");
    const temp = mkdtempSync(join(tmpdir(), "kandelo-startup-crt-"));
    try {
      const compiler = process.env.LLVM_BIN
        ? join(process.env.LLVM_BIN, "clang")
        : "clang";
      const executable = join(temp, "startup-crt-contract");
      execFileSync(compiler, [
        "-std=c11",
        "-Werror",
        "-Wno-ignored-attributes",
        "-Wno-unknown-attributes",
        "-I",
        join(repoRoot, "host/test/fixtures/startup-crt-include"),
        "-I",
        join(repoRoot, "libc/musl-overlay/arch/wasm64posix"),
        "-idirafter",
        join(repoRoot, "libc/musl-overlay/include"),
        "-idirafter",
        join(repoRoot, "libc/musl/include"),
        join(repoRoot, "host/test/fixtures/startup-crt-contract.c"),
        "-o",
        executable,
      ], { cwd: repoRoot, stdio: "pipe" });

      expect(execFileSync(executable, { encoding: "utf8" }))
        .toBe("startup-crt-contract: ok\n");
    } finally {
      rmSync(temp, { recursive: true, force: true });
    }
  });
});
