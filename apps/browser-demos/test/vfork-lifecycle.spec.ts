import { expect, test, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveBinary } from "../../../host/src/binary-resolver";
import {
  detectPtrWidth,
  extractHeapBase,
  WASM_PAGE_SIZE,
} from "../../../host/src/constants";
import { computeProcessMemoryLayout } from "../../../host/src/process-memory";

const __dirname = dirname(fileURLToPath(import.meta.url));
const browserKernelModulePath = resolve(
  __dirname,
  "../../../host/src/browser-kernel-host.ts",
);
const memoryFsModulePath = resolve(
  __dirname,
  "../../../host/src/vfs/memory-fs.ts",
);
const lifecycleProgramPath = resolveBinary("programs/vfork-lifecycle.wasm");
const threadProgramPath = resolveBinary("programs/vfork-from-thread.wasm");
const fatalProgramPath = resolveBinary("programs/vfork-fatal-lifecycle.wasm");
const externalSignalProgramPath = resolveBinary(
  "programs/vfork-external-signal.wasm",
);
const stateProgramPath = resolveBinary("programs/vfork-posix-state.wasm");
const execChildPath = resolveBinary("programs/exec-child.wasm");

function initialAddressSpaceBytes(programPath: string): number {
  const file = readFileSync(programPath);
  const bytes = file.buffer.slice(
    file.byteOffset,
    file.byteOffset + file.byteLength,
  );
  const ptrWidth = detectPtrWidth(bytes);
  return computeProcessMemoryLayout({
    ptrWidth,
    programBytes: bytes,
    heapBase: extractHeapBase(bytes),
  }).initialPages * WASM_PAGE_SIZE;
}

interface BrowserVforkResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  diagnostics: Array<{
    pid?: number;
    status?: number;
    source: string;
    message: string;
  }>;
  processEvents: string[];
}

function expectOrdered(output: string, markers: readonly string[]): void {
  let previous = -1;
  for (const marker of markers) {
    const index = output.indexOf(marker);
    expect(index, `missing output marker ${marker}`).toBeGreaterThan(previous);
    previous = index;
  }
}

function captureRuntimeErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("pageerror", (error) => {
    errors.push(`pageerror: ${error.message}`);
  });
  page.on("console", (message) => {
    if (message.type() === "error") {
      errors.push(`console: ${message.text()}`);
    }
  });
  page.on("requestfailed", (request) => {
    errors.push(
      `requestfailed: ${request.url()} ${request.failure()?.errorText ?? "failed"}`,
    );
  });
  return errors;
}

async function runBrowserVforkFixture(
  page: Page,
  baseURL: string,
  fixturePath: string,
  execChildFixturePath?: string,
  maxProcessMemoryBytes?: number,
): Promise<BrowserVforkResult> {
  const asViteFsUrl = (path: string) => new URL(`/@fs/${path}`, baseURL).href;

  // The bare fixture page has no product favicon. Keep Chromium's unrelated
  // favicon 404 out of the runtime-error evidence collected below.
  await page.route("**/favicon.ico", (route) =>
    route.fulfill({ status: 204, body: "" }),
  );
  await page.goto(new URL("/trap-signal-test.html", baseURL).href);
  return page.evaluate(
    async ({
      browserKernelModuleUrl,
      memoryFsModuleUrl,
      fixtureUrl,
      execChildFixtureUrl,
      maxProcessMemoryBytes,
    }) => {
      // WHY: loading BrowserKernel first avoids racing two cold Vite imports
      // through the same host-runtime dependency graph.
      const { BrowserKernel } = await import(
        /* @vite-ignore */ browserKernelModuleUrl
      );
      const { MemoryFileSystem } = await import(
        /* @vite-ignore */ memoryFsModuleUrl
      );
      const decoder = new TextDecoder();
      let stdout = "";
      let stderr = "";
      const diagnostics: Array<{
        pid?: number;
        status?: number;
        source: string;
        message: string;
      }> = [];
      const processEvents: string[] = [];
      const kernel = new BrowserKernel({
        maxWorkers: 4,
        ...(maxProcessMemoryBytes === undefined
          ? {}
          : { maxProcessMemoryBytes }),
        onStdout: (data: Uint8Array) => {
          stdout += decoder.decode(data);
        },
        onStderr: (data: Uint8Array) => {
          stderr += decoder.decode(data);
        },
        onHostDiagnostic: (diagnostic: {
          pid?: number;
          status?: number;
          source: string;
          message: string;
        }) => diagnostics.push(diagnostic),
        onProcessEvent: (event: { kind: string }) => {
          processEvents.push(event.kind);
        },
      });
      let initialized = false;

      try {
        const imageOwner = MemoryFileSystem.create(
          new SharedArrayBuffer(2 * 1024 * 1024),
        );
        imageOwner.mkdir("/tmp", 0o755);
        if (execChildFixtureUrl) {
          const childResponse = await fetch(execChildFixtureUrl);
          if (!childResponse.ok) {
            throw new Error(
              `exec child fetch failed: ${childResponse.status} ${execChildFixtureUrl}`,
            );
          }
          imageOwner.mkdir("/bin", 0o755);
          imageOwner.createFileWithOwner(
            "/bin/vfork-exec-child",
            0o755,
            0,
            0,
            new Uint8Array(await childResponse.arrayBuffer()),
          );
        }
        await kernel.initFromImage({
          vfsImage: await imageOwner.saveImage(),
        });
        initialized = true;

        const fixtureResponse = await fetch(fixtureUrl);
        if (!fixtureResponse.ok) {
          throw new Error(
            `fixture fetch failed: ${fixtureResponse.status} ${fixtureUrl}`,
          );
        }
        const exitCode = await kernel.spawn(
          await fixtureResponse.arrayBuffer(),
          ["vfork-browser-fixture"],
        );
        return {
          exitCode,
          stdout,
          stderr,
          diagnostics,
          processEvents,
        };
      } finally {
        if (initialized) await kernel.destroy();
      }
    },
    {
      browserKernelModuleUrl: asViteFsUrl(browserKernelModulePath),
      memoryFsModuleUrl: asViteFsUrl(memoryFsModulePath),
      fixtureUrl: asViteFsUrl(fixturePath),
      execChildFixtureUrl: execChildFixturePath
        ? asViteFsUrl(execChildFixturePath)
        : undefined,
      maxProcessMemoryBytes,
    },
  );
}

test("vfork keeps its browser parent parked through exit and exec", async ({
  page,
  baseURL,
}) => {
  test.setTimeout(180_000);
  expect(baseURL).toBeTruthy();
  const runtimeErrors = captureRuntimeErrors(page);

  const result = await runBrowserVforkFixture(
    page,
    baseURL!,
    lifecycleProgramPath,
    execChildPath,
  );

  expect(result.exitCode, JSON.stringify(result, null, 2)).toBe(0);
  expect(result.stderr).toBe("");
  expect(result.diagnostics).toEqual([]);
  expect(runtimeErrors).toEqual([]);
  expectOrdered(result.stdout, [
    "CHILD_EXIT_ONE",
    "PARENT_RESUME_ONE",
    "CHILD_EXIT_TWO",
    "PARENT_RESUME_TWO",
    "CHILD_FAILED_EXEC",
    "PARENT_AFTER_FAILED_EXEC_EXIT",
    "CHILD_NESTED_FORK_EAGAIN",
    "CHILD_NESTED_VFORK_EAGAIN",
    "CHILD_PTHREAD_EAGAIN",
    "PARENT_AFTER_REJECTED_OWNERSHIP",
    "PARENT_AFTER_EXEC_COMMIT",
    "PARENT_REAPED_EXEC_CHILD",
    "PASS: VFORK_LIFECYCLE",
  ]);
  expect(result.processEvents).toContain("exec");
});

test("vfork parks only its calling browser pthread", async ({
  page,
  baseURL,
}) => {
  test.setTimeout(180_000);
  expect(baseURL).toBeTruthy();
  const runtimeErrors = captureRuntimeErrors(page);

  const result = await runBrowserVforkFixture(
    page,
    baseURL!,
    threadProgramPath,
    undefined,
    // WHY: pthread creation grows this one admitted address space before
    // vfork. Any full child allocation would then fail the sampled budget;
    // passing proves the browser host retained the existing Memory instead.
    initialAddressSpaceBytes(threadProgramPath),
  );

  expect(result.exitCode, JSON.stringify(result, null, 2)).toBe(0);
  expect(result.stderr).toBe("");
  expect(result.diagnostics).toEqual([]);
  expect(runtimeErrors).toEqual([]);
  expectOrdered(result.stdout, [
    "THREAD_BEFORE_VFORK",
    "MAIN_SIBLING_RAN",
    "MAIN_RELEASED_CHILD",
    "CHILD_THREAD_EXIT",
    "THREAD_CALLER_RESUMED",
    "MAIN_JOINED_CALLER",
    "MAIN_REAPED_CHILD",
    "PASS: VFORK_FROM_THREAD",
  ]);
});

test("vfork releases its browser parent after trap and signal", async ({
  page,
  baseURL,
}) => {
  test.setTimeout(180_000);
  expect(baseURL).toBeTruthy();
  const runtimeErrors = captureRuntimeErrors(page);

  const result = await runBrowserVforkFixture(
    page,
    baseURL!,
    fatalProgramPath,
  );

  expect(result.exitCode, JSON.stringify(result, null, 2)).toBe(0);
  expect(result.stderr).toBe("");
  // The intentional child trap is surfaced through both the structured host
  // diagnostic and the browser console. Require that one known failure while
  // rejecting any extra page, request, or lifecycle error.
  expect(runtimeErrors).toHaveLength(1);
  expect(runtimeErrors[0]).toMatch(
    /console: \[process-worker\] Kernel worker failed:.*unreachable/is,
  );
  expectOrdered(result.stdout, [
    "CHILD_BEFORE_TRAP",
    "PARENT_AFTER_TRAP",
    "PARENT_REAPED_TRAP",
    "CHILD_BEFORE_SIGKILL",
    "PARENT_AFTER_SIGKILL",
    "PARENT_REAPED_SIGKILL",
    "PASS: VFORK_FATAL_LIFECYCLE",
  ]);
  expect(result.diagnostics).toHaveLength(1);
  expect(result.diagnostics[0]).toMatchObject({
    status: 132,
    source: "worker-main error message",
  });
  expect(result.diagnostics[0].message).toMatch(/unreachable/i);
});

test("vfork contains a compute-running browser borrower", async ({
  page,
  baseURL,
}) => {
  test.setTimeout(180_000);
  expect(baseURL).toBeTruthy();
  const runtimeErrors = captureRuntimeErrors(page);

  const result = await runBrowserVforkFixture(
    page,
    baseURL!,
    externalSignalProgramPath,
  );

  expect(result.exitCode, JSON.stringify(result, null, 2)).toBe(139);
  expect(result.stderr).toBe("");
  expectOrdered(result.stdout, [
    "VFORK_EXTERNAL_SIGNAL_BEGIN",
    "KILLER_THREAD_READY",
    "CHILD_COMPUTE_LOOP",
    "KILLER_SENT_SIGKILL",
  ]);
  expect(result.stdout).not.toContain("UNSAFE_PARENT_RESUMED");
  expect(result.diagnostics).toHaveLength(1);
  expect(result.diagnostics[0]).toMatchObject({
    status: 139,
    source: "vfork address-space containment",
  });
  expect(result.diagnostics[0].message).toMatch(/ambiguous child teardown/);
  expect(runtimeErrors).toHaveLength(1);
  expect(runtimeErrors[0]).toMatch(
    /console: \[vfork\] containing shared address space after ambiguous child teardown/,
  );
});

test("vfork preserves browser-visible POSIX process state", async ({
  page,
  baseURL,
}) => {
  test.setTimeout(180_000);
  expect(baseURL).toBeTruthy();
  const runtimeErrors = captureRuntimeErrors(page);

  const result = await runBrowserVforkFixture(
    page,
    baseURL!,
    stateProgramPath,
  );

  expect(result.exitCode, JSON.stringify(result, null, 2)).toBe(0);
  expect(result.stderr).toBe("");
  expect(result.diagnostics).toEqual([]);
  expect(runtimeErrors).toEqual([]);
  expectOrdered(result.stdout, [
    "PARENT_AFTER_STATE_CHILD",
    "PARENT_REAPED_STATE_CHILD",
    "PASS: VFORK_POSIX_STATE",
  ]);
});
