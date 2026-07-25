import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { findRepoRoot, resolveBinary } from "../src/binary-resolver";
import { runCentralizedProgram } from "./centralized-test-helper";

const repoRoot = findRepoRoot();
const rawWasm32Fixture = join(
  repoRoot,
  "local-binaries/test-fixtures/wasm32/sjlj_noexcept_boundary.raw.wasm",
);
const rawWasm64Fixture = join(
  repoRoot,
  "local-binaries/test-fixtures/wasm64/sjlj_noexcept_boundary.raw.wasm",
);
const unsupportedForkFixture = join(
  repoRoot,
  "local-binaries/test-fixtures/wasm32/unsupported-abi43/sjlj_noexcept_boundary.raw.wasm",
);
const unsupportedForkDiagnostic = `${unsupportedForkFixture}.instrument-error.txt`;
const sigchldFixture = resolveBinary("programs/sigchld_sjlj.wasm");
const TERMINATED_BY_SIGABRT = 128 + 6;

describe("LLVM Wasm SjLj across a noexcept boundary", () => {
  it("keeps the raw wasm32 control independent of fork instrumentation", () => {
    const rawModule = new WebAssembly.Module(readFileSync(rawWasm32Fixture));
    const exportNames = (module: WebAssembly.Module) =>
      WebAssembly.Module.exports(module).map(({ name }) => name);

    expect(exportNames(rawModule)).not.toContain("wpk_fork_state");
  });

  it("keeps the fork-bearing compiler output outside the ABI 43 resolver", () => {
    expect(readFileSync(unsupportedForkFixture).byteLength).toBeGreaterThan(0);
    expect(readFileSync(unsupportedForkDiagnostic, "utf8")).toMatch(
      /reference local\/parameter|uses CatchAll|uses CatchAllRef/,
    );
  });

  it.each([
    ["raw wasm32", rawWasm32Fixture],
    ["raw wasm64", rawWasm64Fixture],
  ])("documents the pinned LLVM failure in the %s control", async (_, path) => {
    const result = await runCentralizedProgram({
      programPath: path,
      argv: ["sjlj_noexcept_boundary", "--noexcept"],
      timeout: 10_000,
      useDefaultRootfs: false,
    });

    expect(result.exitCode).toBe(TERMINATED_BY_SIGABRT);
    expect(result.stderr).toContain("HANDLER: siglongjmp");
    expect(result.stderr).toContain("libc++abi: terminating");
    expect(result.stdout).not.toContain("LANDING: siglongjmp resumed");
  });

  it("resumes the same SjLj tag when it does not cross noexcept", async () => {
    const result = await runCentralizedProgram({
      programPath: rawWasm32Fixture,
      argv: ["sjlj_noexcept_boundary", "--permissive"],
      timeout: 10_000,
      useDefaultRootfs: false,
    });

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toContain("HANDLER: siglongjmp");
    expect(result.stdout).toContain("LANDING: siglongjmp resumed");
    expect(result.stderr).not.toContain("libc++abi: terminating");
  });
});

describe("SIGCHLD SjLj control", () => {
  it("resumes pselect and reaps the child after SIGCHLD", async () => {
    const result = await runCentralizedProgram({
      programPath: sigchldFixture,
      argv: ["sigchld_sjlj"],
      timeout: 10_000,
      useDefaultRootfs: false,
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain(
      "PASS: SIGCHLD siglongjmp resumed at pselect landing pad",
    );
    expect(result.stderr).not.toContain("libc++abi: terminating");
  });
});
