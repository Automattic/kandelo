import { expect, test } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { resolveBinary } from "../../../host/src/binary-resolver";

const dashPath = resolveBinary("programs/dash.wasm");

type TestResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
  combined: string;
};

type TestRunnerWindow = Window & {
  __testRunnerReady: boolean;
  __runTest(
    wasmBytes: ArrayBuffer,
    argv: string[],
    timeoutMs: number,
  ): Promise<TestResult>;
};

test("normal nonzero exits do not write host diagnostics to stderr", async ({
  page,
}) => {
  const dashBytes = Array.from(await readFile(dashPath));

  await page.goto("/pages/test-runner/", { waitUntil: "domcontentloaded" });
  await page.waitForFunction(
    () => (window as unknown as TestRunnerWindow).__testRunnerReady === true,
  );
  await page.evaluate(async () => {
    await navigator.serviceWorker.register("/service-worker.js", {
      scope: "/",
    });
    await navigator.serviceWorker.ready;
  });
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForFunction(
    () =>
      (window as unknown as TestRunnerWindow).__testRunnerReady === true &&
      navigator.serviceWorker.controller !== null,
  );

  const result = await page.evaluate(
    async (bytes) =>
      (window as unknown as TestRunnerWindow).__runTest(
        new Uint8Array(bytes).buffer,
        ["dash", "-c", "exit 7"],
        60_000,
      ),
    dashBytes,
  );

  expect(result).toEqual({
    exitCode: 7,
    stdout: "",
    stderr: "",
    combined: "",
  });
});
