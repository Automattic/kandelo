import { expect, test } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveBinary } from "../../../host/src/binary-resolver";
import type { HostDiagnostic } from "../../../host/src/host-diagnostic";
import type { WasmModuleCacheStats } from "../../../host/src/wasm-module-cache";

// The kernel worker compiles a program's thread-patched module once and
// shares it with every thread of every process running those bytes. This
// runs that path in a real browser: a shell starts three concurrent
// test-pthread processes, each of which creates and joins one thread.

const __dirname = dirname(fileURLToPath(import.meta.url));
const dashPath = resolveBinary("programs/dash.wasm");
// test-pthread has a start section, so the thread patch rewrites its bytes
// and its threads run a module compiled separately from the program's.
const pthreadPath = resolve(__dirname, "../../../examples/test-pthread.wasm");

type TestResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
  combined: string;
  hostDiagnostics: HostDiagnostic[];
  wasmModuleCacheStats?: WasmModuleCacheStats;
};

type TestRunnerWindow = Window & {
  __testRunnerReady: boolean;
  __runTest(
    wasmBytes: ArrayBuffer,
    argv: string[],
    timeoutMs: number,
    options: {
      dataFiles: { path: string; data: number[] }[];
      wasmModuleCacheStats: boolean;
    },
  ): Promise<TestResult>;
};

const SCRIPT = [
  "/usr/bin/test-pthread & a=$!",
  "/usr/bin/test-pthread & b=$!",
  "/usr/bin/test-pthread & c=$!",
  "wait $a || exit 11",
  "wait $b || exit 12",
  "wait $c || exit 13",
].join("\n");

test("processes running the same bytes share one thread module", async ({
  page,
}) => {
  const dashBytes = Array.from(await readFile(dashPath));
  const pthreadBytes = Array.from(await readFile(pthreadPath));

  await page.goto("/pages/test-runner/", { waitUntil: "domcontentloaded" });
  await page.waitForFunction(
    () => (window as unknown as TestRunnerWindow).__testRunnerReady === true,
  );

  const result = await page.evaluate(
    async ({ dashBytes, pthreadBytes, script }) =>
      (window as unknown as TestRunnerWindow).__runTest(
        new Uint8Array(dashBytes).buffer,
        ["dash", "-c", script],
        60_000,
        {
          dataFiles: [{ path: "/usr/bin/test-pthread", data: pthreadBytes }],
          wasmModuleCacheStats: true,
        },
      ),
    { dashBytes, pthreadBytes, script: SCRIPT },
  );

  expect(result.exitCode, result.combined).toBe(0);
  expect(result.stdout.match(/^PASS$/gm), result.combined).toHaveLength(3);

  const stats = result.wasmModuleCacheStats!;
  // dash, test-pthread, and test-pthread's thread module: one compilation
  // each. Forks inherit dash's module, the second and third exec reuse the
  // program module, and their threads reuse the first process's thread module.
  expect(stats).toMatchObject({
    compiles: 3,
    compileFailures: 0,
    threadCompiles: 1,
  });
  expect(stats.threadHits + stats.threadJoins).toBe(2);
});
