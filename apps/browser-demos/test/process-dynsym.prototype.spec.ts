import { expect, test } from "../playwright-test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const fixture = new URL("../../../.scratch/process-dynsym.wasm", import.meta.url);

test("guest executable symbol lookup preserves addresses through fork", async ({ page }) => {
  test.skip(process.env.KANDELO_PROCESS_DYNSYM_PROTOTYPE !== "1", "requires the prototype linker");
  await page.goto("/pages/test-runner/?minimal=1");
  await page.waitForFunction(() => (window as Window & { __testRunnerReady?: boolean }).__testRunnerReady);
  const result = await page.evaluate(async (bytes) => {
    const runner = window as Window & {
      __runTest: (wasm: ArrayBuffer, argv: string[], timeout: number, options: {
        seedEtc: boolean;
      }) => Promise<{ exitCode: number; stdout: string; stderr: string; hostDiagnostics: unknown[] }>;
    };
    return runner.__runTest(new Uint8Array(bytes).buffer, ["process-dynsym"], 30_000, { seedEtc: false });
  }, Array.from(readFileSync(fileURLToPath(fixture))));
  expect(result).toMatchObject({
    exitCode: 0,
    stdout: "before fork\nguest dynsym fork ok\n",
    stderr: "",
    hostDiagnostics: [],
  });
});

test("guest-bound plugin forks from an active side frame", async ({ page }) => {
  test.skip(process.env.KANDELO_PROCESS_DYNSYM_PROTOTYPE !== "1", "requires the prototype linker");
  await page.goto("/pages/test-runner/?minimal=1");
  await page.waitForFunction(() => (window as Window & { __testRunnerReady?: boolean }).__testRunnerReady);
  const executable = new URL("process-dynsym-mapped.wasm", fixture);
  const plugin = new URL("process-dynsym-side.so", fixture);
  const path = "/lib/dynsym-fixture.so";
  const result = await page.evaluate(async ({ main, side, path }) => {
    const runner = window as Window & {
      __runTest: (wasm: ArrayBuffer, argv: string[], timeout: number, options: {
        seedEtc: boolean;
        dataFiles: { path: string; data: number[] }[];
      }) => Promise<{ exitCode: number; stdout: string; stderr: string; hostDiagnostics: unknown[] }>;
    };
    return runner.__runTest(new Uint8Array(main).buffer, ["process-dynsym", path], 30_000, {
      seedEtc: false,
      dataFiles: [{ path, data: side }],
    });
  }, {
    main: Array.from(readFileSync(fileURLToPath(executable))),
    side: Array.from(readFileSync(fileURLToPath(plugin))),
    path,
  });
  expect(result).toMatchObject({
    exitCode: 0,
    stdout: "before fork\nbefore plugin fork\nguest dynsym fork ok\n",
    stderr: "",
    hostDiagnostics: [],
  });
});
