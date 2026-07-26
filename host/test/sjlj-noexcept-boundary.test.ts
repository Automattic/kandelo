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
const instrumentedForkFixture = resolveBinary(
  "programs/sjlj_noexcept_boundary.wasm",
);
const sigchldFixture = resolveBinary("programs/sigchld_sjlj.wasm");
const TERMINATED_BY_SIGABRT = 128 + 6;

describe("LLVM Wasm SjLj across a noexcept boundary", () => {
  it("keeps the raw wasm32 control independent of fork instrumentation", () => {
    const rawModule = new WebAssembly.Module(readFileSync(rawWasm32Fixture));
    const exportNames = (module: WebAssembly.Module) =>
      WebAssembly.Module.exports(module).map(({ name }) => name);

    expect(exportNames(rawModule)).not.toContain("wpk_fork_state");
  });

  it("admits the fork-bearing compiler output through ABI 43 instrumentation", () => {
    const module = new WebAssembly.Module(
      readFileSync(instrumentedForkFixture),
    );
    const exportNames = WebAssembly.Module.exports(module)
      .map(({ name }) => name);

    expect(exportNames).toContain("wpk_fork_state");
  });

  it("forks through the instrumented compiler-EH artifact", async () => {
    const result = await runCentralizedProgram({
      programPath: instrumentedForkFixture,
      argv: ["sjlj_noexcept_boundary", "--fork-instrumentation-anchor"],
      timeout: 10_000,
      useDefaultRootfs: false,
    });

    expect(result.exitCode).toBe(0);
  });

  it.each([
    ["raw wasm32", rawWasm32Fixture],
    ["raw wasm64", rawWasm64Fixture],
    ["instrumented wasm32", instrumentedForkFixture],
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

  it.each([
    ["raw wasm32", rawWasm32Fixture],
    ["instrumented wasm32", instrumentedForkFixture],
  ])("resumes the same SjLj tag in the %s permissive boundary", async (_, path) => {
    const result = await runCentralizedProgram({
      programPath: path,
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
