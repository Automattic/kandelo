import { expect, test, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { tryResolveBinary } from "../../../host/src/binary-resolver";
import {
  detectPtrWidth,
  extractHeapBase,
  WASM_PAGE_SIZE,
} from "../../../host/src/constants";
import { computeProcessMemoryLayout } from "../../../host/src/process-memory";
import {
  RUBY_PRIVILEGED_FORK_MARKER,
  RUBY_PRIVILEGED_FORK_PROGRAM,
  RUBY_VFORK_EXEC_MARKER,
  RUBY_VFORK_EXEC_PROGRAM,
  RUBY_VFORK_EXECUTABLE,
  RUBY_VFORK_FAILED_EXEC_MARKER,
  RUBY_VFORK_FAILED_EXEC_PROGRAM,
} from "../../../packages/registry/ruby/test/posix-spawn-contract";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "../../..");
const rubyBinaryPath = tryResolveBinary("programs/ruby/ruby.wasm");
const execChildBinaryPath = tryResolveBinary("programs/exec-child.wasm");
const artifactsAvailable = rubyBinaryPath !== null && execChildBinaryPath !== null;
const browserKernelModulePath = resolve(
  repoRoot,
  "host/src/browser-kernel-host.ts",
);
const memoryFsModulePath = resolve(repoRoot, "host/src/vfs/memory-fs.ts");
const imageHelpersModulePath = resolve(
  repoRoot,
  "host/src/vfs/image-helpers.ts",
);

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

interface RubyBrowserCase {
  marker: string;
  program: string;
  uid: number;
  gid: number;
  maxProcessMemoryBytes?: number;
}

interface RubyBrowserResult {
  marker: string;
  exitCode: number;
  stdout: string;
  stderr: string;
  diagnostics: Array<{ source: string; message: string }>;
  childEvents: string[];
  forkCounts: string[];
}

async function runRubyCases(
  page: Page,
  baseURL: string,
  cases: readonly RubyBrowserCase[],
): Promise<RubyBrowserResult[]> {
  if (rubyBinaryPath === null || execChildBinaryPath === null) {
    throw new Error("browser fixture unavailable");
  }
  await page.route("**/favicon.ico", (route) =>
    route.fulfill({ status: 204, body: "" }),
  );
  await page.goto(new URL("/trap-signal-test.html", baseURL).href);
  const asViteFsUrl = (path: string) =>
    new URL(`/@fs/${path}`, baseURL).href;

  return page.evaluate(
    async ({
      browserKernelUrl,
      memoryFsUrl,
      imageHelpersUrl,
      rubyUrl,
      execChildUrl,
      executable,
      cases,
    }) => {
      const { BrowserKernel } = await import(
        /* @vite-ignore */ browserKernelUrl
      );
      const { MemoryFileSystem } = await import(
        /* @vite-ignore */ memoryFsUrl
      );
      const { ensureDirRecursive, writeVfsBinary } = await import(
        /* @vite-ignore */ imageHelpersUrl
      );
      const [rubyResponse, execChildResponse] = await Promise.all([
        fetch(rubyUrl),
        fetch(execChildUrl),
      ]);
      if (!rubyResponse.ok || !execChildResponse.ok) {
        throw new Error(
          `Ruby fixture fetch failed: ruby=${rubyResponse.status} `
            + `exec-child=${execChildResponse.status}`,
        );
      }
      const rubyBytes = await rubyResponse.arrayBuffer();
      const execChildBytes = await execChildResponse.arrayBuffer();

      const maxImageBytes = 8 * 1024 * 1024;
      const SharedArrayBufferCtor = SharedArrayBuffer as new (
        byteLength: number,
        options?: { maxByteLength?: number },
      ) => SharedArrayBuffer;
      const imageOwner = MemoryFileSystem.create(
        new SharedArrayBufferCtor(2 * 1024 * 1024, {
          maxByteLength: maxImageBytes,
        }),
        maxImageBytes,
      );
      ensureDirRecursive(imageOwner, "/tmp");
      ensureDirRecursive(imageOwner, "/bin");
      writeVfsBinary(
        imageOwner,
        executable,
        new Uint8Array(execChildBytes),
        0o755,
      );
      const vfsImage = await imageOwner.saveImage();
      const decoder = new TextDecoder();
      const results = [];

      for (const rubyCase of cases) {
        let stdout = "";
        let stderr = "";
        let parentPid: number | undefined;
        const childPids = new Set<number>();
        const childEvents: string[] = [];
        const forkSamples: Array<Promise<bigint>> = [];
        const diagnostics: Array<{ source: string; message: string }> = [];
        const kernel = new BrowserKernel({
          maxWorkers: 4,
          ...(rubyCase.maxProcessMemoryBytes === undefined
            ? {}
            : { maxProcessMemoryBytes: rubyCase.maxProcessMemoryBytes }),
          onStdout: (data: Uint8Array) => {
            stdout += decoder.decode(data);
          },
          onStderr: (data: Uint8Array) => {
            stderr += decoder.decode(data);
          },
          onHostDiagnostic: (diagnostic: {
            source: string;
            message: string;
          }) => diagnostics.push(diagnostic),
          onProcessEvent: (event: {
            kind: string;
            pid: number;
            ppid?: number;
          }) => {
            if (
              parentPid !== undefined
              && event.kind === "spawn"
              && event.ppid === parentPid
            ) {
              childPids.add(event.pid);
              childEvents.push(event.kind);
              forkSamples.push(kernel.getForkCount(parentPid));
            } else if (childPids.has(event.pid)) {
              childEvents.push(event.kind);
            }
          },
        });

        try {
          await kernel.initFromImage({ vfsImage: vfsImage.slice(0) });
          const exitCode = await kernel.spawn(
            rubyBytes.slice(0),
            ["ruby", "--disable-gems", "-e", rubyCase.program],
            {
              env: ["HOME=/tmp", "TMPDIR=/tmp"],
              uid: rubyCase.uid,
              gid: rubyCase.gid,
              onStarted: (pid: number) => {
                parentPid = pid;
              },
            },
          );
          results.push({
            marker: rubyCase.marker,
            exitCode,
            stdout,
            stderr,
            diagnostics,
            childEvents,
            forkCounts: (await Promise.all(forkSamples)).map(String),
          });
        } finally {
          await kernel.destroy();
        }
      }
      return results;
    },
    {
      browserKernelUrl: asViteFsUrl(browserKernelModulePath),
      memoryFsUrl: asViteFsUrl(memoryFsModulePath),
      imageHelpersUrl: asViteFsUrl(imageHelpersModulePath),
      // WHY: `@binaries` intentionally resolves a complete provenance tier.
      // This focused runtime test already selected exact artifacts through
      // Kandelo's resolver and must not require unrelated demo packages such
      // as Bash merely to transfer those bytes into a browser worker.
      rubyUrl: asViteFsUrl(rubyBinaryPath),
      execChildUrl: asViteFsUrl(execChildBinaryPath),
      executable: RUBY_VFORK_EXECUTABLE,
      cases,
    },
  );
}

test("Ruby uid 1000 selects upstream vfork in every browser engine", async ({
  page,
  baseURL,
}) => {
  test.skip(!artifactsAvailable, "The Ruby package artifacts are unavailable");
  test.setTimeout(600_000);
  if (!baseURL || !rubyBinaryPath) throw new Error("browser fixture unavailable");

  const runtimeErrors: string[] = [];
  page.on("pageerror", (error) => runtimeErrors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") runtimeErrors.push(message.text());
  });
  const [result] = await runRubyCases(page, baseURL, [{
    marker: RUBY_VFORK_FAILED_EXEC_MARKER,
    program: RUBY_VFORK_FAILED_EXEC_PROGRAM,
    uid: 1000,
    gid: 1000,
    maxProcessMemoryBytes: initialAddressSpaceBytes(rubyBinaryPath),
  }]);

  expect(result.exitCode, JSON.stringify(result, null, 2)).toBe(0);
  expect(result.stderr).toBe("");
  expect(result.stdout).toContain(`${RUBY_VFORK_FAILED_EXEC_MARKER}\n`);
  expect(result.diagnostics).toEqual([]);
  expect(result.childEvents).toEqual(["spawn", "exit"]);
  expect(result.forkCounts).toEqual(["1"]);
  expect(runtimeErrors).toEqual([]);
});

test("Ruby execs through vfork and root retains ordinary fork", async ({
  page,
  baseURL,
  browserName,
}) => {
  test.skip(browserName !== "chromium", "Chromium is the aggregate Ruby gate");
  test.skip(!artifactsAvailable, "The Ruby package artifacts are unavailable");
  test.setTimeout(600_000);
  if (!baseURL || !rubyBinaryPath) throw new Error("browser fixture unavailable");

  const runtimeErrors: string[] = [];
  page.on("pageerror", (error) => runtimeErrors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") runtimeErrors.push(message.text());
  });
  const [execResult, rootResult] = await runRubyCases(page, baseURL, [
    {
      marker: RUBY_VFORK_EXEC_MARKER,
      program: RUBY_VFORK_EXEC_PROGRAM,
      uid: 1000,
      gid: 1000,
    },
    {
      marker: RUBY_PRIVILEGED_FORK_MARKER,
      program: RUBY_PRIVILEGED_FORK_PROGRAM,
      uid: 0,
      gid: 0,
      maxProcessMemoryBytes: initialAddressSpaceBytes(rubyBinaryPath),
    },
  ]);

  expect(execResult.exitCode, JSON.stringify(execResult, null, 2)).toBe(0);
  expect(execResult.stderr).toBe("");
  expect(execResult.stdout).toContain("argv[0]=ruby-vfork-child\n");
  expect(execResult.stdout).toContain("FROM=ruby-upstream-vfork\n");
  expect(execResult.stdout).toContain(`${RUBY_VFORK_EXEC_MARKER}\n`);
  expect(execResult.diagnostics).toEqual([]);
  expect(execResult.childEvents).toEqual(["spawn", "exec", "exit"]);
  expect(execResult.forkCounts).toEqual(["1"]);

  expect(rootResult.exitCode, JSON.stringify(rootResult, null, 2)).toBe(0);
  expect(rootResult.stderr).toBe("");
  expect(rootResult.stdout).toContain(`${RUBY_PRIVILEGED_FORK_MARKER}\n`);
  expect(rootResult.diagnostics).toEqual([]);
  expect(rootResult.childEvents).toEqual(["spawn", "spawn"]);
  expect(rootResult.forkCounts).toHaveLength(2);
  expect(rootResult.forkCounts.at(-1)).toBe("2");

  const expectedCapacityErrors = runtimeErrors.filter((message) =>
    /fork worker launch failed:.*(?:admission budget|exhausted)/i.test(message)
  );
  expect(expectedCapacityErrors).toHaveLength(2);
  expect(runtimeErrors).toEqual(expectedCapacityErrors);
});
