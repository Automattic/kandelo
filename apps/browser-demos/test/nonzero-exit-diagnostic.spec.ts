import { expect, test } from "@playwright/test";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const programPath = resolve(
  __dirname,
  "../../../local-binaries/programs/wasm32/exec-child.wasm",
);
const trapProgramPath = resolve(
  __dirname,
  "../../../examples/wasm_trap_test.wasm",
);

test("an ordinary nonzero browser process exit is not a host diagnostic", async ({
  page,
  baseURL,
  browserName,
}) => {
  test.skip(
    browserName !== "chromium",
    "the aggregate browser gate uses Chromium",
  );
  expect(baseURL).toBeTruthy();

  const ambientDiagnostics: string[] = [];
  page.on("console", (message) => {
    if (["warning", "error"].includes(message.type())) {
      ambientDiagnostics.push(message.text());
    }
  });

  await page.goto(new URL("/pages/test-runner/", baseURL).href);
  await page.waitForFunction(() => (window as any).__testRunnerReady === true);

  const programUrl = new URL(`/@fs/${programPath}`, baseURL).href;
  const result = await page.evaluate(async ({ programUrl }) => {
    const response = await fetch(programUrl);
    if (!response.ok) {
      throw new Error(`program fetch failed: ${response.status}`);
    }
    return (window as any).__runTest(
      await response.arrayBuffer(),
      ["exec-child"],
      15_000,
    );
  }, { programUrl });

  expect(result.exitCode).toBe(42);
  expect(result.stdout).toContain("argv[0]=exec-child");
  expect(result.stderr).toBe("");
  expect(result.hostDiagnostics).toEqual([]);
  expect(ambientDiagnostics).toEqual([]);
});

test("a browser worker trap retains process failure context", async ({
  page,
  baseURL,
  browserName,
}) => {
  test.skip(
    browserName !== "chromium",
    "the aggregate browser gate uses Chromium",
  );
  expect(baseURL).toBeTruthy();

  await page.goto(new URL("/pages/test-runner/", baseURL).href);
  await page.waitForFunction(() => (window as any).__testRunnerReady === true);

  const programUrl = new URL(`/@fs/${trapProgramPath}`, baseURL).href;
  const result = await page.evaluate(async ({ programUrl }) => {
    const response = await fetch(programUrl);
    if (!response.ok) {
      throw new Error(`program fetch failed: ${response.status}`);
    }
    return (window as any).__runTest(
      await response.arrayBuffer(),
      ["wasm_trap_test"],
      15_000,
    );
  }, { programUrl });

  expect(result.exitCode).toBe(132);
  expect(result.stderr).toContain("before-trap");
  const diagnosticText = result.hostDiagnostics
    .map((diagnostic: { message: string }) => diagnostic.message)
    .join("\n");
  expect(diagnosticText).toContain("RuntimeError");
  expect(diagnosticText).toContain('argv=["wasm_trap_test"]');
  expect(diagnosticText).toContain("last syscalls:");
});
