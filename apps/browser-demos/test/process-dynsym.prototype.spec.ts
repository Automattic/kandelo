import { expect, test } from "../playwright-test";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const fixture = new URL(
  process.env.KANDELO_LOADER_FIXTURE_ARCH === "wasm64posix"
    ? "../../../.scratch/dynsym-wasm64/process-dynsym.wasm"
    : "../../../.scratch/process-dynsym.wasm",
  import.meta.url,
);

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

for (const needed of [false, true]) {
  test(`guest-bound plugin forks from an active side frame (dependency: ${needed})`, async ({ page }) => {
    test.skip(process.env.KANDELO_PROCESS_DYNSYM_PROTOTYPE !== "1", "requires the prototype linker");
    await page.goto("/pages/test-runner/?minimal=1");
    await page.waitForFunction(() => (window as Window & { __testRunnerReady?: boolean }).__testRunnerReady);
    const executable = new URL("process-dynsym-mapped.wasm", fixture);
    const plugin = new URL(needed ? "dynsym-needed-consumer.so" : "process-dynsym-side.so", fixture);
    const path = "/lib/dynsym-fixture.so";
    const dataFiles = [{ path, data: Array.from(readFileSync(fileURLToPath(plugin))) }];
    if (needed) dataFiles.push({
      path: "/lib/dynsym-dependency.so",
      data: Array.from(readFileSync(fileURLToPath(new URL("dynsym-dependency.so", fixture)))),
    });
    const argv = ["process-dynsym", path, ...(needed ? ["dependency"] : [])];
    const result = await page.evaluate(async ({ main, argv, dataFiles }) => {
      const runner = window as Window & {
        __runTest: (wasm: ArrayBuffer, argv: string[], timeout: number, options: {
          seedEtc: boolean;
          dataFiles: { path: string; data: number[] }[];
        }) => Promise<{ exitCode: number; stdout: string; stderr: string; hostDiagnostics: unknown[] }>;
      };
      return runner.__runTest(new Uint8Array(main).buffer, argv, 30_000, {
        seedEtc: false,
        dataFiles,
      });
    }, {
      main: Array.from(readFileSync(fileURLToPath(executable))),
      argv,
      dataFiles,
    });
    expect(result).toMatchObject({
      exitCode: 0,
      stdout: "before fork\nbefore plugin fork\nguest dynsym fork ok\n",
      stderr: "",
      hostDiagnostics: [],
    });
  });
}

for (const [kind, title] of [
  ["plain", "ordinary SDK executables can call plugins without fork instrumentation"],
  ["threaded", "a pthread can call a plugin loaded by the SDK executable"],
]) {
  test(title, async ({ page }) => {
    test.skip(process.env.KANDELO_PROCESS_DYNSYM_PROTOTYPE !== "1", "requires the loader fixtures");
    await page.goto("/pages/test-runner/?minimal=1");
    await page.waitForFunction(() => (window as Window & { __testRunnerReady?: boolean }).__testRunnerReady);
    const read = (name: string) => Array.from(readFileSync(new URL(name, fixture)));
    const path = "/lib/sdk-plugin.so";
    const result = await page.evaluate(async ({ main, path, data }) => {
      const runner = window as Window & {
        __runTest: (wasm: ArrayBuffer, argv: string[], timeout: number, options: {
          seedEtc: boolean;
          dataFiles: { path: string; data: number[] }[];
        }) => Promise<{ exitCode: number; stdout: string; stderr: string; hostDiagnostics: unknown[] }>;
      };
      return runner.__runTest(new Uint8Array(main).buffer, ["plugin-host", path], 30_000, {
        seedEtc: false,
        dataFiles: [{ path, data }],
      });
    }, {
      main: read(`process-dynsym-${kind}.wasm`),
      path,
      data: read(`process-dynsym-${kind}.so`),
    });
    expect(result).toMatchObject({
      exitCode: 0,
      stdout: "plugin: host_scale=3\nplugin_run(7) = 22\n",
      stderr: "",
      hostDiagnostics: [],
    });
  });
}

test("a previously built ABI-56 plugin is callable in the fork child", async ({ page }) => {
  const directory = process.env.KANDELO_ABI56_LOADER_FIXTURE;
  test.skip(!directory, "requires the retained ABI-56 loader fixture");
  await page.goto("/pages/test-runner/?minimal=1");
  await page.waitForFunction(() => (window as Window & { __testRunnerReady?: boolean }).__testRunnerReady);
  const path = "/lib/scaled-dynsym.so";
  const result = await page.evaluate(async ({ main, side, path }) => {
    const runner = window as Window & {
      __runTest: (wasm: ArrayBuffer, argv: string[], timeout: number, options: {
        seedEtc: boolean;
        dataFiles: { path: string; data: number[] }[];
      }) => Promise<{ exitCode: number; stdout: string; stderr: string; hostDiagnostics: unknown[] }>;
    };
    return runner.__runTest(new Uint8Array(main).buffer, ["scaled-dynsym", path], 30_000, {
      seedEtc: false,
      dataFiles: [{ path, data: side }],
    });
  }, {
    main: Array.from(readFileSync(directory + "/plugin-host.wasm")),
    side: Array.from(readFileSync(directory + "/plugin.so")),
    path,
  });
  expect(result).toMatchObject({ exitCode: 0, stderr: "", hostDiagnostics: [] });
  expect(result.stdout).toMatch(/^\d+ \d+ \d+ \d+\n$/);
});

test("guest loader identifies the required format for incompatible plugins", async ({ page }) => {
  const directory = process.env.KANDELO_ABI56_LOADER_FIXTURE;
  const wasm64 = process.env.KANDELO_LOADER_FIXTURE_ARCH === "wasm64posix";
  const otherWidth = new URL(
    wasm64 ? "../../../.scratch/process-dynsym-side.so" : "../../../.scratch/dynsym-wasm64/process-dynsym-side.so",
    import.meta.url,
  );
  test.skip(!directory || !existsSync(otherWidth) || process.env.KANDELO_PROCESS_DYNSYM_PROTOTYPE !== "1",
    "requires the retained ABI-56 and both SDK architectures' fixtures");
  await page.goto("/pages/test-runner/?minimal=1");
  await page.waitForFunction(() => (window as Window & { __testRunnerReady?: boolean }).__testRunnerReady);

  const main = Array.from(readFileSync(new URL("process-dynsym-mapped.wasm", fixture)));
  const path = "/lib/incompatible-plugin.so";
  for (const plugin of [directory + "/plugin.so", otherWidth]) {
    const data = Array.from(readFileSync(plugin));
    const result = await page.evaluate(async ({ main, path, data }) => {
      const runner = window as Window & {
        __runTest: (wasm: ArrayBuffer, argv: string[], timeout: number, options: {
          seedEtc: boolean;
          dataFiles: { path: string; data: number[] }[];
        }) => Promise<{ exitCode: number; stdout: string; stderr: string; hostDiagnostics: unknown[] }>;
      };
      return runner.__runTest(new Uint8Array(main).buffer, ["process-dynsym", path], 30_000, {
        seedEtc: false,
        dataFiles: [{ path, data }],
      });
    }, { main, path, data });
    expect(result).toMatchObject({
      exitCode: 14,
      stdout: "",
      stderr: `rebuild as a ${wasm64 ? "wasm64" : "wasm32"} Kandelo loader v1 side module: ${path}\n`,
      hostDiagnostics: [],
    });
  }
});

test("guest-owned loader serializes pthreads and resumes initializer and finalizer forks", async ({ page }) => {
  test.skip(process.env.KANDELO_PROCESS_DYNSYM_PROTOTYPE !== "1", "requires the prototype linker");
  await page.goto("/pages/test-runner/?minimal=1");
  await page.waitForFunction(() => (window as Window & { __testRunnerReady?: boolean }).__testRunnerReady);
  const read = (name: string) => Array.from(readFileSync(fileURLToPath(new URL(name, fixture))));
  const plugin = "/lib/dynsym-lifecycle.so";
  const main = read("process-dynsym-lifecycle.wasm");
  const dataFiles = [
    { path: plugin, data: read("dynsym-lifecycle.so") },
    { path: "/lib/dynsym-dependency.so", data: read("dynsym-dependency.so") },
    { path: "/bin/dynsym-lifecycle", data: main },
  ];
  const result = await page.evaluate(async ({ main, plugin, dataFiles }) => {
    const runner = window as Window & {
      __runTest: (wasm: ArrayBuffer, argv: string[], timeout: number, options: {
        seedEtc: boolean;
        dataFiles: { path: string; data: number[] }[];
      }) => Promise<{ exitCode: number; stdout: string; stderr: string; hostDiagnostics: unknown[] }>;
    };
    return runner.__runTest(new Uint8Array(main).buffer, ["dynsym-lifecycle", plugin], 45_000, {
      seedEtc: false,
      dataFiles,
    });
  }, { main, plugin, dataFiles });
  expect(result).toMatchObject({
    exitCode: 0,
    stdout: "guest loader lifecycle ok\n",
    stderr: "",
    hostDiagnostics: [],
  });
});
