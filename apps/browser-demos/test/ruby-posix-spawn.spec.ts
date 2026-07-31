import { expect, test } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { tryResolveBinary } from "../../../host/src/binary-resolver";
import {
  RUBY_POSIX_SPAWN_CASES,
  RUBY_POSIX_SPAWN_EXECUTABLE,
} from "../../../packages/registry/ruby/test/posix-spawn-contract";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "../../..");
const rubyBinaryAvailable =
  tryResolveBinary("programs/ruby/ruby.wasm") !== null;
const browserKernelModulePath = resolve(
  repoRoot,
  "host/src/browser-kernel-host.ts",
);
const memoryFsModulePath = resolve(
  repoRoot,
  "host/src/vfs/memory-fs.ts",
);
const imageHelpersModulePath = resolve(
  repoRoot,
  "host/src/vfs/image-helpers.ts",
);
const rubyBinaryFixtureDirectory = resolve(
  repoRoot,
  "target/browser-test-runs",
  `ruby-posix-spawn-${randomUUID()}`,
);
const rubyBinaryFixturePath = resolve(rubyBinaryFixtureDirectory, "ruby.ts");

test.beforeAll(() => {
  mkdirSync(rubyBinaryFixtureDirectory, { recursive: true });
  // WHY: Keep this test-only import outside the authored browser tree. The
  // product scanner must not mistake a regression fixture for a direct shell
  // input, while Vite must still approve Ruby through the normal resolver.
  writeFileSync(
    rubyBinaryFixturePath,
    [
      'import rubyWasmUrl from "@binaries/programs/wasm32/ruby/ruby.wasm?url";',
      "export default rubyWasmUrl;",
      "",
    ].join("\n"),
  );
});

test.afterAll(() => {
  rmSync(rubyBinaryFixtureDirectory, { recursive: true, force: true });
});

test("Ruby uses direct posix_spawn in Chromium and preserves fork fallback", async ({
  page,
  baseURL,
  browserName,
}) => {
  test.skip(
    browserName !== "chromium",
    "Chromium is the aggregate browser runtime gate",
  );
  test.skip(
    !rubyBinaryAvailable,
    "The Ruby package artifact is not available",
  );
  test.setTimeout(600_000);
  if (!baseURL) throw new Error("Playwright baseURL is required");

  const runtimeErrors: string[] = [];
  page.on("pageerror", (error) => runtimeErrors.push(error.message));
  page.on("console", (message) => {
    if (
      message.type() === "error"
      && !message.text().startsWith("Failed to load resource:")
    ) {
      runtimeErrors.push(message.text());
    }
  });

  await page.goto(new URL("/trap-signal-test.html", baseURL).href);
  const result = await page.evaluate(
    async ({
      browserKernelUrl,
      memoryFsUrl,
      imageHelpersUrl,
      rubyBinaryFixtureUrl,
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
      // The fixture's @binaries import crosses the resolver's exact-file
      // capability boundary before exposing a URL to browser code.
      const { default: rubyUrl } = await import(
        /* @vite-ignore */ rubyBinaryFixtureUrl
      );
      const rubyResponse = await fetch(rubyUrl);
      if (!rubyResponse.ok) {
        throw new Error(`Ruby fetch failed: ${rubyResponse.status}`);
      }
      const rubyBytes = await rubyResponse.arrayBuffer();

      // Ruby is also the child executable. Keeping it in the VFS exercises
      // the same kernel-owned resolution path used by the browser shell.
      const maxImageBytes = 96 * 1024 * 1024;
      const SharedArrayBufferCtor = SharedArrayBuffer as new (
        byteLength: number,
        options?: { maxByteLength?: number },
      ) => SharedArrayBuffer;
      const buildFs = MemoryFileSystem.create(
        new SharedArrayBufferCtor(16 * 1024 * 1024, {
          maxByteLength: maxImageBytes,
        }),
        maxImageBytes,
      );
      ensureDirRecursive(buildFs, "/usr/bin");
      writeVfsBinary(
        buildFs,
        executable,
        new Uint8Array(rubyBytes),
        0o755,
      );
      const vfsImage = await buildFs.saveImage();

      let stdout = "";
      let stderr = "";
      const diagnostics: Array<{ source: string; message: string }> = [];
      let activeParentPid: number | undefined;
      let activeChildPid: number | undefined;
      let activeForkSamples: Array<Promise<bigint>> = [];
      let activeChildEvents: Array<"spawn" | "exec" | "exit"> = [];

      const kernel = new BrowserKernel({
        kernelOwnedFs: true,
        onStdout: (data: Uint8Array) => {
          stdout += new TextDecoder().decode(data);
        },
        onStderr: (data: Uint8Array) => {
          stderr += new TextDecoder().decode(data);
        },
        onHostDiagnostic: (diagnostic: { source: string; message: string }) => {
          diagnostics.push(diagnostic);
        },
        onProcessEvent: (event: {
          kind: "spawn" | "exec" | "exit";
          pid: number;
          ppid?: number;
        }) => {
          if (
            activeParentPid !== undefined
            && event.kind === "spawn"
            && event.ppid === activeParentPid
          ) {
            activeChildPid = event.pid;
            activeChildEvents.push(event.kind);
            activeForkSamples.push(kernel.getForkCount(activeParentPid));
          } else if (activeChildPid === event.pid) {
            activeChildEvents.push(event.kind);
          }
        },
      });

      try {
        await kernel.initFromImage({ vfsImage });
        const results = [];
        for (const spawnCase of cases) {
          const stdoutStart = stdout.length;
          const stderrStart = stderr.length;
          const diagnosticsStart = diagnostics.length;
          activeParentPid = undefined;
          activeChildPid = undefined;
          activeForkSamples = [];
          activeChildEvents = [];

          const exitCode = await kernel.spawn(
            rubyBytes.slice(0),
            ["ruby", "--disable-gems", "-e", spawnCase.program],
            {
              env: [
                "HOME=/tmp",
                "TMPDIR=/tmp",
                "K_TEST=inherited-env-ok",
              ],
              onStarted: (pid: number) => {
                activeParentPid = pid;
              },
            },
          );
          const forkCounts = await Promise.all(activeForkSamples);
          results.push({
            marker: spawnCase.marker,
            expectedForkCount: spawnCase.expectedForkCount,
            expectedChildEvents: spawnCase.expectedChildEvents,
            exitCode,
            stdout: stdout.slice(stdoutStart),
            stderr: stderr.slice(stderrStart),
            diagnostics: diagnostics.slice(diagnosticsStart),
            forkCounts: forkCounts.map((count) => count.toString()),
            childEvents: [...activeChildEvents],
          });
        }
        return results;
      } finally {
        await kernel.destroy();
      }
    },
    {
      browserKernelUrl: new URL(
        `/@fs/${browserKernelModulePath}`,
        baseURL,
      ).href,
      memoryFsUrl: new URL(
        `/@fs/${memoryFsModulePath}`,
        baseURL,
      ).href,
      imageHelpersUrl: new URL(`/@fs/${imageHelpersModulePath}`, baseURL).href,
      rubyBinaryFixtureUrl: new URL(
        `/@fs/${rubyBinaryFixturePath}`,
        baseURL,
      ).href,
      executable: RUBY_POSIX_SPAWN_EXECUTABLE,
      cases: RUBY_POSIX_SPAWN_CASES.map((spawnCase) => ({
        marker: spawnCase.marker,
        expectedForkCount: spawnCase.expectedForkCount.toString(),
        expectedChildEvents: spawnCase.expectedChildEvents,
        program: spawnCase.program,
      })),
    },
  );

  for (const spawnCase of result) {
    expect(spawnCase.exitCode, spawnCase.stderr).toBe(0);
    expect(spawnCase.stderr).toBe("");
    expect(spawnCase.stdout).toContain(`${spawnCase.marker}\n`);
    expect(spawnCase.diagnostics).toEqual([]);
    expect(spawnCase.forkCounts).toEqual([
      spawnCase.expectedForkCount,
    ]);
    expect(spawnCase.childEvents).toEqual(spawnCase.expectedChildEvents);
  }
  expect(runtimeErrors).toEqual([]);
});
