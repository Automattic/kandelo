import { expect, test } from "@playwright/test";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runFetchedWasmProgram } from "./run-fetched-wasm-program";

const __dirname = dirname(fileURLToPath(import.meta.url));
const programPath = resolve(
  __dirname,
  "../../../examples/shm_mapping_coherence_test.wasm",
);

// The browser host drives the kernel's shared-mapping table through the same
// kernel worker as Node; this proves separate MAP_SHARED mappings of
// kernel-owned files (/dev/shm, memfd, /tmp) converge there too.
test(
  "MAP_SHARED mappings of kernel-owned files converge in Chromium",
  async ({ page, baseURL, browserName }) => {
    test.skip(
      browserName !== "chromium",
      "the aggregate browser gate uses Chromium",
    );
    expect(baseURL).toBeTruthy();

    const runtimeErrors: string[] = [];
    page.on("pageerror", (error) => {
      runtimeErrors.push(`pageerror: ${error.message}`);
    });
    page.on("console", (message) => {
      if (message.type() === "error") {
        runtimeErrors.push(`console: ${message.text()}`);
      }
    });

    await page.goto(new URL("/pages/test-runner/?minimal=1", baseURL).href);
    await page.waitForFunction(
      () => (window as any).__testRunnerReady === true,
    );

    const result = await page.evaluate(runFetchedWasmProgram, {
      programUrl: new URL(`/@fs/${programPath}`, baseURL).href,
      argv: ["shm-mapping-coherence-test"],
      timeoutMs: 30_000,
    });

    expect(result.exitCode, result.stdout + result.stderr).toBe(0);
    expect(result.stdout).toContain("two-opens-one-process: PASS");
    expect(result.stdout).toContain("inherited-across-fork: PASS");
    expect(result.stdout).toContain("independent-opens: PASS");
    expect(result.stdout).toContain("memfd-across-fork: PASS");
    expect(result.stdout).toContain("descriptor-and-mapping: PASS");
    expect(result.stdout).toContain("descriptor-and-mapping-read: PASS");
    expect(result.stdout).toContain("SHM_MAPPING_COHERENCE_PASS");
    expect(result.stderr).toBe("");
    expect(runtimeErrors).toEqual([]);
  },
);

const boundaryProgramPath = resolve(
  __dirname,
  "../../../examples/shm_mapping_boundary_test.wasm",
);

// The completion boundary of a quiet syscall may skip a comparison the
// kernel proved redundant (BoundaryRecord in runtime-core memory.rs). The
// browser host makes the same claim as Node; every writer must still reach
// its peer no later than before.
test(
  "MAP_SHARED stores still publish around skipped comparisons in Chromium",
  async ({ page, baseURL, browserName }) => {
    test.skip(
      browserName !== "chromium",
      "the aggregate browser gate uses Chromium",
    );
    expect(baseURL).toBeTruthy();

    const runtimeErrors: string[] = [];
    page.on("pageerror", (error) => {
      runtimeErrors.push(`pageerror: ${error.message}`);
    });
    page.on("console", (message) => {
      if (message.type() === "error") {
        runtimeErrors.push(`console: ${message.text()}`);
      }
    });

    await page.goto(new URL("/pages/test-runner/?minimal=1", baseURL).href);
    await page.waitForFunction(
      () => (window as any).__testRunnerReady === true,
    );

    const result = await page.evaluate(runFetchedWasmProgram, {
      programUrl: new URL(`/@fs/${boundaryProgramPath}`, baseURL).href,
      argv: ["shm-mapping-boundary-test"],
      timeoutMs: 60_000,
    });

    expect(result.exitCode, result.stdout + result.stderr).toBe(0);
    expect(result.stdout).toContain("store-after-quiet-syscalls: PASS");
    expect(result.stdout).toContain("syscall-output-into-mapping: PASS");
    expect(result.stdout).toContain("sibling-thread-store: PASS");
    expect(result.stdout).toContain("signal-handler-store: PASS");
    expect(result.stdout).toContain("forked-child-observes-parent: PASS");
    expect(result.stdout).toContain("SHM_MAPPING_BOUNDARY_PASS");
    expect(result.stderr).toBe("");
    expect(runtimeErrors).toEqual([]);
  },
);
