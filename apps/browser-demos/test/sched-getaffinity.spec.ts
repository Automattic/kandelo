import { expect, test } from "../playwright-test";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveBinary } from "../../../host/src/binary-resolver";

const __dirname = dirname(fileURLToPath(import.meta.url));
const programPath = resolve(
  __dirname,
  "../../../local-binaries/programs/wasm32/sched-getaffinity.wasm",
);

test("sched_getaffinity, sysconf and nproc report the host's processors in Chromium", async ({
  page,
  baseURL,
  browserName,
}) => {
  test.skip(
    browserName !== "chromium",
    "the aggregate browser gate uses Chromium",
  );
  expect(baseURL).toBeTruthy();

  const runtimeErrors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") {
      runtimeErrors.push(`console: ${message.text()}`);
    }
  });
  page.on("pageerror", (error) => {
    runtimeErrors.push(`pageerror: ${error.message}`);
  });
  page.on("requestfailed", (request) => {
    runtimeErrors.push(
      `requestfailed: ${request.url()} ${request.failure()?.errorText ?? "failed"}`,
    );
  });
  page.on("response", (response) => {
    if (response.status() >= 400) {
      runtimeErrors.push(`response: ${response.status()} ${response.url()}`);
    }
  });

  const programUrl = new URL(
    "/__test-fixtures__/sched-getaffinity.wasm",
    baseURL,
  ).href;
  await page.route(programUrl, async (route) => {
    await route.fulfill({
      path: programPath,
      contentType: "application/wasm",
    });
  });
  const coreutilsUrl = new URL(
    "/__test-fixtures__/coreutils.wasm",
    baseURL,
  ).href;
  await page.route(coreutilsUrl, async (route) => {
    await route.fulfill({
      path: resolveBinary("programs/wasm32/coreutils.wasm"),
      contentType: "application/wasm",
    });
  });

  await page.goto(new URL("/pages/test-runner/", baseURL).href);
  await page.waitForFunction(() => (window as any).__testRunnerReady === true);

  // The kernel worker reads the same navigator.hardwareConcurrency; the
  // kernel caps it at the 32 CPUs its four-byte affinity mask can name.
  const hardwareConcurrency = await page.evaluate(
    () => navigator.hardwareConcurrency,
  );
  expect(hardwareConcurrency).toBeGreaterThanOrEqual(1);
  const processors = Math.min(hardwareConcurrency, 32);

  const run = (url: string, argv: string[]) =>
    page.evaluate(
      async ({ url, argv }) => {
        const response = await fetch(url);
        if (!response.ok) {
          throw new Error(`program fetch failed: ${response.status}`);
        }
        return (window as any).__runTest(
          await response.arrayBuffer(),
          argv,
          15_000,
        );
      },
      { url, argv },
    );

  const result = await run(programUrl, ["sched-getaffinity", String(processors)]);
  expect(result.stderr).toBe("");
  expect(result.stdout).toBe(`sched-getaffinity-ok raw=4 cpus=${processors}\n`);
  expect(result.exitCode).toBe(0);

  for (const argv of [["nproc"], ["nproc", "--all"]]) {
    const nproc = await run(coreutilsUrl, argv);
    expect(nproc.stderr).toBe("");
    expect(nproc.stdout).toBe(`${processors}\n`);
    expect(nproc.exitCode).toBe(0);
  }
  expect(runtimeErrors).toEqual([]);
});
