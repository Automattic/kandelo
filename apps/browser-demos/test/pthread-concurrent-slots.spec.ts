import { expect, test } from "@playwright/test";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const programPath = resolve(
  __dirname,
  "../../../examples/pthread-concurrent-slots.wasm",
);

// The browser third of a cross-host trio. A pthread's control slot -- its
// thread-local storage, fork-save page and syscall channel -- is placed by the
// kernel now (`sys_clone` -> `kernel_thread_slot_addr`), so a process's
// concurrent-thread ceiling is the program's `__wasm_posix_thread_slots`
// declaration on every host rather than whatever address space each host had
// set aside. This fixture keeps 20 threads live at the same moment; the
// matching Node case is in `host/test/pthread.test.ts` and the native one is
// `smoke_pthread_concurrent_slots` in `crates/host-native/src/lib.rs`.
test("20 pthreads run concurrently in Chromium", async ({
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
  page.on("pageerror", (error) =>
    runtimeErrors.push(`pageerror: ${error.message}`),
  );
  page.on("console", (message) => {
    if (message.type() === "error") {
      runtimeErrors.push(`console: ${message.text()}`);
    }
  });

  await page.goto(new URL("/pages/test-runner/", baseURL).href);
  await page.waitForFunction(() => (window as any).__testRunnerReady === true);

  const programUrl = new URL(`/@fs/${programPath}`, baseURL).href;
  const result = await page.evaluate(
    async ({ programUrl }) => {
      const response = await fetch(programUrl);
      if (!response.ok) {
        throw new Error(
          `program fetch failed: ${response.status} ${response.url}`,
        );
      }
      return (window as any).__runTest(
        await response.arrayBuffer(),
        ["pthread-concurrent-slots"],
        60_000,
      );
    },
    { programUrl },
  );

  expect(result.exitCode).toBe(0);
  expect(result.stdout).toContain("PTHREAD_CONCURRENT_SLOTS_PASS");
  expect(result.stderr).toBe("");
  expect(runtimeErrors).toEqual([]);
});
