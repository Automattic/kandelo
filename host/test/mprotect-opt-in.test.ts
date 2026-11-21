import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { runCentralizedProgram } from "./centralized-test-helper";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "../..");
const source = join(repoRoot, "examples/mprotect_opt_in_test.c");

function compile(arch: "wasm32" | "wasm64", extra: string[]) {
  const out = join(mkdtempSync(join(tmpdir(), "mprotect-")), "t.wasm");
  const result = spawnSync(join(repoRoot, `sdk/bin/${arch}posix-cc`),
    [source, "-o", out, ...extra], { encoding: "utf8" });
  return { out, ...result };
}

// libc.a defines no public mprotect: Wasm cannot enforce page protection.
// A program opts in to -lkandelo-mprotect, whose mprotect() accepts requests
// that keep read and write access and refuses the rest with ENOTSUP; musl's
// own callers use the internal __mprotect. See docs/sdk-guide.md.
describe("mprotect opt-in", () => {
  it("does not link mprotect by default, and names the opt-in", () => {
    const link = compile("wasm32", ["-DKANDELO_TEST_MPROTECT"]);
    expect(link.status).not.toBe(0);
    expect(link.stderr).toMatch(/undefined symbol: mprotect\b/);
    expect(link.stderr).toContain("-lkandelo-mprotect");
    expect(link.stderr).toContain("ENOTSUP");
  });

  for (const arch of ["wasm32", "wasm64"] as const) {
    it(`keeps malloc and pthread_create working without the opt-in (${arch})`, async () => {
      const link = compile(arch, []);
      expect(link.stderr).toBe("");
      expect(link.status).toBe(0);
      const result = await runCentralizedProgram({
        programPath: link.out,
        argv: ["mprotect-opt-in-test"],
        useDefaultRootfs: false,
        timeout: 30_000,
      });
      expect(result.stdout).toContain("MPROTECT_TEST_PASS");
      expect(result.exitCode).toBe(0);
    }, 60_000);

    it(`widens and refuses restriction with ENOTSUP when opted in (${arch})`, async () => {
      const link = compile(arch, ["-DKANDELO_TEST_MPROTECT", "-lkandelo-mprotect"]);
      expect(link.stderr).toBe("");
      expect(link.status).toBe(0);
      const result = await runCentralizedProgram({
        programPath: link.out,
        argv: ["mprotect-opt-in-test"],
        useDefaultRootfs: false,
        timeout: 30_000,
      });
      expect(result.stdout).toContain("MPROTECT_TEST_PASS");
      expect(result.exitCode).toBe(0);
    }, 60_000);
  }
});
