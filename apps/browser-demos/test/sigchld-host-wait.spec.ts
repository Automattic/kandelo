import { expect, test } from "@playwright/test";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The browser half of `host/test/sigchld-host-wait.test.ts`: the same guest,
 * through the browser host's kernel worker. A caught SIGCHLD must interrupt
 * a parent blocked in poll, select, epoll_wait or accept with EINTR even when
 * the kernel reaps the child in the same step (SA_NOCLDWAIT, or a waitpid
 * thread), on the main thread and on a second thread.
 */
const __dirname = dirname(fileURLToPath(import.meta.url));
const programPath = resolve(
  __dirname,
  "../../../examples/sigchld-host-wait.wasm",
);

const CASES = ["poll", "select", "epoll", "accept"].flatMap((kind) =>
  ["autoreap", "waiter"].flatMap((mode) => [
    `${kind}-${mode}`,
    `thread-${kind}-${mode}`,
  ]),
);

test("SIGCHLD interrupts host-owned waits in the browser", async ({
  page,
  baseURL,
}) => {
  test.setTimeout(120_000);
  expect(baseURL).toBeTruthy();

  await page.goto(new URL("/pages/test-runner/?minimal=1", baseURL).href);
  await page.waitForFunction(() => (window as any).__testRunnerReady === true);

  const programUrl = new URL(`/@fs/${programPath}`, baseURL).href;
  const result = await page.evaluate(async ({ programUrl }) => {
    const response = await fetch(programUrl);
    if (!response.ok) {
      throw new Error(`program fetch failed: ${response.status}`);
    }
    return (window as any).__runTest(
      await response.arrayBuffer(),
      ["sigchld-host-wait"],
      90_000,
    );
  }, { programUrl });

  for (const name of CASES) {
    expect(result.stdout, JSON.stringify(result, null, 2)).toContain(`ok ${name}\n`);
  }
  expect(result.stdout).toContain("PASS");
  expect(result.exitCode).toBe(0);
});
