import { expect, test } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { HostDiagnostic } from "../../../host/src/host-diagnostic";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "../../..");
const fixtureSource = join(repoRoot, "host/test/fixtures/dlopen-main-scope.c");
const fixtureWasm = join(tmpdir(), `kandelo-dlopen-main-${process.pid}.wasm`);

test.beforeAll(() => {
  execFileSync(
    "wasm32posix-cc",
    ["-O2", "-ldl", "-Wl,--export-dynamic", fixtureSource, "-o", fixtureWasm],
    { cwd: repoRoot, stdio: "pipe" },
  );
});

test.afterAll(() => {
  rmSync(fixtureWasm, { force: true });
});

test("dlopen(NULL) resolves the main program in BrowserKernel", async ({ page }) => {
  await page.goto("/pages/test-runner/");
  await page.waitForFunction(
    () => (window as typeof window & { __testRunnerReady?: boolean }).__testRunnerReady === true,
    undefined,
    { timeout: 30_000 },
  );

  const wasm = readFileSync(fixtureWasm);
  const result = await page.evaluate(
    async (bytes) => {
      return await (window as typeof window & {
        __runTest: (wasmBytes: ArrayBuffer, argv: string[]) => Promise<{
          exitCode: number;
          stdout: string;
          stderr: string;
          hostDiagnostics: HostDiagnostic[];
        }>;
      }).__runTest(new Uint8Array(bytes).buffer, ["dlopen-main-scope"]);
    },
    Array.from(wasm),
  );

  expect(result).toEqual({
    exitCode: 0,
    stdout: "self=42 default=8 data=35\n",
    stderr: "",
    combined: "self=42 default=8 data=35\n",
    hostDiagnostics: [],
  });
});
