import { expect, test } from "@playwright/test";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The browser half of `host/test/transfer-kernel-wait.test.ts`: the same
 * guest, through the browser host's kernel worker. A blocking pipe or socket
 * transfer is a kernel park, and every way it can end -- data, EOF, room,
 * SO_RCVTIMEO (including an already-expired one), a signal (generated after
 * the park, pending when it is made, or moved onto it by another thread's
 * mask change), SA_RESTART, cancellation, a reused descriptor number -- must
 * be decided as promptly as on Node.
 */
const __dirname = dirname(fileURLToPath(import.meta.url));
const programPath = resolve(
  __dirname,
  "../../../examples/transfer-kernel-wait.wasm",
);

const CASES = [
  "read",
  "eof",
  "write",
  "socket",
  "signal-eintr",
  "signal-restart",
  "pinned",
  "cancel",
  "signal-pending-at-park",
  "expired-timeout",
  "ping-pong",
  "signal-retargeted",
];

test("blocking transfers park in the kernel and end promptly in the browser", async ({
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
      ["transfer-kernel-wait"],
      90_000,
    );
  }, { programUrl });

  for (const name of CASES) {
    expect(result.stdout, JSON.stringify(result, null, 2)).toContain(`ok ${name}\n`);
  }
  expect(result.stdout).toContain("PASS");
  expect(result.exitCode).toBe(0);
});
